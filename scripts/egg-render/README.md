# 111k egg finish studies

Run the following command from the repository root to reproduce the color-corrected studies.

```sh
npm run render:eggs
```

This renders eggs 1, 29, 127, 277, and 466 in natural eggshell, satin ceramic,
polished lacquer, and pearl glaze. Use `--ids` and `--output` to select other eggs or a different destination.

```sh
npm run render:eggs -- --ids 29,277 --output output/eggs/selection
```

The runner downloads `https://cdn.lil.org/nft/111k/eggs/{id}.webp` into
`.cache/egg-render/sources/cdn-lil-111k/`, separate from earlier WIP inputs.
For the five study IDs it checks the CDN artwork's SHA-256 against `samples.json`.
A cache mismatch triggers one fresh download,
which must match before it replaces the cached file. `shell.py` defines the shape
and artwork projection. `studio.py` fixes the materials, lighting, camera and
final contrast curve shared by all four finishes.

The command writes one opaque 1400 × 1400 PNG on white per finish and ID under
`output/eggs/`. The comparison sheet (`comparison.png`) shows the 2D originals
alongside all four finishes. Rerunning replaces matching outputs. Ctrl-C stops
the batch. If publishing fails, the runner restores prior files. If restoration
itself fails, it reports the backup directory (`.egg-publish`) for recovery.

The reference setup used Blender **4.5.3 LTS**, build `67807e1800cc`, with
Cycles on Apple M1 Max Metal (160 samples, seed 27, Standard view transform).
A clean repeat on this setup differed by at most one 8-bit color level in
at most 17 pixels per render. The command also requires
the Node.js version pinned in the repository’s `.nvmrc` and macOS Swift tools. Set `BLENDER_BIN` if the Blender executable
is outside its default Mac app path.

Run the cache, publication, artwork-switching, and cancellation checks with:

```sh
node --test scripts/egg-render/*.test.mjs
"/Applications/Blender.app/Contents/MacOS/Blender" -b --quiet --factory-startup \
  --python-exit-code 1 --python scripts/egg-render/batch.test.py
```
