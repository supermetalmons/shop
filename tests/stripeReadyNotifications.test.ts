import assert from 'node:assert/strict';
import test from 'node:test';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../shared/fulfillmentSources.ts';
import { createStripeReadyToShipNotificationJobs } from '../cloud/workers/api/src/stripeReadyNotifications.ts';

const JOB_IDS = [
  '123e4567-e89b-42d3-a456-426614174000',
  '123e4567-e89b-42d3-a456-426614174001',
];

test('Stripe ready orders create the exact buyer and shipper jobs', async () => {
  const ids = [...JOB_IDS];
  const jobs = await createStripeReadyToShipNotificationJobs({
    order: {
      source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
      status: 'ready_to_ship',
      deliveryId: 7,
      owner: 'auth-owner',
      addressSnapshot: { email: ' buyer@example.com ' },
      items: [{ kind: 'box', refId: 3 }],
    },
    dropId: 'card_nft_2',
    deliveryId: 7,
    createJobId: () => ids.shift() || '',
  });
  assert.deepEqual(jobs.map((job) => ({
    jobId: job.jobId,
    kind: job.kind,
    idempotencyKey: job.idempotencyKey,
    recipients: job.recipients,
  })), [
    {
      jobId: JOB_IDS[0],
      kind: 'buyer_order_received',
      idempotencyKey: 'card_nft_2:7:order_received',
      recipients: ['buyer@example.com'],
    },
    {
      jobId: JOB_IDS[1],
      kind: 'shipper_ready_to_ship',
      idempotencyKey: 'card_nft_2:7:ready_to_ship',
      recipients: ['supermetalxbosch@gmail.com'],
    },
  ]);
});

test('non-Stripe and non-ready orders do not create compatibility jobs', async () => {
  for (const order of [
    { source: 'normal', status: 'ready_to_ship' },
    { source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE, status: 'processing' },
  ]) {
    assert.deepEqual(await createStripeReadyToShipNotificationJobs({
      order,
      dropId: 'card_nft_2',
      deliveryId: 7,
    }), []);
  }
});
