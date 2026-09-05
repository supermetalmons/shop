import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { commerceKeys, D1CommerceRepository, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { reconcilePendingReadyToShipNotifications } from '../src/readyToShipNotificationReconciliation.ts';
import {
  READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD as ATTEMPTS,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD as CLAIM_EXPIRY,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD as CLAIM_ID,
  READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD as RETRY_UNTIL,
  READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS,
} from '../src/readyToShipNotifications.ts';
import { createCommerceD1Harness, seedCommerceDocuments } from './commerceD1Harness.ts';

const NOW_MS = 1_700_000_000_000;

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
    data: order(id, fields),
  })));
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
    const record = await repository.get(commerceKeys.deliveryOrder('card_nft_2', String(id)));
    assert.ok(record);
    return record.data;
  };
  return { repository, jobs, logs, run, load, setSend: (send: typeof onSend) => { onSend = send; } };
}

test('successive bounded passes drain due notifications without OPS_DB or revisiting leased work', async (context) => {
  const ids = Array.from({ length: 12 }, (_, index) => 100 + index);
  const native = fixture(context, [
    { id: 90, fields: { [ATTEMPTS]: 1, [CLAIM_ID]: 'live-claim', [CLAIM_EXPIRY]: NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS } },
    { id: 91, fields: { buyerOrderReceivedEmailState: 'queued' } },
    { id: 92, fields: { buyerOrderReceivedEmailState: 'failed' } },
    ...ids.map((id) => ({ id })),
  ]);
  assert.equal(await native.run(), 4);
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), ids.slice(0, 4));
  assert.equal(await native.run(), 4);
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), ids.slice(0, 8));
  assert.equal(await native.run(), 4);
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), ids);
  assert.equal(await native.run(), 0);
  assert.equal((await native.load(90))[CLAIM_ID], 'live-claim');
});

test('the eight-candidate scan cap bounds malformed-order cleanup without refilling the query', async (context) => {
  const invalidIds = Array.from({ length: 9 }, (_, index) => 100 + index);
  const native = fixture(context, [
    ...invalidIds.map((id) => ({ id, fields: { deliveryId: -1 } })),
    { id: 109 },
  ]);
  assert.equal(await native.run(), 0);
  assert.equal(native.jobs.length, 0);
  assert.equal(native.logs.length, 8);
  for (const id of invalidIds.slice(0, 8)) {
    const failed = await native.load(id);
    assert.equal(failed.buyerOrderReceivedEmailState, 'failed');
    assert.equal(failed.readyToShipNotificationLastErrorCode, 'invalid-order-identity');
  }
  assert.equal((await native.load(108)).buyerOrderReceivedEmailState, 'pending');
  assert.equal((await native.load(109)).buyerOrderReceivedEmailState, 'pending');
  assert.equal(await native.run(), 1);
  assert.equal(native.logs.length, 9);
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), [109]);
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
    assert.equal(pending[ATTEMPTS], 1);
    assert.equal(pending[CLAIM_EXPIRY], NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS);
  }
  native.setSend(undefined);
  assert.equal(await native.run(), 4);
  assert.deepEqual(native.jobs.slice(4).map((job) => job.context.deliveryId), ids.slice(4));
  assert.equal(await native.run(), 0);
  assert.equal(await native.run(NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS), 4);
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
  assert.equal((await native.load(100)).buyerOrderReceivedEmailState, 'queued');
  for (const id of [101, 102, 103]) {
    const untouched = await native.load(id);
    assert.equal(untouched.buyerOrderReceivedEmailState, 'pending');
    assert.equal(untouched[ATTEMPTS], 0);
    assert.equal(untouched[CLAIM_ID], undefined);
  }
});

test('a claim acquired after candidate selection consumes one slot without duplicate publication', async (context) => {
  const native = fixture(context, [100, 101, 102, 103, 104].map((id) => ({ id })));
  native.setSend(async (jobs) => {
    if (jobs[0].context.deliveryId !== 100) return;
    await native.repository.run(NOW_MS, (unit) => unit.update(commerceKeys.deliveryOrder('card_nft_2', '101'), {
      [ATTEMPTS]: 1,
      [CLAIM_ID]: 'concurrent-publisher',
      [CLAIM_EXPIRY]: NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS,
    }));
  });
  assert.equal(await native.run(), 3);
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), [100, 102, 103]);
  assert.equal((await native.load(101))[CLAIM_ID], 'concurrent-publisher');
  assert.equal((await native.load(104))[ATTEMPTS], 0);
  assert.equal(await native.run(), 1);
  assert.deepEqual(native.jobs.map((job) => job.context.deliveryId), [100, 102, 103, 104]);
});
