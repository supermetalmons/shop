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
import type { ReconciliationResult } from '../src/reconciliationResult.ts';

const NOW_MS = 1_700_000_000_000;
const READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS = 10 * 60_000;

function result(attempted: number, changes: Partial<ReconciliationResult> = {}): ReconciliationResult {
  return {
    attempted, completed: attempted, deferred: 0, skipped: 0, failed: 0,
    inspected: attempted, pages: 1, stopReason: 'drained', hasMore: false, oldestDueAgeMs: null,
    ...changes,
  };
}

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
  return { harness, repository, jobs, logs, run, load, setSend: (send: typeof onSend) => { onSend = send; } };
}

test('successive bounded passes drain due notifications without OPS_DB or revisiting leased work', async (context) => {
  const ids = Array.from({ length: 36 }, (_, index) => 100 + index);
  const native = fixture(context, [
    { id: 90, fields: { [ATTEMPTS]: 1, [CLAIM_ID]: '00000000-0000-4000-8000-000000000090', [CLAIM_EXPIRY]: NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS } },
    { id: 91, fields: { buyerOrderReceivedEmailState: 'queued' } },
    { id: 92, fields: { buyerOrderReceivedEmailState: 'failed' } },
    ...ids.map((id) => ({ id })),
  ]);
  assert.deepEqual(await native.run(), result(32, { pages: 4, stopReason: 'item-limit', hasMore: true, oldestDueAgeMs: 0 }));
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), ids.slice(0, 32));
  assert.deepEqual(await native.run(), result(4));
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), ids);
  assert.deepEqual(await native.run(), result(0));
  assert.equal((await native.load(90)).claimId, '00000000-0000-4000-8000-000000000090');
});

test('malformed-order cleanup shares the thirty-two-parent inspection cap', async (context) => {
  const invalidIds = Array.from({ length: 32 }, (_, index) => 100 + index);
  const native = fixture(context, [
    ...invalidIds.map((id) => ({ id, fields: { deliveryId: -1 } })),
    { id: 132 },
  ]);
  assert.deepEqual(await native.run(), result(32, {
    completed: 0, failed: 32, pages: 4, stopReason: 'item-limit', hasMore: true, oldestDueAgeMs: 0,
  }));
  assert.equal(native.jobs.length, 0);
  assert.equal(native.logs.length, 32);
  for (const id of invalidIds) {
    const failed = await native.load(id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.lastErrorCode, 'invalid-order-identity');
  }
  assert.equal((await native.load(132)).state, 'pending');
  assert.deepEqual(await native.run(), result(1));
  assert.equal(native.logs.length, 32);
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), [132]);
});

test('malformed candidates do not block later valid candidates across pages', async (context) => {
  const native = fixture(context, [
    ...[100, 101, 102, 103].map((id) => ({ id })),
    { id: 104, fields: { deliveryId: -1 } },
    { id: 105, fields: { deliveryId: -1 } },
    { id: 106 },
    { id: 107, fields: { deliveryId: -1 } },
    { id: 108 },
  ]);
  assert.deepEqual(await native.run(), result(9, { completed: 6, failed: 3, pages: 2 }));
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), [100, 101, 102, 103, 106, 108]);
  assert.equal(native.logs.length, 3);
  for (const id of [104, 105, 107]) assert.equal((await native.load(id)).state, 'failed');
});

test('a ready order producing two emails contributes one processed order', async (context) => {
  const state = await notificationFixture(context, 'ready');
  assert.deepEqual(await reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: state.harness.db,
    NOTIFICATION_EMAIL_QUEUE: state.queue as Queue<NotificationEmailJobV1>,
  }, new AbortController().signal, { nowMs: () => OUTBOX_NOW }), result(1));
  assert.equal(state.sent.flat().length, 2);
});

test('individual publication failures consume inspection slots and defer retries while later work progresses', async (context) => {
  const ids = Array.from({ length: 36 }, (_, index) => 100 + index);
  const native = fixture(context, ids.map((id) => ({ id })));
  native.setSend(async () => { throw new Error('queue unavailable'); });
  await assert.rejects(native.run(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 32);
    return true;
  });
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), ids.slice(0, 32));
  for (const id of ids.slice(0, 32)) {
    const pending = await native.load(id);
    assert.equal(pending.attemptCount, 1);
    assert.equal(pending.claimExpiresAtMs, NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS);
  }
  native.setSend(undefined);
  assert.deepEqual(await native.run(), result(4));
  assert.deepEqual(native.jobs.slice(32).map((job) => job.context.deliveryId), ids.slice(32));
  assert.deepEqual(await native.run(), result(0));
  assert.deepEqual(await native.run(NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS), result(32, { pages: 4, stopReason: 'item-limit' }));
  assert.deepEqual(native.jobs.slice(36).map((job) => job.context.deliveryId), ids.slice(0, 32));
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
  assert.deepEqual(await native.run(), result(5, { completed: 4, deferred: 1 }));
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), [100, 102, 103, 104]);
  assert.equal((await native.load(101)).claimId, '00000000-0000-4000-8000-000000000101');
  assert.equal((await native.load(104)).attemptCount, 1);
  assert.deepEqual(await native.run(), result(0));
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
  assert.deepEqual(summaries, [result(1, { completed: 0, failed: 1, stopReason: 'failed' })]);
  assert.deepEqual((await state.read()).entries.map(({ kind, state }) => [kind, state]), [
    ['buyer_order_received', 'pending'], ['shipper_ready_to_ship', 'queued'],
  ]);
  assert.deepEqual(logs, [{ event: 'scheduled_reconciliation_item_failed', job: 'notifications',
    parentPath: state.parentKey.path, errorName: 'ReadyToShipNotificationEnqueueError', errorCode: 'unavailable' }]);
});

test('publication and result log failures do not undo ready notification completion', async (context) => {
  const state = await notificationFixture(context, 'ready');
  context.mock.method(console, 'log', () => { throw new Error('logger unavailable'); });
  const summary = await reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: state.harness.db, NOTIFICATION_EMAIL_QUEUE: state.queue as Queue<NotificationEmailJobV1>,
  }, new AbortController().signal, {
    nowMs: () => OUTBOX_NOW,
    onResult: () => { throw new Error('reporter unavailable'); },
  });
  assert.deepEqual(summary, result(1));
  assert.equal((await state.read()).state, 'queued');
  assert.equal(state.sent.flat().length, 2);
});

test('ready notification pages and backlog observation use the fixed run cutoff', async (context) => {
  const ids = Array.from({ length: 9 }, (_, index) => 100 + index);
  const native = fixture(context, ids.map((id) => ({ id })));
  await native.repository.notificationOutbox.compareAndSet({
    expected: await native.load(108), changes: { nextAttemptAtMs: NOW_MS + 1 }, nowMs: NOW_MS,
  });
  let clockMs = NOW_MS;
  const summary = await reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: native.harness.db, NOTIFICATION_EMAIL_QUEUE: {
      sendBatch: async (messages: { body: NotificationEmailJobV1 }[]) => {
        native.jobs.push(...messages.map((message) => message.body));
        clockMs = NOW_MS + 2;
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    } as Queue<NotificationEmailJobV1>,
  }, new AbortController().signal, { nowMs: () => clockMs });
  assert.deepEqual(summary, result(8, { pages: 2 }));
  assert.equal((await native.load(108)).attemptCount, 0);
  assert.deepEqual(await native.run(NOW_MS + 2), result(1));
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), ids);
});

test('ready notification recovery stops new publications at twenty seconds and reports its backlog', async (context) => {
  const native = fixture(context, [100, 101].map((id) => ({ id })));
  let elapsedMs = 0;
  const jobs: NotificationEmailJobV1[] = [];
  const summary = await reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: native.harness.db, NOTIFICATION_EMAIL_QUEUE: {
      sendBatch: async (messages: { body: NotificationEmailJobV1 }[]) => {
        jobs.push(...messages.map((message) => message.body));
        elapsedMs = 20_000;
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    } as Queue<NotificationEmailJobV1>,
  }, new AbortController().signal, { nowMs: () => NOW_MS, monotonicNowMs: () => elapsedMs });
  assert.deepEqual(summary, result(1, { stopReason: 'time-limit', hasMore: true, oldestDueAgeMs: 0 }));
  assert.deepEqual(jobs.map((job) => job.context.deliveryId), [100]);
  assert.equal((await native.load(100)).state, 'queued');
  assert.equal((await native.load(101)).attemptCount, 0);
});
