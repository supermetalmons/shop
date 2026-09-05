import assert from 'node:assert/strict';
import test from 'node:test';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.ts';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { commerceKeys, D1CommerceRepository } from '../src/commerceRepository.ts';
import { stripeCheckoutWriteData } from '../src/stripeCheckout/commerce.ts';
import {
  createStripeTerminalNotificationOutboxFields,
  parseStripeTerminalNotificationOutbox,
} from '../src/stripeCheckout/notificationOutboxState.ts';
import { reconcilePendingStripeTerminalNotifications } from '../src/stripeCheckout/notificationReconciliation.ts';
import { runScheduledReconciliations } from '../src/workerScheduled.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';

const DROP_ID = 'card_nft_2';
const STRIPE_TERMINAL_NOTIFICATION_MAX_ATTEMPTS = 4;
const NOW = Date.UTC(2026, 8, 5);
const checkoutKey = (sessionId: string) => commerceKeys.stripeCheckout(DROP_ID, sessionId);

test('cron recovers fulfilled and manual-review notifications without fulfillment messages or historical backfill', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(NOW, async (transaction) => {
    await transaction.create(commerceKeys.deliveryOrder(DROP_ID, '7'), {
      deliveryId: 7, status: 'ready_to_ship', source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
      owner: 'anonymous:anon:recovery', addressSnapshot: { email: 'buyer@example.com' },
      items: [{ kind: 'box', refId: 3 }],
    });
    await transaction.create(checkoutKey('cs_fulfilled'), stripeCheckoutWriteData({
      status: 'fulfilled', deliveryId: 7,
      ...createStripeTerminalNotificationOutboxFields(null, 'fulfilled', NOW - 60_000),
    }));
    await transaction.create(checkoutKey('cs_manual'), stripeCheckoutWriteData({
      status: 'fulfillment_failed', manualRefundReviewRequired: true,
      owner: 'anonymous:anon:recovery', ownerKind: 'anonymous', authSubject: 'anon:recovery',
      ...createStripeTerminalNotificationOutboxFields(null, 'manual_review', NOW - 60_000),
    }));
    await transaction.create(checkoutKey('cs_historical'), { status: 'fulfilled', deliveryId: 7 });
    await transaction.create(checkoutKey('cs_processing'), stripeCheckoutWriteData({
      status: 'processing',
      ...createStripeTerminalNotificationOutboxFields(null, 'manual_review', NOW - 60_000),
    }));
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
    assert.equal((await repository.get(checkoutKey(sessionId)))?.data.stripeTerminalNotificationState, 'queued');
  }
  assert.equal((await repository.get(checkoutKey('cs_historical')))?.data.stripeTerminalNotificationState, undefined);
  assert.equal((await repository.get(checkoutKey('cs_processing')))?.data.stripeTerminalNotificationState, 'pending');
  assert.equal(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, {
    nowMs: () => NOW,
  }), 0);
  assert.equal(jobs.length, 3);
});

test('notification reconciliation continues past a failed publication and retains it for recovery', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(NOW, async (transaction) => {
    for (const sessionId of ['cs_a_fail', 'cs_b_success']) {
      await transaction.create(checkoutKey(sessionId), stripeCheckoutWriteData({
        status: 'fulfillment_failed', manualRefundReviewRequired: true,
        owner: 'anonymous:anon:recovery', ownerKind: 'anonymous', authSubject: 'anon:recovery',
        ...createStripeTerminalNotificationOutboxFields(null, 'manual_review', NOW),
      }));
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
  assert.equal((await repository.get(checkoutKey('cs_a_fail')))?.data.stripeTerminalNotificationState, 'pending');
  assert.equal((await repository.get(checkoutKey('cs_b_success')))?.data.stripeTerminalNotificationState, 'queued');
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
  const repository = new D1CommerceRepository(harness.db);
  const cancelled = checkoutKey('cs_a_cancelled');
  const next = checkoutKey('cs_b_next');
  await repository.run(NOW, async (transaction) => {
    for (const key of [cancelled, next]) {
      await transaction.create(key, stripeCheckoutWriteData({
        status: 'fulfillment_failed', manualRefundReviewRequired: true,
        owner: 'anonymous:anon:recovery', ownerKind: 'anonymous', authSubject: 'anon:recovery',
        ...createStripeTerminalNotificationOutboxFields(null, 'manual_review', NOW),
      }));
    }
  });
  const initialOutbox = parseStripeTerminalNotificationOutbox((await repository.get(cancelled))?.data.stripeTerminalNotification);
  assert.ok(initialOutbox);
  const nextBefore = (await repository.get(next))?.data;
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
    const checkout = (await repository.get(cancelled))?.data;
    assert.ok(checkout);
    const outbox = parseStripeTerminalNotificationOutbox(checkout.stripeTerminalNotification);
    assert.ok(outbox);
    assert.equal(outbox.attemptCount, 0);
    assert.equal(outbox.claimId, undefined);
    assert.deepEqual(outbox.jobIds, initialOutbox.jobIds);
    assert.equal(checkout.stripeTerminalNotificationState, 'pending');
    assert.equal(checkout.stripeTerminalNotificationNextAttemptAtMs, NOW);
    assert.deepEqual((await repository.get(next))?.data, nextBefore);
    assert.equal(jobs.length, 0);
  }
  assert.equal(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, {
    nowMs: () => NOW,
  }), 2);
  assert.deepEqual(jobs.map((job) => job.context.sessionId), ['cs_a_cancelled', 'cs_b_next']);
  assert.equal(jobs[0].jobId, initialOutbox.jobIds.stripe_checkout_manual_review);
  assert.equal((await repository.get(cancelled))?.data.stripeTerminalNotificationState, 'queued');
  assert.equal((await repository.get(next))?.data.stripeTerminalNotificationState, 'queued');
  assert.equal(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, {
    nowMs: () => NOW,
  }), 0);
  assert.equal(jobs.length, 2);
});
