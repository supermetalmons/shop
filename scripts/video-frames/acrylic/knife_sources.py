import json
import subprocess
import sys
import tempfile
from fractions import Fraction
from pathlib import Path

FRAMES = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FRAMES))
from media import CACHE, prepare_sources, sha256
from verify import FFMPEG, fast_start, streams

KNIVES = FRAMES / "knives"


def render_orbit(renderer, source, angle, movie, *, frameless=False):
    command = [renderer, source, KNIVES / "Knife.metal"]
    if angle is not None:
        command.append(str(angle))
    if frameless:
        command.append("--high-resolution")
    scale = ("scale=1920:1080:flags=lanczos+accurate_rnd+full_chroma_int:"
             "out_color_matrix=bt709:out_range=tv,format=yuv420p" if frameless else
             "scale=out_color_matrix=bt709:out_range=tv,format=yuv444p")
    with subprocess.Popen(command, stdout=subprocess.PIPE) as gpu:
        try:
            result = subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgra",
                "-video_size", "3840x2160" if frameless else "1920x1080", "-framerate", "60", "-i", "pipe:0",
                "-vf", scale + ",setsar=1,"
                       "setparams=range=limited:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709",
                "-an", "-c:v", "libx264", "-crf", "12" if frameless else "0",
                "-preset", "slow" if frameless else "veryfast", "-threads", "6" if frameless else "5",
                "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709",
                "-color_trc", "iec61966-2-1", "-movflags", "+faststart", movie,
            ], stdin=gpu.stdout)
        finally:
            gpu.stdout.close()
        if gpu.wait():
            raise ValueError(f"Could not render {source}")
        result.check_returncode()


def verify_frameless(movie):
    tracks = streams(movie)
    if "audio" in tracks:
        raise ValueError(f"{movie}: expected a silent knife orbit")
    video = tracks["video"]
    expected = {
        "codec_name": "h264", "width": 1920, "height": 1080, "pix_fmt": "yuv420p",
        "color_space": "bt709", "color_transfer": "iec61966-2-1", "color_primaries": "bt709",
        "color_range": "tv", "sample_aspect_ratio": "1:1", "start_pts": 0, "nb_frames": "300",
    }
    for key, value in expected.items():
        if video.get(key) != value:
            raise ValueError(f"{movie}: {key} is {video.get(key)!r}, expected {value!r}")
    duration = Fraction(video["time_base"]) * int(video["duration_ts"])
    if duration != 5 or Fraction(video["avg_frame_rate"]) != 60:
        raise ValueError(f"{movie}: expected 300 frames at 60 fps over five seconds")
    if not fast_start(movie):
        raise ValueError(f"{movie}: missing MP4 fast-start layout")
    result = subprocess.run([
        *FFMPEG, "-i", movie, "-stats_enc_pre", "pipe:1", "-stats_enc_pre_fmt", "{ptsi} {tbi}",
        "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "null", "-",
    ], check=True, stdout=subprocess.PIPE, text=True)
    timestamps = result.stdout.splitlines()
    if len(timestamps) != 300:
        raise ValueError(f"{movie}: decoded {len(timestamps)}, expected 300 frames")
    for index, line in enumerate(timestamps):
        pts, base = line.split()
        if Fraction(base) <= 0 or int(pts) * Fraction(base) != Fraction(index, 60):
            raise ValueError(f"{movie}: frame {index} has an incorrect presentation timestamp")


def numbered_models(ids):
    directory = CACHE / "knives" / "sources"
    records = json.loads((KNIVES / "alignments.json").read_text())
    hashes = {record["id"]: record["source_sha256"] for record in records}
    prepare_sources(directory, "3d", {i: hashes.get(i) for i in ids}, "glb")
    return [directory / f"{i}.glb" for i in ids]


def render_knives(sources, output_dir, *, frameless=False):
    records = json.loads((KNIVES / "alignments.json").read_text())
    angles = {record["source_sha256"]: record["alignment_radians"] for record in records}
    output_dir.mkdir(exist_ok=True, parents=True)
    outputs = []
    with tempfile.TemporaryDirectory(dir=output_dir) as temporary:
        stage = Path(temporary)
        renderer = stage / "renderer"
        subprocess.run(["swiftc", "-O", KNIVES / "MetalRenderer.swift", "-o", renderer], check=True)
        for source in sources:
            movie = stage / f"{source.stem}.mp4"
            print(f"Rendering 16:9 orbit for {source.name}", flush=True)
            if frameless:
                render_orbit(renderer, source, angles.get(sha256(source)), movie, frameless=True)
                verify_frameless(movie)
            else:
                render_orbit(renderer, source, angles.get(sha256(source)), movie)
            destination = output_dir / movie.name
            movie.replace(destination)
            outputs.append(destination)
    return outputs
