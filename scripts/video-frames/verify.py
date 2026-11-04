import argparse
import json
import struct
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

# Reviewed screen corners (TL, TR, BL, BR) in the 424px midpoint images.
VARIANTS = [
    ("01-front", "Bamboo front", "60:121.4:364:121.4:60:292.4:364:292.4"),
    ("03-wide-border", "Wide bamboo border", "77.4:134.1:345.6:124.1:77.4:288.8:345.6:278.8"),
    ("04-bamboo-block", "Bamboo block", "96.6:145.1:326.2:133.4:96.6:279.2:326.2:267.5"),
]
FRAME_COUNTS = [121, 241, 145, 121]
FFMPEG = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror"]


def streams(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", path],
        check=True, capture_output=True,
    )
    tracks = json.loads(result.stdout)["streams"]
    if sorted(track["codec_type"] for track in tracks) != ["audio", "video"]:
        raise ValueError(f"{path}: expected one video and one audio stream")
    return {track["codec_type"]: track for track in tracks}


def fast_start(path):
    file_size = path.stat().st_size
    with path.open("rb") as movie:
        while movie.tell() + 8 <= file_size:
            offset = movie.tell()
            size, kind = struct.unpack(">I4s", movie.read(8))
            header_size = 8
            if size == 1:
                size, = struct.unpack(">Q", movie.read(8))
                header_size = 16
            if not size:
                size = file_size - offset
            if size < header_size or offset + size > file_size:
                break
            if kind in (b"moov", b"mdat"):
                return kind == b"moov"
            movie.seek(offset + size)
    return False


def audio_hash(path):
    result = subprocess.run(
        [*FFMPEG, "-i", path, "-map", "0:a:0", "-c:a", "pcm_f32le", "-f", "hash", "-"],
        check=True, stdout=subprocess.PIPE,
    )
    return result.stdout


def check_movie(path, frame_count, source_audio, source_hash, samples):
    size = path.stat().st_size
    if size > 15_000_000 or not fast_start(path):
        raise ValueError(f"{path}: exceeds 15 MB or lacks MP4 fast-start layout")
    tracks = streams(path)
    video = tracks["video"]
    expected = {
        "codec_name": "h264", "width": 1440, "height": 1440, "pix_fmt": "yuv420p",
        "color_space": "bt709", "color_transfer": "bt709", "color_primaries": "bt709",
        "sample_aspect_ratio": "1:1", "start_pts": 0, "nb_frames": str(frame_count),
    }
    for key, value in expected.items():
        if video.get(key) != value:
            raise ValueError(f"{path}: {key} is {video.get(key)!r}, expected {value!r}")
    duration = Fraction(video["time_base"]) * int(video["duration_ts"])
    if duration != Fraction(frame_count, 24) or Fraction(video["avg_frame_rate"]) != 24:
        raise ValueError(f"{path}: incorrect video timing")
    for key in ("codec_name", "sample_rate", "channels", "start_time", "duration"):
        if tracks["audio"].get(key) != source_audio.get(key):
            raise ValueError(f"{path}: audio {key} differs from source")
    result = subprocess.run([
        *FFMPEG, "-i", path, "-stats_enc_pre", "pipe:1", "-stats_enc_pre_fmt", "{ptsi} {tbi}",
        "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "null", "-",
        "-map", "0:a:0", "-c:a", "pcm_f32le", "-f", "hash", samples / "audio.sha256",
        "-map", "0:v:0", "-vf", f"select=eq(n\\,{frame_count // 2}),scale=424:424:flags=lanczos+accurate_rnd+full_chroma_int",
        "-fps_mode", "passthrough", "-threads:v", "1", "-update", "1", samples / "midpoint.png",
    ], check=True, stdout=subprocess.PIPE, text=True)
    timestamps = result.stdout.splitlines()
    if len(timestamps) != frame_count:
        raise ValueError(f"{path}: decoded {len(timestamps)}, expected {frame_count} frames")
    for index, line in enumerate(timestamps):
        pts, base = line.split()
        time_base = Fraction(base)
        if time_base <= 0 or int(pts) * time_base != Fraction(index, 24):
            raise ValueError(f"{path}: frame {index} has incorrect presentation timestamp {pts} × {base}")
    if (samples / "audio.sha256").read_bytes() != source_hash:
        raise ValueError(f"{path}: decoded audio differs from source")
    print(f"{path.parent.name}/{path.name}    {frame_count} frames    {size / 1_000_000:.3f} MB", flush=True)
    return size


def thumbnail(path, picture_filter):
    pixels = subprocess.check_output([
        *FFMPEG, "-i", path, "-vf", f"{picture_filter},scale=32:18:flags=area:in_color_matrix=bt709",
        "-frames:v", "1", "-an", "-pix_fmt", "rgb24", "-threads:v", "1", "-f", "rawvideo", "-",
    ])
    if len(pixels) != 32 * 18 * 3:
        raise ValueError(f"{path}: missing midpoint image")
    return pixels


def contact_sheet(samples, destination):
    left, top, cell, gap = 174, 212, 424, 12
    width = left + len(VARIANTS) * (cell + gap) + 40
    height = top + len(FRAME_COUNTS) * (cell + gap) + 32
    right = width - 52
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{width}" height="{height}">',
        '<style>text{font-family:Helvetica,Arial,sans-serif;fill:#302f29}.minor{font-size:17px;fill:#716e63;letter-spacing:1px}</style>',
        '<rect width="100%" height="100%" fill="white"/>',
        '<text x="52" y="50" class="minor">111K   /   MOVING IMAGE STUDIES</text>',
        '<text x="50" y="113" style="font-family:Georgia,serif;font-size:54px">Video frame studies</text>',
        f'<text x="{right}" y="108" text-anchor="end" class="minor">1440 × 1440    /    24 FPS</text>',
        f'<path d="M52 144 H{right}" stroke="#a49d8e"/>',
    ]
    for col, (_, label, _) in enumerate(VARIANTS):
        x = left + col * (cell + gap) + 8
        svg += [
            f'<text x="{x}" y="190" class="minor">{col + 1:02}</text>',
            f'<text x="{x + 42}" y="191" font-size="25">{label}</text>',
        ]
    for row, count in enumerate(FRAME_COUNTS):
        y = top + row * (cell + gap)
        frame = count // 2
        svg += [
            f'<path d="M52 {y} H{right}" stroke="#d8d5cd"/>',
            f'<text x="52" y="{y + 50}" class="minor">CLIP</text>',
            f'<text x="50" y="{y + 102}" style="font-family:Georgia,serif;font-size:45px">{row + 1:02}</text>',
            f'<text x="52" y="{y + 147}" font-size="17">Midpoint</text>',
            f'<text x="52" y="{y + 172}" class="minor">{frame / 24:.2f} s</text>',
        ]
        for col, (slug, _, _) in enumerate(VARIANTS):
            x = left + col * (cell + gap)
            svg.append(
                f'<image x="{x}" y="{y + 3}" width="{cell}" height="{cell}" '
                f'xlink:href="{slug}/{row + 1}/midpoint.png"/>'
            )
    layout = samples / "sheet.svg"
    layout.write_text("\n".join([*svg, "</svg>"]), encoding="utf8")
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["rsvg-convert", layout, "-o", destination], check=True)


def main():
    parser = argparse.ArgumentParser(description="Check the video previews and build their comparison sheet.")
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("sheet_file", type=Path)
    args = parser.parse_args()
    sizes = []
    with tempfile.TemporaryDirectory(prefix="video-frame-proof-") as temporary:
        samples = Path(temporary)
        for clip, count in enumerate(FRAME_COUNTS, 1):
            source = args.source_dir / f"{clip}.mp4"
            original = streams(source)
            if int(original["video"]["nb_frames"]) != count or Fraction(original["video"]["avg_frame_rate"]) != 24:
                raise ValueError(f"{source}: source frame count or rate differs from the study")
            source_hash = audio_hash(source)
            reference = thumbnail(source, f"select=eq(n\\,{count // 2})")
            for slug, _, corners in VARIANTS:
                directory = samples / slug / str(clip)
                directory.mkdir(parents=True)
                path = args.output_dir / slug / source.name
                sizes.append(check_movie(path, count, original["audio"], source_hash, directory))
                screen = thumbnail(directory / "midpoint.png", f"perspective={corners}:sense=source")
                mean_error = sum(abs(a - b) for a, b in zip(screen, reference)) / len(reference)
                if mean_error > 6:
                    raise ValueError(f"{path}: screen does not match the source midpoint at the {slug} position "
                                     f"(mean RGB error {mean_error:.1f})")
        under_target = sum(size < 10_000_000 for size in sizes)
        if under_target <= len(sizes) // 2:
            raise ValueError(f"Only {under_target} of {len(sizes)} videos are below 10 MB")
        contact_sheet(samples, args.sheet_file)
        print(f"Verified {len(sizes)} videos. {under_target} below 10 MB. Largest {max(sizes) / 1_000_000:.3f} MB.")


if __name__ == "__main__":
    main()
