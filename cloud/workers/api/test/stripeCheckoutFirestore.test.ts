import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import {
  StripeCheckoutDeleteField,
  StripeCheckoutIncrement,
  StripeCheckoutServerTimestamp,
  stripeCheckoutFieldValue,
} from '../src/stripeCheckout/store.ts';
import { FirestoreWriteConflict, ProfileReadError } from '../src/firestoreRest.ts';
import {
  createWorkerStripeCheckoutStore,
  stripeCheckoutFirestoreTestHooks,
} from '../src/stripeCheckoutFirestore.ts';

test('Stripe checkout Firestore writes encode fields, deletes, increments, and timestamps', () => {
  const write = stripeCheckoutFirestoreTestHooks.encodedDocumentWrite(
    'drops/drop/stripeCheckouts/session',
    {
      status: 'processing',
      updatedAt: stripeCheckoutFieldValue.serverTimestamp(),
      removed: stripeCheckoutFieldValue.delete(),
      processingAttemptCount: stripeCheckoutFieldValue.increment(1),
      processingLeaseExpiresAt: stripeCheckoutFieldValue.timestampFromMillis(1_700_000_000_000),
    },
    'update',
  );
  const update = write.update as { fields: Record<string, unknown> };
  assert.deepEqual(update.fields.status, { stringValue: 'processing' });
  assert.deepEqual(update.fields.processingLeaseExpiresAt, { timestampValue: '2023-11-14T22:13:20.000Z' });
  assert.deepEqual((write.updateMask as { fieldPaths: string[] }).fieldPaths, [
    'status',
    'removed',
    'processingLeaseExpiresAt',
  ]);
  assert.deepEqual(write.updateTransforms, [
    { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    { fieldPath: 'processingAttemptCount', increment: { integerValue: '1' } },
  ]);
  assert.equal(stripeCheckoutFieldValue.serverTimestamp() instanceof StripeCheckoutServerTimestamp, true);
  assert.equal(stripeCheckoutFieldValue.delete() instanceof StripeCheckoutDeleteField, true);
  assert.equal(stripeCheckoutFieldValue.increment(1) instanceof StripeCheckoutIncrement, true);
});

test('Stripe checkout Firestore distinguishes missing documents from decode failures', () => {
  assert.equal(stripeCheckoutFirestoreTestHooks.parseDocument(null), null);
  assert.deepEqual(
    stripeCheckoutFirestoreTestHooks.parseDocument({ updateTime: '2026-08-23T00:00:00.000000Z' }),
    { fields: {}, updateTime: '2026-08-23T00:00:00.000000Z' },
  );
  assert.deepEqual(
    stripeCheckoutFirestoreTestHooks.parseDocument({
      updateTime: '2026-08-23T00:00:00.000000Z',
      fields: {
        attachment: { bytesValue: 'AQID' },
        location: { geoPointValue: { latitude: 41, longitude: 29 } },
        reference: { referenceValue: 'projects/mons-shop/databases/(default)/documents/example/1' },
      },
    }),
    {
      fields: {
        attachment: 'AQID',
        location: { latitude: 41, longitude: 29 },
        reference: 'projects/mons-shop/databases/(default)/documents/example/1',
      },
      updateTime: '2026-08-23T00:00:00.000000Z',
    },
  );
  assert.throws(
    () => stripeCheckoutFirestoreTestHooks.parseDocument({
      updateTime: '2026-08-23T00:00:00.000000Z',
      fields: { attachment: { bytesValue: 123 } },
    }),
    (error: unknown) => error instanceof ProfileReadError && error.code === 'unavailable',
  );
  for (const doubleValue of ['NaN', 'Infinity', '-Infinity']) {
    assert.throws(
      () => stripeCheckoutFirestoreTestHooks.parseDocument({
        updateTime: '2026-08-23T00:00:00.000000Z',
        fields: { claimedAt: { doubleValue } },
      }),
      (error: unknown) => error instanceof ProfileReadError && error.code === 'unavailable',
    );
  }
});

test('Stripe checkout Firestore transactions retry ABORTED commits with fresh reads', async () => {
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, {
    name: 'projects/mons-shop/databases/(default)/documents/drops/drop/stripeCheckouts/session',
    updateTime: '2026-08-23T00:00:00.000Z',
    fields: { status: { stringValue: 'fulfillment_pending' } },
  });
  const store = createWorkerStripeCheckoutStore({
    commerceDb: harness.db,
    signal: new AbortController().signal,
  });
  const competingStore = createWorkerStripeCheckoutStore({
    commerceDb: harness.db,
    signal: new AbortController().signal,
  });
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

test('Stripe checkout Firestore transactions surface create collisions without retrying', async () => {
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, {
    name: 'projects/mons-shop/databases/(default)/documents/drops/drop/deliveryOrders/1',
    fields: { deliveryId: { integerValue: '1' } },
  });
  const store = createWorkerStripeCheckoutStore({
    commerceDb: harness.db,
    signal: new AbortController().signal,
  });
  let attempts = 0;
  await assert.rejects(
    store.runTransaction(async (transaction) => {
      attempts += 1;
      transaction.create(store.doc('drops/drop/deliveryOrders/1'), { deliveryId: 1 });
    }),
    (error: unknown) => error instanceof FirestoreWriteConflict && error.status === 'ALREADY_EXISTS',
  );
  assert.equal(attempts, 1);
});
