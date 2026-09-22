import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStripeCheckoutDocument, createStripeCheckoutIdentity } from '../../../../shared/stripeCheckoutSession.ts';
import { commerceKeys } from '../src/commerceRepository.ts';
import { stripeCheckoutWriteData } from '../src/stripeCheckout/commerce.ts';
import { applyStripeCheckoutWebhook } from '../src/stripeCheckout/sessionStore.ts';
import { markStripeCheckoutFulfillmentFailed, releaseStripeCheckoutFulfillmentForRetry, startStripeCheckoutFulfillmentDocument } from '../src/stripeCheckout/store.ts';
import { enqueueStripeTerminalNotifications } from '../src/stripeCheckout/notificationOutboxState.ts';
import { claimStripeTerminalNotifications } from '../src/stripeCheckout/notificationStore.ts';
import { notificationFixture, OUTBOX_NOW, OUTBOX_LEASE } from './notificationOutboxTestSupport.ts';

test('Stripe terminal notification claims reuse their single outbox read', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal');
  const get = context.mock.method(state.repository.notificationOutbox, 'get');
  const compareAndSet = context.mock.method(state.repository.notificationOutbox, 'compareAndSet');
  const signal = new AbortController().signal;
  const result = await claimStripeTerminalNotifications({
    dropId: state.intent.dropId, sessionId: state.parentKey.documentId,
    commerce: { repository: state.repository, nowMs: state.nowMs, signal }, signal,
  });
  assert.ok('claim' in result);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(compareAndSet.mock.callCount(), 1);
  assert.deepEqual(result.claim.record, await state.read());
});

for (const outcome of ['fulfilled', 'manual_review'] as const) {
  test(`Stripe ${outcome}: missing outbox initializes only for explicit replay`, async (context) => {
    const state = await notificationFixture(context, 'stripe_terminal', { outcome, create: false });
    const parent = await state.repository.get(state.parentKey);
    assert.deepEqual(await state.publish(), { outcome, publication: 'none', queuedJobs: 0, reason: 'missing_outbox' });
    assert.equal(await state.repository.notificationOutbox.get(state.parentKey.path, 'stripe_terminal'), null);
    const result = await state.publish({ initializeMissing: true });
    assert.deepEqual(result, { outcome, publication: 'queued', queuedJobs: outcome === 'fulfilled' ? 2 : 1 });
    assert.deepEqual(await state.repository.get(state.parentKey), parent);
    await state.publish({ initializeMissing: true });
    assert.equal(state.sent.length, 1);
  });
}

test('Stripe manual-review jobs retain their identity and immutable checkout content', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal', { outcome: 'manual_review' });
  const identity = (await state.read()).entries[0];
  await state.publish();
  const job = state.sent[0][0];
  assert.equal(job.kind, 'stripe_checkout_manual_review');
  assert.equal(job.jobId, identity.jobId);
  assert.equal(job.idempotencyKey, 'card_nft_2:cs_notification:stripe_manual_review');
  assert.equal(job.context.sessionId, 'cs_notification');
});

test('manual-review publication does not coerce an unrelated malformed delivery ID', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal', { outcome: 'manual_review' });
  await state.repository.run(OUTBOX_NOW, (unit) => unit.update(state.parentKey, {
    deliveryId: { toString: false, valueOf: false },
  }));
  assert.deepEqual(await state.publish(), { outcome: 'manual_review', publication: 'queued', queuedJobs: 1 });
  assert.equal(state.sent[0][0].kind, 'stripe_checkout_manual_review');
});

test('Stripe optional recipients complete unused entries without sending those jobs', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal');
  await state.updateOrder({ addressSnapshot: {} });
  const result = await state.publish();
  assert.deepEqual(result, { outcome: 'fulfilled', publication: 'queued', queuedJobs: 1 });
  assert.deepEqual(state.sent[0].map((job) => job.kind), ['shipper_ready_to_ship']);
  assert.ok((await state.read()).entries.every((entry) => entry.state === 'queued'));
});

test('Stripe terminal outcome replacement is atomic and allocates a new generation', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal', { outcome: 'manual_review' });
  const before = await state.read();
  await state.repository.run(OUTBOX_NOW, async (unit) => {
    const checkout = await unit.get(state.parentKey);
    assert.ok(checkout);
    await enqueueStripeTerminalNotifications({ transaction: unit,
      key: { ...state.parentKey, kind: 'stripe_checkout' }, before: checkout.data,
      outcome: 'fulfilled', deliveryId: 7, nowMs: OUTBOX_NOW });
    await unit.update(state.parentKey, { status: 'fulfilled', deliveryId: 7 });
  });
  const after = await state.read();
  assert.notEqual(after.generation, before.generation);
  assert.equal(after.outcome, 'fulfilled');
  await state.publish();
  assert.deepEqual(state.sent[0].map((job) => job.kind), ['buyer_order_received', 'shipper_ready_to_ship']);
});

test('Stripe preparation cannot publish an expired claim', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal', { outcome: 'manual_review' });
  await assert.rejects(state.publish({ getDropName: () => {
    state.setTime(OUTBOX_NOW + OUTBOX_LEASE);
    return 'Card NFT 2';
  } }), /claim_expired/);
  assert.equal(state.sent.length, 0);
});

test('Stripe obsolete terminal outcomes never publish', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal', { outcome: 'manual_review' });
  await state.repository.run(OUTBOX_NOW, (unit) => unit.update(state.parentKey, { status: 'fulfilled' }));
  assert.deepEqual(await state.publish(), { outcome: 'fulfilled', publication: 'none', queuedJobs: 0, reason: 'obsolete_outbox' });
  assert.equal(state.sent.length, 0);
});

test('Stripe freezes optional recipient membership before an ambiguous Queue send', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal');
  await state.updateOrder({ addressSnapshot: {} });
  await assert.rejects(state.publish({ queue: { sendBatch: async (messages) => {
    await state.queue.sendBatch(messages);
    throw new Error('queue response lost');
  } } }));
  await state.updateOrder({ addressSnapshot: { email: 'new@example.com' } });
  state.setTime(OUTBOX_NOW + OUTBOX_LEASE);
  await state.publish();
  assert.deepEqual(state.sent[0].map((job) => job.kind), ['shipper_ready_to_ship']);
  assert.deepEqual(state.sent[1], state.sent[0]);
});

test('Stripe empty planned batch completes without a Queue send', async (context) => {
  const state = await notificationFixture(context, 'stripe_terminal', { dropId: 'clear_cards_devnet_v2' });
  await state.updateOrder({ addressSnapshot: {} });
  assert.deepEqual(await state.publish(), { outcome: 'fulfilled', publication: 'queued', queuedJobs: 0 });
  assert.equal(state.sent.length, 0);
  assert.equal((await state.read()).state, 'queued');
  assert.equal((await state.read()).claimId, null);
  await state.updateOrder({ addressSnapshot: { email: 'late@example.com' } });
  assert.deepEqual(await state.publish(), { outcome: 'fulfilled', publication: 'queued', queuedJobs: 0 });
  assert.equal(state.sent.length, 0);
});

for (const previousSend of ['unpublished', 'ambiguous'] as const) {
  test(`Stripe repeated paid webhook preserves ${previousSend} manual-review work through fulfillment retries`, async (context) => {
    const state = await notificationFixture(context, 'stripe_terminal', { outcome: 'manual_review' });
    const dropId = 'card_nft_2';
    const sessionId = state.parentKey.documentId;
    const checkoutKey = commerceKeys.stripeCheckout(dropId, sessionId);
    const commerce = { repository: state.repository, nowMs: state.nowMs };
    await state.repository.run(OUTBOX_NOW, (unit) => unit.update(checkoutKey, stripeCheckoutWriteData({
      ...buildStripeCheckoutDocument({ dropId, sessionId, ...createStripeCheckoutIdentity('anon:terminal'),
        quantity: 1, unitAmountCents: 100, createdAt: OUTBOX_NOW, updatedAt: OUTBOX_NOW }),
      status: 'fulfillment_failed', manualRefundReviewRequired: true,
    })));
    if (previousSend === 'ambiguous') {
      await assert.rejects(state.publish({ queue: { sendBatch: async (messages) => {
        await state.queue.sendBatch(messages);
        throw new Error('queue response lost');
      } } }), /queue response lost/);
    }
    const original = await state.read();
    const sentBeforeRetry = state.sent.length;
    assert.equal((await applyStripeCheckoutWebhook({
      kind: 'enqueue', checkoutKind: 'standard_pack', dropId, eventId: 'evt_repeated_paid',
      eventType: 'checkout.session.completed', expectedLivemode: false, expectedSecretScope: 'devnet', sessionId,
      session: { id: sessionId, livemode: false, payment_status: 'paid', metadata: {} },
    }, commerce)).outcome, 'queued');
    assert.deepEqual(await state.publish(), { outcome: 'not_terminal', publication: 'none', queuedJobs: 0 });
    assert.deepEqual(await state.read(), original);

    const first = await startStripeCheckoutFulfillmentDocument({ commerce, dropId, sessionId, checkoutKey, nowMs: OUTBOX_NOW });
    assert.ok(first.started);
    assert.deepEqual(await state.publish(), { outcome: 'not_terminal', publication: 'none', queuedJobs: 0 });
    assert.deepEqual(await state.read(), original);
    assert.equal((await releaseStripeCheckoutFulfillmentForRetry(commerce, checkoutKey, new Error('retryable failure'), {
      processingAttemptId: first.processingAttemptId, summarizeError: () => ({ message: 'retryable failure' }),
    })).status, 'released');
    assert.deepEqual(await state.read(), original);
    assert.deepEqual(await state.publish(), { outcome: 'not_terminal', publication: 'none', queuedJobs: 0 });

    const second = await startStripeCheckoutFulfillmentDocument({ commerce, dropId, sessionId, checkoutKey, nowMs: OUTBOX_NOW });
    assert.ok(second.started);
    assert.equal((await markStripeCheckoutFulfillmentFailed(commerce, checkoutKey, new Error('second terminal failure'), {
      processingAttemptId: second.processingAttemptId, summarizeError: () => ({ message: 'second terminal failure' }),
    })).status, 'failed');
    assert.deepEqual(await state.read(), original);
    assert.equal(state.sent.length, sentBeforeRetry);
    if (previousSend === 'ambiguous') {
      assert.deepEqual(await state.publish(), { outcome: 'manual_review', publication: 'busy', queuedJobs: 0 });
      assert.equal(state.sent.length, sentBeforeRetry);
      state.setTime(OUTBOX_NOW + OUTBOX_LEASE);
    }
    assert.deepEqual(await state.publish({ initializeMissing: true }), { outcome: 'manual_review', publication: 'queued', queuedJobs: 1 });
    const queued = await state.read();
    assert.equal(queued.generation, original.generation);
    assert.equal(queued.entries[0].jobId, original.entries[0].jobId);
    assert.equal(queued.entries[0].idempotencyKey, original.entries[0].idempotencyKey);
    assert.equal(queued.retryUntilMs, original.retryUntilMs);
    assert.equal(queued.attemptCount, original.attemptCount + 1);
    if (previousSend === 'ambiguous') assert.deepEqual(state.sent[1], state.sent[0]);
  });
}
