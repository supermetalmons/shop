import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import backends
from backends import Host, copy_verified, extract_runtime, runtime_files, setup_host_runtime, verify_runtime
from jobs import CONTRACT


class BackendTests(unittest.TestCase):
    def state(self, temporary):
        state = Path(temporary).resolve() / 'private state'
        state.mkdir(mode=0o700)
        return state

    def runtime(self, state):
        (state / 'host').mkdir(mode=0o700)
        root = state / 'host/runtime'
        for name in ('node/bin/node', 'python/bin/python3.12', 'media/bin/ffmpeg', 'media/bin/ffprobe'):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('#!/bin/sh\nexit 0\n')
            path.chmod(0o700)
        (root / 'runtime.json').write_text(json.dumps({'version': 1, 'contract': CONTRACT['runtime'], 'files': runtime_files(root)}))
        return root

    def test_adapter_exec_and_safe_verified_transfers(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = self.state(temporary)
            host = Host(state)
            self.assertEqual(host.exec(['/bin/cat'], input_bytes=b'render'), b'render')
            with self.assertRaisesRegex(RuntimeError, 'privileged'):
                host.exec(['/bin/true'], sudo=True)
            with self.assertRaisesRegex(RuntimeError, 'Host command failed'):
                host.exec(['/bin/sh', '-c', 'printf failure >&2; exit 1'])
            with self.assertRaises(subprocess.TimeoutExpired):
                host.exec(['/bin/sleep', '2'], timeout=.01)
            source, destination = state / 'source', state / 'destination'
            source.write_bytes(b'card pixels')
            self.assertEqual(host.put(source, str(destination)), str(destination))
            self.assertEqual(destination.read_bytes(), source.read_bytes())
            self.assertEqual(host.get(str(destination), source), source)
            self.assertEqual(copy_verified(source, source), source)
            link = state / 'link'
            link.symlink_to(source)
            with self.assertRaisesRegex(RuntimeError, 'symlinks'):
                host.put(link, destination)
            with self.assertRaisesRegex(RuntimeError, 'symlinks'):
                host.get(source, link)

    def test_failed_copy_preserves_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = self.state(temporary)
            source, destination = state / 'source', state / 'destination'
            source.write_bytes(b'new')
            destination.write_bytes(b'old')
            with patch.object(backends, 'sha256', side_effect=['expected', 'different']):
                with self.assertRaisesRegex(RuntimeError, 'checksum'):
                    copy_verified(source, destination)
            self.assertEqual(destination.read_bytes(), b'old')
            self.assertEqual(sorted(path.name for path in state.iterdir()), ['destination', 'source'])

    def test_timeout_stops_descendants_after_the_direct_child_exits(self):
        source = '''import os,signal,subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1]);(root/'group').write_text(str(os.getpid()))
descendant="""import os,signal,sys,time
from pathlib import Path
def stopped(*args):
 if sys.argv[2]=='delay':
  time.sleep(.05)
  raise SystemExit(0)
signal.signal(signal.SIGTERM,stopped)
Path(sys.argv[1]).write_text(str(os.getpid()))
while True: time.sleep(1)
"""
subprocess.Popen([sys.executable,'-c',descendant,str(root/'descendant'),sys.argv[2]])
while True: time.sleep(1)
'''
        stop = backends.stop_process_group
        for behavior in ('ignore', 'delay'):
            with self.subTest(behavior=behavior), tempfile.TemporaryDirectory() as temporary:
                state = self.state(temporary)
                try:
                    with patch.object(backends, 'stop_process_group', side_effect=lambda child: stop(child, .2)), \
                            self.assertRaises(subprocess.TimeoutExpired):
                        Host(state).exec([sys.executable, '-c', source, str(state), behavior], timeout=1)
                    descendant = int((state / 'descendant').read_text())
                    group = int((state / 'group').read_text())
                    with self.assertRaises(ProcessLookupError):
                        os.kill(descendant, 0)
                    with self.assertRaises(ProcessLookupError):
                        os.killpg(group, 0)
                finally:
                    if (state / 'group').exists():
                        try:
                            os.killpg(int((state / 'group').read_text()), signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    def test_group_cleanup_preserves_the_original_error_when_parent_already_exited(self):
        original = backends.subprocess.Popen.communicate
        def interrupted(child, *args, **kwargs):
            original(child, *args, **kwargs)
            raise InterruptedError('interrupted after exit')
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(backends.subprocess.Popen, 'communicate', interrupted), \
                self.assertRaisesRegex(InterruptedError, 'interrupted after exit'):
            Host(self.state(temporary)).exec([sys.executable, '-c', 'pass'])

    def test_group_cleanup_waits_for_absence_after_a_denied_probe(self):
        child = Mock(pid=12345)
        with patch.object(backends.os, 'killpg', side_effect=[None, PermissionError(), ProcessLookupError()]) as signal_group, \
                patch.object(backends.time, 'sleep'):
            backends.stop_process_group(child)
        self.assertEqual(child.poll.call_count, 2)
        self.assertEqual([item.args[1] for item in signal_group.call_args_list], [signal.SIGTERM, 0, 0])

    def test_host_config_and_runtime_integrity(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = self.state(temporary)
            host = Host(state)
            with self.assertRaisesRegex(RuntimeError, 'not prepared'):
                host.config
            root = self.runtime(state)
            config = host.config
            self.assertEqual(config['guestRoot'], str(state / 'host'))
            self.assertEqual(config['guestUID'], os.getuid())
            self.assertEqual(host.config, config)
            verify_runtime(root)
            (root / 'node/bin/node').write_text('changed')
            with self.assertRaisesRegex(RuntimeError, 'executable changed'):
                host.config
            with self.assertRaisesRegex(RuntimeError, 'integrity'):
                verify_runtime(root)

    def test_setup_reuses_verified_runtime_without_vm(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = self.state(temporary)
            self.runtime(state)
            with patch('prepare.inspect_runtime', return_value={'fixture': True}) as inspected, patch.object(backends, 'VM') as vm:
                first = setup_host_runtime(state)
                second = setup_host_runtime(state)
            self.assertEqual(first, second)
            self.assertEqual(inspected.call_count, 2)
            vm.assert_not_called()

    def test_runtime_archive_rejects_escape_and_symlink_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = self.state(temporary)
            for name, target in [('../escape', None), ('python/link', '/tmp'), ('python/link', '../../../outside')]:
                archive = state / 'runtime.tar'
                with tarfile.open(archive, 'w') as stream:
                    member = tarfile.TarInfo(name)
                    if target:
                        member.type, member.linkname = tarfile.SYMTYPE, target
                        stream.addfile(member)
                    else:
                        member.size = 1
                        stream.addfile(member, io.BytesIO(b'x'))
                with self.assertRaisesRegex(RuntimeError, 'archive'):
                    extract_runtime(archive, state)
            with tarfile.open(archive, 'w') as stream:
                member = tarfile.TarInfo('python/link')
                member.type, member.linkname = tarfile.SYMTYPE, 'safe'
                stream.addfile(member)
                member = tarfile.TarInfo('python/link/nested')
                stream.addfile(member, io.BytesIO(b''))
            with self.assertRaisesRegex(RuntimeError, 'traverses a symlink'):
                extract_runtime(archive, state)


if __name__ == '__main__':
    unittest.main()
