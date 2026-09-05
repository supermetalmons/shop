import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { commerceKeys, D1CommerceRepository, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { readCommerceDocument, type CommerceDocumentContext } from '../src/commerceTransactions.ts';
import {
  publishReadyToShipNotifications,
  ReadyToShipNotificationEnqueueError,
} from '../src/readyToShipNotificationOutbox.ts';
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
const KEY = commerceKeys.deliveryOrder('card_nft_2', '7');
const BUYER_JOB_ID = '00000000-0000-4000-8000-000000000007';
const SHIPPER_JOB_ID = '00000000-0000-4000-9000-000000000007';

function order(overrides: CommerceDocumentData = {}): CommerceDocumentData {
  return {
    dropId: 'card_nft_2',
    deliveryId: 7,
    owner: 'owner-wallet',
    status: 'ready_to_ship',
    addressSnapshot: { email: 'buyer@example.com' },
    items: [{ kind: 'box', refId: 7 }],
    buyerOrderReceivedEmailState: 'pending',
    buyerOrderReceivedEmailJobId: BUYER_JOB_ID,
    buyerOrderReceivedEmailIdempotencyKey: 'card_nft_2:7:order_received',
    [ATTEMPTS]: 0,
    [RETRY_UNTIL]: NOW_MS + READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS,
    ...overrides,
  };
}

function fixture(
  context: TestContext,
  overrides: CommerceDocumentData = {},
  options: Parameters<typeof createCommerceD1Harness>[0] = {},
) {
  const harness = createCommerceD1Harness(options);
  context.after(() => harness.database.close());
  seedCommerceDocuments(harness, [{ key: KEY, data: order(overrides) }]);
  const repository = new D1CommerceRepository(harness.db);
  const commerce: CommerceDocumentContext = {
    commerceDb: harness.db,
    repository,
    nowMs: NOW_MS,
    signal: new AbortController().signal,
  };
  const load = async () => {
    const document = await readCommerceDocument(commerce, KEY.path);
    assert.ok(document);
    return document;
  };
  const publish = async (send: (jobs: NotificationEmailJobV1[]) => Promise<void> = async () => {}) => (
    publishReadyToShipNotifications({
      context: commerce,
      deliveryId: 7,
      document: await load(),
      dropId: 'card_nft_2',
      queue: {
        sendBatch: async (messages) => {
          await send(Array.from(messages, (message) => message.body));
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      },
    })
  );
  const due = () => repository.queryDueReadyNotifications({ dueAtMs: commerce.nowMs, limit: 8 });
  return { harness, repository, commerce, load, publish, due };
}

function jobIdentity(job: NotificationEmailJobV1) {
  return { kind: job.kind, jobId: job.jobId, idempotencyKey: job.idempotencyKey };
}

test('overlapping publishers share the persisted claim and enqueue only once', async (context) => {
  const native = fixture(context);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let queueCalls = 0;
  const first = native.publish(async () => {
    queueCalls += 1;
    started.resolve();
    await finish.promise;
  });
  try {
    await started.promise;
    const claimed = (await native.load()).fields;
    assert.equal(claimed[ATTEMPTS], 1);
    assert.equal(claimed[CLAIM_EXPIRY], NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS);
    assert.equal((await native.due()).length, 0);
    assert.equal(await native.publish(async () => { queueCalls += 1; }), false);
    assert.equal((await native.load()).fields[CLAIM_ID], claimed[CLAIM_ID]);
  } finally {
    finish.resolve();
  }
  assert.equal(await first, true);
  assert.equal(queueCalls, 1);
  assert.equal((await native.load()).fields.buyerOrderReceivedEmailState, 'queued');
  assert.equal((await native.due()).length, 0);
});

test('cancellation after claim persistence releases the claim and restores the attempt', async (context) => {
  const controller = new AbortController();
  const cancellation = new DOMException('cancelled during preparation', 'AbortError');
  let claimedAttempt: unknown;
  const native = fixture(context, {}, {
    observeBatchAfterCommit: () => {
      if (claimedAttempt !== undefined) return;
      const row = native.harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?')
        .get(KEY.path) as { document_json: string };
      const fields = JSON.parse(row.document_json) as Record<string, unknown>;
      if (!fields[CLAIM_ID]) return;
      claimedAttempt = fields[ATTEMPTS];
      controller.abort(cancellation);
    },
  });
  native.commerce.signal = controller.signal;
  await assert.rejects(native.publish(async () => assert.fail('cancelled work reached the queue')), cancellation);
  const released = (await native.load()).fields;
  assert.equal(claimedAttempt, 1);
  assert.equal(released[ATTEMPTS], 0);
  assert.equal(released[CLAIM_ID], undefined);
  assert.equal(released[CLAIM_EXPIRY], undefined);
  assert.equal((await native.due()).length, 1);
});

for (const abort of [false, true]) {
  test(`ambiguous enqueue ${abort ? 'with cancellation ' : ''}retains its lease and reuses job identity`, async (context) => {
    const native = fixture(context);
    const controller = new AbortController();
    native.commerce.signal = controller.signal;
    const sends: NotificationEmailJobV1[][] = [];
    await assert.rejects(native.publish(async (jobs) => {
      sends.push(jobs);
      if (abort) controller.abort(new DOMException('queue response lost', 'AbortError'));
      throw new Error('queue response lost');
    }), ReadyToShipNotificationEnqueueError);
    const pending = (await native.load()).fields;
    assert.equal(pending.buyerOrderReceivedEmailState, 'pending');
    assert.equal(pending[ATTEMPTS], 1);
    assert.equal(pending[CLAIM_EXPIRY], NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS);
    assert.equal((await native.due()).length, 0);
    native.commerce.signal = new AbortController().signal;
    native.commerce.nowMs = NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS - 1;
    assert.equal(await native.publish(async () => assert.fail('lease was bypassed')), false);
    native.commerce.nowMs += 1;
    assert.equal((await native.due()).length, 1);
    assert.equal(await native.publish(async (jobs) => { sends.push(jobs); }), true);
    assert.deepEqual(sends.map((jobs) => jobs.map(jobIdentity)), [
      [{ kind: 'buyer_order_received', jobId: BUYER_JOB_ID, idempotencyKey: 'card_nft_2:7:order_received' }],
      [{ kind: 'buyer_order_received', jobId: BUYER_JOB_ID, idempotencyKey: 'card_nft_2:7:order_received' }],
    ]);
    const completed = (await native.load()).fields;
    assert.equal(completed[ATTEMPTS], 2);
    assert.equal(completed[CLAIM_ID], undefined);
  });
}

test('successful enqueue followed by failed finalization keeps recoverable pending state', async (context) => {
  let rejectWrites = false;
  const native = fixture(context, {}, {
    observeCall: (call) => {
      if (rejectWrites && call.method === 'batch' && call.statements.some(({ sql }) => /INSERT INTO commerce_documents/.test(sql))) {
        throw new Error('finalization database unavailable');
      }
    },
  });
  const sends: NotificationEmailJobV1[][] = [];
  await assert.rejects(native.publish(async (jobs) => {
    sends.push(jobs);
    rejectWrites = true;
  }));
  rejectWrites = false;
  const pending = (await native.load()).fields;
  assert.equal(pending.buyerOrderReceivedEmailState, 'pending');
  assert.equal(pending[ATTEMPTS], 1);
  assert.equal((await native.due()).length, 0);
  native.commerce.nowMs += READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS;
  assert.equal(await native.publish(async (jobs) => { sends.push(jobs); }), true);
  assert.deepEqual(sends[0].map(jobIdentity), sends[1].map(jobIdentity));
});

test('partial publication preserves the remaining marker and retries only that notification', async (context) => {
  const native = fixture(context, {
    addressSnapshot: { email: 'invalid' },
    shipperReadyToShipEmailState: 'pending',
    shipperReadyToShipEmailJobId: SHIPPER_JOB_ID,
    shipperReadyToShipEmailIdempotencyKey: 'card_nft_2:7:ready_to_ship',
  });
  const sends: NotificationEmailJobV1[][] = [];
  await assert.rejects(native.publish(async (jobs) => { sends.push(jobs); }), ReadyToShipNotificationEnqueueError);
  const partial = (await native.load()).fields;
  assert.equal(partial.buyerOrderReceivedEmailState, 'pending');
  assert.equal(partial.shipperReadyToShipEmailState, 'queued');
  assert.equal(partial[ATTEMPTS], 1);
  assert.equal((await native.due()).length, 0);
  await native.repository.run(NOW_MS + 1, (unit) => unit.update(KEY, { addressSnapshot: { email: 'buyer@example.com' } }));
  native.commerce.nowMs += READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS;
  assert.equal(await native.publish(async (jobs) => { sends.push(jobs); }), true);
  assert.deepEqual(sends.map((jobs) => jobs.map(jobIdentity)), [
    [{ kind: 'shipper_ready_to_ship', jobId: SHIPPER_JOB_ID, idempotencyKey: 'card_nft_2:7:ready_to_ship' }],
    [{ kind: 'buyer_order_received', jobId: BUYER_JOB_ID, idempotencyKey: 'card_nft_2:7:order_received' }],
  ]);
  assert.equal((await native.load()).fields[CLAIM_ID], undefined);
  assert.equal((await native.due()).length, 0);
});

test('a late first attempt starts a fresh retry window', async (context) => {
  const native = fixture(context, { [RETRY_UNTIL]: NOW_MS - 1 });
  assert.equal(await native.publish(), true);
  const completed = (await native.load()).fields;
  assert.equal(completed[ATTEMPTS], 1);
  assert.equal(completed[RETRY_UNTIL], NOW_MS + READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS);
});

for (const exhausted of [
  { name: 'attempt limit', attempts: 4, retryUntil: NOW_MS + READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS },
  { name: 'retry deadline', attempts: 1, retryUntil: NOW_MS - 1 },
]) {
  test(`an exhausted ${exhausted.name} is finalized only after the active claim expires`, async (context) => {
    const native = fixture(context, {
      [ATTEMPTS]: exhausted.attempts,
      [RETRY_UNTIL]: exhausted.retryUntil,
      [CLAIM_ID]: 'existing-claim',
      [CLAIM_EXPIRY]: NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS,
    });
    assert.equal(await native.publish(async () => assert.fail('exhausted notification was sent')), false);
    assert.equal((await native.load()).fields.buyerOrderReceivedEmailState, 'pending');
    assert.equal((await native.due()).length, 0);
    native.commerce.nowMs += READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS;
    assert.equal(await native.publish(async () => assert.fail('exhausted notification was sent')), false);
    const failed = (await native.load()).fields;
    assert.equal(failed.buyerOrderReceivedEmailState, 'failed');
    assert.equal(failed[ATTEMPTS], exhausted.attempts);
    assert.equal(failed.readyToShipNotificationLastErrorCode, 'manual-review-required');
    assert.equal(failed[CLAIM_ID], undefined);
    assert.equal((await native.due()).length, 0);
  });
}

test('invalid notification identity is failed while another valid marker can still publish', async (context) => {
  const native = fixture(context, {
    buyerOrderReceivedEmailIdempotencyKey: 'card_nft_2:8:order_received',
    shipperReadyToShipEmailState: 'pending',
    shipperReadyToShipEmailJobId: SHIPPER_JOB_ID,
    shipperReadyToShipEmailIdempotencyKey: 'card_nft_2:7:ready_to_ship',
  });
  const jobs: NotificationEmailJobV1[] = [];
  assert.equal(await native.publish(async (batch) => { jobs.push(...batch); }), true);
  assert.deepEqual(jobs.map(jobIdentity), [
    { kind: 'shipper_ready_to_ship', jobId: SHIPPER_JOB_ID, idempotencyKey: 'card_nft_2:7:ready_to_ship' },
  ]);
  const completed = (await native.load()).fields;
  assert.equal(completed.buyerOrderReceivedEmailState, 'failed');
  assert.equal(completed.shipperReadyToShipEmailState, 'queued');
  assert.equal((await native.due()).length, 0);
});
