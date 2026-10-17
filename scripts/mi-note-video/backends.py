import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile
import time
import uuid

from jobs import CONTRACT
from vm import DEFAULT_STATE, DOCTOR_SCRIPT, VM, absolute, atomic_json, private_directory, regular, sha256


def backend_kind(backend):
    return 'host' if getattr(backend, 'kind', None) == 'host' else 'vm'


def stop_process_group(child, grace_seconds=5):
    for termination in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(child.pid, termination)
        except ProcessLookupError:
            child.wait(timeout=grace_seconds)
            return
        deadline = time.monotonic() + grace_seconds
        while True:
            child.poll()
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                return
            except PermissionError:
                pass
            if time.monotonic() >= deadline:
                break
            time.sleep(.025)
    raise RuntimeError('Host command process group did not stop after termination.')


def copy_verified(source, destination):
    source, destination = regular(source), absolute(destination)
    if source == destination:
        return destination
    if destination.exists():
        regular(destination)
    expected = sha256(source)
    descriptor, name = tempfile.mkstemp(prefix='.' + destination.name + '-', suffix='.partial', dir=destination.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, 'rb') as stream:
                before = os.fstat(stream.fileno())
                if not stat.S_ISREG(before.st_mode):
                    raise RuntimeError('Host transfers require regular files.')
                shutil.copyfileobj(stream, output, 1024 * 1024)
                after = os.fstat(stream.fileno())
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise RuntimeError('Host source changed during transfer.')
            output.flush()
            os.fsync(output.fileno())
        if sha256(temporary) != expected or sha256(source) != expected:
            raise RuntimeError('Host transfer checksum differs.')
        os.replace(temporary, destination)
        descriptor = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return destination
    finally:
        temporary.unlink(missing_ok=True)


def runtime_files(root):
    files = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        if '__pycache__' in relative.parts or path.suffix == '.pyc' or relative.as_posix() == 'runtime.json':
            continue
        if path.is_symlink():
            if not path.resolve().is_relative_to(root):
                raise RuntimeError('Private runtime symlink escapes its directory.')
            files[relative.as_posix()] = {'symlink': os.readlink(path)}
        elif path.is_file():
            files[relative.as_posix()] = {'sha256': sha256(path)}
    return files


def verify_runtime(root):
    root = absolute(root)
    receipt = json.loads(regular(root / 'runtime.json').read_text())
    if receipt.get('version') != 1 or receipt.get('contract') != CONTRACT['runtime']:
        raise RuntimeError('Private host runtime contract differs; rerun host setup.')
    if receipt.get('files') != runtime_files(root):
        raise RuntimeError('Private host runtime files failed their integrity check.')
    return receipt


class Host:
    kind = 'host'

    def __init__(self, state=None):
        self.state = absolute(DEFAULT_STATE if state is None else state)
        self._checked_config = None

    @property
    def config(self):
        return self.read_config()

    def read_config(self):
        private_directory(self.state)
        root = self.state / 'host'
        runtime = root / 'runtime'
        receipt_path = runtime / 'runtime.json'
        if not receipt_path.is_file():
            raise RuntimeError('Private host runtime is not prepared; run setup --backend host.')
        receipt_path = regular(receipt_path)
        receipt_stat = receipt_path.stat()
        signature = (receipt_stat.st_ino, receipt_stat.st_size, receipt_stat.st_mtime_ns, receipt_stat.st_ctime_ns)
        if self._checked_config:
            previous, config, executable_stats = self._checked_config
            if previous == signature and all(self._executable_stat(config[name]) == expected for name, expected in executable_stats.items()):
                return dict(config)
        receipt = json.loads(receipt_path.read_text())
        if receipt.get('contract') != CONTRACT['runtime'] or receipt.get('version') != 1:
            raise RuntimeError('Private host runtime contract differs.')
        account = pwd.getpwuid(os.getuid())
        config = {'version': 1, 'backend': 'host', 'guestRoot': str(root), 'guestUID': os.getuid(),
                  'guestUser': account.pw_name, 'guestHome': account.pw_dir,
                  'node': str(runtime / 'node/bin/node'), 'python': str(runtime / 'python/bin/python3.12'),
                  'ffmpeg': str(runtime / 'media/bin/ffmpeg'), 'ffprobe': str(runtime / 'media/bin/ffprobe')}
        for name in ('node', 'python', 'ffmpeg', 'ffprobe'):
            path = regular(config[name])
            record = receipt.get('files', {}).get(path.relative_to(runtime).as_posix(), {})
            if not os.access(path, os.X_OK) or record.get('sha256') != sha256(path):
                raise RuntimeError('Private host executable changed: ' + name)
        self._checked_config = (signature, config, {name: self._executable_stat(config[name]) for name in ('node', 'python', 'ffmpeg', 'ffprobe')})
        return config

    @staticmethod
    def _executable_stat(path):
        info = regular(path).stat()
        return (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def exec(self, argv, input_bytes=None, timeout=180, sudo=False):
        if sudo:
            raise RuntimeError('Host rendering never runs privileged commands.')
        if not argv or any(not isinstance(item, str) or '\0' in item for item in argv):
            raise ValueError('Host execution requires a nonempty argument vector.')
        if input_bytes is not None and not isinstance(input_bytes, bytes):
            raise ValueError('Host input must be bytes.')
        environment = {name: value for name, value in os.environ.items()
                       if name not in ('PYTHONPATH', 'PYTHONHOME', 'NODE_OPTIONS', 'NODE_PATH') and not name.startswith('DYLD_')}
        environment.update({'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1'})
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            child = subprocess.Popen(argv, stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
                                     stdout=output, stderr=errors, env=environment, start_new_session=True)
            try:
                child.communicate(input_bytes, timeout=timeout)
            except BaseException:
                stop_process_group(child)
                raise
            if child.returncode:
                errors.seek(0, os.SEEK_END)
                errors.seek(max(0, errors.tell() - 8192))
                raise RuntimeError('Host command failed: ' + errors.read().decode(errors='replace').strip())
            if output.tell() > 64 * 1024 ** 2:
                raise RuntimeError('Host command output exceeds 64 MiB; use a file transfer.')
            output.seek(0)
            return output.read()

    def put(self, local, remote, timeout=600, sudo=False):
        if sudo:
            raise RuntimeError('Host transfers never run privileged commands.')
        return str(copy_verified(local, remote))

    def get(self, remote, local, timeout=600):
        return copy_verified(remote, local)

    def status(self):
        graphical = subprocess.run(['/bin/launchctl', 'print', 'gui/' + str(os.getuid())],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        return {'backend': 'host', 'state': 'available' if graphical else 'unavailable',
                'running': graphical, 'active': graphical, 'address': None}

    def doctor(self):
        config = self.config
        verify_runtime(self.state / 'host/runtime')
        report = json.loads(self.exec(['/usr/bin/python3', '-c', DOCTOR_SCRIPT,
                                      json.dumps({name: config[name] for name in ('node', 'python', 'ffmpeg', 'ffprobe')})]))
        checks = {'physicalHost': not str(report.get('model', '')).startswith('VirtualMac'),
                  'hostAccount': report.get('guestUID') == os.getuid() and report.get('guestUser') == config['guestUser'],
                  'graphicalSession': report.get('aqua') is True and report.get('unlocked') is True
                  and report.get('consoleUID') == os.getuid()}
        versions = report.get('versions', {})
        for name, expected in CONTRACT['runtime'].items():
            observed = versions.get(name, '')
            if name == 'node':
                observed = observed.removeprefix('v')
            if name in ('ffmpeg', 'ffprobe'):
                parts = observed.split()
                observed = parts[2] if len(parts) > 2 else None
            checks[name] = observed == expected
        checks['safari'] = versions.get('safari') == 'Included with Safari 27.0.1 (22625.1.29.11.28)'
        report.update({'backend': 'host', 'checks': checks, 'passed': all(checks.values()),
                       'capturePermissions': 'Validated by the owned Safari window during native preflight.'})
        return report


def extract_runtime(archive, destination):
    destination = absolute(destination)
    with tarfile.open(archive) as stream:
        members = stream.getmembers()
        seen = set()
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] not in ('node', 'python'):
                raise RuntimeError('Unsafe private runtime archive path.')
            if member.name in seen or not (member.isfile() or member.isdir() or member.issym()):
                raise RuntimeError('Unsupported private runtime archive member.')
            seen.add(member.name)
            if member.issym():
                target = PurePosixPath(member.linkname)
                path = (destination / member.name).parent / member.linkname
                if target.is_absolute() or not path.resolve().is_relative_to(destination):
                    raise RuntimeError('Private runtime archive symlink escapes its directory.')
        symlinks = {member.name.rstrip('/') for member in members if member.issym()}
        if any(any(parent.as_posix() in symlinks for parent in PurePosixPath(member.name).parents) for member in members):
            raise RuntimeError('Private runtime archive traverses a symlink.')
        stream.extractall(destination, members=members)


def isolate_media(destination, ffmpeg='/opt/homebrew/bin/ffmpeg', ffprobe='/opt/homebrew/bin/ffprobe'):
    def run(argv):
        return subprocess.run(argv, capture_output=True, check=True, text=True).stdout
    destination.mkdir(parents=True)
    originals, mapping = {}, {}
    pending = [Path(ffmpeg).resolve(), Path(ffprobe).resolve()]
    for name, original in zip(('ffmpeg', 'ffprobe'), pending):
        if run([str(original), '-version']).splitlines()[0].split()[2] != CONTRACT['runtime'][name]:
            raise RuntimeError('Installed ' + name + ' does not match the pinned host runtime.')
        mapping[original] = destination / 'bin' / name
    while pending:
        original = pending.pop()
        if original in originals:
            continue
        links = [line.strip().split(' (compatibility version', 1)[0]
                 for line in run(['/usr/bin/otool', '-L', str(original)]).splitlines()[1:]]
        dependencies = {}
        for link in links:
            if link.startswith(('/usr/lib/', '/System/Library/')):
                continue
            if not link.startswith('/'):
                raise RuntimeError('Unsupported non-system media dependency: ' + link)
            dependency = Path(link).resolve()
            if dependency == original:
                continue
            dependencies[link] = dependency
            if dependency not in mapping:
                mapping[dependency] = destination / 'lib' / (hashlib.sha256(str(dependency).encode()).hexdigest()[:12] + '-' + dependency.name)
            pending.append(dependency)
        originals[original] = dependencies
    for original, target in mapping.items():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, target)
        target.chmod(0o700)
    for original, dependencies in originals.items():
        target = mapping[original]
        changes = []
        for link, dependency in dependencies.items():
            changes += ['-change', link, '@loader_path/' + os.path.relpath(mapping[dependency], target.parent)]
        if target.parent.name == 'lib':
            changes += ['-id', '@loader_path/' + target.name]
        if changes:
            run(['/usr/bin/install_name_tool', *changes, str(target)])
        run(['/usr/bin/codesign', '--force', '--sign', '-', str(target)])


def setup_host_runtime(state=None, source_vm=None):
    from prepare import inspect_runtime
    state = private_directory(DEFAULT_STATE if state is None else state, create=True)
    host_root = private_directory(state / 'host', create=True)
    runtime = host_root / 'runtime'
    if runtime.exists():
        verify_runtime(runtime)
        inspect_runtime(Host(state))
        return Host(state).config
    source_vm = source_vm or VM(state)
    starting = not source_vm.status().get('running')
    if starting:
        source_vm.boot()
        deadline = time.monotonic() + 180
        while not (source_vm.status().get('running') and source_vm.status().get('address')):
            if time.monotonic() >= deadline:
                raise RuntimeError('The configured VM did not start for private runtime provisioning.')
            time.sleep(1)
    while True:
        try:
            provenance = inspect_runtime(source_vm)
            break
        except RuntimeError:
            if not starting or time.monotonic() >= deadline:
                raise
            time.sleep(1)
    config = source_vm.config
    remote = config['guestRoot'] + '/incoming/host-runtime-' + uuid.uuid4().hex + '.tar'
    archive_script = '''import pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1]);node=pathlib.Path(sys.argv[2]);python=pathlib.Path(sys.argv[3]);npm=pathlib.Path(sys.argv[4])
root.parent.mkdir(parents=True,exist_ok=True)
def portable(member):
 if member.issym() and pathlib.PurePosixPath(member.linkname).is_absolute():
  candidate=python/pathlib.PurePosixPath(member.name).relative_to('python').parent/pathlib.PurePosixPath(member.linkname).name
  if not candidate.is_file(): raise RuntimeError('Runtime contains an external symlink')
  member.linkname=candidate.name
 return member
with tarfile.open(root,'x',dereference=False) as stream:
 stream.add(node,arcname='node/bin/node',recursive=False)
 stream.add(npm,arcname='node/lib/node_modules/npm')
 stream.add(python,arcname='python',filter=portable)
'''
    with tempfile.TemporaryDirectory(prefix='.runtime-', dir=host_root) as temporary:
        staging, archive = Path(temporary) / 'runtime', Path(temporary) / 'runtime.tar'
        staging.mkdir()
        try:
            source_vm.exec([config['python'], '-c', archive_script, remote, config['node'],
                            str(Path(config['python']).parent.parent),
                            str(Path(config['node']).parent.parent / 'lib/node_modules/npm')], timeout=180)
            expected = source_vm.exec(['/usr/bin/shasum', '-a', '256', remote]).decode().split()[0]
            source_vm.get(remote, archive)
            if sha256(archive) != expected:
                raise RuntimeError('Private host runtime transfer checksum differs.')
            extract_runtime(archive, staging)
        finally:
            source_vm.exec(['/bin/rm', '-f', remote])
        for name in ('npm', 'npx'):
            (staging / 'node/bin' / name).symlink_to('../lib/node_modules/npm/bin/' + name + '-cli.js')
        isolate_media(staging / 'media')
        receipt = {'version': 1, 'contract': CONTRACT['runtime'], 'sourceRuntime': provenance,
                   'sourceArchiveSha256': expected, 'files': runtime_files(staging)}
        atomic_json(staging / 'runtime.json', receipt)
        staging.rename(runtime)
    try:
        verify_runtime(runtime)
        inspect_runtime(Host(state))
    except BaseException:
        runtime.rename(runtime.with_name('runtime.incomplete-' + uuid.uuid4().hex))
        raise
    return Host(state).config
