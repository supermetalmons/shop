import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

import bpy
from mathutils import Matrix, Vector

DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(DIRECTORY))
from geometry import create_canvas
from material import create_material


def arguments():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--manifest', type=Path)
    mode.add_argument('--verify', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--overwrite', action='store_true')
    parser.add_argument('--cancel-file', type=Path)
    parser.add_argument('--work-dir', type=Path)
    return parser.parse_args(sys.argv[sys.argv.index('--') + 1:])


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save_report(path, report):
    pending = path.with_suffix('.pending.json')
    pending.write_text(json.dumps(report, indent=2) + '\n')
    pending.replace(path)


def image_normalizer():
    source = DIRECTORY / 'normalize-image.swift'
    cache = DIRECTORY.parents[1] / '.cache/painting-canvas/helpers'
    executable = cache / f'normalize-image-{checksum(source)[:16]}'
    if not executable.is_file():
        developer = subprocess.run(['/usr/bin/xcode-select', '-p'], capture_output=True, text=True)
        if developer.returncode:
            raise ValueError('Image normalization requires the macOS Swift command-line tools.')
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=cache) as temporary:
            binary = Path(temporary) / 'normalize-image'
            result = subprocess.run(['/usr/bin/swiftc', '-O', str(source), '-o', str(binary)],
                                    capture_output=True, text=True)
            if result.returncode:
                raise ValueError(f'Cannot build image normalizer: {result.stderr.strip()}')
            binary.replace(executable)
    return executable


def normalize_artwork(source, destination, executable):
    result = subprocess.run([str(executable), str(source), str(destination)], capture_output=True, text=True)
    if result.returncode:
        raise ValueError(f'Cannot normalize artwork: {result.stderr.strip()}')
    details = json.loads(result.stdout)
    return (destination if details['normalized'] else Path(source)), details


def setup_device(preset):
    if bpy.app.version_string != preset['blender_version']:
        raise ValueError(f"A Light requires Blender {preset['blender_version']}; found {bpy.app.version_string}.")
    if bpy.app.build_hash.decode() != preset['blender_build_hash']:
        raise ValueError('The Blender build differs from the approved A Light renderer.')
    for name, expected in preset['assets'].items():
        if checksum(DIRECTORY / 'assets' / name) != expected:
            raise ValueError(f'Approved material asset changed: {name}')
    preferences = bpy.context.preferences.addons['cycles'].preferences
    preferences.compute_device_type = preset['device']
    preferences.get_devices()
    for device in preferences.devices:
        device.use = device.type == preset['device']
    selected = [device.name for device in preferences.devices if device.use]
    if not selected:
        raise ValueError('The approved A Light renderer requires an available Metal GPU.')
    return selected


def sources_for(settings):
    if settings.verify:
        record = json.loads((DIRECTORY / 'reference/record.json').read_text())
        source = DIRECTORY / 'reference/artwork.webp'
        approved = DIRECTORY / 'reference/approved.png'
        if checksum(source) != record['source_sha256'] or checksum(approved) != record['approved_sha256']:
            raise ValueError('The approved reproduction fixture has changed.')
        return [{**record, 'path': str(source)}]
    manifest = settings.manifest.resolve()
    samples = json.loads(manifest.read_text()).get('samples')
    if not isinstance(samples, list) or not samples:
        raise ValueError('Manifest must contain a nonempty samples array.')
    result = []
    for sample in samples:
        identifier = str(sample.get('id', ''))
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', identifier):
            raise ValueError(f'Invalid artwork ID: {identifier!r}')
        source = Path(sample['path'])
        if not source.is_absolute():
            source = manifest.parent / source
        source = source.resolve()
        if not source.is_file():
            raise ValueError(f'Artwork does not exist: {source}')
        for key in ['width', 'height']:
            if key in sample and (not isinstance(sample[key], int) or isinstance(sample[key], bool) or sample[key] <= 0):
                raise ValueError(f'Artwork {identifier} has invalid {key}.')
        result.append({**sample, 'path': str(source)})
    if len({str(sample['id']) for sample in result}) != len(result):
        raise ValueError('Artwork IDs must be unique.')
    return result


def preflight_outputs(samples, output, overwrite):
    def identity(path):
        if not path.exists():
            return None
        stat = path.stat()
        return stat.st_dev, stat.st_ino

    ids = [str(sample['id']).casefold() for sample in samples]
    if len(set(ids)) != len(ids):
        raise ValueError('Artwork IDs must be unique ignoring case.')
    sources = {Path(sample['path']).resolve() for sample in samples}
    source_files = {identity(path) for path in sources} - {None}
    targets = [output / f"{sample['id']}.png" for sample in samples]
    targets += [output / 'render-report.json', output / 'render-report.pending.json']
    paths, files = set(), set()
    for target in targets:
        resolved, file = target.resolve(), identity(target)
        if resolved in sources or file in source_files:
            raise ValueError(f'Output would replace a source artwork: {target}')
        if resolved in paths or file is not None and file in files:
            raise ValueError(f'Output paths refer to the same file: {target}')
        if target.is_symlink() or target.exists() and target.stat().st_nlink > 1:
            raise ValueError(f'Output must not be linked to another file: {target}')
        if target.exists() and not overwrite:
            raise ValueError(f'Output already exists; use --overwrite to replace: {target}')
        paths.add(resolved)
        if file is not None:
            files.add(file)


def point_at(obj, position):
    back = (obj.location - Vector(position)).normalized()
    right = Vector((0, 1, 0)).cross(back).normalized()
    up = back.cross(right).normalized()
    obj.rotation_euler = Matrix((right, up, back)).transposed().to_euler()


def light(name, position, power, size):
    bpy.ops.object.light_add(type='AREA', location=position)
    item = bpy.context.object
    item.name = name
    item.data.energy = power
    item.data.shape = 'DISK'
    item.data.size = size
    point_at(item, (0, 0, 0))


def prepare_scene(sample, preset, image_path):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights, bpy.data.materials):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)
    for image in list(bpy.data.images):
        if image.users == 0 and image.type == 'IMAGE' and not image.name.startswith('111k canvas'):
            bpy.data.images.remove(image)
    image = bpy.data.images.load(str(image_path), check_existing=True)
    width_px, height_px = image.size
    if width_px <= 0 or height_px <= 0:
        raise ValueError(f"Artwork {sample['id']} could not be decoded.")
    for key, actual in [('width', width_px), ('height', height_px)]:
        if key in sample and sample[key] != actual:
            raise ValueError(f"Artwork {sample['id']} {key} differs from its manifest.")
        sample[key] = actual
    image.colorspace_settings.name = 'sRGB'
    scene = bpy.context.scene
    scene.render.engine = preset['engine']
    scene.cycles.device = 'GPU'
    scene.cycles.samples = preset['samples']
    scene.cycles.use_denoising = False
    scene.cycles.adaptive_threshold = .025
    scene.cycles.max_bounces = 2
    scene.cycles.diffuse_bounces = 1
    scene.cycles.glossy_bounces = 1
    scene.cycles.seed = preset['seed']
    scene.render.use_persistent_data = True
    scene.render.resolution_x = width_px
    scene.render.resolution_y = height_px
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.image_settings.color_depth = '8'
    scene.render.image_settings.compression = 15
    scene.render.filter_size = .8
    scene.render.dither_intensity = 0
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    if not scene.world:
        scene.world = bpy.data.worlds.new('Neutral studio')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (1, 1, 1, 1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = .25
    scene.use_nodes = True
    nodes, links = scene.node_tree.nodes, scene.node_tree.links
    nodes.clear()
    render = nodes.new('CompositorNodeRLayers')
    over = nodes.new('CompositorNodeAlphaOver')
    over.inputs[0].default_value = 1
    over.inputs[1].default_value = (1, 1, 1, 1)
    links.new(render.outputs['Image'], over.inputs[2])
    composite = nodes.new('CompositorNodeComposite')
    links.new(over.outputs[0], composite.inputs[0])
    width, height = 2 * width_px / height_px, 2
    config = preset['configuration']
    canvas = create_canvas(width, height, config)
    material = create_material(image, {**config,
        'photo_texture_path': str(DIRECTORY / 'assets/reference-weave.png'),
        'photo_edge_path': str(DIRECTORY / 'assets/reference-edge.png')})
    for surface in [canvas, *canvas.children_recursive]:
        if surface.type == 'MESH':
            surface.data.materials.append(material)
    light('Broad upper-right softbox', (3.4, 4.2, 5.5), 440, 5)
    light('Frontal fill', (-2.7, -.8, 6), 140, 5)
    bpy.ops.object.camera_add(location=(8 * math.tan(math.radians(config['yaw'])),
                                        8 * math.tan(math.radians(config['pitch'])), 8))
    camera = bpy.context.object
    camera.name = 'Nearly straight-on camera'
    point_at(camera, (0, 0, 0))
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 2.12 * max(1, width_px / height_px)
    scene.camera = camera
    return scene


def compare_reference(rendered, tolerance):
    import numpy as np

    arrays = []
    for path in [DIRECTORY / 'reference/approved.png', rendered]:
        image = bpy.data.images.load(str(path), check_existing=False)
        values = np.empty(len(image.pixels), dtype=np.float32)
        image.pixels.foreach_get(values)
        arrays.append(np.rint(values.reshape(-1, 4)[:, :3] * 255).clip(0, 255).astype(np.int16))
        bpy.data.images.remove(image)
    if arrays[0].shape != arrays[1].shape:
        raise ValueError('Verification render dimensions differ from the approved image.')
    difference = np.abs(arrays[0] - arrays[1])
    changed = int(np.count_nonzero(difference))
    fraction = changed / difference.size
    maximum = int(difference.max())
    return {'passed': maximum <= tolerance['maximum_8bit_difference']
            and fraction <= tolerance['maximum_changed_channel_fraction'],
            'comparison': 'Decoded RGB8 pixels with bounded Metal rounding tolerance',
            'exact_pixels': changed == 0, 'different_pixels': int(np.count_nonzero(difference.max(axis=1))),
            'different_channels': changed, 'changed_channel_fraction': fraction,
            'maximum_8bit_difference': maximum, 'tolerance': tolerance}


class RenderCancelled(Exception):
    pass


def check_cancel(cancel_file):
    if cancel_file is not None and cancel_file.exists():
        raise RenderCancelled('Canvas rendering cancelled.')


def render_sample(sample, preset, normalizer, output, work_dir, cancel_file):
    check_cancel(cancel_file)
    before = time.perf_counter()
    path = output / f"{sample['id']}.png"
    with tempfile.TemporaryDirectory(prefix='canvas-image-', dir=work_dir) as temporary:
        image_path, normalization = normalize_artwork(sample['path'],
            Path(temporary) / 'artwork.png', normalizer)
        scene = prepare_scene(sample, preset, image_path)
        source_hash = checksum(Path(sample['path']))
        prepared = time.perf_counter()
        scene.render.filepath = str(path)
        check_cancel(cancel_file)
        result = bpy.ops.render.render()
        rendered = time.perf_counter()
        check_cancel(cancel_file)
        if 'FINISHED' not in result:
            raise RenderCancelled('Blender cancelled the render.')
        staged = Path(temporary) / 'render.png'
        bpy.data.images['Render Result'].save_render(str(staged), scene=scene)
        check_cancel(cancel_file)
        staged.replace(path)
        output_hash = checksum(path)
        done = time.perf_counter()
    return {'id': sample['id'], 'source': sample['path'], 'source_sha256': source_hash,
            'width': sample['width'], 'height': sample['height'], 'output': str(path),
            'output_sha256': output_hash, 'normalization': normalization,
            'setup_seconds': prepared - before, 'render_seconds': rendered - prepared,
            'save_seconds': done - rendered, 'seconds': done - before}


def main():
    settings = arguments()
    preset = json.loads((DIRECTORY / 'preset.json').read_text())
    devices = setup_device(preset)
    samples = sources_for(settings)
    output = settings.output.resolve()
    preflight_outputs(samples, output, settings.overwrite)
    report_path = output / 'render-report.json'
    output.mkdir(parents=True, exist_ok=True)
    normalizer = image_normalizer()
    print('CANVAS_READY', flush=True)
    report = {'preset': preset['name'], 'blender_version': bpy.app.version_string,
              'blender_build_hash': bpy.app.build_hash.decode(), 'device': devices,
              'configuration': preset, 'source_hashes': {name: checksum(DIRECTORY / name)
                  for name in ['preset.json', 'render.py', 'render.mjs', 'geometry.py', 'material.py', 'normalize-image.swift']},
              'records': [], 'status': 'rendering',
              'timing_scope': 'Source decode, scene/material setup, rendering, white compositing, PNG writing and checksums; startup excluded.'}
    started = time.perf_counter()
    save_report(report_path, report)
    try:
        for sample in samples:
            record = render_sample(sample, preset, normalizer, output,
                                   settings.work_dir or output, settings.cancel_file)
            report['records'].append(record)
            print('CANVAS_RESULT ' + json.dumps(record), flush=True)
        report['batch_seconds'] = time.perf_counter() - started
        check_cancel(settings.cancel_file)
        if settings.verify:
            report['verification'] = compare_reference(Path(report['records'][0]['output']), preset['verification'])
            if not report['verification']['passed']:
                raise ValueError('A Light reproduction differs from the approved pixels; inspect render-report.json.')
        report['status'] = 'complete'
    except RenderCancelled as error:
        report['status'] = 'cancelled'
        report['error'] = str(error)
        raise
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = str(error)
        raise
    finally:
        save_report(report_path, report)


if __name__ == '__main__':
    main()
