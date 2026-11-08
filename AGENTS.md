Avoid code comments except for TODOs or essential context.

## 111k testnet replacements

Every replacement of the 111k testnet includes purging the superseded deployment
in the same task. Start that cleanup immediately after the replacement is active
and verified, with the required writer fences and drain periods. Remove the old
backend data and obsolete repo/local artifacts and verify their absence before
reporting the replacement complete. Never defer cleanup to a later deployment.

Follow `scripts/docs/111k_reveal_ops.md#superseded-testnet-retirement`. The release
runner's `open` command automatically verifies the replacement and finalizes
cleanup, including same-catalog replacements. Retry interrupted cleanup with
`finalize` against the same frozen release directory; `verify` stays read-only.
Deploy the retirement migration and Worker support before cutover. Pausing alone
is not retirement; use the irreversible per-deployment marker and writer drain.
Never falsify catalog identity or bump the catalog solely to permit deletion.

Keep the replacement's required assets and signed release evidence, immutable
ownership tombstones, Git history, and a minimal cleanup record. Remove obsolete
release trees, generated caches, and old backups; do not retain a legacy archive
unless explicitly requested. Preserve mainnet, pre111k, shared media, profiles,
and unrelated drops. Verify the replacement stays healthy and retired data does
not reappear after a scheduler interval before completing the task.

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

When standalone frameless knife videos are requested, use
`npm run render:knives -- --frameless` with the requested IDs or local models.
This approved option renders at 4K with 4× MSAA, downsamples to 1080p with
Lanczos, and encodes H.264 at CRF 12 with the slow preset. Preserve its 16:9
graphite background, lighting, complete-object framing and five-second 60 fps
idle motion. Framed rendering remains the default.
