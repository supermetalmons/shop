import assert from 'node:assert/strict';
import test from 'node:test';
import { STRIPE_CHECKOUT_STATUS } from '../cloud/workers/api/src/stripeCheckout/contract.ts';
import {
  publishStripeCheckoutTerminalNotifications,
  shouldPublishStripeCheckoutTerminalNotificationsWrite,
} from '../cloud/workers/api/src/stripeCheckout/terminalNotifications.ts';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../shared/fulfillmentSources.ts';
import type { NotificationEmailJobV1 } from '../shared/notificationEmailJob.ts';

const DROP_ID = 'card_nft_2';
const SESSION_ID = 'cs_test_terminal_notifications';
const CHECKOUT_PATH = `drops/${DROP_ID}/stripeCheckouts/${SESSION_ID}`;
const JOB_IDS = [
  '123e4567-e89b-42d3-a456-426614174010',
  '123e4567-e89b-42d3-a456-426614174011',
  '123e4567-e89b-42d3-a456-426614174012',
  '123e4567-e89b-42d3-a456-426614174013',
];

function readyOrder() {
  return {
    source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
    status: 'ready_to_ship',
    deliveryId: 7,
    owner: 'firebase-owner',
    addressSnapshot: { email: 'buyer@example.com' },
    items: [{ kind: 'box', refId: 3 }],
  };
}

function dependencies(args: {
  checkout?: Record<string, unknown> | null;
  order?: Record<string, unknown> | null;
  jobs?: NotificationEmailJobV1[];
  createJobId?: () => string;
  enqueueJob?: (job: NotificationEmailJobV1) => Promise<void>;
} = {}) {
  const jobs = args.jobs || [];
  return {
    loadCheckout: async () => args.checkout === null
      ? null
      : { path: CHECKOUT_PATH, data: args.checkout || { status: 'processing' } },
    loadDeliveryOrder: async () => args.order === null ? null : args.order || readyOrder(),
    enqueueJob: args.enqueueJob || (async (job: NotificationEmailJobV1) => {
      jobs.push(job);
    }),
    getDropName: () => 'Card NFT 2',
    ...(args.createJobId ? { createJobId: args.createJobId } : {}),
  };
}

test('terminal transition detection covers direct fulfillment and manual-review writes once', () => {
  assert.equal(shouldPublishStripeCheckoutTerminalNotificationsWrite({
    before: { status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED },
    after: { status: STRIPE_CHECKOUT_STATUS.FULFILLED },
  }), true);
  assert.equal(shouldPublishStripeCheckoutTerminalNotificationsWrite({
    before: { status: STRIPE_CHECKOUT_STATUS.FULFILLED },
    after: { status: STRIPE_CHECKOUT_STATUS.FULFILLED },
  }), false);
  assert.equal(shouldPublishStripeCheckoutTerminalNotificationsWrite({
    before: { status: STRIPE_CHECKOUT_STATUS.PROCESSING },
    after: {
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
      manualRefundReviewRequired: true,
    },
  }), true);
  assert.equal(shouldPublishStripeCheckoutTerminalNotificationsWrite({
    before: {
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
      manualRefundReviewRequired: true,
    },
    after: {
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
      manualRefundReviewRequired: true,
    },
  }), false);
  assert.equal(shouldPublishStripeCheckoutTerminalNotificationsWrite({
    before: null,
    after: { status: STRIPE_CHECKOUT_STATUS.FULFILLED },
  }), false);
});

test('fulfilled checkout reloads terminal state and queues exact buyer and shipper jobs', async () => {
  const jobs: NotificationEmailJobV1[] = [];
  const ids = [...JOB_IDS];
  let checkoutReads = 0;
  let loadedDeliveryId: number | undefined;
  const result = await publishStripeCheckoutTerminalNotifications({
    dropId: DROP_ID,
    sessionId: SESSION_ID,
    dependencies: {
      ...dependencies({ jobs, createJobId: () => ids.shift() || '' }),
      loadCheckout: async () => {
        checkoutReads += 1;
        return {
          path: CHECKOUT_PATH,
          data: { status: STRIPE_CHECKOUT_STATUS.FULFILLED, deliveryId: 7 },
        };
      },
      loadDeliveryOrder: async (_dropId, deliveryId) => {
        loadedDeliveryId = deliveryId;
        return readyOrder();
      },
    },
  });

  assert.deepEqual(result, { outcome: 'fulfilled', queuedJobs: 2 });
  assert.equal(checkoutReads, 1);
  assert.equal(loadedDeliveryId, 7);
  assert.deepEqual(jobs.map((job) => ({
    kind: job.kind,
    idempotencyKey: job.idempotencyKey,
    context: job.context,
  })), [
    {
      kind: 'buyer_order_received',
      idempotencyKey: `${DROP_ID}:7:order_received`,
      context: { dropId: DROP_ID, deliveryId: 7 },
    },
    {
      kind: 'shipper_ready_to_ship',
      idempotencyKey: `${DROP_ID}:7:ready_to_ship`,
      context: { dropId: DROP_ID, deliveryId: 7 },
    },
  ]);
});

test('manual-review checkout queues the existing bounded notification job', async () => {
  const jobs: NotificationEmailJobV1[] = [];
  const result = await publishStripeCheckoutTerminalNotifications({
    dropId: DROP_ID,
    sessionId: SESSION_ID,
    dependencies: dependencies({
      jobs,
      createJobId: () => JOB_IDS[0],
      checkout: {
        status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
        manualRefundReviewRequired: true,
        manualRefundReviewReason: 'fulfillment_failed_after_payment',
        lastFulfillmentError: { message: '<danger>'.repeat(20_000) },
        livemode: false,
        variantKey: ' xl ',
        owner: ' owner<&> ',
        uid: 'firebase-uid',
        createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
        failedAt: Date.UTC(2026, 0, 2, 3, 6, 5),
      },
    }),
  });

  assert.deepEqual(result, { outcome: 'manual_review', queuedJobs: 1 });
  assert.equal(jobs[0]?.kind, 'stripe_checkout_manual_review');
  assert.equal(jobs[0]?.idempotencyKey, `${DROP_ID}:${SESSION_ID}:stripe_manual_review`);
  assert.deepEqual(jobs[0]?.context, { dropId: DROP_ID, sessionId: SESSION_ID });
  assert.match(jobs[0]?.text || '', new RegExp(`Session ID: ${SESSION_ID}`));
  assert.match(jobs[0]?.text || '', /Variant: xl/);
  assert.match(jobs[0]?.text || '', /… truncated$/);
  assert.doesNotMatch(jobs[0]?.html || '', /<danger>/);
});

test('nonterminal and unflagged failed checkouts do not queue notifications', async () => {
  for (const checkout of [
    { status: STRIPE_CHECKOUT_STATUS.PROCESSING },
    { status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED, manualRefundReviewRequired: false },
  ]) {
    const jobs: NotificationEmailJobV1[] = [];
    const result = await publishStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      dependencies: dependencies({ jobs, checkout }),
    });
    assert.deepEqual(result, { outcome: 'not_terminal', queuedJobs: 0 });
    assert.deepEqual(jobs, []);
  }
});

test('retrying an already-terminal checkout preserves logical idempotency keys', async () => {
  const jobs: NotificationEmailJobV1[] = [];
  const ids = [...JOB_IDS];
  const deps = dependencies({
    jobs,
    checkout: { status: STRIPE_CHECKOUT_STATUS.FULFILLED, deliveryId: 7 },
    createJobId: () => ids.shift() || '',
  });

  await publishStripeCheckoutTerminalNotifications({ dropId: DROP_ID, sessionId: SESSION_ID, dependencies: deps });
  await publishStripeCheckoutTerminalNotifications({ dropId: DROP_ID, sessionId: SESSION_ID, dependencies: deps });

  assert.deepEqual(jobs.map((job) => job.idempotencyKey), [
    `${DROP_ID}:7:order_received`,
    `${DROP_ID}:7:ready_to_ship`,
    `${DROP_ID}:7:order_received`,
    `${DROP_ID}:7:ready_to_ship`,
  ]);
  assert.equal(new Set(jobs.map((job) => job.jobId)).size, 4);
});

test('missing checkout, delivery ID, or delivery order returns a permanent invalid outcome', async () => {
  assert.deepEqual(
    await publishStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      dependencies: dependencies({ checkout: null }),
    }),
    { outcome: 'invalid', queuedJobs: 0, reason: 'missing_checkout' },
  );
  assert.deepEqual(
    await publishStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      dependencies: dependencies({ checkout: { status: STRIPE_CHECKOUT_STATUS.FULFILLED } }),
    }),
    { outcome: 'invalid', queuedJobs: 0, reason: 'invalid_delivery_id' },
  );
  assert.deepEqual(
    await publishStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      dependencies: dependencies({
        checkout: { status: STRIPE_CHECKOUT_STATUS.FULFILLED, deliveryId: 7 },
        order: null,
      }),
    }),
    { outcome: 'invalid', queuedJobs: 0, reason: 'missing_delivery_order' },
  );
});

test('Cloudflare enqueue failures propagate for Queue retry', async () => {
  await assert.rejects(
    publishStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      dependencies: dependencies({
        checkout: {
          status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
          manualRefundReviewRequired: true,
        },
        createJobId: () => JOB_IDS[0],
        enqueueJob: async () => {
          throw new Error('enqueue unavailable');
        },
      }),
    }),
    /enqueue unavailable/,
  );
});

test('Firestore read failures propagate for Queue retry', async () => {
  await assert.rejects(
    publishStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      dependencies: {
        ...dependencies(),
        loadCheckout: async () => {
          throw new Error('firestore unavailable');
        },
      },
    }),
    /firestore unavailable/,
  );
});
