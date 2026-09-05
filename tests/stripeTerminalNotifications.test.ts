import assert from 'node:assert/strict';
import test from 'node:test';
import { STRIPE_CHECKOUT_STATUS } from '../cloud/workers/api/src/stripeCheckout/contract.ts';
import {
  prepareStripeCheckoutTerminalNotifications,
  shouldPublishStripeCheckoutTerminalNotificationsWrite,
} from '../cloud/workers/api/src/stripeCheckout/terminalNotifications.ts';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../shared/fulfillmentSources.ts';

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
    owner: 'anonymous-owner',
    addressSnapshot: { email: 'buyer@example.com' },
    items: [{ kind: 'box', refId: 3 }],
  };
}

function dependencies(args: {
  checkout?: Record<string, unknown> | null;
  order?: Record<string, unknown> | null;
  createJobId?: () => string;
} = {}) {
  return {
    loadCheckout: async () => args.checkout === null
      ? null
      : { path: CHECKOUT_PATH, data: args.checkout || { status: 'processing' } },
    loadDeliveryOrder: async () => args.order === null ? null : args.order || readyOrder(),
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

test('fulfilled checkout reloads terminal state and prepares exact buyer and shipper jobs', async () => {
  const ids = [...JOB_IDS];
  let checkoutReads = 0;
  let loadedDeliveryId: number | undefined;
  const result = await prepareStripeCheckoutTerminalNotifications({
    dropId: DROP_ID,
    sessionId: SESSION_ID,
    dependencies: {
      ...dependencies({ createJobId: () => ids.shift() || '' }),
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

  assert.equal(result.outcome, 'fulfilled');
  assert.equal(result.jobs.length, 2);
  assert.equal(checkoutReads, 1);
  assert.equal(loadedDeliveryId, 7);
  assert.deepEqual(result.jobs.map((job) => ({
    jobId: job.jobId,
    kind: job.kind,
    idempotencyKey: job.idempotencyKey,
    context: job.context,
  })), [
    {
      jobId: JOB_IDS[0],
      kind: 'buyer_order_received',
      idempotencyKey: `${DROP_ID}:7:order_received`,
      context: { dropId: DROP_ID, deliveryId: 7 },
    },
    {
      jobId: JOB_IDS[1],
      kind: 'shipper_ready_to_ship',
      idempotencyKey: `${DROP_ID}:7:ready_to_ship`,
      context: { dropId: DROP_ID, deliveryId: 7 },
    },
  ]);
});

test('manual-review checkout prepares the existing bounded notification with its durable job ID', async () => {
  const result = await prepareStripeCheckoutTerminalNotifications({
    dropId: DROP_ID,
    sessionId: SESSION_ID,
    jobIds: { stripe_checkout_manual_review: JOB_IDS[0] },
    dependencies: dependencies({
      createJobId: () => { throw new Error('durable job ID should be reused'); },
      checkout: {
        status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
        manualRefundReviewRequired: true,
        manualRefundReviewReason: 'fulfillment_failed_after_payment',
        lastFulfillmentError: { message: '<danger>'.repeat(20_000) },
        livemode: false,
        variantKey: ' xl ',
        owner: 'anonymous:anon:manual-review-subject',
        ownerKind: 'anonymous',
        authSubject: 'anon:manual-review-subject',
        createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
        failedAt: Date.UTC(2026, 0, 2, 3, 6, 5),
      },
    }),
  });

  const jobs = result.jobs;
  assert.equal(result.outcome, 'manual_review');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.jobId, JOB_IDS[0]);
  assert.equal(jobs[0]?.kind, 'stripe_checkout_manual_review');
  assert.equal(jobs[0]?.idempotencyKey, `${DROP_ID}:${SESSION_ID}:stripe_manual_review`);
  assert.deepEqual(jobs[0]?.context, { dropId: DROP_ID, sessionId: SESSION_ID });
  assert.match(jobs[0]?.text || '', new RegExp(`Session ID: ${SESSION_ID}`));
  assert.match(jobs[0]?.text || '', /Variant: xl/);
  assert.match(jobs[0]?.text || '', /Auth subject: anon:manual-review-subject/);
  assert.match(jobs[0]?.text || '', /… truncated$/);
  assert.doesNotMatch(jobs[0]?.html || '', /<danger>/);
});

test('nonterminal and unflagged failed checkouts return no notification jobs', async () => {
  for (const checkout of [
    { status: STRIPE_CHECKOUT_STATUS.PROCESSING },
    { status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED, manualRefundReviewRequired: false },
  ]) {
    const result = await prepareStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      dependencies: dependencies({ checkout }),
    });
    assert.deepEqual(result, { outcome: 'not_terminal', jobs: [] });
  }
});

test('preparing an already-terminal checkout preserves durable IDs and logical idempotency keys', async () => {
  const deps = dependencies({
    checkout: { status: STRIPE_CHECKOUT_STATUS.FULFILLED, deliveryId: 7 },
    createJobId: () => JOB_IDS[3],
  });
  const jobIds = { buyer_order_received: JOB_IDS[0], shipper_ready_to_ship: JOB_IDS[1] };

  const first = await prepareStripeCheckoutTerminalNotifications({
    dropId: DROP_ID, sessionId: SESSION_ID, jobIds, dependencies: deps,
  });
  const second = await prepareStripeCheckoutTerminalNotifications({
    dropId: DROP_ID, sessionId: SESSION_ID, jobIds, dependencies: deps,
  });

  assert.equal(first.outcome, 'fulfilled');
  assert.deepEqual(first, second);
  assert.deepEqual(first.jobs.map((job) => job.idempotencyKey), [
    `${DROP_ID}:7:order_received`,
    `${DROP_ID}:7:ready_to_ship`,
  ]);
  assert.deepEqual(first.jobs.map((job) => job.jobId), [JOB_IDS[0], JOB_IDS[1]]);
});

test('missing checkout, delivery ID, or delivery order returns a permanent invalid outcome', async () => {
  assert.deepEqual(
    await prepareStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      dependencies: dependencies({ checkout: null }),
    }),
    { outcome: 'invalid', jobs: [], reason: 'missing_checkout' },
  );
  assert.deepEqual(
    await prepareStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      dependencies: dependencies({ checkout: { status: STRIPE_CHECKOUT_STATUS.FULFILLED } }),
    }),
    { outcome: 'invalid', jobs: [], reason: 'invalid_delivery_id' },
  );
  assert.deepEqual(
    await prepareStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      dependencies: dependencies({
        checkout: { status: STRIPE_CHECKOUT_STATUS.FULFILLED, deliveryId: 7 },
        order: null,
      }),
    }),
    { outcome: 'invalid', jobs: [], reason: 'missing_delivery_order' },
  );
});

test('invalid ready orders are rejected instead of fulfilling with no jobs', async () => {
  for (const order of [
    { ...readyOrder(), source: 'other' },
    { ...readyOrder(), status: 'prepared' },
    { ...readyOrder(), deliveryId: 8 },
  ]) {
    assert.deepEqual(await prepareStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      dependencies: dependencies({
        checkout: { status: STRIPE_CHECKOUT_STATUS.FULFILLED, deliveryId: 7 },
        order,
      }),
    }), { outcome: 'invalid', jobs: [], reason: 'invalid_delivery_order' });
  }
});

test('invalid durable manual-review IDs are rejected instead of generating replacement IDs', async () => {
  for (const jobId of ['', 'invalid']) {
    assert.deepEqual(await prepareStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      jobIds: { stripe_checkout_manual_review: jobId },
      dependencies: dependencies({
        checkout: {
          status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
          manualRefundReviewRequired: true,
          owner: 'anonymous:anonymous-subject',
          ownerKind: 'anonymous',
          authSubject: 'anonymous-subject',
        },
        createJobId: () => JOB_IDS[0],
      }),
    }), { outcome: 'invalid', jobs: [], reason: 'invalid_manual_review_notification' });
  }
});

test('checkout-store read failures propagate for Queue retry', async () => {
  await assert.rejects(
    prepareStripeCheckoutTerminalNotifications({
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      dependencies: {
        ...dependencies(),
        loadCheckout: async () => {
          throw new Error('checkout store unavailable');
        },
      },
    }),
    /checkout store unavailable/,
  );
});
