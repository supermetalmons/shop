import fcntl
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import run


class WorkerFailureTests(unittest.TestCase):
    def test_failed_worker_terminates_descendants(self):
        child = (
            "import fcntl, time\nfrom pathlib import Path\n"
            "lock = open('child.lock', 'w')\nfcntl.flock(lock, fcntl.LOCK_EX)\n"
            "Path('ready').touch()\ntime.sleep(3)\n"
        )
        for result in (2, -signal.SIGKILL):
            with self.subTest(result=result), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "worker.py").write_text(
                    "import json, os, signal, subprocess, sys, time\nfrom pathlib import Path\n"
                    "result = json.load(sys.stdin)\n"
                    f"subprocess.Popen([sys.executable, '-c', {child!r}], cwd=Path(__file__).parent)\n"
                    "ready = Path(__file__).with_name('ready')\n"
                    "while not ready.exists(): time.sleep(.01)\n"
                    "if result < 0: os.kill(os.getpid(), -result)\n"
                    "os._exit(result)\n"
                )
                with patch.object(run, "HERE", root):
                    with self.assertRaises(subprocess.CalledProcessError) as caught:
                        run.run_worker(result, root)
                self.assertEqual(caught.exception.returncode, result)
                with (root / "child.lock").open() as lock:
                    start = time.monotonic()
                    fcntl.flock(lock, fcntl.LOCK_EX)
                    self.assertLess(time.monotonic() - start, 2)
