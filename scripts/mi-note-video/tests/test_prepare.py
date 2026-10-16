import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import CONTRACT, create_job, select_ids, validate_job
from prepare import snapshot


class PreparationTests(unittest.TestCase):
    def source(self, root):
        for name, contents in {
            'src/lib/miNoteCards.ts': 'export const MI_NOTE_CARD_COUNT = 1430;',
            'shared/scene.ts': 'export const width = 1080;',
            'public/icon.svg': '<svg/>',
            'scripts/mi-note-video/package.json': '{"private":true}',
            'scripts/mi-note-video/package-lock.json': '{"lockfileVersion":3}',
            'scripts/mi-note-video/harness.tsx': 'import "../../../shared/scene.ts";',
            'scripts/mi-note-video/tests/example.py': 'ignored',
            'scripts/mi-note-video/node_modules/untrusted.js': 'ignored',
            '.env': 'PRIVATE=do-not-package',
        }.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents)

    def test_snapshot_is_complete_portable_and_deterministic(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / 'checkout with spaces'
            self.source(root)
            first = snapshot(base / 'one', root)
            second = snapshot(base / 'two', root)
            self.assertEqual(first, second)
            self.assertIn('shared/scene.ts', first['files'])
            self.assertIn('public/icon.svg', first['files'])
            self.assertNotIn('.env', first['files'])
            self.assertFalse(any('node_modules' in name or '/tests/' in name for name in first['files']))
            self.assertNotIn(str(base), json.dumps(first))
            for name, expected in first['files'].items():
                self.assertEqual(hashlib.sha256((base / 'one' / name).read_bytes()).hexdigest(), expected)
            (root / 'shared/scene.ts').write_text('export const width = 100;')
            self.assertNotEqual(snapshot(base / 'three', root)['sourceId'], first['sourceId'])

    def test_snapshot_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'source'
            self.source(root)
            (root / 'src/leak.ts').symlink_to(root / '.env')
            with self.assertRaisesRegex(ValueError, 'symlinks'):
                snapshot(Path(temporary) / 'copy', root)

    def test_explicit_full_catalog_and_selection(self):
        self.assertEqual(select_ids(all_cards=True, count=1430), list(range(1, 1431)))
        self.assertEqual(select_ids('1375,312,904', count=1430), [312, 904, 1375])
        for ids, all_cards in [(None, False), ('1', True), ('0', False), ('1431', False), ('1,1', False)]:
            with self.assertRaises(ValueError):
                select_ids(ids, all_cards, count=1430)

    def test_job_records_explicit_profiles_and_source_identity(self):
        prepared = {'sourceId': 'a' * 64, 'guestSourceRoot': '/data/releases/' + 'a' * 64,
                    'runtime': {'versions': {'node': '24.22.0'}}, 'catalogCount': 1430}
        config = {'guestRoot': '/data/render', 'python': '/runtime/python', 'node': '/runtime/node'}
        for profile in CONTRACT['profiles']:
            for motion in CONTRACT['motions']:
                job = create_job('example', [1430, 1], profile, motion, prepared, config)
                self.assertEqual(validate_job(job), job)
                self.assertEqual(job['ids'], [1, 1430])
                self.assertEqual(job['sourceId'], prepared['sourceId'])
                self.assertEqual(job['root'], '/data/render/jobs/example')


if __name__ == '__main__':
    unittest.main()
