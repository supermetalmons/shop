import base64
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


DIRECTORY = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('mi_note_vm', DIRECTORY / 'vm.py')
vm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vm)


class VMTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.state = self.root / 'state'
        self.source = self.root / 'source.vbvm'
        (self.source / '.vbdata').mkdir(parents=True)
        for name in ['Disk.img', 'BuildData.img', 'AuxiliaryStorage', 'HardwareModel', 'MachineIdentifier']:
            (self.source / name).write_bytes(b'fixture')
        self.configuration = {'systemType': 'mac', 'hardware': {
            'cpuCount': 6, 'memorySize': 10 * 1024 ** 3,
            'networkDevices': [{'macAddress': '02:01:02:03:04:05'}],
            '_storageDevices': [{'isBootVolume': index == 0, 'backing': {'managedImage': {'_0': {'filename': name, 'format': 0}}}}
                                for index, name in enumerate(['Disk', 'BuildData'])],
        }}
        (self.source / '.vbdata/Config.plist').write_bytes(plistlib.dumps(self.configuration))
        self.credentials = self.root / 'source-access'
        self.credentials.mkdir(mode=0o700)
        self.password = self.credentials / 'password'
        self.password.write_bytes(b'fixture-password\n')
        self.password.chmod(0o600)
        key_type = b'ssh-ed25519'
        key = len(key_type).to_bytes(4, 'big') + key_type + (32).to_bytes(4, 'big') + b'a' * 32
        self.keys = self.credentials / 'known_hosts'
        self.keys.write_text('fixture-vm ssh-ed25519 ' + base64.b64encode(key).decode() + '\n')
        self.keys.chmod(0o600)
        self.machine = vm.VM(self.state)
        self.arguments = {
            'vm_path': self.source, 'guest_user': 'render-user', 'password_file': self.password,
            'known_hosts': self.keys, 'host_key_alias': 'fixture-vm', 'guest_root': '/Volumes/Render',
            'node': '/usr/local/bin/node', 'python': '/Volumes/Render/runtime/python/bin/python3',
            'ffmpeg': '/opt/homebrew/bin/ffmpeg', 'ffprobe': '/opt/homebrew/bin/ffprobe',
        }

    def tearDown(self):
        self.temporary.cleanup()

    def adopt(self, **extra):
        with patch.object(vm, 'ensure_idle'):
            return self.machine.adopt(**{**self.arguments, **extra})

    def test_adopt_is_independent_of_original_credentials(self):
        config = self.adopt()
        self.password.unlink()
        self.keys.unlink()
        self.assertEqual(vm.read_password(self.machine.config['passwordFile']), b'fixture-password')
        self.assertEqual(self.machine.config['vmPath'], str(self.source))
        self.assertEqual(config['guestRoot'], '/Volumes/Render')
        self.assertEqual(os.stat(self.state).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(config['passwordFile']).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(config['knownHostsFile']).st_mode & 0o777, 0o600)
        hardware = plistlib.loads((self.source / '.vbdata/Config.plist').read_bytes())['hardware']
        self.assertEqual((hardware['cpuCount'], hardware['memorySize']), (4, 8 * 1024 ** 3))

    def test_move_adoption_is_idempotent(self):
        first = self.adopt(move=True)
        self.assertFalse(self.source.exists())
        self.assertTrue((self.state / 'render.vbvm/Disk.img').exists())
        self.assertEqual(self.adopt(move=True), first)

    def test_failed_config_publication_restores_moved_vm(self):
        original = (self.source / '.vbdata/Config.plist').read_bytes()
        with patch.object(vm, 'ensure_idle'), patch.object(vm, 'atomic_json', side_effect=OSError('fixture write failure')):
            with self.assertRaises(OSError):
                self.machine.adopt(**self.arguments, move=True)
        self.assertTrue(self.source.exists())
        self.assertFalse((self.state / 'render.vbvm').exists())
        self.assertEqual((self.source / '.vbdata/Config.plist').read_bytes(), original)

    def test_busy_source_is_preserved(self):
        original = (self.source / '.vbdata/Config.plist').read_bytes()
        with patch.object(vm, 'ensure_idle', side_effect=RuntimeError('busy')):
            with self.assertRaisesRegex(RuntimeError, 'busy'):
                self.machine.adopt(**self.arguments, move=True)
        self.assertEqual((self.source / '.vbdata/Config.plist').read_bytes(), original)
        self.assertFalse((self.state / 'config.json').exists())

    def test_existing_config_refuses_different_credentials(self):
        config = self.adopt()
        self.password.write_bytes(b'different-fixture-password\n')
        with self.assertRaisesRegex(RuntimeError, 'another VM'):
            self.adopt()
        self.assertEqual(vm.read_password(config['passwordFile']), b'fixture-password')

    def test_symlink_and_public_password_are_rejected(self):
        linked = self.credentials / 'linked'
        linked.symlink_to(self.password)
        with self.assertRaisesRegex(RuntimeError, 'symlink'):
            self.adopt(password_file=linked)
        self.password.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'private'):
            self.adopt()

    def test_host_key_alias_must_match(self):
        with self.assertRaisesRegex(RuntimeError, 'selected alias'):
            self.adopt(host_key_alias='other-vm')

    def test_changed_vm_identity_is_rejected(self):
        self.adopt()
        path = self.source / '.vbdata/Config.plist'
        value = plistlib.loads(path.read_bytes())
        value['hardware']['networkDevices'][0]['macAddress'] = '02:01:02:03:04:06'
        path.write_bytes(plistlib.dumps(value))
        with self.assertRaisesRegex(RuntimeError, 'network identity changed'):
            self.machine.read_config()

    def test_ssh_disables_host_credentials_and_uses_pinned_identity(self):
        config = self.adopt()
        command = vm.ssh_command(config, '192.168.64.2')
        self.assertEqual(command[:4], ['/usr/bin/ssh', '-F', '/dev/null', '-T'])
        options = command[5:-4:2]
        for option in ['StrictHostKeyChecking=yes', 'IdentityAgent=none', 'UseKeychain=no', 'PubkeyAuthentication=no', 'ClearAllForwardings=yes', 'ForwardAgent=no', 'ProxyCommand=none', 'HostKeyAlias=fixture-vm']:
            self.assertIn(option, options)
        self.assertEqual(command[-4:], ['-l', 'render-user', '--', '192.168.64.2'])
        with self.assertRaises(RuntimeError):
            vm.ssh_command(config, '127.0.0.1')

    def leases(self, rows):
        path = self.root / 'leases'
        path.write_text('\n'.join('{\nip_address=' + address + '\nhw_address=1,' + mac + '\nlease=' + str(expiry) + '\n}' for mac, address, expiry in rows))
        return path

    def test_dhcp_requires_unambiguous_current_private_lease(self):
        mac = '02:01:02:03:04:05'
        path = self.leases([(mac, '192.168.64.2', 90), (mac, '192.168.64.3', 200)])
        self.assertEqual(vm.find_address(mac, path, now=100), '192.168.64.3')
        path = self.leases([(mac, '192.168.64.2', 200), (mac, '192.168.64.3', 200)])
        with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
            vm.find_address(mac, path, now=100)
        path = self.leases([(mac, '192.168.64.2', 200), ('02:01:02:03:04:06', '192.168.64.2', 200)])
        with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
            vm.find_address(mac, path, now=100)

    def record_running(self):
        config = self.adopt()
        record = {'version': 1, 'vmPath': config['vmPath'], 'launcher': {'pid': 200, 'start': 'fixture-start', 'command': 'fixture-command'}}
        vm.atomic_json(self.state / 'process.json', record)
        vm.atomic_json(self.state / 'vm-status.json', {'running': True, 'state': 'running', 'hostPID': 200, 'vmPath': config['vmPath']})

    def test_pid_reuse_cannot_claim_running_vm(self):
        self.record_running()
        with patch.object(self.machine, '_process_value', return_value='different-start'), patch.object(vm, 'find_address') as address:
            state = self.machine.status()
        self.assertFalse(state['running'])
        self.assertFalse(state['active'])
        address.assert_not_called()

    def test_framework_python_keeps_its_recorded_process_identity(self):
        script = self.root / 'identity-probe.py'
        script.write_text('import time; time.sleep(30)\n')
        command = [str(vm.python_executable()), str(script), 'argument with spaces']
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            record = self.machine._record_process(process, command)
            time.sleep(.2)
            self.assertTrue(self.machine._process_alive(record))
        finally:
            process.terminate()
            process.communicate(timeout=5)

    def test_status_binds_pid_start_command_and_vm_path(self):
        self.record_running()
        with patch.object(self.machine, '_process_value', side_effect=lambda pid, field: 'fixture-start' if field == 'lstart' else 'fixture-command'), patch.object(vm, 'find_address', return_value='192.168.64.3'):
            self.assertTrue(self.machine.status()['running'])
            value = json.loads((self.state / 'process.json').read_text())
            value['vmPath'] = str(self.root / 'another.vbvm')
            vm.atomic_json(self.state / 'process.json', value)
            self.assertFalse(self.machine.status()['active'])

    def test_boot_reuses_active_owned_session(self):
        self.adopt()
        state = {'active': True, 'running': True, 'state': 'running'}
        with patch.object(self.machine, 'status', return_value=state), patch.object(self.machine, 'build_launcher') as build:
            self.assertEqual(self.machine.boot(), state)
        build.assert_not_called()

    def test_stop_writes_marker_only_for_owned_active_vm(self):
        self.adopt()
        with patch.object(self.machine, 'status', return_value={'active': False, 'state': 'stopped'}):
            self.machine.stop()
        self.assertFalse((self.state / 'vm-stop').exists())
        with patch.object(self.machine, 'status', side_effect=[{'active': True}, {'active': False}]), patch.object(vm, 'ensure_idle'):
            self.machine.stop()
        self.assertTrue((self.state / 'vm-stop').is_file())

    def test_concurrent_lifecycle_is_rejected(self):
        with self.machine._lock():
            with self.assertRaisesRegex(RuntimeError, 'Another VM lifecycle'):
                with self.machine._lock():
                    self.fail('second lock unexpectedly acquired')

    def test_get_failure_keeps_existing_file_and_removes_partial(self):
        self.adopt()
        target = self.root / 'output.mp4'
        target.write_bytes(b'original')
        def fail(argv, **kwargs):
            kwargs['output_path'].write_bytes(b'incomplete')
            raise RuntimeError('interrupted')
        with patch.object(self.machine, '_ssh', side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                self.machine.get('/Volumes/Render/video.mp4', target)
        self.assertEqual(target.read_bytes(), b'original')
        self.assertFalse(list(self.root.glob('*.partial')))
        with patch.object(self.machine, '_ssh', side_effect=lambda argv, **kwargs: kwargs['output_path'].write_bytes(b'complete')):
            self.assertEqual(self.machine.get('/Volumes/Render/video.mp4', target), target)
        self.assertEqual(target.read_bytes(), b'complete')

    def run_upload(self, destination, payload, declared_payload):
        import hashlib
        return subprocess.run([sys.executable, '-c', vm.PUT_SCRIPT, str(destination), str(len(declared_payload)), hashlib.sha256(declared_payload).hexdigest()], input=payload, capture_output=True)

    def test_partial_or_corrupt_upload_never_replaces_guest_file(self):
        destination = self.root / 'guest-file'
        destination.write_bytes(b'original')
        for actual in [b'short', b'corrupt payload']:
            result = self.run_upload(destination, actual, b'expected payload')
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(destination.read_bytes(), b'original')
            self.assertFalse(list(self.root.glob('*.partial')))
        result = self.run_upload(destination, b'expected payload', b'expected payload')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(destination.read_bytes(), b'expected payload')

    def test_upload_rejects_symlink_destination(self):
        outside = self.root / 'outside'
        outside.write_bytes(b'original')
        destination = self.root / 'guest-file'
        destination.symlink_to(outside)
        self.assertNotEqual(self.run_upload(destination, b'new', b'new').returncode, 0)
        self.assertEqual(outside.read_bytes(), b'original')

    def test_exec_failure_redacts_password(self):
        self.adopt()
        class Child:
            pid = 200
            def wait(self, timeout=None):
                return 1
        def popen(command, **kwargs):
            kwargs['stderr'].write(b'failure fixture-password diagnostic')
            return Child()
        with patch.object(self.machine, 'status', return_value={'running': True, 'address': '192.168.64.3'}), patch.object(vm.subprocess, 'Popen', side_effect=popen):
            with self.assertRaisesRegex(RuntimeError, r'failure \[REDACTED\] diagnostic') as caught:
                self.machine.exec(['/usr/bin/false'])
        self.assertNotIn('fixture-password', str(caught.exception))

    def test_exec_timeout_terminates_only_its_ssh_process_group(self):
        self.adopt()
        class Child:
            pid = 200
            calls = 0
            def wait(self, timeout=None):
                self.calls += 1
                if self.calls == 1:
                    raise subprocess.TimeoutExpired('ssh', timeout)
                return -15
        with patch.object(self.machine, 'status', return_value={'running': True, 'address': '192.168.64.3'}), patch.object(vm.subprocess, 'Popen', return_value=Child()), patch.object(vm.os, 'killpg') as stop:
            with self.assertRaises(subprocess.TimeoutExpired):
                self.machine.exec(['/usr/bin/true'], timeout=1)
        stop.assert_called_once_with(200, vm.signal.SIGTERM)

    def test_doctor_persists_only_verified_guest_session(self):
        self.adopt()
        report = {'guestUID': 1001, 'guestUser': 'render-user', 'guestHome': '/Users/render-user', 'model': 'VirtualMac2,1',
                  'consoleUID': 1001, 'aqua': True, 'unlocked': True,
                  'versions': {**vm.RUNTIME_VERSIONS, 'ffmpeg': 'ffmpeg version 8.1.2 fixture', 'ffprobe': 'ffprobe version 8.1.2 fixture',
                               'safari': 'Included with Safari 27.0.1 (22625.1.29.11.28)'}}
        with patch.object(self.machine, 'exec', return_value=json.dumps({**report, 'unlocked': False}).encode()):
            self.assertFalse(self.machine.doctor()['passed'])
        self.assertNotIn('guestUID', self.machine.config)
        with patch.object(self.machine, 'exec', return_value=json.dumps(report).encode()):
            self.assertTrue(self.machine.doctor()['passed'])
        self.assertEqual(self.machine.config['guestUID'], 1001)
        self.assertEqual(self.machine.config['guestHome'], '/Users/render-user')


if __name__ == '__main__':
    unittest.main()
