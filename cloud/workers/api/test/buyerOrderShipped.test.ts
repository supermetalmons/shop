import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUYER_ORDER_SHIPPED_EMAIL_PENDING,
  BUYER_ORDER_SHIPPED_EMAIL_QUEUED,
  createBuyerOrderShippedNotificationJob,
  decideBuyerOrderShippedNotification,
} from '../src/buyerOrderShipped.ts';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../../../functions/src/shared/fulfillmentSources.ts';

const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const DELIVERY_ID = 456;
const DROP_ID = 'little_swag_hoodies';
const TRACKING_URL = 'https://carrier.example/track?id=AB123';

function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deliveryId: DELIVERY_ID,
    addressSnapshot: { email: ' buyer@example.com ' },
    items: [{ kind: 'box', refId: 7 }],
    fulfillmentStatus: 'Shipped',
    fulfillmentTrackingCode: TRACKING_URL,
    ...overrides,
  };
}

test('planner creates the first shipped notification and exact Queue job', async () => {
  const after = order();
  const decision = decideBuyerOrderShippedNotification({
    before: order({ fulfillmentStatus: 'Preparing', fulfillmentTrackingCode: undefined }),
    after,
    deliveryDocId: DELIVERY_ID,
    dropId: DROP_ID,
    createJobId: () => JOB_ID,
  });
  assert.deepEqual(decision, {
    kind: 'send',
    deliveryId: DELIVERY_ID,
    idempotencyKey: `${DROP_ID}:${DELIVERY_ID}:order_shipped`,
    jobId: JOB_ID,
  });
  if (decision.kind !== 'send') return;

  const job = await createBuyerOrderShippedNotificationJob({
    deliveryId: decision.deliveryId,
    dropId: DROP_ID,
    idempotencyKey: decision.idempotencyKey,
    jobId: decision.jobId,
    order: after,
  });
  assert.equal(job.jobId, JOB_ID);
  assert.equal(job.kind, 'buyer_order_shipped');
  assert.equal(job.idempotencyKey, `${DROP_ID}:${DELIVERY_ID}:order_shipped`);
  assert.deepEqual(job.recipients, ['buyer@example.com']);
  assert.deepEqual(job.context, { dropId: DROP_ID, deliveryId: DELIVERY_ID });
  assert.equal(job.subject, 'Order shipped - Little Swag Hoodies');
  assert.match(job.text, /Your order shipped\./);
  assert.match(job.text, new RegExp(`Tracking: ${TRACKING_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(job.html, /Track package/);
});

test('planner retries a pending notification with the stored job ID', () => {
  const shipped = order();
  const decision = decideBuyerOrderShippedNotification({
    before: shipped,
    after: shipped,
    deliveryDocId: DELIVERY_ID,
    dropId: DROP_ID,
    emailState: BUYER_ORDER_SHIPPED_EMAIL_PENDING,
    idempotencyKey: `${DROP_ID}:${DELIVERY_ID}:order_shipped`,
    jobId: JOB_ID,
  });
  assert.deepEqual(decision, {
    kind: 'send',
    deliveryId: DELIVERY_ID,
    idempotencyKey: `${DROP_ID}:${DELIVERY_ID}:order_shipped`,
    jobId: JOB_ID,
  });
});

test('planner skips non-qualifying and already queued orders', () => {
  const shipped = order();
  assert.deepEqual(
    decideBuyerOrderShippedNotification({
      before: shipped,
      after: shipped,
      deliveryDocId: DELIVERY_ID,
      dropId: DROP_ID,
    }),
    { kind: 'skip', clearPending: false, reason: 'not-first-shipped-with-tracking' },
  );
  assert.deepEqual(
    decideBuyerOrderShippedNotification({
      before: order({ fulfillmentStatus: 'Preparing' }),
      after: shipped,
      deliveryDocId: DELIVERY_ID,
      dropId: DROP_ID,
      emailState: BUYER_ORDER_SHIPPED_EMAIL_QUEUED,
      jobId: JOB_ID,
    }),
    { kind: 'skip', clearPending: false, reason: 'already-queued' },
  );
  assert.deepEqual(
    decideBuyerOrderShippedNotification({
      before: shipped,
      after: order({ fulfillmentTrackingCode: 'http://carrier.example/track' }),
      deliveryDocId: DELIVERY_ID,
      dropId: DROP_ID,
      emailState: BUYER_ORDER_SHIPPED_EMAIL_PENDING,
      jobId: JOB_ID,
    }),
    { kind: 'skip', clearPending: true, reason: 'pending-no-longer-shipped' },
  );
});

test('planner skips ignored sources, invalid recipients, and delivery ID mismatches', () => {
  const before = order({ fulfillmentStatus: 'Preparing', fulfillmentTrackingCode: undefined });
  assert.deepEqual(
    decideBuyerOrderShippedNotification({
      before,
      after: order({ source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE }),
      deliveryDocId: DELIVERY_ID,
      dropId: DROP_ID,
    }),
    { kind: 'skip', clearPending: false, reason: 'ignored-source' },
  );
  assert.deepEqual(
    decideBuyerOrderShippedNotification({
      before,
      after: order({ addressSnapshot: { email: 'not-an-email' } }),
      deliveryDocId: DELIVERY_ID,
      dropId: DROP_ID,
    }),
    { kind: 'skip', clearPending: false, reason: 'missing-or-invalid-recipient' },
  );
  assert.deepEqual(
    decideBuyerOrderShippedNotification({
      before,
      after: order({ deliveryId: DELIVERY_ID + 1 }),
      deliveryDocId: DELIVERY_ID,
      dropId: DROP_ID,
    }),
    { kind: 'skip', clearPending: false, reason: 'invalid-delivery-id' },
  );
});

test('planner creates a fresh idempotency attempt for an explicit queued retry', () => {
  const decision = decideBuyerOrderShippedNotification({
    before: order(),
    after: order(),
    deliveryDocId: DELIVERY_ID,
    dropId: DROP_ID,
    emailState: BUYER_ORDER_SHIPPED_EMAIL_QUEUED,
    forceRetry: true,
    jobId: '123e4567-e89b-42d3-a456-426614174001',
    createJobId: () => JOB_ID,
  });
  assert.deepEqual(decision, {
    kind: 'send',
    deliveryId: DELIVERY_ID,
    idempotencyKey: `${DROP_ID}:${DELIVERY_ID}:order_shipped:retry:${JOB_ID}`,
    jobId: JOB_ID,
  });
});
