import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid


HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
SPEC = importlib.util.spec_from_file_location('unit_collector', HERE / 'collect.py')
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)
SPEC = importlib.util.spec_from_file_location('video_jobs', HERE / 'jobs.py')
jobs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(jobs)


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + '\n')


class FakeVM:
    def __init__(self):
        self.downloads = []
        self.acks = []
        self.fail_ack = False

    def exec(self, argv, timeout=180):
        return subprocess.run(argv, check=True, capture_output=True, timeout=timeout).stdout

    def get(self, remote, local, timeout=600):
        self.downloads.append(remote)
        shutil.copyfile(remote, local)
        return local

    def put(self, local, remote, timeout=600):
        if self.fail_ack:
            raise RuntimeError('Simulated ACK transfer failure')
        self.acks.append(json.loads(Path(local).read_text()))
        shutil.copyfile(local, remote)
        return remote


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.output = self.root / 'published'
        self.evidence = self.root / 'evidence'
        self.vm = FakeVM()
        self.job = {'version': 1, 'jobId': str(uuid.uuid4()), 'name': 'fixture', 'sourceId': 'a' * 64,
                    'sourceRoot': str(self.root / 'release'), 'root': str(self.root / 'vm/jobs/fixture'),
                    'profile': 'sideways-1980', 'motion': 'breathing-swing', 'ids': [312], 'catalogCount': 1430,
                    'python': sys.executable}
        self.fixture()

    def tearDown(self):
        self.temporary.cleanup()

    def fixture(self, profile='sideways-1980', passed=True):
        self.job['profile'] = profile
        root = Path(self.job['root'])
        (root / 'ack').mkdir(parents=True, exist_ok=True)
        self.unit = root / 'cards/312'
        video_path = self.unit / 'output/312.mp4'
        video_path.parent.mkdir(parents=True, exist_ok=True)
        video_path.write_bytes(b'synthetic-video-fixture')
        size = collector.CONTRACT['profiles'][profile]['deliverySize']
        stream = {**collector.stream_fields(self.job), 'duration': '4.600000'}
        self.video = {'id': 312, 'method': 'd', 'output': str(video_path), 'fullyDecoded': True, 'bytes': video_path.stat().st_size,
                      'sha256': collector.digest(video_path), 'width': size, 'height': size, 'stream': stream,
                      **{key: collector.CONTRACT['video'][key] for key in ['frames', 'frameRate', 'duration', 'space', 'encoder', 'crf', 'preset', 'keyframeInterval']}}
        manifest_path = self.unit / 'output/.render-manifest.json'
        approval_path = self.unit / 'preflight/approved.json'
        audit_path = self.unit / 'audit.json'
        audit_source = Path(self.job['sourceRoot']) / 'scripts/mi-note-video/audit.py'
        audit_source.parent.mkdir(parents=True, exist_ok=True)
        audit_source.write_text('synthetic audit source\n')
        contract_source = audit_source.with_name('contract.json')
        contract_source.write_bytes((HERE / 'contract.json').read_bytes())
        source_files = {str(path.relative_to(self.job['sourceRoot'])): collector.digest(path) for path in [audit_source, contract_source]}
        self.job['sourceId'] = hashlib.sha256(json.dumps(source_files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.job['contractSha256'] = collector.digest(contract_source)
        snapshot_path = Path(self.job['sourceRoot']) / 'source-snapshot.json'
        write(snapshot_path, {'version': 1, 'sourceId': self.job['sourceId'], 'files': source_files})
        write(root / 'job.json', self.job)
        write(manifest_path, {'status': 'complete', 'videos': [self.video]})
        write(approval_path, {'status': 'passed'})
        audit = {'version': 1, **{key: self.job[key] for key in ['jobId', 'sourceId', 'profile', 'motion']}, 'cardId': 312,
                 'videoSha256': self.video['sha256'], 'passed': passed, 'issues': [], 'auditSourceSha256': collector.digest(audit_source),
                 'geometry': {'frames': 276}, 'nativeFramesVerified': 5, 'sourceViewportsVerified': 5 * collector.CONTRACT['profiles'][profile]['tiles'],
                 'independentControlsVerified': 5, 'iccByteExact': True, 'nativePixelsExact': True,
                 'samples': [{'frame': frame} for frame in collector.CONTRACT['capture']['controlFrames']],
                 'thresholds': {'wholeImageMAE': 3.0, 'cardInteriorMAE': 6.0, 'absoluteMeanSignedRGB': 1.5,
                                'edgeEnergyRetention': .85, 'fineDetailEnergyRetention': .75, 'blackBorderMean': .5}}
        write(audit_path, audit)
        paths = [root / 'job.json', manifest_path, approval_path, audit_path, audit_source, contract_source, snapshot_path]
        record = {'version': 1, 'jobId': self.job['jobId'], 'sourceId': self.job['sourceId'], 'cardId': 312,
                  'manifest': {'path': str(manifest_path), 'sha256': collector.digest(manifest_path)},
                  'approval': {'path': str(approval_path), 'sha256': collector.digest(approval_path)},
                  'files': [{'guestPath': str(path), 'archivePath': str(path).lstrip('/'), 'sha256': collector.digest(path), 'bytes': path.stat().st_size} for path in paths]}
        inventory_path = self.unit / 'evidence-manifest.json'
        write(inventory_path, record)
        self.ready = {'version': 1, **{key: self.job[key] for key in ['jobId', 'sourceId', 'profile', 'motion']},
                      'cardId': 312, 'verificationId': str(uuid.uuid4()), 'unitRoot': str(self.unit), 'requiresHostVerification': False,
                      'video': self.video, 'audit': {'path': str(audit_path), 'sha256': collector.digest(audit_path)},
                      'evidence': {'path': str(inventory_path), 'sha256': collector.digest(inventory_path), 'files': len(paths),
                                   'bytes': sum(item['bytes'] for item in record['files']), 'archivePath': str(self.unit / 'transfer/evidence.tar')}}
        write(self.unit / 'ready.json', self.ready)
        self.status = {'jobId': self.job['jobId'], 'sourceId': self.job['sourceId'], 'status': 'awaiting-collection', 'currentCard': 312}
        write(root / 'job-status.json', self.status)

    def collect(self):
        return collector.collect(self.vm, self.job, self.output, self.evidence)

    def decoder(self):
        return patch.object(collector, 'decode_video', return_value={'fullyDecoded': True, 'stream': self.video['stream'], 'verifiedAt': 'fixture'})

    def test_full_catalog_selection_has_no_ten_card_limit(self):
        self.assertEqual(jobs.select_ids(all_cards=True, count=1430), list(range(1, 1431)))
        self.assertEqual(jobs.select_ids('1430,1,312', count=1430), [1, 312, 1430])
        with self.assertRaises(ValueError):
            jobs.select_ids('1,1', count=1430)

    def test_publish_then_idempotent_collect_and_final_completion(self):
        with self.decoder() as decode:
            first = self.collect()
            transfers = len(self.vm.downloads)
            second = self.collect()
            self.assertEqual(first['collected'], 1)
            self.assertEqual(second['collected'], 1)
            self.assertEqual(len(self.vm.downloads), transfers)
            self.assertEqual(decode.call_count, 1)
            self.assertEqual(len(self.vm.acks), 2)
            self.assertEqual(self.vm.acks[-1]['videoSha256'], self.video['sha256'])
            self.status.update({'status': 'complete', 'currentCard': None, 'completed': {'312': {'videoSha256': self.video['sha256'], 'evidenceSha256': self.ready['evidence']['sha256']}}})
            write(Path(self.job['root']) / 'job-status.json', self.status)
            self.assertEqual(self.collect()['status'], 'complete')

    def test_failed_ack_keeps_durable_publication_and_retries_without_download(self):
        self.vm.fail_ack = True
        with self.decoder() as decode:
            with self.assertRaisesRegex(RuntimeError, 'ACK transfer'):
                self.collect()
            publication = json.loads((self.output / '.collection-manifest.json').read_text())
            self.assertEqual(publication['videos']['312']['sha256'], self.video['sha256'])
            self.assertTrue(Path(self.video['output']).exists())
            transfers = len(self.vm.downloads)
            self.vm.fail_ack = False
            self.collect()
            self.assertEqual(len(self.vm.downloads), transfers)
            self.assertEqual(decode.call_count, 1)
            self.assertEqual(len(self.vm.acks), 1)

    def test_resume_requires_fresh_host_verification_token(self):
        with self.decoder():
            self.collect()
            prior = self.ready['verificationId']
            self.ready.update({'verificationId': str(uuid.uuid4()), 'requiresHostVerification': True})
            write(self.unit / 'ready.json', self.ready)
            with patch.object(self.vm, 'get', side_effect=AssertionError('No guest data should be downloaded')):
                self.collect()
            self.assertNotEqual(self.vm.acks[-1]['verificationId'], prior)
            self.assertEqual(self.vm.acks[-1]['verificationId'], self.ready['verificationId'])

    def test_existing_mismatched_video_is_not_overwritten_or_acknowledged(self):
        self.output.mkdir()
        target = self.output / '312.mp4'
        target.write_bytes(b'preserve this unrelated file')
        with self.decoder(), self.assertRaisesRegex(RuntimeError, 'Video mismatch'):
            self.collect()
        self.assertEqual(target.read_bytes(), b'preserve this unrelated file')
        self.assertFalse(self.vm.acks)
        self.assertFalse(self.vm.downloads)

    def test_host_evidence_tampering_blocks_another_ack(self):
        with self.decoder():
            self.collect()
            publication = json.loads((self.output / '.collection-manifest.json').read_text())
            evidence = Path(publication['videos']['312']['evidence']['path'])
            (evidence / self.ready['audit']['path'].lstrip('/')).write_text('{}')
            with self.assertRaisesRegex(RuntimeError, 'Evidence file changed'):
                self.collect()
            self.assertEqual(len(self.vm.acks), 1)

    def test_failed_independent_audit_blocks_ack(self):
        self.fixture(passed=False)
        with self.decoder(), self.assertRaisesRegex(RuntimeError, 'Independent audit'):
            self.collect()
        self.assertFalse(self.vm.acks)
        self.assertTrue(Path(self.video['output']).exists())

    def test_upright_requires_ten_retained_source_viewports(self):
        self.fixture(profile='upright-2160')
        with self.decoder():
            self.assertEqual(self.collect()['collected'], 1)
        self.assertEqual(self.vm.acks[-1]['videoSha256'], self.video['sha256'])


if __name__ == '__main__':
    unittest.main()
