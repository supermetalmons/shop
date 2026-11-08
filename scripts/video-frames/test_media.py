import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media import prepare_sources, publish, valid_source


class MediaTests(unittest.TestCase):
    def test_pinned_source_refresh_preserves_cache_on_bad_cdn_download(self):
        current = b"validated CDN movie"
        digest = hashlib.sha256(current).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cached = root / "10.mp4"
            cached.write_bytes(b"earlier source")
            downloads = iter([b"incomplete download", current])

            def download(command, check):
                self.assertEqual(command[-1], "https://cdn.lil.org/nft/111k/videos/10.mp4")
                Path(command[command.index("--output") + 1]).write_bytes(next(downloads))

            with patch("media.subprocess.run", side_effect=download) as fetch:
                with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                    prepare_sources(root, "videos", {10: digest}, "mp4")
                self.assertEqual(cached.read_bytes(), b"earlier source")
                prepare_sources(root, "videos", {10: digest}, "mp4")
                prepare_sources(root, "videos", {10: digest}, "mp4")
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual(cached.read_bytes(), current)

    def test_unpinned_fast_start_video_with_truncated_media_is_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "3.mp4"
            subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x96:r=24:d=1",
                "-c:v", "libx264", "-movflags", "+faststart", source,
            ], check=True)
            self.assertTrue(valid_source(source, None))
            with source.open("r+b") as file:
                file.truncate(source.stat().st_size // 2)
            codec = subprocess.check_output([
                "ffprobe", "-v", "quiet", "-show_entries", "stream=codec_name", "-of", "csv=p=0", source,
            ]).strip()
            self.assertEqual(codec, b"h264")
            self.assertFalse(valid_source(source, None))

    def test_publication_rejects_symlink_output_root(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory) / "stage"
            stage.mkdir()
            (stage / "sample.mp4").write_bytes(b"movie")
            destination = Path(directory) / "destination"
            destination.mkdir()
            alias = Path(directory) / "alias"
            alias.symlink_to(destination, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "regular output directory"):
                publish(stage, alias, files=[Path("sample.mp4")])
            self.assertEqual(list(destination.iterdir()), [])
