import argparse
import json
import struct
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

VARIANTS = [
    ("01-front", "Bamboo front"),
    ("03-wide-border", "Wide bamboo border"),
    ("04-bamboo-block", "Bamboo block"),
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
        "start_pts": 0, "nb_frames": str(frame_count),
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
        *FFMPEG, "-progress", "pipe:1", "-i", path,
        "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "null", "-",
        "-map", "0:a:0", "-c:a", "pcm_f32le", "-f", "hash", samples / "audio.sha256",
        "-map", "0:v:0", "-vf", f"select=eq(n\\,{frame_count // 2}),scale=424:424:flags=lanczos+accurate_rnd+full_chroma_int",
        "-fps_mode", "passthrough", "-threads:v", "1", "-update", "1", samples / "midpoint.png",
    ], check=True, stdout=subprocess.PIPE, text=True)
    counts = [int(line[6:]) for line in result.stdout.splitlines() if line.startswith("frame=")]
    if not counts or counts[-1] != frame_count:
        raise ValueError(f"{path}: decoded {counts[-1:]}, expected {frame_count} frames")
    if (samples / "audio.sha256").read_bytes() != source_hash:
        raise ValueError(f"{path}: decoded audio differs from source")
    print(f"{path.parent.name}/{path.name}    {frame_count} frames    {size / 1_000_000:.3f} MB", flush=True)
    return size


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
    for col, (_, label) in enumerate(VARIANTS):
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
        for col, (slug, _) in enumerate(VARIANTS):
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
            for slug, _ in VARIANTS:
                directory = samples / slug / str(clip)
                directory.mkdir(parents=True)
                path = args.output_dir / slug / source.name
                sizes.append(check_movie(path, count, original["audio"], source_hash, directory))
        under_target = sum(size < 10_000_000 for size in sizes)
        if under_target <= len(sizes) // 2:
            raise ValueError(f"Only {under_target} of {len(sizes)} videos are below 10 MB")
        contact_sheet(samples, args.sheet_file)
        print(f"Verified {len(sizes)} videos. {under_target} below 10 MB. Largest {max(sizes) / 1_000_000:.3f} MB.")


if __name__ == "__main__":
    main()
