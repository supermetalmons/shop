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
if status and status.get('currentCard') in job['ids']:
    path=root/'cards'/str(status['currentCard'])/'ready.json'
    if path.exists(): ready=read(path)
print(json.dumps({'job':job,'status':status,'ready':ready}))
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


def verify_evidence(job, ready, directory):
    path = directory / '.evidence-manifest.json'
    require(digest(path) == ready['evidence']['sha256'], 'Evidence inventory checksum changed')
    record = read_json(path)
    for item in validate_inventory(job, ready, record):
        file = directory / item['archivePath']
        require(file.resolve() == file and file.is_file() and file.stat().st_size == item['bytes'] and digest(file) == item['sha256'], 'Evidence file changed: ' + item['archivePath'])
    audit = read_json(directory / ready['audit']['path'].lstrip('/'))
    require(audit.get('passed') is True and all(audit.get(key) == ready[key] for key in ['jobId', 'sourceId', 'cardId', 'profile', 'motion'])
            and audit.get('videoSha256') == ready['video']['sha256'] and not audit.get('issues'), 'Independent audit does not approve this video')
    files = {item['guestPath']: item for item in record['files']}
    snapshot_path = job['sourceRoot'] + '/source-snapshot.json'
    require(snapshot_path in files, 'Source snapshot is missing from the evidence')
    snapshot = read_json(directory / snapshot_path.lstrip('/'))
    source_files = snapshot.get('files')
    require(isinstance(source_files, dict) and snapshot.get('version') == 1 and snapshot.get('sourceId') == job['sourceId']
            and hashlib.sha256(json.dumps(source_files, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == job['sourceId'], 'Collected source snapshot identity changed')
    for name, expected in source_files.items():
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and '..' not in relative.parts and valid_sha(expected)
                and files.get(job['sourceRoot'] + '/' + name, {}).get('sha256') == expected, 'Collected rendering source differs: ' + name)
    require(source_files.get('scripts/mi-note-video/contract.json') == job['contractSha256'], 'Collected source contract differs from the job')
    audit_source = job['sourceRoot'] + '/scripts/mi-note-video/audit.py'
    require(files.get(audit_source, {}).get('sha256') == audit.get('auditSourceSha256'), 'Independent audit source is missing or changed')
    profile = CONTRACT['profiles'][job['profile']]
    require(audit.get('geometry', {}).get('frames') == CONTRACT['video']['frames'] and audit.get('nativeFramesVerified') == 5
            and audit.get('sourceViewportsVerified') == 5 * profile['tiles'] and audit.get('independentControlsVerified') == 5
            and audit.get('iccByteExact') is True and audit.get('nativePixelsExact') is True
            and [sample['frame'] for sample in audit.get('samples', [])] == CONTRACT['capture']['controlFrames'], 'Independent audit coverage is incomplete')
    require(audit.get('thresholds') == {'wholeImageMAE': 3.0, 'cardInteriorMAE': 6.0, 'absoluteMeanSignedRGB': 1.5,
            'edgeEnergyRetention': .85, 'fineDetailEnergyRetention': .75, 'blackBorderMean': .5}, 'Independent audit thresholds changed')
    return record


def collect_evidence(vm, job, ready_record, evidence_root):
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
            and valid_sha(archive.get('sha256')) and type(archive.get('bytes')) is int and archive['bytes'] <= MAX_EVIDENCE_BYTES + 64 * 1024 ** 2, 'Invalid guest evidence archive')
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


def publish_unit(vm, job, ready_record, output, evidence_root, publication, publication_path):
    ready = ready_record['value']
    validate_ready(job, ready)
    card = str(ready['cardId'])
    video = ready['video']
    target = output / (card + '.mp4')
    previous = publication['videos'].get(card)
    if previous:
        require(previous['sha256'] == video['sha256'] and previous['bytes'] == video['bytes'] and previous['path'] == str(target)
                and previous['evidence']['sha256'] == ready['evidence']['sha256'], 'Existing host unit differs; preserved without overwrite')
    with tempfile.TemporaryDirectory(prefix='.collect-', dir=output) as temporary:
        staging = Path(temporary)
        pending = None
        if target.exists() or target.is_symlink():
            verify_video(target, video)
            validation = previous.get('hostValidation') if previous else None
            if not validation or validation.get('fullyDecoded') is not True:
                validation = decode_video(job, target)
            else:
                validate_stream(job, validation['stream'])
        else:
            require(not ready.get('requiresHostVerification'), 'Durable host video is missing; guest unit was already acknowledged')
            pending = staging / 'video.mp4'
            vm.get(video['output'], pending, timeout=600)
            verify_video(pending, video)
            validation = decode_video(job, pending)
            verify_video(pending, video)
            fsync_file(pending)
        evidence = collect_evidence(vm, job, ready_record, evidence_root)
        if pending is not None:
            try:
                os.link(pending, target)
            except FileExistsError:
                verify_video(target, video)
            fsync_directory(output)
        fsync_file(target)
        publication['videos'][card] = {'id': ready['cardId'], 'path': str(target), 'sha256': video['sha256'], 'bytes': video['bytes'],
            'guestPath': video['output'], 'hostValidation': validation, 'ready': ready,
            'evidence': {'path': str(evidence), 'sha256': ready['evidence']['sha256'], 'files': ready['evidence']['files']},
            'collectedAt': previous.get('collectedAt') if previous else now(), 'verifiedAt': now()}
        publication['updatedAt'] = now()
        atomic_json(publication_path, publication)
        ack = {'version': 1, 'jobId': job['jobId'], 'sourceId': job['sourceId'], 'cardId': ready['cardId'],
               'verificationId': ready['verificationId'], 'videoSha256': video['sha256'], 'evidenceSha256': ready['evidence']['sha256'],
               'hostManifestPath': str(publication_path), 'hostManifestSha256': digest(publication_path), 'verifiedAt': now()}
        ack_path = staging / 'ack.json'
        atomic_json(ack_path, ack)
        vm.put(ack_path, str(PurePosixPath(job['root']) / 'ack' / (card + '.json')), timeout=180)
        publication['videos'][card]['ackSentAt'] = now()
        publication['videos'][card]['ackVerificationId'] = ready['verificationId']
        atomic_json(publication_path, publication)
    return ready['cardId']


def collect(vm, job, host_output, evidence_root):
    require(job.get('version') == 1 and job.get('profile') in CONTRACT['profiles'] and job.get('motion') in CONTRACT['motions'], 'Unsupported collection job')
    require(type(job.get('catalogCount')) is int and job['catalogCount'] > 0 and isinstance(job.get('ids'), list) and job['ids'] and job['ids'] == sorted(set(job['ids']))
            and all(type(card) is int and 1 <= card <= job['catalogCount'] for card in job['ids']), 'Invalid collection card IDs')
    output, evidence_root = Path(host_output).absolute(), Path(evidence_root).absolute()
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
            require(all(publication.get(key) == job[key] for key in ['jobId', 'sourceId', 'ids', 'profile', 'motion']), 'Host collection belongs to another job')
        else:
            publication = {'version': 1, **{key: job[key] for key in ['jobId', 'sourceId', 'ids', 'profile', 'motion']}, 'createdAt': now(), 'videos': {}, 'status': 'pending'}
        snapshot = json.loads(vm.exec([job['python'], '-c', SNAPSHOT, job['root']], timeout=180))
        require(snapshot.get('job') == job, 'Guest job configuration differs from the host')
        status = snapshot.get('status')
        if status:
            require(status.get('jobId') == job['jobId'] and status.get('sourceId') == job['sourceId'], 'Guest status belongs to another job')
        published = []
        if snapshot.get('ready'):
            published.append(publish_unit(vm, job, snapshot['ready'], output, evidence_root, publication, path))
        complete = status and status.get('status') == 'complete' and set(publication['videos']) == {str(card) for card in job['ids']}
        if complete:
            for card in job['ids']:
                item = publication['videos'][str(card)]
                ready = item['ready']
                validate_ready(job, ready)
                verify_video(Path(item['path']), ready['video'])
                verify_evidence(job, ready, Path(item['evidence']['path']))
                require(status.get('completed', {}).get(str(card), {}).get('videoSha256') == item['sha256']
                        and status['completed'][str(card)]['evidenceSha256'] == item['evidence']['sha256'], 'Guest completion and durable host unit differ')
        publication.update({'updatedAt': now(), 'status': 'complete' if complete else 'pending', 'guestStatus': status})
        atomic_json(path, publication)
        return {'status': publication['status'], 'collected': len(publication['videos']), 'total': len(job['ids']),
                'awaiting': status.get('currentCard') if status and not published else None, 'published': published, 'manifest': str(path)}
    finally:
        os.close(descriptor)


collection = collect
