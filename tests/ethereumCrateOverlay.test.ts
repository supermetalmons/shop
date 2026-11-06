import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useLayoutEffect } from 'react';
import type { EthereumInventoryItem } from '../shared/ethereum/protocol.ts';
import type { CrateSceneProps } from '../src/ethereum/crate/CrateScene.tsx';
import type { WarehouseCrateImage } from '../src/ethereum/warehouse/warehouseAssets.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const environment = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
let sceneProps: CrateSceneProps | null = null;
type WarehouseSceneProps = Omit<CrateSceneProps, 'hit' | 'press' | 'crateRect'> & {
  hits: readonly { id: number; x: number; y: number }[];
  containerRect: CrateSceneProps['crateRect'];
  onImpact: (critical: boolean) => void;
  crateImage: WarehouseCrateImage | null;
};
let warehouseProps: WarehouseSceneProps | null = null;
let warehousePreparations = 0;
let warmWarehouseAssets = true;
let imageFailure = false;
const imageSources: string[] = [];
const sounds: string[] = [];
const bridge = '__ethereumCrateOverlayTest';
Object.defineProperty(globalThis, bridge, { configurable: true, value: {
  Scene(props: CrateSceneProps) {
    sceneProps = props;
    useLayoutEffect(() => { props.onReady(); }, []);
    useLayoutEffect(() => { if (props.assets) props.onAssetsReady(); }, [props.assets]);
    return createElement('div', { 'data-crate-scene': true });
  },
  WarehouseScene(props: WarehouseSceneProps) {
    warehouseProps = props;
    useLayoutEffect(() => { props.onReady(); }, []);
    useLayoutEffect(() => {
      if (props.crateImage && warmWarehouseAssets) { warehousePreparations++; props.onAssetsReady(); }
    }, [props.crateImage]);
    return createElement('div', { 'data-warehouse-scene': true });
  },
  sounds,
} });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/crate/CrateRevealOverlay.tsx')) {
      if (specifier.endsWith('/CrateScene')) return { url: 'test:crate-overlay-scene', shortCircuit: true };
      if (specifier.endsWith('/WarehouseScene')) return { url: 'test:warehouse-overlay-scene', shortCircuit: true };
      if (specifier.endsWith('/warehouseSounds')) return { url: 'test:warehouse-overlay-sounds', shortCircuit: true };
      if (specifier.endsWith('/crateSounds')) return { url: 'test:crate-overlay-sounds', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:crate-overlay-scene') return { format: 'module', shortCircuit: true,
      source: `export default globalThis.${bridge}.Scene;` };
    if (url === 'test:warehouse-overlay-scene') return { format: 'module', shortCircuit: true,
      source: `export default globalThis.${bridge}.WarehouseScene;` };
    if (url === 'test:warehouse-overlay-sounds') return { format: 'module', shortCircuit: true,
      source: `export async function unlockWarehouseSounds() {};
        export async function preloadWarehouseSounds() {};
        export async function playWarehouseImpactSound(critical) { globalThis.${bridge}.sounds.push(critical ? 'ice-critical' : 'ice-hit'); };` };
    if (url === 'test:crate-overlay-sounds') return { format: 'module', shortCircuit: true,
      source: `export async function preloadCrateSounds() {};
        export async function playCrateHitSound() { globalThis.${bridge}.sounds.push('wood-hit'); };
        export async function playCrateOpenSound() { globalThis.${bridge}.sounds.push('wood-open'); };` };
    return nextLoad(url, context);
  },
});
const { useEthereumInventoryPresentation } = await import('../src/ethereum/useEthereumInventoryPresentation.ts');
const { EthereumInventoryOverlays } = await import('../src/ethereum/EthereumInventoryOverlays.tsx');

const sources: HTMLCanvasElement[] = [];
beforeEach(t => {
  sceneProps = null;
  warehouseProps = null;
  warehousePreparations = 0;
  warmWarehouseAssets = true;
  imageFailure = false;
  imageSources.length = 0;
  sounds.length = 0;
  sources.length = 0;
  environment.setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  Object.defineProperty(window, 'WebGLRenderingContext', { configurable: true, value: function () {} });
  const originalImage = globalThis.Image;
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: function () {
    const image = document.createElement('img');
    Object.defineProperties(image, {
      naturalWidth: { value: 640 }, naturalHeight: { value: 480 }, complete: { value: false },
      src: { set: value => {
        if (value) {
          imageSources.push(value);
          queueMicrotask(() => image.dispatchEvent(new window.Event(imageFailure ? 'error' : 'load')));
        }
      } },
    });
    image.decode = async () => {};
    return image;
  } });
  t.after(() => Object.defineProperty(globalThis, 'Image', { configurable: true, value: originalImage }));
  t.mock.method(environment.dom.window.HTMLCanvasElement.prototype, 'getContext', (function (this: HTMLCanvasElement) {
    const canvas = this;
    return { drawImage(source: CanvasImageSource) {
      if (source instanceof HTMLImageElement) sources.push(canvas);
      else if (source instanceof environment.dom.window.HTMLCanvasElement && (!source.width || !source.height)) {
        throw new DOMException('The source canvas has no pixels.', 'InvalidStateError');
      }
    } };
  }) as never);
  t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'play', async () => {});
  t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'pause', () => {});
});
afterEach(() => cleanup());
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, bridge); environment.dom.window.close(); });

const hash = `0x${'ab'.repeat(32)}`;
function item(tokenId: string, kind: EthereumInventoryItem['kind']): EthereumInventoryItem {
  return { id: `eip155:11155111:0x${'33'.repeat(20)}:${tokenId}`, tokenId, name: `${kind} ${tokenId}`, kind,
    owner: `0x${'11'.repeat(20)}`, chainId: 11155111, contractAddress: `0x${'33'.repeat(20)}`,
    displayId: Number(tokenId), image: `https://wip.lil.org/reveal-test/${tokenId}.webp` };
}
function harness(kind: 'crate' | 'warehouse', initialResults = true, onUnpack?: () => Promise<string | null>) {
  let presentation!: ReturnType<typeof useEthereumInventoryPresentation>;
  let sends = 0;
  const results = Array.from({ length: kind === 'warehouse' ? 11 : 20 }, (_, index) =>
    item(String((kind === 'warehouse' ? 111112 : 1) + index), kind === 'warehouse' ? 'crate' : 'artwork'));
  const options = { scope: 'crate-overlay-test', onUnpack: async () => { sends++; return onUnpack ? onUnpack() : hash; }, unpackErrors: {} };
  function Harness({ suspended = false, revealed = initialResults }: { suspended?: boolean; revealed?: boolean }) {
    presentation = useEthereumInventoryPresentation({ ...options, suspended, unpackResults: revealed ? { [hash]: results } : {} });
    return createElement('main', null, createElement('p', null, 'Inventory remains'),
      createElement(EthereumInventoryOverlays, { presentation, suspended }));
  }
  const view = render(createElement(Harness));
  const source = item(kind === 'warehouse' ? '116667' : '111112', kind);
  return { ...view, results, source, get presentation() { return presentation; }, get sends() { return sends; },
    get scene() { return kind === 'warehouse' ? warehouseProps : sceneProps; },
    suspend(value: boolean) { view.rerender(createElement(Harness, { suspended: value })); },
    reveal() { view.rerender(createElement(Harness, { revealed: true })); } };
}
async function opening(kind: 'crate' | 'warehouse' = 'crate') {
  const view = harness(kind);
  await act(async () => { view.presentation.openUnpack([view.source]); });
  const button = view.getByRole('button', { name: `Reveal ${view.source.name}` });
  for (let hit = 0; hit < 3; hit++) fireEvent.click(button);
  await waitFor(() => assert.equal(view.scene?.opening, true));
  assert.equal(sources.length, kind === 'warehouse' ? 1 : 20);
  assert.ok(sources.every(canvas => canvas.width > 0 && canvas.height > 0));
  return view;
}

for (const kind of ['crate', 'warehouse'] as const) test(`${kind} context loss during closing cannot mount previews from released source canvases`, async () => {
  const view = await opening(kind);
  act(() => view.scene!.onComplete());
  assert.equal(view.presentation.overlay?.resultsVisible, true);
  const dialog = view.getByRole('dialog');
  act(() => view.presentation.close());
  assert.equal(view.presentation.overlay?.closing, true);
  assert.ok(sources.every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.doesNotThrow(() => act(() => view.scene!.onError(new Error('WebGL context lost'))));
  assert.ok(dialog.isConnected);
  assert.equal(dialog.querySelector('.crate-reveal__results'), null);
  await waitFor(() => assert.equal(view.presentation.overlay, null));
  assert.equal(dialog.isConnected, false);
  assert.ok(view.getByText('Inventory remains'));
});

for (const kind of ['crate', 'warehouse'] as const) for (const suspended of [false, true]) test(`${kind} context loss ${suspended ? 'while suspended' : 'while active'} preserves the prepared-preview fallback`, async () => {
  const view = await opening(kind);
  const dialog = view.getByRole('dialog');
  if (suspended) view.suspend(true);
  act(() => view.scene!.onError(new Error('WebGL context lost')));
  assert.ok(dialog.classList.contains('crate-reveal--fallback'));
  assert.deepEqual(Array.from(dialog.querySelectorAll('[data-reveal-item]'), element => element.getAttribute('data-reveal-item')), view.results.map(item => item.id));
  assert.ok(sources.every(canvas => canvas.width > 0 && canvas.height > 0));
  assert.equal(view.presentation.overlay?.resultsVisible, false);
  if (suspended) view.suspend(false);
  await waitFor(() => assert.equal(view.presentation.overlay?.resultsVisible, true));
  assert.equal(view.sends, 1);
  assert.equal(view.getByRole('status').textContent, kind === 'warehouse' ? '11 crates revealed' : '20 artworks revealed');
});

test('rapid warehouse hits queue three impacts, wait for confirmed crates, and play ice sounds at impact', async () => {
  const view = harness('warehouse', false);
  await act(async () => { view.presentation.openUnpack([view.source]); });
  const button = view.getByRole('button', { name: `Reveal ${view.source.name}` });
  act(() => { for (let hit = 0; hit < 20; hit++) fireEvent.click(button); });
  await waitFor(() => assert.equal(warehouseProps?.hits.length, 3));
  assert.deepEqual(warehouseProps!.hits.map(hit => hit.id), [1, 2, 3]);
  assert.equal(warehouseProps!.opening, false);
  assert.equal(view.presentation.overlay?.resultsVisible, false);
  assert.deepEqual(sounds, []);
  act(() => { warehouseProps!.onImpact(false); warehouseProps!.onImpact(false); });
  assert.deepEqual(sounds, ['ice-hit', 'ice-hit']);
  view.reveal();
  await waitFor(() => assert.equal(warehouseProps!.opening, true));
  assert.equal(sources.length, 1);
  assert.equal(new Set(warehouseProps!.assets!.items.map(item => item.image)).size, 1);
  act(() => { warehouseProps!.onImpact(true); warehouseProps!.onComplete(); });
  assert.deepEqual(sounds, ['ice-hit', 'ice-hit', 'ice-critical']);
  assert.equal(view.presentation.overlay?.resultsVisible, true);
  assert.equal(view.sends, 1);
});

test('a warehouse without WebGL reveals all confirmed crate identities without waiting notes', async () => {
  Object.defineProperty(window, 'WebGLRenderingContext', { configurable: true, value: undefined });
  const view = harness('warehouse', false);
  await act(async () => { view.presentation.openUnpack([view.source]); });
  const button = view.getByRole('button', { name: `Reveal ${view.source.name}` });
  act(() => { for (let hit = 0; hit < 3; hit++) fireEvent.click(button); });
  const dialog = view.getByRole('dialog');
  assert.equal(view.getByRole('status').textContent, '');
  assert.equal(dialog.querySelectorAll('[data-reveal-item]').length, 0);
  assert.deepEqual(sounds, ['ice-hit', 'ice-hit']);
  view.reveal();
  await waitFor(() => assert.equal(view.presentation.overlay?.resultsVisible, true));
  assert.equal(sources.length, 1);
  assert.deepEqual(Array.from(dialog.querySelectorAll('[data-reveal-item]'), element => element.getAttribute('data-reveal-item')), view.results.map(item => item.id));
  assert.equal(view.getByRole('status').textContent, '11 crates revealed');
  assert.deepEqual(sounds, ['ice-hit', 'ice-hit', 'ice-critical']);
  assert.equal(view.sends, 1);
});

test('rejected warehouse submission resets queued hits before a fresh attempt', async () => {
  const first = Promise.withResolvers<string | null>();
  let attempts = 0;
  const view = harness('warehouse', false, () => ++attempts === 1 ? first.promise : Promise.resolve(hash));
  act(() => { view.presentation.openUnpack([view.source]); });
  const button = view.getByRole('button', { name: `Reveal ${view.source.name}` });
  act(() => { for (let hit = 0; hit < 3; hit++) fireEvent.click(button); });
  await waitFor(() => assert.equal(warehouseProps?.hits.length, 3));
  await act(async () => first.resolve(null));
  assert.equal(view.presentation.overlay?.attempted, false);
  assert.deepEqual(warehouseProps!.hits, []);
  act(() => { fireEvent.click(button); });
  await waitFor(() => assert.equal(view.presentation.overlay?.transactionHash, hash));
  assert.deepEqual(warehouseProps!.hits.map(hit => hit.id), [1]);
  assert.equal(view.sends, 2);
});

test('rejected crate submission keeps retry hit IDs fresh for the retained scene', async () => {
  const first = Promise.withResolvers<string | null>();
  let attempts = 0;
  const view = harness('crate', false, () => ++attempts === 1 ? first.promise : Promise.resolve(hash));
  act(() => { view.presentation.openUnpack([view.source]); });
  const button = view.getByRole('button', { name: `Reveal ${view.source.name}` });
  fireEvent.click(button);
  await waitFor(() => assert.equal(sceneProps?.hit?.id, 1));
  const scene = document.querySelector('[data-crate-scene]');
  assert.ok(scene);
  await act(async () => first.resolve(null));
  assert.equal(view.presentation.overlay?.attempted, false);
  assert.equal(sceneProps!.hit, null);
  fireEvent.click(button);
  await waitFor(() => assert.equal(view.presentation.overlay?.transactionHash, hash));
  assert.equal(document.querySelector('[data-crate-scene]'), scene);
  assert.equal(sceneProps!.hit?.id, 2);
  assert.equal(sceneProps!.opening, false);
  assert.equal(view.sends, 2);
});

test('warehouse image and GPU preparation precede confirmation without fabricating results', async () => {
  const view = harness('warehouse', false);
  await act(async () => { view.presentation.openUnpack([view.source]); });
  await waitFor(() => assert.ok(warehouseProps?.crateImage));
  const image = warehouseProps!.crateImage;
  assert.equal(warehousePreparations, 1);
  assert.deepEqual(imageSources, ['/111k/crate-reference.webp']);
  assert.equal(warehouseProps!.assets, null);
  assert.deepEqual(view.presentation.overlay?.results, []);
  const button = view.getByRole('button', { name: `Reveal ${view.source.name}` });
  for (let hit = 0; hit < 3; hit++) fireEvent.click(button);
  assert.equal(view.getByRole('status').textContent, '');
  view.reveal();
  await waitFor(() => assert.equal(warehouseProps!.opening, true));
  assert.equal(warehouseProps!.crateImage, image);
  assert.equal(warehousePreparations, 1);
  assert.equal(imageSources.length, 1);
  assert.deepEqual(warehouseProps!.assets!.items.map(item => item.id), view.results.map(item => item.id));
  assert.equal(new Set(warehouseProps!.assets!.items.map(item => item.image)).size, 1);
  assert.equal(view.sends, 1);
});

test('confirmed warehouse waits for GPU preparation without a note before critical destruction', async () => {
  warmWarehouseAssets = false;
  const view = harness('warehouse');
  await act(async () => { view.presentation.openUnpack([view.source]); });
  await waitFor(() => assert.ok(warehouseProps?.assets));
  const button = view.getByRole('button', { name: `Reveal ${view.source.name}` });
  for (let hit = 0; hit < 3; hit++) fireEvent.click(button);
  assert.equal(view.getByRole('status').textContent, '');
  assert.equal(warehouseProps!.opening, false);
  act(() => warehouseProps!.onAssetsReady());
  await waitFor(() => assert.equal(warehouseProps!.opening, true));
  assert.equal(view.getByRole('status').textContent, '');
  assert.equal(view.sends, 1);
});

test('warehouse image retry reuses confirmed results without resubmitting', async () => {
  imageFailure = true;
  const view = harness('warehouse');
  await act(async () => { view.presentation.openUnpack([view.source]); });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Retry loading' })));
  const button = view.getByRole('button', { name: `Reveal ${view.source.name}` });
  for (let hit = 0; hit < 3; hit++) fireEvent.click(button);
  assert.equal(warehouseProps!.opening, false);
  imageFailure = false;
  fireEvent.click(view.getByRole('button', { name: 'Retry loading' }));
  await waitFor(() => assert.equal(warehouseProps!.opening, true));
  assert.deepEqual(imageSources, ['/111k/crate-reference.webp', '/111k/crate-reference.webp']);
  assert.equal(view.sends, 1);
  assert.equal(sources.length, 1);
});
