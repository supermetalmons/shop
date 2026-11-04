import argparse
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shell import create_shell, prepare_artwork
from studio import FINISHES, apply_finish, setup_scene


def check_cancelled(cancel_file):
    if cancel_file is not None and cancel_file.exists():
        raise RuntimeError("Egg rendering cancelled.")


def main(source_dir, output_dir, ids, cancel_file=None):
    check_cancelled(cancel_file)
    scene = setup_scene()
    shell = create_shell()
    for finish in FINISHES:
        (output_dir / finish).mkdir()

    for egg_id in ids:
        image = prepare_artwork(source_dir / f"{egg_id}.webp")
        try:
            for finish in FINISHES:
                apply_finish(shell, image, finish)
                frame = output_dir / finish / f"{egg_id}.png"
                scene.render.filepath = str(frame)
                check_cancelled(cancel_file)
                print(f"Rendering egg {egg_id} · {finish}", flush=True)
                result = bpy.ops.render.render(write_still=True)
                check_cancelled(cancel_file)
                if 'FINISHED' not in result or not frame.is_file():
                    raise RuntimeError(f"Blender did not finish rendering {frame}")
        finally:
            bpy.data.images.remove(image)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('source_dir', type=Path)
    parser.add_argument('output_dir', type=Path)
    parser.add_argument('ids', nargs='+')
    parser.add_argument('--cancel-file', type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    main(args.source_dir, args.output_dir, args.ids, args.cancel_file)
