import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render
from studio import setup_scene


def write_egg(path, channel):
    side = 64
    y, x = np.ogrid[-1:1:complex(side), -1:1:complex(side)]
    rgba = np.zeros((side, side, 4), dtype=np.float32)
    rgba[:, :, channel] = 1.0
    rgba[:, :, 3] = (x / 0.55) ** 2 + (y / 0.65) ** 2 < 1
    image = bpy.data.images.new(path.stem, width=side, height=side, alpha=True)
    image.pixels.foreach_set(rgba.ravel())
    image.filepath_raw = str(path)
    image.file_format = 'WEBP'
    image.save()
    bpy.data.images.remove(image)


def small_scene():
    scene = setup_scene()
    scene.render.resolution_x = scene.render.resolution_y = 80
    scene.cycles.samples = 4
    return scene


def check_color(path, channel):
    image = bpy.data.images.load(str(path), check_existing=False)
    width, height = image.size
    pixels = np.empty((height, width, 4), dtype=np.float32)
    image.pixels.foreach_get(pixels.ravel())
    bpy.data.images.remove(image)
    center = pixels[height // 2 - 4:height // 2 + 4, width // 2 - 4:width // 2 + 4, :3]
    rgb = center.mean(axis=(0, 1))
    if rgb[channel] < np.delete(rgb, channel).max() + 0.35:
        raise AssertionError(f'{path.parent.name}/{path.name}: expected dominant channel {channel}, got {rgb}')


with tempfile.TemporaryDirectory(prefix='egg-batch-test-') as temp:
    root = Path(temp)
    cases = {'1': 0, '29': 2}
    for egg_id, channel in cases.items():
        write_egg(root / f'{egg_id}.webp', channel)
    with patch.object(render, 'setup_scene', small_scene):
        render.main(root, root, list(cases))
    for finish in render.FINISHES:
        for egg_id, channel in cases.items():
            check_color(root / finish / f'{egg_id}.png', channel)
    print('Batch source colors verified across all four finishes.')

    interrupted = root / 'interrupted'
    interrupted.mkdir()
    cancel_file = root / 'cancel'

    def cancel_after_frame(*_):
        cancel_file.touch()

    bpy.app.handlers.render_write.append(cancel_after_frame)
    try:
        with patch.object(render, 'setup_scene', small_scene):
            render.main(root, interrupted, list(cases), cancel_file)
    except RuntimeError as error:
        if str(error) != 'Egg rendering cancelled.':
            raise
    else:
        raise AssertionError('The batch ignored the cancellation marker')
    finally:
        bpy.app.handlers.render_write.remove(cancel_after_frame)
    assert len(list(interrupted.glob('*/*.png'))) == 1
