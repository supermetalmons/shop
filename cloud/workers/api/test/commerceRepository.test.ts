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
import {
  type CommerceD1BatchObservation,
  type CommerceD1CallObservation,
  createCommerceD1Harness,
  seedCommerceDocument,
  seedCommerceDocuments,
} from './commerceD1Harness.ts';

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

function assertAuthoritativeReadBatch(observation: CommerceD1BatchObservation): void {
  assert.equal(observation.statements.length, 2);
  const authoritySql = observation.statements[0].sql.replace(/\s+/g, ' ');
  const dataSql = observation.statements[1].sql.replace(/\s+/g, ' ');
  assert.match(
    authoritySql,
    /FROM commerce_authority_control WHERE singleton = 1/,
  );
  assert.match(dataSql, /(?:FROM|JOIN) commerce_documents/);
  assert.match(dataSql, /FROM commerce_authority_control AS authority CROSS JOIN/);
  assert.match(dataSql, /authority\.singleton\s*=\s*1/);
  assert.match(dataSql, /authority_state\s*=\s*'d1'/);
}

function assertDeliveryOwnerReadBatch(observation: CommerceD1BatchObservation): void {
  assert.equal(observation.statements.length, 2);
  const revisionSql = observation.statements[0].sql.replace(/\s+/g, ' ');
  const dataSql = observation.statements[1].sql.replace(/\s+/g, ' ');
  assert.match(
    revisionSql,
    /SELECT COALESCE\(\( SELECT revision FROM commerce_delivery_owner_revisions WHERE owner = \? \), 0\) AS revision/,
  );
  assert.match(dataSql, /INDEXED BY commerce_documents_delivery_owner_path/);
  assert.match(dataSql, /document_kind = 'delivery_order' AND owner = \?/);
  assert.match(dataSql, /ORDER BY document_path ASC\s+LIMIT \?/);
}

function assertReadOnlyRevalidationBatch(observation: CommerceD1BatchObservation): void {
  assert.equal(observation.statements.length, 3);
  assert.match(
    observation.statements[0].sql.replace(/\s+/g, ' '),
    /FROM commerce_authority_control WHERE singleton = 1/,
  );
  assert.match(observation.statements[1].sql, /json_each\(\?\)/);
  assert.match(observation.statements[1].sql, /commerce_delivery_owner_revisions/);
  assert.match(observation.statements[2].sql, /json_each\(\?\)/);
  assert.match(observation.statements[2].sql, /commerce_documents/);
}

async function readWithSingleBatch<T>(
  calls: CommerceD1CallObservation[],
  operation: () => Promise<T>,
): Promise<T> {
  const previousCount = calls.length;
  const result = await operation();
  assert.equal(calls.length, previousCount + 1);
  const call = calls[previousCount];
  assert.equal(call.method, 'batch');
  if (call.method !== 'batch') assert.fail('Expected one D1 batch call.');
  assertAuthoritativeReadBatch(call);
  return result;
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

test('delivery-order owner pagination uses a distinct indexed keyset query', async () => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  const ownerA = '11111111111111111111111111111111';
  const ownerB = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
  const ownerC = 'So11111111111111111111111111111111111111112';
  seedCommerceDocuments(harness, [
    { key: commerceKeys.deliveryOrder('drop', '1'), data: { owner: ownerC } },
    { key: commerceKeys.deliveryOrder('drop', '2'), data: { owner: ownerA } },
    { key: commerceKeys.deliveryOrder('drop', '3'), data: { owner: ownerB } },
    { key: commerceKeys.deliveryOrder('other', '4'), data: { owner: ownerA } },
    { key: commerceKeys.deliveryOrder('drop', '5'), data: {} },
    { key: commerceKeys.deliveryOrder('drop', '6'), data: { owner: 'anonymous:subject' } },
    { key: commerceKeys.stripeCheckout('drop', 'checkout'), data: { owner: ownerA } },
  ]);
  const repository = new D1CommerceRepository(harness.db);

  const first = await repository.queryDeliveryOrderOwners({ limit: 2 });
  assert.deepEqual(first, [ownerA, ownerB]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'batch');
  if (calls[0].method !== 'batch') assert.fail('Expected one D1 batch call.');
  assertAuthoritativeReadBatch(calls[0]);
  const firstSql = calls[0].statements[1].sql.replace(/\s+/g, ' ');
  assert.match(firstSql, /SELECT DISTINCT document\.owner AS owner/);
  assert.match(firstSql, /INDEXED BY commerce_documents_delivery_owner_path/);
  assert.match(firstSql, /document\.document_kind = 'delivery_order'/);
  assert.match(firstSql, /document\.owner IS NOT NULL/);
  assert.match(firstSql, /typeof\(document\.owner\) = 'text'/);
  assert.match(firstSql, /length\(document\.owner\) BETWEEN 32 AND 44/);
  assert.match(firstSql, /document\.owner NOT GLOB '\*\[\^0-9A-Za-z\]\*'/);
  assert.match(firstSql, /document\.owner NOT GLOB '\*\[0OIl\]\*'/);
  assert.doesNotMatch(firstSql, /document_json|document_path AS/);
  assert.doesNotMatch(firstSql, /document\.owner > \?/);
  assert.match(firstSql, /ORDER BY document\.owner ASC LIMIT \?/);

  calls.length = 0;
  const second = await repository.queryDeliveryOrderOwners({ startAfterOwner: ownerB, limit: 2 });
  assert.deepEqual(second, [ownerC]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'batch');
  if (calls[0].method !== 'batch') assert.fail('Expected one D1 batch call.');
  assertAuthoritativeReadBatch(calls[0]);
  assert.match(calls[0].statements[1].sql.replace(/\s+/g, ' '), /document\.owner > \?/);

  const plan = harness.database.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT document.owner AS owner
    FROM commerce_authority_control AS authority
    CROSS JOIN commerce_documents AS document INDEXED BY commerce_documents_delivery_owner_path
    WHERE
      authority.singleton = 1 AND
      authority.authority_state = 'd1' AND
      document.document_kind = 'delivery_order' AND
      document.owner IS NOT NULL AND
      typeof(document.owner) = 'text' AND
      length(document.owner) BETWEEN 32 AND 44 AND
      document.owner NOT GLOB '*[^0-9A-Za-z]*' AND
      document.owner NOT GLOB '*[0OIl]*' AND
      document.owner > '${ownerB}'
    ORDER BY document.owner ASC
    LIMIT 2`).all().map((row) => String(row.detail || ''));
  assert.equal(
    plan.some((detail) => detail.includes('SEARCH document USING INDEX commerce_documents_delivery_owner_path')),
    true,
  );
  assert.equal(plan.some((detail) => detail.includes('USE TEMP B-TREE')), false);

  await assert.rejects(
    repository.queryDeliveryOrderOwners({ limit: 0 }),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'invalid-argument',
  );
  await assert.rejects(
    repository.queryDeliveryOrderOwners({ limit: -1 }),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'invalid-argument',
  );
  await assert.rejects(
    repository.queryDeliveryOrderOwners({ limit: Number.MAX_SAFE_INTEGER + 1 }),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'invalid-argument',
  );
  await assert.rejects(
    repository.queryDeliveryOrderOwners({ startAfterOwner: '', limit: 1 }),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'invalid-argument',
  );
});

test('delivery recovery queries use the composite owner-status index without imposing order', async () => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  seedCommerceDocuments(harness, [
    {
      key: commerceKeys.deliveryOrder('drop', 'processing'),
      data: { owner: 'owner-a', status: 'processing' },
    },
    {
      key: commerceKeys.deliveryOrder('other', 'prepared'),
      data: { owner: 'owner-a', status: 'prepared' },
    },
    {
      key: commerceKeys.deliveryOrder('drop', 'wrong-owner'),
      data: { owner: 'owner-b', status: 'processing' },
    },
    {
      key: commerceKeys.deliveryOrder('drop', 'wrong-status'),
      data: { owner: 'owner-a', status: 'ready_to_ship' },
    },
    {
      key: commerceKeys.stripeCheckout('drop', 'wrong-kind'),
      data: { owner: 'owner-a', status: 'prepared' },
    },
  ]);
  const repository = new D1CommerceRepository(harness.db);

  const records = await repository.queryDeliveryRecoveryOrders('owner-a');
  const documentIds = records.map((record) => record.key.documentId);
  assert.equal(new Set(documentIds).size, documentIds.length);
  assert.deepEqual(documentIds.toSorted(), ['prepared', 'processing']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'batch');
  if (calls[0].method !== 'batch') assert.fail('Expected one D1 batch call.');
  assertAuthoritativeReadBatch(calls[0]);
  const sql = calls[0].statements[1].sql.replace(/\s+/g, ' ');
  assert.match(sql, /INDEXED BY commerce_documents_delivery_owner_status/);
  assert.match(sql, /document\.document_kind = 'delivery_order'/);
  assert.match(sql, /document\.owner = \?/);
  assert.match(sql, /document\.status IN \('processing', 'prepared'\)/);
  assert.doesNotMatch(sql, /ORDER BY/);

  await assert.rejects(
    repository.queryDeliveryRecoveryOrders(''),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'invalid-argument',
  );
  assert.equal(calls.length, 1);
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

test('transactional delivery-owner queries use atomic scope snapshots and sorted unique guards', async () => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  const repository = new D1CommerceRepository(harness.db);
  seedCommerceDocuments(harness, [
    {
      key: commerceKeys.deliveryOrder('drop', 'a'),
      data: { owner: 'owner-a', status: 'ready_to_ship' },
    },
    {
      key: commerceKeys.deliveryOrder('drop', 'z'),
      data: { owner: 'owner-z', status: 'ready_to_ship' },
    },
  ]);
  harness.database.exec(`CREATE TABLE guard_audit (
    expectations_json TEXT NOT NULL,
    delivery_owner_expectations_json TEXT NOT NULL,
    expected_documents_revision INTEGER
  ) STRICT`);
  harness.database.exec(`CREATE TRIGGER guard_audit_capture
    AFTER INSERT ON commerce_commit_guards
    BEGIN
      INSERT INTO guard_audit (
        expectations_json, delivery_owner_expectations_json, expected_documents_revision
      ) VALUES (
        NEW.expectations_json, NEW.delivery_owner_expectations_json, NEW.expected_documents_revision
      );
    END`);

  const unit = await repository.begin(10);
  calls.length = 0;
  assert.deepEqual(
    (await unit.queryDeliveryOrdersByOwner({ owner: 'owner-z', limit: 10 })).map((record) => record.key.documentId),
    ['z'],
  );
  assert.deepEqual(
    (await unit.queryDeliveryOrdersByOwner({ owner: 'owner-a', limit: 10 })).map((record) => record.key.documentId),
    ['a'],
  );
  assert.deepEqual(
    (await unit.queryDeliveryOrdersByOwner({ owner: 'owner-z', limit: 10 })).map((record) => record.key.documentId),
    ['z'],
  );
  for (const call of calls) {
    assert.equal(call.method, 'batch');
    if (call.method !== 'batch') assert.fail('Expected one D1 batch per owner query.');
    assertDeliveryOwnerReadBatch(call);
  }
  await unit.create(commerceKeys.claimCode('OWNER-SCOPE-AUDIT'), { status: 'unused' });
  await unit.commit();

  const audit = harness.database.prepare('SELECT * FROM guard_audit').get()!;
  assert.deepEqual(JSON.parse(String(audit.delivery_owner_expectations_json)), [
    { owner: 'owner-a', revision: 1 },
    { owner: 'owner-z', revision: 1 },
  ]);
  assert.deepEqual(
    JSON.parse(String(audit.expectations_json)).map((entry: { path: string }) => entry.path).sort(),
    [
      commerceKeys.deliveryOrder('drop', 'a').path,
      commerceKeys.deliveryOrder('drop', 'z').path,
      commerceKeys.claimCode('OWNER-SCOPE-AUDIT').path,
    ].sort(),
  );
  assert.equal(audit.expected_documents_revision, null);

  const invalid = await repository.begin(11);
  await assert.rejects(
    invalid.queryDeliveryOrdersByOwner({ owner: '', limit: 10 }),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'invalid-argument',
  );
  await assert.rejects(
    invalid.queryDeliveryOrdersByOwner({ owner: 'owner-a', limit: 0 }),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'invalid-argument',
  );
  invalid.rollback();
});

test('point-read writes retain per-document version conflicts', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.stripeCheckout('drop', 'checkout');
  await repository.run(10, async (unit) => unit.create(key, { status: 'open' }));

  const stale = await repository.begin(11);
  await stale.get(key);
  await stale.update(key, { status: 'complete' });
  await repository.run(12, async (unit) => unit.update(key, { status: 'paid' }));

  await assert.rejects(
    stale.commit(),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
  );
});

test('point-read writes reject cross-transaction delete and recreate ABA', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.claimCode('ABA');
  await repository.run(10, async (unit) => unit.create(key, { value: 'original' }));

  const stale = await repository.begin(11);
  await stale.get(key);
  await stale.update(key, { value: 'stale' });
  await repository.run(12, async (unit) => unit.delete(key, { mustExist: true }));
  await repository.run(13, async (unit) => unit.create(key, { value: 'replacement' }));

  await assert.rejects(
    stale.commit(),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
  );
  const replacement = await repository.get(key);
  assert.deepEqual(replacement?.data, { value: 'replacement' });
  assert.equal(replacement?.version, 1);
});

test('staged replacements preserve versions and invalidate stale owner and point transactions', async () => {
  for (const replacement of ['create', 'set', 'merge'] as const) {
    const harness = createCommerceD1Harness();
    const repository = new D1CommerceRepository(harness.db);
    const key = commerceKeys.deliveryOrder('drop', replacement);
    const staleClaim = commerceKeys.claimCode(`STALE-${replacement.toUpperCase()}`);
    await repository.run(10, async (unit) => unit.create(key, {
      owner: 'source-owner',
      status: 'processing',
    }));

    const stale = await repository.begin(11);
    if (replacement === 'merge') await stale.get(key);
    else await stale.queryDeliveryOrdersByOwner({ owner: 'source-owner', limit: 10 });
    if (replacement !== 'set') await stale.create(staleClaim, { status: 'unused' });

    await repository.run(12, async (unit) => {
      await unit.delete(key, { mustExist: true });
      if (replacement === 'create') {
        await unit.create(key, { owner: 'source-owner', status: 'recreated' });
      } else if (replacement === 'set') {
        await unit.set(key, { owner: 'source-owner', status: 'replaced' });
      } else {
        await unit.set(key, { owner: 'source-owner', status: 'merged' }, { merge: true });
      }
    });

    const stored = await repository.get(key);
    assert.equal(stored?.version, 2, replacement);
    assert.equal(stored?.data.status, replacement === 'create' ? 'recreated' : replacement === 'set' ? 'replaced' : 'merged');
    assert.equal(
      harness.database.prepare(`SELECT revision FROM commerce_delivery_owner_revisions
        WHERE owner = 'source-owner'`).get()!.revision,
      1,
      replacement,
    );
    await assert.rejects(
      stale.commit(),
      (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
      replacement,
    );
    if (replacement !== 'set') assert.equal(await repository.get(staleClaim), null, replacement);
  }
});

test('delivery-owner guards isolate membership and returned-document conflicts', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const first = commerceKeys.deliveryOrder('drop', '1');
  const second = commerceKeys.deliveryOrder('drop', '2');
  await repository.run(10, async (unit) => {
    await unit.create(first, { owner: 'source-owner', status: 'processing' });
    await unit.create(second, { owner: 'source-owner', status: 'processing' });
  });

  const membership = await repository.begin(11);
  await membership.queryDeliveryOrdersByOwner({ owner: 'source-owner', limit: 10 });
  await membership.create(commerceKeys.claimCode('MEMBERSHIP'), { status: 'unused' });
  await repository.run(12, async (unit) => unit.create(
    commerceKeys.deliveryOrder('drop', '3'),
    { owner: 'source-owner', status: 'processing' },
  ));
  await assert.rejects(
    membership.commit(),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
  );

  const returnedContent = await repository.begin(13);
  await returnedContent.queryDeliveryOrdersByOwner({ owner: 'source-owner', limit: 10 });
  await returnedContent.create(commerceKeys.claimCode('RETURNED-CONTENT'), { status: 'unused' });
  await repository.run(14, async (unit) => unit.update(first, { status: 'ready_to_ship' }));
  await assert.rejects(
    returnedContent.commit(),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
  );

  const unrelated = await repository.begin(15);
  await unrelated.queryDeliveryOrdersByOwner({ owner: 'source-owner', limit: 1 });
  await unrelated.create(commerceKeys.claimCode('UNRELATED'), { status: 'unused' });
  await repository.run(16, async (unit) => {
    await unit.update(second, { status: 'ready_to_ship' });
    await unit.create(commerceKeys.deliveryOrder('drop', 'other'), {
      owner: 'destination-owner',
      status: 'processing',
    });
    await unit.create(commerceKeys.claimCode('CONCURRENT'), { status: 'unused' });
  });
  await unrelated.commit();
  assert.deepEqual((await repository.get(commerceKeys.claimCode('UNRELATED')))?.data, { status: 'unused' });

  const ownerDeparture = await repository.begin(17);
  await ownerDeparture.queryDeliveryOrdersByOwner({ owner: 'source-owner', limit: 10 });
  await ownerDeparture.create(commerceKeys.claimCode('OWNER-DEPARTURE'), { status: 'unused' });
  await repository.run(18, async (unit) => unit.update(first, { owner: 'destination-owner' }));
  await assert.rejects(
    ownerDeparture.commit(),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
  );
});

test('delivery-owner guards reject every scoped membership and path change', async () => {
  const scenarios: readonly Readonly<{
    name: string;
    seed: (
      repository: D1CommerceRepository,
    ) => Promise<void>;
    mutate: (
      repository: D1CommerceRepository,
      harness: ReturnType<typeof createCommerceD1Harness>,
    ) => Promise<void>;
  }>[] = [
    {
      name: 'initially absent owner insertion',
      seed: async () => undefined,
      mutate: async (repository) => {
        await repository.run(12, async (unit) => unit.create(
          commerceKeys.deliveryOrder('drop', 'inserted'),
          { owner: 'scope-owner', status: 'processing' },
        ));
      },
    },
    {
      name: 'matching deletion',
      seed: async (repository) => {
        await repository.run(10, async (unit) => unit.create(
          commerceKeys.deliveryOrder('drop', 'deleted'),
          { owner: 'scope-owner', status: 'processing' },
        ));
      },
      mutate: async (repository) => {
        await repository.run(12, async (unit) => unit.delete(
          commerceKeys.deliveryOrder('drop', 'deleted'),
          { mustExist: true },
        ));
      },
    },
    {
      name: 'move into owner',
      seed: async (repository) => {
        await repository.run(10, async (unit) => unit.create(
          commerceKeys.deliveryOrder('drop', 'arriving'),
          { owner: 'other-owner', status: 'processing' },
        ));
      },
      mutate: async (repository) => {
        await repository.run(12, async (unit) => unit.update(
          commerceKeys.deliveryOrder('drop', 'arriving'),
          { owner: 'scope-owner' },
        ));
      },
    },
    {
      name: 'matching path change',
      seed: async (repository) => {
        await repository.run(10, async (unit) => unit.create(
          commerceKeys.deliveryOrder('drop', 'before'),
          { owner: 'scope-owner', status: 'processing' },
        ));
      },
      mutate: async (_repository, harness) => {
        harness.database.exec('BEGIN');
        try {
          harness.database.prepare(`UPDATE commerce_documents
            SET document_path = ?, document_id = ?, version = version + 1
            WHERE document_path = ?`).run(
              commerceKeys.deliveryOrder('drop', 'after').path,
              'after',
              commerceKeys.deliveryOrder('drop', 'before').path,
            );
          harness.database.exec(`UPDATE commerce_authority_control
            SET documents_revision = documents_revision + 1 WHERE singleton = 1`);
          harness.database.exec('COMMIT');
        } catch (error) {
          harness.database.exec('ROLLBACK');
          throw error;
        }
      },
    },
  ];

  for (const scenario of scenarios) {
    const harness = createCommerceD1Harness();
    const repository = new D1CommerceRepository(harness.db);
    await scenario.seed(repository);
    const unit = await repository.begin(11);
    await unit.queryDeliveryOrdersByOwner({ owner: 'scope-owner', limit: 10 });
    await unit.create(commerceKeys.claimCode('SCOPED-GUARD'), { status: 'unused' });
    await scenario.mutate(repository, harness);
    await assert.rejects(
      unit.commit(),
      (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
      scenario.name,
    );
  }
});

test('read-only owner queries revalidate authority, scope epochs, and returned versions in one batch', async () => {
  const membershipCalls: CommerceD1CallObservation[] = [];
  const membershipHarness = createCommerceD1Harness({
    observeCall: (call) => membershipCalls.push(call),
  });
  const membershipRepository = new D1CommerceRepository(membershipHarness.db);
  await membershipRepository.run(10, async (unit) => unit.create(
    commerceKeys.deliveryOrder('drop', '1'),
    { owner: 'owner', status: 'processing' },
  ));
  const membership = await membershipRepository.begin(11);
  await membership.queryDeliveryOrdersByOwner({ owner: 'owner', limit: 10 });
  await membershipRepository.run(12, async (unit) => unit.create(
    commerceKeys.deliveryOrder('drop', '2'),
    { owner: 'owner', status: 'processing' },
  ));
  membershipCalls.length = 0;
  await assert.rejects(
    membership.commit(),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
  );
  assert.equal(membershipCalls.length, 1);
  assert.equal(membershipCalls[0].method, 'batch');
  if (membershipCalls[0].method !== 'batch') assert.fail('Expected one read-only revalidation batch.');
  assertReadOnlyRevalidationBatch(membershipCalls[0]);

  const contentHarness = createCommerceD1Harness();
  const contentRepository = new D1CommerceRepository(contentHarness.db);
  const contentKey = commerceKeys.deliveryOrder('drop', '1');
  await contentRepository.run(20, async (unit) => unit.create(
    contentKey,
    { owner: 'owner', status: 'processing' },
  ));
  const content = await contentRepository.begin(21);
  await content.queryDeliveryOrdersByOwner({ owner: 'owner', limit: 10 });
  await contentRepository.run(22, async (unit) => unit.update(contentKey, { status: 'ready_to_ship' }));
  await assert.rejects(
    content.commit(),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
  );

  const unrelatedHarness = createCommerceD1Harness();
  const unrelatedRepository = new D1CommerceRepository(unrelatedHarness.db);
  await unrelatedRepository.run(30, async (unit) => unit.create(
    commerceKeys.deliveryOrder('drop', '1'),
    { owner: 'owner', status: 'processing' },
  ));
  const unrelated = await unrelatedRepository.begin(31);
  await unrelated.queryDeliveryOrdersByOwner({ owner: 'owner', limit: 10 });
  await unrelatedRepository.run(32, async (unit) => {
    await unit.create(commerceKeys.deliveryOrder('drop', 'other'), {
      owner: 'other-owner',
      status: 'processing',
    });
    await unit.create(commerceKeys.claimCode('UNRELATED-READ'), { status: 'unused' });
  });
  await unrelated.commit();

  const pointCalls: CommerceD1CallObservation[] = [];
  const pointHarness = createCommerceD1Harness({ observeCall: (call) => pointCalls.push(call) });
  const pointRepository = new D1CommerceRepository(pointHarness.db);
  const pointKey = commerceKeys.claimCode('POINT-READ');
  await pointRepository.run(40, async (unit) => unit.create(pointKey, { status: 'unused' }));
  const point = await pointRepository.begin(41);
  await point.get(pointKey);
  await pointRepository.run(42, async (unit) => unit.create(
    commerceKeys.claimCode('POINT-UNRELATED'),
    { status: 'unused' },
  ));
  pointCalls.length = 0;
  await assert.rejects(
    point.commit(),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
  );
  assert.equal(pointCalls.length, 1);
  assert.equal(pointCalls[0].method, 'batch');
  if (pointCalls[0].method !== 'batch') assert.fail('Expected one read-only revalidation batch.');
  assertReadOnlyRevalidationBatch(pointCalls[0]);
});

test('empty read-only owner queries reject concurrent same-owner inserts in one batch', async () => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  const repository = new D1CommerceRepository(harness.db);
  const unit = await repository.begin(10);
  assert.deepEqual(await unit.queryDeliveryOrdersByOwner({ owner: 'owner', limit: 10 }), []);
  await repository.run(11, async (concurrent) => concurrent.create(
    commerceKeys.deliveryOrder('drop', '1'),
    { owner: 'owner', status: 'processing' },
  ));

  calls.length = 0;
  await assert.rejects(
    unit.commit(),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'batch');
  if (calls[0].method !== 'batch') assert.fail('Expected one read-only revalidation batch.');
  assertReadOnlyRevalidationBatch(calls[0]);
});

test('missing point reads tolerate unrelated writes and revalidate in one batch', async () => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  const repository = new D1CommerceRepository(harness.db);
  const unit = await repository.begin(10);
  assert.equal(await unit.get(commerceKeys.claimCode('MISSING')), null);
  await repository.run(11, async (concurrent) => concurrent.create(
    commerceKeys.claimCode('UNRELATED'),
    { status: 'unused' },
  ));

  calls.length = 0;
  await unit.commit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'batch');
  if (calls[0].method !== 'batch') assert.fail('Expected one read-only revalidation batch.');
  assertReadOnlyRevalidationBatch(calls[0]);
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

test('standalone reads use one authoritative two-statement batch', async () => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({
    observeCall: (observation) => calls.push(observation),
  });
  const repository = new D1CommerceRepository(harness.db);
  const existingKey = commerceKeys.claimCode('EXISTING');
  seedCommerceDocument(harness, { key: existingKey, data: { status: 'unused' } });

  const existing = await readWithSingleBatch(calls, () => repository.get(existingKey));
  assert.deepEqual(existing?.data, { status: 'unused' });
  assert.equal(calls[0].method, 'batch');
  if (calls[0].method !== 'batch') assert.fail('Expected one D1 batch call.');
  assert.match(calls[0].statements[1].sql, /document_path = \?\s+LIMIT 1/);

  const missing = await readWithSingleBatch(calls, () => repository.get(commerceKeys.claimCode('MISSING')));
  assert.equal(missing, null);
  assert.equal(calls[1].method, 'batch');
  if (calls[1].method !== 'batch') assert.fail('Expected one D1 batch call.');
  assert.match(calls[1].statements[1].sql, /document_path = \?\s+LIMIT 1/);

  assert.deepEqual(
    await readWithSingleBatch(calls, () => repository.query({ kind: 'delivery_order' })),
    [],
  );
  assert.deepEqual(
    await readWithSingleBatch(calls, () => repository.query({ kind: 'claim_code', limit: 0 })),
    [],
  );
  assert.deepEqual(
    await readWithSingleBatch(calls, () => repository.queryDeliveryOrderOwners({ limit: 1 })),
    [],
  );
  assert.deepEqual(
    await readWithSingleBatch(calls, () => repository.queryDeliveryRecoveryOrders('owner')),
    [],
  );
  assert.deepEqual(
    await readWithSingleBatch(calls, () => repository.queryPendingReadyNotifications({ limit: 1 })),
    [],
  );
  const ownerlessNotificationCall = calls.at(-1);
  assert.equal(ownerlessNotificationCall?.method, 'batch');
  if (ownerlessNotificationCall?.method !== 'batch') assert.fail('Expected one D1 batch call.');
  assert.match(
    ownerlessNotificationCall.statements[1].sql,
    /INDEXED BY commerce_delivery_orders_buyer_notifications_pending\s/,
  );
  assert.match(
    ownerlessNotificationCall.statements[1].sql,
    /INDEXED BY commerce_delivery_orders_shipper_notifications_pending\s/,
  );
  assert.doesNotMatch(ownerlessNotificationCall.statements[1].sql, /notifications_pending_owner_path/);
  assert.deepEqual(
    await readWithSingleBatch(calls, () => repository.queryPendingReadyNotifications({
      limit: 1,
      owner: 'owner',
    })),
    [],
  );
  const ownerNotificationCall = calls.at(-1);
  assert.equal(ownerNotificationCall?.method, 'batch');
  if (ownerNotificationCall?.method !== 'batch') assert.fail('Expected one D1 batch call.');
  assert.match(
    ownerNotificationCall.statements[1].sql,
    /INDEXED BY commerce_delivery_orders_buyer_notifications_pending_owner_path\s/,
  );
  assert.match(
    ownerNotificationCall.statements[1].sql,
    /INDEXED BY commerce_delivery_orders_shipper_notifications_pending_owner_path\s/,
  );
  assert.deepEqual(
    await readWithSingleBatch(calls, () => repository.queryDuePackStatusProjections({
      dropId: 'drop',
      dueAtMs: 1,
      limit: 1,
    })),
    [],
  );
  assert.deepEqual(
    await readWithSingleBatch(calls, () => repository.queryStaleStripeFulfillments(1)),
    [],
  );
  const staleCall = calls.at(-1);
  assert.equal(staleCall?.method, 'batch');
  if (staleCall?.method !== 'batch') assert.fail('Expected one D1 batch call.');
  assert.match(staleCall.statements[1].sql, /INDEXED BY commerce_stripe_checkouts_reconciliation_due/);
  assert.equal(calls.length, 10);
});

test('all standalone reads fail closed when commerce is paused', async () => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({
    observeCall: (observation) => calls.push(observation),
  });
  pauseCommerce(harness);
  const repository = new D1CommerceRepository(harness.db);
  const operations: readonly {
    name: string;
    read: (value: D1CommerceRepository) => Promise<unknown>;
  }[] = [
    { name: 'get', read: (value) => value.get(commerceKeys.claimCode('MISSING')) },
    { name: 'query', read: (value) => value.query({ kind: 'claim_code' }) },
    {
      name: 'queryDeliveryOrderOwners',
      read: (value) => value.queryDeliveryOrderOwners({ limit: 1 }),
    },
    {
      name: 'queryDeliveryRecoveryOrders',
      read: (value) => value.queryDeliveryRecoveryOrders('owner'),
    },
    {
      name: 'queryPendingReadyNotifications',
      read: (value) => value.queryPendingReadyNotifications({ limit: 1 }),
    },
    {
      name: 'queryDuePackStatusProjections',
      read: (value) => value.queryDuePackStatusProjections({ dropId: 'drop', dueAtMs: 1, limit: 1 }),
    },
    {
      name: 'queryStaleStripeFulfillments',
      read: (value) => value.queryStaleStripeFulfillments(1),
    },
  ];

  for (const operation of operations) {
    const previousCount = calls.length;
    await assert.rejects(operation.read(repository), isUnavailableCommerceError, operation.name);
    assert.equal(calls.length, previousCount + 1, operation.name);
    const call = calls[previousCount];
    assert.equal(call.method, 'batch', operation.name);
    if (call.method !== 'batch') assert.fail(`${operation.name} did not use one D1 batch.`);
    assertAuthoritativeReadBatch(call);
  }
});

test('standalone read batch failures log and preserve the D1 cause', async () => {
  const cause = new Error('D1 batch failed');
  const logs: unknown[][] = [];
  const originalConsoleError = console.error;
  const harness = createCommerceD1Harness();
  const db = new Proxy(harness.db, {
    get(target, property, receiver) {
      if (property === 'batch') return async () => { throw cause; };
      return Reflect.get(target, property, receiver);
    },
  });

  console.error = (...values: unknown[]) => { logs.push(values); };
  try {
    await assert.rejects(
      new D1CommerceRepository(db).get(commerceKeys.claimCode('MISSING')),
      (error: unknown) => {
        assert.ok(error instanceof CommerceRepositoryError);
        assert.equal(error.code, 'unavailable');
        assert.equal(error.cause, cause);
        return true;
      },
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(logs, [[{
    event: 'commerce_d1_read_failed',
    error: { name: 'Error', message: 'D1 batch failed' },
  }]]);
});

test('a pause committed after a read batch affects only the next read', async () => {
  let harness: ReturnType<typeof createCommerceD1Harness>;
  let batchCount = 0;
  harness = createCommerceD1Harness({
    observeBatchAfterCommit: () => {
      batchCount += 1;
      if (batchCount === 1) pauseCommerce(harness);
    },
  });
  const key = commerceKeys.claimCode('EXISTING');
  seedCommerceDocument(harness, { key, data: { status: 'unused' } });
  const repository = new D1CommerceRepository(harness.db);

  assert.deepEqual((await repository.get(key))?.data, { status: 'unused' });
  assert.equal(batchCount, 1);
  await assert.rejects(repository.get(key), isUnavailableCommerceError);
  assert.equal(batchCount, 2);
});

test('a revision committed after a query batch does not retry that snapshot', async () => {
  let harness: ReturnType<typeof createCommerceD1Harness>;
  let batchCount = 0;
  harness = createCommerceD1Harness({
    observeBatchAfterCommit: () => {
      batchCount += 1;
      if (batchCount !== 1) return;
      seedCommerceDocument(harness, {
        key: commerceKeys.claimCode('NEW'),
        data: { status: 'unused' },
      });
    },
  });
  seedCommerceDocument(harness, {
    key: commerceKeys.claimCode('EXISTING'),
    data: { status: 'unused' },
  });
  const repository = new D1CommerceRepository(harness.db);

  const first = await repository.query({ kind: 'claim_code' });
  assert.deepEqual(first.map((record) => record.key.documentId), ['EXISTING']);
  assert.equal(batchCount, 1);

  const second = await repository.query({ kind: 'claim_code' });
  assert.deepEqual(second.map((record) => record.key.documentId), ['EXISTING', 'NEW']);
  assert.equal(batchCount, 2);
});
