import json
import subprocess
import sys
import tempfile
from pathlib import Path

FRAMES = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FRAMES))
from media import CACHE, prepare_sources, sha256

KNIVES = FRAMES / "knives"


def render_orbit(renderer, source, angle, movie):
    command = [renderer, source, KNIVES / "Knife.metal"]
    if angle is not None:
        command.append(str(angle))
    with subprocess.Popen(command, stdout=subprocess.PIPE) as gpu:
        try:
            result = subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgra",
                "-video_size", "1920x1080", "-framerate", "60", "-i", "pipe:0",
                "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv444p,setsar=1,"
                       "setparams=range=limited:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709",
                "-an", "-c:v", "libx264", "-crf", "0", "-preset", "veryfast", "-threads", "5",
                "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709",
                "-color_trc", "iec61966-2-1", "-movflags", "+faststart", movie,
            ], stdin=gpu.stdout)
        finally:
            gpu.stdout.close()
        if gpu.wait():
            raise ValueError(f"Could not render {source}")
        result.check_returncode()


def numbered_models(ids):
    directory = CACHE / "knives" / "sources"
    records = json.loads((KNIVES / "alignments.json").read_text())
    hashes = {record["id"]: record["source_sha256"] for record in records}
    prepare_sources(directory, "3d", {i: hashes.get(i) for i in ids}, "glb")
    return [directory / f"{i}.glb" for i in ids]


def render_knives(sources, output_dir):
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
            render_orbit(renderer, source, angles.get(sha256(source)), movie)
            destination = output_dir / movie.name
            movie.replace(destination)
            outputs.append(destination)
    return outputs
