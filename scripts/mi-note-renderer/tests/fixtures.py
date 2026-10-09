import hashlib
import json
from pathlib import Path
import shutil
import sys

import numpy as np
from PIL import Image


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import image_core


WIDTH = 2000
HEIGHT = 2800
DPR = 2.5
ORIGINS = (-64, 1156)


def synthetic_artwork(card_id, transparent_corners=True):
    x = np.arange(WIDTH, dtype=np.uint32)[None, :]
    y = np.arange(HEIGHT, dtype=np.uint32)[:, None]
    pixels = np.empty((HEIGHT, WIDTH, 4), dtype=np.uint8)
    for channel, (x_step, y_step) in enumerate(((5, 11), (7, 13), (17, 19))):
        pixels[:, :, channel] = ((x * x_step + y * y_step + card_id * (channel + 1)) % 86) * 3
    pixels[:, :, 3] = 255
    if transparent_corners:
        radius = 32
        rows, columns = np.indices((radius, radius))
        distance = np.sqrt((radius - 1 - rows) ** 2 + (radius - 1 - columns) ** 2)
        alpha = np.select((distance >= 32, distance >= 31, distance >= 30), (0, 85, 170), default=255).astype(np.uint8)
        pixels[:radius, :radius, 3] = alpha
        pixels[:radius, -radius:, 3] = alpha[:, ::-1]
        pixels[-radius:, :radius, 3] = alpha[::-1, :]
        pixels[-radius:, -radius:, 3] = alpha[::-1, ::-1]
        pixels[pixels[:, :, 3] == 0, :3] = 0
    return Image.fromarray(pixels)


def create_capture_fixture(directory, card_id=460, transparent_corners=True):
    directory = Path(directory).resolve()
    raw = directory / "raw"
    raw.mkdir(parents=True)
    profile = image_core.SRGB_PROFILE
    assets = image_core.expected_assets(card_id)
    artwork = synthetic_artwork(card_id, transparent_corners)
    expected = directory / "expected.png"
    artwork.save(expected, format="PNG", compress_level=9, icc_profile=profile)
    pixels = np.asarray(artwork).astype(np.uint32)
    alpha = pixels[:, :, 3:4]
    for matte, background in (("white", 255), ("black", 0)):
        composite = ((pixels[:, :, :3] * alpha + background * (255 - alpha) + 127) // 255).astype(np.uint8)
        matte_image = Image.fromarray(composite)
        tiles = []
        for index, origin in enumerate(ORIGINS):
            path = raw / f"{card_id}-{matte}-{index}.png"
            image = Image.new("RGBA", (2560, 1716), (background, background, background, 255))
            image.paste(matte_image, (64, -origin))
            image.save(path, format="PNG", compress_level=6, icc_profile=profile)
            image.close()
            rect = {"x": 64 / DPR, "y": -origin / DPR, "width": WIDTH / DPR, "height": HEIGHT / DPR}
            scroll = 0 if index == 0 else 488
            tiles.append({
                "path": str(path), "id": card_id, "matte": matte, "ready": True,
                "loading": False, "frontOpacity": "1", "dpr": DPR, "zoom": WIDTH / (360 * DPR),
                "innerWidth": 1024, "innerHeight": 686, "scrollX": 0, "scrollY": scroll,
                "cardRect": rect, "frameRect": rect,
                "visualViewport": {"width": 1024, "height": 686.4, "scale": 1, "pageTop": scroll, "offsetTop": 0},
                "assetUrls": assets, "actualAssets": {"front": assets["front"], "foil": f"url({assets['foil']})", "mask": f"url({assets['mask']})"},
                "sourceImage": [{"src": assets["front"], "complete": True, "width": WIDTH, "height": HEIGHT}],
                "effect": image_core.EXPECTED_EFFECT.copy(),
                "actualEffect": {key: image_core.EXPECTED_EFFECT[key] for key in ("opacity", "pointerX", "pointerY", "shadow")},
            })
        matte_image.close()
        document = {"id": card_id, "matte": matte, "width": WIDTH, "height": HEIGHT, "browserGutterPixels": 64, "method": "Synthetic native viewport fixture", "tiles": tiles}
        (raw / f"{card_id}-{matte}.json").write_text(json.dumps(document))
    artwork.close()
    return {"id": card_id, "directory": directory, "raw": raw, "expected": expected, "profile": profile, "icc_sha256": hashlib.sha256(profile).hexdigest()}


def copy_capture_fixture(fixture, directory):
    directory = Path(directory).resolve()
    shutil.copytree(fixture["directory"], directory)
    raw = directory / "raw"
    for matte in ("white", "black"):
        path = raw / f"{fixture['id']}-{matte}.json"
        document = json.loads(path.read_text())
        for tile in document["tiles"]:
            tile["path"] = str(raw / Path(tile["path"]).name)
        path.write_text(json.dumps(document))
    return {**fixture, "directory": directory, "raw": raw, "expected": directory / "expected.png"}
