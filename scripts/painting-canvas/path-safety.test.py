import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

stubs = {name: types.ModuleType(name) for name in ['bpy', 'mathutils', 'geometry', 'material']}
stubs['mathutils'].Matrix = stubs['mathutils'].Vector = object
stubs['geometry'].create_canvas = stubs['material'].create_material = lambda *args: None
spec = importlib.util.spec_from_file_location('canvas_render', Path(__file__).with_name('render.py'))
renderer = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, stubs), patch.object(sys, 'path', sys.path.copy()):
    spec.loader.exec_module(renderer)


class OutputSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='canvas-path-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / 'output'
        self.output.mkdir()
        self.sources = [self.root / 'first.png', self.root / 'second.png']
        for index, source in enumerate(self.sources):
            source.write_bytes(f'original-{index}'.encode())
        self.samples = [{'id': name, 'path': str(source)}
                        for name, source in zip(['first', 'second'], self.sources)]

    def reject(self, samples=None, output=None, overwrite=True):
        before = [source.read_bytes() for source in self.sources]
        with self.assertRaises(ValueError):
            renderer.preflight_outputs(samples or self.samples, output or self.output, overwrite)
        self.assertEqual(before, [source.read_bytes() for source in self.sources])

    def test_direct_source_destination(self):
        self.reject(output=self.root)

    def test_output_symlink_to_source(self):
        (self.output / 'first.png').symlink_to(self.sources[0])
        self.reject()

    def test_output_hardlink_to_another_source(self):
        os.link(self.sources[1], self.output / 'first.png')
        self.reject()

    def test_output_hardlink_to_unlisted_approved_reference(self):
        approved = self.root / 'approved.png'
        approved.write_bytes(b'approved reference outside this batch')
        os.link(approved, self.output / 'first.png')
        self.reject()
        self.assertEqual(approved.read_bytes(), b'approved reference outside this batch')

    def test_report_hardlinks_cannot_modify_unlisted_files(self):
        external = self.root / 'external.json'
        external.write_bytes(b'keep this external file')
        for name in ['render-report.json', 'render-report.pending.json']:
            with self.subTest(name=name):
                target = self.output / name
                os.link(external, target)
                self.reject()
                self.assertEqual(external.read_bytes(), b'keep this external file')
                target.unlink()

    def test_case_only_ids(self):
        samples = [dict(sample, id=name) for sample, name in zip(self.samples, ['Art', 'art'])]
        self.reject(samples=samples)

    def test_output_aliases_collide(self):
        shared = self.root / 'shared.png'
        shared.write_bytes(b'previous render')
        for target in ['first.png', 'second.png']:
            (self.output / target).symlink_to(shared)
        self.reject()

    def test_output_hardlinks_collide(self):
        first = self.output / 'first.png'
        first.write_bytes(b'previous render')
        os.link(first, self.output / 'second.png')
        self.reject()

    def test_report_paths_cannot_alias_sources(self):
        for name in ['render-report.json', 'render-report.pending.json']:
            with self.subTest(name=name):
                target = self.output / name
                target.symlink_to(self.sources[0])
                self.reject()
                target.unlink()

    def test_existing_output_requires_overwrite(self):
        (self.output / 'first.png').write_bytes(b'previous render')
        self.reject(overwrite=False)

    def test_safe_overwrite_does_not_modify_files_during_preflight(self):
        target = self.output / 'first.png'
        target.write_bytes(b'previous render')
        renderer.preflight_outputs(self.samples, self.output, True)
        self.assertEqual(target.read_bytes(), b'previous render')
        self.assertEqual(self.sources[0].read_bytes(), b'original-0')

    def test_new_output_directory_is_allowed_without_creating_it(self):
        output = self.root / 'new-output'
        renderer.preflight_outputs(self.samples, output, False)
        self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
