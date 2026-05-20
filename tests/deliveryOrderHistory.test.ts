import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRIPE_OWNER_MERGE_BATCH_SIZE,
  mergeFirebaseStripeDeliveryOrdersToWalletInDb,
} from '../functions/src/deliveryOrderHistory.ts';
import { stripeCheckoutOwnerId } from '../functions/src/stripeCheckout/contract.ts';

type FakeDeliveryDoc = {
  ref: { path: string; doc: FakeDeliveryDoc };
  data: Record<string, unknown>;
};

function fakeDeliveryDoc(path: string, data: Record<string, unknown>): FakeDeliveryDoc {
  const doc = { ref: null as unknown as FakeDeliveryDoc['ref'], data };
  doc.ref = { path, doc };
  return doc;
}

function fakeDb(docs: FakeDeliveryDoc[]) {
  let ownerFilter = '';
  let limitCount = STRIPE_OWNER_MERGE_BATCH_SIZE;
  let commits = 0;

  return {
    get commits() {
      return commits;
    },
    batch() {
      const updates: Array<{ ref: FakeDeliveryDoc['ref']; data: Record<string, unknown> }> = [];
      return {
        update(ref: FakeDeliveryDoc['ref'], data: Record<string, unknown>) {
          updates.push({ ref, data });
        },
        async commit() {
          commits += 1;
          updates.forEach(({ ref, data }) => {
            Object.assign(ref.doc.data, data);
          });
        },
      };
    },
    collectionGroup(collectionId: string) {
      assert.equal(collectionId, 'deliveryOrders');
      return {
        where(field: string, op: string, value: string) {
          assert.equal(field, 'owner');
          assert.equal(op, '==');
          ownerFilter = value;
          return this;
        },
        limit(value: number) {
          limitCount = value;
          return this;
        },
        select() {
          return this;
        },
        async get() {
          const matched = docs.filter((doc) => doc.data.owner === ownerFilter).slice(0, limitCount);
          return {
            empty: matched.length === 0,
            docs: matched,
          };
        },
      };
    },
  };
}

test('mergeFirebaseStripeDeliveryOrdersToWalletInDb reassigns firebase-owned Stripe orders in batches', async () => {
  const uid = 'anon_uid_123';
  const wallet = '11111111111111111111111111111112';
  const firebaseOwner = stripeCheckoutOwnerId(uid);
  const docs = Array.from({ length: STRIPE_OWNER_MERGE_BATCH_SIZE + 2 }, (_, index) =>
    fakeDeliveryDoc(`drops/drop/deliveryOrders/${index + 1}`, {
      owner: firebaseOwner,
      firebaseUid: uid,
      stripeCheckoutSessionId: `cs_test_${index + 1}`,
      source: 'stripe_offchain',
    }),
  );
  docs.push(
    fakeDeliveryDoc('drops/drop/deliveryOrders/wallet-owned', {
      owner: wallet,
      firebaseUid: uid,
      stripeCheckoutSessionId: 'cs_test_wallet',
      source: 'stripe_offchain',
    }),
  );

  const db = fakeDb(docs);
  const merged = await mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, wallet);

  assert.equal(merged, STRIPE_OWNER_MERGE_BATCH_SIZE + 2);
  assert.equal(db.commits, 2);
  for (const doc of docs.slice(0, STRIPE_OWNER_MERGE_BATCH_SIZE + 2)) {
    assert.equal(doc.data.owner, wallet);
    assert.equal(doc.data.firebaseUid, uid);
    assert.equal(doc.data.source, 'stripe_offchain');
    assert.equal(doc.data.mergedFirebaseUid, uid);
    assert.equal(doc.data.previousOwner, firebaseOwner);
    assert.ok(doc.data.ownerMergedAt);
  }
  assert.equal(docs.at(-1)?.data.owner, wallet);
  assert.equal(docs.at(-1)?.data.stripeCheckoutSessionId, 'cs_test_wallet');
  assert.equal(docs.at(-1)?.data.mergedFirebaseUid, undefined);
  assert.equal(docs.at(-1)?.data.previousOwner, undefined);
  assert.equal(docs.at(-1)?.data.ownerMergedAt, undefined);
});
