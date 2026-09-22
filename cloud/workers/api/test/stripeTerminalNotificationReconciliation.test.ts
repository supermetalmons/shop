import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { commerceKeys } from '../src/commerceRepository.ts';
import { reconcilePendingStripeTerminalNotifications } from '../src/stripeCheckout/notificationReconciliation.ts';
import { createStripeTerminalNotificationIntent, notificationFixture, OUTBOX_NOW, OUTBOX_DROP } from './notificationOutboxTestSupport.ts';

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
