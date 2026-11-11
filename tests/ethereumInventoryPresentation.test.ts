import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement } from 'react';
import type { EthereumInventoryItem } from '../shared/ethereum/protocol.ts';
import { ethereumRevealTiles } from '../src/ethereum/revealLayout.ts';
import { REVEAL_OUTSIDE_TAP_DISMISS_LOCK_MS } from '../src/shop/reveal/sounds.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

let environment = setupFrontendDom();
const { act, cleanup, fireEvent, render, renderHook, waitFor } = await import('@testing-library/react');
const { useEthereumInventoryPresentation } = await import('../src/ethereum/useEthereumInventoryPresentation.ts');
const { EthereumInventoryOverlays } = await import('../src/ethereum/EthereumInventoryOverlays.tsx');
const { MediaViewerOverlay } = await import('../src/shop/reveal/MediaViewerOverlay.tsx');
const { EthereumArtworkMedia } = await import('../src/ethereum/EthereumArtworkMedia.tsx');
environment.dom.window.close();

beforeEach(context => {
  const t = context as TestContext;
  environment = setupFrontendDom();
  t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'play', async () => {});
  t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'pause', () => {});
});
afterEach(() => { cleanup(); environment.dom.window.close(); });

const hash = `0x${'ab'.repeat(32)}`;
const otherHash = `0x${'cd'.repeat(32)}`;
const scope = '11155111:contract:owner';
function item(id = '111112', kind: EthereumInventoryItem['kind'] = 'crate'): EthereumInventoryItem {
  return { id: `eip155:11155111:0x${'33'.repeat(20)}:${id}`, tokenId: id, name: `${kind} ${id}`, kind,
    owner: `0x${'11'.repeat(20)}`, chainId: 11155111, contractAddress: `0x${'33'.repeat(20)}`,
    displayId: Number(id), image: `https://wip.lil.org/reveal-test/${id}.webp`, aspectRatio: { width: 2, height: 3 } };
}
type Options = Parameters<typeof useEthereumInventoryPresentation>[0];
function options(overrides: Partial<Options> = {}): Options {
  return { scope, onUnpack: async () => hash, unpackResults: {}, unpackErrors: {}, ...overrides };
}

function previewImages(t: TestContext, options: { decode?: (src: string) => Promise<void>; fail?: () => boolean } = {}) {
  const loaded: string[] = [];
  const released: string[] = [];
  const previewSources: HTMLCanvasElement[] = [];
  const originalImage = globalThis.Image;
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: function () {
    const image = document.createElement('img');
    let source = '';
    Object.defineProperties(image, {
      naturalWidth: { value: 640 }, naturalHeight: { value: 480 }, complete: { value: false },
      src: { get: () => source, set: value => {
        if (value) {
          loaded.push(value);
          queueMicrotask(() => image.dispatchEvent(new window.Event(options.fail?.() ? 'error' : 'load')));
        } else if (source) released.push(source);
        source = value;
      } },
    });
    image.decode = () => options.decode?.(source) ?? Promise.resolve();
    return image;
  } });
  t.after(() => Object.defineProperty(globalThis, 'Image', { configurable: true, value: originalImage }));
  t.mock.method(environment.dom.window.HTMLCanvasElement.prototype, 'getContext', (() => ({ drawImage(source: CanvasImageSource) {
    if (source instanceof environment.dom.window.HTMLCanvasElement) previewSources.push(source);
  } })) as never);
  return { loaded, released, previewSources };
}

function presentationView(initial: Options) {
  let presentation!: ReturnType<typeof useEthereumInventoryPresentation>;
  function Harness(props: Options) {
    presentation = useEthereumInventoryPresentation(props);
    return createElement(EthereumInventoryOverlays, { presentation, suspended: props.suspended });
  }
  const view = render(createElement(Harness, initial));
  return { ...view, get presentation() { return presentation; }, rerenderOptions(next: Options) {
    view.rerender(createElement(Harness, next));
  } };
}

function outsideGesture(dialog: HTMLElement, input: 'mouse' | 'touch') {
  const backdrop = dialog.querySelector('.reveal-overlay__backdrop')!;
  if (input === 'touch') {
    fireEvent.touchStart(backdrop);
    fireEvent.touchEnd(backdrop);
  }
  fireEvent.click(backdrop);
}

for (const count of [1, 11, 20, 31, 111, 311]) {
  for (const [width, height] of [[320, 568], [844, 390], [1440, 900]]) {
    test(`${count} revealed items fit ${width}×${height} without scrolling or overlap`, () => {
      const viewport = { left: 5, top: 7, width, height };
      const tiles = ethereumRevealTiles(count, viewport);
      assert.equal(tiles.length, count);
      for (let index = 0; index < tiles.length; index++) {
        const tile = tiles[index];
        assert.ok(tile.width > 0 && tile.height > 0);
        assert.ok(tile.left >= viewport.left && tile.top >= viewport.top);
        assert.ok(tile.left + tile.width <= viewport.left + width);
        assert.ok(tile.top + tile.height <= viewport.top + height);
        for (const other of tiles.slice(index + 1)) {
          assert.ok(tile.left + tile.width <= other.left || other.left + other.width <= tile.left ||
            tile.top + tile.height <= other.top || other.top + other.height <= tile.top);
        }
      }
    });
  }
}

test('recovered results never open an overlay on mount or after reload', () => {
  const initial = options({ unpackResults: { [hash]: [item('1', 'artwork')] } });
  const first = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  assert.equal(first.result.current.open, false);
  first.unmount();
  const second = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  assert.equal(second.result.current.open, false);
});

for (const kind of ['crate', 'warehouse'] as const) test(`${kind} framing leaves room for opening in portrait, landscape and desktop viewports`, () => {
  for (const [width, height] of [[320, 568], [844, 390], [1440, 900]]) {
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: {
      width, height, offsetLeft: 5, offsetTop: 7, addEventListener() {}, removeEventListener() {},
    } });
    const hook = renderHook(useEthereumInventoryPresentation, { initialProps: options() });
    act(() => { hook.result.current.openUnpack([item(kind === 'warehouse' ? '116667' : '111112', kind)]); });
    const rect = hook.result.current.overlay!.targetRect;
    assert.ok(rect.width <= Math.min(width * (kind === 'warehouse' ? 0.82 : 0.76), kind === 'warehouse' ? 640 : 700));
    assert.ok(rect.top >= 7 + height * (kind === 'warehouse' ? 0.32 : 0.35) - 0.001);
    assert.ok(rect.top + rect.height <= 7 + height * (kind === 'warehouse' ? 0.8 : 0.77) + 0.001);
    assert.equal(rect.left + rect.width / 2, 5 + width / 2);
    hook.unmount();
  }
});

for (const [id, width, height] of [[1, 1320, 1858], [18, 1320, 750]]) {
  test(`relic ${id} viewer uses its mid preview and native aspect ratio`, () => {
    const relic = { ...item(String(117171 + id), 'relic'), displayId: id,
      image: `https://cdn.lil.org/nft/111k/relics/${id}.png`, aspectRatio: undefined };
    const view = presentationView(options());
    act(() => { view.presentation.openViewer(relic); });
    const target = view.presentation.overlay!.targetRect;
    assert.ok(Math.abs(target.height - target.width * height / width) < 1);
    const image = view.getByRole('img', { name: relic.name });
    assert.equal(image.getAttribute('src'), `https://cdn.lil.org/nft/111k/relics/mid/${id}.webp`);
    assert.equal(image.getAttribute('width'), String(width));
    assert.equal(image.getAttribute('height'), String(height));
    assert.equal(relic.image, `https://cdn.lil.org/nft/111k/relics/${id}.png`);
  });
}

test('opening unpack submits immediately and only its own results are presented', async () => {
  const submitted = Promise.withResolvers<string | null>();
  let sends = 0;
  const initial = options({ onUnpack: () => { sends++; return submitted.promise; } });
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  act(() => { assert.equal(view.result.current.openUnpack([item()]), true); });
  assert.equal(sends, 1);
  assert.equal(view.result.current.overlay?.attempted, true);
  await act(async () => {
    assert.equal(view.result.current.openUnpack([item()]), false);
    await view.result.current.requestUnpack();
    await view.result.current.requestUnpack();
  });
  assert.equal(sends, 1);
  view.rerender({ ...initial, unpackResults: { [otherHash]: [item('2', 'artwork')] } });
  assert.equal(view.result.current.overlay?.results.length, 0);
  await act(async () => { submitted.resolve(hash); });
  const artworks = [item('1', 'artwork')];
  view.rerender({ ...initial, unpackResults: { [hash]: artworks, [otherHash]: [item('2', 'artwork')] } });
  assert.deepEqual(view.result.current.overlay?.results, artworks);
});

for (const kind of ['crate', 'warehouse'] as const) test(`${kind} results wait for scene completion and ignore stale or suspended completion callbacks`, async () => {
  const initial = options();
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  await act(async () => { view.result.current.openUnpack([item(kind === 'warehouse' ? '116667' : '111112', kind)]); });
  const session = view.result.current.overlay!.session;
  const revealed = { ...initial, unpackResults: { [hash]: [item('1', kind === 'warehouse' ? 'crate' : 'artwork')] } };
  view.rerender(revealed);
  await act(async () => { await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))); });
  assert.equal(view.result.current.overlay?.resultsVisible, false);
  act(() => view.result.current.completeContainerReveal(session + 1));
  assert.equal(view.result.current.overlay?.resultsVisible, false);
  view.rerender({ ...revealed, suspended: true });
  act(() => view.result.current.completeContainerReveal(session));
  assert.equal(view.result.current.overlay?.resultsVisible, false);
  view.rerender(revealed);
  act(() => view.result.current.completeContainerReveal(session));
  assert.equal(view.result.current.overlay?.resultsVisible, true);
});

for (const count of [20, 31]) test(`the fallback crate requires three hits and all ${count} decoded previews before opening`, async t => {
  environment.setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  const lastImage = Promise.withResolvers<void>();
  const { loaded, released } = previewImages(t, { decode: src => src.endsWith(`/${count}.webp`) ? lastImage.promise : Promise.resolve() });
  let sends = 0;
  const initial = options({ onUnpack: async () => { sends++; return hash; } });
  const view = presentationView(initial);
  await act(async () => { view.presentation.openUnpack([item()]); });
  const button = view.getByRole('button', { name: `Reveal ${item().name}` });
  const results = Array.from({ length: count }, (_, index) => ({ ...item(String(index + 1), 'artwork'),
    category: index % 2 ? 'video' as const : '3d' as const, animation_url: `https://example.com/${index}.glb` }));
  view.rerenderOptions({ ...initial, unpackResults: { [hash]: results } });
  fireEvent.click(button);
  fireEvent.click(button);
  if (count === 31) fireEvent.click(button);
  await waitFor(() => assert.equal(loaded.length, count));
  assert.equal(view.getByRole('dialog').classList.contains('crate-reveal--opening'), false);
  assert.equal(view.presentation.overlay?.resultsVisible, false);
  await act(async () => lastImage.resolve());
  await waitFor(() => assert.equal(released.length, count));
  if (count === 20) {
    assert.equal(view.getByRole('dialog').classList.contains('crate-reveal--opening'), false);
    fireEvent.click(button);
  }
  await waitFor(() => assert.equal(view.getByRole('dialog').classList.contains('crate-reveal--opening'), true));
  assert.equal(view.getByRole('dialog').querySelectorAll('[data-reveal-item]').length, count);
  assert.equal(view.getByRole('dialog').querySelectorAll('video').length, 0);
  assert.equal(loaded.some(source => source.endsWith('.glb')), false);
  await waitFor(() => assert.equal(view.presentation.overlay?.resultsVisible, true));
  assert.equal(sends, 1);
});

test('fallback previews retain their bitmaps through closing after source buffers are released', async t => {
  environment.setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  const { previewSources } = previewImages(t);
  const results = Array.from({ length: 20 }, (_, index) => item(String(index + 1), 'artwork'));
  const view = presentationView(options({ unpackResults: { [hash]: results } }));
  await act(async () => { view.presentation.openUnpack([item()]); });
  const button = view.getByRole('button', { name: `Reveal ${item().name}` });
  for (let hit = 0; hit < 3; hit++) fireEvent.click(button);
  await waitFor(() => assert.equal(view.presentation.overlay?.resultsVisible, true));
  const dialog = view.getByRole('dialog');
  const canvases = Array.from(dialog.querySelectorAll<HTMLCanvasElement>('canvas'));
  assert.equal(canvases.length, 20);
  assert.equal(previewSources.length, 20);
  assert.ok(canvases.every(canvas => canvas.width === 512 && canvas.height === 384));
  assert.ok(previewSources.every(canvas => canvas.width === 512 && canvas.height === 384));
  act(() => view.presentation.close());
  assert.equal(view.presentation.overlay?.closing, true);
  assert.ok(dialog.isConnected && dialog.classList.contains('reveal-overlay--closing'));
  assert.deepEqual(Array.from(dialog.querySelectorAll('canvas')), canvases);
  assert.ok(previewSources.every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.ok(canvases.every(canvas => canvas.width === 512 && canvas.height === 384));
  await waitFor(() => assert.equal(view.presentation.overlay, null));
  assert.ok(canvases.every(canvas => !canvas.isConnected));
});

for (const kind of ['crate', 'warehouse'] as const) test(`retrying ${kind} previews keeps its transaction and suspension preserves the same presentation`, async t => {
  environment.setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  let fail = true;
  previewImages(t, { fail: () => fail });
  let sends = 0;
  const initial = options({ onUnpack: async () => { sends++; return hash; } });
  const view = presentationView(initial);
  const source = item(kind === 'warehouse' ? '116667' : '111112', kind);
  await act(async () => { view.presentation.openUnpack([source]); });
  const button = view.getByRole('button', { name: `Reveal ${source.name}` });
  fireEvent.click(button);
  fireEvent.click(button);
  fireEvent.click(button);
  const revealed = { ...initial, unpackResults: { [hash]: [item('1', kind === 'warehouse' ? 'crate' : 'artwork')] } };
  view.rerenderOptions(revealed);
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Retry loading' })));
  assert.equal(view.presentation.overlay?.resultsVisible, false);
  const session = view.presentation.overlay!.session;
  fail = false;
  fireEvent.click(view.getByRole('button', { name: 'Retry loading' }));
  view.rerenderOptions({ ...revealed, suspended: true });
  await waitFor(() => assert.equal(view.queryByRole('button', { name: 'Retry loading' }), null));
  assert.equal(view.presentation.overlay?.resultsVisible, false);
  assert.equal(view.presentation.overlay?.session, session);
  view.rerenderOptions(revealed);
  await waitFor(() => assert.equal(view.presentation.overlay?.resultsVisible, true));
  assert.equal(view.presentation.overlay?.transactionHash, hash);
  assert.equal(sends, 1);
});

test('a fallback whose flow clock already finished still unlocks dismissal after its gallery paints', async t => {
  environment.setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  previewImages(t);
  let now = performance.now();
  t.mock.method(performance, 'now', () => now);
  const initial = options();
  const view = presentationView(initial);
  await act(async () => { view.presentation.openUnpack([item()]); });
  const button = view.getByRole('button', { name: `Reveal ${item().name}` });
  fireEvent.click(button);
  fireEvent.click(button);
  fireEvent.click(button);
  const revealed = { ...initial, unpackResults: { [hash]: [item('1', 'artwork')] } };
  view.rerenderOptions(revealed);
  await waitFor(() => assert.equal(view.getByRole('dialog').classList.contains('crate-reveal--opening'), true));
  now += 5_000;
  view.rerenderOptions({ ...revealed, suspended: true });
  assert.equal(view.presentation.overlay?.resultsVisible, false);
  view.rerenderOptions(revealed);
  assert.equal(view.presentation.overlay?.resultsVisible, false);
  await waitFor(() => assert.equal(view.presentation.overlay?.resultsVisible, true));
  assert.equal(view.getByRole('status').textContent, '1 artworks revealed');
  t.mock.method(Date, 'now', () => 1e15);
  outsideGesture(view.getByRole('dialog'), 'mouse');
  assert.equal(view.presentation.overlay?.closing, true);
});

test('empty, suspended, and viewer presentations never submit an unpack', () => {
  let sends = 0;
  const initial = options({ onUnpack: async () => { sends++; return hash; } });
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  act(() => { assert.equal(view.result.current.openUnpack([]), false); });
  act(() => { assert.equal(view.result.current.openUnpack([item(), item('111113')]), false); });
  assert.equal(view.result.current.open, false);
  view.rerender({ ...initial, suspended: true });
  act(() => { assert.equal(view.result.current.openUnpack([item()]), false); });
  view.rerender(initial);
  act(() => { assert.equal(view.result.current.openViewer(item('1', 'artwork')), true); });
  act(() => { assert.equal(view.result.current.openUnpack([item()]), false); });
  assert.equal(sends, 0);
});

test('Escape during wallet approval retains the Solana keyboard escape and ignores late results', async () => {
  const submitted = Promise.withResolvers<string | null>();
  let sends = 0;
  const initial = options({ onUnpack: () => ++sends === 1 ? submitted.promise : Promise.resolve(otherHash) });
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  act(() => { view.result.current.openUnpack([item()]); });
  fireEvent.keyDown(document, { key: 'Escape' });
  await act(async () => { submitted.resolve(hash); });
  view.rerender({ ...initial, unpackResults: { [hash]: [item('1', 'artwork')] } });
  assert.equal(view.result.current.overlay?.transactionHash, undefined);
  assert.equal(view.result.current.overlay?.results.length, 0);
  await waitFor(() => assert.equal(view.result.current.open, false));
  await act(async () => { view.result.current.openUnpack([item('111113')]); });
  assert.equal(sends, 2);
  assert.equal(view.result.current.overlay?.transactionHash, otherHash);
  assert.equal(view.result.current.overlay?.results.length, 0);
});

for (const input of ['mouse', 'touch'] as const) test(`${input} outside dismissal waits for submission and visible results to finish`, async t => {
  environment.setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  previewImages(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const submitted = Promise.withResolvers<string | null>();
  const initial = options({ onUnpack: () => submitted.promise });
  const view = presentationView(initial);
  act(() => { view.presentation.openUnpack([item('116667', 'warehouse')]); });
  assert.equal(view.presentation.overlay?.attempted, true);
  const button = view.getByRole('button', { name: 'Reveal warehouse 116667' });
  for (let hit = 0; hit < 3; hit++) fireEvent.click(button);
  outsideGesture(view.getByRole('dialog'), input);
  assert.equal(view.presentation.overlay?.closing, false);
  await act(async () => { submitted.resolve(hash); });
  outsideGesture(view.getByRole('dialog'), input);
  assert.equal(view.presentation.overlay?.closing, false);

  view.rerenderOptions({ ...initial, unpackResults: { [hash]: [item('111112', 'crate')] } });
  assert.equal(view.presentation.overlay?.resultsVisible, false);
  outsideGesture(view.getByRole('dialog'), input);
  assert.equal(view.presentation.overlay?.closing, false);
  await waitFor(() => assert.equal(view.presentation.overlay?.resultsVisible, true));
  outsideGesture(view.getByRole('dialog'), input);
  assert.equal(view.presentation.overlay?.closing, false);
  now += REVEAL_OUTSIDE_TAP_DISMISS_LOCK_MS;
  outsideGesture(view.getByRole('dialog'), input);
  assert.equal(view.presentation.overlay?.closing, true);
});

for (const suspended of [false, true]) test(`an empty successful unpack closes silently${suspended ? ' while suspended' : ''}`, async () => {
  const errors: string[] = [];
  const initial = options({ onError: message => errors.push(message) });
  const view = presentationView(initial);
  act(() => { view.presentation.openUnpack([item()]); });
  await waitFor(() => assert.equal(view.presentation.overlay?.transactionHash, hash));
  view.rerenderOptions({ ...initial, suspended, unpackResults: { [otherHash]: [] } });
  assert.equal(view.presentation.overlay?.attempted, true);
  assert.equal(view.presentation.overlay?.closing, false);
  view.rerenderOptions({ ...initial, suspended, unpackResults: { [hash]: [] } });
  assert.equal(view.presentation.overlay?.attempted, false);
  assert.equal(view.presentation.overlay?.closing, true);
  assert.equal(view.presentation.overlay?.transactionHash, undefined);
  await waitFor(() => assert.equal(view.presentation.open, false));
  view.rerenderOptions({ ...initial, unpackResults: { [hash]: [] } });
  assert.equal(view.queryByRole('dialog'), null);
  assert.deepEqual(errors, []);
});

for (const failure of ['wallet rejection', 'confirmed failure'] as const) test(`${failure} releases outside dismissal and supports a fresh gesture retry`, async () => {
  let calls = 0;
  const initial = options({ onUnpack: async () => {
    calls++;
    return failure === 'wallet rejection' && calls === 1 ? null : calls === 1 ? hash : otherHash;
  } });
  const view = presentationView(initial);
  act(() => { view.presentation.openUnpack([item()]); });
  if (failure === 'confirmed failure') {
    await waitFor(() => assert.equal(view.presentation.overlay?.transactionHash, hash));
    view.rerenderOptions({ ...initial, unpackErrors: { [hash]: 'Reverted' } });
  }
  await waitFor(() => assert.equal(view.presentation.overlay?.attempted, false));
  assert.equal(calls, 1);
  outsideGesture(view.getByRole('dialog'), 'touch');
  assert.equal(view.presentation.overlay?.closing, true);
  await waitFor(() => assert.equal(view.presentation.open, false));
  act(() => { view.presentation.openUnpack([item()]); });
  await waitFor(() => assert.equal(view.presentation.overlay?.transactionHash, otherHash));
  assert.equal(calls, 2);
  outsideGesture(view.getByRole('dialog'), 'touch');
  assert.equal(view.presentation.overlay?.closing, false);
});

test('changing account invalidates pending presentation immediately', async () => {
  const submitted = Promise.withResolvers<string | null>();
  const initial = options({ onUnpack: () => submitted.promise });
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  act(() => { view.result.current.openUnpack([item()]); });
  view.rerender({ ...initial, scope: 'other-account' });
  assert.equal(view.result.current.open, false);
  await act(async () => { submitted.resolve(hash); });
  assert.equal(view.result.current.open, false);
});

test('wallet rejection and confirmed failures allow a one-tap retry', async () => {
  let calls = 0;
  const initial = options({ onUnpack: async () => ++calls === 1 ? null : calls === 2 ? hash : otherHash });
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  await act(async () => { view.result.current.openUnpack([item()]); });
  assert.equal(calls, 1);
  assert.equal(view.result.current.overlay?.attempted, false);
  await act(async () => { await view.result.current.requestUnpack(); });
  assert.equal(view.result.current.overlay?.transactionHash, hash);
  view.rerender({ ...initial, unpackErrors: { [hash]: 'Reverted' } });
  assert.equal(view.result.current.overlay?.attempted, false);
  assert.equal(calls, 2);
  await act(async () => { await view.result.current.requestUnpack(); });
  assert.equal(view.result.current.overlay?.transactionHash, otherHash);
  assert.equal(calls, 3);
});

test('terminal errors wait for an active suspended session to resume and announce only once', async () => {
  const messages: string[] = [];
  const initial = options({ onError: message => messages.push(message) });
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  await act(async () => { view.result.current.openUnpack([item()]); });
  const failed = { ...initial, unpackErrors: { [hash]: 'Opening failed' } };
  view.rerender({ ...failed, suspended: true });
  assert.deepEqual(messages, []);
  assert.equal(view.result.current.overlay?.transactionHash, hash);
  view.rerender(failed);
  assert.deepEqual(messages, ['Opening failed']);
  assert.equal(view.result.current.overlay?.attempted, false);
  view.rerender({ ...failed, unpackErrors: { ...failed.unpackErrors } });
  assert.deepEqual(messages, ['Opening failed']);
});

for (const change of ['close', 'scope'] as const) test(`${change} while suspended discards its deferred unpack error`, async () => {
  const messages: string[] = [];
  const initial = options({ onError: message => messages.push(message) });
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  await act(async () => { view.result.current.openUnpack([item()]); });
  const failed = { ...initial, unpackErrors: { [hash]: 'Opening failed' }, suspended: true };
  view.rerender(failed);
  if (change === 'close') act(() => { view.result.current.close(); });
  else view.rerender({ ...failed, scope: 'another-owner' });
  view.rerender({ ...failed, scope: change === 'scope' ? 'another-owner' : scope, suspended: false });
  assert.deepEqual(messages, []);
});

test('viewer hydration retains the session and source snapshot while updating its media and target ratio', () => {
  const original = item('1', 'artwork');
  const initial = options({ applyArtwork: value => value });
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  act(() => { view.result.current.openViewer(original); });
  const before = view.result.current.overlay!;
  const updated = { ...original, category: '3d' as const, animation_url: 'https://cdn.lil.org/nft/111k/3d/1.glb',
    image: 'https://cdn.lil.org/nft/111k/3d/1.png', aspectRatio: { width: 1, height: 1 } };
  view.rerender({ ...initial, applyArtwork: () => updated });
  assert.equal(view.result.current.overlay?.session, before.session);
  assert.equal(view.result.current.overlay?.items[0], original);
  assert.deepEqual(view.result.current.overlay?.originRect, before.originRect);
  assert.equal(view.result.current.viewerItem, updated);
  assert.equal(view.result.current.overlay!.targetRect.width, view.result.current.overlay!.targetRect.height);
});

test('dense reveal renders every result through the shared reveal shell without a gallery or media players', async () => {
  const initial = options();
  const hook = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  await act(async () => { hook.result.current.openUnpack([item('117172', 'relic')]); });
  const view = render(createElement(EthereumInventoryOverlays, { presentation: hook.result.current }));
  hook.rerender({ ...initial, unpackResults: { [hash]: Array.from({ length: 311 }, (_, index) => item(String(index + 1), 'artwork')) } });
  view.rerender(createElement(EthereumInventoryOverlays, { presentation: hook.result.current }));
  const dialog = view.getByRole('dialog');
  assert.equal(dialog.querySelectorAll('[data-reveal-item]').length, 311);
  assert.equal(dialog.querySelectorAll('video, canvas, .ethereum111k__reveal-grid').length, 0);
  assert.ok(dialog.classList.contains('reveal-overlay'));
});

test('the fullscreen viewer retains source geometry and restores its tile after dismissal', async () => {
  const artwork = item('1', 'artwork');
  const source = document.createElement('article');
  source.dataset.inventoryId = artwork.id;
  source.getBoundingClientRect = () => new window.DOMRect(10, 20, 120, 180);
  document.body.append(source);
  const hook = renderHook(useEthereumInventoryPresentation, { initialProps: options() });
  act(() => { hook.result.current.openViewer(artwork); });
  assert.equal(source.style.visibility, 'hidden');
  assert.ok(Math.abs(hook.result.current.overlay!.targetRect.width / hook.result.current.overlay!.targetRect.height - 2 / 3) < 0.01);
  const view = render(createElement(EthereumInventoryOverlays, { presentation: hook.result.current }));
  const dialog = view.getByRole('dialog', { name: `${artwork.name} viewer` });
  assert.ok(dialog.classList.contains('reveal-overlay--viewer'));
  assert.equal(dialog.querySelectorAll('h1, h2, .ethereum111k__model-status').length, 0);
  act(() => { hook.result.current.close(); });
  await waitFor(() => assert.equal(hook.result.current.open, false));
  assert.equal(source.style.visibility, '');
});

test('viewer media interactions do not dismiss while the backdrop does', () => {
  let dismissed = 0;
  const view = render(createElement(MediaViewerOverlay, { name: 'Artwork', active: true, closing: false, suspended: false,
    dismissIgnoreSelector: 'video, canvas', onDismiss: () => { dismissed++; },
    children: createElement('div', null, createElement('video', { 'aria-label': 'Video' }), createElement('canvas')) }));
  fireEvent.click(view.getByLabelText('Video'));
  fireEvent.click(view.container.querySelector('canvas')!);
  assert.equal(dismissed, 0);
  fireEvent.click(view.container.querySelector('.reveal-overlay__backdrop')!);
  assert.equal(dismissed, 1);
});

test('a fullscreen viewer fades in place when its source moves or disappears', () => {
  for (const removed of [false, true]) {
    const artwork = item('1', 'artwork');
    const source = document.createElement('article');
    source.dataset.inventoryId = artwork.id;
    source.getBoundingClientRect = () => new window.DOMRect(10, 20, 120, 180);
    document.body.append(source);
    const hook = renderHook(useEthereumInventoryPresentation, { initialProps: options() });
    act(() => { hook.result.current.openViewer(artwork); });
    if (removed) source.remove();
    else source.getBoundingClientRect = () => new window.DOMRect(10, 240, 120, 180);
    act(() => { hook.result.current.close(); });
    assert.equal(hook.result.current.overlay?.closeMode, 'fade');
    assert.equal(source.style.visibility, '');
    hook.unmount();
    source.remove();
  }
});

test('suspending the viewer restores its source and releases focus until the same session resumes', () => {
  const artwork = item('1', 'artwork');
  const source = document.createElement('article');
  source.dataset.inventoryId = artwork.id;
  source.getBoundingClientRect = () => new window.DOMRect(10, 20, 120, 180);
  document.body.append(source);
  const initial = options();
  const hook = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  act(() => { hook.result.current.openViewer(artwork); });
  const session = hook.result.current.overlay?.session;
  const view = render(createElement(EthereumInventoryOverlays, { presentation: hook.result.current }));
  assert.equal(source.style.visibility, 'hidden');
  assert.ok(view.getByRole('dialog').contains(document.activeElement));
  hook.rerender({ ...initial, suspended: true });
  view.rerender(createElement(EthereumInventoryOverlays, { presentation: hook.result.current, suspended: true }));
  assert.equal(source.style.visibility, '');
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(hook.result.current.open, true);
  const other = document.createElement('button');
  document.body.append(other);
  other.focus();
  assert.equal(document.activeElement, other);
  hook.rerender(initial);
  view.rerender(createElement(EthereumInventoryOverlays, { presentation: hook.result.current }));
  assert.equal(hook.result.current.overlay?.session, session);
  assert.equal(source.style.visibility, 'hidden');
  assert.ok(view.getByRole('dialog').contains(document.activeElement));
  hook.unmount();
  assert.equal(source.style.visibility, '');
  source.remove();
  other.remove();
});

test('fullscreen video keeps its ratio and playback without additional viewer chrome', t => {
  environment.setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  const play = t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'play', async () => {});
  const video = { ...item('1', 'artwork'), category: 'video' as const, animation_url: 'https://wip.lil.org/reveal-test/1.mp4' };
  const view = render(createElement(EthereumArtworkMedia, { item: video, viewer: true, fullscreen: true, chrome: false }));
  const media = view.container.querySelector('video')!;
  assert.equal(media.controls, false);
  assert.equal(media.autoplay, false);
  assert.equal(view.container.querySelector('.ethereum111k__model-status'), null);
  assert.equal(view.container.querySelector<HTMLElement>('.ethereum111k__artwork-media')!.style.width, '');
  fireEvent.keyDown(media, { key: ' ' });
  assert.equal(play.mock.callCount(), 1);
});
