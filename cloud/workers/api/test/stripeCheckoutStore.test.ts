import assert from 'node:assert/strict';
import test from 'node:test';
import { CommerceWriteConflict } from '../src/commerceRepository.ts';
import {
  StripeCheckoutDeleteField,
  StripeCheckoutIncrement,
  StripeCheckoutServerTimestamp,
  createStripeCheckoutStore,
  stripeCheckoutFieldValue,
} from '../src/stripeCheckout/store.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

test('Stripe checkout D1 store applies fields, deletes, increments, and timestamps', async () => {
  const nowMs = 1_800_000_000_000;
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, {
    name: 'projects/mons-shop/databases/(default)/documents/drops/drop/stripeCheckouts/session',
    fields: {
      removed: { stringValue: 'old' },
      processingAttemptCount: { integerValue: '2' },
      status: { stringValue: 'pending' },
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
  assert.equal(stripeCheckoutFieldValue.serverTimestamp() instanceof StripeCheckoutServerTimestamp, true);
  assert.equal(stripeCheckoutFieldValue.delete() instanceof StripeCheckoutDeleteField, true);
  assert.equal(stripeCheckoutFieldValue.increment(1) instanceof StripeCheckoutIncrement, true);
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
    name: 'projects/mons-shop/databases/(default)/documents/drops/drop/stripeCheckouts/session',
    updateTime: '2026-08-23T00:00:00.000Z',
    fields: { status: { stringValue: 'fulfillment_pending' } },
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
    name: 'projects/mons-shop/databases/(default)/documents/drops/drop/deliveryOrders/1',
    fields: { deliveryId: { integerValue: '1' } },
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
