import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { pollSignatureConfirmation } from '../src/signaturePolling.ts';

test('signature polling returns terminal evidence even when its callback aborts the signal', async () => {
  const controller = new AbortController();
  const result = { ok: false, error: 'known failure' };
  const polled = await pollSignatureConfirmation({
    signal: controller.signal,
    timeoutMs: 25_000,
    poll: async () => {
      controller.abort(new Error('logs unavailable'));
      return result;
    },
    finalLookup: async () => assert.fail('terminal evidence must not trigger another lookup'),
  });
  assert.equal(polled, result);
});

test('signature polling uses full 800ms delays before its single final lookup', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const attempts: number[] = [];
  let finalLookups = 0;
  const result = { ok: false };
  const polling = pollSignatureConfirmation({
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    poll: async () => { attempts.push(Date.now()); return undefined; },
    finalLookup: async () => { finalLookups += 1; return result; },
  });
  await setImmediate();
  context.mock.timers.tick(799);
  await setImmediate();
  assert.deepEqual(attempts, [0]);
  context.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(attempts, [0, 800]);
  context.mock.timers.tick(200);
  await setImmediate();
  assert.equal(finalLookups, 0);
  context.mock.timers.tick(600);
  assert.equal(await polling, result);
  assert.equal(finalLookups, 1);
  assert.deepEqual(attempts, [0, 800]);
});

test('signature history is evaluated lazily and only after six seconds', async (context) => {
  let nowMs = 10_000;
  context.mock.method(Date, 'now', () => nowMs);
  await pollSignatureConfirmation({
    signal: new AbortController().signal,
    timeoutMs: 25_000,
    poll: async ({ searchTransactionHistory }) => {
      assert.equal(searchTransactionHistory(), false);
      nowMs += 6_000;
      assert.equal(searchTransactionHistory(), false);
      nowMs += 1;
      assert.equal(searchTransactionHistory(), true);
      return { ok: true };
    },
    finalLookup: async () => assert.fail('confirmed signature must not trigger a final lookup'),
  });
});

test('zero polling budget goes straight to the caller final lookup without imposing cancellation', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  const result = { ok: true };
  let finalLookups = 0;
  assert.equal(await pollSignatureConfirmation({
    signal: controller.signal,
    timeoutMs: 0,
    poll: async () => assert.fail('zero timeout must skip polling'),
    finalLookup: async () => { finalLookups += 1; return result; },
  }), result);
  assert.equal(finalLookups, 1);
});

test('an in-flight signature poll can return terminal evidence after the elapsed budget', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const pending = Promise.withResolvers<{ ok: true }>();
  const polling = pollSignatureConfirmation({
    signal: new AbortController().signal,
    timeoutMs: 1,
    poll: () => pending.promise,
    finalLookup: async () => assert.fail('terminal evidence must not trigger a final lookup'),
  });
  context.mock.timers.tick(25_000);
  const result = { ok: true } as const;
  pending.resolve(result);
  assert.equal(await polling, result);
});

test('signature polling preserves callback rejection identity without fallback or normalization', async () => {
  for (const timeoutMs of [0, 25_000]) {
    const controller = new AbortController();
    const failure = new Error('provider failed');
    const reject = async () => {
      controller.abort(new Error('concurrent cancellation'));
      throw failure;
    };
    await assert.rejects(pollSignatureConfirmation({
      signal: controller.signal,
      timeoutMs,
      poll: timeoutMs === 0 ? async () => assert.fail('zero timeout must skip polling') : reject,
      finalLookup: timeoutMs === 0 ? reject : async () => assert.fail('poll error must not trigger a final lookup'),
    }), (error) => error === failure);
  }
});

test('cancellation during the signature poll delay prevents further lookups', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const controller = new AbortController();
  const reason = { kind: 'stop polling' };
  let attempts = 0;
  const polling = pollSignatureConfirmation({
    signal: controller.signal,
    timeoutMs: 25_000,
    poll: async () => { attempts += 1; return undefined; },
    finalLookup: async () => assert.fail('cancelled polling must not trigger a final lookup'),
  });
  const rejection = assert.rejects(polling, (error) => error === reason);
  await setImmediate();
  controller.abort(reason);
  await rejection;
  context.mock.timers.tick(25_000);
  assert.equal(attempts, 1);
});
