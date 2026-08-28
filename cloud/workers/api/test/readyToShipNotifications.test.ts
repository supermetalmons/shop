import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.ts';
import {
  READY_NOTIFICATION_BUYER_STATE_FIELD,
  READY_NOTIFICATION_SHIPPER_STATE_FIELD,
  buildReadyNotificationReconciliationQuery,
} from '../../../../shared/readyToShipNotificationReconciliation.ts';
import {
  BUYER_ORDER_RECEIVED_EMAIL_IDEMPOTENCY_KEY_FIELD,
  BUYER_ORDER_RECEIVED_EMAIL_JOB_ID_FIELD,
  BUYER_ORDER_RECEIVED_EMAIL_QUEUED_AT_FIELD,
  BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
  READY_TO_SHIP_NOTIFICATION_PENDING,
  READY_TO_SHIP_NOTIFICATION_QUEUED,
  READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD,
  SHIPPER_READY_TO_SHIP_EMAIL_IDEMPOTENCY_KEY_FIELD,
  SHIPPER_READY_TO_SHIP_EMAIL_JOB_ID_FIELD,
  SHIPPER_READY_TO_SHIP_EMAIL_QUEUED_AT_FIELD,
  SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD,
  createReadyToShipNotificationJobs,
  createReadyToShipNotificationOutbox,
  inspectPendingReadyToShipNotifications,
  pendingReadyToShipNotifications,
  shipperReadyToShipRecipients,
} from '../src/readyToShipNotifications.ts';

const BUYER_JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const SHIPPER_JOB_ID = '123e4567-e89b-42d3-a456-426614174001';
const NOW_MS = 1_700_000_000_000;

function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deliveryId: 7,
    owner: 'owner-wallet',
    status: 'processing',
    addressSnapshot: { email: ' buyer@example.com ' },
    items: [{ kind: 'box', refId: 3 }],
    ...overrides,
  };
}

function createJobIds(): () => string {
  const ids = [BUYER_JOB_ID, SHIPPER_JOB_ID];
  return () => ids.shift() || '';
}

test('ready-to-ship outbox creates exact buyer and shipper jobs', async () => {
  const before = order();
  const after = order({ status: 'ready_to_ship' });
  const outbox = createReadyToShipNotificationOutbox({
    before,
    after,
    deliveryId: 7,
    dropId: 'card_nft_2',
    createJobId: createJobIds(),
    nowMs: NOW_MS,
  });
  assert.deepEqual(outbox.fields, {
    [BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD]: READY_TO_SHIP_NOTIFICATION_PENDING,
    [BUYER_ORDER_RECEIVED_EMAIL_JOB_ID_FIELD]: BUYER_JOB_ID,
    [BUYER_ORDER_RECEIVED_EMAIL_IDEMPOTENCY_KEY_FIELD]: 'card_nft_2:7:order_received',
    [SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD]: READY_TO_SHIP_NOTIFICATION_PENDING,
    [SHIPPER_READY_TO_SHIP_EMAIL_JOB_ID_FIELD]: SHIPPER_JOB_ID,
    [SHIPPER_READY_TO_SHIP_EMAIL_IDEMPOTENCY_KEY_FIELD]: 'card_nft_2:7:ready_to_ship',
    [READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD]: NOW_MS + 6 * 60 * 60_000,
    [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: 0,
  });
  assert.deepEqual(outbox.fieldPaths, [
    BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD,
    BUYER_ORDER_RECEIVED_EMAIL_JOB_ID_FIELD,
    BUYER_ORDER_RECEIVED_EMAIL_IDEMPOTENCY_KEY_FIELD,
    BUYER_ORDER_RECEIVED_EMAIL_QUEUED_AT_FIELD,
    SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD,
    SHIPPER_READY_TO_SHIP_EMAIL_JOB_ID_FIELD,
    SHIPPER_READY_TO_SHIP_EMAIL_IDEMPOTENCY_KEY_FIELD,
    SHIPPER_READY_TO_SHIP_EMAIL_QUEUED_AT_FIELD,
    READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
    READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD,
  ]);
  const readyOrder = { ...after, ...outbox.fields };
  const jobs = await createReadyToShipNotificationJobs({
    order: readyOrder,
    deliveryId: 7,
    dropId: 'card_nft_2',
    pending: pendingReadyToShipNotifications(readyOrder, { deliveryId: 7, dropId: 'card_nft_2' }),
  });
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((job) => ({
    jobId: job.jobId,
    kind: job.kind,
    idempotencyKey: job.idempotencyKey,
    recipients: job.recipients,
    subject: job.subject,
    context: job.context,
  })), [
    {
      jobId: BUYER_JOB_ID,
      kind: 'buyer_order_received',
      idempotencyKey: 'card_nft_2:7:order_received',
      recipients: ['buyer@example.com'],
      subject: 'Order received - Card NFT 2',
      context: { dropId: 'card_nft_2', deliveryId: 7 },
    },
    {
      jobId: SHIPPER_JOB_ID,
      kind: 'shipper_ready_to_ship',
      idempotencyKey: 'card_nft_2:7:ready_to_ship',
      recipients: ['fulfillment@mons.shop'],
      subject: 'New order - Card NFT 2',
      context: { dropId: 'card_nft_2', deliveryId: 7 },
    },
  ]);
  assert.match(jobs[0].text, /We received your order\./);
  assert.match(jobs[1].text, /Open fulfillment: https:\/\/mons\.shop\/fulfillment/);
});

test('ready-to-ship outbox independently plans buyer-only and shipper-only delivery', () => {
  const buyerOnly = createReadyToShipNotificationOutbox({
    before: order(),
    after: order({ status: 'ready_to_ship' }),
    deliveryId: 7,
    dropId: 'clear_cards_devnet_v2',
    createJobId: () => BUYER_JOB_ID,
  });
  assert.deepEqual(buyerOnly.pending.map((entry) => entry.kind), ['buyer_order_received']);

  const shipperOnly = createReadyToShipNotificationOutbox({
    before: order(),
    after: order({ status: 'ready_to_ship', addressSnapshot: {} }),
    deliveryId: 7,
    dropId: 'card_nft_2',
    createJobId: () => SHIPPER_JOB_ID,
  });
  assert.deepEqual(shipperOnly.pending.map((entry) => entry.kind), ['shipper_ready_to_ship']);
  assert.deepEqual(shipperReadyToShipRecipients('card_nft_2'), ['fulfillment@mons.shop']);
  assert.deepEqual(shipperReadyToShipRecipients('clear_cards_devnet_v2'), []);
});

test('ready-to-ship outbox skips ignored sources and invalid recipients', () => {
  const ignored = createReadyToShipNotificationOutbox({
    before: order(),
    after: order({ status: 'ready_to_ship', source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE }),
    deliveryId: 7,
    dropId: 'card_nft_2',
  });
  assert.deepEqual(ignored, { fields: {}, fieldPaths: [], pending: [] });

  const noRecipients = createReadyToShipNotificationOutbox({
    before: order(),
    after: order({ status: 'ready_to_ship', addressSnapshot: { email: 'invalid' } }),
    deliveryId: 7,
    dropId: 'clear_cards_devnet_v2',
  });
  assert.deepEqual(noRecipients, { fields: {}, fieldPaths: [], pending: [] });
});

test('pending markers are reused while queued and legacy markerless orders are skipped', () => {
  const pendingOrder = order({
    status: 'ready_to_ship',
    [BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD]: READY_TO_SHIP_NOTIFICATION_PENDING,
    [BUYER_ORDER_RECEIVED_EMAIL_JOB_ID_FIELD]: BUYER_JOB_ID,
    [BUYER_ORDER_RECEIVED_EMAIL_IDEMPOTENCY_KEY_FIELD]: 'card_nft_2:7:order_received',
  });
  assert.deepEqual(pendingReadyToShipNotifications(pendingOrder).map((entry) => ({
    kind: entry.kind,
    jobId: entry.jobId,
    idempotencyKey: entry.idempotencyKey,
  })), [{
    kind: 'buyer_order_received',
    jobId: BUYER_JOB_ID,
    idempotencyKey: 'card_nft_2:7:order_received',
  }]);
  assert.deepEqual(pendingReadyToShipNotifications(order({
    status: 'ready_to_ship',
    [BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD]: READY_TO_SHIP_NOTIFICATION_QUEUED,
    [BUYER_ORDER_RECEIVED_EMAIL_JOB_ID_FIELD]: BUYER_JOB_ID,
  })), []);
  assert.deepEqual(pendingReadyToShipNotifications(order({ status: 'ready_to_ship' })), []);
});

test('semantic marker inspection rejects only the sibling with another valid order key', () => {
  const inspection = inspectPendingReadyToShipNotifications(order({
    status: 'ready_to_ship',
    [BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD]: READY_TO_SHIP_NOTIFICATION_PENDING,
    [BUYER_ORDER_RECEIVED_EMAIL_JOB_ID_FIELD]: BUYER_JOB_ID,
    [BUYER_ORDER_RECEIVED_EMAIL_IDEMPOTENCY_KEY_FIELD]: 'card_nft_2:6:order_received',
    [SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD]: READY_TO_SHIP_NOTIFICATION_PENDING,
    [SHIPPER_READY_TO_SHIP_EMAIL_JOB_ID_FIELD]: SHIPPER_JOB_ID,
    [SHIPPER_READY_TO_SHIP_EMAIL_IDEMPOTENCY_KEY_FIELD]: 'card_nft_2:7:ready_to_ship',
  }), { deliveryId: 7, dropId: 'card_nft_2' });
  assert.deepEqual(inspection.invalidStateFields, [BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD]);
  assert.deepEqual(inspection.pending.map((marker) => marker.kind), ['shipper_ready_to_ship']);
});

test('shared reconciliation query uses the full Commerce cursor reference', () => {
  const referenceValue = 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/7';
  const query = buildReadyNotificationReconciliationQuery({
    limit: 100,
    startAfterDocumentPath: referenceValue,
  }) as Record<string, any>;
  assert.deepEqual(query.structuredQuery.startAt, {
    before: false,
    values: [{ referenceValue }],
  });
  assert.equal(query.structuredQuery.limit, 32);
  assert.deepEqual(
    query.structuredQuery.where.compositeFilter.filters[1].compositeFilter.filters.map(
      (entry: Record<string, any>) => entry.fieldFilter.field.fieldPath,
    ),
    [READY_NOTIFICATION_BUYER_STATE_FIELD, READY_NOTIFICATION_SHIPPER_STATE_FIELD],
  );
});
