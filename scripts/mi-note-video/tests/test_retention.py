import json
from pathlib import Path
import shutil
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import test_jobs as fixtures


collector = fixtures.collector
write = fixtures.write


class RetentionTests(unittest.TestCase):
    setUp = fixtures.CollectionTests.setUp
    tearDown = fixtures.CollectionTests.tearDown
    fixture = fixtures.CollectionTests.fixture
    decoder = fixtures.CollectionTests.decoder

    def collect(self, minimum_free_bytes=0):
        return collector.collect(self.vm, self.job, self.output, self.evidence,
                                 retention='receipt', source_root=self.job['sourceRoot'], minimum_free_bytes=minimum_free_bytes)

    def publication(self):
        return json.loads((self.output / '.collection-manifest.json').read_text())

    def item(self):
        return self.publication()['videos']['312']

    def complete_guest(self, attempt=None):
        self.status.update({'status': 'complete', 'attempt': attempt or self.ready['verificationId'], 'currentCard': None,
                            'completed': {'312': {'videoSha256': self.video['sha256'], 'evidenceSha256': self.ready['evidence']['sha256']}}})
        write(Path(self.job['root']) / 'job-status.json', self.status)

    def publish_and_compact(self):
        with self.decoder():
            self.collect()
            self.complete_guest()
            self.assertEqual(self.collect()['status'], 'complete')

    def test_receipt_is_durable_before_ack_and_pixels_wait_for_guest_completion(self):
        original_put = self.vm.put

        def check_receipt(local, remote, timeout=600):
            item = self.item()
            self.assertEqual(item['evidence']['mode'], 'full')
            self.assertTrue(Path(item['evidence']['path']).is_dir())
            self.assertTrue(Path(item['receipt']['path']).is_file())
            collector.verify_publication(self.job, self.output)
            return original_put(local, remote, timeout)

        with self.decoder(), patch.object(self.vm, 'put', side_effect=check_receipt):
            self.collect()
        self.assertTrue(Path(self.item()['evidence']['path']).is_dir())
        self.complete_guest()
        self.collect()
        item = self.item()
        self.assertEqual(item['evidence']['mode'], 'receipt')
        self.assertEqual(item['cleanup']['state'], 'complete')
        self.assertFalse(Path(item['evidence']['path']).exists())
        self.assertTrue(Path(item['receipt']['path']).is_file())
        self.assertEqual(collector.verify_publication(self.job, self.output)['status'], 'complete')

    def test_failed_ack_keeps_full_evidence(self):
        self.vm.fail_ack = True
        with self.decoder(), self.assertRaisesRegex(RuntimeError, 'ACK transfer'):
            self.collect()
        self.assertEqual(self.item()['evidence']['mode'], 'full')
        self.assertTrue(Path(self.item()['evidence']['path']).is_dir())
        self.vm.fail_ack = False
        with self.decoder(), patch.object(self.vm, 'get', side_effect=AssertionError('Unexpected download')):
            self.collect()

    def test_ambiguous_delivered_ack_recovers_using_guest_confirmation(self):
        original_put = self.vm.put

        def delivered_then_failed(local, remote, timeout=600):
            original_put(local, remote, timeout)
            raise RuntimeError('Connection lost after delivery')

        with self.decoder(), patch.object(self.vm, 'put', side_effect=delivered_then_failed), self.assertRaisesRegex(RuntimeError, 'Connection lost'):
            self.collect()
        self.assertNotIn('ackSentAt', self.item())
        self.assertTrue(Path(self.item()['evidence']['path']).is_dir())
        self.complete_guest()
        self.collect()
        self.assertEqual(self.item()['cleanup']['state'], 'complete')

    def test_stale_guest_completion_does_not_authorize_cleanup(self):
        with self.decoder():
            self.collect()
        self.complete_guest(attempt='unrelated-attempt')
        self.collect()
        self.assertEqual(self.item()['evidence']['mode'], 'full')
        self.assertTrue(Path(self.item()['evidence']['path']).is_dir())

    def test_receipt_only_resume_uses_fresh_ack_without_downloads_or_decode(self):
        self.publish_and_compact()
        for name in ['output', 'preflight', 'transfer']:
            shutil.rmtree(self.unit / name, ignore_errors=True)
        self.ready.update({'verificationId': str(uuid.uuid4()), 'requiresHostVerification': True})
        write(self.unit / 'ready.json', self.ready)
        self.status.update({'status': 'awaiting-collection', 'attempt': self.ready['verificationId'], 'currentCard': 312, 'completed': {}})
        write(Path(self.job['root']) / 'job-status.json', self.status)
        with patch.object(self.vm, 'get', side_effect=AssertionError('Unexpected download')), \
                patch.object(collector, 'decode_video', side_effect=AssertionError('Unexpected decode')):
            self.collect()
            self.complete_guest()
            self.assertEqual(self.collect()['status'], 'complete')
        self.assertEqual(self.vm.acks[-1]['verificationId'], self.ready['verificationId'])

    def test_receipt_inventory_audit_and_video_corruption_are_rejected(self):
        self.publish_and_compact()
        item = self.item()
        receipt = Path(item['receipt']['path'])
        paths = [receipt, receipt.with_name('inventory.json'), receipt.with_name('audit.json'), Path(item['path'])]
        for path in paths:
            original = path.read_bytes()
            with self.subTest(path=path.name):
                path.write_bytes(b'{}')
                with self.assertRaises(RuntimeError):
                    collector.verify_publication(self.job, self.output)
                path.write_bytes(original)
        receipt.unlink()
        with self.assertRaises(RuntimeError):
            collector.verify_publication(self.job, self.output)

    def test_changed_pinned_source_prevents_receipt_verification(self):
        self.publish_and_compact()
        source = Path(self.job['sourceRoot']) / 'scripts/mi-note-video/audit.py'
        source.write_text('changed source')
        with self.assertRaisesRegex(RuntimeError, 'Pinned rendering source changed'):
            collector.verify_publication(self.job, self.output)

    def test_failed_audit_cannot_produce_receipt_or_ack(self):
        self.fixture(passed=False)
        with self.decoder(), self.assertRaisesRegex(RuntimeError, 'Independent audit'):
            self.collect()
        self.assertFalse(self.vm.acks)
        self.assertFalse((self.output / '.receipts').exists())

    def test_orphan_receipt_before_publication_is_reused_after_fresh_decode(self):
        with self.decoder(), patch.object(collector, 'save_publication', side_effect=RuntimeError('Crash before publication')), \
                self.assertRaisesRegex(RuntimeError, 'Crash before publication'):
            self.collect()
        self.assertFalse(self.vm.acks)
        self.assertFalse((self.output / '.collection-manifest.json').exists())
        saved_receipt = next((self.output / '.receipts').rglob('receipt.json')).read_bytes()
        validation = {'fullyDecoded': True, 'stream': self.video['stream'], 'verifiedAt': 'new verification'}
        with patch.object(collector, 'decode_video', return_value=validation):
            self.collect()
        self.assertEqual(Path(self.item()['receipt']['path']).read_bytes(), saved_receipt)
        self.assertEqual(self.item()['hostValidation']['verifiedAt'], 'fixture')

    def test_cleanup_crash_before_rename_recovers(self):
        with self.decoder():
            self.collect()
        original = Path(self.item()['evidence']['path'])
        real_rename = collector.os.rename

        def crash_rename(source, destination):
            if Path(source) == original:
                raise RuntimeError('Crash before rename')
            return real_rename(source, destination)

        self.complete_guest()
        with patch.object(collector.os, 'rename', side_effect=crash_rename), self.assertRaisesRegex(RuntimeError, 'Crash before rename'):
            self.collect()
        self.assertEqual(self.item()['cleanup']['state'], 'pending')
        self.assertTrue(original.is_dir())
        self.collect()
        self.assertFalse(original.exists())
        self.assertEqual(self.item()['cleanup']['state'], 'complete')

    def test_cleanup_partial_deletion_recovers_without_native_verification(self):
        with self.decoder():
            self.collect()
        real_rmtree = collector.shutil.rmtree

        def crash_delete(path, *args, **kwargs):
            if str(path).endswith('.cleanup'):
                next(Path(path).rglob('*.json')).unlink()
                raise RuntimeError('Crash during deletion')
            return real_rmtree(path, *args, **kwargs)

        self.complete_guest()
        with patch.object(collector.shutil, 'rmtree', side_effect=crash_delete), self.assertRaisesRegex(RuntimeError, 'Crash during deletion'):
            self.collect()
        self.assertTrue(Path(self.item()['cleanup']['tombstone']).is_dir())
        with patch.object(collector, 'verify_evidence', side_effect=AssertionError('Deleted pixels must not be required')):
            self.collect()
        self.assertEqual(self.item()['cleanup']['state'], 'complete')

    def test_cleanup_crash_after_deletion_recovers(self):
        with self.decoder():
            self.collect()
        real_save = collector.save_publication

        def crash_save(path, publication):
            if publication['videos']['312'].get('cleanup', {}).get('state') == 'complete':
                raise RuntimeError('Crash after deletion')
            return real_save(path, publication)

        self.complete_guest()
        with patch.object(collector, 'save_publication', side_effect=crash_save), self.assertRaisesRegex(RuntimeError, 'Crash after deletion'):
            self.collect()
        item = self.item()
        self.assertEqual(item['cleanup']['state'], 'pending')
        self.assertFalse(Path(item['evidence']['path']).exists())
        self.assertFalse(Path(item['cleanup']['tombstone']).exists())
        self.collect()
        self.assertEqual(self.item()['cleanup']['state'], 'complete')

    def test_cleanup_preserves_siblings_and_rejects_symlink_tombstone(self):
        with self.decoder():
            self.collect()
        original = Path(self.item()['evidence']['path'])
        sibling = original.parent / 'unrelated'
        sibling.mkdir()
        (sibling / 'keep').write_text('untouched')
        tombstone = original.with_name('.' + original.name + '.cleanup')
        tombstone.symlink_to(sibling, target_is_directory=True)
        self.complete_guest()
        with self.assertRaisesRegex(RuntimeError, 'conflicting directories|Unsafe evidence cleanup'):
            self.collect()
        self.assertEqual((sibling / 'keep').read_text(), 'untouched')
        self.assertTrue(original.exists())
        tombstone.unlink()
        self.collect()
        self.assertEqual((sibling / 'keep').read_text(), 'untouched')

    def test_retention_is_immutable_and_legacy_publications_verify_offline(self):
        with self.decoder():
            collector.collect(self.vm, self.job, self.output, self.evidence)
        self.assertEqual(collector.verify_publication(self.job, self.output)['version'], 1)
        with self.assertRaisesRegex(RuntimeError, 'retention policy cannot change'):
            self.collect()

    def test_receipt_requires_explicit_source_root(self):
        with self.assertRaisesRegex(RuntimeError, 'pinned local source root'):
            collector.collect(self.vm, self.job, self.output, self.evidence, retention='receipt')

    def test_unchanged_poll_does_not_rewrite_publication(self):
        with self.decoder():
            self.collect()
        manifest_path = self.output / '.collection-manifest.json'
        original_bytes = manifest_path.read_bytes()
        with patch.object(collector, 'atomic_json', wraps=collector.atomic_json) as writes:
            self.collect()
        self.assertFalse(any(call.args[0] == manifest_path for call in writes.call_args_list))
        self.assertEqual(manifest_path.read_bytes(), original_bytes)

    def test_source_cache_is_scoped_to_explicit_verification_pass(self):
        self.publish_and_compact()
        with patch.object(collector, 'verify_source_root', wraps=collector.verify_source_root) as verify:
            cache = {}
            collector.verify_publication(self.job, self.output, source_cache=cache)
            collector.verify_publication(self.job, self.output, source_cache=cache)
            self.assertEqual(verify.call_count, 1)
            collector.verify_publication(self.job, self.output, source_cache={})
            self.assertEqual(verify.call_count, 2)

    def test_disk_headroom_checks_combined_allocations_before_any_transfer(self):
        reserve = 1000
        required = reserve + self.video['bytes'] + self.ready['evidence']['bytes'] * 2
        with self.decoder(), patch.object(collector, 'available_capacity', return_value=required - 1), \
                self.assertRaisesRegex(RuntimeError, 'Insufficient collector disk space'):
            self.collect(minimum_free_bytes=reserve)
        self.assertFalse(self.vm.downloads)
        self.assertFalse(self.vm.acks)
        self.assertFalse((self.output / '.collection-manifest.json').exists())
        self.assertTrue(Path(self.video['output']).exists())

    def test_sufficient_disk_headroom_allows_verified_collection(self):
        reserve = 1000
        required = reserve + self.video['bytes'] + self.ready['evidence']['bytes'] * 2
        with self.decoder(), patch.object(collector, 'available_capacity', return_value=required + 4 * 1024 ** 2):
            self.collect(minimum_free_bytes=reserve)
        self.assertEqual(len(self.vm.acks), 1)
        self.assertEqual(self.item()['evidence']['mode'], 'full')

    def test_existing_outputs_and_evidence_do_not_reserve_transfer_space_again(self):
        with self.decoder():
            self.collect()
        reserve = 1000
        with patch.object(collector, 'available_capacity', return_value=reserve), \
                patch.object(self.vm, 'get', side_effect=AssertionError('Unexpected download')):
            self.collect(minimum_free_bytes=reserve)
        self.assertEqual(len(self.vm.acks), 2)

    def test_evidence_allocation_is_rechecked_after_video_transfer(self):
        self.output.mkdir()
        preserved = self.output / 'unrelated'
        preserved.write_text('keep')
        with self.decoder(), patch.object(collector, 'available_capacity', side_effect=[2 ** 40, 1000]), \
                self.assertRaisesRegex(RuntimeError, 'Insufficient collector disk space'):
            self.collect(minimum_free_bytes=1000)
        self.assertEqual(self.vm.downloads, [self.video['output']])
        self.assertFalse(self.vm.acks)
        self.assertFalse((self.output / '312.mp4').exists())
        self.assertEqual(preserved.read_text(), 'keep')

    def test_disk_headroom_is_per_filesystem_and_accepts_exact_boundary(self):
        with patch.object(collector.os, 'stat', side_effect=[SimpleNamespace(st_dev=1), SimpleNamespace(st_dev=2)]), \
                patch.object(collector, 'available_capacity', side_effect=[1100, 1200]):
            collector.require_disk_space([(self.output, 100), (self.evidence, 200)], 1000)
        with patch.object(collector.os, 'stat', return_value=SimpleNamespace(st_dev=1)), \
                patch.object(collector, 'available_capacity', return_value=1299), \
                self.assertRaisesRegex(RuntimeError, 'Insufficient collector disk space'):
            collector.require_disk_space([(self.output, 100), (self.evidence, 200)], 1000)

    def test_default_retention_does_not_check_disk_space(self):
        with self.decoder(), patch.object(collector, 'available_capacity', side_effect=AssertionError('Legacy policy changed')):
            collector.collect(self.vm, self.job, self.output, self.evidence)


if __name__ == '__main__':
    unittest.main()
