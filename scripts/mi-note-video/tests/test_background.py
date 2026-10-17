import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import background


class BackgroundTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name).resolve()
        self.state = self.base / 'private renderer state'
        self.job = {'name': 'background-fixture', 'jobId': '0affc5fb-4b54-4315-b641-bc6294287e4f'}
        self.root = self.state / 'jobs' / self.job['name']
        self.root.mkdir(parents=True)
        self.root.chmod(0o700)
        self.source = self.state / 'releases' / 'pinned source'
        self.source.mkdir(parents=True)
        self.python = self.base / 'runtime' / 'python3'
        self.domain = f'gui/{os.getuid()}'
        self.service = self.domain + '/' + background.label_for(self.job)
        self.plist = self.root / 'host-agent.plist'
        self.calls = []
        self.print_result = subprocess.CompletedProcess([], 113, stdout='', stderr='Not found')
        self.patches = [patch.object(background.sys, 'platform', 'darwin'),
                        patch.object(background, 'python_executable', return_value=self.python),
                        patch.dict(background.os.environ, {'MI_NOTE_FFMPEG': str(self.base / 'ffmpeg'),
                                                           'MI_NOTE_FFPROBE': str(self.base / 'ffprobe'),
                                                           'UNRELATED_SECRET': 'not inherited'}, clear=True),
                        patch.object(background.subprocess, 'run', side_effect=self.launchctl)]
        for pending in self.patches:
            pending.start()

    def tearDown(self):
        for pending in reversed(self.patches):
            pending.stop()
        self.temporary.cleanup()

    def launchctl(self, command, **kwargs):
        self.assertEqual(command[0], '/bin/launchctl')
        self.calls.append(command)
        if command[1] == 'print':
            return self.print_result
        return subprocess.CompletedProcess(command, 0, stdout='', stderr='')

    def existing(self, state='exited', path=None, label=None, source=None):
        self.plist.write_bytes(plistlib.dumps({'Label': label or background.label_for(self.job),
                                             'WorkingDirectory': str(source or self.source)}))
        self.print_result = subprocess.CompletedProcess([], 0,
                                                       stdout=f'path = {path or self.plist}\nstate = {state}\n', stderr='')

    def test_launch_is_explicit_nonrestarting_and_uses_private_job_paths(self):
        result = background.launch(self.state, self.job, self.source, 'host', 166)
        value = plistlib.loads(self.plist.read_bytes())
        self.assertIs(value['RunAtLoad'], False)
        self.assertIs(value['KeepAlive'], False)
        self.assertEqual(value['LimitLoadToSessionType'], 'Aqua')
        self.assertEqual(value['ProgramArguments'], ['/usr/bin/caffeinate', '-di', str(self.python),
                                                   str(self.source / 'scripts/mi-note-video/cli.py'), '--state', str(self.state),
                                                   'resume', self.job['name'], '--backend', 'host', '--from-id', '166'])
        self.assertEqual(value['WorkingDirectory'], str(self.source))
        self.assertEqual(value['StandardOutPath'], str(self.root / 'host.log'))
        self.assertEqual(value['StandardErrorPath'], str(self.root / 'host.log'))
        self.assertEqual(self.plist.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.calls, [['/bin/launchctl', 'print', self.service],
                                     ['/bin/launchctl', 'bootstrap', self.domain, str(self.plist)],
                                     ['/bin/launchctl', 'kickstart', self.service]])
        self.assertNotIn('LaunchAgents', str(self.plist))
        self.assertFalse(any('enable' in command or 'load' in command for command in self.calls))
        self.assertIs(result['automaticRestart'], False)
        record = json.loads((self.root / 'background.json').read_text())
        self.assertEqual(record['command'], value['ProgramArguments'])
        self.assertEqual(record['service'], self.service)
        self.assertEqual(record['log'], str(self.root / 'host.log'))
        environment = value['EnvironmentVariables']
        self.assertNotIn('UNRELATED_SECRET', environment)
        self.assertEqual(environment['MI_NOTE_FFMPEG'], str(self.base / 'ffmpeg'))
        self.assertEqual(environment['MI_NOTE_FFPROBE'], str(self.base / 'ffprobe'))
        self.assertEqual(environment['PYTHONNOUSERSITE'], '1')
        self.assertEqual(environment['MI_NOTE_RESUME_JOB_ID'], self.job['jobId'])

    def test_vm_launch_keeps_host_awake_without_holding_display_awake(self):
        background.launch(self.state, self.job, self.source, 'vm')
        arguments = plistlib.loads(self.plist.read_bytes())['ProgramArguments']
        self.assertEqual(arguments[:2], ['/usr/bin/caffeinate', '-i'])
        self.assertEqual(arguments[-2:], ['--backend', 'vm'])
        self.assertNotIn('--background', arguments)

    def test_running_service_is_not_replaced_or_restarted(self):
        self.existing(state='running')
        previous = self.plist.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'already running'):
            background.launch(self.state, self.job, self.source, 'host')
        self.assertEqual(self.plist.read_bytes(), previous)
        self.assertEqual(self.calls, [['/bin/launchctl', 'print', self.service]])
        self.assertFalse((self.root / 'background.json').exists())

    def test_foreign_directory_is_not_unloaded(self):
        self.existing(path=self.base / 'other.plist')
        with self.assertRaisesRegex(RuntimeError, 'another directory'):
            background.launch(self.state, self.job, self.source, 'host')
        self.assertEqual(self.calls, [['/bin/launchctl', 'print', self.service]])

    def test_foreign_label_or_source_is_not_unloaded(self):
        for key, value in [('label', 'other.owner'), ('source', self.base / 'other-release')]:
            with self.subTest(key=key):
                self.calls.clear()
                self.existing(**{key: value})
                with self.assertRaisesRegex(RuntimeError, 'another owner'):
                    background.launch(self.state, self.job, self.source, 'host')
                self.assertEqual(self.calls, [['/bin/launchctl', 'print', self.service]])

    def test_owned_exited_service_is_replaced_before_manual_restart(self):
        self.existing()
        background.launch(self.state, self.job, self.source, 'host')
        self.assertEqual(self.calls, [['/bin/launchctl', 'print', self.service],
                                     ['/bin/launchctl', 'bootout', self.service],
                                     ['/bin/launchctl', 'bootstrap', self.domain, str(self.plist)],
                                     ['/bin/launchctl', 'kickstart', self.service]])

    def test_recorded_controller_upgrade_replaces_only_owned_exited_service(self):
        prior_id = 'a' * 64
        prior = self.state / 'releases' / prior_id
        self.existing(source=prior)
        (self.root / 'job-meta.json').write_text(json.dumps({'job': self.job, 'controllerHistory': [prior_id]}))
        background.launch(self.state, self.job, self.source, 'host')
        self.assertEqual(plistlib.loads(self.plist.read_bytes())['WorkingDirectory'], str(self.source))
        self.assertIn(['/bin/launchctl', 'bootout', self.service], self.calls)

    def test_controller_history_from_another_job_is_rejected(self):
        self.existing()
        (self.root / 'job-meta.json').write_text(json.dumps({'job': {'jobId': 'other'}, 'controllerHistory': []}))
        with self.assertRaisesRegex(RuntimeError, 'another job'):
            background.launch(self.state, self.job, self.source, 'host')
        self.assertFalse(any('bootout' in command for command in self.calls))

    def test_missing_media_tool_fails_before_registration(self):
        with patch.dict(background.os.environ, {}, clear=True), patch.object(background.shutil, 'which', return_value=None), \
                self.assertRaisesRegex(RuntimeError, 'FFMPEG is required'):
            background.launch(self.state, self.job, self.source, 'host')
        self.assertEqual(self.calls, [['/bin/launchctl', 'print', self.service]])
        self.assertFalse(self.plist.exists())

    def test_nonmacos_rejected_without_launchctl(self):
        with patch.object(background.sys, 'platform', 'linux'), self.assertRaisesRegex(RuntimeError, 'requires macOS'):
            background.launch(self.state, self.job, self.source, 'host')
        self.assertFalse(self.calls)

    def test_symlink_service_definition_never_overwrites_target(self):
        target = self.base / 'unrelated.plist'
        target.write_bytes(b'preserve')
        self.plist.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'symbolic link'):
            background.launch(self.state, self.job, self.source, 'host')
        self.assertEqual(target.read_bytes(), b'preserve')
        self.assertEqual(self.calls, [['/bin/launchctl', 'print', self.service]])

    def test_bootstrap_failure_is_not_reported_as_launched(self):
        def fail_bootstrap(command, **kwargs):
            result = self.launchctl(command, **kwargs)
            if command[1] == 'bootstrap':
                raise subprocess.CalledProcessError(1, command)
            return result

        with patch.object(background.subprocess, 'run', side_effect=fail_bootstrap), self.assertRaises(subprocess.CalledProcessError):
            background.launch(self.state, self.job, self.source, 'host')
        self.assertFalse((self.root / 'background.json').exists())
        self.assertFalse(any(command[1] == 'kickstart' for command in self.calls))

    def test_control_command_is_private_and_uses_pinned_cli_for_all_actions(self):
        path = background.write_control(self.state, self.job, self.source)
        value = path.read_text()
        self.assertEqual(path, self.root / 'control.command')
        self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        self.assertIn(str(self.source / 'scripts/mi-note-video/cli.py'), value)
        self.assertIn('resume ' + self.job['name'] + ' --background "$@"', value)
        self.assertIn('status|interrupt)', value)
        self.assertNotIn('LaunchAgents', value)
        self.assertNotIn('kickstart', value)
        self.assertFalse(self.calls)

    def test_symlink_control_does_not_overwrite_unrelated_file(self):
        target = self.base / 'unrelated-command'
        target.write_text('preserve')
        (self.root / 'control.command').symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'symbolic link'):
            background.write_control(self.state, self.job, self.source)
        self.assertEqual(target.read_text(), 'preserve')


if __name__ == '__main__':
    unittest.main()
