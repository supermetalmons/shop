import assert from 'node:assert/strict';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { unstable_splitSqlQuery } from 'wrangler';
import { D1CommerceRepository, commerceKeys } from '../cloud/workers/api/src/commerceRepository.ts';
import { createCommerceD1Harness, seedCommerceDocuments, seedPackStatusOutbox } from '../cloud/workers/api/test/commerceD1Harness.ts';
import { readCommerceMigrations, replayCommerceMigrations } from '../scripts/shared/commerceMigrationReplay.ts';
import { LEGACY_PACK_STATUS_PROJECTION_FIELDS } from '../scripts/shared/packStatusProjectionFields.ts';
import { sqlSchemaFingerprint } from '../scripts/shared/sqlSchemaFingerprint.ts';
import { createNotificationEmailJobV1 } from '../shared/notificationEmailJob.ts';
import { parseNotificationOutboxRow } from '../shared/notificationOutbox.ts';
import { LEGACY_NOTIFICATION_FIELDS } from '../scripts/shared/frozenCommerceMetadata.ts';
import { STRIPE_CHECKOUT_STATE_FIELDS, hydrateStripeCheckoutState, parseStripeCheckoutStateRow } from '../shared/stripeCheckoutState.ts';
import { commerceTestLease, commerceTestNow } from './helpers/commerceDatabase.ts';

const migrations = readCommerceMigrations();
const cleanup = migrations.find(({ name }) => name === '0046_frozen_commerce_metadata_cleanup.sql')!;
const delivery = commerceKeys.deliveryOrder('drop', '1');
const checkout = commerceKeys.stripeCheckout('drop', 'cs_cleanup');
const owner = '123456789ABCDEFG123456789ABCDEFG';
const id = '00000000-0000-4000-8000-000000000046';
const unknownId = '00000000-0000-4000-8000-000000000047';
const notificationFields = [...LEGACY_NOTIFICATION_FIELDS];
const packFields = [...LEGACY_PACK_STATUS_PROJECTION_FIELDS];
const checkoutFields = [...STRIPE_CHECKOUT_STATE_FIELDS];

function read(database: DatabaseSync, sql: string) {
  return database.prepare(sql).all().map((row) => ({ ...row }));
}

function snapshot(database: DatabaseSync) {
  return {
    schema: read(database, "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type, name"),
    tables: Object.fromEntries(read(database, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
      .map(({ name }) => [String(name), read(database, `SELECT * FROM ${name} ORDER BY rowid`)])),
  };
}

function withoutTriggers(database: DatabaseSync, table: string, run: () => void) {
  const triggers = read(database, `SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = '${table}'`);
  for (const trigger of triggers) database.exec(`DROP TRIGGER ${trigger.name}`);
  try { run(); } finally { for (const trigger of triggers) database.exec(String(trigger.sql)); }
}

function setRaw(database: DatabaseSync, path: string, patch: Record<string, unknown>) {
  const raw = JSON.parse(String(database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').get(path)!.document_json));
  withoutTriggers(database, 'commerce_documents', () => database.prepare('UPDATE commerce_documents SET document_json = ? WHERE document_path = ?')
    .run(JSON.stringify({ ...raw, ...patch }), path));
}

function pause(database: DatabaseSync, drained = true) {
  commerceTestLease(database, () => database.exec(`UPDATE commerce_authority_control SET authority_state = 'paused',
    revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${commerceTestNow} WHERE authority_state = 'd1';
    ${drained ? `UPDATE commerce_authority_control SET paused_at_ms = ${commerceTestNow}, updated_at_ms = ${commerceTestNow}` : ''}`));
}

function resume(database: DatabaseSync) {
  commerceTestLease(database, () => database.exec(`UPDATE commerce_authority_control SET authority_state = 'd1',
    revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${commerceTestNow}`));
}

function migrate(database: DatabaseSync, sql = cleanup.sql, split = false) {
  database.exec('BEGIN');
  try {
    if (split) for (const statement of unstable_splitSqlQuery(sql)) database.prepare(statement).run();
    else database.exec(sql);
    database.exec('COMMIT');
  }
  catch (error) { database.exec('ROLLBACK'); throw error; }
}

function insert(database: DatabaseSync, table: string, row: Record<string, SQLInputValue>) {
  const keys = Object.keys(row);
  database.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...Object.values(row));
}

function outbox(database: DatabaseSync, family: 'ready' | 'shipped' | 'stripe_terminal', pending = false) {
  const parentPath = family === 'stripe_terminal' ? checkout.path : delivery.path;
  const kind = family === 'shipped' ? 'buyer_order_shipped' : family === 'stripe_terminal' ? 'stripe_checkout_manual_review' : 'buyer_order_received';
  const job = createNotificationEmailJobV1({ jobId: family === 'shipped' ? unknownId : id, kind,
    idempotencyKey: `drop:1:${family}`, recipients: ['owner@example.com'], subject: 'Receipt', text: 'Saved text', html: '<p>Saved text</p>',
    context: family === 'stripe_terminal' ? { dropId: 'drop', sessionId: 'cs_cleanup' } : { dropId: 'drop', deliveryId: 1 } });
  const ambiguous = family === 'shipped';
  const state = pending ? 'pending' : ambiguous ? 'failed' : 'queued';
  const row = { parent_path: parentPath, family, drop_id: 'drop', generation: id,
    outcome: family === 'stripe_terminal' ? 'manual_review' : null, state,
    entries_json: JSON.stringify([{ kind, jobId: job.jobId, idempotencyKey: job.idempotencyKey, state,
      ...(pending ? { payload: job } : ambiguous ? { errorCode: 'legacy_shipped_delivery_unknown' } : { queuedAtMs: 100 }) }]),
    revision: 7, attempt_count: 2, next_attempt_at_ms: pending ? 300 : null, claim_id: pending ? id : null,
    claim_expires_at_ms: pending ? 300 : null, retry_until_ms: 1000, created_at_ms: 0, updated_at_ms: 200,
    last_error_code: ambiguous ? 'legacy_shipped_delivery_unknown' : null };
  parseNotificationOutboxRow(row);
  insert(database, 'commerce_notification_outbox', row);
}

function fixture(context: test.TestContext, pending = false) {
  const harness = createCommerceD1Harness({ frozenCommerceMetadataCleanupMigration: false });
  context.after(() => harness.database.close());
  const { database } = harness;
  seedCommerceDocuments(harness, [
    { key: delivery, data: { owner, status: 'ready_to_ship', updatedAt: 200, deliveryId: 1,
      items: [{ kind: 'box', refId: 1 }], retained: { status: 'nested', updatedAt: 123, packStatusProjectionState: 'nested' },
      receiptRecovery: { pendingTransactions: [{ serializedTransaction: 'signed', signature: 'pending' }], leaseExpiresAt: 999 },
    } },
    { key: checkout, data: { owner, status: 'fulfillment_failed', updatedAt: 300, processingAttemptCount: 5,
      manualRefundReviewRequired: true, stripeSessionSummary: { id: 'cs_cleanup' } } },
    { key: commerceKeys.claimCode('UNCHANGED'), data: { status: 'unused', updatedAt: 55 } },
    { key: commerceKeys.deliveryOrder('drop', '2'), data: { status: 'prepared', updatedAt: 77, retained: true } },
  ]);
  const contract = `0x${'1'.repeat(40)}`;
  database.prepare(`UPDATE ethereum_111k_control SET paused = 0, paused_at_ms = NULL, revision = revision + 1,
    chain_id = 11155111, contract_address = ?`).run(contract);
  seedCommerceDocuments(harness, [{ key: commerceKeys.deliveryOrder('111k_devnet', '800'),
    data: { source: 'ethereum', chainId: 11155111, contractAddress: contract, status: 'processing', updatedAt: 125 } }]);
  insert(database, 'ethereum_delivery_quotes', { chain_id: 11155111, contract_address: contract, order_id: 800,
    request_id: id, wallet: contract, address_id: 'saved', address_json: '{"saved":"address"}', token_ids_json: '[1]',
    items_json: '[{"kind":"crate"}]', fee_wei: '1000', deadline: 500, status: 'pending', transaction_hash: 'pending-hash',
    created_at_ms: 100, updated_at_ms: 125 });
  outbox(database, 'ready', pending);
  outbox(database, 'shipped');
  outbox(database, 'stripe_terminal', pending);
  seedPackStatusOutbox(harness, { parentPath: delivery.path, dropId: 'drop', generation: id, state: 'failed',
    revision: 4, failureCount: 8, nextAttemptAtMs: null, completedAtMs: null, failedAtMs: 200, lastErrorCode: 'projection-unknown',
    createdAtMs: 10, updatedAtMs: 200 });
  const ready = notificationFields.filter((field) => !field.startsWith('stripeTerminal'));
  setRaw(database, delivery.path, { ...Object.fromEntries([...ready, ...packFields].map((field) => [field, null])),
    buyerOrderReceivedEmailState: 'pending', buyerOrderReceivedEmailJobId: id,
    buyerOrderReceivedEmailJob: { subject: 'Frozen payload', recipients: ['old@example.com'] },
    buyerOrderShippedEmailState: 'pending', buyerOrderShippedEmailJobId: unknownId,
    packStatusProjectionState: 'pending', packStatusProjectionNextAttemptAtMs: 17, packStatusProjectionFailureCount: 1 });
  setRaw(database, checkout.path, { ...Object.fromEntries(notificationFields.filter((field) => field.startsWith('stripeTerminal')).map((field) => [field, null])),
    ...Object.fromEntries(checkoutFields.map((field) => [field, null])), status: 'processing', updatedAt: 100,
    stripeTerminalNotificationState: 'pending', stripeTerminalNotification: { version: 1,
      jobs: [{ subject: 'Frozen Stripe payload', text: 'Superseded payload' }] } });
  pause(database);
  return harness;
}

const changedTriggers = new Set(['commerce_notification_legacy_insert_fence', 'commerce_notification_legacy_update_fence',
  'commerce_pack_status_legacy_insert_fence', 'commerce_pack_status_legacy_update_fence',
  'commerce_stripe_checkout_parent_insert_guard', 'commerce_stripe_checkout_parent_update_guard']);

for (const pending of [false, true]) {
  test(`cleanup removes only frozen JSON and preserves ${pending ? 'pending jobs and leases with remote-split SQL' : 'terminal ambiguity evidence with whole SQL'}`, async (context) => {
    const harness = fixture(context, pending);
    const { database } = harness;
    const before = snapshot(database);
    const expected = read(database, `SELECT *, CASE WHEN document_kind = 'stripe_checkout' THEN
      json_remove(document_json, ${[...notificationFields, ...packFields, ...checkoutFields].map((field) => `'$.${field}'`).join(', ')})
      ELSE json_remove(document_json, ${[...notificationFields, ...packFields].map((field) => `'$.${field}'`).join(', ')}) END AS cleaned
      FROM commerce_documents ORDER BY rowid`);
    migrate(database, cleanup.sql, pending);
    const after = snapshot(database);
    assert.deepEqual(after.tables, { ...before.tables, commerce_documents: expected.map(({ cleaned, ...row }) => ({
      ...row, document_json: cleaned,
      ...(row.document_kind === 'stripe_checkout' ? { status: null } : {}),
      pack_projection_state: null, pack_projection_next_attempt_ms: null, buyer_notification_state: null, shipper_notification_state: null,
    })) });
    const retainedSchema = (value: typeof before) => value.schema.filter(({ name }) => !changedTriggers.has(String(name)))
      .map(({ sql, ...object }) => ({ ...object, fingerprint: sqlSchemaFingerprint(String(sql)) }));
    assert.deepEqual(retainedSchema(after), retainedSchema(before));
    resume(database);
    const repository = new D1CommerceRepository(harness.db);
    const current = (await repository.get(checkout))!;
    assert.equal(current.data.status, 'fulfillment_failed');
    assert.equal(current.data.updatedAt, 300);
    assert.equal(current.data.processingAttemptCount, 5);
    assert.deepEqual((await repository.get(delivery))?.data.retained, { status: 'nested', updatedAt: 123, packStatusProjectionState: 'nested' });
    assert.equal((await repository.get(delivery))?.data.status, 'ready_to_ship');
    assert.equal((await repository.get(commerceKeys.claimCode('UNCHANGED')))?.data.updatedAt, 55);
    await repository.run(400, (unit) => unit.update(checkout, { status: 'fulfilled', updatedAt: 400, metadata: 'new' }));
    const raw = JSON.parse(String(database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').get(checkout.path)!.document_json));
    assert.equal(checkoutFields.some((field) => Object.hasOwn(raw, field)), false);
    assert.equal((await repository.get(checkout))?.data.status, 'fulfilled');
  });
}

test('cleanup replays fresh without activating storage or changing bootstrap state', (context) => {
  const database = replayCommerceMigrations(migrations.filter(({ name }) => name < cleanup.name));
  context.after(() => database.close());
  const before = snapshot(database);
  migrate(database);
  assert.deepEqual(snapshot(database).tables, before.tables);
  assert.equal(database.prepare('SELECT authority_state FROM commerce_authority_control').get()!.authority_state, 'paused');
  assert.equal(database.prepare('SELECT storage_mode FROM commerce_stripe_checkout_state_control').get()!.storage_mode, 'legacy');
});

test('late migration failure restores all data and guards', (context) => {
  const { database } = fixture(context, true);
  const before = snapshot(database);
  assert.throws(() => migrate(database, `${cleanup.sql}\nINSERT INTO commerce_preorder_cards (card_id) VALUES (0);`, true));
  assert.deepEqual(snapshot(database), before);
  migrate(database);
});

for (const condition of ['active', 'undrained', 'legacy', 'preparing', 'lease', 'expired-lease', 'commit', 'wipe',
  'missing-ready', 'missing-shipped', 'missing-stripe-notification', 'missing-pack', 'missing-checkout', 'checkout-version',
  'missing-recovery', 'notification-parent', 'notification-job-id', 'notification-state', 'notification-claim-id',
  'notification-payload', 'notification-recipient', 'pack-generation', 'pack-counter', 'checkout-counter', 'misplaced-notification', 'misplaced-pack'] as const) {
  test(`cleanup rejects ${condition} with no changes`, (context) => {
    const { database } = fixture(context, true);
    if (condition === 'active') resume(database);
    if (condition === 'undrained') { resume(database); pause(database, false); }
    if (condition === 'legacy' || condition === 'preparing') withoutTriggers(database, 'commerce_notification_outbox_control', () => {
      database.exec(`UPDATE commerce_notification_outbox_control SET storage_mode = 'legacy', preparation_state = '${condition === 'legacy' ? 'idle' : 'preparing'}'`);
    });
    if (condition === 'lease' || condition === 'expired-lease') database.exec(`INSERT INTO commerce_authority_control_lease VALUES
      (1, '${id}', 1, ${condition === 'lease' ? `${commerceTestNow} + 60000` : '2'})`);
    if (condition === 'commit') withoutTriggers(database, 'commerce_commit_guards', () =>
      database.exec("INSERT INTO commerce_commit_guards (guard_id, expectations_json, created_at_ms) VALUES ('pending', '[]', 0)"));
    if (condition === 'wipe') withoutTriggers(database, 'commerce_wipe_guards', () =>
      database.exec("INSERT INTO commerce_wipe_guards (guard_id, expectations_json, expected_documents_revision, created_at_ms) VALUES ('pending', '[]', 0, 0)"));
    const missingFamily = condition === 'missing-ready' ? 'ready' : condition === 'missing-shipped' ? 'shipped' : condition === 'missing-stripe-notification' ? 'stripe_terminal' : null;
    if (missingFamily) withoutTriggers(database, 'commerce_notification_outbox', () => database.prepare('DELETE FROM commerce_notification_outbox WHERE family = ?').run(missingFamily));
    if (condition === 'missing-pack') withoutTriggers(database, 'commerce_pack_status_outbox', () => database.exec('DELETE FROM commerce_pack_status_outbox'));
    if (condition === 'missing-checkout') withoutTriggers(database, 'commerce_stripe_checkout_state', () => database.exec('DELETE FROM commerce_stripe_checkout_state'));
    if (condition === 'checkout-version') withoutTriggers(database, 'commerce_stripe_checkout_state', () => database.exec('UPDATE commerce_stripe_checkout_state SET document_version = document_version + 1'));
    if (condition === 'missing-recovery') withoutTriggers(database, 'commerce_delivery_recovery', () => database.exec('DELETE FROM commerce_delivery_recovery'));
    if (condition.startsWith('notification-')) withoutTriggers(database, 'commerce_notification_outbox', () => {
      const changes = {
        'notification-parent': "drop_id = 'wrong'",
        'notification-job-id': "entries_json = json_set(entries_json, '$[0].jobId', '00000000-0000-0000-0000-000000000000')",
        'notification-state': "entries_json = json_set(entries_json, '$[0].state', 'failed')",
        'notification-claim-id': "claim_id = '00000000-0000-0000-0000-000000000000'",
        'notification-payload': "entries_json = json_set(entries_json, '$[0].payload.jobId', '00000000-0000-4000-8000-000000000099')",
        'notification-recipient': "entries_json = json_set(entries_json, '$[0].payload.recipients[0]', 'invalid@localhost')",
      };
      database.exec(`UPDATE commerce_notification_outbox SET ${changes[condition as keyof typeof changes]} WHERE family = 'ready'`);
    });
    if (condition === 'pack-generation') withoutTriggers(database, 'commerce_pack_status_outbox', () => database.exec("UPDATE commerce_pack_status_outbox SET generation = '00000000-0000-1000-8000-000000000046'"));
    if (condition === 'pack-counter' || condition === 'checkout-counter') {
      database.exec('PRAGMA ignore_check_constraints = ON');
      const table = condition === 'pack-counter' ? 'commerce_pack_status_outbox' : 'commerce_stripe_checkout_state';
      withoutTriggers(database, table, () => database.exec(`UPDATE ${table} SET ${condition === 'pack-counter' ? 'failure_count' : 'processing_attempt_count'} = -1`));
      database.exec('PRAGMA ignore_check_constraints = OFF');
    }
    if (condition === 'misplaced-notification') setRaw(database, delivery.path, { stripeTerminalNotificationState: null });
    if (condition === 'misplaced-pack') setRaw(database, checkout.path, { packStatusProjectionState: null });
    const before = snapshot(database);
    assert.throws(() => migrate(database), /frozen_commerce_metadata_requires_(?:maintenance|valid_state)/);
    assert.deepEqual(snapshot(database), before);
  });
}

for (const table of ['commerce_document_path_revisions', 'commerce_delivery_owner_revisions']) {
  test(`cleanup rejects pristine-looking bootstrap with ${table} history`, (context) => {
    const database = replayCommerceMigrations(migrations.filter(({ name }) => name < cleanup.name));
    context.after(() => database.close());
    database.prepare(`INSERT INTO ${table} VALUES (?, 1)`).run(table === 'commerce_document_path_revisions' ? delivery.path : owner);
    const before = snapshot(database);
    assert.throws(() => migrate(database), /requires_maintenance/);
    assert.deepEqual(snapshot(database), before);
  });
}

test('cleanup rejects legacy writes including null and preserves ordinary guarded updates', async (context) => {
  const harness = fixture(context);
  const { database } = harness;
  migrate(database);
  resume(database);
  const repository = new D1CommerceRepository(harness.db);
  for (const [key, fields] of [[delivery, [...notificationFields, ...packFields]], [checkout, checkoutFields]] as const) {
    for (const field of fields) {
      const before = snapshot(database);
      assert.throws(() => database.prepare('UPDATE commerce_documents SET document_json = json_set(document_json, ?, null), version = version + 1 WHERE document_path = ?')
        .run(`$.${field}`, key.path), /legacy .* writes are disabled/);
      assert.deepEqual(snapshot(database), before);
      assert.throws(() => database.prepare(`INSERT INTO commerce_documents
        (document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time)
        VALUES (?, ?, 'drop', 'new', ?, 1, 'created', 'updated')`).run(
        key.kind === 'stripe_checkout' ? 'drops/drop/stripeCheckouts/new' : 'drops/drop/deliveryOrders/new',
        key.kind, JSON.stringify({ [field]: null })), /legacy .* writes are disabled/);
      assert.deepEqual(snapshot(database), before);
    }
  }
  await repository.run(500, (unit) => unit.update(delivery, { retained: { changed: true } }));
  assert.deepEqual((await repository.get(delivery))?.data.retained, { changed: true });
  assert.throws(() => database.prepare('UPDATE commerce_documents SET version = version + 1 WHERE document_path = ?').run(delivery.path), /guarded write/);
  assert.throws(() => database.prepare('DELETE FROM commerce_documents WHERE document_path = ?').run(delivery.path), /guarded deletion/);
});

test('previous checkout metadata persistence remains compatible after cleanup', async (context) => {
  const harness = fixture(context);
  const { database } = harness;
  migrate(database);
  const raw = JSON.parse(String(database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').get(checkout.path)!.document_json));
  const state = parseStripeCheckoutStateRow(database.prepare('SELECT * FROM commerce_stripe_checkout_state').get());
  const hydrated = hydrateStripeCheckoutState(raw, state);
  const previousWorker = { ...hydrated, retained: 'previous-worker' };
  for (const field of checkoutFields) {
    delete previousWorker[field];
    if (Object.hasOwn(raw, field)) previousWorker[field] = raw[field];
  }
  assert.deepEqual(previousWorker, { ...raw, retained: 'previous-worker' });
  resume(database);
  database.exec('BEGIN');
  try {
    database.prepare(`INSERT INTO commerce_commit_guards
      (guard_id, expectations_json, created_at_ms, stripe_checkout_paths_json) VALUES (?, '[]', 500, ?)`)
      .run(id, JSON.stringify([checkout.path]));
    database.prepare(`UPDATE commerce_documents SET document_json = ?, version = version + 1, update_time = ?
      WHERE document_path = ?`).run(JSON.stringify(previousWorker), '2026-10-01T00:00:00.000Z', checkout.path);
    database.prepare('UPDATE commerce_stripe_checkout_state SET document_version = document_version + 1 WHERE document_path = ?').run(checkout.path);
    database.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
    database.prepare('DELETE FROM commerce_commit_guards WHERE guard_id = ?').run(id);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  const current = (await new D1CommerceRepository(harness.db).get(checkout))!;
  assert.deepEqual(current.data, { ...hydrated, retained: 'previous-worker' });
  assert.equal(current.version, state.documentVersion + 1);
});
