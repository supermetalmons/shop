import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
from storage import available_capacity


CONTRACT = json.loads(Path(__file__).with_name('contract.json').read_text())
MAX_EVIDENCE_BYTES = 8 * 1024 ** 3
SNAPSHOT = r'''
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
def read(path):
    if path.resolve()!=path or not path.is_file(): raise RuntimeError('Expected a regular job file')
    content=path.read_bytes()
    return {'path':str(path),'sha256':hashlib.sha256(content).hexdigest(),'value':json.loads(content)}
job=read(root/'job.json')['value']
status=read(root/'job-status.json')['value'] if (root/'job-status.json').exists() else None
ready=None
completed={}
for card in job['ids']:
    path=root/'cards'/str(card)/'completed.json'
    if path.exists(): completed[str(card)]=read(path)['value']
if status and status.get('currentCard') in job['ids']:
    path=root/'cards'/str(status['currentCard'])/'ready.json'
    if path.exists(): ready=read(path)
print(json.dumps({'job':job,'status':status,'ready':ready,'completed':completed}))
'''
ARCHIVE = r'''
import hashlib,io,json,os,pathlib,sys,tarfile,uuid
root=pathlib.Path(sys.argv[1]);card=int(sys.argv[2]);ready_sha=sys.argv[3];inventory_sha=sys.argv[4]
def digest(path):
    value=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''): value.update(block)
    return value.hexdigest()
def regular(path):
    if path.resolve()!=path or not path.is_file(): raise RuntimeError('Expected regular evidence: '+str(path))
    return path
job=json.loads(regular(root/'job.json').read_text())
if card not in job['ids']: raise RuntimeError('Unknown card')
unit=root/'cards'/str(card);ready_path=regular(unit/'ready.json')
if digest(ready_path)!=ready_sha: raise RuntimeError('Ready unit changed; collect again')
ready=json.loads(ready_path.read_text())
if ready.get('requiresHostVerification'): raise RuntimeError('The unit already belongs to the durable host copy')
inventory_path=regular(unit/'evidence-manifest.json')
if digest(inventory_path)!=inventory_sha: raise RuntimeError('Evidence inventory changed')
inventory=json.loads(inventory_path.read_text());files=inventory['files']
if inventory['jobId']!=job['jobId'] or inventory['sourceId']!=job['sourceId'] or inventory['cardId']!=card: raise RuntimeError('Evidence identity differs')
if sum(item['bytes'] for item in files)>8*1024**3: raise RuntimeError('Evidence exceeds unit limit')
for item in files:
    path=regular(pathlib.Path(item['guestPath']))
    if not (path.is_relative_to(root) or path.is_relative_to(job['sourceRoot'])) or item['archivePath']!=str(path).lstrip('/'): raise RuntimeError('Unexpected evidence path')
    if path.stat().st_size!=item['bytes'] or digest(path)!=item['sha256']: raise RuntimeError('Evidence changed: '+str(path))
transfer=unit/'transfer';transfer.mkdir(exist_ok=True)
if transfer.resolve()!=transfer: raise RuntimeError('Transfer directory is a symlink')
archive_path=transfer/'evidence.tar';record_path=transfer/'evidence.json'
if archive_path.exists() and record_path.exists():
    record=json.loads(regular(record_path).read_text())
    if record.get('inventorySha256')==inventory_sha and digest(regular(archive_path))==record.get('sha256'):
        print(json.dumps(record));sys.exit(0)
pending=transfer/('evidence-'+str(uuid.uuid4())+'.pending.tar')
try:
    with pending.open('xb') as stream:
        with tarfile.open(fileobj=stream,mode='w',format=tarfile.PAX_FORMAT) as archive:
            content=inventory_path.read_bytes();info=tarfile.TarInfo('.evidence-manifest.json');info.size=len(content);info.mode=0o600
            archive.addfile(info,io.BytesIO(content))
            for item in files:
                path=regular(pathlib.Path(item['guestPath']));info=tarfile.TarInfo(item['archivePath']);info.size=item['bytes'];info.mode=0o600
                with path.open('rb') as source: archive.addfile(info,source)
        stream.flush();os.fsync(stream.fileno())
    os.replace(pending,archive_path)
finally:
    pending.unlink(missing_ok=True)
record={'path':str(archive_path),'sha256':digest(archive_path),'bytes':archive_path.stat().st_size,'inventorySha256':inventory_sha}
temporary=record_path.with_name(record_path.name+'.'+str(uuid.uuid4())+'.pending')
with temporary.open('x') as stream: json.dump(record,stream);stream.flush();os.fsync(stream.fileno())
os.replace(temporary,record_path)
print(json.dumps(record))
'''


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def valid_sha(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def require_disk_space(allocations, minimum_free_bytes):
    if minimum_free_bytes == 0:
        return
    filesystems = {}
    for path, extra_bytes in allocations:
        device = os.stat(path).st_dev
        record = filesystems.setdefault(device, {'path': path, 'extra': 0})
        record['extra'] += extra_bytes
    for record in filesystems.values():
        free = available_capacity(record['path'])
        required = minimum_free_bytes + record['extra']
        require(free >= required, f"Insufficient collector disk space: {record['path']} has {free} bytes available; {required} bytes required including reserve")


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_file(path):
    with Path(path).open('rb') as stream:
        os.fsync(stream.fileno())


def atomic_json(path, value):
    path = Path(path)
    with tempfile.NamedTemporaryFile(mode='w', prefix='.' + path.name, dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def read_json(path):
    path = Path(path)
    require(path.resolve() == path and path.is_file(), 'Expected a regular metadata file: ' + str(path))
    return json.loads(path.read_text())


def save_publication(path, publication):
    previous = read_json(path) if path.exists() else None
    comparable = lambda value: {key: item for key, item in value.items() if key != 'updatedAt'}
    if previous is not None and comparable(previous) == comparable(publication):
        return False
    publication['updatedAt'] = now()
    atomic_json(path, publication)
    return True


def stream_fields(job):
    video = CONTRACT['video']
    size = CONTRACT['profiles'][job['profile']]['deliverySize']
    return {'codec_type': 'video', 'codec_name': video['codec'], 'profile': video['profile'],
            'codec_tag_string': video['tag'], 'width': size, 'height': size, 'pix_fmt': video['pixelFormat'],
            'color_range': video['colorRange'], 'color_space': video['colorSpace'],
            'color_transfer': video['colorTransfer'], 'color_primaries': video['colorPrimaries'],
            'avg_frame_rate': str(video['frameRate']) + '/1', 'nb_frames': str(video['frames']), 'nb_read_frames': str(video['frames'])}


def validate_stream(job, stream):
    for key, value in stream_fields(job).items():
        require(stream.get(key) == value, 'Video stream mismatch: ' + key)
    require(abs(float(stream.get('duration', 0)) - CONTRACT['video']['duration']) <= .001, 'Video duration changed')


def executable(name):
    value = os.environ.get('MI_NOTE_' + name.upper()) or shutil.which(name)
    require(value, name + ' is required for host verification')
    return value


def decode_video(job, path):
    probe = subprocess.run([executable('ffprobe'), '-v', 'error', '-count_frames', '-show_streams', '-of', 'json', str(path)], check=True, capture_output=True, text=True, timeout=300)
    result = json.loads(probe.stdout)
    require(len(result.get('streams', [])) == 1, 'Expected one video stream without audio')
    validate_stream(job, result['streams'][0])
    subprocess.run([executable('ffmpeg'), '-v', 'error', '-xerror', '-i', str(path), '-map', '0:v:0', '-f', 'null', '-'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=300)
    return {'fullyDecoded': True, 'verifiedAt': now(), 'stream': result['streams'][0]}


def verify_decode(vm, job, ready, path, source):
    descriptor = ready['video'].get('decodeCertificate')
    if getattr(vm, 'kind', 'vm') != 'host' or job.get('backend') != 'host' or descriptor is None:
        return decode_video(job, path)
    require(isinstance(descriptor, dict), 'Invalid host decode certificate descriptor')
    source = source or verify_source_root(job, job['sourceRoot'])
    certificate = Path(descriptor.get('path', ''))
    unit = Path(ready['unitRoot'])
    require(certificate.is_absolute() and certificate.is_relative_to(unit / 'output')
            and certificate.resolve() == certificate and certificate.is_file()
            and valid_sha(descriptor.get('sha256')) and digest(certificate) == descriptor['sha256'], 'Decode certificate location or checksum changed')
    validator = 'scripts/mi-note-video/video_validation.py'
    require(source[1]['files'].get(validator) == digest(Path(__file__).with_name('video_validation.py')),
            'Host certificate validator differs from the pinned source')
    from video_validation import verify_certificate
    config = vm.config
    validation = verify_certificate(job, ready['video'], certificate, source[0], verify_samples=True,
                                    executable_paths={'python': job['python'], 'ffmpeg': config['ffmpeg'], 'ffprobe': config['ffprobe']})
    verify_video(path, ready['video'])
    require(validation.get('fullyDecoded') is True and validation.get('certificateSha256') == descriptor['sha256'],
            'Host decode certificate did not validate this video')
    validate_stream(job, validation.get('stream', {}))
    return {**validation, 'verifiedAt': now(), 'reusedPinnedHostDecode': True}


def verify_video(path, video):
    path = Path(path)
    require(path.resolve() == path and path.is_file(), 'Expected a regular video: ' + str(path))
    require(path.stat().st_size == video['bytes'] and digest(path) == video['sha256'], 'Video mismatch; preserved existing bytes: ' + str(path))


def validate_ready(job, ready):
    require(ready.get('version') == 1 and ready.get('jobId') == job['jobId'] and ready.get('sourceId') == job['sourceId'], 'Ready unit belongs to another job')
    card = ready.get('cardId')
    require(type(card) is int and card in job['ids'] and ready.get('profile') == job['profile'] and ready.get('motion') == job['motion'], 'Ready unit selection changed')
    unit = str(PurePosixPath(job['root']) / 'cards' / str(card))
    require(ready.get('unitRoot') == unit and isinstance(ready.get('verificationId'), str) and ready['verificationId'], 'Ready unit location or verification identity changed')
    video, evidence = ready['video'], ready['evidence']
    require(video.get('id') == card and video.get('method') == 'd' and video.get('output') == unit + '/output/' + str(card) + '.mp4', 'Unexpected video identity')
    require(video.get('fullyDecoded') is True and valid_sha(video.get('sha256')) and type(video.get('bytes')) is int and 0 < video['bytes'] <= 512 * 1024 ** 2, 'Invalid video checksum or size')
    size = CONTRACT['profiles'][job['profile']]['deliverySize']
    require(video.get('width') == size and video.get('height') == size, 'Unexpected video dimensions')
    for key in ['frames', 'frameRate', 'duration', 'space', 'encoder', 'crf', 'preset', 'keyframeInterval']:
        require(video.get(key) == CONTRACT['video'][key], 'Video contract changed: ' + key)
    validate_stream(job, video.get('stream', {}))
    require(evidence.get('path') == unit + '/evidence-manifest.json' and evidence.get('archivePath') == unit + '/transfer/evidence.tar', 'Unexpected evidence location')
    require(ready.get('audit', {}).get('path') == unit + '/audit.json' and valid_sha(ready['audit'].get('sha256')), 'Independent unit audit is missing')
    require(valid_sha(evidence.get('sha256')) and type(evidence.get('bytes')) is int and 0 < evidence['bytes'] <= MAX_EVIDENCE_BYTES
            and type(evidence.get('files')) is int and 0 < evidence['files'] <= 32000, 'Invalid evidence inventory')


def validate_inventory(job, ready, record):
    require(record.get('version') == 1 and record.get('jobId') == job['jobId'] and record.get('sourceId') == job['sourceId'] and record.get('cardId') == ready['cardId'], 'Evidence identity changed')
    files = record.get('files', [])
    require(len(files) == ready['evidence']['files'] and sum(item['bytes'] for item in files) == ready['evidence']['bytes'], 'Evidence inventory count or size changed')
    require(len({item['archivePath'] for item in files}) == len(files) and len({item['guestPath'] for item in files}) == len(files), 'Duplicate evidence paths')
    roots = [PurePosixPath(job['root']), PurePosixPath(job['sourceRoot'])]
    for item in files:
        member = PurePosixPath(item['archivePath'])
        guest = PurePosixPath(item['guestPath'])
        require(not member.is_absolute() and '..' not in member.parts and str(guest) == '/' + str(member)
                and any(guest.is_relative_to(root) for root in roots), 'Evidence escapes the selected job or source release')
        require(type(item['bytes']) is int and item['bytes'] >= 0 and valid_sha(item['sha256']), 'Invalid evidence checksum')
    expected_manifest = ready['unitRoot'] + '/output/.render-manifest.json'
    expected_approval = ready['unitRoot'] + '/preflight/approved.json'
    inventory = {item['guestPath']: item for item in files}
    for label, path in [('manifest', expected_manifest), ('approval', expected_approval)]:
        require(record.get(label, {}).get('path') == path and inventory.get(path, {}).get('sha256') == record[label].get('sha256'), 'Evidence lacks its ' + label)
    require(inventory.get(ready['audit']['path'], {}).get('sha256') == ready['audit']['sha256'], 'Evidence lacks its independent audit')
    return files


def validate_source_snapshot(job, snapshot):
    source_files = snapshot.get('files')
    require(isinstance(source_files, dict) and snapshot.get('version') == 1 and snapshot.get('sourceId') == job['sourceId']
            and hashlib.sha256(json.dumps(source_files, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == job['sourceId'], 'Collected source snapshot identity changed')
    for name, expected in source_files.items():
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and '..' not in relative.parts and name and valid_sha(expected), 'Unsafe rendering source: ' + name)
    require(source_files.get('scripts/mi-note-video/contract.json') == job['contractSha256'], 'Collected source contract differs from the job')
    return source_files


def verify_source_root(job, source_root):
    require(source_root is not None, 'Receipt retention requires a pinned local source root')
    root = Path(source_root).absolute()
    require(root.resolve() == root and root.is_dir(), 'Pinned local source root must be a regular directory')
    snapshot = read_json(root / 'source-snapshot.json')
    for name, expected in validate_source_snapshot(job, snapshot).items():
        path = root / name
        require(path.resolve() == path and path.is_file() and digest(path) == expected, 'Pinned rendering source changed: ' + name)
    return root, snapshot


def validate_audit(job, ready, audit, record, snapshot):
    require(audit.get('passed') is True and all(audit.get(key) == ready[key] for key in ['jobId', 'sourceId', 'cardId', 'profile', 'motion'])
            and audit.get('videoSha256') == ready['video']['sha256'] and not audit.get('issues'), 'Independent audit does not approve this video')
    files = {item['guestPath']: item for item in record['files']}
    snapshot_path = job['sourceRoot'] + '/source-snapshot.json'
    require(snapshot_path in files, 'Source snapshot is missing from the evidence')
    source_files = validate_source_snapshot(job, snapshot)
    for name, expected in source_files.items():
        require(files.get(job['sourceRoot'] + '/' + name, {}).get('sha256') == expected, 'Collected rendering source differs: ' + name)
    audit_source = job['sourceRoot'] + '/scripts/mi-note-video/audit.py'
    require(files.get(audit_source, {}).get('sha256') == audit.get('auditSourceSha256'), 'Independent audit source is missing or changed')
    profile = CONTRACT['profiles'][job['profile']]
    require(audit.get('geometry', {}).get('frames') == CONTRACT['video']['frames'] and audit.get('nativeFramesVerified') == 5
            and audit.get('sourceViewportsVerified') == 5 * profile['tiles'] and audit.get('independentControlsVerified') == 5
            and audit.get('iccByteExact') is True and audit.get('nativePixelsExact') is True
            and [sample['frame'] for sample in audit.get('samples', [])] == CONTRACT['capture']['controlFrames'], 'Independent audit coverage is incomplete')
    require(audit.get('thresholds') == {'wholeImageMAE': 3.0, 'cardInteriorMAE': 6.0, 'absoluteMeanSignedRGB': 1.5,
            'edgeEnergyRetention': .85, 'fineDetailEnergyRetention': .75, 'blackBorderMean': .5}, 'Independent audit thresholds changed')
    certificate = ready['video'].get('decodeCertificate')
    if certificate is not None:
        require(isinstance(certificate, dict) and valid_sha(certificate.get('sha256'))
                and files.get(certificate.get('path'), {}).get('sha256') == certificate['sha256']
                and audit.get('decodeCertificateSha256') == certificate['sha256'],
                'Independent audit is not bound to the verified video decode')


def verify_evidence(job, ready, directory):
    path = directory / '.evidence-manifest.json'
    require(digest(path) == ready['evidence']['sha256'], 'Evidence inventory checksum changed')
    record = read_json(path)
    for item in validate_inventory(job, ready, record):
        file = directory / item['archivePath']
        require(file.resolve() == file and file.is_file() and file.stat().st_size == item['bytes'] and digest(file) == item['sha256'], 'Evidence file changed: ' + item['archivePath'])
    audit = read_json(directory / ready['audit']['path'].lstrip('/'))
    snapshot = read_json(directory / (job['sourceRoot'] + '/source-snapshot.json').lstrip('/'))
    validate_audit(job, ready, audit, record, snapshot)
    return record


def verify_local_evidence(job, ready, source):
    require(job.get('backend') == 'host' and source is not None, 'Local evidence requires a pinned host execution')
    require(read_json(Path(job['root']) / 'job.json') == job, 'Local execution identity changed')
    path = Path(ready['evidence']['path'])
    record = read_json(path)
    require(digest(path) == ready['evidence']['sha256'], 'Local evidence inventory checksum changed')
    for item in validate_inventory(job, ready, record):
        file = Path(item['guestPath'])
        require(file.resolve() == file and file.is_file() and file.stat().st_size == item['bytes']
                and digest(file) == item['sha256'], 'Local evidence file changed: ' + str(file))
    audit = read_json(ready['audit']['path'])
    validate_audit(job, ready, audit, record, source[1])
    return record


def collect_evidence(vm, job, ready_record, evidence_root, minimum_free_bytes=0):
    ready = ready_record['value']
    target = evidence_root / str(ready['cardId']) / ready['evidence']['sha256'][:20]
    if target.exists():
        verify_evidence(job, ready, target)
        return target
    require(not ready.get('requiresHostVerification'), 'Durable host evidence is missing; guest unit was already acknowledged')
    target.parent.mkdir(parents=True, exist_ok=True)
    require(target.parent.resolve() == target.parent, 'Evidence directory contains a symlink')
    archive = json.loads(vm.exec([job['python'], '-c', ARCHIVE, job['root'], str(ready['cardId']), ready_record['sha256'], ready['evidence']['sha256']], timeout=1800))
    require(archive.get('path') == ready['evidence']['archivePath'] and archive.get('inventorySha256') == ready['evidence']['sha256']
            and valid_sha(archive.get('sha256')) and type(archive.get('bytes')) is int and 0 < archive['bytes'] <= MAX_EVIDENCE_BYTES + 64 * 1024 ** 2, 'Invalid guest evidence archive')
    require_disk_space([(target.parent, archive['bytes'] * 2)], minimum_free_bytes)
    with tempfile.TemporaryDirectory(prefix='.unit-', dir=target.parent) as temporary:
        staging = Path(temporary)
        archive_path = staging / 'evidence.tar'
        vm.get(archive['path'], archive_path, timeout=1800)
        require(archive_path.stat().st_size == archive['bytes'] and digest(archive_path) == archive['sha256'], 'Transferred archive checksum changed')
        fsync_file(archive_path)
        extracted = staging / 'evidence'
        extracted.mkdir()
        with tarfile.open(archive_path, 'r:') as source:
            members = source.getmembers()
            require(len({member.name for member in members}) == len(members), 'Duplicate archive paths')
            inventory_member = source.getmember('.evidence-manifest.json')
            require(inventory_member.isfile() and inventory_member.size < 32 * 1024 ** 2, 'Invalid archived inventory')
            inventory_bytes = source.extractfile(inventory_member).read()
            require(hashlib.sha256(inventory_bytes).hexdigest() == ready['evidence']['sha256'], 'Archived inventory differs')
            record = json.loads(inventory_bytes)
            inventory = {item['archivePath']: item for item in validate_inventory(job, ready, record)}
            require(set(inventory) | {'.evidence-manifest.json'} == {member.name for member in members}, 'Archive and evidence inventory differ')
            require(sum(member.size for member in members) <= MAX_EVIDENCE_BYTES + 32 * 1024 ** 2, 'Evidence archive exceeds limit')
            for member in members:
                path = PurePosixPath(member.name)
                require(member.isfile() and not path.is_absolute() and '..' not in path.parts, 'Unsafe archive member')
                if member.name in inventory:
                    require(member.size == inventory[member.name]['bytes'], 'Archive member size changed')
                destination = extracted / str(path)
                destination.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as incoming, destination.open('xb') as outgoing:
                    shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
                    outgoing.flush()
                    os.fsync(outgoing.fileno())
        verify_evidence(job, ready, extracted)
        for current, directories, names in os.walk(extracted, topdown=False):
            fsync_directory(current)
        os.rename(extracted, target)
        fsync_directory(target.parent)
    return target


def receipt_directory(output, ready):
    return output / '.receipts' / str(ready['cardId']) / ready['evidence']['sha256']


def receipt_value(job, ready, validation):
    return {'version': 1, 'kind': 'mi-note-video-audit-receipt',
            **{key: ready[key] for key in ['jobId', 'sourceId', 'cardId', 'profile', 'motion']},
            'contractSha256': job['contractSha256'], 'runtime': job.get('runtime'), 'video': ready['video'],
            'evidence': ready['evidence'], 'audit': ready['audit'], 'hostValidation': validation}


def verify_receipt(job, item, output, source):
    ready = item['ready']
    directory = receipt_directory(output, ready)
    receipt = item.get('receipt', {})
    path = directory / 'receipt.json'
    require(receipt.get('version') == 1 and receipt.get('path') == str(path) and valid_sha(receipt.get('sha256')), 'Invalid audit receipt location or identity')
    value = read_json(path)
    require(digest(path) == receipt['sha256'], 'Audit receipt checksum changed')
    require(value == receipt_value(job, ready, item['hostValidation']), 'Audit receipt does not match this published video')
    require(item['hostValidation'].get('fullyDecoded') is True, 'Published video lacks complete host decoding')
    validate_stream(job, item['hostValidation'].get('stream', {}))
    inventory_path, audit_path = directory / 'inventory.json', directory / 'audit.json'
    record, audit = read_json(inventory_path), read_json(audit_path)
    require(digest(inventory_path) == ready['evidence']['sha256'], 'Retained evidence inventory checksum changed')
    require(digest(audit_path) == ready['audit']['sha256'], 'Retained audit checksum changed')
    validate_inventory(job, ready, record)
    source_root, snapshot = source
    inventory = {entry['guestPath']: entry for entry in record['files']}
    snapshot_record = inventory.get(job['sourceRoot'] + '/source-snapshot.json', {})
    require(snapshot_record.get('sha256') == digest(source_root / 'source-snapshot.json'), 'Pinned source snapshot differs from the retained inventory')
    validate_audit(job, ready, audit, record, snapshot)
    return value


def create_receipt(job, ready, validation, evidence, output, source, *, local=False):
    directory = receipt_directory(output, ready)
    path = directory / 'receipt.json'
    if not directory.exists():
        directory.parent.mkdir(parents=True, exist_ok=True)
        require(directory.parent.resolve() == directory.parent, 'Audit receipt directory contains a symlink')
        for parent in [output, output / '.receipts', directory.parent]:
            fsync_directory(parent)
        with tempfile.TemporaryDirectory(prefix='.receipt-', dir=directory.parent) as temporary:
            staging = Path(temporary)
            pending = staging / 'receipt'
            pending.mkdir()
            inventory = Path(ready['evidence']['path']) if local else evidence / '.evidence-manifest.json'
            audit = Path(ready['audit']['path']) if local else evidence / ready['audit']['path'].lstrip('/')
            for original, name in [(inventory, 'inventory.json'), (audit, 'audit.json')]:
                shutil.copyfile(original, pending / name)
                fsync_file(pending / name)
            atomic_json(pending / 'receipt.json', receipt_value(job, ready, validation))
            fsync_directory(pending)
            os.rename(pending, directory)
            fsync_directory(directory.parent)
    saved_validation = read_json(path).get('hostValidation', {})
    require(saved_validation.get('fullyDecoded') is True and saved_validation.get('stream') == validation.get('stream'), 'Existing receipt has another host validation')
    descriptor = {'version': 1, 'path': str(path), 'sha256': digest(path)}
    item = {'ready': ready, 'hostValidation': saved_validation, 'receipt': descriptor}
    verify_receipt(job, item, output, source)
    return descriptor, saved_validation


def validate_publication(job, publication):
    require(publication.get('version') in (1, 2) and all(publication.get(key) == job[key] for key in ['jobId', 'sourceId', 'ids', 'profile', 'motion']), 'Host collection belongs to another job')
    retention = publication.get('retention', 'full')
    require(retention in ('full', 'receipt') and (retention != 'receipt' or publication['version'] == 2), 'Unsupported evidence retention policy')
    require(isinstance(publication.get('videos'), dict) and set(publication['videos']).issubset({str(card) for card in job['ids']}), 'Unexpected published card IDs')
    return retention


def validate_local_receipt_intent(job, item):
    require(job.get('backend') == 'host' and item['evidence'].get('storage') == 'owned-host-originals',
            'Invalid local evidence storage')
    intent = item.get('ackIntent', {})
    require(isinstance(intent, dict) and isinstance(intent.get('verificationId'), str) and intent['verificationId']
            and intent['verificationId'] == item['ready']['verificationId']
            and intent.get('videoSha256') == item['sha256']
            and intent.get('evidenceSha256') == item['evidence']['sha256'],
            'Local receipt lacks a matching durable acknowledgment intent')


def verify_item(job, item, output, publication, source=None):
    ready = item['ready']
    validate_ready(job, ready)
    target = output / (str(ready['cardId']) + '.mp4')
    require(item.get('id') == ready['cardId'] and item.get('path') == str(target)
            and item.get('sha256') == ready['video']['sha256'] and item.get('bytes') == ready['video']['bytes']
            and item.get('evidence', {}).get('sha256') == ready['evidence']['sha256'], 'Published video identity changed')
    verify_video(target, ready['video'])
    require(item.get('hostValidation', {}).get('fullyDecoded') is True, 'Published video lacks complete host decoding')
    validate_stream(job, item['hostValidation'].get('stream', {}))
    if publication.get('retention', 'full') == 'receipt':
        require(item.get('version') == 2 and source is not None, 'Receipt publication requires pinned local source verification')
        expected = Path(publication['evidenceRoot']) / str(ready['cardId']) / ready['evidence']['sha256'][:20]
        require(item['evidence'].get('path') == str(expected), 'Native evidence cleanup location changed')
        verify_receipt(job, item, output, source)
        mode = item['evidence'].get('mode')
        require(mode in ('full', 'local', 'receipt'), 'Unknown retained evidence mode')
        if mode == 'local':
            validate_local_receipt_intent(job, item)
            return
        if mode == 'receipt':
            cleanup = item.get('cleanup', {})
            ack = cleanup.get('ack', {})
            require(cleanup.get('state') in ('pending', 'complete') and isinstance(ack.get('verificationId'), str)
                    and ack['verificationId'] and ack.get('videoSha256') == item['sha256']
                    and ack.get('evidenceSha256') == item['evidence']['sha256'], 'Compact evidence lacks a confirmed acknowledgment')
            require(cleanup.get('tombstone') == str(expected.with_name('.' + expected.name + '.cleanup')), 'Evidence cleanup tombstone changed')
            return
    verify_evidence(job, ready, Path(item['evidence']['path']))


def verify_publication(job, output, source_root=None, *, source_cache=None):
    output = Path(output).absolute()
    require(output.resolve() == output, 'Host output path must not contain symlinks')
    publication = read_json(output / '.collection-manifest.json')
    retention = validate_publication(job, publication)
    source = None
    if retention == 'receipt':
        selected_root = source_root or publication.get('sourceRoot')
        require(selected_root is not None, 'Receipt retention requires a pinned local source root')
        key = (str(Path(selected_root).absolute()), job['sourceId'], job['contractSha256'])
        if source_cache is not None and key in source_cache:
            source = source_cache[key]
        else:
            source = verify_source_root(job, selected_root)
            if source_cache is not None:
                source_cache[key] = source
    for key, item in publication['videos'].items():
        require(key == str(item.get('id')), 'Published card key changed')
        verify_item(job, item, output, publication, source)
    if publication.get('status') == 'complete':
        require(set(publication['videos']) == {str(card) for card in job['ids']}, 'Completed publication is missing videos')
        if retention == 'receipt':
            require(all(item['evidence'].get('mode') != 'local' for item in publication['videos'].values()),
                    'Local receipt publication lacks a confirmed acknowledgment')
    return publication


def local_acknowledged(job, card, item, completed):
    if not completed:
        return False
    intent = item.get('ackIntent', {})
    ack = completed.get('ack', {})
    ready = completed.get('ready', {})
    identity = {'jobId': job['jobId'], 'sourceId': job['sourceId'], 'cardId': int(card)}
    require(completed.get('version') == 1 and completed.get('status') in ('acknowledged', 'complete')
            and all(completed.get(key) == value and ready.get(key) == value and ack.get(key) == value
                    for key, value in identity.items()), 'Local acknowledgment belongs to another execution')
    require(ready.get('video', {}).get('sha256') == item['sha256']
            and ready.get('evidence', {}).get('sha256') == item['evidence']['sha256']
            and ready.get('verificationId') == ack.get('verificationId')
            and ack.get('videoSha256') == item['sha256'] and ack.get('evidenceSha256') == item['evidence']['sha256'],
            'Local acknowledgment differs from the durable video or evidence')
    return bool(intent.get('verificationId') and ack.get('verificationId') == intent['verificationId']
                and intent.get('videoSha256') == item['sha256'] and intent.get('evidenceSha256') == item['evidence']['sha256'])


def prune_acknowledged(job, publication, publication_path, output, status, source, completed_units=None):
    if publication.get('retention') != 'receipt':
        return
    for card, item in publication['videos'].items():
        if item['evidence']['mode'] == 'local':
            validate_local_receipt_intent(job, item)
        if item['evidence']['mode'] in ('full', 'local'):
            completed = (status or {}).get('completed', {}).get(card, {})
            intent = item.get('ackIntent', {})
            confirmed = bool(intent.get('verificationId') and (status or {}).get('attempt') == intent['verificationId']
                    and intent.get('videoSha256') == item['sha256'] and intent.get('evidenceSha256') == item['evidence']['sha256']
                    and completed.get('videoSha256') == item['sha256']
                    and completed.get('evidenceSha256') == item['evidence']['sha256'])
            if item['evidence']['mode'] == 'local' and not confirmed:
                confirmed = local_acknowledged(job, card, item, (completed_units or {}).get(card))
            if not confirmed:
                continue
            local = item['evidence']['mode'] == 'local'
            if local:
                verify_video(output / (card + '.mp4'), item)
                verify_receipt(job, item, output, source)
            else:
                verify_item(job, item, output, publication, source)
            original = Path(item['evidence']['path'])
            item['cleanup'] = {'state': 'complete' if local else 'pending', 'ack': intent,
                               'tombstone': str(original.with_name('.' + original.name + '.cleanup'))}
            if local:
                item['cleanup']['completedAt'] = now()
            item['evidence']['mode'] = 'receipt'
            save_publication(publication_path, publication)
        if item['cleanup']['state'] == 'complete':
            continue
        verify_item(job, item, output, publication, source)
        original = Path(item['evidence']['path'])
        tombstone = Path(item['cleanup']['tombstone'])
        require(original.parent.resolve() == original.parent, 'Evidence cleanup parent contains a symlink')
        require(not (original.exists() and tombstone.exists()), 'Evidence cleanup has conflicting directories')
        for path in [original, tombstone]:
            require(not path.is_symlink() and (not path.exists() or path.resolve() == path and path.is_dir()), 'Unsafe evidence cleanup directory')
        if original.exists():
            os.rename(original, tombstone)
            fsync_directory(original.parent)
        if tombstone.exists():
            shutil.rmtree(tombstone)
            fsync_directory(tombstone.parent)
        item['cleanup']['state'] = 'complete'
        item['cleanup']['completedAt'] = now()
        save_publication(publication_path, publication)


def publish_unit(vm, job, ready_record, output, evidence_root, publication, publication_path, source=None, minimum_free_bytes=0):
    ready = ready_record['value']
    validate_ready(job, ready)
    card = str(ready['cardId'])
    video = ready['video']
    target = output / (card + '.mp4')
    previous = publication['videos'].get(card)
    compact = publication.get('retention') == 'receipt'
    if previous:
        require(previous['sha256'] == video['sha256'] and previous['bytes'] == video['bytes'] and previous['path'] == str(target)
                and previous['evidence']['sha256'] == ready['evidence']['sha256'], 'Existing host unit differs; preserved without overwrite')
    retained = evidence_root / card / ready['evidence']['sha256'][:20]
    receipt_only = compact and previous and previous['evidence'].get('mode') == 'receipt'
    local = compact and getattr(vm, 'kind', 'vm') == 'host' and job.get('backend') == 'host' \
        and (previous is None or previous['evidence'].get('mode') in ('local', 'receipt'))
    video_allocation = 0 if target.exists() or target.is_symlink() else video['bytes']
    evidence_allocation = 0 if local or receipt_only or retained.exists() or retained.is_symlink() else ready['evidence']['bytes'] * 2
    require_disk_space([(output, video_allocation), (evidence_root, evidence_allocation)], minimum_free_bytes)
    with tempfile.TemporaryDirectory(prefix='.collect-', dir=output) as temporary:
        staging = Path(temporary)
        pending = None
        if target.exists() or target.is_symlink():
            verify_video(target, video)
            validation = previous.get('hostValidation') if previous else None
            if not validation or validation.get('fullyDecoded') is not True:
                validation = verify_decode(vm, job, ready, target, source)
            else:
                validate_stream(job, validation['stream'])
        else:
            require(not ready.get('requiresHostVerification'), 'Durable host video is missing; guest unit was already acknowledged')
            pending = staging / 'video.mp4'
            vm.get(video['output'], pending, timeout=600)
            verify_video(pending, video)
            validation = verify_decode(vm, job, ready, pending, source)
            verify_video(pending, video)
            fsync_file(pending)
        if compact and previous and previous['evidence'].get('mode') == 'receipt':
            verify_item(job, previous, output, publication, source)
            evidence = Path(previous['evidence']['path'])
        elif local:
            require(digest(Path(ready['unitRoot']) / 'ready.json') == ready_record['sha256'], 'Ready unit changed; collect again')
            if previous and previous['evidence'].get('mode') == 'local':
                verify_item(job, previous, output, publication, source)
            else:
                require(not ready.get('requiresHostVerification'), 'Local originals were already acknowledged without a durable receipt')
                verify_local_evidence(job, ready, source)
            evidence = retained
        else:
            evidence = collect_evidence(vm, job, ready_record, evidence_root, minimum_free_bytes)
        if pending is not None:
            try:
                os.link(pending, target)
            except FileExistsError:
                verify_video(target, video)
            fsync_directory(output)
        fsync_file(target)
        item = {**(previous or {}), 'id': ready['cardId'], 'path': str(target), 'sha256': video['sha256'], 'bytes': video['bytes'],
            'guestPath': video['output'], 'hostValidation': validation, 'ready': ready,
            'evidence': {**(previous.get('evidence', {}) if previous else {}), 'path': str(evidence), 'sha256': ready['evidence']['sha256'], 'files': ready['evidence']['files']},
            'collectedAt': previous.get('collectedAt') if previous else now()}
        if not previous or previous.get('ready') != ready:
            item['verifiedAt'] = now()
        if compact:
            item['version'] = 2
            item['evidence'].setdefault('mode', 'local' if local else 'full')
            if local:
                item['evidence']['storage'] = 'owned-host-originals'
            if not previous or not previous.get('receipt'):
                item['receipt'], item['hostValidation'] = create_receipt(job, ready, validation, evidence, output, source, local=local)
            verify_receipt(job, item, output, source)
            item['ackIntent'] = {'verificationId': ready['verificationId'], 'videoSha256': video['sha256'], 'evidenceSha256': ready['evidence']['sha256']}
        publication['videos'][card] = item
        save_publication(publication_path, publication)
        ack = {'version': 1, 'jobId': job['jobId'], 'sourceId': job['sourceId'], 'cardId': ready['cardId'],
               'verificationId': ready['verificationId'], 'videoSha256': video['sha256'], 'evidenceSha256': ready['evidence']['sha256'],
               'hostManifestPath': str(publication_path), 'hostManifestSha256': digest(publication_path), 'verifiedAt': now()}
        ack_path = staging / 'ack.json'
        atomic_json(ack_path, ack)
        vm.put(ack_path, str(PurePosixPath(job['root']) / 'ack' / (card + '.json')), timeout=180)
        if item.get('ackVerificationId') != ready['verificationId'] or not item.get('ackSentAt'):
            item['ackSentAt'] = now()
            item['ackVerificationId'] = ready['verificationId']
        save_publication(publication_path, publication)
    return ready['cardId']


def collect(vm, job, host_output, evidence_root, *, retention='full', source_root=None, minimum_free_bytes=0):
    require(job.get('version') == 1 and job.get('profile') in CONTRACT['profiles'] and job.get('motion') in CONTRACT['motions'], 'Unsupported collection job')
    require(type(job.get('catalogCount')) is int and job['catalogCount'] > 0 and isinstance(job.get('ids'), list) and job['ids'] and job['ids'] == sorted(set(job['ids']))
            and all(type(card) is int and 1 <= card <= job['catalogCount'] for card in job['ids']), 'Invalid collection card IDs')
    output, evidence_root = Path(host_output).absolute(), Path(evidence_root).absolute()
    require(retention in ('full', 'receipt'), 'Unsupported evidence retention policy')
    require(type(minimum_free_bytes) is int and minimum_free_bytes >= 0, 'Collector free-space reserve must be a nonnegative integer')
    source = verify_source_root(job, source_root) if retention == 'receipt' else None
    output.mkdir(parents=True, exist_ok=True)
    evidence_root.mkdir(parents=True, exist_ok=True)
    require(output.resolve() == output and evidence_root.resolve() == evidence_root, 'Host output paths must not contain symlinks')
    descriptor = os.open(output / '.collection.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another collector owns this host output')
        path = output / '.collection-manifest.json'
        if path.exists():
            publication = read_json(path)
            require(validate_publication(job, publication) == retention, 'Evidence retention policy cannot change for an existing collection')
            if retention == 'receipt':
                require(publication.get('sourceRoot') == str(source[0]) and publication.get('evidenceRoot') == str(evidence_root), 'Pinned collection paths changed')
        else:
            publication = {'version': 1, **{key: job[key] for key in ['jobId', 'sourceId', 'ids', 'profile', 'motion']}, 'createdAt': now(), 'videos': {}, 'status': 'pending'}
            if retention == 'receipt':
                publication.update({'version': 2, 'retention': retention, 'sourceRoot': str(source[0]), 'evidenceRoot': str(evidence_root)})
        snapshot = json.loads(vm.exec([job['python'], '-c', SNAPSHOT, job['root']], timeout=180))
        require(snapshot.get('job') == job, 'Guest job configuration differs from the host')
        status = snapshot.get('status')
        if status:
            require(status.get('jobId') == job['jobId'] and status.get('sourceId') == job['sourceId'], 'Guest status belongs to another job')
        prune_acknowledged(job, publication, path, output, status, source, snapshot.get('completed'))
        published = []
        if snapshot.get('ready'):
            published.append(publish_unit(vm, job, snapshot['ready'], output, evidence_root, publication, path, source, minimum_free_bytes))
        complete = status and status.get('status') == 'complete' and set(publication['videos']) == {str(card) for card in job['ids']}
        if complete:
            for card in job['ids']:
                item = publication['videos'][str(card)]
                verify_item(job, item, output, publication, source)
                if retention == 'receipt':
                    require(item['evidence'].get('mode') != 'local', 'Local receipt publication lacks a confirmed acknowledgment')
                require(status.get('completed', {}).get(str(card), {}).get('videoSha256') == item['sha256']
                        and status['completed'][str(card)]['evidenceSha256'] == item['evidence']['sha256'], 'Guest completion and durable host unit differ')
        publication.update({'status': 'complete' if complete else 'pending', 'guestStatus': status})
        save_publication(path, publication)
        return {'status': publication['status'], 'collected': len(publication['videos']), 'total': len(job['ids']),
                'awaiting': status.get('currentCard') if status and not published else None, 'published': published, 'manifest': str(path)}
    finally:
        os.close(descriptor)


collection = collect
