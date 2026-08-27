import assert from 'node:assert/strict';
import test from 'node:test';
import { CommerceWriteConflict, commerceKeys } from '../src/commerceRepository.ts';
import {
  createStripeCheckoutStore,
  stripeCheckoutFieldValue,
} from '../src/stripeCheckout/store.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

test('Stripe checkout D1 store applies fields, deletes, increments, and timestamps', async () => {
  const nowMs = 1_800_000_000_000;
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, {
    key: commerceKeys.stripeCheckout('drop', 'session'),
    data: {
      removed: 'old',
      processingAttemptCount: 2,
      status: 'pending',
    },
  });
  const store = createStripeCheckoutStore({
    commerceDb: harness.db,
    nowMs: () => nowMs,
  });
  const reference = store.doc('drops/drop/stripeCheckouts/session');
  await reference.update({
    status: 'processing',
    updatedAt: stripeCheckoutFieldValue.serverTimestamp(),
    removed: stripeCheckoutFieldValue.delete(),
    processingAttemptCount: stripeCheckoutFieldValue.increment(1),
    processingLeaseExpiresAt: stripeCheckoutFieldValue.timestampFromMillis(nowMs + 1_000),
  });
  assert.deepEqual(reference.path, 'drops/drop/stripeCheckouts/session');
  assert.deepEqual((await reference.get()).data(), {
    processingAttemptCount: 3,
    processingLeaseExpiresAt: nowMs + 1_000,
    status: 'processing',
    updatedAt: nowMs,
  });
  const serverTimestamp = stripeCheckoutFieldValue.serverTimestamp();
  const deleteField = stripeCheckoutFieldValue.delete();
  const increment = stripeCheckoutFieldValue.increment(1);
  const timestamp = stripeCheckoutFieldValue.timestampFromMillis(nowMs);
  assert.equal(serverTimestamp.kind, 'server_timestamp');
  assert.equal(deleteField.kind, 'delete_field');
  assert.equal(increment.kind, 'increment');
  assert.equal(increment.operand, 1);
  assert.equal(timestamp.kind, 'timestamp');
  assert.equal(timestamp.toMillis(), nowMs);
  assert.equal(Object.isFrozen(serverTimestamp), true);
  assert.equal(Object.isFrozen(deleteField), true);
  assert.equal(Object.isFrozen(increment), true);
  assert.equal(Object.isFrozen(timestamp), true);
});

test('Stripe checkout store preserves plain JSON with mutation-like kind fields', async () => {
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, {
    key: commerceKeys.stripeCheckout('drop', 'plain-json'),
    data: { dropId: 'drop', sessionId: 'plain-json' },
  });
  const reference = createStripeCheckoutStore({ commerceDb: harness.db })
    .doc('drops/drop/stripeCheckouts/plain-json');
  const collisions = {
    deleteField: { kind: 'delete_field' },
    increment: { kind: 'increment', operand: 3 },
    serverTimestamp: { kind: 'server_timestamp' },
    timestamp: { kind: 'timestamp', milliseconds: 123 },
  };

  await reference.update(collisions);

  assert.deepEqual((await reference.get()).data(), {
    dropId: 'drop',
    sessionId: 'plain-json',
    ...collisions,
  });
});

test('Stripe checkout D1 store distinguishes missing documents and rejects invalid paths', async () => {
  const harness = createCommerceD1Harness();
  const store = createStripeCheckoutStore({ commerceDb: harness.db });
  const snapshot = await store.doc('drops/drop/stripeCheckouts/missing').get();
  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.data(), undefined);
  assert.throws(() => store.doc('drops/drop/unsupported/session'), /Invalid Stripe checkout document path/);
});

test('Stripe checkout D1 transactions retry aborted commits with fresh reads', async () => {
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, {
    key: commerceKeys.stripeCheckout('drop', 'session'),
    data: { status: 'fulfillment_pending' },
    updateTime: '2026-08-23T00:00:00.000Z',
  });
  const store = createStripeCheckoutStore({ commerceDb: harness.db });
  const competingStore = createStripeCheckoutStore({ commerceDb: harness.db });
  const reference = store.doc('drops/drop/stripeCheckouts/session');
  let attempts = 0;
  const result = await store.runTransaction(async (transaction) => {
    assert.equal((await transaction.get(reference)).get('status'), 'fulfillment_pending');
    attempts += 1;
    if (attempts === 1) {
      await competingStore.doc(reference.path).update({ status: 'fulfillment_pending' });
    }
    transaction.update(reference, { status: 'processing' });
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.equal(attempts, 2);
  assert.equal((await reference.get()).get('status'), 'processing');
});

test('Stripe checkout D1 transactions surface create collisions without retrying', async () => {
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder('drop', '1'),
    data: { deliveryId: 1 },
  });
  const store = createStripeCheckoutStore({ commerceDb: harness.db });
  let attempts = 0;
  await assert.rejects(
    store.runTransaction(async (transaction) => {
      attempts += 1;
      transaction.create(store.doc('drops/drop/deliveryOrders/1'), { deliveryId: 1 });
    }),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'already-exists',
  );
  assert.equal(attempts, 1);
});
