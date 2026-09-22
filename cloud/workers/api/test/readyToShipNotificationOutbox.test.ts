import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { markPendingReadyToShipNotificationsFailed, ReadyToShipNotificationEnqueueError } from '../src/readyToShipNotificationOutbox.ts';
import { notificationFixture, OUTBOX_NOW, OUTBOX_LEASE, OUTBOX_WINDOW } from './notificationOutboxTestSupport.ts';

for (const family of ['ready', 'stripe_terminal'] as const) {
  test(`${family}: publication changes only its outbox and discards queued payloads`, async (context) => {
    const state = await notificationFixture(context, family);
    const before = await state.repository.get(state.parentKey);
    const outboxReads = context.mock.method(state.repository.notificationOutbox, 'get');
    await state.publish();
    assert.equal(outboxReads.mock.callCount(), family === 'stripe_terminal' ? 1 : 2);
    const record = await state.read();
    assert.equal(record.state, 'queued');
    assert.equal(record.attemptCount, 1);
    assert.equal(record.claimId, null);
    assert.equal(record.nextAttemptAtMs, null);
    assert.ok(record.entries.every((entry) => entry.state === 'queued' && !entry.payload));
    assert.deepEqual(await state.repository.get(state.parentKey), before);
    await state.publish();
    assert.equal(state.sent.length, 1);
  });

  test(`${family}: ambiguous enqueue keeps exact jobs and shared lease across source edits`, async (context) => {
    const state = await notificationFixture(context, family);
    await assert.rejects(state.publish({ queue: { sendBatch: async (messages) => {
      await state.queue.sendBatch(messages);
      throw new Error('queue response lost');
    } } }));
    const pending = await state.read();
    assert.equal(pending.state, 'pending');
    assert.equal(pending.attemptCount, 1);
    assert.equal(pending.nextAttemptAtMs, OUTBOX_NOW + OUTBOX_LEASE);
    assert.deepEqual(pending.entries.map((entry) => entry.payload), state.sent[0]);
    await state.updateOrder({ addressSnapshot: { email: 'changed@example.com' }, items: [{ kind: 'box', refId: 99 }] });
    await state.publish();
    assert.equal(state.sent.length, 1);
    state.setTime(OUTBOX_NOW + OUTBOX_LEASE);
    await state.publish();
    assert.deepEqual(state.sent[1], state.sent[0]);
  });

  test(`${family}: overlapping publishers send once`, async (context) => {
    const state = await notificationFixture(context, family);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = state.publish({ queue: { sendBatch: async (messages) => {
      const result = await state.queue.sendBatch(messages);
      started.resolve();
      await release.promise;
      return result;
    } } });
    await started.promise;
    await state.publish();
    release.resolve();
    await first;
    assert.equal(state.sent.length, 1);
  });

  for (const afterSnapshot of [false, true]) {
    test(`${family}: cancellation after ${afterSnapshot ? 'snapshot' : 'claim'} restores unused attempt`, async (context) => {
      const state = await notificationFixture(context, family);
      const controller = new AbortController();
      const original = state.repository.notificationOutbox.compareAndSet.bind(state.repository.notificationOutbox);
      let cancelled = false;
      context.mock.method(state.repository.notificationOutbox, 'compareAndSet', async (args: Parameters<typeof original>[0]) => {
        const result = await original(args);
        if (!cancelled && result?.claimId && (!afterSnapshot || result.entries.some((entry) => entry.payload))) {
          cancelled = true;
          controller.abort(new Error('cancelled'));
        }
        return result;
      });
      const outboxReads = context.mock.method(state.repository.notificationOutbox, 'get');
      await assert.rejects(state.publish({ signal: controller.signal }), /cancelled/);
      assert.equal(outboxReads.mock.callCount(), family === 'stripe_terminal' ? 1 : 2);
      const record = await state.read();
      assert.equal(record.attemptCount, 0);
      assert.equal(record.claimId, null);
      assert.equal(record.nextAttemptAtMs, OUTBOX_NOW);
      assert.equal(record.entries.some((entry) => entry.payload), afterSnapshot);
      assert.equal(state.sent.length, 0);
      await state.publish();
      assert.equal((await state.read()).state, 'queued');
    });
  }

  test(`${family}: successful send finalizes despite caller cancellation`, async (context) => {
    const state = await notificationFixture(context, family);
    const controller = new AbortController();
    await state.publish({ signal: controller.signal, queue: { sendBatch: async (messages) => {
      const result = await state.queue.sendBatch(messages);
      controller.abort(new Error('client left'));
      return result;
    } } });
    assert.equal((await state.read()).state, 'queued');
  });

  test(`${family}: failed snapshot persistence never sends`, async (context) => {
    const state = await notificationFixture(context, family);
    const original = state.repository.notificationOutbox.compareAndSet.bind(state.repository.notificationOutbox);
    context.mock.method(state.repository.notificationOutbox, 'compareAndSet', async (args: Parameters<typeof original>[0]) => {
      if (args.changes.entries?.some((entry) => entry.payload)) throw new Error('snapshot unavailable');
      return original(args);
    });
    await assert.rejects(state.publish(), (error: unknown) => error instanceof Error &&
      (error.message === 'snapshot unavailable' || (error.cause instanceof Error && error.cause.message === 'snapshot unavailable')));
    assert.equal(state.sent.length, 0);
    assert.ok((await state.read()).entries.every((entry) => !entry.payload));
  });

  test(`${family}: failed finalization retries frozen jobs`, async (context) => {
    const state = await notificationFixture(context, family);
    const original = state.repository.notificationOutbox.compareAndSet.bind(state.repository.notificationOutbox);
    let reject = true;
    context.mock.method(state.repository.notificationOutbox, 'compareAndSet', async (args: Parameters<typeof original>[0]) => {
      if (reject && args.changes.state === 'queued') throw new Error('finalization unavailable');
      return original(args);
    });
    await assert.rejects(state.publish());
    assert.equal((await state.read()).state, 'pending');
    reject = false;
    state.setTime(OUTBOX_NOW + OUTBOX_LEASE);
    await state.publish();
    assert.deepEqual(state.sent[1], state.sent[0]);
  });

  for (const exhausted of ['attempts', 'window'] as const) {
    test(`${family}: ${exhausted} exhaustion waits for active claim then fails`, async (context) => {
      const state = await notificationFixture(context, family);
      await state.mutate({ attemptCount: exhausted === 'attempts' ? 4 : 1,
        retryUntilMs: exhausted === 'window' ? OUTBOX_NOW : OUTBOX_NOW + OUTBOX_WINDOW,
        claimId: crypto.randomUUID(), claimExpiresAtMs: OUTBOX_NOW + OUTBOX_LEASE,
        nextAttemptAtMs: OUTBOX_NOW + OUTBOX_LEASE });
      await state.publish();
      assert.equal((await state.read()).state, 'pending');
      state.setTime(OUTBOX_NOW + OUTBOX_LEASE);
      await state.publish();
      assert.equal((await state.read()).state, 'failed');
      assert.equal((await state.read()).lastErrorCode, 'manual-review-required');
      assert.equal(state.sent.length, 0);
    });
  }

  test(`${family}: late first claim starts the retry window`, async (context) => {
    const state = await notificationFixture(context, family);
    await state.mutate({ retryUntilMs: OUTBOX_NOW - 1 });
    await state.publish();
    assert.equal((await state.read()).retryUntilMs, OUTBOX_NOW + OUTBOX_WINDOW);
  });

  test(`${family}: replacement generation cannot be overwritten by an old publisher`, async (context) => {
    const state = await notificationFixture(context, family);
    const original = state.repository.notificationOutbox.compareAndSet.bind(state.repository.notificationOutbox);
    let replaced = false;
    context.mock.method(state.repository.notificationOutbox, 'compareAndSet', async (args: Parameters<typeof original>[0]) => {
      const result = await original(args);
      if (!replaced && result?.claimId) {
        replaced = true;
        await state.repository.run(OUTBOX_NOW, (unit) => unit.replaceNotificationOutbox({
          ...state.intent, generation: crypto.randomUUID(),
        }));
      }
      return result;
    });
    await assert.rejects(state.publish());
    assert.equal(state.sent.length, 0);
    assert.equal((await state.read()).attemptCount, 0);
    assert.equal((await state.read()).claimId, null);
  });
}

test('ready: partial publication retries only the remaining sibling', async (context) => {
  const state = await notificationFixture(context, 'ready');
  await state.updateOrder({ addressSnapshot: { email: 'invalid' } });
  await assert.rejects(state.publish(), ReadyToShipNotificationEnqueueError);
  assert.deepEqual((await state.read()).entries.map(({ kind, state }) => [kind, state]), [
    ['buyer_order_received', 'pending'], ['shipper_ready_to_ship', 'queued'],
  ]);
  await state.updateOrder({ addressSnapshot: { email: 'buyer@example.com' } });
  state.setTime(OUTBOX_NOW + OUTBOX_LEASE);
  await state.publish();
  assert.deepEqual(state.sent.map((jobs: NotificationEmailJobV1[]) => jobs.map((job) => job.kind)), [
    ['shipper_ready_to_ship'], ['buyer_order_received'],
  ]);
});

test('ready: explicit failure keeps unrelated sibling pending without rewriting order', async (context) => {
  const state = await notificationFixture(context, 'ready');
  const before = await state.repository.get(state.parentKey);
  assert.deepEqual(await markPendingReadyToShipNotificationsFailed({ repository: state.repository,
    nowMs: OUTBOX_NOW, signal: new AbortController().signal }, state.parentKey.path, 'invalid-notification-data',
  ['buyerOrderReceivedEmailState']), ['buyerOrderReceivedEmailState']);
  await state.publish();
  assert.equal((await state.read()).state, 'failed');
  assert.deepEqual(state.sent[0].map((job) => job.kind), ['shipper_ready_to_ship']);
  assert.deepEqual(await state.repository.get(state.parentKey), before);
});

test('ready: an invalid delivery identity fails only that notification', async (context) => {
  const state = await notificationFixture(context, 'ready');
  await state.repository.run(OUTBOX_NOW, (unit) => unit.replaceNotificationOutbox({ ...state.intent,
    generation: crypto.randomUUID(), entries: state.intent.entries.map((entry) => entry.kind === 'buyer_order_received'
      ? { ...entry, idempotencyKey: 'card_nft_2:8:order_received' } : entry) }));
  await state.publish();
  assert.deepEqual(state.sent[0].map((job) => job.kind), ['shipper_ready_to_ship']);
  assert.deepEqual((await state.read()).entries.map(({ state }) => state), ['failed', 'queued']);
});
