import { LoadingManager, type Object3D } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { releaseClearCardModelLoadResources, type ClearCardModelLoadResources } from '../lib/clearCardModelLoadResources';
import { disposeObject3D } from './resources';

const DRACO_DECODER_PATH = '/draco/0.185.1/';
type ModelKind = 'pack' | 'card';
type LoadSlot = { generation: number; active: ClearCardModelLoadResources | null };

export function createClearCardModelLoads() {
  const slots: Record<ModelKind, LoadSlot> = {
    pack: { generation: 0, active: null },
    card: { generation: 0, active: null },
  };
  let disposed = false;

  const release = (slot: LoadSlot, load: ClearCardModelLoadResources, abort = false) => {
    if (slot.active === load) slot.active = null;
    releaseClearCardModelLoadResources(load, abort);
  };
  const cancel = (kind: ModelKind) => {
    const slot = slots[kind];
    slot.generation += 1;
    if (slot.active) release(slot, slot.active, true);
  };

  return {
    createRequest(kind: ModelKind) {
      cancel(kind);
      const slot = slots[kind];
      const generation = slot.generation;
      return {
        load(modelUrl: string, callbacks: {
          onLoad: (root: Object3D) => void;
          onError: (error: unknown) => void;
        }) {
          if (disposed || generation !== slot.generation) return;
          const loadingManager = new LoadingManager();
          const dracoLoader = new DRACOLoader(loadingManager);
          const load: ClearCardModelLoadResources = { loadingManager, dracoLoader, abortRequested: false };
          slot.active = load;
          dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
          dracoLoader.setWorkerLimit(1);
          const loader = new GLTFLoader(loadingManager);
          loader.setDRACOLoader(dracoLoader);
          void loader.loadAsync(modelUrl)
            .then(gltf => {
              release(slot, load);
              if (disposed || generation !== slot.generation) {
                disposeObject3D(gltf.scene);
                return;
              }
              callbacks.onLoad(gltf.scene);
            })
            .catch((error: unknown) => {
              if (disposed || generation !== slot.generation) return;
              callbacks.onError(error);
            })
            .finally(() => release(slot, load));
        },
      };
    },
    dispose() {
      disposed = true;
      cancel('pack');
      cancel('card');
    },
  };
}
