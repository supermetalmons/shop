import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  checkCommerceD1,
  type CheckCommerceD1Query,
} from '../scripts/ops/checkCommerceD1.ts';
import { inventoryDropConfigs } from '../scripts/shared/dudeInventoryMaintenance.ts';

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
] as const;

function currentDatabase(seedDocuments = true): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const name of migrationNames) {
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
  for (const name of migrationNames) {
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

test('Commerce D1 checker accepts the current in-memory schema', () => {
  const database = currentDatabase();
  try {
    assert.deepEqual(checkCommerceD1(localQuery(database)), {
      authorityState: 'd1',
      authorityRevision: 3,
      inventoryMode: 'legacy',
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
  const database = currentDatabase();
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
      ['SCAN commerce_documents USING INDEX commerce_ready_notifications_due'],
      ['SEARCH commerce_documents USING INDEX commerce_ready_notifications_due (<expr><?)', 'USE TEMP B-TREE FOR ORDER BY'],
    ]) {
      assert.throws(() => checkCommerceD1((sql) => {
        if (sql.includes('EXPLAIN QUERY PLAN') && sql.includes('INDEXED BY commerce_ready_notifications_due')) {
          return details.map((detail) => ({ detail }));
        }
        return query(sql);
      }), /does not search commerce_ready_notifications_due|due ready-notification query plan uses a temporary B-tree/);
    }
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects a malformed Stripe terminal-notification index', () => {
  const database = currentDatabase();
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
