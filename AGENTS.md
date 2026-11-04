Avoid code comments except for TODOs or essential context.

## Canvas artwork rendering

When asked to render paintings or artworks on canvases, use the approved A Light
workflow in `scripts/painting-canvas/README.md`. Run `npm run render:canvases --`
with the requested painting IDs or local images. This is the sole approved look:
35% photographic weave, the saved folded geometry, and the fixed Blender setup.
Keep all rendering headless. Do not recreate variants or change the preset unless
the user explicitly requests a new appearance. Use `--verify` to check reproduction.

## 111k framed media

Use the approved white acrylic presets, `08-soft-clear` and `15-high-key`,
for 111k framed videos, animations and knife models. Render headlessly with
`npm run render:video-frames` or `npm run render:knives`. Both commands use
the saved plates in `scripts/video-frames/acrylic/presets/`. Preserve the
front-facing camera, shadowless white surround and 16:9 opening. Aspect-fit
moving images and keep the full widescreen knife orbit in view.

Use `--verify` to check the approved assets and `--variant` to choose a single
preset. Generate comparison samples only when requested. See
`scripts/video-frames/README.md` for commands and output naming.
