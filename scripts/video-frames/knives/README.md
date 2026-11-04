# Framed knife models

`npm run render:knives` uses the shared [acrylic workflow](../README.md).
The Metal renderer fits the complete knife orbit to a native 16:9 image
with a graphite background and soft strip highlights. The framed result
is a silent 1440 × 1440 MP4 with 300 frames at 60 fps.

```sh
npm run render:knives -- --ids 5,17
npm run render:knives -- --input /path/to/blade.glb --output /path/to/renders
```

Numbered models use IDs 1–1000 and come from
`https://wip.lil.org/111k/3d/{id}.glb`. Matching cached files in
`.cache/video-frames/knives/sources/` also work offline. Repeat `--input`
to render several local GLBs with distinct filename stems.

## Compatible models

Use static, self-contained GLB 2.0 files with transforms baked into the vertices.
Author the broad side in the XY plane. The renderer combines the mesh parts in
the active scene before aligning and framing the object. Supply indexed triangles
with unsigned 8-, 16-, or 32-bit indices and float32 positions, normals, and UV0
as the only vertex attributes. Use one shared metallic-roughness material with
embedded PNG or JPEG base-color, normal, and metallic-roughness textures, default
factors, repeat wrapping, and linear mipmap filtering. Bake any animation,
skin, morph targets, or glTF extensions before export. The preset uses the
authored texture color and opaque or blended alpha, including the translucent M9 blade.
Blended models use per-pose triangle depth sorting. Subdivide large overlapping
surfaces when their centroid depths do not represent the visible order. The four
hash-matched reference assets retain their approved alignment and rendering.
