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
      recipients: ['fulfillment@mons.shop'],
    },
  ]);
  assert.match(
    jobs[1].text,
    /Open fulfillment: https:\/\/mons\.shop\/fulfillment\?dropId=card_nft_2/,
  );
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

test('Stripe ready orders reuse persisted job IDs by kind across retries', async () => {
  const args = {
    order: {
      source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
      status: 'ready_to_ship',
      deliveryId: 7,
      addressSnapshot: { email: 'buyer@example.com' },
    },
    dropId: 'card_nft_2',
    deliveryId: 7,
    jobIds: {
      buyer_order_received: JOB_IDS[0],
      shipper_ready_to_ship: JOB_IDS[1],
    },
  };
  const first = await createStripeReadyToShipNotificationJobs(args);
  const second = await createStripeReadyToShipNotificationJobs(args);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(({ jobId }) => jobId), JOB_IDS);
  const shipperOnly = await createStripeReadyToShipNotificationJobs({
    ...args,
    order: { ...args.order, addressSnapshot: {} },
  });
  assert.equal(shipperOnly.length, 1);
  assert.equal(shipperOnly[0].kind, 'shipper_ready_to_ship');
  assert.equal(shipperOnly[0].jobId, JOB_IDS[1]);
});

test('Stripe ready orders reject invalid persisted job IDs instead of replacing them', async () => {
  await assert.rejects(createStripeReadyToShipNotificationJobs({
    order: {
      source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
      status: 'ready_to_ship',
      deliveryId: 7,
    },
    dropId: 'card_nft_2',
    deliveryId: 7,
    jobIds: { shipper_ready_to_ship: '' },
  }), /notification job ID is invalid/);
});
