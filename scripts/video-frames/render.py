import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from contextlib import ExitStack
from fcntl import LOCK_EX, flock
from fractions import Fraction
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parents[1]
CACHE = ROOT / ".cache" / "video-frames"
OUTPUT = ROOT / "output" / "video-frames"
SOURCE_HASHES = {
    "videos": {
        10: "2c87274bbf432a46cd4b062c9f2b5c8cbbe25c62bb91824e4f086280f372f3c4",
        11: "259182c66bbf6f092dacffc695a734ab7c4081393617628cb3edc8f3bf7cbaef",
        12: "3d52f686a7fbe17b2ba207ab22d53917bd3a923ccc1cda560f22d0b4748594ef",
    },
    "animated": {
        3: "395e21b5f31b4ae99dc2b2c457a9f9ec5305f63100ea5af8cf855349124d2aab",
        27: "5a07d56aa4616f02500031d1e37b14ad7fc0af2e029b6e36e0f6798bb07c13e9",
        102: "2c3c9d3fc8024d7934699d24dcfc1a4a222ada25a020c01e9d4f45cd742d8389",
    },
}

# Reviewed screen corners (TL, TR, BL, BR) in the 424px midpoint images.
VARIANTS = [
    ("01-wide-border", "Wide bamboo border", {
        Fraction(16, 9): "77.4:134.1:345.6:124.1:77.4:288.8:345.6:278.8",
        Fraction(466, 503): "87.3:73.6:335.7:64.3:87.3:348.5:335.7:339.3",
    }),
    ("02-front", "Bamboo front", {
        Fraction(16, 9): "60:121.4:364:121.4:60:292.4:364:292.4",
        Fraction(466, 503): "71.2:54.9:352.8:54.9:71.2:358.8:352.8:358.8",
    }),
]


def prepare_sources(directory, collection):
    directory.mkdir(parents=True, exist_ok=True)
    for clip, digest in SOURCE_HASHES[collection].items():
        path = directory / f"{clip}.mp4"
        if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == digest:
            continue
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            incoming = Path(temporary) / path.name
            url = f"https://wip.lil.org/111k/{collection}/{clip}.mp4"
            subprocess.run(["curl", "-fsSL", "--retry", "2", "--max-time", "120",
                            "--output", incoming, url], check=True)
            if hashlib.sha256(incoming.read_bytes()).hexdigest() != digest:
                raise ValueError(f"Clip {clip} differs from the source used in this study: {url}")
            incoming.replace(path)


def display_aspect(source):
    probe = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height,display_aspect_ratio:stream_side_data=rotation", "-of", "json", source,
    ])
    video = json.loads(probe)["streams"][0]
    dar = video.get("display_aspect_ratio")
    aspect = (Fraction(dar.replace(":", "/")) if dar and dar != "N/A"
              else Fraction(video["width"], video["height"]))
    if any(side.get("rotation", 0) % 180 == 90 for side in video.get("side_data_list", [])):
        return 1 / aspect
    return aspect


def reviewed_aspects(source_dir, collection):
    aspects = {}
    for clip in SOURCE_HASHES[collection]:
        source = source_dir / f"{clip}.mp4"
        aspect = display_aspect(source)
        for slug, _, corners in VARIANTS:
            if aspect not in corners:
                raise ValueError(f"{source}: {slug} needs reviewed screen corners for "
                                 f"display aspect ratio {aspect.numerator}:{aspect.denominator}")
        aspects[clip] = aspect
    return aspects


def publish(videos, output):
    output.mkdir(parents=True, exist_ok=True)
    with ExitStack() as resources:
        directory_fd = os.open(output, os.O_RDONLY)
        resources.callback(os.close, directory_fd)
        flock(directory_fd, LOCK_EX)
        previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
        resources.callback(signal.pthread_sigmask, signal.SIG_SETMASK, previous)
        staging = Path(resources.enter_context(tempfile.TemporaryDirectory(prefix=".publish-", dir=output)))
        incoming = staging / "incoming"
        with ExitStack() as rollback:
            for source in [*sorted(videos.glob("*/*.mp4")), videos / "comparison.png"]:
                relative = source.relative_to(videos)
                target = output / relative
                if target.parent.is_symlink():
                    raise ValueError(f"Expected a regular output directory: {target.parent}")
                if not target.parent.exists():
                    target.parent.mkdir()
                    rollback.callback(target.parent.rmdir)
                if target.is_symlink() or (target.exists() and not target.is_file()):
                    raise ValueError(f"Expected a regular output file: {target}")
                if target.exists():
                    saved = staging / relative
                    saved.parent.mkdir(exist_ok=True)
                    shutil.copy2(target, saved)
                    rollback.callback(os.replace, saved, target)
                else:
                    rollback.callback(target.unlink, missing_ok=True)
                shutil.copyfile(source, incoming)
                incoming.replace(target)
            rollback.pop_all()


def main():
    parser = argparse.ArgumentParser(description="Render both bamboo frames for a sample collection.")
    parser.add_argument("--collection", choices=SOURCE_HASHES, default="videos")
    collection = parser.parse_args().collection
    subdir = Path() if collection == "videos" else Path(collection)
    source_dir = CACHE / subdir / "sources"
    output = OUTPUT / subdir
    prepare_sources(source_dir, collection)
    aspects = reviewed_aspects(source_dir, collection)
    blender = os.environ.get("BLENDER_BIN") or shutil.which("blender") or "/Applications/Blender.app/Contents/MacOS/Blender"
    with tempfile.TemporaryDirectory(prefix="batch-", dir=CACHE) as temporary:
        batch = Path(temporary)
        videos = batch / "videos"
        for clip, aspect in aspects.items():
            source = source_dir / f"{clip}.mp4"
            studio = batch / f"studio-{aspect.numerator}x{aspect.denominator}"
            if not studio.exists():
                subprocess.run([blender, "-b", "--quiet", "--factory-startup", "--python-exit-code", "1",
                                "--python", SCRIPTS / "studio.py", "--", studio,
                                f"{aspect.numerator}:{aspect.denominator}"], check=True)
            for plate in sorted(studio.glob("*/plate.png")):
                variant = plate.parent.name
                print(f"Encoding {variant}/{clip}.mp4", flush=True)
                subprocess.run([sys.executable, SCRIPTS / "encode.py", source,
                                plate.parent, videos / variant / f"{clip}.mp4"], check=True)
        sheet = videos / "comparison.png"
        subprocess.run([sys.executable, SCRIPTS / "verify.py", source_dir, videos, sheet,
                        "--collection", collection], check=True)
        publish(videos, output)
    print(f"Saved verified videos and comparison.png in {output}")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda signum, _: sys.exit(128 + signum))
    main()
