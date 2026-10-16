import importlib.util
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageCms


spec = importlib.util.spec_from_file_location("frames", Path(__file__).resolve().parents[1] / "frames.py")
frames = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frames)


def tile_fixture(directory, columns=1, overlap_extra=0, dimension=256):
    directory = Path(directory)
    y, x = np.indices((dimension, dimension))
    pixels = np.stack([(x + y) % 200, (x * 3) % 200, (y * 5) % 200], axis=2).astype(np.uint8)
    canvas = Image.new("RGBA", (dimension + 64, dimension + 64), (255, 255, 255, 255))
    canvas.paste(Image.fromarray(pixels), (32, 32))
    viewport_width = dimension + 64 if columns == 1 else dimension
    profile = frames.PROFILE_PATHS["srgb"].read_bytes()
    records = []
    for row in range(2):
        for col in range(columns):
            name = f"tile-{row}-{col}.png"
            y = row * (64 - overlap_extra)
            canvas.crop((col * 64, y, col * 64 + viewport_width, y + dimension + overlap_extra)).save(directory / name, icc_profile=profile)
            records.append({
                "path": name, "row": row, "col": col, "originX": col * 64 - 32, "originY": y - 32,
                "viewportWidth": viewport_width, "viewportHeight": dimension + overlap_extra, "icc": frames.profile_metadata(profile),
            })
    metadata = {"width": dimension, "height": dimension, "columns": columns, "rows": 2, "tiles": records}
    metadata_path = directory / "tiles.json"
    metadata_path.write_text(json.dumps(metadata))
    return metadata_path, metadata, pixels, profile


def landscape_viewport_fixture(directory):
    directory = Path(directory)
    y, x = np.indices((460, 240))
    artwork = np.stack([(x + y) % 251, (x * 3) % 239, (y * 5) % 227], axis=2).astype(np.uint8)
    scene = Image.new("RGB", (600, 600), "black")
    scene.paste(Image.fromarray(artwork), (180, 70))
    profile = frames.PROFILE_PATHS["p3"].read_bytes()
    reference = directory / "reference.png"
    scene.save(reference, icc_profile=profile)
    viewport = Image.new("RGBA", (928, 444), (0, 0, 0, 255))
    viewport.paste(scene.transpose(Image.Transpose.ROTATE_270), (32, -110))
    viewport.save(directory / "viewport.png", icc_profile=profile)
    metadata = {
        "singleViewportCapture": True, "landscapeViewportCapture": True,
        "captureRotationDegrees": 90, "backgroundRgb": [0, 0, 0], "shadows": False,
        "width": 600, "height": 600, "captureScale": 600 / 1080, "columns": 1, "rows": 1,
        "backgroundReference": {"path": "reference.png", "sha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
                                "excludedBounds": [160, 50, 440, 550]},
        "tiles": [{
            "path": "viewport.png", "row": 0, "col": 0, "originX": -32, "originY": 110,
            "viewportWidth": 928, "viewportHeight": 444, "icc": frames.profile_metadata(profile),
            "snapshot": {"dpr": 2, "scrollX": 0, "scrollY": 71, "rotationDegrees": 90,
                         "background": "#000000", "shadowEnabled": False, "effect": {"shadow": "none"},
                         "rotatorRect": {"x": 51, "y": 35, "width": 230, "height": 120},
                         "stageDocumentPixels": {"x": 32, "y": 32, "width": 600, "height": 600}},
        }],
    }
    metadata_path = directory / "tiles.json"
    metadata_path.write_text(json.dumps(metadata))
    return metadata_path, metadata, np.asarray(scene), profile


class FramePreparationTests(unittest.TestCase):
    def test_icc_conversion_changes_pixels_preserves_input_and_crops_exactly(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "input.png", Path(directory) / "output.png"
            Image.new("RGB", (10, 8), (200, 100, 50)).save(source, icc_profile=frames.PROFILE_PATHS["p3"].read_bytes())
            original = source.read_bytes()
            result = frames.prepare_frame(source, target, "srgb", (2, 1, 5, 6))
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual((result["width"], result["height"]), (5, 6))
            with Image.open(target) as image:
                self.assertNotEqual(image.getpixel((0, 0)), (200, 100, 50))
                self.assertEqual(image.info["icc_profile"], frames.PROFILE_PATHS["srgb"].read_bytes())
            with self.assertRaisesRegex(ValueError, "already exists"):
                frames.prepare_frame(source, target, "srgb")

    def test_missing_profile_requires_explicit_known_srgb(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "input.png", Path(directory) / "output.png"
            Image.new("RGB", (10, 8), (200, 100, 50)).save(source)
            with self.assertRaisesRegex(ValueError, "missing an ICC"):
                frames.prepare_frame(source, target, "p3")
            self.assertFalse(target.exists())
            result = frames.prepare_frame(source, target, "p3", input_space="srgb")
            self.assertTrue(result["inputProfileAssumed"])
            with Image.open(target) as image:
                self.assertNotEqual(image.getpixel((0, 0)), (200, 100, 50))

    def test_crop_does_not_pad_and_transparent_inputs_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "input.png", Path(directory) / "output.png"
            Image.new("RGBA", (10, 8), (200, 100, 50, 0)).save(source)
            with self.assertRaisesRegex(ValueError, "exceeds input"):
                frames.prepare_frame(source, target, "srgb", (9, 7, 2, 2), "srgb")
            with self.assertRaisesRegex(ValueError, "must be opaque"):
                frames.prepare_frame(source, target, "srgb", input_space="srgb")

    def test_encoding_rejects_incomplete_sequence_before_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "video.mp4"
            with self.assertRaisesRegex(ValueError, "exactly 276"):
                frames.encode_frames(directory, output, "srgb")
            self.assertFalse(output.exists())

    def test_encoding_uses_configured_executables_for_encode_probe_and_decode(self):
        stream = {
            "codec_type": "video", "codec_name": "hevc", "codec_tag_string": "hvc1", "width": 2, "height": 2,
            "pix_fmt": "yuv420p10le", "color_range": "tv", "color_space": "bt709",
            "color_transfer": "iec61966-2-1", "color_primaries": "smpte432", "avg_frame_rate": "60/1",
            "nb_frames": "276", "nb_read_frames": "276", "duration": "4.6",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            competing = root / "path-bin"
            competing.mkdir()
            for name in ["ffmpeg", "ffprobe"]:
                executable = competing / name
                executable.write_text("#!/bin/sh\nexit 99\n")
                executable.chmod(0o700)
            configured = {"MI_NOTE_FFMPEG": str(root / "pinned tools/ffmpeg"),
                          "MI_NOTE_FFPROBE": str(root / "pinned tools/ffprobe")}
            for label, overrides in [("configured", configured), ("unset", {})]:
                with self.subTest(environment=label), patch.dict(frames.os.environ, {"PATH": str(competing), **overrides}, clear=True):
                    self.assertEqual(shutil.which("ffmpeg"), str(competing / "ffmpeg"))
                    self.assertEqual(shutil.which("ffprobe"), str(competing / "ffprobe"))

                    def subprocess_result(command, **kwargs):
                        if "-frames:v" in command:
                            Path(command[-1]).write_bytes(b"mock encoded video")
                        stdout = json.dumps({"streams": [stream]}) if "-count_frames" in command else ""
                        return frames.subprocess.CompletedProcess(command, 0, stdout, "")

                    with patch.object(frames, "validate_frames", return_value={}), \
                            patch.object(frames.subprocess, "run", side_effect=subprocess_result) as run:
                        result = frames.encode_frames(root, root / f"{label}.mp4", "p3", size=2)
                    ffmpeg = overrides.get("MI_NOTE_FFMPEG", "ffmpeg")
                    ffprobe = overrides.get("MI_NOTE_FFPROBE", "ffprobe")
                    self.assertEqual([call.args[0][0] for call in run.call_args_list], [ffmpeg, ffprobe, ffmpeg])
                    self.assertTrue(result["fullyDecoded"])

    def test_sequence_reuses_transform_and_preserves_numbered_frames(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(frames, "FRAME_COUNT", 2):
            source, target = Path(directory) / "source", Path(directory) / "prepared"
            source.mkdir()
            for index in range(2):
                Image.new("RGB", (10, 8), (200, 100 + index, 50)).save(source / f"{index:04d}.png")
            frames.color_transform.cache_clear()
            result = frames.prepare_sequence(source, target, "p3", (1, 2, 5, 4), "srgb")
            self.assertEqual(result["frames"], 2)
            self.assertEqual((result["width"], result["height"]), (5, 4))
            self.assertEqual(sorted(path.name for path in target.iterdir()), ["0000.png", "0001.png"])
            self.assertEqual(frames.color_transform.cache_info().misses, 1)
            self.assertEqual(frames.color_transform.cache_info().hits, 1)

    def test_downsampling_is_one_lanczos_pass_after_icc_conversion(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "input.png", Path(directory) / "output.png"
            pixels = np.empty((18, 18, 3), dtype=np.uint8)
            pixels[:, ::2] = (230, 10, 15)
            pixels[:, 1::2] = (10, 230, 15)
            original = Image.fromarray(pixels)
            original.save(source, icc_profile=frames.PROFILE_PATHS["p3"].read_bytes())
            transform = frames.color_transform(frames.PROFILE_PATHS["p3"].read_bytes(), frames.PROFILE_PATHS["srgb"].read_bytes())
            expected = ImageCms.applyTransform(original, transform).resize((12, 12), Image.Resampling.LANCZOS)
            wrong_order = ImageCms.applyTransform(original.resize((12, 12), Image.Resampling.LANCZOS), transform)
            self.assertFalse(np.array_equal(np.asarray(expected), np.asarray(wrong_order)))
            calls = []
            resize = Image.Image.resize

            def tracked_resize(image, *args, **kwargs):
                calls.append((args, kwargs))
                return resize(image, *args, **kwargs)

            with patch.object(Image.Image, "resize", tracked_resize):
                report = frames.prepare_frame(source, target, "srgb", size=12)
            self.assertEqual(len(calls), 1)
            self.assertEqual(report["capturedSize"], {"width": 18, "height": 18})
            self.assertEqual(report["resample"]["filter"], "Lanczos")
            self.assertTrue(report["resample"]["afterIccConversion"])
            with Image.open(target) as image:
                np.testing.assert_array_equal(np.asarray(image), np.asarray(expected))
                self.assertEqual(image.info["icc_profile"], frames.PROFILE_PATHS["srgb"].read_bytes())

    def test_encoding_size_validation_uses_requested_square_dimensions(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(frames, "FRAME_COUNT", 2):
            for index in range(2):
                Image.new("RGB", (12, 12), "white").save(Path(directory) / f"{index:04d}.png", icc_profile=frames.PROFILE_PATHS["srgb"].read_bytes())
            frames.validate_frames(directory, "srgb", size=12)
            with self.assertRaisesRegex(ValueError, "1080x1080"):
                frames.validate_frames(directory, "srgb")


class TileStitchTests(unittest.TestCase):
    def test_landscape_preserves_native_pixels_and_icc_with_lossless_unrotation(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path, _, expected, profile = landscape_viewport_fixture(directory)
            viewport = Path(directory) / "viewport.png"
            original = viewport.read_bytes()
            output = Path(directory) / "native.png"
            with patch.object(Image.Image, "resize", side_effect=AssertionError("unexpected resampling")):
                report = frames.stitch_frame(metadata_path, output, 400, ["p3"])
            self.assertTrue(report["passed"])
            self.assertTrue(report["singleViewportCapture"])
            self.assertTrue(report["landscapeViewportCapture"])
            self.assertEqual(report["samplingRatio"], 1.5)
            self.assertEqual(report["guardPixels"], 32)
            self.assertEqual(report["seams"], [])
            proof = report["backgroundPadding"]
            self.assertEqual(proof["pasteBox"], [0, 142, 600, 522])
            self.assertEqual(proof["protectedBounds"], [68, 178, 532, 422])
            self.assertEqual(proof["restoredProtectedBounds"], [178, 68, 422, 532])
            self.assertEqual(proof["sourceCropBox"], [32, 32, 632, 412])
            self.assertEqual(proof["paddedBoxes"], [[0, 0, 600, 142], [0, 522, 600, 600]])
            self.assertEqual(proof["blackBorderBoxes"], [[0, 142, 600, 150], [0, 514, 600, 522]])
            self.assertEqual(proof["reference"]["excludedBounds"], [160, 50, 440, 550])
            self.assertEqual(proof["reference"]["rotatedExcludedBounds"], [50, 160, 550, 440])
            self.assertEqual(proof["blackBorderRadiusPixels"], 8)
            self.assertEqual(proof["antialiasAllowancePixels"], 2)
            self.assertEqual(proof["shadowAllowancePixels"], 0)
            self.assertEqual(proof["paddingRgb"], [0, 0, 0])
            for key in ("blackBordersExact", "referenceExteriorExactBlack", "referenceIccMatches",
                        "referencePaddedRegionsExactBlack", "capturedExteriorExactBlack", "nativePixelsPreserved", "losslessUnrotation"):
                self.assertTrue(proof[key], key)
            self.assertEqual(proof["sourceViewport"]["sha256"], hashlib.sha256(original).hexdigest())
            self.assertEqual(viewport.read_bytes(), original)
            self.assertEqual(proof["inverseRotationDegrees"], 90)
            self.assertFalse(proof["inverseRotation"]["resampling"])
            self.assertEqual(proof["inverseRotation"]["restoredRgbSha256"], hashlib.sha256(expected.tobytes()).hexdigest())
            with Image.open(viewport) as source:
                crop = source.convert("RGB").crop(tuple(proof["sourceCropBox"]))
                self.assertEqual(proof["sourceCropRgbSha256"], hashlib.sha256(crop.tobytes()).hexdigest())
            with Image.open(output) as image:
                self.assertEqual(image.mode, "RGB")
                self.assertEqual(image.size, (600, 600))
                self.assertEqual(image.info["icc_profile"], profile)
                np.testing.assert_array_equal(np.asarray(image), expected)

    def test_landscape_requires_explicit_mode_ratio_rotation_black_and_no_shadow(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path, metadata, _, _ = landscape_viewport_fixture(directory)
            changes = [
                {"landscapeViewportCapture": False}, {"landscapeViewportCapture": 1}, {"singleViewportCapture": False},
                {"columns": 2}, {"rows": 2}, {"width": 598}, {"captureScale": 2},
                {"captureRotationDegrees": -90}, {"backgroundRgb": [255, 255, 255]}, {"shadows": True},
            ]
            for change in changes:
                with self.subTest(change=change):
                    metadata_path.write_text(json.dumps({**metadata, **change}))
                    with self.assertRaises(ValueError):
                        frames.stitch_frame(metadata_path, Path(directory) / "rejected.png", 400, ["p3"])
            for omitted in ("singleViewportCapture", "landscapeViewportCapture", "captureScale", "captureRotationDegrees",
                            "backgroundRgb", "shadows", "backgroundReference"):
                with self.subTest(omitted=omitted):
                    metadata_path.write_text(json.dumps({key: value for key, value in metadata.items() if key != omitted}))
                    with self.assertRaises(ValueError):
                        frames.stitch_frame(metadata_path, Path(directory) / "rejected.png", 400, ["p3"])
            metadata_path.write_text(json.dumps(metadata))
            for delivery_size in (None, 300, 398, 402):
                with self.subTest(delivery_size=delivery_size), self.assertRaisesRegex(ValueError, "Landscape-viewport mode"):
                    frames.stitch_frame(metadata_path, Path(directory) / "rejected.png", delivery_size)
            metadata.update(width=3243, height=3243, captureScale=3243 / 1080)
            metadata_path.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, "Landscape-viewport mode"):
                frames.stitch_frame(metadata_path, Path(directory) / "rejected.png", 2162, ["p3"])
            self.assertFalse((Path(directory) / "rejected.png").exists())

    def test_landscape_rejects_clipping_geometry_rotation_or_shadow_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path, metadata, _, _ = landscape_viewport_fixture(directory)
            changes = [
                (lambda item: item["snapshot"]["rotatorRect"].update(y=16), "protected card or antialiasing"),
                (lambda item: item["snapshot"]["rotatorRect"].update(height=175), "protected card or antialiasing"),
                (lambda item: item.update(originY=112), "origin differs"),
                (lambda item: item["snapshot"].update(scrollY=71.5), "raster phase"),
                (lambda item: item["snapshot"].update(dpr=1.5), "DPR-2"),
                (lambda item: item["snapshot"]["stageDocumentPixels"].update(x=30), "32-pixel gutter"),
                (lambda item: item["snapshot"]["rotatorRect"].update(width=float("nan")), "must be finite"),
                (lambda item: item["snapshot"].update(rotationDegrees=-90), "90-degree clockwise"),
                (lambda item: item["snapshot"].update(background="#ffffff"), "black background"),
                (lambda item: item["snapshot"].update(shadowEnabled=True), "no shadow"),
                (lambda item: item["snapshot"]["effect"].update(shadow="0 0 4px black"), "no shadow"),
            ]
            for change, error in changes:
                with self.subTest(error=error):
                    changed = json.loads(json.dumps(metadata))
                    change(changed["tiles"][0])
                    metadata_path.write_text(json.dumps(changed))
                    with self.assertRaisesRegex(ValueError, error):
                        frames.stitch_frame(metadata_path, Path(directory) / "rejected.png", 400, ["p3"])
            self.assertFalse((Path(directory) / "rejected.png").exists())

    def test_landscape_requires_exact_black_joins_full_background_and_guarded_width(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path, metadata, _, profile = landscape_viewport_fixture(directory)
            viewport = Path(directory) / "viewport.png"
            original = viewport.read_bytes()
            for point, error in (
                ((100, 32), "exact-black 8-pixel strip"), ((100, 39), "exact-black 8-pixel strip"),
                ((100, 404), "exact-black 8-pixel strip"), ((100, 411), "exact-black 8-pixel strip"),
                ((50, 100), "captured exterior"), ((620, 200), "captured exterior"),
            ):
                with self.subTest(point=point):
                    viewport.write_bytes(original)
                    with Image.open(viewport) as source:
                        image = source.copy()
                    image.putpixel(point, (0, 1, 0, 255))
                    image.save(viewport, icc_profile=profile)
                    with self.assertRaisesRegex(ValueError, error):
                        frames.stitch_frame(metadata_path, Path(directory) / "rejected.png", 400, ["p3"])
            viewport.write_bytes(original)
            with Image.open(viewport) as source:
                image = source.crop((0, 0, 663, 444))
            image.save(viewport, icc_profile=profile)
            metadata["tiles"][0]["viewportWidth"] = 663
            metadata_path.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, "complete canvas width"):
                frames.stitch_frame(metadata_path, Path(directory) / "rejected.png", 400, ["p3"])
            self.assertFalse((Path(directory) / "rejected.png").exists())

    def test_landscape_reference_integrity_format_icc_and_black_padded_regions_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path, metadata, _, profile = landscape_viewport_fixture(directory)
            reference = Path(directory) / "reference.png"
            original = reference.read_bytes()
            changes = [
                (lambda image: image, profile, False, "SHA-256"),
                (lambda image: image.convert("RGBA"), profile, True, "RGB frame"),
                (lambda image: image.crop((0, 0, 599, 600)), profile, True, "RGB frame"),
                (lambda image: image, frames.PROFILE_PATHS["srgb"].read_bytes(), True, "ICC"),
            ]
            for transform, icc, update_hash, error in changes:
                with self.subTest(error=error):
                    reference.write_bytes(original)
                    with Image.open(reference) as source:
                        image = transform(source.copy())
                    image.save(reference, icc_profile=icc)
                    changed = json.loads(json.dumps(metadata))
                    changed["backgroundReference"]["sha256"] = hashlib.sha256(reference.read_bytes()).hexdigest() if update_hash else "0" * 64
                    metadata_path.write_text(json.dumps(changed))
                    with self.assertRaisesRegex(ValueError, error):
                        frames.stitch_frame(metadata_path, Path(directory) / "rejected.png", 400, ["p3"])
            for point in ((0, 0), (0, 300), (599, 300), (0, 599)):
                with self.subTest(point=point):
                    reference.write_bytes(original)
                    with Image.open(reference) as source:
                        image = source.copy()
                    image.putpixel(point, (0, 0, 1))
                    image.save(reference, icc_profile=profile)
                    changed = json.loads(json.dumps(metadata))
                    changed["backgroundReference"]["sha256"] = hashlib.sha256(reference.read_bytes()).hexdigest()
                    metadata_path.write_text(json.dumps(changed))
                    with self.assertRaisesRegex(ValueError, "exterior must be exactly RGB black"):
                        frames.stitch_frame(metadata_path, Path(directory) / "rejected.png", 400, ["p3"])
            reference.write_bytes(original)
            with Image.open(reference) as source:
                image = source.copy()
            image.putpixel((100, 300), (1, 0, 0))
            image.save(reference, icc_profile=profile)
            metadata["backgroundReference"].update(excludedBounds=[80, 50, 550, 550], sha256=hashlib.sha256(reference.read_bytes()).hexdigest())
            metadata_path.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, "padded regions must be exactly RGB black"):
                frames.stitch_frame(metadata_path, Path(directory) / "rejected.png", 400, ["p3"])
            self.assertFalse((Path(directory) / "rejected.png").exists())

    def test_p3_selection_preserves_native_pixels_when_unused_srgb_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path, metadata, _, profile = tile_fixture(directory, overlap_extra=16)
            for record in metadata["tiles"]:
                Image.new("RGBA", (record["viewportWidth"], record["viewportHeight"]), (100, 100, 50, 255)).save(
                    Path(directory) / record["path"], icc_profile=profile)
            lower = metadata["tiles"][1]
            lower_path = Path(directory) / lower["path"]
            with Image.open(lower_path) as source:
                image = source.copy()
            for y in (80, 96, 112):
                for x in range(16, 256, 16):
                    image.putpixel((x - lower["originX"], y - lower["originY"]), (103, 100, 50, 255))
            image.save(lower_path, icc_profile=profile)
            native_path = Path(directory) / "native.png"
            self.assertTrue(frames.stitch_frame(metadata_path, native_path)["passed"])
            for selection in (None, ["srgb", "p3"], ["srgb"]):
                with self.subTest(selection=selection):
                    rejected = Path(directory) / "rejected.png"
                    with self.assertRaisesRegex(ValueError, "Tile overlap/seam QA failed") as raised:
                        frames.stitch_frame(metadata_path, rejected, 256, selection)
                    seam = json.loads(str(raised.exception).split("Tile overlap/seam QA failed: ", 1)[1])
                    srgb = seam["delivery"]["spaces"]["srgb"]
                    self.assertGreater(srgb["fractionPixelsOver2"], frames.DELIVERY_FRACTION_OVER_2)
                    self.assertLessEqual(srgb["meanChannelError255"], frames.DELIVERY_MEAN_ERROR)
                    self.assertFalse(rejected.exists())
            output = Path(directory) / "p3.png"
            report = frames.stitch_frame(metadata_path, output, 256, ["p3"])
            self.assertTrue(report["passed"])
            self.assertEqual(report["deliverySpaces"], ["p3"])
            delivery = report["seams"][0]["delivery"]
            self.assertEqual(delivery["selectedSpaces"], ["p3"])
            self.assertEqual(list(delivery["spaces"]), ["p3"])
            self.assertEqual(delivery["spaces"]["p3"]["fractionPixelsOver2"], 0)
            self.assertEqual(delivery["spaces"]["p3"]["maxChannelError255"], 2)
            with Image.open(output) as stitched, Image.open(native_path) as native:
                np.testing.assert_array_equal(np.asarray(stitched), np.asarray(native))
                self.assertEqual(stitched.info["icc_profile"], profile)

    def test_delivery_spaces_are_validated_and_require_delivery_size(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path, _, _, _ = tile_fixture(directory)
            output = Path(directory) / "output.png"
            for selection in ([], ["p3", "p3"], ["srgb", "unknown"], [None], [["p3"]], "p3"):
                with self.subTest(selection=selection), self.assertRaisesRegex(ValueError, "nonempty list of distinct"):
                    frames.stitch_frame(metadata_path, output, 256, selection)
                self.assertFalse(output.exists())
            with self.assertRaisesRegex(ValueError, "require a delivery size"):
                frames.stitch_frame(metadata_path, output, delivery_spaces=["p3"])
            self.assertFalse(output.exists())

    def test_delivery_spaces_cli_parses_only_distinct_known_choices(self):
        self.assertEqual(frames.parse_delivery_spaces("p3"), ("p3",))
        self.assertEqual(frames.parse_delivery_spaces("srgb, p3"), ("srgb", "p3"))
        for selection in ("", "p3,p3", "srgb,unknown", "p3,", "P3"):
            with self.subTest(selection=selection), self.assertRaises(frames.argparse.ArgumentTypeError):
                frames.parse_delivery_spaces(selection)

    def test_vertical_and_two_dimensional_grids_preserve_pixels_and_icc(self):
        for columns in (1, 2):
            with self.subTest(columns=columns), tempfile.TemporaryDirectory() as directory:
                metadata_path, _, expected, profile = tile_fixture(directory, columns)
                output = Path(directory) / "stitched.png"
                result = frames.stitch_frame(metadata_path, output)
                self.assertTrue(result["passed"])
                self.assertTrue(result["iccPreservedByteForByte"])
                self.assertEqual(len(result["seams"]), 1 if columns == 1 else 4)
                with Image.open(output) as image:
                    self.assertEqual(image.mode, "RGB")
                    self.assertEqual(image.info["icc_profile"], profile)
                    np.testing.assert_array_equal(np.asarray(image), expected)

    def test_small_accepted_overlap_difference_is_hard_copied_without_blending(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path, _, expected, profile = tile_fixture(directory)
            tile_path = Path(directory) / "tile-1-0.png"
            with Image.open(tile_path) as source:
                image = source.copy()
            pixel = image.getpixel((100, 100))
            image.putpixel((100, 100), (pixel[0] + 1, pixel[1], pixel[2], 255))
            image.save(tile_path, icc_profile=profile)
            output = Path(directory) / "stitched.png"
            report = frames.stitch_frame(metadata_path, output)
            self.assertEqual(report["seams"][0]["band"]["maxChannelError255"], 1)
            expected[132, 68, 0] += 1
            with Image.open(output) as stitched:
                np.testing.assert_array_equal(np.asarray(stitched), expected)

    def test_seam_maximum_and_mean_error_limits_reject_unstable_tiles(self):
        for maximum_error in (True, False):
            with self.subTest(maximum_error=maximum_error), tempfile.TemporaryDirectory() as directory:
                metadata_path, _, _, profile = tile_fixture(directory)
                tile_path = Path(directory) / "tile-1-0.png"
                with Image.open(tile_path) as source:
                    pixels = np.asarray(source).copy()
                if maximum_error:
                    pixels[100, 100, 0] += 21
                else:
                    pixels[32:160, 32:288, :3] += 1
                Image.fromarray(pixels).save(tile_path, icc_profile=profile)
                output = Path(directory) / "stitched.png"
                with self.assertRaisesRegex(ValueError, "QA failed"):
                    frames.stitch_frame(metadata_path, output)
                self.assertFalse(output.exists())

    def test_geometry_metadata_and_profile_mismatches_are_rejected(self):
        for change, error in (
            (lambda data: data["tiles"][0].update(originX=-31.5), "originX must be an integer"),
            (lambda data: data["tiles"][1].update(originY=100), "edge guard"),
            (lambda data: data["tiles"][0].update(viewportWidth=319), "dimensions differ"),
            (lambda data: data["tiles"][1].update(row=0), "duplicated"),
            (lambda data: data["tiles"][0].update(icc={"sha256": "bad"}), "does not match metadata"),
        ):
            with self.subTest(error=error), tempfile.TemporaryDirectory() as directory:
                metadata_path, metadata, _, _ = tile_fixture(directory)
                change(metadata)
                metadata_path.write_text(json.dumps(metadata))
                with self.assertRaisesRegex(ValueError, error):
                    frames.stitch_frame(metadata_path, Path(directory) / "stitched.png")
        with tempfile.TemporaryDirectory() as directory:
            metadata_path, _, _, _ = tile_fixture(directory)
            tile_path = Path(directory) / "tile-1-0.png"
            with Image.open(tile_path) as source:
                image = source.copy()
            image.save(tile_path, icc_profile=frames.PROFILE_PATHS["p3"].read_bytes())
            with self.assertRaisesRegex(ValueError, "profiles differ"):
                frames.stitch_frame(metadata_path, Path(directory) / "stitched.png")

    def test_isolated_difference_outside_seam_band_is_diagnostic_only(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path, metadata, expected, profile = tile_fixture(directory, dimension=384)
            lower = metadata["tiles"][1]
            tile_path = Path(directory) / lower["path"]
            with Image.open(tile_path) as image:
                pixels = np.asarray(image).copy()
            pixels[110 - lower["originY"], 180 - lower["originX"], 0] += 21
            Image.fromarray(pixels).save(tile_path, icc_profile=profile)
            output = Path(directory) / "stitched.png"
            report = frames.stitch_frame(metadata_path, output, 256)
            self.assertEqual(report["seams"][0]["overlap"]["maxChannelError255"], 21)
            self.assertEqual(report["seams"][0]["band"]["maxChannelError255"], 0)
            self.assertTrue(report["passed"])
            with Image.open(output) as image:
                np.testing.assert_array_equal(np.asarray(image), expected)

    def test_delivery_sampling_matches_full_frame_lanczos_and_accepts_sparse_rounding(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path, metadata, expected, profile = tile_fixture(directory, dimension=384)
            lower_path = Path(directory) / "tile-1-0.png"
            with Image.open(lower_path) as image:
                pixels = np.asarray(image).copy()
            pixels[160, 212, 0] += 9
            Image.fromarray(pixels).save(lower_path, icc_profile=profile)
            altered = expected.copy()
            altered[192, 180, 0] += 9
            tiles = []
            for record in metadata["tiles"]:
                with Image.open(Path(directory) / record["path"]) as image:
                    tiles.append({**record, "image": image.convert("RGBA")})
            report = frames.delivery_difference(tiles[0], tiles[1], (0, 128, 384, 256), 384, 384, 256, profile)
            self.assertTrue(report["passed"])
            for space in ("srgb", "p3"):
                transform = frames.color_transform(profile, frames.PROFILE_PATHS[space].read_bytes())
                full = [ImageCms.applyTransform(Image.fromarray(array), transform).resize((256, 256), Image.Resampling.LANCZOS) for array in (expected, altered)]
                metrics = frames.difference_metrics(*(image.crop(report["outputBox"]) for image in full))
                for key, value in metrics.items():
                    self.assertAlmostEqual(report["spaces"][space][key], value, places=12)
            stitched = frames.stitch_frame(metadata_path, Path(directory) / "stitched.png", 256)
            self.assertTrue(stitched["passed"])

    def test_delivery_rejects_coherent_patch_and_line_even_when_native_means_pass(self):
        for pattern in ("patch", "line"):
            with self.subTest(pattern=pattern), tempfile.TemporaryDirectory() as directory:
                metadata_path, _, _, profile = tile_fixture(directory, dimension=384)
                lower_path = Path(directory) / "tile-1-0.png"
                with Image.open(lower_path) as image:
                    pixels = np.asarray(image).copy()
                if pattern == "patch":
                    pixels[150:182, 200:232, :3] += 1
                else:
                    pixels[160:162, 32:416, :3] += 1
                Image.fromarray(pixels).save(lower_path, icc_profile=profile)
                self.assertTrue(frames.stitch_frame(metadata_path, Path(directory) / "native.png")["passed"])
                with self.assertRaisesRegex(ValueError, "Tile overlap/seam QA failed"):
                    frames.stitch_frame(metadata_path, Path(directory) / "delivery.png", 256)

    def test_delivery_isolated_error_away_from_horizontal_and_vertical_cuts_is_accepted(self):
        for orientation in ("horizontal", "vertical"):
            with self.subTest(orientation=orientation), tempfile.TemporaryDirectory() as directory:
                metadata_path, metadata, _, profile = tile_fixture(directory, columns=2, dimension=384)
                target = [1, 0] if orientation == "horizontal" else [0, 1]
                record = next(tile for tile in metadata["tiles"] if [tile["row"], tile["col"]] == target)
                x, y = (182, 152) if orientation == "horizontal" else (152, 182)
                tile_path = Path(directory) / record["path"]
                with Image.open(tile_path) as image:
                    pixels = np.asarray(image).copy()
                x, y = x - record["originX"], y - record["originY"]
                pixels[y:y + 2, x:x + 2, 1] += 20
                Image.fromarray(pixels).save(tile_path, icc_profile=profile)
                report = frames.stitch_frame(metadata_path, Path(directory) / "delivery.png", 256)
                seam = next(item for item in report["seams"] if item["orientation"] == orientation and item["first"] == [0, 0])
                self.assertEqual(seam["band"]["maxChannelError255"], 20)
                self.assertGreater(seam["delivery"]["spaces"]["srgb"]["maxChannelError255"], 10)
                self.assertTrue(seam["delivery"]["passed"])
                self.assertEqual(seam["delivery"]["cutInfluenceBox"], [0, 125, 128, 131] if orientation == "horizontal" else [125, 0, 131, 128])
                for space in ("srgb", "p3"):
                    self.assertEqual(seam["delivery"]["spaces"][space]["cutInfluence"]["maxChannelError255"], 0)

    def test_delivery_isolated_error_near_horizontal_and_vertical_cuts_is_rejected(self):
        for orientation in ("horizontal", "vertical"):
            with self.subTest(orientation=orientation), tempfile.TemporaryDirectory() as directory:
                metadata_path, metadata, _, profile = tile_fixture(directory, columns=2, dimension=384)
                target = [1, 0] if orientation == "horizontal" else [0, 1]
                record = next(tile for tile in metadata["tiles"] if [tile["row"], tile["col"]] == target)
                x, y = (182, 194) if orientation == "horizontal" else (194, 182)
                tile_path = Path(directory) / record["path"]
                with Image.open(tile_path) as image:
                    pixels = np.asarray(image).copy()
                x, y = x - record["originX"], y - record["originY"]
                pixels[y:y + 2, x:x + 2, 1] += 20
                Image.fromarray(pixels).save(tile_path, icc_profile=profile)
                self.assertTrue(frames.stitch_frame(metadata_path, Path(directory) / "native.png")["passed"])
                output = Path(directory) / "delivery.png"
                with self.assertRaisesRegex(ValueError, "Tile overlap/seam QA failed") as raised:
                    frames.stitch_frame(metadata_path, output, 256)
                seam = json.loads(str(raised.exception).split("Tile overlap/seam QA failed: ", 1)[1])
                self.assertLessEqual(seam["delivery"]["spaces"]["srgb"]["maxChannelError255"], 20)
                self.assertGreater(seam["delivery"]["spaces"]["srgb"]["cutInfluence"]["maxChannelError255"], 10)
                self.assertFalse(output.exists())

    def test_native_peak_away_from_cut_requires_delivery_validation(self):
        for orientation in ("horizontal", "vertical"):
            with self.subTest(orientation=orientation), tempfile.TemporaryDirectory() as directory:
                metadata_path, metadata, expected, profile = tile_fixture(directory, columns=2, dimension=384)
                target = [1, 0] if orientation == "horizontal" else [0, 1]
                record = next(tile for tile in metadata["tiles"] if [tile["row"], tile["col"]] == target)
                x, y = (110, 137) if orientation == "horizontal" else (137, 110)
                tile_path = Path(directory) / record["path"]
                with Image.open(tile_path) as image:
                    pixels = np.asarray(image).copy()
                pixels[y - record["originY"], x - record["originX"], 0] += 21
                Image.fromarray(pixels).save(tile_path, icc_profile=profile)
                native_output = Path(directory) / "native.png"
                with self.assertRaisesRegex(ValueError, "Tile overlap/seam QA failed"):
                    frames.stitch_frame(metadata_path, native_output)
                self.assertFalse(native_output.exists())
                output = Path(directory) / "delivery.png"
                report = frames.stitch_frame(metadata_path, output, 256)
                seam = next(item for item in report["seams"] if item["orientation"] == orientation and item["first"] == [0, 0])
                self.assertEqual(report["maximumChannelErrorScope"], "native cut influence")
                self.assertEqual(seam["band"]["maxChannelError255"], 21)
                self.assertEqual(seam["nativeCutInfluence"]["radiusPixels"], 9)
                self.assertEqual(seam["nativeCutInfluence"]["box"], [0, 183, 192, 201] if orientation == "horizontal" else [183, 0, 201, 192])
                self.assertEqual(seam["nativeCutInfluence"]["maxChannelError255"], 0)
                self.assertTrue(seam["delivery"]["passed"])
                with Image.open(output) as image:
                    np.testing.assert_array_equal(np.asarray(image), expected)
                    self.assertEqual(image.info["icc_profile"], profile)

    def test_native_peak_at_cut_rejects_even_when_delivery_passes(self):
        for orientation in ("horizontal", "vertical"):
            with self.subTest(orientation=orientation), tempfile.TemporaryDirectory() as directory:
                metadata_path, metadata, _, profile = tile_fixture(directory, columns=2, dimension=384)
                target = [1, 0] if orientation == "horizontal" else [0, 1]
                record = next(tile for tile in metadata["tiles"] if [tile["row"], tile["col"]] == target)
                x, y = (110, 192) if orientation == "horizontal" else (192, 110)
                tile_path = Path(directory) / record["path"]
                with Image.open(tile_path) as image:
                    pixels = np.asarray(image).copy()
                pixels[y - record["originY"], x - record["originX"], 0] += 21
                Image.fromarray(pixels).save(tile_path, icc_profile=profile)
                output = Path(directory) / "delivery.png"
                with self.assertRaisesRegex(ValueError, "Tile overlap/seam QA failed") as raised:
                    frames.stitch_frame(metadata_path, output, 256)
                seam = json.loads(str(raised.exception).split("Tile overlap/seam QA failed: ", 1)[1])
                self.assertEqual(seam["nativeCutInfluence"]["maxChannelError255"], 21)
                self.assertFalse(seam["nativeCutInfluence"]["passed"])
                self.assertTrue(seam["delivery"]["passed"])
                self.assertFalse(output.exists())

    def test_delivery_coherent_patch_is_checked_only_near_each_cut_orientation(self):
        for orientation in ("horizontal", "vertical"):
            for near_cut in (False, True):
                with self.subTest(orientation=orientation, near_cut=near_cut), tempfile.TemporaryDirectory() as directory:
                    metadata_path, metadata, expected, profile = tile_fixture(directory, columns=2, dimension=384)
                    target = [1, 0] if orientation == "horizontal" else [0, 1]
                    record = next(tile for tile in metadata["tiles"] if [tile["row"], tile["col"]] == target)
                    cut_coordinate = 192 if near_cut else 152
                    x, y = (110, cut_coordinate) if orientation == "horizontal" else (cut_coordinate, 110)
                    tile_path = Path(directory) / record["path"]
                    with Image.open(tile_path) as image:
                        pixels = np.asarray(image).copy()
                    x, y = x - record["originX"], y - record["originY"]
                    pixels[y - 9:y + 9, x - 9:x + 9, :3] += 1
                    Image.fromarray(pixels).save(tile_path, icc_profile=profile)
                    output = Path(directory) / "delivery.png"
                    if near_cut:
                        with self.assertRaisesRegex(ValueError, "Tile overlap/seam QA failed") as raised:
                            frames.stitch_frame(metadata_path, output, 256)
                        seam = json.loads(str(raised.exception).split("Tile overlap/seam QA failed: ", 1)[1])
                        self.assertFalse(output.exists())
                    else:
                        report = frames.stitch_frame(metadata_path, output, 256)
                        seam = next(item for item in report["seams"] if item["orientation"] == orientation and item["first"] == [0, 0])
                        with Image.open(output) as image:
                            np.testing.assert_array_equal(np.asarray(image), expected)
                            self.assertEqual(image.info["icc_profile"], profile)
                    delivery = seam["delivery"]
                    self.assertEqual(delivery["coherenceBox"], [0, 124, 128, 132] if orientation == "horizontal" else [124, 0, 132, 128])
                    srgb = delivery["spaces"]["srgb"]
                    self.assertGreater(srgb["maximum8x8MeanChannelError255"], .75)
                    self.assertLessEqual(srgb["meanChannelError255"], .05)
                    self.assertLessEqual(srgb["maxChannelError255"], 20)
                    self.assertLessEqual(srgb["channelErrorP99_9"], 2)
                    self.assertLessEqual(srgb["fractionPixelsOver2"], .001)
                    self.assertLessEqual(srgb["cutInfluence"]["maxChannelError255"], 10)
                    coherence = srgb["coherenceInfluence"]
                    self.assertEqual(coherence["lineAxis"], "row" if orientation == "horizontal" else "column")
                    self.assertEqual(coherence["passed"], not near_cut)
                    if near_cut:
                        self.assertGreater(coherence["maximum8x8MeanChannelError255"], .75)
                    else:
                        self.assertEqual(coherence["maximum8x8MeanChannelError255"], 0)
                        self.assertTrue(delivery["passed"])

    def test_delivery_cut_line_check_uses_rows_or_columns(self):
        for orientation in ("horizontal", "vertical"):
            with self.subTest(orientation=orientation), tempfile.TemporaryDirectory() as directory:
                metadata_path, metadata, _, profile = tile_fixture(directory, columns=2, dimension=384)
                target = [1, 0] if orientation == "horizontal" else [0, 1]
                record = next(tile for tile in metadata["tiles"] if [tile["row"], tile["col"]] == target)
                tile_path = Path(directory) / record["path"]
                with Image.open(tile_path) as image:
                    pixels = np.asarray(image).copy()
                x0, y0, x1, y1 = (0, 192, 192, 194) if orientation == "horizontal" else (192, 0, 194, 192)
                pixels[y0 - record["originY"]:y1 - record["originY"], x0 - record["originX"]:x1 - record["originX"], :3] += 1
                Image.fromarray(pixels).save(tile_path, icc_profile=profile)
                output = Path(directory) / "delivery.png"
                with self.assertRaisesRegex(ValueError, "Tile overlap/seam QA failed") as raised:
                    frames.stitch_frame(metadata_path, output, 256)
                seam = json.loads(str(raised.exception).split("Tile overlap/seam QA failed: ", 1)[1])
                srgb = seam["delivery"]["spaces"]["srgb"]
                self.assertLessEqual(srgb["meanChannelError255"], .05)
                self.assertLessEqual(srgb["maxChannelError255"], 20)
                self.assertLessEqual(srgb["channelErrorP99_9"], 2)
                self.assertLessEqual(srgb["fractionPixelsOver2"], .001)
                self.assertLessEqual(srgb["cutInfluence"]["maxChannelError255"], 10)
                coherence = srgb["coherenceInfluence"]
                self.assertEqual(coherence["lineAxis"], "row" if orientation == "horizontal" else "column")
                self.assertLessEqual(coherence["maximum8x8MeanChannelError255"], .75)
                self.assertGreater(coherence["maximumAlongSeamMeanChannelError255"], .25)
                self.assertFalse(coherence["passed"])
                self.assertFalse(output.exists())

    def test_subpixel_misregistration_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path, _, _, profile = tile_fixture(directory, dimension=384)
            lower_path = Path(directory) / "tile-1-0.png"
            with Image.open(lower_path) as image:
                shifted = image.transform(image.size, Image.Transform.AFFINE, (1, 0, 0.25, 0, 1, 0), Image.Resampling.BILINEAR)
            shifted.save(lower_path, icc_profile=profile)
            with self.assertRaisesRegex(ValueError, "Tile overlap/seam QA failed"):
                frames.stitch_frame(metadata_path, Path(directory) / "stitched.png", 256)


if __name__ == "__main__":
    unittest.main()
