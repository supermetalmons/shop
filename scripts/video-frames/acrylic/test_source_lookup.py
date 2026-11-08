import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import run


class SourceLookupTests(unittest.TestCase):
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
            prepare.assert_called_once_with(root / "cache/animated/sources", "animated",
                                            {i: hashes[i] for i in (1, 21, 102)}, "mp4")
            self.assertEqual(sources, [root / f"cache/animated/sources/{i}.mp4" for i in (1, 21, 102)])

    def test_animated_default_selection_stays_three_clips(self):
        self.assertEqual(run.source_ids("animated", None, False), [3, 27, 102])


if __name__ == "__main__":
    unittest.main()
