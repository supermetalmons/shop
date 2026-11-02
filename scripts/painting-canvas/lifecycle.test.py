import importlib.util
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
        self.scene = types.SimpleNamespace(render=types.SimpleNamespace(filepath=''))
        self.render = Mock(return_value={'FINISHED'})
        self.save = Mock(side_effect=lambda path, **kwargs: Path(path).write_bytes(b'finished PNG'))
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
                                      self.output, self.work, self.cancel)

    def assert_clean(self):
        self.assertEqual(list(self.work.iterdir()), [])
        self.assertFalse(any(path.exists() for path in self.normalized))
        self.assertEqual(self.source.read_bytes(), b'original source')

    def test_success_publishes_output_and_cleans_each_image(self):
        for identifier in ['first', 'second', 'third']:
            record = self.run_sample(identifier)
            self.assertEqual(record['id'], identifier)
            self.assertEqual(record['output'], str(self.output / f'{identifier}.png'))
            self.assertEqual(Path(record['output']).read_bytes(), b'finished PNG')
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
        target = self.output / 'first.png'
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
        target = self.output / 'first.png'
        target.write_bytes(b'previous complete render')

        def save_then_cancel(path, **kwargs):
            self.assertNotEqual(Path(path), target)
            Path(path).write_bytes(b'interrupted PNG')
            self.cancel.touch()

        self.save.side_effect = save_then_cancel
        with self.assertRaises(renderer.RenderCancelled):
            self.run_sample()
        self.assertEqual(target.read_bytes(), b'previous complete render')
        self.assertEqual(list(self.output.iterdir()), [target])
        self.assert_clean()

    def test_failed_save_cleans_normalized_and_staged_files(self):
        def fail_save(path, **kwargs):
            Path(path).write_bytes(b'partial PNG')
            raise OSError('save failed')

        self.save.side_effect = fail_save
        with self.assertRaisesRegex(OSError, 'save failed'):
            self.run_sample()
        self.assertEqual(list(self.output.iterdir()), [])
        self.assert_clean()


if __name__ == '__main__':
    unittest.main()
