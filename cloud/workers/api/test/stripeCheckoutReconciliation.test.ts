import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, createCommerceD1Harness, seedCommerceDocument, seedCommerceDocuments, type CommerceD1CallObservation } from './commerceD1Harness.ts';
import { STRIPE_CHECKOUT_STATUS } from '../../../../shared/stripeCheckoutSession.ts';
import { STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR } from '../../../../shared/stripeCheckoutFulfillmentJob.ts';
import {
  STRIPE_FULFILLMENT_REQUEUE_AFTER_MS,
  reconcileStaleStripeFulfillments,
} from '../src/stripeCheckoutReconciliation.ts';
import { D1CommerceRepository, commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { parseStripeCheckoutRequeueCandidate, type StripeCheckoutRequeueCandidate, type StripeCheckoutRequeueCursor } from '../src/commerceDiscoveryCandidates.ts';
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
  updatedAtMs: 20,
  dropId: 'card_nft_binder_devnet',
  sessionId: 'cs_test_reconcile',
  stripeEventId: 'evt_test_reconcile',
  stripeEventType: 'checkout.session.completed' as const,
};

const noBacklog = async () => ({ hasMore: false, oldestDueAgeMs: null });
const singlePageMetrics = { inspected: 1, pages: 1, stopReason: 'drained', hasMore: false, oldestDueAgeMs: null };

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
      loadPage: async ({ cutoffMs: value }) => {
        cutoffMs = value;
        return { candidates: [candidate], hasMore: false };
      },
      probeBacklog: noBacklog,
      log: (entry) => { events.push(entry); },
      markEnqueued: async (value) => {
        marked.push(value);
      },
      nowMs: () => nowMs,
      onResult: (result) => { events.push(result); },
    },
  );
  assert.deepEqual(result, { attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0, ...singlePageMetrics });
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
        loadPage: async () => ({ candidates: [candidate], hasMore: false }),
        probeBacklog: noBacklog,
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
        loadPage: async () => ({ candidates: [candidate], hasMore: false }),
        probeBacklog: noBacklog,
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
        loadPage: async () => ({ candidates: [invalidCandidate], hasMore: false }),
        probeBacklog: noBacklog,
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
  assert.deepEqual(await new D1CommerceRepository(harness.db).queryStaleStripeFulfillments(20), {
    candidates: ['cs_async', 'cs_completed', 'cs_default', 'cs_empty_event', 'cs_unknown'].map((sessionId) => ({
      checkoutPath: commerceKeys.stripeCheckout('drop', sessionId).path,
      updatedAtMs: sessionId === 'cs_async' ? 5 : sessionId === 'cs_completed' ? 10 : 20,
      dropId: 'drop', sessionId, stripeEventId: sessionId === 'cs_empty_event' ? '' : `evt_${sessionId}`,
      stripeEventType: sessionId === 'cs_async' ? 'checkout.session.async_payment_succeeded' : 'checkout.session.completed',
    })), hasMore: false,
  });
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
  assert.deepEqual(await repository.queryStaleStripeFulfillments(19), { candidates: [], hasMore: false });
  const first = await repository.queryStaleStripeFulfillments(20);
  assert.deepEqual(first.candidates.map((value) => value.sessionId), sessionIds.slice(0, 100));
  assert.equal(first.hasMore, true);
  const second = await repository.queryStaleStripeFulfillments(20, 100, first.candidates.at(-1));
  assert.deepEqual(second.candidates.map((value) => value.sessionId), sessionIds.slice(100));
  assert.equal(second.hasMore, false);
  const query = staleStripeFulfillmentsQuery(20, 100, first.candidates.at(-1));
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
  const second = { ...candidate, sessionId: 'cs_test_other',
    checkoutPath: commerceKeys.stripeCheckout(candidate.dropId, 'cs_test_other').path };
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
    loadPage: async () => ({ candidates: [candidate, second], hasMore: false }),
    probeBacklog: noBacklog,
    markEnqueued: async (value) => { marked.push(value.sessionId); },
    log: () => { throw new Error('logger unavailable'); },
    error: () => { throw new Error('error logger unavailable'); },
    onResult: (result) => { summaries.push(result); throw new Error('reporter unavailable'); },
    nowMs: () => 2_000_000,
  }), /Stripe fulfillment reconciliation failed for 1 checkout/);
  assert.deepEqual(sent, [candidate.sessionId, second.sessionId]);
  assert.deepEqual(marked, [second.sessionId]);
  assert.deepEqual(summaries, [{ attempted: 2, completed: 1, deferred: 0, skipped: 0, failed: 1, ...singlePageMetrics, inspected: 2 }]);
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
    loadPage: async () => ({ candidates: [candidate], hasMore: false }),
    probeBacklog: noBacklog,
    markEnqueued: async () => { throw new Error('persistence unavailable'); },
    log: () => {}, error: () => {}, nowMs: () => 2_000_000,
    onResult: (result) => { summaries.push(result); },
  }), /failed for 1 checkout/);
  assert.equal(sends, 1);
  assert.deepEqual(summaries, [{ attempted: 1, completed: 0, deferred: 0, skipped: 0, failed: 1, ...singlePageMetrics }]);
});

test('an invalid Stripe candidate whose deferral fails is counted once and does not block later work', async (context) => {
  const invalid = { ...candidate, stripeEventId: 'x', sessionId: 'cs_invalid',
    checkoutPath: commerceKeys.stripeCheckout(candidate.dropId, 'cs_invalid').path };
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
    loadPage: async () => ({ candidates: [invalid, candidate], hasMore: false }),
    probeBacklog: noBacklog,
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
      sessionId: invalid.sessionId, error: { name: 'AggregateError' } },
    { event: 'stripe_fulfillment_job_reconciled', dropId: candidate.dropId,
      sessionId: candidate.sessionId, stripeEventId: candidate.stripeEventId },
    { event: 'stripe_fulfillment_reconciliation_completed', candidates: 2, enqueued: 1, failed: 1 },
    { attempted: 2, completed: 1, deferred: 0, skipped: 0, failed: 1, ...singlePageMetrics, inspected: 2 },
  ]);
  assert.deepEqual(failures, [{ event: 'scheduled_reconciliation_item_failed', job: 'stripe',
    dropId: candidate.dropId, sessionId: invalid.sessionId, errorName: 'Error' }]);
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
        loadPage: async () => ({ candidates: finalCandidate ? [candidate] : [candidate, { ...candidate, sessionId: 'cs_test_later',
          checkoutPath: commerceKeys.stripeCheckout(candidate.dropId, 'cs_test_later').path }], hasMore: false }),
        probeBacklog: noBacklog,
        markEnqueued: async () => {},
        log: (entry) => { logs.push(entry); },
        error: () => {},
        onResult: (result) => { summaries.push(result); },
        nowMs: () => 2_000_000,
      });
      const summary = { attempted: 1, completed: fails ? 0 : 1, deferred: 0, skipped: 0, failed: fails ? 1 : 0,
        ...singlePageMetrics, stopReason: finalCandidate ? 'drained' : 'cancelled', hasMore: null };
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
    loadPage: async () => { throw failure; },
    probeBacklog: noBacklog,
    log: (entry) => { logs.push(entry); },
    onResult: (result) => { summaries.push(result); },
    nowMs: () => 2_000_000,
  }), (error: unknown) => error === failure);
  assert.deepEqual(summaries, [{ attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0,
    ...singlePageMetrics, inspected: 0, stopReason: 'failed' }]);
  assert.deepEqual(logs, []);
});

test('an aborted Stripe pass with an empty overridden candidate list still completes', async () => {
  const events: unknown[] = [];
  let loaded = false;
  const result = await reconcileStaleStripeFulfillments({
    COMMERCE_DB: createCommerceD1(),
    STRIPE_FULFILLMENT_QUEUE: queue(async () => assert.fail('empty pass must not enqueue')),
  }, AbortSignal.abort(new Error('cancelled')), {
    loadPage: async () => { loaded = true; return { candidates: [], hasMore: false }; },
    probeBacklog: noBacklog,
    log: (entry) => { events.push(entry); },
    onResult: (result) => { events.push(result); },
    nowMs: () => 2_000_000,
  });
  assert.equal(loaded, true);
  assert.deepEqual(result, { attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0,
    ...singlePageMetrics, inspected: 0, hasMore: null });
  assert.deepEqual(events, [
    { event: 'stripe_fulfillment_reconciliation_completed', candidates: 0, enqueued: 0, failed: 0 },
    result,
  ]);
});

test('Stripe reconciliation validates page bounds and checkout cursors before querying', async (context) => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  for (const limit of [0, -1, 1.5, 101, NaN, Infinity]) {
    await assert.rejects(repository.queryStaleStripeFulfillments(20, limit), { code: 'invalid-argument' });
  }
  for (const cutoff of [-1, 1.5, NaN, Infinity]) {
    await assert.rejects(repository.queryStaleStripeFulfillments(cutoff, 1), { code: 'invalid-argument' });
  }
  const invalidCursors: unknown[] = [
    null,
    { ...candidate, updatedAtMs: -1 },
    { ...candidate, updatedAtMs: 1.5 },
    { ...candidate, updatedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...candidate, updatedAtMs: '20' },
    { ...candidate, checkoutPath: 'invalid' },
    { ...candidate, checkoutPath: commerceKeys.deliveryOrder('drop', '1').path },
  ];
  for (const cursor of invalidCursors) {
    await assert.rejects(repository.queryStaleStripeFulfillments(20, 1, cursor as StripeCheckoutRequeueCursor),
      { code: 'invalid-argument' });
  }
  assert.deepEqual(calls, []);
});

test('Stripe reconciliation drains pages, keeps the 100-item cap, and resumes remaining work', async (context) => {
  for (const count of [8, 100, 102]) {
    const calls: CommerceD1CallObservation[] = [];
    const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
    context.after(() => harness.database.close());
    const sessionIds = Array.from({ length: count }, (_, index) => `cs_${String(index).padStart(3, '0')}`);
    seedCommerceDocuments(harness, sessionIds.map((sessionId) => ({
      key: commerceKeys.stripeCheckout('drop', sessionId),
      data: { fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
        lastStripeWebhookEventId: `evt_${sessionId}`, status: STRIPE_CHECKOUT_STATUS.PROCESSING, updatedAt: 20 },
    })));
    const sent: string[] = [];
    const env = {
      COMMERCE_DB: harness.db,
      STRIPE_FULFILLMENT_QUEUE: queue(async (job) => {
        const previous = sent.at(-1);
        if (previous) {
          const row = harness.database.prepare('SELECT updated_at_ms FROM commerce_stripe_checkout_state WHERE document_path = ?')
            .get(commerceKeys.stripeCheckout('drop', previous).path)!;
          assert.ok(Number(row.updated_at_ms) > 40);
        }
        sent.push((job as { sessionId: string }).sessionId);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      }),
    };
    const overrides = { nowMs: () => STRIPE_FULFILLMENT_REQUEUE_AFTER_MS + 40, log: () => {} };
    const result = await reconcileStaleStripeFulfillments(env, new AbortController().signal, overrides);
    const expectedCount = Math.min(100, count);
    assert.deepEqual(sent, sessionIds.slice(0, expectedCount));
    assert.deepEqual(result, { attempted: expectedCount, completed: expectedCount, deferred: 0, skipped: 0, failed: 0,
      inspected: expectedCount, pages: count === 8 ? 1 : 13, stopReason: count > 100 ? 'item-limit' : 'drained',
      hasMore: count > 100, oldestDueAgeMs: count > 100 ? 20 : null });
    const pageReads = calls.filter((call) => call.method === 'batch' && call.statements.some((statement) =>
      statement.sql.includes('INDEXED BY commerce_stripe_checkout_state_reconciliation_due')));
    assert.equal(pageReads.length, count === 8 ? 2 : 14);
    if (count > 100) {
      const resumed = await reconcileStaleStripeFulfillments(env, new AbortController().signal, overrides);
      assert.deepEqual(sent, sessionIds);
      assert.deepEqual(resumed, { attempted: 2, completed: 2, deferred: 0, skipped: 0, failed: 0,
        ...singlePageMetrics, inspected: 2 });
    }
  }
});

test('Stripe reconciliation keeps its cutoff fixed and reports failed work behind the page cursor', async (context) => {
  context.mock.method(console, 'error', () => {});
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const sessionIds = Array.from({ length: 10 }, (_, index) => `cs_${String(index).padStart(2, '0')}`);
  seedCommerceDocuments(harness, [...sessionIds, 'cs_future'].map((sessionId) => ({
    key: commerceKeys.stripeCheckout('drop', sessionId),
    data: { fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
      lastStripeWebhookEventId: `evt_${sessionId}`, status: STRIPE_CHECKOUT_STATUS.PROCESSING,
      updatedAt: sessionId === 'cs_future' ? 41 : 20 },
  })));
  let nowMs = STRIPE_FULFILLMENT_REQUEUE_AFTER_MS + 40;
  const sent: string[] = [];
  const summaries: unknown[] = [];
  await assert.rejects(reconcileStaleStripeFulfillments({
    COMMERCE_DB: harness.db,
    STRIPE_FULFILLMENT_QUEUE: queue(async (job) => {
      const { sessionId, enqueuedAtMs } = job as { sessionId: string; enqueuedAtMs: number };
      assert.equal(enqueuedAtMs, STRIPE_FULFILLMENT_REQUEUE_AFTER_MS + 40);
      sent.push(sessionId);
      nowMs += 10;
      if (sessionId === sessionIds[0]) throw new Error('queue unavailable');
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    }),
  }, new AbortController().signal, {
    nowMs: () => nowMs, log: () => {}, error: () => {}, onResult: (value) => { summaries.push(value); },
  }), /failed for 1 checkout/);
  assert.deepEqual(sent, sessionIds);
  assert.deepEqual(summaries, [{ attempted: 10, completed: 9, deferred: 0, skipped: 0, failed: 1,
    inspected: 10, pages: 2, stopReason: 'drained', hasMore: true, oldestDueAgeMs: 120 }]);
  const pending = await new D1CommerceRepository(harness.db).queryStaleStripeFulfillments(41);
  assert.deepEqual(pending.candidates.map((value) => value.sessionId), [sessionIds[0], 'cs_future']);
});

test('Stripe reconciliation preserves partial progress and error identity when a later page fails', async () => {
  const page = Array.from({ length: 8 }, (_, index) => ({ ...candidate, sessionId: `cs_${index}`,
    checkoutPath: commerceKeys.stripeCheckout(candidate.dropId, `cs_${index}`).path }));
  const failure = new Error('later page unavailable');
  const summaries: unknown[] = [];
  let sent = 0;
  let loads = 0;
  await assert.rejects(reconcileStaleStripeFulfillments({
    COMMERCE_DB: createCommerceD1(),
    STRIPE_FULFILLMENT_QUEUE: queue(async () => {
      sent += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    }),
  }, new AbortController().signal, {
    loadPage: async ({ startAfter, limit }) => {
      loads += 1;
      assert.equal(limit, 8);
      if (loads === 1) return { candidates: page, hasMore: true };
      assert.equal(startAfter?.checkoutPath, page.at(-1)?.checkoutPath);
      throw failure;
    },
    probeBacklog: async () => { throw new Error('backlog query unavailable'); },
    markEnqueued: async () => {}, log: () => {}, nowMs: () => 2_000_000,
    onResult: (value) => { summaries.push(value); },
  }), (error: unknown) => error === failure);
  assert.equal(sent, 8);
  assert.deepEqual(summaries, [{ attempted: 8, completed: 8, deferred: 0, skipped: 0, failed: 0,
    inspected: 8, pages: 2, stopReason: 'failed', hasMore: null, oldestDueAgeMs: null }]);
});

test('Stripe reconciliation does not fetch another page after cancellation during the final item of a page', async () => {
  const page = Array.from({ length: 8 }, (_, index) => ({ ...candidate, sessionId: `cs_${index}`,
    checkoutPath: commerceKeys.stripeCheckout(candidate.dropId, `cs_${index}`).path }));
  const controller = new AbortController();
  const cancellation = new Error('cancelled');
  const summaries: unknown[] = [];
  let sent = 0;
  let marked = 0;
  let loads = 0;
  await assert.rejects(reconcileStaleStripeFulfillments({
    COMMERCE_DB: createCommerceD1(),
    STRIPE_FULFILLMENT_QUEUE: queue(async () => {
      sent += 1;
      if (sent === 8) controller.abort(cancellation);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    }),
  }, controller.signal, {
    loadPage: async () => { loads += 1; return { candidates: page, hasMore: true }; },
    probeBacklog: async () => assert.fail('cancelled passes must not probe the backlog'),
    markEnqueued: async () => { marked += 1; }, log: () => {}, nowMs: () => 2_000_000,
    onResult: (value) => { summaries.push(value); },
  }), (error: unknown) => error === cancellation);
  assert.equal(loads, 1);
  assert.equal(sent, 8);
  assert.equal(marked, 8);
  assert.deepEqual(summaries, [{ attempted: 8, completed: 8, deferred: 0, skipped: 0, failed: 0,
    inspected: 8, pages: 1, stopReason: 'cancelled', hasMore: null, oldestDueAgeMs: null }]);
});
