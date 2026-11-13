import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, createRef, StrictMode, type ComponentProps } from 'react';
import * as THREE from 'three';
import type { ClearCardThreeViewerHandle } from '../src/ClearCardThreeViewer.tsx';
import { createClearCardLightingPreset } from '../src/clearCardLighting.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom, setMediaQueryMatches } = setupFrontendDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let frameTime = 0;
let failRenderer = false;
let pointerCapture: number | null = null;
const renderers: FakeRenderer[] = [];
const decoders: FakeDracoLoader[] = [];
const loads: Array<{
  url: string;
  resolve: (value: { scene: THREE.Group }) => void;
  reject: (error: Error) => void;
}> = [];

Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => ({
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    drawImage() {},
  }),
});
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'toBlob', {
  configurable: true,
  value: (callback: BlobCallback) => callback(new Blob(['snapshot'], { type: 'image/png' })),
});
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 400 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 560 });
Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });
HTMLElement.prototype.getBoundingClientRect = () => ({
  left: 0, top: 0, right: 400, bottom: 560, width: 400, height: 560, x: 0, y: 0,
  toJSON() {},
});
HTMLElement.prototype.setPointerCapture = id => { pointerCapture = id; };
HTMLElement.prototype.hasPointerCapture = id => pointerCapture === id;
HTMLElement.prototype.releasePointerCapture = id => { if (pointerCapture === id) pointerCapture = null; };
window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
window.cancelAnimationFrame = id => { frames.delete(id); };

class FakeRenderer {
  pixelRatio = 1;
  size = new THREE.Vector2();
  target: THREE.WebGLRenderTarget | null = null;
  transmissionResolutionScale = 1;
  toneMappingExposure = 1;
  disposed = 0;
  lost = 0;
  renderLists = { dispose() {} };
  renders: Array<{ rotation: THREE.Quaternion; target: THREE.WebGLRenderTarget | null }> = [];
  constructor(readonly options: { canvas: HTMLCanvasElement }) {
    if (failRenderer) throw new Error('WebGL unavailable');
    renderers.push(this);
  }
  setClearColor() {}
  setPixelRatio(value: number) { this.pixelRatio = value; }
  getPixelRatio() { return this.pixelRatio; }
  setSize(width: number, height: number) {
    this.size.set(width, height);
    this.options.canvas.width = width * this.pixelRatio;
    this.options.canvas.height = height * this.pixelRatio;
  }
  getSize(target: THREE.Vector2) { return target.copy(this.size); }
  getRenderTarget() { return this.target; }
  setRenderTarget(target: THREE.WebGLRenderTarget | null) { this.target = target; }
  clear() {}
  render(scene: THREE.Scene) {
    assert.equal(this.disposed, 0);
    const pivot = scene.children.find(child => child instanceof THREE.Group)!;
    this.renders.push({ rotation: pivot.quaternion.clone(), target: this.target });
  }
  readRenderTargetPixels(_target: THREE.WebGLRenderTarget, _x: number, _y: number, _width: number, _height: number, pixels: Uint8Array) {
    for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
  }
  dispose() { this.disposed++; }
  forceContextLoss() { this.lost++; }
}
class FakePMREMGenerator {
  fromScene() { return new THREE.WebGLRenderTarget(1, 1); }
  fromEquirectangular() { return new THREE.WebGLRenderTarget(1, 1); }
  dispose() {}
}
class FakeDracoLoader {
  disposed = 0;
  workerLimit = 0;
  constructor() { decoders.push(this); }
  setDecoderPath() {}
  setWorkerLimit(value: number) { this.workerLimit = value; }
  dispose() { this.disposed++; }
}
class FakeLoader {
  setDRACOLoader() {}
  loadAsync(url: string) {
    return new Promise<{ scene: THREE.Group }>((resolve, reject) => loads.push({ url, resolve, reject }));
  }
}

const bridge = '__clearCardThreeViewerTest';
Object.defineProperty(globalThis, bridge, { configurable: true, value: { FakeRenderer, FakePMREMGenerator, FakeDracoLoader, FakeLoader } });
const imports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/ClearCardThreeViewer.tsx') || context.parentURL?.endsWith('/clear-card-viewer/runtime.ts')) {
      if (specifier === 'three') return { url: 'test:clear-card-three', shortCircuit: true };
      if (specifier.endsWith('/DRACOLoader.js')) return { url: 'test:clear-card-draco', shortCircuit: true };
      if (specifier.endsWith('/GLTFLoader.js')) return { url: 'test:clear-card-loader', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:clear-card-three') return { format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(import.meta.resolve('three'))}; export const WebGLRenderer = globalThis.${bridge}.FakeRenderer; export const PMREMGenerator = globalThis.${bridge}.FakePMREMGenerator;` };
    if (url === 'test:clear-card-draco') return { format: 'module', shortCircuit: true,
      source: `export const DRACOLoader = globalThis.${bridge}.FakeDracoLoader;` };
    if (url === 'test:clear-card-loader') return { format: 'module', shortCircuit: true,
      source: `export const GLTFLoader = globalThis.${bridge}.FakeLoader;` };
    return nextLoad(url, context);
  },
});
const { default: Viewer } = await import('../src/ClearCardThreeViewer.tsx');
imports.deregister();
type Props = ComponentProps<typeof Viewer>;

function props(overrides: Partial<Props> = {}): Props {
  return {
    ready: true,
    cardModelUrl: '/card.glb',
    packModelUrl: '/pack.glb',
    lightingConfig: createClearCardLightingPreset('final_v3'),
    unrestrictedMovement: false,
    axisLockedOrbit: false,
    initiallyRevealed: false,
    onStatusChange() {},
    ...overrides,
  };
}
function model(transmission = 0) {
  const scene = new THREE.Group();
  const texture = new THREE.Texture();
  let geometryDisposed = 0, materialDisposed = 0, textureDisposed = 0, imageClosed = 0;
  texture.source.data = { close() { imageClosed++; } };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 0.1), new THREE.MeshPhysicalMaterial({ map: texture, transmission }));
  mesh.geometry.addEventListener('dispose', () => { geometryDisposed++; });
  mesh.material.addEventListener('dispose', () => { materialDisposed++; });
  texture.addEventListener('dispose', () => { textureDisposed++; });
  scene.add(mesh);
  return { scene, disposed: () => [geometryDisposed, materialDisposed, textureDisposed, imageClosed] };
}
function flush(deltaMs = 16) {
  frameTime += deltaMs;
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(frameTime));
  });
}
async function resolveLoad(index: number, loaded = model()) {
  await act(async () => loads[index].resolve(loaded));
  return loaded;
}
function pointer(canvas: HTMLCanvasElement, type: string, values: Partial<PointerEvent> = {}) {
  fireEvent(canvas, Object.assign(new window.Event(type, { bubbles: true, cancelable: true }), {
    pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: 200, clientY: 280,
    ...values,
  }));
}

beforeEach(() => {
  frames.clear(); loads.length = 0; renderers.length = 0; decoders.length = 0;
  frameTime = 0; failRenderer = false; pointerCapture = null;
  window.sessionStorage.clear();
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
});
afterEach(() => {
  cleanup();
  assert.equal(frames.size, 0);
  assert.ok(renderers.every(renderer => renderer.disposed === 1 && renderer.lost === 1));
  assert.ok(decoders.every(decoder => decoder.disposed >= 1));
  assert.equal(pointerCapture, null);
});
after(() => { Reflect.deleteProperty(globalThis, bridge); dom.window.close(); });

test('initialization is deferred, pack precedes card loading, and card prewarming precedes readiness', async () => {
  const statuses: string[] = [], cardStatuses: string[] = [];
  let renderedFrames = 0;
  const view = render(createElement(Viewer, props({
    onStatusChange: status => statuses.push(status),
    onCardModelLoadStatusChange: status => {
      if (status === 'ready') assert.ok(renderers[0].renders.some(frame => frame.target));
      cardStatuses.push(status);
    },
    onFrameRendered: () => { renderedFrames++; },
  })));
  assert.equal(renderers.length, 0);
  assert.equal(loads.length, 0);
  flush();
  assert.deepEqual(loads.map(load => load.url), ['/pack.glb']);
  const pack = await resolveLoad(0, model(0.7));
  assert.deepEqual(loads.map(load => load.url), ['/pack.glb', '/card.glb']);
  assert.equal(statuses.at(-1), 'loading');
  const card = await resolveLoad(1);
  assert.equal(statuses.at(-1), 'ready');
  assert.deepEqual(cardStatuses, ['loading', 'ready']);
  assert.equal(renderedFrames, 0);
  flush();
  assert.equal(renderedFrames, 1);
  assert.equal(frames.size, 0);
  assert.equal(renderers[0].pixelRatio, 2);
  view.unmount();
  assert.deepEqual(pack.disposed(), [1, 1, 1, 1]);
  assert.deepEqual(card.disposed(), [1, 1, 1, 1]);
});

test('prop updates keep the renderer and discard replaced card loads without publishing stale status', async () => {
  const statuses: string[] = [];
  const initial = props({ packModelUrl: undefined, onStatusChange: status => statuses.push(status) });
  const view = render(createElement(Viewer, initial));
  flush();
  const replacementLighting = { ...initial.lightingConfig, renderer: { ...initial.lightingConfig.renderer, exposure: 2 } };
  view.rerender(createElement(Viewer, { ...initial, ready: false, lightingConfig: replacementLighting, cardModelUrl: '/next.glb' }));
  assert.equal(renderers.length, 1);
  assert.equal(renderers[0].toneMappingExposure, 2);
  assert.equal(decoders[0].workerLimit, 0);
  const stale = await resolveLoad(0);
  assert.deepEqual(stale.disposed(), [1, 1, 1, 1]);
  assert.equal(statuses.at(-1), 'loading');
  const current = await resolveLoad(1);
  assert.equal(statuses.at(-1), 'ready');
  view.unmount();
  assert.deepEqual(current.disposed(), [1, 1, 1, 1]);
});

test('pack replacement and Strict Mode cancel scheduled work and dispose late loads', async () => {
  const initial = props();
  const view = render(createElement(StrictMode, {}, createElement(Viewer, initial)));
  assert.equal(frames.size, 1);
  flush();
  assert.equal(renderers.length, 1);
  view.rerender(createElement(StrictMode, {}, createElement(Viewer, { ...initial, packModelUrl: '/other-pack.glb' })));
  assert.equal(renderers[0].disposed, 1);
  const stale = await resolveLoad(0);
  assert.deepEqual(stale.disposed(), [1, 1, 1, 1]);
  flush();
  assert.equal(renderers.length, 2);
  assert.equal(loads.at(-1)?.url, '/other-pack.glb');
  view.unmount();
  const late = await resolveLoad(1);
  assert.deepEqual(late.disposed(), [1, 1, 1, 1]);
});

test('context loss aborts loaders, stops rendering, and rejects snapshots', async () => {
  const statuses: string[] = [];
  const ref = createRef<ClearCardThreeViewerHandle>();
  const view = render(createElement(Viewer, { ...props({ onStatusChange: status => statuses.push(status) }), ref }));
  flush();
  const canvas = view.container.querySelector('canvas')!;
  const loss = new window.Event('webglcontextlost', { cancelable: true });
  fireEvent(canvas, loss);
  assert.equal(loss.defaultPrevented, true);
  assert.equal(statuses.at(-1), 'error');
  assert.equal(frames.size, 0);
  assert.equal(decoders[0].workerLimit, 0);
  await assert.rejects(ref.current!.captureSnapshot(), /unavailable while the model is loading/);
  const stale = await resolveLoad(0);
  assert.deepEqual(stale.disposed(), [1, 1, 1, 1]);
});

test('keyboard rotation and drag capture survive renderer replacement and release on blur', async () => {
  const initial = props({ packModelUrl: undefined, unrestrictedMovement: true, keyboardRotationEnabled: true });
  const view = render(createElement(Viewer, initial));
  flush(); await resolveLoad(0); flush();
  const canvas = view.container.querySelector('canvas')!;
  assert.equal(canvas.tabIndex, 0);
  fireEvent.keyDown(canvas, { key: 'ArrowRight' });
  flush();
  const rotated = renderers[0].renders.at(-1)!.rotation;
  assert.ok(rotated.angleTo(new THREE.Quaternion()) > 0);
  view.rerender(createElement(Viewer, { ...initial, onStatusChange() {} }));
  flush(); await resolveLoad(1); flush();
  assert.ok(renderers[1].renders.at(-1)!.rotation.angleTo(rotated) < 1e-8);
  pointer(canvas, 'pointerdown');
  assert.equal(pointerCapture, 1);
  pointer(canvas, 'pointermove', { clientX: 250 });
  flush();
  assert.ok(renderers[1].renders.at(-1)!.rotation.angleTo(rotated) > 0);
  fireEvent(window, new window.Event('blur'));
  assert.equal(pointerCapture, null);
});

test('gated reveal, stage quality, callbacks, and reset preserve reduced-motion behavior', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  const stages: string[] = [], hits: number[] = [];
  let breaks = 0;
  const ref = createRef<ClearCardThreeViewerHandle>();
  const initial = props({
    hitProgressionMode: 'reveal-gated', revealReady: false,
    onPackHit: hit => hits.push(hit), onPackBreak: () => { breaks++; }, onStageChange: stage => stages.push(stage),
    renderQualityByStage: {
      pack: { maxPixelRatio: 1, transmissionResolutionScale: 0.5 },
      breaking: { maxPixelRatio: 1, transmissionResolutionScale: 0.5 },
      revealed: { maxPixelRatio: 2, transmissionResolutionScale: 1 },
    },
  });
  const view = render(createElement(Viewer, { ...initial, ref }));
  flush(); await resolveLoad(0); await resolveLoad(1); flush();
  act(() => { for (let index = 0; index < 8; index++) ref.current!.hit(); });
  assert.equal(breaks, 0);
  assert.equal(stages.at(-1), 'pack');
  assert.equal(renderers[0].pixelRatio, 1);
  view.rerender(createElement(Viewer, { ...initial, revealReady: true, ref }));
  act(() => { for (let index = 0; index < 4; index++) ref.current!.hit(); });
  assert.equal(breaks, 1);
  assert.equal(stages.at(-1), 'revealed');
  assert.equal(renderers[0].pixelRatio, 2);
  assert.equal(renderers[0].transmissionResolutionScale, 1);
  assert.ok(hits.length >= 8);
  act(() => ref.current!.reset());
  assert.equal(stages.at(-1), 'pack');
  assert.equal(renderers[0].pixelRatio, 1);
});

test('snapshots restore renderer size, pixel ratio and target before returning the PNG', async () => {
  const ref = createRef<ClearCardThreeViewerHandle>();
  render(createElement(Viewer, { ...props({ packModelUrl: undefined }), ref }));
  flush(); await resolveLoad(0); flush();
  const renderer = renderers[0];
  const size = renderer.size.clone();
  const snapshot = await ref.current!.captureSnapshot({ longestEdge: 700 });
  assert.equal(snapshot.objectKind, 'card');
  assert.equal(snapshot.blob.type, 'image/png');
  assert.deepEqual(renderer.size, size);
  assert.equal(renderer.pixelRatio, 2);
  assert.equal(renderer.target, null);
});

test('throttled interaction skips early frames and releases the cap when dragging ends', async () => {
  const view = render(createElement(Viewer, props({
    packModelUrl: undefined, unrestrictedMovement: true, interactionFrameRateMode: 'throttled',
  })));
  flush(); await resolveLoad(0); flush();
  const renderer = renderers[0];
  const canvas = view.container.querySelector('canvas')!;
  pointer(canvas, 'pointerdown');
  pointer(canvas, 'pointermove', { clientX: 250 });
  flush(1);
  const count = renderer.renders.length;
  pointer(canvas, 'pointermove', { clientX: 260 });
  flush(10);
  assert.equal(renderer.renders.length, count);
  flush(24);
  assert.equal(renderer.renders.length, count + 1);
  pointer(canvas, 'pointerup', { clientX: 260 });
  flush(1);
  assert.equal(renderer.renders.length, count + 2);
  assert.equal(frames.size, 0);
});

test('adaptive interaction records slow-frame throttling and resumes uncapped rendering after release', async () => {
  const view = render(createElement(Viewer, props({
    packModelUrl: undefined, unrestrictedMovement: true, interactionFrameRateMode: 'adaptive',
  })));
  flush(); await resolveLoad(0);
  for (let index = 0; index < 10; index++) flush();
  const renderer = renderers[0];
  const canvas = view.container.querySelector('canvas')!;
  pointer(canvas, 'pointerdown');
  pointer(canvas, 'pointermove', { clientX: 250 });
  for (let index = 0; index < 11; index++) flush(50);
  assert.ok(Number(window.sessionStorage.getItem('mons.clear-card.interaction-throttle-required.v1')) > 0);
  pointer(canvas, 'pointermove', { clientX: 260 });
  flush(1);
  const count = renderer.renders.length;
  pointer(canvas, 'pointermove', { clientX: 270 });
  flush(10);
  assert.equal(renderer.renders.length, count);
  pointer(canvas, 'pointerup', { clientX: 270 });
  flush(1);
  assert.equal(renderer.renders.length, count + 1);
});

test('initial reveal remains latched while hit callbacks update without rebuilding the renderer', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  const ref = createRef<ClearCardThreeViewerHandle>();
  const stages: string[] = [];
  let oldHits = 0, newHits = 0;
  const initial = props({ onStageChange: stage => stages.push(stage), onPackHit: () => { oldHits++; } });
  const view = render(createElement(Viewer, { ...initial, ref }));
  flush(); await resolveLoad(0); await resolveLoad(1); flush();
  view.rerender(createElement(Viewer, {
    ...initial, initiallyRevealed: true, onPackHit: () => { newHits++; }, ref,
  }));
  act(() => ref.current!.hit());
  assert.equal(renderers.length, 1);
  assert.equal(oldHits, 0);
  assert.equal(newHits, 1);
  view.rerender(createElement(Viewer, { ...initial, initiallyRevealed: true, packModelUrl: '/replacement.glb', ref }));
  flush(); await resolveLoad(2); await resolveLoad(3); flush();
  assert.equal(stages.at(-1), 'pack');
});
