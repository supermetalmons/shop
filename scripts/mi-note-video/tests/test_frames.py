import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures.process import BrokenProcessPool
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageCms


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import frames


def crashed_preparation(input_path, *args):
    if Path(input_path).stem == "0001":
        os._exit(23)
    return frames.prepare_frame(input_path, *args)


def tracked_preparation(input_path, output_path, *args):
    Path(output_path).with_suffix(".worker.json").write_text(json.dumps({"pid": os.getpid(), "group": os.getpgrp()}))
    return frames.prepare_frame(input_path, output_path, *args)


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


class BlackPaddingIccTests(unittest.TestCase):
    def full_transform(self, image, source, target):
        return ImageCms.applyTransform(image, frames.color_transform(source, target))

    def padded_image(self, size=(37, 37)):
        image = Image.new("RGB", size, "black")
        y, x = np.indices((size[1] - 12, size[0] - 10))
        pixels = np.stack([(17 * x + y) % 256, (3 * x + 29 * y) % 256, (x + y * 7) % 256], axis=2).astype(np.uint8)
        image.paste(Image.fromarray(pixels), (3, 5))
        return image

    def prepare_optimized(self, source, output, space, **options):
        with Image.open(source) as image:
            image.load()
            return frames.prepare_loaded_frame(image, source, output, space, black_padding=True, **options)

    def assert_transform_equal(self, image, source, target):
        before, info = image.tobytes(), image.info.copy()
        expected = self.full_transform(image, source, target)
        actual = frames.transform_black_padded_rgb(image, source, target)
        self.assertEqual((actual.mode, actual.size, actual.info), (expected.mode, expected.size, expected.info))
        self.assertEqual(actual.tobytes(), expected.tobytes())
        self.assertEqual(image.tobytes(), before)
        self.assertEqual(image.info, info)

    def test_partial_and_all_black_images_match_full_icc_conversion_and_metadata(self):
        exif = Image.Exif()
        exif[270] = "native capture metadata"
        for source_space in ("srgb", "p3"):
            source = frames.PROFILE_PATHS[source_space].read_bytes()
            for target_space in ("srgb", "p3"):
                target = frames.PROFILE_PATHS[target_space].read_bytes()
                for image in (self.padded_image(), Image.new("RGB", (19, 17), "black")):
                    with self.subTest(source=source_space, target=target_space, bounds=image.getbbox()):
                        image.info.update(icc_profile=source, exif=exif.tobytes(), transparency=(7, 8, 9), dpi=(144, 144))
                        self.assert_transform_equal(image, source, target)

    def test_single_red_green_and_blue_pixels_at_every_edge_are_preserved(self):
        source = frames.PROFILE_PATHS["srgb"].read_bytes()
        target = frames.PROFILE_PATHS["p3"].read_bytes()
        for color in ((1, 0, 0), (0, 1, 0), (0, 0, 1), (255, 0, 0), (0, 255, 0), (0, 0, 255)):
            for position in ((0, 0), (11, 0), (0, 9), (11, 9), (5, 4)):
                with self.subTest(color=color, position=position):
                    image = Image.new("RGB", (12, 10), "black")
                    image.putpixel(position, color)
                    self.assert_transform_equal(image, source, target)

    def test_full_bounding_rectangle_keeps_the_original_full_transform(self):
        source = frames.PROFILE_PATHS["srgb"].read_bytes()
        target = frames.PROFILE_PATHS["p3"].read_bytes()
        for image in (Image.new("RGB", (1, 1), (0, 0, 1)), self.padded_image()):
            image.putpixel((0, 0), (1, 0, 0))
            image.putpixel((image.width - 1, image.height - 1), (0, 1, 0))
            with patch.object(ImageCms, "applyTransform", wraps=ImageCms.applyTransform) as apply:
                frames.transform_black_padded_rgb(image, source, target)
            self.assertEqual(apply.call_count, 1)
            self.assertIs(apply.call_args.args[0], image)

    def test_empty_geometry_delegates_to_the_original_transform(self):
        source = frames.PROFILE_PATHS["srgb"].read_bytes()
        target = frames.PROFILE_PATHS["p3"].read_bytes()
        for dimensions in ((0, 0), (0, 7), (7, 0)):
            image = Image.new("RGB", dimensions)
            failure = ValueError("empty image transform")
            with patch.object(ImageCms, "applyTransform", side_effect=failure) as apply:
                with self.assertRaises(ValueError) as raised:
                    frames.transform_black_padded_rgb(image, source, target)
            self.assertIs(raised.exception, failure)
            self.assertEqual(apply.call_count, 1)
            self.assertIs(apply.call_args.args[0], image)

    def test_padding_uses_transformed_black_and_cache_is_bound_to_both_profiles(self):
        calls = []

        def transform(source, target):
            return (sum(source) % 31 + 1, sum(target) % 37 + 1, (sum(source) + sum(target)) % 41 + 1)

        def apply(image, selected):
            calls.append((image.size, selected))
            pixels = (np.asarray(image, dtype=np.uint16) + np.asarray(selected, dtype=np.uint16)) % 256
            result = Image.fromarray(pixels.astype(np.uint8))
            result.info = {**image.info, "icc_profile": bytes(selected)}
            return result

        frames.transformed_black_rgb.cache_clear()
        self.addCleanup(frames.transformed_black_rgb.cache_clear)
        profiles = [(b"source-a", b"target-a"), (b"source-b", b"target-a"), (b"source-a", b"target-b")]
        with patch.object(frames, "color_transform", side_effect=transform), patch.object(ImageCms, "applyTransform", side_effect=apply):
            for source, target in profiles + profiles:
                image = self.padded_image()
                image.info["metadata"] = "preserved"
                self.assert_transform_equal(image, source, target)
            self.assert_transform_equal(Image.new("RGB", (9, 7), "black"), *profiles[0])
        self.assertEqual(frames.transformed_black_rgb.cache_info().misses, 3)
        self.assertEqual(frames.transformed_black_rgb.cache_info().hits, 3)
        self.assertEqual(sum(size == (1, 1) for size, _ in calls), 4)

    def test_prepared_png_bytes_reports_and_full_canvas_lanczos_match_original(self):
        for mode, crop, size in (("RGB", None, None), ("RGB", None, 24), ("RGBA", (1, 1, 33, 33), 22),
                                 ("RGB", (2, 3, 29, 27), None)):
            with self.subTest(mode=mode, crop=crop, size=size), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, baseline, candidate = root / "input.png", root / "baseline.png", root / "candidate.png"
                image = self.padded_image().convert(mode)
                image.save(source, icc_profile=frames.PROFILE_PATHS["srgb"].read_bytes())
                original = source.read_bytes()
                expected = frames.prepare_frame(source, baseline, "p3", crop=crop, size=size)
                calls = []
                resize = Image.Image.resize

                def tracked_resize(current, *args, **kwargs):
                    calls.append((current.size, args, kwargs))
                    return resize(current, *args, **kwargs)

                with patch.object(Image.Image, "resize", tracked_resize):
                    actual = self.prepare_optimized(source, candidate, "p3", crop=crop, size=size)
                self.assertEqual(candidate.read_bytes(), baseline.read_bytes())
                self.assertEqual(json.dumps({**actual, "path": "OUTPUT"}, sort_keys=True),
                                 json.dumps({**expected, "path": "OUTPUT"}, sort_keys=True))
                self.assertEqual(source.read_bytes(), original)
                self.assertEqual(len(calls), int(size is not None))
                if size is not None:
                    expected_canvas = (crop[2], crop[3]) if crop else image.size
                    self.assertEqual(calls[0], (expected_canvas, ((size, size), Image.Resampling.LANCZOS), {}))

    def test_standalone_preparation_never_uses_bbox_or_black_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.png"
            self.padded_image().save(source, icc_profile=frames.PROFILE_PATHS["srgb"].read_bytes())
            with patch.object(Image.Image, "getbbox", side_effect=AssertionError("Default preparation must not inspect padding")), \
                    patch.object(frames, "transform_black_padded_rgb", side_effect=AssertionError("Default preparation must keep the original ICC path")), \
                    patch.object(frames, "transformed_black_rgb", side_effect=AssertionError("Default preparation must not touch the black cache")):
                default = frames.prepare_frame(source, root / "default.png", "p3", size=24)
                with Image.open(source) as image:
                    image.load()
                    loaded = frames.prepare_loaded_frame(image, source, root / "loaded.png", "p3", size=24)
                    explicit = frames.prepare_loaded_frame(image, source, root / "false.png", "p3", size=24, black_padding=False)
            self.assertEqual((root / "default.png").read_bytes(), (root / "loaded.png").read_bytes())
            self.assertEqual((root / "default.png").read_bytes(), (root / "false.png").read_bytes())
            for report in (loaded, explicit):
                self.assertEqual({**report, "path": "OUTPUT"}, {**default, "path": "OUTPUT"})

    def test_black_padding_requires_an_explicit_boolean_opt_in(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = self.padded_image()
            image.info["icc_profile"] = frames.PROFILE_PATHS["srgb"].read_bytes()
            for value in (1, "true", None, []):
                with self.subTest(value=value), self.assertRaisesRegex(ValueError, "must be a boolean"):
                    frames.prepare_loaded_frame(image, root / "input.png", root / "output.png", "p3", black_padding=value)
            self.assertFalse((root / "output.png").exists())

    def test_existing_profile_alpha_crop_mode_and_size_errors_are_unchanged(self):
        cases = [
            ("RGB", None, {}), ("RGB", b"invalid ICC", {}),
            ("RGBA", "profile", {"alpha": 0}), ("L", "profile", {}),
            ("RGB", "profile", {"size": 0}), ("RGB", "profile", {"size": 40}),
            ("RGB", "profile", {"crop": (35, 35, 3, 3)}),
            ("RGB", "profile", {"crop": (1, 1, 29, 27), "size": 20}),
        ]
        for mode, profile, options in cases:
            with self.subTest(mode=mode, options=options), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "input.png"
                image = self.padded_image().convert(mode)
                values = dict(options)
                if "alpha" in values:
                    image.putalpha(values.pop("alpha"))
                profile_bytes = frames.PROFILE_PATHS["srgb"].read_bytes() if profile == "profile" else profile
                image.save(source, **({"icc_profile": profile_bytes} if profile_bytes is not None else {}))
                with self.assertRaises(Exception) as expected:
                    frames.prepare_frame(source, root / "baseline.png", "p3", **values)
                with self.assertRaises(Exception) as actual:
                    self.prepare_optimized(source, root / "candidate.png", "p3", **values)
                self.assertIs(type(actual.exception), type(expected.exception))
                self.assertEqual(str(actual.exception), str(expected.exception))
                self.assertFalse((root / "baseline.png").exists())
                self.assertFalse((root / "candidate.png").exists())


class PreparationSequenceTests(unittest.TestCase):
    def fixture(self, directory, count=8):
        source = Path(directory) / "source"
        source.mkdir()
        y, x = np.indices((36, 36))
        for index in range(count):
            pixels = np.stack([(x * 31 + index * 7) % 256, (y * 19 + index * 29) % 256,
                               ((x + y) * 23 + index * 11) % 256], axis=2).astype(np.uint8)
            profile = frames.PROFILE_PATHS["p3" if index % 2 else "srgb"].read_bytes()
            Image.fromarray(pixels).save(source / f"{index:04d}.png", icc_profile=profile)
        return source

    def test_parallel_preparation_matches_serial_bytes_reports_and_profile_order(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(frames, "FRAME_COUNT", 8):
            source = self.fixture(directory)
            originals = {path.name: path.read_bytes() for path in source.iterdir()}
            serial = Path(directory) / "serial"
            expected = frames.prepare_sequence(source, serial, "p3", size=24)
            expected.pop("output")
            for workers in (2, 4):
                with self.subTest(workers=workers):
                    target = Path(directory) / f"parallel-{workers}"
                    report = frames.prepare_sequence(source, target, "p3", size=24, workers=workers)
                    report.pop("output")
                    self.assertEqual(report, expected)
                    self.assertEqual(sorted(path.name for path in target.iterdir()), sorted(originals))
                    for name, original in originals.items():
                        self.assertEqual((source / name).read_bytes(), original)
                        self.assertEqual((target / name).read_bytes(), (serial / name).read_bytes())

    def test_rejects_missing_extra_frames_and_existing_output_before_processing(self):
        for invalid in ("missing", "extra", "output"):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as directory, patch.object(frames, "FRAME_COUNT", 8):
                source = self.fixture(directory)
                target = Path(directory) / "prepared"
                if invalid == "missing":
                    (source / "0001.png").unlink()
                elif invalid == "extra":
                    (source / "extra.png").write_bytes(b"untouched")
                else:
                    target.mkdir()
                    (target / "existing").write_bytes(b"untouched")
                with self.assertRaisesRegex(ValueError, "exactly 8|already exists"):
                    frames.prepare_sequence(source, target, "p3", size=24, workers=4)
                self.assertEqual(target.exists(), invalid == "output")
                if invalid == "output":
                    self.assertEqual((target / "existing").read_bytes(), b"untouched")

    def test_worker_input_failures_propagate_and_drain_all_children(self):
        cases = {
            "corrupt": (OSError, "cannot identify"),
            "missing-icc": (ValueError, "missing an ICC"),
            "invalid-icc": (OSError, "cannot open profile"),
            "transparent": (ValueError, "must be opaque"),
            "mode": (ValueError, "Expected an RGB or RGBA"),
            "dimensions": (ValueError, "captured dimensions differ"),
        }
        for invalid, (error, message) in cases.items():
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as directory, patch.object(frames, "FRAME_COUNT", 8):
                source = self.fixture(directory)
                target = Path(directory) / "prepared"
                bad = source / "0001.png"
                profile = frames.PROFILE_PATHS["p3"].read_bytes()
                if invalid == "corrupt":
                    bad.write_bytes(b"broken PNG")
                elif invalid == "missing-icc":
                    Image.new("RGB", (36, 36)).save(bad)
                elif invalid == "invalid-icc":
                    Image.new("RGB", (36, 36)).save(bad, icc_profile=b"invalid ICC")
                elif invalid == "transparent":
                    Image.new("RGBA", (36, 36), (1, 2, 3, 0)).save(bad, icc_profile=profile)
                elif invalid == "mode":
                    Image.new("L", (36, 36)).save(bad, icc_profile=profile)
                else:
                    Image.new("RGB", (30, 30)).save(bad, icc_profile=profile)
                previous = {child.pid for child in multiprocessing.active_children()}
                with self.assertRaisesRegex(error, message):
                    frames.prepare_sequence(source, target, "p3", size=24, workers=4)
                self.assertEqual({child.pid for child in multiprocessing.active_children()}, previous)
                self.assertFalse(list(target.glob("*.pending.png")))
                self.assertFalse((target / "0007.png").exists())

    def test_parallel_preparation_rejects_different_prepared_dimensions(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(frames, "FRAME_COUNT", 8):
            source = self.fixture(directory)
            Image.new("RGB", (30, 30)).save(source / "0001.png", icc_profile=frames.PROFILE_PATHS["p3"].read_bytes())
            with self.assertRaisesRegex(ValueError, "prepared dimensions differ"):
                frames.prepare_sequence(source, Path(directory) / "prepared", "p3", workers=4)

    def test_abrupt_worker_exit_fails_without_leaving_children(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(frames, "FRAME_COUNT", 8):
            source = self.fixture(directory)
            previous = {child.pid for child in multiprocessing.active_children()}
            with patch.object(frames, "prepare_frame", crashed_preparation), self.assertRaises(BrokenProcessPool):
                frames.prepare_sequence(source, Path(directory) / "prepared", "p3", size=24, workers=4)
            self.assertEqual({child.pid for child in multiprocessing.active_children()}, previous)

    @unittest.skipUnless(hasattr(os, "getpgrp"), "POSIX process groups required")
    def test_workers_stay_in_parent_process_group(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(frames, "FRAME_COUNT", 8):
            source = self.fixture(directory)
            target = Path(directory) / "prepared"
            with patch.object(frames, "prepare_frame", tracked_preparation):
                frames.prepare_sequence(source, target, "p3", size=24, workers=4)
            records = [json.loads(path.read_text()) for path in target.glob("*.worker.json")]
            self.assertEqual(len(records), 8)
            self.assertTrue(all(record["pid"] != os.getpid() and record["group"] == os.getpgrp() for record in records))
            self.assertLessEqual(len({record["pid"] for record in records}), 4)

    @unittest.skipUnless(hasattr(os, "killpg"), "POSIX process groups required")
    def test_group_interruption_stops_preparation_workers_without_success(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.fixture(directory)
            target = Path(directory) / "prepared"
            script = Path(directory) / "interrupted.py"
            script.write_text(f"""import json, os, sys, time
from pathlib import Path
sys.path.insert(0, {str(Path(frames.__file__).parent)!r})
import frames

def waiting_preparation(input_path, output_path, *args):
    marker = Path(output_path).with_suffix('.worker.json')
    pending = marker.with_suffix('.pending')
    pending.write_text(json.dumps({{'pid': os.getpid(), 'group': os.getpgrp()}}))
    pending.replace(marker)
    time.sleep(30)

if __name__ == '__main__':
    frames.FRAME_COUNT = 8
    frames.prepare_frame = waiting_preparation
    print(json.dumps(frames.prepare_sequence(sys.argv[1], sys.argv[2], 'p3', workers=4)), flush=True)
""")
            process = subprocess.Popen([sys.executable, str(script), str(source), str(target)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
            try:
                deadline = time.monotonic() + 10
                while len(list(target.glob("*.worker.json"))) < 4 and time.monotonic() < deadline:
                    self.assertIsNone(process.poll(), "Preparation exited before its workers started")
                    time.sleep(.02)
                records = [json.loads(path.read_text()) for path in target.glob("*.worker.json")]
                self.assertEqual(len(records), 4)
                self.assertTrue(all(record["group"] == process.pid for record in records))
                os.killpg(process.pid, signal.SIGTERM)
                stdout, _ = process.communicate(timeout=5)
                self.assertNotEqual(process.returncode, 0)
                self.assertEqual(stdout, "")
                deadline = time.monotonic() + 5
                while True:
                    running = [record["pid"] for record in records if any(state and not state.startswith("Z") for state in
                               subprocess.run(["ps", "-o", "stat=", "-p", str(record["pid"])], capture_output=True,
                                              text=True, check=False).stdout.split())]
                    if not running or time.monotonic() >= deadline:
                        break
                    time.sleep(.02)
                self.assertEqual(running, [])
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.communicate(timeout=5)

    def test_worker_count_is_bounded_and_cli_defaults_to_four(self):
        with tempfile.TemporaryDirectory() as directory:
            for workers in (True, 0, -1, 1.5, 5):
                with self.subTest(workers=workers), self.assertRaises(ValueError):
                    frames.prepare_sequence(directory, Path(directory) / "prepared", "p3", workers=workers)
            self.assertFalse((Path(directory) / "prepared").exists())
        command = ["frames.py", "prepare-sequence", "--input", "/input", "--output", "/output", "--space", "p3"]
        for arguments, expected in ((command, 4), (command + ["--workers", "1"], 1)):
            with patch.object(sys, "argv", arguments), patch.object(frames, "prepare_sequence", return_value={}) as prepare, \
                    patch("builtins.print"):
                frames.main()
            self.assertEqual(prepare.call_args.args[-1], expected)


if __name__ == "__main__":
    unittest.main()
