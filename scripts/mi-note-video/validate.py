import argparse
import json
from pathlib import Path
import subprocess
import time
import uuid

from cli import assert_idle, environment, exclusive_work, launch, ready, remote_json, write_remote_json
from jobs import CONTRACT, now
from prepare import atomic_json, prepare
from vm import VM


def task(vm, prepared, root, arguments, label):
    vm.exec(['/bin/mkdir', '-p', root])
    identity = str(uuid.uuid4())
    description = {'id': identity, 'status': root + '/task-status.json', 'command': arguments,
                   'cwd': prepared['guestSourceRoot'], 'environment': environment(vm, root)}
    write_remote_json(vm, root + '/task.json', description)
    launch(vm, label, [vm.config['node'], prepared['guestSourceRoot'] + '/scripts/mi-note-video/guest-task.mjs', root + '/task.json'], prepared['guestSourceRoot'], root)
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        try:
            status = remote_json(vm, description['status'])
        except RuntimeError:
            status = None
        if status and status.get('taskId') == identity:
            if status['status'] == 'complete':
                return status
            if status['status'] == 'failed':
                log = vm.exec(['/usr/bin/tail', '-n', '25', root + '/job.log']).decode(errors='replace')
                raise RuntimeError('Bounded validation failed:\n' + log)
        time.sleep(2)
    raise RuntimeError('Bounded validation timed out; its guest evidence and log were preserved.')


def main():
    parser = argparse.ArgumentParser(description='Bounded VM checks for both profiles and all three motions; never renders a full video.')
    parser.add_argument('--state', type=Path)
    parser.add_argument('--prepared', action='store_true', help='Use the current prepared source snapshot without preparing it again.')
    parser.add_argument('--id', type=int, default=312)
    parser.add_argument('--no-reboot', action='store_true', help='Skip the second pass of exact controls after VM reboot.')
    args = parser.parse_args()
    vm = VM(args.state)
    with exclusive_work(vm):
        run_validation(vm, args)


def run_validation(vm, args):
    ready(vm)
    assert_idle(vm)
    prepared = json.loads((vm.state / 'prepared.json').read_text()) if args.prepared else prepare(vm, vm.state)
    if not 1 <= args.id <= prepared['catalogCount']:
        raise ValueError('Choose an ID in the prepared card catalog.')
    identity = uuid.uuid4().hex[:12]
    root = vm.config['guestRoot'] + '/validation/' + identity
    directory = vm.state / 'validation' / identity
    directory.mkdir(parents=True)
    result = {'version': 1, 'id': identity, 'sourceId': prepared['sourceId'], 'cardId': args.id, 'startedAt': now(),
              'guestRoot': root, 'passed': False, 'combinations': {}}
    try:
        for profile in CONTRACT['profiles']:
            for motion in CONTRACT['motions']:
                key = profile + '/' + motion
                unit = root + '/' + key
                label = 'org.mons.mi-note-check.' + identity + '.' + profile + '.' + motion
                arguments = [vm.config['node'], prepared['guestSourceRoot'] + '/scripts/mi-note-video/entry.mjs', 'preflight.mjs',
                             '--profile', profile, '--motion', motion, '--id', str(args.id), '--output', unit + '/preflight', '--python', vm.config['python']]
                print(json.dumps({'phase': 'preflight', 'profile': profile, 'motion': motion}), flush=True)
                task(vm, prepared, unit, arguments, label)
                approval = remote_json(vm, unit + '/preflight/approved.json')
                probe_command = [vm.config['python'], prepared['guestSourceRoot'] + '/scripts/mi-note-video/probe.py', '--approval', unit + '/preflight/approved.json', '--output', unit + '/probe']
                task(vm, prepared, unit, probe_command, label)
                probe = remote_json(vm, unit + '/probe/probe.json')
                result['combinations'][key] = {'approval': approval, 'probe': probe, 'passed': True, 'resumeVerified': False}
                atomic_json(directory / 'report.json', result)
                print(json.dumps({'phase': 'preflight-passed', 'profile': profile, 'motion': motion, 'probeFrames': probe['frames']}), flush=True)
        if not args.no_reboot:
            result['beforeBoot'] = vm.exec(['/usr/sbin/sysctl', '-n', 'kern.boottime']).decode().strip()
            print('Restarting the VM before fresh exact native controls.', flush=True)
            vm.stop()
            ready(vm)
            result['afterBoot'] = vm.exec(['/usr/sbin/sysctl', '-n', 'kern.boottime']).decode().strip()
            if result['beforeBoot'] == result['afterBoot']:
                raise RuntimeError('The VM did not reboot.')
            for profile in CONTRACT['profiles']:
                for motion in CONTRACT['motions']:
                    key = profile + '/' + motion
                    unit = root + '/' + key
                    arguments = [vm.config['node'], prepared['guestSourceRoot'] + '/scripts/mi-note-video/entry.mjs', 'preflight.mjs',
                                 '--profile', profile, '--motion', motion, '--id', str(args.id), '--output', unit + '/preflight', '--python', vm.config['python'], '--verify-resume']
                    print(json.dumps({'phase': 'resume-controls', 'profile': profile, 'motion': motion}), flush=True)
                    task(vm, prepared, unit, arguments, 'org.mons.mi-note-check.' + identity + '.' + profile + '.' + motion)
                    approval = remote_json(vm, unit + '/preflight/approved.json')
                    if approval != result['combinations'][key]['approval']:
                        raise RuntimeError('A completed preflight was modified during resume verification.')
                    result['combinations'][key]['resumeVerified'] = True
                    atomic_json(directory / 'report.json', result)
        result.update({'passed': True, 'finishedAt': now()})
        atomic_json(directory / 'report.json', result)
        print(json.dumps({'passed': True, 'combinations': len(result['combinations']), 'report': str(directory / 'report.json')}), flush=True)
    except BaseException as error:
        result.update({'error': str(error), 'finishedAt': now()})
        atomic_json(directory / 'report.json', result)
        raise
    finally:
        vm.stop()


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error))
