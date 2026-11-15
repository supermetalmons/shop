import * as THREE from 'three';
import type { DrifCardConfig } from '../drifCards';
import { createMiNoteCardGeometry } from '../lib/miNoteCardGeometry';
import { createMiNoteCardMaterial } from '../lib/miNoteCardMaterial';
import { MI_NOTE_LEAF_WIDTH, type createMiNotePackModel } from '../lib/miNotePackModel';
import type { MiNotePackViewerProps } from './types';

function cardAssetKey(card: DrifCardConfig) {
  return JSON.stringify([card.imageSrc, card.foilSrc, card.textureSrc]);
}

export function createMiNoteCardAssets({ model, scene, camera, renderer, props, active, invalidate, beforeClear, afterClear }: {
  model: ReturnType<typeof createMiNotePackModel>;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  props: () => MiNotePackViewerProps;
  active: () => boolean;
  invalidate: () => void;
  beforeClear: () => void;
  afterClear: () => void;
}) {
  const geometry = createMiNoteCardGeometry();
  let disposed = false;
  let generation = 0;
  let activeEffect: DrifCardConfig['effect'] | undefined;
  let readyPending: (() => void) | null = null;

  const createCard = (config: DrifCardConfig, index: number) => {
    const anchor = new THREE.Group();
    const home = new THREE.Vector3((index === 0 ? -1 : 1) * (MI_NOTE_LEAF_WIDTH / 2 - 0.015), -0.005, 0.0057);
    anchor.position.copy(home);
    const surface = createMiNoteCardMaterial(config);
    const mesh = new THREE.Mesh(geometry, surface.material);
    mesh.name = `mi-note-card-${index}`;
    mesh.userData.card = index;
    mesh.visible = false;
    anchor.add(mesh);
    const parent = index === 0 ? model.left : model.right;
    parent.add(anchor);
    return { anchor, mesh, surface, parent, home, assetKey: cardAssetKey(config) };
  };
  const cards: ReturnType<typeof createCard>[] = [];
  const clearCards = () => {
    cards.splice(0).forEach(({ anchor, surface }) => {
      surface.dispose();
      anchor.removeFromParent();
    });
  };

  return {
    get cards(): readonly ReturnType<typeof createCard>[] { return cards; },
    update(configs: MiNotePackViewerProps['cards'], effect: DrifCardConfig['effect']) {
      if (disposed || !active()) return;
      if (!configs) {
        beforeClear();
        generation += 1;
        clearCards();
        afterClear();
        activeEffect = undefined;
        props().onCardsReadyChange(false);
        return;
      }
      let assetsChanged = false;
      configs.forEach((config, index) => {
        const card = cards[index];
        if (!card) {
          cards.push(createCard(config, index));
          assetsChanged = true;
          return;
        }
        const assetKey = cardAssetKey(config);
        if (card.assetKey === assetKey) return;
        const previous = card.surface;
        card.surface = createMiNoteCardMaterial(config);
        card.mesh.material = card.surface.material;
        card.mesh.visible = false;
        card.assetKey = assetKey;
        previous.dispose();
        assetsChanged = true;
      });
      if (!assetsChanged && effect === activeEffect) return;
      activeEffect = effect;
      const request = ++generation;
      props().onCardsError(null);
      props().onCardsReadyChange(false);
      const isCurrent = () => !disposed && active() && request === generation
        && props().cardEffect === effect
        && props().cards?.every((card, index) => cardAssetKey(card) === cards[index]?.assetKey);
      void Promise.all(cards.map(({ surface }) => surface.setEffect(effect))).then(() => {
        if (!isCurrent()) return;
        const textures = new Set<THREE.Texture>();
        cards.forEach(({ surface }) => Object.values(surface.material.uniforms).forEach(({ value }) => {
          if (value instanceof THREE.Texture) textures.add(value);
        }));
        textures.forEach(texture => renderer.initTexture(texture));
        cards.forEach(({ mesh }) => { mesh.visible = true; });
        renderer.compile(scene, camera);
        if (!isCurrent()) return;
        readyPending = () => {
          if (isCurrent()) props().onCardsReadyChange(true);
        };
        invalidate();
      }).catch((error: unknown) => {
        if (!isCurrent()) return;
        props().onCardsError(error instanceof Error ? error : new Error('Unable to load the cards.'));
      });
    },
    commitReady() {
      const reportReady = readyPending;
      readyPending = null;
      reportReady?.();
    },
    updateMaterials() {
      cards.forEach(({ mesh, surface }) => { if (mesh.visible) surface.update(mesh, camera); });
    },
    dispose() {
      disposed = true;
      clearCards();
      geometry.dispose();
    },
  };
}

export type MiNoteCardAssets = ReturnType<typeof createMiNoteCardAssets>;
