import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import CONTRACT, create_job, select_ids, validate_job
import prepare
from prepare import file_hash, publish_snapshot, snapshot


class PreparationTests(unittest.TestCase):
    def source(self, root):
        for name, contents in {
            'src/lib/miNoteCards.ts': 'export const MI_NOTE_CARD_COUNT = 1430;',
            'shared/scene.ts': 'export const width = 1080;',
            'public/icon.svg': '<svg/>',
            'scripts/mi-note-video/package.json': '{"private":true}',
            'scripts/mi-note-video/package-lock.json': '{"lockfileVersion":3}',
            'scripts/mi-note-video/contract.json': json.dumps(CONTRACT),
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

    def test_publish_recovers_incomplete_or_changed_releases_and_reuses_verified_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / 'source'
            self.source(root)
            staging = base / 'staging'
            manifest = snapshot(staging, root)
            release = base / 'releases' / manifest['sourceId']
            release.mkdir(parents=True)
            (release / 'partial').write_text('interrupted copy')
            publish_snapshot(staging, release, manifest)
            self.assertFalse(staging.exists())
            preserved = list(release.parent.glob(release.name + '.incomplete-*'))
            self.assertEqual(len(preserved), 1)
            self.assertEqual((preserved[0] / 'partial').read_text(), 'interrupted copy')
            self.assertEqual(json.loads((release / 'source-snapshot.json').read_text()), manifest)

            snapshot(staging, root)
            publish_snapshot(staging, release, manifest)
            self.assertTrue(staging.exists())
            self.assertEqual(len(list(release.parent.iterdir())), 2)
            (release / 'shared/scene.ts').write_text('corrupted copy')
            publish_snapshot(staging, release, manifest)
            self.assertEqual(file_hash(release / 'shared/scene.ts'), manifest['files']['shared/scene.ts'])
            self.assertEqual(len(list(release.parent.iterdir())), 3)

    def test_interrupted_publication_leaves_no_partial_final_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / 'source'
            self.source(root)
            staging = base / 'staging'
            manifest = snapshot(staging, root)
            release = base / 'releases' / manifest['sourceId']
            with patch.object(Path, 'rename', side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    publish_snapshot(staging, release, manifest)
            self.assertFalse(release.exists())
            publish_snapshot(staging, release, manifest)
            self.assertEqual(file_hash(release / 'shared/scene.ts'), manifest['files']['shared/scene.ts'])

    def test_preparation_and_job_metadata_use_snapshot_during_checkout_edits(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root, state = base / 'source', base / 'state'
            self.source(root)
            state.mkdir()
            contract_hash = file_hash(root / 'scripts/mi-note-video/contract.json')
            vm = Mock(config={'guestRoot': '/data/render', 'python': '/runtime/python', 'node': '/runtime/node'})
            transferred_hash = None

            def upload(local, remote):
                nonlocal transferred_hash
                transferred_hash = file_hash(local)

            def execute(arguments, **kwargs):
                if arguments[0] == '/usr/bin/shasum':
                    return (transferred_hash + ' source.tar\n').encode()
                if 'npm ci' in arguments[-1]:
                    (root / 'src/lib/miNoteCards.ts').write_text('export const MI_NOTE_CARD_COUNT = 1431;')
                    contract = json.loads((root / 'scripts/mi-note-video/contract.json').read_text())
                    contract['scene']['effectOpacity'] = .98
                    (root / 'scripts/mi-note-video/contract.json').write_text(json.dumps(contract))
                return b''

            vm.put.side_effect = upload
            vm.exec.side_effect = execute
            with patch.object(prepare, 'snapshot', side_effect=lambda destination: snapshot(destination, root)), \
                    patch.object(prepare, 'inspect_runtime', return_value={'fixture': True}):
                prepared = prepare.prepare(vm, state)
            self.assertEqual(prepared['catalogCount'], 1430)
            self.assertEqual(prepared['contractSha256'], contract_hash)
            self.assertNotEqual(file_hash(root / 'scripts/mi-note-video/contract.json'), contract_hash)
            with patch('jobs.HERE', root / 'scripts/mi-note-video'):
                job = create_job('fixture', [1], 'sideways-1980', 'breathing-swing', prepared, vm.config)
            self.assertEqual(job['catalogCount'], 1430)
            self.assertEqual(job['contractSha256'], contract_hash)

    def test_explicit_full_catalog_and_selection(self):
        self.assertEqual(select_ids(all_cards=True, count=1430), list(range(1, 1431)))
        self.assertEqual(select_ids('1375,312,904', count=1430), [312, 904, 1375])
        for ids, all_cards in [(None, False), ('1', True), ('0', False), ('1431', False), ('1,1', False)]:
            with self.assertRaises(ValueError):
                select_ids(ids, all_cards, count=1430)

    def test_frozen_host_preparation_reuses_exact_release_without_transfer(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root, state = base / 'source', base / 'state'
            self.source(root)
            staging = base / 'staging'
            manifest = snapshot(staging, root)
            release = state / 'releases' / manifest['sourceId']
            publish_snapshot(staging, release, manifest)
            host = Mock(kind='host', config={'guestRoot': str(state / 'host'), 'python': '/runtime/python', 'node': '/runtime/node'})
            with patch.object(prepare, 'snapshot', side_effect=AssertionError('Must not resnapshot')), \
                    patch.object(prepare, 'inspect_runtime', return_value={'fixture': True}):
                first = prepare.prepare_frozen(host, state, manifest['sourceId'])
                (root / 'shared/scene.ts').write_text('changed checkout')
                second = prepare.prepare_frozen(host, state, manifest['sourceId'])
            self.assertEqual(first['sourceId'], second['sourceId'])
            self.assertEqual(first, second)
            self.assertEqual(first['guestSourceRoot'], str(release))
            self.assertTrue((release / 'source-snapshot.json').is_file())
            self.assertTrue((state / 'prepared-host.json').is_file())
            host.put.assert_not_called()
            self.assertFalse(any('/bin/rm' == call.args[0][0] for call in host.exec.call_args_list))

    def test_frozen_preparation_stops_on_corruption_without_repair(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root, state = base / 'source', base / 'state'
            self.source(root)
            staging = base / 'staging'
            manifest = snapshot(staging, root)
            release = state / 'releases' / manifest['sourceId']
            publish_snapshot(staging, release, manifest)
            (release / 'shared/scene.ts').write_text('corruption')
            backend = Mock()
            with self.assertRaisesRegex(ValueError, 'missing or changed'):
                prepare.prepare_frozen(backend, state, manifest['sourceId'])
            backend.exec.assert_not_called()
            self.assertEqual((release / 'shared/scene.ts').read_text(), 'corruption')

    def test_frozen_manifest_rejects_changed_inventory_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / 'source'
            self.source(root)
            manifest = snapshot(base / 'release', root)
            manifest['files']['shared/scene.ts'] = 'a' * 64
            (base / 'release/source-snapshot.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'identity differs'):
                prepare.verify_snapshot(base / 'release', manifest['sourceId'])

    def test_job_records_explicit_profiles_and_source_identity(self):
        prepared = {'sourceId': 'a' * 64, 'guestSourceRoot': '/data/releases/' + 'a' * 64,
                    'runtime': {'versions': {'node': '24.22.0'}}, 'catalogCount': 1430, 'contractSha256': 'b' * 64}
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
