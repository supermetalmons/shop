import math
import bpy

def _axis_samples(half, radius, segments):
    inner = half - radius
    if half <= radius * 4:
        values = [-inner + 2 * inner * i / segments for i in range(segments + 1)]
    else:
        shoulder = half - radius * 4
        values = [-shoulder + 2 * shoulder * i / segments for i in range(segments + 1)]
        for i in range(1, 21):
            distance = shoulder + radius * 3 * i / 20
            values.extend([-distance, distance])
    for i in range(1, 15):
        distance = inner + radius * math.tan(math.pi / 4 * i / 14)
        values.extend([-distance, distance])
    return sorted(set((round(value, 12) for value in values)))

def _mesh_object(name, vertices, faces, uvs):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    uv_layer = mesh.uv_layers.new(name='Continuous artwork wrap')
    for polygon in mesh.polygons:
        polygon.use_smooth = True
        for loop in polygon.loop_indices:
            uv_layer.data[loop].uv = uvs[mesh.loops[loop].vertex_index]
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj

def _canvas_surface_uv(obj, width, height):
    mesh = obj.data
    uv_layer = mesh.uv_layers.new(name='Canvas surface')
    for polygon in mesh.polygons:
        for loop in polygon.loop_indices:
            point = mesh.vertices[mesh.loops[loop].vertex_index].co
            uv_layer.data[loop].uv = (0.5 + point.x / width, 0.5 + point.y / height)
    mesh.uv_layers.active_index = 0
    mesh.uv_layers[0].active_render = True

def create_canvas(width, height, config):
    depth = float(config.get('depth', 0.06))
    radius = min(float(config.get('roll_radius', 0.028)), depth * 0.48, width * 0.1, height * 0.1)
    crown = float(config.get('face_crown', 0.002))
    fold = float(config.get('corner_fold', 0.003))
    tension = float(config.get('edge_tension', 0.0015))
    irregularity = float(config.get('edge_irregularity', 0.001))
    wrap = float(config.get('wrap_fraction', 0.012))
    squareness = max(2, float(config.get('corner_squareness', 5)))
    flap_strength = float(config.get('corner_overlap', 0.65))
    halves = [width / 2, height / 2, depth / 2]
    face_segments = 56
    axes = [_axis_samples(halves[axis], radius, face_segments if axis < 2 else 8) for axis in range(3)]

    def surface(coordinates):
        roll = radius
        inner = [max(-halves[axis] + roll, min(halves[axis] - roll, coordinates[axis])) for axis in range(3)]
        delta = [coordinates[axis] - inner[axis] for axis in range(3)]
        planar = (abs(delta[0]) ** squareness + abs(delta[1]) ** squareness) ** (1 / squareness)
        length = math.hypot(planar, delta[2])
        normal = [component / length for component in delta]
        point = [inner[axis] + normal[axis] * roll for axis in range(3)]
        (x, y, z) = point
        face = max(normal[2], 0)
        (dx, dy) = (halves[0] - abs(x), halves[1] - abs(y))
        center = max(0, 1 - (x / halves[0]) ** 2) * max(0, 1 - (y / halves[1]) ** 2)
        point[2] += crown * center ** 2 * face
        edge_x = math.exp(-((dx - radius * 1.12) / (radius * 0.72)) ** 2)
        edge_y = math.exp(-((dy - radius * 1.12) / (radius * 0.72)) ** 2)
        raised = 1 - (1 - edge_x) * (1 - edge_y)
        inset = math.exp(-((min(dx, dy) - radius * 2.65) / (radius * 1.0)) ** 2)
        displacement = tension * (raised - 0.24 * inset) * face ** 1.5
        pull = 0.46 * math.sin(x * 23 + y * 31) + 0.27 * math.sin(x * 59 - y * 43) + 0.16 * math.sin(y * 91)
        displacement += irregularity * pull * math.exp(-(min(dx, dy) / (radius * 2.8)) ** 2) * face
        if fold:
            phase = (1.1 if x > 0 else 2.8) + (0.7 if y > 0 else 2.1)
            asymmetry = 0.72 + 0.28 * math.sin(phase)
            slope = 0.82 + 0.26 * math.sin(phase * 1.7)
            diagonal = (dx - dy * slope) / (radius * 0.19)
            corner = math.exp(-((dx + dy - radius * 1.18) / (radius * 2.25)) ** 2)
            ridge = math.exp(-diagonal ** 2) - 0.44 * math.exp(-((diagonal - 1.55) / 0.95) ** 2)
            radial = math.hypot(dx, dy)
            pucker = math.sin(math.atan2(dy, dx) * 13 + phase) * math.exp(-(radial / (radius * 3.1)) ** 2)
            pucker *= min(1, radial / (radius * 1.4))
            displacement += fold * asymmetry * (corner * ridge + 0.2 * pucker) * face ** 0.6
        for axis in range(3):
            point[axis] += displacement * normal[axis]
        edge_face = 0.2 + 0.8 * face
        point[0] += math.copysign(1, x) * irregularity * (0.55 * math.sin(y * 28 + 1.3) + 0.26 * math.sin(y * 71)) * math.exp(-(dx / (radius * 1.3)) ** 2) * edge_face
        point[1] += math.copysign(1, y) * irregularity * (0.5 * math.sin(x * 25 - 0.7) + 0.3 * math.sin(x * 67)) * math.exp(-(dy / (radius * 1.3)) ** 2) * edge_face
        inset_uv = wrap * (coordinates[2] + halves[2]) / depth
        uv = (0.5 + coordinates[0] / width * (1 - 2 * inset_uv), 0.5 + coordinates[1] / height * (1 - 2 * inset_uv))
        return (point, normal, uv)
    (vertices, uvs, faces, lookup) = ([], [], [], {})

    def add_vertex(coordinates):
        key = tuple((round(value, 10) for value in coordinates))
        if key not in lookup:
            (point, normal, uv) = surface(coordinates)
            lookup[key] = len(vertices)
            vertices.append(point)
            uvs.append(uv)
        return lookup[key]
    for (normal_axis, first_axis, second_axis) in [(2, 0, 1), (0, 1, 2), (1, 2, 0)]:
        for sign in [-1, 1]:
            grid = []
            for first in axes[first_axis]:
                row = []
                for second in axes[second_axis]:
                    coordinates = [0, 0, 0]
                    coordinates[normal_axis] = halves[normal_axis] * sign
                    (coordinates[first_axis], coordinates[second_axis]) = (first, second)
                    row.append(add_vertex(coordinates))
                grid.append(row)
            for i in range(len(grid) - 1):
                for j in range(len(grid[0]) - 1):
                    face = [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]
                    faces.append(face if sign > 0 else list(reversed(face)))
    canvas = _mesh_object('Tensioned stretched canvas', vertices, faces, uvs)
    _canvas_surface_uv(canvas, width, height)
    canvas['depth'] = depth
    canvas['roll_radius'] = radius
    canvas['edge_tension'] = tension
    canvas['corner_fold'] = fold
    canvas['corner_overlap'] = flap_strength
    canvas['wrap_fraction'] = wrap
    canvas['surface_vertices'] = len(vertices)
    if flap_strength <= 0:
        return canvas
    for (corner_index, (sx, sy, length_x, length_y)) in enumerate([(-1, 1, 1.35, 0.95), (1, 1, 0.82, 1.15), (1, -1, 1.15, 1.3), (-1, -1, 1.4, 1.1)]):
        span = radius * (1.6 + 0.25 * flap_strength)
        triangle = [(radius * 0.12, radius * 0.12), (span * length_x, radius * 0.18), (radius * 0.18, span * length_y)]
        (points, normals, texcoords, triangles, index_map) = ([], [], [], [], {})
        count = 18
        for i in range(count + 1):
            for j in range(count + 1 - i):
                (a, b) = (i / count, j / count)
                dx = triangle[0][0] * (1 - a - b) + triangle[1][0] * a + triangle[2][0] * b
                dy = triangle[0][1] * (1 - a - b) + triangle[1][1] * a + triangle[2][1] * b
                (position, normal, uv) = surface((sx * (halves[0] - dx), sy * (halves[1] - dy), halves[2]))
                rounding = math.exp(-((a + b - 0.38) / 0.33) ** 2)
                overlap = flap_strength * (0.00065 + 0.0016 * rounding + 0.00045 * math.sin(math.pi * a) * math.sin(math.pi * b))
                index_map[i, j] = len(points)
                points.append([position[k] + normal[k] * overlap for k in range(3)])
                normals.append(normal)
                texcoords.append(uv)
        for i in range(count):
            for j in range(count - i):
                triangles.append([index_map[i, j], index_map[i + 1, j], index_map[i, j + 1]])
                if i + j < count - 1:
                    triangles.append([index_map[i + 1, j], index_map[i + 1, j + 1], index_map[i, j + 1]])
        if sx * sy < 0:
            triangles = [list(reversed(face)) for face in triangles]
        length = len(points)
        thickness = 0.0007 * flap_strength
        points += [[point[k] - normal[k] * thickness for k in range(3)] for (point, normal) in zip(points[:], normals)]
        texcoords += texcoords[:]
        triangles += [[index + length for index in reversed(face)] for face in triangles[:]]
        boundary = [index_map[i, 0] for i in range(count + 1)]
        boundary += [index_map[count - j, j] for j in range(1, count + 1)]
        boundary += [index_map[0, j] for j in range(count - 1, 0, -1)]
        if sx * sy < 0:
            boundary.reverse()
        for (i, first) in enumerate(boundary):
            second = boundary[(i + 1) % len(boundary)]
            triangles.append([first, first + length, second + length, second])
        flap = _mesh_object(f'Tucked corner cloth {corner_index + 1}', points, triangles, texcoords)
        _canvas_surface_uv(flap, width, height)
        flap.parent = canvas
    return canvas
