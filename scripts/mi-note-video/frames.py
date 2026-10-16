import argparse
import hashlib
import io
import json
import os
import math
from pathlib import Path
import subprocess
import sys
from fractions import Fraction
from functools import lru_cache
from uuid import uuid4

import numpy as np
from PIL import Image, ImageCms


WIDTH = 1080
HEIGHT = 1080
FRAME_COUNT = 276
FPS = 60
STITCH_GUARD = 32
STITCH_BAND = 128
STITCH_MAX_ERROR = 20
STITCH_MEAN_ERROR = 0.05
DELIVERY_MAX_ERROR = 20
DELIVERY_CUT_MAX_ERROR = 10
DELIVERY_CUT_RADIUS = 3
DELIVERY_COHERENCE_RADIUS = 4
DELIVERY_MEAN_ERROR = 0.05
DELIVERY_P999_ERROR = 2
DELIVERY_FRACTION_OVER_2 = 0.001
DELIVERY_BLOCK_MEAN_ERROR = 0.75
DELIVERY_LINE_MEAN_ERROR = 0.25
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


def tile_crop(tile, box):
    local = tuple(value - tile["originX" if index % 2 == 0 else "originY"] for index, value in enumerate(box))
    if local[0] < STITCH_GUARD or local[1] < STITCH_GUARD \
            or local[2] > tile["image"].width - STITCH_GUARD or local[3] > tile["image"].height - STITCH_GUARD:
        raise ValueError(f"{tile['path']}: crop {local} violates the {STITCH_GUARD}-pixel viewport edge guard")
    image = tile["image"].crop(local)
    if image.getchannel("A").getextrema() != (255, 255):
        raise ValueError(f"{tile['path']}: stitched frame region must be opaque")
    return image.convert("RGB")


def difference_metrics(left, right):
    difference = np.abs(np.asarray(left, dtype=np.int16) - np.asarray(right, dtype=np.int16))
    pixel_means = difference.mean(axis=2)
    if min(pixel_means.shape) >= 8:
        integral = np.pad(pixel_means.cumsum(axis=0).cumsum(axis=1), ((1, 0), (1, 0)))
        blocks = integral[8:, 8:] - integral[:-8, 8:] - integral[8:, :-8] + integral[:-8, :-8]
        max_block_mean = float(blocks.max() / 64)
    else:
        max_block_mean = float(pixel_means.mean())
    return {
        "pixels": difference.shape[0] * difference.shape[1],
        "meanChannelError255": float(difference.mean()),
        "maxChannelError255": int(difference.max()),
        "channelErrorP99_9": float(np.percentile(difference, 99.9)),
        "fractionPixelsOver2": float(np.any(difference > 2, axis=2).mean()),
        "maximum8x8MeanChannelError255": max_block_mean,
        "maximumRowMeanChannelError255": float(pixel_means.mean(axis=1).max()),
        "differentPixels": int(np.any(difference > 0, axis=2).sum()),
    }


def tile_difference(first, second, box):
    return {"box": list(box), **difference_metrics(tile_crop(first, box), tile_crop(second, box))}


def validate_delivery_spaces(spaces):
    if spaces is None:
        return ("srgb", "p3")
    if not isinstance(spaces, (list, tuple)) or not spaces \
            or any(not isinstance(space, str) or space not in PROFILE_PATHS for space in spaces) \
            or len(set(spaces)) != len(spaces):
        raise ValueError("Delivery spaces must be a nonempty list of distinct choices from srgb,p3")
    return tuple(spaces)


def parse_delivery_spaces(value):
    try:
        return validate_delivery_spaces([space.strip() for space in value.split(",")])
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def delivery_difference(first, second, band, width, height, delivery_size, profile_bytes, delivery_spaces=None):
    selected_spaces = validate_delivery_spaces(delivery_spaces)
    scale_x = Fraction(delivery_size, width)
    scale_y = Fraction(delivery_size, height)
    output_box = (
        math.floor(band[0] * scale_x), math.floor(band[1] * scale_y),
        math.ceil(band[2] * scale_x), math.ceil(band[3] * scale_y),
    )
    padding_x = math.ceil(3 / scale_x) + 2
    padding_y = math.ceil(3 / scale_y) + 2
    source_box = (
        max(0, math.floor(output_box[0] / scale_x) - padding_x),
        max(0, math.floor(output_box[1] / scale_y) - padding_y),
        min(width, math.ceil(output_box[2] / scale_x) + padding_x),
        min(height, math.ceil(output_box[3] / scale_y) + padding_y),
    )
    resize_box = (
        float(output_box[0] / scale_x - source_box[0]),
        float(output_box[1] / scale_y - source_box[1]),
        float(output_box[2] / scale_x - source_box[0]),
        float(output_box[3] / scale_y - source_box[1]),
    )
    output_size = (output_box[2] - output_box[0], output_box[3] - output_box[1])
    cut_axis = 1 if first["row"] != second["row"] else 0
    cut_scale = scale_y if cut_axis else scale_x
    cut_position = Fraction(band[cut_axis] + band[cut_axis + 2], 2) * cut_scale
    cut_box = list(output_box)
    cut_box[cut_axis] = max(output_box[cut_axis], math.floor(cut_position) - DELIVERY_CUT_RADIUS)
    cut_box[cut_axis + 2] = min(output_box[cut_axis + 2], math.ceil(cut_position) + DELIVERY_CUT_RADIUS)
    cut_crop = tuple(value - output_box[index % 2] for index, value in enumerate(cut_box))
    coherence_box = list(output_box)
    coherence_box[cut_axis] = max(output_box[cut_axis], math.floor(cut_position) - DELIVERY_COHERENCE_RADIUS)
    coherence_box[cut_axis + 2] = min(output_box[cut_axis + 2], math.ceil(cut_position) + DELIVERY_COHERENCE_RADIUS)
    coherence_crop = tuple(value - output_box[index % 2] for index, value in enumerate(coherence_box))
    captures = [tile_crop(first, source_box), tile_crop(second, source_box)]
    reports = {}
    for space in selected_spaces:
        transform = color_transform(profile_bytes, PROFILE_PATHS[space].read_bytes())
        images = [ImageCms.applyTransform(image, transform).resize(output_size, Image.Resampling.LANCZOS, box=resize_box) for image in captures]
        metrics = difference_metrics(images[0], images[1])
        cut_metrics = difference_metrics(*(image.crop(cut_crop) for image in images))
        cut_metrics["passed"] = cut_metrics["maxChannelError255"] <= DELIVERY_CUT_MAX_ERROR
        metrics["cutInfluence"] = cut_metrics
        coherence_images = [image.crop(coherence_crop) for image in images]
        coherence_metrics = difference_metrics(*coherence_images)
        coherence_difference = np.abs(np.asarray(coherence_images[0], dtype=np.int16) - np.asarray(coherence_images[1], dtype=np.int16)).mean(axis=2)
        coherence_metrics["lineAxis"] = "row" if cut_axis else "column"
        coherence_metrics["maximumAlongSeamMeanChannelError255"] = float(coherence_difference.mean(axis=cut_axis).max())
        coherence_metrics["passed"] = coherence_metrics["maximum8x8MeanChannelError255"] <= DELIVERY_BLOCK_MEAN_ERROR \
            and coherence_metrics["maximumAlongSeamMeanChannelError255"] <= DELIVERY_LINE_MEAN_ERROR
        metrics["coherenceInfluence"] = coherence_metrics
        metrics["passed"] = metrics["meanChannelError255"] <= DELIVERY_MEAN_ERROR \
            and metrics["maxChannelError255"] <= DELIVERY_MAX_ERROR \
            and cut_metrics["passed"] \
            and metrics["channelErrorP99_9"] <= DELIVERY_P999_ERROR \
            and metrics["fractionPixelsOver2"] <= DELIVERY_FRACTION_OVER_2 \
            and coherence_metrics["passed"]
        reports[space] = metrics
    return {
        "width": delivery_size, "height": delivery_size, "outputBox": list(output_box),
        "paddedSourceBox": list(source_box), "filter": "Lanczos", "globalSamplingPhase": True,
        "cutInfluenceBox": cut_box, "cutInfluenceRadiusPixels": DELIVERY_CUT_RADIUS,
        "cutMaximumChannelError255": DELIVERY_CUT_MAX_ERROR,
        "coherenceBox": coherence_box, "coherenceRadiusPixels": DELIVERY_COHERENCE_RADIUS,
        "selectedSpaces": list(selected_spaces),
        "spaces": reports, "passed": all(report["passed"] for report in reports.values()),
    }


def landscape_viewport_frame(tile, record, metadata, metadata_path, profile_bytes):
    width, height = metadata["width"], metadata["height"]
    reference = metadata.get("backgroundReference")
    if not isinstance(reference, dict) or not isinstance(reference.get("path"), str) or not reference["path"]:
        raise ValueError("Landscape capture requires a background reference path")
    reference_path = Path(reference["path"])
    if not reference_path.is_absolute():
        reference_path = metadata_path.parent / reference_path
    reference_path = reference_path.resolve()
    reference_bytes = reference_path.read_bytes()
    digest = hashlib.sha256(reference_bytes).hexdigest()
    if reference.get("sha256") != digest:
        raise ValueError("Background reference SHA-256 does not match")
    excluded = reference.get("excludedBounds")
    if not isinstance(excluded, (list, tuple)) or len(excluded) != 4:
        raise ValueError("Background reference requires four excluded bounds")
    left, top, right, bottom = [integer(value, "excluded bound", 0) for value in excluded]
    if not (0 < left < right < width and 0 < top < bottom < height):
        raise ValueError("Background reference excluded bounds must lie inside the canvas")
    rotated_excluded = [width - bottom, left, width - top, right]
    with Image.open(io.BytesIO(reference_bytes)) as image:
        image.load()
        if image.mode != "RGB" or image.size != (width, height):
            raise ValueError(f"Background reference must be a {width}-pixel RGB frame")
        if image.info.get("icc_profile") != profile_bytes:
            raise ValueError("Background reference ICC does not match the native viewport")
        pixels = np.asarray(image)
        exterior = (pixels[:top], pixels[bottom:], pixels[top:bottom, :left], pixels[top:bottom, right:])
        if any(not np.all(region == 0) for region in exterior):
            raise ValueError("Background reference exterior must be exactly RGB black")
        rotated_reference = image.transpose(Image.Transpose.ROTATE_270)

    snapshot = record.get("snapshot")
    if not isinstance(snapshot, dict) or snapshot.get("dpr") != 2:
        raise ValueError("Landscape capture requires a DPR-2 snapshot")
    effect = snapshot.get("effect")
    if snapshot.get("rotationDegrees") != 90 or snapshot.get("background") != "#000000" \
            or snapshot.get("shadowEnabled") is not False or not isinstance(effect, dict) or effect.get("shadow") != "none":
        raise ValueError("Landscape snapshot must prove 90-degree clockwise rotation, black background, and no shadow")
    rect, stage = snapshot.get("rotatorRect"), snapshot.get("stageDocumentPixels")
    if not isinstance(rect, dict) or not isinstance(stage, dict):
        raise ValueError("Landscape capture requires projected card and stage geometry")

    def measured(value, label):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{label} must be finite")
        return value

    scroll_x = measured(snapshot.get("scrollX"), "scroll X")
    scroll_y = measured(snapshot.get("scrollY"), "scroll Y")
    if min(scroll_x, scroll_y) < 0 or any(abs(value - round(value)) > 0.0375 for value in (scroll_x, scroll_y)):
        raise ValueError("Landscape scroll must preserve the integer CSS raster phase")
    for key, expected in (("x", 32), ("y", 32), ("width", width), ("height", height)):
        if abs(measured(stage.get(key), f"stage {key}") - expected) > 0.075:
            raise ValueError("Landscape stage does not match the native canvas and 32-pixel gutter")
    if abs(scroll_x * 2 - stage["x"] - tile["originX"]) > 0.075 \
            or abs(scroll_y * 2 - stage["y"] - tile["originY"]) > 0.075:
        raise ValueError("Landscape tile origin differs from its snapshot")
    x, y, card_width, card_height = [measured(rect.get(key), f"projected card {key}") for key in ("x", "y", "width", "height")]
    if min(card_width, card_height) <= 0:
        raise ValueError("Projected card dimensions must be positive")
    protected = [
        math.floor((x + scroll_x) * 2 - stage["x"] - 2),
        math.floor((y + scroll_y) * 2 - stage["y"] - 2),
        math.ceil((x + scroll_x + card_width) * 2 - stage["x"] + 2),
        math.ceil((y + scroll_y + card_height) * 2 - stage["y"] + 2),
    ]
    box = [
        max(0, tile["originX"] + STITCH_GUARD), max(0, tile["originY"] + STITCH_GUARD),
        min(width, tile["originX"] + tile["image"].width - STITCH_GUARD),
        min(height, tile["originY"] + tile["image"].height - STITCH_GUARD),
    ]
    if box[0] != 0 or box[2] != width or box[1] >= box[3]:
        raise ValueError("Landscape viewport must cover the complete canvas width inside its guard")
    if any(protected[index] < box[index] or protected[index] < rotated_excluded[index] for index in (0, 1)) \
            or any(protected[index] > box[index] or protected[index] > rotated_excluded[index] for index in (2, 3)):
        raise ValueError("Landscape viewport clips the protected card or antialiasing bounds")
    captured = tile_crop(tile, box)
    border_radius = 8
    borders = []
    if box[1] > 0:
        borders.append([0, 0, width, border_radius])
    if box[3] < height:
        borders.append([0, captured.height - border_radius, width, captured.height])
    if captured.height < border_radius or any(not np.all(np.asarray(captured.crop(border)) == 0) for border in borders):
        raise ValueError("Landscape padding join must contain an exact-black 8-pixel strip")
    protected_local = [value - box[index % 2] for index, value in enumerate(protected)]
    left, top, right, bottom = protected_local
    pixels = np.asarray(captured)
    exterior = (pixels[:top], pixels[bottom:], pixels[top:bottom, :left], pixels[top:bottom, right:])
    if any(not np.all(region == 0) for region in exterior):
        raise ValueError("Landscape captured exterior outside protected card bounds must be exactly RGB black")
    padded_boxes = []
    if box[1] > 0:
        padded_boxes.append([0, 0, width, box[1]])
    if box[3] < height:
        padded_boxes.append([0, box[3], width, height])
    if any(not np.all(np.asarray(rotated_reference.crop(padded_box)) == 0) for padded_box in padded_boxes):
        raise ValueError("Landscape padded regions must be exactly RGB black in the rotated background reference")
    rotated = Image.new("RGB", (width, height), (0, 0, 0))
    rotated.paste(captured, (box[0], box[1]))
    result = rotated.transpose(Image.Transpose.ROTATE_90)
    restored_protected = [protected[1], width - protected[2], protected[3], width - protected[0]]
    return result, box, {
        "reference": {"path": str(reference_path), "sha256": digest, "excludedBounds": list(excluded),
                      "orientation": "unrotated", "rotatedExcludedBounds": rotated_excluded},
        "referenceExteriorExactBlack": True, "referencePaddedRegionsExactBlack": True, "referenceIccMatches": True,
        "sourceViewport": {"path": str(Path(tile["path"]).resolve()), "sha256": tile["sourceSha256"]},
        "sourceCropBox": [value - tile["originX" if index % 2 == 0 else "originY"] for index, value in enumerate(box)],
        "sourceCropRgbSha256": hashlib.sha256(captured.tobytes()).hexdigest(), "paddedBoxes": padded_boxes,
        "pasteBox": box, "protectedBounds": protected, "restoredProtectedBounds": restored_protected,
        "shadowAllowancePixels": 0, "antialiasAllowancePixels": 2,
        "blackBorderRadiusPixels": border_radius, "blackBordersExact": True,
        "blackBorderBoxes": [[border[0], border[1] + box[1], border[2], border[3] + box[1]] for border in borders],
        "capturedExteriorExactBlack": True, "paddingRgb": [0, 0, 0], "nativePixelsPreserved": True,
        "inverseRotationDegrees": 90, "losslessUnrotation": True,
        "inverseRotation": {"captureClockwiseDegrees": 90, "restoreCounterclockwiseDegrees": 90,
                            "operation": "PIL.Image.Transpose.ROTATE_90", "losslessIntegerPermutation": True,
                            "resampling": False, "restoredRgbSha256": hashlib.sha256(result.tobytes()).hexdigest()},
    }


def upright_black_proof(image, metadata):
    measured = []
    for tile in metadata["tiles"]:
        snapshot = tile.get("snapshot", {})
        if snapshot.get("dpr") != 2 or snapshot.get("rotationDegrees") != 0 or snapshot.get("background") != "#000000" \
                or snapshot.get("shadowEnabled") is not False or snapshot.get("effect", {}).get("shadow") != "none":
            raise ValueError("Upright capture requires DPR 2, no rotation, black, and no shadow")
        stage = snapshot.get("stageDocumentPixels", {})
        if any(not isinstance(stage.get(key), (int, float)) or not math.isfinite(stage[key]) or abs(stage[key] - value) > .075
               for key, value in {"x": 32, "y": 32, "width": 3240, "height": 3240}.items()):
            raise ValueError("Upright capture stage geometry differs")
        rect = snapshot.get("rotatorRect", {})
        values = [rect.get(key) for key in ["x", "y", "width", "height"]] + [snapshot.get("scrollX"), snapshot.get("scrollY")]
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
            raise ValueError("Upright capture projected bounds are missing")
        x, y, width, height, scroll_x, scroll_y = values
        if width <= 0 or height <= 0 or min(scroll_x, scroll_y) < 0:
            raise ValueError("Upright capture projected bounds are invalid")
        if any(abs(value * 2 - round(value * 2)) > .075 or round(value * 2) % 6 for value in [scroll_x, scroll_y]):
            raise ValueError("Upright capture scroll changed its six-pixel native raster phase")
        if abs(scroll_x * 2 - 32 - tile["originX"]) > .075 or abs(scroll_y * 2 - 32 - tile["originY"]) > .075:
            raise ValueError("Upright capture tile origin differs from its measured scroll")
        measured.append([(x + scroll_x) * 2 - 32, (y + scroll_y) * 2 - 32, width * 2, height * 2])
    if any(abs(value - measured[0][index]) > .075 for rect in measured for index, value in enumerate(rect)):
        raise ValueError("Projected card geometry differs between upright tiles")
    bounds = [math.floor(min(rect[0] for rect in measured)) - 2, math.floor(min(rect[1] for rect in measured)) - 2,
              math.ceil(max(rect[0] + rect[2] for rect in measured)) + 2, math.ceil(max(rect[1] + rect[3] for rect in measured)) + 2]
    left, top, right, bottom = bounds
    if not 0 <= left < right <= image.width or not 0 <= top < bottom <= image.height:
        raise ValueError("Upright card exceeds its native canvas")
    pixels = np.asarray(image)
    if any(not np.all(region == 0) for region in (pixels[:top], pixels[bottom:], pixels[top:bottom, :left], pixels[top:bottom, right:])):
        raise ValueError("Static exterior QA failed: upright native exterior must be exactly RGB black")
    return {"protectedBounds": bounds, "antialiasAllowancePixels": 2, "shadowAllowancePixels": 0,
            "capturedExteriorExactBlack": True, "nativePixelsPreserved": True, "sourceViewports": 2}


def stitch_frame(metadata_path, output_path, delivery_size=None, delivery_spaces=None):
    if delivery_spaces is not None and delivery_size is None:
        raise ValueError("Delivery spaces require a delivery size")
    selected_spaces = validate_delivery_spaces(delivery_spaces)
    metadata_path = Path(metadata_path).resolve()
    output = require_new_output(output_path, ".png")
    metadata = json.loads(metadata_path.read_text())
    width = integer(metadata.get("width"), "width", 1)
    height = integer(metadata.get("height"), "height", 1)
    if delivery_size is not None:
        integer(delivery_size, "delivery size", 1)
        if width != height or delivery_size > width:
            raise ValueError("Delivery size requires a square frame and must not upscale it")
    columns = integer(metadata.get("columns"), "columns", 1)
    rows = integer(metadata.get("rows"), "rows", 1)
    single_viewport = metadata.get("singleViewportCapture", False)
    landscape_viewport = metadata.get("landscapeViewportCapture", False)
    profile = metadata.get("profile")
    if profile is not None:
        expected = {
            "sideways-1980": (2970, 1980, 2.75, 90, 1, True),
            "upright-2160": (3240, 2160, 3, 0, 2, False),
        }.get(profile)
        if expected is None:
            raise ValueError("Unknown native capture profile")
        size, delivery, scale, rotation, tile_rows, sideways = expected
        if width != size or height != size or delivery_size != delivery or columns != 1 or rows != tile_rows \
                or metadata.get("captureScale") != scale or metadata.get("captureRotationDegrees") != rotation \
                or single_viewport is not sideways or landscape_viewport is not sideways \
                or metadata.get("backgroundRgb") != [0, 0, 0] or metadata.get("shadows") is not False:
            raise ValueError("Native capture profile geometry, tile count, black background, or shadow setting differs")
    if not isinstance(landscape_viewport, bool):
        raise ValueError("Landscape-viewport mode must be explicit boolean metadata")
    if landscape_viewport:
        capture_scale = metadata.get("captureScale")
        if not (single_viewport is True and columns == rows == 1 and width == height
                and delivery_size is not None and delivery_size <= 2160 and width * 2 == delivery_size * 3
                and isinstance(capture_scale, (int, float)) and not isinstance(capture_scale, bool)
                and math.isfinite(capture_scale) and abs(capture_scale - width / 1080) < 1e-10
                and metadata.get("captureRotationDegrees") == 90 and metadata.get("backgroundRgb") == [0, 0, 0]
                and metadata.get("shadows") is False):
            raise ValueError("Landscape-viewport mode requires one black shadowless 90-degree capture at exactly 1.5x sampling for delivery up to 2160")
    elif not isinstance(single_viewport, bool) or single_viewport:
        raise ValueError("Single-viewport capture requires the black sideways profile")
    if not single_viewport and "backgroundReference" in metadata:
        raise ValueError("A background reference requires explicit single-viewport mode")
    if width % columns or height % rows:
        raise ValueError("Frame dimensions must divide into integer grid partitions")
    records = metadata.get("tiles")
    if not isinstance(records, list) or len(records) != rows * columns:
        raise ValueError("Tile count does not match the requested grid")
    x_boundaries = [index * width // columns for index in range(columns + 1)]
    y_boundaries = [index * height // rows for index in range(rows + 1)]
    tiles = {}
    profile_bytes = None
    for record in records:
        row = integer(record.get("row"), "tile row", 0)
        col = integer(record.get("col"), "tile col", 0)
        if row >= rows or col >= columns or (row, col) in tiles:
            raise ValueError("Tile coordinates are out of range or duplicated")
        origin_x = integer(record.get("originX"), "tile originX")
        origin_y = integer(record.get("originY"), "tile originY")
        viewport_width = integer(record.get("viewportWidth"), "tile viewportWidth", 1)
        viewport_height = integer(record.get("viewportHeight"), "tile viewportHeight", 1)
        path = Path(record["path"])
        if not path.is_absolute():
            path = metadata_path.parent / path
        source_bytes = path.read_bytes() if single_viewport else None
        with Image.open(io.BytesIO(source_bytes) if single_viewport else path) as image:
            image.load()
            if image.size != (viewport_width, viewport_height):
                raise ValueError(f"{path}: actual PNG dimensions differ from viewport metadata")
            if image.mode not in ("RGB", "RGBA"):
                raise ValueError(f"{path}: expected RGB or RGBA capture")
            current_profile = image.info.get("icc_profile")
            if not current_profile:
                raise ValueError(f"{path}: native screenshot ICC profile is missing")
            current_icc = profile_metadata(current_profile)
            if profile_bytes is not None and current_profile != profile_bytes:
                raise ValueError(f"{path}: native screenshot ICC profiles differ between tiles")
            expected_icc = record.get("icc") or {}
            if not isinstance(expected_icc, dict):
                raise ValueError("Tile icc metadata must be an object")
            expected_hash = record.get("iccSha256") or expected_icc.get("sha256")
            if expected_hash and expected_hash != current_icc["sha256"]:
                raise ValueError(f"{path}: native screenshot ICC does not match metadata")
            profile_bytes = current_profile
            tiles[(row, col)] = {
                "row": row, "col": col, "originX": origin_x, "originY": origin_y,
                "path": str(path), "image": image.convert("RGBA"),
            }
            if single_viewport:
                tiles[(row, col)]["sourceSha256"] = hashlib.sha256(source_bytes).hexdigest()
    background_padding = None
    if landscape_viewport:
        tile = tiles[(0, 0)]
        result, box, background_padding = landscape_viewport_frame(tile, records[0], metadata, metadata_path, profile_bytes)
        partitions = [{"row": 0, "col": 0, "path": tile["path"], "box": box}]
    else:
        result = Image.new("RGB", (width, height))
        partitions = []
        for (row, col), tile in sorted(tiles.items()):
            box = (x_boundaries[col], y_boundaries[row], x_boundaries[col + 1], y_boundaries[row + 1])
            result.paste(tile_crop(tile, box), (box[0], box[1]))
            partitions.append({"row": row, "col": col, "path": tile["path"], "box": list(box)})
    seams = []
    for row in range(rows):
        for col in range(columns):
            first = tiles[(row, col)]
            neighbors = []
            if row + 1 < rows:
                seam = y_boundaries[row + 1]
                neighbors.append((tiles[(row + 1, col)], "horizontal", (
                    x_boundaries[col], seam - STITCH_BAND // 2,
                    x_boundaries[col + 1], seam + STITCH_BAND // 2,
                )))
            if col + 1 < columns:
                seam = x_boundaries[col + 1]
                neighbors.append((tiles[(row, col + 1)], "vertical", (
                    seam - STITCH_BAND // 2, y_boundaries[row],
                    seam + STITCH_BAND // 2, y_boundaries[row + 1],
                )))
            for second, orientation, band in neighbors:
                overlap = (
                    max(0, first["originX"] + STITCH_GUARD, second["originX"] + STITCH_GUARD),
                    max(0, first["originY"] + STITCH_GUARD, second["originY"] + STITCH_GUARD),
                    min(width, first["originX"] + first["image"].width - STITCH_GUARD, second["originX"] + second["image"].width - STITCH_GUARD),
                    min(height, first["originY"] + first["image"].height - STITCH_GUARD, second["originY"] + second["image"].height - STITCH_GUARD),
                )
                if band[0] < overlap[0] or band[1] < overlap[1] or band[2] > overlap[2] or band[3] > overlap[3]:
                    raise ValueError("Tiles do not provide a complete guarded 128-pixel seam band")
                full_metrics = tile_difference(first, second, overlap)
                seam_metrics = tile_difference(first, second, band)
                peak_metrics = seam_metrics
                native_cut_metrics = None
                if delivery_size is not None:
                    cut_axis = 1 if orientation == "horizontal" else 0
                    cut_scale = Fraction(delivery_size, height if cut_axis else width)
                    cut_radius = math.ceil((DELIVERY_CUT_RADIUS + 3) / cut_scale)
                    cut_position = (band[cut_axis] + band[cut_axis + 2]) // 2
                    cut_box = list(band)
                    cut_box[cut_axis] = max(0, cut_position - cut_radius)
                    cut_box[cut_axis + 2] = min(height if cut_axis else width, cut_position + cut_radius)
                    native_cut_metrics = {
                        **tile_difference(first, second, cut_box), "radiusPixels": cut_radius,
                        "maximumChannelError255": STITCH_MAX_ERROR,
                    }
                    native_cut_metrics["passed"] = native_cut_metrics["maxChannelError255"] <= STITCH_MAX_ERROR
                    peak_metrics = native_cut_metrics
                passed = all(metrics["meanChannelError255"] <= STITCH_MEAN_ERROR for metrics in (full_metrics, seam_metrics)) \
                    and peak_metrics["maxChannelError255"] <= STITCH_MAX_ERROR
                report = {
                    "orientation": orientation, "first": [first["row"], first["col"]],
                    "second": [second["row"], second["col"]], "overlap": full_metrics, "band": seam_metrics, "passed": passed,
                }
                if delivery_size is not None:
                    report["nativeCutInfluence"] = native_cut_metrics
                    report["delivery"] = delivery_difference(first, second, band, width, height, delivery_size, profile_bytes, selected_spaces)
                    passed = passed and report["delivery"]["passed"]
                    report["passed"] = passed
                seams.append(report)
                if not passed:
                    raise ValueError(f"Tile overlap/seam QA failed: {json.dumps(report)}")
    upright_proof = upright_black_proof(result, metadata) if profile == "upright-2160" else None
    save_png(result, output, profile_bytes)
    report = {
        "path": str(output), "metadata": str(metadata_path), "metadataSha256": hashlib.sha256(metadata_path.read_bytes()).hexdigest(),
        "width": width, "height": height, "mode": "RGB",
        "icc": profile_metadata(profile_bytes), "iccPreservedByteForByte": True,
        "columns": columns, "rows": rows, "guardPixels": STITCH_GUARD, "seamBandPixels": STITCH_BAND,
        "maximumChannelError255": STITCH_MAX_ERROR,
        "maximumChannelErrorScope": "native cut influence" if delivery_size is not None else "seam band",
        "maximumMeanChannelError255": STITCH_MEAN_ERROR,
        "deliverySpaces": list(selected_spaces) if delivery_size is not None else None,
        "deliveryThresholds": {
            "size": delivery_size, "maximumChannelError255": DELIVERY_MAX_ERROR,
            "cutMaximumChannelError255": DELIVERY_CUT_MAX_ERROR, "cutInfluenceRadiusPixels": DELIVERY_CUT_RADIUS,
            "maximumMeanChannelError255": DELIVERY_MEAN_ERROR, "maximumChannelErrorP99_9": DELIVERY_P999_ERROR,
            "maximumFractionPixelsOver2": DELIVERY_FRACTION_OVER_2,
            "coherenceRadiusPixels": DELIVERY_COHERENCE_RADIUS,
            "maximum8x8MeanChannelError255": DELIVERY_BLOCK_MEAN_ERROR,
            "maximumAlongSeamMeanChannelError255": DELIVERY_LINE_MEAN_ERROR,
        } if delivery_size is not None else None,
        "partitions": partitions, "seams": seams, "passed": True,
        "processing": "Integer hard partitions; no resizing, registration shifts, blending, or color conversion",
    }
    if landscape_viewport:
        report.update({
            "singleViewportCapture": True, "landscapeViewportCapture": True, "backgroundPadding": background_padding,
            "captureRotationDegrees": 90, "samplingRatio": 1.5,
            "processing": "Native viewport pixels with verified exact-black background padding and lossless 90-degree counterclockwise transpose; no resizing, blending, or color conversion",
        })
    if upright_proof:
        report["uprightCapture"] = upright_proof
    return report


def prepare_frame(input_path, output_path, space, crop=None, input_space=None, size=None):
    if size is not None:
        integer(size, "size", 1)
    output = require_new_output(output_path, ".png")
    target_bytes = PROFILE_PATHS[space].read_bytes()
    with Image.open(input_path) as image:
        image.load()
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


def prepare_sequence(input_directory, output_directory, space, crop=None, input_space=None, size=None):
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
    for index, name in enumerate(names):
        report = prepare_frame(source / name, output / name, space, crop, input_space, size)
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
    command = [
        ffmpeg, "-hide_banner", "-v", "error", "-xerror", "-n",
        "-framerate", str(FPS), "-start_number", "0", "-i", str(directory / "%04d.png"),
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


def main():
    parser = argparse.ArgumentParser(description="Prepare color-managed frames and encode Mi Note comparison videos")
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("input", type=Path)
    stitch = commands.add_parser("stitch")
    stitch.add_argument("--metadata", required=True, type=Path)
    stitch.add_argument("--output", required=True, type=Path)
    stitch.add_argument("--delivery-size", type=int)
    stitch.add_argument("--delivery-spaces", type=parse_delivery_spaces)
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
    encode = commands.add_parser("encode")
    encode.add_argument("--frames", required=True, type=Path)
    encode.add_argument("--output", required=True, type=Path)
    encode.add_argument("--space", required=True, choices=PROFILE_PATHS)
    encode.add_argument("--size", type=int)
    args = parser.parse_args()
    if args.command == "inspect":
        result = inspect_image(args.input)
    elif args.command == "stitch":
        result = stitch_frame(args.metadata, args.output, args.delivery_size, args.delivery_spaces)
    elif args.command == "prepare":
        result = prepare_frame(args.input, args.output, args.space, args.crop, args.input_space, args.size)
    elif args.command == "prepare-sequence":
        result = prepare_sequence(args.input, args.output, args.space, args.crop, args.input_space, args.size)
    else:
        result = encode_frames(args.frames, args.output, args.space, args.size)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, ImageCms.PyCMSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
