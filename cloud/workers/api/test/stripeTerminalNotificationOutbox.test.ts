import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { commerceKeys, D1CommerceRepository } from '../src/commerceRepository.ts';
import { createStripeCheckoutStore } from '../src/stripeCheckout/store.ts';
import { publishPendingStripeCheckoutTerminalNotifications } from '../src/stripeCheckout/notificationOutbox.ts';
import {
  createStripeTerminalNotificationOutboxFields,
  parseStripeTerminalNotificationOutbox,
  STRIPE_TERMINAL_NOTIFICATION_FIELD,
  STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD,
  STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD,
  STRIPE_TERMINAL_NOTIFICATION_LEASE_MS,
  STRIPE_TERMINAL_NOTIFICATION_MAX_ATTEMPTS,
  STRIPE_TERMINAL_NOTIFICATION_RETRY_WINDOW_MS,
  type StripeTerminalNotificationOutcome,
} from '../src/stripeCheckout/notificationOutboxState.ts';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.ts';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

const NOW_MS = 1_800_000_000_000;
const DROP_ID = 'card_nft_2';
const SESSION_ID = 'cs_test_terminal_outbox';
const CHECKOUT_PATH = `drops/${DROP_ID}/stripeCheckouts/${SESSION_ID}`;
const ORDER_PATH = `drops/${DROP_ID}/deliveryOrders/7`;
type PublicationOptions = Parameters<typeof publishPendingStripeCheckoutTerminalNotifications>[0];

async function fixture(context: TestContext, options: {
  outcome?: StripeTerminalNotificationOutcome;
  markerTimeMs?: number;
  harness?: Parameters<typeof createCommerceD1Harness>[0];
} = {}) {
  const harness = createCommerceD1Harness(options.harness);
  context.after(() => harness.database.close());
  context.mock.method(console, 'log', () => undefined);
  context.mock.method(console, 'error', () => undefined);
  const outcome = options.outcome || 'fulfilled';
  seedCommerceDocument(harness, {
    key: commerceKeys.stripeCheckout(DROP_ID, SESSION_ID),
    data: {
      status: outcome === 'fulfilled' ? 'fulfilled' : 'fulfillment_failed',
      deliveryId: 7,
      manualRefundReviewRequired: outcome === 'manual_review',
      manualRefundReviewReason: 'fulfillment_failed_after_payment',
      owner: 'anonymous:anon:terminal-outbox',
      ownerKind: 'anonymous',
      authSubject: 'anon:terminal-outbox',
    },
  });
  seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder(DROP_ID, '7'),
    data: {
      source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
      status: 'ready_to_ship',
      deliveryId: 7,
      owner: 'anonymous:anon:terminal-outbox',
      addressSnapshot: { email: 'buyer@example.com', name: 'Original Buyer' },
      items: [{ kind: 'box', refId: 3 }],
    },
  });
  let nowMs = NOW_MS;
  const store = createStripeCheckoutStore({ commerceDb: harness.db, nowMs: () => nowMs });
  const reference = store.doc(CHECKOUT_PATH);
  await reference.update(createStripeTerminalNotificationOutboxFields(null, outcome, options.markerTimeMs ?? nowMs));
  const sent: NotificationEmailJobV1[][] = [];
  const queue: PublicationOptions['queue'] = {
    sendBatch: async (messages) => {
      sent.push([...messages].map((message) => structuredClone(message.body)));
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  };
  const read = async () => {
    const checkout = (await new D1CommerceRepository(harness.db)
      .get(commerceKeys.stripeCheckout(DROP_ID, SESSION_ID)))?.data;
    assert.ok(checkout);
    return checkout;
  };
  const outbox = async () => {
    const value = parseStripeTerminalNotificationOutbox((await read())[STRIPE_TERMINAL_NOTIFICATION_FIELD]);
    assert.ok(value);
    return value;
  };
  return {
    harness,
    store,
    reference,
    queue,
    sent,
    read,
    outbox,
    setTime: (value: number) => { nowMs = value; },
    publish: (overrides: Partial<PublicationOptions> = {}) => publishPendingStripeCheckoutTerminalNotifications({
      store,
      dropId: DROP_ID,
      sessionId: SESSION_ID,
      queue,
      signal: new AbortController().signal,
      getDropName: () => 'Card NFT 2',
      nowMs: () => nowMs,
      ...overrides,
    }),
  };
}

test('failed queue publication retains the pending outbox and exact jobs for a later retry', async (context) => {
  const state = await fixture(context);
  const originalJobIds = (await state.outbox()).jobIds;
  const unavailable = new Error('queue unavailable');
  await assert.rejects(state.publish({ queue: {
    sendBatch: async (messages) => {
      await state.queue.sendBatch(messages);
      throw unavailable;
    },
  } }), (error: unknown) => error === unavailable);

  const failed = await state.outbox();
  assert.equal((await state.read())[STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD], 'pending');
  assert.equal((await state.read())[STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD], NOW_MS + STRIPE_TERMINAL_NOTIFICATION_LEASE_MS);
  assert.equal(failed.attemptCount, 1);
  assert.deepEqual(failed.jobIds, originalJobIds);
  assert.deepEqual(failed.jobs, state.sent[0]);
  assert.equal(state.sent[0].length, 2);
  assert.deepEqual(state.sent[0].map((job) => job.jobId), [
    originalJobIds.buyer_order_received,
    originalJobIds.shipper_ready_to_ship,
  ]);

  assert.deepEqual(await state.publish(), { outcome: 'fulfilled', publication: 'busy', queuedJobs: 0 });
  assert.equal(state.sent.length, 1);
  await state.store.doc(ORDER_PATH).update({
    addressSnapshot: { email: 'changed@example.com', name: 'Changed Buyer' },
    items: [{ kind: 'box', refId: 99 }],
  });
  state.setTime(NOW_MS + STRIPE_TERMINAL_NOTIFICATION_LEASE_MS + 1);
  assert.deepEqual(await state.publish(), { outcome: 'fulfilled', publication: 'queued', queuedJobs: 2 });
  assert.deepEqual(state.sent[1], state.sent[0]);
  assert.equal((await state.read())[STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD], 'queued');
  assert.equal((await state.outbox()).attemptCount, 2);
});

test('queued outboxes never publish again or retain email payloads', async (context) => {
  const state = await fixture(context);
  await state.publish();
  state.setTime(NOW_MS + STRIPE_TERMINAL_NOTIFICATION_RETRY_WINDOW_MS + 1);
  assert.deepEqual(await state.publish(), { outcome: 'fulfilled', publication: 'queued', queuedJobs: 0 });
  assert.equal(state.sent.length, 1);
  const checkout = await state.read();
  assert.equal(checkout[STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD], undefined);
  assert.equal((await state.outbox()).jobs, undefined);
  assert.equal((await state.outbox()).claimId, undefined);
});

test('concurrent D1 publishers claim one notification batch', { timeout: 5_000 }, async (context) => {
  const state = await fixture(context);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const queue: PublicationOptions['queue'] = {
    sendBatch: async (messages) => {
      const result = await state.queue.sendBatch(messages);
      started.resolve();
      await release.promise;
      return result;
    },
  };
  const competingStore = createStripeCheckoutStore({ commerceDb: state.harness.db, nowMs: () => NOW_MS });
  const first = state.publish({ queue });
  const second = state.publish({ store: competingStore, queue });
  await started.promise;
  try {
    assert.deepEqual(await Promise.race([first, second]), {
      outcome: 'fulfilled', publication: 'busy', queuedJobs: 0,
    });
    assert.equal(state.sent.length, 1);
    assert.equal((await state.outbox()).attemptCount, 1);
  } finally {
    release.resolve();
  }
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.queuedJobs).sort(), [0, 2]);
  assert.deepEqual(results.map((result) => result.publication).sort(), ['busy', 'queued']);
});

test('successful queue send followed by failed D1 finalization retries the same stored jobs', async (context) => {
  let failNextBatch = false;
  const state = await fixture(context, { harness: {
    observeCall: (call) => {
      if (call.method === 'batch' && failNextBatch) {
        failNextBatch = false;
        throw new Error('D1 finalization unavailable');
      }
    },
  } });
  await assert.rejects(state.publish({ queue: {
    sendBatch: async (messages) => {
      const result = await state.queue.sendBatch(messages);
      failNextBatch = true;
      return result;
    },
  } }));
  assert.equal((await state.read())[STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD], 'pending');
  assert.deepEqual((await state.outbox()).jobs, state.sent[0]);

  state.setTime(NOW_MS + STRIPE_TERMINAL_NOTIFICATION_LEASE_MS + 1);
  await state.publish();
  assert.equal(state.sent.length, 2);
  assert.deepEqual(state.sent[1], state.sent[0]);
  assert.equal((await state.read())[STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD], 'queued');
});

test('overdue initial pending outboxes start their retry window when first claimed', async (context) => {
  const state = await fixture(context, {
    markerTimeMs: NOW_MS - STRIPE_TERMINAL_NOTIFICATION_RETRY_WINDOW_MS - 1,
  });
  assert.ok((await state.outbox()).retryUntilMs < NOW_MS);
  assert.deepEqual(await state.publish(), { outcome: 'fulfilled', publication: 'queued', queuedJobs: 2 });
  assert.equal((await state.outbox()).retryUntilMs, NOW_MS + STRIPE_TERMINAL_NOTIFICATION_RETRY_WINDOW_MS);
  assert.equal(state.sent.length, 1);
});

test('manual-review notification publication uses its durable job ID and checkout content', async (context) => {
  const state = await fixture(context, { outcome: 'manual_review' });
  const jobId = (await state.outbox()).jobIds.stripe_checkout_manual_review;
  assert.deepEqual(await state.publish(), { outcome: 'manual_review', publication: 'queued', queuedJobs: 1 });
  const [job] = state.sent[0];
  assert.equal(job.jobId, jobId);
  assert.equal(job.kind, 'stripe_checkout_manual_review');
  assert.equal(job.idempotencyKey, `${DROP_ID}:${SESSION_ID}:stripe_manual_review`);
  assert.deepEqual(job.context, { dropId: DROP_ID, sessionId: SESSION_ID });
  assert.match(job.text, /fulfillment_failed_after_payment/);
  assert.match(job.text, /Auth subject: anon:terminal-outbox/);
  await state.publish();
  assert.equal(state.sent.length, 1);
});

test('expired retries and exhausted attempt budgets fail without sending', async (context) => {
  for (const exhausted of ['window', 'attempts'] as const) {
    await context.test(exhausted, async (subcontext) => {
      const state = await fixture(subcontext);
      const outbox = await state.outbox();
      await state.reference.update({
        [STRIPE_TERMINAL_NOTIFICATION_FIELD]: {
          ...outbox,
          attemptCount: exhausted === 'attempts' ? STRIPE_TERMINAL_NOTIFICATION_MAX_ATTEMPTS : 1,
          retryUntilMs: exhausted === 'window' ? NOW_MS : outbox.retryUntilMs,
        },
      });
      assert.deepEqual(await state.publish(), {
        outcome: 'fulfilled', publication: 'failed', queuedJobs: 0, reason: 'manual-review-required',
      });
      assert.equal(state.sent.length, 0);
      assert.equal((await state.read())[STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD], 'failed');
      assert.equal((await state.read())[STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD], undefined);
    });
  }
});

test('an already aborted publication does not claim or send jobs', async (context) => {
  const state = await fixture(context);
  const before = await state.read();
  const aborted = new Error('caller cancelled');
  const signal = AbortSignal.abort(aborted);
  await assert.rejects(state.publish({ signal }), (error: unknown) => error === aborted);
  assert.deepEqual(await state.read(), before);
  assert.equal(state.sent.length, 0);
});

test('cancellation after claiming but before queue send releases its unused attempt', async (context) => {
  const controller = new AbortController();
  const aborted = new Error('caller cancelled before send');
  let cancelNextCommit = false;
  const state = await fixture(context, { harness: {
    observeBatchAfterCommit: () => {
      if (cancelNextCommit) {
        cancelNextCommit = false;
        controller.abort(aborted);
      }
    },
  } });
  cancelNextCommit = true;
  await assert.rejects(state.publish({ signal: controller.signal }), (error: unknown) => error === aborted);
  assert.equal(state.sent.length, 0);
  assert.equal((await state.outbox()).attemptCount, 0);
  assert.equal((await state.outbox()).claimId, undefined);
  assert.equal((await state.read())[STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD], NOW_MS);
  assert.deepEqual(await state.publish(), { outcome: 'fulfilled', publication: 'queued', queuedJobs: 2 });
});
