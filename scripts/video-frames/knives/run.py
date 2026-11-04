import argparse
import hashlib
import json
import signal
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from encode import BT709_TO_SRGB, screen_filters
from render import CACHE, OUTPUT, prepare_sources, publish
from verify import check_movie


def model_ids(value):
    fields = value.split(",")
    if any(not s.isascii() or not s.isdecimal() or not 1 <= int(s) <= 1000 for s in fields):
        raise argparse.ArgumentTypeError("expected comma-separated 111k model IDs from 1 through 1000")
    ids = list(map(int, fields))
    if len(set(ids)) != len(ids):
        raise argparse.ArgumentTypeError("each model ID must appear only once")
    return ids


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def frame_assets(preset):
    assets = {}
    for key, record in preset["frame"].items():
        path = HERE / record["file"]
        if sha256(path) != record["sha256"]:
            raise ValueError(f"SHA-256 mismatch for approved frame asset {path}")
        assets[key] = path
    return assets


def source_files(args, samples, publishing_approved):
    if args.input:
        sources = [path.absolute() for path in args.input]
        for path in sources:
            if path.suffix.lower() != ".glb" or not path.is_file():
                raise ValueError(f"Expected a local .glb file: {path}")
            reference = samples.get(path.stem)
            if reference and publishing_approved and sha256(path) != reference["source_sha256"]:
                raise ValueError(f"{path} would replace approved sample {path.stem}.mp4; choose a different --output")
        names = [unicodedata.normalize("NFC", path.stem).casefold() for path in sources]
        if len(set(names)) != len(names):
            raise ValueError("Local model filenames must have distinct stems")
        return sources

    ids = args.ids or [int(key) for key in samples]
    directory = CACHE / "knives" / "sources"
    digests = {i: samples.get(str(i), {}).get("source_sha256") for i in ids}
    prepare_sources(directory, "3d", digests, "glb")
    return [directory / f"{i}.glb" for i in ids]


def render_movie(renderer, model, output, frame):
    corners, = json.loads(frame["corners"].read_text())
    filters = [
        "[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv444p,"
        + BT709_TO_SRGB + ",loop=loop=300:size=1:start=0[plate0]",
        "[0:v]null[source0]",
        *screen_filters(0, corners),
        "[plate1]format=yuv420p,setsar=1[out]",
    ]
    command = [
        "ffmpeg", "-nostdin", "-v", "error", "-filter_complex_threads", "3",
        "-f", "rawvideo", "-pixel_format", "bgra", "-video_size", "1056x704",
        "-framerate", "60", "-i", "pipe:0", "-framerate", "60", "-i", frame["plate"],
        "-i", frame["mask"], "-filter_complex", ";".join(filters), "-map", "[out]",
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-threads", "5",
        "-maxrate", "13M", "-bufsize", "13M", "-fps_mode", "passthrough",
        "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", "iec61966-2-1", "-movflags", "+faststart", output,
    ]
    with subprocess.Popen([renderer, model, HERE / "Knife.metal"], stdout=subprocess.PIPE) as gpu:
        try:
            result = subprocess.run(command, stdin=gpu.stdout)
        finally:
            gpu.stdout.close()
        if gpu.wait():
            raise ValueError(f"Could not render {model}")
        result.check_returncode()


def main():
    parser = argparse.ArgumentParser(description="Render the approved Dark Halo Soft Strip knife preset.")
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--ids", type=model_ids, help="comma-separated 111k model IDs (default: 1,2,3,4)")
    selection.add_argument("--input", type=Path, action="append", help="local baked GLB; repeat for multiple models")
    selection.add_argument("--verify", action="store_true", help="freshly render and verify all four approved MP4 hashes")
    parser.add_argument("--output", type=Path, help="destination directory (required for local GLBs)")
    args = parser.parse_args()
    if args.input and not args.output:
        parser.error("--input requires --output DIR")
    if args.verify and args.output:
        parser.error("--verify renders to a temporary directory and does not take --output")

    preset = json.loads((HERE / "preset.json").read_text())
    samples = {str(s["id"]): s for s in preset["samples"]}
    approved = (OUTPUT / "knives" / preset["name"]).resolve()
    destination = args.output.resolve() if args.output else approved
    publishing_approved = destination == approved or (
        destination.is_dir() and approved.is_dir() and destination.samefile(approved)
    )
    frame = frame_assets(preset)
    sources = source_files(args, samples, publishing_approved)
    with tempfile.TemporaryDirectory(prefix="knife-render-") as tmp:
        stage = Path(tmp)
        renderer = stage / "renderer"
        subprocess.run(["swiftc", "-O", HERE / "MetalRenderer.swift", "-o", renderer], check=True)
        files, mismatches = [], []
        for model in sources:
            output = stage / (model.stem + ".mp4")
            print(f"Rendering {model.name}", flush=True)
            render_movie(renderer, model, output, frame)
            with tempfile.TemporaryDirectory(dir=stage) as proof:
                check_movie(output, 300, 60, "iec61966-2-1", None, None, Path(proof))
            files.append(Path(output.name))
            if model.stem in samples and (args.verify or publishing_approved):
                expected = samples[model.stem]["output_sha256"]
                actual = sha256(output)
                if actual != expected:
                    mismatches.append(f"{output.name}: expected {expected}, got {actual}")
        if mismatches:
            raise ValueError("Approved MP4 SHA-256 mismatch:\n" + "\n".join(mismatches))
        if args.verify:
            print(f"All {len(files)} freshly rendered MP4s match the approved SHA-256 hashes.")
        else:
            publish(stage, destination, files=files)
            print(f"Saved {len(files)} verified MP4(s) in {destination}")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda signum, _: sys.exit(128 + signum))
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
