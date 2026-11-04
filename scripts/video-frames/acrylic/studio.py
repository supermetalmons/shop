import argparse
import json
import math
import struct
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

@dataclass(frozen=True)
class Setup:
    width: float = 2.35
    height: float = 1.52
    depth: float = .112
    radius: float = .035
    cut: float = .010
    roughness: float = .046
    grazing: float = .62
    body_light: float = 5.4
    bezel: float = .078
    inset_radius: float = .050
    cap: float = .042
    crown: float = .009
    brush: float = .24
    key: tuple = (-3.2, -3.2, 3.4)
    silk: tuple = (3.3, 3.8)
    color: tuple = (.94, .97, 1)
    bounce: float = .84
    strip: float = .8


SETUPS = {
    '08-soft-clear': Setup(),
    '15-high-key': Setup(width=2.33, height=1.50, depth=.087, radius=.053, cut=.006,
                         roughness=.036, grazing=.74, body_light=7.05, bezel=.082, inset_radius=.037,
                         cap=.039, crown=.006, brush=.21, key=(-.8, -2.4, 3.1), silk=(4.6, 4.2),
                         color=(1, 1, 1), bounce=1.16, strip=2.2),
}
SIZE = 1440
SCREEN_WIDTH = 1.87
SCREEN_HEIGHT = SCREEN_WIDTH * 9 / 16
SCREEN_DEPTH = -.002
SCREEN_RADIUS = .004
IOR = 1.49


def rounded_rect(width, height, radius, depth):
    vertices = []
    for sx, sz, start in ((1, 1, 90), (1, -1, 0), (-1, -1, -90), (-1, 1, -180)):
        for step in range(7):
            angle = math.radians(start - step * 15)
            x = sx * (width / 2 - radius) + radius * math.cos(angle)
            z = sz * (height / 2 - radius) + radius * math.sin(angle)
            vertices.append((x, depth, z))
    return vertices


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


def surface(name, color, roughness, metal=0, transmit=0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metal
    shader.inputs['Transmission Weight'].default_value = transmit
    shader.inputs['IOR'].default_value = IOR
    return material


def slab(name, width, height, radius, front, back, bevel, material, parent, center):
    loops = [rounded_rect(width, height, radius, y) for y in (front, back)]
    count = len(loops[0])
    sides = [(i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count)]
    faces = [tuple(reversed(range(count))), tuple(range(count, 2 * count)), *sides]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(loops[0] + loops[1], [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    obj.location.z = center
    obj.data.materials.append(material)
    for poly in mesh.polygons:
        poly.use_smooth = True
    edge = obj.modifiers.new('Polished edge break', 'BEVEL')
    edge.width = bevel
    edge.segments = 6
    edge.harden_normals = True
    obj.modifiers.new('Face normals', 'WEIGHTED_NORMAL')
    return obj


def turned_part(name, x, z, profile, material, parent):
    segments = 96
    rings = []
    for radius, depth in profile:
        rings.extend((x + radius * math.cos(angle * math.tau / segments), depth,
                      z + radius * math.sin(angle * math.tau / segments))
                     for angle in range(segments))
    faces = []
    for ring in range(len(profile) - 1):
        start = ring * segments
        for angle in range(segments):
            i, j = start + angle, start + (angle + 1) % segments
            faces.append((i, i + segments, j + segments, j))
    faces.extend([tuple(range(segments)), tuple(reversed(range(len(rings) - segments, len(rings))))])
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(rings, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    mesh.materials.append(material)
    for face in mesh.polygons:
        face.use_smooth = True
    return obj


def optical_block(setup, root, center, pmma, edge):
    front, back = -setup.depth * .52, setup.depth * .48
    rings = [(setup.cut, front), (0, front + setup.cut * .92), (0, back)]
    loops = [rounded_rect(setup.width - 2 * inset, setup.height - 2 * inset,
                          max(.002, setup.radius - inset), y) for inset, y in rings]
    n = len(loops[0])
    faces = [tuple(reversed(range(n)))]
    for k in range(len(loops) - 1):
        for i in range(n):
            j = (i + 1) % n
            faces.append((k * n + i, k * n + j, (k + 1) * n + j, (k + 1) * n + i))
    faces.append(tuple(range((len(loops) - 1) * n, len(loops) * n)))
    mesh = bpy.data.meshes.new('One-piece optical PMMA body')
    mesh.from_pydata([p for loop in loops for p in loop], [], faces)
    mesh.update()
    body = bpy.data.objects.new('Solid clear acrylic block', mesh)
    bpy.context.collection.objects.link(body)
    body.parent = root
    body.location.z = center
    mesh.materials.append(pmma)
    mesh.materials.append(edge)
    for face in list(mesh.polygons)[1:-1]:
        face.material_index = 1


def acrylic_frame(setup):
    center = setup.height / 2
    root = bpy.data.objects.new('Acrylic video frame', None)
    bpy.context.collection.objects.link(root)
    pmma = surface('Optically clear PMMA', (.998, .999, 1), .020, transmit=1)
    edge = surface('Optical edge finish', (.49, .55, .59), setup.roughness, transmit=1)
    for material in (pmma, edge):
        absorption = material.node_tree.nodes.new('ShaderNodeVolumeAbsorption')
        absorption.inputs['Color'].default_value = (.56, .61, .64, 1)
        absorption.inputs['Density'].default_value = .42
        material.node_tree.links.new(absorption.outputs['Volume'], material.node_tree.nodes['Material Output'].inputs['Volume'])
    optical_block(setup, root, center, pmma, edge)
    white = surface('Opaque satin white inset', (.94, .94, .93), .34)
    gasket = surface('Glass opening edge', (.13, .14, .145), .28)
    slab('Moulded white mat', SCREEN_WIDTH + 2 * setup.bezel, SCREEN_HEIGHT + 2 * setup.bezel,
         setup.inset_radius, 0, .022, .005, white, root, center)
    slab('Screen glass edge', SCREEN_WIDTH + .004, SCREEN_HEIGHT + .004, SCREEN_RADIUS + .002,
         SCREEN_DEPTH, .001, .0012, gasket, root, center)
    silver = surface('Turned silver buttons', (.52, .54, .56), setup.brush, metal=1)
    shader = silver.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Anisotropic'].default_value = .67
    tangent = silver.node_tree.nodes.new('ShaderNodeTangent')
    tangent.direction_type = 'RADIAL'
    tangent.axis = 'Y'
    silver.node_tree.links.new(tangent.outputs['Tangent'], shader.inputs['Tangent'])
    barrel = surface('Polished silver barrel', (.45, .47, .49), .17, metal=1)
    front, back = -setup.depth * .52, setup.depth * .48
    radius = setup.cap
    button = [(.001 * radius, front - .009 - setup.crown), (.50 * radius, front - .009 - .85 * setup.crown),
              (.77 * radius, front - .009 - .56 * setup.crown), (.94 * radius, front - .009),
              (radius, front - .007), (radius, front - .001), (.96 * radius, front)]
    inset = .090
    for x in (-setup.width / 2 + inset, setup.width / 2 - inset):
        for z in (inset, setup.height - inset):
            turned_part('Silver sleeve', x, z, [(.68 * radius, front - .002), (.73 * radius, front),
                        (.73 * radius, back), (.68 * radius, back + .004)], barrel, root)
            turned_part('Brushed button cap', x, z, button, silver, root)
            turned_part('Rear fixing', x, z, [(.87 * radius, back), (.87 * radius, back + .005),
                        (.82 * radius, back + .008)], barrel, root)
    bpy.context.view_layer.update()
    return root, center


def area(name, pos, aim, energy, size, color=(1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.shape = 'RECTANGLE'
    data.energy = energy
    data.size, data.size_y = size
    data.color = color
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = pos
    obj.rotation_euler = (Vector(aim) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def flag(name, pos, aim, size, black):
    bpy.ops.mesh.primitive_plane_add(size=1, location=pos)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = (*size, 0)
    obj.rotation_euler = (Vector(aim) - obj.location).to_track_quat('Z', 'Y').to_euler()
    obj.data.materials.append(black)
    obj.visible_camera = obj.visible_diffuse = obj.visible_shadow = obj.visible_transmission = False


def studio_field(scene, setup):
    world = bpy.data.worlds.new('Shadowless white studio')
    scene.world = world
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    ambient = nodes['Background']
    ambient.inputs['Color'].default_value = (.91, .95, 1, 1)
    ambient.inputs['Strength'].default_value = setup.bounce
    transmitted = nodes.new('ShaderNodeBackground')
    transmitted.inputs['Color'].default_value = (1, 1, 1, 1)
    transmitted.inputs['Strength'].default_value = setup.body_light
    field = nodes.new('ShaderNodeBackground')
    field.inputs['Color'].default_value = (1, 1, 1, 1)
    field.inputs['Strength'].default_value = 9
    ray = nodes.new('ShaderNodeLightPath')
    direction = nodes.new('ShaderNodeSeparateXYZ')
    links.new(nodes.new('ShaderNodeTexCoord').outputs['Generated'], direction.inputs[0])
    absolute = nodes.new('ShaderNodeMath')
    absolute.operation = 'ABSOLUTE'
    links.new(direction.outputs['Y'], absolute.inputs[0])
    # A straight ray sees the backdrop through the acrylic. The cut edge redirects it into the studio.
    angle = nodes.new('ShaderNodeMapRange')
    angle.interpolation_type = 'SMOOTHERSTEP'
    angle.inputs['From Min'].default_value = .977
    angle.inputs['From Max'].default_value = .998
    angle.inputs['To Min'].default_value = setup.grazing
    links.new(absolute.outputs[0], angle.inputs['Value'])
    mix = nodes.new('ShaderNodeMath')
    mix.operation = 'MULTIPLY'
    links.new(angle.outputs['Result'], mix.inputs[0])
    links.new(ray.outputs['Is Transmission Ray'], mix.inputs[1])
    optic = nodes.new('ShaderNodeMixShader')
    links.new(mix.outputs[0], optic.inputs[0])
    links.new(ambient.outputs[0], optic.inputs[1])
    links.new(transmitted.outputs[0], optic.inputs[2])
    exposure = nodes.new('ShaderNodeMixShader')
    links.new(ray.outputs['Is Camera Ray'], exposure.inputs[0])
    links.new(optic.outputs[0], exposure.inputs[1])
    links.new(field.outputs[0], exposure.inputs[2])
    links.new(exposure.outputs[0], nodes['World Output'].inputs['Surface'])


def studio(setup):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    preferences = bpy.context.preferences.addons['cycles'].preferences
    try:
        preferences.compute_device_type = 'METAL'
        preferences.refresh_devices()
        for device in preferences.devices:
            device.use = device.type == 'METAL'
        if any(d.use for d in preferences.devices):
            scene.cycles.device = 'GPU'
    except TypeError:
        pass
    scene.cycles.samples = 96
    scene.cycles.adaptive_threshold = .012
    scene.cycles.max_bounces = 16
    scene.cycles.transmission_bounces = 14
    scene.cycles.glossy_bounces = 7
    scene.cycles.use_denoising = True
    scene.cycles.seed = 29
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.resolution_percentage = 100
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.dither_intensity = 0
    scene.display_settings.display_device = 'sRGB'
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
    studio_field(scene, setup)
    aim = (0, 0, setup.height / 2)
    area('Silk key', setup.key, aim, 630, setup.silk, setup.color)
    area('Overhead strip', (-.2, .5, 3.4), aim, 230, (3.0, setup.strip))
    area('Vertical strip', (-2.1, -.8, 1.2), aim, 145, (setup.strip, 2.6), setup.color)
    area('Portrait fill', (.9, -3.6, 2.3), aim, 125, (2.1, 2.8))
    black = surface('Studio negative fill', (.008, .009, .01), .89)
    flag('Near left blade', (-2.25, -.8, 1.3), aim, (1.25, 3.3), black)
    flag('Near right blade', (2.4, -.5, 1.2), aim, (.8, 2.9), black)
    flag('Low bounce cut', (-.4, -2.4, .47), aim, (4.8, 1.2), black)
    flag('Vertical metal accent', (1.3, -2.7, 1.25), aim, (.72, 3.5), black)
    return scene


def set_camera(scene, half, setup):
    bpy.ops.object.camera_add(location=(0, -8, half))
    cam = bpy.context.object
    cam.rotation_euler = (math.pi / 2, 0, 0)
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = setup.width / .89
    scene.camera = cam
    bpy.context.view_layer.update()


def camera_pixel(scene, world):
    uv = world_to_camera_view(scene, scene.camera, world)
    return [SIZE * uv.x, SIZE * (1 - uv.y)]


def screen_projection(scene, root, half):
    def project(point):
        world = root.matrix_world @ (Vector(point) + Vector((0, 0, half)))
        return camera_pixel(scene, world)

    corners = [project((x * SCREEN_WIDTH / 2, SCREEN_DEPTH, z * SCREEN_HEIGHT / 2))
               for x, z in ((-1, 1), (1, 1), (1, -1), (-1, -1))]
    outline = [project(p) for p in rounded_rect(SCREEN_WIDTH, SCREEN_HEIGHT, SCREEN_RADIUS, SCREEN_DEPTH)]
    return corners, outline


def save_blend(path, scene, root):
    scene.render.filepath = '//plate.png'
    for obj in scene.objects:
        if obj.type != 'MESH':
            continue
        if not obj.visible_camera:
            obj.display_type = 'WIRE'
            obj.color = (0, 0, 0, 0)
            obj.show_transparent = True
        elif obj.active_material:
            shader = obj.active_material.node_tree.nodes.get('Principled BSDF')
            color = shader.inputs['Base Color'].default_value
            opacity = .10 if shader.inputs['Transmission Weight'].default_value else 1
            obj.color = (*color[:3], opacity)
            obj.show_transparent = opacity < 1
    bpy.ops.object.select_all(action='DESELECT')
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    for area in bpy.context.screen.areas:
        if area.type == 'VIEW_3D':
            view = area.spaces.active
            view.region_3d.view_perspective = 'CAMERA'
            view.region_3d.view_camera_zoom = 4
            view.shading.type = 'SOLID'
            view.shading.color_type = 'OBJECT'
            view.overlay.show_overlays = False
    if 'FINISHED' not in bpy.ops.wm.save_as_mainfile(filepath=str(path), relative_remap=False, compress=True):
        raise RuntimeError(f'Failed to save {path}')


def render(directory, slug, *, include_model=False):
    setup = SETUPS[slug]
    scene = studio(setup)
    root, half = acrylic_frame(setup)
    set_camera(scene, half, setup)
    corners, outline = screen_projection(scene, root, half)
    directory.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(directory / 'plate.png')
    if 'FINISHED' not in bpy.ops.render.render(write_still=True):
        raise RuntimeError(f'Failed to render {slug}')
    write_screen_mask(directory / 'mask-0.png', outline)
    (directory / 'screens.json').write_text(json.dumps([corners], indent=2) + '\n')
    body = scene.objects['Solid clear acrylic block']
    xs, ys = zip(*(camera_pixel(scene, body.matrix_world @ vertex.co) for vertex in body.data.vertices))
    bounds = [round(value, 1) for value in (min(xs), min(ys), max(xs), max(ys))]
    (directory / 'outline.json').write_text(json.dumps(bounds, indent=2) + '\n')
    if include_model:
        save_blend(directory / 'frame.blend', scene, root)
    print(f'Finished {slug}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--variant', choices=SETUPS)
    parser.add_argument('--save-blend', action='store_true', help='also save the editable frame scene')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    for slug in ([args.variant] if args.variant else SETUPS):
        render(args.directory.resolve() / slug, slug, include_model=args.save_blend)
