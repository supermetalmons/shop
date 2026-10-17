import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import frames
import video_validation as validation


MEDIA = all(os.environ.get('MI_NOTE_' + name.upper()) or shutil.which(name) for name in ('ffmpeg', 'ffprobe'))


@unittest.skipUnless(MEDIA, 'FFmpeg and FFprobe are required')
class VideoValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name).resolve()
        prepared = cls.root / 'prepared'
        prepared.mkdir()
        image = Image.new('RGB', (64, 64), 'black')
        image.paste((180, 90, 140), (16, 10, 48, 54))
        for frame in range(276):
            frames.save_png(image, prepared / f'{frame:04d}.png', frames.PROFILE_PATHS['p3'].read_bytes())
        cls.baseline = frames.encode_frames(prepared, cls.root / 'baseline.mp4', 'p3', 64)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.case = tempfile.TemporaryDirectory()
        self.addCleanup(self.case.cleanup)
        self.directory = Path(self.case.name).resolve()
        self.source = self.directory / 'source'
        engine = self.source / 'scripts/mi-note-video'
        engine.mkdir(parents=True)
        shutil.copyfile(validation.__file__, engine / 'video_validation.py')
        contract = json.loads(validation.CONTRACT_PATH.read_text())
        contract['profiles']['upright-2160']['deliverySize'] = 64
        self.contract_path = engine / 'contract.json'
        self.contract_path.write_text(json.dumps(contract))
        with patch.object(validation, 'CONTRACT_PATH', self.contract_path):
            self.certificate, self.descriptor = validation.strict_decode(self.baseline['output'], self.directory / 'validation', 64)
        self.video = {**self.baseline, 'stream': self.certificate['stream'], 'decodeCertificate': self.descriptor}
        validator = self.certificate['validator']
        self.job = {'profile': 'upright-2160', 'contractSha256': validator['contractSha256'],
                    'runtime': {'executableSha256': validator['executableSha256'], 'versions': validator['versions']}}

    def verify(self, **kwargs):
        return validation.verify_certificate(self.job, self.video, self.descriptor['path'], self.source, **kwargs)

    def save_certificate(self, certificate):
        path = Path(self.descriptor['path'])
        path.write_text(json.dumps(certificate))
        self.descriptor['sha256'] = validation.digest(path)

    def test_single_fatal_decode_counts_frames_and_binds_samples(self):
        result = self.verify(executable_paths=validation.executables())
        self.assertTrue(result['fullyDecoded'])
        self.assertEqual(result['decodedFrames'], 276)
        self.assertEqual(result['stream']['nb_read_frames'], '276')
        with patch.object(validation.subprocess, 'run', wraps=subprocess.run) as run, \
                patch.object(validation, 'CONTRACT_PATH', self.contract_path):
            validation.strict_decode(self.baseline['output'], self.directory / 'rechecked', 64)
        probes = [call.args[0] for call in run.call_args_list if '-show_streams' in call.args[0]]
        decodes = [call.args[0] for call in run.call_args_list if '-xerror' in call.args[0]]
        self.assertEqual(len(probes), 1)
        self.assertNotIn('-count_frames', probes[0])
        self.assertEqual(len(decodes), 1)
        self.assertIn('framecrc', decodes[0])
        self.assertEqual([row['frame'] for row in self.certificate['samples']], [0, 69, 138, 207, 275])

    def test_certificate_hash_video_identity_stream_and_runtime_changes_fail(self):
        path = Path(self.descriptor['path'])
        path.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'certificate checksum'):
            self.verify()
        for name in ('frames', 'video', 'stream', 'validator', 'runtime', 'version', 'sample-order', 'sample-format'):
            with self.subTest(name=name):
                certificate = copy.deepcopy(self.certificate)
                if name == 'frames':
                    certificate['decodedFrames'] = 275
                elif name == 'video':
                    certificate['videoSha256'] = '0' * 64
                elif name == 'stream':
                    certificate['stream']['color_primaries'] = 'bt709'
                elif name == 'validator':
                    certificate['validator']['sha256'] = '0' * 64
                elif name == 'runtime':
                    certificate['validator']['executableSha256']['ffmpeg'] = '0' * 64
                elif name == 'version':
                    certificate['validator']['versions']['python'] = '0.0.0'
                elif name == 'sample-order':
                    certificate['samples'].reverse()
                else:
                    certificate['samples'][0]['pixelFormat'] = 'yuv420p'
                self.save_certificate(certificate)
                with self.assertRaises(ValueError):
                    self.verify()

    def test_count_evidence_missing_reordered_or_truncated_cannot_claim_276(self):
        path = Path(self.certificate['countEvidence']['path'])
        original = path.read_bytes()
        path.unlink()
        with self.assertRaisesRegex(ValueError, 'regular validation file'):
            self.verify()
        for name in ('checksum', 'count', 'order'):
            with self.subTest(name=name):
                path.write_bytes(original)
                certificate = copy.deepcopy(self.certificate)
                lines = original.decode().splitlines()
                rows = [i for i, line in enumerate(lines) if line and not line.startswith('#')]
                if name == 'order':
                    lines[rows[0]], lines[rows[1]] = lines[rows[1]], lines[rows[0]]
                else:
                    lines.pop(rows[-1])
                path.write_text('\n'.join(lines) + '\n')
                if name != 'checksum':
                    certificate['countEvidence'] = validation.describe(path)
                self.save_certificate(certificate)
                with self.assertRaises(ValueError):
                    self.verify()

    def test_sample_hash_and_counted_crc_both_bind_decoded_bytes(self):
        sample = self.certificate['samples'][0]
        path = Path(sample['path'])
        data = bytearray(path.read_bytes())
        data[0] ^= 1
        path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'sample checksum'):
            self.verify()
        certificate = copy.deepcopy(self.certificate)
        certificate['samples'][0]['sha256'] = validation.digest(path)
        self.save_certificate(certificate)
        with self.assertRaisesRegex(ValueError, 'sample checksum'):
            self.verify()

    def test_current_executable_and_validator_source_must_match(self):
        paths = validation.executables()
        wrong = self.directory / 'wrong-executable'
        wrong.write_bytes(b'wrong')
        with self.assertRaisesRegex(ValueError, 'Current decode executable'):
            self.verify(executable_paths={**paths, 'ffmpeg': str(wrong)})
        (self.source / validation.SOURCE).write_bytes(b'changed source')
        with self.assertRaisesRegex(ValueError, 'validator source'):
            self.verify()

    def test_invalid_or_wrong_length_video_never_creates_certificate(self):
        broken = self.directory / 'broken.mp4'
        broken.write_bytes(Path(self.baseline['output']).read_bytes()[:64])
        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
            validation.strict_decode(broken, self.directory / 'invalid', 64)
        self.assertFalse((self.directory / 'invalid/certificate.json').exists())
        with self.assertRaisesRegex(ValueError, 'frame count'):
            validation.strict_decode(self.baseline['output'], self.directory / 'short', 64, frame_count=277)
        self.assertFalse((self.directory / 'short/certificate.json').exists())


if __name__ == '__main__':
    unittest.main()
