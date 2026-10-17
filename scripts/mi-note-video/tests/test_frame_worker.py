import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import frame_worker
from test_frames import tile_fixture, landscape_viewport_fixture


COMPARE_SOURCE = """import sys,json,hashlib,numpy as np
from PIL import Image
a=Image.open(sys.argv[1]);b=Image.open(sys.argv[2]);aa=np.asarray(a);bb=np.asarray(b);icc=a.info.get('icc_profile')
same_size=aa.shape==bb.shape
equal=bool(same_size and np.array_equal(aa,bb));same_icc=bool(icc and icc==b.info.get('icc_profile'))
print(json.dumps({'passed':equal and same_icc,'pixelExact':equal,'iccExact':same_icc,'iccSha256':hashlib.sha256(icc).hexdigest() if icc else None}))"""
BLACK_EXTERIOR_SOURCE = """import sys,json,hashlib,numpy as np
from PIL import Image
image=Image.open(sys.argv[1]);image.load();bounds=json.loads(sys.argv[2]);size=int(sys.argv[3]);a=np.asarray(image);l,t,r,b=bounds;icc=image.info.get('icc_profile')
passed=image.size==(size,size) and image.mode=='RGB' and bool(icc) and all(np.all(part==0) for part in (a[:t],a[b:],a[t:b,:l],a[t:b,r:]))
print(json.dumps({'passed':bool(passed),'bounds':bounds,'iccSha256':hashlib.sha256(icc).hexdigest() if icc else None}))"""


def uncached_static_check(reference, paths, bounds, size, expansion_pixels):
    with Image.open(reference) as image:
        image.load()
        profile = image.info.get("icc_profile")
        if image.size != (size, size) or image.mode != "RGB" or not profile:
            raise ValueError("Invalid static reference")
        reference_pixels = np.asarray(image)
    left, top, right, bottom = bounds
    mask = np.ones((size, size), dtype=bool)
    mask[top:bottom, left:right] = False
    expected = reference_pixels[mask]
    checks = []
    for path in paths:
        with Image.open(path) as image:
            image.load()
            if image.size != (size, size) or image.mode != "RGB":
                raise ValueError("Invalid static-check frame: " + path)
            icc_equal = image.info.get("icc_profile") == profile
            pixels = np.asarray(image)[mask]
        different = np.any(expected != pixels, axis=1)
        count = int(different.sum())
        if count:
            delta = np.abs(expected.astype(np.int16) - pixels.astype(np.int16))
            maximum, mean = int(delta.max()), float(delta.mean())
        else:
            maximum, mean = 0, 0.0
        checks.append({"path": path, "equal": count == 0, "iccEqual": icc_equal, "differentPixels": count,
                       "maxChannelError": maximum, "meanChannelError": mean, "passed": count == 0 and icc_equal})
    return {"reference": reference, "iccSha256": hashlib.sha256(profile).hexdigest(), "excludedCardBounds": bounds,
            "expansionPixels": expansion_pixels, "checks": checks, "passed": all(check["passed"] for check in checks)}


class FrameWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.profile = frame_worker.frames.PROFILE_PATHS["p3"].read_bytes()
        self.reference = self.directory / "reference.png"
        self.frame = self.directory / "frame.png"
        self.save(self.reference)
        self.save(self.frame)
        self.bounds = [4, 5, 24, 28]

    def save(self, path, changed=None, profile=None, size=(32, 32), mode="RGB"):
        image = Image.new(mode, size, "black")
        if changed:
            for position, color in changed:
                image.putpixel(position, color)
        image.save(path, icc_profile=self.profile if profile is None else profile)

    def check(self, checker, digest=None, paths=None, bounds=None):
        return checker.check(str(self.reference), paths or [str(self.frame)], bounds or self.bounds, 32, 240, digest)

    def test_static_reports_match_original_for_equal_different_interior_and_icc_cases(self):
        checker = frame_worker.StaticExteriorChecker()
        for changes, profile in [(None, self.profile), ([((10, 10), (80, 30, 90))], self.profile),
                                 ([((0, 0), (80, 30, 90)), ((31, 31), (255, 25, 0))], self.profile),
                                 (None, frame_worker.frames.PROFILE_PATHS["srgb"].read_bytes())]:
            self.save(self.frame, changes, profile)
            expected = uncached_static_check(str(self.reference), [str(self.frame)], self.bounds, 32, 240)
            self.assertEqual(self.check(checker), expected)
        self.assertEqual(self.check(checker, paths=[str(self.frame)] * 3),
                         uncached_static_check(str(self.reference), [str(self.frame)] * 3, self.bounds, 32, 240))

    def test_reference_is_rehashed_every_time_but_decoded_once_until_content_or_bounds_change(self):
        checker = frame_worker.StaticExteriorChecker()
        original = self.reference.read_bytes()
        digest = hashlib.sha256(original).hexdigest()
        with patch.object(frame_worker.Image, "open", wraps=Image.open) as opened, \
                patch.object(frame_worker.Path, "read_bytes", autospec=True, side_effect=Path.read_bytes) as read:
            self.assertTrue(self.check(checker, digest)["passed"])
            self.assertTrue(self.check(checker, digest)["passed"])
            self.assertEqual(opened.call_count, 3)
            self.assertEqual(read.call_count, 2)
        self.save(self.reference, [((0, 0), (70, 0, 0))])
        with self.assertRaisesRegex(ValueError, "Trusted static reference checksum changed"):
            self.check(checker, digest)
        self.assertIsNone(checker.cached)
        changed = self.check(checker)
        self.assertFalse(changed["passed"])
        self.assertEqual(changed, uncached_static_check(str(self.reference), [str(self.frame)], self.bounds, 32, 240))
        self.assertTrue(self.check(checker, bounds=[0, 0, 32, 32])["passed"])
        self.reference.write_bytes(original)
        self.assertTrue(self.check(checker, digest)["passed"])

    def test_corrupted_or_invalid_reference_and_frames_never_reuse_stale_pixels(self):
        checker = frame_worker.StaticExteriorChecker()
        self.assertTrue(self.check(checker)["passed"])
        self.reference.write_bytes(b"invalid PNG")
        with self.assertRaises(OSError):
            self.check(checker)
        self.assertIsNone(checker.cached)
        for size, mode, profile in [((16, 32), "RGB", self.profile), ((32, 32), "RGBA", self.profile),
                                    ((32, 32), "RGB", b"")]:
            self.save(self.reference, size=size, mode=mode, profile=profile)
            with self.assertRaisesRegex(ValueError, "Invalid static reference"):
                self.check(checker)
        self.save(self.reference)
        self.save(self.frame, size=(16, 32))
        with self.assertRaisesRegex(ValueError, "Invalid static-check frame"):
            self.check(checker)
        self.frame.write_bytes(b"invalid PNG")
        with self.assertRaises(OSError):
            self.check(checker)
        self.save(self.frame)
        self.assertTrue(self.check(checker)["passed"])

    def test_inspect_and_stitch_match_existing_functions_and_exact_png_bytes(self):
        operations = frame_worker.FrameOperations()
        self.assertEqual(operations.run("inspect", {"input": str(self.frame)}), frame_worker.frames.inspect_image(self.frame))
        for name, fixture, size in [("tiled", tile_fixture, 128), ("sideways", landscape_viewport_fixture, 400)]:
            directory = self.directory / name
            directory.mkdir()
            metadata, *_ = fixture(directory, overlap_extra=16) if name == "tiled" else fixture(directory)
            baseline, candidate = directory / "baseline.png", directory / "candidate.png"
            expected = frame_worker.frames.stitch_frame(metadata, baseline, size, ["p3"])
            result = operations.run("stitch", {"metadata": str(metadata), "output": str(candidate),
                                                "deliverySize": size, "deliverySpaces": ["p3"]})
            self.assertEqual(candidate.read_bytes(), baseline.read_bytes())
            self.assertEqual({**result, "path": expected["path"]}, expected)
            self.assertFalse(list(directory.glob("*.pending.png")))
            with self.assertRaisesRegex(ValueError, "Output already exists"):
                operations.run("stitch", {"metadata": str(metadata), "output": str(candidate),
                                           "deliverySize": size, "deliverySpaces": ["p3"]})

    def test_compare_matches_former_inline_operation_for_pixels_sizes_modes_and_icc(self):
        operations = frame_worker.FrameOperations()
        cases = [{}, {"changed": [((10, 10), (1, 0, 0))]}, {"size": (16, 32)}, {"mode": "RGBA"},
                 {"profile": frame_worker.frames.PROFILE_PATHS["srgb"].read_bytes()}, {"profile": b""}]
        for options in cases:
            with self.subTest(options=options.keys()):
                self.save(self.frame, **options)
                for first, second in [(self.reference, self.frame), (self.frame, self.frame)]:
                    expected = subprocess.run([sys.executable, "-c", COMPARE_SOURCE, str(first), str(second)],
                                              capture_output=True, text=True, check=True, timeout=10)
                    actual = operations.run("compare", {"first": str(first), "second": str(second)})
                    self.assertEqual(actual, json.loads(expected.stdout))

    def test_black_exterior_matches_former_inline_operation_for_bounds_modes_and_icc(self):
        operations = frame_worker.FrameOperations()
        cases = [{}, {"changed": [((10, 10), (1, 0, 0))]},
                 *({"changed": [(point, (1, 0, 0))]} for point in [(0, 0), (31, 31), (0, 10), (31, 10)]),
                 {"size": (16, 32)}, {"mode": "RGBA"}, {"profile": b""}]
        for options in cases:
            self.save(self.frame, **options)
            for bounds in [self.bounds, [0, 0, 32, 32]]:
                with self.subTest(options=options.keys(), bounds=bounds):
                    expected = subprocess.run([sys.executable, "-c", BLACK_EXTERIOR_SOURCE, str(self.frame),
                                               json.dumps(bounds), "32"],
                                              capture_output=True, text=True, check=True, timeout=10)
                    actual = operations.run("black-exterior", {"input": str(self.frame), "bounds": bounds, "size": 32})
                    self.assertEqual(actual, json.loads(expected.stdout))

    def test_preflight_comparison_errors_match_former_inline_operations(self):
        operations = frame_worker.FrameOperations()
        self.frame.write_bytes(b"invalid PNG")
        for path in [self.frame, self.directory / "missing.png"]:
            for operation, source, args, command_args in [
                ("compare", COMPARE_SOURCE, {"first": str(self.reference), "second": str(path)}, [str(self.reference), str(path)]),
                ("black-exterior", BLACK_EXTERIOR_SOURCE, {"input": str(path), "bounds": self.bounds, "size": 32},
                 [str(path), json.dumps(self.bounds), "32"]),
            ]:
                with self.subTest(operation=operation, path=path.name):
                    expected = subprocess.run([sys.executable, "-c", source, *command_args],
                                              capture_output=True, text=True, timeout=10)
                    self.assertNotEqual(expected.returncode, 0)
                    with self.assertRaises(OSError) as caught:
                        operations.run(operation, args)
                    self.assertIn(type(caught.exception).__name__ + ": " + str(caught.exception), expected.stderr)

    def test_prepare_matches_cli_reports_and_exact_png_bytes(self):
        operations = frame_worker.FrameOperations()
        self.save(self.frame, [((10, 10), (90, 40, 10))])
        for size in [16, 32]:
            baseline, candidate = self.directory / f"cli-{size}.png", self.directory / f"worker-{size}.png"
            expected = subprocess.run([sys.executable, frame_worker.frames.__file__, "prepare", "--input", str(self.frame),
                                       "--output", str(baseline), "--space", "p3", "--size", str(size)],
                                      capture_output=True, text=True, check=True, timeout=10)
            actual = operations.run("prepare", {"input": str(self.frame), "output": str(candidate), "space": "p3", "size": size})
            report = json.loads(expected.stdout)
            self.assertEqual({**actual, "path": report["path"]}, report)
            self.assertEqual(candidate.read_bytes(), baseline.read_bytes())
            with self.assertRaisesRegex(ValueError, "Output already exists"):
                operations.run("prepare", {"input": str(self.frame), "output": str(candidate), "space": "p3", "size": size})

    def test_prepare_rejects_same_invalid_inputs_as_cli_and_preserves_outputs(self):
        operations = frame_worker.FrameOperations()
        for index, (image_options, size) in enumerate([({"profile": b""}, 16), ({"mode": "L"}, 16), ({}, 33)]):
            self.save(self.frame, **image_options)
            baseline, candidate = self.directory / f"invalid-cli-{index}.png", self.directory / f"invalid-worker-{index}.png"
            expected = subprocess.run([sys.executable, frame_worker.frames.__file__, "prepare", "--input", str(self.frame),
                                       "--output", str(baseline), "--space", "p3", "--size", str(size)],
                                      capture_output=True, text=True, timeout=10)
            self.assertNotEqual(expected.returncode, 0)
            with self.assertRaises(ValueError) as caught:
                operations.run("prepare", {"input": str(self.frame), "output": str(candidate), "space": "p3", "size": size})
            self.assertIn(str(caught.exception), expected.stderr)
            self.assertFalse(baseline.exists())
            self.assertFalse(candidate.exists())
        self.assertFalse(list(self.directory.glob("*.pending.png")))

    def test_worker_protocol_recovers_after_operation_failure_and_flushes_multiple_results(self):
        files = self.directory / "files.json"
        files.write_text(json.dumps([str(self.frame)]))
        requests = [
            {"id": 1, "operation": "inspect", "args": {"input": str(self.directory / "missing.png")}},
            {"id": 2, "operation": "inspect", "args": {"input": str(self.frame)}},
            {"id": 3, "operation": "static-check", "args": {"reference": str(self.reference), "filesPath": str(files),
             "referenceSha256": hashlib.sha256(self.reference.read_bytes()).hexdigest(), "bounds": self.bounds,
             "size": 32, "expansionPixels": 240}},
            {"id": 4, "operation": "prepare", "args": {"input": str(self.frame), "output": str(self.directory / "prepared.png"),
             "space": "p3", "size": 32}},
            {"id": 5, "operation": "compare", "args": {"first": str(self.reference), "second": str(self.frame)}},
            {"id": 6, "operation": "black-exterior", "args": {"input": str(self.frame), "bounds": self.bounds, "size": 32}},
            {"id": 7, "operation": "compare", "args": {"first": str(self.reference), "second": str(self.directory / "missing.png")}},
            {"id": 8, "operation": "black-exterior", "args": {"input": str(self.frame), "bounds": self.bounds, "size": 32}},
        ]
        result = subprocess.run([sys.executable, "-u", frame_worker.__file__],
                                input="".join(json.dumps(request) + "\n" for request in requests),
                                capture_output=True, text=True, timeout=10, check=True)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([response["id"] for response in responses], list(range(1, 9)))
        self.assertEqual(responses[0]["error"]["type"], "FileNotFoundError")
        self.assertEqual(responses[1]["result"], frame_worker.frames.inspect_image(self.frame))
        self.assertEqual(responses[2]["result"], self.check(frame_worker.StaticExteriorChecker()))
        self.assertTrue(frame_worker.compare_images(str(self.directory / "prepared.png"), str(self.frame))["passed"])
        self.assertTrue(responses[3]["result"]["icc"])
        self.assertTrue(responses[4]["result"]["passed"])
        self.assertTrue(responses[5]["result"]["passed"])
        self.assertEqual(responses[6]["error"]["type"], "FileNotFoundError")
        self.assertEqual(responses[7]["result"], responses[5]["result"])
        self.assertEqual(result.stderr, "")

    def test_malformed_protocol_fails_closed_without_executing_following_requests(self):
        for line in ["not JSON\n", '{"id":true,"operation":"inspect","args":{}}\n',
                     '{"id":1,"operation":"inspect","args":null}\n', '{}', 'x' * (4 * 1024 * 1024 + 1)]:
            output = io.StringIO()
            code = frame_worker.serve(io.StringIO(line + '{"id":2,"operation":"inspect","args":{}}\n'), output)
            self.assertEqual(code, 1)
            responses = output.getvalue().splitlines()
            self.assertEqual(len(responses), 1)
            self.assertIsNone(json.loads(responses[0])["id"])


if __name__ == "__main__":
    unittest.main()
