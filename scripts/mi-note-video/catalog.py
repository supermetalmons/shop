import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

from jobs import CONTRACT, create_job, job_name, now, select_ids, validate_job
from prepare import atomic_json, file_hash, inspect_runtime, prepare, prepare_frozen, publish_snapshot, snapshot, verify_snapshot
from storage import available_capacity
from vm import DEFAULT_STATE, VM, private_directory


MINIMUM_HOST_FREE = 5 * 1024 ** 3
TERMINAL = {'complete', 'failed', 'interrupted', 'low-space'}
SOURCE_UPGRADE_FILES = {
    'scripts/mi-note-video/catalog.py', 'scripts/mi-note-video/cli.py',
    'scripts/mi-note-video/capture.mjs', 'scripts/mi-note-video/frames.py',
    'scripts/mi-note-video/frame-worker.mjs', 'scripts/mi-note-video/frame_worker.py',
    'scripts/mi-note-video/background.py', 'scripts/mi-note-video/backends.py', 'scripts/mi-note-video/collect.py',
    'scripts/mi-note-video/storage.py', 'scripts/mi-note-video/test.mjs',
    'scripts/mi-note-video/README.md',
    'scripts/mi-note-video/guest-runner.mjs', 'scripts/mi-note-video/jobs.py',
    'scripts/mi-note-video/quality.py', 'scripts/mi-note-video/audit.py',
    'scripts/mi-note-video/video_validation.py', 'scripts/mi-note-video/processing_worker.py',
    'scripts/mi-note-video/stream-processing.mjs', 'scripts/mi-note-video/capture-release.mjs',
    'scripts/mi-note-video/capture-overlap.mjs', 'scripts/mi-note-video/preflight.mjs',
    'scripts/mi-note-video/frame-scroll-action.mjs',
    'scripts/mi-note-video/pipeline.json', 'scripts/mi-note-video/safari.mjs',
}
PIPELINE_CAPABILITY = {'version': 1, 'maxUnfinished': 2, 'captureRelease': 1, 'streamProcessing': 1}


class Interrupted(RuntimeError):
    pass


class LowSpace(RuntimeError):
    pass


def read(path):
    path = Path(path)
    if path.resolve() != path or not path.is_file():
        raise RuntimeError('Expected a regular catalog record: ' + str(path))
    return json.loads(path.read_text())


def save_changed(path, value):
    path = Path(path)
    if not path.exists() or read(path) != value:
        atomic_json(path, value)


def state_path(state=None):
    return private_directory(Path(state or DEFAULT_STATE).expanduser().absolute(), create=True)


def directory(state, name):
    return Path(state) / 'jobs' / job_name(name)


def is_catalog(state, name):
    path = directory(state, name) / 'job-meta.json'
    return path.exists() and read(path).get('version') == 2


def load(state, name):
    root = directory(state, name)
    metadata = read(root / 'job-meta.json')
    job = metadata['job']
    if metadata.get('version') != 2 or job.get('version') != 2 or job['name'] != name:
        raise ValueError('Unsupported catalog identity.')
    uuid.UUID(job['jobId'])
    if any(not re.fullmatch('[a-f0-9]{64}', str(job.get(key, ''))) for key in ('sourceId', 'contractSha256')):
        raise ValueError('Invalid pinned catalog source identity.')
    if read(root / 'job.json') != job or job['ids'] != select_ids(job['ids'], count=job['catalogCount']):
        raise ValueError('The immutable catalog records disagree.')
    if job['profile'] not in CONTRACT['profiles'] or job['motion'] not in CONTRACT['motions'] or job['retention'] not in ('full', 'receipt'):
        raise ValueError('Unsupported catalog rendering settings.')
    if metadata['output'] != job['output'] or Path(metadata['output']).resolve() != Path(metadata['output']):
        raise ValueError('Catalog output paths must not traverse symlinks.')
    validate_source_history(state, job, metadata)
    return job, metadata


def backend_for(state, kind):
    if kind == 'vm':
        return VM(state)
    if kind == 'host':
        from backends import Host
        return Host(state)
    raise ValueError('Backend must be host or vm.')


def backend_ready(backend):
    if getattr(backend, 'kind', 'vm') == 'vm':
        from cli import ready
        return ready(backend)
    report = backend.doctor()
    if report.get('passed') is not True:
        raise RuntimeError('Host rendering prerequisites failed: ' + json.dumps(report))
    return report


def check_capacity(state, output, working_bytes=0):
    for path in {Path(state), Path(output)}:
        while not path.exists():
            path = path.parent
        free = available_capacity(path)
        if free < MINIMUM_HOST_FREE + working_bytes:
            raise LowSpace(f'A 5 GiB host reserve plus {working_bytes / 1024 ** 3:.1f} GiB working space is required; {free / 1024 ** 3:.1f} GiB is available at {path}, including reclaimable macOS capacity. Free space, then resume this job.')


def source_root(state, job):
    return Path(state) / 'releases' / job['sourceId']


def source_for_card(job, metadata, card):
    selected = job['sourceId']
    for upgrade in metadata.get('renderSourceHistory', []):
        if card >= upgrade['fromCard']:
            selected = upgrade['sourceId']
    return selected


def pipeline_capability(state, source_id):
    path = Path(state) / 'releases' / source_id / 'scripts/mi-note-video/pipeline.json'
    if not path.exists():
        return False
    if read(path) != PIPELINE_CAPABILITY:
        raise ValueError('Unsupported native pipeline capability.')
    return True


def validate_equivalence(report, job, baseline, candidate):
    identity = {'version': 1, 'kind': 'mi-note-performance-equivalence', 'status': 'passed',
                'baselineSourceId': baseline, 'candidateSourceId': candidate,
                'contractSha256': job['contractSha256'], 'profile': job['profile'], 'motion': job['motion'],
                'frames': CONTRACT['video']['frames']}
    if any(report.get(key) != value for key, value in identity.items()):
        raise ValueError('Equivalence evidence does not match the source upgrade and rendering recipe.')
    if type(report.get('cardId')) is not int or report['cardId'] not in job['ids']:
        raise ValueError('Equivalence evidence must identify a card in this catalog.')
    if any(report.get(key) is not True for key in ('nativePixelsExact', 'preparedPixelsExact', 'iccExact', 'videoBytesExact')):
        raise ValueError('Source upgrade requires exact native pixels, prepared pixels, ICC, and video bytes.')
    for key in ('nativeFrameHashes', 'preparedFrameHashes'):
        frames = report.get(key)
        if not isinstance(frames, list) or len(frames) != CONTRACT['video']['frames'] or any(
                not isinstance(frame, dict) or type(frame.get('frame')) is not int or frame['frame'] != index
                or not re.fullmatch('[a-f0-9]{64}', str(frame.get('baseline', '')))
                or frame.get('baseline') != frame.get('candidate') for index, frame in enumerate(frames)):
            raise ValueError('Equivalence evidence requires every matching frame hash: ' + key)
    if not re.fullmatch('[a-f0-9]{64}', str(report.get('baselineVideoSha256', ''))) or report.get('baselineVideoSha256') != report.get('candidateVideoSha256'):
        raise ValueError('Equivalence evidence requires matching video SHA-256 values.')


def validate_source_history(state, job, metadata):
    history = metadata.get('renderSourceHistory', [])
    if not isinstance(history, list):
        raise ValueError('Invalid rendering source history.')
    previous, boundary = job['sourceId'], 0
    for entry in history:
        if not isinstance(entry, dict) or type(entry.get('fromCard')) is not int or entry['fromCard'] not in job['ids'] or entry['fromCard'] <= boundary:
            raise ValueError('Rendering source boundaries must increase within the pinned card selection.')
        candidate = entry.get('sourceId')
        if entry.get('previousSourceId') != previous or not re.fullmatch('[a-f0-9]{64}', str(candidate)) or candidate == previous or entry.get('contractSha256') != job['contractSha256']:
            raise ValueError('Rendering source history has an invalid source or contract identity.')
        evidence = entry.get('evidence', {})
        digest = evidence.get('sha256', '')
        path = directory(state, job['name']) / 'source-upgrades' / (digest + '.json')
        if not re.fullmatch('[a-f0-9]{64}', digest) or evidence.get('path') != str(path):
            raise ValueError('Rendering source equivalence evidence has an invalid location.')
        report = read(path)
        if file_hash(path) != digest:
            raise ValueError('Rendering source equivalence evidence checksum changed.')
        validate_equivalence(report, job, previous, candidate)
        proof = entry.get('unchangedRenderInputs', {})
        changed = proof.get('changedFiles')
        if proof.get('baselineSourceId') != previous or proof.get('candidateSourceId') != candidate or not isinstance(changed, list) or not changed or changed != sorted(set(changed)) or not set(changed).issubset(SOURCE_UPGRADE_FILES):
            raise ValueError('Rendering source upgrade changed unapproved rendering inputs.')
        previous, boundary = candidate, entry['fromCard']


def upgrade_source(state, job, metadata, from_card, evidence_path):
    if status(state, job['name'])['supervisorRunning']:
        raise RuntimeError('Interrupt the active job before upgrading its rendering source.')
    ensure_exclusive_native(state)
    publication = verify_catalog(state, job, metadata)
    pending = pending_cards(job, publication)
    if not pending or type(from_card) is not int or from_card != pending[0]:
        raise ValueError('Source upgrade must start at the first unpublished card after all earlier cards are verified.')
    if any(int(card) >= from_card for card in publication['videos']):
        raise ValueError('Source upgrade cannot cross an already published card; complete the earlier gap first.')
    for card in pending:
        for backend in ('vm', 'host'):
            if (execution_directory(state, job, backend, card) / 'execution.json').exists():
                raise RuntimeError(f'Card {card} already has a {backend} execution. Finish and publish its original checkpoints before upgrading the source.')
    baseline_id = source_for_card(job, metadata, from_card)
    baseline = verify_snapshot(Path(state) / 'releases' / baseline_id, baseline_id)
    original_evidence = Path(evidence_path).expanduser().absolute()
    report = read(original_evidence)
    evidence_sha = file_hash(original_evidence)
    with tempfile.TemporaryDirectory(prefix='source-upgrade-', dir=state) as temporary:
        staging = Path(temporary) / 'source'
        candidate = snapshot(staging)
        candidate_id = candidate['sourceId']
        if candidate_id == baseline_id:
            raise ValueError('The rendering source is already current.')
        changed = sorted(name for name in set(baseline['files']) | set(candidate['files']) if baseline['files'].get(name) != candidate['files'].get(name))
        if not set(changed).issubset(SOURCE_UPGRADE_FILES):
            raise ValueError('Source upgrade changed unapproved rendering inputs: ' + ', '.join(name for name in changed if name not in SOURCE_UPGRADE_FILES))
        if candidate['files'].get('scripts/mi-note-video/contract.json') != job['contractSha256']:
            raise ValueError('Source upgrade cannot change the rendering contract.')
        validate_equivalence(report, job, baseline_id, candidate_id)
        release = Path(state) / 'releases' / candidate_id
        publish_snapshot(staging, release, candidate)
    evidence_root = directory(state, job['name']) / 'source-upgrades'
    evidence_root.mkdir(exist_ok=True)
    if evidence_root.resolve() != evidence_root:
        raise ValueError('Source upgrade evidence directory must not contain symlinks.')
    retained = evidence_root / (evidence_sha + '.json')
    if not retained.exists():
        with tempfile.TemporaryDirectory(prefix='.evidence-', dir=evidence_root) as temporary:
            pending_evidence = Path(temporary) / 'report.json'
            shutil.copyfile(original_evidence, pending_evidence)
            if file_hash(pending_evidence) != evidence_sha:
                raise ValueError('Source equivalence evidence changed during retention.')
            with pending_evidence.open('rb') as stream:
                os.fsync(stream.fileno())
            os.link(pending_evidence, retained)
    if retained.resolve() != retained or file_hash(retained) != evidence_sha:
        raise ValueError('Retained source equivalence evidence changed.')
    from collect import fsync_directory
    fsync_directory(evidence_root)
    entry = {'fromCard': from_card, 'previousSourceId': baseline_id, 'sourceId': candidate_id,
             'contractSha256': job['contractSha256'], 'upgradedAt': now(),
             'evidence': {'path': str(retained), 'sha256': evidence_sha},
             'unchangedRenderInputs': {'baselineSourceId': baseline_id, 'candidateSourceId': candidate_id, 'changedFiles': changed}}
    updated = {**metadata, 'renderSourceHistory': [*metadata.get('renderSourceHistory', []), entry],
               'controllerSourceId': candidate_id,
               'controllerHistory': list(dict.fromkeys([*metadata.get('controllerHistory', []), metadata.get('controllerSourceId', job['sourceId'])]))}
    validate_source_history(state, job, updated)
    from background import write_control
    write_control(state, job, release)
    atomic_json(directory(state, job['name']) / 'job-meta.json', updated)
    return {'job': job['name'], 'fromCard': from_card, 'sourceId': candidate_id,
            'previousSourceId': baseline_id, 'evidence': entry['evidence'], 'status': 'source-upgraded'}


def controller_root(state, job, metadata):
    identity = metadata.get('controllerSourceId', job['sourceId'])
    if not re.fullmatch('[a-f0-9]{64}', str(identity)):
        raise ValueError('Invalid controller source identity.')
    root = Path(state) / 'releases' / identity
    if identity != job['sourceId']:
        manifest = verify_snapshot(root, identity)
        if manifest['files'].get('scripts/mi-note-video/contract.json') != job['contractSha256']:
            raise RuntimeError('Controller refresh cannot change the rendering contract.')
    return root


def refresh_controller(state, job, metadata):
    if status(state, job['name'])['supervisorRunning']:
        raise RuntimeError('Interrupt the active job before refreshing its controller.')
    ensure_exclusive_native(state)
    previous = controller_root(state, job, metadata)
    with tempfile.TemporaryDirectory(prefix='controller-', dir=state) as temporary:
        staging = Path(temporary) / 'source'
        manifest = snapshot(staging)
        if manifest['files'].get('scripts/mi-note-video/contract.json') != job['contractSha256']:
            raise RuntimeError('Controller refresh cannot change the rendering contract.')
        root = Path(state) / 'releases' / manifest['sourceId']
        publish_snapshot(staging, root, manifest)
    updated = {**metadata, 'controllerSourceId': manifest['sourceId'],
               'controllerHistory': list(dict.fromkeys([*metadata.get('controllerHistory', []), previous.name]))}
    atomic_json(directory(state, job['name']) / 'job-meta.json', updated)
    from background import write_control
    write_control(state, job, root)
    return updated


def manifest_path(metadata):
    return Path(metadata['output']) / '.catalog-manifest.json'


def empty_manifest(job):
    return {key: job[key] for key in ('version', 'jobId', 'sourceId', 'ids', 'profile', 'motion', 'retention')} | {'videos': {}, 'status': 'pending'}


def read_manifest(job, metadata):
    path = manifest_path(metadata)
    manifest = read(path) if path.exists() else empty_manifest(job)
    for key in ('version', 'jobId', 'sourceId', 'ids', 'profile', 'motion', 'retention'):
        if manifest.get(key) != job[key]:
            raise RuntimeError('Catalog publication belongs to another immutable job.')
    if not isinstance(manifest.get('videos'), dict) or any(key not in {str(card) for card in job['ids']} for key in manifest['videos']):
        raise RuntimeError('Unexpected card in catalog publication.')
    return manifest


def execution_directory(state, job, backend, card):
    return directory(state, job['name']) / 'executions' / backend / str(card)


def validate_execution(logical, metadata, backend, card, catalog_metadata=None):
    job = validate_job(metadata['job'])
    if metadata.get('catalogJobId') != logical['jobId'] or metadata.get('backend') != backend:
        raise RuntimeError('Execution belongs to another catalog or backend.')
    if job.get('sourceId') != source_for_card(logical, catalog_metadata or {}, card):
        raise RuntimeError('Execution rendering identity changed: sourceId')
    for key in ('profile', 'motion', 'catalogCount', 'contractSha256'):
        if job.get(key) != logical[key]:
            raise RuntimeError('Execution rendering identity changed: ' + key)
    if job.get('backend', 'vm') != backend or job['ids'] != [card]:
        raise RuntimeError('Execution card selection changed.')
    if 'pipeline' in job and job['pipeline']['catalogJobId'] != logical['jobId']:
        raise RuntimeError('Pipeline execution belongs to another catalog.')
    return job


def verify_catalog(state, job, metadata):
    from collect import verify_publication, verify_video
    manifest = read_manifest(job, metadata)
    source_cache = {}
    for key, item in manifest['videos'].items():
        card = int(key)
        execution_root = execution_directory(state, job, item['backend'], card)
        execution = read(execution_root / 'execution.json')
        native_job = validate_execution(job, execution, item['backend'], card, metadata)
        if item['executionId'] != native_job['jobId']:
            raise RuntimeError('Published card execution changed.')
        publication = verify_publication(native_job, execution['output'], source_root=source_root(state, native_job), source_cache=source_cache)
        if publication.get('status') != 'complete':
            raise RuntimeError('Published card lacks a completed execution.')
        video = publication['videos'][key]
        expected = Path(metadata['output']) / f'{card}.mp4'
        if item['path'] != str(expected) or item['sha256'] != video['sha256'] or item['bytes'] != video['bytes']:
            raise RuntimeError('Published catalog video identity changed.')
        verify_video(expected, video)
    return manifest


def pending_cards(job, manifest, from_id=None):
    completed = {int(value) for value in manifest['videos']}
    if from_id is not None:
        if from_id not in job['ids']:
            raise ValueError('--from-id must be an ID in the pinned card selection.')
        missing = next((card for card in job['ids'] if card < from_id and card not in completed), None)
        if missing is not None:
            raise ValueError(f'Cannot start at {from_id}: earlier card {missing} is not verified. Resume without --from-id to fill the gap.')
    return [card for card in job['ids'] if card not in completed]


def boundary_target(state, job, manifest, active_cards=()):
    path = directory(state, job['name']) / 'stop-after-card.json'
    if not path.exists():
        return None
    request = read(path)
    if request.get('jobId') != job['jobId']:
        raise ValueError('The card-boundary stop request belongs to another catalog.')
    target = request.get('throughCard')
    if target is not None and (type(target) is not int or target not in job['ids']):
        raise ValueError('The card-boundary stop request contains an invalid card.')
    if target is None:
        target = max(active_cards, default=next(iter(pending_cards(job, manifest)), job['ids'][-1]))
    target = max([target, *active_cards])
    save_changed(path, {**request, 'throughCard': target})
    return target


def boundary_reached(job, manifest, target):
    return target is not None and all(str(card) in manifest['videos'] for card in job['ids'] if card <= target)


def initialize_catalog_files(state, job, metadata):
    Path(metadata['output']).mkdir(parents=True, exist_ok=True)
    if not manifest_path(metadata).exists():
        atomic_json(manifest_path(metadata), empty_manifest(job))
    control = directory(state, job['name']) / 'control.command'
    if not control.exists():
        from background import write_control
        write_control(state, job, controller_root(state, job, metadata))


def create(state, args):
    root = directory(state, args.job)
    if root.exists():
        raise ValueError('This job already exists; use resume or choose a new name.')
    backend_name = args.backend or 'vm'
    ensure_exclusive_native(state)
    backend = backend_for(state, backend_name)
    output = Path(args.output or Path(state) / 'outputs' / args.job).expanduser().absolute()
    if output.resolve() != output or (output.exists() and any(output.iterdir())):
        raise ValueError('A new catalog requires an empty output directory without symlinks.')
    check_capacity(state, output)
    backend_ready(backend)
    from cli import assert_idle
    assert_idle(backend)
    prepared = prepare(backend, state)
    ids = select_ids(args.ids, args.all, prepared['catalogCount'])
    job = {'version': 2, 'jobId': str(uuid.uuid4()), 'name': args.job, 'ids': ids, 'catalogCount': prepared['catalogCount'],
           'profile': args.profile, 'motion': args.motion, 'retention': args.retention,
           'sourceId': prepared['sourceId'], 'contractSha256': prepared['contractSha256'], 'output': str(output), 'createdAt': now()}
    metadata = {'version': 2, 'job': job, 'output': str(output)}
    root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.create-', dir=root.parent) as temporary:
        staging = Path(temporary) / 'job'
        staging.mkdir()
        atomic_json(staging / 'job.json', job)
        atomic_json(staging / 'job-meta.json', metadata)
        atomic_json(staging / 'catalog-state.json', {'status': 'ready', 'backend': backend_name, 'currentCard': None, 'updatedAt': now()})
        from collect import fsync_directory
        fsync_directory(staging)
        staging.rename(root)
        fsync_directory(root.parent)
    initialize_catalog_files(state, job, metadata)
    return job, metadata


def status(state, name):
    job, metadata = load(state, name)
    path = directory(state, name) / 'catalog-state.json'
    current = read(path) if path.exists() else {'status': 'ready', 'backend': 'vm', 'currentCard': None}
    manifest = read_manifest(job, metadata)
    running = VM(state)._process_alive(current.get('supervisor'))
    if current.get('supervisor') and not running and current['status'] not in TERMINAL:
        current = {**current, 'lastPhase': current['status'], 'status': 'needs-resume'}
    return {**current, 'job': name, 'profile': job['profile'], 'motion': job['motion'], 'retention': job['retention'],
            'supervisorRunning': running,
            'collected': len(manifest['videos']), 'total': len(job['ids']), 'output': metadata['output'],
            'control': str(directory(state, name) / 'control.command')}


def native_arguments(backend, job):
    return [backend.config['node'], job['sourceRoot'] + '/scripts/mi-note-video/guest-runner.mjs', '--job', job['root'] + '/job.json']


def active_executions(state, job):
    root = directory(state, job['name'])
    plural = root / 'active-executions.json'
    if plural.exists():
        value = read(plural)
        entries = value.get('executions')
        if value.get('version') != 1 or value.get('catalogJobId') != job['jobId'] or not isinstance(entries, list) or len(entries) > 2:
            raise ValueError('Invalid active pipeline execution inventory.')
    else:
        singular = root / 'active-execution.json'
        entries = [read(singular)] if singular.exists() else []
    if any(entry.get('backend') not in ('host', 'vm') or type(entry.get('currentCard')) is not int or entry['currentCard'] not in job['ids'] for entry in entries):
        raise ValueError('Active execution inventory contains an invalid card or backend.')
    if len({entry['currentCard'] for entry in entries}) != len(entries):
        raise ValueError('Active execution inventory contains duplicate cards.')
    return entries


def save_active_executions(state, job, contexts):
    root = directory(state, job['name'])
    entries = [{'backend': context['execution']['backend'], 'currentCard': context['execution']['job']['ids'][0],
                'executionId': context['execution']['job']['jobId']} for context in contexts]
    atomic_json(root / 'active-executions.json', {'version': 1, 'catalogJobId': job['jobId'], 'executions': entries})
    (root / 'active-execution.json').unlink(missing_ok=True)


def native_running(backend, job):
    from cli import service_running
    if getattr(backend, 'kind', 'vm') == 'vm' and not backend.status().get('running'):
        return False
    return service_running(backend, 'org.mons.mi-note-render.' + job['name'], native_arguments(backend, job), job['sourceRoot'], job['root'])


def stop_native(backend, job):
    from cli import interrupt
    if native_running(backend, job):
        interrupt(backend, job)


def request_interrupt(state, name, after_card=False):
    current = status(state, name)
    job, metadata = load(state, name)
    if after_card:
        manifest = read_manifest(job, metadata)
        pending = pending_cards(job, manifest)
        if not pending:
            return {'job': name, 'status': current['status'], 'interruptionRequested': False}
        target = max((entry['currentCard'] for entry in active_executions(state, job)), default=pending[0])
        atomic_json(directory(state, name) / 'stop-after-card.json', {'jobId': job['jobId'], 'requestedAt': now(), 'throughCard': target})
        return {'job': name, 'interruptionRequested': True, 'afterCurrentCard': True}
    active = active_executions(state, job)
    if not active and not pending_cards(job, read_manifest(job, metadata)):
        return {'job': name, 'status': current['status'], 'interruptionRequested': False}
    atomic_json(directory(state, name) / 'interrupt-request.json', {'requestedAt': now()})
    for entry in active or [current]:
        if not entry.get('currentCard'):
            continue
        execution_path = execution_directory(state, job, entry['backend'], entry['currentCard']) / 'execution.json'
        if execution_path.exists():
            execution = read(execution_path)
            native_job = validate_execution(job, execution, entry['backend'], entry['currentCard'], metadata)
            if entry.get('executionId', native_job['jobId']) != native_job['jobId']:
                raise ValueError('Active execution identity changed.')
            stop_native(backend_for(state, entry['backend']), native_job)
    return {'job': name, 'interruptionRequested': True}


def ensure_other_idle(state, job, backend_name):
    for current in active_executions(state, job) or [status(state, job['name'])]:
        if current.get('backend') == backend_name or not current.get('currentCard'):
            continue
        path = execution_directory(state, job, current['backend'], current['currentCard']) / 'execution.json'
        if path.exists() and native_running(backend_for(state, current['backend']), read(path)['job']):
            raise RuntimeError('The previous backend is still running. Interrupt this job and wait for it to stop before switching backends.')


def ensure_exclusive_native(state, logical=None, selected_backend=None):
    from cli import assert_idle
    active = active_executions(state, logical) if logical else []
    for kind in ('vm', 'host'):
        marker = Path(state) / ('config.json' if kind == 'vm' else 'host/runtime/runtime.json')
        if not marker.exists():
            continue
        backend = backend_for(state, kind)
        if kind == 'vm' and not backend.status().get('running'):
            continue
        allowed = []
        for entry in active:
            if kind != selected_backend or kind != entry['backend']:
                continue
            path = execution_directory(state, logical, kind, entry['currentCard']) / 'execution.json'
            if path.exists():
                execution = read(path)
                native_job = validate_execution(logical, execution, kind, entry['currentCard'], load(state, logical['name'])[1])
                if entry.get('executionId') != native_job['jobId']:
                    raise ValueError('Active execution identity changed.')
                if native_running(backend, native_job):
                    allowed.append(native_job)
        assert_idle(backend, allowed_jobs=allowed)


def execution_for(state, logical, backend_name, backend, prepared, card):
    catalog_metadata = load(state, logical['name'])[1]
    if prepared['sourceId'] != source_for_card(logical, catalog_metadata, card):
        raise RuntimeError('Prepared rendering source differs from the selected card source.')
    root = execution_directory(state, logical, backend_name, card)
    path = root / 'execution.json'
    if path.exists():
        metadata = read(path)
        native_job = validate_execution(logical, metadata, backend_name, card, catalog_metadata)
        if native_job['runtime'] != prepared['runtime'] or native_job['sourceRoot'] != prepared['guestSourceRoot']:
            raise RuntimeError('The saved execution runtime or paths changed; restore this backend or select the other backend. Partial frames are preserved.')
        return metadata
    name = f"catalog-{logical['jobId'].replace('-', '')[:16]}-{backend_name}-{card}"
    native_job = create_job(name, [card], logical['profile'], logical['motion'], prepared, backend.config)
    native_job['backend'] = backend_name
    if backend_name == 'host' and pipeline_capability(state, prepared['sourceId']):
        native_job['pipeline'] = {'version': 1, 'catalogJobId': logical['jobId'], 'maxUnfinished': 2}
    root.mkdir(parents=True, exist_ok=True)
    metadata = {'version': 1, 'catalogJobId': logical['jobId'], 'backend': backend_name, 'job': native_job,
                'output': str(root / 'published'), 'evidence': str(root / 'evidence')}
    atomic_json(path, metadata)
    return metadata


def publish_card(state, logical, metadata, execution, manifest):
    from collect import verify_publication, verify_video, fsync_directory
    native_job = validate_execution(logical, execution, execution['backend'], execution['job']['ids'][0], metadata)
    publication = verify_publication(native_job, execution['output'], source_root=source_root(state, native_job))
    if publication.get('status') != 'complete':
        raise RuntimeError('Cannot publish an unfinished execution.')
    card = native_job['ids'][0]
    item = publication['videos'][str(card)]
    target = Path(metadata['output']) / f'{card}.mp4'
    if target.exists() or target.is_symlink():
        verify_video(target, item)
    else:
        try:
            os.link(item['path'], target)
        except OSError as error:
            if error.errno != 18:
                raise
            temporary = target.with_name('.' + target.name + '.' + uuid.uuid4().hex)
            try:
                with open(item['path'], 'rb') as incoming, temporary.open('xb') as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
                    outgoing.flush()
                    os.fsync(outgoing.fileno())
                verify_video(temporary, item)
                os.link(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        fsync_directory(target.parent)
    verify_video(target, item)
    manifest['videos'][str(card)] = {'id': card, 'path': str(target), 'bytes': item['bytes'], 'sha256': item['sha256'],
                                    'backend': execution['backend'], 'executionId': native_job['jobId'], 'verifiedAt': now()}
    manifest['status'] = 'complete' if len(manifest['videos']) == len(logical['ids']) else 'pending'
    atomic_json(manifest_path(metadata), manifest)


def superseded_executions(state, logical, backend_name, manifest):
    catalog_metadata = load(state, logical['name'])[1]
    for key, item in manifest['videos'].items():
        if item['backend'] == backend_name:
            continue
        path = execution_directory(state, logical, backend_name, int(key)) / 'execution.json'
        if not path.exists():
            continue
        execution = read(path)
        if not execution.get('supersededAt'):
            yield path, execution, validate_execution(logical, execution, backend_name, int(key), catalog_metadata)


def cleanup_superseded(state, logical, backend_name, backend, manifest):
    script = '''import json,pathlib,shutil,sys
root=pathlib.Path(sys.argv[1]);expected=json.loads(sys.argv[2])
identity=root/'job.json'
if root.resolve()!=root: raise RuntimeError('Superseded execution identity changed')
if not identity.exists():
 if identity.is_symlink() or (root.exists() and (not root.is_dir() or any(root.iterdir()))): raise RuntimeError('Uninitialized superseded execution contains unowned data')
 print('uninitialized');sys.exit(0)
if identity.resolve()!=identity or not identity.is_file() or json.loads(identity.read_text())!=expected: raise RuntimeError('Superseded execution identity changed')
unit=root/'cards'/str(expected['ids'][0])
for name in ('capture','preflight','output','transfer'):
 p=unit/name
 if p.exists():
  if p.resolve()!=p or not p.is_dir(): raise RuntimeError('Unsafe superseded checkpoint path')
  shutil.rmtree(p)
receipts=root/'screenshot-transfers'
if receipts.exists():
 if receipts.resolve()!=receipts or not receipts.is_dir(): raise RuntimeError('Unsafe screenshot receipt directory')
 shutil.rmtree(receipts)
print('cleaned')'''
    for path, execution, native_job in superseded_executions(state, logical, backend_name, manifest):
        if native_running(backend, native_job):
            raise RuntimeError('A superseded execution is still running; interrupt it before continuing.')
        backend.exec([backend.config['python'], '-c', script, native_job['root'], json.dumps(native_job)])
        execution['supersededAt'] = now()
        atomic_json(path, execution)


def cleanup_available(state, logical, manifest):
    for kind in ('vm', 'host'):
        if not any(superseded_executions(state, logical, kind, manifest)):
            continue
        backend = backend_for(state, kind)
        if kind == 'vm' and not backend.status().get('running'):
            continue
        cleanup_superseded(state, logical, kind, backend, manifest)


def run_execution(state, logical, metadata, execution, backend, stopped, update):
    from cli import assert_idle, ensure_guest_job, launch, read_current_status
    from collect import collect
    job = execution['job']
    ensure_guest_job(backend, job)
    previous_attempt = None
    if not native_running(backend, job):
        check_capacity(state, metadata['output'], 12 * 1024 ** 3)
        assert_idle(backend)
        try:
            previous_attempt = read_current_status(backend, job)['attempt']
        except RuntimeError:
            pass
        launch(backend, 'org.mons.mi-note-render.' + job['name'], native_arguments(backend, job), job['sourceRoot'], job['root'])
    deadline = time.monotonic() + 45
    last = None
    try:
        while True:
            if stopped():
                raise Interrupted('Interruption requested; native checkpoints are preserved.')
            check_capacity(state, metadata['output'])
            try:
                current = read_current_status(backend, job, previous_attempt)
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1)
                continue
            if current is None:
                if time.monotonic() >= deadline:
                    raise RuntimeError('The execution did not publish a fresh attempt.')
                time.sleep(1)
                continue
            previous_attempt = None
            if current['status'] not in ('complete', 'failed', 'interrupted') and not native_running(backend, job):
                current = read_current_status(backend, job)
                if current['status'] not in ('complete', 'failed', 'interrupted'):
                    raise RuntimeError('The native renderer exited without a terminal checkpoint. Resume this job to recover its saved frames.')
            try:
                result = collect(backend, job, execution['output'], execution['evidence'],
                                 retention=logical['retention'], source_root=source_root(state, job), minimum_free_bytes=MINIMUM_HOST_FREE)
            except RuntimeError as error:
                if str(error).startswith('Insufficient collector disk space:'):
                    raise LowSpace(str(error)) from error
                raise
            summary = (current['status'], result['collected'])
            if summary != last:
                phase = 'publishing' if current['status'] == 'complete' else current['status']
                update(phase, job['ids'][0], execution['backend'])
                print(json.dumps({'job': logical['name'], 'backend': execution['backend'], 'card': job['ids'][0], 'phase': current['status']}), flush=True)
                last = summary
            if current['status'] == 'complete':
                if result['status'] != 'complete':
                    raise RuntimeError('Execution ended before durable host verification.')
                exit_deadline = time.monotonic() + 45
                while native_running(backend, job):
                    if time.monotonic() > exit_deadline:
                        raise RuntimeError('The completed native renderer did not release its execution. Check its log before resuming.')
                    time.sleep(0.2)
                return
            if current['status'] in ('failed', 'interrupted'):
                error = current.get('error') or 'Native execution stopped.'
                if current['status'] == 'interrupted':
                    raise Interrupted(error)
                raise RuntimeError(error)
            time.sleep(0.2 if result.get('published') else 3)
    except BaseException:
        with contextlib.suppress(OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            stop_native(backend, job)
        raise


def capture_released(job, current):
    release = current.get('captureReleased', {})
    expected = Path(job['root']) / 'cards' / str(job['ids'][0]) / 'capture-complete.json'
    if not job.get('pipeline') or release.get('attempt') != current.get('attempt') or release.get('path') != str(expected):
        return False
    if not re.fullmatch('[a-f0-9]{64}', str(release.get('sha256', ''))):
        raise ValueError('Pipeline capture release has an invalid checksum.')
    marker = read(expected)
    if file_hash(expected) != release['sha256'] or any(marker.get(key) != job[key] for key in ('jobId', 'sourceId', 'profile', 'motion')) or marker.get('attempt') != current['attempt'] or marker.get('cardId') != job['ids'][0] or marker.get('safariReleased') is not True:
        raise ValueError('Pipeline capture release identity changed.')
    owner = Path(job['root']).parent.parent / 'render.lock/owner.json'
    if owner.exists() and read(owner).get('jobId') == job['jobId']:
        return False
    return True


def start_pipeline_execution(state, logical, metadata, context, backend, active):
    from cli import assert_idle, ensure_guest_job, launch, read_current_status
    execution = context['execution']
    job = execution['job']
    ensure_guest_job(backend, job)
    context.update({'previousAttempt': None, 'deadline': time.monotonic() + 45, 'current': None})
    if native_running(backend, job):
        return
    check_capacity(state, metadata['output'], 12 * 1024 ** 3)
    assert_idle(backend, allowed_jobs=[item['execution']['job'] for item in active if item is not context])
    try:
        context['previousAttempt'] = read_current_status(backend, job)['attempt']
    except RuntimeError:
        pass
    launch(backend, 'org.mons.mi-note-render.' + job['name'], native_arguments(backend, job), job['sourceRoot'], job['root'])


def poll_pipeline_execution(state, logical, context, backend):
    from cli import read_current_status
    from collect import collect
    execution = context['execution']
    job = execution['job']
    try:
        current = read_current_status(backend, job, context['previousAttempt'])
    except RuntimeError:
        if time.monotonic() >= context['deadline']:
            raise
        return False
    if current is None:
        if time.monotonic() >= context['deadline']:
            raise RuntimeError('The pipeline execution did not publish a fresh attempt.')
        return False
    context['previousAttempt'] = None
    running = native_running(backend, job)
    if current['status'] not in ('complete', 'failed', 'interrupted') and not running:
        current = read_current_status(backend, job)
        if current['status'] not in ('complete', 'failed', 'interrupted'):
            raise RuntimeError('A pipeline renderer exited without a terminal checkpoint. All unfinished cards are preserved.')
    context['current'] = current
    if current['status'] in ('failed', 'interrupted'):
        error = current.get('error') or 'Native pipeline execution stopped.'
        raise Interrupted(error) if current['status'] == 'interrupted' else RuntimeError(error)
    if current['status'] not in ('awaiting-collection', 'unit-complete', 'complete'):
        return False
    try:
        result = collect(backend, job, execution['output'], execution['evidence'], retention=logical['retention'],
                         source_root=source_root(state, job), minimum_free_bytes=MINIMUM_HOST_FREE)
    except RuntimeError as error:
        if str(error).startswith('Insufficient collector disk space:'):
            raise LowSpace(str(error)) from error
        raise
    if current['status'] != 'complete':
        return False
    if result['status'] != 'complete':
        raise RuntimeError('Pipeline execution ended before durable host verification.')
    if running:
        context.setdefault('exitDeadline', time.monotonic() + 45)
        if time.monotonic() > context['exitDeadline']:
            raise RuntimeError('Completed pipeline renderer did not release its execution ownership.')
        return False
    return True


def run_pipeline(state, logical, metadata, remaining, backend, prepared_sources, manifest, stopped, update):
    root = directory(state, logical['name'])
    boundary = root / 'stop-after-card.json'
    active = []
    pending = list(remaining)
    saved = active_executions(state, logical)
    target = boundary_target(state, logical, manifest, [entry['currentCard'] for entry in saved])
    for entry in saved:
        if entry['backend'] != 'host' or entry['currentCard'] not in pending:
            continue
        execution = read(execution_directory(state, logical, 'host', entry['currentCard']) / 'execution.json')
        native_job = validate_execution(logical, execution, 'host', entry['currentCard'], metadata)
        if native_job['jobId'] != entry['executionId'] or not native_job.get('pipeline'):
            raise ValueError('Saved pipeline execution identity changed.')
        active.append({'execution': execution})
        pending.remove(entry['currentCard'])
    active.sort(key=lambda item: item['execution']['job']['ids'][0])
    draining = target is not None
    last_summary = None
    try:
        for context in active:
            if native_running(backend, context['execution']['job']):
                start_pipeline_execution(state, logical, metadata, context, backend, active)
                context['launched'] = True
        while active or pending:
            if stopped():
                raise Interrupted('Interruption requested; all pipeline checkpoints are preserved.')
            check_capacity(state, metadata['output'])
            target = boundary_target(state, logical, manifest, [item['execution']['job']['ids'][0] for item in active])
            draining = target is not None
            for context in active:
                if context.get('launched') and not context.get('done'):
                    context['done'] = poll_pipeline_execution(state, logical, context, backend)
            while active and active[0].get('done'):
                context = active[0]
                execution = context['execution']
                card = execution['job']['ids'][0]
                publish_card(state, logical, metadata, execution, manifest)
                active.pop(0)
                save_active_executions(state, logical, active)
                cleanup_available(state, logical, {'videos': {str(card): manifest['videos'][str(card)]}})
                print(json.dumps({'job': logical['name'], 'collected': len(manifest['videos']), 'total': len(logical['ids']), 'card': card}), flush=True)
            target = boundary_target(state, logical, manifest, [item['execution']['job']['ids'][0] for item in active])
            draining = target is not None
            deferred = next((item for item in active if not item.get('launched')), None)
            running = [item for item in active if item.get('launched')]
            if deferred and all(item.get('current') and capture_released(item['execution']['job'], item['current']) for item in running):
                start_pipeline_execution(state, logical, metadata, deferred, backend, active)
                deferred['launched'] = True
            if not active and boundary_reached(logical, manifest, target):
                boundary.unlink(missing_ok=True)
                save_active_executions(state, logical, [])
                update('complete' if not pending else 'interrupted', None, stoppedAfterCard=target, activeExecutions=[])
                return not pending
            can_start = pending and len(active) < 2 and (not draining or not active)
            if can_start and all(item.get('current') and capture_released(item['execution']['job'], item['current']) for item in active):
                card = pending.pop(0)
                selected_source = source_for_card(logical, metadata, card)
                execution = execution_for(state, logical, 'host', backend, prepared_sources[selected_source], card)
                if not execution['job'].get('pipeline'):
                    raise ValueError('An unpinned execution cannot enter the pipeline.')
                context = {'execution': execution}
                active.append(context)
                save_active_executions(state, logical, active)
                start_pipeline_execution(state, logical, metadata, context, backend, active)
                context['launched'] = True
            details = [{'card': item['execution']['job']['ids'][0], 'status': (item.get('current') or {}).get('status', 'starting')}
                       for item in active]
            summary = json.dumps(details, sort_keys=True)
            if summary != last_summary:
                update('pipelining' if len(active) > 1 else details[0]['status'] if details else 'publishing',
                       details[-1]['card'] if details else None, activeExecutions=details, draining=draining)
                last_summary = summary
            if active:
                time.sleep(0.5)
        save_active_executions(state, logical, [])
        return True
    except BaseException:
        for context in active:
            with contextlib.suppress(OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                stop_native(backend, context['execution']['job'])
        raise


def begin_resume(state, name):
    (directory(state, name) / 'interrupt-request.json').unlink(missing_ok=True)


def check_interruption(state, name):
    if (directory(state, name) / 'interrupt-request.json').exists():
        raise Interrupted('Interruption requested during resume startup.')


def run(state, name, backend_name=None, from_id=None, *, preserve_interrupt=False):
    logical, metadata = load(state, name)
    if not preserve_interrupt:
        begin_resume(state, name)
    initialize_catalog_files(state, logical, metadata)
    root = directory(state, name)
    backend_name = backend_name or status(state, name)['backend']
    ensure_other_idle(state, logical, backend_name)
    ensure_exclusive_native(state, logical, backend_name)
    interrupted = False
    def stop(signum, frame):
        nonlocal interrupted
        interrupted = True
    request = root / 'interrupt-request.json'
    boundary_request = root / 'stop-after-card.json'
    if boundary_request.exists() and read(boundary_request).get('jobId') != logical['jobId']:
        raise ValueError('The card-boundary stop request belongs to another catalog.')
    handlers = {value: signal.signal(value, stop) for value in (signal.SIGTERM, signal.SIGINT)}
    current_card = None
    process = VM(state)
    supervisor = {'pid': os.getpid(), 'start': process._process_value(os.getpid(), 'lstart'),
                  'command': process._process_value(os.getpid(), 'command')}
    def stopped():
        return interrupted or request.exists()
    def update(phase, card, selected=backend_name, **extra):
        value = {'status': phase, 'backend': selected, 'currentCard': card, 'updatedAt': now(), 'supervisor': supervisor, **extra}
        atomic_json(root / 'catalog-state.json', value)
    try:
        if stopped():
            raise Interrupted('Interruption requested during resume startup.')
        update('verifying-completed', None)
        manifest = verify_catalog(state, logical, metadata)
        remaining = pending_cards(logical, manifest, from_id)
        if stopped():
            raise Interrupted('Interruption requested during catalog verification.')
        target = boundary_target(state, logical, manifest, [entry['currentCard'] for entry in active_executions(state, logical)])
        if boundary_reached(logical, manifest, target):
            boundary_request.unlink()
            save_active_executions(state, logical, [])
            if remaining:
                update('interrupted', None, stoppedAfterCard=target)
                return 0
        if not remaining:
            if any(superseded_executions(state, logical, backend_name, manifest)):
                backend = backend_for(state, backend_name)
                backend_ready(backend)
                cleanup_superseded(state, logical, backend_name, backend, manifest)
            cleanup_available(state, logical, manifest)
            manifest['status'] = 'complete'
            save_changed(manifest_path(metadata), manifest)
            update('complete', None)
            return 0
        check_capacity(state, metadata['output'])
        backend = backend_for(state, backend_name)
        update('preparing', None)
        backend_ready(backend)
        if stopped():
            raise Interrupted('Interruption requested before backend preparation.')
        prepared_sources = {}
        cleanup_superseded(state, logical, backend_name, backend, manifest)
        pipeline = backend_name == 'host' and all(pipeline_capability(state, source_for_card(logical, metadata, card)) for card in remaining)
        if pipeline:
            for selected_source in dict.fromkeys(source_for_card(logical, metadata, card) for card in remaining):
                prepared_sources[selected_source] = prepare_frozen(backend, state, selected_source)
                if stopped():
                    raise Interrupted('Interruption requested during backend preparation.')
            complete = run_pipeline(state, logical, metadata, remaining, backend, prepared_sources, manifest, stopped, update)
            if complete:
                verify_catalog(state, logical, metadata)
                update('complete', None, activeExecutions=[])
            return 0
        (root / 'active-executions.json').unlink(missing_ok=True)
        for card in remaining:
            if stopped():
                raise Interrupted('Interruption requested between cards.')
            check_capacity(state, metadata['output'])
            current_card = card
            selected_source = source_for_card(logical, metadata, card)
            if selected_source not in prepared_sources:
                prepared_sources[selected_source] = prepare_frozen(backend, state, selected_source)
            prepared = prepared_sources[selected_source]
            if stopped():
                raise Interrupted('Interruption requested during backend preparation.')
            execution = execution_for(state, logical, backend_name, backend, prepared, card)
            active_path = root / 'active-execution.json'
            atomic_json(active_path, {'backend': backend_name, 'currentCard': card, 'executionId': execution['job']['jobId']})
            update('starting', card)
            run_execution(state, logical, metadata, execution, backend, stopped, update)
            publish_card(state, logical, metadata, execution, manifest)
            active_path.unlink()
            cleanup_available(state, logical, {'videos': {str(card): manifest['videos'][str(card)]}})
            print(json.dumps({'job': name, 'collected': len(manifest['videos']), 'total': len(logical['ids']), 'card': card}), flush=True)
            if boundary_reached(logical, manifest, boundary_target(state, logical, manifest, [card])):
                boundary_request.unlink()
                if manifest['status'] != 'complete':
                    update('interrupted', None, stoppedAfterCard=card)
                    return 0
        verify_catalog(state, logical, metadata)
        update('complete', None)
        return 0
    except BaseException as error:
        phase = 'interrupted' if isinstance(error, Interrupted) else 'low-space' if isinstance(error, LowSpace) else 'failed'
        update(phase, current_card, error=str(error))
        raise
    finally:
        for value, handler in handlers.items():
            signal.signal(value, handler)


def collect_current(state, name):
    from collect import collect
    logical, metadata = load(state, name)
    current = status(state, name)
    active = active_executions(state, logical)
    if len(active) > 1:
        results = []
        for entry in sorted(active, key=lambda item: item['currentCard']):
            execution = read(execution_directory(state, logical, entry['backend'], entry['currentCard']) / 'execution.json')
            native_job = validate_execution(logical, execution, entry['backend'], entry['currentCard'], metadata)
            if entry['executionId'] != native_job['jobId']:
                raise ValueError('Active execution identity changed.')
            backend = backend_for(state, entry['backend'])
            backend_ready(backend)
            check_capacity(state, metadata['output'])
            result = collect(backend, native_job, execution['output'], execution['evidence'], retention=logical['retention'],
                             source_root=source_root(state, native_job), minimum_free_bytes=MINIMUM_HOST_FREE)
            if result['status'] == 'complete':
                manifest = verify_catalog(state, logical, metadata)
                pending = pending_cards(logical, manifest)
                if pending and pending[0] == entry['currentCard']:
                    publish_card(state, logical, metadata, execution, manifest)
            results.append(result)
        return {'job': name, 'executions': results}
    if active:
        current = {**current, **active[0]}
    card = current.get('currentCard')
    if not card:
        return current
    path = execution_directory(state, logical, current['backend'], card) / 'execution.json'
    execution = read(path)
    native_job = validate_execution(logical, execution, current['backend'], card, metadata)
    backend = backend_for(state, current['backend'])
    backend_ready(backend)
    check_capacity(state, metadata['output'])
    result = collect(backend, native_job, execution['output'], execution['evidence'], retention=logical['retention'],
                     source_root=source_root(state, native_job), minimum_free_bytes=MINIMUM_HOST_FREE)
    if result['status'] == 'complete':
        publish_card(state, logical, metadata, execution, verify_catalog(state, logical, metadata))
    return result
