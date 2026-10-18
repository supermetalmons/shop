import argparse
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from contextlib import contextmanager
import hashlib
import io
import json
import fcntl
import os
import multiprocessing
from pathlib import Path
import subprocess
import stat
import sys
import tempfile
from fractions import Fraction
from functools import lru_cache
from uuid import uuid4

from PIL import Image, ImageCms


WIDTH = 1080
HEIGHT = 1080
FRAME_COUNT = 276
FPS = 60
PROFILE_PATHS = {
    "srgb": Path("/System/Library/ColorSync/Profiles/sRGB Profile.icc"),
    "p3": Path("/System/Library/ColorSync/Profiles/Display P3.icc"),
}


@lru_cache(maxsize=16)
def profile_metadata(profile_bytes):
    if not profile_bytes:
        return None
    profile = ImageCms.ImageCmsProfile(io.BytesIO(profile_bytes))
    return {
        "sha256": hashlib.sha256(profile_bytes).hexdigest(),
        "bytes": len(profile_bytes),
        "description": ImageCms.getProfileDescription(profile).strip(),
    }


@lru_cache(maxsize=16)
def color_transform(source_bytes, target_bytes):
    return ImageCms.buildTransformFromOpenProfiles(
        ImageCms.ImageCmsProfile(io.BytesIO(source_bytes)),
        ImageCms.ImageCmsProfile(io.BytesIO(target_bytes)),
        "RGB", "RGB", renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )


@lru_cache(maxsize=16)
def transformed_black_rgb(source_bytes, target_bytes):
    black = Image.new("RGB", (1, 1), (0, 0, 0))
    return ImageCms.applyTransform(black, color_transform(source_bytes, target_bytes)).getpixel((0, 0))


def transform_black_padded_rgb(image, source_bytes, target_bytes):
    transform = color_transform(source_bytes, target_bytes)
    if not all(image.size):
        return ImageCms.applyTransform(image, transform)
    bounds = image.getbbox()
    if bounds == (0, 0, image.width, image.height):
        return ImageCms.applyTransform(image, transform)
    converted = ImageCms.applyTransform(image.crop(bounds or (0, 0, 1, 1)), transform)
    background = transformed_black_rgb(source_bytes, target_bytes) if bounds else converted.getpixel((0, 0))
    result = Image.new("RGB", image.size, background)
    result.info = converted.info.copy()
    if bounds:
        result.paste(converted, (bounds[0], bounds[1]))
    return result


def inspect_image(path):
    with Image.open(path) as image:
        image.load()
        return {
            "path": str(Path(path).resolve()),
            "width": image.width,
            "height": image.height,
            "mode": image.mode,
            "icc": profile_metadata(image.info.get("icc_profile")),
        }


def crop_box(value):
    try:
        parts = [int(part) for part in value.split(",")]
    except ValueError as error:
        raise argparse.ArgumentTypeError("Crop must be four integers: x,y,width,height") from error
    if len(parts) != 4 or parts[0] < 0 or parts[1] < 0 or parts[2] <= 0 or parts[3] <= 0:
        raise argparse.ArgumentTypeError("Crop requires nonnegative x,y and positive width,height")
    return tuple(parts)


def require_new_output(path, suffix):
    path = Path(path).resolve()
    if path.suffix.lower() != suffix:
        raise ValueError(f"Output must end with {suffix}")
    if path.exists():
        raise ValueError(f"Output already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def save_png(image, output, profile_bytes):
    pending = output.with_name(f".{output.stem}.{uuid4().hex}.pending.png")
    try:
        with pending.open("xb") as destination:
            image.save(destination, format="PNG", compress_level=1, icc_profile=profile_bytes)
        os.link(pending, output)
    finally:
        pending.unlink(missing_ok=True)


def integer(value, label, minimum=None):
    if isinstance(value, bool) or not isinstance(value, int) or (minimum is not None and value < minimum):
        raise ValueError(f"{label} must be an integer" + (f" at least {minimum}" if minimum is not None else ""))
    return value


def prepare_frame(input_path, output_path, space, crop=None, input_space=None, size=None):
    if size is not None:
        integer(size, "size", 1)
    output = require_new_output(output_path, ".png")
    with Image.open(input_path) as image:
        image.load()
        return prepare_loaded_frame(image, input_path, output, space, crop, input_space, size)


def prepare_loaded_frame(image, input_path, output_path, space, crop=None, input_space=None, size=None, *, black_padding=False):
    if size is not None:
        integer(size, "size", 1)
    output = require_new_output(output_path, ".png")
    target_bytes = PROFILE_PATHS[space].read_bytes()
    source_size = {"width": image.width, "height": image.height}
    source_bytes = image.info.get("icc_profile")
    assumed_profile = False
    if not source_bytes:
        if input_space != "srgb":
            raise ValueError("Input is missing an ICC profile; use --input-space srgb only for known sRGB pixels")
        source_bytes = PROFILE_PATHS["srgb"].read_bytes()
        assumed_profile = True
    if image.mode not in ("RGB", "RGBA"):
        raise ValueError(f"Expected an RGB or RGBA screenshot, got {image.mode}")
    if crop is not None:
        x, y, width, height = crop
        if x + width > image.width or y + height > image.height:
            raise ValueError(f"Crop {crop} exceeds input dimensions {image.size}")
        image = image.crop((x, y, x + width, y + height))
    if image.mode == "RGBA" and image.getchannel("A").getextrema() != (255, 255):
        raise ValueError("Video frames must be opaque; capture the complete native stage before preparing")
    captured_size = {"width": image.width, "height": image.height}
    if size is not None and (image.width != image.height or size > image.width):
        raise ValueError("Size requires a square source crop and must not upscale it")
    if type(black_padding) is not bool:
        raise ValueError("Black-padding ICC optimization must be a boolean")
    if black_padding:
        converted = transform_black_padded_rgb(image.convert("RGB"), source_bytes, target_bytes)
    else:
        converted = ImageCms.applyTransform(image.convert("RGB"), color_transform(source_bytes, target_bytes))
    resample = None
    if size is not None and converted.size != (size, size):
        converted = converted.resize((size, size), Image.Resampling.LANCZOS)
        resample = {"filter": "Lanczos", "passes": 1, "from": captured_size, "to": {"width": size, "height": size}, "afterIccConversion": True}
    save_png(converted, output, target_bytes)
    return {
        "path": str(output), "width": converted.width, "height": converted.height, "mode": converted.mode,
        "icc": profile_metadata(target_bytes),
        "space": space,
        "input": str(Path(input_path).resolve()),
        "inputIcc": profile_metadata(source_bytes),
        "inputProfileAssumed": assumed_profile,
        "crop": list(crop) if crop is not None else None,
        "sourceSize": source_size, "capturedSize": captured_size, "resample": resample,
        "conversion": "LittleCMS relative colorimetric ICC transform",
    }


def run(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{command[0]} failed ({result.returncode}): {result.stderr[-8000:]}")
    return result.stdout


def frame_names(directory):
    directory = Path(directory).resolve()
    if not directory.is_dir():
        raise ValueError(f"Frame directory does not exist: {directory}")
    expected = [f"{index:04d}.png" for index in range(FRAME_COUNT)]
    actual = sorted(path.name for path in directory.glob("*.png"))
    if actual != expected:
        raise ValueError(f"Expected exactly {FRAME_COUNT} numbered PNG frames, 0000.png through {FRAME_COUNT - 1:04d}.png")
    return expected


@contextmanager
def prepared_frame_reports(source, output, names, space, crop, input_space, size, workers):
    if workers == 1:
        yield (prepare_frame(source / name, output / name, space, crop, input_space, size) for name in names)
        return
    pool = ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn"))
    pending = deque()
    remaining = iter(names)

    def submit_next():
        name = next(remaining, None)
        if name is not None:
            pending.append(pool.submit(prepare_frame, source / name, output / name, space, crop, input_space, size))

    def ordered_reports():
        while pending:
            yield pending.popleft().result()
            submit_next()

    try:
        for _ in range(workers):
            submit_next()
        yield ordered_reports()
    finally:
        pool.shutdown(wait=True, cancel_futures=True)


def prepare_sequence(input_directory, output_directory, space, crop=None, input_space=None, size=None, workers=1):
    integer(workers, "workers", 1)
    if workers > 4:
        raise ValueError("At most four preparation workers are supported")
    source = Path(input_directory).resolve()
    output = Path(output_directory).resolve()
    names = frame_names(source)
    if output.exists():
        raise ValueError(f"Output already exists: {output}")
    output.mkdir(parents=True)
    dimensions = None
    captured_size = None
    resample = None
    source_profiles = {}
    assumed = False
    with prepared_frame_reports(source, output, names, space, crop, input_space, size, workers) as reports:
        for index, (name, report) in enumerate(zip(names, reports)):
            frame_dimensions = (report["width"], report["height"])
            if dimensions is not None and frame_dimensions != dimensions:
                raise ValueError(f"{name}: prepared dimensions differ from earlier frames")
            if captured_size is not None and report["capturedSize"] != captured_size:
                raise ValueError(f"{name}: captured dimensions differ from earlier frames")
            dimensions = frame_dimensions
            captured_size = report["capturedSize"]
            resample = report["resample"]
            source_profiles[report["inputIcc"]["sha256"]] = report["inputIcc"]
            assumed = assumed or report["inputProfileAssumed"]
            if (index + 1) % 24 == 0 or index == len(names) - 1:
                print(f"Prepared {index + 1}/{len(names)} {space} frames", file=sys.stderr, flush=True)
    return {
        "input": str(source), "output": str(output), "space": space, "frames": len(names),
        "width": dimensions[0], "height": dimensions[1], "mode": "RGB",
        "icc": profile_metadata(PROFILE_PATHS[space].read_bytes()),
        "inputIcc": list(source_profiles.values()), "inputProfileAssumed": assumed,
        "crop": list(crop) if crop is not None else None,
        "capturedSize": captured_size, "resample": resample,
        "conversion": "LittleCMS relative colorimetric ICC transform",
    }


def validate_frames(directory, space, size=None):
    size = WIDTH if size is None else integer(size, "size", 1)
    directory = Path(directory).resolve()
    expected = frame_names(directory)
    profile_bytes = PROFILE_PATHS[space].read_bytes()
    for name in expected:
        with Image.open(directory / name) as image:
            image.load()
            if image.size != (size, size) or image.mode != "RGB":
                raise ValueError(f"{name}: expected opaque RGB {size}x{size}, got {image.mode} {image.size}")
            if image.info.get("icc_profile") != profile_bytes:
                raise ValueError(f"{name}: ICC profile does not match the {space} target profile")
    return profile_metadata(profile_bytes)


def encoding_command(input_arguments, pending, space, size):
    ffmpeg = os.environ.get("MI_NOTE_FFMPEG", "ffmpeg")
    primaries = "smpte432" if space == "p3" else "bt709"
    pixel_format = "yuv420p10le" if space == "p3" else "yuv420p"
    filters = (
        f"scale=w={size}:h={size}:in_range=full:out_range=limited:out_color_matrix=bt709:"
        f"in_primaries={primaries}:out_primaries={primaries}:"
        "in_transfer=iec61966-2-1:out_transfer=iec61966-2-1,"
        f"format={pixel_format}"
    )
    command = [
        ffmpeg, "-hide_banner", "-v", "error", "-xerror", "-n",
        *input_arguments,
        "-map", "0:v:0", "-an", "-frames:v", str(FRAME_COUNT),
        "-vf", filters, "-c:v", "libx265" if space == "p3" else "libx264",
        "-preset", "medium", "-crf", "16", "-threads", "4", "-bf", "3", "-g", "60", "-keyint_min", "60",
        "-color_primaries", primaries, "-color_trc", "iec61966-2-1",
        "-colorspace", "bt709", "-color_range", "tv", "-movflags", "+faststart",
    ]
    if space == "p3":
        command.extend(["-x265-params", "keyint=60:min-keyint=60:scenecut=0:pools=4:frame-threads=2:log-level=error", "-tag:v", "hvc1"])
    else:
        command.extend(["-sc_threshold", "0"])
    command.append(str(pending))
    return command, filters


def encode_frames(directory, output_path, space, size=None):
    size = WIDTH if size is None else integer(size, "size", 1)
    if size % 2:
        raise ValueError("Encoded size must be even for YUV 4:2:0")
    output = require_new_output(output_path, ".mp4")
    directory = Path(directory).resolve()
    profile = validate_frames(directory, space, size)
    ffmpeg = os.environ.get("MI_NOTE_FFMPEG", "ffmpeg")
    ffprobe = os.environ.get("MI_NOTE_FFPROBE", "ffprobe")
    primaries = "smpte432" if space == "p3" else "bt709"
    codec = "hevc" if space == "p3" else "h264"
    pixel_format = "yuv420p10le" if space == "p3" else "yuv420p"
    filters = (
        f"scale=w={size}:h={size}:in_range=full:out_range=limited:out_color_matrix=bt709:"
        f"in_primaries={primaries}:out_primaries={primaries}:"
        "in_transfer=iec61966-2-1:out_transfer=iec61966-2-1,"
        f"format={pixel_format}"
    )
    pending = output.with_name(f".{output.stem}.{uuid4().hex}.pending.mp4")
    command, filters = encoding_command(["-framerate", str(FPS), "-start_number", "0", "-i", str(directory / "%04d.png")], pending, space, size)
    try:
        run(command)
        probe = json.loads(run([
            ffprobe, "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(pending),
        ]))
        streams = probe.get("streams", [])
        if len(streams) != 1:
            raise ValueError("Expected exactly one video stream")
        stream = streams[0]
        expected_tags = {
            "codec_type": "video", "codec_name": codec, "width": size, "height": size,
            "pix_fmt": pixel_format, "color_range": "tv", "color_space": "bt709",
            "color_transfer": "iec61966-2-1", "color_primaries": primaries,
        }
        if space == "p3":
            expected_tags["codec_tag_string"] = "hvc1"
        for name, value in expected_tags.items():
            if stream.get(name) != value:
                raise ValueError(f"Output {name}: expected {value}, got {stream.get(name)}")
        if Fraction(stream["avg_frame_rate"]) != FPS:
            raise ValueError("Output frame rate differs from the requested rate")
        if int(stream["nb_frames"]) != FRAME_COUNT or int(stream["nb_read_frames"]) != FRAME_COUNT:
            raise ValueError("Output frame count differs from the requested count")
        if abs(float(stream["duration"]) - FRAME_COUNT / FPS) > 0.001:
            raise ValueError("Output duration differs from the requested duration")
        run([ffmpeg, "-v", "error", "-xerror", "-i", str(pending), "-map", "0:v:0", "-f", "null", "-"])
        digest = hashlib.sha256(pending.read_bytes()).hexdigest()
        byte_size = pending.stat().st_size
        os.link(pending, output)
    finally:
        pending.unlink(missing_ok=True)
    return {
        "output": str(output), "space": space, "bytes": byte_size, "sha256": digest,
        "frames": FRAME_COUNT, "frameRate": FPS, "duration": FRAME_COUNT / FPS, "width": size, "height": size,
        "inputIcc": profile, "encoder": "libx265" if space == "p3" else "libx264",
        "crf": 16, "preset": "medium", "keyframeInterval": 60,
        "rgbToYuvFilter": filters, "fullyDecoded": True, "stream": stream,
    }


class PngSequenceEncoder:
    def __init__(self, output_path, space, size):
        integer(size, "size", 2)
        if size % 2 or space not in PROFILE_PATHS:
            raise ValueError("Invalid streaming encoding dimensions or color space")
        self.output = require_new_output(output_path, ".mp4")
        self.pending = self.output.with_name(f".{self.output.stem}.{uuid4().hex}.pending.mp4")
        self.space, self.size, self.count = space, size, 0
        self.process = self.lock = None
        self.errors = tempfile.TemporaryFile()
        try:
            lock_path = os.environ.get("MI_NOTE_ENCODER_LOCK")
            if lock_path:
                path = Path(lock_path)
                if not path.is_absolute() or path.parent.resolve() != path.parent:
                    raise ValueError("Encoder lock must have an absolute regular parent")
                self.lock = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
                if not stat.S_ISREG(os.fstat(self.lock).st_mode):
                    raise ValueError("Encoder lock must be a regular file")
                fcntl.flock(self.lock, fcntl.LOCK_EX)
            command, self.filters = encoding_command(
                ["-f", "image2pipe", "-framerate", str(FPS), "-c:v", "png", "-i", "pipe:0"],
                self.pending, space, size)
            self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                            stderr=self.errors, bufsize=0)
        except BaseException:
            self.close()
            raise

    def write(self, frame, content):
        if type(frame) is not int or frame != self.count or self.count >= FRAME_COUNT:
            raise ValueError("Streaming encoder frame order or count changed")
        if self.process is None or self.process.poll() is not None:
            raise RuntimeError("Streaming encoder exited before all frames arrived")
        remaining = memoryview(content)
        while remaining:
            written = self.process.stdin.write(remaining)
            if not written:
                raise RuntimeError("Streaming encoder stopped accepting PNG bytes")
            remaining = remaining[written:]
        self.count += 1

    def release_lock(self):
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None

    def finish(self, certificate_directory):
        from video_validation import strict_decode
        if self.count != FRAME_COUNT or self.process is None:
            raise ValueError(f"Expected exactly {FRAME_COUNT} streaming frames")
        self.process.stdin.close()
        code = self.process.wait(timeout=300)
        self.release_lock()
        if code:
            self.errors.seek(0)
            raise RuntimeError(f"Streaming encoder failed ({code}): {self.errors.read()[-8000:].decode(errors='replace')}")
        certificate, descriptor = strict_decode(self.pending, certificate_directory, self.size, self.space, FRAME_COUNT, FPS)
        report = {
            "output": str(self.output), "space": self.space, "bytes": certificate['videoBytes'], "sha256": certificate['videoSha256'],
            "frames": FRAME_COUNT, "frameRate": FPS, "duration": FRAME_COUNT / FPS, "width": self.size, "height": self.size,
            "inputIcc": profile_metadata(PROFILE_PATHS[self.space].read_bytes()), "encoder": "libx265" if self.space == "p3" else "libx264",
            "crf": 16, "preset": "medium", "keyframeInterval": 60,
            "rgbToYuvFilter": self.filters, "fullyDecoded": True, "stream": certificate['stream'], "decodeCertificate": descriptor,
        }
        os.link(self.pending, self.output)
        self.pending.unlink()
        return report

    def close(self):
        try:
            if self.process is not None:
                if self.process.stdin and not self.process.stdin.closed:
                    self.process.stdin.close()
                if self.process.poll() is None:
                    self.process.terminate()
                    try:
                        self.process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        self.process.kill()
                        self.process.wait(timeout=2)
        finally:
            self.release_lock()
            self.errors.close()


def main():
    parser = argparse.ArgumentParser(description="Prepare color-managed frames and encode Mi Note comparison videos")
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("input", type=Path)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--input", required=True, type=Path)
    prepare.add_argument("--output", required=True, type=Path)
    prepare.add_argument("--space", required=True, choices=PROFILE_PATHS)
    prepare.add_argument("--crop", type=crop_box)
    prepare.add_argument("--input-space", choices=["srgb"])
    prepare.add_argument("--size", type=int)
    sequence = commands.add_parser("prepare-sequence")
    sequence.add_argument("--input", required=True, type=Path)
    sequence.add_argument("--output", required=True, type=Path)
    sequence.add_argument("--space", required=True, choices=PROFILE_PATHS)
    sequence.add_argument("--crop", type=crop_box)
    sequence.add_argument("--input-space", choices=["srgb"])
    sequence.add_argument("--size", type=int)
    sequence.add_argument("--workers", type=int, choices=range(1, 5), default=4)
    encode = commands.add_parser("encode")
    encode.add_argument("--frames", required=True, type=Path)
    encode.add_argument("--output", required=True, type=Path)
    encode.add_argument("--space", required=True, choices=PROFILE_PATHS)
    encode.add_argument("--size", type=int)
    args = parser.parse_args()
    if args.command == "inspect":
        result = inspect_image(args.input)
    elif args.command == "prepare":
        result = prepare_frame(args.input, args.output, args.space, args.crop, args.input_space, args.size)
    elif args.command == "prepare-sequence":
        result = prepare_sequence(args.input, args.output, args.space, args.crop, args.input_space, args.size, args.workers)
    else:
        result = encode_frames(args.frames, args.output, args.space, args.size)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, ImageCms.PyCMSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
