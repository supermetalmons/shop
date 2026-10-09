import hashlib
import io
import json
from pathlib import Path
import zlib

import numpy as np
from PIL import Image, ImageCms


SRGB_PROFILE = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


EXPECTED_EFFECT = {
    "opacity": "0.99", "pointerX": "50%", "pointerY": "50%",
    "rotateX": "0deg", "rotateY": "0deg", "shadow": "none",
}


def expected_assets(card_id):
    base = "https://cdn.lil.org/nft/mi_note_cards"
    return {
        "front": f"{base}/fronts/{card_id}.png",
        "foil": f"{base}/foils/{card_id}.webp",
        "mask": f"{base}/masks/{card_id}.webp",
    }


def reconstruct(white, black):
    w = np.asarray(white, dtype=np.int16)
    b = np.asarray(black, dtype=np.int16)
    difference = w - b
    transmission = np.floor((difference.min(axis=2) + difference.max(axis=2)) / 2 + 0.5)
    alpha = np.clip(255 - transmission, 0, 255).astype(np.uint8)
    premultiplied = np.clip((w + b - transmission[:, :, None]) / 2, 0, alpha[:, :, None])
    rgb = np.zeros_like(w, dtype=np.float64)
    np.divide(255 * premultiplied, alpha[:, :, None], out=rgb, where=alpha[:, :, None] > 0)
    rgba = np.dstack([np.clip(np.floor(rgb + 0.5), 0, 255).astype(np.uint8), alpha])
    return Image.fromarray(rgba)


def composite_array(rgba, background):
    pixels = np.asarray(rgba, dtype=np.float64)
    alpha = pixels[:, :, 3:4] / 255
    return np.floor(pixels[:, :, :3] * alpha + np.asarray(background) * (1 - alpha) + 0.5).astype(np.uint8)


def reconstruct_tiled(white, black, tile_height=192):
    result = Image.new("RGBA", white.size)
    accumulators = {matte: {"maxChannelError255": 0, "sumChannelError255": 0, "pixelsOverTolerance": 0} for matte in ("white", "black")}
    alpha_counts = {"transparentPixels": 0, "translucentPixels": 0, "opaquePixels": 0}
    for y in range(0, white.height, tile_height):
        box = (0, y, white.width, min(white.height, y + tile_height))
        white_tile, black_tile = white.crop(box), black.crop(box)
        reconstructed = reconstruct(white_tile, black_tile)
        result.paste(reconstructed, (0, y))
        for matte, source, background in [("white", white_tile, 255), ("black", black_tile, 0)]:
            error = np.abs(composite_array(reconstructed, background).astype(np.int16) - np.asarray(source, dtype=np.int16))
            acc = accumulators[matte]
            acc["maxChannelError255"] = max(acc["maxChannelError255"], int(error.max()))
            acc["sumChannelError255"] += int(error.sum())
            acc["pixelsOverTolerance"] += int(np.any(error > 2, axis=2).sum())
        alpha = np.asarray(reconstructed)[:, :, 3]
        alpha_counts["transparentPixels"] += int((alpha == 0).sum())
        alpha_counts["translucentPixels"] += int(((alpha > 0) & (alpha < 255)).sum())
        alpha_counts["opaquePixels"] += int((alpha == 255).sum())
    for acc in accumulators.values():
        acc["meanChannelError255"] = acc.pop("sumChannelError255") / (white.width * white.height * 3)
    return result, {"recomposition": accumulators, **alpha_counts}


def near_integer(value, label, tolerance=0.075):
    rounded = round(value)
    if abs(value - rounded) > tolerance:
        raise ValueError(f"{label}={value} is not an integer physical pixel; no resampling or automatic shift permitted")
    return rounded


def load_tile(record, raw, width, height, card_id, matte, profile):
    path = Path(record["path"])
    if not path.is_absolute():
        path = raw / path
    with Image.open(path) as source:
        source.load()
        if source.size != (2560, 1716):
            raise ValueError(f"{path.name}: native viewport must be 2560×1716 pixels, got {source.size}")
        current_profile = source.info.get("icc_profile")
        if not current_profile:
            raise ValueError(f"{path.name}: missing native viewport ICC profile")
        if profile is not None and current_profile != profile:
            raise ValueError(f"{path.name}: ICC profile differs between captures")
        image = source.convert("RGBA")
    assets = expected_assets(card_id)
    if record.get("assetUrls") != assets:
        raise ValueError(f"{path.name}: asset URL mismatch")
    actual = record.get("actualAssets", {})
    if actual.get("front") != assets["front"]:
        raise ValueError(f"{path.name}: actual PNG front differs")
    for name in ("mask", "foil"):
        if actual.get(name, "").replace('"', "").replace("'", "") != f"url({assets[name]})":
            raise ValueError(f"{path.name}: actual {name} differs")
    if record["effect"] != EXPECTED_EFFECT:
        raise ValueError(f"{path.name}: effect settings changed")
    if record.get("actualEffect") != {key: EXPECTED_EFFECT[key] for key in ("opacity", "pointerX", "pointerY", "shadow")}:
        raise ValueError(f"{path.name}: actual compositor pose or shadow differs")
    if str(record["id"]) != card_id or record["matte"] != matte or not record["ready"] or record["loading"] or float(record["frontOpacity"]) != 1:
        raise ValueError(f"{path.name}: card or readiness mismatch")
    if not any(item["src"] == assets["front"] and item["complete"] and item["width"] == width and item["height"] == height for item in record["sourceImage"]):
        raise ValueError(f"{path.name}: native-size PNG front was not decoded")
    dpr = record["dpr"]
    rect = record["cardRect"]
    if abs(rect["width"] * dpr - width) > 0.075 or abs(rect["height"] * dpr - height) > 0.075:
        raise ValueError(f"{path.name}: native artwork dimensions differ")
    crop_x = near_integer(rect["x"] * dpr, f"{path.name} cropX")
    origin_y = near_integer(-rect["y"] * dpr, f"{path.name} precise card originY")
    if crop_x < 0 or crop_x + width > image.width:
        raise ValueError(f"{path.name}: full artwork width does not fit viewport")
    viewport = record.get("visualViewport", {})
    if abs(viewport.get("scale", 1) - 1) > 1e-6 or abs(viewport.get("offsetTop", 0)) > 1e-6:
        raise ValueError(f"{path.name}: visual viewport scale/offset must be accounted for explicitly")
    image = image.crop((crop_x, 0, crop_x + width, image.height))
    metadata = {
        "sourceFile": path.name, "pixelSize": list(image.size), "cropX": crop_x, "originY": origin_y,
        "originSource": "-cardRect.y * devicePixelRatio (not rounded window.scrollY)",
        "windowScrollPhysicalY": record["scrollY"] * dpr,
        "visualViewportPagePhysicalY": viewport.get("pageTop", record["scrollY"]) * dpr,
        "devicePixelRatio": dpr,
    }
    return {"image": image, "origin": origin_y, "metadata": metadata, "record": record}, current_profile


def difference_metrics(a, b):
    difference = np.abs(np.asarray(a, dtype=np.int16) - np.asarray(b, dtype=np.int16))
    rgb = difference[:, :, :3]
    return {
        "pixels": a.width * a.height,
        "meanAbsoluteChannelError255": float(rgb.mean()),
        "maxChannelError255": int(rgb.max()),
        "channelErrorP99_9": float(np.percentile(rgb, 99.9)),
        "fractionPixelsOver2": float(np.any(rgb > 2, axis=2).mean()),
        "alphaMaxDifference255": int(difference[:, :, 3].max()),
    }


def overlap_crops(a, b, start, end, shift_y=0, shift_x=0, inset_x=0):
    width = a["image"].width
    left = max(inset_x, -shift_x)
    right = min(width - inset_x, width - shift_x)
    first = a["image"].crop((left, start - a["origin"], right, end - a["origin"]))
    second = b["image"].crop((left + shift_x, start - b["origin"] + shift_y, right + shift_x, end - b["origin"] + shift_y))
    return first, second


def overlap_diagnostic(a, b, height, guard):
    start = max(0, a["origin"], b["origin"])
    end = min(height, a["origin"] + a["image"].height, b["origin"] + b["image"].height)
    if end - start < 2 * guard + 64:
        raise ValueError("Insufficient overlap for guarded compositor stitching")
    safe_start = max(start, a["origin"] + guard, b["origin"] + guard)
    safe_end = min(end, a["origin"] + a["image"].height - guard, b["origin"] + b["image"].height - guard)
    if safe_end - safe_start < 64:
        raise ValueError("Insufficient overlap outside viewport edge guards")
    seam = (safe_start + safe_end) // 2
    band_start, band_end = seam - 32, seam + 32
    full_metrics = difference_metrics(*overlap_crops(a, b, start, end))
    guarded_metrics = difference_metrics(*overlap_crops(a, b, safe_start, safe_end))
    seam_metrics = difference_metrics(*overlap_crops(a, b, band_start, band_end))
    candidates = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            metrics = difference_metrics(*overlap_crops(a, b, safe_start + 1, safe_end - 1, dy, dx, 1))
            candidates.append({"dx": dx, "dy": dy, **metrics})
    candidates.sort(key=lambda item: item["meanAbsoluteChannelError255"])
    best = candidates[0]
    zero = next(item for item in candidates if item["dx"] == 0 and item["dy"] == 0)
    alignment_ok = best["dx"] == 0 and best["dy"] == 0
    passed = alignment_ok and seam_metrics["maxChannelError255"] <= 6 and seam_metrics["meanAbsoluteChannelError255"] <= 0.01 and seam_metrics["channelErrorP99_9"] <= 1 and seam_metrics["alphaMaxDifference255"] == 0
    return {
        "range": [start, end], "edgeGuardPixels": guard, "guardedRange": [safe_start, safe_end],
        "fullOverlap": full_metrics, "guardedOverlap": guarded_metrics,
        "seamY": seam, "seamBand": [band_start, band_end], "seamBandMetrics": seam_metrics,
        "registration": {"best": best, "zero": zero, "candidates": candidates},
        "seamPolicy": "Hard copy at middle of guarded overlap; no blending, averaging, resizing, or registration adjustment",
        "passed": passed,
    }


def stitch(document, raw, width, height, card_id, matte, guard, expected_profile, reports_dir):
    profile = expected_profile
    tiles = []
    for record in document["tiles"]:
        tile, profile = load_tile(record, raw, width, height, card_id, matte, profile)
        tiles.append(tile)
    tiles.sort(key=lambda tile: tile["origin"])
    if not tiles:
        raise ValueError("No viewport tiles")
    if tiles[0]["origin"] > 0 or tiles[-1]["origin"] + tiles[-1]["image"].height < height:
        raise ValueError("Viewport tiles do not cover the full card")
    top_guard = -tiles[0]["origin"]
    bottom_guard = tiles[-1]["origin"] + tiles[-1]["image"].height - height
    report = {"id": int(card_id), "matte": matte, "tiles": [tile["metadata"] for tile in tiles], "topCaptureGutterPixels": top_guard, "bottomCaptureGutterPixels": bottom_guard}
    overlaps = [overlap_diagnostic(a, b, height, guard) for a, b in zip(tiles, tiles[1:])]
    report["overlaps"] = overlaps
    report["passed"] = all(overlap["passed"] for overlap in overlaps)
    reports_dir.mkdir(parents=True, exist_ok=True)
    (reports_dir / f"{card_id}-{matte}-stitch.json").write_text(json.dumps(report, indent=2) + "\n")
    if not report["passed"]:
        raise ValueError(f"#{card_id} {matte}: overlap/alignment QA failed; inspect reports before adjusting anything")
    result = Image.new("RGBA", (width, height))
    boundaries = [0] + [overlap["seamY"] for overlap in overlaps] + [height]
    for tile, start, end in zip(tiles, boundaries, boundaries[1:]):
        result.paste(tile["image"].crop((0, start - tile["origin"], width, end - tile["origin"])), (0, start))
    return result, profile, report


def alpha_statistics(image):
    alpha = np.asarray(image.getchannel("A"))
    height, width = alpha.shape
    center = alpha[height // 4:height * 3 // 4, width // 4:width * 3 // 4]
    values, counts = np.unique(center, return_counts=True)
    corners = [int(alpha[y, x]) for y, x in ((0, 0), (0, width - 1), (height - 1, 0), (height - 1, width - 1))]
    return {
        "alphaBounds": list(image.getchannel("A").getbbox() or ()),
        "centerMinAlpha255": int(center.min()), "centerNonOpaquePixels": int((center < 255).sum()),
        "centerAlphaHistogram": {str(int(value)): int(count) for value, count in zip(values, counts)},
        "cornerAlpha255": corners, "cornersTransparent": all(value == 0 for value in corners),
    }


def finalize(card_id, args):
    documents = {matte: json.loads((args.raw / f"{card_id}-{matte}.json").read_text()) for matte in ("white", "black")}
    width, height = documents["white"]["width"], documents["white"]["height"]
    if (width, height) != (2000, 2800):
        raise ValueError("This capture set requires native 2000×2800 artwork")
    profile = None
    mattes, stitching = {}, {}
    for matte, document in documents.items():
        if str(document["id"]) != card_id or document["matte"] != matte or (document["width"], document["height"]) != (width, height):
            raise ValueError("Matte metadata mismatch")
        mattes[matte], profile, stitching[matte] = stitch(document, args.raw, width, height, card_id, matte, args.edge_guard, profile, args.reports)
    white = mattes["white"].convert("RGB")
    black = mattes["black"].convert("RGB")
    result, metrics = reconstruct_tiled(white, black)
    metrics.update(alpha_statistics(result))
    metrics["geometryPassed"] = metrics["alphaBounds"] == [0, 0, width, height]
    metrics["recompositionTolerance255"] = args.recomposition_tolerance
    metrics["passed"] = metrics["geometryPassed"] and metrics["centerNonOpaquePixels"] == 0 and metrics["cornersTransparent"] and all(value["maxChannelError255"] <= args.recomposition_tolerance for value in metrics["recomposition"].values())
    profile_description = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(profile))).strip()
    report = {
        "id": int(card_id), "file": f"{card_id}.png", "width": width, "height": height,
        "profile": {"description": profile_description, "bytes": len(profile), "sha256": hashlib.sha256(profile).hexdigest(), "crc32": f"{zlib.crc32(profile):08x}", "preservedByteForByte": True},
        "assetUrls": expected_assets(card_id), "effect": EXPECTED_EFFECT,
        "captureMethod": documents["white"]["method"], "stitching": stitching, "qa": metrics,
    }
    (args.reports / f"{card_id}-reconstruction.json").write_text(json.dumps(report, indent=2) + "\n")
    if not metrics["passed"]:
        raise ValueError(f"#{card_id}: matte reconstruction QA failed; see reports/{card_id}-reconstruction.json")
    destination = args.output / f"{card_id}.png"
    result.save(destination, format="PNG", compress_level=9, icc_profile=profile)
    with Image.open(destination) as saved:
        assert saved.info.get("icc_profile") == profile
        assert saved.size == (width, height) and saved.mode == "RGBA"
        saved.verify()
    preview = ImageCms.profileToProfile(result.convert("RGB"), ImageCms.ImageCmsProfile(io.BytesIO(profile)), ImageCms.ImageCmsProfile(io.BytesIO(SRGB_PROFILE)), outputMode="RGB", renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC).convert("RGBA")
    preview.putalpha(result.getchannel("A"))
    print(f"#{card_id}: {width}×{height}, native {profile_description} ICC preserved, matte max error W/B {metrics['recomposition']['white']['maxChannelError255']}/{metrics['recomposition']['black']['maxChannelError255']}, center nonopaque {metrics['centerNonOpaquePixels']}", flush=True)
    return {"id": int(card_id), "image": preview, "caption": "2000 × 2800 px · viewport", "manifest": report}
