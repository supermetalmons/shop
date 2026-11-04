import sys
from pathlib import Path

import bpy


def ebonized_wood():
    wood = bpy.data.materials.new('Ebonized ash')
    wood.use_nodes = True
    nodes, links = wood.node_tree.nodes, wood.node_tree.links
    surface = nodes['Principled BSDF']
    surface.inputs['Roughness'].default_value = 0.47
    surface.inputs['Coat Weight'].default_value = 0.08
    uv = nodes.new('ShaderNodeTexCoord').outputs['UV']
    stretch = nodes.new('ShaderNodeVectorMath')
    stretch.operation = 'MULTIPLY'
    stretch.inputs[1].default_value = (10, 207, 1)
    links.new(uv, stretch.inputs[0])
    fibers = nodes.new('ShaderNodeTexNoise')
    fibers.inputs['Scale'].default_value = 1
    fibers.inputs['Detail'].default_value = 2.5
    fibers.inputs['Distortion'].default_value = 0.42
    links.new(stretch.outputs['Vector'], fibers.inputs['Vector'])
    ramp = nodes.new('ShaderNodeValToRGB')
    palette = ramp.color_ramp.elements
    palette[0].position, palette[0].color = 0.26, (0.012, 0.011, 0.010, 1)
    palette[1].position, palette[1].color = 0.76, (0.065, 0.061, 0.055, 1)
    palette.new(0.44).color = (0.033, 0.031, 0.029, 1)
    links.new(fibers.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], surface.inputs['Base Color'])
    pores = nodes.new('ShaderNodeBump')
    pores.inputs['Strength'].default_value = 0.21
    pores.inputs['Distance'].default_value = 0.0007
    links.new(fibers.outputs['Fac'], pores.inputs['Height'])
    links.new(pores.outputs['Normal'], surface.inputs['Normal'])
    return wood


def frame(location, lip, width, height):
    border = height * 0.043
    sections = [
        (border - 0.002, 0.096), (border, 0.093), (border, 0.0025),
        (border - 0.0025, 0), (0.005, 0), (0.003, 0.002),
        (0.003, 0.007), (0, 0.008),
    ]
    vertices, polygons = [], []
    for outset, depth in sections:
        start = len(vertices)
        vertices.extend((x * (width / 2 + outset), depth, z * (height / 2 + outset))
                        for x, z in ((-1, 1), (1, 1), (1, -1), (-1, -1)))
        if start:
            for side in range(4):
                end = (side + 1) % 4
                polygons.append((start - 4 + side, start + side, start + end, start - 4 + end))
    polygons.extend([(0, 1, 2, 3), (start + 3, start + 2, start + 1, start)])
    mesh = bpy.data.meshes.new('Mitered wooden bezel')
    mesh.from_pydata(vertices, [], polygons)
    mesh.materials.append(ebonized_wood())
    mesh.materials.append(lip)
    uvs = mesh.uv_layers.new(name='Rail grain')
    for face in mesh.polygons:
        if face.index >= 24:
            face.material_index = 1
            continue
        rail = face.index % 4
        for i in face.loop_indices:
            x, y, z = vertices[mesh.loops[i].vertex_index]
            length, cross = (x, z) if rail % 2 == 0 else (z, x)
            uvs.data[i].uv = (length + rail * 0.5, cross + y)
    obj = bpy.data.objects.new('Thin ash frame', mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    return obj, vertices[-4:]


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from studio import render_variant

    output, = sys.argv[sys.argv.index("--") + 1:]
    render_variant(Path(output).resolve(), "02-front", 1.5, frame_builder=frame)
