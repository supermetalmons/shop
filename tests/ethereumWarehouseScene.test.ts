import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
import * as THREE from 'three';
import type { WarehouseSceneProps } from '../src/ethereum/warehouse/WarehouseScene.tsx';
import type { CratePreviewAssets } from '../src/ethereum/crate/crateAssets.ts';
import { WAREHOUSE_BOUNDS } from '../src/ethereum/warehouse/warehouseModel.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, render } = await import('@testing-library/react');
const frames = new Map<number, FrameRequestCallback>();
let frameSequence = 0;
let time = 1000;
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => {
    const id = ++frameSequence;
    frames.set(id, callback);
    return id;
  } });
  Object.defineProperty(target, 'cancelAnimationFrame', { configurable: true, value: (id: number) => frames.delete(id) });
}

class Renderer {
  domElement = document.createElement('canvas');
  info = { render: { calls: 0, triangles: 0 }, memory: { textures: 0 } };
  debug: { onShaderError?: () => void } = {};
  initialized: THREE.Texture[] = [];
  warmed = new Set<THREE.Texture>();
  scene: THREE.Scene | null = null;
  camera: THREE.Camera | null = null;
  target: THREE.WebGLRenderTarget | null = null;
  disposed = false;
  disposals = 0;
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
  compile() {
    assert.equal(this.disposed, false);
    compilations.push(this);
    if (this.shaderFailure === 'compile') this.debug.onShaderError?.();
  }
  render(scene: THREE.Scene, camera: THREE.Camera) {
    assert.equal(this.disposed, false);
    this.scene = scene;
    this.camera = camera;
    this.renders++;
    if (this.shaderFailure === 'render') this.debug.onShaderError?.();
    if (this.target) scene.traverseVisible(object => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial && object.material.map) {
        this.warmed.add(object.material.map);
      }
    });
  }
  dispose() { this.disposed = true; this.disposals++; }
  forceContextLoss() { this.lost = true; }
}

const renderers: Renderer[] = [];
let deferModel = false;
const compilations: Renderer[] = [];
function createModel() {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(WAREHOUSE_BOUNDS.width, WAREHOUSE_BOUNDS.height, WAREHOUSE_BOUNDS.depth), new THREE.MeshBasicMaterial());
  root.add(mesh);
  const model = {
    root, hitMeshes: [mesh], disposed: false, disposals: 0, fracture: 0, opacity: 1,
    damage: [] as { count: number; point?: THREE.Vector3 }[],
    setDamage(count: number, point?: THREE.Vector3) { model.damage.push({ count, point: point?.clone() }); },
    setFracture(progress: number) {
      model.fracture = progress;
      mesh.position.x = progress * 6;
      mesh.rotation.y = progress * 0.7;
    },
    setOpacity(opacity: number) { model.opacity = opacity; root.visible = opacity > 0; },
    setRecoil(x: number, y: number, amount: number) {
      root.rotation.set(y * amount * 0.1, x * amount * 0.15, -x * amount * 0.08);
      root.position.set(-x * amount * 0.05, -Math.abs(amount) * 0.02, -amount * 0.08);
    },
    dispose() {
      model.disposed = true;
      model.disposals++;
      root.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
  const pending = Promise.withResolvers<typeof model>();
  modelLoads.push({ model, pending });
  if (!deferModel) pending.resolve(model);
  return pending.promise;
}
const modelLoads: { model: Awaited<ReturnType<typeof createModel>>; pending: ReturnType<typeof Promise.withResolvers<Awaited<ReturnType<typeof createModel>>>> }[] = [];

function createCrates(count: number, image: NonNullable<WarehouseSceneProps['crateImage']>) {
  const root = new THREE.Group();
  const texture = new THREE.CanvasTexture(image.image);
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const batch = new THREE.InstancedMesh(geometry, material, count);
  root.add(batch);
  const value = {
    root, count, texture, matrices: Array.from({ length: count }, () => new THREE.Matrix4()),
    bounds: new THREE.Box3(new THREE.Vector3(-1.8, -1.1, -1.2), new THREE.Vector3(1.8, 1, 1.2)),
    disposed: false, disposals: 0, opacity: 1, commits: 0,
    setMatrixAt(index: number, matrix: THREE.Matrix4) {
      value.matrices[index].copy(matrix);
      batch.setMatrixAt(index, matrix);
    },
    commit() { value.commits++; batch.instanceMatrix.needsUpdate = true; },
    setOpacity(opacity: number) { value.opacity = opacity; root.visible = opacity > 0; },
    dispose() {
      value.disposed = true;
      value.disposals++;
      root.removeFromParent();
      batch.dispose();
      material.dispose();
      geometry.dispose();
      texture.dispose();
    },
  };
  crateLoads.push({ value, image });
  return value;
}
const crateLoads: { value: ReturnType<typeof createCrates>; image: NonNullable<WarehouseSceneProps['crateImage']> }[] = [];

const bridge = '__ethereumWarehouseSceneTest';
Object.defineProperty(globalThis, bridge, { configurable: true, value: { Renderer, createModel, createCrates } });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/warehouse/WarehouseScene.tsx')) {
      if (specifier === 'three') return { url: 'test:warehouse-three', shortCircuit: true };
      if (specifier.endsWith('/warehouseModel')) return { url: 'test:warehouse-model', shortCircuit: true };
      if (specifier.endsWith('/crateSprites')) return { url: 'test:warehouse-crates', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:warehouse-three') return { format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(import.meta.resolve('three'))}; export const WebGLRenderer = globalThis.${bridge}.Renderer;` };
    if (url === 'test:warehouse-model') return { format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(new URL('../src/ethereum/warehouse/warehouseModel.ts', import.meta.url).href)}; export const createWarehouseModel = globalThis.${bridge}.createModel;` };
    if (url === 'test:warehouse-crates') return { format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(new URL('../src/ethereum/warehouse/crateSprites.ts', import.meta.url).href)}; export const createCrateSprites = globalThis.${bridge}.createCrates;` };
    return nextLoad(url, context);
  },
});
const { default: WarehouseScene } = await import('../src/ethereum/warehouse/WarehouseScene.tsx');
hooks.deregister();

beforeEach(() => {
  renderers.length = 0;
  modelLoads.length = 0;
  crateLoads.length = 0;
  deferModel = false;
  compilations.length = 0;
  time = 1000;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    for (const load of modelLoads) load.pending.resolve(load.model);
  });
  assert.equal(frames.size, 0);
  assert.ok(renderers.every(renderer => renderer.disposed && renderer.disposals === 1));
  assert.ok(modelLoads.every(load => load.model.disposed && load.model.disposals === 1));
  assert.ok(crateLoads.every(load => load.value.disposed && load.value.disposals === 1));
});
after(() => { Reflect.deleteProperty(globalThis, bridge); dom.window.close(); });

async function advanceFrame(elapsed = 50) {
  await act(async () => {
    time += elapsed;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(time));
  });
}
async function settle() {
  await act(async () => {});
  for (let index = 0; frames.size && index < 180; index++) await advanceFrame();
  assert.equal(frames.size, 0, 'The warehouse must stop requesting frames when it is still.');
}
function crateImage(): NonNullable<WarehouseSceneProps['crateImage']> {
  const image = document.createElement('canvas');
  image.width = 512;
  image.height = 350;
  return { image, width: 1448, height: 1086, release() {} };
}
function previews(count = 11): CratePreviewAssets {
  const image = document.createElement('canvas');
  return { items: Array.from({ length: count }, (_, index) => ({ id: String(index), src: '/crate.webp',
    name: `Crate ${index + 1}`, width: 1448, height: 1086, image })), release() {} };
}
const hits = [{ id: 1, x: -0.3, y: -0.1 }, { id: 2, x: 0.3, y: 0.1 }, { id: 3, x: 0, y: 0 }];
function harness(overrides: Partial<WarehouseSceneProps> = {}) {
  const events = { ready: 0, assets: 0, complete: 0, errors: [] as Error[], frames: 0,
    impacts: [] as { critical: boolean; time: number; fracture: number }[] };
  let props: WarehouseSceneProps = {
    assets: null, crateImage: crateImage(), hits: [], opening: false, active: true, suspended: false, reducedMotion: false,
    viewport: { left: 0, top: 0, width: 1000, height: 800 },
    containerRect: { left: 300, top: 200, width: 400, height: 400 * 1024 / 1536 },
    onReady: () => { events.ready++; }, onAssetsReady: () => { events.assets++; }, onComplete: () => { events.complete++; },
    onError: error => { events.errors.push(error); }, onFrame: () => { events.frames++; },
    onImpact: critical => { events.impacts.push({ critical, time, fracture: modelLoads[0].model.fracture }); }, ...overrides,
  };
  const view = render(createElement(WarehouseScene, props));
  return { view, events, update(next: Partial<WarehouseSceneProps>) { props = { ...props, ...next }; view.rerender(createElement(WarehouseScene, props)); } };
}

test('warehouse prepares one shared sprite texture before confirmation and stops rendering at rest', async () => {
  const run = harness();
  await act(async () => {});
  await settle();
  assert.equal(run.events.ready, 1);
  assert.equal(run.events.assets, 1);
  assert.equal(renderers[0].initialized.length, 1);
  assert.ok(renderers[0].warmed.has(crateLoads[0].value.texture));
  assert.equal(crateLoads[0].value.count, 11);
  assert.equal(modelLoads.length, 1);
  assert.equal(renderers.length, 1);
  assert.equal(run.events.complete, 0);
  assert.equal(modelLoads[0].model.fracture, 0);
  assert.deepEqual(run.events.errors, []);
});

test('three rapid queued hits retain both normal contacts before one critical contact and completion', async () => {
  const run = harness({ assets: previews(), hits, opening: true });
  await act(async () => {});
  await settle();
  assert.deepEqual(run.events.impacts.map(event => event.critical), [false, false, true]);
  assert.ok(run.events.impacts.every(event => event.fracture === 0), 'No shell fracture can precede the critical contact.');
  assert.ok(run.events.impacts[1].time > run.events.impacts[0].time);
  assert.ok(run.events.impacts[2].time > run.events.impacts[1].time);
  assert.deepEqual(modelLoads[0].model.damage.map(event => event.count), [1, 2, 3]);
  assert.equal(modelLoads[0].model.fracture, 1);
  assert.equal(run.events.complete, 1);
  run.update({ opening: true, hits: [...hits] });
  await settle();
  assert.equal(run.events.complete, 1);
  assert.equal(run.events.impacts.length, 3);
  assert.deepEqual(run.events.errors, []);
});

test('hits respond while confirmation is pending, then the ready critical strike runs once', async () => {
  const run = harness({ hits });
  await act(async () => {});
  await settle();
  assert.deepEqual(run.events.impacts.map(event => event.critical), [false, false]);
  assert.equal(modelLoads[0].model.fracture, 0);
  assert.equal(run.events.complete, 0);
  assert.equal(renderers[0].scene!.getObjectByName('warehouse-ice-meteor')!.visible, false);
  assert.equal(frames.size, 0);
  const preparedTextures = renderers[0].initialized.length;
  const preparedCompilations = compilations.length;
  run.update({ assets: previews(), opening: true });
  await act(async () => {});
  await settle();
  assert.deepEqual(run.events.impacts.map(event => event.critical), [false, false, true]);
  assert.equal(run.events.complete, 1);
  assert.equal(crateLoads.length, 1);
  assert.equal(renderers[0].initialized.length, preparedTextures);
  assert.equal(compilations.length, preparedCompilations);
});

test('a requested critical strike cannot start before confirmed results arrive', async () => {
  const run = harness({ hits, opening: true });
  await settle();
  assert.equal(run.events.assets, 1);
  assert.equal(run.events.complete, 0);
  assert.deepEqual(run.events.impacts.map(event => event.critical), [false, false]);
  assert.equal(modelLoads[0].model.fracture, 0);
  assert.equal(renderers[0].scene!.getObjectByName('warehouse-ice-meteor')!.visible, false);
  run.update({ assets: previews() });
  await settle();
  assert.equal(run.events.complete, 1);
  assert.equal(crateLoads.length, 1);
});

test('staged GPU preparation gates the critical strike and pauses between warming frames', async () => {
  const run = harness({ assets: previews(), hits, opening: true, suspended: true });
  await act(async () => {});
  assert.equal(renderers[0].initialized.length, 0);
  run.update({ suspended: false });
  await advanceFrame();
  assert.equal(renderers[0].initialized.length, 1);
  assert.equal(run.events.assets, 0);
  assert.equal(run.events.complete, 0);
  assert.ok(run.events.impacts.every(event => !event.critical));
  assert.equal(modelLoads[0].model.fracture, 0);
  run.update({ suspended: true });
  time += 5000;
  assert.equal(frames.size, 0);
  assert.equal(run.events.assets, 0);
  run.update({ suspended: false });
  await settle();
  assert.equal(run.events.assets, 1);
  assert.equal(run.events.complete, 1);
  assert.deepEqual(run.events.impacts.map(event => event.critical), [false, false, true]);
});

test('settled sprite planes face the camera and retain one shared batch', async () => {
  const run = harness({ assets: previews(), hits, opening: true });
  await settle();
  const camera = renderers[0].camera!;
  const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  for (const matrix of crateLoads[0].value.matrices) {
    matrix.decompose(position, rotation, scale);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
    assert.ok(normal.dot(facing) > 0.99999, 'Every image plane must face the camera.');
    assert.ok(scale.x > 0 && scale.y > 0);
  }
  assert.equal(crateLoads[0].value.root.children.length, 1);
  assert.equal(run.events.complete, 1);
  assert.equal(frames.size, 0);
});

test('resetting rejected hits clears damage and permits a new three-hit sequence', async () => {
  const run = harness({ hits: hits.slice(0, 2) });
  await act(async () => {});
  await settle();
  run.update({ hits: [] });
  await settle();
  assert.equal(modelLoads[0].model.damage.at(-1)?.count, 0);
  run.update({ hits, assets: previews(), opening: true });
  await act(async () => {});
  await settle();
  assert.deepEqual(run.events.impacts.map(event => event.critical), [false, false, false, false, true]);
  assert.equal(run.events.complete, 1);
});

test('suspension defers GPU preparation and freezes the opening across a long pause', async () => {
  const run = harness({ assets: previews(), hits, opening: true, suspended: true });
  await act(async () => {});
  assert.equal(frames.size, 0);
  assert.equal(renderers[0].initialized.length, 0);
  assert.equal(run.events.assets, 0);
  run.update({ suspended: false });
  for (let index = 0; index < 45; index++) await advanceFrame();
  const fracture = modelLoads[0].model.fracture;
  assert.ok(fracture > 0 && fracture < 1);
  const matrices = crateLoads[0].value.matrices.map(matrix => matrix.toArray());
  run.update({ suspended: true });
  assert.equal(frames.size, 0);
  time += 5000;
  run.update({ suspended: false });
  await advanceFrame();
  assert.equal(modelLoads[0].model.fracture, fracture);
  assert.deepEqual(crateLoads[0].value.matrices.map(matrix => matrix.toArray()), matrices);
  assert.equal(run.events.complete, 0);
  await settle();
  assert.equal(run.events.complete, 1);
});

test('unrelated React updates do not freeze the active opening clock', async () => {
  const run = harness({ assets: previews(), hits, opening: true });
  await act(async () => {});
  const model = modelLoads[0].model;
  for (let index = 0; model.fracture === 0 && index < 100; index++) await advanceFrame(25);
  assert.ok(model.fracture > 0 && model.fracture < 1);
  let previous = model.fracture;
  for (let index = 0; index < 8; index++) {
    run.update({ onFrame: () => {} });
    await advanceFrame(25);
    assert.ok(model.fracture > previous, 'A parent update must not discard the next frame interval.');
    previous = model.fracture;
  }
  await settle();
  assert.equal(run.events.complete, 1);
});

test('hidden documents pause hits and opening without consuming animation time', async () => {
  const run = harness({ assets: previews(), hits, opening: true });
  await act(async () => {});
  for (let index = 0; index < 45; index++) await advanceFrame();
  const fracture = modelLoads[0].model.fracture;
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  assert.equal(frames.size, 0);
  time += 10000;
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  await advanceFrame();
  assert.equal(modelLoads[0].model.fracture, fracture);
  assert.equal(run.events.complete, 0);
  await settle();
  assert.equal(run.events.complete, 1);
});

test('a contacted normal hit cannot replay its meteor after a paused motion preference change', async () => {
  const run = harness({ reducedMotion: true });
  await settle();
  run.update({ hits: hits.slice(0, 1) });
  await advanceFrame();
  await advanceFrame(50);
  assert.equal(run.events.impacts.length, 1);
  run.update({ suspended: true });
  run.update({ reducedMotion: false });
  run.update({ suspended: false });
  for (let index = 0; index < 12; index++) {
    await advanceFrame();
    assert.equal(renderers[0].scene!.getObjectByName('warehouse-ice-meteor')!.visible, false);
  }
  await settle();
  assert.deepEqual(run.events.impacts.map(event => event.critical), [false]);
  assert.deepEqual(modelLoads[0].model.damage.map(event => event.count), [1]);
});

test('reduced motion finishes on the same pile and never restarts after preference changes', async () => {
  const run = harness({ assets: previews(), hits, opening: true, reducedMotion: true });
  await act(async () => {});
  await settle();
  assert.equal(run.events.complete, 1);
  assert.equal(modelLoads[0].model.opacity, 0);
  const matrices = crateLoads[0].value.matrices.map(matrix => matrix.toArray());
  for (const reducedMotion of [false, true]) {
    run.update({ reducedMotion });
    await settle();
    crateLoads[0].value.matrices.forEach((matrix, index) => {
      assert.ok(matrix.elements.every((value, axis) => Math.abs(value - matrices[index][axis]) < 1e-9));
    });
    assert.equal(run.events.complete, 1);
    assert.equal(run.events.impacts.length, 3);
  }
});

test('disabling reduced motion during its dissolve cannot restore the warehouse or hide the pile', async () => {
  const run = harness({ assets: previews(), hits, opening: true, reducedMotion: true });
  await act(async () => {});
  for (let index = 0; index < 8; index++) await advanceFrame();
  const model = modelLoads[0].model;
  const crates = crateLoads[0].value;
  assert.ok(model.opacity > 0 && model.opacity < 1);
  assert.ok(crates.opacity > 0 && crates.opacity < 1);
  const opacity = model.opacity;
  const matrices = crates.matrices.map(matrix => matrix.toArray());
  run.update({ reducedMotion: false });
  await advanceFrame();
  assert.ok(model.opacity <= opacity, 'The warehouse can continue fading but must not reappear.');
  assert.equal(crates.root.visible, true);
  assert.deepEqual(crates.matrices.map(matrix => matrix.toArray()), matrices);
  assert.equal(renderers[0].scene!.getObjectByName('warehouse-ice-meteor')!.visible, false);
  await settle();
  assert.equal(run.events.complete, 1);
  assert.equal(model.opacity, 0);
  assert.deepEqual(run.events.impacts.map(event => event.critical), [false, false, true]);
});

test('enabling reduced motion during destruction completes without replaying motion or impact sounds', async () => {
  const run = harness({ assets: previews(), hits, opening: true });
  await act(async () => {});
  for (let index = 0; index < 45; index++) await advanceFrame();
  assert.ok(modelLoads[0].model.fracture > 0 && modelLoads[0].model.fracture < 1);
  assert.equal(run.events.complete, 0);
  run.update({ reducedMotion: true });
  await advanceFrame();
  assert.equal(run.events.complete, 1);
  assert.equal(modelLoads[0].model.opacity, 0);
  const matrices = crateLoads[0].value.matrices.map(matrix => matrix.toArray());
  run.update({ reducedMotion: false });
  await settle();
  assert.deepEqual(crateLoads[0].value.matrices.map(matrix => matrix.toArray()), matrices);
  assert.deepEqual(run.events.impacts.map(event => event.critical), [false, false, true]);
  assert.equal(run.events.complete, 1);
});

test('inspection recreates the same pose and impact after reverse seeks and motion preference changes', async () => {
  const run = harness({ assets: previews(), hits, inspectionTime: 0 });
  await act(async () => {});
  await settle();
  const snapshot = () => {
    const renderer = renderers[0];
    renderer.scene!.updateMatrixWorld(true);
    const meshes: unknown[] = [];
    renderer.scene!.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes.push({ visible: object.visible, matrix: object.matrixWorld.toArray(),
        instances: object instanceof THREE.InstancedMesh ? Array.from(object.instanceMatrix.array) : null });
    });
    return { meshes, camera: renderer.camera!.matrixWorld.toArray(),
      impact: modelLoads[0].model.damage.at(-1)!.point!.toArray(), opacity: modelLoads[0].model.opacity };
  };
  run.update({ inspectionTime: 650 });
  await settle();
  const expected = snapshot();
  run.update({ inspectionTime: 2800 });
  await settle();
  run.update({ inspectionTime: 650 });
  await settle();
  assert.deepEqual(snapshot(), expected);
  run.update({ reducedMotion: true });
  await settle();
  run.update({ reducedMotion: false });
  await settle();
  assert.deepEqual(snapshot(), expected);
  assert.equal(run.events.complete, 0);
  assert.deepEqual(run.events.impacts, []);
});

test('changing or clearing a prepared image disposes its sprite batch once', async () => {
  const run = harness();
  await settle();
  assert.equal(crateLoads.length, 1);
  run.update({ crateImage: crateImage() });
  assert.equal(crateLoads[0].value.disposed, true);
  await settle();
  assert.equal(crateLoads.length, 2);
  assert.equal(run.events.assets, 2);
  assert.equal(modelLoads.length, 1);
  assert.equal(renderers.length, 1);
  run.update({ crateImage: null });
  await settle();
  assert.equal(crateLoads[1].value.disposed, true);
  assert.equal(crateLoads[1].value.disposals, 1);
});

test('unexpected result counts fail safely and release any previous instance batch', async () => {
  const run = harness({ assets: previews() });
  await act(async () => {});
  await settle();
  run.update({ assets: previews(12) });
  assert.equal(run.events.errors.length, 1);
  assert.equal(run.events.complete, 0);
  assert.equal(crateLoads.length, 1);
  assert.equal(crateLoads[0].value.disposed, true);
  assert.equal(renderers[0].disposed, true);
  assert.equal(frames.size, 0);
});

for (const stage of ['compile', 'render'] as const) test(`${stage} failure during preparation never reports assets ready`, async () => {
  const run = harness({ crateImage: null });
  await act(async () => {});
  await settle();
  renderers[0].shaderFailure = stage;
  run.update({ crateImage: crateImage() });
  await act(async () => {});
  await settle();
  assert.equal(run.events.errors.length, 1);
  assert.equal(run.events.assets, 0);
  assert.equal(run.events.complete, 0);
  assert.equal(renderers[0].disposed, true);
});

test('context loss ignores and disposes a late warehouse model', async () => {
  deferModel = true;
  const run = harness({ assets: previews(), hits, opening: true });
  act(() => renderers[0].domElement.dispatchEvent(new window.Event('webglcontextlost', { cancelable: true })));
  await act(async () => modelLoads[0].pending.resolve(modelLoads[0].model));
  assert.equal(run.events.errors.length, 1);
  assert.equal(run.events.ready, 0);
  assert.equal(run.events.assets, 0);
  assert.equal(run.events.complete, 0);
  assert.equal(modelLoads[0].model.disposed, true);
});

test('unmount between GPU warming frames releases sprites without reporting readiness', async () => {
  const run = harness({ assets: previews(), hits, opening: true });
  await act(async () => {});
  await advanceFrame();
  assert.equal(renderers[0].initialized.length, 1);
  assert.equal(run.events.assets, 0);
  run.view.unmount();
  await act(async () => {});
  assert.equal(crateLoads[0].value.disposed, true);
  assert.equal(run.events.assets, 0);
  assert.equal(run.events.complete, 0);
  assert.equal(renderers[0].disposed, true);
  assert.equal(frames.size, 0);
});

test('context loss during destruction reports one failure and disposes prepared shared resources', async () => {
  const run = harness({ assets: previews(), hits, opening: true });
  await act(async () => {});
  for (let index = 0; index < 45; index++) await advanceFrame();
  assert.ok(modelLoads[0].model.fracture > 0);
  act(() => renderers[0].domElement.dispatchEvent(new window.Event('webglcontextlost', { cancelable: true })));
  assert.equal(run.events.errors.length, 1);
  assert.equal(run.events.complete, 0);
  assert.equal(frames.size, 0);
  assert.equal(crateLoads[0].value.disposed, true);
  run.update({ opening: true });
  await advanceFrame();
  assert.equal(run.events.errors.length, 1);
  assert.equal(run.events.complete, 0);
});
