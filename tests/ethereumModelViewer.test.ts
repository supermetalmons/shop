import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, StrictMode } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { EthereumInventoryItem } from '../shared/ethereum/protocol.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let failRenderer = false;
let useRealLoader = false;
let width = 500;
let height = 500;
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  } });
  Object.defineProperty(target, 'cancelAnimationFrame', { configurable: true, value: (id: number) => frames.delete(id) });
}
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => height });
Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });

class FakeRenderer {
  domElement = document.createElement('canvas');
  debug: { onShaderError?: () => void } = {};
  pixelRatio = 0;
  disposed = false;
  lost = false;
  cameras: THREE.PerspectiveCamera[] = [];
  constructor() {
    if (failRenderer) throw new Error('WebGL unavailable');
    renderers.push(this);
  }
  setPixelRatio(value: number) { this.pixelRatio = value; }
  setSize() {}
  render(_scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    assert.equal(this.disposed, false);
    this.cameras.push(camera.clone());
  }
  dispose() { assert.equal(this.disposed, false); this.disposed = true; }
  forceContextLoss() { this.lost = true; }
}
class FakePMREMGenerator {
  fromScene() { return new THREE.WebGLRenderTarget(1, 1); }
  dispose() {}
}
class TrackedControls extends OrbitControls {
  disposed = false;
  constructor(camera: THREE.Camera, canvas: HTMLElement) { super(camera, canvas); controls.push(this); }
  dispose() { this.disposed = true; super.dispose(); }
}
class FakeLoader {
  constructor(private readonly manager: THREE.LoadingManager) {}
  loadAsync(src: string) {
    if (useRealLoader) return new GLTFLoader(this.manager).loadAsync(src);
    return new Promise<{ scene: THREE.Group }>((resolve, reject) => loads.push({ src, resolve, reject }));
  }
}
const renderers: FakeRenderer[] = [];
const controls: TrackedControls[] = [];
const loads: Array<{ src: string; resolve: (value: { scene: THREE.Group }) => void; reject: (error: Error) => void }> = [];
const bridge = '__ethereumModelViewerTest';
Object.defineProperty(globalThis, bridge, { configurable: true, value: { FakeRenderer, FakePMREMGenerator, TrackedControls, FakeLoader } });
const imports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/ethereum/EthereumModelViewer.tsx')) {
      if (specifier === 'three') return { url: 'test:ethereum-model-three', shortCircuit: true };
      if (specifier.endsWith('/OrbitControls.js')) return { url: 'test:ethereum-model-controls', shortCircuit: true };
      if (specifier.endsWith('/GLTFLoader.js')) return { url: 'test:ethereum-model-loader', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:ethereum-model-three') return { format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(import.meta.resolve('three'))}; export const WebGLRenderer = globalThis.${bridge}.FakeRenderer; export const PMREMGenerator = globalThis.${bridge}.FakePMREMGenerator;` };
    if (url === 'test:ethereum-model-controls') return { format: 'module', shortCircuit: true,
      source: `export const OrbitControls = globalThis.${bridge}.TrackedControls;` };
    if (url === 'test:ethereum-model-loader') return { format: 'module', shortCircuit: true,
      source: `export const GLTFLoader = globalThis.${bridge}.FakeLoader;` };
    return nextLoad(url, context);
  },
});
const { default: EthereumModelViewer } = await import('../src/ethereum/EthereumModelViewer.tsx');
const { EthereumArtworkMedia } = await import('../src/ethereum/EthereumArtworkMedia.tsx');
imports.deregister();

beforeEach(() => { frames.clear(); loads.length = 0; renderers.length = 0; controls.length = 0; failRenderer = false; useRealLoader = false; width = height = 500; });
afterEach(() => {
  cleanup();
  assert.equal(frames.size, 0);
  assert.ok(renderers.every(renderer => renderer.disposed && renderer.lost));
  assert.ok(controls.every(control => control.disposed));
});
after(() => { Reflect.deleteProperty(globalThis, bridge); dom.window.close(); });

function model() {
  const scene = new THREE.Group();
  const texture = new THREE.Texture();
  let geometryDisposed = false, materialDisposed = false, textureDisposed = false, imageClosed = false;
  texture.source.data = { close() { imageClosed = true; } };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), new THREE.MeshStandardMaterial({ map: texture }));
  mesh.geometry.addEventListener('dispose', () => { geometryDisposed = true; });
  mesh.material.addEventListener('dispose', () => { materialDisposed = true; });
  texture.addEventListener('dispose', () => { textureDisposed = true; });
  scene.add(mesh);
  return { scene, disposed: () => geometryDisposed && materialDisposed && textureDisposed && imageClosed };
}
function flush() {
  act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); });
}
const src = 'https://wip.lil.org/111k/3d/1.glb';
const nft: EthereumInventoryItem = { id: 'model', chainId: 11155111, contractAddress: `0x${'11'.repeat(20)}`,
  owner: `0x${'22'.repeat(20)}`, tokenId: '1', displayId: 1, kind: 'artwork', name: '1', category: '3d',
  image: 'https://wip.lil.org/111k/3d/1.webp', animation_url: src, aspectRatio: { width: 1, height: 1 } };

test('model rendering fits bounds, supports keyboard orbit and zoom, and stays idle between changes', async () => {
  let ready = 0;
  const loaded = model();
  const view = render(createElement(EthereumModelViewer, { src, label: 'Model 1', onReady: () => { ready++; }, onError: assert.fail }));
  await waitFor(() => assert.equal(loads.length, 1));
  await act(async () => loads[0].resolve(loaded));
  assert.equal(ready, 0);
  flush();
  assert.equal(ready, 1);
  assert.equal(frames.size, 0);
  assert.equal(renderers[0].pixelRatio, 2);
  assert.equal(controls[0].enablePan, false);
  assert.equal(controls[0].autoRotate, false);
  const canvas = view.container.querySelector('canvas')!;
  assert.equal(canvas.tabIndex, 0);
  const initial = renderers[0].cameras.at(-1)!.position.clone();
  fireEvent.keyDown(canvas, { key: 'ArrowRight' });
  flush();
  assert.notEqual(renderers[0].cameras.at(-1)!.position.x, initial.x);
  fireEvent.keyDown(canvas, { key: '+' });
  flush();
  assert.ok(renderers[0].cameras.at(-1)!.position.length() < initial.length());
  fireEvent.keyDown(canvas, { key: 'Home' });
  flush();
  assert.ok(renderers[0].cameras.at(-1)!.position.distanceTo(initial) < 1e-8);
  width = 250;
  act(() => window.dispatchEvent(new window.Event('resize')));
  flush();
  assert.equal(renderers[0].cameras.at(-1)!.aspect, 0.5);
  view.unmount();
  assert.equal(loaded.disposed(), true);
});

test('closing or switching the model discards and disposes late loads', async () => {
  const first = model(), second = model();
  let ready = 0;
  const props = { src, label: 'Model', onReady: () => { ready++; }, onError: assert.fail };
  const view = render(createElement(EthereumModelViewer, props));
  await waitFor(() => assert.equal(loads.length, 1));
  view.rerender(createElement(EthereumModelViewer, { ...props, src: src.replace('/1.glb', '/2.glb') }));
  await waitFor(() => assert.equal(loads.length, 2));
  await act(async () => loads[0].resolve(first));
  assert.equal(first.disposed(), true);
  assert.equal(ready, 0);
  view.unmount();
  await act(async () => loads[1].resolve(second));
  assert.equal(second.disposed(), true);
  assert.equal(ready, 0);
});

test('3D thumbnails stay static and detail loading preserves the poster with error retry', async () => {
  const view = render(createElement(EthereumArtworkMedia, { item: nft }));
  assert.equal(loads.length, 0);
  assert.equal(view.container.querySelector('video'), null);
  view.rerender(createElement(EthereumArtworkMedia, { item: nft, viewer: true }));
  await waitFor(() => assert.equal(loads.length, 1));
  assert.equal(view.container.querySelector('img')!.hidden, false);
  await act(async () => loads[0].reject(new Error('Network unavailable')));
  assert.equal(view.container.querySelector('img')!.hidden, false);
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  await waitFor(() => assert.equal(loads.length, 2));
  const loaded = model();
  await act(async () => loads[1].resolve(loaded));
  assert.equal(view.container.querySelector('img')!.hidden, false);
  flush();
  assert.equal(view.container.querySelector('img')!.hidden, true);
  fireEvent(view.container.querySelector('canvas')!, new window.Event('webglcontextlost', { cancelable: true }));
  assert.equal(view.container.querySelector('img')!.hidden, false);
  assert.equal(loaded.disposed(), true);
  assert.ok(view.getByRole('button', { name: 'Retry' }));
});

test('unsupported WebGL leaves the preview and offers retry', async () => {
  failRenderer = true;
  const view = render(createElement(EthereumArtworkMedia, { item: nft, viewer: true }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Retry' })));
  assert.equal(view.container.querySelector('img')!.hidden, false);
  assert.equal(loads.length, 0);
});

test('StrictMode and Retry keep the real loader request alive until the viewer closes', async t => {
  useRealLoader = true;
  const requests: Array<{ signal: AbortSignal; reject: (error: Error) => void }> = [];
  t.mock.method(globalThis, 'fetch', (request: Request) => new Promise<Response>((_resolve, reject) => {
    requests.push({ signal: request.signal, reject });
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  }));
  const view = render(createElement(StrictMode, null, createElement(EthereumArtworkMedia, { item: nft, viewer: true })));
  await waitFor(() => assert.equal(requests.length, 1));
  assert.equal(requests[0].signal.aborted, false);
  assert.ok(view.getByText('Loading 3D model…'));
  await act(async () => requests[0].reject(new Error('Network unavailable')));
  fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
  await waitFor(() => assert.equal(requests.length, 2));
  assert.equal(requests[1].signal.aborted, false);
  assert.ok(view.getByText('Loading 3D model…'));
  await act(async () => view.unmount());
  assert.equal(requests[1].signal.aborted, true);
});
