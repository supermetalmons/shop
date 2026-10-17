import hashlib
import fcntl
import io
import json
import os
from pathlib import Path
import shutil
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import frames
import processing_worker
import quality


MEDIA = all(os.environ.get('MI_NOTE_' + name.upper()) or shutil.which(name) for name in ('ffmpeg', 'ffprobe'))


def native_fixture(root):
    source = root / 'native'
    source.mkdir()
    image = Image.new('RGB', (96, 96), 'black')
    image.paste((180, 90, 140), (24, 16, 72, 80))
    content = io.BytesIO()
    image.save(content, format='PNG', icc_profile=frames.PROFILE_PATHS['p3'].read_bytes())
    for frame in range(276):
        (source / f'{frame:04d}.png').write_bytes(content.getvalue())
    before, after = root / 'before.png', root / 'after.png'
    before.write_bytes(content.getvalue())
    after.write_bytes(content.getvalue())
    digest = hashlib.sha256(content.getvalue()).hexdigest()
    args = {'cardId': 17, 'nativeSize': 96, 'size': 64, 'space': 'p3', 'before': str(before),
            'beforeSha256': digest, 'bounds': [20, 12, 76, 84], 'preparedDirectory': str(root / 'prepared'),
            'output': str(root / 'video.mp4'), 'certificateDirectory': str(root / 'validation')}
    return source, args, {'after': str(after), 'afterSha256': digest, 'qualityOutput': str(root / 'quality.json')}


@unittest.skipUnless(MEDIA, 'FFmpeg and FFprobe are required')
class ProcessingWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source, self.args, self.finish = native_fixture(self.root)

    def messages(self, count=276):
        return [{'id': 1, 'operation': 'init', 'args': self.args}, *[
            {'id': frame + 2, 'operation': 'frame', 'args': {'frame': frame, 'input': str(self.source / f'{frame:04d}.png'),
                                                         'sha256': self.args['beforeSha256']}}
            for frame in range(count)]]

    def serve(self, requests):
        output = io.StringIO()
        code = processing_worker.serve(io.StringIO(''.join(json.dumps(request) + '\n' for request in requests)), output)
        return code, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_shared_decode_matches_preparation_quality_and_mp4_bytes(self):
        expected_preparation = frames.prepare_sequence(self.source, self.root / 'serial', 'p3', size=64)
        expected_quality = quality.audit_sequence(self.source, Path(self.args['before']), Path(self.finish['after']),
                                                 self.root / 'expected-quality.json', self.args['bounds'], 17, 96)
        expected_video = frames.encode_frames(self.root / 'serial', self.root / 'expected.mp4', 'p3', 64)
        requests = self.messages() + [{'id': 278, 'operation': 'quality', 'args': self.finish},
                                      {'id': 279, 'operation': 'finish', 'args': {}}]
        with patch.object(frames, 'prepare_loaded_frame', wraps=frames.prepare_loaded_frame) as preparation:
            code, responses = self.serve(requests)
        self.assertEqual(preparation.call_count, 276)
        self.assertTrue(all(call.kwargs.get('black_padding') is True for call in preparation.call_args_list))
        self.assertEqual(code, 0, responses[-1])
        result = responses[-1]['result']
        self.assertEqual(result['qualityReport'], expected_quality)
        self.assertEqual({**result['preparation'], 'output': expected_preparation['output']}, expected_preparation)
        self.assertEqual(result['video']['sha256'], expected_video['sha256'])
        self.assertEqual((self.root / 'video.mp4').read_bytes(), (self.root / 'expected.mp4').read_bytes())
        self.assertEqual(responses[-2]['result']['qualityReport'], expected_quality)
        self.assertEqual(len(responses), 279)
        for frame in range(276):
            self.assertEqual((self.root / 'prepared' / f'{frame:04d}.png').read_bytes(),
                             (self.root / 'serial' / f'{frame:04d}.png').read_bytes())
            self.assertEqual(responses[frame + 1]['result']['sourceSha256'], self.args['beforeSha256'])

    def test_streaming_icc_opt_in_occurs_only_after_the_native_checkpoint_hash_is_verified(self):
        session = processing_worker.ProcessingSession(self.args)
        self.addCleanup(session.close)
        request = self.messages(1)[1]['args']
        with patch.object(frames, 'prepare_loaded_frame', wraps=frames.prepare_loaded_frame) as preparation, \
                patch.object(frames, 'transform_black_padded_rgb', wraps=frames.transform_black_padded_rgb) as optimized:
            with self.assertRaisesRegex(ValueError, 'checksum changed'):
                session.frame({**request, 'sha256': '0' * 64})
            preparation.assert_not_called()
            optimized.assert_not_called()
            result = session.frame(request)
        self.assertEqual(result['frame'], 0)
        self.assertEqual(preparation.call_count, 1)
        self.assertIs(preparation.call_args.kwargs['black_padding'], True)
        self.assertEqual(optimized.call_count, 1)

    def test_quality_checkpoint_precedes_publication_and_survives_lost_finalization_response(self):
        session = processing_worker.ProcessingSession(self.args)
        self.addCleanup(session.close)
        for request in self.messages()[1:]:
            session.frame(request['args'])
        checkpoint = session.validate_quality(self.finish)
        self.assertTrue(checkpoint['qualityReport']['passed'])
        self.assertEqual(json.loads(Path(self.finish['qualityOutput']).read_text()), checkpoint['qualityReport'])
        self.assertFalse(Path(self.args['output']).exists())
        finalize = session.encoder.finish

        def publish_then_interrupt(*args):
            finalize(*args)
            raise InterruptedError('Lost finalization response')

        with patch.object(session.encoder, 'finish', side_effect=publish_then_interrupt):
            with self.assertRaisesRegex(InterruptedError, 'Lost finalization response'):
                session.finish({})
        self.assertTrue(Path(self.args['output']).exists())
        self.assertEqual(json.loads(Path(self.finish['qualityOutput']).read_text()), checkpoint['qualityReport'])

    def test_legacy_finish_still_validates_and_publishes(self):
        code, responses = self.serve(self.messages() + [{'id': 278, 'operation': 'finish', 'args': self.finish}])
        self.assertEqual(code, 0, responses[-1])
        self.assertTrue(responses[-1]['result']['qualityReport']['passed'])
        self.assertTrue(Path(self.args['output']).exists())

    def test_eof_after_quality_checkpoint_preserves_report_without_publication(self):
        code, responses = self.serve(self.messages() + [{'id': 278, 'operation': 'quality', 'args': self.finish}])
        self.assertEqual(code, 1)
        self.assertTrue(responses[-1]['result']['qualityReport']['passed'])
        self.assertTrue(Path(self.finish['qualityOutput']).exists())
        self.assertFalse(Path(self.args['output']).exists())

    def test_initialization_waits_for_encoder_lock_and_remains_cancellable(self):
        for cancel in (False, True):
            with self.subTest(cancel=cancel), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                _, args, _ = native_fixture(root)
                lock = root / 'encoder.lock'
                with lock.open('w') as owner:
                    fcntl.flock(owner, fcntl.LOCK_EX)
                    process = subprocess.Popen([sys.executable, '-u', processing_worker.__file__], stdin=subprocess.PIPE,
                                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
                                               env={**os.environ, 'MI_NOTE_ENCODER_LOCK': str(lock)})
                    try:
                        process.stdin.write(json.dumps({'id': 1, 'operation': 'init', 'args': args}) + '\n')
                        process.stdin.flush()
                        deadline = time.monotonic() + 5
                        while not Path(args['preparedDirectory']).exists() and time.monotonic() < deadline:
                            time.sleep(.01)
                        self.assertTrue(Path(args['preparedDirectory']).exists())
                        self.assertEqual(select.select([process.stdout], [], [], .15)[0], [])
                        if cancel:
                            os.killpg(process.pid, signal.SIGTERM)
                            stdout, _ = process.communicate(timeout=5)
                            self.assertEqual(stdout, '')
                            self.assertNotEqual(process.returncode, 0)
                        else:
                            fcntl.flock(owner, fcntl.LOCK_UN)
                            self.assertTrue(select.select([process.stdout], [], [], 5)[0])
                            self.assertTrue(json.loads(process.stdout.readline())['result']['ready'])
                            process.communicate(timeout=5)
                        self.assertFalse(Path(args['output']).exists())
                    finally:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.communicate(timeout=5)

    def test_bad_order_hash_icc_and_frame_format_fail_without_publication(self):
        for invalid in ('order', 'hash', 'icc', 'corrupt', 'mode', 'geometry'):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as directory:
                source, args, _ = native_fixture(Path(directory).resolve())
                frame = {'frame': 0, 'input': str(source / '0000.png'), 'sha256': args['beforeSha256']}
                if invalid == 'order':
                    frame['frame'] = 1
                elif invalid == 'hash':
                    frame['sha256'] = '0' * 64
                else:
                    path = source / '0000.png'
                    if invalid == 'corrupt':
                        path.write_bytes(b'not PNG')
                    else:
                        with Image.open(path) as image:
                            image = image.copy()
                        if invalid == 'mode':
                            image = image.convert('RGBA')
                        elif invalid == 'geometry':
                            image = image.resize((95, 95))
                        image.save(path, icc_profile=frames.PROFILE_PATHS['srgb' if invalid == 'icc' else 'p3'].read_bytes())
                    frame['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
                code, responses = self.serve([{'id': 1, 'operation': 'init', 'args': args},
                                               {'id': 2, 'operation': 'frame', 'args': frame},
                                               {'id': 3, 'operation': 'finish', 'args': self.finish}])
                self.assertEqual(code, 1)
                self.assertIn('error', responses[-1])
                self.assertEqual(len(responses), 2)
                self.assertFalse(Path(args['output']).exists())

    def test_partial_eof_and_early_finish_reap_encoder(self):
        original = frames.PngSequenceEncoder
        for finish in (False, True):
            with self.subTest(finish=finish), tempfile.TemporaryDirectory() as directory:
                source, args, final = native_fixture(Path(directory).resolve())
                encoders = []
                def create(*values):
                    encoder = original(*values)
                    encoders.append(encoder)
                    return encoder
                requests = [{'id': 1, 'operation': 'init', 'args': args},
                            {'id': 2, 'operation': 'frame', 'args': {'frame': 0, 'input': str(source / '0000.png'), 'sha256': args['beforeSha256']}}]
                if finish:
                    requests.append({'id': 3, 'operation': 'finish', 'args': final})
                with patch.object(frames, 'PngSequenceEncoder', side_effect=create):
                    code, _ = self.serve(requests)
                self.assertEqual(code, 1)
                self.assertIsNotNone(encoders[0].process.poll())
                self.assertFalse(Path(args['output']).exists())

    def test_end_rest_failure_never_publishes_completed_encode(self):
        with Image.open(self.finish['after']) as image:
            image = image.copy()
        image.putpixel((48, 48), (0, 0, 0))
        image.save(self.finish['after'], icc_profile=frames.PROFILE_PATHS['p3'].read_bytes())
        self.finish['afterSha256'] = hashlib.sha256(Path(self.finish['after']).read_bytes()).hexdigest()
        code, responses = self.serve(self.messages() + [{'id': 278, 'operation': 'finish', 'args': self.finish}])
        self.assertEqual(code, 1)
        self.assertIn('quality audit failed', responses[-1]['error']['message'])
        self.assertFalse(Path(self.args['output']).exists())

    def test_group_interruption_stops_encoder_and_worker(self):
        process = subprocess.Popen([sys.executable, '-u', processing_worker.__file__], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        children = []
        try:
            process.stdin.write(json.dumps(self.messages(0)[0]) + '\n')
            process.stdin.flush()
            self.assertTrue(json.loads(process.stdout.readline())['result']['ready'])
            listing = subprocess.run(['ps', '-axo', 'pid=,ppid='], capture_output=True, text=True, check=True).stdout
            children = [int(line.split()[0]) for line in listing.splitlines() if int(line.split()[1]) == process.pid]
            self.assertTrue(children)
            self.assertTrue(all(os.getpgid(pid) == process.pid for pid in children))
            os.killpg(process.pid, signal.SIGTERM)
            stdout, _ = process.communicate(timeout=5)
            self.assertNotEqual(process.returncode, 0)
            self.assertEqual(stdout, '')
            self.assertFalse(Path(self.args['output']).exists())
            for pid in children:
                state = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
                self.assertTrue(not state or state.startswith('Z'), state)
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
