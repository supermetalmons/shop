# Framed knife models

`npm run render:knives` uses the shared [acrylic workflow](../README.md).
The Metal renderer fits the complete knife orbit to a native 16:9 image
with a graphite background and soft strip highlights. The framed result
is a silent 1440 × 1440 MP4 with 300 frames at 60 fps.

```sh
npm run render:knives -- --ids 5,17
npm run render:knives -- --input /path/to/blade.glb --output /path/to/renders
```

## Frameless high-resolution option

```sh
npm run render:knives -- --frameless --ids 904,6
npm run render:knives -- --frameless --samples
npm run render:knives -- --frameless --input /path/to/blade.glb --output /path/to/renders
```

`--frameless` exports the approved standalone 16:9 animation with the same
graphite background, strip lighting, alignment and idle motion. It renders at
3840 × 2160 with 4× MSAA, then downsamples with Lanczos to 1920 × 1080. Delivery
uses H.264 CRF 12, the slow preset, yuv420p and fast-start metadata. Each silent
MP4 contains 300 frames at 60 fps (five seconds), retaining sRGB transfer,
BT.709 primaries/matrix and limited range.

The default destination is `output/video-frames/knives/frameless/`. Numbered
models use `<id>.mp4`; local files use the existing `local-3d-<stem>-<hash>.mp4`
naming scheme. `--samples` selects IDs 904, 906, 909, 942 and 986. Local inputs
still require `--output`. Movies are checked for format, exact frame timing,
successful decoding and fast-start before publication.

This option is restricted to knives/3d and cannot be combined with `--variant`,
`--background` or `--verify`. Without `--frameless`, the standard framed workflow
and both approved acrylic presets remain unchanged. `--verify` continues to
check those acrylic assets.

Numbered models use IDs 1–3000 and come from
`https://cdn.lil.org/nft/111k/3d/{id}.glb`. Matching cached files in
`.cache/video-frames/knives/sources/cdn-lil-111k/` also work offline. Repeat `--input`
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
