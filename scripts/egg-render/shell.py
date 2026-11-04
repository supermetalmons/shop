import math
from pathlib import Path

import bpy
import numpy as np


ARTWORK_ASPECT = 457 / 537


def create_shell():
    bpy.ops.mesh.primitive_uv_sphere_add(segments=160, ring_count=96, radius=1.0)
    shell = bpy.context.object
    shell.name = "Painted egg"
    mesh = shell.data
    for vertex in mesh.vertices:
        x, y, t = vertex.co
        # Smooth quadratic fit to the common silhouette, applied to a unit sphere.
        scale = 0.8405 - 0.1246 * t - 0.0426 * t * t
        vertex.co = (x * scale, y * scale, t + 1.0)
    mesh.update()

    uv = mesh.uv_layers.active.data
    for face in mesh.polygons:
        face.use_smooth = True
        for index in face.loop_indices:
            x, y, z = mesh.vertices[mesh.loops[index].vertex_index].co
            if y > 1e-6:
                # Continue past the printed edges on the rear, meeting at the hidden seam.
                x = math.copysign(2 * math.hypot(x, y) - abs(x), face.center.x)
            u = 0.5 + x / (2 * ARTWORK_ASPECT)
            uv[index].uv = (min(1.0, max(0.0, u)), z / 2)
    mesh.update()
    return shell


def prepare_artwork(path):
    source = bpy.data.images.load(str(path), check_existing=False)
    try:
        width, height = source.size
        pixels = np.empty((height, width, 4), dtype=np.float32)
        source.pixels.foreach_get(pixels.ravel())
    finally:
        bpy.data.images.remove(source)

    ys, xs = np.nonzero(pixels[:, :, 3] >= 0.5)
    if not xs.size:
        raise ValueError(f"No visible egg in {path}")
    crop = pixels[ys.min():ys.max() + 1, xs.min():xs.max() + 1].copy()
    opaque = crop[:, :, 3] >= 0.999
    rows = np.flatnonzero(opaque.any(axis=1))
    if not rows.size:
        raise ValueError(f"No opaque artwork in {path}")
    for y, row in enumerate(crop):
        source_y = max(rows[0], min(y, rows[-1]))
        columns = np.flatnonzero(opaque[source_y])
        if not columns.size:
            raise ValueError(f"Broken egg silhouette in {path}")
        row[:] = crop[source_y]
        row[:columns[0]] = row[columns[0]]
        row[columns[-1] + 1:] = row[columns[-1]]
    crop[:, :, 3] = 1.0

    height, width = crop.shape[:2]
    image = bpy.data.images.new(f"Egg {Path(path).stem}", width=width, height=height, alpha=False)
    image.colorspace_settings.name = "sRGB"
    image.pixels.foreach_set(crop.ravel())
    image.update()
    return image
