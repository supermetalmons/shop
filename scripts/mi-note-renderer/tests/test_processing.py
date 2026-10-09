import sys

sys.dont_write_bytecode = True

import argparse
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageCms


TOOL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL))
import image_core
from fixtures import copy_capture_fixture, create_capture_fixture


class ProcessingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="mi-note-processing-tests-")
        cls.directory = Path(cls.temporary.name)
        cls.fixture = create_capture_fixture(cls.directory / "fixture")
        cls.input_hashes = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in cls.fixture["raw"].iterdir()}

    @classmethod
    def tearDownClass(cls):
        after = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in cls.fixture["raw"].iterdir()}
        if cls.input_hashes != after:
            raise AssertionError("Processing modified the original input fixture")
        cls.temporary.cleanup()

    def pair(self, fixture=None, expected_icc=None):
        fixture = fixture or self.fixture
        result = subprocess.run([
            sys.executable, "-B", str(TOOL / "check_pair.py"),
            "--metadata", str(fixture["raw"] / "460-white.json"),
            "--expected-icc", expected_icc or fixture["icc_sha256"],
        ], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.stderr, "")
        return result.returncode, json.loads(result.stdout)

    def worker(self, name, fixture=None, reference=None, expected_icc=None):
        fixture = fixture or self.fixture
        stage = self.directory / name
        command = [
            sys.executable, "-B", str(TOOL / "finalize_worker.py"),
            "--id", "460", "--raw", str(fixture["raw"]), "--stage", str(stage),
            "--fingerprint", "synthetic-test-run", "--expected-icc", expected_icc or fixture["icc_sha256"],
        ]
        if reference:
            command.extend(("--compare-with", str(reference)))
        result = subprocess.run(command, capture_output=True, text=True, timeout=90)
        return stage, result

    def test_native_stitch_alpha_and_icc_match_ground_truth(self):
        stage, process = self.worker("exact", reference=self.fixture["expected"])
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        result = json.loads((stage / "result.json").read_text())
        self.assertTrue(result["qaPassed"])
        self.assertEqual(result["runFingerprint"], "synthetic-test-run")
        self.assertEqual(len(result["rawFiles"]), 6)
        self.assertTrue(result["comparison"]["decodedRgbaEqual"])
        self.assertTrue(result["comparison"]["iccBytesEqual"])
        self.assertTrue(result["comparison"]["fileBytesEqual"])
        self.assertEqual((stage / "460.png").read_bytes(), self.fixture["expected"].read_bytes())
        self.assertEqual(result["report"]["qa"]["cornerAlpha255"], [0, 0, 0, 0])
        self.assertTrue(result["report"]["qa"]["cornersTransparent"])
        for matte in ("white", "black"):
            self.assertEqual(result["report"]["qa"]["recomposition"][matte]["maxChannelError255"], 0)
        with Image.open(stage / "thumb.png") as image:
            self.assertEqual((image.size, image.mode), ((280, 392), "RGBA"))
            self.assertEqual(image.getpixel((0, 0))[3], 0)
            profile = ImageCms.ImageCmsProfile(io.BytesIO(image.info["icc_profile"]))
            self.assertIn("srgb", ImageCms.getProfileDescription(profile).lower())

    def test_aligned_pair_passes(self):
        code, result = self.pair()
        self.assertEqual(code, 0)
        self.assertTrue(result["passed"])
        self.assertEqual(result["metrics"]["maxChannelError255"], 0)
        self.assertEqual(result["seamY"], 1404)
        self.assertEqual(result["edgeGuardPixels"], 64)
        self.assertEqual(result["registration"]["best"]["dx"], 0)
        self.assertEqual(result["registration"]["best"]["dy"], 0)

    def test_quantization_error_exceeding_seam_mean_is_rejected(self):
        fixture = copy_capture_fixture(self.fixture, self.directory / "seam-mean")
        path = fixture["raw"] / "460-white-1.png"
        with Image.open(path) as source:
            pixels = np.array(source)
        pixels[216:280, 64:144, 0] ^= 1
        Image.fromarray(pixels).save(path, icc_profile=fixture["profile"])
        code, result = self.pair(fixture)
        self.assertEqual(code, 2)
        self.assertFalse(result["passed"])
        self.assertEqual(result["metrics"]["maxChannelError255"], 1)
        self.assertGreater(result["metrics"]["meanAbsoluteChannelError255"], 0.01)

    def test_wrong_native_viewport_size_is_rejected(self):
        fixture = copy_capture_fixture(self.fixture, self.directory / "viewport-size")
        path = fixture["raw"] / "460-white-1.png"
        with Image.open(path) as source:
            cropped = source.crop((0, 0, 2560, 1715))
        cropped.save(path, icc_profile=fixture["profile"])
        cropped.close()
        code, result = self.pair(fixture)
        self.assertEqual(code, 1)
        self.assertIn("2560×1716", result["error"])

    def test_fractional_physical_pixel_crop_is_rejected(self):
        fixture = copy_capture_fixture(self.fixture, self.directory / "fractional-crop")
        path = fixture["raw"] / "460-white.json"
        document = json.loads(path.read_text())
        document["tiles"][0]["cardRect"]["x"] += 0.2 / 2.5
        path.write_text(json.dumps(document))
        code, result = self.pair(fixture)
        self.assertEqual(code, 1)
        self.assertIn("not an integer physical pixel", result["error"])

    def test_capture_not_ready_is_rejected(self):
        fixture = copy_capture_fixture(self.fixture, self.directory / "not-ready")
        path = fixture["raw"] / "460-white.json"
        document = json.loads(path.read_text())
        document["tiles"][1]["ready"] = False
        path.write_text(json.dumps(document))
        code, result = self.pair(fixture)
        self.assertEqual(code, 1)
        self.assertIn("readiness mismatch", result["error"])

    def test_unexpected_icc_is_rejected(self):
        code, result = self.pair(expected_icc="0" * 64)
        self.assertEqual(code, 1)
        self.assertIn("Native ICC profile differs", result["error"])

    def test_opaque_corners_are_rejected(self):
        fixture = create_capture_fixture(self.directory / "opaque-corners", transparent_corners=False)
        stage, process = self.worker("opaque-corners-stage", fixture=fixture)
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse((stage / "result.json").exists())
        failure = json.loads((stage / "error.json").read_text())
        self.assertIn("matte reconstruction QA failed", failure["error"])
        report = json.loads((stage / "qa/460-reconstruction.json").read_text())
        self.assertFalse(report["qa"]["cornersTransparent"])
        self.assertEqual(report["qa"]["cornerAlpha255"], [255, 255, 255, 255])

    def test_exact_control_comparison_rejects_one_channel_change(self):
        reference = self.directory / "changed-reference.png"
        with Image.open(self.fixture["expected"]) as source:
            image = source.copy()
        pixel = image.getpixel((1000, 1400))
        image.putpixel((1000, 1400), (pixel[0] ^ 1, *pixel[1:]))
        image.save(reference, icc_profile=self.fixture["profile"])
        image.close()
        stage, process = self.worker("comparison-failure", reference=reference)
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse((stage / "result.json").exists())
        failure = json.loads((stage / "error.json").read_text())
        self.assertTrue(failure["comparison"]["iccBytesEqual"])
        self.assertFalse(failure["comparison"]["decodedRgbaEqual"])
        self.assertEqual(failure["comparison"]["differingPixels"], 1)
        self.assertEqual(failure["comparison"]["maxChannelError255"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
