# Dark Halo Soft Strip

The approved preset renders a five-second Floating Orbit loop in a thin ebonized
ash frame on white. A soft strip light catches the blade against a graphite
halo. The knife fits the 3:2 opening at a fixed scale throughout the orbit.
Exports are silent 1440 × 1440 H.264 MP4s with 300 frames at 60 fps.

## Render

Run these from the repository root on a Mac with Metal, Swift command-line
tools, Python 3, FFmpeg with libx264, ffprobe, and curl.

```sh
npm run render:knives
npm run render:knives -- --ids 5,17
npm run render:knives -- --input /path/to/blade.glb --output /path/to/renders
npm run render:knives -- --verify
```

The default command renders 111k IDs 1–4. Use `--ids` for other IDs from
1–1000. Numbered models come from `https://wip.lil.org/111k/3d/{id}.glb`
and are cached in `.cache/video-frames/knives/sources/`. Matching cached
files work offline. Output defaults to `output/video-frames/knives/dark-halo-soft-strip/`.
Local files take their output names from their stems. Repeat `--input` to
render several files together, and supply an explicit `--output` directory.
The batch publishes its MP4s after all selected models render successfully.
`npm run render:video-frames -- --collection knives` is an equivalent entry point.

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

## Reproduce the approved result

`--verify` builds the renderer, renders all four pinned inputs to temporary
files, and checks their MP4 SHA-256 hashes. It works without previously
exported movies. [The preset manifest](preset.json) records the approved source,
frame, and output hashes and the reference Mac toolchain. Verification reports
a mismatch if another encoder or Metal version produces different bytes.

Production uses the saved plate, mask, and projected corners in `frame/`.
To inspect or edit the frame, render the Blender recipe into a separate directory.

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-exit-code 1 \
  --python scripts/video-frames/knives/frame_recipe.py -- /tmp/knife-frame
```

The recipe shares the headless studio camera, lighting, and shadow with the
video frames. A fresh Cycles render can differ slightly from the approved plate.
