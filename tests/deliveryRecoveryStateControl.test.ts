import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseDeliveryRecoveryStateControlArgs, runDeliveryRecoveryStateControl } from '../scripts/ops/deliveryRecoveryStateControl.ts';
import { parseCommerceD1DocumentRow, queryRemoteCommerceDocuments } from '../scripts/shared/commerceD1Maintenance.ts';
import { parseDeliveryRecoveryRow } from '../shared/deliveryRecoveryState.ts';

const timestamp = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

function withLease(db: DatabaseSync, operation: () => void) {
  db.exec(`INSERT INTO commerce_authority_control_lease VALUES
    (1, '00000000-0000-4000-8000-000000001099', ${timestamp}, ${timestamp} + 60000)`);
  try { operation(); } finally { db.exec('DELETE FROM commerce_authority_control_lease'); }
}

function database(context: { after: (cleanup: () => void) => void }, current = true) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../cloud/workers/api/commerce-migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '0033' && (current || name < '0030')).sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  withLease(db, () => db.exec(`UPDATE commerce_authority_control SET paused_at_ms = ${timestamp}, updated_at_ms = ${timestamp};
    UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = ${timestamp}`));
  return db;
}

function pause(db: DatabaseSync) {
  withLease(db, () => db.exec(`UPDATE commerce_authority_control SET authority_state = 'paused',
    revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${timestamp};
    UPDATE commerce_authority_control SET paused_at_ms = ${timestamp}, updated_at_ms = ${timestamp}`));
}

function resume(db: DatabaseSync) {
  withLease(db, () => db.exec(`UPDATE commerce_authority_control SET authority_state = 'd1',
    revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${timestamp}`));
}

function insert(db: DatabaseSync, id: string, data: Record<string, unknown> = {}) {
  db.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
  ) VALUES (?, 'delivery_order', 'drop', ?, ?, 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`)
    .run(`drops/drop/deliveryOrders/${id}`, id, JSON.stringify({ status: 'processing', updatedAt: 1000, ...data }));
  db.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
}

function query(db: DatabaseSync) { return (sql: string) => db.prepare(sql).all().map((row) => ({ ...row })); }
function execute(db: DatabaseSync, command: string, overrides = {}) {
  const revision = db.prepare('SELECT revision FROM commerce_authority_control').get()!.revision;
  return runDeliveryRecoveryStateControl([command, ...(command === 'status' ? [] : ['--write', '--expected-revision', String(revision)]),
    ...(command === 'activate' ? ['--worker-deployed'] : [])], { query: query(db), ...overrides });
}

test('recovery state control requires explicit mutation flags and compatible Worker publication', () => {
  assert.throws(() => parseDeliveryRecoveryStateControlArgs(['prepare']), /requires --write/);
  assert.throws(() => parseDeliveryRecoveryStateControlArgs(['status', '--write']), /read-only/);
  assert.throws(() => parseDeliveryRecoveryStateControlArgs(['activate', '--write', '--expected-revision', '1']), /--worker-deployed/);
  assert.throws(() => parseDeliveryRecoveryStateControlArgs(['prepare', '--write', '--expected-revision', '1', '--worker-deployed']), /only to activation/);
});

test('recovery preparation preserves every value, pending journals, legacy lease expiry, and parent versions', async (context) => {
  const db = database(context);
  const values = [undefined, null, false, 3, ['future'], { preparedProbeCount: '2.9', nextPreparedProbeAt: 1500,
    lastAttemptAt: 1000, leaseExpiresAt: 5000, pendingTransactions: [{ serializedTransaction: 'signed', signature: 'sig' }], future: { keep: true } }];
  for (let index = 0; index < values.length; index += 1) insert(db, String(index), values[index] === undefined ? {} : { receiptRecovery: values[index] });
  const before = query(db)('SELECT * FROM commerce_documents ORDER BY document_path');
  pause(db);
  const revisions = query(db)('SELECT documents_revision FROM commerce_authority_control');
  assert.equal((await execute(db, 'prepare')).deliveryCount, values.length);
  const records = query(db)('SELECT * FROM commerce_delivery_recovery ORDER BY parent_path').map(parseDeliveryRecoveryRow);
  for (let index = 0; index < values.length; index += 1) {
    assert.equal(records[index].receiptRecoveryJson, values[index] === undefined ? null : JSON.stringify(values[index]));
    assert.equal(records[index].revision, 1);
    assert.equal(records[index].leaseId, null);
  }
  assert.equal(records.at(-1)!.preparedDelayMs, 600000);
  assert.equal(records.at(-1)!.leaseExpiresAtMs, 5000);
  assert.deepEqual(query(db)('SELECT * FROM commerce_documents ORDER BY document_path'), before);
  assert.deepEqual(query(db)('SELECT documents_revision FROM commerce_authority_control'), revisions);
  assert.throws(() => resume(db), /cutover is incomplete/);
  assert.equal((await execute(db, 'activate')).mode, 'table');
  assert.throws(() => withLease(db, () => db.exec("UPDATE commerce_delivery_recovery_control SET storage_mode = 'legacy'")), /irreversible/);
  resume(db);
  const hydrated = queryRemoteCommerceDocuments('SELECT * FROM commerce_documents ORDER BY document_path', query(db));
  assert.deepEqual(hydrated.map((document) => document.data.receiptRecovery), values);
  assert.equal((await execute(db, 'status')).legacyMetadataCount, values.length - 1);
});

test('interrupted recovery preparation resumes without replacing imported generations and bounds source reads', async (context) => {
  const db = database(context);
  for (let index = 0; index < 30; index += 1) insert(db, String(100 + index));
  pause(db);
  const normal = query(db);
  let imports = 0;
  await assert.rejects(execute(db, 'prepare', { query: (sql: string) => {
    const rows = normal(sql);
    if (sql.startsWith('INSERT INTO commerce_delivery_recovery (') && ++imports === 1) throw new Error('lost acknowledgement');
    return rows;
  } }), /lost acknowledgement/);
  const saved = normal('SELECT * FROM commerce_delivery_recovery ORDER BY parent_path');
  assert.equal((await execute(db, 'status')).preparation, 'preparing');
  await assert.rejects(execute(db, 'activate'), /incomplete or stale/);
  imports = 0;
  await execute(db, 'prepare', { query: (sql: string) => {
    if (sql.startsWith('INSERT INTO commerce_delivery_recovery (')) imports += 1;
    if (sql.startsWith('SELECT document.document_path, document.document_kind')) assert.match(sql, /LIMIT 5$/);
    assert.ok(Buffer.byteLength(sql) < 100000);
    return normal(sql);
  } });
  assert.equal(imports, 5);
  assert.equal(saved.length, 5);
  assert.deepEqual(normal('SELECT * FROM commerce_delivery_recovery ORDER BY parent_path LIMIT 5'), saved);
  assert.equal((await execute(db, 'activate')).deliveryCount, 30);
});

test('recovery imports copy large source payloads without expanding SQL statements', async (context) => {
  const db = database(context);
  const payloads = [...Array<string>(25).fill('x'.repeat(4000)), 'large-source-payload\'"\\🌍'.repeat(10_000)];
  for (const [index, custom] of payloads.entries()) {
    insert(db, String(1000 + index), { receiptRecovery: { custom, preparedProbeCount: '1' } });
  }
  const normal = query(db);
  const parents = normal('SELECT * FROM commerce_documents ORDER BY document_path');
  const expected = normal(`SELECT document_path AS parent_path, document_json -> '$.receiptRecovery' AS receipt_recovery_json
    FROM commerce_documents ORDER BY document_path`);
  assert.ok(Buffer.byteLength(String(expected.at(-1)!.receipt_recovery_json)) > 100_000);
  pause(db);
  const importedPageSizes: number[] = [];
  const boundedQuery = (sql: string) => {
    assert.ok(Buffer.byteLength(sql) < 100_000, 'Every statement must fit the D1 SQL size limit');
    const rows = normal(sql);
    if (sql.startsWith('INSERT INTO commerce_delivery_recovery (')) {
      assert.doesNotMatch(sql, /large-source-payload|x{100}/);
      importedPageSizes.push(rows.length);
    }
    return rows;
  };
  assert.equal((await execute(db, 'prepare', { query: boundedQuery })).preparation, 'ready');
  assert.deepEqual(importedPageSizes, [5, 5, 5, 5, 5, 1]);
  assert.deepEqual(normal('SELECT parent_path, receipt_recovery_json FROM commerce_delivery_recovery ORDER BY parent_path'), expected);
  assert.deepEqual(normal('SELECT * FROM commerce_documents ORDER BY document_path'), parents);
  assert.equal((await execute(db, 'activate', { query: boundedQuery })).mode, 'table');
});

test('large recovery pages stay below the runner output limit throughout the cutover', async (context) => {
  const db = database(context);
  const payload = { custom: '\\'.repeat(900_000) };
  for (let index = 0; index < 11; index += 1) {
    insert(db, String(1000 + index), { retained: '\\'.repeat(75_000), receiptRecovery: payload });
  }
  pause(db);
  const normal = query(db);
  let sawImportedPage = false;
  const boundedQuery = (sql: string) => {
    const rows = normal(sql);
    const responseBytes = Buffer.byteLength(JSON.stringify([{ success: true, results: rows, meta: {} }], null, 2));
    assert.ok(responseBytes < 64 * 1024 * 1024, `Query output is ${responseBytes} bytes`);
    if (sql.startsWith('SELECT document.document_path, document.document_kind')) {
      assert.ok(rows.length <= 5);
      for (const row of rows) {
        assert.equal(Object.hasOwn(JSON.parse(String(row.document_json)), 'receiptRecovery'), false);
        if (row.parent_path === null) continue;
        sawImportedPage = true;
        assert.equal(row.receipt_recovery_json, row.legacy_receipt_recovery_json);
      }
    }
    return rows;
  };
  assert.equal((await execute(db, 'prepare', { query: boundedQuery })).preparation, 'ready');
  assert.equal(sawImportedPage, true);
  assert.equal((await execute(db, 'status', { query: boundedQuery })).validationError, null);
  assert.equal((await execute(db, 'prepare', { query: boundedQuery })).deliveryCount, 11);
  assert.equal((await execute(db, 'activate', { query: boundedQuery })).mode, 'table');
  assert.equal((await execute(db, 'status', { query: boundedQuery })).validationError, null);
  resume(db);
});

test('recovery preparation rejects malformed parent metadata before writing state', async (context) => {
  const db = database(context);
  insert(db, 'bad');
  db.exec("UPDATE commerce_documents SET update_time = 'broken', version = version + 1");
  pause(db);
  await assert.rejects(execute(db, 'prepare'), /identity is inconsistent/);
  assert.match((await execute(db, 'status')).validationError!, /identity is inconsistent/);
  assert.equal(query(db)('SELECT preparation_state FROM commerce_delivery_recovery_control')[0].preparation_state, 'idle');
  assert.equal(query(db)('SELECT COUNT(*) AS count FROM commerce_delivery_recovery')[0].count, 0);
});

test('recovery activation rejects stale preparation and reconciles a lost acknowledgement', async (context) => {
  const db = database(context);
  insert(db, '1');
  pause(db);
  await execute(db, 'prepare');
  db.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
  await assert.rejects(execute(db, 'activate'), /incomplete or stale/);
  assert.match((await execute(db, 'status')).validationError!, /stale/);
  await execute(db, 'prepare');
  const normal = query(db);
  assert.equal((await execute(db, 'activate', { query: (sql: string) => {
    const rows = normal(sql);
    if (sql.startsWith("UPDATE commerce_delivery_recovery_control SET storage_mode = 'table'")) throw new Error('lost acknowledgement');
    return rows;
  } })).mode, 'table');
});

test('active maintenance hydration uses recovery rows and prepare never restores frozen JSON', async (context) => {
  const db = database(context);
  insert(db, '1', { receiptRecovery: { preparedProbeCount: 0, future: 'frozen' } });
  pause(db);
  await execute(db, 'prepare');
  await execute(db, 'activate');
  const normal = query(db);
  db.exec(`DROP TRIGGER commerce_delivery_recovery_update_guard;
    UPDATE commerce_delivery_recovery SET receipt_recovery_json = '{"preparedProbeCount":3}', prepared_delay_ms = NULL,
      revision = revision + 1, updated_at_ms = updated_at_ms + 1`);
  assert.deepEqual(queryRemoteCommerceDocuments('SELECT * FROM commerce_documents', normal)[0].data.receiptRecovery, { preparedProbeCount: 3 });
  await execute(db, 'prepare');
  assert.deepEqual(queryRemoteCommerceDocuments('SELECT * FROM commerce_documents', normal)[0].data.receiptRecovery, { preparedProbeCount: 3 });
  const parent = parseCommerceD1DocumentRow(normal('SELECT * FROM commerce_documents')[0]);
  assert.deepEqual(parent.data.receiptRecovery, { preparedProbeCount: 0, future: 'frozen' });
  db.exec('UPDATE commerce_delivery_recovery SET prepared_delay_ms = 30000');
  assert.throws(() => queryRemoteCommerceDocuments('SELECT * FROM commerce_documents', normal), /projections/);
  await assert.rejects(execute(db, 'prepare'), /projections/);
});

test('maintenance hydration avoids duplicate large payloads before and after activation', async (context) => {
  const db = database(context);
  const receiptRecovery = { preparedProbeCount: 1, future: '\"\\'.repeat(275_000) };
  for (let index = 0; index < 16; index += 1) insert(db, String(1000 + index), { receiptRecovery });
  const normal = query(db);
  const sourceJson = normal("SELECT document_json -> '$.receiptRecovery' AS recovery FROM commerce_documents LIMIT 1")[0].recovery;
  assert.equal(typeof sourceJson, 'string');
  assert.ok(Buffer.byteLength(String(sourceJson)) > 1_100_000);
  let active = false;
  let snapshots = 0;
  const boundedQuery = (sql: string) => {
    const rows = normal(sql);
    assert.ok(Buffer.byteLength(JSON.stringify([{ success: true, results: rows, meta: {} }], null, 2)) < 64 * 1024 * 1024);
    if (sql.startsWith('SELECT snapshot.document_path,')) {
      snapshots += 1;
      assert.equal(rows.length, 16);
      for (const row of rows) {
        assert.equal(Object.hasOwn(JSON.parse(String(row.document_json)), 'receiptRecovery'), !active);
        assert.equal(row.recovery_payload_json, active ? sourceJson : null);
        if (active) {
          assert.ok(Buffer.byteLength(String(row.recovery_state_json)) < 1024);
          assert.equal(Object.hasOwn(JSON.parse(String(row.recovery_state_json)), 'receipt_recovery_json'), false);
        }
      }
    }
    return rows;
  };
  const sql = 'SELECT * FROM commerce_documents ORDER BY document_path';
  const legacy = queryRemoteCommerceDocuments(sql, boundedQuery);
  pause(db);
  await execute(db, 'prepare');
  assert.deepEqual(queryRemoteCommerceDocuments(sql, boundedQuery), legacy);
  await execute(db, 'activate');
  active = true;
  const hydrated = queryRemoteCommerceDocuments(sql, boundedQuery);
  assert.equal(snapshots, 3);
  assert.deepEqual(hydrated, legacy);
  assert.deepEqual(hydrated[0].data.receiptRecovery, receiptRecovery);
  assert.equal(normal("SELECT COUNT(*) AS count FROM commerce_documents WHERE json_type(document_json, '$.receiptRecovery') IS NOT NULL")[0].count, 16);
});

test('maintenance reads support pre-cutover delivery schemas and reject incomplete new schemas', (context) => {
  const previous = database(context, false);
  insert(previous, '1', { receiptRecovery: { leaseExpiresAt: 1000 } });
  assert.deepEqual(queryRemoteCommerceDocuments('SELECT * FROM commerce_documents', query(previous))[0].data.receiptRecovery, { leaseExpiresAt: 1000 });
  const current = database(context);
  insert(current, '1');
  current.exec('DROP TABLE commerce_delivery_recovery_control');
  assert.throws(() => queryRemoteCommerceDocuments('SELECT * FROM commerce_documents', query(current)), /schema is incomplete/);
});

test('recovery control refuses an undrained pause, stale authority, unfinished wipe, and overlapping maintenance', async (context) => {
  const db = database(context);
  await assert.rejects(execute(db, 'prepare'), /pause\/drain/);
  pause(db);
  await assert.rejects(runDeliveryRecoveryStateControl(['prepare', '--write', '--expected-revision', '1'], { query: query(db) }), /expected authority revision/);
  const normal = query(db);
  await assert.rejects(execute(db, 'prepare', { query: (sql: string) => sql.startsWith('SELECT guard_id') ? [{ guard_id: 'unfinished' }] : normal(sql) }), /wipe is unfinished/);
  db.exec(`INSERT INTO commerce_authority_control_lease VALUES
    (1, '00000000-0000-4000-8000-000000001099', ${timestamp}, ${timestamp} + 60000)`);
  await assert.rejects(execute(db, 'prepare'), /already running/);
});

test('maintenance reads hydrate parent and recovery from one current snapshot after a concurrent update', async (context) => {
  const db = database(context);
  insert(db, '1', { receiptRecovery: { preparedProbeCount: 0 }, snapshotLabel: 'original' });
  pause(db);
  await execute(db, 'prepare');
  await execute(db, 'activate');
  resume(db);
  const normal = query(db);
  const record = parseDeliveryRecoveryRow(normal('SELECT * FROM commerce_delivery_recovery')[0]);
  const sql = "SELECT * FROM commerce_documents WHERE document_id = '1' ORDER BY document_path LIMIT 1;";
  const hydrated = queryRemoteCommerceDocuments(sql, (statement) => {
    const rows = normal(statement);
    if (statement === sql) {
      db.prepare(`INSERT INTO commerce_commit_guards
        (guard_id, expectations_json, created_at_ms, delivery_recovery_paths_json, delivery_recovery_expectations_json)
        VALUES ('recovery-update', ?, 2000, ?, ?)`).run(JSON.stringify([{ path: record.parentPath, version: 1 }]),
        JSON.stringify([record.parentPath]), JSON.stringify([{ parentPath: record.parentPath, generation: record.generation, revision: 1 }]));
      db.exec(`UPDATE commerce_documents SET document_json = json_set(document_json, '$.snapshotLabel', 'updated'),
        version = 2, update_time = '2026-09-01T00:00:01.000Z';
        UPDATE commerce_delivery_recovery SET receipt_recovery_json = '{"preparedProbeCount":1}', prepared_delay_ms = 120000,
          revision = 2, updated_at_ms = updated_at_ms + 1;
        UPDATE commerce_authority_control SET documents_revision = documents_revision + 1;
        DELETE FROM commerce_commit_guards WHERE guard_id = 'recovery-update'`);
    }
    return rows;
  });
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0].version, 2);
  assert.equal(hydrated[0].data.snapshotLabel, 'updated');
  assert.deepEqual(hydrated[0].data.receiptRecovery, { preparedProbeCount: 1 });
});

test('recovery preparation, status, and activation use page-bounded remote calls for hundreds of orders', async (context) => {
  const db = database(context);
  const orderCount = 548;
  const pageCount = Math.ceil(orderCount / 5);
  for (let index = 0; index < orderCount; index += 1) insert(db, String(1000 + index));
  pause(db);
  const normal = query(db);
  let calls = 0;
  let imports = 0;
  const importedPageSizes: number[] = [];
  const observed = (sql: string) => {
    calls += 1;
    assert.doesNotMatch(sql, /^SELECT \* FROM commerce_delivery_recovery WHERE parent_path/);
    if (sql.startsWith('SELECT document.document_path, document.document_kind')) {
      assert.match(sql, /LEFT JOIN commerce_delivery_recovery/);
      assert.match(sql, /LIMIT 5$/);
    }
    const rows = normal(sql);
    if (sql.startsWith('INSERT INTO commerce_delivery_recovery (')) {
      imports += 1;
      importedPageSizes.push(rows.length);
      assert.match(sql, /UNION ALL/);
    }
    assert.ok(Buffer.byteLength(sql) < 100000);
    return rows;
  };
  assert.equal((await execute(db, 'prepare', { query: observed })).deliveryCount, orderCount);
  assert.equal(imports, pageCount);
  assert.deepEqual(importedPageSizes, [...Array(pageCount - 1).fill(5), 3]);
  assert.ok(calls <= pageCount * 4 + 20, `prepare made ${calls} queries for ${pageCount} pages`);
  const saved = normal('SELECT * FROM commerce_delivery_recovery ORDER BY parent_path');
  calls = 0;
  imports = 0;
  assert.equal((await execute(db, 'status', { query: observed })).validationError, null);
  assert.ok(calls <= pageCount + 4, `status made ${calls} queries for ${pageCount} pages`);
  assert.equal(imports, 0);
  calls = 0;
  await execute(db, 'prepare', { query: observed });
  assert.equal(imports, 0);
  assert.deepEqual(normal('SELECT * FROM commerce_delivery_recovery ORDER BY parent_path'), saved);
  assert.ok(calls <= pageCount * 3 + 20, `repeated prepare made ${calls} queries for ${pageCount} pages`);
  calls = 0;
  assert.equal((await execute(db, 'activate', { query: observed })).mode, 'table');
  assert.ok(calls <= pageCount + 15, `activate made ${calls} queries for ${pageCount} pages`);
  assert.equal(imports, 0);
});
