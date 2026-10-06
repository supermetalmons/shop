import * as THREE from 'three';
import registry from './miNotePackRenderSetups.json' with { type: 'json' };
import type { MiNoteStickerEffectSettings } from './miNoteStickerEffects';

type Vector3Tuple = [number, number, number];
type QuaternionTuple = [number, number, number, number];

export type MiNotePackId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type MiNotePackRenderShared = {
  output: { width: number; height: number };
  renderer: { outputColorSpace: 'srgb'; toneMapping: 'ACESFilmic'; exposure: number; clearColor: string; clearAlpha: number; antialias: boolean };
  lighting: {
    hemisphere: { skyColor: string; groundColor: string; intensity: number };
    directional: { color: string; intensity: number; position: Vector3Tuple; target: Vector3Tuple }[];
  };
  quality: { stickerTextureSize: 512 | 1024 | 2048; anisotropy: number };
};

export type MiNotePackRenderSetup = {
  id: string;
  packId: MiNotePackId;
  variantId: string;
  color: string;
  imageFilename: string;
  sticker: {
    id: string;
    source: string;
    foldPosition: number;
    rotationOffsetDegrees: number;
    verticalPosition: number;
    sizeScale: number;
    effectSettings: MiNoteStickerEffectSettings;
  };
  model: {
    position: Vector3Tuple;
    rotationDegrees: Vector3Tuple;
    rotationOrder: 'XYZ';
    scale: Vector3Tuple;
    folderPhase: 0;
    flipRotationY: number;
    sealState: 'sealed';
  };
  camera: {
    position: Vector3Tuple;
    quaternion: QuaternionTuple;
    fov: number;
    aspect: number;
    near: number;
    far: number;
    zoom: number;
  };
  framing: { alphaBounds: { left: number; top: number; width: number; height: number } };
};

export type MiNotePackRenderRegistry = {
  schemaVersion: 1;
  modelVersion: 'mi-note-pack-v1';
  shared: MiNotePackRenderShared;
  setups: Record<string, MiNotePackRenderSetup>;
};

export const MI_NOTE_PACK_RENDER_REGISTRY = registry as unknown as MiNotePackRenderRegistry;

export function getMiNotePackRenderSetup(variantId: string, stickerId: string): MiNotePackRenderSetup | undefined {
  const packId = MI_NOTE_PACK_RENDER_REGISTRY.setups[`${variantId}--${stickerId}`]?.packId;
  return packId === undefined ? undefined : getMiNotePackRenderSetupByPackId(packId);
}

export function getMiNotePackRenderSetupByPackId(packId: number): MiNotePackRenderSetup | undefined {
  return Object.values(MI_NOTE_PACK_RENDER_REGISTRY.setups).find(setup => setup.packId === packId);
}

export function configureMiNotePackRenderer(renderer: THREE.WebGLRenderer, shared: MiNotePackRenderShared) {
  renderer.setClearColor(shared.renderer.clearColor, shared.renderer.clearAlpha);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = shared.renderer.exposure;
}

export function addMiNotePackRenderLights(scene: THREE.Scene, shared: MiNotePackRenderShared) {
  const hemisphere = shared.lighting.hemisphere;
  scene.add(new THREE.HemisphereLight(hemisphere.skyColor, hemisphere.groundColor, hemisphere.intensity));
  for (const light of shared.lighting.directional) {
    const directional = new THREE.DirectionalLight(light.color, light.intensity);
    directional.position.fromArray(light.position);
    directional.target.position.fromArray(light.target);
    scene.add(directional, directional.target);
  }
}

export function applyMiNotePackRenderPose(model: { group: THREE.Group; flipRoot: THREE.Group; setFolderPhase: (phase: number) => void }, setup: MiNotePackRenderSetup) {
  model.group.position.fromArray(setup.model.position);
  model.group.rotation.set(...setup.model.rotationDegrees.map(THREE.MathUtils.degToRad) as Vector3Tuple, setup.model.rotationOrder);
  model.group.scale.fromArray(setup.model.scale);
  model.flipRoot.rotation.y = setup.model.flipRotationY;
  model.setFolderPhase(setup.model.folderPhase);
}

export function applyMiNotePackTextureQuality(group: THREE.Group, renderer: THREE.WebGLRenderer, shared: MiNotePackRenderShared) {
  const anisotropy = Math.min(shared.quality.anisotropy, renderer.capabilities.getMaxAnisotropy());
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      const mapped = material as THREE.MeshStandardMaterial;
      for (const texture of [mapped.map, mapped.bumpMap]) {
        if (texture instanceof THREE.Texture && texture.anisotropy !== anisotropy) {
          texture.anisotropy = anisotropy;
          texture.needsUpdate = true;
        }
      }
    }
  });
}

export function restoreMiNotePackRenderCamera(camera: THREE.PerspectiveCamera, setup: MiNotePackRenderSetup) {
  camera.position.fromArray(setup.camera.position);
  camera.quaternion.fromArray(setup.camera.quaternion);
  camera.fov = setup.camera.fov;
  camera.aspect = setup.camera.aspect;
  camera.near = setup.camera.near;
  camera.far = setup.camera.far;
  camera.zoom = setup.camera.zoom;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

export function getMiNotePackPresentation(setup: MiNotePackRenderSetup, width: number, height: number, output = MI_NOTE_PACK_RENDER_REGISTRY.shared.output) {
  const bounds = setup.framing.alphaBounds;
  const scale = Math.min(height * 0.52 / bounds.height, width * 0.68 / bounds.width);
  const imageWidth = output.width * scale;
  const imageHeight = output.height * scale;
  return {
    left: (width - imageWidth) / 2,
    top: (height - imageHeight) / 2,
    width: imageWidth,
    height: imageHeight,
    zoom: setup.camera.zoom * imageHeight / height,
  };
}
