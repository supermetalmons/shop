import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.ts';
import { createReadyToShipNotificationIntent, createReadyToShipNotificationJobs,
  readyToShipNotificationMarker, planReadyToShipNotifications } from '../src/readyToShipNotifications.ts';

const BUYER_JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const SHIPPER_JOB_ID = '123e4567-e89b-42d3-a456-426614174001';
const readyOrder = { deliveryId: 7, owner: 'owner-wallet', status: 'ready_to_ship',
  addressSnapshot: { email: ' buyer@example.com ' }, items: [{ kind: 'box', refId: 3 }] };
const options = { before: { status: 'processing' }, after: readyOrder, deliveryId: 7, dropId: 'card_nft_2' };

test('ready notification intent creates stable buyer and shipper identities without document writes', async () => {
  const ids = [BUYER_JOB_ID, SHIPPER_JOB_ID];
  const intent = createReadyToShipNotificationIntent({ ...options, parentPath: 'drops/card_nft_2/deliveryOrders/7',
    nowMs: 1_700_000_000_000, createJobId: () => ids.shift()! });
  assert.ok(intent);
  assert.equal(intent.family, 'ready');
  assert.equal(intent.retryUntilMs, 1_700_000_000_000 + 6 * 60 * 60_000);
  assert.deepEqual(intent.entries, [
    { kind: 'buyer_order_received', jobId: BUYER_JOB_ID, idempotencyKey: 'card_nft_2:7:order_received', state: 'pending' },
    { kind: 'shipper_ready_to_ship', jobId: SHIPPER_JOB_ID, idempotencyKey: 'card_nft_2:7:ready_to_ship', state: 'pending' },
  ]);
  const jobs = await createReadyToShipNotificationJobs({ order: readyOrder, deliveryId: 7, dropId: 'card_nft_2',
    pending: intent.entries.map(readyToShipNotificationMarker) });
  assert.deepEqual(jobs.map(({ jobId, kind, idempotencyKey, recipients, subject, context }) =>
    ({ jobId, kind, idempotencyKey, recipients, subject, context })), [
    { jobId: BUYER_JOB_ID, kind: 'buyer_order_received', idempotencyKey: 'card_nft_2:7:order_received',
      recipients: ['buyer@example.com'], subject: 'Order received - Card NFT 2', context: { dropId: 'card_nft_2', deliveryId: 7 } },
    { jobId: SHIPPER_JOB_ID, kind: 'shipper_ready_to_ship', idempotencyKey: 'card_nft_2:7:ready_to_ship',
      recipients: ['fulfillment@mons.shop'], subject: 'New order - Card NFT 2', context: { dropId: 'card_nft_2', deliveryId: 7 } },
  ]);
  assert.match(jobs[0].text, /We received your order\./);
  assert.match(jobs[1].text, /Open fulfillment: https:\/\/mons\.shop\/fulfillment\?dropId=card_nft_2/);
});

test('ready notification planning keeps optional recipients and ignored sources', () => {
  assert.deepEqual(planReadyToShipNotifications({ ...options, dropId: 'clear_cards_devnet_v2' }).map((entry) => entry.kind),
    ['buyer_order_received']);
  assert.deepEqual(planReadyToShipNotifications({ ...options, after: { ...readyOrder, addressSnapshot: {} } }).map((entry) => entry.kind),
    ['shipper_ready_to_ship']);
  assert.deepEqual(planReadyToShipNotifications({ ...options, after: { ...readyOrder, source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } }), []);
  assert.equal(createReadyToShipNotificationIntent({ ...options, parentPath: 'drops/clear_cards_devnet_v2/deliveryOrders/7',
    dropId: 'clear_cards_devnet_v2', after: { ...readyOrder, addressSnapshot: {} } }), null);
  assert.deepEqual(planReadyToShipNotifications({ ...options, before: readyOrder }), []);
});
