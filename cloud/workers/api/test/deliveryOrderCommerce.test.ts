import assert from 'node:assert/strict';
import test from 'node:test';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import { setDeliveryOrderFulfillment } from '../src/deliveryOrderCommerce.ts';
import { publishBuyerOrderShippedNotification, publishBuyerOrderShippedNotificationDetailed, reconcilePendingShippedNotifications } from '../src/buyerOrderShippedOutbox.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { claimNotificationOutbox, markClaimedNotificationQueued } from '../src/notificationOutboxStore.ts';

const DROP_ID = 'card_nft_2';
const NOW_MS = 1_800_000_000_000;
const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const NEXT_JOB_ID = '123e4567-e89b-42d3-a456-426614174001';
const TRACKING_URL = 'https://carrier.example/track?id=AB123';
const key = commerceKeys.deliveryOrder(DROP_ID, '7');

function fixture(context: { after: (run: () => void) => void }) {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  seedCommerceDocument(harness, { key, data: {
    deliveryId: 7, status: 'ready_to_ship', fulfillmentStatus: 'Preparing',
    addressSnapshot: { email: 'buyer@example.com' }, futureField: { preserved: true },
  } });
  const update = (args: { status?: 'Preparing' | 'Shipped'; retryShippedEmail?: boolean; jobId?: string; trackingCode?: string; nowMs?: number } = {}) =>
    setDeliveryOrderFulfillment({
      common: { repository, nowMs: args.nowMs ?? NOW_MS },
      createNotificationJobId: () => args.jobId ?? JOB_ID, deliveryId: 7, dropId: DROP_ID,
      status: args.status ?? 'Shipped', trackingCode: args.trackingCode ?? TRACKING_URL,
      retryShippedEmail: args.retryShippedEmail, wallet: 'staff',
    });
  return { harness, repository, update };
}

function queue(send: (jobs: NotificationEmailJobV1[]) => Promise<void>) {
  return { sendBatch: async (messages: { body: NotificationEmailJobV1 }[]) => {
    await send(messages.map((message) => message.body));
    return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
  } } as Pick<Queue<NotificationEmailJobV1>, 'sendBatch'>;
}

async function reconciliationFixture(context: { after: (run: () => void) => void }, ids: number[]) {
  const state = fixture(context);
  await state.repository.run(NOW_MS, async (unit) => {
    for (const id of ids) {
      const orderKey = commerceKeys.deliveryOrder(DROP_ID, String(id));
      await unit.create(orderKey, {
        deliveryId: id, status: 'ready_to_ship', fulfillmentStatus: 'Shipped',
        fulfillmentTrackingCode: TRACKING_URL, addressSnapshot: { email: 'buyer@example.com' },
      });
      await unit.enqueueNotificationOutbox({
        parentPath: orderKey.path, family: 'shipped', dropId: DROP_ID,
        generation: crypto.randomUUID(), outcome: null, retryUntilMs: NOW_MS + 6 * 60 * 60_000,
        entries: [{ kind: 'buyer_order_shipped', jobId: crypto.randomUUID(),
          idempotencyKey: `${DROP_ID}:${id}:order_shipped`, state: 'pending' }],
      });
    }
  });
  return {
    ...state,
    run: (send: (jobs: NotificationEmailJobV1[]) => Promise<void>, signal = new AbortController().signal) =>
      reconcilePendingShippedNotifications({
        COMMERCE_DB: state.harness.db, NOTIFICATION_EMAIL_QUEUE: queue(send) as Queue<NotificationEmailJobV1>,
      }, signal, { nowMs: () => NOW_MS }),
    load: (id: number) => state.repository.notificationOutbox.get(commerceKeys.deliveryOrder(DROP_ID, String(id)).path, 'shipped'),
  };
}

test('shipment transition stores an atomic outbox intent and repeated saves preserve its identity', async (context) => {
  const { repository, update } = fixture(context);
  const first = await update();
  assert.equal(first.response.buyerOrderShippedEmailState, 'pending');
  const group = await repository.notificationOutbox.get(key.path, 'shipped');
  assert.equal(group?.entries[0].idempotencyKey, 'card_nft_2:7:order_shipped');
  await update({ jobId: NEXT_JOB_ID });
  assert.equal((await repository.notificationOutbox.get(key.path, 'shipped'))?.generation, group?.generation);
  const order = await repository.get(key);
  assert.equal(order?.data.fulfillmentStatus, 'Shipped');
  assert.deepEqual(order?.data.futureField, { preserved: true });
  assert.equal(Object.hasOwn(order!.data, 'buyerOrderShippedEmailState'), false);
});

test('shipment publication updates only the outbox and completed jobs are not sent twice', async (context) => {
  const { repository, update } = fixture(context);
  await update();
  const before = await repository.get(key);
  const jobs: NotificationEmailJobV1[] = [];
  const args = { repository, parentPath: key.path, signal: new AbortController().signal,
    nowMs: () => NOW_MS, queue: queue(async (batch) => { jobs.push(...batch); }) };
  const outboxReads = context.mock.method(repository.notificationOutbox, 'get');
  assert.equal(await publishBuyerOrderShippedNotification(args), true);
  assert.equal(outboxReads.mock.callCount(), 1);
  assert.equal(await publishBuyerOrderShippedNotification(args), true);
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].text, /Tracking: https:\/\/carrier.example/);
  assert.deepEqual(await repository.get(key), before);
  const group = await repository.notificationOutbox.get(key.path, 'shipped');
  assert.equal(group?.state, 'queued');
  assert.equal(group?.entries[0].payload, undefined);
  assert.equal((await update()).response.buyerOrderShippedEmailState, 'queued');
});

test('a lost shipment cancellation claim reports deferred without another read or an enqueue', async (context) => {
  const { repository, update } = fixture(context);
  await update();
  await repository.run(NOW_MS, (unit) => unit.update(key, { fulfillmentStatus: 'Preparing' }));
  context.mock.method(repository.notificationOutbox, 'compareAndSet', async () => null);
  const reads = context.mock.method(repository.notificationOutbox, 'get');
  const result = await publishBuyerOrderShippedNotificationDetailed({
    repository, parentPath: key.path, signal: new AbortController().signal, nowMs: () => NOW_MS,
    queue: queue(async () => assert.fail('a lost cancellation must not publish')),
  });
  assert.deepEqual(result, { outcome: 'deferred', published: false });
  assert.equal(reads.mock.callCount(), 1);
});

for (const afterSnapshot of [false, true]) {
  test(`shipment cancellation after ${afterSnapshot ? 'snapshot' : 'claim'} reuses the latest record for cleanup`, async (context) => {
    const { repository, update } = fixture(context);
    await update();
    const controller = new AbortController();
    const original = repository.notificationOutbox.compareAndSet.bind(repository.notificationOutbox);
    let cancelled = false;
    context.mock.method(repository.notificationOutbox, 'compareAndSet', async (args: Parameters<typeof original>[0]) => {
      const result = await original(args);
      if (!cancelled && result?.claimId && (!afterSnapshot || result.entries.some((entry) => entry.payload))) {
        cancelled = true;
        controller.abort(new Error('cancelled'));
      }
      return result;
    });
    const outboxReads = context.mock.method(repository.notificationOutbox, 'get');
    const jobs: NotificationEmailJobV1[] = [];
    await assert.rejects(publishBuyerOrderShippedNotification({
      repository, parentPath: key.path, signal: controller.signal, nowMs: () => NOW_MS,
      queue: queue(async (batch) => { jobs.push(...batch); }),
    }), /cancelled/);
    assert.equal(outboxReads.mock.callCount(), 1);
    const record = await repository.notificationOutbox.get(key.path, 'shipped');
    assert.ok(record);
    assert.equal(record.attemptCount, 0);
    assert.equal(record.claimId, null);
    assert.equal(record.nextAttemptAtMs, NOW_MS);
    assert.equal(record.entries.some((entry) => entry.payload), afterSnapshot);
    assert.equal(jobs.length, 0);
  });
}

test('scheduled shipment recovery reuses the exact saved email after an uncertain queue send', async (context) => {
  const { harness, repository, update } = fixture(context);
  await update();
  const jobs: NotificationEmailJobV1[] = [];
  await assert.rejects(publishBuyerOrderShippedNotification({
    repository, parentPath: key.path, signal: new AbortController().signal, nowMs: () => NOW_MS,
    queue: queue(async (batch) => { jobs.push(...batch); throw new Error('uncertain queue result'); }),
  }));
  await update({ trackingCode: 'https://carrier.example/updated' });
  const retried = await reconcilePendingShippedNotifications({
    COMMERCE_DB: harness.db,
    NOTIFICATION_EMAIL_QUEUE: queue(async (batch) => { jobs.push(...batch); }) as Queue,
  }, new AbortController().signal, { nowMs: () => NOW_MS + 10 * 60_000 });
  assert.deepEqual(retried, { attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(jobs[1], jobs[0]);
});

test('shipment recovery processes four candidates including ineligible orders without refilling', async (context) => {
  const state = await reconciliationFixture(context, [100, 101, 102, 103, 104, 105]);
  await state.repository.run(NOW_MS, (unit) => unit.update(commerceKeys.deliveryOrder(DROP_ID, '100'), {
    fulfillmentStatus: 'Preparing',
  }));
  const jobs: NotificationEmailJobV1[] = [];
  const send = async (batch: NotificationEmailJobV1[]) => { jobs.push(...batch); };
  assert.deepEqual(await state.run(send), { attempted: 4, completed: 3, deferred: 0, skipped: 1, failed: 0 });
  assert.deepEqual(jobs.map((job) => job.context.deliveryId), [101, 102, 103]);
  assert.equal((await state.load(100))?.state, 'cancelled');
  for (const id of [104, 105]) assert.equal((await state.load(id))?.attemptCount, 0);
  assert.deepEqual(await state.run(send), { attempted: 2, completed: 2, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(jobs.map((job) => job.context.deliveryId), [101, 102, 103, 104, 105]);
});

test('shipment recovery continues after failure while retaining the four-candidate cap and error log', async (context) => {
  const state = await reconciliationFixture(context, [100, 101, 102, 103, 104]);
  const logs = context.mock.method(console, 'error', () => undefined);
  const failure = new Error('queue unavailable');
  const jobs: NotificationEmailJobV1[] = [];
  await assert.rejects(state.run(async (batch) => {
    jobs.push(...batch);
    if (batch[0].context.deliveryId === 100) throw failure;
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'Shipped notification reconciliation failed');
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.deepEqual(jobs.map((job) => job.context.deliveryId), [100, 101, 102, 103]);
  assert.deepEqual(logs.mock.calls.map((call) => call.arguments[0]).filter((entry) => entry.event !== 'scheduled_reconciliation_item_failed'), [{
    event: 'buyer_order_shipped_notification_enqueue_failed',
    parentPath: commerceKeys.deliveryOrder(DROP_ID, '100').path,
    error: { name: 'Error' },
  }]);
  assert.equal((await state.load(100))?.state, 'pending');
  assert.equal((await state.load(100))?.attemptCount, 1);
  for (const id of [101, 102, 103]) assert.equal((await state.load(id))?.state, 'queued');
  assert.equal((await state.load(104))?.attemptCount, 0);
  assert.deepEqual(await state.run(async (batch) => { jobs.push(...batch); }), { attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(jobs.map((job) => job.context.deliveryId), [100, 101, 102, 103, 104]);
});

test('shipment recovery finalizes an accepted enqueue before cancellation stops later candidates', async (context) => {
  const state = await reconciliationFixture(context, [100, 101, 102]);
  const controller = new AbortController();
  const cancellation = new Error('scheduled reconciliation cancelled');
  const jobs: NotificationEmailJobV1[] = [];
  await assert.rejects(state.run(async (batch) => {
    jobs.push(...batch);
    controller.abort(cancellation);
  }, controller.signal), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [cancellation]);
    return true;
  });
  assert.deepEqual(jobs.map((job) => job.context.deliveryId), [100]);
  assert.equal((await state.load(100))?.state, 'queued');
  for (const id of [101, 102]) {
    assert.equal((await state.load(id))?.attemptCount, 0);
    assert.equal((await state.load(id))?.state, 'pending');
  }
});

test('explicit shipment resend supersedes an old lease and creates a fresh idempotency key', async (context) => {
  const { repository, update } = fixture(context);
  await update();
  const claimed = await claimNotificationOutbox({ repository, parentPath: key.path, family: 'shipped', nowMs: () => NOW_MS });
  assert.equal(claimed.outcome, 'claimed');
  if (claimed.outcome !== 'claimed') return;
  await update({ retryShippedEmail: true, jobId: NEXT_JOB_ID });
  const current = await repository.notificationOutbox.get(key.path, 'shipped');
  assert.equal(current?.generation, NEXT_JOB_ID);
  assert.equal(current?.entries[0].idempotencyKey, `card_nft_2:7:order_shipped:retry:${NEXT_JOB_ID}`);
  assert.equal(await markClaimedNotificationQueued({ repository, claim: claimed.claim, nowMs: () => NOW_MS, jobs: [] }), null);
});

test('unshipping cancels pending work and prevents a held publisher from finalizing', async (context) => {
  const { repository, update } = fixture(context);
  await update();
  const claimed = await claimNotificationOutbox({ repository, parentPath: key.path, family: 'shipped', nowMs: () => NOW_MS });
  assert.equal(claimed.outcome, 'claimed');
  const response = (await update({ status: 'Preparing' })).response;
  assert.equal(response.buyerOrderShippedEmailState, undefined);
  const group = await repository.notificationOutbox.get(key.path, 'shipped');
  assert.equal(group?.state, 'cancelled');
  assert.equal(group?.claimId, null);
  if (claimed.outcome === 'claimed') {
    assert.equal(await markClaimedNotificationQueued({ repository, claim: claimed.claim, nowMs: () => NOW_MS, jobs: [] }), null);
  }
  assert.equal((await update()).response.buyerOrderShippedEmailState, undefined);
});

test('failed historical shipment state stays pending publicly and requires explicit retry', async (context) => {
  const { repository, update } = fixture(context);
  await update();
  const group = (await repository.notificationOutbox.get(key.path, 'shipped'))!;
  await repository.notificationOutbox.compareAndSet({ expected: group, nowMs: NOW_MS, changes: {
    state: 'failed', nextAttemptAtMs: null, lastErrorCode: 'legacy_shipped_delivery_unknown',
    entries: group.entries.map((entry) => ({ ...entry, state: 'failed', errorCode: 'legacy_shipped_delivery_unknown' })),
  } });
  assert.equal((await update()).response.buyerOrderShippedEmailState, 'pending');
  assert.equal((await repository.notificationOutbox.get(key.path, 'shipped'))?.state, 'failed');
  await update({ retryShippedEmail: true, jobId: NEXT_JOB_ID });
  assert.equal((await repository.notificationOutbox.get(key.path, 'shipped'))?.state, 'pending');
});
