import assert from 'node:assert/strict';
import test from 'node:test';
import { planNotificationOutboxBackfill } from '../../../../scripts/shared/notificationOutboxMaintenance.ts';
import { createStripeReadyToShipNotificationJobs } from '../src/stripeReadyNotifications.ts';
import { seedNotificationOutbox } from './commerceD1Harness.ts';
import { notificationFixture, OUTBOX_NOW, OUTBOX_WINDOW } from './notificationOutboxTestSupport.ts';

for (const empty of [false, true]) {
  test(`migrated ${empty ? 'empty' : 'shipper-only'} Stripe snapshot never adds recipients after order edits`, async (context) => {
    const state = await notificationFixture(context, 'stripe_terminal', {
      create: false, ...(empty ? { dropId: 'clear_cards_devnet_v2' } : {}),
    });
    await state.updateOrder({ addressSnapshot: {} });
    const order = await state.repository.get(state.orderKey);
    const parent = await state.repository.get(state.parentKey);
    assert.ok(order);
    assert.ok(parent);
    const jobIds = Object.fromEntries(state.intent.entries.map((entry) => [entry.kind, entry.jobId]));
    const savedJobs = await createStripeReadyToShipNotificationJobs({
      order: order.data, dropId: state.intent.dropId, deliveryId: 7, jobIds,
    });
    assert.equal(savedJobs.length, empty ? 0 : 1);
    const [migrated] = planNotificationOutboxBackfill({
      path: parent.key.path, documentId: parent.key.documentId, dropId: parent.key.dropId,
      kind: parent.key.kind, version: parent.version, createTime: parent.createTime, updateTime: parent.updateTime,
      data: {
        ...parent.data,
        stripeTerminalNotificationState: 'pending',
        stripeTerminalNotificationNextAttemptAtMs: OUTBOX_NOW,
        stripeTerminalNotification: {
          version: 1, outcome: 'fulfilled', jobIds, attemptCount: 1,
          retryUntilMs: OUTBOX_NOW + OUTBOX_WINDOW, jobs: savedJobs,
        },
      },
    });
    seedNotificationOutbox(state.harness, migrated);
    await state.updateOrder({ addressSnapshot: { email: 'late@example.com', country: 'CA', hint: 'Changed after snapshot' } });
    const published = await state.publish();
    assert.deepEqual(published, { outcome: 'fulfilled', publication: 'queued', queuedJobs: savedJobs.length });
    assert.deepEqual(state.sent, empty ? [] : [savedJobs]);
    assert.equal((await state.read()).state, 'queued');
    await state.publish();
    assert.deepEqual(state.sent, empty ? [] : [savedJobs]);
  });
}
