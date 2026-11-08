import contextlib
import fcntl
import io
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import run


class FinalistTests(unittest.TestCase):
    def invoke(self, root, *flags, prepare=None):
        def media(collection, ids, inputs):
            return inputs or [Path(f"{i}.mp4") for i in ids]

        with contextlib.ExitStack() as scope:
            scope.enter_context(patch.object(sys, "argv", ["run.py", *map(str, flags)]))
            scope.enter_context(patch.object(run, "OUTPUT", root / "output"))
            scope.enter_context(patch.object(run, "CACHE", root / "cache"))
            scope.enter_context(patch.object(run, "prepare_media", side_effect=prepare or media))
            scope.enter_context(patch.object(run, "run_worker"))
            publish = scope.enter_context(patch.object(run, "publish"))
            scope.enter_context(contextlib.redirect_stdout(io.StringIO()))
            run.main()
            return publish.call_args.args[1], publish.call_args.kwargs["files"]

    def test_full_and_filtered_sample_names_are_stable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output, files = self.invoke(root, "--samples")
            self.assertEqual(output, root / "output/acrylic/finalists")
            self.assertEqual(len(set(files)), 18)
            self.assertIn(Path("01-soft-clear-white.mp4"), files)
            self.assertTrue(all(p.name.endswith("-white.mp4") for p in files))
            self.assertTrue(all(p.parent == Path(".") and p.suffix == ".mp4" for p in files))
            filtered, knives = self.invoke(root, "--samples", "--collection", "knives",
                                           "--background", "white", "--variant", "15-high-key")
            self.assertEqual(filtered, output)
            self.assertEqual(knives, [Path(f"{i:02}-high-key-white.mp4") for i in range(5, 10)])
            self.assertEqual(run.sample_filename("3d", 904, "15-high-key"), knives[0])

    def test_explicit_and_local_sources_cannot_alias_other_exports(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = self.invoke(root, "--ids", "1")[1]
            self.assertTrue(set(first).isdisjoint(self.invoke(root, "--collection", "3d", "--ids", "1")[1]))
            clip = root / "1.mp4"
            clip.write_bytes(b"first local clip")
            files = self.invoke(root, "--input", clip, "--output", root / "custom")[1]
            clip.write_bytes(b"other local clip")
            new = self.invoke(root, "--input", clip, "--output", root / "custom")[1]
            self.assertTrue(set(files).isdisjoint(first + new))

    def test_long_local_names_publish_distinct_files_on_case_insensitive_volumes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inputs = [root / f"{stem}.mp4" for stem in
                      ("A" * 100 + "1", "a" * 100 + "2", "É" * 60 + "1", "é" * 60 + "2")]
            for source in inputs:
                source.write_bytes(b"identical source contents")

            def render(jobs, work):
                for source, _, output in jobs:
                    target = Path(output)
                    target.parent.mkdir(exist_ok=True)
                    target.write_bytes(Path(source).read_bytes())

            args = ["run.py", "--variant", run.VARIANTS[0], "--output", str(root / "export")]
            args += [part for path in inputs for part in ("--input", str(path))]
            with patch.object(sys, "argv", args), patch.object(run, "run_worker", side_effect=render):
                with contextlib.redirect_stdout(io.StringIO()):
                    run.main()
            outputs = list((root / "export").glob("*.mp4"))
            self.assertEqual(len(outputs), len(inputs))
            self.assertEqual(len({p.name.casefold() for p in outputs}), len(inputs))
            self.assertTrue(all(len(p.name.encode("utf8")) <= 255 for p in outputs))

    def test_canonical_folder_rejects_foreign_entries_before_preparing_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "output/acrylic/finalists"
            output.mkdir(parents=True)
            (output / ".DS_Store").touch()
            (output / "01-high-key-white.mp4").touch()
            run.check_finalist_directory(output)
            (output / "comparison.html").touch()
            with self.assertRaisesRegex(ValueError, "comparison.html"):
                self.invoke(root, "--samples")
            self.assertFalse((root / "cache").exists())

    def test_reserved_location_covers_symlinks_and_volume_case_rules_even_before_creation(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stderr(io.StringIO()):
            root = Path(tmp)
            frame_output = root / "output/acrylic"
            frame_output.mkdir(parents=True)
            link = root / "alias"
            link.symlink_to(frame_output, target_is_directory=True)
            insensitive = (root / "OUTPUT").exists()
            reserved = frame_output / "finalists"
            for exists in (False, True):
                if exists:
                    reserved.mkdir()
                for suffix in (Path("."), Path("new/subfolder")):
                    with self.assertRaises(SystemExit):
                        self.invoke(root, "--ids", "1", "--output", link / "finalists" / suffix)
                    alias = link / "FINALISTS" / suffix
                    if insensitive:
                        with self.assertRaises(SystemExit):
                            self.invoke(root, "--ids", "1", "--output", alias)
                    else:
                        self.assertEqual(self.invoke(root, "--ids", "1", "--output", alias)[0], alias)

    def test_preparation_and_names_use_a_single_literal_local_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as cleanup:
            root = Path(tmp)
            cleanup.callback(os.chdir, Path.cwd())
            os.chdir(root)
            for collection, name in (("videos", "-clip.mp4"), ("3d", "file:knife.glb")):
                original = root / name
                original.write_bytes(b"original artwork")
                expected = run.local_prefix(collection, original)

                def replace_original(category, ids, inputs):
                    snapshot, = inputs
                    self.assertTrue(snapshot.is_absolute())
                    self.assertEqual(snapshot.name, original.name)
                    self.assertFalse(snapshot.samefile(original))
                    update = original.with_suffix(".new")
                    update.write_bytes(b"new artwork")
                    update.replace(original)
                    self.assertEqual(snapshot.read_bytes(), b"original artwork")
                    return [snapshot]

                _, files = self.invoke(root, "--collection", collection, "--input", "./" + name,
                                       "--output", root / "export", prepare=replace_original)
                self.assertEqual(files, [run.movie_filename(expected, variant) for variant in run.VARIANTS])

    def test_verify_from_either_collection_needs_no_media_cache_or_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for selections in ([], ["--collection", "knives"]):
                with self.subTest(selections=selections), contextlib.ExitStack() as scope:
                    scope.enter_context(patch.object(sys, "argv", ["run.py", *selections, "--verify"]))
                    scope.enter_context(patch.object(run, "CACHE", root / "cache"))
                    scope.enter_context(patch.object(run, "OUTPUT", root / "output"))
                    scope.enter_context(patch.object(run, "prepare_media", side_effect=AssertionError))
                    scope.enter_context(patch.object(run, "publish", side_effect=AssertionError))
                    scope.enter_context(patch.object(run.subprocess, "run", side_effect=AssertionError))
                    scope.enter_context(contextlib.redirect_stdout(io.StringIO()))
                    run.main()
            self.assertEqual(list(root.iterdir()), [])

    def test_verification_rejects_changed_assets_before_media_preparation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            presets = root / "presets"
            shutil.copytree(run.PRESETS, presets)
            asset = presets / "15-high-key" / "mask-0.png"
            asset.write_bytes(b"wrong mask")
            with patch.object(run, "PRESETS", presets), patch.object(run, "prepare_media", side_effect=AssertionError):
                with patch.object(sys, "argv", ["run.py", "--samples", "--output", str(root / "out")]):
                    with self.assertRaisesRegex(ValueError, "mask-0.png"):
                        run.main()
            self.assertFalse((root / "out").exists())
            asset.unlink()
            with self.assertRaises(FileNotFoundError):
                run.verify_presets(presets, run.VARIANTS)

    def test_black_background_rejected(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                self.invoke(Path(tmp), "--background", "black")

    def test_sigterm_cleans_active_worker_and_staging(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scratch = root / "tmp"
            scratch.mkdir()
            (root / "clip.mp4").touch()
            probe = root / "ffprobe"
            probe.write_text(f"#!{sys.executable}\n"
                             "import fcntl, os, signal, time\nfrom pathlib import Path\n"
                             "lock = open('probe.lock', 'w')\nfcntl.flock(lock, fcntl.LOCK_EX)\n"
                             "os.kill(int(Path('cli.pid').read_text()), signal.SIGTERM)\n"
                             "time.sleep(10)\n")
            probe.chmod(0o755)
            env = {**os.environ, "TMPDIR": str(scratch), "PATH": str(root) + os.pathsep + os.environ["PATH"]}
            command = [sys.executable, run.__file__, "--input", "clip.mp4", "--variant", run.VARIANTS[0],
                       "--output", "out"]
            with subprocess.Popen(command, cwd=root, env=env) as cli:
                (root / "cli.pid").write_text(str(cli.pid))
                self.assertEqual(cli.wait(timeout=5), 128 + signal.SIGTERM)
            self.assertEqual(list(scratch.iterdir()), [])
            self.assertFalse((root / "out").exists())
            with (root / "probe.lock").open() as lock:
                start = time.monotonic()
                fcntl.flock(lock, fcntl.LOCK_EX)
                self.assertLess(time.monotonic() - start, 5)


if __name__ == "__main__":
    unittest.main()
