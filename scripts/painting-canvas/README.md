# Approved canvas renderer: A Light

This is the sole approved canvas setup, selected as **1 — A Light**. Use it when
asked to render paintings or artworks on canvases. Do not recreate the earlier
experiments or change its appearance unless explicitly requested.

The look uses a straight-on stretched canvas, folded edges, and photographic weave
at 35% strength. The default output is transparent WebP at quality 85, capped at
1400 pixels on the longest side without upscaling. Use `--format png` for the
original full-resolution PNG with a white background.
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
Use `--help` for all input and export options. Canvas geometry, materials, lighting,
and render sampling remain fixed to the approved setup.

The ten IDs used when approving this look were
`1,3,7,79,275,336,1883,12345,64000,85556`.

## Numbered image URLs

Use `{id}` in the URL and supply an inclusive range. This renders paintings 1 through 8888.

```sh
npm run render:canvases:urls -- \
  --url-template 'https://cdn.lil.org/nft/111k/paintings/{id}.png' \
  --first 1 --last 8888 --output output/canvas/111k-8888
```

The command verifies the reference once, renders 20 images per batch with the
default WebP settings, and prefetches one batch. Up to four downloads run at a
time. Each verified `<id>.webp` appears in the output folder, and its downloaded
source is removed. Prefix the command with `caffeinate -i` to keep a Mac awake.

Run one batch per output folder. To resume, keep `canvas-checkpoint.jsonl` there
and rerun the same command once the previous renderer exits. The command reclaims
its temporary downloads and skips files matching the recorded URL and checksum. A conflicting
output or a missing checkpointed file in the requested range stops the run.
If you moved IDs 1–8745 elsewhere, rerun with `--first 8746 --last 8888` to
check and finish only those remaining IDs.

## Export options

The normal command produces transparent WebP at quality 85, capped at 1400 pixels:

```sh
npm run render:canvases -- --input /absolute/path/images --output output/canvas
```

For the original high-resolution PNG output, retaining the upright source dimensions
and white background:

```sh
npm run render:canvases -- --input /absolute/path/images --format png --output output/canvas-png
```

- `--format webp|png` selects the export defaults described above.
- `--transparent` enables alpha outside the canvas for PNG; WebP is transparent by
  default. Antialiased edges retain alpha, and white areas within the artwork remain opaque.
- `--quality` sets integer WebP encoding quality from 0 through 100, defaulting to 85.
  Explicit quality is rejected for PNG; this does not change Cycles sampling.
- `--max-side` is a positive integer pixel cap on the longest output side. Images
  render directly at the capped size, preserve aspect ratio to the nearest pixel,
  and never upscale. The default cap is 1400 for WebP; PNG has no cap unless specified.

Blender writes WebP natively; no extra encoder is required. Import normalization
still composites transparent source artwork over white before applying it to the canvas.

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
Export options cannot be combined with `--verify`; verification always uses the
original full-size, white-background PNG settings and approved fixture.

## Requirements and fixed settings

- Use the Node.js version pinned in the repository’s `.nvmrc`. The runner uses only built-in modules.
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

Each run writes `<id>.png` or `<id>.webp`, `render-report.json`, and `render.log`.
Reports include source/output hashes, preset/code hashes, Blender/device details,
export settings, and per-image timing. Record `width`/`height` describe the actual
output; `source_width`/`source_height` describe the upright source artwork.
Catalog downloads are cached under `.cache/painting-canvas/sources/`.
The cache and default generated output are ignored by Git.
Image intermediates are kept beside the outputs and removed after each render.
Cancellation stops the batch without publishing the interrupted frame, preserves
completed outputs, and reports `cancelled` with exit code 130 or 143.

Regression checks: `node --test scripts/painting-canvas/render.test.mjs` and
`python3 scripts/painting-canvas/path-safety.test.py` cover output protection and
download cancellation. `python3 scripts/painting-canvas/lifecycle.test.py` checks
render cancellation and intermediate cleanup. Run `swift scripts/painting-canvas/normalization.test.swift`
for image-import checks; `--verify` checks the approved rendering appearance.
