import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from acrylic import knife_sources
from media import prepare_sources, sha256


class SourceCacheTests(unittest.TestCase):
    def test_local_alignment_follows_glb_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            known = directory / "renamed.glb"
            known.write_bytes(b"known")
            other = directory / "1.glb"
            other.write_bytes(b"other")
            record = {"id": 1, "source_sha256": sha256(known), "alignment_radians": .75}
            (directory / "alignments.json").write_text(json.dumps([record]))

            def record_angle(renderer, source, angle, movie):
                movie.write_text(json.dumps(angle))

            with patch.object(knife_sources, "KNIVES", directory), patch("subprocess.run"), \
                 patch.object(knife_sources, "render_orbit", side_effect=record_angle):
                movies = knife_sources.render_knives([known, other], directory / "rendered")
            self.assertEqual([p.stem for p in movies], ["renamed", "1"])
            self.assertEqual([json.loads(p.read_text()) for p in movies], [.75, None])

    def test_bad_glb_is_refetched_and_bad_download_is_never_published(self):
        json_chunk = b'{"asset":{"version":"2.0"},"buffers":[{"byteLength":4}]}'
        json_chunk += b" " * (-len(json_chunk) % 4)
        valid = (struct.pack("<4sIII4s", b"glTF", 2, 32 + len(json_chunk), len(json_chunk), b"JSON")
                 + json_chunk + struct.pack("<I4sI", 4, b"BIN\0", 0))
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            cached = directory / "17.glb"
            cached.write_bytes(valid[:-1])
            downloads = iter([b"<html>unavailable</html>", valid])

            def download(cmd, check):
                Path(cmd[cmd.index("--output") + 1]).write_bytes(next(downloads))

            with patch("media.subprocess.run", side_effect=download) as fetch:
                with self.assertRaisesRegex(ValueError, "invalid GLB"):
                    prepare_sources(directory, "3d", {17: None}, "glb")
                self.assertEqual(cached.read_bytes(), valid[:-1])
                prepare_sources(directory, "3d", {17: None}, "glb")
                prepare_sources(directory, "3d", {17: None}, "glb")
                self.assertEqual(fetch.call_count, 2)
                self.assertEqual(cached.read_bytes(), valid)


if __name__ == "__main__":
    unittest.main()
