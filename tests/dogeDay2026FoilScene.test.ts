import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach, type TestContext } from 'node:test';
import * as THREE from 'three';
import type { DrifCardConfig } from '../src/drifCards.ts';
import type { DogeFoilPose } from '../src/dogeDay2026/foilPackFlow.ts';
import { calcPonchoDrifellaRevealTargetRect, ponchoDrifellaRevealOverlayStyleVars } from '../src/lib/revealOverlayLayout.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom, setMediaQueryMatches } = setupFrontendDom();
const motionQuery = '(prefers-reduced-motion: reduce)';
const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;
let now = 1000;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => {
    frames.set(++nextFrameId, callback);
    return nextFrameId;
  } });
  Object.defineProperty(target, 'cancelAnimationFrame', { configurable: true, value: (id: number) => frames.delete(id) });
}
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 900 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 900 });

const observers = new Set<FakeResizeObserver>();
class FakeResizeObserver {
  constructor(readonly callback: () => void) {}
  observe() { observers.add(this); }
  disconnect() { observers.delete(this); }
}
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: FakeResizeObserver });

function createTestPack() {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(2.45, 3.75, 0.1);
  const material = new THREE.MeshBasicMaterial();
  group.add(new THREE.Mesh(geometry, material));
  const pack = {
    group,
    poses: [] as DogeFoilPose[],
    disposeCount: 0,
    update(pose: DogeFoilPose) {
      assert.equal(pack.disposeCount, 0);
      pack.poses.push({ ...pose });
    },
    dispose() {
      pack.disposeCount += 1;
      geometry.dispose();
      material.dispose();
    },
  };
  packs.push(pack);
  return pack;
}
const packs: ReturnType<typeof createTestPack>[] = [];

function createTestSurface(_card: DrifCardConfig, options: { loadTexture: (source: string) => Promise<THREE.Texture> }) {
  const loaded = deferred();
  const texture = new THREE.Texture();
  const material = new THREE.ShaderMaterial({ uniforms: { uFront: { value: texture } } });
  const surface = {
    loaded,
    loadTexture: options.loadTexture,
    material,
    disposeCount: 0,
    setEffect() { return loaded.promise; },
    update() { assert.equal(surface.disposeCount, 0); },
    dispose() {
      surface.disposeCount += 1;
      texture.dispose();
      material.dispose();
    },
  };
  surfaces.push(surface);
  return surface;
}
const surfaces: ReturnType<typeof createTestSurface>[] = [];

class FakeWebGLRenderer {
  domElement = document.createElement('canvas');
  capabilities = { maxTextureSize: 4096 };
  debug: { onShaderError: (() => void) | null } = { onShaderError: null };
  onCompile?: () => void;
  onRender?: (offscreen: boolean) => void;
  contextLost = false;
  compileCount = 0;
  disposeCount = 0;
  contextLossCount = 0;
  uploadedTextures = new Set<THREE.Texture>();
  target: THREE.WebGLRenderTarget | null = null;
  drawingBuffer = { width: 1, height: 1, density: 1 };
  drawingBuffers: typeof this.drawingBuffer[] = [];
  renders: { offscreen: boolean; visibleCard: boolean }[] = [];
  snapshots: {
    packMatrix: number[];
    cardMatrix: number[];
    cardRotation: { x: number; y: number };
    cardBounds: THREE.Box2;
    particleSystems: number;
    pose: DogeFoilPose | undefined;
  }[] = [];
  constructor() { renderers.push(this); }
  setClearColor() {}
  setDrawingBufferSize(width: number, height: number, density: number) {
    this.drawingBuffer = { width, height, density };
    this.drawingBuffers.push(this.drawingBuffer);
    this.domElement.width = Math.floor(width * density);
    this.domElement.height = Math.floor(height * density);
  }
  initTexture(texture: THREE.Texture) { this.uploadedTextures.add(texture); }
  setRenderTarget(target: THREE.WebGLRenderTarget | null) { this.target = target; }
  compile() {
    assert.equal(this.disposeCount, 0);
    this.compileCount += 1;
    this.onCompile?.();
  }
  getContext() { return { isContextLost: () => this.contextLost }; }
  loseContext() {
    this.contextLost = true;
    this.domElement.dispatchEvent(new dom.window.Event('webglcontextlost', { cancelable: true }));
  }
  render(scene: THREE.Scene, camera: THREE.Camera) {
    assert.equal(this.disposeCount, 0);
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const pack = packs.find(candidate => scene.getObjectById(candidate.group.id));
    assert.ok(pack?.group.parent);
    let cardFront: THREE.Mesh | undefined;
    let particleSystems = 0;
    scene.traverse(object => {
      if (object instanceof THREE.Mesh && surfaces.some(surface => surface.material === object.material)) cardFront = object;
      if (object instanceof THREE.Points) particleSystems += 1;
    });
    assert.ok(cardFront?.parent);
    cardFront.geometry.computeBoundingBox();
    const bounds = cardFront.geometry.boundingBox!;
    const projectedBounds = new THREE.Box2();
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        const point = new THREE.Vector3(x, y, 0).applyMatrix4(cardFront.matrixWorld).project(camera);
        projectedBounds.expandByPoint(new THREE.Vector2(
          (point.x + 1) * this.drawingBuffer.width / 2 + Number.parseFloat(this.domElement.style.left || '0'),
          (1 - point.y) * this.drawingBuffer.height / 2,
        ));
      }
    }
    this.snapshots.push({
      packMatrix: pack.group.parent.matrixWorld.toArray(),
      cardMatrix: cardFront.parent.matrixWorld.toArray(),
      cardRotation: { x: cardFront.parent.rotation.x, y: cardFront.parent.rotation.y },
      cardBounds: projectedBounds,
      particleSystems,
      pose: pack.poses.at(-1),
    });
    let visibleCard = false;
    scene.traverseVisible(object => {
      if (object instanceof THREE.Mesh && surfaces.some(surface => surface.material === object.material)) visibleCard = true;
    });
    const offscreen = this.target !== null;
    this.renders.push({ offscreen, visibleCard });
    this.onRender?.(offscreen);
  }
  dispose() { this.disposeCount += 1; }
  forceContextLoss() { this.contextLossCount += 1; }
}
const renderers: FakeWebGLRenderer[] = [];
const bridge = '__dogeFoilSceneTest';
Object.defineProperty(globalThis, bridge, { configurable: true, value: { FakeWebGLRenderer, createTestPack, createTestSurface } });
const imports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/dogeDay2026/foilPackScene.ts')) {
      if (specifier === 'three') return { url: 'test:doge-foil-three', shortCircuit: true };
      if (specifier.endsWith('/foilPackModel')) return { url: 'test:doge-foil-pack', shortCircuit: true };
      if (specifier.endsWith('/miNoteCardMaterial')) return { url: 'test:doge-foil-surface', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:doge-foil-three') return {
      format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(import.meta.resolve('three'))}; export const WebGLRenderer = globalThis.${bridge}.FakeWebGLRenderer;`,
    };
    if (url === 'test:doge-foil-pack') return {
      format: 'module', shortCircuit: true,
      source: `export const createDogeFoilPackModel = globalThis.${bridge}.createTestPack;`,
    };
    if (url === 'test:doge-foil-surface') return {
      format: 'module', shortCircuit: true,
      source: `export const createMiNoteCardMaterial = globalThis.${bridge}.createTestSurface;`,
    };
    return nextLoad(url, context);
  },
});
const { createDogeFoilScene } = await import('../src/dogeDay2026/foilPackScene.ts');
imports.deregister();
const controllers: ReturnType<typeof createDogeFoilScene>[] = [];

beforeEach(() => {
  now = 1000;
  packs.length = surfaces.length = renderers.length = controllers.length = 0;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
  setMediaQueryMatches(motionQuery, false);
});
afterEach(async () => {
  controllers.forEach(controller => controller.dispose());
  surfaces.forEach(surface => surface.loaded.resolve());
  await flush();
  assert.equal(frames.size, 0);
  assert.equal(observers.size, 0);
  assert.ok(packs.every(pack => pack.disposeCount === 1));
  assert.ok(surfaces.every(surface => surface.disposeCount === 1));
  assert.ok(renderers.every(renderer => renderer.disposeCount === 1 && renderer.contextLossCount === 1));
  document.body.replaceChildren();
});
after(() => { Reflect.deleteProperty(globalThis, bridge); dom.window.close(); });

function harness(cardReady = true, viewport = { width: 900, height: 900 }) {
  const host = document.createElement('div');
  Object.defineProperties(host, {
    clientWidth: { value: viewport.width },
    clientHeight: { value: viewport.height },
  });
  document.body.append(host);
  const events: string[] = [];
  const stages: string[] = [];
  const card = { imageSrc: '/front.png', textureSrc: '/mask.png', effect: { effectKey: 'lighting-only' } } as DrifCardConfig;
  const controller = createDogeFoilScene(host, {
    card,
    cardReady,
    onStageChange(stage) { stages.push(stage); },
    onReady() { events.push('ready'); },
    onError() { events.push('error'); },
    onHit() { events.push('hit'); },
    onReveal() { events.push('reveal'); },
    onBackgroundTap() { events.push('background'); },
  });
  controllers.push(controller);
  return { host, controller, events, stages, renderer: renderers.at(-1)!, surface: surfaces.at(-1)!, pack: packs.at(-1)! };
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function advanceFrame(milliseconds = 16.67) {
  assert.ok(frames.size <= 1);
  now += milliseconds;
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(now));
}

function drainFrames() {
  for (let index = 0; frames.size && index < 500; index += 1) advanceFrame();
  assert.equal(frames.size, 0, 'The scene must stop requesting frames once settled');
}

async function warmCard(run: ReturnType<typeof harness>) {
  run.surface.loaded.resolve();
  await flush();
  assert.equal(run.renderer.compileCount, 1);
}

async function revealCard(run: ReturnType<typeof harness>) {
  await warmCard(run);
  drainFrames();
  for (let hit = 0; hit < 3; hit += 1) {
    run.controller.activate();
    drainFrames();
  }
  assert.equal(run.stages.at(-1), 'revealed');
}

function cardPointer(t: TestContext, run: ReturnType<typeof harness>) {
  const rect = new dom.window.DOMRect(120, 80, run.host.clientWidth, run.host.clientHeight);
  t.mock.method(run.host, 'getBoundingClientRect', () => rect);
  Object.assign(run.host, { setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {} });
  const bounds = run.renderer.snapshots.at(-1)!.cardBounds.clone();
  const center = bounds.getCenter(new THREE.Vector2());
  const halfSize = bounds.getSize(new THREE.Vector2()).multiplyScalar(0.5);
  let timeStamp = 1000;
  return (type: string, x: number, y: number, pointerType = 'mouse', buttons = 0) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      pointerId: { value: 1 }, pointerType: { value: pointerType }, isPrimary: { value: true },
      button: { value: 0 }, buttons: { value: type === 'pointerdown' ? 1 : buttons },
      clientX: { value: rect.left + center.x + x * halfSize.x },
      clientY: { value: rect.top + center.y + y * halfSize.y },
      timeStamp: { value: timeStamp += 50 },
    });
    run.host.dispatchEvent(event);
  };
}

function assertCardTilt(run: ReturnType<typeof harness>, x: number, y: number) {
  const rotation = run.renderer.snapshots.at(-1)!.cardRotation;
  assert.ok(Math.abs(rotation.x - x) < 0.00001, `Expected pitch ${x}, received ${rotation.x}`);
  assert.ok(Math.abs(rotation.y - y) < 0.00001, `Expected yaw ${y}, received ${rotation.y}`);
}

function mockArtwork(t: TestContext, width: number, height: number) {
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, 'Image')!;
  const images: FakeImage[] = [];
  class FakeImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { images.push(this); }
    set src(value: string) { if (value) queueMicrotask(() => this.onload?.()); }
    decode() { return Promise.resolve(); }
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: FakeImage });
  t.after(() => Object.defineProperty(globalThis, 'Image', previousImage));
  return images;
}

test('card artwork retains its decoded source resolution within the GPU texture limit', async (t) => {
  const images = mockArtwork(t, 1500, 2100);
  t.mock.method(dom.window.HTMLCanvasElement.prototype, 'getContext', () => { throw new Error('Artwork within the GPU limit must not be resampled'); });
  const run = harness();
  const texture = await run.surface.loadTexture('/high-resolution-card.png');
  t.after(() => texture.dispose());
  assert.equal(texture.image, images[0]);
  assert.equal(texture.image.naturalWidth, 1500);
  assert.equal(texture.image.naturalHeight, 2100);
});

test('artwork larger than the GPU limit is downsampled only to that limit', async (t) => {
  const images = mockArtwork(t, 6000, 8400);
  const draws: unknown[][] = [];
  const context = {
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    drawImage(...args: unknown[]) { draws.push(args); },
  };
  t.mock.method(dom.window.HTMLCanvasElement.prototype, 'getContext', (() => context) as unknown as HTMLCanvasElement['getContext']);
  const run = harness();
  const texture = await run.surface.loadTexture('/oversized-card.png');
  t.after(() => texture.dispose());
  assert.ok(texture.image instanceof dom.window.HTMLCanvasElement);
  assert.equal(texture.image.height, run.renderer.capabilities.maxTextureSize);
  assert.equal(texture.image.width, Math.round(6000 * 4096 / 8400));
  assert.deepEqual(draws, [[images[0], 0, 0, texture.image.width, texture.image.height]]);
  assert.equal(context.imageSmoothingEnabled, true);
  assert.equal(context.imageSmoothingQuality, 'high');
});

test('retina desktop and phone canvases retain native resolution after slow animation frames', async () => {
  for (const viewport of [
    { width: 1440, height: 900, density: 2 },
    { width: 390, height: 844, density: 3 },
    { width: 3840, height: 2160, density: 2 },
  ]) {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: viewport.density });
    const run = harness(true, viewport);
    await warmCard(run);
    drainFrames();
    for (let hit = 0; hit < 3; hit += 1) {
      run.controller.activate();
      for (let frame = 0; frames.size && frame < 500; frame += 1) advanceFrame(33.33);
      assert.equal(frames.size, 0);
    }
    assert.equal(run.stages.at(-1), 'revealed');
    const targetRect = calcPonchoDrifellaRevealTargetRect(viewport.width, viewport.height);
    const canvasWidth = Math.min(viewport.width, targetRect.width);
    assert.ok(run.renderer.drawingBuffers.every(buffer => buffer.density === viewport.density));
    assert.equal(run.renderer.drawingBuffers.length, 1);
    assert.deepEqual(run.renderer.drawingBuffer, { width: canvasWidth, height: viewport.height, density: viewport.density });
    assert.equal(Number.parseFloat(run.renderer.domElement.style.left), (viewport.width - canvasWidth) / 2);
    assert.equal(Number.parseFloat(run.renderer.domElement.style.width), canvasWidth);
    run.controller.dispose();
  }
});

test('display density changes refresh the drawing buffer on the next active frame', () => {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
  const run = harness();
  drainFrames();
  assert.equal(run.renderer.drawingBuffers.length, 1);
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });
  run.controller.activate();
  drainFrames();
  assert.equal(run.renderer.drawingBuffer.density, 3);
  assert.equal(run.renderer.drawingBuffers.length, 2);
});

test('cropped canvas pointer mapping follows the rendered card for hover and taps', async (t) => {
  const run = harness(true, { width: 1920, height: 1080 });
  const hostRect = new dom.window.DOMRect(120, 80, 1920, 1080);
  t.mock.method(run.host, 'getBoundingClientRect', () => hostRect);
  Object.assign(run.host, { setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {} });
  function pointer(type: string, x: number, y: number, timeStamp: number) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      pointerId: { value: 1 }, pointerType: { value: 'mouse' }, isPrimary: { value: true },
      button: { value: 0 }, buttons: { value: type === 'pointerdown' ? 1 : 0 },
      clientX: { value: hostRect.left + x }, clientY: { value: hostRect.top + y }, timeStamp: { value: timeStamp },
    });
    run.host.dispatchEvent(event);
  }
  await warmCard(run);
  drainFrames();
  for (let hit = 0; hit < 3; hit += 1) {
    run.controller.activate();
    drainFrames();
  }
  assert.equal(run.stages.at(-1), 'revealed');
  const settled = run.renderer.snapshots.at(-1)!;
  const bounds = settled.cardBounds;
  const center = bounds.getCenter(new THREE.Vector2());
  pointer('pointermove', bounds.max.x - 12, center.y, 1000);
  drainFrames();
  assert.equal(run.host.style.cursor, 'default');
  assert.notDeepEqual(run.renderer.snapshots.at(-1)!.cardMatrix, settled.cardMatrix);
  pointer('pointerdown', center.x, center.y, 2000);
  pointer('pointerup', center.x, center.y, 2100);
  drainFrames();
  assert.deepEqual(run.renderer.snapshots.at(-1)!.cardMatrix, settled.cardMatrix);
  assert.equal(run.events.filter(event => event === 'background').length, 0);
  pointer('pointerdown', bounds.min.x - 20, center.y, 3000);
  pointer('pointerup', bounds.min.x - 20, center.y, 3100);
  drainFrames();
  assert.equal(run.events.filter(event => event === 'background').length, 1);
});

test('hover follows Mi Note pitch and yaw against fixed card bounds without feedback', async (t) => {
  const run = harness(true, { width: 1920, height: 1080 });
  await revealCard(run);
  const pointer = cardPointer(t, run);
  for (const [x, y] of [[0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8], [0.6, -0.6]]) {
    pointer('pointermove', x, y);
    drainFrames();
    assertCardTilt(run, -y * 0.24, -x * 0.3);
    const settled = run.renderer.snapshots.at(-1)!.cardMatrix;
    pointer('pointermove', x, y);
    drainFrames();
    assert.deepEqual(run.renderer.snapshots.at(-1)!.cardMatrix, settled);
  }
  pointer('pointermove', 1.01, 0);
  drainFrames();
  assertCardTilt(run, 0, 0);
  pointer('pointermove', 0.8, 0);
  drainFrames();
  run.controller.activate();
  drainFrames();
  assertCardTilt(run, 0, 0);
});

test('mouse taps and drags preserve absolute card tilt after release while touch releases reset', async (t) => {
  for (const pointerType of ['mouse', 'touch']) {
    const run = harness();
    await revealCard(run);
    const pointer = cardPointer(t, run);
    pointer('pointerdown', 0.6, 0.5, pointerType);
    pointer('pointerup', 0.6, 0.5, pointerType);
    drainFrames();
    assertCardTilt(run, pointerType === 'mouse' ? -0.12 : 0, pointerType === 'mouse' ? -0.18 : 0);
    pointer('pointerdown', -0.4, -0.3, pointerType);
    pointer('pointermove', 0.7, -0.6, pointerType, 1);
    drainFrames();
    assertCardTilt(run, 0.144, -0.21);
    pointer('pointerup', 0.7, -0.6, pointerType);
    drainFrames();
    assertCardTilt(run, pointerType === 'mouse' ? 0.144 : 0, pointerType === 'mouse' ? -0.21 : 0);
    assert.equal(run.events.filter(event => event === 'hit').length, 3);
    assert.equal(run.events.filter(event => event === 'background').length, 0);
    run.controller.dispose();
  }
});

test('cancelled drags and reduced motion return the card to its resting orientation', async (t) => {
  const run = harness();
  await revealCard(run);
  const pointer = cardPointer(t, run);
  for (const pointerType of ['mouse', 'touch']) {
    pointer('pointerdown', 0, 0, pointerType);
    pointer('pointermove', 0.7, -0.6, pointerType, 1);
    drainFrames();
    assertCardTilt(run, 0.144, -0.21);
    pointer('pointermove', 2, -2, pointerType, 1);
    drainFrames();
    assertCardTilt(run, 0.24, -0.3);
    pointer('pointercancel', 0.7, -0.6, pointerType);
    drainFrames();
    assertCardTilt(run, 0, 0);
  }
  pointer('pointermove', 0.8, -0.8);
  drainFrames();
  assertCardTilt(run, 0.192, -0.24);
  setMediaQueryMatches(motionQuery, true);
  drainFrames();
  assertCardTilt(run, 0, 0);
  pointer('pointermove', -0.8, 0.8);
  pointer('pointerdown', 0, 0, 'touch');
  pointer('pointermove', 0.8, 0.8, 'touch', 1);
  drainFrames();
  assertCardTilt(run, 0, 0);
  pointer('pointerup', 0.8, 0.8, 'touch');
  drainFrames();
  assertCardTilt(run, 0, 0);
});

test('pack hits and the final reveal do not add particle systems', async () => {
  const run = harness();
  await revealCard(run);
  assert.ok(run.renderer.snapshots.some(snapshot => snapshot.pose && snapshot.pose.hit > 0));
  assert.ok(run.renderer.snapshots.every(snapshot => snapshot.particleSystems === 0));
});

test('the pack starts front-on at its settled size and stays still while awaiting a hit', (t) => {
  const run = harness();
  advanceFrame();
  assert.equal(frames.size, 0);
  const first = run.renderer.snapshots.at(-1)!;
  const matrix = new THREE.Matrix4().fromArray(first.packMatrix);
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, rotation, scale);
  assert.deepEqual(rotation.toArray(), [0, 0, 0, 1]);
  assert.ok(scale.x > 0 && scale.y > 0 && scale.z > 0);
  const pointer = cardPointer(t, run);
  pointer('pointermove', 0.8, -0.8);
  drainFrames();
  assert.deepEqual(run.renderer.snapshots.at(-1)!.packMatrix, first.packMatrix);
  for (let index = 0; index < 45; index += 1) {
    observers.forEach(observer => observer.callback());
    advanceFrame();
    assert.deepEqual(run.renderer.snapshots.at(-1)!.packMatrix, first.packMatrix);
  }
  assert.equal(frames.size, 0);
});

test('the card keeps its warmed position and size through tearing, discard, reveal, and activation', async () => {
  const run = harness();
  await warmCard(run);
  const warmed = run.renderer.snapshots.at(-1)!;
  drainFrames();
  for (let index = 0; index < 3; index += 1) {
    run.controller.activate();
    drainFrames();
  }
  assert.equal(run.stages.at(-1), 'revealed');
  assert.ok(run.renderer.snapshots.some(snapshot => snapshot.pose && snapshot.pose.tear > 0 && snapshot.pose.tear < 1));
  assert.ok(run.renderer.snapshots.some(snapshot => snapshot.pose && snapshot.pose.discard > 0 && snapshot.pose.discard < 1));
  assert.ok(run.renderer.snapshots.some(snapshot => snapshot.pose?.cardInteractive));
  run.controller.activate();
  drainFrames();
  for (const snapshot of run.renderer.snapshots) {
    assert.deepEqual(snapshot.cardMatrix, warmed.cardMatrix);
    assert.ok(snapshot.cardBounds.equals(warmed.cardBounds));
  }
});

test('the rendered card matches Poncho framing on square, desktop, phone, and landscape viewports', async () => {
  for (const viewport of [
    { width: 900, height: 900 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    const run = harness(true, viewport);
    await warmCard(run);
    drainFrames();
    const targetRect = calcPonchoDrifellaRevealTargetRect(viewport.width, viewport.height);
    const reference = ponchoDrifellaRevealOverlayStyleVars({
      originRect: targetRect,
      targetRect,
      viewport: { ...viewport, left: 0, top: 0 },
      cardCount: 1,
    });
    const bounds = run.renderer.snapshots.at(-1)!.cardBounds;
    const renderedWidth = bounds.max.x - bounds.min.x;
    const renderedHeight = bounds.max.y - bounds.min.y;
    const renderedCenterX = (bounds.min.x + bounds.max.x) / 2;
    const renderedCenterY = (bounds.min.y + bounds.max.y) / 2;
    const referenceWidth = Number.parseFloat(reference['--poncho-card-width']!);
    const referenceHeight = Number.parseFloat(reference['--poncho-card-height']!);
    const referenceCenterX = targetRect.left + Number.parseFloat(reference['--poncho-card-left']!) + referenceWidth / 2;
    const referenceCenterY = targetRect.top + Number.parseFloat(reference['--poncho-card-top']!) + referenceHeight / 2;
    assert.ok(Math.abs(renderedWidth - referenceWidth) < 0.001, `Card width at ${viewport.width}×${viewport.height}`);
    assert.ok(Math.abs(renderedHeight - referenceHeight) <= 1, `Card height at ${viewport.width}×${viewport.height}`);
    assert.ok(Math.abs(renderedCenterX - referenceCenterX) <= 1, `Card horizontal position at ${viewport.width}×${viewport.height}`);
    assert.ok(Math.abs(renderedCenterY - referenceCenterY) < 0.001, `Card position at ${viewport.width}×${viewport.height}`);
    run.controller.dispose();
  }
});

test('the third hit waits for decoded textures, shader compilation, and a visible offscreen card render', async () => {
  const run = harness();
  drainFrames();
  assert.deepEqual(run.events, ['ready']);
  for (let index = 0; index < 3; index += 1) {
    run.controller.activate();
    drainFrames();
  }
  assert.equal(run.stages.at(-1), 'waiting');
  assert.equal(run.events.includes('reveal'), false);
  run.renderer.onCompile = () => {
    assert.equal(run.renderer.uploadedTextures.size, 1);
    assert.equal(run.stages.at(-1), 'waiting');
    assert.equal(run.events.includes('reveal'), false);
  };
  run.renderer.onRender = (offscreen) => {
    if (offscreen) {
      assert.equal(run.stages.at(-1), 'waiting');
      assert.equal(run.events.includes('reveal'), false);
    }
  };
  await warmCard(run);
  assert.deepEqual(run.renderer.renders.filter(frame => frame.offscreen), [{ offscreen: true, visibleCard: true }]);
  assert.equal(run.stages.at(-1), 'opening');
  drainFrames();
  assert.equal(run.stages.at(-1), 'revealed');
  assert.equal(run.events.filter(event => event === 'reveal').length, 1);
});

test('card identity readiness remains required after GPU warming and more reversible hits remain available', async () => {
  const run = harness(false);
  await warmCard(run);
  drainFrames();
  for (let index = 0; index < 5; index += 1) {
    run.controller.activate();
    drainFrames();
  }
  assert.equal(run.stages.at(-1), 'waiting');
  assert.deepEqual(run.pack.poses.filter(pose => pose.hit > 0).map(pose => pose.variant).filter((variant, index, values) => !index || variant !== values[index - 1]), [0, 1, 2, 0, 1]);
  run.controller.setCardReady(true);
  assert.equal(run.stages.at(-1), 'opening');
  drainFrames();
  assert.equal(run.stages.at(-1), 'revealed');
});

test('hidden tabs freeze an active hit and do not skip the reveal on return', async () => {
  const run = harness();
  await warmCard(run);
  drainFrames();
  for (let index = 0; index < 2; index += 1) {
    run.controller.activate();
    drainFrames();
  }
  run.controller.activate();
  advanceFrame();
  const before = run.pack.poses.at(-1)!;
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(frames.size, 0);
  advanceFrame(60_000);
  assert.equal(run.pack.poses.at(-1), before);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  advanceFrame();
  assert.equal(run.stages.at(-1), 'hit');
  assert.equal(run.events.includes('reveal'), false);
  drainFrames();
  assert.equal(run.stages.at(-1), 'revealed');
});

test('changing reduced motion before the first hit preserves GPU and identity readiness', async () => {
  const run = harness();
  await warmCard(run);
  drainFrames();
  setMediaQueryMatches(motionQuery, true);
  drainFrames();
  for (let index = 0; index < 3; index += 1) {
    run.controller.activate();
    drainFrames();
  }
  assert.equal(run.stages.at(-1), 'revealed');
  assert.equal(run.events.filter(event => event === 'reveal').length, 1);
});

test('revoking readiness pauses opening without keeping the render loop alive', async () => {
  const run = harness();
  await warmCard(run);
  drainFrames();
  for (let index = 0; index < 2; index += 1) {
    run.controller.activate();
    drainFrames();
  }
  run.controller.activate();
  while (run.stages.at(-1) !== 'opening') advanceFrame();
  for (let index = 0; index < 20; index += 1) advanceFrame();
  run.controller.setCardReady(false);
  drainFrames();
  assert.equal(run.stages.at(-1), 'opening');
  const frozen = run.pack.poses.at(-1)!;
  advanceFrame(60_000);
  assert.equal(run.pack.poses.at(-1), frozen);
  run.controller.setCardReady(true);
  drainFrames();
  assert.equal(run.stages.at(-1), 'revealed');
  assert.equal(run.events.filter(event => event === 'reveal').length, 1);
});

test('disposal before texture completion prevents late compilation or callbacks and is idempotent', async () => {
  const run = harness();
  run.controller.dispose();
  run.controller.dispose();
  run.surface.loaded.resolve();
  await flush();
  assert.equal(run.host.children.length, 0);
  assert.equal(run.renderer.compileCount, 0);
  assert.deepEqual(run.events, []);
  run.controller.activate();
  run.controller.setCardReady(true);
  assert.equal(frames.size, 0);
});

test('context loss during compilation prevents warming and allows immediate idempotent disposal', async () => {
  const run = harness();
  run.renderer.onCompile = () => run.renderer.loseContext();
  await warmCard(run);
  assert.deepEqual(run.events, ['error']);
  assert.equal(run.renderer.renders.length, 0);
  assert.equal(frames.size, 0);
  run.controller.dispose();
  run.controller.dispose();
  assert.equal(run.host.children.length, 0);
  assert.equal(frames.size, 0);
  assert.equal(observers.size, 0);
  assert.equal(run.renderer.disposeCount, 1);
  assert.equal(run.renderer.contextLossCount, 1);
  assert.equal(run.surface.disposeCount, 1);
  assert.equal(run.pack.disposeCount, 1);
  run.controller.setCardReady(true);
  run.controller.activate();
  await flush();
  assert.deepEqual(run.events, ['error']);
});

test('shader compilation failure stops rendering and activation without starting the reveal', async () => {
  const run = harness();
  run.renderer.onCompile = () => { throw new Error('Shader compilation failed'); };
  await warmCard(run);
  assert.deepEqual(run.events, ['error']);
  assert.equal(frames.size, 0);
  run.controller.activate();
  run.controller.setCardReady(true);
  assert.equal(frames.size, 0);
  assert.deepEqual(run.events, ['error']);
});

test('a shader error callback during compilation prevents the warm render and reveal', async () => {
  const run = harness();
  run.renderer.onCompile = () => run.renderer.debug.onShaderError?.();
  await warmCard(run);
  assert.deepEqual(run.events, ['error']);
  assert.equal(run.renderer.renders.length, 0);
  assert.equal(frames.size, 0);
});

test('context loss during the warm render does not unlock the reveal before its event arrives', async () => {
  const run = harness();
  drainFrames();
  for (let index = 0; index < 3; index += 1) {
    run.controller.activate();
    drainFrames();
  }
  assert.equal(run.stages.at(-1), 'waiting');
  run.renderer.onRender = (offscreen) => {
    if (offscreen) run.renderer.contextLost = true;
  };
  await warmCard(run);
  assert.equal(run.stages.at(-1), 'waiting');
  assert.equal(run.events.filter(event => event === 'error').length, 1);
  assert.equal(run.events.includes('reveal'), false);
  assert.equal(run.renderer.target, null);
  run.renderer.loseContext();
  run.controller.dispose();
  assert.equal(run.renderer.disposeCount, 1);
  assert.equal(run.surface.disposeCount, 1);
  assert.equal(frames.size, 0);
});

test('context loss before textures arrive prevents late warming and allows immediate cleanup', async () => {
  const run = harness();
  run.renderer.loseContext();
  run.controller.dispose();
  assert.equal(run.renderer.disposeCount, 1);
  assert.equal(run.surface.disposeCount, 1);
  run.surface.loaded.resolve();
  await flush();
  assert.equal(run.renderer.compileCount, 0);
  assert.deepEqual(run.events, ['error']);
  assert.equal(frames.size, 0);
});

test('a background tap released after failure cannot hide the restored controls', () => {
  const run = harness();
  Object.assign(run.host, { setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {} });
  const pointerEvent = (type: string, timeStamp: number) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      pointerId: { value: 1 }, pointerType: { value: 'touch' }, isPrimary: { value: true },
      button: { value: 0 }, clientX: { value: 10 }, clientY: { value: 10 }, timeStamp: { value: timeStamp },
    });
    return event;
  };
  drainFrames();
  run.host.dispatchEvent(pointerEvent('pointerdown', 1000));
  run.host.dispatchEvent(pointerEvent('pointerup', 1100));
  assert.deepEqual(run.events, ['ready', 'background']);
  run.host.dispatchEvent(pointerEvent('pointerdown', 2000));
  run.renderer.loseContext();
  run.host.dispatchEvent(pointerEvent('pointerup', 2100));
  assert.deepEqual(run.events, ['ready', 'background', 'error']);
  assert.equal(frames.size, 0);
});
