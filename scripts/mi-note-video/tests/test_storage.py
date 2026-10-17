from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import storage


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name)
        storage._capacity_cache.clear()

    def tearDown(self):
        self.temporary.cleanup()
        storage._capacity_cache.clear()

    def test_macos_uses_reclaimable_capacity_and_caches_by_volume(self):
        with patch.object(storage.sys, 'platform', 'darwin'), \
                patch.object(storage.subprocess, 'run', return_value=SimpleNamespace(stdout='135000000000\n')) as run:
            self.assertEqual(storage.available_capacity(self.path, 30000000000), 135000000000)
            self.assertEqual(storage.available_capacity(self.path, 31000000000), 135000000000)
            run.assert_called_once()

    def test_cache_expires_and_requeries_capacity(self):
        with patch.object(storage.sys, 'platform', 'darwin'), patch.object(storage.time, 'monotonic', side_effect=[1, 32, 32]), \
                patch.object(storage.subprocess, 'run', side_effect=[SimpleNamespace(stdout='135'), SimpleNamespace(stdout='80')]) as run:
            self.assertEqual(storage.available_capacity(self.path, 30), 135)
            self.assertEqual(storage.available_capacity(self.path, 30), 80)
            self.assertEqual(run.call_count, 2)

    def test_cached_capacity_decreases_with_observed_disk_usage(self):
        with patch.object(storage.sys, 'platform', 'darwin'), \
                patch.object(storage.subprocess, 'run', return_value=SimpleNamespace(stdout='20')) as run:
            self.assertEqual(storage.available_capacity(self.path, 10), 20)
            self.assertEqual(storage.available_capacity(self.path, 4), 14)
            self.assertEqual(storage.available_capacity(self.path, 8), 14)
            self.assertEqual(storage.available_capacity(self.path, 2), 8)
            run.assert_called_once()

    def test_cache_usage_updates_do_not_extend_expiration(self):
        with patch.object(storage.sys, 'platform', 'darwin'), \
                patch.object(storage.time, 'monotonic', side_effect=[1, 20, 32, 32]), \
                patch.object(storage.subprocess, 'run', side_effect=[SimpleNamespace(stdout='20'), SimpleNamespace(stdout='12')]) as run:
            self.assertEqual(storage.available_capacity(self.path, 10), 20)
            self.assertEqual(storage.available_capacity(self.path, 8), 18)
            self.assertEqual(storage.available_capacity(self.path, 6), 12)
            self.assertEqual(run.call_count, 2)

    def test_failed_or_invalid_macos_probe_falls_back_to_immediate_free(self):
        for response in (SimpleNamespace(stdout='-1'), SimpleNamespace(stdout='invalid'), OSError('missing'), subprocess.TimeoutExpired('swift', 15)):
            storage._capacity_cache.clear()
            with self.subTest(response=response), patch.object(storage.sys, 'platform', 'darwin'), \
                    patch.object(storage.subprocess, 'run', **({'side_effect': response} if isinstance(response, Exception) else {'return_value': response})):
                self.assertEqual(storage.available_capacity(self.path, 30), 30)
                self.assertEqual(storage.available_capacity(self.path, 4), 4)

    def test_never_reduces_immediate_free_and_nonmacos_does_not_probe(self):
        with patch.object(storage.sys, 'platform', 'darwin'), patch.object(storage.subprocess, 'run', return_value=SimpleNamespace(stdout='20')):
            self.assertEqual(storage.available_capacity(self.path, 30), 30)
        with patch.object(storage.sys, 'platform', 'linux'), patch.object(storage.subprocess, 'run') as run:
            self.assertEqual(storage.available_capacity(self.path, 40), 40)
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
