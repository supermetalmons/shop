import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  checkCommerceD1,
  type CheckCommerceD1Query,
} from '../scripts/ops/checkCommerceD1.ts';
import { inventoryDropConfigs } from '../scripts/shared/dudeInventoryMaintenance.ts';
import { createDeliveryRecoveryRecord, deliveryRecoveryRow } from '../shared/deliveryRecoveryState.ts';
import { runDeliveryRecoveryStateControl } from '../scripts/ops/deliveryRecoveryStateControl.ts';
import { packStatusOutboxRow } from '../shared/packStatusOutbox.ts';
import { legacyPackStatusProjectionsQuery, planPackStatusOutboxBackfill } from '../scripts/shared/packStatusOutboxMaintenance.ts';
import { parseCommerceD1DocumentRow } from '../scripts/shared/commerceD1Maintenance.ts';
import {
  adminIrlRedeemWorkflowStatusQuery,
  deliveryOrderOwnersQuery,
  deliveryRecoveryStateQuery,
  packStatusOutboxDueQuery,
  dueReadyNotificationsQuery,
  dueStripeTerminalNotificationsQuery,
  fulfillmentOrdersQuery,
  manualReviewCheckoutsQuery,
  pendingReadyNotificationsQuery,
  shipmentHistoryPageQuery,
  shipmentPresenceQuery,
  staleStripeFulfillmentsQuery,
  stripeChargebackLinkedSessionsQuery,
  stripeChargebackMatchedDocumentsQuery,
} from '../cloud/workers/api/src/commerceQueries.ts';
import { renderCommerceQuerySql } from '../scripts/shared/commerceQuerySql.ts';
import { runStripeCheckoutStateControl } from '../scripts/ops/stripeCheckoutStateControl.ts';

const migrationNames = [
  '0001_current_schema.sql',
  '0002_authority_control_lease.sql',
  '0003_wipe_readiness_guard.sql',
  '0004_ready_notification_owner_indexes.sql',
  '0005_delivery_owner_query_revisions.sql',
  '0006_document_path_revisions.sql',
  '0007_stripe_terminal_notifications.sql',
  '0008_admin_irl_redeem_workflow_operation.sql',
  '0009_ready_notification_due_index.sql',
  '0010_dude_inventory.sql',
  '0011_stripe_order_disputes.sql',
  '0012_stripe_identity_lookup_indexes.sql',
  '0013_notification_outbox.sql',
  '0014_drop_legacy_notification_indexes.sql',
  '0015_manual_review_pagination.sql',
  '0016_shipment_history_pagination.sql',
  '0017_receipt_claim_workflow.sql',
  '0018_preorders.sql',
  '0019_preorder_buyer_index.sql',
  '0020_preorder_expiry_index.sql',
  '0021_preorder_ethereum_ownership.sql',
  '0022_preorder_confirmation.sql',
  '0023_preorder_card_range.sql',
  '0024_preorder_card_range_1400.sql',
  '0025_preorder_scoped_expiry.sql',
  '0026_stripe_checkout_state.sql',
  '0027_preorder_expiry_claim_release.sql',
  '0028_preorder_card_range_1413.sql',
  '0029_pack_status_outbox.sql',
  '0030_delivery_recovery.sql',
  '0031_preorder_card_range_1419.sql',
] as const;

test('preorder migration is required for deployment and its unique claims and permanent-history guards are checked', () => {
  const previous = currentDatabase(false, 17);
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  assert.throws(() => checkCommerceD1(localQuery(previous), { forDeployment: true }), /preorder migration/);
  previous.close();
  for (const [type, name] of [['index', 'commerce_preorder_active_buyer'], ['trigger', 'commerce_preorder_claim_delete_guard']] as const) {
    const database = currentDatabase(false);
    database.exec(`DROP ${type} ${name}`);
    assert.throws(() => checkCommerceD1(localQuery(database)), /preorder schema/);
    database.close();
  }
});

test('Stripe checkout state migration is required for deployment while the previous baseline remains inspectable', () => {
  const previous = currentDatabase(false, 25);
  try {
    assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
    assert.throws(() => checkCommerceD1(localQuery(previous), { forDeployment: true }), /Stripe checkout state migration/);
  } finally { previous.close(); }
});

test('Stripe checkout state schema checks reject missing state guards and reconciliation indexes', () => {
  for (const [type, name] of [
    ['TRIGGER', 'commerce_stripe_checkout_state_update_guard'],
    ['TRIGGER', 'commerce_commit_guard_stripe_checkout_finish'],
    ['INDEX', 'commerce_stripe_checkout_state_reconciliation_due'],
  ]) {
    const database = currentDatabase(false);
    try {
      database.exec(`DROP ${type} ${name}`);
      assert.throws(() => checkCommerceD1(localQuery(database)), /Stripe checkout state schema is invalid/);
    } finally { database.close(); }
  }
});

test('active checkout health uses authoritative state and rejects missing or stale parent versions', async () => {
  const database = currentDatabase();
  try {
    database.exec(`INSERT INTO commerce_authority_control_lease VALUES
      (1, '00000000-0000-4000-8000-000000000907', CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000);
      UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
      UPDATE commerce_authority_control SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
      DELETE FROM commerce_authority_control_lease`);
    const query = localQuery(database);
    const revision = String(query('SELECT revision FROM commerce_authority_control')[0].revision);
    await runStripeCheckoutStateControl(['prepare', '--write', '--expected-revision', revision], { query });
    await runStripeCheckoutStateControl(['activate', '--write', '--expected-revision', revision, '--worker-deployed'], { query });
    assert.equal(checkCommerceD1(query).stripeCheckoutStateRows, 256);
    assert.equal(checkCommerceD1((sql) => query(sql).map((row) => sql.startsWith('SELECT checkout.*,')
      ? { ...row, document_version: Number(row.document_version) + 1, parent_version: Number(row.parent_version) + 1 }
      : row)).stripeCheckoutStateRows, 256);
    const updateGuard = String(query("SELECT sql FROM sqlite_schema WHERE name = 'commerce_stripe_checkout_state_update_guard'")[0].sql);
    database.exec(`DROP TRIGGER commerce_stripe_checkout_state_update_guard;
      UPDATE commerce_stripe_checkout_state SET status = 'fulfilled' WHERE document_path = 'drops/drop/stripeCheckouts/0';
      ${updateGuard}`);
    assert.equal(checkCommerceD1(query).stripeCheckoutStateMode, 'table');
    database.exec(`DROP TRIGGER commerce_stripe_checkout_state_update_guard;
      UPDATE commerce_stripe_checkout_state SET document_version = 2 WHERE document_path = 'drops/drop/stripeCheckouts/0';
      ${updateGuard}`);
    assert.throws(() => checkCommerceD1(query), /parent or version is invalid/);
    const deleteGuard = String(query("SELECT sql FROM sqlite_schema WHERE name = 'commerce_stripe_checkout_state_delete_guard'")[0].sql);
    database.exec(`DROP TRIGGER commerce_stripe_checkout_state_delete_guard;
      DELETE FROM commerce_stripe_checkout_state WHERE document_path = 'drops/drop/stripeCheckouts/0';
      ${deleteGuard}`);
    assert.throws(() => checkCommerceD1(query), /differs from source/);
  } finally { database.close(); }
});

test('preorder buyer index is required for deployment and its definition is verified', () => {
  const previous = currentDatabase(false, 18);
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  assert.throws(() => checkCommerceD1(localQuery(previous), { forDeployment: true }), /preorder buyer index migration/);
  previous.close();
  const database = currentDatabase(false);
  database.exec('DROP INDEX commerce_preorder_succeeded_buyer');
  assert.throws(() => checkCommerceD1(localQuery(database)), /preorder buyer index is invalid/);
  database.exec('CREATE INDEX commerce_preorder_succeeded_buyer ON commerce_preorder_orders (buyer)');
  assert.throws(() => checkCommerceD1(localQuery(database)), /preorder buyer index is invalid/);
  database.close();
});

test('preorder expiry index is required for deployment and its definition is verified', () => {
  const previous = currentDatabase(false, 19);
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  assert.throws(() => checkCommerceD1(localQuery(previous), { forDeployment: true }), /preorder expiry index migration/);
  previous.close();
  const database = currentDatabase(false);
  database.exec('DROP INDEX commerce_preorder_prepared_expiry');
  assert.throws(() => checkCommerceD1(localQuery(database)), /preorder expiry index is invalid/);
  database.exec('CREATE INDEX commerce_preorder_prepared_expiry ON commerce_preorder_orders (expires_at_ms)');
  assert.throws(() => checkCommerceD1(localQuery(database)), /preorder expiry index is invalid/);
  database.close();
});

test('preorder Ethereum identity migration is required for deployment and its guards are verified', () => {
  const previous = currentDatabase(false, 20);
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  assert.throws(() => checkCommerceD1(localQuery(previous), { forDeployment: true }), /Ethereum ownership migration/);
  previous.close();
  const database = currentDatabase(false);
  database.exec('DROP TRIGGER commerce_preorder_order_update_guard');
  assert.throws(() => checkCommerceD1(localQuery(database)), /preorder schema/);
  database.close();
});

test('preorder confirmation migration is required for deployment and its recovery guards are verified', () => {
  const previous = currentDatabase(false, 21);
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  assert.throws(() => checkCommerceD1(localQuery(previous), { forDeployment: true }), /confirmation migration/);
  previous.close();
  for (const [type, name] of [
    ['trigger', 'commerce_preorder_confirmation_guard'],
    ['index', 'commerce_preorder_confirmed_recovery'],
    ['index', 'commerce_preorder_inventory_buyer'],
  ] as const) {
    const database = currentDatabase(false);
    database.exec(`DROP ${type} ${name}`);
    assert.throws(() => checkCommerceD1(localQuery(database)), /preorder schema/);
    database.close();
  }
  const database = currentDatabase(false);
  database.exec(`DROP INDEX commerce_preorder_active_buyer;
    CREATE UNIQUE INDEX commerce_preorder_active_buyer ON commerce_preorder_orders (cluster, collection, buyer)
      WHERE status IN ('prepared', 'submitted')`);
  assert.throws(() => checkCommerceD1(localQuery(database)), /preorder schema/);
  database.close();
});

test('preorder card range migration is required for deployment and its table and claim guards are verified', () => {
  const previous = currentDatabase(false, 22);
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  assert.throws(() => checkCommerceD1(localQuery(previous), { forDeployment: true }), /card range migration/);
  previous.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run('0023_preorder_card_range.sql');
  assert.throws(() => checkCommerceD1(localQuery(previous)), /preorder schema commerce_preorder_claims/);
  previous.close();
  for (const [type, name] of [
    ['index', 'commerce_preorder_claim_order'],
    ['trigger', 'commerce_preorder_claim_insert_guard'],
    ['trigger', 'commerce_preorder_claim_update_guard'],
    ['trigger', 'commerce_preorder_claim_delete_guard'],
  ] as const) {
    const database = currentDatabase(false);
    database.exec(`DROP ${type} ${name}`);
    assert.throws(() => checkCommerceD1(localQuery(database)), /preorder schema/);
    database.close();
  }
});

test('preorder card range 1400 migration is required for deployment and its table is verified', () => {
  const previous = currentDatabase(false, 23);
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  assert.throws(() => checkCommerceD1(localQuery(previous), { forDeployment: true }), /card range 1400 migration/);
  previous.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run('0024_preorder_card_range_1400.sql');
  assert.throws(() => checkCommerceD1(localQuery(previous)), /preorder schema commerce_preorder_claims/);
  previous.exec(readFileSync(new URL('../cloud/workers/api/commerce-migrations/0024_preorder_card_range_1400.sql', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  previous.close();
});

test('preorder scoped expiry migration is required for deployment and its index definition is verified', () => {
  const previous = currentDatabase(false, 24);
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  assert.throws(() => checkCommerceD1(localQuery(previous), { forDeployment: true }), /scoped expiry migration/);
  previous.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run('0025_preorder_scoped_expiry.sql');
  assert.throws(() => checkCommerceD1(localQuery(previous)), /preorder expiry index is invalid/);
  previous.exec(readFileSync(new URL('../cloud/workers/api/commerce-migrations/0025_preorder_scoped_expiry.sql', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  previous.close();
});

test('preorder expiry claim release migration is required for deployment while the previous baseline remains inspectable', (context) => {
  const previous = currentDatabase(false, 26);
  context.after(() => previous.close());
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  assert.throws(() => checkCommerceD1(localQuery(previous), { forDeployment: true }), /expiry claim release migration/);
  previous.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run('0027_preorder_expiry_claim_release.sql');
  assert.throws(() => checkCommerceD1(localQuery(previous)), /preorder schema commerce_preorder_expiry_claim_release/);
  previous.exec(readFileSync(new URL('../cloud/workers/api/commerce-migrations/0027_preorder_expiry_claim_release.sql', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
});

test('preorder card range 1413 migration is required for deployment and its excluded specials are verified', (context) => {
  const previous = currentDatabase(false, 27);
  context.after(() => previous.close());
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  assert.throws(() => checkCommerceD1(localQuery(previous), { forDeployment: true }), /card range 1413 migration/);
  previous.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run('0028_preorder_card_range_1413.sql');
  assert.throws(() => checkCommerceD1(localQuery(previous)), /preorder schema commerce_preorder_claims/);
  const migration = readFileSync(new URL('../cloud/workers/api/commerce-migrations/0028_preorder_card_range_1413.sql', import.meta.url), 'utf8');
  previous.exec(migration);
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  previous.exec(migration.replace('card_id BETWEEN 1 AND 1400 OR card_id BETWEEN 1409 AND 1413', 'card_id BETWEEN 1 AND 1413'));
  assert.throws(() => checkCommerceD1(localQuery(previous)), /preorder schema commerce_preorder_claims/);
});

test('preorder expiry claim release schema rejects a missing or broadened trigger', (context) => {
  const database = currentDatabase(false);
  context.after(() => database.close());
  database.exec('DROP TRIGGER commerce_preorder_expiry_claim_release');
  assert.throws(() => checkCommerceD1(localQuery(database)), /preorder schema commerce_preorder_expiry_claim_release/);
  database.exec(`CREATE TRIGGER commerce_preorder_expiry_claim_release
    AFTER UPDATE OF status ON commerce_preorder_orders WHEN NEW.status = 'expired'
    BEGIN DELETE FROM commerce_preorder_claims WHERE order_id = NEW.order_id; END`);
  assert.throws(() => checkCommerceD1(localQuery(database)), /preorder schema commerce_preorder_expiry_claim_release/);
});

test('preorder card range 1419 migration is required for deployment and its excluded specials are verified', (context) => {
  const previous = currentDatabase(false, 30);
  context.after(() => previous.close());
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  assert.throws(() => checkCommerceD1(localQuery(previous), { forDeployment: true }), /card range 1419 migration/);
  previous.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run('0031_preorder_card_range_1419.sql');
  assert.throws(() => checkCommerceD1(localQuery(previous)), /preorder schema commerce_preorder_claims/);
  const migration = readFileSync(new URL('../cloud/workers/api/commerce-migrations/0031_preorder_card_range_1419.sql', import.meta.url), 'utf8');
  previous.exec(migration);
  assert.doesNotThrow(() => checkCommerceD1(localQuery(previous)));
  previous.exec(migration.replace('card_id BETWEEN 1 AND 1400 OR card_id BETWEEN 1409 AND 1419', 'card_id BETWEEN 1 AND 1419'));
  assert.throws(() => checkCommerceD1(localQuery(previous)), /preorder schema commerce_preorder_claims/);
});

function currentDatabase(seedDocuments = true, migrationCount: 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 = 31): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  const appliedMigrations = migrationNames.slice(0, migrationCount);
  for (const name of appliedMigrations) {
    database.exec(readFileSync(
      new URL(`../cloud/workers/api/commerce-migrations/${name}`, import.meta.url),
      'utf8',
    ));
  }
  database.exec(`CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  )`);
  const recordMigration = database.prepare('INSERT INTO d1_migrations (name) VALUES (?)');
  for (const name of appliedMigrations) {
    recordMigration.run(name);
  }
  if (!seedDocuments) return database;
  database.exec(`BEGIN IMMEDIATE;
    INSERT INTO commerce_authority_control_lease (
      singleton, lease_token, acquired_at_ms, expires_at_ms
    ) VALUES (
      1,
      '00000000-0000-4000-8000-000000000406',
      CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
    );
    UPDATE commerce_authority_control
    SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1 AND authority_state = 'paused' AND paused_at_ms IS NULL;
    UPDATE commerce_authority_control
    SET authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
      updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1 AND authority_state = 'paused';
    DELETE FROM commerce_authority_control_lease
    WHERE singleton = 1 AND lease_token = '00000000-0000-4000-8000-000000000406';
    COMMIT`);
  const insertDocument = database.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json,
    version, create_time, update_time, processed_at_seconds, processed_at_nanos
  ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
  database.exec('BEGIN IMMEDIATE');
  try {
    insertDocument.run(
      'claimCodes/HEALTHY',
      'claim_code',
      null,
      'HEALTHY',
      JSON.stringify({ status: 'unused' }),
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      null,
      null,
    );
    const ownerCharacters = '123456789ABCDEFG';
    for (let index = 0; index < 256; index += 1) {
      const owner = ownerCharacters[index % ownerCharacters.length].repeat(32);
      const deliveryStatus = index % 16 === 0
        ? 'ready_to_ship'
        : index % 16 === 1
          ? 'processing'
          : 'shipped';
      insertDocument.run(
        `drops/drop/deliveryOrders/${index}`,
        'delivery_order',
        'drop',
        String(index),
        JSON.stringify({
          owner,
          source: 'stripe_offchain',
          stripeCheckoutSessionId: `cs_live_${index}`,
          status: deliveryStatus,
          buyerOrderReceivedEmailState: index % 32 === 0 ? 'pending' : 'sent',
          shipperReadyToShipEmailState: index % 32 === 16 ? 'pending' : 'sent',
          fulfillmentStatus: index % 32 === 0 ? 'pending' : 'complete',
          packStatusProjectionState: index % 32 === 0 ? 'pending' : 'complete',
          packStatusProjectionNextAttemptAtMs: index,
        }),
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        index,
        0,
      );
      insertDocument.run(
        `drops/drop/stripeCheckouts/${index}`,
        'stripe_checkout',
        'drop',
        String(index),
        JSON.stringify({
          stripePaymentIntentId: `pi_${index}`,
          fulfillmentProcessor: 'cloudflare_queue_v1',
          status: index % 32 === 0 ? 'fulfillment_pending' : 'fulfilled',
          updatedAt: index,
          lastStripeWebhookEventId: `evt_${index}`,
          manualRefundReviewRequired: index % 32 === 0,
          stripeTerminalNotificationState: index % 32 === 1 ? 'pending' : 'queued',
          stripeTerminalNotificationNextAttemptAtMs: index,
        }),
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        null,
        null,
      );
    }
    database.exec(`UPDATE commerce_authority_control
      SET documents_revision = documents_revision + 1, updated_at_ms = updated_at_ms + 1
      WHERE singleton = 1`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return database;
}

function localQuery(database: DatabaseSync): CheckCommerceD1Query {
  return (sql) => database.prepare(sql).all().map((row) => ({ ...row }));
}

function seedInventory(database: DatabaseSync, ready = true) {
  database.exec(`INSERT INTO commerce_authority_control_lease (
      singleton, lease_token, acquired_at_ms, expires_at_ms
    ) VALUES (
      1, '00000000-0000-4000-8000-000000000407',
      CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
    );
    UPDATE commerce_authority_control
    SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1`);
  const configs = inventoryDropConfigs();
  const insert = database.prepare(`INSERT INTO commerce_inventory_drops (
    drop_id, generation, ready, drop_family, items_per_box, max_dude_id, initialized_at_ms
  ) VALUES (?, '00000000-0000-4000-8000-000000000408', 0, ?, ?, ?, 1000)`);
  for (const config of configs) {
    insert.run(config.dropId, config.dropFamily, config.itemsPerBox, config.maxDudeId);
  }
  database.prepare(`INSERT INTO commerce_available_dudes (drop_id, dude_id, pool_position)
    VALUES (?, 1, 0)`).run(configs[0].dropId);
  if (ready) database.exec('UPDATE commerce_inventory_drops SET ready = 1');
  return configs[0];
}

function prepareRecoveryState(database: DatabaseSync, activate = true): void {
  database.exec(`UPDATE commerce_delivery_recovery_control SET preparation_state = 'preparing',
    source_documents_revision = (SELECT documents_revision FROM commerce_authority_control)`);
  for (const source of localQuery(database)(`SELECT document_path, update_time, document_json -> '$.receiptRecovery' AS recovery
    FROM commerce_documents WHERE document_kind = 'delivery_order'`)) {
    const record = deliveryRecoveryRow(createDeliveryRecoveryRecord({
      parentPath: String(source.document_path), receiptRecoveryJson: source.recovery as string | null,
      generation: crypto.randomUUID(), nowMs: Date.parse(String(source.update_time)),
    }));
    database.prepare(`INSERT INTO commerce_delivery_recovery (${Object.keys(record).join(',')})
      VALUES (${Object.keys(record).map(() => '?').join(',')})`).run(...Object.values(record));
  }
  database.exec("UPDATE commerce_delivery_recovery_control SET preparation_state = 'ready', prepared_at_ms = 1");
  if (activate) database.exec("UPDATE commerce_delivery_recovery_control SET storage_mode = 'table'");
}

function preparedPackStatusDatabase(recoveryActive = true): DatabaseSync {
  const database = currentDatabase(false);
  seedInventory(database);
  database.exec(`UPDATE commerce_authority_control SET authority_state = 'd1',
    revision = revision + 1, paused_at_ms = NULL,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
    BEGIN IMMEDIATE`);
  database.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
  ) VALUES ('drops/card_nft_2/deliveryOrders/1', 'delivery_order', 'card_nft_2', '1', ?,
    1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(JSON.stringify({
    deliveryId: 1, dropId: 'card_nft_2', status: 'ready_to_ship', items: [{ kind: 'box' }],
    packStatusProjectionState: 'pending', packStatusProjectionNextAttemptAtMs: 17,
    packStatusProjectionFailureCount: 2, packStatusProjectionLastErrorCode: 'unavailable',
  }));
  database.exec(`UPDATE commerce_authority_control SET documents_revision = documents_revision + 1,
    updated_at_ms = updated_at_ms + 1; COMMIT;
    UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
    UPDATE commerce_authority_control SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
    UPDATE commerce_authority_control SET dude_inventory_mode = 'rows';
    UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing', source_documents_revision = 1;
    UPDATE commerce_notification_outbox_control SET preparation_state = 'ready', prepared_at_ms = 1;
    UPDATE commerce_notification_outbox_control SET storage_mode = 'table';
    UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'preparing', source_documents_revision = 1;
    UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'ready', prepared_at_ms = 1;
    UPDATE commerce_stripe_checkout_state_control SET storage_mode = 'table';
    UPDATE commerce_pack_status_outbox_control SET preparation_state = 'preparing', source_documents_revision = 1`);
  const document = parseCommerceD1DocumentRow(localQuery(database)('SELECT * FROM commerce_documents')[0]);
  const row = packStatusOutboxRow(planPackStatusOutboxBackfill(document)!);
  database.prepare(`INSERT INTO commerce_pack_status_outbox (${Object.keys(row).join(', ')})
    VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
  database.exec("UPDATE commerce_pack_status_outbox_control SET preparation_state = 'ready', prepared_at_ms = 1");
  if (recoveryActive) prepareRecoveryState(database);
  return database;
}

test('Commerce D1 checker accepts the current schema using complete production queries', () => {
  const database = currentDatabase();
  try {
    const queries: string[] = [];
    const query = localQuery(database);
    assert.deepEqual(checkCommerceD1((sql) => {
      queries.push(sql);
      return query(sql);
    }), {
      authorityState: 'd1',
      authorityRevision: 3,
      inventoryMode: 'legacy',
      notificationOutboxMode: 'legacy',
      notificationOutboxPreparation: 'idle',
      notificationOutboxGroups: 0,
      notificationOutboxFailures: [],
      stripeCheckoutStateMode: 'legacy',
      stripeCheckoutStatePreparation: 'idle',
      stripeCheckoutStateRows: 0,
      packStatusOutboxMode: 'legacy',
      packStatusOutboxPreparation: 'idle',
      packStatusOutboxRows: 0,
      deliveryRecoveryStateMode: 'legacy',
      deliveryRecoveryStatePreparation: 'idle',
      deliveryRecoveryStateRows: 0,
      inventoryDrops: 0,
      availableDudes: 0,
      authoritativeDocuments: 513,
      deliveryOwnerRevisions: 16,
      documentPathRevisions: 513,
      kindCounts: {
        claim_code: 1,
        delivery_order: 256,
        stripe_checkout: 256,
      },
    });
    const productionPlans = [
      deliveryOrderOwnersQuery({ limit: 501 }),
      deliveryOrderOwnersQuery({ limit: 501, startAfterOwner: '11111111111111111111111111111111' }),
      deliveryRecoveryStateQuery('11111111111111111111111111111111', 1, 1),
      shipmentHistoryPageQuery({ owner: '11111111111111111111111111111111', limit: 51 }),
      shipmentHistoryPageQuery({ owner: '11111111111111111111111111111111', limit: 51,
        startAfter: { version: 1, owner: '11111111111111111111111111111111', sortAtMs: 1,
          documentPath: 'drops/drop/deliveryOrders/1' } }),
      shipmentPresenceQuery({ owner: '11111111111111111111111111111111', stripeSessionIds: ['cs_cursor'] }),
      shipmentPresenceQuery({ owner: '11111111111111111111111111111111', documentPaths: ['drops/drop/deliveryOrders/1'] }),
      shipmentPresenceQuery({ owner: '11111111111111111111111111111111', stripeSessionIds: ['cs_cursor'],
        documentPaths: ['drops/drop/deliveryOrders/1'] }),
      manualReviewCheckoutsQuery({ dropId: 'drop', limit: 26 }),
      manualReviewCheckoutsQuery({
        dropId: 'drop', limit: 26,
        startAfter: {
          version: 1, dropId: 'drop', sortAtMs: 1, sessionId: 'cs_cursor',
          documentPath: 'drops/drop/stripeCheckouts/cs_cursor',
        },
      }),
      fulfillmentOrdersQuery({ dropId: 'drop', limit: 1001 }),
      fulfillmentOrdersQuery({
        dropId: 'drop',
        limit: 1001,
        startAfter: {
          processedAt: { seconds: 1, nanos: 1 },
          documentPath: 'drops/drop/deliveryOrders/1',
        },
      }),
      pendingReadyNotificationsQuery({ limit: 8, owner: 'owner', startAfterPath: 'drops/a/deliveryOrders/1' }),
      pendingReadyNotificationsQuery({ limit: 8, startAfterPath: 'drops/a/deliveryOrders/1' }),
      packStatusOutboxDueQuery({ dropId: 'drop', dueAtMs: 1, limit: 4 }),
      staleStripeFulfillmentsQuery(1),
      dueReadyNotificationsQuery({ dueAtMs: 1, limit: 8 }),
      dueStripeTerminalNotificationsQuery({ dueAtMs: 1, limit: 20 }),
      stripeChargebackLinkedSessionsQuery('pi_check'),
      stripeChargebackMatchedDocumentsQuery('cs_live_check'),
      adminIrlRedeemWorkflowStatusQuery(`airf-v1-${'0'.repeat(64)}`),
    ];
    for (const productionQuery of productionPlans) {
      const expected = `EXPLAIN QUERY PLAN ${renderCommerceQuerySql(productionQuery)}`;
      assert.equal(queries.filter((sql) => sql === expected).length, 1, expected);
    }
    assert.equal(queries.filter((sql) => sql.startsWith('EXPLAIN QUERY PLAN')).length, productionPlans.length + 6);
    const smokeQuery = renderCommerceQuerySql(deliveryOrderOwnersQuery({ limit: 1 }));
    assert.equal(queries.filter((sql) => sql === smokeQuery).length, 1);
    assert.equal(queries.filter((sql) => /\bFROM sqlite_(?:schema|master)\b/i.test(sql)).length, 1);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker reads one schema catalog for each supported migration baseline', () => {
  for (const migrationCount of [13, 25, 28, 29, 30, 31] as const) {
    const database = currentDatabase(false, migrationCount);
    try {
      let catalogReads = 0;
      const query = localQuery(database);
      checkCommerceD1((sql) => {
        if (/\bFROM sqlite_(?:schema|master)\b/i.test(sql)) catalogReads += 1;
        return query(sql);
      });
      assert.equal(catalogReads, 1, `migration ${migrationCount}`);
    } finally {
      database.close();
    }
  }
});

test('Commerce D1 checker preserves missing, wrong-type, and duplicate schema object failures', () => {
  const database = currentDatabase(false);
  try {
    const query = localQuery(database);
    for (const corruption of ['missing', 'wrong-type', 'duplicate'] as const) {
      assert.throws(() => checkCommerceD1((sql) => {
        const rows = query(sql);
        if (!/\bFROM sqlite_schema\b/i.test(sql)) return rows;
        const object = rows.find((row) => row.name === 'commerce_preorder_orders')!;
        if (corruption === 'missing') return rows.filter((row) => row !== object);
        if (corruption === 'wrong-type') return rows.map((row) => row === object ? { ...row, type: 'index' } : row);
        return [...rows, { ...object }];
      }), /Commerce D1 preorder schema commerce_preorder_orders is invalid/);
    }
  } finally {
    database.close();
  }
});

test('Commerce D1 checker propagates catalog query failures without retrying individual reads', () => {
  const database = currentDatabase(false);
  try {
    const failure = new Error('catalog unavailable');
    let catalogReads = 0;
    const query = localQuery(database);
    assert.throws(() => checkCommerceD1((sql) => {
      if (/\bFROM sqlite_(?:schema|master)\b/i.test(sql)) {
        catalogReads += 1;
        throw failure;
      }
      return query(sql);
    }), (error) => error === failure);
    assert.equal(catalogReads, 1);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker reloads its schema catalog between invocations', () => {
  const database = currentDatabase(false);
  try {
    let catalogReads = 0;
    const query: CheckCommerceD1Query = (sql) => {
      if (/\bFROM sqlite_(?:schema|master)\b/i.test(sql)) catalogReads += 1;
      return localQuery(database)(sql);
    };
    checkCommerceD1(query);
    database.exec('DROP INDEX commerce_preorder_succeeded_buyer');
    assert.throws(() => checkCommerceD1(query), /Commerce D1 preorder buyer index is invalid/);
    assert.equal(catalogReads, 2);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker keeps schema loading behind integrity and deployment preconditions', () => {
  const database = currentDatabase(false, 13);
  try {
    let catalogReads = 0;
    const query: CheckCommerceD1Query = (sql) => {
      if (/\bFROM sqlite_(?:schema|master)\b/i.test(sql)) catalogReads += 1;
      return localQuery(database)(sql);
    };
    assert.throws(() => checkCommerceD1((sql) => sql === 'PRAGMA quick_check'
      ? [{ quick_check: 'invalid' }] : query(sql)), /Commerce D1 quick check failed/);
    assert.throws(() => checkCommerceD1(query, { forDeployment: true }), /pagination migration is required/);
    database.exec("UPDATE d1_migrations SET name = 'unexpected.sql' WHERE id = 1");
    assert.throws(() => checkCommerceD1(query), /schema baseline is invalid/);
    assert.equal(catalogReads, 0);
  } finally {
    database.close();
  }
});

test('Commerce D1 schema catalog preserves SQLite trigger inventory matching', () => {
  const database = currentDatabase(false);
  try {
    database.exec(`CREATE TRIGGER COMMERCEaunexpected BEFORE INSERT ON commerce_documents
      BEGIN SELECT 1; END`);
    assert.throws(() => checkCommerceD1(localQuery(database)), /Commerce D1 trigger inventory is invalid/);
  } finally {
    database.close();
  }
});

test('pack-status outbox migration is required for deployment while legacy inspection keeps its production query', () => {
  const database = currentDatabase(false, 28);
  try {
    const queries: string[] = [];
    const query = localQuery(database);
    const report = checkCommerceD1((sql) => { queries.push(sql); return query(sql); });
    assert.equal(report.packStatusOutboxMode, undefined);
    assert.ok(queries.includes(`EXPLAIN QUERY PLAN ${renderCommerceQuerySql(
      legacyPackStatusProjectionsQuery({ dropId: 'drop', dueAtMs: 1, limit: 4 }),
    )}`));
    assert.throws(() => checkCommerceD1(query, { forDeployment: true }), /pack-status outbox migration is required/);
  } finally {
    database.close();
  }
});

test('pack-status outbox schema checks reject missing and weakened indexes and write guards', () => {
  for (const [type, name] of [
    ['INDEX', 'commerce_pack_status_outbox_due'],
    ['TRIGGER', 'commerce_pack_status_outbox_update_guard'],
    ['TRIGGER', 'commerce_pack_status_legacy_update_fence'],
    ['TRIGGER', 'commerce_pack_status_control_update_guard'],
  ]) {
    const database = currentDatabase(false);
    try {
      database.exec(`DROP ${type} ${name}`);
      const error = new RegExp(`Pack-status outbox schema is invalid: ${name}`);
      assert.throws(() => checkCommerceD1(localQuery(database)), error);
      database.exec(type === 'INDEX'
        ? `CREATE INDEX ${name} ON commerce_pack_status_outbox (parent_path)`
        : `CREATE TRIGGER ${name} BEFORE UPDATE ON commerce_pack_status_outbox BEGIN SELECT 1; END`);
      assert.throws(() => checkCommerceD1(localQuery(database)), error);
    } finally {
      database.close();
    }
  }
});

test('pack-status outbox deployment accepts exact paused preparation and authoritative state after activation', () => {
  const database = preparedPackStatusDatabase();
  try {
    const query = localQuery(database);
    const prepared = checkCommerceD1(query, { forDeployment: true });
    assert.equal(prepared.packStatusOutboxMode, 'legacy');
    assert.equal(prepared.packStatusOutboxPreparation, 'ready');
    assert.equal(prepared.packStatusOutboxRows, 1);
    database.exec(`UPDATE commerce_pack_status_outbox_control SET storage_mode = 'table';
      UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
      UPDATE commerce_pack_status_outbox SET state = 'completed', next_attempt_at_ms = NULL,
        completed_at_ms = updated_at_ms + 1, updated_at_ms = updated_at_ms + 1, revision = revision + 1`);
    assert.equal(checkCommerceD1(query, { forDeployment: true }).packStatusOutboxMode, 'table');
    assert.equal(JSON.parse(String(query('SELECT document_json FROM commerce_documents')[0].document_json))
      .packStatusProjectionState, 'pending');
  } finally {
    database.close();
  }
});

test('active pack-status checks reject lost migrated obligations and allow unmarked historical parents', () => {
  const database = preparedPackStatusDatabase();
  try {
    database.exec(`UPDATE commerce_pack_status_outbox_control SET storage_mode = 'table';
      DELETE FROM commerce_pack_status_outbox`);
    const query = localQuery(database);
    const expectedError = /Pack-status outbox is missing for source document: drops\/card_nft_2\/deliveryOrders\/1/;
    assert.throws(() => checkCommerceD1(query), expectedError);
    const unmarked = { deliveryId: 1, dropId: 'card_nft_2', status: 'ready_to_ship', items: [{ kind: 'box' }] };
    const withFields = (fields: Record<string, unknown>): CheckCommerceD1Query => (sql) => query(sql).map((row) =>
      sql.includes('FROM commerce_documents ORDER BY document_path')
        ? { ...row, document_json: JSON.stringify({ ...unmarked, ...fields }) } : row);
    for (const field of [
      'packStatusProjectionState', 'packStatusProjectionNextAttemptAtMs', 'packStatusProjectionFailureCount',
      'packStatusProjectionCompletedAt', 'packStatusProjectionFailedAt', 'packStatusProjectionLastErrorCode',
    ]) {
      assert.throws(() => checkCommerceD1(withFields({ [field]: null })), expectedError);
    }
    assert.equal(checkCommerceD1(withFields({})).packStatusOutboxRows, 0);
  } finally {
    database.close();
  }
});

test('pack-status outbox checker rejects missing rows, changed preparation, and stale source revisions', () => {
  const database = preparedPackStatusDatabase();
  try {
    const query = localQuery(database);
    for (const corruption of ['missing', 'failure-count', 'generation', 'stale-revision'] as const) {
      assert.throws(() => checkCommerceD1((sql) => {
        const rows = query(sql);
        if (sql === 'SELECT * FROM commerce_pack_status_outbox_control' && corruption === 'stale-revision') {
          return rows.map((row) => ({ ...row, source_documents_revision: 0 }));
        }
        if (sql !== 'SELECT * FROM commerce_pack_status_outbox ORDER BY parent_path') return rows;
        if (corruption === 'missing') return [];
        if (corruption === 'failure-count') return rows.map((row) => ({ ...row, failure_count: 3 }));
        if (corruption === 'generation') return rows.map((row) => ({ ...row, generation: '00000000-0000-4000-8000-000000000999' }));
        return rows;
      }), /Pack-status outbox preparation differs from source documents/);
    }
  } finally {
    database.close();
  }
});

test('pack-status outbox checker rejects invalid controls, orphan rows, and malformed retry state', () => {
  const database = preparedPackStatusDatabase();
  try {
    const query = localQuery(database);
    for (const changes of [
      { storage_mode: 'unknown' }, { storage_mode: 'table', preparation_state: 'idle' },
      { source_documents_revision: null }, { prepared_at_ms: null }, { singleton: 2 },
    ]) {
      assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) =>
        sql === 'SELECT * FROM commerce_pack_status_outbox_control' ? { ...row, ...changes } : row)),
      /Pack-status outbox control is invalid/);
    }
    assert.throws(() => checkCommerceD1((sql) => sql === 'SELECT * FROM commerce_pack_status_outbox_control'
      ? [] : query(sql)), /Pack-status outbox control is invalid/);
    assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) =>
      sql === 'SELECT * FROM commerce_pack_status_outbox ORDER BY parent_path'
        ? { ...row, parent_path: 'drops/card_nft_2/deliveryOrders/999' } : row)),
    /Pack-status outbox parent identity is invalid/);
    assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) =>
      sql === 'SELECT * FROM commerce_pack_status_outbox ORDER BY parent_path'
        ? { ...row, next_attempt_at_ms: null } : row)), /Invalid pack-status outbox/);
  } finally {
    database.close();
  }
});

test('pack-status outbox deployment rejects unready preparation and preparation without a drained pause', () => {
  const database = preparedPackStatusDatabase();
  try {
    const query = localQuery(database);
    for (const state of ['idle', 'preparing']) {
      assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) =>
        sql === 'SELECT * FROM commerce_pack_status_outbox_control'
          ? { ...row, preparation_state: state } : row), { forDeployment: true }),
      /requires activated pack-status outbox storage or fully paused, verified preparation/);
    }
    for (const changes of [{ paused_at_ms: null }, { authority_state: 'd1', paused_at_ms: null }]) {
      assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) =>
        sql === 'SELECT * FROM commerce_authority_control' ? { ...row, ...changes } : row), { forDeployment: true }),
      /requires activated pack-status outbox storage or fully paused, verified preparation/);
    }
  } finally {
    database.close();
  }
});

test('pack-status outbox query plan must search by drop and due time without a temporary sort', () => {
  const database = currentDatabase(false);
  try {
    const query = localQuery(database);
    const sql = `EXPLAIN QUERY PLAN ${renderCommerceQuerySql(packStatusOutboxDueQuery({
      dropId: 'drop', dueAtMs: 1, limit: 4,
    }))}`;
    for (const plan of [
      [{ detail: 'SCAN commerce_pack_status_outbox USING INDEX commerce_pack_status_outbox_due' }],
      [{ detail: 'SEARCH commerce_pack_status_outbox USING INDEX commerce_pack_status_outbox_due (drop_id=?)' }],
      [...query(sql), { detail: 'USE TEMP B-TREE FOR ORDER BY' }],
    ]) {
      assert.throws(() => checkCommerceD1((requested) => requested === sql ? plan : query(requested)),
        /does not search commerce_pack_status_outbox_due|does not seek the full drop-due prefix|uses a temporary B-tree/);
    }
  } finally {
    database.close();
  }
});

test('Commerce D1 checker validates chargeback history independently of commerce documents', () => {
  const database = currentDatabase(false);
  try {
    database.prepare(`INSERT INTO stripe_order_disputes VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, 'cs_live_history', 'du_history', 'retired_drop', 'ch_history', 'pi_history', 1, 2);
    assert.doesNotThrow(() => checkCommerceD1(localQuery(database)));
    database.exec('DROP INDEX stripe_order_disputes_drop_session');
    assert.throws(() => checkCommerceD1(localQuery(database)), /chargeback history schema is invalid/);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects chargeback history with mismatched Stripe mode', () => {
  const database = currentDatabase(false);
  try {
    database.prepare(`INSERT INTO stripe_order_disputes VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, 'cs_test_history', 'du_history', 'drop', 'ch_history', 'pi_history', 1, 2);
    assert.throws(() => checkCommerceD1(localQuery(database)), /chargeback history identity is invalid/);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker accepts the exact empty post-migration state', () => {
  const database = currentDatabase(false);
  try {
    assert.deepEqual(checkCommerceD1(localQuery(database)), {
      authorityState: 'paused',
      authorityRevision: 2,
      inventoryMode: 'legacy',
      notificationOutboxMode: 'legacy',
      notificationOutboxPreparation: 'idle',
      notificationOutboxGroups: 0,
      notificationOutboxFailures: [],
      stripeCheckoutStateMode: 'legacy',
      stripeCheckoutStatePreparation: 'idle',
      stripeCheckoutStateRows: 0,
      packStatusOutboxMode: 'legacy',
      packStatusOutboxPreparation: 'idle',
      packStatusOutboxRows: 0,
      deliveryRecoveryStateMode: 'legacy',
      deliveryRecoveryStatePreparation: 'idle',
      deliveryRecoveryStateRows: 0,
      inventoryDrops: 0,
      availableDudes: 0,
      authoritativeDocuments: 0,
      deliveryOwnerRevisions: 0,
      documentPathRevisions: 0,
      kindCounts: {},
    });
  } finally {
    database.close();
  }
});

test('Commerce D1 checker still accepts migration 0013 during notification cutover', () => {
  const database = currentDatabase(true, 13);
  try {
    assert.equal(checkCommerceD1(localQuery(database)).notificationOutboxMode, 'legacy');
  } finally {
    database.close();
  }
});

test('Commerce D1 checker accepts migration 0014 for inspection but requires pagination before deployment', () => {
  const database = currentDatabase(true, 14);
  try {
    assert.doesNotThrow(() => checkCommerceD1(localQuery(database)));
    assert.throws(() => checkCommerceD1(localQuery(database), { forDeployment: true }),
      /manual-review pagination migration is required/);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects a weakened manual-review cursor index', () => {
  const database = currentDatabase(false);
  try {
    database.exec(`DROP INDEX commerce_stripe_checkouts_manual_review_cursor;
      CREATE INDEX commerce_stripe_checkouts_manual_review_cursor ON commerce_documents (document_path)`);
    assert.throws(() => checkCommerceD1(localQuery(database)), /manual-review cursor index is invalid/);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker accepts migration 0015 for inspection but requires shipment pagination before deployment', () => {
  const database = currentDatabase(true, 15);
  try {
    assert.doesNotThrow(() => checkCommerceD1(localQuery(database)));
    assert.throws(() => checkCommerceD1(localQuery(database), { forDeployment: true }),
      /shipment-history pagination migration is required/);
  } finally {
    database.close();
  }
});

test('receipt Workflow readiness checks retain indexed searches before any operations exist', () => {
  const database = currentDatabase();
  try {
    database.exec(`DELETE FROM sqlite_stat1 WHERE idx = 'commerce_receipt_claim_workflow_operation';
      INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('commerce_documents', 'commerce_receipt_claim_workflow_operation', '1000000 1000000');
      ANALYZE sqlite_schema;`);
    assert.doesNotThrow(() => checkCommerceD1(localQuery(database)));
  } finally { database.close(); }
});

test('Commerce D1 checker requires receipt claim Workflow migration for deployment', () => {
  const database = currentDatabase(true, 16);
  try {
    assert.doesNotThrow(() => checkCommerceD1(localQuery(database)));
    assert.throws(() => checkCommerceD1(localQuery(database), { forDeployment: true }),
      /receipt claim Workflow migration is required/);
  } finally {
    database.close();
  }
});

for (const index of ['commerce_receipt_claim_workflow_operation', 'commerce_receipt_claim_workflow_due']) {
  test(`Commerce D1 checker rejects a weakened ${index}`, () => {
    const database = currentDatabase(false);
    try {
      database.exec(`DROP INDEX ${index}; CREATE INDEX ${index} ON commerce_documents (document_path)`);
      assert.throws(() => checkCommerceD1(localQuery(database)), /receipt claim Workflow index .* is invalid/);
    } finally {
      database.close();
    }
  });
}

for (const index of ['commerce_delivery_orders_shipment_cursor', 'commerce_delivery_orders_shipment_session']) {
  test(`Commerce D1 checker rejects a weakened ${index}`, () => {
    const database = currentDatabase(false);
    try {
      database.exec(`DROP INDEX ${index}; CREATE INDEX ${index} ON commerce_documents (document_path)`);
      assert.throws(() => checkCommerceD1(localQuery(database)), /shipment-history index .* is invalid/);
    } finally {
      database.close();
    }
  });
}

test('Commerce D1 checker rejects shipment scans, partial cursor seeks, and temporary sorts', () => {
  const database = currentDatabase();
  try {
    const query = localQuery(database);
    const owner = '11111111111111111111111111111111';
    const sql = `EXPLAIN QUERY PLAN ${renderCommerceQuerySql(shipmentHistoryPageQuery({ owner, limit: 51,
      startAfter: { version: 1, owner, sortAtMs: 1, documentPath: 'drops/drop/deliveryOrders/1' } }))}`;
    const plan = query(sql);
    for (const replacement of [
      [{ detail: 'SCAN commerce_documents USING INDEX commerce_delivery_orders_shipment_cursor' }],
      [{ detail: 'SEARCH commerce_documents USING INDEX commerce_delivery_orders_shipment_cursor (owner=?)' }],
      [...plan, { detail: 'USE TEMP B-TREE FOR ORDER BY' }],
    ]) {
      assert.throws(() => checkCommerceD1((requestedSql) => requestedSql === sql ? replacement : query(requestedSql)),
        /does not search commerce_delivery_orders_shipment_cursor|does not seek the full cursor|uses a temporary B-tree/);
    }
    const presenceSql = `EXPLAIN QUERY PLAN ${renderCommerceQuerySql(shipmentPresenceQuery({ owner, stripeSessionIds: ['cs_cursor'] }))}`;
    assert.throws(() => checkCommerceD1((requestedSql) => requestedSql === presenceSql
      ? [{ detail: 'SEARCH commerce_documents USING INDEX commerce_delivery_orders_shipment_session (owner=?)' }]
      : query(requestedSql)), /does not search by owner and Stripe session/);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects fulfillment scans, partial cursor seeks, and temporary sorts', () => {
  const database = currentDatabase();
  try {
    const query = localQuery(database);
    for (const startAfter of [undefined, {
      processedAt: { seconds: 1, nanos: 1 },
      documentPath: 'drops/drop/deliveryOrders/1',
    }]) {
      const sql = `EXPLAIN QUERY PLAN ${renderCommerceQuerySql(fulfillmentOrdersQuery({
        dropId: 'drop', limit: 1001, startAfter,
      }))}`;
      const plan = query(sql);
      const searches = plan.filter((row) => String(row.detail).startsWith(
        'SEARCH commerce_documents USING INDEX commerce_documents_drop_processed_cursor ',
      ));
      assert.equal(searches.length, startAfter ? 2 : 1);
      const replacements = [
        [...plan, { detail: 'USE TEMP B-TREE FOR ORDER BY' }],
        ...searches.map((search) => plan.map((row) => row === search
          ? { ...row, detail: String(row.detail).replace(/^SEARCH /, 'SCAN ') } : row)),
        ...(startAfter ? searches.map((search) => plan.map((row) => row === search
          ? { ...row, detail: 'SEARCH commerce_documents USING INDEX commerce_documents_drop_processed_cursor (document_kind=? AND drop_id=? AND status=?)' }
          : row)) : []),
      ];
      for (const replacement of replacements) {
        assert.throws(() => checkCommerceD1((requestedSql) => requestedSql === sql ? replacement : query(requestedSql)),
          /does not search commerce_documents_drop_processed_cursor|does not seek the full cursor|does not search the null-timestamp tail|uses a temporary B-tree/);
      }
    }
  } finally {
    database.close();
  }
});

for (const index of [
  'commerce_delivery_orders_buyer_notifications_pending',
  'commerce_delivery_orders_shipper_notifications_pending',
  'commerce_delivery_orders_buyer_notifications_pending_owner_path',
  'commerce_delivery_orders_shipper_notifications_pending_owner_path',
  'commerce_ready_notifications_due',
  'commerce_stripe_terminal_notifications_due',
]) {
  test(`Commerce D1 checker rejects retired index ${index} after migration 0014`, () => {
    const database = currentDatabase(false);
    try {
      database.exec(`CREATE INDEX ${index} ON commerce_documents (document_path)`);
      assert.throws(() => checkCommerceD1(localQuery(database)), /notification index(?:es)? (?:are|is) invalid/);
    } finally {
      database.close();
    }
  });
}

for (const mutation of [
  "UPDATE d1_migrations SET name = '0014_unexpected.sql' WHERE id = 14",
  'DELETE FROM d1_migrations WHERE id = 4',
  "INSERT INTO d1_migrations (name) VALUES ('0015_unexpected.sql')",
]) {
  test(`Commerce D1 checker rejects migration history mutation: ${mutation}`, () => {
    const database = currentDatabase(false);
    try {
      database.exec(mutation);
      assert.throws(() => checkCommerceD1(localQuery(database)), /schema baseline is invalid/);
    } finally {
      database.close();
    }
  });
}

test('API deployment rejects active legacy inventory while standalone inspection succeeds', () => {
  const database = currentDatabase();
  try {
    const query = localQuery(database);
    assert.equal(checkCommerceD1(query).inventoryMode, 'legacy');
    assert.throws(() => checkCommerceD1(query, { forDeployment: true }), /requires activated figure inventory/);
  } finally {
    database.close();
  }
});

test('API deployment requires activation even after inventory preparation and accepts ready rows mode', () => {
  const database = currentDatabase(false);
  try {
    seedInventory(database);
    const query = localQuery(database);
    assert.equal(checkCommerceD1(query).inventoryMode, 'legacy');
    assert.throws(() => checkCommerceD1(query, { forDeployment: true }), /requires activated figure inventory/);
    database.exec('DELETE FROM commerce_available_dudes');
    database.exec("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1");
    assert.throws(() => checkCommerceD1(query, { forDeployment: true }), /requires activated notification outbox/);
    database.exec(`UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing', source_documents_revision = 0;
      UPDATE commerce_notification_outbox_control SET preparation_state = 'ready', prepared_at_ms = 0;
      UPDATE commerce_notification_outbox_control SET storage_mode = 'table'`);
    assert.throws(() => checkCommerceD1(query, { forDeployment: true }), /requires activated Stripe checkout state/);
    database.exec(`UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'preparing', source_documents_revision = 0;
      UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'ready', prepared_at_ms = 0;
      UPDATE commerce_stripe_checkout_state_control SET storage_mode = 'table'`);
    assert.throws(() => checkCommerceD1(query, { forDeployment: true }), /requires activated pack-status outbox/);
    database.exec(`UPDATE commerce_pack_status_outbox_control SET preparation_state = 'preparing', source_documents_revision = 0;
      UPDATE commerce_pack_status_outbox_control SET preparation_state = 'ready', prepared_at_ms = 0;
      UPDATE commerce_pack_status_outbox_control SET storage_mode = 'table'`);
    assert.throws(() => checkCommerceD1(query, { forDeployment: true }), /requires activated delivery recovery state/);
    prepareRecoveryState(database);
    assert.equal(checkCommerceD1(query, { forDeployment: true }).inventoryMode, 'rows');
    assert.equal(checkCommerceD1(query, { forDeployment: true }).availableDudes, 0);
    database.exec(`UPDATE commerce_authority_control
      SET authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
        updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE singleton = 1`);
    assert.equal(checkCommerceD1(query, { forDeployment: true }).authorityState, 'd1');
  } finally {
    database.close();
  }
});

test('Commerce D1 checker accepts staged legacy inventory and ready native inventory', () => {
  const database = currentDatabase(false);
  try {
    seedInventory(database, false);
    const staged = checkCommerceD1(localQuery(database));
    assert.equal(staged.inventoryMode, 'legacy');
    assert.equal(staged.inventoryDrops, inventoryDropConfigs().length);
    assert.equal(staged.availableDudes, 1);
    database.exec(`UPDATE commerce_inventory_drops SET ready = 1;
      UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1`);
    const ready = checkCommerceD1(localQuery(database));
    assert.equal(ready.inventoryMode, 'rows');
    assert.equal(ready.inventoryDrops, inventoryDropConfigs().length);
    assert.equal(ready.availableDudes, 1);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects native mode with missing or unready inventory', () => {
  const database = currentDatabase(false);
  try {
    const config = seedInventory(database);
    database.exec("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1");
    const updateGuard = String(database.prepare(`SELECT sql FROM sqlite_schema
      WHERE name = 'commerce_inventory_drop_update_guard'`).get()!.sql);
    database.exec('DROP TRIGGER commerce_inventory_drop_update_guard');
    database.prepare('UPDATE commerce_inventory_drops SET ready = 0 WHERE drop_id = ?').run(config.dropId);
    database.exec(updateGuard);
    assert.throws(() => checkCommerceD1(localQuery(database)), /inventory initialization is incomplete/);
    assert.throws(() => checkCommerceD1(localQuery(database), { forDeployment: true }), /inventory initialization is incomplete/);
    database.prepare('DELETE FROM commerce_inventory_drops WHERE drop_id = ?').run(config.dropId);
    assert.throws(() => checkCommerceD1(localQuery(database)), /inventory initialization is incomplete/);
    assert.throws(() => checkCommerceD1(localQuery(database), { forDeployment: true }), /inventory initialization is incomplete/);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects inventory configuration drift', () => {
  const database = currentDatabase(false);
  try {
    const config = seedInventory(database);
    const updateGuard = String(database.prepare(`SELECT sql FROM sqlite_schema
      WHERE name = 'commerce_inventory_drop_update_guard'`).get()!.sql);
    database.exec('DROP TRIGGER commerce_inventory_drop_update_guard');
    database.prepare("UPDATE commerce_inventory_drops SET drop_family = 'wrong-family' WHERE drop_id = ?")
      .run(config.dropId);
    database.exec(updateGuard);
    assert.throws(() => checkCommerceD1(localQuery(database)), /inventory state is invalid/);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects figures that are both available and assigned', () => {
  const database = currentDatabase(false);
  try {
    const config = seedInventory(database);
    database.exec(`UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1;
      UPDATE commerce_authority_control
      SET authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
        updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE singleton = 1;
      BEGIN IMMEDIATE`);
    database.prepare(`INSERT INTO commerce_documents (
      document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
    ) VALUES (?, 'dude_assignment', ?, '1', ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
      .run(`drops/${config.dropId}/dudeAssignments/1`, config.dropId, JSON.stringify({
        dudeId: 1,
        boxAssetId: 'box',
        inventoryGeneration: '00000000-0000-4000-8000-000000000408',
      }));
    database.exec(`UPDATE commerce_authority_control SET documents_revision = documents_revision + 1,
      updated_at_ms = updated_at_ms + 1 WHERE singleton = 1; COMMIT`);
    const insertGuard = String(database.prepare(`SELECT sql FROM sqlite_schema
      WHERE name = 'commerce_available_dude_insert_guard'`).get()!.sql);
    database.exec('DROP TRIGGER commerce_available_dude_insert_guard');
    database.prepare('INSERT INTO commerce_available_dudes (drop_id, dude_id, pool_position) VALUES (?, 1, 0)')
      .run(config.dropId);
    database.exec(insertGuard);
    assert.throws(() => checkCommerceD1(localQuery(database)), /inventory state is invalid/);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects a weakened native inventory trigger', () => {
  const database = currentDatabase(false);
  try {
    database.exec(`DROP TRIGGER commerce_dude_pool_insert_fence;
      CREATE TRIGGER commerce_dude_pool_insert_fence BEFORE INSERT ON commerce_documents
      BEGIN SELECT 1; END`);
    assert.throws(() => checkCommerceD1(localQuery(database)), /inventory trigger schema is invalid/);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker accepts the Workflow index after upgrading with existing statistics', () => {
  const database = currentDatabase();
  try {
    database.exec(`DROP INDEX commerce_admin_irl_redeem_workflow_operation;
      BEGIN IMMEDIATE;
      INSERT INTO commerce_documents (
        document_path, document_kind, drop_id, document_id, document_json,
        version, create_time, update_time
      ) VALUES (
        'drops/drop/adminIrlRedeemRequests/workflow', 'admin_irl_redeem_request', 'drop', 'workflow',
        '{"workflowFinalizeV1":{"operationId":"airf-v1-${'a'.repeat(64)}"}}',
        1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      UPDATE commerce_authority_control
      SET documents_revision = documents_revision + 1, updated_at_ms = updated_at_ms + 1
      WHERE singleton = 1;
      COMMIT;
      ANALYZE commerce_documents;`);

    database.exec(readFileSync(
      new URL('../cloud/workers/api/commerce-migrations/0008_admin_irl_redeem_workflow_operation.sql', import.meta.url),
      'utf8',
    ));

    assert.equal(checkCommerceD1(localQuery(database)).authoritativeDocuments, 514);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects a future document-path revision', () => {
  const database = currentDatabase();
  try {
    database.exec(`UPDATE commerce_document_path_revisions
      SET revision = revision + 1
      WHERE document_path = 'claimCodes/HEALTHY'`);
    assert.throws(
      () => checkCommerceD1(localQuery(database)),
      /Commerce D1 contains noncanonical schema or identity state/,
    );
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects a missing live document-path revision', () => {
  const database = currentDatabase();
  try {
    const deleteGuardSql = String(database.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'commerce_document_path_revision_delete_guard'`).get()!.sql);
    database.exec(`DROP TRIGGER commerce_document_path_revision_delete_guard;
      DELETE FROM commerce_document_path_revisions
      WHERE document_path = 'claimCodes/HEALTHY';
      ${deleteGuardSql}`);
    assert.throws(
      () => checkCommerceD1(localQuery(database)),
      /Commerce D1 contains noncanonical schema or identity state/,
    );
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects a malformed Stripe reconciliation index', () => {
  const database = currentDatabase();
  try {
    database.exec(`DROP INDEX commerce_stripe_checkouts_reconciliation_due;
      CREATE INDEX commerce_stripe_checkouts_reconciliation_due
      ON commerce_documents (document_path)`);
    assert.throws(
      () => checkCommerceD1(localQuery(database)),
      /Commerce D1 Stripe-reconciliation index is invalid/,
    );
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects a missing or malformed due ready-notification index', () => {
  const database = currentDatabase(true, 13);
  try {
    database.exec('DROP INDEX commerce_ready_notifications_due');
    assert.throws(
      () => checkCommerceD1(localQuery(database)),
      /Commerce D1 due ready-notification index is invalid/,
    );
    database.exec('CREATE INDEX commerce_ready_notifications_due ON commerce_documents (document_path)');
    assert.throws(
      () => checkCommerceD1(localQuery(database)),
      /Commerce D1 due ready-notification index is invalid/,
    );
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects due ready-notification scans and temporary sorts', () => {
  const database = currentDatabase();
  try {
    const query = localQuery(database);
    for (const details of [
      ['SCAN outbox USING INDEX commerce_notification_outbox_family_due'],
      ['SEARCH outbox USING INDEX commerce_notification_outbox_family_due (family=? AND next_attempt_at_ms<?)', 'USE TEMP B-TREE FOR ORDER BY'],
    ]) {
      assert.throws(() => checkCommerceD1((sql) => {
        if (sql.includes('EXPLAIN QUERY PLAN') && sql.includes('INDEXED BY commerce_notification_outbox_family_due') && sql.includes("outbox.family = 'ready'")) {
          return details.map((detail) => ({ detail }));
        }
        return query(sql);
      }), /does not search commerce_notification_outbox_family_due|due ready-notification query plan uses a temporary B-tree/);
    }
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects a malformed Stripe terminal-notification index', () => {
  const database = currentDatabase(true, 13);
  try {
    database.exec(`DROP INDEX commerce_stripe_terminal_notifications_due;
      CREATE INDEX commerce_stripe_terminal_notifications_due
      ON commerce_documents (document_path)`);
    assert.throws(
      () => checkCommerceD1(localQuery(database)),
      /Commerce D1 Stripe terminal-notification index is invalid/,
    );
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects missing, malformed, or unique Stripe identity indexes', () => {
  for (const name of [
    'commerce_documents_stripe_payment_intent',
    'commerce_stripe_checkouts_session_id',
    'commerce_stripe_delivery_orders_session_id',
  ]) {
    const database = currentDatabase(false);
    try {
      const originalSql = String(database.prepare(`SELECT sql FROM sqlite_schema WHERE name = ?`).get(name)!.sql);
      database.exec(`DROP INDEX ${name}`);
      const expectedError = new RegExp(`Commerce D1 Stripe identity index ${name} is invalid`);
      assert.throws(() => checkCommerceD1(localQuery(database)), expectedError);
      database.exec(`CREATE INDEX ${name} ON commerce_documents (document_kind, document_path)`);
      assert.throws(() => checkCommerceD1(localQuery(database)), expectedError);
      database.exec(`DROP INDEX ${name}`);
      database.exec(originalSql.replace('CREATE INDEX', 'CREATE UNIQUE INDEX'));
      assert.throws(() => checkCommerceD1(localQuery(database)), expectedError);
    } finally {
      database.close();
    }
  }
});

test('Commerce D1 checker rejects Stripe identity scans and kind-only searches', () => {
  const database = currentDatabase();
  try {
    const query = localQuery(database);
    for (const [productionQuery, expectedSearchCount] of [
      [stripeChargebackLinkedSessionsQuery('pi_check'), 1],
      [stripeChargebackMatchedDocumentsQuery('cs_live_check'), 2],
    ] as const) {
      const sql = `EXPLAIN QUERY PLAN ${renderCommerceQuerySql(productionQuery)}`;
      assert.doesNotMatch(sql, /INDEXED BY/i);
      const plan = query(sql);
      const identitySearches = plan.filter((row) =>
        /SEARCH .*commerce_(?:documents_stripe_payment_intent|stripe_(?:checkouts|delivery_orders)_session_id)/
          .test(String(row.detail)));
      assert.equal(identitySearches.length, expectedSearchCount);
      for (const search of identitySearches) {
        const detail = String(search.detail);
        for (const replacement of [
          'SCAN commerce_documents',
          detail.replace(/^SEARCH /, 'SCAN '),
          detail.replace(/\([^)]*\)$/, '(document_kind=?)'),
          detail.replace(/\([^)]*\)$/, '(source=?)'),
          'SEARCH commerce_documents USING INDEX commerce_documents_owner (document_kind=?)',
        ]) {
          assert.throws(() => checkCommerceD1((requestedSql) => {
            if (requestedSql !== sql) return query(requestedSql);
            return plan.map((row) => row === search ? { ...row, detail: replacement } : row);
          }), /does not search .* by Stripe identity/);
        }
      }
    }
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects a missing Admin IRL Workflow operation index', () => {
  const database = currentDatabase();
  try {
    database.exec('DROP INDEX commerce_admin_irl_redeem_workflow_operation');
    assert.throws(
      () => checkCommerceD1(localQuery(database)),
      /Commerce D1 Admin IRL Workflow operation index is invalid/,
    );
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects a malformed Admin IRL Workflow operation index', () => {
  const database = currentDatabase();
  try {
    database.exec(`DROP INDEX commerce_admin_irl_redeem_workflow_operation;
      CREATE INDEX commerce_admin_irl_redeem_workflow_operation
      ON commerce_documents (document_path)
      WHERE document_kind = 'admin_irl_redeem_request'`);
    assert.throws(
      () => checkCommerceD1(localQuery(database)),
      /Commerce D1 Admin IRL Workflow operation index is invalid/,
    );
  } finally {
    database.close();
  }
});

test('API deployment accepts a fully paused verified notification preparation before activation', () => {
  const database = currentDatabase(false);
  try {
    seedInventory(database);
    database.exec("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1");
    database.exec(`UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing', source_documents_revision = 0;
      UPDATE commerce_notification_outbox_control SET preparation_state = 'ready', prepared_at_ms = 1;
      UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'preparing', source_documents_revision = 0;
      UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'ready', prepared_at_ms = 1;
      UPDATE commerce_pack_status_outbox_control SET preparation_state = 'preparing', source_documents_revision = 0;
      UPDATE commerce_pack_status_outbox_control SET preparation_state = 'ready', prepared_at_ms = 1`);
    prepareRecoveryState(database, false);
    const result = checkCommerceD1(localQuery(database), { forDeployment: true });
    assert.equal(result.notificationOutboxMode, 'legacy');
    assert.equal(result.notificationOutboxPreparation, 'ready');
    database.exec('UPDATE commerce_notification_outbox_control SET preparation_state = \'preparing\', prepared_at_ms = NULL');
    assert.throws(() => checkCommerceD1(localQuery(database), { forDeployment: true }), /requires activated notification outbox/);
  } finally { database.close(); }
});

test('Commerce D1 checker rejects weakened notification fences and outbox indexes', () => {
  for (const name of ['commerce_notification_legacy_update_fence', 'commerce_notification_outbox_resume_guard', 'commerce_notification_outbox_family_due']) {
    const database = currentDatabase(false);
    try {
      const type = name.endsWith('_due') ? 'INDEX' : 'TRIGGER';
      database.exec(`DROP ${type} ${name}`);
      if (type === 'INDEX') database.exec(`CREATE INDEX ${name} ON commerce_notification_outbox (family)`);
      else database.exec(`CREATE TRIGGER ${name} BEFORE UPDATE ON commerce_documents BEGIN SELECT 1; END`);
      assert.throws(() => checkCommerceD1(localQuery(database)), /Notification outbox schema is invalid|no query solution/);
    } finally { database.close(); }
  }
});

test('Commerce D1 checker rejects missing or stale pending-owner lookup entries', () => {
  for (const corruption of ['missing', 'wrong-owner', 'terminal-row'] as const) {
    const database = currentDatabase();
    try {
      database.exec(`INSERT INTO commerce_authority_control_lease VALUES (
        1, '00000000-0000-4000-8000-000000000407',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000);
      UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
      UPDATE commerce_authority_control SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
      UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing';`);
      database.prepare(`INSERT INTO commerce_notification_outbox (
        parent_path, family, drop_id, generation, outcome, state, entries_json, revision,
        attempt_count, next_attempt_at_ms, claim_id, claim_expires_at_ms, retry_until_ms, created_at_ms, updated_at_ms, last_error_code
      ) VALUES ('drops/drop/deliveryOrders/16', 'ready', 'drop',
        '00000000-0000-4000-8000-000000000408', NULL, 'pending', ?, 1, 0, 0, NULL, NULL, 10000, 0, 0, NULL)`)
        .run(JSON.stringify([{ kind: 'buyer_order_received', jobId: '00000000-0000-4000-8000-000000000409',
          idempotencyKey: 'drop:16:order_received', state: 'pending' }]));
      assert.doesNotThrow(() => checkCommerceD1(localQuery(database)));
      if (corruption === 'missing') database.exec('DELETE FROM commerce_notification_outbox_pending_owners');
      else if (corruption === 'wrong-owner') database.exec("UPDATE commerce_notification_outbox_pending_owners SET owner = 'wrong-owner'");
      else {
        database.exec(`UPDATE commerce_notification_outbox SET state = 'queued', next_attempt_at_ms = NULL,
          entries_json = json_set(entries_json, '$[0].state', 'queued'), revision = revision + 1;
        INSERT INTO commerce_notification_outbox_pending_owners VALUES ('drops/drop/deliveryOrders/16', 'ready', 'stale-owner')`);
      }
      assert.throws(() => checkCommerceD1(localQuery(database)), /pending-owner lookup is inconsistent/);
    } finally { database.close(); }
  }
});

test('Commerce D1 checker rejects missing or stale Stripe due lookup entries', () => {
  for (const corruption of ['missing', 'wrong-due', 'terminal-row'] as const) {
    const database = currentDatabase();
    try {
      database.exec(`INSERT INTO commerce_authority_control_lease VALUES (
        1, '00000000-0000-4000-8000-000000000407',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000);
      UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
      UPDATE commerce_authority_control SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
      UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing';`);
      database.prepare(`INSERT INTO commerce_notification_outbox (
        parent_path, family, drop_id, generation, outcome, state, entries_json, revision,
        attempt_count, next_attempt_at_ms, claim_id, claim_expires_at_ms, retry_until_ms, created_at_ms, updated_at_ms, last_error_code
      ) VALUES ('drops/drop/stripeCheckouts/1', 'stripe_terminal', 'drop',
        '00000000-0000-4000-8000-000000000408', 'fulfilled', 'pending', ?, 1, 0, 0, NULL, NULL, 10000, 0, 0, NULL)`)
        .run(JSON.stringify([{ kind: 'buyer_order_received', jobId: '00000000-0000-4000-8000-000000000409',
          idempotencyKey: 'drop:1:order_received', state: 'pending' }]));
      assert.doesNotThrow(() => checkCommerceD1(localQuery(database)));
      if (corruption === 'missing') database.exec('DELETE FROM commerce_notification_outbox_stripe_due');
      else if (corruption === 'wrong-due') database.exec('UPDATE commerce_notification_outbox_stripe_due SET next_attempt_at_ms = 1');
      else {
        database.exec(`UPDATE commerce_notification_outbox SET state = 'queued', next_attempt_at_ms = NULL,
          entries_json = json_set(entries_json, '$[0].state', 'queued'), revision = revision + 1;
        INSERT INTO commerce_notification_outbox_stripe_due (parent_path, next_attempt_at_ms)
          VALUES ('drops/drop/stripeCheckouts/1', 0)`);
      }
      assert.throws(() => checkCommerceD1(localQuery(database)), /Stripe due lookup is inconsistent/);
    } finally { database.close(); }
  }
});

test('delivery recovery migration is required for deployment while previous schemas remain inspectable', () => {
  const database = currentDatabase(false, 29);
  try {
    assert.equal(checkCommerceD1(localQuery(database)).deliveryRecoveryStateMode, undefined);
    assert.throws(() => checkCommerceD1(localQuery(database), { forDeployment: true }), /delivery recovery migration/);
  } finally { database.close(); }
});

test('delivery recovery checker validates all fences and the altered commit and wipe guard schemas', () => {
  for (const name of [
    'commerce_delivery_recovery_control_update_guard', 'commerce_delivery_recovery_insert_guard',
    'commerce_delivery_recovery_update_guard', 'commerce_delivery_recovery_parent_update_guard',
    'commerce_delivery_recovery_parent_delete_guard', 'commerce_wipe_guard_delivery_recovery_validate',
    'commerce_commit_guard_delivery_recovery_validate', 'commerce_commit_guard_delivery_recovery_finish',
  ]) {
    const database = currentDatabase(false);
    try {
      database.exec(`DROP TRIGGER ${name}`);
      assert.throws(() => checkCommerceD1(localQuery(database)), new RegExp(`Delivery recovery state schema is invalid: ${name}`));
    } finally { database.close(); }
  }
  const database = currentDatabase(false);
  try {
    const query = localQuery(database);
    for (const name of ['commerce_commit_guards', 'commerce_wipe_guards', 'commerce_delivery_recovery']) {
      assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) => row.name === name && row.type === 'table'
        ? { ...row, sql: String(row.sql).replace('STRICT', '') } : row)), /Delivery recovery state schema is invalid/);
    }
  } finally { database.close(); }
});

test('delivery recovery deployment accepts verified paused preparation and rejects stale, missing, or corrupt rows', async () => {
  const database = preparedPackStatusDatabase(false);
  try {
    const query = localQuery(database);
    const revision = String(query('SELECT revision FROM commerce_authority_control')[0].revision);
    database.exec('DELETE FROM commerce_authority_control_lease');
    assert.throws(() => checkCommerceD1(query, { forDeployment: true }), /requires activated delivery recovery state/);
    await runDeliveryRecoveryStateControl(['prepare', '--write', '--expected-revision', revision], { query });
    const prepared = checkCommerceD1(query, { forDeployment: true });
    assert.equal(prepared.deliveryRecoveryStateMode, 'legacy');
    assert.equal(prepared.deliveryRecoveryStatePreparation, 'ready');
    assert.equal(prepared.deliveryRecoveryStateRows, 1);
    assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) => sql === 'SELECT * FROM commerce_delivery_recovery_control'
      ? { ...row, source_documents_revision: 0 } : row)), /preparation is stale/);
    assert.throws(() => checkCommerceD1((sql) => sql.startsWith('SELECT recovery.*,')
      ? [] : query(sql)), /differs from source/);
    await runDeliveryRecoveryStateControl(['activate', '--write', '--expected-revision', revision, '--worker-deployed'], { query });
    assert.equal(checkCommerceD1(query, { forDeployment: true }).deliveryRecoveryStateMode, 'table');
    assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) => sql.startsWith('SELECT recovery.*,')
      ? { ...row, parent_path: null } : row)), /state is missing/);
    for (const corruption of [{ revision: 0 }, { generation: 'broken' }, { prepared_delay_ms: 120000 }]) {
      assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) => sql.startsWith('SELECT recovery.*,')
        ? { ...row, ...corruption } : row)), /Invalid delivery recovery/);
    }
    assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) => sql.startsWith('SELECT recovery.*,')
      ? { ...row, parent_path: 'drops/card_nft_2/deliveryOrders/999' } : row)), /parent is invalid/);
    assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) => sql.startsWith('SELECT recovery.*,')
      ? { ...row, document_path: null, document_kind: null } : row)), /parent is invalid/);
    const updateGuard = String(query("SELECT sql FROM sqlite_schema WHERE name = 'commerce_delivery_recovery_update_guard'")[0].sql);
    database.exec(`DROP TRIGGER commerce_delivery_recovery_update_guard;
      UPDATE commerce_delivery_recovery SET prepared_delay_ms = 120000; ${updateGuard}`);
    assert.throws(() => checkCommerceD1(query), /Invalid delivery recovery projections/);
    database.exec(`DROP TRIGGER commerce_delivery_recovery_update_guard;
      UPDATE commerce_delivery_recovery SET prepared_delay_ms = 30000; ${updateGuard}`);
    const deleteGuard = String(query("SELECT sql FROM sqlite_schema WHERE name = 'commerce_delivery_recovery_delete_guard'")[0].sql);
    database.exec(`DROP TRIGGER commerce_delivery_recovery_delete_guard;
      DELETE FROM commerce_delivery_recovery; ${deleteGuard}`);
    assert.throws(() => checkCommerceD1(query), /state is missing/);
  } finally { database.close(); }
});

for (const change of ['creation', 'cleanup'] as const) {
  test(`delivery recovery checker accepts concurrent prepared delivery ${change}`, () => {
    const database = preparedPackStatusDatabase();
    try {
      database.exec(`UPDATE commerce_pack_status_outbox_control SET storage_mode = 'table';
        UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
          paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
        DELETE FROM commerce_authority_control_lease`);
      const parentPath = 'drops/card_nft_2/deliveryOrders/2';
      const recovery = createDeliveryRecoveryRecord({
        parentPath, receiptRecoveryJson: null, generation: '00000000-0000-4000-8000-000000000002', nowMs: 1_000,
      });
      const writeOrder = (remove: boolean) => {
        database.exec('BEGIN IMMEDIATE');
        database.prepare(`INSERT INTO commerce_commit_guards (
          guard_id, expectations_json, created_at_ms, delivery_recovery_paths_json, delivery_recovery_expectations_json
        ) VALUES ('concurrent-prepared', ?, 1000, ?, ?)`).run(
          JSON.stringify([{ path: parentPath, version: remove ? 1 : -1 }]),
          JSON.stringify([parentPath]),
          JSON.stringify([{ parentPath, generation: remove ? recovery.generation : null, revision: remove ? 1 : -1 }]),
        );
        if (remove) database.prepare('DELETE FROM commerce_documents WHERE document_path = ?').run(parentPath);
        else {
          database.prepare(`INSERT INTO commerce_documents (
            document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
          ) VALUES (?, 'delivery_order', 'card_nft_2', '2', '{"status":"prepared","createdAt":1000}', 1,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(parentPath);
          const row = deliveryRecoveryRow(recovery);
          database.prepare(`INSERT INTO commerce_delivery_recovery (${Object.keys(row).join(', ')})
            VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
        }
        database.exec(`UPDATE commerce_authority_control SET documents_revision = documents_revision + 1;
          DELETE FROM commerce_commit_guards WHERE guard_id = 'concurrent-prepared'; COMMIT`);
      };
      if (change === 'cleanup') writeOrder(false);
      const query = localQuery(database);
      assert.doesNotThrow(() => checkCommerceD1(query, { forDeployment: true }));
      let changed = false;
      const checked = checkCommerceD1((sql) => {
        const rows = query(sql);
        if (sql.startsWith('SELECT\n    document_path, document_kind, drop_id, document_id, document_json') && !changed) {
          changed = true;
          writeOrder(change === 'cleanup');
        }
        return rows;
      }, { forDeployment: true });
      assert.equal(changed, true);
      assert.equal(checked.deliveryRecoveryStateRows, change === 'creation' ? 2 : 1);
      assert.doesNotThrow(() => checkCommerceD1(query, { forDeployment: true }));
    } finally { database.close(); }
  });
}
