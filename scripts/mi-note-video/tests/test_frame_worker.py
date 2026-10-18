import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import frame_worker


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

    def test_comparison_errors_match_former_inline_operations(self):
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
        requests = [
            {"id": 1, "operation": "inspect", "args": {"input": str(self.directory / "missing.png")}},
            {"id": 2, "operation": "inspect", "args": {"input": str(self.frame)}},
            {"id": 3, "operation": "compare", "args": {"first": str(self.reference), "second": str(self.frame)}},
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
        self.assertEqual(responses[2]["result"], frame_worker.compare_images(self.reference, self.frame))
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
