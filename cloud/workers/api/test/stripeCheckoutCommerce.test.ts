import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
} from '../src/commerceRepository.ts';
import { commerceTimestamp } from '../src/commerceTransactions.ts';
import {
  stripeCheckoutWriteData,
  type StripeCheckoutCommerceContext,
} from '../src/stripeCheckout/commerce.ts';
import { markStripeCheckoutFulfillmentFulfilled } from '../src/stripeCheckout/service.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

test('Stripe checkout commerce applies native fields, deletes, increments, and timestamps', async (context) => {
  const nowMs = 1_800_000_000_000;
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const key = commerceKeys.stripeCheckout('drop', 'session');
  seedCommerceDocument(harness, {
    key,
    data: { removed: 'old', processingAttemptCount: 2, status: 'pending' },
  });
  const repository = new D1CommerceRepository(harness.db);
  const updatedAt = commerceFieldValue.serverTimestamp();
  const updates = stripeCheckoutWriteData({
    status: 'processing',
    updatedAt,
    removed: commerceFieldValue.delete(),
    processingAttemptCount: commerceFieldValue.increment(1),
    processingLeaseExpiresAt: commerceTimestamp(nowMs + 1_000),
  });
  assert.equal(updates.updatedAt, updatedAt);
  await repository.run(nowMs, (unit) => unit.update(key, updates));

  assert.deepEqual((await repository.get(key))?.data, {
    processingAttemptCount: 3,
    processingLeaseExpiresAt: nowMs + 1_000,
    status: 'processing',
    updatedAt: nowMs,
  });
});

test('Stripe checkout write normalization preserves JSON with mutation-like fields', () => {
  const data = {
    deleteField: { kind: 'delete_field' },
    nativeDeleteField: { kind: 'delete-field' },
    increment: { kind: 'increment', operand: 3, amount: 3 },
    serverTimestamp: { kind: 'server_timestamp' },
    nativeServerTimestamp: { kind: 'server-timestamp' },
    timestamp: { kind: 'timestamp', milliseconds: 123, value: { seconds: 0, nanos: 123_000_000 } },
  };
  assert.deepEqual(stripeCheckoutWriteData(data), data);
});

test('Stripe checkout write normalization omits undefined object fields without mutating input', () => {
  const data = {
    absent: undefined,
    error: { message: 'failed', details: undefined },
    items: [{ value: 1, absent: undefined }],
  };
  const normalized = stripeCheckoutWriteData(data);
  assert.deepEqual(normalized, { error: { message: 'failed' }, items: [{ value: 1 }] });
  assert.equal(Object.hasOwn(data, 'absent'), true);
  assert.equal(Object.hasOwn(data.error, 'details'), true);
  assert.notEqual(normalized.error, data.error);
  assert.notEqual(normalized.items, data.items);
});

test('Stripe checkout write normalization rejects invalid JSON and undefined array entries', () => {
  for (const value of [NaN, Infinity, -Infinity, 1n, Symbol('invalid'), () => 1, [undefined], { nested: [undefined] }]) {
    assert.throws(() => stripeCheckoutWriteData({ value }), /Invalid Stripe checkout document value/);
  }
});

test('Stripe checkout write normalization rejects invalid native timestamps', () => {
  for (const milliseconds of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => stripeCheckoutWriteData({ value: commerceTimestamp(milliseconds) }),
      /Invalid Stripe checkout timestamp/,
    );
  }
  assert.throws(
    () => stripeCheckoutWriteData({ value: commerceFieldValue.timestamp(1, 1_000_000_000) }),
    /Invalid Stripe checkout timestamp/,
  );
});

test('Stripe checkout retries aborted commits with a fresh clock and processing-attempt read', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const key = commerceKeys.stripeCheckout('drop', 'session');
  seedCommerceDocument(harness, {
    key,
    data: { status: 'processing', processingAttemptId: 'old-attempt' },
  });
  const repository = new D1CommerceRepository(harness.db);
  const nowMs = 1_800_000_000_000;
  const operationTimes: number[] = [];
  let clockCalls = 0;
  const commerce: StripeCheckoutCommerceContext = {
    nowMs: () => nowMs + clockCalls++,
    repository: {
      get: repository.get.bind(repository),
      run: (now, operation) => repository.run(now, async (unit) => {
        operationTimes.push(now);
        const result = await operation(unit);
        if (operationTimes.length === 1) {
          await repository.run(now, (competing) => competing.update(key, { processingAttemptId: 'new-attempt' }));
        }
        return result;
      }),
    },
  };

  const result = await markStripeCheckoutFulfillmentFulfilled(commerce, key, {
    deliveryId: 123,
    processingAttemptId: 'old-attempt',
  });
  assert.deepEqual(result, { status: 'stale_processing_attempt' });
  assert.deepEqual(operationTimes, [nowMs, nowMs + 1]);
  assert.deepEqual((await repository.get(key))?.data, {
    status: 'processing',
    processingAttemptId: 'new-attempt',
  });
});

test('Stripe checkout missing-document updates surface failed preconditions without retrying', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.stripeCheckout('drop', 'missing');
  let attempts = 0;
  const commerce: StripeCheckoutCommerceContext = {
    nowMs: () => 1_800_000_000_000,
    repository: {
      get: repository.get.bind(repository),
      run: (now, operation) => {
        attempts += 1;
        return repository.run(now, operation);
      },
    },
  };
  await assert.rejects(
    markStripeCheckoutFulfillmentFulfilled(commerce, key, { deliveryId: 123 }),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'failed-precondition',
  );
  assert.equal(attempts, 1);
  assert.equal(await repository.get(key), null);
});
