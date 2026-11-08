import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import run
import knife_sources


class SourceLookupTests(unittest.TestCase):
    def test_video_and_model_sources_ignore_legacy_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for collection, relative, source_id, extension in (
                ("videos", "sources", 13, "mp4"), ("3d", "knives/sources", 17, "glb"),
            ):
                with self.subTest(collection=collection):
                    legacy = root / relative / f"{source_id}.{extension}"
                    legacy.parent.mkdir(parents=True)
                    legacy.write_bytes(b"legacy source")

                    def download(command, check):
                        self.assertEqual(command[-1],
                                         f"https://cdn.lil.org/nft/111k/{collection}/{legacy.name}")
                        Path(command[command.index("--output") + 1]).write_bytes(b"CDN source")

                    with patch.object(run, "CACHE", root), patch.object(knife_sources, "CACHE", root):
                        with patch("media.valid_source", return_value=True):
                            with patch("media.subprocess.run", side_effect=download) as fetch:
                                sources = run.prepare_media(collection, [source_id], [])
                    self.assertEqual(sources, [legacy.parent / "cdn-lil-111k" / legacy.name])
                    self.assertEqual(sources[0].read_bytes(), b"CDN source")
                    self.assertEqual(legacy.read_bytes(), b"legacy source")
                    fetch.assert_called_once()

    def test_animated_sources_resolve_without_release_artifacts(self):
        manifest = run.HERE.parent / "animated-source-sha256.json"
        hashes = {int(i): digest for i, digest in json.loads(manifest.read_text()).items()}
        self.assertEqual(sorted(hashes), list(range(1, 103)))
        for source_id, digest in run.SOURCE_HASHES["animated"].items():
            self.assertEqual(hashes[source_id], digest)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(run, "ROOT", root), patch.object(run, "CACHE", root / "cache"):
                with patch.object(run, "prepare_sources") as prepare:
                    sources = run.prepare_media("animated", [1, 21, 102], [])
            prepare.assert_called_once_with(root / "cache/animated/sources/cdn-lil-111k", "animated",
                                            {i: hashes[i] for i in (1, 21, 102)}, "mp4")
            self.assertEqual(sources, [root / f"cache/animated/sources/cdn-lil-111k/{i}.mp4" for i in (1, 21, 102)])

    def test_animated_default_selection_stays_three_clips(self):
        self.assertEqual(run.source_ids("animated", None, False), [3, 27, 102])

    def test_numbered_sources_use_cdn_catalog_boundaries(self):
        for collection, last in (("videos", 58), ("animated", 421), ("3d", 3000)):
            with self.subTest(collection=collection):
                self.assertEqual(run.source_ids(collection, f"1,{last}", False), [1, last])
                with self.assertRaisesRegex(ValueError, f"between 1 and {last}"):
                    run.source_ids(collection, str(last + 1), False)

    def test_video_sample_pins_cover_current_ids_without_overriding_default_hashes(self):
        hashes = {int(i): digest for i, digest in run.SAMPLES["video_sha256"].items()}
        self.assertTrue(all(1 <= i <= run.LIMITS["videos"] for i in hashes))
        self.assertTrue(set(run.SAMPLES["groups"]["videos"]) <= hashes.keys())
        for source_id in hashes.keys() & run.SOURCE_HASHES["videos"].keys():
            self.assertEqual(hashes[source_id], run.SOURCE_HASHES["videos"][source_id])


if __name__ == "__main__":
    unittest.main()
