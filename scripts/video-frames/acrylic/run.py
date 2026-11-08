import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from media import CACHE, OUTPUT, ROOT, SOURCE_HASHES, prepare_sources, publish, sha256

VARIANTS = ("08-soft-clear", "15-high-key")
PRESETS = HERE / "presets"
PRESET_FILES = ("plate.png", "mask-0.png", "screens.json", "outline.json", "frame.blend")
LIMITS = {"videos": 58, "animated": 421, "3d": 3000}
SAMPLES = json.loads((HERE / "samples.json").read_text())
SAMPLE_ORDER = [(category, str(i)) for category in ("videos", "3d") for i in SAMPLES["groups"][category]]


def sample_prefix(category, source_id):
    return f"{SAMPLE_ORDER.index((category, str(source_id))) + 1:02}"


def movie_filename(prefix, variant):
    return Path(f"{prefix}-{variant.split('-', 1)[1]}-white.mp4")


def sample_filename(category, source_id, variant):
    return movie_filename(sample_prefix(category, source_id), variant)


def same_location(path, reserved):
    while path != reserved:
        try:
            return path.samefile(reserved)
        except FileNotFoundError:
            pass
        if not path.name or not reserved.name:
            return False
        if path.name != reserved.name:
            if sys.platform != "darwin" or path.name.casefold() != reserved.name.casefold():
                return False
            ancestor = next(p for p in reserved.parents if p.exists())
            # Darwin's _PC_CASE_SENSITIVE is absent from Python's pathconf_names.
            if os.pathconf(ancestor, 11) == 1:
                return False
        path, reserved = path.parent, reserved.parent
    return True


def check_finalist_directory(output):
    if output.is_symlink() or output.exists() and not output.is_dir():
        raise ValueError(f"Expected a regular finalists directory: {output}")
    if not output.exists():
        return
    allowed = {sample_filename(category, i, variant) for category, i in SAMPLE_ORDER for variant in VARIANTS}
    unexpected = sorted(entry.name for entry in output.iterdir() if not entry.name.startswith(".")
                        and (Path(entry.name) not in allowed or entry.is_symlink() or not entry.is_file()))
    if unexpected:
        raise ValueError(f"Unexpected entries in {output}: {', '.join(unexpected)}. "
                         "Move them out of the finalists folder or choose another --output directory")


def local_prefix(category, path):
    name = unicodedata.normalize("NFC", path.stem)
    identity = f"{name.casefold()}\0{sha256(path)}"
    digest = hashlib.sha256(identity.encode("utf8")).hexdigest()[:24]
    stem = name.encode("utf8")[:100].decode("utf8", errors="ignore")
    return f"local-{category}-{stem}-{digest}"


def snapshot_inputs(inputs, directory):
    directory.mkdir()
    copies = []
    for original in inputs:
        target = directory / original.name
        with original.open("rb") as source, target.open("xb") as copy:
            before = os.fstat(source.fileno())
            shutil.copyfileobj(source, copy, length=1024 * 1024)
            after = os.fstat(source.fileno())
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ValueError(f"{original} changed while copying. Retry with a finished input file")
        copies.append(target)
    return copies


def source_ids(collection, value, samples):
    if value is None:
        if samples:
            return SAMPLES["groups"][collection]
        return list(SOURCE_HASHES[collection]) if collection != "3d" else [1, 2, 3, 4]
    fields = value.split(",")
    if any(not s.isascii() or not s.isdecimal() or not 1 <= int(s) <= LIMITS[collection] for s in fields):
        raise ValueError(f"Expected {collection} IDs between 1 and {LIMITS[collection]}")
    ids = list(map(int, fields))
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate IDs in selection")
    return ids


def prepare_media(collection, ids, inputs):
    if inputs:
        return inputs
    if collection == "3d":
        from knife_sources import numbered_models
        return numbered_models(ids)
    if collection == "animated":
        manifest = HERE.parent / "animated-source-sha256.json"
        hashes = {int(i): digest for i, digest in json.loads(manifest.read_text()).items()}
        directory = CACHE / "animated/sources/cdn-lil-111k"
    else:
        hashes = {**SOURCE_HASHES["videos"], **{int(i): h for i, h in SAMPLES["video_sha256"].items()}}
        directory = CACHE / "sources/cdn-lil-111k"
    prepare_sources(directory, collection, {i: hashes.get(i) for i in ids}, "mp4")
    return [directory / f"{i}.mp4" for i in ids]


def verify_presets(directory, variants):
    checksums = json.loads((directory / "checksums.json").read_text())
    if not isinstance(checksums, dict) or set(checksums) != set(VARIANTS):
        raise ValueError("Expected a checksum manifest for the two approved acrylic presets")
    for variant in variants:
        pinned = checksums[variant]
        if not isinstance(pinned, dict) or set(pinned) != set(PRESET_FILES):
            raise ValueError(f"{variant}: expected checksums for exactly the five approved assets")
        for name in PRESET_FILES:
            path = directory / variant / name
            if sha256(path) != pinned[name]:
                raise ValueError(f"SHA-256 mismatch for approved preset asset {path}")


def run_worker(jobs, work):
    command = [sys.executable, HERE / "worker.py"]
    # Register the child before cancellation can interrupt the spawning thread.
    mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
    try:
        with subprocess.Popen(command, stdin=subprocess.PIPE, text=True, start_new_session=True,
                              env={**os.environ, "TMPDIR": str(work)}) as worker:
            try:
                signal.pthread_sigmask(signal.SIG_SETMASK, mask)
                worker.communicate(json.dumps(jobs))
                if worker.returncode:
                    raise subprocess.CalledProcessError(worker.returncode, command)
            except BaseException:
                try:
                    os.killpg(worker.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                raise
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, mask)


def main():
    parser = argparse.ArgumentParser(description="Render framed 111k media or standalone 16:9 knife animations.")
    parser.add_argument("--collection", choices=["videos", "animated", "knives", "3d"])
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--samples", action="store_true", help="render the four selected videos and five selected knives")
    selection.add_argument("--ids", help="comma-separated category-local IDs")
    selection.add_argument("--input", action="append", type=Path, default=[], help="local MP4, or a GLB for knives")
    selection.add_argument("--verify", action="store_true", help="check both saved acrylic presets against their approved hashes")
    parser.add_argument("--variant", choices=VARIANTS, help="render just one setup (default: both)")
    parser.add_argument("--frameless", action="store_true", help="knives only: render at 4K, downsample to 1080p, encode at CRF 12")
    parser.add_argument("--background", choices=["white"], help="the approved white background (default)")
    parser.add_argument("--output", type=Path, help="destination directory")
    args = parser.parse_args()
    collection = "3d" if args.collection == "knives" else args.collection
    if args.frameless:
        if collection != "3d":
            parser.error("--frameless requires --collection knives or 3d")
        if args.variant or args.background or args.verify:
            parser.error("--frameless cannot be combined with --variant, --background or --verify")
    if args.verify:
        if args.output or args.variant:
            parser.error("--verify checks both saved presets and takes no output directory or variant")
        verify_presets(PRESETS, VARIANTS)
        print(f"Verified both acrylic presets ({len(VARIANTS) * len(PRESET_FILES)} assets).")
        return
    if args.input:
        if not args.output:
            parser.error("--input requires --output")
        extension = ".glb" if collection == "3d" else ".mp4"
        if any(not p.is_file() or p.suffix.lower() != extension for p in args.input):
            parser.error(f"All local inputs must be existing {extension} files")
        if len({unicodedata.normalize("NFC", p.stem).casefold() for p in args.input}) != len(args.input):
            parser.error("Local inputs must have distinct stems")
    if args.samples and collection and collection not in SAMPLES["groups"]:
        parser.error("The current sample selection contains videos and knives")
    collections = list(SAMPLES["groups"]) if args.samples and not collection else [collection or "videos"]
    variants = [args.variant] if args.variant else VARIANTS
    selections = {key: source_ids(key, args.ids, args.samples) for key in collections}
    finalists = OUTPUT / "acrylic" / "finalists"
    default_output = OUTPUT / "knives" / "frameless" if args.frameless else (
        finalists if args.samples else OUTPUT / "acrylic" / collections[0])
    output = args.output or default_output
    resolved = output.resolve()
    reserved = finalists.resolve()
    canonical = same_location(resolved, reserved)
    if any(same_location(p, reserved) for p in resolved.parents) or ((not args.samples or args.frameless) and canonical):
        parser.error("The finalists directory is reserved for --samples. Choose another --output directory")
    if canonical:
        check_finalist_directory(output)
    if not args.frameless:
        verify_presets(PRESETS, variants)
    with tempfile.TemporaryDirectory(prefix="acrylic-") as temporary:
        work = Path(temporary).absolute()
        inputs = snapshot_inputs(args.input, work / "inputs") if args.input else []
        sources = {}
        for category, ids in selections.items():
            media = prepare_media(category, ids, inputs)
            for index, source in enumerate(media):
                if args.frameless and not inputs:
                    prefix = source.stem
                elif args.samples:
                    prefix = sample_prefix(category, source.stem)
                elif inputs:
                    prefix = local_prefix(category, inputs[index])
                else:
                    prefix = f"{category}-{source.stem}"
                if prefix in sources:
                    raise ValueError(f"Duplicate export name for {source}")
                sources[prefix] = source
        stage = work / "export"
        if args.frameless:
            jobs = [(str(source), None, str(stage / f"{prefix}.mp4")) for prefix, source in sources.items()]
        else:
            jobs = [(str(source), str(PRESETS / variant), str(stage / movie_filename(prefix, variant)))
                    for prefix, source in sources.items() for variant in variants]
        run_worker(jobs, work)
        files = [Path(output_name).relative_to(stage) for _, _, output_name in jobs]
        if canonical:
            check_finalist_directory(output)
        publish(stage, output, files=files)
    print(f"Saved {len(files)} verified movies in {output.resolve()}")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda sig, _: sys.exit(128 + sig))
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
