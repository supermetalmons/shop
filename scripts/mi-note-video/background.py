import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import subprocess
import sys

from prepare import atomic_json
from vm import python_executable


def label_for(job):
    return 'org.mons.mi-note-render.catalog.' + job['jobId']


def command_for(state, job, source_root, backend, from_id=None):
    arguments = [str(python_executable()), str(Path(source_root) / 'scripts/mi-note-video/cli.py'),
                 '--state', str(state), 'resume', job['name'], '--backend', backend]
    if from_id is not None:
        arguments += ['--from-id', str(from_id)]
    return ['/usr/bin/caffeinate', '-di' if backend == 'host' else '-i', *arguments]


def write_control(state, job, source_root):
    root = Path(state) / 'jobs' / job['name']
    invocation = shlex.join([str(python_executable()), str(Path(source_root) / 'scripts/mi-note-video/cli.py'), '--state', str(state)])
    content = '\n'.join([
        '#!/bin/sh', 'set -eu', 'action="${1:-status}"', 'if [ "$#" -gt 0 ]; then shift; fi',
        'case "$action" in',
        '  resume) exec ' + invocation + ' resume ' + shlex.quote(job['name']) + ' --background "$@" ;;',
        '  status|interrupt) exec ' + invocation + ' "$action" ' + shlex.quote(job['name']) + ' "$@" ;;',
        '  *) echo "Usage: control.command status|resume|interrupt [options]" >&2; exit 2 ;;', 'esac', '',
    ])
    path = root / 'control.command'
    if path.is_symlink():
        raise RuntimeError('The control command must not be a symbolic link.')
    temporary = path.with_suffix('.pending')
    with temporary.open('w') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o700)
    temporary.replace(path)
    return path


def launch(state, job, source_root, backend, from_id=None):
    if sys.platform != 'darwin':
        raise RuntimeError('Background rendering requires macOS launchd.')
    root = Path(state) / 'jobs' / job['name']
    label = label_for(job)
    domain = f'gui/{os.getuid()}'
    service = domain + '/' + label
    plist_path = root / 'host-agent.plist'
    printed = subprocess.run(['/bin/launchctl', 'print', service], capture_output=True, text=True)
    if printed.returncode == 0:
        match = re.search(r'(?m)^\s*path = (.+)$', printed.stdout)
        if not match or match.group(1).strip() != str(plist_path) or plist_path.resolve() != plist_path:
            raise RuntimeError('The registered host service belongs to another directory.')
        previous = plistlib.loads(plist_path.read_bytes())
        allowed_roots = {str(source_root)}
        metadata_path = root / 'job-meta.json'
        if metadata_path.exists():
            if metadata_path.resolve() != metadata_path:
                raise RuntimeError('The catalog metadata must not be a symbolic link.')
            metadata = json.loads(metadata_path.read_text())
            if metadata.get('job') != job:
                raise RuntimeError('The controller metadata belongs to another job.')
            for identity in metadata.get('controllerHistory', []):
                if not re.fullmatch('[a-f0-9]{64}', str(identity)):
                    raise RuntimeError('Invalid previous controller identity.')
                allowed_roots.add(str(Path(state) / 'releases' / identity))
        if previous.get('Label') != label or previous.get('WorkingDirectory') not in allowed_roots:
            raise RuntimeError('The registered host service has another owner.')
        if 'state = running' in printed.stdout:
            raise RuntimeError('This background job is already running. Interrupt it before resuming or switching backends.')
        subprocess.run(['/bin/launchctl', 'bootout', service], check=True, capture_output=True)
    environment = {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
                   'HOME': str(Path.home()), 'TMPDIR': '/private/tmp', 'PYTHONUNBUFFERED': '1',
                   'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
                   'MI_NOTE_RESUME_JOB_ID': job['jobId']}
    for name in ('FFMPEG', 'FFPROBE'):
        executable = os.environ.get('MI_NOTE_' + name) or shutil.which(name.lower())
        if not executable:
            raise RuntimeError(name + ' is required for host collection.')
        environment['MI_NOTE_' + name] = str(Path(executable).resolve())
    plist = {'Label': label, 'ProgramArguments': command_for(state, job, source_root, backend, from_id),
             'WorkingDirectory': str(source_root), 'EnvironmentVariables': environment,
             'LimitLoadToSessionType': 'Aqua', 'RunAtLoad': False, 'KeepAlive': False,
             'StandardOutPath': str(root / 'host.log'), 'StandardErrorPath': str(root / 'host.log')}
    if plist_path.is_symlink():
        raise RuntimeError('The host service definition must not be a symbolic link.')
    with plist_path.open('wb') as stream:
        plistlib.dump(plist, stream)
        stream.flush()
        os.fsync(stream.fileno())
    plist_path.chmod(0o600)
    subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(plist_path)], check=True, capture_output=True)
    subprocess.run(['/bin/launchctl', 'kickstart', service], check=True, capture_output=True)
    atomic_json(root / 'background.json', {'label': label, 'service': service, 'backend': backend,
                                         'command': plist['ProgramArguments'], 'log': str(root / 'host.log')})
    return {'job': job['name'], 'background': True, 'backend': backend, 'log': str(root / 'host.log'),
            'control': str(root / 'control.command'), 'automaticRestart': False}
