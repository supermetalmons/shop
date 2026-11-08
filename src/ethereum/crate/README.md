# 111k crate reveal

The crate scene is loaded only for a single-crate unpack. The existing Ethereum
submission and confirmed reveal flow remains authoritative. Three crate hits,
all decoded preview images, and GPU preparation must finish before opening.
The scene's completion callback starts the presentation's dismissal cooldown.

`crateModel.ts` contains the geometry and calibrated camera. Exterior UVs project
`public/111k/crate-reference-v16.webp`, a byte-identical local mirror of
<https://cdn.lil.org/nft/111k/crate.webp>, onto real timber geometry. The camera,
wall proportions and wood samples match this 1448 × 1086 image; its 4:3 aspect
comes from the shared container media configuration. Preserve its native alpha
and the closed reference pose when adjusting the opening motion.
Unphotographed interior surfaces use wood samples from the same image.

`crateAssets.ts` prepares up to four previews at a time, retaining at most 512px
on each image's longest edge. The scene warms two textures per frame before
declaring readiness. No video or artwork model is loaded during unpacking.

## Local preview

Run `npm run dev`, then open `/111k_devnet/crate-preview`. The route is available
only in development and uses local fixture results without a wallet or API.

- `?count=31` selects the last crate's larger result set.
- `?delay=5000` delays the results while hits remain available.
- `?failure=1` supplies one deliberately missing preview.
- `?inspect=1&time=1000` uses the production scene at a deterministic animation
  time. The slider covers the complete 0–2150ms sequence.

The interactive fixture uses the production presentation and overlay. Escape
closes it. Browser reduced-motion emulation exercises the short reveal. Blocking
the scene or losing its WebGL context exercises the prepared-preview fallback.

## Checks

```sh
node --import tsx --test tests/ethereumCrate*.test.ts tests/ethereumInventoryPresentation.test.ts tests/ethereum111kPage.test.ts
npm run typecheck
npm run build
```

Inspect the closed pose against the reference, hit locations, lid clearance,
artwork occlusion at the rim, and the final gallery in desktop, mobile portrait,
and mobile landscape. The scene's DOM data attributes expose draw calls,
triangle count, texture count, readiness, and animation activity for browser QA.

Original wooden audio samples are generated reproducibly with
`npm run generate:crate-sounds` and played through the shared sound
player. Audio is never part of the opening readiness gate.
