import hashlib
from pathlib import Path
import bpy

def fabric_image(config):
    path = Path(config['photo_texture_path']).resolve()
    name = '111k canvas photograph ' + hashlib.sha256(str(path).encode()).hexdigest()[:12]
    existing = bpy.data.images.get(name)
    if existing:
        return existing
    image = bpy.data.images.load(str(path), check_existing=True)
    image.name = name
    image.colorspace_settings.name = 'Non-Color'
    return image

def create_material(image, config):
    opacity = min(1.0, max(0.0, float(config.get('texture_opacity', 0.35))))
    material = bpy.data.materials.new('Painted canvas fibers')
    material.use_nodes = True
    (nodes, links) = (material.node_tree.nodes, material.node_tree.links)
    nodes.clear()
    coordinates = nodes.new('ShaderNodeTexCoord')
    artwork = nodes.new('ShaderNodeTexImage')
    artwork.image = image
    artwork.interpolation = 'Linear'
    artwork.extension = 'EXTEND'
    links.new(coordinates.outputs['UV'], artwork.inputs['Vector'])
    scale = nodes.new('ShaderNodeVectorMath')
    scale.operation = 'MULTIPLY_ADD'
    factor = 1 / config.get('photo_scale', 1.0)
    scale.inputs[1].default_value = (factor, factor, 1)
    scale.inputs[2].default_value = ((1 - factor) / 2, (1 - factor) / 2, 0)
    links.new(coordinates.outputs['UV'], scale.inputs[0])
    weave = nodes.new('ShaderNodeTexImage')
    weave.image = fabric_image(config)
    weave.interpolation = 'Linear'
    weave.extension = 'EXTEND'
    links.new(scale.outputs['Vector'], weave.inputs['Vector'])
    channels = nodes.new('ShaderNodeSeparateColor')
    channels.mode = 'RGB'
    links.new(weave.outputs['Color'], channels.inputs['Color'])
    tone = nodes.new('ShaderNodeMath')
    tone.operation = 'MULTIPLY_ADD'
    contrast = config.get('weave_contrast', 0.38) * opacity
    tone.inputs[1].default_value = contrast
    tone.inputs[2].default_value = 1 - contrast * 0.5
    links.new(channels.outputs['Green'], tone.inputs[0])
    macro = nodes.new('ShaderNodeMath')
    macro.operation = 'MULTIPLY_ADD'
    macro_contrast = config.get('macro_contrast', 0.035) * opacity
    macro.inputs[1].default_value = macro_contrast
    macro.inputs[2].default_value = -macro_contrast * 0.5
    links.new(channels.outputs['Blue'], macro.inputs[0])
    combined = nodes.new('ShaderNodeMath')
    combined.operation = 'ADD'
    links.new(tone.outputs[0], combined.inputs[0])
    links.new(macro.outputs[0], combined.inputs[1])
    modulation = combined.outputs[0]
    edge_strength = config.get('edge_photo_strength', 0.6)
    if edge_strength:
        edge_source = config.get('photo_edge_path') or Path(config['photo_texture_path']).with_name('reference-edge.png')
        edge_path = Path(edge_source).resolve()
        edge_name = '111k canvas photographed edge ' + hashlib.sha256(str(edge_path).encode()).hexdigest()[:12]
        edge_image = bpy.data.images.get(edge_name)
        if edge_image is None:
            edge_image = bpy.data.images.load(str(edge_path), check_existing=True)
            edge_image.name = edge_name
            edge_image.colorspace_settings.name = 'Non-Color'
        surface_uv = nodes.new('ShaderNodeUVMap')
        surface_uv.uv_map = 'Canvas surface'
        edge = nodes.new('ShaderNodeTexImage')
        edge.image = edge_image
        edge.interpolation = 'Linear'
        edge.extension = 'EXTEND'
        links.new(surface_uv.outputs['UV'], edge.inputs['Vector'])
        edge_factor = nodes.new('ShaderNodeMath')
        edge_factor.operation = 'MULTIPLY_ADD'
        edge_factor.inputs[1].default_value = 1.5 * edge_strength
        edge_factor.inputs[2].default_value = 1 - edge_strength
        links.new(edge.outputs['Color'], edge_factor.inputs[0])
        edge_combined = nodes.new('ShaderNodeMath')
        edge_combined.operation = 'MULTIPLY'
        links.new(modulation, edge_combined.inputs[0])
        links.new(edge_factor.outputs[0], edge_combined.inputs[1])
        modulation = edge_combined.outputs[0]
    pigment = nodes.new('ShaderNodeMixRGB')
    pigment.blend_type = 'MULTIPLY'
    pigment.inputs[0].default_value = 1
    links.new(artwork.outputs['Color'], pigment.inputs[1])
    links.new(modulation, pigment.inputs[2])
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = config.get('bump_strength', 0.8)
    bump.inputs['Distance'].default_value = config.get('bump_distance', 0.0011) * opacity
    links.new(channels.outputs['Red'], bump.inputs['Height'])
    fabric = nodes.new('ShaderNodeBsdfPrincipled')
    fabric.inputs['Roughness'].default_value = config.get('roughness', 0.96)
    fabric.inputs['Specular IOR Level'].default_value = 0
    fabric.inputs['Sheen Weight'].default_value = 0
    links.new(pigment.outputs[0], fabric.inputs['Base Color'])
    links.new(bump.outputs['Normal'], fabric.inputs['Normal'])
    emission = nodes.new('ShaderNodeEmission')
    emission.inputs['Strength'].default_value = config.get('pigment_strength', 1)
    links.new(pigment.outputs[0], emission.inputs['Color'])
    mix = nodes.new('ShaderNodeMixShader')
    mix.inputs[0].default_value = config.get('diffuse_mix', 0.75)
    links.new(emission.outputs[0], mix.inputs[1])
    links.new(fabric.outputs[0], mix.inputs[2])
    output = nodes.new('ShaderNodeOutputMaterial')
    links.new(mix.outputs[0], output.inputs['Surface'])
    return material
