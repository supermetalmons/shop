import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
import * as THREE from 'three';
import type { CrateSceneProps } from '../src/ethereum/crate/CrateScene.tsx';
import type { CratePreviewAssets } from '../src/ethereum/crate/crateAssets.ts';
import { CRATE_BOUNDS } from '../src/ethereum/crate/crateModel.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, render } = await import('@testing-library/react');
const frames = new Map<number, FrameRequestCallback>();
let frameSequence = 0;
let time = 1000;
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => {
    const id = ++frameSequence; frames.set(id, callback); return id;
  } });
  Object.defineProperty(target, 'cancelAnimationFrame', { configurable: true, value: (id: number) => frames.delete(id) });
}

class Renderer {
  domElement = document.createElement('canvas');
  capabilities = { getMaxAnisotropy: () => 8 };
  info = { render: { calls: 0, triangles: 0 }, memory: { textures: 0 } };
  debug: { onShaderError?: () => void } = {};
  initialized: THREE.Texture[] = [];
  warmed = new Set<THREE.Texture>();
  scene: THREE.Scene | null = null;
  camera: THREE.Camera | null = null;
  target: THREE.WebGLRenderTarget | null = null;
  disposed = false;
  lost = false;
  shaderFailure: 'compile' | 'render' | null = null;
  renders = 0;
  pixelRatio = 1;
  constructor() { renderers.push(this); }
  setPixelRatio(ratio: number) { this.pixelRatio = ratio; }
  setSize() {}
  setRenderTarget(target: THREE.WebGLRenderTarget | null) { this.target = target; }
  getContext() { return { isContextLost: () => this.lost }; }
  initTexture(texture: THREE.Texture) { assert.equal(this.disposed, false); this.initialized.push(texture); }
  compile() { assert.equal(this.disposed, false); if (this.shaderFailure === 'compile') this.debug.onShaderError?.(); }
  render(scene: THREE.Scene, camera: THREE.Camera) {
    assert.equal(this.disposed, false);
    this.scene = scene;
    this.camera = camera;
    this.renders++;
    if (this.shaderFailure === 'render') this.debug.onShaderError?.();
    if (this.target) scene.traverseVisible(object => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial && object.material.map) this.warmed.add(object.material.map);
    });
  }
  dispose() { this.disposed = true; }
  forceContextLoss() { this.lost = true; }
}

const renderers: Renderer[] = [];
let deferModel = false;
function createModel() {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(CRATE_BOUNDS.width, CRATE_BOUNDS.height, CRATE_BOUNDS.depth), new THREE.MeshBasicMaterial());
  root.add(mesh);
  const model = {
    root, lid: new THREE.Group(), hitMeshes: [mesh], disposed: false, opening: 0, opacity: 1,
    damage: [] as { count: number; point?: THREE.Vector3 }[],
    setDamage(count: number, point?: THREE.Vector3) { model.damage.push({ count, point: point?.clone() }); },
    setOpening(progress: number) { model.opening = progress; },
    setOpacity(opacity: number) { model.opacity = opacity; },
    setRecoil() {},
    dispose() { model.disposed = true; root.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); },
  };
  const pending = Promise.withResolvers<typeof model>();
  modelLoads.push({ model, pending });
  if (!deferModel) pending.resolve(model);
  return pending.promise;
}
const modelLoads: { model: Awaited<ReturnType<typeof createModel>>; pending: ReturnType<typeof Promise.withResolvers<Awaited<ReturnType<typeof createModel>>>> }[] = [];

const bridge = '__ethereumCrateSceneTest';
Object.defineProperty(globalThis, bridge, { configurable: true, value: { Renderer, createModel } });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/crate/CrateScene.tsx')) {
      if (specifier === 'three') return { url: 'test:crate-three', shortCircuit: true };
      if (specifier.endsWith('/crateModel')) return { url: 'test:crate-model', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:crate-three') return { format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(import.meta.resolve('three'))}; export const WebGLRenderer = globalThis.${bridge}.Renderer;` };
    if (url === 'test:crate-model') return { format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(new URL('../src/ethereum/crate/crateModel.ts', import.meta.url).href)}; export const createCrateModel = globalThis.${bridge}.createModel;` };
    return nextLoad(url, context);
  },
});
const { default: CrateScene, crateRenderDensity } = await import('../src/ethereum/crate/CrateScene.tsx');
hooks.deregister();

beforeEach(() => {
  renderers.length = 0;
  modelLoads.length = 0;
  deferModel = false;
  time = 1000;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});
afterEach(async () => {
  cleanup();
  await act(async () => { for (const load of modelLoads) load.pending.resolve(load.model); });
  assert.equal(frames.size, 0);
  assert.ok(renderers.every(renderer => renderer.disposed));
  assert.ok(modelLoads.every(load => load.model.disposed));
});
after(() => { Reflect.deleteProperty(globalThis, bridge); dom.window.close(); });

function advanceFrame(elapsed = 50) {
  act(() => {
    time += elapsed;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(time));
  });
}
function settle() {
  for (let index = 0; frames.size && index < 150; index++) advanceFrame();
  assert.equal(frames.size, 0, 'The scene must stop requesting frames when it is still.');
}
function previews(count = 20): CratePreviewAssets {
  return { items: Array.from({ length: count }, (_, index) => ({ id: String(index), src: `/preview-${index}.webp`,
    name: `Artwork ${index}`, width: index % 2 ? 500 : 800, height: 600, image: document.createElement('canvas') })), release() {} };
}
function harness(overrides: Partial<CrateSceneProps> = {}) {
  const events = { ready: 0, assets: 0, complete: 0, errors: [] as Error[], frames: 0 };
  let props: CrateSceneProps = { assets: null, hit: null, opening: false, active: true, suspended: false, reducedMotion: false,
    viewport: { left: 0, top: 0, width: 1000, height: 800 }, crateRect: { left: 250, top: 200, width: 500, height: 500 * 833 / 1218 },
    onReady: () => { events.ready++; }, onAssetsReady: () => { events.assets++; }, onComplete: () => { events.complete++; },
    onError: error => { events.errors.push(error); }, onFrame: () => { events.frames++; }, ...overrides };
  const view = render(createElement(CrateScene, props));
  return { view, events, update(next: Partial<CrateSceneProps>) { props = { ...props, ...next }; view.rerender(createElement(CrateScene, props)); } };
}
function previewMeshes() {
  const meshes: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  renderers[0].scene!.traverse(object => {
    if (object instanceof THREE.Mesh && object.geometry instanceof THREE.PlaneGeometry && object.material instanceof THREE.MeshBasicMaterial) {
      meshes.push(object as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>);
    }
  });
  return meshes;
}

test('density caps retina work and total pixels on large screens', () => {
  for (const [width, height] of [[320, 568], [844, 390], [1440, 900], [5120, 2880]]) {
    for (const ratio of [1, 1.5, 2, 3, 4]) {
      const density = crateRenderDensity(width, height, ratio);
      assert.ok(density > 0 && density <= 2 && density <= ratio);
      assert.ok(width * height * density ** 2 <= 3_000_000.001);
    }
  }
});

test('a fresh hit ID after a rejected attempt applies another visible crate impact', async () => {
  const run = harness();
  await act(async () => {});
  settle();
  run.update({ hit: { id: 1, x: 0, y: 0 } });
  settle();
  const model = modelLoads[0].model;
  assert.equal(model.damage.length, 1);
  run.update({ hit: null });
  settle();
  run.update({ hit: { id: 2, x: 0.5, y: 0.5 } });
  advanceFrame();
  assert.equal(model.damage.length, 2);
  assert.equal(model.damage[1].count, 2);
  assert.equal(run.view.container.querySelector('[data-animating]')?.getAttribute('data-animating'), 'true');
  settle();
});

for (const count of [20, 31]) test(`${count} preview surfaces are all warmed before readiness and assignment retains the crate`, async () => {
  const run = harness();
  await act(async () => {});
  settle();
  assert.equal(run.events.ready, 1);
  const model = modelLoads[0].model;
  run.update({ assets: previews(count), onAssetsReady: () => {
    assert.equal(renderers[0].initialized.length, count);
    assert.equal(renderers[0].warmed.size, count);
    run.events.assets++;
  } });
  settle();
  assert.equal(run.events.assets, 1);
  assert.equal(modelLoads.length, 1);
  assert.equal(renderers.length, 1);
  assert.equal(model.opening, 0);
  run.update({ opening: true });
  settle();
  assert.equal(run.events.complete, 1);
  assert.equal(model.opacity, 0);
  run.update({ opening: true });
  settle();
  assert.equal(run.events.complete, 1);
  assert.deepEqual(run.events.errors, []);
});

test('a completed reduced-motion reveal stays complete when the motion preference changes', async () => {
  const run = harness({ assets: previews(), opening: true, reducedMotion: true });
  await act(async () => {});
  settle();
  const model = modelLoads[0].model;
  const snapshot = () => previewMeshes().map(mesh => ({ position: mesh.position.toArray(), quaternion: mesh.quaternion.toArray(),
    scale: mesh.scale.toArray(), visible: mesh.visible, opacity: mesh.material.opacity }));
  const completed = snapshot();
  assert.equal(completed.length, 20);
  assert.ok(completed.every(item => item.visible && item.opacity === 1));
  assert.equal(run.events.complete, 1);
  for (const reducedMotion of [false, true]) {
    run.update({ reducedMotion });
    advanceFrame();
    snapshot().forEach((actual, index) => {
      const expected = completed[index];
      for (const key of ['position', 'quaternion', 'scale'] as const) {
        assert.ok(actual[key].every((value, axis) => Math.abs(value - expected[key][axis]) < 1e-9), `Preview ${index + 1} changed ${key}.`);
      }
      assert.equal(actual.visible, expected.visible);
      assert.equal(actual.opacity, expected.opacity);
    });
    assert.equal(model.opacity, 0);
    assert.equal(model.opening, 1);
    assert.equal(frames.size, 0, 'Changing the preference must not restart the completed animation.');
    assert.equal(run.events.complete, 1);
  }
  assert.deepEqual(run.events.errors, []);
});

for (const count of [20, 31]) for (const [width, height] of [[1440, 900], [390, 844], [844, 390]]) {
  test(`${count} preview quads stay outside the crate after clearing its rim at ${width}x${height}`, async () => {
    const crateWidth = Math.min(width * 0.76, height * 0.42 * 1218 / 833, 700);
    const crateHeight = crateWidth * 833 / 1218;
    const run = harness({ assets: previews(count), inspectionTime: 0,
      viewport: { left: 0, top: 0, width, height },
      crateRect: { left: (width - crateWidth) / 2, top: height * 0.56 - crateHeight / 2, width: crateWidth, height: crateHeight } });
    await act(async () => {});
    settle();
    const cards = previewMeshes();
    assert.equal(cards.length, count);
    const half = new THREE.Vector3(CRATE_BOUNDS.width, CRATE_BOUNDS.height, CRATE_BOUNDS.depth).multiplyScalar(0.5);
    const body = new THREE.Box3(half.clone().negate(), half);
    const cleared = new Set<THREE.Mesh>();
    for (let elapsed = 0; elapsed <= 2150; elapsed += 25) {
      run.update({ inspectionTime: elapsed });
      advanceFrame(25);
      renderers[0].scene!.updateMatrixWorld(true);
      for (const [index, card] of cards.entries()) {
        if (!card.visible) continue;
        const positions = card.geometry.getAttribute('position');
        const corners = Array.from({ length: positions.count }, (_, vertex) =>
          new THREE.Vector3().fromBufferAttribute(positions, vertex).applyMatrix4(card.matrixWorld));
        if (corners.every(corner => corner.y > body.max.y)) cleared.add(card);
        if (!cleared.has(card) || modelLoads[0].model.opacity <= 0) continue;
        const indices = card.geometry.index!;
        for (let vertex = 0; vertex < indices.count; vertex += 3) {
          const triangle = new THREE.Triangle(corners[indices.getX(vertex)], corners[indices.getX(vertex + 1)], corners[indices.getX(vertex + 2)]);
          assert.equal(body.intersectsTriangle(triangle), false, `Preview ${index + 1} re-enters the crate at ${elapsed}ms.`);
        }
      }
    }
    assert.equal(cleared.size, count, 'Every preview must fully clear the rim.');
    assert.deepEqual(run.events.errors, []);
  });
}

test('suspension defers GPU work and preserves opening progress across a long pause', async () => {
  const run = harness({ assets: previews(), suspended: true });
  await act(async () => {});
  assert.equal(frames.size, 0);
  assert.equal(renderers[0].initialized.length, 0);
  assert.equal(run.events.assets, 0);
  run.update({ suspended: false });
  settle();
  run.update({ opening: true });
  for (let index = 0; index < 8; index++) advanceFrame();
  const progress = modelLoads[0].model.opening;
  assert.ok(progress > 0 && progress < 1);
  run.update({ suspended: true });
  assert.equal(frames.size, 0);
  time += 5000;
  run.update({ suspended: false });
  advanceFrame();
  assert.equal(modelLoads[0].model.opening, progress);
  assert.equal(run.events.complete, 0);
  settle();
  assert.equal(run.events.complete, 1);
});

test('partial GPU warming stays gated and replacement previews discard obsolete resources', async () => {
  const run = harness({ assets: previews(31), opening: true });
  await act(async () => {});
  advanceFrame();
  assert.equal(renderers[0].initialized.length, 2);
  assert.equal(run.events.assets, 0);
  assert.equal(modelLoads[0].model.opening, 0);
  const oldTextures: THREE.Texture[] = [];
  renderers[0].scene!.traverse(object => {
    if (object instanceof THREE.Mesh && object.geometry instanceof THREE.PlaneGeometry && object.material.map) oldTextures.push(object.material.map);
  });
  assert.equal(oldTextures.length, 31);
  let disposed = 0;
  oldTextures.forEach(texture => texture.addEventListener('dispose', () => disposed++));
  run.update({ assets: previews(20) });
  assert.equal(disposed, 31);
  settle();
  assert.equal(run.events.assets, 1);
  assert.equal(run.events.complete, 1);
  assert.equal(renderers.length, 1);
  assert.equal(modelLoads.length, 1);
});

test('hidden documents stop drawing and do not consume the opening timeline', async () => {
  const run = harness({ assets: previews(), opening: true });
  await act(async () => {});
  for (let index = 0; index < 8; index++) advanceFrame();
  const progress = modelLoads[0].model.opening;
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  assert.equal(frames.size, 0);
  time += 8000;
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  advanceFrame();
  assert.equal(modelLoads[0].model.opening, progress);
  settle();
  assert.equal(run.events.complete, 1);
});

for (const stage of ['compile', 'render'] as const) test(`${stage} failure during preparation prevents ready callbacks and disposes the scene`, async () => {
  const run = harness();
  await act(async () => {});
  settle();
  renderers[0].shaderFailure = stage;
  run.update({ assets: previews() });
  settle();
  assert.equal(run.events.assets, 0);
  assert.equal(run.events.complete, 0);
  assert.equal(run.events.errors.length, 1);
  assert.equal(renderers[0].disposed, true);
});

test('context loss before model resolution ignores and disposes the late model', async () => {
  deferModel = true;
  const run = harness({ assets: previews(), opening: true });
  act(() => renderers[0].domElement.dispatchEvent(new window.Event('webglcontextlost', { cancelable: true })));
  await act(async () => modelLoads[0].pending.resolve(modelLoads[0].model));
  assert.equal(run.events.errors.length, 1);
  assert.equal(run.events.ready, 0);
  assert.equal(run.events.assets, 0);
  assert.equal(run.events.complete, 0);
  assert.equal(modelLoads[0].model.disposed, true);
});

test('unmount releases all preview textures and ignores a late model success', async () => {
  const run = harness({ assets: previews() });
  await act(async () => {});
  settle();
  let released = 0;
  const textures = [...renderers[0].initialized];
  textures.forEach(texture => texture.addEventListener('dispose', () => released++));
  run.view.unmount();
  assert.equal(released, textures.length);
  assert.equal(renderers[0].disposed, true);
  deferModel = true;
  const pending = harness();
  pending.view.unmount();
  await act(async () => modelLoads[1].pending.resolve(modelLoads[1].model));
  assert.equal(modelLoads[1].model.disposed, true);
  assert.equal(pending.events.ready, 0);
  assert.equal(pending.events.frames, 0);
});
