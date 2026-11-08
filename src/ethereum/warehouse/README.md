# 111k warehouse reveal

Single-warehouse unpacking uses the same submission and confirmed-result lifecycle
as crate unpacking. Two ice impacts damage the building; the third hit arms the
critical strike. Confirmed results and prepared GPU resources gate destruction.
Eleven camera-facing crate images emerge from the building and settle into a
stationary pile. Dismiss the result to open individual crates from inventory.

The warehouse model projects `public/111k/warehouse-reference-v16.webp`, a
byte-identical local mirror of <https://cdn.lil.org/nft/111k/warehouse.webp>, onto a
hollow shell with a pitched roof, front gable and three roof vents. Its calibrated
camera and image landmarks match the 1536 × 1024 reference; its 3:2 aspect comes
from the shared container media configuration. Native alpha remains intact.
The roof and wall pieces follow deterministic fracture trajectories. The crates
share one instanced plane batch and one 512px preview texture: 22 triangles total.
The versioned local crate mirror of <https://cdn.lil.org/nft/111k/crate.webp>
loads when the overlay opens and is reused for both the
scene and fallback. Texture upload, compilation, and the offscreen warm render
are staged independently of confirmation; result arrival does not build or load a model.
The critical meteor launches only when the reveal can run continuously, without
a held meteor or waiting note. The scene renders only while preparing, animating
or responding to input and resize. Hidden or suspended
scenes pause without consuming animation time.

Enabling reduced motion during destruction finishes with the short reveal.
Disabling it during that reveal does not restart the destruction sequence.

## Local preview

Run `npm run dev`, then open `/111k_devnet/warehouse-preview`. This development-only
route uses eleven fixture crates and the production overlay without a wallet or API.

- `?delay=5000` delays confirmation while hits remain available.
- `?failure=1` simulates a confirmed transaction failure. Disable Failed
  confirmation and retry to verify the same presentation recovers.
- `?inspect=1&time=1000` samples the production scene at a deterministic time.
  The slider covers the full 0–2800ms finishing sequence.
- `?inspect=1&reduced=1` inspects the reduced-motion reveal. For the interactive
  overlay, emulate `prefers-reduced-motion: reduce` in the browser.

Reset creates a fresh session. Suspend pauses the active session. The submission
counter helps detect unintended duplicate transactions. Escape and outside
dismissal use production behavior. Block the scene module or lose its WebGL
context to exercise the prepared-image fallback; block
`/111k/crate-reference-v16.webp` to check asset preparation failures. A different image
URL on a fixture crate does not change the shared local preview.

Inspect the intact building against the static artwork, impact positions,
fracture clearance, crate contacts and final pile visibility in desktop, mobile
portrait and mobile landscape. Use the scene's DOM performance counters to check
draw calls, triangles, textures and idle animation activity.
Seeking to the same time produces the same frame regardless of earlier slider
positions. Motion tests check every crate pair throughout emergence as well as
floor contact and the upper crates' landing supports.

## Checks

```sh
node --import tsx --test tests/ethereumWarehouse*.test.ts tests/ethereumCrate*.test.ts tests/ethereumInventoryPresentation.test.ts tests/ethereum111kPage.test.ts
npm run typecheck
npm run build
```

Regenerate the original PCM ice samples with
`npm run generate:warehouse-sounds`. `ice-impact.wav` is a short impact;
`ice-critical.wav` includes the heavier strike and collapse tail. Playback uses
the shared sound player, unlocks on user input and is never a readiness gate.
