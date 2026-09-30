import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@solana/web3.js';
import { waitForSignature } from '../src/deliveryReceiptOnchain.ts';

const signature = 'receipt-signature';

function connection(methods: {
  getSignatureStatuses?: () => Promise<unknown>;
  getTransaction?: () => Promise<unknown>;
}): Connection {
  return methods as unknown as Connection;
}

test('receipt polling preserves definitive errors when their log lookup fails or is cancelled', async () => {
  const transactionError = { InstructionError: [0, { Custom: 1 }] };
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const reason = new Error('log lookup failed');
    const result = await waitForSignature(connection({
      getSignatureStatuses: async () => ({
        value: [{ confirmationStatus: 'processed', confirmations: 0, err: transactionError }],
      }),
      getTransaction: async () => {
        if (cancelled) controller.abort(reason);
        throw reason;
      },
    }), signature, controller.signal, 100);
    assert.deepEqual(result, { ok: false, definitive: true, error: transactionError, logs: [] });
  }
});

test('receipt polling and final lookup retain the exact cancellation error', async () => {
  for (const timeoutMs of [0, 100]) {
    const controller = new AbortController();
    const reason = { kind: 'cancelled' };
    const failure = new Error('provider cancelled', { cause: reason });
    const cancel = async () => {
      controller.abort(reason);
      throw failure;
    };
    await assert.rejects(waitForSignature(connection({
      getSignatureStatuses: cancel,
      getTransaction: cancel,
    }), signature, controller.signal, timeoutMs), (error) => error === failure);
  }
});

test('receipt final lookup preserves definitive evidence and filters only nonstring logs', async () => {
  const transactionError = { InstructionError: [0, { Custom: 1 }] };
  const logs = Array.from({ length: 81 }, (_, index) => `log ${index}`);
  for (const [transaction, expected] of [
    [null, { ok: false, definitive: false, error: 'timeout', logs: [] }],
    [{ meta: { err: null } }, { ok: true }],
    [{ meta: { err: transactionError, logMessages: [null, ...logs, 1] } },
      { ok: false, definitive: true, error: transactionError, logs }],
  ] as const) {
    let lookups = 0;
    const result = await waitForSignature(connection({
      getSignatureStatuses: async () => assert.fail('zero timeout must skip status polling'),
      getTransaction: async () => { lookups += 1; return transaction; },
    }), signature, new AbortController().signal, 0);
    assert.deepEqual(result, expected);
    assert.equal(lookups, 1);
  }
  assert.deepEqual(await waitForSignature(connection({
    getTransaction: async () => { throw new Error('unavailable'); },
  }), signature, new AbortController().signal, 0), {
    ok: false, definitive: false, error: 'timeout', logs: [],
  });
});
