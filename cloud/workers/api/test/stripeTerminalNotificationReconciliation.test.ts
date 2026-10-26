import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { commerceKeys, D1CommerceRepository } from '../src/commerceRepository.ts';
import { dueStripeTerminalNotificationsQuery } from '../src/commerceQueries.ts';
import { NotificationOutboxRepository } from '../src/notificationOutboxRepository.ts';
import { reconcilePendingStripeTerminalNotifications } from '../src/stripeCheckout/notificationReconciliation.ts';
import { createStripeTerminalNotificationIntent, notificationFixture, OUTBOX_NOW, OUTBOX_DROP, OUTBOX_LEASE } from './notificationOutboxTestSupport.ts';

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
  assert.partialDeepStrictEqual(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, { nowMs: () => OUTBOX_NOW }), { attempted: 2, completed: 2, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(state.sent.flat().map((job) => job.kind).sort(), [
    'buyer_order_received', 'shipper_ready_to_ship', 'stripe_checkout_manual_review',
  ]);
  assert.equal(await state.repository.notificationOutbox.get(historical.path, 'stripe_terminal'), null);
  assert.partialDeepStrictEqual(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, { nowMs: () => OUTBOX_NOW }), { attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0 });
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
  assert.deepEqual(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, { nowMs: () => OUTBOX_NOW }), {
    attempted: 20, completed: 20, deferred: 0, skipped: 0, failed: 0,
    inspected: 20, pages: 3, stopReason: 'item-limit', hasMore: true, oldestDueAgeMs: 0,
  });
  assert.deepEqual(state.sent.flat().map((job) => job.context.sessionId), sessionIds.slice(0, 20));
  const lastKey = commerceKeys.stripeCheckout(OUTBOX_DROP, sessionIds[20]);
  assert.equal((await state.repository.notificationOutbox.get(lastKey.path, 'stripe_terminal'))?.attemptCount, 0);
  assert.partialDeepStrictEqual(await reconcilePendingStripeTerminalNotifications(env, new AbortController().signal, { nowMs: () => OUTBOX_NOW }), { attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(state.sent.flat().map((job) => job.context.sessionId), sessionIds);
});

test('Stripe notification keysets preserve due-time ties and use the existing index', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal', { create: false });
  await addManualNotifications(state, ['cs_100', 'cs_101', 'cs_102', 'cs_103']);
  for (const [sessionId, due] of [['cs_100', OUTBOX_NOW - 1], ['cs_103', OUTBOX_NOW + 1]] as const) {
    state.harness.database.prepare('UPDATE commerce_notification_outbox SET next_attempt_at_ms = ?, revision = revision + 1 WHERE parent_path = ?')
      .run(due, commerceKeys.stripeCheckout(OUTBOX_DROP, sessionId).path);
  }
  const first = await state.repository.queryDueStripeTerminalNotifications(OUTBOX_NOW, 2);
  assert.deepEqual(first.candidates.map(({ key, nextAttemptAtMs }) => [key.documentId, nextAttemptAtMs]), [
    ['cs_100', OUTBOX_NOW - 1], ['cs_101', OUTBOX_NOW],
  ]);
  assert.equal(first.hasMore, true);
  const startAfter = { family: 'stripe_terminal' as const, parentPath: first.candidates[1].key.path, nextAttemptAtMs: OUTBOX_NOW };
  const next = await state.repository.queryDueStripeTerminalNotifications(OUTBOX_NOW, 2, startAfter);
  assert.deepEqual(next.candidates.map(({ key }) => key.documentId), ['cs_102']);
  assert.equal(next.hasMore, false);
  const query = dueStripeTerminalNotificationsQuery({ dueAtMs: OUTBOX_NOW, limit: 3, startAfter });
  const plan = JSON.stringify(state.harness.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings));
  assert.match(plan, /SEARCH due USING (?:COVERING )?INDEX commerce_notification_outbox_stripe_due_at/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
  for (const nextAttemptAtMs of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(state.repository.queryDueStripeTerminalNotifications(OUTBOX_NOW, 2, { ...startAfter, nextAttemptAtMs }),
      { code: 'invalid-argument' });
  }
  await assert.rejects(state.repository.queryDueStripeTerminalNotifications(OUTBOX_NOW, 2, { ...startAfter, family: 'ready' }),
    { code: 'invalid-argument' });
});

test('Stripe notification pages keep the original due cutoff while publication advances time', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal', { create: false });
  const sessionIds = Array.from({ length: 10 }, (_, index) => `cs_${100 + index}`);
  await addManualNotifications(state, sessionIds);
  const future = commerceKeys.stripeCheckout(OUTBOX_DROP, sessionIds[9]);
  state.harness.database.prepare('UPDATE commerce_notification_outbox SET next_attempt_at_ms = ?, revision = revision + 1 WHERE parent_path = ?')
    .run(OUTBOX_NOW + 1, future.path);
  const result = await reconcilePendingStripeTerminalNotifications({
    COMMERCE_DB: state.harness.db,
    NOTIFICATION_EMAIL_QUEUE: { sendBatch: async (messages) => {
      state.setTime(OUTBOX_NOW + 1000);
      return state.queue.sendBatch(messages);
    } },
  }, new AbortController().signal, { nowMs: state.nowMs });
  assert.equal(result.completed, 9);
  assert.equal(result.pages, 2);
  assert.equal(result.hasMore, false);
  assert.deepEqual(state.sent.flat().map((job) => job.context.sessionId), sessionIds.slice(0, 9));
  assert.equal((await state.repository.notificationOutbox.get(future.path, 'stripe_terminal'))?.attemptCount, 0);
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

for (const discovery of ['empty', 'candidate', 'failure'] as const) {
  test(`Stripe recovery awaits initial ${discovery} discovery after cancellation`, async (context) => {
    const state = await notificationFixture(context, 'stripe_terminal', { create: discovery === 'candidate' });
    const controller = new AbortController();
    const cancellation = new Error('cancelled during discovery');
    const queryFailure = new Error('discovery failed');
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    context.after(() => release.resolve());
    const query = D1CommerceRepository.prototype.queryDueStripeTerminalNotifications;
    context.mock.method(D1CommerceRepository.prototype, 'queryDueStripeTerminalNotifications', async function (
      this: D1CommerceRepository, ...args: Parameters<typeof query>
    ) {
      const page = await query.apply(this, args);
      started.resolve();
      await release.promise;
      if (discovery === 'failure') throw queryFailure;
      return page;
    });
    const pass = reconcilePendingStripeTerminalNotifications({
      COMMERCE_DB: state.harness.db, NOTIFICATION_EMAIL_QUEUE: state.queue,
    }, controller.signal, { nowMs: state.nowMs });
    let settled = false;
    void pass.then(() => { settled = true; }, () => { settled = true; });
    await started.promise;
    controller.abort(cancellation);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    release.resolve();
    if (discovery === 'empty') assert.equal((await pass).attempted, 0);
    else await assert.rejects(pass, (error: unknown) => discovery === 'failure' ? error === queryFailure
      : error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === cancellation);
    assert.equal(state.sent.length, 0);
  });
}

for (const terminalState of ['queued', 'failed'] as const) {
  test(`Stripe recovery reports concurrent ${terminalState} state after exhausted claim races`, async (context) => {
    const state = await notificationFixture(context, 'stripe_terminal');
    const failureLogs: Record<string, unknown>[] = [];
    context.mock.method(console, 'error', (entry: Record<string, unknown>) => { failureLogs.push(entry); });
    if (terminalState === 'failed') {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        state.setTime(OUTBOX_NOW + attempt * OUTBOX_LEASE);
        await assert.rejects(state.publish({ queue: { sendBatch: async () => { throw new Error('uncertain enqueue'); } } }));
      }
      state.setTime(OUTBOX_NOW + 4 * OUTBOX_LEASE);
    }
    const original = NotificationOutboxRepository.prototype.compareAndSet;
    let attempts = 0;
    let competing = false;
    context.mock.method(NotificationOutboxRepository.prototype, 'compareAndSet', async function (
      this: NotificationOutboxRepository,
      args: Parameters<typeof original>[0],
    ) {
      if (competing) return original.call(this, args);
      attempts += 1;
      if (attempts === 1) {
        await state.repository.run(state.nowMs(), (unit) => unit.update(state.parentKey, {
          manualRefundReviewReason: 'changed metadata',
        }));
      }
      const updated = await original.call(this, args);
      assert.equal(updated, null);
      if (attempts === 6) {
        competing = true;
        const publication = await state.publish();
        assert.ok(typeof publication !== 'boolean');
        assert.equal(publication.publication, terminalState);
      }
      return updated;
    });
    assert.partialDeepStrictEqual(await reconcilePendingStripeTerminalNotifications({
      COMMERCE_DB: state.harness.db, NOTIFICATION_EMAIL_QUEUE: state.queue,
    }, new AbortController().signal, { nowMs: state.nowMs }), {
      attempted: 1, completed: terminalState === 'queued' ? 1 : 0,
      deferred: 0, skipped: 0, failed: terminalState === 'failed' ? 1 : 0,
    });
    assert.equal(attempts, 6);
    assert.equal((await state.read()).state, terminalState);
    assert.equal(state.sent.flat().length, terminalState === 'queued' ? 2 : 0);
    assert.deepEqual(failureLogs.filter((entry) => entry.event === 'scheduled_reconciliation_item_failed'),
      terminalState === 'failed' ? [{
        event: 'scheduled_reconciliation_item_failed', job: 'stripeNotifications',
        dropId: OUTBOX_DROP, sessionId: state.parentKey.documentId, errorCode: 'manual-review-required',
      }] : []);
  });
}
