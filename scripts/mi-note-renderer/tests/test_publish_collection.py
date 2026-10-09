import contextlib
import copy
import hashlib
from html.parser import HTMLParser
import importlib.util
import io
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import unquote, urlsplit
import zipfile

from PIL import Image, ImageCms, ImageDraw


SCRIPT = Path(__file__).resolve().parents[1] / "publish_collection.py"
spec = importlib.util.spec_from_file_location("publish_collection", SCRIPT)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
COUNT = 21


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def make_fixture(directory):
    output, cache = directory / "collection", directory / "cache"
    for name in ("qa", "thumbnails", "controls"):
        (output / name).mkdir(parents=True)
    cache.mkdir()
    fingerprint = hashlib.sha256(b"synthetic-publisher-fixture").hexdigest()
    profile = publisher.SRGB_BYTES
    profile_hash = hashlib.sha256(profile).hexdigest()
    records, completed = {}, {}
    for card_id in range(1, COUNT + 1):
        path = output / f"{card_id}.png"
        image = Image.new("RGBA", (2000, 2800))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((0, 0, 1999, 2799), radius=64, fill=(card_id * 9, 100, 200, 255))
        draw.rectangle((240, 480, 1760, 600), fill=(240, 230, 200, 255))
        draw.line((100, 1200, 1900, 1600), fill=(20, 40, 60, 255), width=8)
        image.save(path, compress_level=1, icc_profile=profile)
        decoded_hash = hashlib.sha256(image.tobytes()).hexdigest()
        thumbnail = image.convert("RGBa").resize((280, 392), Image.Resampling.LANCZOS).convert("RGBA")
        thumbnail.save(output / "thumbnails" / path.name, icc_profile=profile)
        image.close()
        report = {
            "id": card_id, "file": path.name, "width": 2000, "height": 2800,
            "profile": {"bytes": len(profile), "sha256": profile_hash, "preservedByteForByte": True},
            "stitching": {matte: {"passed": True, "overlaps": [{"passed": True}]} for matte in ("white", "black")},
            "qa": {"passed": True, "geometryPassed": True, "centerNonOpaquePixels": 0, "alphaBounds": [0, 0, 2000, 2800], "recompositionTolerance255": 2, "recomposition": {matte: {"maxChannelError255": 0} for matte in ("white", "black")}},
        }
        record = {
            "id": card_id, "runFingerprint": fingerprint, "fileSha256": publisher.file_hash(path),
            "decodedRgbaSha256": decoded_hash, "iccSha256": profile_hash, "bytes": path.stat().st_size,
            "width": 2000, "height": 2800, "mode": "RGBA", "qaPassed": True, "report": report,
            "rawFiles": [], "timestamp": "2026-01-01T00:00:00Z",
        }
        records[card_id] = record
        save(output / "qa" / f"{card_id}.json", record)
        completed[str(card_id)] = {key: record[key] for key in ("id", "fileSha256", "decodedRgbaSha256", "iccSha256", "bytes")}
        completed[str(card_id)]["completedAt"] = record["timestamp"]
    controls = []
    for label, card_id in (("startup-1", 1), ("end-1", 1), ("end-21", 21)):
        relative = f"controls/{label}.json"
        comparison = {"decodedRgbaEqual": True, "iccBytesEqual": True, "fileBytesEqual": True, "differingPixels": 0, "maxChannelError255": 0}
        save(output / relative, {**records[card_id], "label": label, "baselineFile": f"{card_id}.png", "comparison": comparison})
        controls.append({"label": label, "id": card_id, "passed": True, "report": relative, "comparison": comparison, "runFingerprint": fingerprint})
    config = {
        "runFingerprint": fingerprint, "ids": list(range(1, COUNT + 1)), "controlIds": [1, 21],
        "sourceHashes": {"synthetic-source": hashlib.sha256(b"fixture").hexdigest()},
        "assetFingerprint": hashlib.sha256(b"synthetic-assets").hexdigest(),
        "settings": {"width": 2000, "height": 2800, "dpr": 2.5}, "expectedIccSha256": profile_hash,
    }
    checkpoint = {"runFingerprint": fingerprint, "completed": completed, "controls": controls, "startupControlsComplete": True, "finalControlsComplete": True, "status": "captured"}
    save(cache / "run-config.json", config)
    save(cache / "checkpoint.json", checkpoint)
    save(output / "capture-config.json", config)
    save(output / "assets-preflight.json", {"fixture": True, "assetsChecked": COUNT * 3})
    save(output / "session-summary.json", {"fixture": True, "cleanupComplete": True})
    save(output / "browser-recovery-first.json", {"fixture": True, "sourceSettingsChanged": False})
    return output, cache, config, checkpoint, records


class HtmlLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.images = []

    def handle_starttag(self, tag, attributes):
        values = dict(attributes)
        self.links.extend(values[key] for key in ("href", "src") if key in values)
        if tag == "img":
            self.images.append(values.get("src"))


class PublisherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory(prefix="mi-note-publisher-test-")
        cls.addClassCleanup(directory.cleanup)
        cls.directory = Path(directory.name)
        cls.output, cls.cache, cls.config, cls.checkpoint, cls.records = make_fixture(cls.directory)
        usage = shutil.disk_usage(cls.directory)._replace(free=100 * 1024**3)
        disk = patch.object(publisher.shutil, "disk_usage", return_value=usage)
        disk.start()
        cls.addClassCleanup(disk.stop)

    def setUp(self):
        save(self.cache / "run-config.json", self.config)
        save(self.cache / "checkpoint.json", self.checkpoint)
        save(self.output / "qa" / "1.json", self.records[1])

    def validate(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return publisher.validate_collection(self.output, self.cache, COUNT)

    def test_complete_gallery_has_every_id_and_local_link(self):
        with contextlib.redirect_stdout(io.StringIO()):
            result = publisher.main(["--output", str(self.output), "--cache", str(self.cache), "--expected-count", str(COUNT), "--skip-zip"])
        self.assertEqual((result["count"], result["contactSheetPagesPerBackground"], result["contactSheets"]), (COUNT, 2, 6))
        manifest = publisher.load_json(self.output / "manifest.json")
        self.assertEqual([item["id"] for item in manifest["samples"]], list(range(1, COUNT + 1)))
        self.assertEqual(manifest["repeatability"]["configuredIds"], [1, 21])
        self.assertFalse(manifest["archivePolicy"]["requested"])
        self.assertEqual(manifest["provenance"]["historicalComparisons"], [])
        self.assertEqual(manifest["assetFingerprint"], self.config["assetFingerprint"])
        self.assertEqual(len(manifest["provenance"]["reports"]), 4)
        ids = []
        for page in [self.output / "index.html", *sorted((self.output / "gallery").glob("page-*.html"))]:
            links = HtmlLinks()
            links.feed(page.read_text())
            for link in links.links:
                target = urlsplit(link)
                self.assertFalse(target.scheme or target.netloc)
                self.assertTrue((page.parent / unquote(target.path)).is_file(), (page.name, link))
            ids.extend(int(re.fullmatch(r"../thumbnails/(\d+)\.png", value).group(1)) for value in links.images)
        self.assertEqual(ids, list(range(1, COUNT + 1)))
        for background in publisher.BACKGROUNDS:
            for page in (1, 2):
                with Image.open(self.output / "contact-sheets" / f"{background}-{page:03d}.png") as image:
                    self.assertEqual(image.size, publisher.SHEET_SIZE)
                    profile = ImageCms.ImageCmsProfile(io.BytesIO(image.info["icc_profile"]))
                    self.assertIn("srgb", ImageCms.getProfileDescription(profile).lower())
        for report in manifest["provenance"]["reports"]:
            self.assertEqual(report["sha256"], publisher.file_hash(self.output / report["file"]))

    def test_historical_comparison_is_optional_and_informational(self):
        relative = "comparison-reference/reproduction-report.json"
        path = self.output / relative
        save(path, {"count": 3, "passedCount": 0, "passed": False})
        try:
            provenance = publisher.provenance_reports(self.output)
            historical = provenance["historicalComparisons"][0]
            self.assertEqual((historical["count"], historical["exactMatches"]), (3, 0))
            self.assertFalse(historical["exact"] or historical["acceptanceGate"])
            self.assertEqual(historical["file"], relative)
        finally:
            path.unlink()

    def test_missing_card_rejected(self):
        path = self.output / f"{COUNT}.png"
        hidden = path.with_suffix(".hidden")
        path.rename(hidden)
        try:
            with self.assertRaisesRegex(ValueError, "Numeric PNG set mismatch"):
                self.validate()
        finally:
            hidden.rename(path)

    def test_extra_card_rejected(self):
        path = self.output / f"{COUNT + 1}.png"
        shutil.copyfile(self.output / "1.png", path)
        try:
            with self.assertRaisesRegex(ValueError, "Numeric PNG set mismatch"):
                self.validate()
        finally:
            path.unlink()

    def test_incomplete_capture_rejected(self):
        checkpoint = copy.deepcopy(self.checkpoint)
        checkpoint["status"] = "running"
        save(self.cache / "checkpoint.json", checkpoint)
        with self.assertRaisesRegex(ValueError, "status 'captured'"):
            self.validate()

    def test_changed_pixel_rejected_even_with_updated_file_hash(self):
        path = self.output / "1.png"
        original = path.read_bytes()
        try:
            with Image.open(path) as source:
                image = source.copy()
            image.putpixel((1000, 1400), (250, 20, 30, 255))
            image.save(path, icc_profile=publisher.SRGB_BYTES)
            record, checkpoint = copy.deepcopy(self.records[1]), copy.deepcopy(self.checkpoint)
            for key, value in {"bytes": path.stat().st_size, "fileSha256": publisher.file_hash(path)}.items():
                record[key] = value
                checkpoint["completed"]["1"][key] = value
            save(self.output / "qa" / "1.json", record)
            save(self.cache / "checkpoint.json", checkpoint)
            with self.assertRaisesRegex(ValueError, "decodedRgbaSha256 differs"):
                self.validate()
        finally:
            path.write_bytes(original)

    def test_mismatched_icc_rejected(self):
        config = copy.deepcopy(self.config)
        config["expectedIccSha256"] = "0" * 64
        save(self.cache / "run-config.json", config)
        with self.assertRaisesRegex(ValueError, "native ICC differs"):
            self.validate()

    def test_failed_qa_rejected(self):
        record = copy.deepcopy(self.records[1])
        record["report"]["qa"]["centerNonOpaquePixels"] = 1
        save(self.output / "qa" / "1.json", record)
        with self.assertRaisesRegex(ValueError, "center is not fully opaque"):
            self.validate()

    def test_missing_final_control_rejected(self):
        checkpoint = copy.deepcopy(self.checkpoint)
        checkpoint["controls"] = checkpoint["controls"][:-1]
        with self.assertRaisesRegex(ValueError, "Missing final exact repeatability control end-21"):
            publisher.validate_controls(self.output, self.config, checkpoint)

    def test_control_mismatch_rejected(self):
        checkpoint = copy.deepcopy(self.checkpoint)
        checkpoint["controls"][0]["comparison"]["differingPixels"] = 1
        with self.assertRaisesRegex(ValueError, "exact decoded RGBA/ICC comparison failed"):
            publisher.validate_controls(self.output, self.config, checkpoint)

    def test_disk_reserve_rejected(self):
        usage = shutil.disk_usage(self.output)._replace(free=publisher.RESERVE_BYTES - 1)
        with patch.object(publisher.shutil, "disk_usage", return_value=usage):
            with self.assertRaisesRegex(ValueError, "10 GiB reserve"):
                publisher.ensure_space(self.output)

    def test_small_zip64_stream_and_crc(self):
        directory = self.directory / "archive-unit"
        directory.mkdir()
        (directory / "1.png").write_bytes(b"archive-stream-fixture" * 65536)
        (directory / "index.html").write_text("fixture")
        hashes = {"1.png": publisher.file_hash(directory / "1.png")}
        with contextlib.redirect_stdout(io.StringIO()):
            result = publisher.create_archive(directory, 1, hashes)
        self.assertEqual(result["rootNumericPngCount"], 1)
        self.assertTrue(result["crcVerified"])
        with zipfile.ZipFile(directory.with_name(directory.name + ".zip")) as archive:
            self.assertEqual(set(archive.namelist()), {"1.png", "index.html"})
            self.assertGreaterEqual(archive.getinfo("1.png").extract_version, 45)

    def test_archive_rejects_file_change(self):
        directory = self.directory / "archive-mutation-unit"
        directory.mkdir()
        (directory / "1.png").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "changed after publication validation"):
            publisher.create_archive(directory, 1, {"1.png": "0" * 64})
        self.assertFalse(directory.with_name(directory.name + ".zip.partial").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
