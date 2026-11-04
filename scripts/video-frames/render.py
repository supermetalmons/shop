import hashlib
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from contextlib import ExitStack
from fcntl import LOCK_EX, flock
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parents[1]
CACHE = ROOT / ".cache" / "video-frames"
OUTPUT = ROOT / "output" / "video-frames"
SOURCES = {
    10: "2c87274bbf432a46cd4b062c9f2b5c8cbbe25c62bb91824e4f086280f372f3c4",
    11: "259182c66bbf6f092dacffc695a734ab7c4081393617628cb3edc8f3bf7cbaef",
    12: "3d52f686a7fbe17b2ba207ab22d53917bd3a923ccc1cda560f22d0b4748594ef",
}


def prepare_sources(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for clip, digest in SOURCES.items():
        path = directory / f"{clip}.mp4"
        if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == digest:
            continue
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            incoming = Path(temporary) / path.name
            url = f"https://wip.lil.org/111k/videos/{clip}.mp4"
            subprocess.run(["curl", "-fsSL", "--retry", "2", "--max-time", "120",
                            "--output", incoming, url], check=True)
            if hashlib.sha256(incoming.read_bytes()).hexdigest() != digest:
                raise ValueError(f"Clip {clip} differs from the source used in this study: {url}")
            incoming.replace(path)


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
    source_dir = CACHE / "sources"
    prepare_sources(source_dir)
    blender = os.environ.get("BLENDER_BIN") or shutil.which("blender") or "/Applications/Blender.app/Contents/MacOS/Blender"
    with tempfile.TemporaryDirectory(prefix="batch-", dir=CACHE) as temporary:
        batch = Path(temporary)
        studio, videos = batch / "studio", batch / "videos"
        subprocess.run([blender, "-b", "--quiet", "--factory-startup", "--python-exit-code", "1",
                        "--python", SCRIPTS / "studio.py", "--", studio], check=True)
        for plate in sorted(studio.glob("*/plate.png")):
            variant = plate.parent.name
            (videos / variant).mkdir(parents=True)
            for clip in SOURCES:
                print(f"Encoding {variant}/{clip}.mp4", flush=True)
                subprocess.run([sys.executable, SCRIPTS / "encode.py", source_dir / f"{clip}.mp4",
                                plate.parent, videos / variant / f"{clip}.mp4"], check=True)
        sheet = videos / "comparison.png"
        subprocess.run([sys.executable, SCRIPTS / "verify.py", source_dir, videos, sheet], check=True)
        publish(videos, OUTPUT)
    print(f"Saved verified videos and comparison.png in {OUTPUT}")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda signum, _: sys.exit(128 + signum))
    main()
