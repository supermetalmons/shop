import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw


spec = importlib.util.spec_from_file_location('native_frames', Path(__file__).resolve().parents[1] / 'frames.py')
frames = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frames)


def fixture(directory):
    directory = Path(directory)
    profile = frames.PROFILE_PATHS['p3'].read_bytes()
    scene = Image.new('RGB', (3240, 3240), 'black')
    draw = ImageDraw.Draw(scene)
    draw.rectangle((700, 400, 2499, 2839), fill=(145, 180, 210))
    for y in range(405, 2835, 47):
        draw.line((705, y, 2490, y), fill=(20, 40, 80), width=2)
    canvas = Image.new('RGBA', (3328, 3306), (0, 0, 0, 255))
    canvas.paste(scene, (32, 32))
    tiles = []
    for row, scroll in enumerate([0, 1470]):
        path = directory / f'tile-{row}.png'
        canvas.crop((0, scroll, 3328, scroll + 1836)).save(path, icc_profile=profile)
        tiles.append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'row': row, 'col': 0,
                      'originX': -32, 'originY': scroll - 32, 'viewportWidth': 3328, 'viewportHeight': 1836,
                      'snapshot': {'dpr': 2, 'rotationDegrees': 0, 'background': '#000000', 'shadowEnabled': False,
                                   'effect': {'shadow': 'none'}, 'scrollX': 0, 'scrollY': scroll / 2,
                                   'stageDocumentPixels': {'x': 32, 'y': 32, 'width': 3240, 'height': 3240},
                                   'rotatorRect': {'x': 366, 'y': (432 - scroll) / 2, 'width': 900, 'height': 1220}}})
    metadata = {'profile': 'upright-2160', 'width': 3240, 'height': 3240, 'captureScale': 3, 'captureRotationDegrees': 0,
                'backgroundRgb': [0, 0, 0], 'shadows': False, 'columns': 1, 'rows': 2, 'tiles': tiles}
    path = directory / 'tiles.json'
    path.write_text(json.dumps(metadata))
    return path, metadata, scene, profile


class UprightProfileTests(unittest.TestCase):
    def test_two_native_black_tiles_preserve_all_pixels_and_icc(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata, _, scene, profile = fixture(directory)
            output = Path(directory) / 'native.png'
            report = frames.stitch_frame(metadata, output, 2160, ['p3'])
            with Image.open(output) as actual:
                self.assertEqual(actual.tobytes(), scene.tobytes())
                self.assertEqual(actual.info['icc_profile'], profile)
            self.assertEqual(report['rows'], 2)
            self.assertTrue(report['uprightCapture']['capturedExteriorExactBlack'])
            self.assertTrue(report['uprightCapture']['nativePixelsPreserved'])
            self.assertEqual(report['metadataSha256'], hashlib.sha256(metadata.read_bytes()).hexdigest())
            self.assertTrue(all(seam['passed'] and seam['delivery']['passed'] for seam in report['seams']))

    def test_upright_profile_rejects_white_shadow_rotation_or_missing_tiles(self):
        with tempfile.TemporaryDirectory() as directory:
            path, metadata, _, _ = fixture(directory)
            for index, patch in enumerate([{'backgroundRgb': [255, 255, 255]}, {'shadows': True}, {'captureRotationDegrees': 90}, {'rows': 1}]):
                path.write_text(json.dumps({**metadata, **patch}))
                with self.subTest(patch=patch), self.assertRaisesRegex(ValueError, 'profile geometry'):
                    frames.stitch_frame(path, Path(directory) / f'rejected-{index}.png', 2160, ['p3'])

    def test_upright_black_proof_rejects_a_changed_exterior_pixel(self):
        with tempfile.TemporaryDirectory() as directory:
            _, metadata, scene, _ = fixture(directory)
            scene.putpixel((5, 5), (1, 0, 0))
            with self.assertRaisesRegex(ValueError, 'exactly RGB black'):
                frames.upright_black_proof(scene, metadata)

    def test_upright_black_proof_rejects_subpixel_scroll_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            _, metadata, scene, _ = fixture(directory)
            metadata['tiles'][1]['snapshot']['scrollY'] += .5
            with self.assertRaisesRegex(ValueError, 'raster phase'):
                frames.upright_black_proof(scene, metadata)


if __name__ == '__main__':
    unittest.main()
