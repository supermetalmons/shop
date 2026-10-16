import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

from jobs import CONTRACT, ROOT, create_job, job_name, select_ids, validate_job
from prepare import atomic_json, inspect_runtime, prepare
from vm import VM, private_directory


@contextlib.contextmanager
def exclusive_work(vm):
    state = private_directory(vm.state)
    descriptor = os.open(state / '.work.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError('The VM work lock must be a private regular file owned by the current user.')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another rendering command owns this VM; wait for it to finish or interrupt it.') from None
        yield
    finally:
        os.close(descriptor)


def read(path):
    return json.loads(Path(path).read_text())


def remote_json(vm, path):
    return json.loads(vm.exec(['/bin/cat', path]))


def write_remote_json(vm, path, value):
    with tempfile.TemporaryDirectory(prefix='job-', dir=vm.state) as temporary:
        local = Path(temporary) / 'value.json'
        atomic_json(local, value)
        vm.put(local, path)


def ready(vm):
    if not vm.status().get('running'):
        vm.boot(detach=True)
    deadline = time.monotonic() + 180
    error = None
    while time.monotonic() < deadline:
        try:
            vm.exec(['/usr/bin/id', '-u'], timeout=15)
            report = vm.doctor()
            if report.get('passed'):
                return report
            failed = [name for name, passed in report.get('checks', {}).items() if not passed]
            if failed != ['graphicalSession']:
                raise ValueError('VM prerequisites failed: ' + ', '.join(failed))
            error = RuntimeError('Waiting for the unlocked guest GUI session.')
        except (OSError, RuntimeError, subprocess.SubprocessError) as current:
            error = current
        time.sleep(2)
    raise RuntimeError(f'The rendering VM did not become ready: {error}')


def environment(vm, root):
    config = vm.config
    paths = [str(Path(config[name]).parent) for name in ('node', 'ffmpeg', 'ffprobe', 'python')]
    return {'HOME': config['guestHome'], 'TMPDIR': '/private/tmp', 'MI_NOTE_JOB_ROOT': root,
            'MI_NOTE_FFMPEG': config['ffmpeg'], 'MI_NOTE_FFPROBE': config['ffprobe'],
            'PATH': ':'.join(dict.fromkeys([*paths, '/usr/bin', '/bin', '/usr/sbin', '/sbin']))}


def launch(vm, label, arguments, cwd, root):
    config = vm.config
    uid = config['guestUID']
    domain = f'gui/{uid}'
    service = domain + '/' + label
    plist = {'Label': label, 'ProgramArguments': ['/usr/bin/caffeinate', '-di', *arguments],
             'WorkingDirectory': cwd, 'EnvironmentVariables': environment(vm, root),
             'LimitLoadToSessionType': 'Aqua', 'RunAtLoad': False, 'KeepAlive': False,
             'StandardOutPath': root + '/job.log', 'StandardErrorPath': root + '/job.log'}
    vm.exec(['/bin/mkdir', '-p', root])
    try:
        printed = vm.exec(['/bin/launchctl', 'print', service]).decode()
    except RuntimeError:
        printed = None
    if printed:
        verify_service(vm, printed, label, arguments, cwd, root)
        if 'state = running' in printed:
            raise RuntimeError('This guest service is already running; use status or collect.')
        vm.exec(['/bin/launchctl', 'bootout', service])
    with tempfile.TemporaryDirectory(prefix='launch-', dir=vm.state) as temporary:
        local = Path(temporary) / 'agent.plist'
        local.write_bytes(plistlib.dumps(plist))
        path = root + '/agent.plist'
        vm.put(local, path)
    vm.exec(['/bin/launchctl', 'bootstrap', domain, path])
    vm.exec(['/bin/launchctl', 'kickstart', service])


def verify_service(vm, printed, label, arguments, cwd, root):
    match = re.search(r'(?m)^\s*path = (.+)$', printed)
    path = root + '/agent.plist'
    if not match or match.group(1).strip() != path:
        raise RuntimeError('The registered guest service belongs to another directory.')
    actual = json.loads(vm.exec(['/usr/bin/plutil', '-convert', 'json', '-o', '-', path]))
    if actual.get('Label') != label or actual.get('ProgramArguments') != ['/usr/bin/caffeinate', '-di', *arguments] or actual.get('WorkingDirectory') != cwd:
        raise RuntimeError('The registered guest service has another owner or executable.')


def service_running(vm, label, arguments, cwd, root):
    try:
        value = vm.exec(['/bin/launchctl', 'print', f"gui/{vm.config['guestUID']}/{label}"]).decode()
    except RuntimeError:
        return False
    verify_service(vm, value, label, arguments, cwd, root)
    return 'state = running' in value


def assert_idle(vm):
    script = '''const fs=require('node:fs'),cp=require('node:child_process');
const path=process.argv[1]+'/render.lock/owner.json';
if(fs.existsSync(path)){
 let owner;try{owner=JSON.parse(fs.readFileSync(path))}catch{process.exit(0)}
 if(Number.isSafeInteger(owner.pid)&&owner.pid>1){
  let command='';try{command=cp.execFileSync('/bin/ps',['-p',String(owner.pid),'-o','command='],{encoding:'utf8'})}catch{}
  if(command.includes('/scripts/mi-note-video/guest-runner.mjs'))throw Error('A rendering job is active. Interrupt it before preparing another source snapshot.');
 }
}'''
    vm.exec([vm.config['node'], '-e', script, vm.config['guestRoot']])


def paths(state, name):
    return Path(state) / 'jobs' / job_name(name)


def load_job(state, name):
    directory = paths(state, name)
    metadata = read(directory / 'job-meta.json')
    job = validate_job(metadata['job'])
    if (directory / 'job.json').exists() and read(directory / 'job.json') != job:
        raise RuntimeError('The local job files disagree; no guest data was changed.')
    return job, metadata


def ensure_guest_job(vm, job):
    script = '''import json,os,pathlib,sys,tempfile
job=json.load(sys.stdin);root=pathlib.Path(job['root']);path=root/'job.json'
if root.resolve()!=root: raise RuntimeError('Guest job directory must not traverse symlinks')
if path.exists():
 if json.loads(path.read_text())!=job: raise RuntimeError('Existing guest job identity differs')
else:
 if (root/'job-status.json').exists() or (root/'cards').exists(): raise RuntimeError('Guest work exists without its immutable job identity')
 root.mkdir(parents=True,exist_ok=True)
 descriptor,name=tempfile.mkstemp(prefix='.job-',suffix='.pending',dir=root)
 try:
  with os.fdopen(descriptor,'w') as stream:
   json.dump(job,stream,indent=2);stream.write('\\n');stream.flush();os.fsync(stream.fileno())
  try: os.link(name,path)
  except FileExistsError:
   if json.loads(path.read_text())!=job: raise RuntimeError('Concurrent guest job identity differs')
 finally: os.unlink(name)
print(json.dumps({'jobId':job['jobId'],'ready':True}))'''
    result = json.loads(vm.exec([vm.config['python'], '-c', script], input_bytes=json.dumps(job).encode()))
    if result != {'jobId': job['jobId'], 'ready': True}:
        raise RuntimeError('Guest job initialization returned another identity.')


def read_current_status(vm, job, previous_attempt=None):
    status = remote_json(vm, job['root'] + '/job-status.json')
    if status.get('jobId') != job['jobId'] or status.get('sourceId') != job['sourceId']:
        raise ValueError('Guest job status belongs to another immutable job.')
    if previous_attempt is not None and status.get('attempt') == previous_attempt:
        return None
    return status


def interrupt(vm, job):
    script = '''const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const job=JSON.parse(fs.readFileSync(process.argv[1]));
const state=JSON.parse(fs.readFileSync(job.root+'/job-status.json'));
const owner=JSON.parse(fs.readFileSync(path.dirname(path.dirname(job.root))+'/render.lock/owner.json'));
if(state.jobId!==job.jobId||state.sourceId!==job.sourceId||owner.jobId!==job.jobId||owner.sourceId!==job.sourceId||owner.pid!==state.pid||owner.attempt!==state.attempt)throw Error('Guest job identity changed.');
const started=cp.execFileSync('/bin/ps',['-p',String(owner.pid),'-o','lstart='],{encoding:'utf8'}).trim();
if(started!==owner.started)throw Error('The runner process was replaced.');
const command=cp.execFileSync('/bin/ps',['-p',String(state.pid),'-o','command='],{encoding:'utf8'}).trim();
if(!command.includes(job.sourceRoot+'/scripts/mi-note-video/guest-runner.mjs')||!command.includes(job.root+'/job.json'))throw Error('Guest runner identity changed.');
process.kill(state.pid,'SIGTERM');'''
    vm.exec([vm.config['node'], '-e', script, job['root'] + '/job.json'])


def collect_job(vm, state, name):
    from collect import collect
    job, metadata = load_job(state, name)
    result = collect(vm, job, Path(metadata['output']), Path(metadata['evidence']))
    print(json.dumps(result, indent=2), flush=True)
    return result


def supervise(vm, state, job, metadata, previous_attempt=None):
    from collect import collect
    stopped = False
    def stop(signum, frame):
        nonlocal stopped
        stopped = True
    handlers = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    previous = None
    startup_deadline = time.monotonic() + 30
    try:
        while True:
            if stopped:
                interrupt(vm, job)
                print('Interruption requested; checkpoints are retained. Use resume with the same job name.', flush=True)
                return 130
            try:
                status = read_current_status(vm, job, previous_attempt)
            except RuntimeError:
                if time.monotonic() >= startup_deadline:
                    raise
                time.sleep(1)
                continue
            if status is None:
                if time.monotonic() >= startup_deadline:
                    raise RuntimeError('The restarted guest job did not publish a new attempt; inspect its log.')
                time.sleep(1)
                continue
            previous_attempt = None
            try:
                result = collect(vm, job, Path(metadata['output']), Path(metadata['evidence']))
            except RuntimeError as error:
                if str(error) != 'Another collector owns this host output':
                    raise
                time.sleep(1)
                continue
            atomic_json(paths(state, job['name']) / 'last-status.json', status)
            summary = (status.get('status'), result.get('collected'), status.get('currentCard'))
            if summary != previous:
                print(json.dumps({'job': job['name'], 'status': summary[0], 'collected': result.get('collected'), 'total': len(job['ids']), 'card': summary[2]}), flush=True)
                previous = summary
            if status.get('status') == 'complete':
                if result.get('collected') != len(job['ids']):
                    raise RuntimeError('The guest completed before every host artifact was verified.')
                return 0
            if status.get('status') in ('failed', 'interrupted'):
                raise RuntimeError(status.get('error') or 'The guest job stopped. Check its saved status and resume the same job.')
            time.sleep(3)
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


def run_job(vm, args):
    with exclusive_work(vm):
        return _run_job(vm, args)


def _run_job(vm, args):
    directory = paths(vm.state, args.job)
    if args.command == 'run' and directory.exists():
        if (directory / 'job-meta.json').exists():
            raise ValueError('This job already exists; use resume or choose a new name.')
        preserved = Path(vm.state) / 'incomplete-jobs'
        preserved.mkdir(exist_ok=True)
        directory.rename(preserved / (args.job + '-' + str(uuid.uuid4())))
    ready(vm)
    if args.command == 'run':
        assert_idle(vm)
        prepared = prepare(vm, vm.state)
        ids = select_ids(args.ids, args.all, prepared['catalogCount'])
        job = create_job(args.job, ids, args.profile, args.motion, prepared, vm.config)
        metadata = {'version': 1, 'output': str((args.output or ROOT / 'renderer-samples/mi-note-video' / args.job).resolve()),
                    'evidence': str(directory / 'evidence'), 'job': job}
        directory.mkdir(parents=True)
        atomic_json(directory / 'job-meta.json', metadata)
        atomic_json(directory / 'job.json', job)
    else:
        job, metadata = load_job(vm.state, args.job)
        if inspect_runtime(vm) != job['runtime']:
            raise RuntimeError('The guest runtime changed; the existing job cannot resume.')
    ensure_guest_job(vm, job)
    label = 'org.mons.mi-note-render.' + job['name']
    arguments = [vm.config['node'], job['sourceRoot'] + '/scripts/mi-note-video/guest-runner.mjs', '--job', job['root'] + '/job.json']
    previous_attempt = None
    if not service_running(vm, label, arguments, job['sourceRoot'], job['root']):
        try:
            previous_attempt = read_current_status(vm, job)['attempt']
        except RuntimeError:
            pass
        launch(vm, label, arguments, job['sourceRoot'], job['root'])
    return supervise(vm, vm.state, job, metadata, previous_attempt)


def main():
    parser = argparse.ArgumentParser(description='Standalone native Safari video rendering in an owned macOS VM.')
    parser.add_argument('--state', type=Path, help='Private renderer state directory (defaults to current-user Application Support).')
    commands = parser.add_subparsers(dest='command', required=True)
    adopt = commands.add_parser('adopt', help='Adopt an idle, configured macOS VM and copy its pinned access credentials.')
    for option in ('vm', 'password-file', 'known-hosts'):
        adopt.add_argument('--' + option, type=Path, required=True)
    for option in ('guest-user', 'host-key-alias', 'guest-root', 'node', 'python', 'ffmpeg', 'ffprobe'):
        adopt.add_argument('--' + option, required=True)
    adopt.add_argument('--move', action='store_true', help='Move this task’s owned idle VM into private state instead of keeping its existing location.')
    commands.add_parser('prepare', help='Stage a hashed source snapshot and pinned dependencies; does not render.')
    commands.add_parser('doctor', help='Boot and verify access, the GUI session, and pinned runtimes; does not capture.')
    run = commands.add_parser('run', help='Start a named rendering job. Explicit card selection is required.')
    run.add_argument('--job', required=True, type=job_name)
    group = run.add_mutually_exclusive_group(required=True)
    group.add_argument('--ids')
    group.add_argument('--all', action='store_true')
    run.add_argument('--profile', choices=CONTRACT['profiles'], default=CONTRACT['defaults']['profile'])
    run.add_argument('--motion', choices=CONTRACT['motions'], default=CONTRACT['defaults']['motion'])
    run.add_argument('--output', type=Path)
    for name in ('resume', 'collect', 'interrupt'):
        command = commands.add_parser(name)
        command.add_argument('job', type=job_name)
    status = commands.add_parser('status')
    status.add_argument('job', nargs='?', type=job_name)
    commands.add_parser('vm-stop', help='Stop the owned VM after interrupting active jobs.')
    args = parser.parse_args()
    vm = VM(args.state)
    if args.command == 'adopt':
        result = vm.adopt(args.vm, args.guest_user, args.password_file, args.known_hosts, args.host_key_alias,
                         args.guest_root, args.node, args.python, args.ffmpeg, args.ffprobe, move=args.move)
    elif args.command == 'doctor':
        result = {'guest': ready(vm), 'runtime': inspect_runtime(vm)}
    elif args.command == 'prepare':
        with exclusive_work(vm):
            ready(vm)
            assert_idle(vm)
            result = prepare(vm, vm.state)
    elif args.command in ('run', 'resume'):
        return run_job(vm, args)
    elif args.command == 'collect':
        ready(vm)
        collect_job(vm, vm.state, args.job)
        return 0
    elif args.command == 'interrupt':
        job, _ = load_job(vm.state, args.job)
        interrupt(vm, job)
        result = {'job': args.job, 'interruptionRequested': True}
    elif args.command == 'status':
        if args.job:
            job, _ = load_job(vm.state, args.job)
            result = remote_json(vm, job['root'] + '/job-status.json') if vm.status().get('running') else {'vm': vm.status(), 'lastKnownJobStatus': read(paths(vm.state, args.job) / 'last-status.json') if (paths(vm.state, args.job) / 'last-status.json').exists() else None}
        else:
            result = vm.status()
    else:
        vm.stop()
        result = {'shutdownRequested': True}
    print(json.dumps(result, indent=2), flush=True)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
