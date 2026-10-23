import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach, type TestContext } from 'node:test';
import * as THREE from 'three';
import type { DrifCardConfig } from '../src/drifCards.ts';
import { sampleDogeFoilOpening, type DogeFoilPose } from '../src/dogeDay2026/foilPackFlow.ts';
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
    resizeMotion: [] as boolean[],
    disposeCount: 0,
    setExitDistance() {},
    update(pose: DogeFoilPose, preserveResizeMotion = true) {
      assert.equal(pack.disposeCount, 0);
      pack.poses.push({ ...pose });
      pack.resizeMotion.push(preserveResizeMotion);
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

function createTestSurface(card: DrifCardConfig, options: { loadTexture: (source: string) => Promise<THREE.Texture> }) {
  const loaded = deferred();
  const texture = new THREE.Texture();
  const material = new THREE.ShaderMaterial({ uniforms: { uFront: { value: texture } } });
  const surface = {
    card,
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

type CardSnapshot = {
  imageSrc: string;
  matrix: number[];
  rotation: { x: number; y: number };
  bounds: THREE.Box2;
  visible: boolean;
  renderOrder: number;
  frontDepthWrite: boolean;
  backDepthWrite: boolean;
};

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
  resourceDisposals = new Map<THREE.BufferGeometry | THREE.Material, number>();
  target: THREE.WebGLRenderTarget | null = null;
  drawingBuffer = { width: 1, height: 1, density: 1 };
  drawingBuffers: typeof this.drawingBuffer[] = [];
  renders: { offscreen: boolean; visibleCard: boolean }[] = [];
  snapshots: {
    packMatrix: number[];
    packVisible: boolean;
    cards: CardSnapshot[];
    offscreen: boolean;
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
    const cardFronts: THREE.Mesh[] = [];
    const visibleFronts = new Set<THREE.Object3D>();
    let particleSystems = 0;
    scene.traverse(object => {
      if (object instanceof THREE.Mesh) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const resource of [object.geometry, ...materials] as (THREE.BufferGeometry | THREE.Material)[]) {
          if (this.resourceDisposals.has(resource)) continue;
          this.resourceDisposals.set(resource, 0);
          resource.addEventListener('dispose', () => this.resourceDisposals.set(resource, this.resourceDisposals.get(resource)! + 1));
        }
      }
      if (object instanceof THREE.Mesh && surfaces.some(surface => surface.material === object.material)) cardFronts.push(object);
      if (object instanceof THREE.Points) particleSystems += 1;
    });
    scene.traverseVisible(object => visibleFronts.add(object));
    const cards = cardFronts.map(cardFront => {
      assert.ok(cardFront.parent);
      assert.ok(!Array.isArray(cardFront.material));
      const cardBack = cardFront.parent.children.find(object => object instanceof THREE.Mesh
        && !Array.isArray(object.material) && object.material.side === THREE.BackSide) as THREE.Mesh | undefined;
      assert.ok(cardBack && !Array.isArray(cardBack.material));
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
      return {
        imageSrc: surfaces.find(surface => surface.material === cardFront.material)!.card.imageSrc,
        matrix: cardFront.parent.matrixWorld.toArray(),
        rotation: { x: cardFront.parent.rotation.x, y: cardFront.parent.rotation.y },
        bounds: projectedBounds,
        visible: visibleFronts.has(cardFront),
        renderOrder: cardFront.renderOrder,
        frontDepthWrite: cardFront.material.depthWrite,
        backDepthWrite: cardBack.material.depthWrite,
      };
    });
    assert.ok(cards.length);
    const offscreen = this.target !== null;
    this.snapshots.push({
      packMatrix: pack.group.parent.matrixWorld.toArray(),
      packVisible: visibleFronts.has(pack.group),
      cards,
      offscreen,
      cardMatrix: cards[0]!.matrix,
      cardRotation: cards[0]!.rotation,
      cardBounds: cards[0]!.bounds,
      particleSystems,
      pose: pack.poses.at(-1),
    });
    this.renders.push({ offscreen, visibleCard: cards.some(card => card.visible) });
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
  for (const renderer of renderers) {
    assert.ok([...renderer.resourceDisposals.values()].every(count => count === 1), 'Every rendered material and geometry should be disposed exactly once');
  }
  document.body.replaceChildren();
});
after(() => { Reflect.deleteProperty(globalThis, bridge); dom.window.close(); });

function harness(cardReady = true, viewport = { width: 900, height: 900 }, cardCount = 1) {
  const host = document.createElement('div');
  Object.defineProperties(host, {
    clientWidth: { value: viewport.width },
    clientHeight: { value: viewport.height },
  });
  document.body.append(host);
  const events: string[] = [];
  const stages: string[] = [];
  const cardStates: { mode: 'stack' | 'cycling' | 'spreading' | 'row'; activeCardIndex: number; transitioning: boolean }[] = [];
  const cards = Array.from({ length: cardCount }, (_, index) => ({ imageSrc: `/front-${index}.png`, textureSrc: '/mask.png', effect: { effectKey: 'lighting-only' } } as DrifCardConfig));
  const surfaceStart = surfaces.length;
  const controller = createDogeFoilScene(host, {
    cards,
    cardReady,
    onStageChange(stage) { stages.push(stage); },
    onReady() { events.push('ready'); },
    onError() { events.push('error'); },
    onHit() { events.push('hit'); },
    onReveal() { events.push('reveal'); },
    onBackgroundTap() { events.push('background'); },
    onCardStateChange(state) { cardStates.push({ ...state }); },
    onCardSwipe() { events.push('swipe'); },
    onCardSpread() { events.push('spread'); },
  });
  controllers.push(controller);
  return { host, controller, events, stages, cards, cardStates, renderer: renderers.at(-1)!, surface: surfaces[surfaceStart]!, surfaces: surfaces.slice(surfaceStart), pack: packs.at(-1)! };
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
  run.surfaces.forEach(surface => surface.loaded.resolve());
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

function cardPointer(t: TestContext, run: ReturnType<typeof harness>, cardIndex = 0) {
  const rect = new dom.window.DOMRect(120, 80, run.host.clientWidth, run.host.clientHeight);
  t.mock.method(run.host, 'getBoundingClientRect', () => rect);
  Object.assign(run.host, { setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {} });
  const bounds = run.renderer.snapshots.at(-1)!.cards[cardIndex]!.bounds.clone();
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

function assertCardTilt(run: ReturnType<typeof harness>, x: number, y: number, cardIndex = 0) {
  const rotation = run.renderer.snapshots.at(-1)!.cards[cardIndex]!.rotation;
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
    const canvasWidth = viewport.width;
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

test('full-width canvas pointer mapping follows the rendered card for hover and taps', async (t) => {
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
  assert.equal(run.host.style.cursor, 'pointer');
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


for (const cardCount of [2, 3]) {
  const expectedSounds = [...Array<string>(cardCount - 1).fill('swipe'), 'spread'];

  test(`${cardCount}-card packs wait for every decoded surface and individually warm each card before opening`, async () => {
    const run = harness(true, { width: 900, height: 900 }, cardCount);
    drainFrames();
    for (let hit = 0; hit < 3; hit += 1) {
      run.controller.activate();
      drainFrames();
    }
    assert.equal(run.stages.at(-1), 'waiting');
    run.surfaces.forEach((surface, index) => { if (index !== 1) surface.loaded.resolve(); });
    await flush();
    assert.equal(run.renderer.compileCount, 0);
    assert.equal(run.events.includes('reveal'), false);
    assert.equal(frames.size, 0);
    run.renderer.onCompile = () => {
      assert.equal(run.renderer.uploadedTextures.size, cardCount);
      assert.equal(run.stages.at(-1), 'waiting');
    };
    run.renderer.onRender = offscreen => {
      if (offscreen) {
        assert.equal(run.stages.at(-1), 'waiting');
        assert.equal(run.events.includes('reveal'), false);
      }
    };
    await warmCard(run);
    const warmed = run.renderer.snapshots.filter(snapshot => snapshot.offscreen);
    assert.deepEqual(warmed.map(snapshot => snapshot.cards.filter(card => card.visible).map(card => card.imageSrc)),
      run.cards.map(card => [card.imageSrc]));
    assert.equal(run.stages.at(-1), 'opening');
    drainFrames();
    assert.equal(run.stages.at(-1), 'revealed');
    assert.equal(run.events.filter(event => event === 'reveal').length, 1);
    assert.deepEqual(run.cardStates.at(-1), { mode: 'stack', activeCardIndex: 0, transitioning: false });
    assert.ok(run.renderer.snapshots.at(-1)!.cards.every(card => card.visible));
  });

  test(`${cardCount}-card browsing ignores opening and rapid activations, cycles through every card, then spreads in original order`, async () => {
    const run = harness(true, { width: 1440, height: 900 }, cardCount);
    await warmCard(run);
    drainFrames();
    for (let hit = 0; hit < 2; hit += 1) {
      run.controller.activate();
      drainFrames();
    }
    run.controller.activate();
    while (run.stages.at(-1) !== 'opening') advanceFrame();
    run.controller.activate();
    run.controller.activate();
    assert.equal(run.events.includes('swipe'), false);
    drainFrames();
    for (let index = 0; index < cardCount; index += 1) {
      const before = run.renderer.snapshots.at(-1)!.cards[index]!.bounds.getCenter(new THREE.Vector2());
      run.controller.activate();
      const mode = index < cardCount - 1 ? 'cycling' : 'spreading';
      assert.equal(run.cardStates.at(-1)!.mode, mode);
      assert.equal(run.cardStates.at(-1)!.transitioning, true);
      const eventCount = run.events.length;
      run.controller.activate();
      run.controller.activate();
      assert.equal(run.events.length, eventCount);
      for (let frame = 0; frame < 6; frame += 1) advanceFrame(50);
      if (index < cardCount - 1) {
        const during = run.renderer.snapshots.at(-1)!.cards[index]!.bounds.getCenter(new THREE.Vector2());
        assert.ok(during.x < before.x, 'The current card should travel left while cycling');
      }
      for (let frame = 0; frame < 5; frame += 1) advanceFrame(50);
      assert.equal(run.cardStates.at(-1)!.mode, mode, 'The transition should still be active before 560 ms');
      advanceFrame(50);
      assert.equal(run.cardStates.at(-1)!.mode, index < cardCount - 1 ? 'stack' : 'row');
      assert.equal(run.cardStates.at(-1)!.transitioning, false);
      if (index < cardCount - 1) assert.equal(run.cardStates.at(-1)!.activeCardIndex, index + 1);
      drainFrames();
    }
    assert.deepEqual(run.events.filter(event => event === 'swipe' || event === 'spread'), expectedSounds);
    const row = run.renderer.snapshots.at(-1)!.cards;
    assert.deepEqual(row.map(card => card.imageSrc), run.cards.map(card => card.imageSrc));
    assert.equal(row.length, cardCount);
    assert.equal(row.filter(card => card.visible).length, cardCount);
    row.slice(1).forEach((card, index) => assert.ok(row[index]!.bounds.max.x < card.bounds.min.x));
    const before = row.map(card => card.matrix);
    run.controller.activate();
    drainFrames();
    assert.equal(run.cardStates.at(-1)!.mode, 'row');
    assert.deepEqual(run.renderer.snapshots.at(-1)!.cards.map(card => card.matrix), before);
  });

  test(`${cardCount}-card taps advance the stack while drags, cancelled pointers, and long presses do not`, async (t) => {
    const run = harness(true, { width: 900, height: 900 }, cardCount);
    await revealCard(run);
    const pointer = cardPointer(t, run);
    pointer('pointerdown', 0, 0);
    pointer('pointermove', 0.7, -0.6, 'mouse', 1);
    drainFrames();
    assertCardTilt(run, 0.144, -0.21);
    pointer('pointerup', 0.7, -0.6);
    drainFrames();
    assert.equal(run.cardStates.at(-1)!.activeCardIndex, 0);
    assert.equal(run.events.includes('swipe'), false);
    pointer('pointerdown', 0, 0, 'touch');
    pointer('pointermove', -0.5, 0.6, 'touch', 1);
    pointer('pointercancel', -0.5, 0.6, 'touch');
    drainFrames();
    assertCardTilt(run, 0, 0);
    pointer('pointerdown', 0, 0);
    for (let move = 0; move < 13; move += 1) pointer('pointermove', 0, 0, 'mouse', 1);
    pointer('pointerup', 0, 0);
    drainFrames();
    assert.equal(run.events.includes('swipe'), false);
    pointer('pointerdown', 0, 0, 'touch');
    pointer('pointerup', 0, 0, 'touch');
    assert.equal(run.cardStates.at(-1)!.mode, 'cycling');
    drainFrames();
    assert.equal(run.cardStates.at(-1)!.activeCardIndex, 1);
    assert.ok(run.renderer.snapshots.at(-1)!.cards.every(card => card.rotation.x === 0 && card.rotation.y === 0));
    assert.equal(run.events.filter(event => event === 'swipe').length, 1);
    assert.equal(run.events.includes('background'), false);
  });

  test(`${cardCount}-card row cards tilt independently and card taps keep the completed row displayed`, async (t) => {
    const run = harness(true, { width: 1440, height: 900 }, cardCount);
    await revealCard(run);
    for (let index = 0; index < cardCount; index += 1) {
      run.controller.activate();
      drainFrames();
    }
    const resting = run.renderer.snapshots.at(-1)!.cards.map(card => card.matrix);
    const pointer = cardPointer(t, run, 1);
    pointer('pointermove', 0.7, -0.6);
    drainFrames();
    assertCardTilt(run, 0.144, -0.21, 1);
    run.renderer.snapshots.at(-1)!.cards.forEach((card, index) => {
      if (index !== 1) assert.deepEqual(card.matrix, resting[index]);
    });
    pointer('pointerdown', 0.7, -0.6);
    pointer('pointerup', 0.7, -0.6);
    drainFrames();
    assert.equal(run.cardStates.at(-1)!.mode, 'row');
    assert.deepEqual(run.events.filter(event => event === 'swipe' || event === 'spread'), expectedSounds);
    run.controller.activate();
    drainFrames();
    assert.ok(run.renderer.snapshots.at(-1)!.cards.every(card => card.rotation.x === 0 && card.rotation.y === 0));
    pointer('pointerdown', 0, 2, 'touch');
    pointer('pointerup', 0, 2, 'touch');
    drainFrames();
    assert.equal(run.events.filter(event => event === 'background').length, 1);
  });

  test(`${cardCount}-card row hover stays stable at each card edge and resets outside its resting bounds`, async (t) => {
    const run = harness(true, { width: 1440, height: 900 }, cardCount);
    await revealCard(run);
    for (let index = 0; index < cardCount; index += 1) {
      run.controller.activate();
      drainFrames();
    }
    for (let cardIndex = 0; cardIndex < cardCount; cardIndex += 1) {
      const pointer = cardPointer(t, run, cardIndex);
      for (const [x, y] of [[-0.99, 0], [0.99, 0], [0, -0.99], [0, 0.99]]) {
        for (let move = 0; move < 6; move += 1) {
          pointer('pointermove', x, y);
          drainFrames();
          assertCardTilt(run, -y * 0.24, -x * 0.3, cardIndex);
          for (let other = 0; other < cardCount; other += 1) {
            if (other !== cardIndex) assertCardTilt(run, 0, 0, other);
          }
        }
      }
      pointer('pointermove', 0, 1.05);
      drainFrames();
      assert.ok(run.renderer.snapshots.at(-1)!.cards.every(card => card.rotation.x === 0 && card.rotation.y === 0));
    }
  });

  test(`the ${cardCount}-card row matches reference framing and fits square, desktop, phone, and landscape canvases`, async () => {
    for (const viewport of [
      { width: 900, height: 900 },
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      const run = harness(true, viewport, cardCount);
      await revealCard(run);
      for (let index = 0; index < cardCount; index += 1) {
        run.controller.activate();
        drainFrames();
      }
      const targetRect = calcPonchoDrifellaRevealTargetRect(viewport.width, viewport.height);
      const reference = ponchoDrifellaRevealOverlayStyleVars({
        originRect: targetRect,
        targetRect,
        viewport: { ...viewport, left: 0, top: 0 },
        cardCount,
      });
      const rowWidth = Number.parseFloat(reference['--poncho-card-row-width']!);
      const rowHeight = Number.parseFloat(reference['--poncho-card-row-height']!);
      const rowTop = Number.parseFloat(reference['--poncho-card-row-top']!);
      const row = run.renderer.snapshots.at(-1)!.cards;
      assert.equal(row.length, cardCount);
      assert.equal(row.filter(card => card.visible).length, cardCount);
      row.forEach((card, index) => {
        const leftKey = `--poncho-card-row-left-${index}` as '--poncho-card-row-left-0' | '--poncho-card-row-left-1' | '--poncho-card-row-left-2';
        assert.ok(Math.abs(card.bounds.min.x - Number.parseFloat(reference[leftKey]!)) <= 1);
        assert.ok(Math.abs(card.bounds.min.y - rowTop) <= 1);
        assert.ok(Math.abs(card.bounds.getSize(new THREE.Vector2()).x - rowWidth) <= 1);
        assert.ok(Math.abs(card.bounds.getSize(new THREE.Vector2()).y - rowHeight) <= 1.001, `Card height at ${viewport.width}×${viewport.height}: received ${card.bounds.getSize(new THREE.Vector2()).y}, expected ${rowHeight}`);
        assert.ok(card.bounds.getSize(new THREE.Vector2()).x <= viewport.width * (cardCount === 2 ? 0.36 : 0.21) + 1);
        assert.ok(card.bounds.min.x >= 0 && card.bounds.max.x <= viewport.width);
        assert.ok(card.bounds.min.y >= 0 && card.bounds.max.y <= viewport.height);
      });
      assert.equal(run.renderer.drawingBuffer.width, viewport.width);
      assert.equal(Number.parseFloat(run.renderer.domElement.style.left), 0);
      run.controller.dispose();
    }
  });

  test(`reduced motion skips card travel and still progresses through the ${cardCount}-card sequence`, async () => {
    setMediaQueryMatches(motionQuery, true);
    const run = harness(true, { width: 900, height: 900 }, cardCount);
    await revealCard(run);
    for (let index = 0; index < cardCount; index += 1) {
      run.controller.activate();
      advanceFrame();
      assert.equal(run.cardStates.at(-1)!.transitioning, false);
      assert.equal(run.cardStates.at(-1)!.mode, index < cardCount - 1 ? 'stack' : 'row');
      assert.equal(frames.size, 0);
    }
    assert.deepEqual(run.events.filter(event => event === 'swipe' || event === 'spread'), expectedSounds);
  });

  test(`${cardCount}-card cycling pauses in hidden tabs without skipping the remaining animation on return`, async () => {
    const run = harness(true, { width: 900, height: 900 }, cardCount);
    await revealCard(run);
    run.controller.activate();
    for (let index = 0; index < 4; index += 1) advanceFrame(50);
    const before = run.renderer.snapshots.at(-1)!.cards.map(card => card.matrix);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.equal(frames.size, 0);
    advanceFrame(60_000);
    assert.deepEqual(run.renderer.snapshots.at(-1)!.cards.map(card => card.matrix), before);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    advanceFrame();
    assert.equal(run.cardStates.at(-1)!.mode, 'cycling');
    drainFrames();
    assert.deepEqual(run.cardStates.at(-1), { mode: 'stack', activeCardIndex: 1, transitioning: false });
    assert.equal(run.events.filter(event => event === 'swipe').length, 1);
  });

  test(`disposing a partially loaded ${cardCount}-card scene prevents late warming and state callbacks`, async () => {
    const run = harness(true, { width: 900, height: 900 }, cardCount);
    run.surfaces[0]!.loaded.resolve();
    await flush();
    const states = run.cardStates.slice();
    run.controller.dispose();
    run.controller.dispose();
    run.surfaces.slice(1).forEach(surface => surface.loaded.resolve());
    await flush();
    assert.equal(run.renderer.compileCount, 0);
    assert.equal(run.renderer.renders.length, 0);
    assert.deepEqual(run.events, []);
    assert.deepEqual(run.cardStates, states);
    assert.ok(run.surfaces.every(surface => surface.disposeCount === 1));
    assert.equal(run.host.children.length, 0);
    run.controller.activate();
    run.controller.setCardReady(true);
    assert.equal(frames.size, 0);
  });

  test(`failure of one ${cardCount}-card surface blocks all warming and reports a single recoverable error`, async () => {
    const run = harness(true, { width: 900, height: 900 }, cardCount);
    run.surfaces[1]!.loaded.reject(new Error('Artwork failed'));
    await flush();
    run.surfaces.forEach((surface, index) => { if (index !== 1) surface.loaded.resolve(); });
    await flush();
    assert.deepEqual(run.events, ['error']);
    assert.equal(run.renderer.compileCount, 0);
    assert.equal(run.renderer.renders.length, 0);
    run.controller.activate();
    run.controller.setCardReady(true);
    assert.equal(frames.size, 0);
    run.controller.dispose();
    assert.ok(run.surfaces.every(surface => surface.disposeCount === 1));
  });
}

test('context loss while warming the second card prevents the third warm render and opening', async () => {
  const run = harness(true, { width: 900, height: 900 }, 3);
  let warmed = 0;
  run.renderer.onRender = offscreen => {
    if (offscreen && ++warmed === 2) run.renderer.loseContext();
  };
  await warmCard(run);
  assert.equal(warmed, 2);
  assert.deepEqual(run.events, ['error']);
  assert.equal(run.renderer.target, null);
  assert.equal(frames.size, 0);
  run.controller.dispose();
  assert.ok(run.surfaces.every(surface => surface.disposeCount === 1));
});


test('card faces occlude rear foil during opening and switch to ordered layering after reveal', async () => {
  for (const cardCount of [1, 2, 3]) {
    const run = harness(true, { width: 900, height: 900 }, cardCount);
    await revealCard(run);
    if (cardCount > 1) {
      for (let index = 0; index < cardCount; index += 1) {
        run.controller.activate();
        drainFrames();
      }
    }
    const visibleFrames = run.renderer.snapshots.filter(snapshot => !snapshot.offscreen
      && snapshot.cards.some(card => card.visible));
    const opening = visibleFrames.filter(snapshot => snapshot.packVisible);
    const revealed = visibleFrames.filter(snapshot => !snapshot.packVisible);
    assert.ok(opening.some(snapshot => snapshot.pose!.tear > 0 && snapshot.pose!.tear < 1));
    assert.ok(opening.some(snapshot => snapshot.pose!.discard > 0 && snapshot.pose!.discard < 1));
    assert.ok(revealed.length > 0);
    for (const snapshot of opening) {
      assert.ok(snapshot.cards.every(card => card.frontDepthWrite && card.backDepthWrite),
        'Front and back faces must write depth while the foil can pass behind them');
    }
    for (const snapshot of revealed) {
      assert.ok(snapshot.cards.every(card => !card.frontDepthWrite && !card.backDepthWrite),
        'Revealed faces must use render order so tilted cards cannot cut through the stack');
    }
    run.controller.dispose();
  }
});

test('opening inspection samples exact frames without advancing time, replaying sounds, or reallocating the scene', async () => {
  const run = harness(true, { width: 900, height: 900 }, 3);
  run.controller.setInspectionTime(0);
  drainFrames();
  assert.ok(run.renderer.snapshots.at(-1)!.cards.every(card => !card.visible));
  await warmCard(run);
  drainFrames();
  const fixedMatrices: number[][] = [];
  for (const elapsed of [1000 / 60, 500, 783.333333333, 1250, 1300, 650]) {
    run.controller.setInspectionTime(elapsed);
    advanceFrame(60_000);
    const snapshot = run.renderer.snapshots.at(-1)!;
    assert.deepEqual(snapshot.pose, {
      hit: 0, hitX: 0, hitY: 0, variant: 0, ...sampleDogeFoilOpening(elapsed),
    });
    assert.equal(snapshot.packVisible, elapsed < 1300);
    assert.ok(snapshot.cards.every(card => card.visible));
    assert.ok(snapshot.cards.every(card => card.frontDepthWrite === (elapsed < 1300)
      && card.backDepthWrite === (elapsed < 1300)));
    if (!fixedMatrices.length) fixedMatrices.push(...snapshot.cards.map(card => card.matrix));
    else assert.deepEqual(snapshot.cards.map(card => card.matrix), fixedMatrices);
    assert.equal(frames.size, 0);
    run.controller.activate();
    assert.equal(frames.size, 0);
  }
  assert.deepEqual(run.events, ['ready']);
  assert.equal(run.renderer.compileCount, 1);
  assert.equal(run.renderer.snapshots.filter(snapshot => snapshot.offscreen).length, 3);
  run.controller.setInspectionTime(null);
  drainFrames();
  assert.equal(run.stages.at(-1), 'sealed');
  run.controller.activate();
  assert.equal(run.events.at(-1), 'hit');
});

test('opening inspection waits for GPU readiness and resumes the same requested frame after a hidden tab', async () => {
  const run = harness(true);
  run.controller.setInspectionTime(925);
  drainFrames();
  assert.ok(run.renderer.snapshots.at(-1)!.cards.every(card => !card.visible));
  await warmCard(run);
  drainFrames();
  assert.ok(run.renderer.snapshots.at(-1)!.cards.every(card => card.visible));
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  run.controller.setInspectionTime(1100);
  assert.equal(frames.size, 0);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  advanceFrame(60_000);
  assert.equal(run.renderer.snapshots.at(-1)!.pose!.discard, sampleDogeFoilOpening(1100).discard);
  assert.equal(frames.size, 0);
  run.controller.dispose();
  run.controller.setInspectionTime(500);
  assert.equal(frames.size, 0);
});

test('inspection contact sheets capture all 79 opening frames with the existing renderer and restore the selected time', async (t) => {
  const run = harness(true);
  run.controller.setInspectionTime(600);
  assert.deepEqual(run.controller.captureOpeningFrames(), []);
  await warmCard(run);
  drainFrames();
  let captures = 0;
  let sheetCount = 0;
  const contexts = [] as string[];
  const crops: number[][] = [];
  t.mock.method(dom.window.HTMLCanvasElement.prototype, 'getContext', ((kind: string) => {
    contexts.push(kind);
    return { fillRect() {}, fillText() {}, drawImage(_canvas: unknown, ...dimensions: number[]) { captures += 1; crops.push(dimensions); } };
  }) as typeof dom.window.HTMLCanvasElement.prototype.getContext);
  t.mock.method(dom.window.HTMLCanvasElement.prototype, 'toDataURL', () => `data:image/png;base64,sheet-${sheetCount++}`);
  const start = run.renderer.snapshots.length;
  assert.equal(run.controller.captureOpeningFrames().length, 4);
  assert.equal(captures, 79);
  assert.ok(crops.every(crop => crop.length === 8 && crop[0] > 0 && crop[2] < 900 && crop[3] === 900));
  assert.deepEqual(contexts, ['2d', '2d', '2d', '2d']);
  assert.equal(renderers.length, 1);
  const snapshots = run.renderer.snapshots.slice(start);
  assert.equal(snapshots.length, 80);
  assert.ok(run.pack.resizeMotion.slice(-80).every(preserve => !preserve));
  snapshots.slice(0, -1).forEach((snapshot, index) => {
    const opening = sampleDogeFoilOpening(index * 1000 / 60);
    assert.equal(snapshot.pose!.tear, opening.tear);
    assert.equal(snapshot.pose!.discard, opening.discard);
  });
  assert.equal(snapshots.at(-1)!.pose!.discard, sampleDogeFoilOpening(600).discard);
  assert.deepEqual(run.events, ['ready']);
  assert.equal(frames.size, 0);
});

test('inspection capture discards partial sheets when context loss precedes its DOM event', async (t) => {
  const run = harness(true);
  run.controller.setInspectionTime(600);
  await warmCard(run);
  drainFrames();
  let rendered = 0;
  let copied = 0;
  let sheets = 0;
  t.mock.method(dom.window.HTMLCanvasElement.prototype, 'getContext', (() => ({
    fillRect() {}, fillText() {},
    drawImage() {
      assert.equal(run.renderer.contextLost, false);
      copied += 1;
    },
  })) as typeof dom.window.HTMLCanvasElement.prototype.getContext);
  t.mock.method(dom.window.HTMLCanvasElement.prototype, 'toDataURL', () => `data:image/png;base64,sheet-${sheets++}`);
  run.renderer.onRender = offscreen => {
    if (!offscreen && ++rendered === 22) run.renderer.contextLost = true;
  };
  assert.deepEqual(run.controller.captureOpeningFrames(), []);
  assert.equal(rendered, 22);
  assert.equal(copied, 21);
  assert.equal(sheets, 1);
  assert.deepEqual(run.events, ['ready', 'error']);
  run.renderer.loseContext();
  run.controller.setInspectionTime(800);
  run.controller.setCardReady(true);
  run.controller.activate();
  assert.deepEqual(run.controller.captureOpeningFrames(), []);
  assert.deepEqual(run.events, ['ready', 'error']);
  assert.equal(rendered, 22);
  assert.equal(frames.size, 0);
});

test('inspection density overrides preserve native sizing outside inspection and restore the actual display density', async () => {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
  const run = harness(true, { width: 390, height: 844 });
  await warmCard(run);
  drainFrames();
  run.controller.setInspectionDensity(3);
  drainFrames();
  assert.equal(run.renderer.drawingBuffer.density, 2);
  run.controller.setInspectionTime(800);
  drainFrames();
  assert.equal(run.renderer.drawingBuffer.density, 3);
  assert.equal(run.renderer.domElement.width, 390 * 3);
  run.controller.setInspectionDensity(1);
  drainFrames();
  assert.equal(run.renderer.drawingBuffer.density, 1);
  run.controller.setInspectionDensity(null);
  drainFrames();
  assert.equal(run.renderer.drawingBuffer.density, 2);
  run.controller.setInspectionDensity(3);
  run.controller.setInspectionTime(null);
  drainFrames();
  assert.equal(run.renderer.drawingBuffer.density, 2);
  assert.equal(run.renderer.compileCount, 1);
  assert.equal(frames.size, 0);
});
