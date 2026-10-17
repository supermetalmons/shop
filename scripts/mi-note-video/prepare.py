import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import tarfile
import tempfile
import uuid

from jobs import CONTRACT, HERE, ROOT, catalog_count, digest, now

SOURCE_SUFFIXES = {'.py', '.mjs', '.ts', '.tsx', '.css', '.html', '.json', '.swift', '.entitlements', '.txt'}
TSCONFIG = {'compilerOptions': {'target': 'ESNext', 'module': 'ESNext', 'moduleResolution': 'Bundler', 'jsx': 'react-jsx', 'allowImportingTsExtensions': True, 'resolveJsonModule': True, 'allowSyntheticDefaultImports': True, 'skipLibCheck': True, 'noEmit': True}, 'include': ['src', 'shared', 'scripts/mi-note-video']}


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def file_hash(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def publish_snapshot(staging, release, manifest):
    release.parent.mkdir(parents=True, exist_ok=True)
    if release.is_symlink():
        raise ValueError('Local source release must not be a symlink.')
    if release.exists():
        expected = {**manifest['files'], 'source-snapshot.json': file_hash(staging / 'source-snapshot.json')}
        try:
            valid = all((release / name).resolve() == release / name and (release / name).is_file()
                        and file_hash(release / name) == digest for name, digest in expected.items())
        except OSError:
            valid = False
        if valid:
            return
        release.rename(release.with_name(release.name + '.incomplete-' + uuid.uuid4().hex))
    staging.rename(release)


def snapshot(destination, root=ROOT):
    destination, root = Path(destination), Path(root)
    destination.mkdir(parents=True, exist_ok=True)
    paths = []
    for directory in ('src', 'shared', 'public', 'scripts/mi-note-video'):
        for source in sorted((root / directory).rglob('*')):
            relative = source.relative_to(root)
            if any(part in {'node_modules', '__pycache__', 'tests', '.cache'} for part in relative.parts):
                continue
            if source.is_symlink():
                raise ValueError('Source snapshots cannot contain symlinks: ' + str(relative))
            if not source.is_file() or (directory == 'scripts/mi-note-video' and source.suffix not in SOURCE_SUFFIXES):
                continue
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            paths.append(relative.as_posix())
    for name in ('package.json', 'package-lock.json'):
        shutil.copyfile(root / 'scripts/mi-note-video' / name, destination / name)
        paths.append(name)
    (destination / 'tsconfig.json').write_text(json.dumps(TSCONFIG, indent=2) + '\n')
    paths.append('tsconfig.json')
    files = {name: file_hash(destination / name) for name in sorted(paths)}
    manifest = {'version': 1, 'sourceId': digest(files), 'files': files}
    atomic_json(destination / 'source-snapshot.json', manifest)
    return manifest


def inspect_runtime(vm):
    config = vm.config
    python = json.loads(vm.exec([config['python'], '-c', 'import json,platform,numpy;from PIL import Image,features;print(json.dumps({"python":platform.python_version(),"pillow":Image.__version__,"numpy":numpy.__version__,"littlecms":features.version("littlecms2")}))']))
    node = vm.exec([config['node'], '--version']).decode().strip().removeprefix('v')
    versions = {**python, 'node': node}
    for name in ('ffmpeg', 'ffprobe'):
        line = vm.exec([config[name], '-version']).decode().splitlines()[0]
        versions[name] = line.split()[2]
    for name, expected in CONTRACT['runtime'].items():
        if versions.get(name) != expected:
            kind = 'Host' if getattr(vm, 'kind', None) == 'host' else 'Guest'
            raise ValueError(f'{kind} {name} must be {expected}; found {versions.get(name)}.')
    versions['safari'] = vm.exec(['/usr/bin/safaridriver', '--version']).decode().strip()
    versions['macos'] = vm.exec(['/usr/bin/sw_vers', '-productVersion']).decode().strip()
    executable_hashes = {}
    for name in ('node', 'python', 'ffmpeg', 'ffprobe'):
        executable_hashes[name] = vm.exec(['/usr/bin/shasum', '-a', '256', config[name]]).decode().split()[0]
    return {'versions': versions, 'executableSha256': executable_hashes}


def verify_snapshot(release, source_id):
    release = Path(release).absolute()
    if not re.fullmatch('[a-f0-9]{64}', source_id) or release.resolve() != release:
        raise ValueError('Invalid frozen source identity or release path.')
    manifest_path = release / 'source-snapshot.json'
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError('Frozen source manifest is missing or unsafe.')
    manifest = json.loads(manifest_path.read_text())
    files = manifest.get('files')
    if manifest.get('version') != 1 or manifest.get('sourceId') != source_id or not isinstance(files, dict) or digest(files) != source_id:
        raise ValueError('Frozen source manifest identity differs.')
    for name, expected in files.items():
        path = PurePosixPath(name)
        target = release / name
        if path.is_absolute() or '..' in path.parts or '\\' in name or not re.fullmatch('[a-f0-9]{64}', str(expected)):
            raise ValueError('Unsafe frozen source entry.')
        if target.resolve() != target or not target.is_file() or file_hash(target) != expected:
            raise ValueError('Frozen source file is missing or changed: ' + name)
    for required in ('package-lock.json', 'src/lib/miNoteCards.ts', 'scripts/mi-note-video/contract.json'):
        if required not in files:
            raise ValueError('Frozen source inventory is incomplete: ' + required)
    return manifest


def transfer_release(vm, state, local_release, manifest, release):
    with tempfile.TemporaryDirectory(prefix='prepare-', dir=state) as temporary:
        archive = Path(temporary) / 'source.tar'
        with tarfile.open(archive, 'w') as stream:
            for name in [*manifest['files'], 'source-snapshot.json']:
                stream.add(local_release / name, arcname=name, recursive=False)
        vm.exec(['/bin/mkdir', '-p', vm.config['guestRoot'] + '/incoming', vm.config['guestRoot'] + '/releases'])
        remote_archive = vm.config['guestRoot'] + '/incoming/' + manifest['sourceId'] + '.tar'
        vm.put(archive, remote_archive)
        remote_hash = vm.exec(['/usr/bin/shasum', '-a', '256', remote_archive]).decode().split()[0]
        if remote_hash != file_hash(archive):
            raise RuntimeError('Transferred source archive checksum differs.')
        verifier = '''import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);data=json.loads((root/'source-snapshot.json').read_text())
assert data['sourceId']==sys.argv[2]
assert hashlib.sha256(json.dumps(data['files'],sort_keys=True,separators=(',',':')).encode()).hexdigest()==sys.argv[2]
for name,expected in data['files'].items():
 p=root/name
 assert not pathlib.PurePosixPath(name).is_absolute() and '..' not in pathlib.PurePosixPath(name).parts
 assert p.resolve()==p and p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==expected,name
print(data['sourceId'])'''
        script = 'set -eu\n' + '\n'.join([
            'if [ ! -d ' + shlex.quote(release) + ' ]; then',
            'if [ -e ' + shlex.quote(release + '.pending') + ' ]; then mv ' + shlex.quote(release + '.pending') + ' ' + shlex.quote(release + '.interrupted-' + str(uuid.uuid4())) + '; fi',
            'mkdir ' + shlex.quote(release + '.pending'),
            'tar -xf ' + shlex.quote(remote_archive) + ' -C ' + shlex.quote(release + '.pending'),
            shlex.join([vm.config['python'], '-c', verifier, release + '.pending', manifest['sourceId']]),
            'mv ' + shlex.quote(release + '.pending') + ' ' + shlex.quote(release),
            'fi',
            shlex.join([vm.config['python'], '-c', verifier, release, manifest['sourceId']]),
        ])
        vm.exec(['/bin/sh', '-c', script], timeout=120)
        vm.exec(['/bin/rm', remote_archive])


def stage_release(vm, state, local_release, manifest):
    is_host = getattr(vm, 'kind', None) == 'host'
    release = str(local_release) if is_host else vm.config['guestRoot'].rstrip('/') + '/releases/' + manifest['sourceId']
    if not is_host:
        transfer_release(vm, state, local_release, manifest, release)
    node_dir = str(Path(vm.config['node']).parent)
    install = 'set -eu\ncd ' + shlex.quote(release) + '\n' + 'export PATH=' + shlex.quote(node_dir + ':/usr/bin:/bin:/usr/sbin:/sbin') + '\n' + 'if [ ! -f .dependencies-ready ]; then npm ci --ignore-scripts --no-audit --no-fund; fi\n' + shlex.join([vm.config['node'], '--input-type=module', '-e', "await import('vite'); await import('tsx/esm/api'); console.log('Renderer dependencies ready')"]) + '\n' + 'if [ ! -f .dependencies-ready ]; then touch .dependencies-ready; fi'
    print('Preparing the pinned renderer dependencies on the ' + ('host.' if is_host else 'VM.'), flush=True)
    vm.exec(['/bin/sh', '-c', install], timeout=600)
    return release


def prepare_frozen(vm, state, source_id):
    state = Path(state).absolute()
    local_release = state / 'releases' / source_id
    manifest = verify_snapshot(local_release, source_id)
    runtime = inspect_runtime(vm)
    release = stage_release(vm, state, local_release, manifest)
    verify_snapshot(local_release, source_id)
    result = {'version': 1, 'sourceId': source_id, 'guestSourceRoot': release, 'runtime': runtime,
              'catalogCount': catalog_count(local_release), 'contractSha256': manifest['files']['scripts/mi-note-video/contract.json'],
              'preparedAt': now(), 'manifestSha256': file_hash(local_release / 'source-snapshot.json')}
    prepared_path = state / ('prepared-host.json' if getattr(vm, 'kind', None) == 'host' else 'prepared.json')
    if prepared_path.exists():
        previous = json.loads(prepared_path.read_text())
        if {key: value for key, value in previous.items() if key != 'preparedAt'} == {key: value for key, value in result.items() if key != 'preparedAt'}:
            return previous
    atomic_json(prepared_path, result)
    return result


def prepare(vm, state):
    state = Path(state).absolute()
    state.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='prepare-', dir=state) as temporary:
        staging = Path(temporary) / 'source'
        manifest = snapshot(staging)
        publish_snapshot(staging, state / 'releases' / manifest['sourceId'], manifest)
    return prepare_frozen(vm, state, manifest['sourceId'])
