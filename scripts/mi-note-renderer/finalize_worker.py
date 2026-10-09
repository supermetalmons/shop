import argparse
import contextlib
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys

import numpy as np
from PIL import Image


sys.dont_write_bytecode = True

import image_core as finalizer


class WorkerFailure(Exception):
    def __init__(self, message, details=None):
        super().__init__(message)
        self.details = details or {}


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def file_sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def fsync_file(path):
    with path.open("rb+") as handle:
        handle.flush()
        os.fsync(handle.fileno())


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path, value):
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    fsync_directory(path.parent)



def inspect_raw(card_id, raw):
    paths = set()
    for matte in ("white", "black"):
        metadata_path = raw / f"{card_id}-{matte}.json"
        document = json.loads(metadata_path.read_text())
        paths.add(metadata_path.resolve())
        for tile in document["tiles"]:
            path = Path(tile["path"])
            paths.add((path if path.is_absolute() else raw / path).resolve())
    return [
        {"file": str(path), "sha256": file_sha256(path), "bytes": path.stat().st_size}
        for path in sorted(paths)
    ]


def compare_png(image, profile, output_path, reference_path):
    with Image.open(reference_path) as reference:
        reference.verify()
    with Image.open(reference_path) as reference:
        reference.load()
        reference_profile = reference.info.get("icc_profile")
        same_size = image.size == reference.size
        comparison = {
            "reference": str(reference_path.resolve()),
            "referenceFileSha256": file_sha256(reference_path),
            "decodedRgbaEqual": False,
            "iccBytesEqual": profile == reference_profile,
            "fileBytesEqual": output_path.read_bytes() == reference_path.read_bytes(),
            "differingPixels": None,
            "maxChannelError255": None,
            "dimensionsEqual": same_size,
        }
        if same_size:
            difference = np.abs(
                np.asarray(image, dtype=np.int16)
                - np.asarray(reference.convert("RGBA"), dtype=np.int16)
            )
            comparison["differingPixels"] = int(np.any(difference != 0, axis=2).sum())
            comparison["maxChannelError255"] = int(difference.max())
            comparison["decodedRgbaEqual"] = comparison["differingPixels"] == 0
    return comparison


def save_thumbnail(preview, profile, stage):
    temporary = stage / f".thumb.{os.getpid()}.tmp"
    thumbnail = preview.convert("RGBa").resize((280, 392), Image.Resampling.LANCZOS).convert("RGBA")
    try:
        thumbnail.save(temporary, format="PNG", compress_level=9, icc_profile=profile)
    finally:
        thumbnail.close()
    fsync_file(temporary)
    os.replace(temporary, stage / "thumb.png")
    fsync_directory(stage)


def run(args):
    if not 1 <= args.id <= 1430:
        raise WorkerFailure("Card ID must be between 1 and 1430")
    if not args.fingerprint.strip():
        raise WorkerFailure("Run fingerprint must not be empty")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", args.expected_icc):
        raise WorkerFailure("Expected ICC must be a SHA-256 hexadecimal digest")
    if (args.stage / "result.json").exists():
        raise WorkerFailure("Stage already contains a completion record; use a fresh stage")
    raw_files = inspect_raw(args.id, args.raw)
    options = argparse.Namespace(
        raw=args.raw,
        output=args.stage,
        reports=args.stage / "qa",
        edge_guard=64,
        recomposition_tolerance=2,
    )
    with contextlib.redirect_stdout(sys.stderr):
        entry = finalizer.finalize(str(args.id), options)
    png_path = args.stage / f"{args.id}.png"
    fsync_file(png_path)
    fsync_directory(args.stage)
    with Image.open(png_path) as verification:
        verification.verify()
    comparison = None
    with Image.open(png_path) as image:
        image.load()
        if image.size != (2000, 2800) or image.mode != "RGBA":
            raise WorkerFailure(f"Unexpected output geometry or mode: {image.size} {image.mode}")
        profile = image.info.get("icc_profile")
        actual_icc = hashlib.sha256(profile).hexdigest() if profile else None
        if actual_icc != args.expected_icc.lower():
            raise WorkerFailure("Native ICC profile differs from the expected profile", {
                "expectedIccSha256": args.expected_icc.lower(), "actualIccSha256": actual_icc,
            })
        if not entry["manifest"]["qa"]["passed"]:
            raise WorkerFailure("Validated finalizer did not pass capture QA")
        decoded_sha = hashlib.sha256(image.tobytes()).hexdigest()
        if args.compare_with:
            comparison = compare_png(image, profile, png_path, args.compare_with)
            if not comparison["decodedRgbaEqual"] or not comparison["iccBytesEqual"]:
                raise WorkerFailure("Control comparison is not exact in decoded RGBA and ICC bytes", {
                    "comparison": comparison,
                })
    for record in raw_files:
        path = Path(record["file"])
        if path.stat().st_size != record["bytes"] or file_sha256(path) != record["sha256"]:
            raise WorkerFailure(f"Raw input changed during finalization: {path}")
    save_thumbnail(entry["image"], finalizer.SRGB_PROFILE, args.stage)
    entry["image"].close()
    for report_path in options.reports.glob("*.json"):
        fsync_file(report_path)
    fsync_directory(options.reports)
    result = {
        "id": args.id,
        "runFingerprint": args.fingerprint,
        "fileSha256": file_sha256(png_path),
        "decodedRgbaSha256": decoded_sha,
        "iccSha256": actual_icc,
        "bytes": png_path.stat().st_size,
        "width": 2000,
        "height": 2800,
        "mode": "RGBA",
        "qaPassed": True,
        "report": entry["manifest"],
        "rawFiles": raw_files,
        "timestamp": timestamp(),
    }
    if comparison is not None:
        result["comparison"] = comparison
    error_path = args.stage / "error.json"
    if error_path.exists():
        error_path.unlink()
    atomic_json(args.stage / "result.json", result)
    print(json.dumps({"id": args.id, "qaPassed": True, "result": str(args.stage / "result.json")}))
    return 0


def main():
    parser = argparse.ArgumentParser(description="Finalize one Safari viewport card in an isolated stage")
    parser.add_argument("--id", required=True, type=int)
    parser.add_argument("--raw", required=True, type=Path)
    parser.add_argument("--stage", required=True, type=Path)
    parser.add_argument("--fingerprint", required=True)
    parser.add_argument("--expected-icc", required=True)
    parser.add_argument("--compare-with", type=Path)
    args = parser.parse_args()
    args.raw = args.raw.resolve()
    args.stage = args.stage.resolve()
    try:
        args.stage.mkdir(parents=True, exist_ok=True)
        return run(args)
    except Exception as error:
        failure = {
            "id": args.id,
            "runFingerprint": args.fingerprint,
            "timestamp": timestamp(),
            "error": str(error),
            "type": type(error).__name__,
            **(error.details if isinstance(error, WorkerFailure) else {}),
        }
        try:
            atomic_json(args.stage / "error.json", failure)
        except Exception as write_error:
            print(f"Unable to persist error.json: {write_error}", file=sys.stderr)
        print(json.dumps(failure), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
