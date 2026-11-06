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

test('a static container gesture submits once and only its own results are presented', async () => {
  const submitted = Promise.withResolvers<string | null>();
  let sends = 0;
  const initial = options({ onUnpack: () => { sends++; return submitted.promise; } });
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  act(() => { assert.equal(view.result.current.openUnpack([item()]), true); });
  assert.equal(sends, 0);
  let first!: Promise<void>;
  await act(async () => {
    first = view.result.current.requestUnpack();
    await view.result.current.requestUnpack();
  });
  assert.equal(sends, 1);
  view.rerender({ ...initial, unpackResults: { [otherHash]: [item('2', 'artwork')] } });
  assert.equal(view.result.current.overlay?.results.length, 0);
  await act(async () => { submitted.resolve(hash); await first; });
  const artworks = [item('1', 'artwork')];
  view.rerender({ ...initial, unpackResults: { [hash]: artworks, [otherHash]: [item('2', 'artwork')] } });
  assert.deepEqual(view.result.current.overlay?.results, artworks);
});

test('Escape during wallet approval retains the Solana keyboard escape and ignores late results', async () => {
  const submitted = Promise.withResolvers<string | null>();
  const initial = options({ onUnpack: () => submitted.promise });
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  act(() => { view.result.current.openUnpack([item()]); });
  let sending!: Promise<void>;
  act(() => { sending = view.result.current.requestUnpack(); });
  fireEvent.keyDown(document, { key: 'Escape' });
  await act(async () => { submitted.resolve(hash); await sending; });
  view.rerender({ ...initial, unpackResults: { [hash]: [item('1', 'artwork')] } });
  assert.equal(view.result.current.overlay?.transactionHash, undefined);
  assert.equal(view.result.current.overlay?.results.length, 0);
  await waitFor(() => assert.equal(view.result.current.open, false));
  act(() => { view.result.current.openUnpack([item('111113')]); });
  assert.equal(view.result.current.overlay?.results.length, 0);
});

for (const input of ['mouse', 'touch'] as const) test(`${input} outside dismissal waits for submission and visible results to finish`, async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const submitted = Promise.withResolvers<string | null>();
  const initial = options({ onUnpack: () => submitted.promise });
  const view = presentationView(initial);
  act(() => { view.presentation.openUnpack([item()]); });
  outsideGesture(view.getByRole('dialog'), input);
  assert.equal(view.presentation.overlay?.closing, true);
  await waitFor(() => assert.equal(view.presentation.open, false));

  act(() => { view.presentation.openUnpack([item()]); });
  fireEvent.click(view.getByRole('button', { name: `Reveal ${item().name}` }));
  assert.equal(view.presentation.overlay?.attempted, true);
  outsideGesture(view.getByRole('dialog'), input);
  assert.equal(view.presentation.overlay?.closing, false);
  await act(async () => { submitted.resolve(hash); });
  outsideGesture(view.getByRole('dialog'), input);
  assert.equal(view.presentation.overlay?.closing, false);

  view.rerenderOptions({ ...initial, unpackResults: { [hash]: [item('1', 'artwork')] } });
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
  fireEvent.click(view.getByRole('button', { name: `Reveal ${item().name}` }));
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
  fireEvent.click(view.getByRole('button', { name: `Reveal ${item().name}` }));
  if (failure === 'confirmed failure') {
    await waitFor(() => assert.equal(view.presentation.overlay?.transactionHash, hash));
    view.rerenderOptions({ ...initial, unpackErrors: { [hash]: 'Reverted' } });
  }
  await waitFor(() => assert.equal(view.presentation.overlay?.attempted, false));
  outsideGesture(view.getByRole('dialog'), 'touch');
  assert.equal(view.presentation.overlay?.closing, true);
  await waitFor(() => assert.equal(view.presentation.open, false));
  act(() => { view.presentation.openUnpack([item()]); });
  fireEvent.click(view.getByRole('button', { name: `Reveal ${item().name}` }));
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
  let sending!: Promise<void>;
  act(() => { sending = view.result.current.requestUnpack(); });
  view.rerender({ ...initial, scope: 'other-account' });
  assert.equal(view.result.current.open, false);
  await act(async () => { submitted.resolve(hash); await sending; });
  assert.equal(view.result.current.open, false);
});

test('wallet rejection and confirmed failures allow a one-tap retry', async () => {
  let calls = 0;
  const initial = options({ onUnpack: async () => ++calls === 1 ? null : calls === 2 ? hash : otherHash });
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  act(() => { view.result.current.openUnpack([item()]); });
  await act(async () => { await view.result.current.requestUnpack(); });
  assert.equal(view.result.current.overlay?.attempted, false);
  await act(async () => { await view.result.current.requestUnpack(); });
  assert.equal(view.result.current.overlay?.transactionHash, hash);
  view.rerender({ ...initial, unpackErrors: { [hash]: 'Reverted' } });
  assert.equal(view.result.current.overlay?.attempted, false);
  await act(async () => { await view.result.current.requestUnpack(); });
  assert.equal(view.result.current.overlay?.transactionHash, otherHash);
  assert.equal(calls, 3);
});

test('terminal errors wait for an active suspended session to resume and announce only once', async () => {
  const messages: string[] = [];
  const initial = options({ onError: message => messages.push(message) });
  const view = renderHook(useEthereumInventoryPresentation, { initialProps: initial });
  act(() => { view.result.current.openUnpack([item()]); });
  await act(async () => { await view.result.current.requestUnpack(); });
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
  act(() => { view.result.current.openUnpack([item()]); });
  await act(async () => { await view.result.current.requestUnpack(); });
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
  const updated = { ...original, category: '3d' as const, animation_url: 'https://wip.lil.org/111k/3d/1.glb',
    image: 'https://wip.lil.org/111k/3d/1.webp', aspectRatio: { width: 1, height: 1 } };
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
  act(() => { hook.result.current.openUnpack([item()]); });
  const view = render(createElement(EthereumInventoryOverlays, { presentation: hook.result.current }));
  const reveal = view.getByRole('button', { name: `Reveal ${item().name}` });
  await act(async () => { fireEvent.click(reveal); });
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
