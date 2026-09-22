import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { unstable_splitSqlQuery } from 'wrangler';

const directory = new URL('../cloud/workers/api/commerce-migrations/', import.meta.url);
const migrationName = '0014_drop_legacy_notification_indexes.sql';
const migrationSql = readFileSync(new URL(migrationName, directory), 'utf8');
const legacyIndexes = [
  'commerce_delivery_orders_buyer_notifications_pending',
  'commerce_delivery_orders_buyer_notifications_pending_owner_path',
  'commerce_delivery_orders_shipper_notifications_pending',
  'commerce_delivery_orders_shipper_notifications_pending_owner_path',
  'commerce_ready_notifications_due',
  'commerce_stripe_terminal_notifications_due',
];
const timestamp = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

function database(context: { after: (cleanup: () => void) => void }): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < migrationName).sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'));
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
  }
  return db;
}

function applyCleanup(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const statement of unstable_splitSqlQuery(migrationSql)) db.exec(statement);
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(migrationName);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function withLease(db: DatabaseSync, operation: () => void): void {
  db.exec(`INSERT INTO commerce_authority_control_lease VALUES (
    1, '00000000-0000-4000-8000-000000000014', ${timestamp}, ${timestamp} + 60000
  )`);
  try { operation(); }
  finally { db.exec('DELETE FROM commerce_authority_control_lease'); }
}

function resume(db: DatabaseSync): void {
  withLease(db, () => db.exec(`UPDATE commerce_authority_control
      SET paused_at_ms = ${timestamp}, updated_at_ms = ${timestamp} WHERE paused_at_ms IS NULL;
    UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = ${timestamp}`));
}

function pause(db: DatabaseSync): void {
  withLease(db, () => db.exec(`UPDATE commerce_authority_control
      SET authority_state = 'paused', revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${timestamp};
    UPDATE commerce_authority_control SET paused_at_ms = ${timestamp}, updated_at_ms = ${timestamp}`));
}

function seedDocument(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    INSERT INTO commerce_documents (
      document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
    ) VALUES ('drops/drop/deliveryOrders/1', 'delivery_order', 'drop', '1',
      '{"owner":"owner","status":"ready_to_ship","buyerOrderReceivedEmailState":"pending"}', 1, 'created', 'updated');
    UPDATE commerce_authority_control SET documents_revision = documents_revision + 1;
    COMMIT`);
}

function prepare(db: DatabaseSync, ready: boolean): void {
  db.exec(`UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing',
    source_documents_revision = (SELECT documents_revision FROM commerce_authority_control)`);
  if (ready) db.exec(`UPDATE commerce_notification_outbox_control
    SET preparation_state = 'ready', prepared_at_ms = ${timestamp}`);
}

function seedOutbox(db: DatabaseSync): void {
  db.exec(`INSERT INTO commerce_notification_outbox (
    parent_path, family, drop_id, generation, outcome, state, entries_json, revision,
    attempt_count, next_attempt_at_ms, claim_id, claim_expires_at_ms, retry_until_ms,
    created_at_ms, updated_at_ms, last_error_code
  ) VALUES ('drops/drop/deliveryOrders/1', 'ready', 'drop', '00000000-0000-4000-8000-000000000114',
    NULL, 'pending', '[{"kind":"buyer_order_received","jobId":"00000000-0000-4000-8000-000000000214","idempotencyKey":"drop:1:order_received","state":"pending"}]',
    1, 0, 0, NULL, NULL, 10000, 0, 0, NULL)`);
}

function rows(db: DatabaseSync) {
  return Object.fromEntries([
    'commerce_authority_control', 'commerce_notification_outbox_control',
    'commerce_documents', 'commerce_notification_outbox',
    'commerce_notification_outbox_pending_owners', 'commerce_notification_outbox_stripe_due',
  ].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
}

function schema(db: DatabaseSync) {
  return db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
}

function assertCleaned(db: DatabaseSync): void {
  assert.deepEqual(db.prepare(`SELECT name FROM sqlite_schema
    WHERE name IN (${legacyIndexes.map(() => '?').join(', ')})`).all(...legacyIndexes), []);
  assert.deepEqual(db.prepare(`SELECT name FROM sqlite_schema
    WHERE name = 'commerce_legacy_notification_index_migration_guard'`).all(), []);
  assert.equal(db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').get()?.name, migrationName);
}

function assertBlocked(db: DatabaseSync): void {
  const before = { schema: schema(db), rows: rows(db), migrations: db.prepare('SELECT * FROM d1_migrations').all() };
  assert.throws(() => applyCleanup(db), /notification_outbox_activation_required/);
  assert.deepEqual({ schema: schema(db), rows: rows(db), migrations: db.prepare('SELECT * FROM d1_migrations').all() }, before);
  assert.deepEqual(db.prepare(`SELECT name FROM sqlite_schema
    WHERE name IN (${legacyIndexes.map(() => '?').join(', ')}) ORDER BY name`).all(...legacyIndexes)
    .map((row) => row.name), legacyIndexes);
}

test('legacy notification cleanup accepts untouched fresh bootstrap without activating it', (context) => {
  const db = database(context);
  const before = rows(db);
  applyCleanup(db);
  assert.deepEqual(rows(db), before);
  assertCleaned(db);
});

for (const active of [false, true]) {
  test(`legacy notification cleanup preserves populated table storage while ${active ? 'active' : 'paused'}`, (context) => {
    const db = database(context);
    resume(db);
    seedDocument(db);
    pause(db);
    withLease(db, () => {
      prepare(db, false);
      seedOutbox(db);
      db.exec(`UPDATE commerce_notification_outbox_control SET preparation_state = 'ready', prepared_at_ms = ${timestamp};
        UPDATE commerce_notification_outbox_control SET storage_mode = 'table'`);
    });
    if (active) resume(db);
    const before = rows(db);
    applyCleanup(db);
    assert.deepEqual(rows(db), before);
    assertCleaned(db);
  });
}

for (const preparation of ['idle', 'preparing', 'ready'] as const) {
  test(`legacy notification cleanup rejects populated legacy ${preparation} without changing schema or data`, (context) => {
    const db = database(context);
    resume(db);
    seedDocument(db);
    pause(db);
    if (preparation !== 'idle') withLease(db, () => prepare(db, preparation === 'ready'));
    assertBlocked(db);
  });
}

test('legacy notification cleanup rejects active empty legacy storage', (context) => {
  const db = database(context);
  resume(db);
  assertBlocked(db);
});

test('legacy notification cleanup rejects an empty database that already completed its first pause', (context) => {
  const db = database(context);
  withLease(db, () => db.exec(`UPDATE commerce_authority_control
    SET paused_at_ms = ${timestamp}, updated_at_ms = ${timestamp}`));
  assertBlocked(db);
});

test('legacy notification cleanup rejects fresh bootstrap with an active maintenance lease', (context) => {
  const db = database(context);
  withLease(db, () => assertBlocked(db));
});
