import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { DRIF_EFFECTS, getDrifCardVisualAssetSources, type DrifCardConfig } from '../src/drifCards.ts';
import { loadMiNoteCardAssets, type MiNoteCardAssetResidency } from '../src/lib/miNoteCardAssets.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useMiNoteCardAssets } = await import('../src/hooks/useMiNoteCardAssets.ts');
afterEach(cleanup);
after(() => dom.window.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function card(id: number): DrifCardConfig {
  return {
    imageSrc: `https://images.example/front-${id}.webp`,
    foilSrc: `https://images.example/foil-${id}.webp`,
    textureSrc: `https://images.example/mask-${id}.webp`,
    effect: DRIF_EFFECTS['swshp-SWSH179']!,
  };
}

class FakeImage {
  src = '';
  decoding = '';
  fetchPriority = '';
  complete = false;
  naturalWidth = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decoded = deferred<void>();
  decodeCalls = 0;

  decode() {
    this.decodeCalls += 1;
    return this.decoded.promise;
  }

  load() {
    this.complete = true;
    this.naturalWidth = 1000;
    this.onload?.();
  }
}

function imageFactory() {
  const images: FakeImage[] = [];
  return {
    images,
    createImage: () => {
      const image = new FakeImage();
      images.push(image);
      return image as unknown as HTMLImageElement;
    },
  };
}

test('preloading deduplicates both cards and waits for every effect layer to decode', async () => {
  const { images, createImage } = imageFactory();
  const cards = [card(1), card(2)];
  const pending = loadMiNoteCardAssets(cards, { createImage });
  const sources = [...new Set(cards.flatMap(getDrifCardVisualAssetSources))];
  assert.deepEqual(images.map((image) => image.src), sources);
  assert.equal(images.length, 8);
  assert.ok(images.every((image) => image.decoding === 'async' && image.fetchPriority === 'high'));

  let ready = false;
  void pending.then(() => { ready = true; });
  images.forEach((image) => image.load());
  images.slice(0, -1).forEach((image) => image.decoded.resolve());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ready, false);
  images.at(-1)!.decoded.resolve();
  const loaded = await pending;
  assert.equal(ready, true);
  assert.equal(loaded.images.length, 8);
  assert.deepEqual(images.map((image) => image.src), sources);
  assert.ok(images.every((image) => image.decodeCalls === 1));
  loaded.release();
  loaded.release();
  assert.ok(images.every((image) => image.src === '' && !image.onload && !image.onerror));
});

test('load failures release the entire batch and retry reloads the same source set', async () => {
  const first = imageFactory();
  const cards = [card(1), card(2)];
  const pending = loadMiNoteCardAssets(cards, first);
  const rejected = assert.rejects(pending, /Unable to load card asset/);
  first.images[0]!.onerror?.();
  await rejected;
  assert.ok(first.images.every((image) => image.src === '' && !image.onload && !image.onerror));

  const retry = imageFactory();
  const retried = loadMiNoteCardAssets(cards, retry);
  assert.deepEqual(retry.images.map((image) => image.src), [...new Set(cards.flatMap(getDrifCardVisualAssetSources))]);
  retry.images.forEach((image) => { image.load(); image.decoded.resolve(); });
  (await retried).release();
});

test('decode failures and decode timeouts fail readiness and release pending images', async () => {
  const failed = imageFactory();
  const pending = loadMiNoteCardAssets([card(1)], failed);
  const rejected = assert.rejects(pending, /Unable to decode card asset/);
  failed.images[0]!.load();
  failed.images[0]!.decoded.reject(new Error('decode failed'));
  await rejected;
  assert.ok(failed.images.every((image) => image.src === ''));

  const timeout = imageFactory();
  const timed = loadMiNoteCardAssets([card(1)], { ...timeout, timeoutMs: 5 });
  timeout.images.forEach((image) => image.load());
  await assert.rejects(timed, /Timed out loading card asset/);
  assert.ok(timeout.images.every((image) => image.src === ''));
  timeout.images.forEach((image) => image.decoded.resolve());
});

test('abort during decode rejects, ignores late decode completion, and releases images', async () => {
  const batch = imageFactory();
  const controller = new AbortController();
  const pending = loadMiNoteCardAssets([card(1)], { ...batch, signal: controller.signal });
  batch.images.forEach((image) => image.load());
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
  batch.images.forEach((image) => image.decoded.resolve());
  await Promise.resolve();
  assert.ok(batch.images.every((image) => image.src === '' && !image.onload && !image.onerror));
});

test('already-aborted signals create no images and abort also releases successful residents', async () => {
  const batch = imageFactory();
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(loadMiNoteCardAssets([card(1)], { ...batch, signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(batch.images.length, 0);

  const controller = new AbortController();
  const pending = loadMiNoteCardAssets([card(1)], { ...batch, signal: controller.signal });
  batch.images.forEach((image) => { image.load(); image.decoded.resolve(); });
  await pending;
  controller.abort();
  assert.ok(batch.images.every((image) => image.src === ''));
});

function controlledLoader() {
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
  return { calls, loader };
}

test('the hook immediately hides old readiness on new cards and ignores stale loads', async () => {
  const { calls, loader } = controlledLoader();
  const frames: { key: string; ready: boolean }[] = [];
  const first = [card(1), card(2)];
  const view = renderHook((cards: readonly DrifCardConfig[]) => {
    const result = useMiNoteCardAssets(cards, loader);
    frames.push({ key: cards[0]!.imageSrc, ready: result.ready });
    return result;
  }, { initialProps: first });
  await act(async () => { calls[0]!.resolve(); });
  assert.equal(view.result.current.ready, true);

  const second = [card(3), card(4)];
  view.rerender(second);
  assert.equal(calls[0]!.signal?.aborted, true);
  assert.equal(calls[0]!.releases, 1);
  assert.equal(view.result.current.ready, false);
  assert.ok(frames.filter((frame) => frame.key === second[0]!.imageSrc).every((frame) => !frame.ready));

  view.rerender([card(5), card(6)]);
  await act(async () => { calls[1]!.resolve(); });
  assert.equal(calls[1]!.releases, 1);
  assert.equal(view.result.current.ready, false);
  await act(async () => { calls[2]!.resolve(); });
  assert.equal(view.result.current.ready, true);
  view.unmount();
  assert.equal(calls[2]!.releases, 1);
});

test('the hook exposes load errors and retries the same pair without stale error or readiness', async () => {
  const { calls, loader } = controlledLoader();
  const cards = [card(1), card(2)];
  const view = renderHook(() => useMiNoteCardAssets(cards, loader));
  const failure = new Error('texture missing');
  await act(async () => { calls[0]!.pending.reject(failure); });
  assert.equal(view.result.current.error, failure);
  assert.equal(view.result.current.ready, false);
  act(() => view.result.current.retry());
  assert.equal(view.result.current.error, null);
  assert.equal(view.result.current.ready, false);
  assert.deepEqual(calls[1]!.cards, cards);
  await act(async () => { calls[1]!.resolve(); });
  assert.equal(view.result.current.ready, true);
  act(() => view.result.current.retry());
  assert.equal(view.result.current.ready, false);
  assert.equal(calls[1]!.releases, 1);
});

test('the hook preserves residents for equivalent arrays and aborts pending loads on unmount', async () => {
  const { calls, loader } = controlledLoader();
  const view = renderHook((cards: readonly DrifCardConfig[]) => useMiNoteCardAssets(cards, loader), {
    initialProps: [card(1), card(2)],
    reactStrictMode: true,
  });
  const active = calls.at(-1)!;
  view.rerender([card(1), card(2)]);
  assert.equal(calls.at(-1), active);
  view.unmount();
  assert.equal(active.signal?.aborted, true);
  await act(async () => { calls.forEach((call) => call.resolve()); });
  assert.ok(calls.every((call) => call.releases === 1));
});
