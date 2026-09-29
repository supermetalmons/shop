import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseStripeCheckoutStateControlArgs, runStripeCheckoutStateControl } from '../scripts/ops/stripeCheckoutStateControl.ts';
import { parseCommerceD1DocumentRow, queryRemoteCommerceDocuments } from '../scripts/shared/commerceD1Maintenance.ts';
import { planStripeCheckoutStateBackfill } from '../scripts/shared/stripeCheckoutStateMaintenance.ts';
import { parseStripeCheckoutStateRow } from '../shared/stripeCheckoutState.ts';

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
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && (current || name < '0026')).sort()) {
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
  ) VALUES (?, 'stripe_checkout', 'drop', ?, ?, 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`)
    .run(`drops/drop/stripeCheckouts/${id}`, id, JSON.stringify({ status: 'processing', updatedAt: 1000, ...data }));
  db.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
}

function query(db: DatabaseSync) { return (sql: string) => db.prepare(sql).all().map((row) => ({ ...row })); }
function execute(db: DatabaseSync, command: string, overrides = {}) {
  const revision = db.prepare('SELECT revision FROM commerce_authority_control').get()!.revision;
  return runStripeCheckoutStateControl([command, ...(command === 'status' ? [] : ['--write', '--expected-revision', String(revision)]),
    ...(command === 'activate' ? ['--worker-deployed'] : [])], { query: query(db), ...overrides });
}

test('checkout state control requires deliberate writes and successful Worker publication', () => {
  assert.throws(() => parseStripeCheckoutStateControlArgs(['prepare']), /requires --write/);
  assert.throws(() => parseStripeCheckoutStateControlArgs(['status', '--write']), /read-only/);
  assert.throws(() => parseStripeCheckoutStateControlArgs(['activate', '--write', '--expected-revision', '1']), /--worker-deployed/);
});

test('maintenance reads support populated pre-cutover schemas and reject partially missing current schemas', (context) => {
  const previous = database(context, false);
  insert(previous, 'cs_old');
  const queryPrevious = query(previous);
  assert.equal(queryRemoteCommerceDocuments('SELECT * FROM commerce_documents', queryPrevious)[0].data.status, 'processing');
  const current = database(context);
  insert(current, 'cs_new');
  const queryCurrent = query(current);
  current.exec('DROP TABLE commerce_stripe_checkout_state_control');
  assert.throws(() => queryRemoteCommerceDocuments('SELECT * FROM commerce_documents', queryCurrent), /schema is incomplete/);
});

test('checkout preparation preserves fields and document versions and activation is one-way', async (context) => {
  const db = database(context);
  insert(db, 'cs_1', { processingAttemptId: 'attempt', processingAttemptCount: 3, processingStartedAt: 900,
    processingLeaseExpiresAt: 2000, lastRetryableFulfillmentAttempt: 2, lastRetryableFulfillmentErrorAt: 800,
    nextFulfillmentRetryAt: 2100, fulfillmentQueueReenqueuedAt: 700, lastFulfillmentReconciliationErrorAt: 600,
    payment: { futureMetadata: 'preserved' } });
  const before = query(db)('SELECT * FROM commerce_documents');
  const expected = before.map(parseCommerceD1DocumentRow).map(planStripeCheckoutStateBackfill);
  pause(db);
  const revisions = query(db)('SELECT documents_revision FROM commerce_authority_control');
  assert.equal((await execute(db, 'prepare')).preparation, 'ready');
  assert.deepEqual(query(db)('SELECT * FROM commerce_stripe_checkout_state').map(parseStripeCheckoutStateRow), expected);
  assert.deepEqual(query(db)('SELECT * FROM commerce_documents'), before);
  assert.deepEqual(query(db)('SELECT documents_revision FROM commerce_authority_control'), revisions);
  assert.throws(() => resume(db), /cutover is incomplete/);
  assert.equal((await execute(db, 'activate')).mode, 'table');
  assert.throws(() => withLease(db, () => db.exec("UPDATE commerce_stripe_checkout_state_control SET storage_mode = 'legacy'")), /irreversible/);
  resume(db);
});

test('interrupted preparation resumes by retaining imported rows and stays bounded by document pages', async (context) => {
  const db = database(context);
  for (let index = 0; index < 30; index += 1) insert(db, `cs_${100 + index}`);
  pause(db);
  const normal = query(db);
  let imports = 0;
  await assert.rejects(execute(db, 'prepare', { query: (sql: string) => {
    const rows = normal(sql);
    if (sql.startsWith('INSERT INTO commerce_stripe_checkout_state (') && ++imports === 3) throw new Error('lost acknowledgement');
    return rows;
  } }), /lost acknowledgement/);
  assert.throws(() => resume(db), /cutover is incomplete/);
  await assert.rejects(execute(db, 'activate'), /incomplete or stale/);
  const saved = normal('SELECT * FROM commerce_stripe_checkout_state ORDER BY document_path');
  imports = 0;
  await execute(db, 'prepare', { query: (sql: string) => {
    if (sql.startsWith('INSERT INTO commerce_stripe_checkout_state (')) imports += 1;
    if (sql.startsWith('SELECT document_path, document_kind')) assert.match(sql, /LIMIT 25$/);
    assert.ok(Buffer.byteLength(sql) < 100_000);
    return normal(sql);
  } });
  assert.equal(imports, 27);
  assert.deepEqual(normal('SELECT * FROM commerce_stripe_checkout_state ORDER BY document_path LIMIT 3'), saved);
  assert.equal((await execute(db, 'activate')).checkoutCount, 30);
});

test('malformed legacy state is rejected before changing preparation state', async (context) => {
  const db = database(context);
  insert(db, 'cs_bad', { processingAttemptCount: '3' });
  pause(db);
  await assert.rejects(execute(db, 'prepare'), /validation failed/);
  assert.match((await execute(db, 'status')).validationError!, /validation failed/);
  assert.equal(db.prepare('SELECT preparation_state FROM commerce_stripe_checkout_state_control').get()!.preparation_state, 'idle');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_stripe_checkout_state').get()!.count, 0);
});

test('checkout state activation rejects stale preparation and reconciles a lost acknowledgement', async (context) => {
  const db = database(context);
  insert(db, 'cs_1');
  pause(db);
  await execute(db, 'prepare');
  db.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
  await assert.rejects(execute(db, 'activate'), /incomplete or stale/);
  await execute(db, 'prepare');
  const normal = query(db);
  assert.equal((await execute(db, 'activate', { query: (sql: string) => {
    const rows = normal(sql);
    if (sql.startsWith("UPDATE commerce_stripe_checkout_state_control SET storage_mode = 'table'")) throw new Error('lost acknowledgement');
    return rows;
  } })).mode, 'table');
});

test('active maintenance reads hydrate table state and never reimport frozen legacy JSON', async (context) => {
  const db = database(context);
  insert(db, 'cs_1');
  const normal = query(db);
  const source = normal('SELECT * FROM commerce_documents');
  assert.equal(queryRemoteCommerceDocuments('SELECT * FROM commerce_documents', normal)[0].data.status, 'processing');
  pause(db);
  await execute(db, 'prepare');
  await execute(db, 'activate');
  db.exec("DROP TRIGGER commerce_stripe_checkout_state_update_guard; UPDATE commerce_stripe_checkout_state SET status = 'fulfilled', updated_at_ms = 3000");
  const hydrated = queryRemoteCommerceDocuments('SELECT * FROM commerce_documents', normal)[0];
  assert.equal(hydrated.data.status, 'fulfilled');
  assert.equal(hydrated.data.updatedAt, 3000);
  assert.equal(parseCommerceD1DocumentRow(source[0]).data.status, 'processing');
  await execute(db, 'prepare');
  assert.equal(normal('SELECT status FROM commerce_stripe_checkout_state')[0].status, 'fulfilled');
  db.exec('UPDATE commerce_stripe_checkout_state SET document_version = 2');
  assert.throws(() => queryRemoteCommerceDocuments('SELECT * FROM commerce_documents', normal), /missing or stale/);
  await assert.rejects(execute(db, 'prepare'), /differs from source/);
});

test('maintenance reads keep metadata, parent versions, and state together across a concurrent checkout update', async (context) => {
  const db = database(context);
  insert(db, 'cs_1', { snapshotLabel: 'original' });
  pause(db);
  await execute(db, 'prepare');
  await execute(db, 'activate');
  resume(db);
  const normal = query(db);
  const sql = "SELECT * FROM commerce_documents WHERE document_id = 'cs_1'";
  let updated = false;
  const documents = queryRemoteCommerceDocuments(sql, (statement) => {
    const rows = normal(statement);
    if (statement === sql) {
      assert.equal(rows[0].version, 1);
      db.exec(`BEGIN;
        INSERT INTO commerce_commit_guards (guard_id, expectations_json, created_at_ms, stripe_checkout_paths_json)
          VALUES ('snapshot-update', '[{"path":"drops/drop/stripeCheckouts/cs_1","version":1}]', 2000,
            '["drops/drop/stripeCheckouts/cs_1"]');
        UPDATE commerce_documents SET document_json = json_set(document_json, '$.snapshotLabel', 'updated'),
          version = 2, update_time = '2026-09-01T00:00:01.000Z' WHERE document_id = 'cs_1';
        UPDATE commerce_stripe_checkout_state SET document_version = 2, status = 'fulfilled', updated_at_ms = 2000
          WHERE document_path = 'drops/drop/stripeCheckouts/cs_1';
        UPDATE commerce_authority_control SET documents_revision = documents_revision + 1;
        DELETE FROM commerce_commit_guards WHERE guard_id = 'snapshot-update';
        COMMIT;`);
      updated = true;
    }
    return rows;
  });
  assert.equal(updated, true);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].version, 2);
  assert.equal(documents[0].data.snapshotLabel, 'updated');
  assert.equal(documents[0].data.status, 'fulfilled');
  assert.equal(documents[0].data.updatedAt, 2000);
});

test('checkout snapshot hydration preserves query filtering, ordering, and limits', async (context) => {
  const db = database(context);
  for (const id of ['cs_1', 'cs_2', 'cs_3']) insert(db, id);
  pause(db);
  await execute(db, 'prepare');
  await execute(db, 'activate');
  const selected = queryRemoteCommerceDocuments(`SELECT * FROM commerce_documents
    WHERE document_id <> 'cs_2' ORDER BY document_id DESC LIMIT 1;`, query(db));
  assert.deepEqual(selected.map((document) => document.documentId), ['cs_3']);
});

test('noncheckout maintenance reads keep their original snapshot without querying checkout storage', (context) => {
  const db = database(context);
  db.exec(`INSERT INTO commerce_documents (document_path, document_kind, drop_id, document_id,
    document_json, version, create_time, update_time) VALUES (
      'claimCodes/CODE', 'claim_code', NULL, 'CODE', '{"status":"unused"}', 1,
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`);
  const normal = query(db);
  const sql = "SELECT * FROM commerce_documents WHERE document_kind = 'claim_code'";
  const documents = queryRemoteCommerceDocuments(sql, (statement) => {
    assert.equal(statement, sql);
    return normal(statement);
  });
  assert.equal(documents[0].data.status, 'unused');
});

test('checkout state maintenance refuses missing pause, stale authority, and unfinished wipes', async (context) => {
  const db = database(context);
  await assert.rejects(execute(db, 'prepare'), /pause\/drain/);
  pause(db);
  await assert.rejects(runStripeCheckoutStateControl(['prepare', '--write', '--expected-revision', '1'], { query: query(db) }), /expected authority revision/);
  const normal = query(db);
  await assert.rejects(execute(db, 'prepare', { query: (sql: string) => sql.startsWith('SELECT guard_id') ? [{ guard_id: 'unfinished' }] : normal(sql) }), /wipe is unfinished/);
});
