import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

stubs = {name: types.ModuleType(name) for name in ['bpy', 'mathutils', 'geometry', 'material']}
stubs['mathutils'].Matrix = stubs['mathutils'].Vector = object
stubs['geometry'].create_canvas = stubs['material'].create_material = lambda *args: None
spec = importlib.util.spec_from_file_location('canvas_render_lifecycle', Path(__file__).with_name('render.py'))
renderer = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, stubs), patch.object(sys, 'path', sys.path.copy()):
    spec.loader.exec_module(renderer)


class RenderLifecycleTests(unittest.TestCase):
    image_format = 'png'

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='canvas-lifecycle-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output, self.work = self.root / 'output', self.root / 'work'
        self.output.mkdir()
        self.work.mkdir()
        self.source, self.cancel = self.root / 'source.png', self.root / 'cancel'
        self.source.write_bytes(b'original source')
        self.sample = {'id': 'first', 'path': str(self.source), 'width': 1200, 'height': 1295}
        self.normalized = []
        self.export = {'format': self.image_format, 'transparent': self.image_format == 'webp',
                       'quality': 85 if self.image_format == 'webp' else None, 'max_side': None}
        self.scene = types.SimpleNamespace(render=types.SimpleNamespace(
            filepath='', resolution_x=1200, resolution_y=1295, resolution_percentage=100))
        self.render = Mock(return_value={'FINISHED'})
        self.save = Mock(side_effect=lambda path, **kwargs: Path(path).write_bytes(b'finished image'))
        patches = [
            patch.object(renderer, 'normalize_artwork', side_effect=self.normalize),
            patch.object(renderer, 'prepare_scene', return_value=self.scene),
            patch.object(renderer.bpy, 'ops', types.SimpleNamespace(render=types.SimpleNamespace(render=self.render)), create=True),
            patch.object(renderer.bpy, 'data', types.SimpleNamespace(images={
                'Render Result': types.SimpleNamespace(save_render=self.save)}), create=True),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def normalize(self, source, destination, executable):
        self.assertFalse(any(path.exists() for path in self.normalized))
        self.assertEqual(Path(source).read_bytes(), b'original source')
        destination.write_bytes(b'normalized source')
        self.normalized.append(destination)
        return destination, {'normalized': True}

    def run_sample(self, identifier='first'):
        return renderer.render_sample(dict(self.sample, id=identifier), {}, None,
                                      self.output, self.work, self.cancel, self.export)

    def assert_clean(self):
        self.assertEqual(list(self.work.iterdir()), [])
        self.assertFalse(any(path.exists() for path in self.normalized))
        self.assertEqual(self.source.read_bytes(), b'original source')

    def test_success_publishes_output_and_cleans_each_image(self):
        for identifier in ['first', 'second', 'third']:
            record = self.run_sample(identifier)
            self.assertEqual(record['id'], identifier)
            self.assertEqual(record['output'], str(self.output / f'{identifier}.{self.image_format}'))
            self.assertEqual(Path(record['output']).read_bytes(), b'finished image')
            self.assertEqual(Path(self.save.call_args.args[0]).suffix, f'.{self.image_format}')
            self.assertEqual(record['export'], self.export)
            self.assertTrue(record['normalization']['normalized'])
            self.assert_clean()

    def test_cancellation_before_start_does_no_work(self):
        self.cancel.touch()
        with self.assertRaises(renderer.RenderCancelled):
            self.run_sample()
        self.assertEqual(self.normalized, [])
        self.render.assert_not_called()
        self.save.assert_not_called()
        self.assertEqual(list(self.output.iterdir()), [])
        self.assert_clean()

    def test_cancellation_during_render_preserves_existing_output(self):
        target = self.output / f'first.{self.image_format}'
        target.write_bytes(b'previous complete render')
        self.render.side_effect = lambda: (self.cancel.touch(), {'FINISHED'})[1]
        with self.assertRaises(renderer.RenderCancelled):
            self.run_sample()
        self.save.assert_not_called()
        self.assertEqual(target.read_bytes(), b'previous complete render')
        self.assert_clean()

    def test_cancelled_blender_result_is_not_published(self):
        self.render.return_value = {'CANCELLED'}
        with self.assertRaises(renderer.RenderCancelled):
            self.run_sample()
        self.save.assert_not_called()
        self.assertEqual(list(self.output.iterdir()), [])
        self.assert_clean()

    def test_cancellation_during_save_does_not_publish_staging_file(self):
        target = self.output / f'first.{self.image_format}'
        target.write_bytes(b'previous complete render')

        def save_then_cancel(path, **kwargs):
            self.assertNotEqual(Path(path), target)
            Path(path).write_bytes(b'interrupted image')
            self.cancel.touch()

        self.save.side_effect = save_then_cancel
        with self.assertRaises(renderer.RenderCancelled):
            self.run_sample()
        self.assertEqual(target.read_bytes(), b'previous complete render')
        self.assertEqual(list(self.output.iterdir()), [target])
        self.assert_clean()

    def test_failed_save_cleans_normalized_and_staged_files(self):
        def fail_save(path, **kwargs):
            Path(path).write_bytes(b'partial image')
            raise OSError('save failed')

        self.save.side_effect = fail_save
        with self.assertRaisesRegex(OSError, 'save failed'):
            self.run_sample()
        self.assertEqual(list(self.output.iterdir()), [])
        self.assert_clean()


class WebPRenderLifecycleTests(RenderLifecycleTests):
    image_format = 'webp'

    def test_report_separates_source_and_rendered_dimensions(self):
        self.export['max_side'] = 1400
        self.sample.update(width=1864, height=2012)
        self.scene.render.resolution_x = 1297
        self.scene.render.resolution_y = 1400
        record = self.run_sample()
        self.assertEqual((record['source_width'], record['source_height']), (1864, 2012))
        self.assertEqual((record['width'], record['height']), (1297, 1400))
        self.assertEqual(record['export']['quality'], 85)


class ExportOptionTests(unittest.TestCase):
    def parse(self, *options):
        return renderer.arguments(['--manifest', 'samples.json', '--output', 'output', *options])

    def test_defaults_and_webp_quality(self):
        defaults = self.parse()
        self.assertEqual(defaults.format, 'webp')
        self.assertTrue(defaults.transparent)
        self.assertEqual(defaults.quality, 85)
        self.assertEqual(defaults.max_side, 1400)
        self.assertEqual(self.parse('--format', 'webp').quality, 85)
        for quality in [0, 85, 100]:
            self.assertEqual(self.parse('--quality', str(quality)).quality, quality)

    def test_png_and_verification_keep_original_high_resolution_settings(self):
        for settings in [self.parse('--format', 'png'), renderer.arguments(['--verify', '--output', 'output'])]:
            with self.subTest(verify=settings.verify):
                self.assertEqual(settings.format, 'png')
                self.assertFalse(settings.transparent)
                self.assertIsNone(settings.quality)
                self.assertIsNone(settings.max_side)

    def test_explicit_export_overrides(self):
        png = self.parse('--format', 'png', '--transparent', '--max-side', '1000')
        self.assertTrue(png.transparent)
        self.assertEqual(png.max_side, 1000)
        webp = self.parse('--max-side', '2000', '--quality', '0')
        self.assertEqual(webp.max_side, 2000)
        self.assertEqual(webp.quality, 0)

    def test_invalid_options(self):
        cases = [['--format', 'jpg'], ['--format', 'png', '--quality', '85'], ['--format', 'webp', '--quality', '101'],
                 ['--format', 'webp', '--quality', '-1'], ['--format', 'webp', '--quality', '1.5'],
                 ['--max-side', '0'], ['--max-side', '-1'], ['--max-side', '1.5'],
                 ['--max-side', '9007199254740992']]
        for options in cases:
            with self.subTest(options=options), patch('sys.stderr', new_callable=io.StringIO), self.assertRaises(SystemExit):
                self.parse(*options)

    def test_verification_rejects_each_export_option(self):
        for options in [['--format', 'png'], ['--transparent'], ['--quality', '85'], ['--max-side', '1400']]:
            with self.subTest(options=options), patch('sys.stderr', new_callable=io.StringIO), self.assertRaises(SystemExit):
                renderer.arguments(['--verify', '--output', 'output', *options])

    def test_dimensions_preserve_aspect_ratio_and_never_upscale(self):
        cases = [(1864, 2012, 1400, (1297, 1400)), (2012, 1864, 1400, (1400, 1297)),
                 (2000, 2000, 1400, (1400, 1400)), (932, 1006, 1400, (932, 1006)),
                 (1864, 2012, None, (1864, 2012)), (1400, 1297, 1400, (1400, 1297)),
                 (10, 5, 5, (5, 3)), (4000, 1, 1400, (1400, 1)), (1864, 2012, 1, (1, 1))]
        for width, height, cap, expected in cases:
            with self.subTest(width=width, height=height, cap=cap):
                self.assertEqual(renderer.output_dimensions(width, height, cap), expected)


if __name__ == '__main__':
    unittest.main()
