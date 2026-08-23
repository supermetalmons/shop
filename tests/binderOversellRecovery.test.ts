import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_NFT_BINDER_OVERSELL_ADMIN,
  CARD_NFT_BINDER_OVERSELL_DROP_ID,
  CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS,
  CARD_NFT_BINDER_OVERSELL_SESSION_IDS,
  buildCardNftBinderOversellFirestoreCommit,
  publishCardNftBinderOversellTerminalNotifications,
  shouldPublishCardNftBinderOversellRecoveryNotifications,
} from '../scripts/shared/binderOversellRecovery.ts';
import { decodeFirestoreRestDocument } from '../scripts/shared/firebaseCliFirestoreRest.ts';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../functions/src/shared/fulfillmentSources.ts';
import type { NotificationEmailJobV1 } from '../functions/src/shared/notificationEmailJob.ts';

const EXPECTED_SESSIONS = [
  'cs_live_a1ZanWVK9yZbZslwrR7NcxjU4ufFlJGNpgC7QFuXVC8Ff4ZPBpO61ssKU0',
  'cs_live_a16siqxPeMuQoyNYyNMZvHMbfzGuuQBER06a6AMnl03CwBDKriRRzE7Iv0',
  'cs_live_a1N1U7jzdmAkw7Ao78BH2Ru35yIvxLVhT7Wks2xl8m0jEfCfgUKLSTuIG7',
  'cs_live_a1DmeTWkPpgbJKs1uILK0Rpw8Hm7DSkBfktjHgN3StjlgARS3O4g86RUyQ',
  'cs_live_a1X9UrjIGjr4lSljeTfgB8LQKd9gZnT5eVFhyaKJKDE8xqHunANHIJpGlc',
];

function decodedWrite(write: {
  update: {
    name: string;
    fields: Record<string, Record<string, unknown>>;
  };
}) {
  return decodeFirestoreRestDocument(write.update);
}

test('binder oversell recovery is hard-coded to the five chronological sessions', () => {
  assert.deepEqual(
    CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS.map((item) => item.sessionId),
    EXPECTED_SESSIONS,
  );
  assert.deepEqual(
    CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS.map((item) => item.metadataId),
    [16, 17, 18, 19, 20],
  );
  assert.deepEqual(
    CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS.map((item) => item.uri),
    [16, 17, 18, 19, 20].map(
      (id) =>
        `https://cdn.lil.org/nft/card_nft_binder/json/rb${id}.json`,
    ),
  );
  assert.deepEqual([...CARD_NFT_BINDER_OVERSELL_SESSION_IDS], EXPECTED_SESSIONS);
  assert.equal(
    CARD_NFT_BINDER_OVERSELL_SESSION_IDS.has('cs_live_unrelated'),
    false,
  );
});

test('binder recovery commit atomically creates normal order records and fulfills checkout', () => {
  const item = CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS[0];
  const commit = buildCardNftBinderOversellFirestoreCommit({
    checkoutUpdateTime: '2026-07-29T09:10:11.123456Z',
    item,
    receiptTx: 'receipt-signature',
    deliveryId: 123456,
    claimCode: 'ABCDEF-0123456789',
    owner: 'firebase:user-1',
    firebaseUid: 'user-1',
    receiptOwner: CARD_NFT_BINDER_OVERSELL_ADMIN,
    orderHashHex: '11'.repeat(32),
    stripeSession: {
      id: item.sessionId,
      payment_intent: 'pi_123',
      customer: 'cus_123',
    },
    addressSnapshot: {
      country: 'Türkiye',
      countryCode: 'TR',
      encrypted: 'nonce.ephemeral.ciphertext',
      hint: 'A...34',
    },
  });

  assert.equal(commit.writes.length, 4);
  assert.deepEqual(
    commit.writes.slice(0, 3).map((write) => write.currentDocument),
    [{ exists: false }, { exists: false }, { exists: false }],
  );
  assert.deepEqual(commit.writes[3].currentDocument, {
    updateTime: '2026-07-29T09:10:11.123456Z',
  });
  assert.equal(commit.deliveryPath.endsWith('/deliveryOrders/123456'), true);
  assert.equal(
    commit.markerPath.endsWith(`/offchainOrders/${'11'.repeat(32)}`),
    true,
  );
  assert.equal(commit.claimPath, 'claimCodes/ABCDEF-0123456789');
  assert.equal(
    commit.checkoutPath,
    `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/stripeCheckouts/${item.sessionId}`,
  );

  const delivery = decodedWrite(commit.writes[0]);
  const marker = decodedWrite(commit.writes[1]);
  const claim = decodedWrite(commit.writes[2]);
  const checkout = decodedWrite(commit.writes[3]);
  assert.deepEqual(delivery?.data.metadataIds, [16]);
  assert.equal(delivery?.data.metadataId, 16);
  assert.equal(delivery?.data.receiptTxs?.[0], 'receipt-signature');
  assert.equal(marker?.data.receiptTx, 'receipt-signature');
  assert.equal(claim?.data.status, 'unclaimed');
  assert.equal(claim?.data.boxId, 16);
  assert.equal(checkout?.data.status, 'fulfilled');
  assert.equal(checkout?.data.deliveryId, 123456);
  assert.equal(checkout?.data.receiptTx, 'receipt-signature');
  assert.deepEqual(
    commit.writes[3].updateTransforms?.map((value) => value.fieldPath),
    ['fulfilledAt', 'updatedAt'],
  );
  for (const deletedField of [
    'lastFulfillmentError',
    'manualRefundReviewRequired',
    'manualRefundReviewReason',
    'failedAt',
    'processingAttemptId',
    'processingLeaseExpiresAt',
  ]) {
    assert.equal(
      commit.writes[3].updateMask?.fieldPaths.includes(deletedField),
      true,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        commit.writes[3].update.fields,
        deletedField,
      ),
      false,
    );
  }
});

test('binder recovery commit refuses malformed claim codes', () => {
  assert.throws(
    () =>
      buildCardNftBinderOversellFirestoreCommit({
        checkoutUpdateTime: '2026-07-29T09:10:11.123456Z',
        item: CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS[0],
        receiptTx: 'receipt-signature',
        deliveryId: 123456,
        claimCode: 'not-a-claim',
        owner: 'firebase:user-1',
        firebaseUid: 'user-1',
        receiptOwner: CARD_NFT_BINDER_OVERSELL_ADMIN,
        orderHashHex: '11'.repeat(32),
        stripeSession: {
          id: CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS[0].sessionId,
        },
        addressSnapshot: {},
      }),
    /Invalid Stripe receipt claim code/,
  );
});

test('binder recovery resumes only explicitly pending notification publication', () => {
  assert.equal(
    shouldPublishCardNftBinderOversellRecoveryNotifications(false),
    true,
  );
  assert.equal(
    shouldPublishCardNftBinderOversellRecoveryNotifications(true),
    false,
  );
  assert.equal(
    shouldPublishCardNftBinderOversellRecoveryNotifications(undefined),
    false,
  );
});

test('binder recovery publishes buyer and shipper notifications with retry-safe idempotency', async () => {
  const item = CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS[0];
  const deliveryId = 123456;
  const jobIds = [
    '123e4567-e89b-42d3-a456-426614174020',
    '123e4567-e89b-42d3-a456-426614174021',
    '123e4567-e89b-42d3-a456-426614174022',
    '123e4567-e89b-42d3-a456-426614174023',
  ];
  const queued: NotificationEmailJobV1[] = [];
  let failShipperOnce = true;
  const dependencies = {
    loadCheckout: async () => ({
      path: `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/stripeCheckouts/${item.sessionId}`,
      data: {
        status: 'fulfilled',
        deliveryId,
      },
    }),
    loadDeliveryOrder: async () => ({
      source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
      status: 'ready_to_ship',
      deliveryId,
      owner: 'firebase:user-1',
      addressSnapshot: { email: 'buyer@example.com' },
      items: [{ kind: 'box', refId: item.metadataId }],
    }),
    enqueueJob: async (job: NotificationEmailJobV1) => {
      if (job.kind === 'shipper_ready_to_ship' && failShipperOnce) {
        failShipperOnce = false;
        throw new Error('temporary enqueue failure');
      }
      queued.push(job);
    },
    createJobId: () => jobIds.shift() || '',
  };

  await assert.rejects(
    publishCardNftBinderOversellTerminalNotifications({
      item,
      dependencies,
    }),
    /temporary enqueue failure/,
  );
  const result = await publishCardNftBinderOversellTerminalNotifications({
    item,
    dependencies,
  });

  assert.deepEqual(result, { outcome: 'fulfilled', queuedJobs: 2 });
  assert.deepEqual(
    queued.map((job) => ({
      kind: job.kind,
      idempotencyKey: job.idempotencyKey,
      recipients: job.recipients,
    })),
    [
      {
        kind: 'buyer_order_received',
        idempotencyKey: `${CARD_NFT_BINDER_OVERSELL_DROP_ID}:${deliveryId}:order_received`,
        recipients: ['buyer@example.com'],
      },
      {
        kind: 'buyer_order_received',
        idempotencyKey: `${CARD_NFT_BINDER_OVERSELL_DROP_ID}:${deliveryId}:order_received`,
        recipients: ['buyer@example.com'],
      },
      {
        kind: 'shipper_ready_to_ship',
        idempotencyKey: `${CARD_NFT_BINDER_OVERSELL_DROP_ID}:${deliveryId}:ready_to_ship`,
        recipients: ['supermetalxbosch@gmail.com'],
      },
    ],
  );
});
