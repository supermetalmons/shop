import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StripeCheckoutDeleteField,
  StripeCheckoutIncrement,
  StripeCheckoutServerTimestamp,
  stripeCheckoutFieldValue,
} from '../../../../functions/src/stripeCheckout/store.ts';
import { FirestoreWriteConflict, ProfileReadError } from '../src/firestoreRest.ts';
import {
  createWorkerStripeCheckoutStore,
  stripeCheckoutFirestoreTestHooks,
} from '../src/stripeCheckoutFirestore.ts';

function accessTokenProvider() {
  return {
    invalidate: () => undefined,
    get: async () => 'firestore-access-token',
  };
}

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
  let beginCount = 0;
  let readCount = 0;
  let commitCount = 0;
  const commits: Record<string, unknown>[] = [];
  const store = createWorkerStripeCheckoutStore({
    accessTokenProvider: accessTokenProvider(),
    serviceAccountJson: 'writer-service-account',
    signal: new AbortController().signal,
    providerFetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/documents:beginTransaction')) {
        beginCount += 1;
        return Response.json({ transaction: `transaction-${beginCount}` });
      }
      if (url.includes('/documents/drops/drop/stripeCheckouts/session')) {
        readCount += 1;
        return Response.json({
          name: 'projects/mons-shop/databases/(default)/documents/drops/drop/stripeCheckouts/session',
          updateTime: '2026-08-23T00:00:00.000000Z',
          fields: { status: { stringValue: 'fulfillment_pending' } },
        });
      }
      if (url.endsWith('/documents:commit')) {
        commitCount += 1;
        commits.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (commitCount === 1) {
          return Response.json({ error: { status: 'ABORTED', message: 'retry' } }, { status: 409 });
        }
        return Response.json({ writeResults: [{}] });
      }
      throw new Error(`Unexpected request: ${init?.method} ${url}`);
    },
  });
  const reference = store.doc('drops/drop/stripeCheckouts/session');
  const result = await store.runTransaction(async (transaction) => {
    assert.equal((await transaction.get(reference)).get('status'), 'fulfillment_pending');
    transaction.update(reference, { status: 'processing' });
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.equal(beginCount, 2);
  assert.equal(readCount, 2);
  assert.equal(commitCount, 2);
  assert.equal(commits[1].transaction, 'transaction-2');
});

test('Stripe checkout Firestore transactions surface create collisions without retrying', async () => {
  let beginCount = 0;
  const store = createWorkerStripeCheckoutStore({
    accessTokenProvider: accessTokenProvider(),
    serviceAccountJson: 'writer-service-account',
    signal: new AbortController().signal,
    providerFetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/documents:beginTransaction')) {
        beginCount += 1;
        return Response.json({ transaction: 'transaction-create' });
      }
      if (url.endsWith('/documents:commit')) {
        return Response.json({ error: { status: 'ALREADY_EXISTS', message: 'collision' } }, { status: 409 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  await assert.rejects(
    store.runTransaction(async (transaction) => {
      transaction.create(store.doc('drops/drop/deliveryOrders/1'), { deliveryId: 1 });
    }),
    (error: unknown) => error instanceof FirestoreWriteConflict && error.status === 'ALREADY_EXISTS',
  );
  assert.equal(beginCount, 1);
});
