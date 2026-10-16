import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

import frames


def main():
    parser = argparse.ArgumentParser(description='Encode only the five preflight samples to verify the delivery contract.')
    parser.add_argument('--approval', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    approval = json.loads(args.approval.read_text())
    if approval['status'] != 'passed':
        raise ValueError('A passing native preflight is required.')
    report = json.loads(Path(approval['report']).read_text())
    samples = report['cards'][0]['samples']
    if [item['frame'] for item in samples] != [0, 69, 138, 207, 275]:
        raise ValueError('The five approved preflight poses are required.')
    args.output.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix='frames-', dir=args.output) as temporary:
        directory = Path(temporary)
        for index, sample in enumerate(samples):
            path = Path(sample['prepared']['path'])
            if hashlib.sha256(path.read_bytes()).hexdigest() != approval['evidenceHashes'][str(path)]:
                raise ValueError('A prepared preflight sample changed.')
            shutil.copyfile(path, directory / f'{index:04d}.png')
        frames.FRAME_COUNT = len(samples)
        video = frames.encode_frames(directory, args.output / 'probe.mp4', 'p3', approval['identity']['deliverySize'])
    result = {'passed': video['fullyDecoded'], 'approvalSha256': hashlib.sha256(args.approval.read_bytes()).hexdigest(),
              'profile': approval['identity']['profile'], 'motion': approval['identity']['motion'], 'frames': len(samples), 'video': video}
    (args.output / 'probe.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
