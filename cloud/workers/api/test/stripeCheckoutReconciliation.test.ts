import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1 } from './commerceD1Harness.ts';
import { STRIPE_CHECKOUT_STATUS } from '../../../../shared/stripeCheckoutSession.ts';
import { STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR } from '../../../../shared/stripeCheckoutFulfillmentJob.ts';
import {
  reconcileStaleStripeFulfillments,
  stripeCheckoutReconciliationTestHooks,
} from '../src/stripeCheckoutReconciliation.ts';

function queue(send: Queue['send']): Queue {
  return {
    send,
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
}

const candidate = {
  checkoutPath: 'drops/card_nft_binder_devnet/stripeCheckouts/cs_test_reconcile',
  dropId: 'card_nft_binder_devnet',
  sessionId: 'cs_test_reconcile',
  stripeEventId: 'evt_test_reconcile',
  stripeEventType: 'checkout.session.completed' as const,
};

test('Stripe fulfillment reconciliation requeues and marks stale pending checkouts', async () => {
  const jobs: unknown[] = [];
  const marked: unknown[] = [];
  let cutoffMs = 0;
  const nowMs = 2_000_000;
  const result = await reconcileStaleStripeFulfillments(
    {
      COMMERCE_DB: createCommerceD1(),
      STRIPE_FULFILLMENT_QUEUE: queue(async (job) => {
        jobs.push(job);
        return { metadata: { metrics: { backlogCount: 1, backlogBytes: 128 } } };
      }),
    },
    new AbortController().signal,
    {
      loadCandidates: async (value) => {
        cutoffMs = value;
        return [candidate];
      },
      log: () => undefined,
      markEnqueued: async (value) => {
        marked.push(value);
      },
      nowMs: () => nowMs,
    },
  );
  assert.deepEqual(result, { enqueued: 1, failed: 0 });
  assert.equal(cutoffMs, nowMs - stripeCheckoutReconciliationTestHooks.requeueAfterMs);
  assert.deepEqual(marked, [candidate]);
  assert.deepEqual(jobs, [{
    version: 1,
    kind: 'stripe_checkout_fulfillment',
    dropId: candidate.dropId,
    sessionId: candidate.sessionId,
    stripeEventId: candidate.stripeEventId,
    stripeEventType: candidate.stripeEventType,
    enqueuedAtMs: nowMs,
  }]);
});

test('Stripe fulfillment reconciliation retains stale work when Queue publication fails', async () => {
  let marked = false;
  await assert.rejects(
    reconcileStaleStripeFulfillments(
      {
        COMMERCE_DB: createCommerceD1(),
        STRIPE_FULFILLMENT_QUEUE: queue(async () => {
          throw new Error('queue unavailable');
        }),
      },
      new AbortController().signal,
      {
        error: () => undefined,
        loadCandidates: async () => [candidate],
        log: () => undefined,
        markEnqueued: async () => {
          marked = true;
        },
        nowMs: () => 2_000_000,
      },
    ),
    /failed for 1 checkout/,
  );
  assert.equal(marked, false);
});

test('Stripe fulfillment reconciliation stops before enqueue when its deadline is already aborted', async () => {
  let sent = false;
  const controller = new AbortController();
  controller.abort(new DOMException('timed out', 'TimeoutError'));
  await assert.rejects(
    reconcileStaleStripeFulfillments(
      {
        COMMERCE_DB: createCommerceD1(),
        STRIPE_FULFILLMENT_QUEUE: queue(async () => {
          sent = true;
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        }),
      },
      controller.signal,
      {
        loadCandidates: async () => [candidate],
        log: () => undefined,
        markEnqueued: async () => undefined,
        nowMs: () => 2_000_000,
      },
    ),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
  assert.equal(sent, false);
});

test('Stripe fulfillment reconciliation defers invalid candidates behind the backlog', async () => {
  let sent = false;
  const invalidCandidate = { ...candidate, stripeEventId: 'x' };
  const marked: unknown[] = [];
  await assert.rejects(
    reconcileStaleStripeFulfillments(
      {
        COMMERCE_DB: createCommerceD1(),
        STRIPE_FULFILLMENT_QUEUE: queue(async () => {
          sent = true;
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        }),
      },
      new AbortController().signal,
      {
        error: () => undefined,
        loadCandidates: async () => [invalidCandidate],
        log: () => undefined,
        markInvalid: async (value, error) => {
          marked.push({ value, error });
        },
        nowMs: () => 2_000_000,
      },
    ),
    /failed for 1 checkout/,
  );
  assert.equal(sent, false);
  assert.equal(marked.length, 1);
  assert.deepEqual((marked[0] as { value: unknown }).value, invalidCandidate);
});

test('Stripe fulfillment reconciliation query and decoder select only stale marked checkouts', () => {
  const cutoffMs = Date.parse('2026-08-23T00:15:00.000Z');
  const query = stripeCheckoutReconciliationTestHooks.stripeCheckoutReconciliationQuery(cutoffMs, 100) as {
    structuredQuery: Record<string, unknown>;
  };
  assert.deepEqual(query.structuredQuery.orderBy, [
    { field: { fieldPath: 'updatedAt' }, direction: 'ASCENDING' },
    { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
  ]);
  const candidates = stripeCheckoutReconciliationTestHooks.parseRequeueCandidates([
    {
      document: {
        name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_binder_devnet/stripeCheckouts/cs_test_stale',
        fields: {
          fulfillmentProcessor: { stringValue: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR },
          lastStripeWebhookEventId: { stringValue: 'evt_test_stale' },
          lastStripeWebhookEventType: { stringValue: 'checkout.session.completed' },
          status: { stringValue: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING },
          updatedAt: { timestampValue: '2026-08-23T00:00:00.000Z' },
        },
      },
    },
    {
      document: {
        name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_binder_devnet/stripeCheckouts/cs_test_processing',
        fields: {
          fulfillmentProcessor: { stringValue: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR },
          lastStripeWebhookEventId: { stringValue: 'evt_test_processing' },
          lastStripeWebhookEventType: { stringValue: 'checkout.session.async_payment_succeeded' },
          status: { stringValue: STRIPE_CHECKOUT_STATUS.PROCESSING },
          updatedAt: { timestampValue: '2026-08-23T00:05:00.000Z' },
        },
      },
    },
    {
      document: {
        name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_binder_devnet/stripeCheckouts/cs_test_recent',
        fields: {
          fulfillmentProcessor: { stringValue: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR },
          lastStripeWebhookEventId: { stringValue: 'evt_test_recent' },
          lastStripeWebhookEventType: { stringValue: 'checkout.session.completed' },
          status: { stringValue: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING },
          updatedAt: { timestampValue: '2026-08-23T00:30:00.000Z' },
        },
      },
    },
  ], cutoffMs);
  assert.deepEqual(candidates, [
    {
      checkoutPath: 'drops/card_nft_binder_devnet/stripeCheckouts/cs_test_stale',
      dropId: 'card_nft_binder_devnet',
      sessionId: 'cs_test_stale',
      stripeEventId: 'evt_test_stale',
      stripeEventType: 'checkout.session.completed',
    },
    {
      checkoutPath: 'drops/card_nft_binder_devnet/stripeCheckouts/cs_test_processing',
      dropId: 'card_nft_binder_devnet',
      sessionId: 'cs_test_processing',
      stripeEventId: 'evt_test_processing',
      stripeEventType: 'checkout.session.async_payment_succeeded',
    },
  ]);
});
