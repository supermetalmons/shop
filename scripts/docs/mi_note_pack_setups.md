# Mi Note pack IDs and saved 3D setups

`src/lib/miNotePackRenderSetups.json` preserves the nine pack identities and their complete 3D settings. Numeric `packId` values are stable; combination strings remain the registry keys. Numbering does not depend on object order.

| Pack ID | Color | Sticker | Image filename |
| --- | --- | --- | --- |
| 1 | Cobalt Blue | Blush | `1.png` |
| 2 | Cobalt Blue | Zombie | `2.png` |
| 3 | Cobalt Blue | Supermetal | `3.png` |
| 4 | Marigold | Blush | `4.png` |
| 5 | Marigold | Zombie | `5.png` |
| 6 | Marigold | Supermetal | `6.png` |
| 7 | Emerald | Blush | `7.png` |
| 8 | Emerald | Zombie | `8.png` |
| 9 | Emerald | Supermetal | `9.png` |

`getMiNotePackRenderSetupByPackId(4)` returns Marigold with the Blush sticker. Unknown IDs return `undefined`. `imageFilename`, such as `4.png`, is metadata identifying the separately saved PNG; it is not a hosted URL. An application supplying those images must provide its own asset location.

The registry stores shared output width/height, renderer settings, lighting, and texture quality. Each setup stores its color, sticker source and placement, finish effects, model transform, and camera. All nine share the standard root rotation `[0.055, -0.12, -0.016]` radians, zero position, unit scale, and the original consistent camera framing.

The existing WIP viewer keeps its original behavior. These saved presets do not enable a PNG loading handoff. Export scripts and their dependencies are not required to use the presets.

## Restore a pack in a browser

Use `MI_NOTE_PACK_STARS` to resolve the sticker's bundled asset URL. Pass the saved placement and finish explicitly. The optional `stickerTextureSize` defaults to `512`; supplying `shared.quality.stickerTextureSize` opts into the saved `2048` quality without changing other callers.

```ts
import * as THREE from 'three';
import { createMiNotePackModel } from './src/lib/miNotePackModel';
import { MI_NOTE_PACK_STARS } from './src/lib/miNotePackStars';
import {
  MI_NOTE_PACK_RENDER_REGISTRY,
  getMiNotePackRenderSetupByPackId,
  configureMiNotePackRenderer,
  addMiNotePackRenderLights,
  applyMiNotePackRenderPose,
  applyMiNotePackTextureQuality,
  restoreMiNotePackRenderCamera,
} from './src/lib/miNotePackRenderSetup';

const packId = 4;
const setup = getMiNotePackRenderSetupByPackId(packId);
if (!setup) throw new Error(`Unknown pack ID: ${packId}`);
const star = MI_NOTE_PACK_STARS.find(value => value.id === setup.sticker.id);
if (!star) throw new Error(`Unknown sticker: ${setup.sticker.id}`);
const { shared } = MI_NOTE_PACK_RENDER_REGISTRY;
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: shared.renderer.antialias });
renderer.setPixelRatio(1);
renderer.setSize(shared.output.width, shared.output.height);
configureMiNotePackRenderer(renderer, shared);
const scene = new THREE.Scene();
addMiNotePackRenderLights(scene, shared);
const camera = new THREE.PerspectiveCamera();
restoreMiNotePackRenderCamera(camera, setup);
const model = createMiNotePackModel({
  color: setup.color,
  star,
  foldPosition: setup.sticker.foldPosition,
  rotationOffsetDegrees: setup.sticker.rotationOffsetDegrees,
  verticalPosition: setup.sticker.verticalPosition,
  sizeScale: setup.sticker.sizeScale,
  effectSettings: setup.sticker.effectSettings,
  stickerTextureSize: shared.quality.stickerTextureSize,
});
await model.ready;
applyMiNotePackRenderPose(model, setup);
applyMiNotePackTextureQuality(model.group, renderer, shared);
scene.add(model.group);
document.body.append(renderer.domElement);
renderer.render(scene, camera);
```

Adjust import paths for the caller's location. `rotationDegrees` uses `[pitchX, yawY, rollZ]` with Euler order `XYZ`; camera quaternions use `[x, y, z, w]`. The restoration helpers preserve the saved camera quaternion, so do not replace it with `camera.lookAt(...)`. Keep the saved aspect ratio when matching the original framing.

When finished, call `model.dispose()`, `renderer.dispose()`, and remove `renderer.domElement`. Pixel-identical image reproduction additionally depends on the rendering runtime and image-processing pipeline; this example restores the recorded scene settings.
