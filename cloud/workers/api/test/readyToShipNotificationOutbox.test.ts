import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createNotificationEmailJobV1, type NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { CommerceRepositoryError, commerceKeys, D1CommerceRepository, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { readCommerceRecord, type CommerceRepositoryContext } from '../src/commerceTransactions.ts';
import {
  markPendingReadyToShipNotificationsFailed,
  publishReadyToShipNotifications,
  ReadyToShipNotificationEnqueueError,
} from '../src/readyToShipNotificationOutbox.ts';
import {
  NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS as READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS,
} from '../src/notificationOutboxPublication.ts';
import {
  BUYER_ORDER_RECEIVED_EMAIL_JOB_FIELD as BUYER_JOB,
  SHIPPER_READY_TO_SHIP_EMAIL_JOB_FIELD as SHIPPER_JOB,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD as ATTEMPTS,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD as CLAIM_EXPIRY,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD as CLAIM_ID,
  READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD as RETRY_UNTIL,
} from '../src/readyToShipNotifications.ts';
import {
  createCommerceD1Harness,
  seedCommerceDocuments,
  type CommerceD1CallObservation,
} from './commerceD1Harness.ts';

const NOW_MS = 1_700_000_000_000;
const READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS = 10 * 60_000;
const KEY = commerceKeys.deliveryOrder('card_nft_2', '7');
const BUYER_JOB_ID = '00000000-0000-4000-8000-000000000007';
const SHIPPER_JOB_ID = '00000000-0000-4000-9000-000000000007';

function buyerJob(): NotificationEmailJobV1 {
  return createNotificationEmailJobV1({
    jobId: BUYER_JOB_ID,
    kind: 'buyer_order_received',
    idempotencyKey: 'card_nft_2:7:order_received',
    recipients: ['original@example.com'],
    subject: 'Original subject',
    text: 'Original text',
    html: '<p>Original HTML</p>',
    context: { dropId: 'card_nft_2', deliveryId: 7 },
  });
}

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
  const commerce: CommerceRepositoryContext = {
    repository,
    nowMs: NOW_MS,
    signal: new AbortController().signal,
  };
  const load = async () => {
    const document = await readCommerceRecord(commerce, KEY);
    assert.ok(document);
    return document;
  };
  const publish = async (
    send: (jobs: NotificationEmailJobV1[]) => Promise<void> = async () => {},
    nowMs?: () => number,
  ) => (
    publishReadyToShipNotifications({
      context: commerce,
      deliveryId: 7,
      document: await load(),
      dropId: 'card_nft_2',
      nowMs: nowMs || (() => commerce.nowMs),
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

test('notification publication reuses each transaction read when claiming, freezing, and finalizing', async (context) => {
  const calls: CommerceD1CallObservation[] = [];
  const native = fixture(context, {}, { observeCall: (call) => calls.push(call) });
  calls.length = 0;

  assert.equal(await native.publish(), true);

  assert.equal(calls.length, 10);
  const transactionReads = calls.filter((call) => call.method === 'batch' &&
    call.statements.some(({ sql }) => /FROM commerce_document_path_revisions WHERE document_path = \?/.test(sql)));
  assert.equal(transactionReads.length, 3);
  assert.equal((await native.load()).data.buyerOrderReceivedEmailState, 'queued');
});

test('a competing claim causes a fresh transactional read without publishing', async (context) => {
  let raced = false;
  const native = fixture(context, {}, {
    observeBatchAfterCommit: ({ statements }) => {
      if (raced || !statements.some(({ sql }) => /FROM commerce_document_path_revisions WHERE document_path = \?/.test(sql))) return;
      raced = true;
      seedCommerceDocuments(native.harness, [{
        key: KEY,
        version: 2,
        data: order({
          [CLAIM_ID]: 'concurrent-claim',
          [CLAIM_EXPIRY]: NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS,
          [ATTEMPTS]: 1,
          concurrentValue: 'retained',
        }),
      }]);
    },
  });

  assert.equal(await native.publish(async () => assert.fail('competing claim reached the queue')), false);
  assert.equal(raced, true);
  const stored = (await native.load()).data;
  assert.equal(stored[CLAIM_ID], 'concurrent-claim');
  assert.equal(stored[ATTEMPTS], 1);
  assert.equal(stored.concurrentValue, 'retained');
});

test('a no-write notification update revalidates its read and retries changed markers', async (context) => {
  let raced = false;
  const native = fixture(context, { buyerOrderReceivedEmailState: 'queued' }, {
    observeBatchAfterCommit: ({ statements }) => {
      if (raced || !statements.some(({ sql }) => /FROM commerce_document_path_revisions WHERE document_path = \?/.test(sql))) return;
      raced = true;
      seedCommerceDocuments(native.harness, [{ key: KEY, version: 2, data: order({ concurrentValue: 'retained' }) }]);
    },
  });

  assert.deepEqual(await markPendingReadyToShipNotificationsFailed(native.commerce, KEY.path, 'invalid-notification-data'),
    ['buyerOrderReceivedEmailState']);
  assert.equal(raced, true);
  const stored = (await native.load()).data;
  assert.equal(stored.buyerOrderReceivedEmailState, 'failed');
  assert.equal(stored.concurrentValue, 'retained');
});

test('a no-write notification update revalidates authority after a maintenance pause', async (context) => {
  let paused = false;
  const native = fixture(context, { buyerOrderReceivedEmailState: 'queued' }, {
    observeBatchAfterCommit: ({ statements }) => {
      if (paused || !statements.some(({ sql }) => /FROM commerce_document_path_revisions WHERE document_path = \?/.test(sql))) return;
      paused = true;
      native.harness.database.exec(`INSERT INTO commerce_authority_control_lease (
        singleton, lease_token, acquired_at_ms, expires_at_ms
      ) VALUES (
        1, '00000000-0000-4000-8000-000000000107',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
      );
      UPDATE commerce_authority_control SET authority_state = 'paused',
        revision = revision + 1, paused_at_ms = NULL,
        updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE singleton = 1;
      DELETE FROM commerce_authority_control_lease;`);
    },
  });

  await assert.rejects(markPendingReadyToShipNotificationsFailed(native.commerce, KEY.path, 'invalid-notification-data'),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable');
  assert.equal(paused, true);
  const stored = native.harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?')
    .get(KEY.path) as { document_json: string };
  assert.equal(JSON.parse(stored.document_json).buyerOrderReceivedEmailState, 'queued');
});

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
    const claimed = (await native.load()).data;
    assert.equal(claimed[ATTEMPTS], 1);
    assert.equal(claimed[CLAIM_EXPIRY], NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS);
    assert.equal((await native.due()).length, 0);
    assert.equal(await native.publish(async () => { queueCalls += 1; }), false);
    assert.equal((await native.load()).data[CLAIM_ID], claimed[CLAIM_ID]);
  } finally {
    finish.resolve();
  }
  assert.equal(await first, true);
  assert.equal(queueCalls, 1);
  assert.equal((await native.load()).data.buyerOrderReceivedEmailState, 'queued');
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
  const released = (await native.load()).data;
  assert.equal(claimedAttempt, 1);
  assert.equal(released[ATTEMPTS], 0);
  assert.equal(released[CLAIM_ID], undefined);
  assert.equal(released[CLAIM_EXPIRY], undefined);
  assert.equal((await native.due()).length, 1);
});

for (const abort of [false, true]) {
  test(`ambiguous enqueue ${abort ? 'with cancellation ' : ''}retains its lease and exact payload after order changes`, async (context) => {
    const native = fixture(context);
    const controller = new AbortController();
    native.commerce.signal = controller.signal;
    const sends: NotificationEmailJobV1[][] = [];
    await assert.rejects(native.publish(async (jobs) => {
      sends.push(jobs);
      assert.deepEqual((await native.load()).data[BUYER_JOB], jobs[0]);
      if (abort) controller.abort(new DOMException('queue response lost', 'AbortError'));
      throw new Error('queue response lost');
    }), ReadyToShipNotificationEnqueueError);
    const pending = (await native.load()).data;
    assert.equal(pending.buyerOrderReceivedEmailState, 'pending');
    assert.equal(pending[ATTEMPTS], 1);
    assert.equal(pending[CLAIM_EXPIRY], NOW_MS + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS);
    assert.equal((await native.due()).length, 0);
    await native.repository.run(NOW_MS + 1, (unit) => unit.update(KEY, {
      addressSnapshot: { email: 'changed@example.com' },
      items: [{ kind: 'box', refId: 99 }],
    }));
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
    assert.deepEqual(sends[1], sends[0]);
    const completed = (await native.load()).data;
    assert.equal(completed[ATTEMPTS], 2);
    assert.equal(completed[CLAIM_ID], undefined);
    assert.equal(completed[BUYER_JOB], undefined);
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
  const pending = (await native.load()).data;
  assert.equal(pending.buyerOrderReceivedEmailState, 'pending');
  assert.equal(pending[ATTEMPTS], 1);
  assert.equal((await native.due()).length, 0);
  assert.deepEqual(pending[BUYER_JOB], sends[0][0]);
  await native.repository.run(NOW_MS + 1, (unit) => unit.update(KEY, {
    addressSnapshot: { email: 'changed@example.com' },
    items: [{ kind: 'box', refId: 99 }],
  }));
  native.commerce.nowMs += READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS;
  assert.equal(await native.publish(async (jobs) => { sends.push(jobs); }), true);
  assert.deepEqual(sends[0], sends[1]);
  assert.equal((await native.load()).data[BUYER_JOB], undefined);
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
  const partial = (await native.load()).data;
  assert.equal(partial.buyerOrderReceivedEmailState, 'pending');
  assert.equal(partial.shipperReadyToShipEmailState, 'queued');
  assert.equal(partial[SHIPPER_JOB], undefined);
  assert.equal(partial[BUYER_JOB], undefined);
  assert.equal(partial[ATTEMPTS], 1);
  assert.equal((await native.due()).length, 0);
  await native.repository.run(NOW_MS + 1, (unit) => unit.update(KEY, { addressSnapshot: { email: 'buyer@example.com' } }));
  native.commerce.nowMs += READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS;
  assert.equal(await native.publish(async (jobs) => { sends.push(jobs); }), true);
  assert.deepEqual(sends.map((jobs) => jobs.map(jobIdentity)), [
    [{ kind: 'shipper_ready_to_ship', jobId: SHIPPER_JOB_ID, idempotencyKey: 'card_nft_2:7:ready_to_ship' }],
    [{ kind: 'buyer_order_received', jobId: BUYER_JOB_ID, idempotencyKey: 'card_nft_2:7:order_received' }],
  ]);
  assert.equal((await native.load()).data[CLAIM_ID], undefined);
  assert.equal((await native.due()).length, 0);
});

test('a late first attempt starts a fresh retry window', async (context) => {
  const native = fixture(context, { [RETRY_UNTIL]: NOW_MS - 1 });
  assert.equal(await native.publish(), true);
  const completed = (await native.load()).data;
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
      [BUYER_JOB]: buyerJob(),
    });
    assert.equal(await native.publish(async () => assert.fail('exhausted notification was sent')), false);
    assert.equal((await native.load()).data.buyerOrderReceivedEmailState, 'pending');
    assert.equal((await native.due()).length, 0);
    native.commerce.nowMs += READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS;
    assert.equal(await native.publish(async () => assert.fail('exhausted notification was sent')), false);
    const failed = (await native.load()).data;
    assert.equal(failed.buyerOrderReceivedEmailState, 'failed');
    assert.equal(failed[ATTEMPTS], exhausted.attempts);
    assert.equal(failed.readyToShipNotificationLastErrorCode, 'manual-review-required');
    assert.equal(failed[CLAIM_ID], undefined);
    assert.equal(failed[BUYER_JOB], undefined);
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
  const completed = (await native.load()).data;
  assert.equal(completed.buyerOrderReceivedEmailState, 'failed');
  assert.equal(completed.shipperReadyToShipEmailState, 'queued');
  assert.equal((await native.due()).length, 0);
});

test('failed snapshot persistence prevents enqueue and leaves the legacy pending marker recoverable', async (context) => {
  const unavailable = new Error('snapshot database unavailable');
  let writes = 0;
  const native = fixture(context, {}, {
    observeCall: (call) => {
      if (call.method !== 'batch' || !call.statements.some(({ sql }) => /INSERT INTO commerce_documents/.test(sql))) return;
      if (++writes === 2) throw unavailable;
    },
  });
  await assert.rejects(native.publish(async () => assert.fail('unpersisted snapshot reached queue')), (error: unknown) => (
    error instanceof ReadyToShipNotificationEnqueueError && error.cause === unavailable
  ));
  const pending = (await native.load()).data;
  assert.equal(pending.buyerOrderReceivedEmailState, 'pending');
  assert.equal(pending[BUYER_JOB], undefined);
  assert.equal(pending[ATTEMPTS], 1);
  native.commerce.nowMs += READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS;
  assert.equal(await native.publish(), true);
});

test('cancellation after snapshot persistence retains its payload and restores the unused attempt', async (context) => {
  const controller = new AbortController();
  const cancellation = new DOMException('cancelled after snapshot', 'AbortError');
  let snapshot: unknown;
  const native = fixture(context, {}, {
    observeBatchAfterCommit: () => {
      if (snapshot) return;
      const row = native.harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?')
        .get(KEY.path) as { document_json: string };
      snapshot = JSON.parse(row.document_json)[BUYER_JOB];
      if (snapshot) controller.abort(cancellation);
    },
  });
  native.commerce.signal = controller.signal;
  await assert.rejects(native.publish(async () => assert.fail('cancelled snapshot reached queue')), cancellation);
  const released = (await native.load()).data;
  assert.ok(snapshot);
  assert.deepEqual(released[BUYER_JOB], snapshot);
  assert.equal(released[ATTEMPTS], 0);
  assert.equal(released[CLAIM_ID], undefined);
  assert.equal(released[CLAIM_EXPIRY], undefined);
  await native.repository.run(NOW_MS + 1, (unit) => unit.update(KEY, {
    addressSnapshot: { email: 'changed@example.com' },
    items: [{ kind: 'box', refId: 99 }],
  }));
  native.commerce.signal = new AbortController().signal;
  assert.equal(await native.publish(async (jobs) => { assert.deepEqual(jobs, [snapshot]); }), true);
});

for (const [name, replacement] of Object.entries({
  claim: { [CLAIM_ID]: 'replacement-claim' },
  status: { status: 'shipped' },
  marker: { buyerOrderReceivedEmailJobId: '00000000-0000-4000-8000-000000000008' },
})) {
  test(`a changed ${name} before snapshot persistence blocks sending without clobbering its replacement`, async (context) => {
    let replaced = false;
    const native = fixture(context, {}, {
      observeBatchAfterCommit: () => {
        if (replaced) return;
        const row = native.harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?')
          .get(KEY.path) as { document_json: string };
        const fields = JSON.parse(row.document_json);
        if (!fields[CLAIM_ID]) return;
        replaced = true;
        seedCommerceDocuments(native.harness, [{ key: KEY, version: 3, data: { ...fields, ...replacement } }]);
      },
    });
    await assert.rejects(native.publish(async () => assert.fail('replaced claim reached queue')), ReadyToShipNotificationEnqueueError);
    assert.equal(replaced, true);
    const current = (await native.load()).data;
    for (const [field, value] of Object.entries(replacement)) assert.equal(current[field], value);
    assert.equal(current[BUYER_JOB], undefined);
  });
}

test('an expired claim before snapshot persistence cannot enqueue', async (context) => {
  let nowMs = NOW_MS;
  const native = fixture(context, {}, {
    observeBatchAfterCommit: () => {
      const row = native.harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?')
        .get(KEY.path) as { document_json: string };
      if (JSON.parse(row.document_json)[CLAIM_ID]) nowMs += READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS;
    },
  });
  await assert.rejects(native.publish(
    async () => assert.fail('expired claim reached queue'),
    () => nowMs,
  ), /claim expired/);
  const pending = (await native.load()).data;
  assert.equal(pending.buyerOrderReceivedEmailState, 'pending');
  assert.equal(pending[ATTEMPTS], 1);
  assert.equal(pending[BUYER_JOB], undefined);
});

for (const [name, snapshot] of Object.entries({
  malformed: { ...buyerJob(), html: '' },
  identity: { ...buyerJob(), jobId: SHIPPER_JOB_ID },
  context: { ...buyerJob(), context: { dropId: 'card_nft_2', deliveryId: 8 } },
})) {
  test(`a ${name} snapshot fails only its marker and allows its sibling to publish`, async (context) => {
    const native = fixture(context, {
      [BUYER_JOB]: snapshot,
      shipperReadyToShipEmailState: 'pending',
      shipperReadyToShipEmailJobId: SHIPPER_JOB_ID,
      shipperReadyToShipEmailIdempotencyKey: 'card_nft_2:7:ready_to_ship',
    });
    assert.equal(await native.publish(async (jobs) => {
      assert.deepEqual(jobs.map((job) => job.kind), ['shipper_ready_to_ship']);
    }), true);
    const completed = (await native.load()).data;
    assert.equal(completed.buyerOrderReceivedEmailState, 'failed');
    assert.equal(completed.shipperReadyToShipEmailState, 'queued');
    assert.equal(completed[BUYER_JOB], undefined);
    assert.equal(completed[SHIPPER_JOB], undefined);
    assert.equal(completed[CLAIM_ID], undefined);
  });
}

test('snapshot corruption after claiming is failed transactionally while a valid sibling publishes', async (context) => {
  let replaced = false;
  const native = fixture(context, {
    shipperReadyToShipEmailState: 'pending',
    shipperReadyToShipEmailJobId: SHIPPER_JOB_ID,
    shipperReadyToShipEmailIdempotencyKey: 'card_nft_2:7:ready_to_ship',
  }, {
    observeBatchAfterCommit: () => {
      if (replaced) return;
      const row = native.harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?')
        .get(KEY.path) as { document_json: string };
      const fields = JSON.parse(row.document_json);
      if (!fields[CLAIM_ID]) return;
      replaced = true;
      seedCommerceDocuments(native.harness, [{
        key: KEY,
        version: 3,
        data: { ...fields, [BUYER_JOB]: { ...buyerJob(), jobId: SHIPPER_JOB_ID } },
      }]);
    },
  });
  assert.equal(await native.publish(async (jobs) => {
    assert.deepEqual(jobs.map((job) => job.kind), ['shipper_ready_to_ship']);
  }), true);
  const completed = (await native.load()).data;
  assert.equal(completed.buyerOrderReceivedEmailState, 'failed');
  assert.equal(completed.shipperReadyToShipEmailState, 'queued');
  assert.equal(completed[BUYER_JOB], undefined);
  assert.equal(completed[CLAIM_ID], undefined);
});

test('stale invalid snapshot cleanup preserves a concurrently replaced valid marker', async (context) => {
  const native = fixture(context, { [BUYER_JOB]: { invalid: true } });
  const observed = await native.load();
  const replacement = buyerJob();
  await native.repository.run(NOW_MS + 1, (unit) => unit.update(KEY, { [BUYER_JOB]: replacement }));
  assert.deepEqual(await markPendingReadyToShipNotificationsFailed(
    native.commerce,
    KEY.path,
    'invalid-notification-data',
    ['buyerOrderReceivedEmailState'],
    observed.updateTime,
  ), []);
  const current = (await native.load()).data;
  assert.equal(current.buyerOrderReceivedEmailState, 'pending');
  assert.deepEqual(current[BUYER_JOB], replacement);
  assert.equal(await native.publish(async (jobs) => { assert.deepEqual(jobs, [replacement]); }), true);
});
