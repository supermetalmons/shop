import assert from 'node:assert/strict';
import test from 'node:test';
import { mapWithConcurrency } from '../src/mapWithConcurrency.ts';

test('concurrent mapping preserves input order and bounds active work', async () => {
  const pending = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const result = mapWithConcurrency([10, 20, 30, 40, 50], 2, async (value, index) => {
    started.push(index);
    peak = Math.max(peak, ++active);
    await pending[index].promise;
    active -= 1;
    return value + index;
  }, { signal: new AbortController().signal });
  assert.deepEqual(started, [0, 1]);
  pending[1].resolve();
  await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1, 2]);
  pending[2].resolve();
  await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1, 2, 3]);
  pending.forEach(({ resolve }) => resolve());
  assert.deepEqual(await result, [10, 21, 32, 43, 54]);
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test('concurrent mapping handles empty input and rejects invalid concurrency', async () => {
  const options = { signal: new AbortController().signal };
  assert.deepEqual(await mapWithConcurrency([], 4, async () => assert.fail('unexpected mapping'), options), []);
  for (const concurrency of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(mapWithConcurrency([1], concurrency, async () => assert.fail('unexpected mapping'), options), RangeError);
  }
});

test('concurrent mapping cancels siblings, drains work, and preserves its first failure', async () => {
  const parent = new AbortController();
  const failure = new Error('first failure');
  const siblingFailure = new Error('sibling failure');
  const cleanup = Promise.withResolvers<void>();
  const siblingAborted = Promise.withResolvers<void>();
  const started: number[] = [];
  let settled = false;
  const result = mapWithConcurrency([0, 1, 2, 3], 2, async (value, _index, signal) => {
    started.push(value);
    if (value === 0) throw failure;
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
      assert.equal(signal.reason, failure);
      siblingAborted.resolve();
      resolve();
    }, { once: true }));
    await cleanup.promise;
    throw siblingFailure;
  }, { signal: parent.signal });
  const rejected = assert.rejects(result, (error) => error === failure).then(() => { settled = true; });
  await siblingAborted.promise;
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1]);
  assert.equal(parent.signal.aborted, false);
  cleanup.resolve();
  await rejected;
});

test('concurrent mapping preserves an undefined rejection', async () => {
  await assert.rejects(mapWithConcurrency([0, 1], 1, async () => {
    throw undefined;
  }, { signal: new AbortController().signal }), (error) => error === undefined);
});

test('concurrent mapping starts no work for an aborted caller', async () => {
  const reason = new Error('already cancelled');
  await assert.rejects(mapWithConcurrency([1], 2, async () => assert.fail('unexpected mapping'), {
    signal: AbortSignal.abort(reason),
  }), (error) => error === reason);
});

test('concurrent mapping propagates caller cancellation without scheduling more work', async () => {
  const parent = new AbortController();
  const reason = new Error('cancelled');
  const started: number[] = [];
  const result = mapWithConcurrency([0, 1, 2], 2, async (value, _index, signal) => {
    started.push(value);
    return new Promise<number>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }, { signal: parent.signal });
  const rejected = assert.rejects(result, (error) => error === reason);
  parent.abort(reason);
  await rejected;
  assert.deepEqual(started, [0, 1]);
});

test('concurrent mapping rejects cancellation when an active mapper ignores its signal', async () => {
  const parent = new AbortController();
  const reason = new Error('cancelled');
  const active = Promise.withResolvers<number>();
  const result = mapWithConcurrency([1], 1, async () => active.promise, { signal: parent.signal });
  const rejected = assert.rejects(result, (error) => error === reason);
  parent.abort(reason);
  active.resolve(1);
  await rejected;
});
