import json
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
import uuid

import test_jobs as fixtures
import test_retention as retention


collector = fixtures.collector
write = fixtures.write


class HostReceiptTests(unittest.TestCase):
    tearDown = fixtures.CollectionTests.tearDown
    fixture = fixtures.CollectionTests.fixture
    decoder = fixtures.CollectionTests.decoder
    collect = retention.RetentionTests.collect
    publication = retention.RetentionTests.publication
    item = retention.RetentionTests.item
    complete_guest = retention.RetentionTests.complete_guest

    def setUp(self):
        fixtures.CollectionTests.setUp(self)
        self.vm.kind = 'host'
        self.job['backend'] = 'host'
        self.fixture()

    def remove_working_pixels(self):
        for name in ('capture', 'preflight', 'output', 'transfer'):
            shutil.rmtree(self.unit / name, ignore_errors=True)

    def test_receipt_and_video_are_durable_before_ack_without_archive(self):
        put = self.vm.put

        def verify_before_ack(local, remote, timeout=600):
            item = self.item()
            self.assertEqual(item['evidence']['mode'], 'local')
            self.assertFalse(Path(item['evidence']['path']).exists())
            self.assertTrue(Path(item['receipt']['path']).is_file())
            self.assertTrue(Path(item['path']).is_file())
            collector.verify_publication(self.job, self.output)
            return put(local, remote, timeout)

        with self.decoder(), patch.object(collector, 'collect_evidence', side_effect=AssertionError('Unexpected archive')), \
                patch.object(self.vm, 'put', side_effect=verify_before_ack):
            self.collect()
        self.assertEqual(self.vm.downloads, [self.video['output']])
        self.assertFalse((self.unit / 'transfer').exists())
        self.assertTrue((self.unit / 'preflight').exists())
        self.remove_working_pixels()
        self.complete_guest()
        self.assertEqual(self.collect()['status'], 'complete')
        self.assertEqual(self.item()['evidence']['mode'], 'receipt')
        self.assertEqual(self.item()['cleanup']['state'], 'complete')
        self.assertEqual(collector.verify_publication(self.job, self.output)['status'], 'complete')

    def test_failed_ack_retains_originals_and_retries_without_copy_or_decode(self):
        self.vm.fail_ack = True
        with self.decoder(), self.assertRaisesRegex(RuntimeError, 'ACK transfer'):
            self.collect()
        self.assertEqual(self.item()['evidence']['mode'], 'local')
        self.assertTrue(Path(self.video['output']).exists())
        self.vm.fail_ack = False
        with patch.object(self.vm, 'get', side_effect=AssertionError('Unexpected copy')), \
                patch.object(collector, 'decode_video', side_effect=AssertionError('Unexpected decode')):
            self.collect()
        self.assertEqual(len(self.vm.acks), 1)

    def test_ambiguous_ack_recovers_after_originals_are_cleaned(self):
        put = self.vm.put

        def delivered(local, remote, timeout=600):
            put(local, remote, timeout)
            raise RuntimeError('Lost acknowledgment response')

        with self.decoder(), patch.object(self.vm, 'put', side_effect=delivered), \
                self.assertRaisesRegex(RuntimeError, 'Lost acknowledgment'):
            self.collect()
        self.remove_working_pixels()
        self.complete_guest()
        self.assertEqual(self.collect()['status'], 'complete')
        self.assertEqual(self.item()['cleanup']['state'], 'complete')

    def acknowledge_before_cleanup(self):
        completed = {'version': 1, 'jobId': self.job['jobId'], 'sourceId': self.job['sourceId'],
                     'cardId': 312, 'ready': self.ready, 'ack': self.vm.acks[-1], 'status': 'acknowledged'}
        write(self.unit / 'completed.json', completed)

    def test_poll_during_cleanup_uses_acknowledged_receipt_without_originals(self):
        with self.decoder():
            self.collect()
        self.acknowledge_before_cleanup()
        self.remove_working_pixels()
        with patch.object(collector, 'decode_video', side_effect=AssertionError('Unexpected decode')), \
                patch.object(collector, 'verify_local_evidence', side_effect=AssertionError('Originals already acknowledged')):
            self.collect()
        self.assertEqual(self.item()['evidence']['mode'], 'receipt')

    def test_cleanup_after_a_stale_snapshot_uses_the_durable_receipt_then_confirms_next_poll(self):
        with self.decoder():
            self.collect()
        execute = self.vm.exec

        def cleanup_after_snapshot(argv, timeout=180):
            result = execute(argv, timeout)
            snapshot = json.loads(result)
            self.assertEqual(snapshot['completed'], {})
            self.acknowledge_before_cleanup()
            self.remove_working_pixels()
            return result

        with patch.object(self.vm, 'exec', side_effect=cleanup_after_snapshot), \
                patch.object(collector, 'verify_local_evidence', side_effect=AssertionError('Originals may be deleting')), \
                patch.object(collector, 'decode_video', side_effect=AssertionError('Unexpected decode')):
            result = self.collect()
        self.assertEqual(result['status'], 'pending')
        self.assertEqual(self.item()['evidence']['mode'], 'local')
        self.complete_guest()
        with patch.object(collector, 'verify_local_evidence', side_effect=AssertionError('Originals were acknowledged')):
            self.assertEqual(self.collect()['status'], 'complete')
        self.assertEqual(self.item()['evidence']['mode'], 'receipt')

    def test_pending_publication_verification_during_cleanup_does_not_read_originals(self):
        with self.decoder():
            self.collect()
        self.acknowledge_before_cleanup()
        self.remove_working_pixels()
        with patch.object(collector, 'verify_local_evidence', side_effect=AssertionError('Originals may be deleting')):
            publication = collector.verify_publication(self.job, self.output)
        self.assertEqual(publication['status'], 'pending')
        self.assertEqual(publication['videos']['312']['evidence']['mode'], 'local')

    def test_completed_publication_cannot_claim_an_unconfirmed_local_receipt(self):
        with self.decoder():
            self.collect()
        publication = self.publication()
        publication['status'] = 'complete'
        write(self.output / '.collection-manifest.json', publication)
        with self.assertRaisesRegex(RuntimeError, 'lacks a confirmed acknowledgment'):
            collector.verify_publication(self.job, self.output)

    def test_previous_local_receipt_requires_a_matching_durable_acknowledgment_intent(self):
        with self.decoder():
            self.collect()
        original = self.publication()
        for change in ['missing', 'null', 'empty', 'verificationId', 'videoSha256', 'evidenceSha256']:
            with self.subTest(change=change):
                publication = json.loads(json.dumps(original))
                item = publication['videos']['312']
                if change == 'missing':
                    del item['ackIntent']
                elif change == 'null':
                    item['ackIntent'] = None
                elif change == 'empty':
                    item['ackIntent'] = {}
                else:
                    item['ackIntent'][change] = 'wrong'
                write(self.output / '.collection-manifest.json', publication)
                acknowledgments = len(self.vm.acks)
                with self.assertRaisesRegex(RuntimeError, 'durable acknowledgment intent'):
                    self.collect()
                with self.assertRaisesRegex(RuntimeError, 'durable acknowledgment intent'):
                    collector.verify_publication(self.job, self.output)
                self.assertEqual(len(self.vm.acks), acknowledgments)
        write(self.output / '.collection-manifest.json', original)

    def test_corrupt_durable_receipt_or_video_blocks_local_retries_without_original_reads(self):
        with self.decoder():
            self.collect()
        for key in ['receipt', 'video']:
            with self.subTest(file=key):
                item = self.item()
                path = Path(item['receipt']['path'] if key == 'receipt' else item['path'])
                original = path.read_bytes()
                path.write_bytes(b'{}')
                acknowledgments = len(self.vm.acks)
                with patch.object(collector, 'verify_local_evidence', side_effect=AssertionError('Unexpected original read')):
                    with self.assertRaisesRegex(RuntimeError, 'receipt checksum|Video mismatch'):
                        self.collect()
                    with self.assertRaisesRegex(RuntimeError, 'receipt checksum|Video mismatch'):
                        collector.verify_publication(self.job, self.output)
                self.assertEqual(len(self.vm.acks), acknowledgments)
                path.write_bytes(original)

    def test_restart_during_cleanup_can_reacknowledge_under_a_new_attempt(self):
        with self.decoder():
            self.collect()
        self.acknowledge_before_cleanup()
        self.remove_working_pixels()
        self.ready.update({'verificationId': str(uuid.uuid4()), 'requiresHostVerification': True})
        write(self.unit / 'ready.json', self.ready)
        self.status.update({'attempt': self.ready['verificationId'], 'completed': {}})
        write(Path(self.job['root']) / 'job-status.json', self.status)
        with patch.object(collector, 'decode_video', side_effect=AssertionError('Unexpected decode')), \
                patch.object(collector, 'verify_local_evidence', side_effect=AssertionError('Originals already acknowledged')):
            self.collect()
        self.assertEqual(self.vm.acks[-1]['verificationId'], self.ready['verificationId'])
        self.complete_guest()
        self.assertEqual(self.collect()['status'], 'complete')

    def test_wrong_completed_ack_cannot_replace_local_evidence_verification(self):
        with self.decoder():
            self.collect()
        self.acknowledge_before_cleanup()
        path = self.unit / 'completed.json'
        record = collector.read_json(path)
        record['ack']['videoSha256'] = 'a' * 64
        write(path, record)
        self.remove_working_pixels()
        with self.assertRaisesRegex(RuntimeError, 'acknowledgment differs'):
            self.collect()

    def test_local_corruption_is_rejected_without_acknowledging(self):
        manifest = self.unit / 'output/.render-manifest.json'
        manifest.write_text('{}')
        with self.decoder(), self.assertRaisesRegex(RuntimeError, 'Local evidence file changed'):
            self.collect()
        self.assertFalse(self.vm.acks)

    def test_stale_ack_cannot_bypass_missing_originals(self):
        with self.decoder():
            self.collect()
        self.remove_working_pixels()
        self.complete_guest(attempt='stale')
        with self.assertRaises(RuntimeError):
            self.collect()
        self.assertEqual(self.item()['evidence']['mode'], 'local')

    def test_failed_audit_cannot_create_local_receipt(self):
        self.fixture(passed=False)
        with self.decoder(), self.assertRaisesRegex(RuntimeError, 'Independent audit'):
            self.collect()
        self.assertFalse(self.vm.acks)
        self.assertFalse((self.output / '.receipts').exists())

    def test_full_host_retention_still_retains_full_evidence(self):
        with self.decoder():
            collector.collect(self.vm, self.job, self.output, self.evidence)
        item = self.item()
        self.assertTrue(Path(item['evidence']['path']).is_dir())
        self.assertTrue((self.unit / 'transfer/evidence.tar').exists())

    def test_local_fast_path_does_not_require_double_evidence_space(self):
        allocations = []

        def capacity(items, reserve):
            allocations.extend(items)

        with self.decoder(), patch.object(collector, 'require_disk_space', side_effect=capacity):
            self.collect()
        self.assertIn((self.evidence, 0), allocations)

    def test_symlink_inventory_member_is_rejected(self):
        path = self.unit / 'preflight/approved.json'
        moved = self.root / 'approval.json'
        path.rename(moved)
        path.symlink_to(moved)
        with self.decoder(), self.assertRaisesRegex(RuntimeError, 'Local evidence file changed'):
            self.collect()
        self.assertFalse(self.vm.acks)

    def test_receipt_corruption_still_blocks_completion(self):
        with self.decoder():
            self.collect()
        self.complete_guest()
        Path(self.item()['receipt']['path']).write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'receipt checksum'):
            self.collect()

    def certificate_fixture(self):
        path = self.unit / 'output/validation-attempt/certificate.json'
        write(path, {'certificate': 'fixture'})
        self.video['decodeCertificate'] = {'path': str(path), 'sha256': collector.digest(path)}
        self.vm.config = {'ffmpeg': '/pinned/ffmpeg', 'ffprobe': '/pinned/ffprobe'}
        source = (Path(self.job['sourceRoot']), {'files': {
            'scripts/mi-note-video/video_validation.py': collector.digest(fixtures.HERE / 'video_validation.py'),
        }})
        validation = {'fullyDecoded': True, 'stream': self.video['stream'],
                      'certificateSha256': self.video['decodeCertificate']['sha256']}
        return path, source, validation

    def test_same_host_certificate_reuses_strict_decode(self):
        path, source, validation = self.certificate_fixture()
        with patch('video_validation.verify_certificate', return_value=validation) as verify, \
                patch.object(collector, 'decode_video', side_effect=AssertionError('Unexpected decode')):
            result = collector.verify_decode(self.vm, self.job, self.ready, Path(self.video['output']), source)
        self.assertTrue(result['reusedPinnedHostDecode'])
        self.assertTrue(verify.call_args.kwargs['verify_samples'])
        self.assertEqual(verify.call_args.kwargs['executable_paths'],
                         {'python': self.job['python'], 'ffmpeg': '/pinned/ffmpeg', 'ffprobe': '/pinned/ffprobe'})
        self.assertEqual(verify.call_args.args[2], path)

    def test_vm_keeps_independent_decode_even_with_a_certificate(self):
        _, source, _ = self.certificate_fixture()
        self.vm.kind = 'vm'
        self.job['backend'] = 'vm'
        with self.decoder() as decode, patch('video_validation.verify_certificate', side_effect=AssertionError('Unexpected trust')):
            collector.verify_decode(self.vm, self.job, self.ready, Path(self.video['output']), source)
        self.assertEqual(decode.call_count, 1)

    def test_changed_certificate_or_validator_cannot_fall_back_silently(self):
        path, source, _ = self.certificate_fixture()
        original = path.read_bytes()
        path.write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'certificate location or checksum'):
            collector.verify_decode(self.vm, self.job, self.ready, Path(self.video['output']), source)
        path.write_bytes(original)
        source[1]['files']['scripts/mi-note-video/video_validation.py'] = 'a' * 64
        with self.assertRaisesRegex(RuntimeError, 'validator differs'):
            collector.verify_decode(self.vm, self.job, self.ready, Path(self.video['output']), source)

    def test_certificate_runtime_failure_blocks_publication(self):
        _, source, _ = self.certificate_fixture()
        with patch('video_validation.verify_certificate', side_effect=ValueError('Runtime changed')), \
                self.assertRaisesRegex(ValueError, 'Runtime changed'):
            collector.verify_decode(self.vm, self.job, self.ready, Path(self.video['output']), source)


if __name__ == '__main__':
    unittest.main()
