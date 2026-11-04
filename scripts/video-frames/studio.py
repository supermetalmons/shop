import json
import math
import struct
import sys
import zlib
from pathlib import Path

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector


SIZE = 1440
ASPECT = 16 / 9
CAMERA_ANGLES = {'01-wide-border': (15, 8), '02-front': (0, 0)}


def bamboo_material():
    material = bpy.data.materials.new('Oiled laminated bamboo')
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    surface = nodes['Principled BSDF']
    surface.inputs['Roughness'].default_value = 0.38
    surface.inputs['Coat Weight'].default_value = 0.14
    surface.inputs['Coat Roughness'].default_value = 0.34
    coords = nodes.new('ShaderNodeTexCoord').outputs['Object']

    def math_node(operation, first, second=None):
        node = nodes.new('ShaderNodeMath')
        node.operation = operation
        links.new(first, node.inputs[0])
        if isinstance(second, (int, float)):
            node.inputs[1].default_value = second
        elif second is not None:
            links.new(second, node.inputs[1])
        return node.outputs[0]

    def scaled_coords(frequencies):
        scaling = nodes.new('ShaderNodeVectorMath')
        scaling.operation = 'MULTIPLY'
        links.new(coords, scaling.inputs[0])
        scaling.inputs[1].default_value = frequencies
        return scaling.outputs['Vector']

    def grain(frequencies):
        grain_node = nodes.new('ShaderNodeTexNoise')
        grain_node.inputs['Scale'].default_value = 1
        grain_node.inputs['Detail'].default_value = 2
        grain_node.inputs['Distortion'].default_value = 0.18
        links.new(scaled_coords(frequencies), grain_node.inputs['Vector'])
        return grain_node.outputs['Fac']

    xyz = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coords, xyz.inputs[0])
    lamina = math_node('FLOOR', math_node('MULTIPLY', xyz.outputs['X'], 9.2))
    variation = nodes.new('ShaderNodeTexWhiteNoise')
    variation.noise_dimensions = '1D'
    links.new(lamina, variation.inputs['W'])
    streaks = grain((59, 76, 3.8))
    fibers = grain((240, 250, 11))
    pores = nodes.new('ShaderNodeTexVoronoi')
    pores.inputs['Scale'].default_value = 1
    links.new(scaled_coords((191, 212, 14)), pores.inputs['Vector'])
    vessels = nodes.new('ShaderNodeMapRange')
    vessels.interpolation_type = 'SMOOTHERSTEP'
    vessels.inputs['From Min'].default_value = 0.13
    vessels.inputs['From Max'].default_value = 0.44
    vessels.inputs['To Min'].default_value = 0.10
    vessels.inputs['To Max'].default_value = 0
    links.new(pores.outputs['Distance'], vessels.inputs['Value'])
    tint = math_node('ADD', math_node('MULTIPLY', variation.outputs['Value'], 0.23),
                     math_node('MULTIPLY', streaks, 0.42))
    tint = math_node('ADD', tint, math_node('MULTIPLY', fibers, 0.35))
    tint = math_node('SUBTRACT', tint, vessels.outputs['Result'])
    ramp = nodes.new('ShaderNodeValToRGB')
    palette = ramp.color_ramp.elements
    palette[0].position, palette[0].color = 0.22, (0.242, 0.105, 0.026, 1)
    palette[1].position, palette[1].color = 0.79, (0.88, 0.64, 0.34, 1)
    palette.new(0.52).color = (0.585, 0.350, 0.122, 1)
    links.new(tint, ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], surface.inputs['Base Color'])
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.12
    bump.inputs['Distance'].default_value = 0.0007
    links.new(fibers, bump.inputs['Height'])
    links.new(bump.outputs[0], surface.inputs['Normal'])
    return material


def rounded_rect(width, height, radius, depth):
    vertices = []
    for sx, sz, start in ((1, 1, 90), (1, -1, 0), (-1, -1, -90), (-1, 1, -180)):
        for step in range(7):
            angle = math.radians(start - step * 15)
            x = sx * (width / 2 - radius) + radius * math.cos(angle)
            z = sz * (height / 2 - radius) + radius * math.sin(angle)
            vertices.append((x, depth, z))
    return vertices


def display_size(aspect):
    # The original 16:9 display is one unit high. Keep its long edge for every orientation.
    return ASPECT * min(aspect, 1), ASPECT / max(aspect, 1)


def frame(location, slug, wood, lip, aspect=ASPECT):
    front_w, front_h = display_size(aspect)
    outer = (front_w + 0.2, front_h + 0.2)
    scale = 1.2 / 1.36 if slug == '01-wide-border' else 1
    screen_w, screen_h = front_w * scale, front_h * scale
    screen = (screen_w, screen_h)
    recess = 0.011
    profiles = [
        (outer, -0.012, 0.010, 0.154),
        (outer, -0.003, 0.016, 0.151),
        (outer, 0, 0.018, 0.147),
        (outer, 0, 0.018, 0.008),
        (outer, -0.003, 0.016, 0.003),
        (outer, -0.012, 0.011, 0),
        (screen, 0.030, 0.018, 0),
        (screen, 0.022, 0.014, 0.002),
        (screen, 0.016, 0.011, recess - 0.005),
        (screen, 0.016, 0.011, recess - 0.001),
        (screen, 0.000, 0.005, recess),
    ]
    vertices, polygons = [], []
    for dimensions, offset, radius, depth in profiles:
        loop = rounded_rect(dimensions[0] + offset, dimensions[1] + offset, radius, depth)
        index, n = len(vertices), len(loop)
        vertices.extend(loop)
        if index:
            for i in range(n):
                j = (i + 1) % n
                polygons.append((index - n + i, index + i, index + j, index - n + j))
    polygons.extend([tuple(range(n)), tuple(reversed(range(len(vertices) - n, len(vertices))))])
    mesh = bpy.data.meshes.new('Machined bamboo enclosure')
    mesh.from_pydata(vertices, [], polygons)
    mesh.materials.append(wood)
    mesh.materials.append(lip)
    for polygon in list(mesh.polygons)[9*n:10*n]:
        polygon.material_index = 1
    mesh.polygons[-1].material_index = 1
    obj = bpy.data.objects.new('Video print', mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    screen_points = [(x * screen_w / 2, recess, z * screen_h / 2)
                     for x, z in ((-1, 1), (1, 1), (1, -1), (-1, -1))]
    return obj, screen_points


def softbox(name, position, watts, width, height):
    light = bpy.data.lights.new(name, 'AREA')
    light.shape = 'RECTANGLE'
    light.energy, light.size, light.size_y = watts, width, height
    obj = bpy.data.objects.new(name, light)
    bpy.context.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (-Vector(position)).to_track_quat('-Z', 'Y').to_euler()


def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    try:
        prefs.compute_device_type = 'METAL'
        prefs.refresh_devices()
        for device in prefs.devices:
            device.use = device.type == 'METAL'
        scene.cycles.device = 'GPU' if any(d.use for d in prefs.devices) else 'CPU'
    except TypeError:
        scene.cycles.device = 'CPU'
    scene.cycles.samples = 64
    scene.cycles.max_bounces = 3
    scene.cycles.adaptive_threshold = 0.018
    scene.cycles.seed = 41
    scene.cycles.use_denoising = False
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.resolution_percentage = 100
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.dither_intensity = 0
    scene.render.film_transparent = True
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.world = bpy.data.worlds.new('Studio bounce')
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes['Background']
    background.inputs['Color'].default_value = (1, 1, 1, 1)
    background.inputs['Strength'].default_value = 0.48
    softbox('Upper left silk', (-2.6, -3.1, 4.8), 260, 3.3, 2.6)
    softbox('Front fill', (3.4, -3.5, 1.0), 68, 3.4, 3.4)
    softbox('Top strip', (0.9, 0.4, 3.2), 65, 2.8, 1.2)
    return scene


def projected(scene, point):
    uv = world_to_camera_view(scene, scene.camera, point)
    return [uv.x * SIZE, (1 - uv.y) * SIZE]


def shadow_sweep(scene, obj):
    # A level front camera sees a real floor edge-on. Paint its soft penumbra into the sweep.
    y, x = np.ogrid[:SIZE, :SIZE]
    half_width = round(max(v.co.x for v in obj.data.vertices), 2)
    half_height = max(v.co.z for v in obj.data.vertices)
    base = [projected(scene, obj.matrix_world @ Vector((i, 0.06, -half_height)))
            for i in (-half_width, half_width)]
    (lx, ly), (rx, ry) = base
    span = rx - lx
    cx, cy = (lx + rx) / 2, (ly + ry) / 2
    dx = (x - cx) / span
    dy = (y - cy - span * 0.052 - (ry - ly) * dx * 0.6) / span
    transmission = 1 - (0.17 * np.exp(-((dx / 0.36) ** 2 + (dy / 0.023) ** 2)) +
                        0.09 * np.exp(-((dx / 0.48) ** 2 + (dy / 0.047) ** 2)))
    pixels = np.ones((SIZE, SIZE, 4), dtype=np.float32)
    pixels[:, :, :3] = transmission[::-1, :, None]
    image = bpy.data.images.new('Floating shadow sweep', SIZE, SIZE, float_buffer=True)
    image.colorspace_settings.name = 'Non-Color'
    image.pixels.foreach_set(pixels.ravel())
    image.update()
    scene.use_nodes = True
    nodes, links = scene.node_tree.nodes, scene.node_tree.links
    nodes.clear()
    sweep = nodes.new('CompositorNodeImage')
    sweep.image = image
    layers = nodes.new('CompositorNodeRLayers')
    over = nodes.new('CompositorNodeAlphaOver')
    links.new(sweep.outputs['Image'], over.inputs[1])
    links.new(layers.outputs['Image'], over.inputs[2])
    links.new(over.outputs[0], nodes.new('CompositorNodeComposite').inputs[0])


def write_screen_mask(path, outline):
    x = np.arange(SIZE)[None, :] + 0.5
    y = np.arange(SIZE)[:, None] + 0.5
    distance = np.full((SIZE, SIZE), np.inf)
    for (ax, ay), (bx, by) in zip(outline, outline[1:] + outline[:1]):
        dx, dy = bx - ax, by - ay
        edge_distance = (dx * (y - ay) - dy * (x - ax)) / math.hypot(dx, dy)
        np.minimum(distance, edge_distance, out=distance)
    mask = np.rint(np.clip(distance + 0.5, 0, 1) * 255).astype('uint8')

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data)))

    rows = b''.join(b'\x00' + row.tobytes() for row in mask)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' +
                     chunk(b'IHDR', struct.pack('>2I5B', SIZE, SIZE, 8, 0, 0, 0, 0)) +
                     chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def render_variant(path, slug, aspect=ASPECT, frame_builder=None):
    scene = setup_scene()
    lip = bpy.data.materials.new('Graphite display gasket')
    lip.diffuse_color = (0.012, 0.014, 0.016, 1)
    yaw, elevation = map(math.radians, CAMERA_ANGLES[slug])
    eye = Vector((-math.sin(yaw) * math.cos(elevation),
                  -math.cos(yaw) * math.cos(elevation), math.sin(elevation)))
    bpy.ops.object.camera_add(location=eye * 7)
    camera = bpy.context.object
    camera.rotation_euler = (-eye).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 2.48 * math.cos(yaw)
    scene.camera = camera
    basis = camera.rotation_euler.to_quaternion()
    location = (basis @ Vector((0, 1, 0))) * 0.03
    if frame_builder is None:
        obj, screen_points = frame(location, slug, bamboo_material(), lip, aspect)
    else:
        obj, screen_points = frame_builder(location, lip, *display_size(aspect))
    bpy.context.view_layer.update()
    shadow_sweep(scene, obj)
    path.mkdir(exist_ok=True, parents=True)
    scene.render.filepath = str(path / 'plate.png')
    if 'FINISHED' not in bpy.ops.render.render(write_still=True):
        raise RuntimeError(f'Failed to render {slug}')
    def project(point):
        return projected(scene, obj.matrix_world @ Vector(point))
    corners = [[project(point) for point in screen_points]]
    w, depth, h = screen_points[1]
    contour = rounded_rect(w * 2, h * 2, 0.005, depth)
    write_screen_mask(path / 'mask-0.png', [project(point) for point in contour])
    (path / 'screens.json').write_text(json.dumps(corners, indent=2) + '\n')
    print(f'Finished {slug}', flush=True)


if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    output, *options = sys.argv[sys.argv.index('--') + 1:]
    aspect = ASPECT
    if options:
        ratio, = options
        width, height = map(int, ratio.split(':'))
        if min(width, height) <= 0:
            raise ValueError('Display aspect dimensions must be positive')
        aspect = width / height
    for variant in CAMERA_ANGLES:
        render_variant(Path(output).resolve() / variant, variant, aspect)
