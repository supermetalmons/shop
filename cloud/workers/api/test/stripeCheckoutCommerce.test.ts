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
  getStripeCheckout,
  stripeCheckoutRecord,
  stripeCheckoutWriteData,
  updateStripeCheckout,
  validateStripeCheckoutForFulfillment,
  type StripeCheckoutCommerceContext,
} from '../src/stripeCheckout/commerce.ts';
import { StripeCheckoutFulfillmentError } from '../src/stripeCheckout/errors.ts';
import { createStripeCheckoutIdentity } from '../../../../shared/checkoutIdentity.ts';
import { markStripeCheckoutFulfillmentFulfilled } from '../src/stripeCheckout/service.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import {
  markStripeCheckoutReenqueued,
  recordStripeCheckoutReconciliationFailure,
} from '../src/stripeCheckout/sessionStore.ts';

if (false) {
  const transaction = { update: async () => {} };
  const key = commerceKeys.stripeCheckout('drop', 'session');
  // @ts-expect-error Reconciliation timestamps must not accept strings.
  void updateStripeCheckout(transaction, key, { fulfillmentQueueReenqueuedAt: 'today' });
  // @ts-expect-error Reconciliation failures require a string name.
  void updateStripeCheckout(transaction, key, { lastFulfillmentReconciliationError: { name: 1 } });
  // @ts-expect-error Checkout mutations must not accept delivery-order keys.
  void updateStripeCheckout(transaction, commerceKeys.deliveryOrder('drop', '1'), { status: 'fulfilled' });
  // @ts-expect-error Checkout lifecycle fields must be spelled correctly.
  void updateStripeCheckout(transaction, key, { processingAttempId: 'attempt' });
  // @ts-expect-error Checkout state must be a supported status.
  void updateStripeCheckout(transaction, key, { status: 'shipped' });
  // @ts-expect-error Numeric identifiers must not accept strings.
  void updateStripeCheckout(transaction, key, { deliveryId: '123' });
  // @ts-expect-error Increment operations cannot be applied to string fields.
  void updateStripeCheckout(transaction, key, { processingAttemptId: commerceFieldValue.increment(1) });
  // @ts-expect-error Plain JSON cannot impersonate a native delete operation.
  void updateStripeCheckout(transaction, key, { processingAttemptId: { kind: 'delete-field' } });
}

test('checkout reconciliation transitions retain sparse records and unknown fields', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.stripeCheckout('drop', 'session');
  const identity = { dropId: 'drop', sessionId: 'session' };
  const legacy = { nested: [true, null, 'retained'] };
  seedCommerceDocument(harness, { key, data: {
    legacy,
    fulfillmentQueueReenqueuedAt: 'invalid',
    lastFulfillmentReconciliationError: { name: false },
    lastFulfillmentReconciliationErrorAt: 'invalid',
  } });
  const initial = await getStripeCheckout(repository, key);
  assert.equal(initial?.fulfillmentQueueReenqueuedAtMs, undefined);
  assert.equal(initial?.lastFulfillmentReconciliationError, undefined);
  assert.equal(initial?.lastFulfillmentReconciliationErrorAtMs, undefined);
  const nowMs = 1_800_000_000_000;
  const commerce = { repository, nowMs };
  await markStripeCheckoutReenqueued(commerce, identity);
  await recordStripeCheckoutReconciliationFailure({ ...commerce, nowMs: nowMs + 10 }, identity,
    { name: 'RetryError', message: 'retry later' });
  const checkout = await getStripeCheckout(repository, key);
  assert.equal(checkout?.fulfillmentQueueReenqueuedAtMs, nowMs);
  assert.equal(checkout?.lastFulfillmentReconciliationErrorAtMs, nowMs + 10);
  assert.deepEqual(checkout?.lastFulfillmentReconciliationError, { name: 'RetryError', message: 'retry later' });
  assert.deepEqual(checkout?.fields.legacy, legacy);
  assert.equal(checkout?.fields.updatedAt, nowMs + 10);
  assert.equal(checkout?.status, '');
  await assert.rejects(markStripeCheckoutReenqueued(commerce, { ...identity, sessionId: 'missing' }),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'failed-precondition');
});

test('typed checkout reads preserve sparse lifecycle records and normalize malformed optional fields', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.stripeCheckout('drop', 'session');
  assert.equal(await getStripeCheckout(repository, key), null);
  seedCommerceDocument(harness, {
    key,
    data: {
      status: false,
      processingAttemptId: 42,
      processingLeaseExpiresAt: 'invalid',
      processingStartedAt: 1_800_000_000_000,
      historicalField: { retained: true },
    },
  });
  const checkout = await getStripeCheckout(repository, key);
  assert.ok(checkout);
  assert.equal(checkout.status, '');
  assert.equal(checkout.processingAttemptId, '');
  assert.equal(checkout.processingLeaseExpiresAtMs, undefined);
  assert.equal(checkout.processingStartedAtMs, 1_800_000_000_000);
  assert.deepEqual(checkout.fields.historicalField, { retained: true });
  await repository.run(1_800_000_000_100, async (unit) => {
    assert.deepEqual(await getStripeCheckout(unit, key), checkout);
    await updateStripeCheckout(unit, key, { status: 'processing', processingAttemptId: 'current' });
  });
  assert.equal((await getStripeCheckout(repository, key))?.processingAttemptId, 'current');
  assert.deepEqual((await repository.get(key))?.data.historicalField, { retained: true });
});

test('validated checkout reads reuse contract normalization and reject mismatched identity', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.stripeCheckout('drop', 'cs_session');
  const identity = createStripeCheckoutIdentity('anonymous-subject');
  seedCommerceDocument(harness, {
    key,
    data: {
      ...identity,
      dropId: 'drop',
      sessionId: 'cs_session',
      fulfillmentMode: 'admin_variant_receipt',
      currency: 'usd',
      livemode: false,
      quantity: 1,
      unitAmountCents: '100',
      deliveryId: '123',
      status: 'fulfillment_pending',
    },
  });
  const checkout = await getStripeCheckout(repository, key);
  assert.ok(checkout);
  const validated = validateStripeCheckoutForFulfillment(checkout, { dropId: 'drop', sessionId: 'cs_session' });
  assert.deepEqual(validated, {
    ...identity,
    key,
    quantity: 1,
    unitAmountCents: 100,
    deliveryId: 123,
    livemode: false,
    status: 'fulfillment_pending',
  });
  assert.throws(
    () => validateStripeCheckoutForFulfillment(checkout, { dropId: 'other', sessionId: 'cs_session' }),
    (error: unknown) => error instanceof StripeCheckoutFulfillmentError && error.code === 'failed-precondition',
  );
  const stored = await repository.get(key);
  assert.throws(
    () => stripeCheckoutRecord(commerceKeys.stripeCheckout('drop', 'other'), stored),
    /Invalid Stripe checkout document identity/,
  );
});

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
      notificationOutbox: repository.notificationOutbox,
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
  assert.equal(operationTimes.length, 2);
  assert.equal(operationTimes[0], nowMs);
  assert.ok(operationTimes[1] > operationTimes[0]);
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
      notificationOutbox: repository.notificationOutbox,
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
