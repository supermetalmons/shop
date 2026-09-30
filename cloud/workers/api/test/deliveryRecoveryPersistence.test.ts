import assert from 'node:assert/strict';
import test from 'node:test';
import { updateDeliveryRecoveryRecord } from '../../../../shared/deliveryRecoveryState.ts';
import { CommerceWriteConflict, D1CommerceRepository, commerceKeys, type CommerceDocumentWriteData } from '../src/commerceRepository.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';
import { runDeliveryRecoveryStateControl } from '../../../../scripts/ops/deliveryRecoveryStateControl.ts';

const key = commerceKeys.deliveryOrder('card_nft_2', '7');
const leaseId = '00000000-0000-4000-8000-000000000030';

async function createOrder(repository: D1CommerceRepository): Promise<void> {
  await repository.run(1_000, (unit) => unit.create(key, {
    dropId: 'card_nft_2', deliveryId: 7, owner: 'owner', status: 'prepared', createdAt: 1_000,
    addressSnapshot: { encrypted: 'private address', country: 'US' },
    receiptRecovery: { preparedProbeCount: 0, nextPreparedProbeAt: 31_000, futureField: { keep: true } },
  }));
}

async function claim(repository: D1CommerceRepository, nowMs = 2_000): Promise<void> {
  await repository.run(nowMs, async (unit) => {
    const snapshot = await unit.getRecoverySnapshot(key);
    assert.ok(snapshot);
    unit.stageRecovery(updateDeliveryRecoveryRecord(snapshot.state, {
      receiptRecoveryJson: JSON.stringify({ ...JSON.parse(snapshot.state.receiptRecoveryJson!), lastAttemptAt: nowMs, leaseExpiresAt: nowMs + 90_000 }),
      leaseId,
    }, nowMs));
  });
}

test('recovery-only commits leave parent payload, timestamps, versions and query epochs unchanged', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  await createOrder(repository);
  const tables = ['commerce_documents', 'commerce_authority_control', 'commerce_document_path_revisions', 'commerce_delivery_owner_revisions'];
  const before = tables.map((table) => harness.database.prepare(`SELECT * FROM ${table}`).all());
  const original = await repository.getRecoverySnapshot(key);
  assert.ok(original);
  await claim(repository);
  assert.deepEqual(tables.map((table) => harness.database.prepare(`SELECT * FROM ${table}`).all()), before);
  const snapshot = await repository.getRecoverySnapshot(key);
  assert.ok(snapshot);
  assert.equal(snapshot.state.revision, original.state.revision + 1);
  assert.equal(snapshot.state.leaseId, leaseId);
  assert.equal((snapshot.order.data.receiptRecovery as Record<string, unknown>).lastAttemptAt, 2_000);
  assert.equal((await repository.get(key))?.data.receiptRecovery, undefined);
  assert.equal(JSON.parse(String(harness.database.prepare('SELECT document_json FROM commerce_documents').get()?.document_json)).receiptRecovery, undefined);
});

test('metadata-only readers and writers do not conflict with independent recovery state commits', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  await createOrder(repository);
  const reader = await repository.begin(2_000);
  const writer = await repository.begin(2_000);
  assert.ok(await reader.get(key));
  assert.ok(await writer.get(key));
  await claim(repository, 2_100);
  await reader.commit();
  await writer.update(key, { fulfillmentTrackingCode: 'tracking' });
  await writer.commit();
  assert.equal((await repository.get(key))?.data.fulfillmentTrackingCode, 'tracking');
  const snapshot = await repository.getRecoverySnapshot(key);
  assert.ok(snapshot);
  assert.equal(snapshot.state.revision, 2);
  assert.equal(snapshot.state.leaseId, leaseId);
});

test('recovery readers and writers reject concurrent state revisions and preserve the winner', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  await createOrder(repository);
  const reader = await repository.begin(2_000);
  const writer = await repository.begin(2_000);
  assert.ok(await reader.getRecoverySnapshot(key));
  const original = await writer.getRecoverySnapshot(key);
  assert.ok(original);
  writer.stageRecovery(updateDeliveryRecoveryRecord(original.state, { receiptRecoveryJson: '{"preparedProbeCount":2}' }, 2_000));
  await claim(repository, 2_100);
  const winner = await repository.getRecoverySnapshot(key);
  await assert.rejects(reader.commit(), CommerceWriteConflict);
  await assert.rejects(writer.commit(), CommerceWriteConflict);
  assert.deepEqual(await repository.getRecoverySnapshot(key), winner);
});

test('staged recovery changes coalesce into one revision and retain prior staged fields', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  await createOrder(repository);
  await repository.run(2_000, async (unit) => {
    const first = await unit.getRecoverySnapshot(key);
    assert.ok(first);
    unit.stageRecovery(updateDeliveryRecoveryRecord(first.state, { leaseId }, 2_000));
    const second = await unit.getRecoverySnapshot(key);
    assert.ok(second);
    unit.stageRecovery(updateDeliveryRecoveryRecord(second.state, {
      receiptRecoveryJson: JSON.stringify({ ...JSON.parse(second.state.receiptRecoveryJson!), preparedProbeCount: 1 }),
    }, 2_001));
  });
  const result = await repository.getRecoverySnapshot(key);
  assert.ok(result);
  assert.equal(result.state.revision, 2);
  assert.equal(result.state.leaseId, leaseId);
  assert.equal(result.state.preparedDelayMs, 120_000);
  assert.deepEqual((result.order.data.receiptRecovery as Record<string, unknown>).futureField, { keep: true });
});

test('recovery snapshots reject stale parent status and delete-recreate generations', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  await createOrder(repository);
  const staleStatus = await repository.begin(2_000);
  const beforeStatus = await staleStatus.getRecoverySnapshot(key);
  assert.ok(beforeStatus);
  await repository.run(2_100, (unit) => unit.update(key, { status: 'processing' }));
  staleStatus.stageRecovery(updateDeliveryRecoveryRecord(beforeStatus.state, { leaseId }, 2_200));
  await assert.rejects(staleStatus.commit(), CommerceWriteConflict);
  const staleGeneration = await repository.begin(3_000);
  const beforeDelete = await staleGeneration.getRecoverySnapshot(key);
  assert.ok(beforeDelete);
  await repository.run(3_100, (unit) => unit.delete(key, { mustExist: true }));
  await createOrder(repository);
  const replacement = await repository.getRecoverySnapshot(key);
  assert.ok(replacement);
  assert.notEqual(replacement.state.generation, beforeDelete.state.generation);
  staleGeneration.stageRecovery(updateDeliveryRecoveryRecord(beforeDelete.state, { leaseId }, 3_200));
  await assert.rejects(staleGeneration.commit(), CommerceWriteConflict);
  assert.deepEqual(await repository.getRecoverySnapshot(key), replacement);
});

test('recovery transactions roll back parent and sidecar if a later statement fails', async (t) => {
  let failCommit = false;
  const harness = createCommerceD1Harness({ observeStatement: ({ sql }) => {
    if (failCommit && sql.startsWith('DELETE FROM commerce_commit_guards')) throw new Error('injected commit failure');
  } });
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  await createOrder(repository);
  const before = await repository.getRecoverySnapshot(key);
  assert.ok(before);
  failCommit = true;
  await assert.rejects(repository.run(2_000, async (unit) => {
    const snapshot = await unit.getRecoverySnapshot(key);
    assert.ok(snapshot);
    await unit.update(key, { status: 'processing' });
    unit.stageRecovery(updateDeliveryRecoveryRecord(snapshot.state, { leaseId }, 2_000));
  }), /injected commit failure/);
  failCommit = false;
  assert.deepEqual(await repository.getRecoverySnapshot(key), before);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').get()?.count, 0);
});

test('generic delivery writes cannot mutate recovery state and missing state fails closed', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  await createOrder(repository);
  const recoveryUpdates: CommerceDocumentWriteData[] = [{ receiptRecovery: {} }, { 'receiptRecovery.attemptCount': 1 }];
  for (const updates of recoveryUpdates) {
    await assert.rejects(repository.run(2_000, (unit) => unit.update(key, updates)), /recovery state store/);
  }
  harness.database.exec('DROP TRIGGER commerce_delivery_recovery_delete_guard; DELETE FROM commerce_delivery_recovery');
  await assert.rejects(repository.getRecoverySnapshot(key), /temporarily unavailable/);
  await assert.rejects(repository.run(2_000, (unit) => unit.delete(key)), /temporarily unavailable/);
});

test('metadata updates preserve frozen legacy recovery JSON without a JavaScript number round-trip', async (t) => {
  const harness = createCommerceD1Harness({ deliveryRecoveryMode: 'legacy' });
  t.after(() => harness.database.close());
  const database = harness.database;
  const query = (sql: string) => database.prepare(sql).all().map((row) => ({ ...row }));
  const now = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
  const acquireLease = () => database.exec(`INSERT INTO commerce_authority_control_lease VALUES
    (1, '00000000-0000-4000-8000-000000000901', ${now}, ${now} + 60000)`);
  const legacyValues = [null, 'null', 'false', '17', '"legacy"', '[]', '9007199254740993', '1e999',
    '{"future":[9007199254740993,1e999,null],"preparedProbeCount":"2.9"}'];
  for (const [index, raw] of legacyValues.entries()) {
    database.prepare(`INSERT INTO commerce_documents (
      document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
    ) VALUES (?, 'delivery_order', 'card_nft_2', ?, ?, 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`)
      .run(`drops/card_nft_2/deliveryOrders/${index}`, String(index),
        `{"owner":"owner","status":"prepared","createdAt":1000${raw === null ? '' : `,"receiptRecovery":${raw}`}}`);
  }
  database.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
  acquireLease();
  database.exec(`UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = ${now};
    UPDATE commerce_authority_control SET paused_at_ms = ${now}, updated_at_ms = ${now};
    DELETE FROM commerce_authority_control_lease`);
  const revision = String(query('SELECT revision FROM commerce_authority_control')[0].revision);
  await runDeliveryRecoveryStateControl(['prepare', '--write', '--expected-revision', revision], { query });
  await runDeliveryRecoveryStateControl(['activate', '--write', '--expected-revision', revision, '--worker-deployed'], { query });
  acquireLease();
  database.exec(`UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = ${now};
    DELETE FROM commerce_authority_control_lease`);
  const recoveryBefore = query('SELECT * FROM commerce_delivery_recovery ORDER BY parent_path');
  const frozenBefore = query(`SELECT document_path, document_json -> '$.receiptRecovery' AS recovery
    FROM commerce_documents ORDER BY document_path`);
  const repository = new D1CommerceRepository(harness.db);
  for (const [index] of legacyValues.entries()) {
    const orderKey = commerceKeys.deliveryOrder('card_nft_2', String(index));
    await repository.run(Date.now(), (unit) => unit.update(orderKey, { fulfillmentTrackingCode: 'tracking' }));
    await repository.run(Date.now(), (unit) => unit.set(orderKey, { status: 'processing', owner: 'owner', replaced: true }));
    assert.equal((await repository.get(orderKey))?.data.replaced, true);
  }
  assert.deepEqual(query(`SELECT document_path, document_json -> '$.receiptRecovery' AS recovery
    FROM commerce_documents ORDER BY document_path`), frozenBefore);
  assert.deepEqual(query('SELECT * FROM commerce_delivery_recovery ORDER BY parent_path'), recoveryBefore);
});

test('snapshot and page reads keep large escaped recovery payloads out of metadata JSON', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const payload = { custom: '\\'.repeat(550_000) };
  const raw = JSON.stringify(payload);
  assert.ok(Buffer.byteLength(JSON.stringify({ receipt_recovery_json: raw })) > 2_000_000);
  await new D1CommerceRepository(harness.db).run(1_000, (unit) => unit.create(key, {
    owner: 'owner', status: 'processing', receiptRecovery: payload,
  }));
  let snapshots = 0;
  const observed = new Proxy(harness.db, {
    get(target, property, receiver) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        const results = await target.batch<Record<string, unknown>>(statements);
        for (const result of results) for (const row of result.results) {
          for (const value of Object.values(row)) {
            if (typeof value === 'string') assert.ok(Buffer.byteLength(value) <= 2_000_000);
          }
          if (typeof row.recovery_state_json !== 'string') continue;
          snapshots += 1;
          assert.ok(Buffer.byteLength(row.recovery_state_json) < 1_000);
          assert.equal(Object.hasOwn(JSON.parse(row.recovery_state_json), 'receipt_recovery_json'), false);
          assert.equal(row.recovery_payload_json, raw);
        }
        return results;
      };
      return Reflect.get(target, property, receiver);
    },
  });
  const repository = new D1CommerceRepository(observed);
  assert.equal((await repository.getRecoverySnapshot(key))?.state.receiptRecoveryJson, raw);
  await repository.run(2_000, async (unit) => {
    assert.deepEqual((await unit.getRecoverySnapshot(key))?.order.data.receiptRecovery, payload);
  });
  const page = await repository.queryDeliveryRecoveryPage({ owner: 'owner', phase: 'processing', limit: 8 });
  assert.equal(page.length, 1);
  assert.equal(page[0].state.receiptRecoveryJson, raw);
  assert.equal(snapshots, 3);
});
