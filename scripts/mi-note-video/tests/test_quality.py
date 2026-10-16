import importlib.util
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageCms, ImageDraw, ImageFilter


spec = importlib.util.spec_from_file_location('quality_tilt', Path(__file__).resolve().parents[1] / 'quality.py')
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)


def moving_card_sequence():
    size = 256
    y, x = np.indices((180, 128))
    texture = 100 + 30 * np.sin(x / 2.2) + 22 * np.cos(y / 3.1) + 10 * np.sin((x + y) / 1.8)
    colors = np.stack([texture, texture * .8 + 15, texture * .6 + 30], axis=2).astype(np.uint8)
    base = Image.new('RGB', (size, size), 'white')
    base.paste(Image.fromarray(colors), (64, 38))
    draw = ImageDraw.Draw(base)
    draw.rectangle((65, 39, 190, 216), outline=(25, 25, 25), width=2)
    draw.text((80, 150), 'CARD NFT 2', fill=(250, 250, 250))
    for index in range(quality.FRAME_COUNT):
        angle = 2 * math.pi * index / quality.FRAME_COUNT
        shear = .06 * math.sin(angle)
        scale = .98 + .02 * math.cos(angle)
        shift = 3 * math.cos(angle)
        yield base.transform(base.size, Image.Transform.AFFINE,
                             (1 / scale, shear, 128 * (1 - 1 / scale) - 128 * shear + shift,
                              -.03 * math.cos(angle), 1, 128 * .03 * math.cos(angle)),
                             Image.Resampling.BICUBIC, fillcolor='white')


def measured_rows(images):
    rows, colors = [], []
    for image in images:
        row, color = quality.frame_metrics(image, (24, 12, 232, 244))
        rows.append(row)
        colors.append(color)
    for index, row in enumerate(rows):
        row['previousRGBMAE'] = float(np.abs(colors[index] - colors[index - 1]).mean())
    return rows


class TiltTemporalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.images = list(moving_card_sequence())

    def test_smooth_geometric_motion_passes_without_stationary_mask(self):
        self.assertEqual(quality.temporal_issues(measured_rows(self.images)), [])

    def test_isolated_and_persistent_blur_are_detected(self):
        for indices in ([75], range(75, 185)):
            with self.subTest(indices=str(indices)):
                images = self.images.copy()
                for index in indices:
                    images[index] = images[index].filter(ImageFilter.GaussianBlur(1.5))
                issues = quality.temporal_issues(measured_rows(images))
                self.assertTrue(any(issue['type'] == 'detail-continuity' and issue['frame'] == 75 for issue in issues))

    def test_color_flash_is_detected(self):
        images = self.images.copy()
        pixels = np.asarray(images[75]).astype(np.int16)
        pixels[40:216, 65:190] = np.minimum(pixels[40:216, 65:190] + 50, 255)
        images[75] = Image.fromarray(pixels.astype(np.uint8))
        issues = quality.temporal_issues(measured_rows(images))
        self.assertTrue(any(issue['type'] == 'color-continuity' and issue['frame'] == 75 for issue in issues))


class TiltPixelControlsTests(unittest.TestCase):
    def fixture(self, directory):
        path = Path(directory)
        frames = path / 'native'
        frames.mkdir()
        profile = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
        image = Image.new('RGB', (64, 64), 'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((16, 12, 47, 51), fill=(45, 80, 120))
        for index in range(4):
            image.save(frames / f'{index:04d}.png', icc_profile=profile)
        before, after = path / 'before.png', path / 'after.png'
        image.save(before, icc_profile=profile)
        image.save(after, icc_profile=profile)
        return frames, before, after, path / 'report.json', [8, 8, 56, 56], 2, 64

    def test_exact_controls_profiles_and_frame_hashes(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(quality, 'FRAME_COUNT', 4):
            report = quality.audit_sequence(*self.fixture(directory))
            self.assertTrue(report['passed'])
            self.assertTrue(report['restRepeatExact'])
            self.assertEqual(report['frameCount'], 4)
            self.assertEqual(len(report['frames'][0]['sha256']), 64)
            self.assertEqual(len(report['nativeIccSha256']), 64)

    def test_static_exterior_first_frame_and_repeat_are_exact(self):
        for target in ('exterior', 'first', 'repeat'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory, patch.object(quality, 'FRAME_COUNT', 4):
                args = self.fixture(directory)
                destination = args[0] / ('0001.png' if target == 'exterior' else '0000.png') if target != 'repeat' else args[2]
                with Image.open(destination) as source:
                    image = source.copy()
                image.putpixel((1, 1) if target == 'exterior' else (30, 30), (1, 2, 3))
                image.save(destination, icc_profile=image.info['icc_profile'])
                report = quality.audit_sequence(*args)
                self.assertFalse(report['passed'])
                self.assertTrue(any(issue['type'] == ('rest-repeat' if target == 'repeat' else 'static-or-rest-pixels')
                                    for issue in report['issues']))

    def test_missing_frame_geometry_and_profile_are_rejected(self):
        for target in ('missing', 'geometry', 'profile'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory, patch.object(quality, 'FRAME_COUNT', 4):
                args = self.fixture(directory)
                destination = args[0] / '0001.png'
                if target == 'missing':
                    destination.unlink()
                else:
                    with Image.open(destination) as source:
                        image = source.copy()
                    if target == 'geometry':
                        image = image.resize((63, 63))
                        image.save(destination, icc_profile=image.info['icc_profile'])
                    else:
                        image.info.pop('icc_profile')
                        image.save(destination)
                with self.assertRaises(ValueError):
                    quality.audit_sequence(*args)


if __name__ == '__main__':
    unittest.main()
