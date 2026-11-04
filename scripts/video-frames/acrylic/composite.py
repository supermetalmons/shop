import json
import subprocess
import sys
import tempfile
from fractions import Fraction
from pathlib import Path
from typing import NamedTuple, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from encode import encode
from verify import BT709_TO_SRGB, FFMPEG, audio_hash, check_movie, streams, thumbnail


SRGB = "iec61966-2-1"
DISPLAY = Fraction(16, 9)


class SourceProperties(NamedTuple):
    count: int
    fps: Fraction
    transfer: str
    fit: str
    audio: Optional[dict]
    duration: float
    retime: bool


def fit_filter(video, transfer):
    width, height = video["width"], video["height"]
    sar = video.get("sample_aspect_ratio")
    pixel_aspect = Fraction(sar.replace(":", "/")) if sar and sar != "N/A" else 1
    if pixel_aspect <= 0:
        pixel_aspect = 1
    for side in video.get("side_data_list", []):
        rotation = side.get("rotation", 0)
        if rotation % 90:
            raise ValueError(f"Unsupported display rotation {rotation}°")
        if rotation % 180:
            width, height = height, width
            pixel_aspect = Fraction(1, pixel_aspect)
    aspect = Fraction(width, height) * pixel_aspect
    if aspect == DISPLAY:
        return ""
    pad_width = max(width, round(width * DISPLAY / aspect))
    pad_height = max(height, round(height * aspect / DISPLAY))
    color = "0x101010" if transfer == SRGB else "0x060606"
    return f"format=yuv444p,pad={pad_width}:{pad_height}:(ow-iw)/2:(oh-ih)/2:{color}"


def source_color_filter(video):
    matrix = video.get("color_space", "unknown")
    if matrix not in ("bt709", "unknown", "gbr"):
        raise ValueError(f"unsupported color_space {matrix}; expected BT.709 or RGB")
    primaries = video.get("color_primaries", "unknown")
    if primaries not in ("bt709", "unknown"):
        raise ValueError(f"unsupported color_primaries {primaries}; expected BT.709")
    rgb = matrix == "gbr" or any(tag in video.get("pix_fmt", "") for tag in ("rgb", "bgr", "gbr"))
    if not rgb and video.get("color_range") != "pc":
        return ""
    in_range = "tv" if video.get("color_range") == "tv" else "pc"
    return (f"scale=iw:ih:in_range={in_range}:out_range=tv:in_color_matrix=bt709:out_color_matrix=bt709:"
            "flags=lanczos+accurate_rnd+full_chroma_int,format=yuv444p,setparams=range=limited:colorspace=bt709")


def quantized_rate(times, tick, nominal, average, duration):
    # A CFR source rounded to this clock constrains each frame interval to a common range.
    half_tick = tick / 2
    shortest = max((time - half_tick) / i for i, time in enumerate(times[1:], 1))
    longest = min((time + half_tick) / i for i, time in enumerate(times[1:], 1))
    if duration is not None:
        shortest = max(shortest, (duration - tick) / len(times))
        longest = min(longest, (duration + tick) / len(times))
    if shortest > longest:
        raise ValueError("expected a constant frame rate within the source clock precision")
    lower, upper = 1 / longest, 1 / shortest
    whole_fps = round(average)
    for rate in (nominal, Fraction(whole_fps), Fraction(whole_fps * 1000, 1001), average):
        if lower <= rate <= upper:
            return rate
    # Short MP4s can have two inaccurate reported rates. Choose a simple rate consistent with every tick.
    middle = (lower + upper) / 2
    denominator = 1
    while True:
        rate = middle.limit_denominator(denominator)
        if lower <= rate <= upper:
            return rate
        denominator *= 2


def source_properties(source):
    original = streams(source, media_only=True)
    video = original["video"]
    color = source_color_filter(video)
    transfer = video.get("color_transfer", "bt709")
    if transfer == "unknown":
        transfer = "bt709"
    if transfer not in ("bt709", SRGB):
        raise ValueError(f"{source}: unsupported transfer {transfer}")
    try:
        fps = Fraction(video.get("avg_frame_rate", "0"))
        base = Fraction(video.get("time_base", "0"))
    except (ValueError, ZeroDivisionError) as error:
        raise ValueError(f"{source}: invalid source frame rate or time base") from error
    if min(fps, base) <= 0:
        raise ValueError(f"{source}: expected a positive frame rate and time base")
    packets = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "packet=pts", "-of", "json", source,
    ])).get("packets", [])
    try:
        times = sorted(int(packet["pts"]) * base for packet in packets)
        count = len(times) if video.get("nb_frames") in (None, "N/A") else int(video["nb_frames"])
    except (KeyError, ValueError) as error:
        raise ValueError(f"{source}: invalid packet timestamps or frame count") from error
    if count < 1:
        raise ValueError(f"{source}: source has no video frames")
    if len(times) != count or times[0] != 0 or any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError(f"{source}: expected one distinct timestamp per frame starting at zero")
    retime = any(time != i / fps for i, time in enumerate(times))
    if retime:
        try:
            nominal = Fraction(video.get("r_frame_rate", "0"))
        except (ValueError, ZeroDivisionError):
            nominal = 0
        duration = int(video["duration_ts"]) * base if video.get("duration_ts") not in (None, "N/A") else None
        fps = quantized_rate(times, base, nominal, fps, duration)
    fit = ",".join(filter(None, (color, fit_filter(video, transfer))))
    return SourceProperties(count, fps, transfer, fit, original.get("audio"),
                            float(video.get("duration", count / fps)), retime)


def check_white_background(pixels, outline):
    size = 424
    if len(pixels) != size * size * 3:
        raise ValueError("Expected a 424px RGB proof")
    left, top, right, bottom = [round(value * size / 1440) for value in outline]
    if not (6 <= left < right <= size - 6 and 6 <= top < bottom <= size - 6):
        raise ValueError("Invalid physical frame outline for exterior sampling")
    xpad, ypad = (right - left) // 6, (bottom - top) // 6
    horizontal = (left + xpad, right - xpad)
    vertical = (top + ypad, bottom - ypad)
    regions = [
        (*horizontal, top - 5, top - 2), (*horizontal, bottom + 2, bottom + 5),
        (left - 5, left - 2, *vertical), (right + 2, right + 5, *vertical),
        (0, size, 0, 5), (0, size, size - 5, size),
        (0, 5, 0, size), (size - 5, size, 0, size),
    ]
    for x0, x1, y0, y1 in regions:
        samples = b"".join(pixels[(y * size + x0) * 3:(y * size + x1) * 3] for y in range(y0, y1))
        errors = samples.translate(bytes(reversed(range(256))))
        if sum(errors) > 2 * len(errors) or sum(level > 6 for level in errors) > .01 * len(errors):
            raise ValueError(f"Expected neutral white background in proof region ({x0}, {y0})–({x1}, {y1})")


def verify_composite(source, plate_dir, output, properties=None):
    props = properties or source_properties(source)
    corners, = json.loads((plate_dir / "screens.json").read_text())
    coords = ":".join(f"{v * 424 / 1440:.6f}" for i in (0, 1, 3, 2) for v in corners[i])
    with tempfile.TemporaryDirectory(prefix="acrylic-proof-") as directory:
        proof = Path(directory)
        check_movie(output, props.count, props.fps, props.transfer, props.audio,
                    audio_hash(source) if props.audio else None, proof, source=source)
        # The transfer filter needs even dimensions. Resolve chroma before shrinking to a 32px RGB proof.
        reference_filters = [f"select=eq(n\\,{props.count // 2})", props.fit,
                             "scale=ceil(iw/2)*2:ceil(ih/2)*2:in_color_matrix=bt709:out_color_matrix=bt709:"
                             "out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv444p",
                             BT709_TO_SRGB if props.transfer == "bt709" else "",
                             "scale=in_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=rgb24"]
        reference = thumbnail(source, ",".join(filter(None, reference_filters)))
        actual = thumbnail(proof / "midpoint.png", f"perspective={coords}:sense=source")
        error = sum(abs(a - b) for a, b in zip(actual, reference)) / len(actual)
        if error > 6:
            raise ValueError(f"{output}: screen differs from fitted source midpoint (mean RGB error {error:.2f})")
        outline = json.loads((plate_dir / "outline.json").read_text())
        pixels = subprocess.check_output([*FFMPEG, "-i", proof / "midpoint.png", "-frames:v", "1",
                                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-threads:v", "1", "-"])
        check_white_background(pixels, outline)
        return error


def composite(source: Path, plate_dir: Path, output: Path):
    properties = source_properties(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as directory:
        staged = Path(directory) / output.name
        rate = properties.fps
        timing = f"settb={rate.denominator}/{rate.numerator},setpts=N" if properties.retime else ""
        encode(source, plate_dir, staged, fps=rate, transfer=properties.transfer, duration=properties.duration,
               audio=properties.audio, source_filter=",".join(filter(None, (timing, properties.fit))))
        verify_composite(source, plate_dir, staged, properties)
        staged.replace(output)
