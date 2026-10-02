import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  createDeliveryRecoveryRecord,
  deliveryRecoveryRow,
  parseDeliveryRecoveryRow,
  updateDeliveryRecoveryRecord,
  type DeliveryRecoveryRecord,
} from '../../../../shared/deliveryRecoveryState.ts';

const PATH = 'drops/card_nft_2/deliveryOrders/7';
const SECOND_PATH = 'drops/card_nft_2/deliveryOrders/8';
const GENERATION = '00000000-0000-4000-8000-000000000030';
const LEASE = '00000000-0000-4000-8000-000000000031';
const SQL_NOW = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

function fresh() {
  const database = new DatabaseSync(':memory:');
  const clock = { nowMs: 2_000_000_000_000 };
  database.function('strftime', (format, value) => format === '%s' && value === 'now' ? String(clock.nowMs / 1000) : null);
  const directory = 'cloud/workers/api/commerce-migrations';
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '0033_').sort()) {
    database.exec(readFileSync(`${directory}/${file}`, 'utf8'));
  }
  database.exec(`INSERT INTO commerce_authority_control_lease (singleton, lease_token, acquired_at_ms, expires_at_ms)
    VALUES (1, '${LEASE}', ${SQL_NOW}, ${SQL_NOW} + 1800000)`);
  resume(database);
  return { database, clock };
}

function resume(database: DatabaseSync): void {
  database.exec(`UPDATE commerce_authority_control SET paused_at_ms = ${SQL_NOW}, updated_at_ms = ${SQL_NOW}
    WHERE authority_state = 'paused' AND paused_at_ms IS NULL;
    UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = ${SQL_NOW} WHERE authority_state = 'paused'`);
}

function pause(database: DatabaseSync): void {
  database.exec(`UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
    paused_at_ms = NULL, updated_at_ms = ${SQL_NOW} WHERE authority_state = 'd1';
    UPDATE commerce_authority_control SET paused_at_ms = ${SQL_NOW}, updated_at_ms = ${SQL_NOW}
      WHERE authority_state = 'paused' AND paused_at_ms IS NULL`);
}

function insertParent(database: DatabaseSync, path = PATH, documentJson = '{"status":"processing"}'): void {
  database.prepare(`INSERT INTO commerce_documents (document_path, document_kind, drop_id, document_id,
      document_json, version, create_time, update_time)
    VALUES (?, 'delivery_order', 'card_nft_2', ?, ?, 1, '2026-01-01T00:00:00.000000000Z', '2026-01-01T00:00:00.000000000Z')`)
    .run(path, path.split('/').at(-1)!, documentJson);
}

function seedParent(database: DatabaseSync, path = PATH, documentJson?: string): void {
  insertParent(database, path, documentJson);
  database.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1');
}

function insertRecovery(database: DatabaseSync, record: DeliveryRecoveryRecord): void {
  const row = deliveryRecoveryRow(record);
  database.prepare(`INSERT INTO commerce_delivery_recovery (${Object.keys(row).join(', ')})
    VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
}

function updateRecovery(database: DatabaseSync, record: DeliveryRecoveryRecord): void {
  const row = deliveryRecoveryRow(record);
  const fields = Object.keys(row).filter((column) => column !== 'parent_path');
  database.prepare(`UPDATE commerce_delivery_recovery SET ${fields.map((column) => `${column} = ?`).join(', ')}
    WHERE parent_path = ?`).run(...fields.map((column) => row[column]), record.parentPath);
}

function recovery(database: DatabaseSync, path = PATH): DeliveryRecoveryRecord {
  return parseDeliveryRecoveryRow(database.prepare('SELECT * FROM commerce_delivery_recovery WHERE parent_path = ?').get(path));
}

function preparing(database: DatabaseSync): void {
  pause(database);
  database.exec(`UPDATE commerce_delivery_recovery_control SET preparation_state = 'preparing',
    source_documents_revision = (SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1),
    prepared_at_ms = NULL WHERE singleton = 1`);
}

function backfill(database: DatabaseSync): void {
  for (const row of database.prepare(`SELECT document_path, document_json -> '$.receiptRecovery' AS recovery_json
    FROM commerce_documents WHERE document_kind = 'delivery_order'`).all()) {
    insertRecovery(database, createDeliveryRecoveryRecord({
      parentPath: String(row.document_path), receiptRecoveryJson: row.recovery_json as string | null,
      nowMs: 1_000, generation: GENERATION,
    }));
  }
}

function activate(database: DatabaseSync): void {
  database.exec(`UPDATE commerce_delivery_recovery_control SET preparation_state = 'ready', prepared_at_ms = ${SQL_NOW}
    WHERE singleton = 1;
    UPDATE commerce_delivery_recovery_control SET storage_mode = 'table' WHERE singleton = 1`);
}

function activated(database: DatabaseSync): void {
  preparing(database);
  backfill(database);
  activate(database);
  resume(database);
}

type Expectation = { parentPath: string; generation: string | null; revision: number };

function insertGuard(database: DatabaseSync, expectations: Expectation[], paths: string[]): void {
  database.prepare(`INSERT INTO commerce_commit_guards (guard_id, expectations_json, created_at_ms,
    delivery_recovery_expectations_json, delivery_recovery_paths_json) VALUES ('guard', '[]', 1000, ?, ?)`)
    .run(JSON.stringify(expectations), JSON.stringify(paths));
}

function guarded(database: DatabaseSync, expectations: Expectation[], paths: string[], mutate: () => void): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    insertGuard(database, expectations, paths);
    mutate();
    if (paths.length) database.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1');
    database.exec("DELETE FROM commerce_commit_guards WHERE guard_id = 'guard'");
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

test('delivery recovery migration is inactive and preparation requires completed pause and lease', (t) => {
  const { database } = fresh();
  t.after(() => database.close());
  assert.equal(database.prepare('SELECT storage_mode FROM commerce_delivery_recovery_control').get()?.storage_mode, 'legacy');
  seedParent(database);
  assert.throws(() => database.exec("UPDATE commerce_delivery_recovery_control SET preparation_state = 'preparing', source_documents_revision = 1"), /maintenance is not ready/);
  preparing(database);
  assert.throws(() => resume(database), /cutover is incomplete/);
  assert.throws(() => activate(database), /preparation is incomplete/);
  database.exec('DELETE FROM commerce_authority_control_lease');
  assert.throws(() => backfill(database), /delivery recovery is unavailable/);
});

test('delivery recovery activation preserves raw pending journal and lease expiry and is irreversible', (t) => {
  const { database } = fresh();
  t.after(() => database.close());
  const raw = '{"status":"processing","receiptRecovery":{"attemptCount":"2.9","leaseExpiresAt":90000.5,"pendingSubmission":{"signature":"pending"},"unknown":[true,null]}}';
  seedParent(database, PATH, raw);
  seedParent(database, SECOND_PATH, '{"status":"prepared","receiptRecovery":null}');
  activated(database);
  assert.equal(recovery(database).leaseId, null);
  assert.equal(recovery(database).leaseExpiresAtMs, 90_000.5);
  assert.deepEqual(JSON.parse(recovery(database).receiptRecoveryJson!), JSON.parse(raw).receiptRecovery);
  assert.equal(recovery(database, SECOND_PATH).receiptRecoveryJson, 'null');
  pause(database);
  assert.throws(() => database.exec("UPDATE commerce_delivery_recovery_control SET storage_mode = 'legacy'"), /irreversible/);
});

test('delivery recovery activation rejects missing, mismatched, and stale backfill', (t) => {
  for (const corruption of ['missing', 'mismatch', 'stale'] as const) {
    const { database } = fresh();
    t.after(() => database.close());
    seedParent(database, PATH, '{"status":"processing","receiptRecovery":{"attemptCount":1}}');
    preparing(database);
    if (corruption !== 'missing') backfill(database);
    if (corruption === 'mismatch') database.exec("UPDATE commerce_delivery_recovery SET receipt_recovery_json = '{\"attemptCount\":2}'");
    if (corruption === 'stale') database.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
    assert.throws(() => activate(database), /delivery recovery (?:preparation is incomplete|source changed)/);
  }
});

test('delivery recovery state-only CAS writes preserve parent and global revisions', (t) => {
  const { database } = fresh();
  t.after(() => database.close());
  seedParent(database);
  activated(database);
  const before = recovery(database);
  const parent = database.prepare('SELECT * FROM commerce_documents WHERE document_path = ?').get(PATH);
  const authority = database.prepare('SELECT * FROM commerce_authority_control').get();
  const next = updateDeliveryRecoveryRecord(before, { leaseId: LEASE, receiptRecoveryJson: '{"lastAttemptAt":10000,"leaseExpiresAt":100000}' }, 10_000);
  assert.throws(() => updateRecovery(database, next), /unavailable/);
  guarded(database, [before], [], () => updateRecovery(database, next));
  assert.deepEqual(recovery(database), next);
  assert.deepEqual(database.prepare('SELECT * FROM commerce_documents WHERE document_path = ?').get(PATH), parent);
  assert.deepEqual(database.prepare('SELECT * FROM commerce_authority_control').get(), authority);
  assert.throws(() => guarded(database, [before], [], () => updateRecovery(database, next)), /delivery recovery changed/);
  assert.throws(() => guarded(database, [next], [], () => database.exec(`UPDATE commerce_delivery_recovery SET generation = '${LEASE}', revision = revision + 1`)), /delivery recovery revision/);
  pause(database);
  assert.throws(() => updateRecovery(database, updateDeliveryRecoveryRecord(next, {}, 20_000)), /unavailable/);
});

test('delivery recovery fences old parent writers and freezes legacy JSON without lexical coupling', (t) => {
  const { database } = fresh();
  t.after(() => database.close());
  seedParent(database, PATH, '{"status":"processing","receiptRecovery":{"number":1.0,"custom":{"keep":true}}}');
  activated(database);
  assert.throws(() => database.exec('UPDATE commerce_documents SET version = version + 1'), /guarded write/);
  assert.throws(() => database.exec('DELETE FROM commerce_documents'), /guarded deletion/);
  assert.throws(() => insertParent(database, SECOND_PATH), /guarded write/);
  guarded(database, [], [PATH], () => database.prepare('UPDATE commerce_documents SET document_json = ?, version = version + 1 WHERE document_path = ?')
    .run('{"status":"processing","custom":"changed","receiptRecovery":{"custom":{"keep":true},"number":1}}', PATH));
  assert.equal(recovery(database).revision, 1);
  assert.throws(() => guarded(database, [], [PATH], () => database.exec("UPDATE commerce_documents SET document_json = json_set(document_json, '$.receiptRecovery.number', 2)")), /legacy delivery recovery writes/);
  assert.throws(() => guarded(database, [], [PATH], () => database.exec('DELETE FROM commerce_documents')), /guarded deletion/);
});

test('delivery recovery parent creation and deletion require complete atomic sidecar contracts', (t) => {
  const { database } = fresh();
  t.after(() => database.close());
  activated(database);
  const absent = { parentPath: PATH, generation: null, revision: -1 };
  assert.throws(() => guarded(database, [absent], [PATH], () => insertParent(database)), /commit is incomplete/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM commerce_documents').get()?.count, 0);
  assert.throws(() => guarded(database, [absent], [PATH], () => insertParent(database, PATH, '{"receiptRecovery":null}')), /legacy delivery recovery writes/);
  const record = createDeliveryRecoveryRecord({ parentPath: PATH, receiptRecoveryJson: null, nowMs: 1_000, generation: GENERATION });
  guarded(database, [absent], [PATH], () => { insertParent(database); insertRecovery(database, record); });
  assert.throws(() => database.exec('DELETE FROM commerce_delivery_recovery'), /requires parent deletion/);
  guarded(database, [record], [PATH], () => database.exec('DELETE FROM commerce_documents'));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM commerce_delivery_recovery').get()?.count, 0);
});

test('delivery recovery wipe guards enforce per-row snapshots and permit only coordinated cascades', (t) => {
  const { database, clock } = fresh();
  t.after(() => database.close());
  seedParent(database);
  activated(database);
  const record = recovery(database);
  pause(database);
  clock.nowMs += 67_000;
  const authority = database.prepare('SELECT revision, documents_revision FROM commerce_authority_control').get()!;
  const insertWipe = (expected: Expectation[]) => database.prepare(`INSERT INTO commerce_wipe_guards
    (guard_id, expectations_json, expected_documents_revision, expected_authority_revision, created_at_ms, delivery_recovery_expectations_json)
    VALUES ('wipe', ?, ?, ?, ?, ?)`).run(JSON.stringify([{ path: PATH, version: 1 }]),
      authority.documents_revision, authority.revision, clock.nowMs, JSON.stringify(expected));
  assert.throws(() => insertWipe([{ ...record, revision: record.revision + 1 }]), /delivery recovery changed/);
  insertWipe([]);
  assert.throws(() => database.exec('DELETE FROM commerce_documents'), /guarded deletion/);
  database.exec("DELETE FROM commerce_wipe_guards WHERE guard_id = 'wipe'");
  insertWipe([record]);
  database.exec('DELETE FROM commerce_documents');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM commerce_delivery_recovery').get()?.count, 0);
});
