import subprocess
import tempfile
import unittest
from pathlib import Path

from media import publish, valid_source


class MediaTests(unittest.TestCase):
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
