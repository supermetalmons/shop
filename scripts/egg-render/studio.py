import math

import bpy
import numpy as np
from mathutils import Vector


NATURAL = '01-natural-eggshell'
SATIN = '02-satin-ceramic'
LACQUER = '03-polished-lacquer'
PEARL = '04-pearl-glaze'

FINISHES = {
    NATURAL: (0.76, 1.43, 0.0, 0.45),
    SATIN: (0.38, 1.47, 0.28, 0.28),
    LACQUER: (0.34, 1.48, 0.92, 0.075),
    PEARL: (0.35, 1.48, 0.68, 0.22),
}

WHITE = (1.0, 1.0, 1.0)


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def material(name):
    item = bpy.data.materials.new(name)
    item.use_nodes = True
    return item


def contact_shadow():
    # The level orthographic camera sees a ground plane edge-on.
    width, height = 512, 128
    y, x = np.ogrid[-1:1:complex(height), -1:1:complex(width)]
    soft = 0.26 * np.exp(-(((x - 0.045) / 0.44) ** 2 + (y / 0.36) ** 2) * 2)
    contact = 0.53 * np.exp(-((x / 0.22) ** 2 + ((y - 0.02) / 0.16) ** 2) * 2)
    rgba = np.ones((height, width, 4), dtype=np.float32)
    rgba[:, :, :3] = (1 - soft - contact)[:, :, None]
    image = bpy.data.images.new('Contact falloff', width, height, float_buffer=True)
    image.colorspace_settings.name = 'Non-Color'
    image.pixels.foreach_set(rgba.ravel())
    image.update()
    bpy.ops.mesh.primitive_plane_add(size=2, location=(0, 1.4, -0.002),
                                     rotation=(math.pi / 2, 0, 0))
    card = bpy.context.object
    card.name = 'Contact shadow'
    card.scale = (1.18, 0.24, 1)
    card.visible_glossy = card.visible_diffuse = card.visible_shadow = False
    shader = material('White sweep with soft contact')
    nodes, links = shader.node_tree.nodes, shader.node_tree.links
    nodes.remove(nodes.get('Principled BSDF'))
    emission = nodes.new('ShaderNodeEmission')
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = image
    links.new(texture.outputs['Color'], emission.inputs['Color'])
    links.new(emission.outputs[0], nodes['Material Output'].inputs['Surface'])
    card.data.materials.append(shader)


def setup_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    preferences = bpy.context.preferences.addons['cycles'].preferences
    try:
        preferences.compute_device_type = 'METAL'
        preferences.refresh_devices()
        for device in preferences.devices:
            device.use = device.type == 'METAL'
        scene.cycles.device = 'GPU' if any(d.use for d in preferences.devices) else 'CPU'
    except TypeError:
        scene.cycles.device = 'CPU'
    scene.cycles.samples = 160
    scene.cycles.seed = 27
    scene.cycles.adaptive_threshold = 0.008
    scene.cycles.max_bounces = 3
    scene.cycles.use_denoising = False
    scene.render.resolution_x = scene.render.resolution_y = 1400
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.image_settings.color_depth = '8'
    scene.render.image_settings.compression = 35
    # Cycles can retain a previous egg's generated texture when persistent data is enabled.
    scene.render.use_persistent_data = False
    scene.render.dither_intensity = 0
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.world = bpy.data.worlds.new('Neutral studio')
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes['Background']
    background.inputs['Color'].default_value = (*WHITE, 1)
    background.inputs['Strength'].default_value = 0.24

    scene.use_nodes = True
    nodes, links = scene.node_tree.nodes, scene.node_tree.links
    nodes.clear()
    layers = nodes.new('CompositorNodeRLayers')
    over = nodes.new('CompositorNodeAlphaOver')
    over.inputs[1].default_value = (*WHITE, 1)
    links.new(layers.outputs['Image'], over.inputs[2])
    grade = nodes.new('CompositorNodeCurveRGB')
    grade.label = 'Deepen printed colors'
    for tone, adjusted in ((0.035, 0.022), (0.18, 0.157), (0.55, 0.55)):
        grade.mapping.curves[3].points.new(tone, adjusted)
    grade.mapping.update()
    links.new(over.outputs[0], grade.inputs['Image'])
    links.new(grade.outputs['Image'], nodes.new('CompositorNodeComposite').inputs[0])

    bpy.ops.object.camera_add(location=(0, -7, 1))
    camera = bpy.context.object
    aim(camera, (0, 0, 1))
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 2.5
    scene.camera = camera
    contact_shadow()
    return scene


def softbox(name, position, power, width, height, color=WHITE, glossy=True):
    light = bpy.data.lights.new(name, 'AREA')
    light.shape = 'RECTANGLE'
    light.size = width
    light.size_y = height
    light.energy = power
    light.color = color
    obj = bpy.data.objects.new(name, light)
    bpy.context.scene.collection.objects.link(obj)
    obj.visible_glossy = glossy
    obj.location = position
    aim(obj, (0, 0, 1))


def studio_lights(finish):
    for obj in list(bpy.context.scene.objects):
        if obj.type == 'LIGHT':
            light = obj.data
            bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.lights.remove(light)
    if finish == NATURAL:
        softbox('Window', (-3.2, -3, 4.7), 282, 3.2, 3.5)
        softbox('Bounce', (2.5, -3, 1.8), 65, 3, 3)
    elif finish == SATIN:
        softbox('Tall silk', (-3.0, -1.9, 3.5), 185, 1.65, 4.7)
        softbox('Right sweep', (3.2, -0.9, 2.8), 92, 2.4, 3.6)
        softbox('Fill', (0.2, -4, 4.5), 105, 4.5, 4.5)
    elif finish == LACQUER:
        softbox('Left strip', (-3.3, -0.35, 2.4), 92, 0.43, 3.9)
        softbox('Right strip', (3.3, 0.15, 2.1), 62, 0.30, 3.5)
        softbox('Overhead silk', (-1, -1.9, 5.7), 238, 4.0, 3.6, glossy=False)
        softbox('Fill', (0, -4, 1.9), 46, 5, 5, glossy=False)
    else:
        softbox('Cool sweep', (-2.5, -0.3, 2.5), 105, 1.3, 4.0, (0.63, 0.85, 1))
        softbox('Rose sweep', (2.6, 0.0, 2.0), 98, 1.2, 3.7, (1, 0.59, 0.72))
        softbox('Silk', (-0.9, -3.2, 4.3), 210, 3.8, 3.5, glossy=False)


def apply_finish(shell, image, finish_slug):
    roughness, ior, coat, coat_roughness = FINISHES[finish_slug]
    previous_materials = list(shell.data.materials)
    shell.data.materials.clear()
    for old in previous_materials:
        if old.users == 0:
            bpy.data.materials.remove(old)
    shader = material(finish_slug)
    nodes, links = shader.node_tree.nodes, shader.node_tree.links
    bsdf = nodes['Principled BSDF']
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = image
    texture.extension = 'EXTEND'
    links.new(texture.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['IOR'].default_value = ior
    bsdf.inputs['Coat Weight'].default_value = coat
    bsdf.inputs['Coat Roughness'].default_value = coat_roughness

    if finish_slug == NATURAL:
        pores = nodes.new('ShaderNodeTexNoise')
        pores.inputs['Scale'].default_value = 285
        pores.inputs['Detail'].default_value = 2.2
        bump = nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = 0.20
        bump.inputs['Distance'].default_value = 0.0013
        links.new(pores.outputs['Fac'], bump.inputs['Height'])
        links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    elif finish_slug == PEARL:
        bsdf.inputs['Metallic'].default_value = 0.22
        bsdf.inputs['Thin Film Thickness'].default_value = 420
        bsdf.inputs['Thin Film IOR'].default_value = 1.46
    shell.data.materials.append(shader)
    studio_lights(finish_slug)
