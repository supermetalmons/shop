import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
import * as THREE from 'three';
import type { PrimaryMediaControls } from '../src/components/MediaWithFallback.tsx';
import type { MiNotePackStar } from '../src/lib/miNotePackStars.ts';
import { MI_NOTE_PACK_RENDER_REGISTRY, getMiNotePackRenderSetupByPackId, restoreMiNotePackRenderCamera } from '../src/lib/miNotePackRenderSetup.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom, setMediaQueryMatches } = setupFrontendDom();
const { act, cleanup, render } = await import('@testing-library/react');
const motionQuery = '(prefers-reduced-motion: reduce)';
const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;
let now = 1000;
let width = 1050;
let height = 1400;
let failure: 'constructor' | 'model' | 'compile' | 'render' | 'shader-compile' | 'shader-render' | null = null;
let rendererAttempts = 0;
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => {
    frames.set(++nextFrameId, callback);
    return nextFrameId;
  } });
  Object.defineProperty(target, 'cancelAnimationFrame', { configurable: true, value: (id: number) => { frames.delete(id); } });
}
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => height });
Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });

const resizeObservers = new Set<FakeResizeObserver>();
class FakeResizeObserver {
  constructor(readonly callback: () => void) {}
  observe() { resizeObservers.add(this); }
  disconnect() { resizeObservers.delete(this); }
}
const intersectionObservers = new Set<FakeIntersectionObserver>();
class FakeIntersectionObserver {
  constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe() { intersectionObservers.add(this); }
  disconnect() { intersectionObservers.delete(this); }
}
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: FakeResizeObserver });
Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: FakeIntersectionObserver });

type TestModel = {
  group: THREE.Group;
  flipRoot: THREE.Group;
  material: THREE.MeshStandardMaterial;
  mesh: THREE.Mesh;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  star: string;
  color: string;
  disposed: boolean;
  setColor: (value: string) => void;
  setFolderPhase: () => void;
  dispose: () => void;
};

function createTestModel({ color, star }: { color: string; star: MiNotePackStar }): TestModel {
  if (failure === 'model') throw new Error('Model creation failed');
  const group = new THREE.Group();
  const flipRoot = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.01), material);
  group.add(flipRoot);
  flipRoot.add(mesh);
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const model = {
    group, flipRoot, material, mesh, ready, resolveReady, rejectReady,
    star: star.id,
    color,
    disposed: false,
    setColor(value: string) {
      assert.equal(model.disposed, false);
      model.color = value;
      material.color.set(value);
    },
    setFolderPhase() { assert.equal(model.disposed, false); },
    dispose() {
      assert.equal(model.disposed, false);
      model.disposed = true;
      rejectReady(new dom.window.DOMException('Cancelled', 'AbortError'));
      mesh.geometry.dispose();
      material.dispose();
      group.removeFromParent();
    },
  };
  models.push(model);
  return model;
}
const models: TestModel[] = [];

type RenderedFrame = {
  model: TestModel;
  color: string;
  rotation: number[];
  position: number[];
  scale: number[];
  camera: THREE.PerspectiveCamera;
};
class FakeWebGLRenderer {
  domElement = document.createElement('canvas');
  debug: { checkShaderErrors: boolean; onShaderError: (() => void) | null } = { checkShaderErrors: true, onShaderError: null };
  capabilities = { getMaxAnisotropy: () => 8 };
  rendered: RenderedFrame[] = [];
  compiled = false;
  disposed = false;
  disposedInsideShaderCallback = false;
  contextLost = false;
  pixelRatio = 0;
  size: number[] = [];
  constructor() {
    rendererAttempts += 1;
    if (failure === 'constructor') throw new Error('WebGL unavailable');
    renderers.push(this);
  }
  setClearColor() {}
  setPixelRatio(value: number) { this.pixelRatio = value; }
  setSize(nextWidth: number, nextHeight: number) { this.size = [nextWidth, nextHeight]; }
  compile() {
    assert.equal(this.disposed, false);
    if (failure === 'compile') throw new Error('Shader compilation failed');
    if (failure === 'shader-compile' && this.debug.checkShaderErrors) this.debug.onShaderError?.();
    this.disposedInsideShaderCallback ||= this.disposed;
    assert.equal(this.disposed, false, 'Shader failure cleanup must wait for compile to return');
    this.compiled = true;
  }
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    assert.equal(this.disposed, false);
    if (failure === 'render') throw new Error('Rendering failed');
    if (failure === 'shader-render' && this.debug.checkShaderErrors) this.debug.onShaderError?.();
    this.disposedInsideShaderCallback ||= this.disposed;
    assert.equal(this.disposed, false, 'Shader failure cleanup must wait for render to return');
    const visible = models.filter(model => model.group.parent === scene && model.group.visible);
    assert.equal(visible.length, 1);
    const model = visible[0];
    this.rendered.push({
      model, color: model.color, rotation: model.group.rotation.toArray().slice(0, 3) as number[],
      position: model.group.position.toArray(), scale: model.group.scale.toArray(), camera: camera.clone(),
    });
  }
  dispose() { assert.equal(this.disposed, false); this.disposed = true; }
  forceContextLoss() { this.contextLost = true; }
}
const renderers: FakeWebGLRenderer[] = [];
const bridgeKey = '__miNotePackShowcaseTest';
Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: { FakeWebGLRenderer, createTestModel } });
const imports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/components/MiNotePackShowcase.tsx')) {
      if (specifier === 'three') return { url: 'test:mi-note-showcase-three', shortCircuit: true };
      if (specifier.endsWith('/miNotePackModel')) return { url: 'test:mi-note-showcase-model', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:mi-note-showcase-three') return {
      format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(import.meta.resolve('three'))}; export const WebGLRenderer = globalThis.${bridgeKey}.FakeWebGLRenderer;`,
    };
    if (url === 'test:mi-note-showcase-model') return {
      format: 'module', shortCircuit: true,
      source: `export const createMiNotePackModel = globalThis.${bridgeKey}.createTestModel;`,
    };
    return nextLoad(url, context);
  },
});
const { default: MiNotePackShowcase } = await import('../src/components/MiNotePackShowcase.tsx');
imports.deregister();

beforeEach(() => {
  models.length = 0;
  renderers.length = 0;
  rendererAttempts = 0;
  failure = null;
  now = 1000;
  width = 1050;
  height = 1400;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  setMediaQueryMatches(motionQuery, false);
});
afterEach(async () => {
  await act(async () => cleanup());
  assert.equal(frames.size, 0);
  assert.equal(resizeObservers.size, 0);
  assert.equal(intersectionObservers.size, 0);
  assert.ok(models.every(model => model.disposed));
  assert.ok(renderers.every(renderer => renderer.disposed && renderer.contextLost));
  assert.ok(renderers.every(renderer => !renderer.disposedInsideShaderCallback), 'Cleanup must wait until Three returns');
});
after(() => { Reflect.deleteProperty(globalThis, bridgeKey); dom.window.close(); });

function harness() {
  const events: string[] = [];
  const media: PrimaryMediaControls = {
    ready: false, hidden: false,
    onLoading: () => { events.push('loading'); },
    onReady: () => { events.push('ready'); },
    onError: () => { events.push('error'); },
  };
  const view = render(createElement(MiNotePackShowcase, { media }));
  return { view, events, host: view.container.firstElementChild as HTMLElement };
}

async function makeReady(selected = models) {
  await act(async () => {
    selected.forEach(model => model.resolveReady());
    await Promise.all(selected.map(model => model.ready));
  });
}

function advanceFrame(milliseconds = 50) {
  assert.equal(frames.size, 1);
  act(() => {
    now += milliseconds;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(now));
  });
}

function finishHandoff(run: ReturnType<typeof harness>) {
  for (let index = 0; !run.events.includes('ready') && index < 20; index += 1) advanceFrame();
  assert.deepEqual(run.events, ['loading', 'ready']);
}

function lastPose() {
  const frame = renderers[0].rendered.at(-1)!;
  return { star: frame.model.star, color: frame.color, rotation: frame.rotation, position: frame.position, scale: frame.scale };
}

test('the image stays active until all stickers load and the first rendered pack finishes fading in', async (t) => {
  const listeners: { target: HTMLElement; type: string }[] = [];
  const addEventListener = HTMLElement.prototype.addEventListener;
  t.mock.method(HTMLElement.prototype, 'addEventListener', function(this: HTMLElement, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
    listeners.push({ target: this, type });
    addEventListener.call(this, type, listener, options);
  });
  const run = harness();
  assert.equal(renderers.length, 1);
  assert.equal(models.length, 3);
  assert.deepEqual(models.map(model => model.star), ['blush', 'zombie', 'supermetal']);
  assert.deepEqual(run.events, ['loading']);
  assert.equal(run.host.dataset.visible, 'false');
  assert.equal(run.host.hasAttribute('tabindex'), false);
  assert.equal(run.host.querySelectorAll('button, a, input, [tabindex]').length, 0);
  assert.deepEqual(listeners.filter(listener => listener.target === run.host), []);
  await makeReady(models.slice(0, 2));
  assert.equal(frames.size, 0);
  assert.equal(renderers[0].compiled, false);
  await makeReady(models.slice(2));
  assert.equal(renderers[0].compiled, true);
  advanceFrame();
  assert.equal(run.host.dataset.visible, 'true');
  assert.equal(run.host.dataset.packId, '1');
  assert.deepEqual(run.events, ['loading']);
  for (let index = 0; index < 12; index += 1) advanceFrame();
  assert.deepEqual(run.events, ['loading']);
  finishHandoff(run);
});

test('colors cycle blue, green, yellow with random stickers using one renderer and the same three models', async (t) => {
  const run = harness();
  await makeReady();
  finishHandoff(run);
  const originalModels = [...models];
  const originalMaterials = models.map(model => model.material);
  const seen = new Map<number, RenderedFrame>();
  const variants = [getMiNotePackRenderSetupByPackId(Number(run.host.dataset.packId))!.variantId];
  let random = 0;
  t.mock.method(Math, 'random', () => random);
  for (let index = 0; index < 1200; index += 1) {
    random = (Math.floor(index / 159) % 3 + 0.5) / 3;
    advanceFrame();
    const packId = Number(run.host.dataset.packId);
    const setup = getMiNotePackRenderSetupByPackId(packId)!;
    if (variants.at(-1) !== setup.variantId) {
      variants.push(setup.variantId);
      assert.equal(setup.sticker.id, ['blush', 'zombie', 'supermetal'][Math.floor(random * 3)]);
    }
    seen.set(packId, renderers[0].rendered.at(-1)!);
  }
  assert.ok(variants.length > 9);
  assert.deepEqual(variants, variants.map((_, index) => ['cobalt-blue', 'emerald', 'marigold'][index % 3]));
  assert.deepEqual([...seen.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const [packId, frame] of seen) {
    const setup = getMiNotePackRenderSetupByPackId(packId)!;
    assert.equal(frame.model.star, setup.sticker.id);
    assert.equal(frame.color, setup.color);
  }
  assert.equal(rendererAttempts, 1);
  assert.deepEqual(models, originalModels);
  assert.deepEqual(models.map(model => model.material), originalMaterials);
  assert.ok(models.every(model => !model.disposed));
  assert.deepEqual(run.events, ['loading', 'ready']);
});

test('hidden, offscreen, and cached pages pause without advancing or jumping their animation clocks', async () => {
  const run = harness();
  await makeReady();
  finishHandoff(run);
  for (let index = 0; index < 20; index += 1) advanceFrame();
  const pauseCases = [
    {
      pause() { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new dom.window.Event('visibilitychange')); },
      resume() { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new dom.window.Event('visibilitychange')); },
    },
    {
      pause() { intersectionObservers.forEach(observer => observer.callback([{ isIntersecting: false }])); },
      resume() { intersectionObservers.forEach(observer => observer.callback([{ isIntersecting: true }])); },
    },
    {
      pause() { window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: true })); },
      resume() { window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true })); },
    },
  ];
  for (const paused of pauseCases) {
    const pose = lastPose();
    const renders = renderers[0].rendered.length;
    act(paused.pause);
    assert.equal(frames.size, 0);
    now += 60_000;
    assert.equal(renderers[0].rendered.length, renders);
    act(paused.resume);
    advanceFrame();
    assert.deepEqual(lastPose(), pose);
    advanceFrame();
    assert.notDeepEqual(lastPose(), pose);
  }
  assert.deepEqual(run.events, ['loading', 'ready']);
});

test('an offscreen pack waits to render and reduced motion presents static pack 1 without an animation loop', async () => {
  setMediaQueryMatches(motionQuery, true);
  const run = harness();
  act(() => intersectionObservers.forEach(observer => observer.callback([{ isIntersecting: false }])));
  await makeReady();
  assert.equal(frames.size, 0);
  assert.deepEqual(run.events, ['loading']);
  act(() => intersectionObservers.forEach(observer => observer.callback([{ isIntersecting: true }])));
  advanceFrame();
  assert.equal(run.host.dataset.packId, '1');
  assert.equal(run.host.dataset.visible, 'true');
  assert.deepEqual(run.events, ['loading', 'ready']);
  assert.equal(frames.size, 0);
});

test('enabling reduced motion during a later pack returns to static pack 1 and can resume safely', async () => {
  const run = harness();
  await makeReady();
  finishHandoff(run);
  for (let index = 0; index < 90; index += 1) advanceFrame();
  assert.notEqual(run.host.dataset.packId, '1');
  act(() => setMediaQueryMatches(motionQuery, true));
  advanceFrame();
  assert.equal(run.host.dataset.packId, '1');
  assert.equal(frames.size, 0);
  const pose = lastPose();
  act(() => setMediaQueryMatches(motionQuery, false));
  advanceFrame();
  assert.deepEqual(lastPose(), pose);
  assert.equal(frames.size, 1);
  assert.deepEqual(run.events, ['loading', 'ready']);
});

test('resizing keeps the saved image projection centered and contained without stretching', async () => {
  setMediaQueryMatches(motionQuery, true);
  const run = harness();
  await makeReady();
  advanceFrame();
  const setup = getMiNotePackRenderSetupByPackId(1)!;
  const output = MI_NOTE_PACK_RENDER_REGISTRY.shared.output;
  const sourceCamera = new THREE.PerspectiveCamera();
  restoreMiNotePackRenderCamera(sourceCamera, setup);
  const points = [new THREE.Vector3(-0.4, 0.6, 0), new THREE.Vector3(0.5, -0.7, 0.03), new THREE.Vector3(0, 0, 0.02)];
  for (const viewport of [[480, 640], [1200, 500], [320, 700]]) {
    [width, height] = viewport;
    act(() => resizeObservers.forEach(observer => observer.callback()));
    advanceFrame();
    const camera = renderers[0].rendered.at(-1)!.camera;
    const scale = Math.min(width / output.width, height / output.height);
    const imageWidth = output.width * scale;
    const imageHeight = output.height * scale;
    for (const point of points) {
      const source = point.clone().project(sourceCamera);
      const live = point.clone().project(camera);
      const x = (width - imageWidth) / 2 + (source.x + 1) * imageWidth / 2;
      const y = (height - imageHeight) / 2 + (1 - source.y) * imageHeight / 2;
      assert.ok(Math.abs((live.x + 1) * width / 2 - x) < 1e-8);
      assert.ok(Math.abs((1 - live.y) * height / 2 - y) < 1e-8);
    }
    assert.deepEqual(renderers[0].size, viewport);
    assert.equal(renderers[0].pixelRatio, 2);
    assert.equal(frames.size, 0);
  }
  width = 0;
  act(() => resizeObservers.forEach(observer => observer.callback()));
  assert.equal(frames.size, 0);
  width = 320;
  act(() => resizeObservers.forEach(observer => observer.callback()));
  advanceFrame();
  assert.deepEqual(run.events, ['loading', 'ready']);
});

for (const point of ['constructor', 'model', 'texture', 'compile', 'render', 'shader-compile', 'shader-render', 'context'] as const) {
  test(`${point} failure restores the image and releases the complete showcase`, async () => {
    setMediaQueryMatches(motionQuery, true);
    if (point === 'constructor' || point === 'model') failure = point;
    const run = harness();
    if (point === 'texture') {
      await act(async () => { models[1].rejectReady(new Error('Sticker unavailable')); });
    } else if (point !== 'constructor' && point !== 'model') {
      if (point === 'compile' || point === 'render' || point === 'shader-compile' || point === 'shader-render') failure = point;
      await makeReady();
      if (point !== 'compile' && point !== 'shader-compile') advanceFrame();
      if (point === 'context') {
        const event = new dom.window.Event('webglcontextlost', { cancelable: true });
        act(() => renderers[0].domElement.dispatchEvent(event));
        assert.equal(event.defaultPrevented, true);
      }
    }
    assert.equal(run.events.filter(event => event === 'error').length, 1);
    assert.deepEqual(run.events, point === 'context' ? ['loading', 'ready', 'error'] : ['loading', 'error']);
    assert.equal(run.host.dataset.visible, 'false');
    assert.equal(run.host.querySelector('canvas'), null);
    assert.equal(frames.size, 0);
    assert.equal(resizeObservers.size, 0);
    assert.equal(intersectionObservers.size, 0);
    assert.ok(models.every(model => model.disposed));
    assert.ok(renderers.every(renderer => renderer.disposed));
  });
}

for (const phase of ['at the fade boundary', 'after handoff']) {
  test(`a nonthrowing shader error ${phase} keeps the fallback active and stops animation`, async () => {
    const run = harness();
    await makeReady();
    advanceFrame();
    if (phase === 'after handoff') finishHandoff(run);
    else for (let index = 0; index < 12; index += 1) advanceFrame();
    failure = 'shader-render';
    advanceFrame();
    assert.deepEqual(run.events, phase === 'after handoff' ? ['loading', 'ready', 'error'] : ['loading', 'error']);
    assert.equal(run.host.dataset.visible, 'false');
    assert.equal(frames.size, 0);
    assert.equal(renderers[0].disposed, true);
  });
}

test('unmounting during texture loading cancels work and ignores late readiness', async () => {
  const run = harness();
  const pending = [...models];
  await makeReady(pending.slice(0, 1));
  await act(async () => run.view.unmount());
  await act(async () => pending.forEach(model => model.resolveReady()));
  assert.deepEqual(run.events, ['loading']);
  assert.equal(renderers[0].compiled, false);
  assert.equal(renderers[0].rendered.length, 0);
  assert.equal(frames.size, 0);
});

test('unmounting while fading never hides the image through a late ready callback', async () => {
  const run = harness();
  await makeReady();
  advanceFrame();
  await act(async () => run.view.unmount());
  assert.deepEqual(run.events, ['loading']);
  assert.equal(frames.size, 0);
});
