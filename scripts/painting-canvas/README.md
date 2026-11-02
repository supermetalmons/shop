# Approved canvas renderer: A Light

This is the sole approved canvas setup, selected as **1 — A Light**. Use it when
asked to render paintings or artworks on canvases. Do not recreate the earlier
experiments or change its appearance unless explicitly requested.

The look uses a straight-on stretched canvas, folded edges, a white background,
and photographic weave at 35% strength. Output PNGs keep the upright artwork's dimensions.
The outer approximately 1.2% of the artwork continues around the canvas sides.

## Render

Render 111k painting asset IDs:

```sh
npm run render:canvases -- --ids 1,3,7 --output output/canvas
```

Render local images or a directory:

```sh
npm run render:canvases -- --input /absolute/path/artwork.webp
npm run render:canvases -- --input /absolute/path/images --output output/canvas
```

Directories are nonrecursive. PNG, JPEG, and WebP are supported; `--input` may be
repeated. Filenames become output IDs. Duplicate IDs fail before rendering.
Case-only filename differences are also rejected. Local images are oriented from
EXIF, converted from embedded color profiles to sRGB, and composited over white
when transparent. Opaque sRGB images pass through without rewriting.

For a manifest, use `--manifest /path/samples.json` with:

```json
{"samples":[{"id":"painting","path":"images/painting.webp"}]}
```

Paths are relative to the manifest. Optional `width` and `height` fields are
checked against the upright image. Existing output files require `--overwrite`;
symbolic and hard-linked output files are rejected even when overwriting is enabled.
The equivalent direct entrypoint is `node scripts/painting-canvas/render.mjs`.
Use `--help` for all input options. There are no variant or quality switches.

The ten IDs used when approving this look were
`1,3,7,79,275,336,1883,12345,64000,85556`.

## Verify the approved look

```sh
npm run render:canvases -- --verify
```

This renders the bundled source and compares it with
[`reference/approved.png`](reference/approved.png). Results go to
`.cache/painting-canvas/verification/`. The check permits only one RGB8 level of
difference in at most 0.01% of channels: even the unchanged original renderer
occasionally varies by one level in a few pixels on Metal. Larger differences fail.
Using `--verify --output` with a custom destination requires `--overwrite` to
replace existing files, just like a normal render.

## Requirements and fixed settings

- Node.js 22 or newer; the runner uses only built-in modules. No `npm install` needed.
- Blender **4.5.3 LTS**, build `67807e1800cc`, with a Metal GPU.
- macOS Swift command-line tools for the small ImageIO normalization helper,
  compiled automatically and cached on first use. No image-processing packages are needed.
- Default executable: `/Applications/Blender.app/Contents/MacOS/Blender`.
  Use `--blender` or `BLENDER_BIN` if the same build is installed elsewhere.
  Relative executable paths resolve from the caller's working directory.
- All rendering uses background mode (`-b`); no windows or browser capture.
- Cycles, 48 samples, seed 19, no denoising, Standard color transform, sRGB artwork.

The renderer rejects a different Blender build or modified material maps.
The approved preset is in `preset.json`; lighting, framing, and scene settings are
in `render.py`. Geometry and material code contain only this setup.

The two exact photographic maps are bundled in `assets/` with hashes and
provenance. They do not depend on Desktop files, earlier outputs, reference-photo
processing, a Python environment, or the previous web renderer. Blender supplies
the Python runtime and the NumPy used by verification.

Each run writes `<id>.png`, `render-report.json`, and `render.log`. Reports include
source/output hashes, preset/code hashes, Blender/device details, and per-image
timing. Catalog downloads are cached under `.cache/painting-canvas/sources/`.
The cache and default generated output are ignored by Git.
Image intermediates are kept beside the outputs and removed after each render.
Cancellation stops the batch without publishing the interrupted frame, preserves
completed outputs, and reports `cancelled` with exit code 130 or 143.

Regression checks: `node --test scripts/painting-canvas/render.test.mjs` and
`python3 scripts/painting-canvas/path-safety.test.py` cover output protection and
download cancellation. `python3 scripts/painting-canvas/lifecycle.test.py` checks
render cancellation and intermediate cleanup. Run `swift scripts/painting-canvas/normalization.test.swift`
for image-import checks; `--verify` checks the approved rendering appearance.
