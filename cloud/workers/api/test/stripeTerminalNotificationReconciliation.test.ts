import assert from 'node:assert/strict';
import test from 'node:test';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.ts';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { createStripeCheckoutStore } from '../src/stripeCheckout/store.ts';
import {
  createStripeTerminalNotificationOutboxFields,
  parseStripeTerminalNotificationOutbox,
  STRIPE_TERMINAL_NOTIFICATION_MAX_ATTEMPTS,
} from '../src/stripeCheckout/notificationOutboxState.ts';
import { reconcilePendingStripeTerminalNotifications } from '../src/stripeCheckout/notificationReconciliation.ts';
import { runScheduledReconciliations } from '../src/workerScheduled.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';

const DROP_ID = 'card_nft_2';
const NOW = Date.UTC(2026, 8, 5);
const checkoutPath = (sessionId: string) => `drops/${DROP_ID}/stripeCheckouts/${sessionId}`;

test('cron recovers fulfilled and manual-review notifications without fulfillment messages or historical backfill', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const store = createStripeCheckoutStore({ commerceDb: harness.db, nowMs: () => NOW });
  await store.runTransaction(async (transaction) => {
    transaction.create(store.doc(`drops/${DROP_ID}/deliveryOrders/7`), {
      deliveryId: 7, status: 'ready_to_ship', source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
      owner: 'anonymous:anon:recovery', addressSnapshot: { email: 'buyer@example.com' },
      items: [{ kind: 'box', refId: 3 }],
    });
    transaction.create(store.doc(checkoutPath('cs_fulfilled')), {
      status: 'fulfilled', deliveryId: 7,
      ...createStripeTerminalNotificationOutboxFields(null, 'fulfilled', NOW - 60_000),
    });
    transaction.create(store.doc(checkoutPath('cs_manual')), {
      status: 'fulfillment_failed', manualRefundReviewRequired: true,
      owner: 'anonymous:anon:recovery', ownerKind: 'anonymous', authSubject: 'anon:recovery',
      ...createStripeTerminalNotificationOutboxFields(null, 'manual_review', NOW - 60_000),
    });
    transaction.create(store.doc(checkoutPath('cs_historical')), { status: 'fulfilled', deliveryId: 7 });
    transaction.create(store.doc(checkoutPath('cs_processing')), {
      status: 'processing',
      ...createStripeTerminalNotificationOutboxFields(null, 'manual_review', NOW - 60_000),
    });
  });
  const jobs: NotificationEmailJobV1[] = [];
  const env = {
    COMMERCE_DB: harness.db,
    NOTIFICATION_EMAIL_QUEUE: {
      sendBatch: async (messages: Iterable<MessageSendRequest<NotificationEmailJobV1>>) => {
        jobs.push(...Array.from(messages, (message) => message.body));
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
  } as Env;
  await runScheduledReconciliations(env, new AbortController().signal, {
    notifications: async () => 0,
    ops: async () => undefined,
    packStatus: async () => 0,
    stripe: async () => ({ enqueued: 0, failed: 0 }),
    stripeNotifications: (bindings, signal) => reconcilePendingStripeTerminalNotifications(bindings, signal, {
      nowMs: () => NOW,
    }),
  });
  assert.deepEqual(jobs.map((job) => job.kind).sort(), [
    'buyer_order_received', 'shipper_ready_to_ship', 'stripe_checkout_manual_review',
  ]);
  for (const sessionId of ['cs_fulfilled', 'cs_manual']) {
    assert.equal((await store.doc(checkoutPath(sessionId)).get()).get('stripeTerminalNotificationState'), 'queued');
  }
  assert.equal((await store.doc(checkoutPath('cs_historical')).get()).get('stripeTerminalNotificationState'), undefined);
  assert.equal((await store.doc(checkoutPath('cs_processing')).get()).get('stripeTerminalNotificationState'), 'pending');
  assert.equal(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, {
    nowMs: () => NOW,
  }), 0);
  assert.equal(jobs.length, 3);
});

test('notification reconciliation continues past a failed publication and retains it for recovery', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const store = createStripeCheckoutStore({ commerceDb: harness.db, nowMs: () => NOW });
  await store.runTransaction(async (transaction) => {
    for (const sessionId of ['cs_a_fail', 'cs_b_success']) {
      transaction.create(store.doc(checkoutPath(sessionId)), {
        status: 'fulfillment_failed', manualRefundReviewRequired: true,
        owner: 'anonymous:anon:recovery', ownerKind: 'anonymous', authSubject: 'anon:recovery',
        ...createStripeTerminalNotificationOutboxFields(null, 'manual_review', NOW),
      });
    }
  });
  const failure = new Error('queue temporarily unavailable');
  const env = {
    COMMERCE_DB: harness.db,
    NOTIFICATION_EMAIL_QUEUE: {
      sendBatch: async (messages: Iterable<MessageSendRequest<NotificationEmailJobV1>>) => {
        if (Array.from(messages)[0].body.context.sessionId === 'cs_a_fail') throw failure;
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
  } as Env;
  await assert.rejects(reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, {
    nowMs: () => NOW,
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.equal((await store.doc(checkoutPath('cs_a_fail')).get()).get('stripeTerminalNotificationState'), 'pending');
  assert.equal((await store.doc(checkoutPath('cs_b_success')).get()).get('stripeTerminalNotificationState'), 'queued');
});

test('cancelled reconciliation releases unused claims and preserves every notification for retry', async (context) => {
  let cancelAfterCommit: AbortController | undefined;
  const harness = createCommerceD1Harness({
    observeBatchAfterCommit: ({ statements }) => {
      if (!cancelAfterCommit || !statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))) return;
      const controller = cancelAfterCommit;
      cancelAfterCommit = undefined;
      controller.abort(new Error('scheduled reconciliation timed out'));
    },
  });
  context.after(() => harness.database.close());
  context.mock.method(console, 'log', () => undefined);
  context.mock.method(console, 'error', () => undefined);
  const store = createStripeCheckoutStore({ commerceDb: harness.db, nowMs: () => NOW });
  const cancelled = store.doc(checkoutPath('cs_a_cancelled'));
  const next = store.doc(checkoutPath('cs_b_next'));
  await store.runTransaction(async (transaction) => {
    for (const reference of [cancelled, next]) {
      transaction.create(reference, {
        status: 'fulfillment_failed', manualRefundReviewRequired: true,
        owner: 'anonymous:anon:recovery', ownerKind: 'anonymous', authSubject: 'anon:recovery',
        ...createStripeTerminalNotificationOutboxFields(null, 'manual_review', NOW),
      });
    }
  });
  const initialOutbox = parseStripeTerminalNotificationOutbox((await cancelled.get()).get('stripeTerminalNotification'));
  assert.ok(initialOutbox);
  const nextBefore = (await next.get()).data();
  const jobs: NotificationEmailJobV1[] = [];
  const env = {
    COMMERCE_DB: harness.db,
    NOTIFICATION_EMAIL_QUEUE: {
      sendBatch: async (messages: Iterable<MessageSendRequest<NotificationEmailJobV1>>) => {
        jobs.push(...Array.from(messages, (message) => message.body));
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
  } as Env;
  for (let attempt = 0; attempt < STRIPE_TERMINAL_NOTIFICATION_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    cancelAfterCommit = controller;
    await assert.rejects(reconcilePendingStripeTerminalNotifications(env, controller.signal, {
      nowMs: () => NOW,
    }), AggregateError);
    const checkout = await cancelled.get();
    const outbox = parseStripeTerminalNotificationOutbox(checkout.get('stripeTerminalNotification'));
    assert.ok(outbox);
    assert.equal(outbox.attemptCount, 0);
    assert.equal(outbox.claimId, undefined);
    assert.deepEqual(outbox.jobIds, initialOutbox.jobIds);
    assert.equal(checkout.get('stripeTerminalNotificationState'), 'pending');
    assert.equal(checkout.get('stripeTerminalNotificationNextAttemptAtMs'), NOW);
    assert.deepEqual((await next.get()).data(), nextBefore);
    assert.equal(jobs.length, 0);
  }
  assert.equal(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, {
    nowMs: () => NOW,
  }), 2);
  assert.deepEqual(jobs.map((job) => job.context.sessionId), ['cs_a_cancelled', 'cs_b_next']);
  assert.equal(jobs[0].jobId, initialOutbox.jobIds.stripe_checkout_manual_review);
  assert.equal((await cancelled.get()).get('stripeTerminalNotificationState'), 'queued');
  assert.equal((await next.get()).get('stripeTerminalNotificationState'), 'queued');
  assert.equal(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, {
    nowMs: () => NOW,
  }), 0);
  assert.equal(jobs.length, 2);
});
