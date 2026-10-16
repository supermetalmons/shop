import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIRECTORY))
SPEC = importlib.util.spec_from_file_location('mi_note_video_cli', DIRECTORY / 'cli.py')
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)
VALIDATE_SPEC = importlib.util.spec_from_file_location('mi_note_video_validate', DIRECTORY / 'validate.py')
validation = importlib.util.module_from_spec(VALIDATE_SPEC)
VALIDATE_SPEC.loader.exec_module(validation)


class LocalGuest:
    def __init__(self):
        self.config = {'python': sys.executable}

    def exec(self, argv, input_bytes=None, timeout=180):
        if argv[:2] != [sys.executable, '-c']:
            raise AssertionError('Only the embedded fixture Python script may execute')
        result = subprocess.run(argv, input=input_bytes, capture_output=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(result.stderr.decode())
        return result.stdout


class CLITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.config = {'guestRoot': str(self.root / 'guest'), 'python': '/runtime/python', 'node': '/runtime/node'}
        self.prepared = {'sourceId': 'a' * 64, 'guestSourceRoot': str(self.root / 'release'), 'runtime': {'versions': {'node': '24.22.0'}}, 'catalogCount': 1430}
        self.job = cli.create_job('fixture', [312, 904], cli.CONTRACT['defaults']['profile'], cli.CONTRACT['defaults']['motion'], self.prepared, self.config)
        self.metadata = {'version': 1, 'job': self.job, 'output': str(self.root / 'output'), 'evidence': str(self.root / 'evidence')}
        self.vm = SimpleNamespace(state=self.state, config=self.config)

    def tearDown(self):
        self.temporary.cleanup()

    def status(self, attempt='new', status='complete', **extra):
        return {'jobId': self.job['jobId'], 'sourceId': self.job['sourceId'], 'attempt': attempt, 'status': status, **extra}

    def test_read_status_ignores_old_terminal_attempt(self):
        for terminal in ['complete', 'failed', 'interrupted']:
            with self.subTest(terminal=terminal), patch.object(cli, 'remote_json', return_value=self.status('old', terminal)):
                self.assertIsNone(cli.read_current_status(self.vm, self.job, previous_attempt='old'))
        current = self.status('new', 'rendering')
        with patch.object(cli, 'remote_json', return_value=current):
            self.assertEqual(cli.read_current_status(self.vm, self.job, previous_attempt='old'), current)

    def test_read_status_accepts_existing_running_attempt(self):
        current = self.status('existing', 'awaiting-host')
        with patch.object(cli, 'remote_json', return_value=current):
            self.assertEqual(cli.read_current_status(self.vm, self.job), current)

    def test_read_status_rejects_wrong_identity_before_attempt_filter(self):
        for field in ['jobId', 'sourceId']:
            with self.subTest(field=field), patch.object(cli, 'remote_json', return_value=self.status('old', **{field: 'different'})):
                with self.assertRaisesRegex(ValueError, 'another immutable job'):
                    cli.read_current_status(self.vm, self.job, previous_attempt='old')

    def test_supervise_waits_for_new_attempt_before_collection(self):
        for terminal in ['complete', 'failed', 'interrupted']:
            collector = Mock(return_value={'collected': len(self.job['ids'])})
            with self.subTest(terminal=terminal), patch.dict(sys.modules, {'collect': SimpleNamespace(collect=collector)}), \
                    patch.object(cli, 'remote_json', side_effect=[self.status('old', terminal), self.status('new')]), \
                    patch.object(cli.signal, 'signal', return_value=signal.SIG_DFL), patch.object(cli.time, 'sleep') as sleep, \
                    patch.object(cli, 'atomic_json') as save, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.supervise(self.vm, self.state, self.job, self.metadata, previous_attempt='old'), 0)
                collector.assert_called_once()
                sleep.assert_called_once_with(1)
                self.assertEqual(save.call_args.args[1]['attempt'], 'new')

    def test_stale_attempt_times_out_without_publishing(self):
        collector = Mock()
        with patch.dict(sys.modules, {'collect': SimpleNamespace(collect=collector)}), \
                patch.object(cli, 'remote_json', return_value=self.status('old')), \
                patch.object(cli.signal, 'signal', return_value=signal.SIG_DFL), \
                patch.object(cli.time, 'monotonic', side_effect=[0, 31]):
            with self.assertRaisesRegex(RuntimeError, 'did not publish a new attempt'):
                cli.supervise(self.vm, self.state, self.job, self.metadata, previous_attempt='old')
        collector.assert_not_called()

    def test_supervise_retries_only_collector_contention(self):
        collector = Mock(side_effect=[RuntimeError('Another collector owns this host output'), {'collected': len(self.job['ids'])}])
        with patch.dict(sys.modules, {'collect': SimpleNamespace(collect=collector)}), \
                patch.object(cli, 'remote_json', return_value=self.status()), \
                patch.object(cli.signal, 'signal', return_value=signal.SIG_DFL), \
                patch.object(cli.time, 'sleep') as sleep, patch.object(cli, 'atomic_json') as save, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.supervise(self.vm, self.state, self.job, self.metadata), 0)
        self.assertEqual(collector.call_count, 2)
        sleep.assert_called_once_with(1)
        save.assert_called_once()

    def test_supervise_preserves_verification_failures(self):
        for message in ['Video checksum changed', 'Another collector owns this host output: unrelated verification failure']:
            collector = Mock(side_effect=RuntimeError(message))
            with self.subTest(message=message), patch.dict(sys.modules, {'collect': SimpleNamespace(collect=collector)}), \
                    patch.object(cli, 'remote_json', return_value=self.status()), \
                    patch.object(cli.signal, 'signal', return_value=signal.SIG_DFL), \
                    patch.object(cli.time, 'sleep') as sleep:
                with self.assertRaises(RuntimeError) as caught:
                    cli.supervise(self.vm, self.state, self.job, self.metadata)
                self.assertEqual(str(caught.exception), message)
                collector.assert_called_once()
                sleep.assert_not_called()

    def assert_work_locked(self):
        with self.assertRaisesRegex(RuntimeError, 'Another rendering command owns this VM'):
            with cli.exclusive_work(self.vm):
                self.fail('A second work owner acquired the VM')

    def test_work_lock_is_exclusive_and_releases_on_error(self):
        with self.assertRaisesRegex(ValueError, 'fixture failure'):
            with cli.exclusive_work(self.vm):
                self.assert_work_locked()
                raise ValueError('fixture failure')
        with cli.exclusive_work(self.vm):
            self.assertEqual(os.stat(self.state / '.work.lock').st_mode & 0o777, 0o600)

    def test_work_lock_releases_when_owner_process_dies(self):
        script = "import sys,time;from pathlib import Path;from types import SimpleNamespace;sys.path.insert(0,sys.argv[1]);from cli import exclusive_work\nwith exclusive_work(SimpleNamespace(state=Path(sys.argv[2]))):\n print('locked',flush=True)\n time.sleep(30)\n"
        process = subprocess.Popen([sys.executable, '-c', script, str(DIRECTORY), str(self.state)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            with selectors.DefaultSelector() as selected:
                selected.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(selected.select(timeout=10), 'Fixture lock owner did not start')
            self.assertEqual(process.stdout.readline(), b'locked\n')
            self.assert_work_locked()
        finally:
            process.terminate()
            process.communicate(timeout=5)
        with cli.exclusive_work(self.vm):
            pass

    def test_work_lock_rejects_symlink_and_nonprivate_file(self):
        target = self.root / 'untouched'
        target.write_bytes(b'untouched')
        lock = self.state / '.work.lock'
        lock.symlink_to(target)
        with self.assertRaises(OSError):
            with cli.exclusive_work(self.vm):
                self.fail('A symbolic-link work lock was accepted')
        self.assertEqual(target.read_bytes(), b'untouched')
        lock.unlink()
        lock.write_bytes(b'')
        lock.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'private regular file'):
            with cli.exclusive_work(self.vm):
                self.fail('A nonprivate work lock was accepted')

    def test_run_and_resume_hold_work_lock_for_supervision(self):
        def work(vm, args):
            self.assert_work_locked()
            return 7
        for command in ['run', 'resume']:
            with self.subTest(command=command), patch.object(cli, '_run_job', side_effect=work):
                self.assertEqual(cli.run_job(self.vm, SimpleNamespace(command=command)), 7)
        with cli.exclusive_work(self.vm):
            pass

    def test_prepare_command_holds_work_lock(self):
        def work(vm, state):
            self.assert_work_locked()
            return {'prepared': True}
        with patch.object(cli, 'VM', return_value=self.vm), patch.object(cli, 'ready'), \
                patch.object(cli, 'assert_idle'), patch.object(cli, 'prepare', side_effect=work), \
                patch.object(sys, 'argv', ['cli.py', 'prepare']), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(), 0)
        with cli.exclusive_work(self.vm):
            pass

    def test_validation_holds_work_lock_through_final_shutdown(self):
        self.vm.stop = Mock(side_effect=self.assert_work_locked)
        with patch.object(validation, 'VM', return_value=self.vm), patch.object(validation, 'ready'), \
                patch.object(validation, 'assert_idle'), patch.object(validation, 'prepare', return_value=self.prepared), \
                patch.object(validation, 'CONTRACT', {'profiles': {'1980': {}}, 'motions': ['breathing-swing']}), \
                patch.object(validation, 'task', side_effect=RuntimeError('fixture validation failed')), \
                patch.object(sys, 'argv', ['validate.py', '--no-reboot']), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'fixture validation failed'):
                validation.main()
        self.vm.stop.assert_called_once()
        with cli.exclusive_work(self.vm):
            pass

    def test_missing_guest_job_is_recreated_and_repeat_is_idempotent(self):
        guest = LocalGuest()
        cli.ensure_guest_job(guest, self.job)
        path = Path(self.job['root']) / 'job.json'
        self.assertEqual(json.loads(path.read_text()), self.job)
        original = path.read_bytes()
        cli.ensure_guest_job(guest, self.job)
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse(list(path.parent.glob('*.pending')))

    def test_existing_identical_guest_job_bytes_are_preserved(self):
        root = Path(self.job['root'])
        root.mkdir(parents=True)
        path = root / 'job.json'
        original = json.dumps(self.job, separators=(',', ':')).encode()
        path.write_bytes(original)
        cli.ensure_guest_job(LocalGuest(), self.job)
        self.assertEqual(path.read_bytes(), original)

    def test_conflicting_guest_job_is_preserved(self):
        root = Path(self.job['root'])
        root.mkdir(parents=True)
        path = root / 'job.json'
        original = json.dumps({**self.job, 'jobId': 'different'}).encode()
        path.write_bytes(original)
        with self.assertRaisesRegex(RuntimeError, 'Existing guest job identity differs'):
            cli.ensure_guest_job(LocalGuest(), self.job)
        self.assertEqual(path.read_bytes(), original)

    def test_orphaned_guest_work_prevents_identity_recreation(self):
        root = Path(self.job['root'])
        root.mkdir(parents=True)
        for name in ['job-status.json', 'cards']:
            path = root / name
            if name == 'cards':
                path.mkdir()
            else:
                path.write_text('{}')
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'Guest work exists without its immutable job identity'):
                cli.ensure_guest_job(LocalGuest(), self.job)
            self.assertFalse((root / 'job.json').exists())
            path.rmdir() if path.is_dir() else path.unlink()

    def test_guest_initialization_reply_must_match_job(self):
        guest = SimpleNamespace(config={'python': '/runtime/python'}, exec=Mock(return_value=b'{"jobId":"different","ready":true}'))
        with self.assertRaisesRegex(RuntimeError, 'another identity'):
            cli.ensure_guest_job(guest, self.job)
        self.assertEqual(json.loads(guest.exec.call_args.kwargs['input_bytes']), self.job)

    def save_local_job(self, include_secondary=False):
        directory = cli.paths(self.state, self.job['name'])
        directory.mkdir(parents=True)
        (directory / 'job-meta.json').write_text(json.dumps(self.metadata))
        if include_secondary:
            (directory / 'job.json').write_text(json.dumps(self.job))

    def test_resume_repairs_dispatch_without_repreparing_sources(self):
        self.save_local_job()
        args = SimpleNamespace(command='resume', job=self.job['name'])
        with patch.object(cli, 'ready'), patch.object(cli, 'prepare') as prepare, \
                patch.object(cli, 'inspect_runtime', return_value=self.job['runtime']), \
                patch.object(cli, 'ensure_guest_job') as ensure, patch.object(cli, 'service_running', return_value=False), \
                patch.object(cli, 'read_current_status', return_value=self.status('old', 'failed')), \
                patch.object(cli, 'launch') as launch, patch.object(cli, 'supervise', return_value=0) as supervise:
            self.assertEqual(cli.run_job(self.vm, args), 0)
            ensure.assert_called_once_with(self.vm, self.job)
            launch.assert_called_once()
            prepare.assert_not_called()
            self.assertEqual(supervise.call_args.args[-1], 'old')

    def test_resume_attaches_to_current_service_without_new_attempt_gate(self):
        self.save_local_job(include_secondary=True)
        args = SimpleNamespace(command='resume', job=self.job['name'])
        with patch.object(cli, 'ready'), patch.object(cli, 'inspect_runtime', return_value=self.job['runtime']), \
                patch.object(cli, 'ensure_guest_job'), patch.object(cli, 'service_running', return_value=True), \
                patch.object(cli, 'read_current_status') as status, patch.object(cli, 'launch') as launch, \
                patch.object(cli, 'supervise', return_value=0) as supervise:
            self.assertEqual(cli.run_job(self.vm, args), 0)
            status.assert_not_called()
            launch.assert_not_called()
            self.assertIsNone(supervise.call_args.args[-1])


if __name__ == '__main__':
    unittest.main()
