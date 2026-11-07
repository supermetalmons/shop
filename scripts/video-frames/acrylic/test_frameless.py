import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import knife_sources
import run
import worker


class FramelessCliTests(unittest.TestCase):
    def invoke(self, root, *flags, fail=False):
        jobs_seen = []

        def media(collection, ids, inputs):
            self.assertEqual(collection, "3d")
            return inputs or [root / f"{i}.glb" for i in ids]

        def render(jobs, work):
            jobs_seen.extend(jobs)
            for source, _, output in jobs:
                target = Path(output)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(Path(source).name.encode())
            if fail:
                raise ValueError("render validation failed")

        with contextlib.ExitStack() as scope:
            scope.enter_context(patch.object(sys, "argv", ["run.py", *map(str, flags)]))
            scope.enter_context(patch.object(run, "OUTPUT", root / "output"))
            scope.enter_context(patch.object(run, "prepare_media", side_effect=media))
            scope.enter_context(patch.object(run, "run_worker", side_effect=render))
            presets = scope.enter_context(patch.object(run, "verify_presets"))
            scope.enter_context(contextlib.redirect_stdout(io.StringIO()))
            run.main()
        return jobs_seen, presets

    def test_numbered_models_publish_one_unframed_movie_each(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            jobs, presets = self.invoke(root, "--collection", "knives", "--frameless", "--ids", "904,6")
            output = root / "output/knives/frameless"
            self.assertEqual(sorted(p.name for p in output.iterdir()), ["6.mp4", "904.mp4"])
            self.assertEqual((output / "904.mp4").read_bytes(), b"904.glb")
            self.assertTrue(all(plate is None for _, plate, _ in jobs))
            presets.assert_not_called()

    def test_sample_names_keep_actual_model_ids(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.invoke(root, "--collection", "3d", "--frameless", "--samples")
            output = root / "output/knives/frameless"
            self.assertEqual({p.name for p in output.iterdir()},
                             {f"{i}.mp4" for i in run.SAMPLES["groups"]["3d"]})
            self.assertFalse((root / "output/acrylic/finalists").exists())

    def test_local_model_uses_content_based_name_and_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "904.glb"
            source.write_bytes(b"local model")
            expected = run.local_prefix("3d", source) + ".mp4"
            output = root / "export"
            jobs, _ = self.invoke(root, "--collection", "knives", "--frameless", "--input", source,
                                  "--output", output)
            self.assertEqual([p.name for p in output.iterdir()], [expected])
            self.assertNotEqual(Path(jobs[0][0]), source)
            self.assertFalse(Path(jobs[0][0]).exists())

    def test_failed_render_does_not_replace_existing_exports(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "export"
            output.mkdir()
            previous = output / "6.mp4"
            previous.write_bytes(b"previous successful render")
            with self.assertRaisesRegex(ValueError, "render validation failed"):
                self.invoke(root, "--collection", "knives", "--frameless", "--ids", "6,904",
                            "--output", output, fail=True)
            self.assertEqual(list(output.iterdir()), [previous])
            self.assertEqual(previous.read_bytes(), b"previous successful render")

    def test_unsupported_combinations_fail_before_sources_are_prepared(self):
        invalid = [
            ["--frameless"],
            ["--frameless", "--samples"],
            ["--collection", "videos", "--frameless"],
            ["--collection", "animated", "--frameless"],
            ["--collection", "knives", "--frameless", "--variant", "08-soft-clear"],
            ["--collection", "knives", "--frameless", "--background", "white"],
            ["--collection", "knives", "--frameless", "--verify"],
        ]
        for flags in invalid:
            with self.subTest(flags=flags), contextlib.redirect_stderr(io.StringIO()):
                with patch.object(sys, "argv", ["run.py", *flags]):
                    with patch.object(run, "prepare_media") as prepare, patch.object(run, "run_worker") as render:
                        with self.assertRaises(SystemExit) as caught:
                            run.main()
                        self.assertEqual(caught.exception.code, 2)
                        prepare.assert_not_called()
                        render.assert_not_called()

    def test_frameless_samples_cannot_use_reserved_framed_finalists(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for suffix in (Path("."), Path("nested")):
                with self.subTest(suffix=suffix), contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit):
                        self.invoke(root, "--collection", "knives", "--frameless", "--samples",
                                    "--output", root / "output/acrylic/finalists" / suffix)

    def test_framed_default_still_publishes_both_approved_variants(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            jobs, presets = self.invoke(root, "--collection", "knives", "--ids", "6")
            output = root / "output/acrylic/3d"
            self.assertEqual({p.name for p in output.iterdir()},
                             {"3d-6-soft-clear-white.mp4", "3d-6-high-key-white.mp4"})
            self.assertEqual({Path(plate).name for _, plate, _ in jobs}, set(run.VARIANTS))
            presets.assert_called_once_with(run.PRESETS, run.VARIANTS)


class FramelessWorkerTests(unittest.TestCase):
    def test_frameless_exports_renderer_output_without_compositing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sources = [root / "904.glb", root / "6.glb"]
            outputs = [root / "export/904.mp4", root / "export/6.mp4"]
            calls = []

            def render(models, directory, *, frameless=False):
                calls.append((models, frameless))
                directory.mkdir(parents=True, exist_ok=True)
                movies = []
                for source in models:
                    movie = directory / f"{source.stem}.mp4"
                    movie.write_bytes(source.name.encode())
                    movies.append(movie)
                return movies

            jobs = [(str(source), None, str(output)) for source, output in zip(sources, outputs)]
            with patch.object(sys, "stdin", io.StringIO(json.dumps(jobs))):
                with patch.object(worker, "render_knives", side_effect=render), patch.object(worker, "composite") as composite:
                    with patch.object(worker.tempfile, "gettempdir", return_value=str(root)):
                        with contextlib.redirect_stdout(io.StringIO()):
                            worker.main()
            self.assertEqual(calls, [(sources, True)])
            composite.assert_not_called()
            self.assertEqual([p.read_bytes() for p in outputs], [b"904.glb", b"6.glb"])


class FramelessValidationTests(unittest.TestCase):
    def verify(self, timestamps):
        video = {
            "codec_name": "h264", "width": 1920, "height": 1080, "pix_fmt": "yuv420p",
            "color_space": "bt709", "color_transfer": "iec61966-2-1", "color_primaries": "bt709",
            "color_range": "tv", "sample_aspect_ratio": "1:1", "start_pts": 0,
            "nb_frames": "300", "time_base": "1/15360", "duration_ts": 76800,
            "avg_frame_rate": "60/1",
        }
        result = subprocess.CompletedProcess([], 0, stdout="\n".join(f"{pts} 1/15360" for pts in timestamps))
        with patch.object(knife_sources, "streams", return_value={"video": video}):
            with patch.object(knife_sources, "fast_start", return_value=True):
                with patch.object(knife_sources.subprocess, "run", return_value=result):
                    knife_sources.verify_frameless(Path("orbit.mp4"))

    def test_rejects_irregular_frame_timing_despite_valid_summary_metadata(self):
        timestamps = [index * 256 for index in range(300)]
        timestamps[150] += 128
        with self.assertRaisesRegex(ValueError, "frame 150 has an incorrect presentation timestamp"):
            self.verify(timestamps)

    def test_rejects_truncated_decode_despite_metadata_claiming_300_frames(self):
        timestamps = [index * 256 for index in range(299)]
        with self.assertRaisesRegex(ValueError, "decoded 299, expected 300 frames"):
            self.verify(timestamps)


if __name__ == "__main__":
    unittest.main()
