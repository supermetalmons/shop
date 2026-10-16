import argparse
import base64
import contextlib
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time


DEFAULT_STATE = Path.home() / 'Library/Application Support/Mons Mi Note Render'
TOOLS = Path(__file__).resolve().parent
RUNTIME_VERSIONS = {
    'node': 'v24.22.0', 'python': '3.12.14', 'pillow': '12.3.0',
    'numpy': '2.3.5', 'littlecms': '2.19',
}


def absolute(value):
    path = Path(value).expanduser().absolute()
    if '..' in path.parts or path.resolve() != path:
        raise RuntimeError('Paths must not traverse symlinks or parent components')
    return path


def private_directory(path, create=False):
    path = absolute(path)
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('VM state directories must be private and owned by the current user')
    return path


def regular(path, private=False):
    path = absolute(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError('Expected a regular file owned by the current user: ' + str(path))
    if private and info.st_mode & 0o077:
        raise RuntimeError('Guest access files must be private')
    return path


def read_bytes(path, private=False, maximum=1024 * 1024):
    path = regular(path, private)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > maximum:
            raise RuntimeError('File size or ownership changed while opening it')
        if private and info.st_mode & 0o077:
            raise RuntimeError('Guest access files must remain private')
        contents = stream.read(maximum + 1)
    if len(contents) > maximum:
        raise RuntimeError('File exceeds the permitted size')
    return contents


def read_password(path):
    value = read_bytes(path, private=True, maximum=4096).removesuffix(b'\n').removesuffix(b'\r')
    if not value or any(byte in value for byte in (b'\n', b'\r', b'\0')):
        raise RuntimeError('The guest password file must contain one nonempty line')
    return value


def atomic_bytes(path, contents, replace=True):
    path = absolute(path)
    if path.exists():
        regular(path)
    with tempfile.NamedTemporaryFile(prefix='.' + path.name + '-', dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        os.fchmod(stream.fileno(), 0o600)
        stream.write(contents)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_json(path, value):
    atomic_bytes(path, (json.dumps(value, indent=2, sort_keys=True) + '\n').encode())


def sha256(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def python_executable():
    executable = Path(sys.executable).resolve()
    framework = executable.parent.parent / 'Resources/Python.app/Contents/MacOS/Python'
    if any(part.endswith('.framework') for part in executable.parts) and framework.is_file():
        return framework.resolve()
    return executable


def mac_address(value):
    parts = str(value).lower().split(':')
    if len(parts) != 6 or any(not re.fullmatch('[0-9a-f]{1,2}', part) for part in parts):
        raise RuntimeError('The VM must have a valid fixed MAC address')
    normalized = ':'.join(part.zfill(2) for part in parts)
    if int(parts[0], 16) & 1 or normalized == '00:00:00:00:00:00':
        raise RuntimeError('The VM MAC address must be unicast')
    return normalized


def vm_configuration(path):
    path = absolute(path)
    info = path.stat()
    if path.suffix != '.vbvm' or not path.is_dir() or info.st_uid != os.getuid():
        raise RuntimeError('Expected an existing VM bundle owned by the current user')
    for name in ['Disk.img', 'AuxiliaryStorage', 'HardwareModel', 'MachineIdentifier', '.vbdata/Config.plist']:
        regular(path / name)
    configuration = plistlib.loads(read_bytes(path / '.vbdata/Config.plist'))
    hardware = configuration.get('hardware', {})
    networks = hardware.get('networkDevices', [])
    devices = hardware.get('_storageDevices', [])
    if configuration.get('systemType') != 'mac' or len(networks) != 1 or len(devices) not in (1, 2):
        raise RuntimeError('Expected a macOS VM with one network device and one or two managed disks')
    for index, name in enumerate(['Disk', 'BuildData'][:len(devices)]):
        image = devices[index].get('backing', {}).get('managedImage', {}).get('_0', {})
        if image.get('filename') != name or image.get('format') != 0 or bool(devices[index].get('isBootVolume')) != (index == 0):
            raise RuntimeError('The VM contains an unsupported storage device')
        regular(path / (name + '.img'))
    if (path / 'BuildData.img').exists() != (len(devices) == 2):
        raise RuntimeError('The build disk does not match its VM configuration')
    mac_address(networks[0].get('macAddress'))
    return configuration


def ensure_idle(path):
    vm_configuration(path)
    disks = [str(Path(path) / name) for name in ['Disk.img', 'BuildData.img'] if (Path(path) / name).exists()]
    result = subprocess.run(['/usr/sbin/lsof', '-t', '+w', *disks], capture_output=True, timeout=30)
    if result.stdout.strip():
        raise RuntimeError('The VM disks are in use; shut down their current owner before adopting or starting them')
    if result.returncode not in (0, 1) or result.stderr.strip():
        raise RuntimeError('Could not establish that the VM disks are idle')


def pinned_keys(path, alias):
    if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,127}', alias):
        raise RuntimeError('Invalid SSH host-key alias')
    result = set()
    for line in read_bytes(path, maximum=65536).decode('ascii').splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        pieces = line.split()
        if len(pieces) < 3 or pieces[0] != alias or pieces[1] not in ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521']:
            raise RuntimeError('Every pinned SSH host key must belong to the selected alias')
        try:
            blob = base64.b64decode(pieces[2], validate=True)
            length = int.from_bytes(blob[:4], 'big')
            if not 0 < length <= 64 or blob[4:4 + length].decode('ascii') != pieces[1] or len(blob) <= 4 + length:
                raise ValueError()
        except (ValueError, UnicodeError):
            raise RuntimeError('Invalid pinned SSH public key') from None
        result.add(' '.join(pieces[:3]))
    if not result:
        raise RuntimeError('At least one pinned SSH host key is required')
    return ('\n'.join(sorted(result)) + '\n').encode()


def find_address(mac, lease_path=Path('/var/db/dhcpd_leases'), now=None):
    mac = mac_address(mac)
    now = time.time() if now is None else now
    try:
        contents = Path(lease_path).read_text()
    except FileNotFoundError:
        return None
    active = []
    for block in re.findall(r'\{([^{}]*)\}', contents):
        record = dict(re.findall(r'^\s*([a-z_]+)\s*=\s*([^\r\n]+)', block, re.MULTILINE))
        raw_mac = record.get('hw_address', '').strip().removeprefix('1,')
        try:
            candidate = mac_address(raw_mac)
            expiry = int(record.get('lease', '').strip(), 0)
            address = ipaddress.IPv4Address(record.get('ip_address', '').strip())
        except (RuntimeError, ValueError):
            if raw_mac.lower() == mac:
                raise RuntimeError('The VM DHCP lease is malformed') from None
            continue
        if expiry <= now:
            continue
        if candidate == mac:
            private_address(str(address))
        active.append((candidate, str(address)))
    addresses = {address for candidate, address in active if candidate == mac}
    if len(addresses) > 1 or any(candidate != mac and address in addresses for candidate, address in active):
        raise RuntimeError('The VM DHCP lease is ambiguous')
    return next(iter(addresses), None)


def private_address(value):
    address = ipaddress.IPv4Address(value)
    if not address.is_private or address.is_loopback or address.is_link_local or address.is_unspecified:
        raise RuntimeError('SSH requires a private numeric VM address')
    return str(address)


def guest_path(value):
    if not isinstance(value, str):
        raise RuntimeError('Guest paths must be strings')
    path = PurePosixPath(value)
    if not path.is_absolute() or '..' in path.parts or '\0' in value or '\n' in value:
        raise RuntimeError('Guest paths must be absolute without parent components')
    return str(path)


def ssh_command(config, address):
    address = private_address(address)
    if not re.fullmatch('[A-Za-z0-9_-]{1,64}', config['guestUser']):
        raise RuntimeError('Invalid guest account')
    known_hosts = regular(config['knownHostsFile'], private=True)
    pinned_keys(known_hosts, config['hostKeyAlias'])
    escaped = str(known_hosts).replace('\\', '\\\\').replace('"', '\\"')
    options = [f'UserKnownHostsFile="{escaped}"', 'HostKeyAlias=' + config['hostKeyAlias'],
               'GlobalKnownHostsFile=/dev/null', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no',
               'IdentityAgent=none', 'IdentitiesOnly=yes', 'PubkeyAuthentication=no',
               'PasswordAuthentication=yes', 'KbdInteractiveAuthentication=no', 'GSSAPIAuthentication=no',
               'HostbasedAuthentication=no', 'UseKeychain=no', 'NumberOfPasswordPrompts=1',
               'ClearAllForwardings=yes', 'ForwardAgent=no', 'ForwardX11=no', 'Tunnel=no',
               'ProxyCommand=none', 'ProxyJump=none', 'PermitLocalCommand=no',
               'ControlMaster=no', 'ControlPath=none', 'RequestTTY=no',
               'ConnectTimeout=10', 'ConnectionAttempts=1', 'ServerAliveInterval=15', 'ServerAliveCountMax=3']
    return ['/usr/bin/ssh', '-F', '/dev/null', '-T', *[item for option in options for item in ['-o', option]], '-l', config['guestUser'], '--', address]


PUT_SCRIPT = r'''
import hashlib, os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
expected_bytes, expected_hash = int(sys.argv[2]), sys.argv[3]
if path.parent.resolve() != path.parent or not path.parent.is_dir() or path.is_symlink() or (path.exists() and not path.is_file()):
    raise RuntimeError('Guest upload destination must be a regular file in an existing real directory')
descriptor, name = tempfile.mkstemp(prefix='.' + path.name + '-', suffix='.partial', dir=path.parent)
try:
    value, count = hashlib.sha256(), 0
    with os.fdopen(descriptor, 'wb') as target:
        for block in iter(lambda: sys.stdin.buffer.read(1024 * 1024), b''):
            count += len(block)
            if count > expected_bytes: raise RuntimeError('Upload exceeds its declared size')
            value.update(block)
            target.write(block)
        target.flush()
        os.fsync(target.fileno())
    if count != expected_bytes or value.hexdigest() != expected_hash: raise RuntimeError('Upload checksum or byte count differs')
    os.replace(name, path)
finally:
    if os.path.exists(name): os.unlink(name)
'''


GET_SCRIPT = r'''
import os, pathlib, stat, sys
path = pathlib.Path(sys.argv[1])
if path.resolve() != path: raise RuntimeError('Guest download path must not traverse symlinks')
descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(descriptor, 'rb') as source:
    before = os.fstat(source.fileno())
    if not stat.S_ISREG(before.st_mode): raise RuntimeError('Guest download requires a regular file')
    for block in iter(lambda: source.read(1024 * 1024), b''): sys.stdout.buffer.write(block)
    after = os.fstat(source.fileno())
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns): raise RuntimeError('Guest file changed during transfer')
'''


DOCTOR_SCRIPT = r'''
import json, os, pathlib, pwd, subprocess, sys
paths = json.loads(sys.argv[1])
def output(argv):
    return subprocess.run(argv, check=True, capture_output=True, text=True, timeout=30).stdout.strip()
account = pwd.getpwuid(os.getuid())
uid = os.getuid()
registry = subprocess.run(['/usr/sbin/ioreg', '-n', 'Root', '-d', '1', '-a'], check=True, capture_output=True).stdout
locked = subprocess.run(['/usr/bin/plutil', '-extract', 'IOConsoleLocked', 'raw', '-o', '-', '-'], input=registry, check=True, capture_output=True).stdout.strip()
python = json.loads(output([paths['python'], '-c', 'import json,platform,numpy;from PIL import Image,features;print(json.dumps({"python":platform.python_version(),"pillow":Image.__version__,"numpy":numpy.__version__,"littlecms":features.version("littlecms2")}))']))
print(json.dumps({'guestUID': uid, 'guestUser': account.pw_name, 'guestHome': account.pw_dir,
    'model': output(['/usr/sbin/sysctl', '-n', 'hw.model']), 'consoleUID': os.stat('/dev/console').st_uid,
    'aqua': subprocess.run(['/bin/launchctl', 'print', 'gui/' + str(uid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0,
    'unlocked': locked == b'false',
    'versions': {**python, 'node': output([paths['node'], '--version']),
        'ffmpeg': output([paths['ffmpeg'], '-version']).splitlines()[0], 'ffprobe': output([paths['ffprobe'], '-version']).splitlines()[0],
        'safari': output(['/usr/bin/safaridriver', '--version']), 'macos': output(['/usr/bin/sw_vers', '-productVersion'])}}))
'''


class VM:
    def __init__(self, state=None):
        self.state = absolute(DEFAULT_STATE if state is None else state)

    @property
    def config(self):
        return self.read_config()

    def read_config(self):
        private_directory(self.state)
        value = json.loads(read_bytes(self.state / 'config.json', private=True))
        required = ['vmPath', 'macAddress', 'guestUser', 'passwordFile', 'knownHostsFile', 'hostKeyAlias', 'guestRoot', 'node', 'python', 'ffmpeg', 'ffprobe']
        if value.get('version') != 1 or any(not isinstance(value.get(key), str) for key in required):
            raise RuntimeError('Invalid rendering VM configuration')
        if not re.fullmatch('[A-Za-z0-9_-]{1,64}', value['guestUser']):
            raise RuntimeError('Invalid guest account')
        for key in ['guestRoot', 'node', 'python', 'ffmpeg', 'ffprobe']:
            guest_path(value[key])
        for key in ['passwordFile', 'knownHostsFile']:
            path = regular(value[key], private=True)
            if path.parent != self.state / 'credentials':
                raise RuntimeError('Guest access must use renderer-owned credentials')
        private_directory(self.state / 'credentials')
        pinned_keys(value['knownHostsFile'], value['hostKeyAlias'])
        configuration = vm_configuration(value['vmPath'])
        if mac_address(configuration['hardware']['networkDevices'][0]['macAddress']) != value['macAddress']:
            raise RuntimeError('The adopted VM network identity changed')
        if configuration['hardware'].get('cpuCount') != 4 or configuration['hardware'].get('memorySize') != 8 * 1024 ** 3:
            raise RuntimeError('The adopted VM must retain four CPUs and 8 GiB of memory')
        return value

    @contextlib.contextmanager
    def _lock(self):
        private_directory(self.state, create=True)
        descriptor = os.open(self.state / '.lifecycle.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        except BlockingIOError:
            raise RuntimeError('Another VM lifecycle operation is active') from None
        finally:
            os.close(descriptor)

    def adopt(self, vm_path, guest_user, password_file, known_hosts, host_key_alias, guest_root, node, python, ffmpeg, ffprobe, move=False):
        source = absolute(vm_path)
        password = read_password(password_file)
        keys = pinned_keys(known_hosts, host_key_alias)
        if not re.fullmatch('[A-Za-z0-9_-]{1,64}', guest_user):
            raise RuntimeError('Invalid guest account')
        runtime = {key: guest_path(value) for key, value in [('guestRoot', guest_root), ('node', node), ('python', python), ('ffmpeg', ffmpeg), ('ffprobe', ffprobe)]}
        destination = self.state / 'render.vbvm' if move else source
        if self.state.is_relative_to(source):
            raise RuntimeError('VM state must remain outside the VM bundle')
        with self._lock():
            if (self.state / 'config.json').exists():
                previous = self.read_config()
                expected = {'vmPath': str(destination), 'guestUser': guest_user, 'hostKeyAlias': host_key_alias, **runtime}
                if any(previous[key] != value for key, value in expected.items()) or read_password(previous['passwordFile']) != password or pinned_keys(previous['knownHostsFile'], host_key_alias) != keys:
                    raise RuntimeError('This state directory already owns another VM configuration')
                return previous
            configuration = vm_configuration(source)
            ensure_idle(source)
            if destination != source and destination.exists():
                raise RuntimeError('The VM import destination already exists')
            credentials = private_directory(self.state / 'credentials', create=True)
            for name, contents in [('password', password + b'\n'), ('known_hosts', keys)]:
                target = credentials / name
                if target.exists():
                    if read_bytes(target, private=True) != contents:
                        raise RuntimeError('Existing renderer credentials differ; no files were replaced')
                else:
                    atomic_bytes(target, contents, replace=False)
            moved = False
            original_configuration = read_bytes(source / '.vbdata/Config.plist')
            try:
                if destination != source:
                    os.rename(source, destination)
                    moved = True
                hardware = configuration['hardware']
                hardware['cpuCount'] = 4
                hardware['memorySize'] = 8 * 1024 ** 3
                atomic_bytes(destination / '.vbdata/Config.plist', plistlib.dumps(configuration))
                value = {'version': 1, 'vmPath': str(destination), 'macAddress': mac_address(hardware['networkDevices'][0]['macAddress']),
                         'guestUser': guest_user, 'passwordFile': str(credentials / 'password'), 'knownHostsFile': str(credentials / 'known_hosts'),
                         'hostKeyAlias': host_key_alias, **runtime}
                atomic_json(self.state / 'config.json', value)
                return value
            except BaseException:
                if destination.exists():
                    atomic_bytes(destination / '.vbdata/Config.plist', original_configuration)
                if moved:
                    os.rename(destination, source)
                raise

    def _process_value(self, pid, field):
        if type(pid) is not int or pid <= 1:
            return None
        result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', field + '='], capture_output=True, text=True, timeout=10)
        return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None

    def _process_alive(self, record):
        return bool(isinstance(record, dict) and record.get('start') and record.get('command') and
                    self._process_value(record.get('pid'), 'lstart') == record['start'] and
                    self._process_value(record.get('pid'), 'command') == record['command'])

    def _record_process(self, process, command):
        start = self._process_value(process.pid, 'lstart')
        if not start:
            raise RuntimeError('The VM process exited before its identity was recorded')
        return {'pid': process.pid, 'start': start, 'command': ' '.join(map(str, command))}

    def _read_optional(self, name):
        path = self.state / name
        return json.loads(read_bytes(path, private=True)) if path.exists() else None

    def status(self):
        config = self.read_config()
        process = self._read_optional('process.json') or {}
        observed = self._read_optional('vm-status.json') or {}
        same_vm = process.get('vmPath') == config['vmPath']
        supervisor = same_vm and self._process_alive(process.get('supervisor'))
        launcher = same_vm and self._process_alive(process.get('launcher'))
        observed_owner = observed.get('vmPath') == config['vmPath'] and observed.get('hostPID') == process.get('launcher', {}).get('pid')
        active = bool(supervisor or launcher)
        running = bool(launcher and observed_owner and observed.get('running'))
        state = observed.get('state') if launcher and observed_owner else ('starting' if supervisor else 'stopped')
        result = {'state': state, 'running': running, 'active': active, 'vmPath': config['vmPath'],
                  'address': find_address(config['macAddress']) if running else None}
        if launcher:
            result['hostPID'] = process['launcher']['pid']
        if supervisor:
            result['supervisorPID'] = process['supervisor']['pid']
        if observed_owner and observed.get('error'):
            result['error'] = observed['error']
        return result

    def build_launcher(self):
        private_directory(self.state, create=True)
        source = read_bytes(TOOLS / 'vm-host.swift')
        entitlements = read_bytes(TOOLS / 'virtualization.entitlements')
        compiler = subprocess.run(['/usr/bin/xcrun', 'swiftc', '--version'], check=True, capture_output=True).stdout
        identity = hashlib.sha256(b'mi-note-vm-swift6-v1\0' + source + entitlements + compiler).hexdigest()
        directory = private_directory(self.state / 'tools' / identity[:20], create=True)
        executable = directory / 'vm-host'
        receipt = directory / 'build.json'
        if executable.exists():
            regular(executable, private=True)
            previous = json.loads(read_bytes(receipt, private=True))
            if previous.get('identity') != identity or previous.get('sha256') != sha256(executable):
                raise RuntimeError('The cached VM launcher failed its integrity check')
            return executable
        with tempfile.TemporaryDirectory(prefix='.build-', dir=directory) as temporary:
            pending = Path(temporary) / 'vm-host'
            frozen_source = Path(temporary) / 'vm-host.swift'
            frozen_entitlements = Path(temporary) / 'virtualization.entitlements'
            frozen_source.write_bytes(source)
            frozen_entitlements.write_bytes(entitlements)
            subprocess.run(['/usr/bin/xcrun', 'swiftc', '-swift-version', '6', '-parse-as-library', '-O', '-module-name', 'MiNoteVMHost', str(frozen_source), '-o', str(pending)], check=True, capture_output=True)
            subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', 'org.mons.mi-note-video.vm', '--entitlements', str(frozen_entitlements), str(pending)], check=True, capture_output=True)
            pending.chmod(0o700)
            os.link(pending, executable)
            atomic_json(receipt, {'identity': identity, 'sha256': sha256(executable), 'sourceSha256': hashlib.sha256(source).hexdigest(), 'compiler': compiler.decode().strip()})
        return executable

    def boot(self, detach=True):
        with self._lock():
            config = self.read_config()
            current = self.status()
            if current['active']:
                return current
            if sys.platform != 'darwin' or os.uname().machine != 'arm64':
                raise RuntimeError('The rendering VM requires an Apple silicon Mac')
            ensure_idle(config['vmPath'])
            launcher = self.build_launcher()
            stop = self.state / 'vm-stop'
            if stop.exists():
                regular(stop, private=True).unlink()
            command = [str(python_executable()), str(Path(__file__).resolve()), '_supervise', '--state', str(self.state), '--launcher', str(launcher)]
            log_path = self.state / 'vm.log'
            descriptor = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'ab', buffering=0) as log:
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=detach)
            try:
                record = {'version': 1, 'vmPath': config['vmPath'], 'supervisor': self._record_process(process, command)}
                atomic_json(self.state / 'process.json', record)
            except BaseException:
                process.terminate()
                process.wait(timeout=30)
                raise
        if not detach:
            process.wait()
            return self.status()
        return {'state': 'starting', 'running': False, 'active': True, 'vmPath': config['vmPath'], 'supervisorPID': process.pid, 'address': None}

    def _supervise(self, launcher):
        config = self.read_config()
        deadline = time.monotonic() + 10
        record = None
        while time.monotonic() < deadline:
            record = self._read_optional('process.json')
            if record and record.get('supervisor', {}).get('pid') == os.getpid():
                break
            time.sleep(.05)
        if not record or not self._process_alive(record.get('supervisor')) or record['supervisor']['pid'] != os.getpid() or record.get('vmPath') != config['vmPath']:
            raise RuntimeError('The VM supervisor does not own the recorded session')
        if absolute(launcher) != self.build_launcher():
            raise RuntimeError('Unexpected VM launcher')
        def stop(signum, frame):
            atomic_bytes(self.state / 'vm-stop', b'')
        for value in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
            signal.signal(value, stop)
        command = [str(launcher), '--vm', config['vmPath'], '--status', str(self.state / 'vm-status.json'), '--stop-file', str(self.state / 'vm-stop'), '--owner-pid', str(os.getpid())]
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL)
        try:
            record['launcher'] = self._record_process(child, command)
            atomic_json(self.state / 'process.json', record)
            return child.wait()
        finally:
            if child.poll() is None:
                stop(None, None)
                try:
                    child.wait(timeout=35)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()

    def stop(self):
        with self._lock():
            current = self.status()
            if not current['active']:
                return current
            atomic_bytes(self.state / 'vm-stop', b'')
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                current = self.status()
                if not current['active']:
                    ensure_idle(self.config['vmPath'])
                    return current
                time.sleep(.25)
            raise RuntimeError('The owned VM did not finish its bounded shutdown; inspect its log before retrying')

    def _ssh(self, argv, input_bytes=None, input_path=None, output_path=None, timeout=180, sudo=False):
        if not argv or any(not isinstance(item, str) or '\0' in item for item in argv):
            raise ValueError('Guest execution requires a nonempty argument vector')
        if input_bytes is not None and (not isinstance(input_bytes, bytes) or input_path is not None):
            raise ValueError('Choose bytes or a file for guest input')
        config = self.read_config()
        current = self.status()
        if not current['running'] or not current['address']:
            raise RuntimeError('The owned rendering VM is not running with a known network address')
        command = ssh_command(config, current['address'])
        remote = shlex.join(argv)
        if sudo:
            remote = '/usr/bin/sudo -k -S -p "" -- ' + remote
        secret = read_password(config['passwordFile'])
        with tempfile.TemporaryDirectory(prefix='ssh-', dir=self.state) as temporary:
            askpass = Path(temporary) / 'askpass'
            askpass.write_text('#!/bin/sh\nexec ' + shlex.join([str(python_executable()), str(Path(__file__).resolve()), '_askpass', config['passwordFile']]) + '\n')
            askpass.chmod(0o700)
            environment = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C', 'HOME': str(self.state), 'SSH_ASKPASS': str(askpass), 'SSH_ASKPASS_REQUIRE': 'force'}
            with contextlib.ExitStack() as stack:
                output = stack.enter_context(open(output_path, 'xb')) if output_path else stack.enter_context(tempfile.TemporaryFile())
                errors = stack.enter_context(tempfile.TemporaryFile())
                source = stack.enter_context(open(input_path, 'rb')) if input_path else None
                piped = sudo or input_bytes is not None
                child = subprocess.Popen(command + [remote], stdin=subprocess.PIPE if piped else (source or subprocess.DEVNULL), stdout=output, stderr=errors, env=environment, start_new_session=True)
                writer_error = []
                def write_input():
                    try:
                        if sudo:
                            child.stdin.write(secret + b'\n')
                        if input_bytes is not None:
                            child.stdin.write(input_bytes)
                        elif source:
                            for block in iter(lambda: source.read(1024 * 1024), b''):
                                child.stdin.write(block)
                    except (BrokenPipeError, OSError) as error:
                        writer_error.append(error)
                    finally:
                        try:
                            child.stdin.close()
                        except OSError:
                            pass
                writer = threading.Thread(target=write_input, daemon=True) if piped else None
                if writer:
                    writer.start()
                try:
                    code = child.wait(timeout=timeout)
                except BaseException:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait()
                    raise
                finally:
                    if writer:
                        writer.join(timeout=5)
                errors.seek(0, os.SEEK_END)
                errors.seek(max(0, errors.tell() - 8192))
                diagnostic = errors.read().replace(secret, b'[REDACTED]').decode(errors='replace').strip()
                if code or writer_error:
                    raise RuntimeError('Guest command failed' + (': ' + diagnostic if diagnostic else ''))
                output.flush()
                if output_path:
                    os.fsync(output.fileno())
                    return b''
                if output.tell() > 64 * 1024 ** 2:
                    raise RuntimeError('Guest command output exceeds 64 MiB; use a file transfer')
                output.seek(0)
                return output.read()

    def exec(self, argv, input_bytes=None, timeout=180, sudo=False):
        return self._ssh(argv, input_bytes=input_bytes, timeout=timeout, sudo=sudo)

    def put(self, local, remote, timeout=600, sudo=False):
        local = regular(local)
        remote = guest_path(remote)
        self._ssh(['/usr/bin/python3', '-c', PUT_SCRIPT, remote, str(local.stat().st_size), sha256(local)], input_path=local, timeout=timeout, sudo=sudo)
        return remote

    def get(self, remote, local, timeout=600):
        remote = guest_path(remote)
        local = absolute(local)
        if local.exists():
            regular(local)
        descriptor, name = tempfile.mkstemp(prefix='.' + local.name + '-', suffix='.partial', dir=local.parent)
        os.close(descriptor)
        temporary = Path(name)
        temporary.unlink()
        try:
            self._ssh(['/usr/bin/python3', '-c', GET_SCRIPT, remote], output_path=temporary, timeout=timeout)
            os.replace(temporary, local)
            descriptor = os.open(local.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            return local
        finally:
            temporary.unlink(missing_ok=True)

    def doctor(self):
        config = self.read_config()
        paths = {key: config[key] for key in ['node', 'python', 'ffmpeg', 'ffprobe']}
        report = json.loads(self.exec(['/usr/bin/python3', '-c', DOCTOR_SCRIPT, json.dumps(paths)]))
        checks = {
            'virtualMachine': str(report.get('model', '')).startswith('VirtualMac'),
            'guestAccount': report.get('guestUser') == config['guestUser'] and type(report.get('guestUID')) is int and report['guestUID'] >= 500,
            'graphicalSession': report.get('aqua') is True and report.get('unlocked') is True and report.get('consoleUID') == report.get('guestUID'),
            **{key: report.get('versions', {}).get(key) == value for key, value in RUNTIME_VERSIONS.items()},
            'ffmpeg': str(report.get('versions', {}).get('ffmpeg', '')).startswith('ffmpeg version 8.1.2 '),
            'ffprobe': str(report.get('versions', {}).get('ffprobe', '')).startswith('ffprobe version 8.1.2 '),
            'safari': report.get('versions', {}).get('safari') == 'Included with Safari 27.0.1 (22625.1.29.11.28)',
        }
        report.update({'checks': checks, 'passed': all(checks.values())})
        if report['passed']:
            guest_path(report['guestHome'])
            with self._lock():
                if self.read_config() != config:
                    raise RuntimeError('VM configuration changed during guest inspection')
                config.update({'guestUID': report['guestUID'], 'guestHome': report['guestHome'], 'runtimeVersions': report['versions']})
                atomic_json(self.state / 'config.json', config)
        return report


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    askpass = commands.add_parser('_askpass')
    askpass.add_argument('path', type=Path)
    supervisor = commands.add_parser('_supervise')
    supervisor.add_argument('--state', type=Path, required=True)
    supervisor.add_argument('--launcher', type=Path, required=True)
    args = parser.parse_args()
    if args.command == '_askpass':
        sys.stdout.buffer.write(read_password(args.path) + b'\n')
        return 0
    return VM(args.state)._supervise(args.launcher)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
