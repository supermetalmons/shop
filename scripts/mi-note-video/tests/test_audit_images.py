import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


AVAILABLE = importlib.util.find_spec('numpy') is not None and importlib.util.find_spec('PIL') is not None
if AVAILABLE:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import numpy as np
    from PIL import Image, ImageCms, ImageFilter
    spec = importlib.util.spec_from_file_location('native_unit_audit', Path(__file__).resolve().parents[1] / 'audit.py')
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)


@unittest.skipUnless(AVAILABLE, 'Pinned NumPy/Pillow runtime is required for native image tests')
class NativeAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()

    def tearDown(self):
        self.temporary.cleanup()

    def fixture(self, sideways):
        profile = {'nativeSize': 64, 'tiles': 1 if sideways else 2, 'rotationDegrees': 90 if sideways else 0}
        y, x = np.indices((64, 64))
        pixels = np.stack([(x * 3 + y) % 251, (x + y * 3) % 241, (x * 2 + y * 2) % 239], axis=2).astype(np.uint8)
        capture = np.rot90(pixels, k=-1) if sideways else pixels
        icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
        native_path = self.root / 'native.png'
        Image.fromarray(pixels).save(native_path, icc_profile=icc)
        tiles, sources, partitions = [], [], []
        for row in range(profile['tiles']):
            origin_y = -32 if row == 0 else 0
            box = [0, 0, 64, 64] if sideways else [0, row * 32, 64, (row + 1) * 32]
            viewport = Image.new('RGBA', (128, 128), (0, 0, 0, 255))
            viewport.paste(Image.fromarray(capture), (32, -origin_y))
            source_path = self.root / f'viewport-{row}.png'
            viewport.save(source_path, icc_profile=icc)
            original = str(self.root / f'original-{row}.png')
            source = {'path': str(source_path), 'originalPath': original, 'sha256': audit.sha(source_path), 'row': row, 'col': 0}
            sources.append(source)
            tiles.append({'path': original, 'sha256': source['sha256'], 'row': row, 'col': 0,
                          'originX': -32, 'originY': origin_y, 'viewportWidth': 128, 'viewportHeight': 128})
            partitions.append({'path': original, 'row': row, 'col': 0, 'box': box})
        metadata_path, report_path = self.root / 'metadata.json', self.root / 'stitch.json'
        metadata = {'tiles': tiles}
        metadata_path.write_text(json.dumps(metadata))
        report = {'partitions': partitions}
        if sideways:
            report['backgroundPadding'] = {'sourceCropBox': [32, 32, 96, 96], 'sourceCropRgbSha256': hashlib.sha256(capture.tobytes()).hexdigest(),
                'nativePixelsPreserved': True, 'referenceIccMatches': True, 'blackBordersExact': True, 'capturedExteriorExactBlack': True,
                'losslessUnrotation': True, 'inverseRotation': {'losslessIntegerPermutation': True, 'resampling': False, 'restoredRgbSha256': hashlib.sha256(pixels.tobytes()).hexdigest()}}
        report_path.write_text(json.dumps(report))
        retained = {'frame': 0, 'path': str(native_path)}
        retained['viewportSource' if sideways else 'viewportSources'] = sources[0] if sideways else sources
        manifest = {'nativeFrames': {'1:0': {'sha256': audit.sha(native_path), 'stitchReport': str(report_path), 'tileMetadata': str(metadata_path)}},
                    'compacted': {'1': {'retained': [retained]}}}
        return manifest, profile, hashlib.sha256(icc).hexdigest(), pixels, metadata, metadata_path, sources

    def test_sideways_source_pixels_reconstruct_exactly_after_quarter_turn(self):
        manifest, profile, icc, pixels, *_ = self.fixture(True)
        image, _ = audit.reconstruct(manifest, 1, 0, profile, icc)
        self.assertTrue(np.array_equal(np.asarray(image), pixels))

    def test_two_upright_source_viewports_reconstruct_exactly(self):
        manifest, profile, icc, pixels, *_ = self.fixture(False)
        image, _ = audit.reconstruct(manifest, 1, 0, profile, icc)
        self.assertTrue(np.array_equal(np.asarray(image), pixels))

    def test_reconstruction_rejects_changed_pixels_even_with_updated_source_hashes(self):
        manifest, profile, icc, pixels, metadata, metadata_path, sources = self.fixture(False)
        source = sources[0]
        with Image.open(source['path']) as original:
            image = original.copy()
            image.putpixel((40, 40), (255, 255, 255, 255))
            image.save(source['path'], icc_profile=original.info['icc_profile'])
        source['sha256'] = metadata['tiles'][0]['sha256'] = audit.sha(source['path'])
        metadata_path.write_text(json.dumps(metadata))
        with self.assertRaisesRegex(RuntimeError, 'differs from its original viewport pixels'):
            audit.reconstruct(manifest, 1, 0, profile, icc)

    def test_fidelity_rejects_color_bias_blur_and_nonblack_borders(self):
        y, x = np.indices((128, 128))
        pattern = (110 + 65 * np.sin(x * 1.7) + 50 * np.cos(y * 1.3)).clip(0, 255).astype(np.uint8)
        image = np.zeros((128, 128, 3), np.uint8)
        image[20:108, 30:98] = np.repeat(pattern[:, :, None], 3, axis=2)[20:108, 30:98]
        reference = image.astype(np.float32)
        self.assertEqual(audit.fidelity(reference, reference, reference @ audit.LUMA)[1], [])
        biased = reference.copy()
        biased[20:108, 30:98] += 8
        self.assertIn('color-error', audit.fidelity(reference, biased, biased @ audit.LUMA)[1])
        blurred = np.asarray(Image.fromarray(image).filter(ImageFilter.GaussianBlur(2)), dtype=np.float32)
        self.assertIn('detail-loss', audit.fidelity(reference, blurred, blurred @ audit.LUMA)[1])
        border = reference.copy()
        border[:2] = border[-2:] = border[:, :2] = border[:, -2:] = 2
        self.assertIn('border-luminance', audit.fidelity(reference, border, border @ audit.LUMA)[1])


if __name__ == '__main__':
    unittest.main()
