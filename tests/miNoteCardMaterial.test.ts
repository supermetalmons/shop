import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { CARD_NFT_2_NEUTRAL_CARD_EFFECT, DRIF_EFFECTS, DRIF_GRAIN_URL, type DrifCardConfig } from '../src/drifCards.ts';
import { createMiNoteCardMaterial } from '../src/lib/miNoteCardMaterial.ts';

const card: DrifCardConfig = {
  imageSrc: 'front.webp',
  foilSrc: 'foil.webp',
  textureSrc: 'mask.webp',
  effect: DRIF_EFFECTS['swshp-SWSH179']!,
};

function textureLoader() {
  const textures = new Map<string, THREE.Texture>();
  const disposals = new Map<string, number>();
  const requests: string[] = [];
  return {
    requests,
    textures,
    disposals,
    loadTexture: async (source: string) => {
      requests.push(source);
      const texture = new THREE.Texture({ width: 1000, height: 1400 });
      texture.addEventListener('dispose', () => disposals.set(source, (disposals.get(source) ?? 0) + 1));
      textures.set(source, texture);
      return texture;
    },
  };
}

test('live effect selection reuses the same material and textures with CSS color handling', async () => {
  const loader = textureLoader();
  const result = createMiNoteCardMaterial(card, loader);
  assert.equal(loader.requests.length, 0);
  await result.setEffect(card.effect);
  const material = result.material;
  assert.deepEqual(loader.requests, [card.imageSrc, card.textureSrc, DRIF_GRAIN_URL]);
  assert.equal(material.toneMapped, false);
  assert.deepEqual(material.uniforms.uCardSize!.value.toArray(), [300, 420]);
  for (const texture of loader.textures.values()) {
    assert.equal(texture.colorSpace, THREE.NoColorSpace);
    assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
    assert.equal(texture.generateMipmaps, true);
  }
  await result.setEffect(DRIF_EFFECTS['swsh6-196']!);
  assert.equal(material.uniforms.uEffect!.value, 1);
  await result.setEffect(CARD_NFT_2_NEUTRAL_CARD_EFFECT);
  assert.equal(material.uniforms.uEffect!.value, 2);
  await result.setEffect(card.effect);
  assert.equal(material.uniforms.uEffect!.value, 0);
  assert.equal(loader.requests.length, 4);
  assert.equal(result.material, material);
  assert.equal(loader.textures.get(DRIF_GRAIN_URL)!.wrapS, THREE.RepeatWrapping);
  result.dispose();
});

test('lighting works with a front-only card without loading unused textures', async () => {
  const loader = textureLoader();
  const result = createMiNoteCardMaterial({
    imageSrc: card.imageSrc,
    effect: CARD_NFT_2_NEUTRAL_CARD_EFFECT,
  }, loader);
  await result.setEffect(CARD_NFT_2_NEUTRAL_CARD_EFFECT);
  assert.deepEqual(loader.requests, [card.imageSrc]);
  assert.equal(result.material.uniforms.uFront!.value, loader.textures.get(card.imageSrc));
  assert.equal(result.material.uniforms.uEffect!.value, 2);
  result.dispose();
});

test('Trainer loads front, mask, and foil without requesting grain', async () => {
  const loader = textureLoader();
  const result = createMiNoteCardMaterial(card, loader);
  await result.setEffect(DRIF_EFFECTS['swsh6-196']!);
  assert.deepEqual(loader.requests, [card.imageSrc, card.textureSrc, card.foilSrc]);
  assert.equal(result.material.uniforms.uEffect!.value, 1);
  result.dispose();
});

for (const failedSource of ['foil.webp', 'mask.webp']) {
  test(`lighting recovers from failed ${failedSource} and reuses successful textures on retry`, async () => {
    const loader = textureLoader();
    const requests: string[] = [];
    const result = createMiNoteCardMaterial(card, {
      loadTexture: (source) => {
        requests.push(source);
        if (source === failedSource && requests.filter((request) => request === source).length === 1) {
          return Promise.reject(new Error(`Failed ${source}`));
        }
        return loader.loadTexture(source);
      },
    });
    const material = result.material;
    await assert.rejects(result.setEffect(DRIF_EFFECTS['swsh6-196']!), /Failed/);
    const front = material.uniforms.uFront!.value;
    assert.equal(front, loader.textures.get(card.imageSrc));
    assert.equal(loader.disposals.size, 0);
    await result.setEffect(CARD_NFT_2_NEUTRAL_CARD_EFFECT);
    assert.equal(result.material, material);
    assert.equal(material.uniforms.uFront!.value, front);
    assert.equal(material.uniforms.uEffect!.value, 2);
    assert.equal(requests.length, 3);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1, 0, 5);
    result.update(new THREE.Object3D(), camera);
    assert.ok(material.uniforms.uPointer!.value.x > 0.5);
    await result.setEffect(DRIF_EFFECTS['swsh6-196']!);
    assert.equal(material.uniforms.uEffect!.value, 1);
    assert.equal(material.uniforms.uFront!.value, front);
    assert.deepEqual(requests, [card.imageSrc, card.textureSrc, card.foilSrc, failedSource]);
    result.dispose();
    await Promise.resolve();
    assert.equal(loader.disposals.size, 3);
    assert.ok([...loader.disposals.values()].every((count) => count === 1));
  });
}

test('a pending effect preserves current rendering and cannot override a newer lighting request', async () => {
  const pending = new Map<string, (texture: THREE.Texture) => void>();
  const front = new THREE.Texture();
  const result = createMiNoteCardMaterial(card, {
    loadTexture: (source) => source === card.imageSrc ? Promise.resolve(front) : new Promise((resolve) => {
      pending.set(source, resolve);
    }),
  });
  await result.setEffect(CARD_NFT_2_NEUTRAL_CARD_EFFECT);
  const trainerReady = result.setEffect(DRIF_EFFECTS['swsh6-196']!);
  assert.equal(result.material.uniforms.uEffect!.value, 2);
  await result.setEffect(CARD_NFT_2_NEUTRAL_CARD_EFFECT);
  assert.equal(result.material.uniforms.uEffect!.value, 2);
  assert.equal(pending.size, 2);
  pending.forEach((resolve) => resolve(new THREE.Texture()));
  await trainerReady;
  assert.equal(result.material.uniforms.uEffect!.value, 2);
  assert.equal(result.material.uniforms.uFront!.value, front);
  await result.setEffect(DRIF_EFFECTS['swsh6-196']!);
  assert.equal(result.material.uniforms.uEffect!.value, 1);
  result.dispose();
});

test('shared textures survive until the final card releases them', async () => {
  const loader = textureLoader();
  const first = createMiNoteCardMaterial(card, loader);
  const second = createMiNoteCardMaterial(card, loader);
  await Promise.all([first.setEffect(card.effect), second.setEffect(card.effect)]);
  assert.equal(loader.requests.length, 3);
  assert.equal(first.material.uniforms.uFront!.value, second.material.uniforms.uFront!.value);
  first.dispose();
  first.dispose();
  assert.equal(loader.disposals.size, 0);
  second.dispose();
  await Promise.resolve();
  assert.equal(loader.disposals.size, 3);
  assert.ok([...loader.disposals.values()].every((count) => count === 1));
});

test('disposing a card while assets are loading also disposes late textures', async () => {
  const pending: (() => void)[] = [];
  let disposals = 0;
  const result = createMiNoteCardMaterial(card, {
    loadTexture: () => new Promise((resolve) => {
      const texture = new THREE.Texture();
      texture.addEventListener('dispose', () => { disposals += 1; });
      pending.push(() => resolve(texture));
    }),
  });
  const ready = result.setEffect(card.effect);
  result.dispose();
  pending.forEach((resolve) => resolve());
  await ready;
  assert.equal(disposals, 3);
});

test('disposing a failed card preserves another card’s shared textures', async () => {
  const pending = new Map<string, { resolve: (texture: THREE.Texture) => void; reject: (error: Error) => void }>();
  const disposals = new Map<string, number>();
  const loader = {
    loadTexture: (source: string) => new Promise<THREE.Texture>((resolve, reject) => {
      pending.set(source, { resolve, reject });
    }),
  };
  const first = createMiNoteCardMaterial(card, loader);
  const second = createMiNoteCardMaterial({ ...card, imageSrc: 'second.webp' }, loader);
  const rejection = assert.rejects(first.setEffect(card.effect), /Failed first card/);
  const secondReady = second.setEffect(card.effect);
  pending.get(card.imageSrc)!.reject(new Error('Failed first card'));
  await rejection;
  assert.equal(pending.size, 4);
  for (const [source, request] of pending) {
    if (source === card.imageSrc) continue;
    const texture = new THREE.Texture();
    texture.addEventListener('dispose', () => disposals.set(source, (disposals.get(source) ?? 0) + 1));
    request.resolve(texture);
  }
  await secondReady;
  assert.equal(disposals.size, 0);
  first.dispose();
  assert.equal(disposals.size, 0);
  second.dispose();
  await Promise.resolve();
  assert.equal(disposals.size, 3);
  assert.ok([...disposals.values()].every((count) => count === 1));
});

test('failed effects retain loaded textures and release pending textures on disposal', async () => {
  const pending: ((texture: THREE.Texture) => void)[] = [];
  let rejectFront!: (error: Error) => void;
  let disposals = 0;
  const result = createMiNoteCardMaterial(card, {
    loadTexture: (source) => new Promise((resolve, reject) => {
      if (source === card.imageSrc) rejectFront = reject;
      else pending.push(resolve);
    }),
  });
  const resolveTexture = (resolve: (texture: THREE.Texture) => void) => {
    const texture = new THREE.Texture();
    texture.addEventListener('dispose', () => { disposals += 1; });
    resolve(texture);
  };
  const rejection = assert.rejects(result.setEffect(card.effect), /Failed front/);
  resolveTexture(pending.shift()!);
  rejectFront(new Error('Failed front'));
  await rejection;
  assert.equal(disposals, 0);
  result.dispose();
  await Promise.resolve();
  assert.equal(disposals, 1);
  pending.forEach(resolveTexture);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposals, 2);
});

test('stalled textures time out, dispose late responses, and can be retried', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pending: ((texture: THREE.Texture) => void)[] = [];
  let disposals = 0;
  const result = createMiNoteCardMaterial(card, {
    loadTexture: () => new Promise((resolve) => { pending.push(resolve); }),
  });
  const rejection = assert.rejects(result.setEffect(card.effect), /Timed out loading card texture/);
  context.mock.timers.tick(30_000);
  await rejection;
  for (const resolve of pending) {
    const texture = new THREE.Texture();
    texture.addEventListener('dispose', () => { disposals += 1; });
    resolve(texture);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposals, 3);
  const retry = result.setEffect(CARD_NFT_2_NEUTRAL_CARD_EFFECT);
  assert.equal(pending.length, 4);
  const front = new THREE.Texture();
  front.addEventListener('dispose', () => { disposals += 1; });
  pending[3]!(front);
  await retry;
  assert.equal(result.material.uniforms.uFront!.value, front);
  result.dispose();
  await Promise.resolve();
  assert.equal(disposals, 4);
});

test('foil response follows card orientation and camera position through parent transforms', async () => {
  const result = createMiNoteCardMaterial(card, textureLoader());
  await result.setEffect(card.effect);
  const camera = new THREE.PerspectiveCamera();
  camera.position.z = 5;
  const parent = new THREE.Group();
  const mesh = new THREE.Object3D();
  parent.add(mesh);
  result.update(mesh, camera);
  const pointer = result.material.uniforms.uPointer!.value as THREE.Vector2;
  assert.deepEqual(pointer.toArray(), [0.5, 0.5]);
  parent.rotation.y = 0.1;
  result.update(mesh, camera);
  assert.ok(pointer.x < 0.5);
  camera.position.y = 1;
  result.update(mesh, camera);
  assert.ok(pointer.y < 0.5);
  assert.ok(result.material.uniforms.uPointerFromCenter!.value > 0);
  assert.equal(result.material.uniforms.uEffect!.value, 0);
  result.dispose();
});
