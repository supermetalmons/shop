import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import frames
import native_processing_worker
import processing_worker
from test_processing_worker import native_fixture


MEDIA = all(os.environ.get('MI_NOTE_' + name.upper()) or shutil.which(name) for name in ('ffmpeg', 'ffprobe'))


@unittest.skipUnless(MEDIA, 'FFmpeg and FFprobe are required')
class NativeProcessingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source, self.args, self.finish = native_fixture(self.root)

    def frame(self, number, **overrides):
        return {'frame': number, 'input': str(self.source / f'{number:04d}.png'),
                'sha256': self.args['beforeSha256'], **overrides}

    def run_session(self, module, args, finish):
        requests = [{'id': 1, 'operation': 'init', 'args': args}]
        requests.extend({'id': frame + 2, 'operation': 'frame', 'args': self.frame(frame)} for frame in range(276))
        requests.extend([{'id': 278, 'operation': 'quality', 'args': finish}, {'id': 279, 'operation': 'finish', 'args': {}}])
        destination = io.StringIO()
        code = module.serve(io.StringIO(''.join(json.dumps(request) + '\n' for request in requests)), destination)
        return code, [json.loads(line) for line in destination.getvalue().splitlines()]

    def test_parallel_preparation_preserves_every_png_quality_metric_and_video_byte(self):
        serial_args = {**self.args, 'preparedDirectory': str(self.root / 'serial-prepared'),
                       'output': str(self.root / 'serial.mp4'), 'certificateDirectory': str(self.root / 'serial-certificate')}
        serial_finish = {**self.finish, 'qualityOutput': str(self.root / 'serial-quality.json')}
        serial_code, serial = self.run_session(processing_worker, serial_args, serial_finish)
        parallel_code, parallel = self.run_session(native_processing_worker, self.args, self.finish)
        self.assertEqual(serial_code, 0, serial[-1])
        self.assertEqual(parallel_code, 0, parallel[-1])
        self.assertEqual(serial[-1]['result']['qualityReport'], parallel[-1]['result']['qualityReport'])
        self.assertEqual((self.root / 'serial.mp4').read_bytes(), (self.root / 'video.mp4').read_bytes())
        receipts = [row for response in parallel[1:-1] for row in response['result']['completed']]
        self.assertEqual([row['frame'] for row in receipts], list(range(276)))
        for frame, receipt in enumerate(receipts):
            name = f'{frame:04d}.png'
            content = (self.root / 'prepared' / name).read_bytes()
            self.assertEqual(content, (self.root / 'serial-prepared' / name).read_bytes())
            self.assertEqual(receipt['preparedSha256'], hashlib.sha256(content).hexdigest())
            self.assertEqual(receipt['sourceSha256'], self.args['beforeSha256'])

    def test_queue_stays_bounded_and_commits_strictly_in_order(self):
        session = native_processing_worker.NativeProcessingSession(self.args)
        self.addCleanup(session.close)
        receipts = []
        for frame in range(12):
            result = session.frame(self.frame(frame))
            receipts.extend(result['completed'])
            self.assertEqual(result['acceptedFrame'], frame)
            self.assertLessEqual(len(session.pending), 3)
        while session.pending:
            receipts.append(session.commit())
        self.assertEqual([row['frame'] for row in receipts], list(range(12)))
        self.assertFalse(Path(self.args['output']).exists())

    def test_bad_hash_or_pixels_cannot_be_committed_or_published(self):
        for invalid in ['hash', 'icc', 'mode', 'geometry', 'rest']:
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                source, args, finish = native_fixture(root)
                path = source / '0000.png'
                digest = args['beforeSha256']
                if invalid == 'hash':
                    digest = '0' * 64
                else:
                    with Image.open(path) as opened:
                        image = opened.copy()
                    if invalid == 'mode':
                        image = image.convert('RGBA')
                    elif invalid == 'geometry':
                        image = image.resize((95, 95))
                    elif invalid == 'rest':
                        image.putpixel((48, 48), (0, 0, 0))
                    image.save(path, icc_profile=frames.PROFILE_PATHS['srgb' if invalid == 'icc' else 'p3'].read_bytes())
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                session = native_processing_worker.NativeProcessingSession(args)
                try:
                    session.frame({'frame': 0, 'input': str(path), 'sha256': digest})
                    with self.assertRaisesRegex(ValueError, 'checksum|mismatch|pixels changed'):
                        session.commit()
                    self.assertEqual(len(session.preparations), 0)
                    self.assertFalse(Path(args['output']).exists())
                finally:
                    session.close()

    def test_invalid_worker_count_and_out_of_order_admission_fail(self):
        for override in [{'workers': 0}, {'workers': 4}, {'workers': 2, 'capacity': 1}, {'capacity': 5}]:
            with self.assertRaises(ValueError):
                native_processing_worker.NativeProcessingSession({**self.args, **override})
        session = native_processing_worker.NativeProcessingSession(self.args)
        self.addCleanup(session.close)
        with self.assertRaisesRegex(ValueError, 'order or count'):
            session.frame(self.frame(1))
        self.assertEqual(session.submitted, 0)


if __name__ == '__main__':
    unittest.main()
