import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { commerceKeys, D1CommerceRepository, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { reconcilePendingReadyToShipNotifications } from '../src/readyToShipNotificationReconciliation.ts';
import { ReadyToShipNotificationEnqueueError } from '../src/readyToShipNotificationOutbox.ts';
import {
  NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS as READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS,
} from '../src/notificationOutboxPublication.ts';
const ATTEMPTS = 'readyToShipNotificationPublishAttemptCount';
const CLAIM_EXPIRY = 'readyToShipNotificationPublishClaimExpiresAtMs';
const CLAIM_ID = 'readyToShipNotificationPublishClaimId';
const RETRY_UNTIL = 'readyToShipNotificationRetryUntilMs';
import { withoutNotificationFields } from './deliveryStoreTestSupport.ts';
import { createCommerceD1Harness, seedCommerceDocuments, seedNotificationOutbox } from './commerceD1Harness.ts';
import { notificationFixture, OUTBOX_NOW } from './notificationOutboxTestSupport.ts';

const NOW_MS = 1_700_000_000_000;
const READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS = 10 * 60_000;

function order(deliveryId: number, overrides: CommerceDocumentData = {}): CommerceDocumentData {
  return {
    dropId: 'card_nft_2',
    deliveryId,
    owner: 'owner-wallet',
    status: 'ready_to_ship',
    addressSnapshot: { email: 'buyer@example.com' },
    items: [{ kind: 'box', refId: deliveryId }],
    buyerOrderReceivedEmailState: 'pending',
    buyerOrderReceivedEmailJobId: `00000000-0000-4000-8000-${String(deliveryId).padStart(12, '0')}`,
    buyerOrderReceivedEmailIdempotencyKey: `card_nft_2:${deliveryId}:order_received`,
    [ATTEMPTS]: 0,
    [RETRY_UNTIL]: NOW_MS + READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS,
    ...overrides,
  };
}

function fixture(context: TestContext, orders: Array<{ id: number; fields?: CommerceDocumentData }>) {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seedCommerceDocuments(harness, orders.map(({ id, fields }) => ({
    key: commerceKeys.deliveryOrder('card_nft_2', String(id)),
    data: withoutNotificationFields(order(id, fields)),
  })));
  for (const { id, fields } of orders) {
    const source = order(id, fields);
    const state = source.buyerOrderReceivedEmailState as 'pending' | 'queued' | 'failed';
    const expiry = typeof source[CLAIM_EXPIRY] === 'number' ? Number(source[CLAIM_EXPIRY]) : null;
    seedNotificationOutbox(harness, {
      parentPath: commerceKeys.deliveryOrder('card_nft_2', String(id)).path, family: 'ready', dropId: 'card_nft_2',
      generation: crypto.randomUUID(), outcome: null, state, revision: 1,
      entries: [{ kind: 'buyer_order_received', jobId: String(source.buyerOrderReceivedEmailJobId),
        idempotencyKey: String(source.buyerOrderReceivedEmailIdempotencyKey), state }],
      attemptCount: Number(source[ATTEMPTS]), retryUntilMs: Number(source[RETRY_UNTIL]),
      claimId: typeof source[CLAIM_ID] === 'string' ? String(source[CLAIM_ID]) : null,
      claimExpiresAtMs: expiry, nextAttemptAtMs: state === 'pending' ? expiry ?? NOW_MS : null,
      createdAtMs: NOW_MS, updatedAtMs: NOW_MS, lastErrorCode: null,
    });
  }
  const repository = new D1CommerceRepository(harness.db);
  const jobs: NotificationEmailJobV1[] = [];
  const logs: Record<string, unknown>[] = [];
  let onSend: ((batch: NotificationEmailJobV1[]) => Promise<void>) | undefined;
  const metrics = { backlogCount: 0, backlogBytes: 0 };
  const queue: Queue<NotificationEmailJobV1> = {
    metrics: async () => metrics,
    send: async () => assert.fail('reconciliation must publish batches'),
    sendBatch: async (messages) => {
      const batch = Array.from(messages, (message) => message.body);
      jobs.push(...batch);
      await onSend?.(batch);
      return { metadata: { metrics } };
    },
  };
  const run = (nowMs = NOW_MS, signal = new AbortController().signal) => (
    reconcilePendingReadyToShipNotifications({
      COMMERCE_DB: harness.db,
      NOTIFICATION_EMAIL_QUEUE: queue,
    }, signal, { nowMs: () => nowMs, log: (entry) => { logs.push(entry); } })
  );
  const load = async (id: number) => {
    const record = await repository.notificationOutbox.get(commerceKeys.deliveryOrder('card_nft_2', String(id)).path, 'ready');
    assert.ok(record);
    return record;
  };
  return { repository, jobs, logs, run, load, setSend: (send: typeof onSend) => { onSend = send; } };
}

test('successive bounded passes drain due notifications without OPS_DB or revisiting leased work', async (context) => {
  const ids = Array.from({ length: 12 }, (_, index) => 100 + index);
  const native = fixture(context, [
    { id: 90, fields: { [ATTEMPTS]: 1, [CLAIM_ID]: '00000000-0000-4000-8000-000000000090', [CLAIM_EXPIRY]: NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS } },
    { id: 91, fields: { buyerOrderReceivedEmailState: 'queued' } },
    { id: 92, fields: { buyerOrderReceivedEmailState: 'failed' } },
    ...ids.map((id) => ({ id })),
  ]);
  assert.deepEqual(await native.run(), { attempted: 4, completed: 4, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), ids.slice(0, 4));
  assert.deepEqual(await native.run(), { attempted: 4, completed: 4, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), ids.slice(0, 8));
  assert.deepEqual(await native.run(), { attempted: 4, completed: 4, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), ids);
  assert.deepEqual(await native.run(), { attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0 });
  assert.equal((await native.load(90)).claimId, '00000000-0000-4000-8000-000000000090');
});

test('the eight-candidate scan cap bounds malformed-order cleanup without refilling the query', async (context) => {
  const invalidIds = Array.from({ length: 9 }, (_, index) => 100 + index);
  const native = fixture(context, [
    ...invalidIds.map((id) => ({ id, fields: { deliveryId: -1 } })),
    { id: 109 },
  ]);
  assert.deepEqual(await native.run(), { attempted: 8, completed: 0, deferred: 0, skipped: 0, failed: 8 });
  assert.equal(native.jobs.length, 0);
  assert.equal(native.logs.length, 8);
  for (const id of invalidIds.slice(0, 8)) {
    const failed = await native.load(id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.lastErrorCode, 'invalid-order-identity');
  }
  assert.equal((await native.load(108)).state, 'pending');
  assert.equal((await native.load(109)).state, 'pending');
  assert.deepEqual(await native.run(), { attempted: 2, completed: 1, deferred: 0, skipped: 0, failed: 1 });
  assert.equal(native.logs.length, 9);
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), [109]);
});

test('malformed candidates are cleaned after four publication attempts until the next valid candidate', async (context) => {
  const native = fixture(context, [
    ...[100, 101, 102, 103].map((id) => ({ id })),
    { id: 104, fields: { deliveryId: -1 } },
    { id: 105, fields: { deliveryId: -1 } },
    { id: 106 },
    { id: 107, fields: { deliveryId: -1 } },
  ]);
  assert.deepEqual(await native.run(), { attempted: 6, completed: 4, deferred: 0, skipped: 0, failed: 2 });
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), [100, 101, 102, 103]);
  assert.equal(native.logs.length, 2);
  for (const id of [104, 105]) assert.equal((await native.load(id)).state, 'failed');
  for (const id of [106, 107]) assert.equal((await native.load(id)).state, 'pending');
  assert.deepEqual(await native.run(), { attempted: 2, completed: 1, deferred: 0, skipped: 0, failed: 1 });
  assert.equal((await native.load(107)).state, 'failed');
});

test('a ready order producing two emails contributes one processed order', async (context) => {
  const state = await notificationFixture(context, 'ready');
  assert.deepEqual(await reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: state.harness.db,
    NOTIFICATION_EMAIL_QUEUE: state.queue as Queue<NotificationEmailJobV1>,
  }, new AbortController().signal, { nowMs: () => OUTBOX_NOW }), { attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0 });
  assert.equal(state.sent.flat().length, 2);
});

test('individual publication failures consume four slots and defer their retries while later work progresses', async (context) => {
  const ids = Array.from({ length: 8 }, (_, index) => 100 + index);
  const native = fixture(context, ids.map((id) => ({ id })));
  native.setSend(async () => { throw new Error('queue unavailable'); });
  await assert.rejects(native.run(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 4);
    return true;
  });
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), ids.slice(0, 4));
  for (const id of ids.slice(0, 4)) {
    const pending = await native.load(id);
    assert.equal(pending.attemptCount, 1);
    assert.equal(pending.claimExpiresAtMs, NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS);
  }
  native.setSend(undefined);
  assert.deepEqual(await native.run(), { attempted: 4, completed: 4, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(native.jobs.slice(4).map((job) => job.context.deliveryId), ids.slice(4));
  assert.deepEqual(await native.run(), { attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(await native.run(NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS), { attempted: 4, completed: 4, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(native.jobs.slice(8).map((job) => job.context.deliveryId), ids.slice(0, 4));
});

test('cancellation after an enqueue finalizes that notification and stops the remaining candidates', async (context) => {
  const native = fixture(context, [100, 101, 102, 103].map((id) => ({ id })));
  const controller = new AbortController();
  const cancellation = new DOMException('scheduled reconciliation cancelled', 'AbortError');
  native.setSend(async () => controller.abort(cancellation));
  await assert.rejects(native.run(NOW_MS, controller.signal), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [cancellation]);
    return true;
  });
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), [100]);
  assert.equal((await native.load(100)).state, 'queued');
  for (const id of [101, 102, 103]) {
    const untouched = await native.load(id);
    assert.equal(untouched.state, 'pending');
    assert.equal(untouched.attemptCount, 0);
    assert.equal(untouched.claimId, null);
  }
});

test('a claim acquired after candidate selection consumes one slot without duplicate publication', async (context) => {
  const native = fixture(context, [100, 101, 102, 103, 104].map((id) => ({ id })));
  native.setSend(async (jobs) => {
    if (jobs[0].context.deliveryId !== 100) return;
    await native.repository.notificationOutbox.compareAndSet({ expected: await native.load(101), nowMs: NOW_MS,
      changes: { attemptCount: 1, claimId: '00000000-0000-4000-8000-000000000101',
        claimExpiresAtMs: NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS,
        nextAttemptAtMs: NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS } });
  });
  assert.deepEqual(await native.run(), { attempted: 4, completed: 3, deferred: 1, skipped: 0, failed: 0 });
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), [100, 102, 103]);
  assert.equal((await native.load(101)).claimId, '00000000-0000-4000-8000-000000000101');
  assert.equal((await native.load(104)).attemptCount, 0);
  assert.deepEqual(await native.run(), { attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), [100, 102, 103, 104]);
});

test('partial email publication reports one failed parent and retains queued siblings', async (context) => {
  const state = await notificationFixture(context, 'ready');
  await state.updateOrder({ addressSnapshot: { email: 'invalid' } });
  const summaries: unknown[] = [];
  const logs: unknown[] = [];
  context.mock.method(console, 'error', (entry: unknown) => { logs.push(entry); });
  await assert.rejects(reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: state.harness.db, NOTIFICATION_EMAIL_QUEUE: state.queue as Queue<NotificationEmailJobV1>,
  }, new AbortController().signal, {
    nowMs: () => OUTBOX_NOW,
    onResult: (result) => { summaries.push(result); throw new Error('reporter unavailable'); },
  }), (error: unknown) => error instanceof AggregateError && error.errors[0] instanceof ReadyToShipNotificationEnqueueError);
  assert.deepEqual(summaries, [{ attempted: 1, completed: 0, deferred: 0, skipped: 0, failed: 1 }]);
  assert.deepEqual((await state.read()).entries.map(({ kind, state }) => [kind, state]), [
    ['buyer_order_received', 'pending'], ['shipper_ready_to_ship', 'queued'],
  ]);
  assert.deepEqual(logs, [{ event: 'scheduled_reconciliation_item_failed', job: 'notifications',
    parentPath: state.parentKey.path, errorName: 'ReadyToShipNotificationEnqueueError', errorCode: 'unavailable' }]);
});

test('publication and result log failures do not undo ready notification completion', async (context) => {
  const state = await notificationFixture(context, 'ready');
  context.mock.method(console, 'log', () => { throw new Error('logger unavailable'); });
  const result = await reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: state.harness.db, NOTIFICATION_EMAIL_QUEUE: state.queue as Queue<NotificationEmailJobV1>,
  }, new AbortController().signal, {
    nowMs: () => OUTBOX_NOW,
    onResult: () => { throw new Error('reporter unavailable'); },
  });
  assert.deepEqual(result, { attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0 });
  assert.equal((await state.read()).state, 'queued');
  assert.equal(state.sent.flat().length, 2);
});
