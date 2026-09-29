import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { commerceKeys } from '../src/commerceRepository.ts';
import { reconcilePendingStripeTerminalNotifications } from '../src/stripeCheckout/notificationReconciliation.ts';
import { createStripeTerminalNotificationIntent, notificationFixture, OUTBOX_NOW, OUTBOX_DROP } from './notificationOutboxTestSupport.ts';

async function addManualNotifications(state: Awaited<ReturnType<typeof notificationFixture>>, sessionIds: string[]) {
  await state.repository.run(OUTBOX_NOW, async (unit) => {
    for (const sessionId of sessionIds) {
      const key = commerceKeys.stripeCheckout(OUTBOX_DROP, sessionId);
      await unit.create(key, { status: 'fulfillment_failed', manualRefundReviewRequired: true,
        owner: 'anonymous:anon:recovery', ownerKind: 'anonymous', authSubject: 'anon:recovery' });
      await unit.enqueueNotificationOutbox(createStripeTerminalNotificationIntent({
        parentPath: key.path, dropId: OUTBOX_DROP, sessionId, outcome: 'manual_review', nowMs: OUTBOX_NOW,
      }));
    }
  });
}

test('cron recovers terminal notification rows without backfilling historical checkouts', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal');
  const manual = commerceKeys.stripeCheckout(OUTBOX_DROP, 'cs_manual');
  const historical = commerceKeys.stripeCheckout(OUTBOX_DROP, 'cs_historical');
  await state.repository.run(OUTBOX_NOW, async (unit) => {
    await unit.create(manual, { status: 'fulfillment_failed', manualRefundReviewRequired: true,
      owner: 'anonymous:anon:recovery', ownerKind: 'anonymous', authSubject: 'anon:recovery' });
    await unit.enqueueNotificationOutbox(createStripeTerminalNotificationIntent({
      parentPath: manual.path, dropId: OUTBOX_DROP, sessionId: manual.documentId,
      outcome: 'manual_review', nowMs: OUTBOX_NOW,
    }));
    await unit.create(historical, { status: 'fulfilled', deliveryId: 7 });
  });
  const env = { COMMERCE_DB: state.harness.db, NOTIFICATION_EMAIL_QUEUE: state.queue };
  assert.equal(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, { nowMs: () => OUTBOX_NOW }), 3);
  assert.deepEqual(state.sent.flat().map((job) => job.kind).sort(), [
    'buyer_order_received', 'shipper_ready_to_ship', 'stripe_checkout_manual_review',
  ]);
  assert.equal(await state.repository.notificationOutbox.get(historical.path, 'stripe_terminal'), null);
  assert.equal(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, { nowMs: () => OUTBOX_NOW }), 0);
});

test('reconciliation continues after Queue failure and preserves the failed publication for recovery', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal', { outcome: 'manual_review' });
  const other = commerceKeys.stripeCheckout(OUTBOX_DROP, 'cs_other');
  await state.repository.run(OUTBOX_NOW, async (unit) => {
    await unit.create(other, { status: 'fulfillment_failed', manualRefundReviewRequired: true,
      owner: 'anonymous:anon:recovery', ownerKind: 'anonymous', authSubject: 'anon:recovery' });
    await unit.enqueueNotificationOutbox(createStripeTerminalNotificationIntent({
      parentPath: other.path, dropId: OUTBOX_DROP, sessionId: other.documentId,
      outcome: 'manual_review', nowMs: OUTBOX_NOW,
    }));
  });
  const failure = new Error('queue unavailable');
  const env = { COMMERCE_DB: state.harness.db, NOTIFICATION_EMAIL_QUEUE: { sendBatch: async (
    messages: Iterable<MessageSendRequest<NotificationEmailJobV1>>,
  ) => {
    const jobs = Array.from(messages);
    if (jobs[0].body.context.sessionId === state.parentKey.documentId) throw failure;
    return state.queue.sendBatch(jobs);
  } } };
  await assert.rejects(reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, { nowMs: () => OUTBOX_NOW }),
    (error: unknown) => error instanceof AggregateError && error.errors[0] === failure);
  assert.equal((await state.read()).state, 'pending');
  assert.equal((await state.repository.notificationOutbox.get(other.path, 'stripe_terminal'))?.state, 'queued');
});

test('Stripe recovery drains at most twenty checkouts per pass', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal', { create: false });
  const sessionIds = Array.from({ length: 21 }, (_, index) => `cs_${100 + index}`);
  await addManualNotifications(state, sessionIds);
  const env = { COMMERCE_DB: state.harness.db, NOTIFICATION_EMAIL_QUEUE: state.queue };
  assert.equal(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, { nowMs: () => OUTBOX_NOW }), 20);
  assert.deepEqual(state.sent.flat().map((job) => job.context.sessionId), sessionIds.slice(0, 20));
  const lastKey = commerceKeys.stripeCheckout(OUTBOX_DROP, sessionIds[20]);
  assert.equal((await state.repository.notificationOutbox.get(lastKey.path, 'stripe_terminal'))?.attemptCount, 0);
  assert.equal(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, { nowMs: () => OUTBOX_NOW }), 1);
  assert.deepEqual(state.sent.flat().map((job) => job.context.sessionId), sessionIds);
});

test('Stripe recovery finalizes an accepted enqueue before cancellation stops later checkouts', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal', { create: false });
  await addManualNotifications(state, ['cs_100', 'cs_101']);
  const controller = new AbortController();
  const cancellation = new Error('scheduled reconciliation cancelled');
  const env = { COMMERCE_DB: state.harness.db, NOTIFICATION_EMAIL_QUEUE: { sendBatch: async (
    messages: Iterable<MessageSendRequest<NotificationEmailJobV1>>,
  ) => {
    const result = await state.queue.sendBatch(messages);
    controller.abort(cancellation);
    return result;
  } } };
  await assert.rejects(reconcilePendingStripeTerminalNotifications(env, controller.signal, { nowMs: () => OUTBOX_NOW }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'Stripe terminal notification reconciliation failed');
      assert.deepEqual(error.errors, [cancellation]);
      return true;
    });
  assert.deepEqual(state.sent.flat().map((job) => job.context.sessionId), ['cs_100']);
  const first = await state.repository.notificationOutbox.get(commerceKeys.stripeCheckout(OUTBOX_DROP, 'cs_100').path, 'stripe_terminal');
  const second = await state.repository.notificationOutbox.get(commerceKeys.stripeCheckout(OUTBOX_DROP, 'cs_101').path, 'stripe_terminal');
  assert.equal(first?.state, 'queued');
  assert.equal(second?.state, 'pending');
  assert.equal(second?.attemptCount, 0);
});
