import hashlib
import json
import os
from pathlib import Path
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
            raise ValueError(f'Guest {name} must be {expected}; found {versions.get(name)}.')
    versions['safari'] = vm.exec(['/usr/bin/safaridriver', '--version']).decode().strip()
    versions['macos'] = vm.exec(['/usr/bin/sw_vers', '-productVersion']).decode().strip()
    executable_hashes = {}
    for name in ('node', 'python', 'ffmpeg', 'ffprobe'):
        executable_hashes[name] = vm.exec(['/usr/bin/shasum', '-a', '256', config[name]]).decode().split()[0]
    return {'versions': versions, 'executableSha256': executable_hashes}


def prepare(vm, state):
    state = Path(state)
    runtime = inspect_runtime(vm)
    with tempfile.TemporaryDirectory(prefix='prepare-', dir=state) as temporary:
        staging = Path(temporary) / 'source'
        manifest = snapshot(staging)
        count = catalog_count(staging)
        contract_hash = manifest['files']['scripts/mi-note-video/contract.json']
        release = vm.config['guestRoot'].rstrip('/') + '/releases/' + manifest['sourceId']
        archive = Path(temporary) / 'source.tar'
        with tarfile.open(archive, 'w') as stream:
            for name in [*manifest['files'], 'source-snapshot.json']:
                stream.add(staging / name, arcname=name, recursive=False)
        vm.exec(['/bin/mkdir', '-p', vm.config['guestRoot'] + '/incoming', vm.config['guestRoot'] + '/releases'])
        remote_archive = vm.config['guestRoot'] + '/incoming/' + manifest['sourceId'] + '.tar'
        vm.put(archive, remote_archive)
        remote_hash = vm.exec(['/usr/bin/shasum', '-a', '256', remote_archive]).decode().split()[0]
        if remote_hash != file_hash(archive):
            raise RuntimeError('Transferred source archive checksum differs.')
        verifier = '''import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);data=json.loads((root/'source-snapshot.json').read_text())
assert data['sourceId']==sys.argv[2]
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
        node_dir = str(Path(vm.config['node']).parent)
        install = 'set -eu\ncd ' + shlex.quote(release) + '\n' + 'export PATH=' + shlex.quote(node_dir + ':/usr/bin:/bin:/usr/sbin:/sbin') + '\n' + 'if [ ! -f .dependencies-ready ]; then npm ci --ignore-scripts --no-audit --no-fund; fi\n' + shlex.join([vm.config['node'], '--input-type=module', '-e', "await import('vite'); await import('tsx/esm/api'); console.log('Renderer dependencies ready')"]) + '\n' + 'touch .dependencies-ready'
        print('Preparing the pinned renderer dependencies in the VM.', flush=True)
        vm.exec(['/bin/sh', '-c', install], timeout=600)
        vm.exec(['/bin/rm', remote_archive])
        local_release = state / 'releases' / manifest['sourceId']
        publish_snapshot(staging, local_release, manifest)
        result = {'version': 1, 'sourceId': manifest['sourceId'], 'guestSourceRoot': release, 'runtime': runtime,
                  'catalogCount': count, 'contractSha256': contract_hash, 'preparedAt': now(),
                  'manifestSha256': file_hash(local_release / 'source-snapshot.json')}
        atomic_json(state / 'prepared.json', result)
        return result
