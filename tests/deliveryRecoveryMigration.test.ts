import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { D1CommerceRepository, commerceKeys } from '../cloud/workers/api/src/commerceRepository.ts';
import { d1Database } from '../cloud/workers/api/test/commerceD1Harness.ts';
import { runDeliveryRecoveryStateControl } from '../scripts/ops/deliveryRecoveryStateControl.ts';
import { queryRemoteCommerceDocuments } from '../scripts/shared/commerceD1Maintenance.ts';
import { readCommerceMigrations, replayCommerceMigrations } from '../scripts/shared/commerceMigrationReplay.ts';
import { updateDeliveryRecoveryRecord } from '../shared/deliveryRecoveryState.ts';

const migrations = readCommerceMigrations();
const cleanup = migrations.find(({ name }) => name === '0033_delivery_recovery_metadata_cleanup.sql')!;
const sqlNow = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
const leaseId = '00000000-0000-4000-8000-000000000033';
const owner = '123456789ABCDEFG123456789ABCDEFG';

function query(database: DatabaseSync) {
  return (sql: string) => database.prepare(sql).all().map((row) => ({ ...row }));
}

function withLease(database: DatabaseSync, operation: () => void): void {
  database.exec(`INSERT INTO commerce_authority_control_lease VALUES (1, '${leaseId}', ${sqlNow}, ${sqlNow} + 60000)`);
  try { operation(); } finally { database.exec('DELETE FROM commerce_authority_control_lease'); }
}

function resume(database: DatabaseSync): void {
  withLease(database, () => database.exec(`UPDATE commerce_authority_control
    SET paused_at_ms = ${sqlNow}, updated_at_ms = ${sqlNow}
    WHERE authority_state = 'paused' AND paused_at_ms IS NULL;
    UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = ${sqlNow}`));
}

function pause(database: DatabaseSync, drained = true): void {
  withLease(database, () => database.exec(`UPDATE commerce_authority_control
    SET authority_state = 'paused', revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${sqlNow};
    ${drained ? `UPDATE commerce_authority_control SET paused_at_ms = ${sqlNow}, updated_at_ms = ${sqlNow};` : ''}`));
}

function database(context: test.TestContext, current = false): DatabaseSync {
  const result = replayCommerceMigrations(current ? migrations : migrations.filter(({ name }) => name < cleanup.name));
  context.after(() => result.close());
  return result;
}

function migrate(database: DatabaseSync, sql = cleanup.sql): void {
  database.exec('BEGIN');
  try {
    database.exec(sql);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function seed(database: DatabaseSync, id: string, recoveryJson: string | null): void {
  const metadata = JSON.stringify({ owner, status: 'processing', deliveryId: Number(id), dropId: 'drop', retained: ['metadata'] });
  database.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
  ) VALUES (?, 'delivery_order', 'drop', ?, ?, 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`).run(
    commerceKeys.deliveryOrder('drop', id).path, id,
    recoveryJson === null ? metadata : `${metadata.slice(0, -1)},"receiptRecovery":${recoveryJson}}`,
  );
  database.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
}

async function activateRecovery(database: DatabaseSync): Promise<void> {
  const revision = String(database.prepare('SELECT revision FROM commerce_authority_control').get()!.revision);
  const dependencies = { query: query(database) };
  await runDeliveryRecoveryStateControl(['prepare', '--expected-revision', revision, '--write'], dependencies);
  await runDeliveryRecoveryStateControl(['activate', '--expected-revision', revision, '--write', '--worker-deployed'], dependencies);
}

async function populatedDatabase(context: test.TestContext): Promise<DatabaseSync> {
  const db = database(context);
  resume(db);
  const payloads = [null, 'null', 'false', '3', '["unknown",null]',
    '{"preparedProbeCount":2,"pendingTransactions":[{"serializedTransaction":"signed","signature":"pending"}],"unknown":9007199254740993,"same":1,"same":2}',
    JSON.stringify({ future: '\\"'.repeat(100_000) })];
  payloads.forEach((payload, index) => seed(db, String(index + 1), payload));
  pause(db);
  await activateRecovery(db);
  return db;
}

function snapshot(database: DatabaseSync) {
  const read = query(database);
  return {
    schema: read("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type, name"),
    tables: Object.fromEntries(read("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
      .map(({ name }) => [String(name), read(`SELECT * FROM ${name} ORDER BY rowid`)])),
  };
}

test('cleanup fixture resumes fresh and drained Commerce across clock seconds', (context) => {
  const db = database(context);
  let nowMs = 2_000_000_000_000;
  db.function('strftime', (format, value) => format === '%s' && value === 'now' ? String(nowMs / 1_000) : null);
  resume(db);
  assert.equal(db.prepare('SELECT authority_state FROM commerce_authority_control').get()!.authority_state, 'd1');
  pause(db);
  const paused = db.prepare('SELECT revision, paused_at_ms FROM commerce_authority_control').get()!;
  assert.equal(paused.paused_at_ms, nowMs);
  nowMs += 1_000;
  resume(db);
  assert.deepEqual({ ...db.prepare('SELECT authority_state, revision, paused_at_ms FROM commerce_authority_control').get() }, {
    authority_state: 'd1', revision: Number(paused.revision) + 1, paused_at_ms: null,
  });
});

test('delivery recovery cleanup removes only frozen metadata and preserves current recovery bytes and revisions', async (context) => {
  const db = await populatedDatabase(context);
  resume(db);
  const repository = new D1CommerceRepository(d1Database(db));
  const key = commerceKeys.deliveryOrder('drop', '6');
  await repository.run(Date.now(), async (unit) => {
    const current = await unit.getRecoverySnapshot(key);
    assert.ok(current);
    unit.stageRecovery(updateDeliveryRecoveryRecord(current.state, {
      leaseId, receiptRecoveryJson: '{"pendingTransactions":[{"serializedTransaction":"new signed journal"}],"current":9007199254740993}',
    }, Date.now()));
  });
  pause(db);
  const before = snapshot(db);
  const expectedDocuments = query(db)(`SELECT document_path, json_remove(document_json, '$.receiptRecovery') AS document_json
    FROM commerce_documents ORDER BY document_path`);
  const hydratedBefore = queryRemoteCommerceDocuments('SELECT * FROM commerce_documents ORDER BY document_path', query(db));
  migrate(db);
  const after = snapshot(db);
  assert.deepEqual(after.tables, {
    ...before.tables,
    commerce_documents: before.tables.commerce_documents.map((document) => ({
      ...document, document_json: expectedDocuments.find(({ document_path }) => document_path === document.document_path)!.document_json,
    })),
  });
  const replaced = new Set(['commerce_delivery_recovery_parent_insert_guard', 'commerce_delivery_recovery_parent_update_guard']);
  assert.deepEqual(after.schema.filter(({ name }) => !replaced.has(String(name))), before.schema.filter(({ name }) => !replaced.has(String(name))));
  assert.deepEqual(queryRemoteCommerceDocuments('SELECT * FROM commerce_documents ORDER BY document_path', query(db)), hydratedBefore);
  assert.equal(query(db)("SELECT COUNT(*) AS count FROM commerce_documents WHERE json_type(document_json, '$.receiptRecovery') IS NOT NULL")[0].count, 0);
  resume(db);
  assert.equal((await repository.get(key))?.data.receiptRecovery, undefined);
  const state = (await repository.getRecoverySnapshot(key))!.state;
  assert.equal(state.revision, 2);
  assert.equal(state.leaseId, leaseId);
  assert.equal(state.receiptRecoveryJson, '{"pendingTransactions":[{"serializedTransaction":"new signed journal"}],"current":9007199254740993}');
});

test('delivery recovery cleanup rolls back data and every fence after a late failure', async (context) => {
  const db = await populatedDatabase(context);
  const before = snapshot(db);
  assert.throws(() => migrate(db, `${cleanup.sql}\nINSERT INTO commerce_preorder_cards (card_id) VALUES (0);`), /CHECK constraint failed/);
  assert.deepEqual(snapshot(db), before);
  migrate(db);
  assert.equal(query(db)("SELECT COUNT(*) AS count FROM commerce_documents WHERE json_type(document_json, '$.receiptRecovery') IS NOT NULL")[0].count, 0);
});

for (const condition of ['active', 'not-drained', 'legacy-populated', 'missing-recovery', 'lease', 'commit', 'wipe'] as const) {
  test(`delivery recovery cleanup rejects ${condition} without changes`, async (context) => {
    const db = await populatedDatabase(context);
    if (condition === 'active') resume(db);
    if (condition === 'not-drained') { resume(db); pause(db, false); }
    if (condition === 'legacy-populated') {
      db.exec(`DROP TRIGGER commerce_delivery_recovery_control_update_guard;
        UPDATE commerce_delivery_recovery_control SET storage_mode = 'legacy'`);
    }
    if (condition === 'missing-recovery') {
      db.exec(`DROP TRIGGER commerce_delivery_recovery_delete_guard;
        DELETE FROM commerce_delivery_recovery WHERE parent_path = 'drops/drop/deliveryOrders/1'`);
    }
    if (condition === 'lease') db.exec(`INSERT INTO commerce_authority_control_lease VALUES (1, '${leaseId}', ${sqlNow}, ${sqlNow} + 60000)`);
    if (condition === 'commit') {
      db.exec(`DROP TRIGGER commerce_commit_guard_validate;
        INSERT INTO commerce_commit_guards (guard_id, expectations_json, created_at_ms) VALUES ('unfinished', '[]', 0)`);
    }
    if (condition === 'wipe') {
      db.exec(`DROP TRIGGER commerce_wipe_guard_validate;
        INSERT INTO commerce_wipe_guards (guard_id, expectations_json, expected_documents_revision, created_at_ms)
          VALUES ('unfinished', '[]', 0, 0)`);
    }
    const before = snapshot(db);
    assert.throws(() => migrate(db), /delivery_recovery_cleanup_requires_maintenance/);
    assert.deepEqual(snapshot(db), before);
  });
}

test('fresh migration replay keeps bootstrap controls and supports native initial recovery state', async (context) => {
  const db = database(context, true);
  assert.deepEqual(query(db)('SELECT storage_mode, preparation_state FROM commerce_delivery_recovery_control'), [{ storage_mode: 'legacy', preparation_state: 'idle' }]);
  resume(db);
  assert.throws(() => seed(db, '1', '{}'), /legacy delivery recovery writes are disabled/);
  pause(db);
  await activateRecovery(db);
  resume(db);
  const repository = new D1CommerceRepository(d1Database(db));
  const key = commerceKeys.deliveryOrder('drop', '1');
  await repository.run(1_000, (unit) => unit.create(key, { status: 'prepared', receiptRecovery: null }));
  assert.equal((await repository.get(key))?.data.receiptRecovery, undefined);
  assert.equal((await repository.getRecoverySnapshot(key))!.state.receiptRecoveryJson, 'null');
});

for (const table of ['commerce_document_path_revisions', 'commerce_delivery_owner_revisions'] as const) {
  test(`delivery recovery cleanup rejects a nonpristine bootstrap with ${table}`, (context) => {
    const db = database(context);
    db.prepare(`INSERT INTO ${table} VALUES (?, 1)`).run(table === 'commerce_document_path_revisions'
      ? 'drops/drop/deliveryOrders/deleted' : owner);
    const before = snapshot(db);
    assert.throws(() => migrate(db), /delivery_recovery_cleanup_requires_maintenance/);
    assert.deepEqual(snapshot(db), before);
  });
}

test('existing Worker persistence stays compatible and stale legacy writers cannot restore metadata', async (context) => {
  const db = await populatedDatabase(context);
  const key = commerceKeys.deliveryOrder('drop', '6');
  const staleJson = String(db.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').get(key.path)!.document_json);
  migrate(db);
  resume(db);
  const writeWithPreviousWorker = (documentJson: string) => {
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO commerce_commit_guards (guard_id, expectations_json, created_at_ms, delivery_recovery_paths_json)
        VALUES ('previous-worker', '[]', 0, ?)`).run(JSON.stringify([key.path]));
      db.prepare(`INSERT INTO commerce_documents (
        document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
      ) SELECT document_path, document_kind, drop_id, document_id, ?, version + 1, create_time, update_time
        FROM commerce_documents WHERE document_path = ?
      ON CONFLICT(document_path) DO UPDATE SET
        document_json = CASE WHEN json_type(commerce_documents.document_json, '$.receiptRecovery') IS NULL
          THEN json_remove(excluded.document_json, '$.receiptRecovery')
          ELSE json_set(excluded.document_json, '$.receiptRecovery', json(commerce_documents.document_json -> '$.receiptRecovery')) END,
        version = excluded.version`).run(documentJson, key.path);
      db.exec(`UPDATE commerce_authority_control SET documents_revision = documents_revision + 1;
        DELETE FROM commerce_commit_guards WHERE guard_id = 'previous-worker'; COMMIT`);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const currentJson = String(db.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').get(key.path)!.document_json);
  assert.doesNotThrow(() => writeWithPreviousWorker(currentJson));
  const beforeStaleWrite = snapshot(db);
  assert.throws(() => writeWithPreviousWorker(staleJson), /legacy delivery recovery writes are disabled/);
  assert.deepEqual(snapshot(db), beforeStaleWrite);
  assert.throws(() => db.prepare("UPDATE commerce_documents SET document_json = json_set(document_json, '$.receiptRecovery', null), version = version + 1 WHERE document_path = ?").run(key.path), /legacy delivery recovery writes are disabled/);
  assert.throws(() => db.prepare('UPDATE commerce_documents SET version = version + 1 WHERE document_path = ?').run(key.path), /guarded write/);
  assert.throws(() => db.prepare('DELETE FROM commerce_documents WHERE document_path = ?').run(key.path), /guarded deletion/);
});
