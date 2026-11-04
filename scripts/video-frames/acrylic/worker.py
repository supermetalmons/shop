import json
import signal
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from composite import composite
from knife_sources import render_knives


def main():
    jobs = [tuple(map(Path, job)) for job in json.load(sys.stdin)]
    models = list(dict.fromkeys(source for source, _, _ in jobs if source.suffix.lower() == ".glb"))
    orbits = {}
    if models:
        orbits = dict(zip(models, render_knives(models, Path(tempfile.gettempdir()) / "knife-sources")))

    def render(job):
        source, plate, output = job
        composite(orbits.get(source, source), plate, output)
        print(f"Verified {output.name}", flush=True)

    with ThreadPoolExecutor(max_workers=2) as workers:
        list(workers.map(render, jobs))


if __name__ == "__main__":
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT, signal.SIGTERM})
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
