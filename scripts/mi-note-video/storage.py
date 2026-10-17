import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


_capacity_cache = {}
_capacity_script = '''import Foundation
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let values = try url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
print(values.volumeAvailableCapacityForImportantUsage ?? -1)
'''


def available_capacity(path, immediate=None):
    path = Path(path)
    immediate = shutil.disk_usage(path).free if immediate is None else immediate
    if sys.platform != 'darwin':
        return immediate
    device = os.stat(path).st_dev
    cached = _capacity_cache.get(device)
    if cached and time.monotonic() - cached[0] < 30:
        available = max(immediate, cached[1] - max(0, cached[2] - immediate))
        _capacity_cache[device] = (cached[0], available, immediate)
        return available
    available = immediate
    try:
        result = subprocess.run(['/usr/bin/swift', '-e', _capacity_script, str(path)],
                                check=True, capture_output=True, text=True, timeout=15)
        important = int(result.stdout.strip())
        if important > 0:
            available = max(immediate, important)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    _capacity_cache[device] = (time.monotonic(), available, immediate)
    return available
