import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CommerceRepositoryError,
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
  d1RetryCount,
} from '../src/commerceRepository.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

function pauseCommerce(harness: ReturnType<typeof createCommerceD1Harness>): void {
  const nowMsSql = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
  harness.database.exec(`INSERT INTO commerce_authority_control_lease (
    singleton, lease_token, acquired_at_ms, expires_at_ms
  ) VALUES (
    1, '123e4567-e89b-42d3-a456-426614174000',
    ${nowMsSql}, ${nowMsSql} + 60000
  )`);
  harness.database.exec(`UPDATE commerce_authority_control SET
    authority_state = 'paused', revision = revision + 1, paused_at_ms = NULL,
    updated_at_ms = ${nowMsSql}
    WHERE singleton = 1`);
  harness.database.exec('DELETE FROM commerce_authority_control_lease');
}

function isUnavailableCommerceError(error: unknown): boolean {
  assert.ok(error instanceof CommerceRepositoryError);
  assert.equal(error.code, 'unavailable');
  return true;
}

function createPausingDocumentReadHarness(): ReturnType<typeof createCommerceD1Harness> {
  let harness: ReturnType<typeof createCommerceD1Harness>;
  let armed = true;
  harness = createCommerceD1Harness({
    observeStatement: ({ method, sql }) => {
      const normalized = sql.replace(/\s+/g, ' ');
      if (
        armed &&
        (method === 'first' || method === 'all') &&
        normalized.includes('FROM commerce_documents')
      ) {
        armed = false;
        pauseCommerce(harness);
      }
    },
  });
  return harness;
}

function createChangingQueryHarness(
  seed: (harness: ReturnType<typeof createCommerceD1Harness>) => void,
): {
  authorityReads: () => number;
  harness: ReturnType<typeof createCommerceD1Harness>;
  queryReads: () => number;
} {
  let harness: ReturnType<typeof createCommerceD1Harness>;
  let authorityReads = 0;
  let queryReads = 0;
  harness = createCommerceD1Harness({
    observeStatement: ({ method, sql }) => {
      const normalized = sql.replace(/\s+/g, ' ');
      if (method === 'first' && normalized.includes(
        'FROM commerce_authority_control WHERE singleton = 1',
      )) authorityReads += 1;
      if (method !== 'all' || !normalized.includes('FROM commerce_documents')) return;
      queryReads += 1;
      if (queryReads !== 1) return;
      harness.database.exec('BEGIN');
      try {
        seed(harness);
        harness.database.exec(`UPDATE commerce_authority_control
          SET documents_revision = documents_revision + 1 WHERE singleton = 1`);
        harness.database.exec('COMMIT');
      } catch (error) {
        harness.database.exec('ROLLBACK');
        throw error;
      }
    },
  });
  return {
    authorityReads: () => authorityReads,
    harness,
    queryReads: () => queryReads,
  };
}

function createContinuousRevisionRacingHarness(): {
  authorityReads: () => number;
  harness: ReturnType<typeof createCommerceD1Harness>;
} {
  let harness: ReturnType<typeof createCommerceD1Harness>;
  let authorityReads = 0;
  harness = createCommerceD1Harness({
    observeStatement: ({ method, sql }) => {
      if (
        method === 'first' &&
        sql.replace(/\s+/g, ' ').includes(
          'FROM commerce_authority_control WHERE singleton = 1',
        )
      ) {
        authorityReads += 1;
        if (authorityReads % 2 === 1) {
          harness.database.exec(`UPDATE commerce_authority_control
            SET documents_revision = documents_revision + 1 WHERE singleton = 1`);
        }
      }
    },
  });
  return { authorityReads: () => authorityReads, harness };
}

test('native repository keys cover every commerce document kind', () => {
  assert.equal(commerceKeys.claimCode('ABC').path, 'claimCodes/ABC');
  assert.equal(commerceKeys.deliveryOrder('poncho', '7').path, 'drops/poncho/deliveryOrders/7');
  assert.equal(commerceKeys.stripeCheckout('poncho', 'cs_1').path, 'drops/poncho/stripeCheckouts/cs_1');
  assert.equal(commerceKeys.boxAssignment('poncho', 'asset').path, 'drops/poncho/boxAssignments/asset');
  assert.equal(commerceKeys.dudeAssignment('poncho', '1').path, 'drops/poncho/dudeAssignments/1');
  assert.equal(commerceKeys.dudePool('poncho').path, 'drops/poncho/meta/dudePool');
  assert.equal(commerceKeys.offchainOrder('poncho', 'hash').path, 'drops/poncho/offchainOrders/hash');
  assert.equal(
    commerceKeys.adminIrlRedeemRequest('poncho', 'id').path,
    'drops/poncho/adminIrlRedeemRequests/id',
  );
  assert.equal(
    commerceKeys.adminIrlRedeemPackMarker('poncho', 'id').path,
    'drops/poncho/adminIrlRedeemPackMarkers/id',
  );
  assert.equal(
    commerceKeys.adminIrlRedeemReceiptMarker('poncho', 'id').path,
    'drops/poncho/adminIrlRedeemReceiptMarkers/id',
  );
  assert.throws(() => commerceKeys.claimCode('café'), /Invalid commerce document key/);
  assert.throws(() => commerceKeys.deliveryOrder('drop', 'bad id'), /Invalid commerce document key/);
  assert.throws(() => commerceKeys.deliveryOrder('dröp', '1'), /Invalid commerce document key/);
});

test('D1 query telemetry reports retries rather than total attempts', () => {
  assert.equal(d1RetryCount({ total_attempts: 1 }), 0);
  assert.equal(d1RetryCount({ total_attempts: 3 }), 2);
  assert.equal(d1RetryCount({}), 0);
});

test('native writes persist canonical documents and lossless cursor timestamps', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.deliveryOrder('poncho', '7');
  await repository.run(1_700_000_000_123, async (unit) => {
    await unit.create(key, {
      attempts: 1,
      owner: 'wallet',
      processedAt: commerceFieldValue.timestamp(1_700_000_000, 123_000_001),
      status: 'processing',
    });
  });
  await repository.run(1_700_000_001_456, async (unit) => {
    await unit.update(key, {
      attempts: commerceFieldValue.increment(2),
      status: 'ready_to_ship',
      updatedAt: commerceFieldValue.serverTimestamp(),
    });
  });

  const record = await repository.get(key);
  assert.deepEqual(record?.data, {
    attempts: 3,
    owner: 'wallet',
    processedAt: 1_700_000_000_123,
    status: 'ready_to_ship',
    updatedAt: 1_700_000_001_456,
  });
  assert.deepEqual(record?.processedAt, { seconds: 1_700_000_000, nanos: 123_000_001 });
  assert.equal(record?.version, 2);
  assert.deepEqual(
    { ...harness.database.prepare(`SELECT document_json, processed_at_seconds, processed_at_nanos
      FROM commerce_documents WHERE document_path = ?`).get(key.path) },
    {
      document_json: JSON.stringify(record?.data),
      processed_at_seconds: 1_700_000_000,
      processed_at_nanos: 123_000_001,
    },
  );
  assert.equal(
    harness.database.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('commerce_documents')
      WHERE name = 'fields_json'`).get()!.count,
    0,
  );
});

test('plain JSON objects with mutation-like kind fields remain document data', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.claimCode('PLAIN-JSON');
  const collisions = {
    arrayUnion: { kind: 'array-union', values: [1, 2] },
    deleteField: { kind: 'delete-field' },
    increment: { kind: 'increment', amount: 2 },
    serverTimestamp: { kind: 'server-timestamp' },
    timestamp: { kind: 'timestamp', value: { seconds: 1, nanos: 2 } },
  };

  await repository.run(10, async (unit) => {
    await unit.create(key, collisions);
  });

  assert.deepEqual((await repository.get(key))?.data, collisions);
});

test('native cursors preserve nanosecond and document-path ordering', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(10, async (unit) => {
    await unit.create(commerceKeys.deliveryOrder('poncho', '1'), {
      processedAt: commerceFieldValue.timestamp(1_787_054_400, 123_000_001),
      status: 'ready_to_ship',
    });
    await unit.create(commerceKeys.deliveryOrder('poncho', '2'), {
      processedAt: commerceFieldValue.timestamp(1_787_054_400, 123_000_002),
      status: 'ready_to_ship',
    });
    await unit.create(commerceKeys.deliveryOrder('poncho', '3'), {
      processedAt: commerceFieldValue.timestamp(1_787_054_400, 123_000_002),
      status: 'ready_to_ship',
    });
  });

  assert.deepEqual(
    harness.database.prepare(`SELECT document_id, processed_at_seconds, processed_at_nanos
      FROM commerce_documents ORDER BY document_id`).all().map((row) => ({ ...row })),
    [
      { document_id: '1', processed_at_seconds: 1_787_054_400, processed_at_nanos: 123_000_001 },
      { document_id: '2', processed_at_seconds: 1_787_054_400, processed_at_nanos: 123_000_002 },
      { document_id: '3', processed_at_seconds: 1_787_054_400, processed_at_nanos: 123_000_002 },
    ],
  );

  const records = await repository.query({
    dropId: 'poncho',
    filters: [{ field: 'status', op: 'equal', value: 'ready_to_ship' }],
    kind: 'delivery_order',
    orderBy: [
      { field: 'processedAt', direction: 'desc' },
      { field: 'documentPath', direction: 'desc' },
    ],
    startAfter: [
      { seconds: 1_787_054_400, nanos: 123_000_002 },
      'drops/poncho/deliveryOrders/3',
    ],
  });
  assert.deepEqual(records.map((record) => record.key.documentId), ['2', '1']);
});

test('native queries apply every filter, boolean, order, cursor, and limit in D1', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(10, async (unit) => {
    await unit.create(commerceKeys.stripeCheckout('drop', 'a'), {
      fulfillmentProcessor: 'queue',
      manualRefundReviewRequired: true,
      status: 'processing',
    });
    await unit.create(commerceKeys.stripeCheckout('drop', 'b'), {
      fulfillmentProcessor: 'queue',
      manualRefundReviewRequired: true,
      status: 'pending',
    });
    await unit.create(commerceKeys.stripeCheckout('drop', 'c'), {
      fulfillmentProcessor: 'other',
      manualRefundReviewRequired: true,
      status: 'processing',
    });
  });
  const records = await repository.query({
    dropId: 'drop',
    filters: [
      { field: 'fulfillmentProcessor', op: 'equal', value: 'queue' },
      { field: 'status', op: 'in', value: ['processing', 'pending'] },
      { field: 'manualRefundReviewRequired', op: 'equal', value: true },
    ],
    kind: 'stripe_checkout',
    limit: 1,
    orderBy: [{ field: 'documentPath', direction: 'desc' }],
    startAfter: ['drops/drop/stripeCheckouts/c'],
  });
  assert.deepEqual(records.map((record) => record.key.documentId), ['b']);
});

test('native reconciliation queries are bounded, ordered, and duplicate-free', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(10, async (unit) => {
    await unit.create(commerceKeys.deliveryOrder('drop', '1'), {
      buyerOrderReceivedEmailState: 'pending',
      owner: 'owner-a',
      packStatusProjectionNextAttemptAtMs: 30,
      packStatusProjectionState: 'pending',
      shipperReadyToShipEmailState: 'pending',
      status: 'ready_to_ship',
    });
    await unit.create(commerceKeys.deliveryOrder('drop', '2'), {
      buyerOrderReceivedEmailState: 'queued',
      owner: 'owner-a',
      packStatusProjectionNextAttemptAtMs: 10,
      packStatusProjectionState: 'pending',
      shipperReadyToShipEmailState: 'pending',
      status: 'ready_to_ship',
    });
    await unit.create(commerceKeys.deliveryOrder('drop', '3'), {
      buyerOrderReceivedEmailState: 'queued',
      owner: 'owner-b',
      packStatusProjectionNextAttemptAtMs: 20,
      packStatusProjectionState: 'pending',
      shipperReadyToShipEmailState: 'queued',
      status: 'ready_to_ship',
    });
    await unit.create(commerceKeys.stripeCheckout('drop', 'recent'), {
      fulfillmentProcessor: 'cloudflare_queue_v1',
      status: 'processing',
      updatedAt: 40,
    });
    await unit.create(commerceKeys.stripeCheckout('drop', 'old'), {
      fulfillmentProcessor: 'cloudflare_queue_v1',
      lastStripeWebhookEventId: 'evt_old',
      status: 'fulfillment_pending',
      updatedAt: 5,
    });
    for (let index = 0; index < 101; index += 1) {
      await unit.create(commerceKeys.stripeCheckout('drop', `malformed-${String(index).padStart(3, '0')}`), {
        fulfillmentProcessor: 'cloudflare_queue_v1',
        status: 'fulfillment_pending',
        updatedAt: index,
      });
    }
  });
  const pending = await repository.queryPendingReadyNotifications({ owner: 'owner-a', limit: 8 });
  assert.deepEqual(pending.map((record) => record.key.documentId), ['1', '2']);
  const after = await repository.queryPendingReadyNotifications({
    limit: 8,
    startAfterPath: 'drops/drop/deliveryOrders/1',
  });
  assert.deepEqual(after.map((record) => record.key.documentId), ['2']);
  const due = await repository.queryDuePackStatusProjections({ dropId: 'drop', dueAtMs: 25, limit: 4 });
  assert.deepEqual(due.map((record) => record.key.documentId), ['2', '3']);
  const stale = await repository.queryStaleStripeFulfillments(20);
  assert.deepEqual(stale.map((record) => record.key.documentId), ['old']);
});

test('native timestamps remain monotonic and path ordering is binary', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const existing = commerceKeys.claimCode('existing');
  await repository.run(2_000, async (unit) => unit.create(existing, {
    updatedAt: commerceFieldValue.serverTimestamp(),
  }));
  const before = await repository.get(existing);
  await repository.run(1_000, async (unit) => unit.update(existing, {
    updatedAt: commerceFieldValue.serverTimestamp(),
  }));
  const after = await repository.get(existing);
  assert.equal(after?.data.updatedAt, 2_001);
  assert.equal(Boolean(before && after && after.updateTime > before.updateTime), true);

  await repository.run(3_000, async (unit) => {
    await unit.create(commerceKeys.claimCode('a'), {});
    await unit.create(commerceKeys.claimCode('_'), {});
    await unit.create(commerceKeys.claimCode('A'), {});
  });
  const ordered = await repository.query({
    kind: 'claim_code',
    orderBy: [{ field: 'documentPath', direction: 'asc' }],
  });
  assert.deepEqual(ordered.map((record) => record.key.documentId), ['A', '_', 'a', 'existing']);
});

test('point reads and queries conflict on stale versions and collection revisions', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const first = commerceKeys.stripeCheckout('poncho', 'first');
  const second = commerceKeys.stripeCheckout('poncho', 'second');
  await repository.run(10, async (unit) => unit.create(first, { status: 'open' }));

  const pointUnit = await repository.begin(11);
  await pointUnit.get(first);
  await pointUnit.update(first, { status: 'complete' });
  await repository.run(12, async (unit) => unit.update(first, { status: 'paid' }));
  await assert.rejects(pointUnit.commit(), (error: unknown) => {
    assert.ok(error instanceof CommerceWriteConflict);
    assert.equal(error.code, 'aborted');
    return true;
  });

  const queryUnit = await repository.begin(13);
  await queryUnit.query({ kind: 'stripe_checkout', filters: [{ field: 'status', op: 'equal', value: 'paid' }] });
  await queryUnit.create(second, { status: 'open' });
  await repository.run(14, async (unit) => unit.create(commerceKeys.claimCode('NEW'), { status: 'unused' }));
  await assert.rejects(queryUnit.commit(), (error: unknown) => {
    assert.ok(error instanceof CommerceWriteConflict);
    assert.equal(error.code, 'aborted');
    return true;
  });
  assert.equal(await repository.get(second), null);

  const readOnlyQueryUnit = await repository.begin(15);
  await readOnlyQueryUnit.query({
    kind: 'stripe_checkout',
    filters: [{ field: 'status', op: 'equal', value: 'paid' }],
  });
  await repository.run(16, async (unit) => unit.create(commerceKeys.claimCode('LATEST'), { status: 'unused' }));
  await assert.rejects(readOnlyQueryUnit.commit(), (error: unknown) => {
    assert.ok(error instanceof CommerceWriteConflict);
    assert.equal(error.code, 'aborted');
    return true;
  });
});

test('native preconditions distinguish create, existence, and version conflicts atomically', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const existing = commerceKeys.claimCode('EXISTING');
  const missing = commerceKeys.claimCode('MISSING');
  await repository.run(10, async (unit) => unit.create(existing, { status: 'unused' }));

  await assert.rejects(repository.run(11, async (unit) => unit.create(existing, { status: 'duplicate' })),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'already-exists');
  await assert.rejects(repository.run(12, async (unit) => unit.update(missing, { status: 'used' })),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'failed-precondition');

  const createRace = await repository.begin(13);
  await createRace.create(missing, { status: 'first' });
  await repository.run(14, async (unit) => unit.create(missing, { status: 'second' }));
  await assert.rejects(createRace.commit(),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'already-exists');

  const replacement = commerceKeys.claimCode('REPLACEMENT');
  const deleteRace = await repository.begin(15);
  await deleteRace.update(existing, { status: 'used' });
  await deleteRace.create(replacement, { status: 'unused' });
  await repository.run(16, async (unit) => unit.delete(existing, { mustExist: true }));
  await assert.rejects(deleteRace.commit(),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'failed-precondition');
  assert.equal(await repository.get(replacement), null);
});

test('units revalidate cached authority when committing after a pause', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.claimCode('ABC');
  await repository.run(10, async (unit) => unit.create(key, { status: 'unused' }));
  const storedBefore = {
    ...harness.database.prepare(`SELECT document_json, version FROM commerce_documents
      WHERE document_path = ?`).get(key.path),
  };
  const revisionBefore = Number(harness.database.prepare(`SELECT documents_revision
    FROM commerce_authority_control WHERE singleton = 1`).get()!.documents_revision);
  const readOnlyUnit = await repository.begin(11);
  await readOnlyUnit.get(key);
  const writeUnit = await repository.begin(12);
  await writeUnit.get(key);

  pauseCommerce(harness);
  await writeUnit.update(key, { status: 'used' });

  await assert.rejects(readOnlyUnit.commit(), isUnavailableCommerceError);
  await assert.rejects(writeUnit.commit(), isUnavailableCommerceError);
  assert.deepEqual({
    ...harness.database.prepare(`SELECT document_json, version FROM commerce_documents
      WHERE document_path = ?`).get(key.path),
  }, storedBefore);
  assert.equal(
    Number(harness.database.prepare(`SELECT documents_revision
      FROM commerce_authority_control WHERE singleton = 1`).get()!.documents_revision),
    revisionBefore,
  );
  assert.equal(
    harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').get()!.count,
    0,
  );
});

test('native repository fails closed while commerce is paused', async () => {
  const harness = createCommerceD1Harness();
  pauseCommerce(harness);
  const repository = new D1CommerceRepository(harness.db);
  await assert.rejects(repository.get(commerceKeys.claimCode('ABC')), isUnavailableCommerceError);
});

test('repository read helpers revalidate authority after reading', async () => {
  const getHarness = createPausingDocumentReadHarness();
  await assert.rejects(
    new D1CommerceRepository(getHarness.db).get(commerceKeys.claimCode('ABC')),
    isUnavailableCommerceError,
  );

  const queryHarness = createPausingDocumentReadHarness();
  await assert.rejects(
    new D1CommerceRepository(queryHarness.db).query({ kind: 'claim_code' }),
    isUnavailableCommerceError,
  );

  const pendingHarness = createPausingDocumentReadHarness();
  await assert.rejects(
    new D1CommerceRepository(pendingHarness.db).queryPendingReadyNotifications({ limit: 1 }),
    isUnavailableCommerceError,
  );

  const projectionHarness = createPausingDocumentReadHarness();
  await assert.rejects(
    new D1CommerceRepository(projectionHarness.db).queryDuePackStatusProjections({
      dropId: 'drop',
      dueAtMs: 1,
      limit: 1,
    }),
    isUnavailableCommerceError,
  );

  const fulfillmentHarness = createPausingDocumentReadHarness();
  await assert.rejects(
    new D1CommerceRepository(fulfillmentHarness.db).queryStaleStripeFulfillments(1),
    isUnavailableCommerceError,
  );
});

test('point reads perform only begin and final authority checks', async () => {
  let authorityReads = 0;
  const harness = createCommerceD1Harness({
    observeStatement: ({ method, sql }) => {
      if (method === 'first' && sql.includes('FROM commerce_authority_control')) authorityReads += 1;
    },
  });
  await new D1CommerceRepository(harness.db).get(commerceKeys.claimCode('MISSING'));
  assert.equal(authorityReads, 2);
});

test('public queries retry one collection revision conflict', async () => {
  const racing = createChangingQueryHarness((harness) => seedCommerceDocument(harness, {
    key: commerceKeys.claimCode('NEW'),
    data: { status: 'unused' },
  }));
  const records = await new D1CommerceRepository(racing.harness.db).query({ kind: 'claim_code' });
  assert.deepEqual(records.map((record) => record.key.documentId), ['NEW']);
  assert.equal(racing.authorityReads(), 4);
  assert.equal(racing.queryReads(), 2);

  const specialized = createChangingQueryHarness((harness) => seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder('drop', '1'),
    data: {
      packStatusProjectionNextAttemptAtMs: 0,
      packStatusProjectionState: 'pending',
    },
  }));
  const due = await new D1CommerceRepository(specialized.harness.db).queryDuePackStatusProjections({
    dropId: 'drop',
    dueAtMs: 1,
    limit: 1,
  });
  assert.deepEqual(due.map((record) => record.key.documentId), ['1']);
  assert.equal(specialized.authorityReads(), 4);
  assert.equal(specialized.queryReads(), 2);
});

test('public queries map continuous collection revision conflicts to unavailable', async () => {
  const racing = createContinuousRevisionRacingHarness();
  await assert.rejects(
    new D1CommerceRepository(racing.harness.db).query({ kind: 'claim_code' }),
    isUnavailableCommerceError,
  );
  assert.equal(racing.authorityReads(), 6);

  const specialized = createContinuousRevisionRacingHarness();
  await assert.rejects(
    new D1CommerceRepository(specialized.harness.db).queryDuePackStatusProjections({
      dropId: 'drop',
      dueAtMs: 1,
      limit: 1,
    }),
    isUnavailableCommerceError,
  );
  assert.equal(specialized.authorityReads(), 6);
});
