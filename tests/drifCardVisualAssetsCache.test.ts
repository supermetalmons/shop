import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { DRIF_EFFECTS, getDrifCardVisualAssetSources, type DrifCardConfig } from '../src/drifCards.ts';
import {
  drifCardVisualAssetsCache,
  preloadDrifCardVisualAssets,
} from '../src/lib/drifCardVisualAssets.ts';
import { createDrifCardVisualAssetsCache } from '../src/lib/drifCardVisualAssetsCache.ts';
import { loadMiNoteCardAssets, type MiNoteCardAssetResidency } from '../src/lib/miNoteCardAssets.ts';
import { mockCardAssetImages } from './helpers/cardAssets.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useDrifCardVisualAssets } = await import('../src/hooks/useDrifCardVisualAssets.ts');
afterEach(() => {
  cleanup();
  drifCardVisualAssetsCache.clear();
});
after(() => dom.window.close());

function card(id: number): DrifCardConfig & { foilSrc: string; textureSrc: string } {
  return {
    imageSrc: `https://images.example/front-${id}.webp`,
    foilSrc: `https://images.example/foil-${id}.webp`,
    textureSrc: `https://images.example/mask-${id}.webp`,
    effect: DRIF_EFFECTS['swshp-SWSH179']!,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function controlledCache() {
  const calls: {
    cards: readonly DrifCardConfig[];
    signal?: AbortSignal;
    pending: ReturnType<typeof deferred<MiNoteCardAssetResidency>>;
    releases: number;
    resolve: () => void;
  }[] = [];
  const loader: typeof loadMiNoteCardAssets = (cards, options) => {
    const pending = deferred<MiNoteCardAssetResidency>();
    const call = {
      cards,
      signal: options?.signal,
      pending,
      releases: 0,
      resolve: () => pending.resolve({ images: [], release: () => { call.releases += 1; } }),
    };
    calls.push(call);
    return pending.promise;
  };
  return { calls, cache: createDrifCardVisualAssetsCache(loader) };
}

test('preload and the mounted hook share the exact required high-priority images through final decode', async (t) => {
  const images = mockCardAssetImages(t);
  const selected = card(1);
  preloadDrifCardVisualAssets(selected);
  assert.deepEqual(images.map((image) => image.src), getDrifCardVisualAssetSources(selected));
  assert.ok(images.every((image) => image.fetchPriority === 'high'));
  const count = images.length;
  const view = renderHook(() => useDrifCardVisualAssets(selected));
  assert.equal(images.length, count);
  assert.equal(view.result.current.ready, false);

  await act(async () => {
    images.forEach((image) => image.load());
    images.slice(0, -1).forEach((image) => image.resolveDecode());
  });
  assert.equal(view.result.current.ready, false);
  await act(async () => { images.at(-1)!.resolveDecode(); });
  assert.equal(view.result.current.ready, true);
  assert.ok(images.every((image) => image.decodeCalls === 1));
  view.unmount();
  assert.ok(images.every((image) => image.src !== ''));
  drifCardVisualAssetsCache.clear();
  assert.ok(images.every((image) => image.src === ''));
});

test('cached reopens are ready on their first render and do not restart loading under StrictMode', async () => {
  const { calls, cache } = controlledCache();
  const selected = card(1);
  cache.preload(selected);
  calls[0]!.resolve();
  await calls[0]!.pending.promise;
  const frames: boolean[] = [];
  const view = renderHook(() => {
    const state = useDrifCardVisualAssets(selected, cache);
    frames.push(state.ready);
    return state;
  }, { reactStrictMode: true });
  assert.ok(frames.length > 0 && frames.every(Boolean));
  assert.equal(calls.length, 1);
  view.unmount();
  assert.equal(calls[0]!.releases, 0);
  const reopenedFrames: boolean[] = [];
  const reopened = renderHook(() => {
    const state = useDrifCardVisualAssets({ ...selected }, cache);
    reopenedFrames.push(state.ready);
    return state;
  });
  assert.ok(reopenedFrames.length > 0 && reopenedFrames.every(Boolean));
  assert.equal(calls.length, 1);
  reopened.unmount();
  cache.clear();
  assert.equal(calls[0]!.releases, 1);
});

test('card switches immediately hide old readiness and can reuse pending or ready assets', async () => {
  const { calls, cache } = controlledCache();
  const first = card(1);
  const second = card(2);
  const frames: { source: string; ready: boolean }[] = [];
  const view = renderHook((selected: DrifCardConfig | undefined) => {
    const state = useDrifCardVisualAssets(selected, cache);
    frames.push({ source: selected?.imageSrc ?? '', ready: state.ready });
    return state;
  }, { initialProps: first as DrifCardConfig | undefined });
  await act(async () => { calls[0]!.resolve(); });
  view.rerender(second);
  assert.equal(view.result.current.ready, false);
  assert.ok(frames.filter((frame) => frame.source === second.imageSrc).every((frame) => !frame.ready));
  view.rerender(first);
  assert.equal(view.result.current.ready, true);
  assert.equal(calls.length, 2);
  await act(async () => { calls[1]!.resolve(); });
  assert.equal(view.result.current.ready, true);
  view.rerender(second);
  assert.equal(view.result.current.ready, true);
  view.rerender(undefined);
  assert.deepEqual(view.result.current, { ready: false, error: null });
  assert.equal(calls.length, 2);
  view.unmount();
  cache.clear();
});

test('the hook does not request assets without a card and shares equivalent visual sources', async () => {
  const { calls, cache } = controlledCache();
  const view = renderHook((selected: DrifCardConfig | undefined) => useDrifCardVisualAssets(selected, cache), {
    initialProps: undefined as DrifCardConfig | undefined,
  });
  assert.equal(calls.length, 0);
  const selected = card(1);
  view.rerender(selected);
  view.rerender({ ...selected, foilSrc: 'https://images.example/unused.webp', effect: { ...selected.effect, id: 'equivalent' } });
  assert.equal(calls.length, 1);
  const second = renderHook(() => useDrifCardVisualAssets(selected, cache));
  assert.equal(calls.length, 1);
  await act(async () => { calls[0]!.resolve(); });
  assert.equal(view.result.current.ready, true);
  assert.equal(second.result.current.ready, true);
  view.unmount();
  second.unmount();
  cache.clear();
});

test('failed assets stay unready and explicit preload or reopening retries without stale errors', async () => {
  const { calls, cache } = controlledCache();
  const selected = card(1);
  const view = renderHook(() => useDrifCardVisualAssets(selected, cache));
  const error = new Error('texture unavailable');
  await act(async () => { calls[0]!.pending.reject(error); });
  assert.deepEqual(view.result.current, { ready: false, error });
  act(() => cache.preload(selected));
  assert.deepEqual(view.result.current, { ready: false, error: null });
  assert.equal(calls.length, 2);
  await act(async () => { calls[1]!.pending.reject(error); });
  view.unmount();
  const reopened = renderHook(() => useDrifCardVisualAssets(selected, cache));
  assert.deepEqual(reopened.result.current, { ready: false, error: null });
  assert.equal(calls.length, 3);
  await act(async () => { calls[2]!.resolve(); });
  assert.equal(reopened.result.current.ready, true);
  reopened.unmount();
  cache.clear();
});

test('only the three most recently used idle cards retain decoded image residency', async () => {
  const { calls, cache } = controlledCache();
  for (const id of [1, 2, 3]) {
    cache.preload(card(id));
    calls.at(-1)!.resolve();
    await calls.at(-1)!.pending.promise;
  }
  cache.preload(card(1));
  cache.preload(card(4));
  assert.equal(calls.length, 4);
  assert.equal(calls[0]!.releases, 0);
  assert.equal(calls[1]!.releases, 1);
  assert.equal(calls[2]!.releases, 0);
  assert.equal(cache.getSnapshot(card(2)).ready, false);
  cache.clear();
  assert.equal(calls[0]!.releases, 1);
  assert.equal(calls[2]!.releases, 1);
  assert.equal(calls[3]!.signal?.aborted, true);
});

test('active subscriptions are never evicted and the idle limit applies when subscribers leave', async () => {
  const { calls, cache } = controlledCache();
  const unsubscribers = [1, 2, 3, 4].map((id) => cache.subscribe(card(id), () => {}));
  const extraSubscriber = cache.subscribe(card(1), () => {});
  calls.forEach((call) => call.resolve());
  await Promise.all(calls.map((call) => call.pending.promise));
  for (const id of [5, 6, 7, 8]) cache.preload(card(id));
  assert.ok(calls.slice(0, 4).every((call) => call.releases === 0 && !call.signal?.aborted));
  assert.equal(calls[4]!.signal?.aborted, true);
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  assert.equal(calls[0]!.releases, 0);
  extraSubscriber();
  assert.equal(calls[1]!.releases, 1);
  assert.equal(calls[2]!.releases, 0);
  assert.equal(calls[3]!.releases, 0);
  cache.clear();
});

test('eviction cancels pending loads and late completions cannot revive or replace a new entry', async () => {
  const { calls, cache } = controlledCache();
  for (const id of [1, 2, 3, 4]) cache.preload(card(id));
  assert.equal(calls[0]!.signal?.aborted, true);
  cache.preload(card(1));
  calls[0]!.resolve();
  await calls[0]!.pending.promise;
  assert.equal(calls[0]!.releases, 1);
  assert.equal(cache.getSnapshot(card(1)).ready, false);
  calls[4]!.resolve();
  await calls[4]!.pending.promise;
  assert.equal(cache.getSnapshot(card(1)).ready, true);
  calls[1]!.pending.reject(new Error('late cancelled load'));
  await Promise.resolve();
  assert.deepEqual(cache.getSnapshot(card(1)), { ready: true, error: null });
  cache.clear();
});

test('reset releases decoded images, aborts pending work, and ignores late completions', async () => {
  const { calls, cache } = controlledCache();
  cache.preload(card(1));
  cache.preload(card(2));
  calls[0]!.resolve();
  await calls[0]!.pending.promise;
  cache.clear();
  assert.equal(calls[0]!.releases, 1);
  assert.equal(calls[1]!.signal?.aborted, true);
  calls[1]!.resolve();
  await calls[1]!.pending.promise;
  assert.equal(calls[1]!.releases, 1);
  assert.deepEqual(cache.getSnapshot(card(1)), { ready: false, error: null });
  assert.deepEqual(cache.getSnapshot(card(2)), { ready: false, error: null });
  cache.preload(card(2));
  assert.equal(calls.length, 3);
  cache.clear();
});

test('a synchronous loader failure can be retried without leaving a stuck pending entry', async () => {
  const failure = new Error('Image unavailable');
  let attempts = 0;
  const cache = createDrifCardVisualAssetsCache(() => {
    attempts += 1;
    if (attempts === 1) throw failure;
    return Promise.resolve({ images: [], release: () => {} });
  });
  cache.preload(card(1));
  assert.deepEqual(cache.getSnapshot(card(1)), { ready: false, error: failure });
  cache.preload(card(1));
  await Promise.resolve();
  assert.deepEqual(cache.getSnapshot(card(1)), { ready: true, error: null });
  cache.clear();
});
