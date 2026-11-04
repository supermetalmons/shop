import filecmp
import hashlib
import os
import shutil
import signal
import struct
import subprocess
import tempfile
from contextlib import ExitStack
from fcntl import LOCK_EX, flock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache" / "video-frames"
OUTPUT = ROOT / "output" / "video-frames"
MAX_MOVIE_BYTES = 15_000_000
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


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def valid_source(path, digest):
    if digest is not None:
        return sha256(path) == digest
    if path.suffix == ".mp4":
        result = subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-abort_on", "empty_output_stream",
            "-err_detect", "explode", "-f", "mov", "-i", path, "-map", "0:v:0", "-map", "0:a:0?",
            "-f", "null", "-",
        ], capture_output=True)
        return result.returncode == 0 and not result.stderr
    with path.open("rb") as source:
        size = os.fstat(source.fileno()).st_size
        header = source.read(20)
        if len(header) != 20:
            return False
        magic, version, length, json_length, kind = struct.unpack("<4sIII4s", header)
        if (magic, version, length, kind) != (b"glTF", 2, size, b"JSON") or not 0 < json_length <= size - 28:
            return False
        source.seek(json_length, os.SEEK_CUR)
        return source.read(8) == struct.pack("<I4s", size - 28 - json_length, b"BIN\0")


def prepare_sources(directory, collection, hashes, extension):
    directory.mkdir(parents=True, exist_ok=True)
    for clip, digest in hashes.items():
        path = directory / f"{clip}.{extension}"
        if path.is_file() and valid_source(path, digest):
            continue
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            incoming = Path(temporary) / path.name
            url = f"https://wip.lil.org/111k/{collection}/{path.name}"
            subprocess.run(["curl", "-fsSL", "--retry", "2", "--max-time", "120",
                            "--output", incoming, url], check=True)
            if not valid_source(incoming, digest):
                reason = "SHA-256 mismatch" if digest is not None else f"invalid {extension.upper()} container"
                raise ValueError(f"{url}: {reason}")
            incoming.replace(path)


def publish(videos, output, *, files):
    if output.is_symlink():
        raise ValueError(f"Expected a regular output directory: {output}")
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
            for relative in files:
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError(f"Expected a relative output path: {relative}")
                source = videos / relative
                target = output / relative
                directory = output
                for part in relative.parent.parts:
                    directory = directory / part
                    if directory.is_symlink():
                        raise ValueError(f"Expected a regular output directory: {directory}")
                    if not directory.exists():
                        directory.mkdir()
                        rollback.callback(directory.rmdir)
                if target.is_symlink() or (target.exists() and not target.is_file()):
                    raise ValueError(f"Expected a regular output file: {target}")
                if target.exists():
                    if filecmp.cmp(source, target, shallow=False):
                        continue
                    saved = staging / relative
                    saved.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(target, saved)
                    rollback.callback(os.replace, saved, target)
                else:
                    rollback.callback(target.unlink, missing_ok=True)
                shutil.copyfile(source, incoming)
                incoming.replace(target)
            rollback.pop_all()
