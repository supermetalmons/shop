import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach, type TestContext } from 'node:test';
import { useEffect } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { ShopRevealOptions } from '../src/shop/reveal/contracts.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { mockMethod } from './helpers/mockMethod.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useRevealAssets } = await import('../src/shop/reveal/useRevealAssets.ts');
const { useShopReveal } = await import('../src/shop/reveal/useShopReveal.ts');
const { soundPlayer } = await import('../src/lib/SoundPlayer.ts');
const { getFrontendDrop } = await import('../src/config/deployment.ts');
const { resolveDropContent } = await import('../src/lib/dropContent.ts');

const content = resolveDropContent('little_swag_boxes');
const context: Parameters<typeof useRevealAssets>[0] = {
  getDropConfig: id => id ? getFrontendDrop(id) : undefined,
  getDropContent: () => ({
    ...content,
    figures: { ...content.figures, revealVideoBaseUrl: 'https://example.test/reveal' },
    reveal: { ...content.reveal, renderer: 'default', frameSequence: {
      baseUrl: 'https://example.test/frames', ext: 'png', frameCount: 2,
      clickMax: 1, autoplayStart: 1, mediaStart: 1,
    } },
  }),
};

beforeEach(() => { soundPlayer.isInitialized = false; });
afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-reveal-video-preload]').forEach(root => root.remove());
});
after(() => dom.window.close());

function media(t: TestContext) {
  const paused: HTMLMediaElement[] = [];
  const loaded: Array<{ element: HTMLMediaElement; urls: string[] }> = [];
  t.mock.method(dom.window.HTMLMediaElement.prototype, 'pause', function (this: HTMLMediaElement) { paused.push(this); });
  t.mock.method(dom.window.HTMLMediaElement.prototype, 'load', function (this: HTMLMediaElement) {
    loaded.push({ element: this, urls: Array.from(this.querySelectorAll('source')).map(source => source.getAttribute('src') ?? '') });
  });
  return { paused, loaded };
}

function roots() { return Array.from(document.querySelectorAll('[data-reveal-video-preload]')); }

test('video preloads survive rerenders and release old media when replaced', t => {
  const calls = media(t);
  const view = renderHook(() => useRevealAssets(context));
  view.result.current.preloadRevealVideos([1, 2]);
  const root = roots()[0];
  const previous = Array.from(root.querySelectorAll('video'));
  assert.equal(calls.loaded.length, 2);
  view.rerender();
  view.result.current.preloadRevealVideos([1, 2]);
  assert.deepEqual(Array.from(root.querySelectorAll('video')), previous);
  assert.equal(calls.loaded.length, 2);
  view.result.current.preloadRevealVideos([3]);
  assert.equal(roots()[0], root);
  assert.equal(root.querySelectorAll('video').length, 1);
  for (const video of previous) {
    assert.equal(video.isConnected, false);
    assert.ok(calls.paused.includes(video));
    assert.equal(video.hasAttribute('src'), false);
    assert.ok(Array.from(video.querySelectorAll('source')).every(source => !source.hasAttribute('src')));
    assert.ok(calls.loaded.some(call => call.element === video && call.urls.every(url => !url)));
  }
});

test('clear, account reset, and unmount release media and allow the same videos to preload again', t => {
  const calls = media(t);
  const view = renderHook(() => useRevealAssets(context));
  view.result.current.preloadRevealVideos([1]);
  const root = roots()[0];
  const first = root.querySelector('video')!;
  view.result.current.clearRevealVideos();
  assert.equal(root.childElementCount, 0);
  assert.ok(calls.paused.includes(first));
  view.result.current.preloadRevealVideos([1]);
  const second = root.querySelector('video')!;
  assert.notEqual(second, first);
  view.result.current.resetRevealAssets();
  view.result.current.resetRevealAssets();
  assert.equal(roots().length, 0);
  assert.ok(calls.paused.includes(second));
  view.result.current.preloadRevealVideos([1]);
  const third = roots()[0].querySelector('video')!;
  view.unmount();
  assert.equal(roots().length, 0);
  assert.ok(calls.paused.includes(third));
});

test('unmount removes only the owning hook preload root and remount remains usable', t => {
  const calls = media(t);
  const first = renderHook(() => useRevealAssets(context));
  const second = renderHook(() => useRevealAssets(context));
  first.result.current.preloadRevealVideos([1]);
  second.result.current.preloadRevealVideos([2]);
  const secondRoot = roots()[1];
  const secondVideo = secondRoot.querySelector('video')!;
  first.unmount();
  assert.deepEqual(roots(), [secondRoot]);
  assert.equal(calls.paused.includes(secondVideo), false);
  second.unmount();
  assert.equal(roots().length, 0);
  const remounted = renderHook(() => useRevealAssets(context));
  remounted.result.current.preloadRevealVideos([1]);
  assert.equal(roots().length, 1);
});

test('Strict Mode effect replay leaves one usable preload root and no orphan on unmount', t => {
  media(t);
  const view = renderHook(() => {
    const assets = useRevealAssets(context);
    useEffect(() => { assets.preloadRevealVideos([1]); }, [assets.preloadRevealVideos]);
    return assets;
  }, { reactStrictMode: true });
  assert.equal(roots().length, 1);
  assert.equal(roots()[0].querySelectorAll('video').length, 1);
  view.unmount();
  assert.equal(roots().length, 0);
});

test('reset releases pending frame images without letting stale callbacks clear a replacement preload', t => {
  class FrameImage {
    src = '';
    decoding = '';
    fetchPriority = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
  }
  const images: FrameImage[] = [];
  t.mock.method(globalThis, 'Image', function () {
    const image = new FrameImage();
    images.push(image);
    return image as unknown as HTMLImageElement;
  });
  const view = renderHook(() => useRevealAssets(context));
  view.result.current.preloadBoxFrames(1, 1);
  const first = images[0];
  const oldLoad = first.onload;
  const oldError = first.onerror;
  assert.ok(oldLoad && oldError);
  view.result.current.resetRevealAssets();
  assert.equal(first.onload, null);
  assert.equal(first.onerror, null);
  assert.equal(first.src, '');
  view.result.current.preloadBoxFrames(1, 1);
  oldLoad();
  oldError();
  view.result.current.preloadBoxFrames(1, 1);
  assert.equal(images.length, 2);
  view.unmount();
  assert.equal(images[1].src, '');
  assert.equal(images[1].onload, null);
  assert.equal(images[1].onerror, null);
});

test('failed sound initialization through playback stays nonblocking and can retry', async t => {
  let attempts = 0;
  mockMethod(t, soundPlayer, 'initializeOnUserInteraction', async () => {
    if (++attempts === 1) throw new Error('Audio unavailable');
    soundPlayer.isInitialized = true;
  });
  t.mock.method(soundPlayer, 'playSound', async () => {});
  t.mock.method(soundPlayer, 'preloadSound', async () => {});
  const view = renderHook(() => useRevealAssets(context));
  await act(async () => { view.result.current.playClickSoundForDropId(); });
  await act(async () => { view.result.current.playClickSoundForDropId(); });
  assert.equal(attempts, 2);
});

test('unmount invalidates an audio continuation still waiting for initialization', async t => {
  const initialization = Promise.withResolvers<void>();
  t.mock.method(soundPlayer, 'initializeOnUserInteraction', () => initialization.promise);
  const playing = t.mock.method(soundPlayer, 'playSound', async () => {});
  const preloading = t.mock.method(soundPlayer, 'preloadSound', async () => {});
  const view = renderHook(() => useRevealAssets(context));
  view.result.current.playClickSoundForDropId('card_nft_2');
  view.unmount();
  await act(async () => { initialization.resolve(); await initialization.promise; });
  assert.equal(playing.mock.callCount(), 0);
  assert.equal(preloading.mock.callCount(), 0);
});

test('reset cancels deferred sound preloads and invalidates playback already waiting for decoding', async t => {
  soundPlayer.isInitialized = true;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  t.mock.method(window, 'setTimeout', (run: () => void) => { timers.set(++nextTimer, run); return nextTimer; });
  t.mock.method(window, 'clearTimeout', (id: number) => { timers.delete(id); });
  let stillActive: (() => boolean) | undefined;
  mockMethod(t, soundPlayer, 'playSound', async (_url, _volume, isActive) => { stillActive = isActive; });
  const preloading = t.mock.method(soundPlayer, 'preloadSound', async () => {});
  const view = renderHook(() => useRevealAssets(context));
  await act(async () => { view.result.current.playClickSoundForDropId('card_nft_2'); });
  assert.equal(timers.size, 1);
  const callback = Array.from(timers.values())[0];
  const isActive = stillActive;
  assert.ok(isActive);
  assert.equal(isActive(), true);
  view.result.current.resetRevealAssets();
  assert.equal(timers.size, 0);
  assert.equal(isActive(), false);
  callback();
  assert.equal(preloading.mock.callCount(), 0);
  await act(async () => { view.result.current.playClickSoundForDropId('card_nft_2'); });
  assert.equal(timers.size, 1);
});

test('the generic reveal click cannot play after the shop unmounts during initialization', async t => {
  const initialization = Promise.withResolvers<void>();
  t.mock.method(soundPlayer, 'initializeOnUserInteraction', async () => {
    await initialization.promise;
    soundPlayer.isInitialized = true;
  });
  t.mock.method(soundPlayer, 'preloadSound', async () => {});
  const playing = t.mock.method(soundPlayer, 'playSound', async () => {});
  const publicKey = new PublicKey(new Uint8Array(32).fill(1));
  const owner = publicKey.toBase58();
  const drop = getFrontendDrop('little_swag_boxes');
  assert.ok(drop);
  const item = { id: 'pending-box', dropId: drop.dropId, kind: 'box' as const, boxId: '1', name: 'Box' };
  let signIns = 0;
  const forbidden = () => { throw new Error('Sound lifecycle verification must not submit transactions'); };
  const options: ShopRevealOptions = {
    ...context,
    connectedWallet: owner, publicKey, owner, localAccountWallet: owner,
    isViewerMode: false, suspended: false, walletModalVisible: false, receiptTransferOpen: false,
    routeDrop: drop, inventory: [item], pendingOpenBoxes: [], figureMetadataByKey: {},
    requireKnownDropConfig: () => drop, getDropConnection: forbidden,
    boxLabelForDropId: () => 'box', figureLabelForDropId: () => 'figure', figureReferenceForDropId: () => 'figure',
    openGerundForDropId: () => 'Opening', canOpenBoxesForDropId: () => true,
    addLocalPendingReveal: forbidden, removeLocalPendingReveal: forbidden, rememberRecentReveal: forbidden,
    addLocalRevealedDudes: forbidden, markAssetsHidden: forbidden, refetchInventory: forbidden,
    refetchPendingOpenBoxes: forbidden, ensureSignedIn: async () => ++signIns === 1,
    openWalletModal: forbidden, blockViewerModeAction: () => false,
    sendAndConfirmViaConnection: forbidden, retryAfterBlockhashExpiry: forbidden,
    clearSelection: forbidden, showToast: forbidden,
  };
  const view = renderHook(() => useShopReveal(options));
  await act(async () => { await view.result.current.openPendingReveal(item, new dom.window.DOMRect(0, 0, 100, 140)); });
  assert.equal(view.result.current.revealOverlay?.phase, 'ready');
  await act(async () => { await view.result.current.handleRevealOverlayClick(); });
  assert.equal(signIns, 2);
  view.unmount();
  await act(async () => { initialization.resolve(); await initialization.promise; });
  assert.equal(playing.mock.callCount(), 0);
});
