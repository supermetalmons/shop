import json
import shutil
import signal
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from composite import composite
from knife_sources import render_knives


def main():
    jobs = [(Path(source), Path(plate) if plate is not None else None, Path(output))
            for source, plate, output in json.load(sys.stdin)]
    models = list(dict.fromkeys(source for source, plate, _ in jobs
                               if plate is not None and source.suffix.lower() == ".glb"))
    frameless = list(dict.fromkeys(source for source, plate, _ in jobs if plate is None))
    if any(source.suffix.lower() != ".glb" for source in frameless):
        raise ValueError("Frameless rendering requires GLB models")
    orbits = {}
    if models:
        orbits = dict(zip(models, render_knives(models, Path(tempfile.gettempdir()) / "knife-sources")))
    standalone = {}
    if frameless:
        standalone = dict(zip(frameless, render_knives(
            frameless, Path(tempfile.gettempdir()) / "knife-frameless", frameless=True)))

    def render(job):
        source, plate, output = job
        if plate is None:
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(standalone[source], output)
        else:
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
