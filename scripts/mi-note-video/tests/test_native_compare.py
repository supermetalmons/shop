import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, PngImagePlugin


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location('native_compare', ROOT / 'native-compare.py')
compare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compare)


class NativeComparisonTests(unittest.TestCase):
    def test_identity_has_zero_error_and_finite_json(self):
        pixels = np.arange(120, dtype=np.uint8).reshape(5, 8, 3)
        result = compare.difference_metrics(pixels, pixels.copy())
        self.assertEqual(result['meanAbsoluteChannelError255'], 0)
        self.assertEqual(result['changedPixelFraction'], 0)
        self.assertIsNone(result['peakSignalToNoiseRatioDb'])
        json.dumps(result, allow_nan=False)

    def test_signed_bias_is_candidate_minus_reference(self):
        reference = np.full((4, 4, 3), 100, dtype=np.uint8)
        candidate = reference.copy()
        candidate[:, :, 0] += 3
        candidate[:, :, 2] -= 6
        result = compare.difference_metrics(reference, candidate)
        self.assertEqual(result['meanSignedRGB255'], [3, 0, -6])
        self.assertEqual(result['meanAbsoluteChannelError255'], 3)
        self.assertEqual(result['maxAbsoluteChannelError255'], 6)
        self.assertEqual(result['pixelFractionOverChannelError']['5'], 1)
        self.assertEqual(result['pixelFractionOverChannelError']['10'], 0)

    def test_source_requires_real_profile_and_opaque_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '0000.png'
            image = Image.new('RGB', (3240, 3240))
            image.save(path)
            with self.assertRaisesRegex(ValueError, 'embedded source ICC'):
                compare.image_identity(path)
            image.save(path, icc_profile=compare.P3)
            self.assertEqual(compare.image_identity(path)['icc']['description'], 'Display P3')
            image = image.convert('RGBA')
            image.putpixel((0, 0), (0, 0, 0, 254))
            image.save(path, icc_profile=compare.P3)
            with self.assertRaisesRegex(ValueError, 'not opaque'):
                compare.image_identity(path)

    def test_prepared_comparison_rejects_mismatched_profiles(self):
        reference = Image.new('RGB', (2160, 2160))
        candidate = reference.copy()
        reference.info['icc_profile'] = compare.P3
        candidate.info['icc_profile'] = compare.frames.PROFILE_PATHS['srgb'].read_bytes()
        with self.assertRaisesRegex(ValueError, 'exact standard Display P3'):
            compare.paired_metrics(reference, candidate)

    def test_flat_candidate_preserves_metrics_and_reports_undefined_detail_ratio(self):
        pixels = np.zeros((32, 32, 3), dtype=np.uint8)
        pixels[:, :, 0] = (np.arange(32) % 3 * 127)[None, :]
        reference = Image.fromarray(pixels)
        reference.info['icc_profile'] = compare.P3
        for value in (0, 128):
            with self.subTest(value=value), patch.object(compare, 'INTERIOR', (0, 0, 32, 32)):
                candidate = Image.new('RGB', reference.size, (value, value, value))
                candidate.info['icc_profile'] = compare.P3
                result = compare.paired_metrics(reference, candidate)
                self.assertGreater(result['detail']['reference']['fineToGradientRatio'], 0)
                self.assertEqual(result['detail']['candidateToReference'], {
                    'gradientEnergy': 0, 'fineDetailEnergy': 0, 'fineToGradientRatio': None,
                })
                json.dumps(result, allow_nan=False)

    def test_lab_channels_handle_signed_storage_without_wrapping(self):
        neutral = compare.quantized_lab(Image.new('RGB', (1, 1), (128, 128, 128)))
        self.assertEqual(neutral[0, 0, 1:].tolist(), [0, 0])
        green = compare.quantized_lab(Image.new('RGB', (1, 1), (0, 255, 0)))
        self.assertLess(green[0, 0, 1], -90)
        self.assertGreater(green[0, 0, 2], 90)
        a = Image.new('RGB', (1, 1), (128, 127, 128))
        b = Image.new('RGB', (1, 1), (128, 129, 128))
        self.assertLess(compare.perceptual_metrics(a, b)['maxDeltaE76'], 5)

    def test_explicit_png_srgb_is_reported_without_inventing_embedded_icc(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '0000.png'
            metadata = PngImagePlugin.PngInfo()
            metadata.add(b'sRGB', b'\x00')
            Image.new('RGB', (3240, 3240)).save(path, pnginfo=metadata)
            result = compare.image_identity(path)
            self.assertEqual(result['inputSpace'], 'srgb')
            self.assertIsNone(result['embeddedIcc'])
            self.assertEqual(result['pngSrgbIntent'], 0)

    def test_existing_comparison_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'already exists'):
                compare.compare_directories('/unused', '/unused', directory)


if __name__ == '__main__':
    unittest.main()
