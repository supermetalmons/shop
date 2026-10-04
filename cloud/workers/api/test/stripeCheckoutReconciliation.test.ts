import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1 } from './commerceD1Harness.ts';
import { STRIPE_CHECKOUT_STATUS } from '../../../../shared/stripeCheckoutSession.ts';
import { STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR } from '../../../../shared/stripeCheckoutFulfillmentJob.ts';
import {
  STRIPE_FULFILLMENT_REQUEUE_AFTER_MS,
  parseRequeueCandidates,
  reconcileStaleStripeFulfillments,
} from '../src/stripeCheckoutReconciliation.ts';
import { commerceKeys, type CommerceDocumentRecord } from '../src/commerceRepository.ts';
import type { StripeCheckoutRequeueCandidate } from '../src/stripeCheckout/readModel.ts';

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
  const events: unknown[] = [];
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
      log: (entry) => { events.push(entry); },
      markEnqueued: async (value) => {
        marked.push(value);
      },
      nowMs: () => nowMs,
      onResult: (result) => { events.push(result); },
    },
  );
  assert.deepEqual(result, { attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0 });
  assert.equal(cutoffMs, nowMs - STRIPE_FULFILLMENT_REQUEUE_AFTER_MS);
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
  assert.deepEqual(events, [
    { event: 'stripe_fulfillment_job_reconciled', dropId: candidate.dropId,
      sessionId: candidate.sessionId, stripeEventId: candidate.stripeEventId },
    { event: 'stripe_fulfillment_reconciliation_completed', candidates: 1, enqueued: 1, failed: 0 },
    result,
  ]);
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
    (error: unknown) => error instanceof Error && !(error instanceof AggregateError) &&
      error.message === 'Stripe fulfillment reconciliation failed for 1 checkout(s)',
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

function checkoutRecord(
  dropId: string,
  sessionId: string,
  data: Record<string, unknown>,
): CommerceDocumentRecord {
  return {
    createTime: '2026-08-23T00:00:00.000000000Z',
    data: data as CommerceDocumentRecord['data'],
    key: commerceKeys.stripeCheckout(dropId, sessionId),
    processedAt: null,
    updateTime: '2026-08-23T00:00:00.000000001Z',
    version: 1,
  };
}

test('Stripe fulfillment reconciliation decoder selects only stale marked D1 checkouts', () => {
  const cutoffMs = Date.parse('2026-08-23T00:15:00.000Z');
  const candidates = parseRequeueCandidates([
    checkoutRecord('card_nft_binder_devnet', 'cs_test_recent', {
      fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
      lastStripeWebhookEventId: 'evt_test_recent',
      lastStripeWebhookEventType: 'checkout.session.completed',
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
      updatedAt: Date.parse('2026-08-23T00:30:00.000Z'),
    }),
    checkoutRecord('card_nft_binder_devnet', 'cs_test_processing', {
      fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
      lastStripeWebhookEventId: 'evt_test_processing',
      lastStripeWebhookEventType: 'checkout.session.async_payment_succeeded',
      status: STRIPE_CHECKOUT_STATUS.PROCESSING,
      updatedAt: Date.parse('2026-08-23T00:05:00.000Z'),
    }),
    checkoutRecord('card_nft_binder_devnet', 'cs_test_stale', {
      fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
      lastStripeWebhookEventId: 'evt_test_stale',
      lastStripeWebhookEventType: 'checkout.session.completed',
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
      updatedAt: Date.parse('2026-08-23T00:00:00.000Z'),
    }),
  ], cutoffMs);
  assert.deepEqual(candidates, [
    {
      checkoutPath: 'drops/card_nft_binder_devnet/stripeCheckouts/cs_test_processing',
      dropId: 'card_nft_binder_devnet',
      sessionId: 'cs_test_processing',
      stripeEventId: 'evt_test_processing',
      stripeEventType: 'checkout.session.async_payment_succeeded',
    },
    {
      checkoutPath: 'drops/card_nft_binder_devnet/stripeCheckouts/cs_test_stale',
      dropId: 'card_nft_binder_devnet',
      sessionId: 'cs_test_stale',
      stripeEventId: 'evt_test_stale',
      stripeEventType: 'checkout.session.completed',
    },
  ]);
});

test('throwing Stripe loggers do not change queue outcomes, progress or the failure summary', async (context) => {
  const failure = new Error('private provider request and customer data');
  const summaries: unknown[] = [];
  const failures: unknown[] = [];
  const sent: string[] = [];
  const marked: string[] = [];
  const second = { ...candidate, sessionId: 'cs_test_other' };
  context.mock.method(console, 'error', (entry: unknown) => { failures.push(entry); });
  await assert.rejects(reconcileStaleStripeFulfillments({
    COMMERCE_DB: createCommerceD1(),
    STRIPE_FULFILLMENT_QUEUE: queue(async (body) => {
      const sessionId = (body as { sessionId: string }).sessionId;
      sent.push(sessionId);
      if (sessionId === candidate.sessionId) throw failure;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    }),
  }, new AbortController().signal, {
    loadCandidates: async () => [candidate, second],
    markEnqueued: async (value) => { marked.push(value.sessionId); },
    log: () => { throw new Error('logger unavailable'); },
    error: () => { throw new Error('error logger unavailable'); },
    onResult: (result) => { summaries.push(result); throw new Error('reporter unavailable'); },
    nowMs: () => 2_000_000,
  }), /Stripe fulfillment reconciliation failed for 1 checkout/);
  assert.deepEqual(sent, [candidate.sessionId, second.sessionId]);
  assert.deepEqual(marked, [second.sessionId]);
  assert.deepEqual(summaries, [{ attempted: 2, completed: 1, deferred: 0, skipped: 0, failed: 1 }]);
  assert.deepEqual(failures, [{ event: 'scheduled_reconciliation_item_failed', job: 'stripe',
    dropId: candidate.dropId, sessionId: candidate.sessionId, errorName: 'Error' }]);
});

test('an accepted Stripe enqueue with a failed persistence write is not counted as completed', async () => {
  let sends = 0;
  const summaries: unknown[] = [];
  await assert.rejects(reconcileStaleStripeFulfillments({
    COMMERCE_DB: createCommerceD1(),
    STRIPE_FULFILLMENT_QUEUE: queue(async () => {
      sends += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    }),
  }, new AbortController().signal, {
    loadCandidates: async () => [candidate],
    markEnqueued: async () => { throw new Error('persistence unavailable'); },
    log: () => {}, error: () => {}, nowMs: () => 2_000_000,
    onResult: (result) => { summaries.push(result); },
  }), /failed for 1 checkout/);
  assert.equal(sends, 1);
  assert.deepEqual(summaries, [{ attempted: 1, completed: 0, deferred: 0, skipped: 0, failed: 1 }]);
});

test('an invalid Stripe candidate whose deferral fails is counted once and does not block later work', async (context) => {
  const invalid = { ...candidate, stripeEventId: 'x' };
  const sent: unknown[] = [];
  const marked: unknown[] = [];
  const deferred: Array<{ value: StripeCheckoutRequeueCandidate; error: unknown }> = [];
  const events: unknown[] = [];
  const failures: unknown[] = [];
  context.mock.method(console, 'error', (entry: unknown) => { failures.push(entry); });
  await assert.rejects(reconcileStaleStripeFulfillments({
    COMMERCE_DB: createCommerceD1(),
    STRIPE_FULFILLMENT_QUEUE: queue(async (job) => {
      sent.push(job);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    }),
  }, new AbortController().signal, {
    loadCandidates: async () => [invalid, candidate],
    markInvalid: async (value, error) => {
      deferred.push({ value, error });
      throw new Error('deferral unavailable');
    },
    markEnqueued: async (value) => { marked.push(value); },
    log: (entry) => { events.push(entry); },
    error: (entry) => { events.push(entry); },
    onResult: (result) => { events.push(result); },
    nowMs: () => 2_000_000,
  }), (error: unknown) => error instanceof Error && !(error instanceof AggregateError) &&
    error.message === 'Stripe fulfillment reconciliation failed for 1 checkout(s)');
  assert.deepEqual(deferred.map(({ value }) => value), [invalid]);
  assert.ok(deferred[0].error instanceof Error);
  assert.equal(sent.length, 1);
  assert.deepEqual(marked, [candidate]);
  assert.deepEqual(events, [
    { event: 'stripe_fulfillment_job_reconciliation_failed', dropId: candidate.dropId,
      sessionId: candidate.sessionId, error: { name: 'AggregateError' } },
    { event: 'stripe_fulfillment_job_reconciled', dropId: candidate.dropId,
      sessionId: candidate.sessionId, stripeEventId: candidate.stripeEventId },
    { event: 'stripe_fulfillment_reconciliation_completed', candidates: 2, enqueued: 1, failed: 1 },
    { attempted: 2, completed: 1, deferred: 0, skipped: 0, failed: 1 },
  ]);
  assert.deepEqual(failures, [{ event: 'scheduled_reconciliation_item_failed', job: 'stripe',
    dropId: candidate.dropId, sessionId: candidate.sessionId, errorName: 'Error' }]);
});

test('Stripe cancellation respects candidate boundaries and preserves partial outcomes', async (context) => {
  context.mock.method(console, 'error', () => {});
  for (const finalCandidate of [false, true]) {
    for (const fails of [false, true]) {
      const controller = new AbortController();
      const cancellation = new Error('cancelled');
      const summaries: unknown[] = [];
      const logs: Array<Record<string, unknown>> = [];
      let sends = 0;
      const pass = reconcileStaleStripeFulfillments({
        COMMERCE_DB: createCommerceD1(),
        STRIPE_FULFILLMENT_QUEUE: queue(async () => {
          sends += 1;
          controller.abort(cancellation);
          if (fails) throw new Error('queue unavailable');
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        }),
      }, controller.signal, {
        loadCandidates: async () => finalCandidate ? [candidate] : [candidate, { ...candidate, sessionId: 'cs_test_later' }],
        markEnqueued: async () => {},
        log: (entry) => { logs.push(entry); },
        error: () => {},
        onResult: (result) => { summaries.push(result); },
        nowMs: () => 2_000_000,
      });
      const summary = { attempted: 1, completed: fails ? 0 : 1, deferred: 0, skipped: 0, failed: fails ? 1 : 0 };
      if (!finalCandidate) await assert.rejects(pass, (error: unknown) => error === cancellation);
      else if (fails) {
        await assert.rejects(pass, (error: unknown) => error instanceof Error && !(error instanceof AggregateError) &&
          error.message === 'Stripe fulfillment reconciliation failed for 1 checkout(s)');
      } else assert.deepEqual(await pass, summary);
      assert.equal(sends, 1);
      assert.deepEqual(summaries, [summary]);
      assert.deepEqual(logs.filter((entry) => entry.event === 'stripe_fulfillment_reconciliation_completed'),
        finalCandidate ? [{ event: 'stripe_fulfillment_reconciliation_completed', candidates: 1,
          enqueued: summary.completed, failed: summary.failed }] : []);
    }
  }
});

test('Stripe candidate loading failures retain their identity and report an empty result once', async () => {
  const failure = new Error('query unavailable');
  const summaries: unknown[] = [];
  const logs: unknown[] = [];
  await assert.rejects(reconcileStaleStripeFulfillments({
    COMMERCE_DB: createCommerceD1(),
    STRIPE_FULFILLMENT_QUEUE: queue(async () => assert.fail('failed query must not enqueue')),
  }, new AbortController().signal, {
    loadCandidates: async () => { throw failure; },
    log: (entry) => { logs.push(entry); },
    onResult: (result) => { summaries.push(result); },
    nowMs: () => 2_000_000,
  }), (error: unknown) => error === failure);
  assert.deepEqual(summaries, [{ attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0 }]);
  assert.deepEqual(logs, []);
});

test('an aborted Stripe pass with an empty overridden candidate list still completes', async () => {
  const events: unknown[] = [];
  let loaded = false;
  const result = await reconcileStaleStripeFulfillments({
    COMMERCE_DB: createCommerceD1(),
    STRIPE_FULFILLMENT_QUEUE: queue(async () => assert.fail('empty pass must not enqueue')),
  }, AbortSignal.abort(new Error('cancelled')), {
    loadCandidates: async () => { loaded = true; return []; },
    log: (entry) => { events.push(entry); },
    onResult: (result) => { events.push(result); },
    nowMs: () => 2_000_000,
  });
  assert.equal(loaded, true);
  assert.deepEqual(result, { attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(events, [
    { event: 'stripe_fulfillment_reconciliation_completed', candidates: 0, enqueued: 0, failed: 0 },
    result,
  ]);
});
