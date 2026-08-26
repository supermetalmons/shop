import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  CommerceRepositoryError,
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
} from '../src/commerceRepository.ts';
import { D1CommerceDocumentStore } from '../src/commerceDocumentStore.ts';
import {
  FIRESTORE_DATABASE_NAME,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
} from '../src/firestoreContract.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';

const COMMIT_URL = `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`;

function legacyCreate(path: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    currentDocument: { exists: false },
    update: { fields, name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}` },
  };
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
});

test('native writes remain readable through the compatibility adapter', async () => {
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

  const adapter = new D1CommerceDocumentStore(harness.db);
  const value = await adapter.request({
    method: 'GET',
    nowMs: 1_700_000_001_457,
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents/${key.path}`,
  }) as { fields: Record<string, Record<string, unknown>> };
  assert.equal(value.fields.owner.stringValue, 'wallet');
  assert.equal(value.fields.status.stringValue, 'ready_to_ship');
  assert.equal(value.fields.attempts.integerValue, '3');
  assert.equal(value.fields.processedAt.timestampValue, '2023-11-14T22:13:20.123000001Z');
  assert.equal(value.fields.updatedAt.timestampValue, '2023-11-14T22:13:21.456000000Z');

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
});

test('native cursors preserve compatibility timestamps written during the bridge gap', async () => {
  const harness = createCommerceD1Harness();
  const adapter = new D1CommerceDocumentStore(harness.db);
  const writes = [
    ['1', '2026-08-18T12:00:00.123000001Z'],
    ['2', '2026-08-18T12:00:00.123000002Z'],
    ['3', '2026-08-18T12:00:00.123000002Z'],
  ].map(([id, processedAt]) => legacyCreate(`drops/poncho/deliveryOrders/${id}`, {
    processedAt: { timestampValue: processedAt },
    status: { stringValue: 'ready_to_ship' },
  }));
  await adapter.request({ method: 'POST', nowMs: 10, url: COMMIT_URL, body: JSON.stringify({ writes }) });

  assert.deepEqual(
    harness.database.prepare(`SELECT document_id, processed_at_seconds, processed_at_nanos
      FROM commerce_documents ORDER BY document_id`).all().map((row) => ({ ...row })),
    [
      { document_id: '1', processed_at_seconds: null, processed_at_nanos: null },
      { document_id: '2', processed_at_seconds: null, processed_at_nanos: null },
      { document_id: '3', processed_at_seconds: null, processed_at_nanos: null },
    ],
  );

  const repository = new D1CommerceRepository(harness.db);
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

test('native repository migration backfills lossless processed-time columns', () => {
  const database = new DatabaseSync(':memory:');
  const migrationDirectory = 'cloud/workers/api/commerce-migrations';
  for (const file of readdirSync(migrationDirectory).sort().filter((file) => file < '0007')) {
    database.exec(readFileSync(`${migrationDirectory}/${file}`, 'utf8'));
  }
  database.exec(`UPDATE commerce_authority_control SET
    authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
    WHERE singleton = 1`);
  database.prepare(`INSERT INTO commerce_import_manifests (
    manifest_sha256, document_count, kind_counts_json, source_updated_at_ms, imported_at_ms, archive_object_prefix
  ) VALUES (?, 1, '{"delivery_order":1}', 1, 1, 'test')`).run('a'.repeat(64));
  database.prepare(`UPDATE commerce_authority_control SET
    authority_state = 'd1', revision = 3, cutover_at_ms = 2,
    import_manifest_sha256 = ?, updated_at_ms = 2 WHERE singleton = 1`).run('a'.repeat(64));
  database.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, fields_json, document_json,
    version, create_time, update_time
  ) VALUES (?, 'delivery_order', 'poncho', '7', ?, ?, 1, ?, ?)`).run(
    'drops/poncho/deliveryOrders/7',
    JSON.stringify({ processedAt: { timestampValue: '2026-08-18T12:00:00.123456789Z' } }),
    JSON.stringify({ processedAt: 1_787_054_400_123 }),
    '2026-08-18T12:00:00.000Z',
    '2026-08-18T12:00:00.000000001Z',
  );
  database.exec(readFileSync(`${migrationDirectory}/0007_native_repository_expand.sql`, 'utf8'));
  assert.deepEqual(
    { ...database.prepare(`SELECT processed_at_seconds, processed_at_nanos
      FROM commerce_documents WHERE document_path = ?`).get('drops/poncho/deliveryOrders/7') },
    { processed_at_seconds: 1_787_054_400, processed_at_nanos: 123_456_789 },
  );
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

test('native repository fails closed while commerce is paused', async () => {
  const harness = createCommerceD1Harness();
  harness.database.exec(`UPDATE commerce_authority_control SET
    authority_state = 'paused', revision = revision + 1, paused_at_ms = 20, updated_at_ms = 20
    WHERE singleton = 1`);
  const repository = new D1CommerceRepository(harness.db);
  await assert.rejects(repository.get(commerceKeys.claimCode('ABC')), (error: unknown) => {
    assert.ok(error instanceof CommerceRepositoryError);
    assert.equal(error.code, 'unavailable');
    return true;
  });
});
