import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  figureMetadataCacheKey,
  getCachedFigureMetadata,
  getFigureMetadataSnapshot,
  loadFigureMetadata,
  loadFigureMetadataBatch,
  retainFigureMetadataTargets,
  subscribeFigureMetadata,
  type FigureMetadataTarget,
} from '../src/lib/figureMetadata.ts';

function target(figureId: number): FigureMetadataTarget {
  return { dropId: 'little_swag_hoodies', figureId };
}

function response(name = 'Hoodie'): Response {
  return new Response(JSON.stringify({ name, image: 'https://images.example/hoodie.webp' }));
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushRequests() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function trackRetryTimers(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const setTimeout = globalThis.setTimeout;
  const clearTimeout = globalThis.clearTimeout;
  const active = new Set<ReturnType<typeof globalThis.setTimeout>>();
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay?: number) => {
    const timer = setTimeout(() => {
      active.delete(timer);
      callback();
    }, delay);
    active.add(timer);
    return timer;
  }) as typeof globalThis.setTimeout);
  t.mock.method(globalThis, 'clearTimeout', ((timer: ReturnType<typeof globalThis.setTimeout>) => {
    active.delete(timer);
    clearTimeout(timer);
  }) as typeof globalThis.clearTimeout);
  return active;
}

test('metadata snapshots publish immutable changes and remain stable for cache hits', async (t) => {
  const first = target(91001);
  const second = target(91002);
  const pending = deferredResponse();
  const fetch = t.mock.method(globalThis, 'fetch', () => pending.promise);
  const before = getFigureMetadataSnapshot();
  const snapshots: ReturnType<typeof getFigureMetadataSnapshot>[] = [];
  const unsubscribe = subscribeFigureMetadata(() => snapshots.push(getFigureMetadataSnapshot()));
  t.after(unsubscribe);

  const loading = loadFigureMetadata(first.dropId, first.figureId);
  assert.equal(getFigureMetadataSnapshot(), before);
  assert.equal(snapshots.length, 0);
  pending.resolve(response('First hoodie'));
  const record = await loading;
  const after = getFigureMetadataSnapshot();
  const key = figureMetadataCacheKey(first.dropId, first.figureId);

  assert.notEqual(after, before);
  assert.equal(before[key], undefined);
  assert.equal(after[key], record);
  assert.equal(getCachedFigureMetadata(first.dropId, first.figureId), record);
  assert.deepEqual(snapshots, [after]);
  assert.equal(await loadFigureMetadata(first.dropId, first.figureId), record);
  assert.equal(getFigureMetadataSnapshot(), after);
  assert.equal(snapshots.length, 1);
  assert.equal(fetch.mock.callCount(), 1);

  unsubscribe();
  fetch.mock.mockImplementation(async () => response('Second hoodie'));
  await loadFigureMetadata(second.dropId, second.figureId);
  assert.equal(getFigureMetadataSnapshot()[key], record);
  assert.equal(snapshots.length, 1);
});

test('a 3000-card batch publishes one complete immutable snapshot', async (t) => {
  const targets = Array.from({ length: 3000 }, (_, index) => ({ dropId: 'card_nft_2', figureId: index + 1 }));
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected metadata fetch'); });
  const before = getFigureMetadataSnapshot();
  const snapshots: ReturnType<typeof getFigureMetadataSnapshot>[] = [];
  t.after(subscribeFigureMetadata(() => snapshots.push(getFigureMetadataSnapshot())));

  const records = await loadFigureMetadataBatch([...targets, targets[0], targets[2999]]);
  const after = getFigureMetadataSnapshot();
  assert.equal(records.length, 3000);
  assert.notEqual(after, before);
  assert.deepEqual(snapshots, [after]);
  for (const record of records) {
    const key = figureMetadataCacheKey(record.dropId, record.id);
    assert.equal(before[key], undefined);
    assert.equal(after[key], record);
    assert.equal(getCachedFigureMetadata(record.dropId, record.id), record);
  }
  assert.equal(fetch.mock.callCount(), 0);
  await loadFigureMetadataBatch(targets);
  assert.equal(getFigureMetadataSnapshot(), after);
  assert.equal(snapshots.length, 1);
});

test('3000 synchronous target registrations share a single snapshot publication', async (t) => {
  const targets = Array.from({ length: 3000 }, (_, index) => ({ dropId: 'card_nft_2', figureId: index + 3001 }));
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected metadata fetch'); });
  const before = getFigureMetadataSnapshot();
  const snapshots: ReturnType<typeof getFigureMetadataSnapshot>[] = [];
  t.after(subscribeFigureMetadata(() => snapshots.push(getFigureMetadataSnapshot())));
  const releases = targets.map((figure) => retainFigureMetadataTargets([figure]));
  t.after(() => releases.forEach((release) => release()));
  t.after(retainFigureMetadataTargets([targets[0], targets[2999]]));

  assert.equal(getFigureMetadataSnapshot(), before);
  assert.equal(snapshots.length, 0);
  assert.ok(getCachedFigureMetadata('card_nft_2', 3001)?.image);
  assert.ok(getCachedFigureMetadata('card_nft_2', 6000)?.image);
  await flushRequests();

  const after = getFigureMetadataSnapshot();
  assert.notEqual(after, before);
  assert.deepEqual(snapshots, [after]);
  for (const { dropId, figureId } of targets) {
    const key = figureMetadataCacheKey(dropId, figureId);
    assert.equal(before[key], undefined);
    assert.ok(after[key]?.image);
    assert.equal(after[key], getCachedFigureMetadata(dropId, figureId));
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('resolved metadata is reusable before its snapshot is published', async (t) => {
  const dropId = 'card_nft_2';
  const figureId = 6001;
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected metadata fetch'); });
  const before = getFigureMetadataSnapshot();
  const snapshots: ReturnType<typeof getFigureMetadataSnapshot>[] = [];
  t.after(subscribeFigureMetadata(() => snapshots.push(getFigureMetadataSnapshot())));

  const first = loadFigureMetadata(dropId, figureId);
  const cached = getCachedFigureMetadata(dropId, figureId);
  const second = loadFigureMetadata(dropId, figureId);
  t.after(retainFigureMetadataTargets([{ dropId, figureId }]));
  assert.ok(cached?.image);
  assert.equal(getFigureMetadataSnapshot(), before);
  assert.equal(snapshots.length, 0);

  const [firstRecord, secondRecord] = await Promise.all([first, second]);
  assert.equal(firstRecord, cached);
  assert.equal(secondRecord, cached);
  const after = getFigureMetadataSnapshot();
  const key = figureMetadataCacheKey(dropId, figureId);
  assert.equal(before[key], undefined);
  assert.equal(after[key], cached);
  assert.deepEqual(snapshots, [after]);
  assert.equal(fetch.mock.callCount(), 0);
});

test('retained, imperative, and batch consumers share requests and cache late success after release', async (t) => {
  const figure = target(91003);
  const pending = deferredResponse();
  const fetch = t.mock.method(globalThis, 'fetch', () => pending.promise);
  const release = retainFigureMetadataTargets([figure]);
  t.after(release);
  const individual = loadFigureMetadata(figure.dropId, figure.figureId);
  const batch = loadFigureMetadataBatch([figure, figure]);
  assert.equal(fetch.mock.callCount(), 1);

  release();
  pending.resolve(response());
  const [record, records] = await Promise.all([individual, batch]);
  assert.ok(record);
  assert.deepEqual(records, [record]);
  assert.equal(getCachedFigureMetadata(figure.dropId, figure.figureId), record);
  assert.equal(getFigureMetadataSnapshot()[figureMetadataCacheKey(figure.dropId, figure.figureId)], record);

  const releaseAgain = retainFigureMetadataTargets([figure]);
  t.after(releaseAgain);
  await flushRequests();
  assert.equal(fetch.mock.callCount(), 1);
});

test('overlapping registrations share one retry timer and retry only targets still retained', async (t) => {
  const activeTimers = trackRetryTimers(t);
  const shared = target(91004);
  const separate = target(91005);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  t.mock.method(console, 'warn', () => undefined);
  const releaseFirst = retainFigureMetadataTargets([shared, shared, separate]);
  const releaseSecond = retainFigureMetadataTargets([shared]);
  t.after(releaseFirst);
  t.after(releaseSecond);
  await flushRequests();
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(activeTimers.size, 1);

  releaseFirst();
  releaseFirst();
  assert.equal(activeTimers.size, 1);
  t.mock.timers.tick(2_999);
  await flushRequests();
  assert.equal(fetch.mock.callCount(), 2);
  t.mock.timers.tick(1);
  await flushRequests();
  assert.equal(fetch.mock.callCount(), 3);
  assert.match(String(fetch.mock.calls[2].arguments[0]), /91004\.json$/);
  assert.equal(activeTimers.size, 1);

  releaseSecond();
  assert.equal(activeTimers.size, 0);
  t.mock.timers.tick(30_000);
  await flushRequests();
  assert.equal(fetch.mock.callCount(), 3);
});

test('explicit loads bypass background cooldown and success cancels scheduled retries', async (t) => {
  const activeTimers = trackRetryTimers(t);
  const figure = target(91006);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  t.mock.method(console, 'warn', () => undefined);
  const release = retainFigureMetadataTargets([figure]);
  t.after(release);
  await flushRequests();
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(activeTimers.size, 1);

  await assert.rejects(loadFigureMetadata(figure.dropId, figure.figureId));
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(activeTimers.size, 1);
  fetch.mock.mockImplementation(async () => response());
  const record = await loadFigureMetadata(figure.dropId, figure.figureId);
  assert.ok(record);
  assert.equal(fetch.mock.callCount(), 3);
  assert.equal(activeTimers.size, 0);

  t.mock.timers.tick(30_000);
  await flushRequests();
  assert.equal(fetch.mock.callCount(), 3);
});

test('imperative failures do not schedule background retries without retained targets', async (t) => {
  const activeTimers = trackRetryTimers(t);
  const figure = target(91007);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  await assert.rejects(loadFigureMetadata(figure.dropId, figure.figureId));
  assert.equal(activeTimers.size, 0);
  t.mock.timers.tick(30_000);
  await flushRequests();
  assert.equal(fetch.mock.callCount(), 1);
});

test('invalid and unknown targets neither fetch nor schedule retries', async (t) => {
  const activeTimers = trackRetryTimers(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => response());
  const snapshot = getFigureMetadataSnapshot();
  const release = retainFigureMetadataTargets([
    target(0), target(-1), target(Number.NaN), { dropId: 'unknown-metadata-drop', figureId: 1 },
  ]);
  t.after(release);
  assert.equal(await loadFigureMetadata('unknown-metadata-drop', 1), null);
  t.mock.timers.tick(30_000);
  await flushRequests();
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(activeTimers.size, 0);
  assert.equal(getFigureMetadataSnapshot(), snapshot);
});

test('late failure after final release stays idle and a new registration starts immediately', async (t) => {
  const activeTimers = trackRetryTimers(t);
  const figure = target(91008);
  const pending = deferredResponse();
  const fetch = t.mock.method(globalThis, 'fetch', () => pending.promise);
  t.mock.method(console, 'warn', () => undefined);
  const release = retainFigureMetadataTargets([figure]);
  t.after(release);
  release();
  pending.resolve(new Response(null, { status: 503 }));
  await flushRequests();
  assert.equal(activeTimers.size, 0);
  t.mock.timers.tick(30_000);
  await flushRequests();
  assert.equal(fetch.mock.callCount(), 1);

  fetch.mock.mockImplementation(async () => response());
  const releaseAgain = retainFigureMetadataTargets([figure]);
  t.after(releaseAgain);
  await flushRequests();
  assert.equal(fetch.mock.callCount(), 2);
  assert.ok(getCachedFigureMetadata(figure.dropId, figure.figureId));
  assert.equal(activeTimers.size, 0);
});
