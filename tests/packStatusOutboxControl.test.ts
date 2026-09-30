import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parsePackStatusOutboxControlArgs, runPackStatusOutboxControl } from '../scripts/ops/packStatusOutboxControl.ts';
import { parseCommerceD1DocumentRow } from '../scripts/shared/commerceD1Maintenance.ts';
import { planPackStatusOutboxBackfill } from '../scripts/shared/packStatusOutboxMaintenance.ts';
import { parsePackStatusOutboxRow } from '../shared/packStatusOutbox.ts';

const timestamp = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
const dropId = 'card_nft_2';

function withLease(db: DatabaseSync, operation: () => void) {
  db.exec(`INSERT INTO commerce_authority_control_lease VALUES
    (1, '00000000-0000-4000-8000-000000002099', ${timestamp}, ${timestamp} + 60000)`);
  try { operation(); } finally { db.exec('DELETE FROM commerce_authority_control_lease'); }
}

function database(context: { after: (cleanup: () => void) => void }) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../cloud/workers/api/commerce-migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
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

function insert(db: DatabaseSync, id: number, data: Record<string, unknown> = {}) {
  db.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
  ) VALUES (?, 'delivery_order', ?, ?, ?, 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:01:00.000Z')`)
    .run(`drops/${dropId}/deliveryOrders/${id}`, dropId, String(id), JSON.stringify({
      deliveryId: id, status: 'ready_to_ship', items: [{ kind: 'box', refId: 1 }], ...data,
    }));
  db.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
}

function query(db: DatabaseSync) { return (sql: string) => db.prepare(sql).all().map((row) => ({ ...row })); }
function execute(db: DatabaseSync, command: string, overrides: Parameters<typeof runPackStatusOutboxControl>[1] = {}) {
  const revision = db.prepare('SELECT revision FROM commerce_authority_control').get()!.revision;
  return runPackStatusOutboxControl([command, ...(command === 'status' ? [] : ['--write', '--expected-revision', String(revision)]),
    ...(command === 'activate' ? ['--worker-deployed'] : [])], { query: query(db), ...overrides });
}

test('pack-status control requires deliberate writes and compatible publication', () => {
  assert.throws(() => parsePackStatusOutboxControlArgs(['prepare']), /requires --write/);
  assert.throws(() => parsePackStatusOutboxControlArgs(['status', '--write']), /read-only/);
  assert.throws(() => parsePackStatusOutboxControlArgs(['activate', '--write', '--expected-revision', '1']), /--worker-deployed/);
  assert.throws(() => parsePackStatusOutboxControlArgs(['prepare', '--write', '--expected-revision', '1', '--worker-deployed']), /only to activation/);
});

test('preparation preserves explicit projection states and leaves unmarked historical orders alone', async (context) => {
  const db = database(context);
  insert(db, 1, { packStatusProjectionState: 'pending', packStatusProjectionFailureCount: 2,
    packStatusProjectionNextAttemptAtMs: 1700000000000, packStatusProjectionLastErrorCode: 'd1-write-failed' });
  insert(db, 2, { packStatusProjectionState: 'completed', packStatusProjectionFailureCount: 1,
    packStatusProjectionCompletedAt: 1700000000100 });
  insert(db, 3, { packStatusProjectionState: 'failed', packStatusProjectionFailedAt: 1700000000200,
    packStatusProjectionLastErrorCode: 'invalid-order-items' });
  insert(db, 4);
  const documents = query(db)('SELECT * FROM commerce_documents ORDER BY document_path');
  const revision = query(db)('SELECT documents_revision FROM commerce_authority_control')[0].documents_revision;
  pause(db);
  const prepared = await execute(db, 'prepare');
  assert.equal(prepared.preparation, 'ready');
  assert.equal(prepared.projectionCount, 3);
  assert.equal(prepared.validationError, null);
  const expected = documents.map(parseCommerceD1DocumentRow).flatMap((document) => planPackStatusOutboxBackfill(document) ?? []);
  assert.deepEqual(query(db)('SELECT * FROM commerce_pack_status_outbox ORDER BY parent_path').map(parsePackStatusOutboxRow), expected);
  assert.deepEqual(query(db)('SELECT * FROM commerce_documents ORDER BY document_path'), documents);
  assert.equal(query(db)('SELECT documents_revision FROM commerce_authority_control')[0].documents_revision, revision);
  const active = await execute(db, 'activate');
  assert.equal(active.mode, 'table');
  assert.equal(active.validationError, null);
  assert.deepEqual(query(db)('SELECT * FROM commerce_documents ORDER BY document_path'), documents);
  assert.throws(() => withLease(db, () => db.exec("UPDATE commerce_pack_status_outbox_control SET storage_mode = 'legacy'")), /irreversible/);
  resume(db);
  assert.throws(() => db.exec(`UPDATE commerce_documents SET document_json = json_set(document_json, '$.packStatusProjectionState', 'completed'),
    version = version + 1 WHERE document_id = '1'`), /legacy pack-status projection/);
  assert.throws(() => insert(db, 5, { packStatusProjectionState: 'pending' }), /legacy pack-status projection/);
});

test('legacy defaults match the existing retry reader and preparation is deterministic', async (context) => {
  const db = database(context);
  insert(db, 1, { packStatusProjectionState: 'pending' });
  insert(db, 2, { packStatusProjectionState: 'completed' });
  pause(db);
  await execute(db, 'prepare');
  const before = query(db)('SELECT * FROM commerce_pack_status_outbox ORDER BY parent_path');
  assert.equal(before[0].failure_count, 0);
  assert.equal(before[0].next_attempt_at_ms, 0);
  assert.equal(before[1].completed_at_ms, null);
  await execute(db, 'prepare');
  assert.deepEqual(query(db)('SELECT * FROM commerce_pack_status_outbox ORDER BY parent_path'), before);
});

test('all legacy sources are validated before importing any rows', async (context) => {
  for (const invalid of [
    { packStatusProjectionState: 'unknown' },
    { packStatusProjectionState: 'pending', packStatusProjectionFailureCount: null },
    { packStatusProjectionState: 'pending', packStatusProjectionNextAttemptAtMs: -1 },
    { packStatusProjectionState: 'completed', packStatusProjectionCompletedAt: 'yesterday' },
    { packStatusProjectionFailureCount: 1 },
    { packStatusProjectionState: 'pending', deliveryId: 999 },
    { packStatusProjectionState: 'pending', items: [] },
    { packStatusProjectionState: 'pending', source: 'stripe_offchain' },
  ]) {
    const db = database(context);
    insert(db, 1, { packStatusProjectionState: 'pending' });
    insert(db, 2, invalid);
    pause(db);
    await assert.rejects(execute(db, 'prepare'), /validation failed for drops\/card_nft_2\/deliveryOrders\/2/);
    assert.equal(query(db)('SELECT COUNT(*) AS count FROM commerce_pack_status_outbox')[0].count, 0);
    assert.equal(query(db)('SELECT preparation_state FROM commerce_pack_status_outbox_control')[0].preparation_state, 'idle');
    assert.equal(query(db)('SELECT COUNT(*) AS count FROM commerce_authority_control_lease')[0].count, 0);
  }
});

test('interrupted preparation retains identical rows and blocks resume until activation', async (context) => {
  const db = database(context);
  for (let id = 1; id <= 30; id += 1) insert(db, id, { packStatusProjectionState: 'pending' });
  pause(db);
  let imports = 0;
  await assert.rejects(execute(db, 'prepare', { query: (sql) => {
    if (sql.startsWith('INSERT INTO commerce_pack_status_outbox (') && ++imports === 3) throw new Error('interrupted');
    return query(db)(sql);
  } }), /interrupted/);
  assert.equal(query(db)('SELECT COUNT(*) AS count FROM commerce_pack_status_outbox')[0].count, 2);
  const partial = query(db)('SELECT * FROM commerce_pack_status_outbox ORDER BY parent_path');
  assert.throws(() => resume(db), /cutover is incomplete/);
  await execute(db, 'prepare');
  const complete = query(db)('SELECT * FROM commerce_pack_status_outbox ORDER BY parent_path');
  assert.equal(complete.length, 30);
  assert.deepEqual(complete.slice(0, 2), partial);
  await execute(db, 'activate');
  resume(db);
});

test('misplaced legacy markers on non-order records fail before preparation or imports', async (context) => {
  const db = database(context);
  insert(db, 1, { packStatusProjectionState: 'pending' });
  db.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
  ) VALUES ('claimCodes/misplaced', 'claim_code', NULL, 'misplaced', ?, 1,
    '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`)
    .run(JSON.stringify({ packStatusProjectionState: 'pending' }));
  db.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
  pause(db);
  assert.match((await execute(db, 'status')).validationError || '', /claimCodes\/misplaced/);
  await assert.rejects(execute(db, 'prepare'), /claimCodes\/misplaced/);
  assert.equal(query(db)('SELECT COUNT(*) AS count FROM commerce_pack_status_outbox')[0].count, 0);
  assert.equal(query(db)('SELECT preparation_state FROM commerce_pack_status_outbox_control')[0].preparation_state, 'idle');
  assert.doesNotThrow(() => resume(db));
});

test('maintenance rejects missing drain, stale revision, stale preparation and overlapping leases', async (context) => {
  const db = database(context);
  insert(db, 1, { packStatusProjectionState: 'pending' });
  await assert.rejects(execute(db, 'prepare'), /completed Commerce pause/);
  pause(db);
  await assert.rejects(runPackStatusOutboxControl(['prepare', '--write', '--expected-revision', '999'], { query: query(db) }), /expected authority revision/);
  db.exec(`INSERT INTO commerce_authority_control_lease VALUES
    (1, '00000000-0000-4000-8000-000000002098', ${timestamp}, ${timestamp} + 60000)`);
  await assert.rejects(execute(db, 'prepare'), /already running/);
  db.exec('DELETE FROM commerce_authority_control_lease');
  await execute(db, 'prepare');
  withLease(db, () => db.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1'));
  await assert.rejects(execute(db, 'activate'), /preparation is incomplete or stale/);
  assert.throws(() => resume(db), /cutover is incomplete/);
  await execute(db, 'prepare');
  await execute(db, 'activate');
});

test('activation requires exact prepared rows and source equality', async (context) => {
  const db = database(context);
  insert(db, 1, { packStatusProjectionState: 'pending' });
  pause(db);
  await execute(db, 'prepare');
  withLease(db, () => db.exec(`UPDATE commerce_pack_status_outbox_control SET preparation_state = 'preparing', prepared_at_ms = NULL;
    UPDATE commerce_pack_status_outbox SET failure_count = 5;
    UPDATE commerce_pack_status_outbox_control SET preparation_state = 'ready', prepared_at_ms = ${timestamp}`));
  await assert.rejects(execute(db, 'activate'), /differs from source/);
  await execute(db, 'prepare');
  await execute(db, 'activate');
});

test('active preparation validates current state without replaying frozen JSON', async (context) => {
  const db = database(context);
  insert(db, 1, { packStatusProjectionState: 'pending' });
  pause(db);
  await execute(db, 'prepare');
  await execute(db, 'activate');
  resume(db);
  db.exec(`UPDATE commerce_pack_status_outbox SET state = 'completed', next_attempt_at_ms = NULL,
    completed_at_ms = ${timestamp}, revision = revision + 1, updated_at_ms = ${timestamp}`);
  pause(db);
  const before = query(db)('SELECT * FROM commerce_pack_status_outbox');
  const status = await execute(db, 'prepare');
  assert.equal(status.mode, 'table');
  assert.equal(status.validationError, null);
  assert.deepEqual(query(db)('SELECT * FROM commerce_pack_status_outbox'), before);
  assert.equal(JSON.parse(String(query(db)('SELECT document_json FROM commerce_documents')[0].document_json)).packStatusProjectionState, 'pending');
});

test('lost activation response is recovered by observing the committed control state', async (context) => {
  const db = database(context);
  insert(db, 1, { packStatusProjectionState: 'pending' });
  pause(db);
  await execute(db, 'prepare');
  let lost = false;
  const status = await execute(db, 'activate', { query: (sql) => {
    const rows = query(db)(sql);
    if (!lost && sql.startsWith("UPDATE commerce_pack_status_outbox_control SET storage_mode = 'table'")) {
      lost = true;
      throw new Error('response lost');
    }
    return rows;
  } });
  assert.equal(lost, true);
  assert.equal(status.mode, 'table');
});

test('active validation detects a lost migrated obligation without comparing frozen retry state', async (context) => {
  const db = database(context);
  insert(db, 1, { packStatusProjectionState: 'pending' });
  insert(db, 2);
  pause(db);
  await execute(db, 'prepare');
  await execute(db, 'activate');
  withLease(db, () => db.exec('DELETE FROM commerce_pack_status_outbox'));
  const status = await execute(db, 'status');
  assert.match(status.validationError || '', /outbox is missing: drops\/card_nft_2\/deliveryOrders\/1/);
  await assert.rejects(execute(db, 'prepare'), /outbox is missing/);
  assert.equal(query(db)('SELECT COUNT(*) AS count FROM commerce_pack_status_outbox')[0].count, 0);
});
