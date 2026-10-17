import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import catalog
import background
import cli
from backends import Host
from prepare import atomic_json


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.state = Path(self.temporary.name).resolve()
        self.job = {'version': 2, 'jobId': '07953116-ebf4-4bc8-b895-e2766ea4a67c', 'name': 'catalog-fixture',
                    'ids': [1, 2, 3], 'catalogCount': 1430, 'sourceId': 'a' * 64, 'contractSha256': 'b' * 64,
                    'profile': 'upright-2160', 'motion': 'breathing-swing', 'retention': 'receipt'}
        self.metadata = {'version': 2, 'job': self.job, 'output': str(self.state / 'outputs/fixture')}
        self.job['output'] = self.metadata['output']
        self.root = catalog.directory(self.state, self.job['name'])
        self.root.mkdir(parents=True)
        Path(self.metadata['output']).mkdir(parents=True)
        atomic_json(self.root / 'job.json', self.job)
        atomic_json(self.root / 'job-meta.json', self.metadata)
        self.prepared = {'sourceId': self.job['sourceId'], 'contractSha256': self.job['contractSha256'],
                         'catalogCount': 1430, 'guestSourceRoot': str(self.state / 'release'), 'runtime': {'fixture': True}}
        self.backend = SimpleNamespace(config={'guestRoot': str(self.state / 'vm'), 'node': '/runtime/node', 'python': '/runtime/python'})

    def tearDown(self):
        self.temporary.cleanup()

    def execution(self, backend='vm', card=1):
        return catalog.execution_for(self.state, self.job, backend, self.backend, self.prepared, card)

    def publication(self, execution):
        card = execution['job']['ids'][0]
        root = Path(execution['output'])
        root.mkdir(parents=True, exist_ok=True)
        path = root / f'{card}.mp4'
        path.write_bytes(f'video-{card}'.encode())
        return {'status': 'complete', 'videos': {str(card): {
            'path': str(path), 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        }}}

    def equivalence(self, candidate='c' * 64):
        hashes = [{'frame': index, 'baseline': 'd' * 64, 'candidate': 'd' * 64} for index in range(276)]
        return {'version': 1, 'kind': 'mi-note-performance-equivalence', 'status': 'passed',
                'baselineSourceId': self.job['sourceId'], 'candidateSourceId': candidate,
                'contractSha256': self.job['contractSha256'], 'profile': self.job['profile'], 'motion': self.job['motion'],
                'cardId': 1, 'frames': 276, 'nativePixelsExact': True, 'preparedPixelsExact': True,
                'iccExact': True, 'videoBytesExact': True, 'nativeFrameHashes': hashes, 'preparedFrameHashes': hashes,
                'baselineVideoSha256': 'e' * 64, 'candidateVideoSha256': 'e' * 64}

    def upgrade(self, from_card=2, changed='scripts/mi-note-video/capture.mjs'):
        evidence = self.state / 'equivalence.json'
        atomic_json(evidence, self.equivalence())
        baseline = {'sourceId': self.job['sourceId'], 'files': {'scripts/mi-note-video/contract.json': self.job['contractSha256'], changed: '0' * 64}}
        candidate = {'sourceId': 'c' * 64, 'files': {**baseline['files'], changed: '1' * 64}}
        publication = {**catalog.empty_manifest(self.job), 'videos': {'1': {}}}
        with patch.object(catalog, 'ensure_exclusive_native'), patch.object(catalog, 'verify_catalog', return_value=publication), \
                patch.object(catalog, 'verify_snapshot', return_value=baseline), patch.object(catalog, 'snapshot', return_value=candidate), \
                patch.object(catalog, 'publish_snapshot'):
            return catalog.upgrade_source(self.state, self.job, self.metadata, from_card, evidence)

    def creation_args(self, name):
        return SimpleNamespace(job=name, backend='host', output=self.state / 'outputs' / name,
                               ids='1,2', all=False, profile=self.job['profile'], motion=self.job['motion'], retention='receipt')

    def test_initial_identity_write_failures_leave_creation_retryable(self):
        with patch.object(catalog, 'ensure_exclusive_native'), patch.object(catalog, 'backend_for', return_value=self.backend), \
                patch.object(catalog, 'backend_ready'), patch.object(catalog, 'check_capacity'), patch('cli.assert_idle'), \
                patch.object(catalog, 'prepare', return_value=self.prepared):
            for index, failed_name in enumerate(('job.json', 'job-meta.json', 'catalog-state.json')):
                with self.subTest(failed_name=failed_name):
                    args = self.creation_args(f'creation-{index}')
                    args.output.mkdir()
                    root = catalog.directory(self.state, args.job)
                    def fail_write(path, value):
                        if Path(path).name == failed_name:
                            raise OSError('initial write failed')
                        atomic_json(path, value)
                    with patch.object(catalog, 'atomic_json', side_effect=fail_write), self.assertRaisesRegex(OSError, 'initial write failed'):
                        catalog.create(self.state, args)
                    self.assertFalse(root.exists())
                    self.assertTrue(args.output.is_dir())
                    self.assertEqual(list(args.output.iterdir()), [])
                    job, metadata = catalog.create(self.state, args)
                    self.assertEqual(catalog.load(self.state, args.job), (job, metadata))
                    self.assertEqual(catalog.status(self.state, args.job)['backend'], 'host')
                    self.assertEqual(catalog.read_manifest(job, metadata), catalog.empty_manifest(job))
                    self.assertTrue((root / 'control.command').is_file())

    def test_postcommit_creation_failures_are_repaired_by_resume(self):
        for index, failure in enumerate(('manifest', 'control')):
            with self.subTest(failure=failure):
                args = self.creation_args(f'postcommit-{index}')
                root = catalog.directory(self.state, args.job)
                def fail_write(path, value):
                    if Path(path).name == '.catalog-manifest.json':
                        raise OSError('manifest write failed')
                    atomic_json(path, value)
                failing = patch.object(catalog, 'atomic_json', side_effect=fail_write) if failure == 'manifest' else patch('background.write_control', side_effect=OSError('control write failed'))
                with patch.object(catalog, 'ensure_exclusive_native'), patch.object(catalog, 'backend_for', return_value=self.backend), \
                        patch.object(catalog, 'backend_ready'), patch.object(catalog, 'check_capacity'), patch('cli.assert_idle'), \
                        patch.object(catalog, 'prepare', return_value=self.prepared), failing, self.assertRaises(OSError):
                    catalog.create(self.state, args)
                job, metadata = catalog.load(self.state, args.job)
                original = {name: (root / name).read_bytes() for name in ('job.json', 'job-meta.json')}
                self.assertTrue(catalog.is_catalog(self.state, args.job))
                self.assertEqual(catalog.status(self.state, args.job)['backend'], 'host')
                with patch.object(catalog, 'ensure_other_idle'), patch.object(catalog, 'ensure_exclusive_native'), \
                        patch.object(catalog, 'backend_for') as backend, \
                        patch.object(catalog, 'check_capacity', side_effect=catalog.Interrupted('fixture stop before rendering')), \
                        self.assertRaisesRegex(catalog.Interrupted, 'fixture stop'):
                    catalog.run(self.state, args.job, 'host')
                backend.assert_not_called()
                self.assertEqual({name: (root / name).read_bytes() for name in original}, original)
                self.assertEqual(catalog.read_manifest(job, metadata), catalog.empty_manifest(job))
                self.assertTrue((root / 'control.command').is_file())

    def test_creation_preserves_unrelated_job_and_output_directories(self):
        for occupied in ('job', 'output'):
            with self.subTest(occupied=occupied):
                args = self.creation_args('occupied-' + occupied)
                root = catalog.directory(self.state, args.job) if occupied == 'job' else args.output
                root.mkdir()
                original = root / 'unrelated.txt'
                original.write_bytes(b'preserved')
                with patch.object(catalog, 'ensure_exclusive_native'), patch.object(catalog, 'backend_for'), \
                        patch.object(catalog, 'prepare') as prepare, self.assertRaises(ValueError):
                    catalog.create(self.state, args)
                prepare.assert_not_called()
                self.assertEqual(original.read_bytes(), b'preserved')
                self.assertEqual(list(root.iterdir()), [original])

    def test_explicit_start_rejects_earlier_holes_and_does_not_skip_selected_card(self):
        manifest = catalog.empty_manifest(self.job)
        manifest['videos'] = {'2': {}}
        with self.assertRaisesRegex(ValueError, 'earlier card 1'):
            catalog.pending_cards(self.job, manifest, 2)
        manifest['videos'] = {'1': {}}
        self.assertEqual(catalog.pending_cards(self.job, manifest, 2), [2, 3])
        self.assertEqual(catalog.pending_cards(self.job, manifest), [2, 3])
        with self.assertRaises(ValueError):
            catalog.pending_cards(self.job, manifest, 4)

    def test_backend_switch_isolates_checkpoints_and_return_reuses_same_environment(self):
        vm = self.execution('vm')
        host = self.execution('host')
        self.assertNotEqual(vm['job']['jobId'], host['job']['jobId'])
        self.assertNotEqual(vm['job']['root'], host['job']['root'])
        self.assertEqual(self.execution('vm'), vm)
        self.assertEqual(self.execution('host'), host)
        for execution in (vm, host):
            self.assertEqual(execution['job']['sourceId'], self.job['sourceId'])
            self.assertEqual(execution['job']['ids'], [1])
        changed = {**self.prepared, 'runtime': {'fixture': False}}
        with self.assertRaisesRegex(RuntimeError, 'runtime or paths changed'):
            catalog.execution_for(self.state, self.job, 'vm', self.backend, changed, 1)

    def test_completed_outputs_require_matching_publication_and_canonical_bytes(self):
        execution = self.execution()
        publication = self.publication(execution)
        manifest = catalog.empty_manifest(self.job)
        with patch('collect.verify_publication', return_value=publication):
            catalog.publish_card(self.state, self.job, self.metadata, execution, manifest)
            self.assertEqual(catalog.verify_catalog(self.state, self.job, self.metadata)['videos']['1']['backend'], 'vm')
            target = Path(self.metadata['output']) / '1.mp4'
            target.write_bytes(b'corrupt')
            with self.assertRaisesRegex(RuntimeError, 'Video mismatch'):
                catalog.verify_catalog(self.state, self.job, self.metadata)

    def test_crash_after_video_link_can_publish_without_overwrite_or_rerender(self):
        execution = self.execution()
        publication = self.publication(execution)
        manifest = catalog.empty_manifest(self.job)
        with patch('collect.verify_publication', return_value=publication):
            with patch.object(catalog, 'atomic_json', side_effect=OSError('simulated crash')):
                with self.assertRaises(OSError):
                    catalog.publish_card(self.state, self.job, self.metadata, execution, manifest)
            saved = (Path(self.metadata['output']) / '1.mp4').read_bytes()
            catalog.publish_card(self.state, self.job, self.metadata, execution, catalog.empty_manifest(self.job))
            self.assertEqual((Path(self.metadata['output']) / '1.mp4').read_bytes(), saved)

    def test_complete_status_requires_every_original_id(self):
        manifest = catalog.empty_manifest(self.job)
        for card, backend in ((1, 'vm'), (2, 'host'), (3, 'vm')):
            execution = self.execution(backend, card)
            with patch('collect.verify_publication', return_value=self.publication(execution)):
                catalog.publish_card(self.state, self.job, self.metadata, execution, manifest)
            self.assertEqual(manifest['status'], 'complete' if card == 3 else 'pending')
        self.assertEqual(catalog.pending_cards(self.job, manifest), [])

    def test_durable_active_identity_blocks_switch_even_when_display_phase_has_no_card(self):
        execution = self.execution()
        atomic_json(self.root / 'active-execution.json', {'backend': 'vm', 'currentCard': 1, 'executionId': execution['job']['jobId']})
        atomic_json(self.root / 'catalog-state.json', {'status': 'failed', 'backend': 'vm', 'currentCard': None})
        with patch.object(catalog, 'backend_for', return_value=self.backend), patch.object(catalog, 'native_running', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'previous backend is still running'):
                catalog.ensure_other_idle(self.state, self.job, 'host')
        with patch.object(catalog, 'backend_for', return_value=self.backend), patch.object(catalog, 'stop_native') as stop:
            self.assertTrue(catalog.request_interrupt(self.state, self.job['name'])['interruptionRequested'])
            stop.assert_called_once_with(self.backend, execution['job'])

    def test_native_crash_fails_instead_of_polling_stale_status_forever(self):
        execution = self.execution()
        current = {'status': 'rendering', 'attempt': 'fixture'}
        with patch('cli.ensure_guest_job'), patch('cli.read_current_status', return_value=current), \
                patch.object(catalog, 'native_running', side_effect=[True, False]), \
                patch.object(catalog, 'check_capacity'), patch.object(catalog, 'stop_native'), \
                patch('collect.collect') as collect:
            with self.assertRaisesRegex(RuntimeError, 'exited without a terminal checkpoint'):
                catalog.run_execution(self.state, self.job, self.metadata, execution, self.backend, lambda: False, lambda *args: None)
            collect.assert_not_called()

    def test_native_completion_is_publishing_until_catalog_publication(self):
        execution = self.execution()
        updates = []
        with patch('cli.ensure_guest_job'), patch('cli.read_current_status', return_value={'status': 'complete', 'attempt': 'fixture'}), \
                patch.object(catalog, 'native_running', side_effect=[True, False]), patch.object(catalog, 'check_capacity'), \
                patch('collect.collect', return_value={'status': 'complete', 'collected': 1}):
            catalog.run_execution(self.state, self.job, self.metadata, execution, self.backend, lambda: False, lambda *args: updates.append(args))
        self.assertEqual(updates[0][0], 'publishing')

    def test_capacity_includes_working_headroom(self):
        with patch.object(catalog, 'available_capacity', return_value=16 * 1024 ** 3):
            catalog.check_capacity(self.state, self.metadata['output'])
            with self.assertRaises(catalog.LowSpace):
                catalog.check_capacity(self.state, self.metadata['output'], 12 * 1024 ** 3)
        with patch.object(catalog, 'available_capacity', return_value=30 * 1024 ** 3):
            catalog.check_capacity(self.state, self.metadata['output'], 12 * 1024 ** 3)

    def test_controller_refresh_preserves_render_identity_and_checkpoints(self):
        execution = self.execution()
        original = (self.root / 'job.json').read_bytes()
        before = catalog.controller_root(self.state, self.job, self.metadata)
        manifest = {'sourceId': 'c' * 64, 'files': {'scripts/mi-note-video/contract.json': self.job['contractSha256']}}
        with patch.object(catalog, 'ensure_exclusive_native'), patch.object(catalog, 'snapshot', return_value=manifest), \
                patch.object(catalog, 'publish_snapshot'), patch.object(catalog, 'verify_snapshot', return_value=manifest):
            updated = catalog.refresh_controller(self.state, self.job, self.metadata)
            self.assertEqual(catalog.controller_root(self.state, self.job, updated), self.state / 'releases' / ('c' * 64))
        self.assertEqual((self.root / 'job.json').read_bytes(), original)
        self.assertEqual(catalog.source_root(self.state, self.job), before)
        self.assertEqual(self.execution(), execution)
        self.assertIn(self.job['sourceId'], updated['controllerHistory'])

    def test_controller_refresh_rejects_changed_render_contract(self):
        manifest = {'sourceId': 'c' * 64, 'files': {'scripts/mi-note-video/contract.json': 'd' * 64}}
        with patch.object(catalog, 'ensure_exclusive_native'), patch.object(catalog, 'snapshot', return_value=manifest), \
                self.assertRaisesRegex(RuntimeError, 'rendering contract'):
            catalog.refresh_controller(self.state, self.job, self.metadata)

    def test_orphaned_other_backend_prevents_a_second_renderer(self):
        (self.state / 'config.json').write_text('{}')
        vm = SimpleNamespace(status=lambda: {'running': True})
        with patch.object(catalog, 'backend_for', return_value=vm), \
                patch('cli.assert_idle', side_effect=RuntimeError('A rendering job is active')):
            with self.assertRaisesRegex(RuntimeError, 'rendering job is active'):
                catalog.ensure_exclusive_native(self.state, self.job, 'host')

    def test_superseded_frames_are_retained_until_card_is_published_then_cleanup_is_deferred_if_offline(self):
        old = self.execution('vm', 1)
        self.execution('host', 1)
        manifest = catalog.empty_manifest(self.job)
        self.assertEqual(list(catalog.superseded_executions(self.state, self.job, 'vm', manifest)), [])
        manifest['videos'] = {'1': {'backend': 'host'}}
        pending = list(catalog.superseded_executions(self.state, self.job, 'vm', manifest))
        self.assertEqual(pending[0][2], old['job'])
        offline = SimpleNamespace(status=lambda: {'running': False})
        with patch.object(catalog, 'backend_for', return_value=offline), patch.object(catalog, 'cleanup_superseded') as cleanup:
            catalog.cleanup_available(self.state, self.job, manifest)
            cleanup.assert_not_called()
        online = SimpleNamespace(status=lambda: {'running': True})
        with patch.object(catalog, 'backend_for', return_value=online), patch.object(catalog, 'cleanup_superseded') as cleanup:
            catalog.cleanup_available(self.state, self.job, manifest)
            cleanup.assert_called_once()

    def test_uninitialized_superseded_execution_cleanup_after_backend_switch_is_retryable(self):
        manifest = catalog.empty_manifest(self.job)
        backend = SimpleNamespace(config={'python': sys.executable}, exec=Host(self.state).exec,
                                  status=lambda: {'running': True})
        for card, initialized_root in ((1, False), (2, True)):
            with self.subTest(initialized_root=initialized_root):
                old = self.execution('vm', card)
                native_root = Path(old['job']['root'])
                if initialized_root:
                    native_root.mkdir(parents=True)
                replacement = self.execution('host', card)
                publication = self.publication(replacement)
                with patch('collect.verify_publication', return_value=publication):
                    catalog.publish_card(self.state, self.job, self.metadata, replacement, manifest)
                target = Path(self.metadata['output']) / f'{card}.mp4'
                published = target.read_bytes()
                with patch.object(catalog, 'backend_for', return_value=backend), \
                        patch.object(catalog, 'native_running', return_value=False):
                    catalog.cleanup_available(self.state, self.job, manifest)
                record = catalog.execution_directory(self.state, self.job, 'vm', card) / 'execution.json'
                self.assertTrue(catalog.read(record)['supersededAt'])
                self.assertEqual(native_root.exists(), initialized_root)
                if initialized_root:
                    self.assertEqual(list(native_root.iterdir()), [])
                self.assertEqual(target.read_bytes(), published)
                with patch.object(catalog, 'backend_for') as selected:
                    catalog.cleanup_available(self.state, self.job, manifest)
                selected.assert_not_called()

    def test_superseded_cleanup_refuses_missing_or_mismatched_identity_with_data(self):
        backend = SimpleNamespace(config={'python': sys.executable}, exec=Host(self.state).exec)
        for card, identity in ((1, None), (2, {'jobId': 'another-execution'})):
            with self.subTest(identity=identity):
                execution = self.execution('vm', card)
                native_root = Path(execution['job']['root'])
                checkpoint = native_root / 'cards' / str(card) / 'capture/frame.png'
                checkpoint.parent.mkdir(parents=True)
                checkpoint.write_bytes(b'preserved')
                if identity is not None:
                    atomic_json(native_root / 'job.json', identity)
                with patch.object(catalog, 'native_running', return_value=False), \
                        self.assertRaisesRegex(RuntimeError, 'unowned data|identity changed'):
                    catalog.cleanup_superseded(self.state, self.job, 'vm', backend,
                                               {'videos': {str(card): {'backend': 'host'}}})
                self.assertEqual(checkpoint.read_bytes(), b'preserved')
                record = catalog.execution_directory(self.state, self.job, 'vm', card) / 'execution.json'
                self.assertNotIn('supersededAt', catalog.read(record))

    def test_superseded_cleanup_refuses_symlink_identity_even_when_contents_match(self):
        execution = self.execution('vm', 1)
        native_root = Path(execution['job']['root'])
        native_root.mkdir(parents=True)
        unrelated = self.state / 'unrelated-job.json'
        atomic_json(unrelated, execution['job'])
        identity = native_root / 'job.json'
        identity.symlink_to(unrelated)
        backend = SimpleNamespace(config={'python': sys.executable}, exec=Host(self.state).exec)
        with patch.object(catalog, 'native_running', return_value=False), \
                self.assertRaisesRegex(RuntimeError, 'identity changed'):
            catalog.cleanup_superseded(self.state, self.job, 'vm', backend, {'videos': {'1': {'backend': 'host'}}})
        self.assertTrue(identity.is_symlink())
        self.assertEqual(catalog.read(unrelated), execution['job'])
        record = catalog.execution_directory(self.state, self.job, 'vm', 1) / 'execution.json'
        self.assertNotIn('supersededAt', catalog.read(record))

    def test_controls_use_pinned_release_and_manual_background_resume(self):
        source = self.state / 'source with spaces'
        path = background.write_control(self.state, self.job, source)
        text = path.read_text()
        self.assertIn(str(source / 'scripts/mi-note-video/cli.py'), text)
        self.assertIn('--background "$@"', text)
        command = background.command_for(self.state, self.job, source, 'host', 2)
        self.assertEqual(command[:2], ['/usr/bin/caffeinate', '-di'])
        self.assertEqual(command[-4:], ['--backend', 'host', '--from-id', '2'])
        self.assertNotIn('--background', command)

    def test_background_launch_occurs_after_parent_releases_global_lock(self):
        def launched(*args):
            with cli.exclusive_work(SimpleNamespace(state=self.state)):
                return {'background': True}
        with patch.object(sys, 'argv', ['cli.py', '--state', str(self.state), 'resume', self.job['name'], '--background']), \
                patch.object(catalog, 'verify_catalog', return_value=catalog.empty_manifest(self.job)), \
                patch.object(catalog, 'ensure_other_idle'), patch('background.launch', side_effect=launched) as launch:
            self.assertEqual(cli.main(), 0)
            launch.assert_called_once()

    def test_interrupt_is_saved_for_an_unfinished_catalog_without_active_executions(self):
        atomic_json(self.root / 'catalog-state.json', {'status': 'interrupted', 'backend': 'host', 'currentCard': None})
        result = catalog.request_interrupt(self.state, self.job['name'])
        self.assertTrue(result['interruptionRequested'])
        self.assertTrue((self.root / 'interrupt-request.json').is_file())
        self.assertEqual(catalog.active_executions(self.state, self.job), [])

    def test_interrupt_of_a_completed_idle_catalog_remains_a_noop(self):
        manifest = {**catalog.empty_manifest(self.job), 'videos': {str(card): {} for card in self.job['ids']}}
        atomic_json(catalog.manifest_path(self.metadata), manifest)
        result = catalog.request_interrupt(self.state, self.job['name'])
        self.assertFalse(result['interruptionRequested'])
        self.assertFalse((self.root / 'interrupt-request.json').exists())

    def test_interrupt_during_resume_ownership_checks_prevents_render_dispatch(self):
        def interrupt_during_startup(*args):
            self.assertTrue(catalog.request_interrupt(self.state, self.job['name'])['interruptionRequested'])
        with patch.object(catalog, 'ensure_other_idle'), \
                patch.object(catalog, 'ensure_exclusive_native', side_effect=interrupt_during_startup), \
                patch.object(catalog, 'backend_for') as backend, patch.object(catalog, 'run_pipeline') as pipeline, \
                patch.object(catalog, 'run_execution') as execution, \
                self.assertRaisesRegex(catalog.Interrupted, 'during resume startup'):
            catalog.run(self.state, self.job['name'], 'host')
        backend.assert_not_called()
        pipeline.assert_not_called()
        execution.assert_not_called()
        self.assertTrue((self.root / 'interrupt-request.json').is_file())
        self.assertEqual(catalog.status(self.state, self.job['name'])['status'], 'interrupted')

    def test_explicit_resume_clears_old_interrupt_before_ownership_checks(self):
        request = self.root / 'interrupt-request.json'
        atomic_json(request, {'requestedAt': 'old request'})
        def check_request(*args):
            self.assertFalse(request.exists())
        with patch.object(catalog, 'ensure_other_idle', side_effect=check_request), \
                patch.object(catalog, 'ensure_exclusive_native'), \
                patch.object(catalog, 'check_capacity', side_effect=RuntimeError('fixture reached preparation')), \
                self.assertRaisesRegex(RuntimeError, 'fixture reached preparation'):
            catalog.run(self.state, self.job['name'], 'host')
        self.assertFalse(request.exists())

    def test_interrupt_during_cli_preverification_prevents_foreground_and_background_dispatch(self):
        for background_requested in (False, True):
            with self.subTest(background=background_requested):
                request = self.root / 'interrupt-request.json'
                atomic_json(request, {'requestedAt': 'old request'})
                def verify(*args):
                    self.assertFalse(request.exists())
                    self.assertTrue(catalog.request_interrupt(self.state, self.job['name'])['interruptionRequested'])
                    return catalog.empty_manifest(self.job)
                arguments = ['cli.py', '--state', str(self.state), 'resume', self.job['name']]
                if background_requested:
                    arguments.append('--background')
                with patch.object(sys, 'argv', arguments), patch.dict(cli.os.environ, {}, clear=True), \
                        patch.object(catalog, 'verify_catalog', side_effect=verify), \
                        patch.object(catalog, 'run') as run, patch('background.launch') as launch, \
                        self.assertRaisesRegex(catalog.Interrupted, 'during resume startup'):
                    cli.main()
                run.assert_not_called()
                launch.assert_not_called()
                self.assertTrue(request.exists())

    def test_cli_foreground_preserves_interrupt_received_after_preverification(self):
        original_run = catalog.run
        def run_after_verification(*args, **kwargs):
            self.assertTrue(catalog.request_interrupt(self.state, self.job['name'])['interruptionRequested'])
            return original_run(*args, **kwargs)
        with patch.object(sys, 'argv', ['cli.py', '--state', str(self.state), 'resume', self.job['name']]), \
                patch.dict(cli.os.environ, {}, clear=True), \
                patch.object(catalog, 'verify_catalog', return_value=catalog.empty_manifest(self.job)), \
                patch.object(catalog, 'ensure_other_idle'), patch.object(catalog, 'ensure_exclusive_native'), \
                patch.object(catalog, 'run', side_effect=run_after_verification), \
                patch.object(catalog, 'backend_for') as backend, \
                self.assertRaisesRegex(catalog.Interrupted, 'during resume startup'):
            cli.main()
        backend.assert_not_called()
        self.assertTrue((self.root / 'interrupt-request.json').is_file())

    def test_new_catalog_keeps_interrupt_received_after_identity_creation(self):
        def created(*args):
            self.assertTrue(catalog.request_interrupt(self.state, self.job['name'])['interruptionRequested'])
            return self.job, self.metadata
        with patch.object(sys, 'argv', ['cli.py', '--state', str(self.state), 'run', '--job', self.job['name'], '--ids', '1,2,3']), \
                patch.object(catalog, 'create', side_effect=created), \
                patch.object(catalog, 'ensure_other_idle'), patch.object(catalog, 'ensure_exclusive_native'), \
                patch.object(catalog, 'backend_for') as backend, \
                self.assertRaisesRegex(catalog.Interrupted, 'during resume startup'):
            cli.main()
        backend.assert_not_called()
        self.assertTrue((self.root / 'interrupt-request.json').is_file())

    def test_interrupt_during_backend_preparation_prevents_render_dispatch(self):
        for pipeline_enabled in (False, True):
            with self.subTest(pipeline=pipeline_enabled):
                def prepared(*args):
                    self.assertTrue(catalog.request_interrupt(self.state, self.job['name'])['interruptionRequested'])
                    return self.prepared
                with patch.object(catalog, 'ensure_other_idle'), patch.object(catalog, 'ensure_exclusive_native'), \
                        patch.object(catalog, 'backend_for', return_value=self.backend), patch.object(catalog, 'backend_ready'), \
                        patch.object(catalog, 'check_capacity'), patch.object(catalog, 'cleanup_superseded'), \
                        patch.object(catalog, 'pipeline_capability', return_value=pipeline_enabled), \
                        patch.object(catalog, 'prepare_frozen', side_effect=prepared), \
                        patch.object(catalog, 'execution_for') as execution, patch.object(catalog, 'run_pipeline') as pipeline, \
                        self.assertRaisesRegex(catalog.Interrupted, 'during backend preparation'):
                    catalog.run(self.state, self.job['name'], 'host')
                execution.assert_not_called()
                pipeline.assert_not_called()
                self.assertTrue((self.root / 'interrupt-request.json').is_file())

    def test_background_resume_preserves_interrupt_saved_during_handoff(self):
        def launch(state, job, source, backend, from_id):
            self.assertTrue(catalog.request_interrupt(state, job['name'])['interruptionRequested'])
            arguments = background.command_for(state, job, source, backend, from_id)[2:]
            with patch.object(sys, 'argv', arguments[1:]), \
                    patch.dict(cli.os.environ, {'MI_NOTE_RESUME_JOB_ID': job['jobId']}), \
                    patch.object(catalog, 'run') as run, \
                    self.assertRaisesRegex(catalog.Interrupted, 'during resume startup'):
                cli.main()
            run.assert_not_called()
            return {'background': True}
        with patch.object(sys, 'argv', ['cli.py', '--state', str(self.state), 'resume', self.job['name'], '--background']), \
                patch.dict(cli.os.environ, {}, clear=True), \
                patch.object(catalog, 'verify_catalog', return_value=catalog.empty_manifest(self.job)), \
                patch.object(catalog, 'ensure_other_idle'), patch('background.launch', side_effect=launch):
            self.assertEqual(cli.main(), 0)
        self.assertTrue((self.root / 'interrupt-request.json').is_file())

    def test_unrelated_background_job_marker_does_not_preserve_a_stale_interrupt(self):
        request = self.root / 'interrupt-request.json'
        atomic_json(request, {'requestedAt': 'old request'})
        def verify(*args):
            self.assertFalse(request.exists())
            return catalog.empty_manifest(self.job)
        with patch.object(sys, 'argv', ['cli.py', '--state', str(self.state), 'resume', self.job['name']]), \
                patch.dict(cli.os.environ, {'MI_NOTE_RESUME_JOB_ID': 'another-job'}), \
                patch.object(catalog, 'verify_catalog', side_effect=verify), patch.object(catalog, 'run', return_value=0) as run:
            self.assertEqual(cli.main(), 0)
        self.assertTrue(run.call_args.kwargs['preserve_interrupt'])
        self.assertFalse(request.exists())

    def test_source_upgrade_preserves_old_execution_and_uses_per_card_source_for_receipts(self):
        original_job = (self.root / 'job.json').read_bytes()
        old_execution = self.execution('host', 1)
        old_path = catalog.execution_directory(self.state, self.job, 'host', 1) / 'execution.json'
        old_bytes = old_path.read_bytes()
        result = self.upgrade()
        job, metadata = catalog.load(self.state, self.job['name'])
        self.assertEqual(result['fromCard'], 2)
        self.assertEqual((self.root / 'job.json').read_bytes(), original_job)
        self.assertEqual(old_path.read_bytes(), old_bytes)
        self.assertEqual(catalog.source_for_card(job, metadata, 1), 'a' * 64)
        self.assertEqual(catalog.source_for_card(job, metadata, 2), 'c' * 64)
        prepared = {**self.prepared, 'sourceId': 'c' * 64, 'guestSourceRoot': str(self.state / 'candidate')}
        new_execution = catalog.execution_for(self.state, job, 'host', self.backend, prepared, 2)
        manifest = catalog.empty_manifest(job)
        publications = {1: self.publication(old_execution), 2: self.publication(new_execution)}
        observed = []
        def verify(native_job, output, *, source_root, **kwargs):
            observed.append((native_job['ids'][0], source_root))
            return publications[native_job['ids'][0]]
        with patch('collect.verify_publication', side_effect=verify):
            for execution in (old_execution, new_execution):
                catalog.publish_card(self.state, job, metadata, execution, manifest)
            catalog.verify_catalog(self.state, job, metadata)
        self.assertEqual(observed, [(1, self.state / 'releases' / ('a' * 64)), (2, self.state / 'releases' / ('c' * 64))] * 2)
        with self.assertRaisesRegex(RuntimeError, 'Prepared rendering source'):
            catalog.execution_for(self.state, job, 'vm', self.backend, self.prepared, 2)

    def test_source_upgrade_rejects_partial_checkpoints_and_earlier_holes(self):
        for backend in ('host', 'vm'):
            with self.subTest(backend=backend):
                execution = self.execution(backend, 2)
                with self.assertRaisesRegex(RuntimeError, 'already has a ' + backend + ' execution'):
                    self.upgrade()
                (catalog.execution_directory(self.state, self.job, backend, 2) / 'execution.json').unlink()
        with self.assertRaisesRegex(ValueError, 'first unpublished card'):
            self.upgrade(from_card=3)

    def test_source_upgrade_rejects_changed_art_and_render_contract(self):
        for name in ('scripts/mi-note-video/capture.css', 'scripts/mi-note-video/motion.ts',
                     'scripts/mi-note-video/contract.json', 'src/lib/miNoteCards.ts', 'public/asset.png', 'package-lock.json'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'unapproved rendering inputs'):
                self.upgrade(changed=name)

    def test_source_upgrade_cannot_reassign_an_already_published_later_card(self):
        publication = {**catalog.empty_manifest(self.job), 'videos': {'1': {}, '3': {}}}
        with patch.object(catalog, 'ensure_exclusive_native'), patch.object(catalog, 'verify_catalog', return_value=publication), \
                self.assertRaisesRegex(ValueError, 'already published card'):
            catalog.upgrade_source(self.state, self.job, self.metadata, 2, self.state / 'missing.json')

    def test_equivalence_requires_every_exact_frame_and_video(self):
        for key, value in (('frames', 275), ('iccExact', False), ('videoBytesExact', False),
                           ('candidateVideoSha256', 'f' * 64), ('candidateSourceId', 'f' * 64),
                           ('nativeFrameHashes', []), ('preparedFrameHashes', [])):
            report = self.equivalence()
            report[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                catalog.validate_equivalence(report, self.job, 'a' * 64, 'c' * 64)
        report = self.equivalence()
        report['nativeFrameHashes'][275]['candidate'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'every matching frame'):
            catalog.validate_equivalence(report, self.job, 'a' * 64, 'c' * 64)

    def test_source_upgrade_evidence_remains_bound_on_resume(self):
        result = self.upgrade()
        retained = Path(result['evidence']['path'])
        retained.write_text(retained.read_text() + '\n')
        with self.assertRaisesRegex(ValueError, 'checksum changed'):
            catalog.load(self.state, self.job['name'])

    def test_source_upgrade_rejects_running_supervisor(self):
        with patch.object(catalog, 'status', return_value={'supervisorRunning': True}), \
                self.assertRaisesRegex(RuntimeError, 'Interrupt the active job'):
            catalog.upgrade_source(self.state, self.job, self.metadata, 2, self.state / 'missing.json')

    def test_source_upgrade_is_not_committed_when_control_update_fails(self):
        with patch('background.write_control', side_effect=OSError('control unavailable')):
            with self.assertRaisesRegex(OSError, 'control unavailable'):
                self.upgrade()
        self.assertEqual(catalog.load(self.state, self.job['name'])[1], self.metadata)

    def test_boundary_request_can_precede_resume_and_stops_before_next_execution(self):
        catalog.request_interrupt(self.state, self.job['name'], after_card=True)
        request = self.root / 'stop-after-card.json'
        self.assertEqual(json.loads(request.read_text())['jobId'], self.job['jobId'])
        publication = catalog.empty_manifest(self.job)
        def publish(state, job, metadata, execution, manifest):
            manifest['videos']['1'] = {'backend': 'host'}
        with patch.object(catalog, 'ensure_other_idle'), patch.object(catalog, 'ensure_exclusive_native'), \
                patch.object(catalog, 'verify_catalog', return_value=publication), patch.object(catalog, 'check_capacity'), \
                patch.object(catalog, 'backend_for', return_value=self.backend), patch.object(catalog, 'backend_ready'), \
                patch.object(catalog, 'prepare_frozen', return_value=self.prepared), patch.object(catalog, 'cleanup_superseded'), \
                patch.object(catalog, 'cleanup_available'), patch.object(catalog, 'run_execution'), \
                patch.object(catalog, 'publish_card', side_effect=publish):
            self.assertEqual(catalog.run(self.state, self.job['name'], 'host'), 0)
        self.assertFalse(request.exists())
        self.assertTrue((catalog.execution_directory(self.state, self.job, 'host', 1) / 'execution.json').exists())
        self.assertFalse(catalog.execution_directory(self.state, self.job, 'host', 2).exists())
        self.assertEqual(json.loads((self.root / 'catalog-state.json').read_text())['stoppedAfterCard'], 1)

    def test_boundary_request_survives_processing_failure(self):
        catalog.request_interrupt(self.state, self.job['name'], after_card=True)
        with patch.object(catalog, 'ensure_other_idle'), patch.object(catalog, 'ensure_exclusive_native'), \
                patch.object(catalog, 'verify_catalog', return_value=catalog.empty_manifest(self.job)), patch.object(catalog, 'check_capacity'), \
                patch.object(catalog, 'backend_for', return_value=self.backend), patch.object(catalog, 'backend_ready'), \
                patch.object(catalog, 'prepare_frozen', return_value=self.prepared), patch.object(catalog, 'cleanup_superseded'), \
                patch.object(catalog, 'run_execution', side_effect=RuntimeError('capture failed')):
            with self.assertRaisesRegex(RuntimeError, 'capture failed'):
                catalog.run(self.state, self.job['name'], 'host')
        self.assertTrue((self.root / 'stop-after-card.json').exists())

    def test_legacy_boundary_stops_at_an_already_published_active_card(self):
        execution = self.execution('host', 1)
        catalog.save_active_executions(self.state, self.job, [{'execution': execution}])
        atomic_json(self.root / 'stop-after-card.json', {'jobId': self.job['jobId']})
        publication = {**catalog.empty_manifest(self.job), 'videos': {'1': {'backend': 'host'}}}
        with patch.object(catalog, 'ensure_other_idle'), patch.object(catalog, 'ensure_exclusive_native'), \
                patch.object(catalog, 'verify_catalog', return_value=publication), patch.object(catalog, 'backend_for') as backend:
            self.assertEqual(catalog.run(self.state, self.job['name'], 'host'), 0)
        backend.assert_not_called()
        self.assertFalse((self.root / 'stop-after-card.json').exists())
        self.assertEqual(catalog.active_executions(self.state, self.job), [])
        self.assertEqual(catalog.status(self.state, self.job['name'])['stoppedAfterCard'], 1)
        self.assertFalse(catalog.execution_directory(self.state, self.job, 'host', 2).exists())

    def test_boundary_request_from_another_job_is_rejected(self):
        atomic_json(self.root / 'stop-after-card.json', {'jobId': 'different-job'})
        with patch.object(catalog, 'ensure_other_idle'), patch.object(catalog, 'ensure_exclusive_native'), \
                self.assertRaisesRegex(ValueError, 'belongs to another catalog'):
            catalog.run(self.state, self.job['name'], 'host')


if __name__ == '__main__':
    unittest.main()
