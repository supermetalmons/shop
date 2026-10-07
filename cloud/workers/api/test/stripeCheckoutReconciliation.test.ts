import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, createCommerceD1Harness, seedCommerceDocument, seedCommerceDocuments } from './commerceD1Harness.ts';
import { STRIPE_CHECKOUT_STATUS } from '../../../../shared/stripeCheckoutSession.ts';
import { STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR } from '../../../../shared/stripeCheckoutFulfillmentJob.ts';
import {
  STRIPE_FULFILLMENT_REQUEUE_AFTER_MS,
  reconcileStaleStripeFulfillments,
} from '../src/stripeCheckoutReconciliation.ts';
import { D1CommerceRepository, commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { parseStripeCheckoutRequeueCandidate, type StripeCheckoutRequeueCandidate } from '../src/commerceDiscoveryCandidates.ts';
import { staleStripeFulfillmentsQuery } from '../src/commerceQueries.ts';

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

test('Stripe reconciliation projects only candidate metadata and preserves eligibility and event defaults', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const fixtures: Array<{ sessionId: string } & CommerceDocumentData> = [
    { sessionId: 'cs_recent', updatedAt: 21 },
    { sessionId: 'cs_unmarked', lastStripeWebhookEventId: null },
    { sessionId: 'cs_wrong_processor', fulfillmentProcessor: 'legacy' },
    { sessionId: 'cs_fulfilled', status: STRIPE_CHECKOUT_STATUS.FULFILLED },
    { sessionId: 'cs_no_timestamp', updatedAt: null },
    { sessionId: 'cs_nonstring_event', lastStripeWebhookEventId: true },
    { sessionId: 'cs_async', updatedAt: 5, status: STRIPE_CHECKOUT_STATUS.PROCESSING,
      lastStripeWebhookEventType: 'checkout.session.async_payment_succeeded' },
    { sessionId: 'cs_completed', updatedAt: 10, lastStripeWebhookEventType: 'checkout.session.completed' },
    { sessionId: 'cs_default' },
    { sessionId: 'cs_empty_event', lastStripeWebhookEventId: '' },
    { sessionId: 'cs_unknown', lastStripeWebhookEventType: { unexpected: true } },
  ];
  seedCommerceDocuments(harness, fixtures.map(({ sessionId, ...fields }) => ({
    key: commerceKeys.stripeCheckout('drop', sessionId),
    data: {
      fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
      lastStripeWebhookEventId: `evt_${sessionId}`,
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
      updatedAt: 20,
      stripeSessionSummary: { privatePayload: 'x'.repeat(64 * 1024) },
      ...fields,
    },
  })));
  const query = staleStripeFulfillmentsQuery(20);
  const rows = harness.database.prepare(query.sql).all(...query.bindings);
  for (const row of rows) {
    const metadata = JSON.parse(String(row.document_json));
    assert.deepEqual(Object.keys(metadata).sort(), [
      'fulfillmentProcessor', 'lastStripeWebhookEventId', 'lastStripeWebhookEventType',
    ]);
    assert.equal(String(row.document_json).length < 300, true);
    assert.equal(Object.hasOwn(row, 'stripeSessionSummary'), false);
  }
  assert.deepEqual(await new D1CommerceRepository(harness.db).queryStaleStripeFulfillments(20),
    ['cs_async', 'cs_completed', 'cs_default', 'cs_empty_event', 'cs_unknown'].map((sessionId) => ({
      checkoutPath: commerceKeys.stripeCheckout('drop', sessionId).path,
      dropId: 'drop', sessionId, stripeEventId: sessionId === 'cs_empty_event' ? '' : `evt_${sessionId}`,
      stripeEventType: sessionId === 'cs_async' ? 'checkout.session.async_payment_succeeded' : 'checkout.session.completed',
    })));
});

test('Stripe reconciliation candidates keep the due index, chronological path order, and 100-row cap', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const sessionIds = Array.from({ length: 102 }, (_, index) => `cs_${String(index).padStart(3, '0')}`);
  seedCommerceDocuments(harness, [...sessionIds].reverse().map((sessionId) => ({
    key: commerceKeys.stripeCheckout('drop', sessionId),
    data: { fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
      lastStripeWebhookEventId: `evt_${sessionId}`, status: STRIPE_CHECKOUT_STATUS.PROCESSING, updatedAt: 20 },
  })));
  const repository = new D1CommerceRepository(harness.db);
  assert.deepEqual(await repository.queryStaleStripeFulfillments(19), []);
  assert.deepEqual((await repository.queryStaleStripeFulfillments(20)).map((value) => value.sessionId), sessionIds.slice(0, 100));
  const query = staleStripeFulfillmentsQuery(20);
  const plan = harness.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings)
    .map((row) => row.detail).join('\n');
  assert.match(plan, /commerce_stripe_checkout_state_reconciliation_due/);
  assert.doesNotMatch(plan, /USE TEMP B-TREE/);
});

test('Stripe reconciliation candidates retain document and complete checkout-state validation', (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seedCommerceDocument(harness, {
    key: commerceKeys.stripeCheckout('drop', 'cs_valid'),
    data: { fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
      lastStripeWebhookEventId: 'evt_valid', status: STRIPE_CHECKOUT_STATUS.PROCESSING, updatedAt: 20 },
  });
  const query = staleStripeFulfillmentsQuery(20);
  const row = harness.database.prepare(query.sql).get(...query.bindings)!;
  const state = JSON.parse(String(row.checkout_state_json));
  const invalid = [
    { document_path: 'drops/other/stripeCheckouts/cs_valid' },
    { document_kind: 'delivery_order' },
    { document_id: 'cs_wrong' },
    { drop_id: null },
    { version: 0 },
    { create_time: null },
    { update_time: null },
    { processed_at_seconds: 1, processed_at_nanos: null },
    { document_json: 'not-json' },
    { checkout_state_mode: 'legacy' },
    { checkout_state_json: null },
    { checkout_state_json: JSON.stringify({ ...state, document_version: 2 }) },
    { checkout_state_json: JSON.stringify({ ...state, processing_attempt_count: -1 }) },
    { checkout_state_json: JSON.stringify({ ...state, next_fulfillment_retry_at_ms: '20' }) },
  ];
  for (const changes of invalid) {
    assert.throws(() => parseStripeCheckoutRequeueCandidate({ ...row, ...changes }, 20), { code: 'unavailable' });
  }
  assert.equal(parseStripeCheckoutRequeueCandidate(row, 19), null);
});

test('Stripe reconciliation uses the projected repository candidates through its default loader', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seedCommerceDocument(harness, {
    key: commerceKeys.stripeCheckout(candidate.dropId, candidate.sessionId),
    data: { fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
      lastStripeWebhookEventId: candidate.stripeEventId, status: STRIPE_CHECKOUT_STATUS.PROCESSING, updatedAt: 20 },
  });
  const jobs: unknown[] = [];
  const marked: StripeCheckoutRequeueCandidate[] = [];
  const result = await reconcileStaleStripeFulfillments({
    COMMERCE_DB: harness.db,
    STRIPE_FULFILLMENT_QUEUE: queue(async (job) => {
      jobs.push(job);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    }),
  }, new AbortController().signal, {
    nowMs: () => STRIPE_FULFILLMENT_REQUEUE_AFTER_MS + 20,
    markEnqueued: async (value) => { marked.push(value); }, log: () => {},
  });
  assert.equal(result.completed, 1);
  assert.deepEqual(marked, [candidate]);
  assert.equal(jobs.length, 1);
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
