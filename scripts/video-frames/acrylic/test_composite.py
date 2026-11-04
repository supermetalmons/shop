import contextlib
import io
import subprocess
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path
from unittest.mock import patch

from composite import SRGB, check_white_background, composite, fit_filter, source_properties, verify_composite
from verify import audio_hash, audio_packets, streams


class DisplayFitTests(unittest.TestCase):
    def test_square_and_anamorphic_widescreen_fill_display(self):
        for width, height, sar in ((1920, 1080, "1:1"), (720, 576, "64:45")):
            self.assertEqual(fit_filter({"width": width, "height": height, "sample_aspect_ratio": sar}, SRGB), "")

    def test_portrait_animation_is_centered_without_resampling(self):
        result = fit_filter({"width": 932, "height": 1006}, SRGB)
        self.assertEqual(result, "format=yuv444p,pad=1788:1006:(ow-iw)/2:(oh-ih)/2:0x101010")

    def test_ultrawide_source_is_letterboxed(self):
        result = fit_filter({"width": 1920, "height": 800}, "bt709")
        self.assertIn("pad=1920:1080:", result)

    def test_rotated_anamorphic_source_uses_display_coordinates(self):
        video = {"width": 720, "height": 576, "sample_aspect_ratio": "16:15", "side_data_list": [{"rotation": 90}]}
        self.assertIn("pad=1365:720:", fit_filter(video, SRGB))


class SourcePropertiesTests(unittest.TestCase):
    def test_fragmented_mp4_without_declared_frame_count(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "fragmented.mp4"
            subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x36:r=30:d=0.5",
                "-c:v", "libx264", "-bf", "0", "-movflags", "+frag_keyframe+empty_moov", source,
            ], check=True)
            self.assertEqual(source_properties(source).count, 15)

    def test_explicit_unsupported_color_matrix_or_primaries_is_rejected(self):
        for key, value in (("color_space", "smpte170m"), ("color_primaries", "bt2020")):
            with self.subTest(key=key), patch("composite.streams", return_value={"video": {key: value}}):
                with self.assertRaisesRegex(ValueError, key):
                    source_properties(Path("test.mp4"))


class LocalMediaIntegrationTests(unittest.TestCase):
    preset = Path(__file__).resolve().parent / "presets" / "08-soft-clear"

    def test_copied_audio_budget_uses_the_15_mb_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            for seconds in (2, 3):
                source = Path(directory) / f"{seconds}s.mp4"
                output = Path(directory) / f"{seconds}s-framed.mp4"
                subprocess.run([
                    "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=s=160x90:r=2",
                    "-f", "lavfi", "-i", "anullsrc=r=192000:cl=7.1", "-t", str(seconds),
                    "-c:v", "libx264", "-c:a", "pcm_s32le", source,
                ], check=True)
                if seconds == 2:
                    with contextlib.redirect_stdout(io.StringIO()):
                        composite(source, self.preset, output)
                    self.assertGreater(output.stat().st_size, 12_000_000)
                    self.assertLessEqual(output.stat().st_size, 15_000_000)
                else:
                    with self.assertRaisesRegex(ValueError, "copied audio alone exhausts"):
                        composite(source, self.preset, output)
                    self.assertFalse(output.exists())

    def make_clip(self, path, pattern, *options, frames=6):
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", pattern,
            "-frames:v", str(frames), "-c:v", "libx264", "-crf", "0", "-colorspace", "bt709",
            "-color_primaries", "bt709", "-color_trc", "bt709", *options, path,
        ], check=True)

    def center_pixels(self, path, pix_fmt):
        return subprocess.check_output([
            "ffmpeg", "-nostdin", "-v", "error", "-i", path, "-map", "0:v:0",
            "-vf", "crop=4:4:(iw-4)/2:(ih-4)/2,scale=1:1:flags=area:in_color_matrix=bt709",
            "-fps_mode", "passthrough", "-threads:v", "1", "-f", "rawvideo", "-pix_fmt", pix_fmt, "-",
        ])

    def test_saturated_quantized_cfr_with_timecode_preserves_every_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = (Path(directory) / name for name in ("source.mp4", "framed.mp4"))
            for fps, frames in ((24, 6), (Fraction(30000, 1001), 9)):
                with self.subTest(fps=fps):
                    pattern = (f"testsrc2=s=320x180:r={fps},"
                               "geq=lum='if(between(X,136,184)*between(Y,66,114),40+N*20,lum(X,Y))':cb='cb(X,Y)':cr='cr(X,Y)'")
                    self.make_clip(source, pattern, "-video_track_timescale", "1000",
                                   "-timecode", "01:00:00:00", frames=frames)
                    props = source_properties(source)
                    self.assertTrue(props.retime)
                    self.assertEqual(props.fps, fps)
                    with self.assertRaises(ValueError):
                        streams(source)
                    with contextlib.redirect_stdout(io.StringIO()):
                        composite(source, self.preset, output)
                    self.assertEqual(set(streams(output)), {"video"})
                    before, after = (self.center_pixels(path, "gray") for path in (source, output))
                    self.assertEqual(len(before), frames)
                    self.assertEqual(len(after), frames)
                    self.assertTrue(all(abs(a - b) <= 4 for a, b in zip(before, after)), (before, after))

    def test_integer_frame_period_is_not_truncated_by_the_movie_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = (Path(directory) / name for name in ("source.mp4", "framed.mp4"))
            self.make_clip(source, "testsrc2=s=64x36:r=23", frames=3)
            with contextlib.redirect_stdout(io.StringIO()):
                composite(source, self.preset, output)
            video = streams(output)["video"]
            self.assertEqual(int(video["duration_ts"]) * Fraction(video["time_base"]), Fraction(3, 23))

    def test_aac_edit_precision_keeps_packets_and_a_real_offset_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = (Path(directory) / name for name in ("source.mp4", "framed.mp4"))
            for fps, offset, quantized in ((30, "0.027", False), (Fraction(30000, 1001), "0.013", False),
                                           (24, "0.027", True)):
                with self.subTest(fps=fps, offset=offset, quantized=quantized):
                    subprocess.run([
                        "ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
                        f"testsrc2=s=96x64:r={fps}", "-itsoffset", offset, "-f", "lavfi", "-i",
                        "sine=sample_rate=44100:duration=0.6", "-frames:v", "15", "-c:v", "libx264",
                        "-c:a", "aac", *(["-video_track_timescale", "1000"] if quantized else []), source,
                    ], check=True)
                    with contextlib.redirect_stdout(io.StringIO()):
                        composite(source, self.preset, output)
                    before, after = (streams(path)["audio"] for path in (source, output))
                    self.assertEqual(int(before["start_pts"]) * Fraction(before["time_base"]),
                                     int(after["start_pts"]) * Fraction(after["time_base"]))
                    self.assertEqual(audio_hash(source), audio_hash(output))
            shifted = Path(directory) / "shifted.mp4"
            subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-i", output, "-itsoffset", "0.001", "-i", output,
                "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movie_timescale", "88200", "-movflags", "+faststart", shifted,
            ], check=True)
            with self.assertRaisesRegex(ValueError, "audio start"):
                verify_composite(source, self.preset, shifted)

    def test_last_packet_respects_source_audio_edit_end(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = (Path(directory) / name for name in ("source.mp4", "framed.mp4"))
            cases = (("libmp3lame", 44100, "0"), ("libmp3lame", 44100, "0.042"),
                     ("ac3", 48000, "0"), ("eac3", 48000, "0.013"), ("pcm_s16le", 48000, "0.013"))
            for codec, sample_rate, offset in cases:
                with self.subTest(codec=codec, offset=offset):
                    subprocess.run([
                        "ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=96x64:r=24",
                        "-itsoffset", offset, "-f", "lavfi", "-i", f"sine=sample_rate={sample_rate}", "-t", "0.377",
                        "-c:v", "libx264", "-c:a", codec, source,
                    ], check=True)
                    with contextlib.redirect_stdout(io.StringIO()):
                        composite(source, self.preset, output)
                    src, dst = (streams(path)["audio"] for path in (source, output))
                    src_base, dst_base = Fraction(src["time_base"]), Fraction(dst["time_base"])
                    end = (int(src["start_pts"]) + int(src["duration_ts"])) * src_base
                    last_pts, packet_duration, _ = audio_packets(source, src_base)[-1]
                    self.assertGreater(abs(last_pts + packet_duration - end), Fraction(1, 1000))
                    self.assertEqual(end, (int(dst["start_pts"]) + int(dst["duration_ts"])) * dst_base)
                    self.assertEqual(audio_hash(source), audio_hash(output))

    def test_odd_and_rotated_bt709_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for size, rotation in (("111x181", 0), ("320x180", 90)):
                with self.subTest(size=size):
                    source = root / "source.mp4"
                    self.make_clip(source, f"testsrc=s={size}:r=30,format=yuv444p")
                    if rotation:
                        rotated = root / "rotated.mp4"
                        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-display_rotation:v:0", str(rotation),
                                        "-i", source, "-c", "copy", rotated], check=True)
                        source = rotated
                    with contextlib.redirect_stdout(io.StringIO()):
                        composite(source, self.preset, root / "framed.mp4")

    def test_full_range_yuv_and_rgb(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = (Path(directory) / name for name in ("source.mp4", "framed.mp4"))
            yuv = "nullsrc=s=320x180:r=30,geq=lum=32:cb=128:cr=128"
            for transfer, matrix, codec, pattern in (
                ("bt709", "bt709", "libx264", yuv), (SRGB, "bt709", "libx264", yuv),
                (SRGB, "rgb", "libx264rgb", "color=c=0xd0481e:s=320x180:r=30,format=rgb24"),
            ):
                with self.subTest(transfer=transfer, matrix=matrix):
                    self.make_clip(source, pattern, "-c:v", codec, "-colorspace", matrix,
                                   "-color_trc", transfer, "-color_range", "pc")
                    with contextlib.redirect_stdout(io.StringIO()):
                        composite(source, self.preset, output)
                    before, after = (self.center_pixels(path, "rgb24") for path in (source, output))
                    self.assertEqual(len(before), len(after))
                    self.assertTrue(all(abs(a - b) <= 5 for a, b in zip(before, after)), (before, after))

    def test_genuinely_variable_rate_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "vfr.mp4"
            self.make_clip(source, "testsrc2=s=96x64:r=24", "-vf", "setpts=(N+gte(N\\,3))/(24*TB)",
                           "-fps_mode", "passthrough")
            with self.assertRaisesRegex(ValueError, "constant frame rate"):
                source_properties(source)


class BackgroundTests(unittest.TestCase):
    bounds = [80, 300, 1360, 1140]

    def test_clean_field(self):
        pixels = bytearray([255]) * (424 * 424 * 3)
        pixels[3 * (424 * 200 + 100):3 * (424 * 200 + 220)] = bytes([70]) * 360
        check_white_background(pixels, self.bounds)

    def test_local_halo_on_each_side_with_clean_distant_pixels(self):
        for x0, x1, y0, y1 in ((18, 22, 100, 310), (402, 407, 100, 310),
                               (50, 380, 83, 87), (50, 380, 338, 342)):
            with self.subTest(x0=x0, y0=y0):
                pixels = bytearray([255]) * (424 * 424 * 3)
                for y in range(y0, y1):
                    start = 3 * (424 * y + x0)
                    stripe = bytes([234]) * (3 * (x1 - x0))
                    pixels[start:start + len(stripe)] = stripe
                with self.assertRaisesRegex(ValueError, "neutral white"):
                    check_white_background(pixels, self.bounds)

    def test_distant_margin_with_clean_frame_surround(self):
        pixels = bytearray([255]) * (424 * 424 * 3)
        pixels[:424 * 3] = bytes([220, 240, 255]) * 424
        with self.assertRaisesRegex(ValueError, "neutral white"):
            check_white_background(pixels, self.bounds)
