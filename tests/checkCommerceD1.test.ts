import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  checkCommerceD1,
  type CheckCommerceD1Query,
} from '../scripts/ops/checkCommerceD1.ts';
import { commerceD1AuditRows } from '../scripts/shared/commerceD1Audit.ts';
import { createD1MaintenanceRunner } from '../scripts/shared/d1MaintenanceRunner.ts';
import { inventoryDropConfigs } from '../scripts/shared/dudeInventoryMaintenance.ts';
import { createDeliveryRecoveryRecord, deliveryRecoveryRow } from '../shared/deliveryRecoveryState.ts';
import { packStatusOutboxRow } from '../shared/packStatusOutbox.ts';
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
import { readCommerceMigrations } from '../scripts/shared/commerceMigrationReplay.ts';
import { stripeCheckoutStateFromDocument, stripeCheckoutStateMetadata, stripeCheckoutStateRow } from '../shared/stripeCheckoutState.ts';

const commerceMigrations = readCommerceMigrations();
const latestMigrationError = {
  message: `Commerce D1 requires the latest migration: ${commerceMigrations.at(-1)!.name}.`,
};
const FIXTURE_NOW_SQL = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
const FIXTURE_TIME = '2026-01-01T00:00:00.000Z';
const FIXTURE_GENERATION = '00000000-0000-4000-8000-000000000408';
const CONTROL_TABLES = [
  'commerce_notification_outbox_control', 'commerce_stripe_checkout_state_control',
  'commerce_pack_status_outbox_control', 'commerce_delivery_recovery_control',
] as const;

function schemaError(name: string) {
  return { message: `Commerce D1 schema ${name} is invalid at ${commerceMigrations.at(-1)!.name}.` };
}

function localQuery(database: DatabaseSync): CheckCommerceD1Query {
  return (sql) => database.prepare(sql).all().map((row) => ({ ...row }));
}

function rawDatabase(migrationCount = commerceMigrations.length): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON; CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
  for (const { name, sql } of commerceMigrations.slice(0, migrationCount)) {
    database.exec(sql);
    database.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
  }
  return database;
}

function pauseDatabase(database: DatabaseSync): void {
  database.exec(`INSERT INTO commerce_authority_control_lease VALUES
    (1, '00000000-0000-4000-8000-000000000407', ${FIXTURE_NOW_SQL}, ${FIXTURE_NOW_SQL} + 60000)
    ON CONFLICT(singleton) DO NOTHING;
    UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = ${FIXTURE_NOW_SQL} WHERE authority_state = 'd1';
    UPDATE commerce_authority_control SET paused_at_ms = ${FIXTURE_NOW_SQL}, updated_at_ms = ${FIXTURE_NOW_SQL}
      WHERE authority_state = 'paused' AND paused_at_ms IS NULL`);
}

function resumeDatabase(database: DatabaseSync): void {
  pauseDatabase(database);
  database.exec(`UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
    paused_at_ms = NULL, updated_at_ms = ${FIXTURE_NOW_SQL}; DELETE FROM commerce_authority_control_lease`);
}

function seedInventory(database: DatabaseSync) {
  pauseDatabase(database);
  const configs = inventoryDropConfigs();
  if (database.prepare('SELECT COUNT(*) AS count FROM commerce_inventory_drops').get()!.count !== 0) return configs[0];
  const insert = database.prepare(`INSERT INTO commerce_inventory_drops
    (drop_id, generation, ready, drop_family, items_per_box, max_dude_id, initialized_at_ms)
    VALUES (?, ?, 0, ?, ?, ?, 1000)`);
  for (const config of configs) insert.run(config.dropId, FIXTURE_GENERATION, config.dropFamily, config.itemsPerBox, config.maxDudeId);
  database.prepare('INSERT INTO commerce_available_dudes (drop_id, dude_id, pool_position) VALUES (?, 1, 0)').run(configs[0].dropId);
  database.exec("UPDATE commerce_inventory_drops SET ready = 1; UPDATE commerce_authority_control SET dude_inventory_mode = 'rows'");
  return configs[0];
}

function insertRow(database: DatabaseSync, table: string, row: Record<string, string | number | null>): void {
  database.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')})
    VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
}

type FixtureDocument = {
  path: string;
  kind: 'claim_code' | 'delivery_order' | 'stripe_checkout';
  dropId: string | null;
  id: string;
  data: Record<string, unknown>;
  processedAt?: number;
};

function insertDocuments(database: DatabaseSync, documents: FixtureDocument[]): void {
  const deliveries = documents.filter((document) => document.kind === 'delivery_order');
  const checkouts = documents.filter((document) => document.kind === 'stripe_checkout');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO commerce_commit_guards (guard_id, expectations_json, created_at_ms,
      delivery_recovery_paths_json, delivery_recovery_expectations_json, stripe_checkout_paths_json)
      VALUES ('checker-fixture', ?, 1000, ?, ?, ?)`).run(
      JSON.stringify(documents.map((document) => ({ path: document.path, version: -1 }))),
      JSON.stringify(deliveries.map((document) => document.path)),
      JSON.stringify(deliveries.map((document) => ({ parentPath: document.path, generation: null, revision: -1 }))),
      JSON.stringify(checkouts.map((document) => document.path)),
    );
    for (const document of documents) {
      const data = document.kind === 'stripe_checkout'
        ? stripeCheckoutStateMetadata(document.data, {}) : document.data;
      database.prepare(`INSERT INTO commerce_documents (document_path, document_kind, drop_id, document_id, document_json,
        version, create_time, update_time, processed_at_seconds, processed_at_nanos)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(
        document.path, document.kind, document.dropId, document.id, JSON.stringify(data), FIXTURE_TIME, FIXTURE_TIME,
        document.processedAt ?? null, document.processedAt === undefined ? null : 0,
      );
      if (document.kind === 'delivery_order') insertRow(database, 'commerce_delivery_recovery', deliveryRecoveryRow(
        createDeliveryRecoveryRecord({ parentPath: document.path, receiptRecoveryJson: null,
          generation: FIXTURE_GENERATION, nowMs: Date.parse(FIXTURE_TIME) }),
      ));
      if (document.kind === 'stripe_checkout') insertRow(database, 'commerce_stripe_checkout_state',
        stripeCheckoutStateRow(stripeCheckoutStateFromDocument(document.path, document.data, 1)));
    }
    database.exec(`UPDATE commerce_authority_control SET documents_revision = documents_revision + 1,
      updated_at_ms = updated_at_ms + 1; DELETE FROM commerce_commit_guards WHERE guard_id = 'checker-fixture'; COMMIT`);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function currentDatabase(seedDocuments = true): DatabaseSync {
  const database = rawDatabase();
  seedInventory(database);
  for (const table of CONTROL_TABLES) database.exec(`UPDATE ${table}
    SET preparation_state = 'preparing', source_documents_revision = 0;
    UPDATE ${table} SET preparation_state = 'ready', prepared_at_ms = 1;
    UPDATE ${table} SET storage_mode = 'table'`);
  database.exec('DELETE FROM commerce_authority_control_lease');
  if (!seedDocuments) return database;
  resumeDatabase(database);
  const documents: FixtureDocument[] = [{ path: 'claimCodes/HEALTHY', kind: 'claim_code', dropId: null,
    id: 'HEALTHY', data: { status: 'unused' } }];
  const ownerCharacters = '123456789ABCDEFG';
  for (let index = 0; index < 256; index += 1) {
    documents.push({ path: `drops/drop/deliveryOrders/${index}`, kind: 'delivery_order', dropId: 'drop', id: String(index),
      processedAt: index, data: {
        owner: ownerCharacters[index % ownerCharacters.length].repeat(32), source: 'stripe_offchain',
        stripeCheckoutSessionId: `cs_live_${index}`,
        status: index % 16 === 0 ? 'ready_to_ship' : index % 16 === 1 ? 'processing' : 'shipped',
        fulfillmentStatus: index % 32 === 0 ? 'pending' : 'complete',
      } });
    documents.push({ path: `drops/drop/stripeCheckouts/${index}`, kind: 'stripe_checkout', dropId: 'drop', id: String(index),
      data: { stripePaymentIntentId: `pi_${index}`, fulfillmentProcessor: 'cloudflare_queue_v1',
        status: index % 32 === 0 ? 'fulfillment_pending' : 'fulfilled', updatedAt: index,
        lastStripeWebhookEventId: `evt_${index}`, manualRefundReviewRequired: index % 32 === 0,
      } });
  }
  insertDocuments(database, documents);
  return database;
}

function currentPackStatusDatabase(): DatabaseSync {
  const database = currentDatabase(false);
  resumeDatabase(database);
  const fence = String(database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'commerce_pack_status_legacy_insert_fence'").get()!.sql);
  database.exec('DROP TRIGGER commerce_pack_status_legacy_insert_fence');
  insertDocuments(database, [{ path: 'drops/card_nft_2/deliveryOrders/1', kind: 'delivery_order', dropId: 'card_nft_2', id: '1',
    data: { deliveryId: 1, dropId: 'card_nft_2', status: 'ready_to_ship', items: [{ kind: 'box' }],
      packStatusProjectionState: 'pending', packStatusProjectionNextAttemptAtMs: 17,
      packStatusProjectionFailureCount: 2, packStatusProjectionLastErrorCode: 'unavailable' } }]);
  database.exec(fence);
  insertRow(database, 'commerce_pack_status_outbox', packStatusOutboxRow({
    parentPath: 'drops/card_nft_2/deliveryOrders/1', dropId: 'card_nft_2', generation: FIXTURE_GENERATION,
    state: 'pending', revision: 1, failureCount: 2, nextAttemptAtMs: 17,
    completedAtMs: null, failedAtMs: null, lastErrorCode: 'unavailable',
    createdAtMs: Date.parse(FIXTURE_TIME), updatedAtMs: Date.parse(FIXTURE_TIME),
  }));
  pauseDatabase(database);
  return database;
}

for (let count = 1; count < commerceMigrations.length; count += 1) {
  test(`Commerce D1 checker rejects historical schema ${commerceMigrations[count - 1].name} for inspection and deployment`, () => {
    const database = rawDatabase(count);
    try {
      const query = localQuery(database);
      let catalogReads = 0;
      const checked: CheckCommerceD1Query = (sql) => {
        if (/\bFROM sqlite_(?:schema|master)\b/i.test(sql)) catalogReads += 1;
        return query(sql);
      };
      assert.throws(() => checkCommerceD1(checked), latestMigrationError);
      assert.throws(() => checkCommerceD1(checked, { forDeployment: true }), latestMigrationError);
      assert.equal(catalogReads, 0);
    } finally { database.close(); }
  });
}

for (const [type, name] of [
  ['index', 'commerce_preorder_active_buyer'],
  ['index', 'commerce_preorder_prepared_expiry'], ['index', 'commerce_preorder_confirmed_recovery'],
  ['index', 'commerce_preorder_inventory_buyer'], ['index', 'commerce_preorder_claim_order'],
  ['index', 'commerce_stripe_checkout_state_reconciliation_due'],
  ['trigger', 'commerce_preorder_order_update_guard'], ['trigger', 'commerce_preorder_confirmation_guard'],
  ['trigger', 'commerce_preorder_claim_insert_guard'], ['trigger', 'commerce_preorder_claim_update_guard'],
  ['trigger', 'commerce_preorder_claim_delete_guard'], ['trigger', 'commerce_preorder_expiry_claim_release'],
  ['trigger', 'commerce_stripe_checkout_state_update_guard'], ['trigger', 'commerce_commit_guard_stripe_checkout_finish'],
] as const) {
  test(`Commerce D1 checker rejects missing or weakened current schema object ${name}`, () => {
    const database = currentDatabase(false);
    try {
      database.exec(`DROP ${type} ${name}`);
      assert.throws(() => checkCommerceD1(localQuery(database)), schemaError(name));
      database.exec(type === 'index' ? `CREATE INDEX ${name} ON commerce_documents (document_path)`
        : `CREATE TRIGGER ${name} BEFORE INSERT ON commerce_documents BEGIN SELECT 1; END`);
      assert.throws(() => checkCommerceD1(localQuery(database)), schemaError(name));
    } finally { database.close(); }
  });
}

test('active checkout health uses authoritative state and rejects missing or stale parent versions', () => {
  const database = currentDatabase();
  try {
    const query = localQuery(database);
    assert.equal(checkCommerceD1(query).stripeCheckoutStateRows, 256);
    assert.equal(checkCommerceD1((sql) => query(sql).map((row) => sql.startsWith('SELECT checkout.*,')
      ? { ...row, document_version: Number(row.document_version) + 1, parent_version: Number(row.parent_version) + 1 }
      : row)).stripeCheckoutStateRows, 256);
    const guard = String(query("SELECT sql FROM sqlite_schema WHERE name = 'commerce_stripe_checkout_state_update_guard'")[0].sql);
    database.exec(`DROP TRIGGER commerce_stripe_checkout_state_update_guard;
      UPDATE commerce_stripe_checkout_state SET status = 'fulfilled' WHERE document_path = 'drops/drop/stripeCheckouts/0'; ${guard}`);
    assert.equal(checkCommerceD1(query).stripeCheckoutStateMode, 'table');
    database.exec(`DROP TRIGGER commerce_stripe_checkout_state_update_guard;
      UPDATE commerce_stripe_checkout_state SET document_version = 2 WHERE document_path = 'drops/drop/stripeCheckouts/0'; ${guard}`);
    assert.throws(() => checkCommerceD1(query), /parent or version is invalid/);
    const deleteGuard = String(query("SELECT sql FROM sqlite_schema WHERE name = 'commerce_stripe_checkout_state_delete_guard'")[0].sql);
    database.exec(`DROP TRIGGER commerce_stripe_checkout_state_delete_guard;
      DELETE FROM commerce_stripe_checkout_state WHERE document_path = 'drops/drop/stripeCheckouts/0'; ${deleteGuard}`);
    assert.throws(() => checkCommerceD1(query), /differs from source/);
  } finally { database.close(); }
});

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
      inventoryMode: 'rows',
      notificationOutboxMode: 'table',
      notificationOutboxPreparation: 'ready',
      notificationOutboxGroups: 0,
      notificationOutboxFailures: [],
      stripeCheckoutStateMode: 'table',
      stripeCheckoutStatePreparation: 'ready',
      stripeCheckoutStateRows: 256,
      packStatusOutboxMode: 'table',
      packStatusOutboxPreparation: 'ready',
      packStatusOutboxRows: 0,
      deliveryRecoveryStateMode: 'table',
      deliveryRecoveryStatePreparation: 'ready',
      deliveryRecoveryStateRows: 256,
      inventoryDrops: inventoryDropConfigs().length,
      availableDudes: 1,
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

test('Commerce D1 checker reads one schema catalog for the current schema', () => {
  const database = currentDatabase(false);
  try {
    let catalogReads = 0;
    const query = localQuery(database);
    checkCommerceD1((sql) => {
      if (/\bFROM sqlite_(?:schema|master)\b/i.test(sql)) catalogReads += 1;
      return query(sql);
    });
    assert.equal(catalogReads, 1);
  } finally { database.close(); }
});

for (const [label, mutation] of [
  ['missing card', 'DELETE FROM commerce_preorder_cards WHERE card_id = 1419'],
  ['extra card', 'INSERT INTO commerce_preorder_cards (card_id) VALUES (1431)'],
  ['reserved card', 'INSERT INTO commerce_preorder_cards (card_id) VALUES (1401)'],
  ['reserved replacement', `DELETE FROM commerce_preorder_cards WHERE card_id = 1419;
    INSERT INTO commerce_preorder_cards (card_id) VALUES (1408)`],
] as const) {
  test(`Commerce D1 checker rejects preorder catalog drift: ${label}`, () => {
    const database = currentDatabase(false);
    try {
      database.exec(mutation);
      assert.throws(() => checkCommerceD1(localQuery(database)), {
        message: 'Commerce D1 preorder catalog is invalid.',
      });
    } finally {
      database.close();
    }
  });
}

test('Commerce D1 checker fingerprints base tables and guards beyond the old schema subset', () => {
  for (const [name, mutation] of [
    ['commerce_documents', 'ALTER TABLE commerce_documents ADD COLUMN unexpected TEXT'],
    ['commerce_documents_insert_authority_guard', `DROP TRIGGER commerce_documents_insert_authority_guard;
      CREATE TRIGGER commerce_documents_insert_authority_guard BEFORE INSERT ON commerce_documents
      BEGIN SELECT 1; END`],
    ['commerce_documents_kind_path', `DROP INDEX commerce_documents_kind_path;
      CREATE INDEX commerce_documents_kind_path ON commerce_documents (document_path)`],
  ] as const) {
    const database = currentDatabase(false);
    try {
      database.exec(mutation);
      assert.throws(() => checkCommerceD1(localQuery(database)), schemaError(name));
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
      }), schemaError('commerce_preorder_orders'));
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
    database.exec('DROP INDEX commerce_preorder_inventory_buyer');
    assert.throws(() => checkCommerceD1(query), schemaError('commerce_preorder_inventory_buyer'));
    assert.equal(catalogReads, 2);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker keeps schema loading behind integrity and deployment preconditions', () => {
  const database = rawDatabase(13);
  try {
    let catalogReads = 0;
    const query: CheckCommerceD1Query = (sql) => {
      if (/\bFROM sqlite_(?:schema|master)\b/i.test(sql)) catalogReads += 1;
      return localQuery(database)(sql);
    };
    assert.throws(() => checkCommerceD1((sql) => sql === 'PRAGMA quick_check'
      ? [{ quick_check: 'invalid' }] : query(sql)), /Commerce D1 quick check failed/);
    assert.throws(() => checkCommerceD1((sql) => sql === 'PRAGMA foreign_key_check'
      ? [{ table: 'commerce_preorder_claims', rowid: 1, parent: 'commerce_preorder_orders', fkid: 0 }] : query(sql)),
    /Commerce D1 foreign-key check failed/);
    assert.throws(() => checkCommerceD1(query, { forDeployment: true }), latestMigrationError);
    database.exec("UPDATE d1_migrations SET name = 'unexpected.sql' WHERE id = 1");
    assert.throws(() => checkCommerceD1(query), latestMigrationError);
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
      const error = schemaError(name);
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

test('pack-status outbox checks accept authoritative state while frozen markers remain unchanged', () => {
  const database = currentPackStatusDatabase();
  try {
    const query = localQuery(database);
    const paused = checkCommerceD1(query, { forDeployment: true });
    assert.equal(paused.packStatusOutboxMode, 'table');
    assert.equal(paused.packStatusOutboxPreparation, 'ready');
    assert.equal(paused.packStatusOutboxRows, 1);
    resumeDatabase(database);
    database.exec(`UPDATE commerce_pack_status_outbox SET state = 'completed', next_attempt_at_ms = NULL,
      completed_at_ms = updated_at_ms + 1, updated_at_ms = updated_at_ms + 1, revision = revision + 1`);
    assert.equal(checkCommerceD1(query, { forDeployment: true }).packStatusOutboxMode, 'table');
    assert.equal(JSON.parse(String(query('SELECT document_json FROM commerce_documents')[0].document_json))
      .packStatusProjectionState, 'pending');
  } finally { database.close(); }
});
test('active pack-status checks reject lost migrated obligations and allow unmarked historical parents', () => {
  const database = currentPackStatusDatabase();
  try {
    database.exec('DELETE FROM commerce_pack_status_outbox');
    const query = localQuery(database);
    const expectedError = /Pack-status outbox is missing for source document: drops\/card_nft_2\/deliveryOrders\/1/;
    assert.throws(() => checkCommerceD1(query), expectedError);
    const unmarked = { deliveryId: 1, dropId: 'card_nft_2', status: 'ready_to_ship', items: [{ kind: 'box' }] };
    const withFields = (fields: Record<string, unknown>): CheckCommerceD1Query => (sql) => query(sql).map((row) =>
      sql.startsWith('SELECT document.document_path, document.document_kind,')
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

test('pack-status outbox checker rejects missing or malformed current rows without comparing frozen source markers', () => {
  const database = currentPackStatusDatabase();
  try {
    const query = localQuery(database);
    assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) =>
      sql.startsWith('SELECT document.document_path, document.document_kind,')
        ? { ...row, pack_status_parent_path: null } : row)), /Pack-status outbox is missing for source document/);
    for (const corruption of [{ failure_count: -1 }, { generation: 'invalid' }, { revision: 0 }]) {
      assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) =>
        sql.startsWith('SELECT outbox.*,') && sql.includes('FROM commerce_pack_status_outbox AS outbox') ? { ...row, ...corruption } : row)),
      /Invalid pack-status outbox/);
    }
    assert.equal(checkCommerceD1((sql) => query(sql).map((row) =>
      sql.startsWith('SELECT outbox.*,') && sql.includes('FROM commerce_pack_status_outbox AS outbox')
        ? { ...row, failure_count: 3, revision: 2, updated_at_ms: Number(row.updated_at_ms) + 1 } : row)).packStatusOutboxRows, 1);
  } finally { database.close(); }
});
test('pack-status outbox checker rejects invalid controls, orphan rows, and malformed retry state', () => {
  const database = currentPackStatusDatabase();
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
      sql.startsWith('SELECT outbox.*,') && sql.includes('FROM commerce_pack_status_outbox AS outbox')
        ? { ...row, parent_document_path: 'drops/card_nft_2/deliveryOrders/999' } : row)),
    /Pack-status outbox parent identity is invalid/);
    assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) =>
      sql.startsWith('SELECT outbox.*,') && sql.includes('FROM commerce_pack_status_outbox AS outbox')
        ? { ...row, next_attempt_at_ms: null } : row)), /Invalid pack-status outbox/);
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects every inactive control state for inspection and deployment', () => {
  const database = currentDatabase(false);
  try {
    const query = localQuery(database);
    for (const table of CONTROL_TABLES) {
      for (const state of [
        { storage_mode: 'legacy', preparation_state: 'idle' },
        { storage_mode: 'legacy', preparation_state: 'preparing' },
        { storage_mode: 'legacy', preparation_state: 'ready' },
        { storage_mode: 'table', preparation_state: 'preparing' },
      ]) {
        const invalid: CheckCommerceD1Query = (sql) => query(sql).map((row) =>
          sql === `SELECT * FROM ${table}` ? { ...row, ...state } : row);
        assert.throws(() => checkCommerceD1(invalid), /control is invalid/, `${table}: ${JSON.stringify(state)}`);
        assert.throws(() => checkCommerceD1(invalid, { forDeployment: true }), /control is invalid/);
      }
    }
  } finally { database.close(); }
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
    assert.throws(() => checkCommerceD1(localQuery(database)), schemaError('stripe_order_disputes_drop_session'));
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

test('Commerce D1 checker rejects uninitialized latest schema and accepts initialized empty storage', () => {
  const uninitialized = rawDatabase();
  try {
    assert.throws(() => checkCommerceD1(localQuery(uninitialized)), /control is invalid/);
    assert.throws(() => checkCommerceD1(localQuery(uninitialized), { forDeployment: true }), /control is invalid/);
  } finally { uninitialized.close(); }
  const database = currentDatabase(false);
  try {
    assert.deepEqual(checkCommerceD1(localQuery(database)), {
      authorityState: 'paused', authorityRevision: 2, inventoryMode: 'rows',
      notificationOutboxMode: 'table', notificationOutboxPreparation: 'ready', notificationOutboxGroups: 0,
      notificationOutboxFailures: [], stripeCheckoutStateMode: 'table', stripeCheckoutStatePreparation: 'ready',
      stripeCheckoutStateRows: 0, packStatusOutboxMode: 'table', packStatusOutboxPreparation: 'ready',
      packStatusOutboxRows: 0, deliveryRecoveryStateMode: 'table', deliveryRecoveryStatePreparation: 'ready',
      deliveryRecoveryStateRows: 0, inventoryDrops: inventoryDropConfigs().length, availableDudes: 1,
      authoritativeDocuments: 0, deliveryOwnerRevisions: 0, documentPathRevisions: 0, kindCounts: {},
    });
  } finally { database.close(); }
});

test('Commerce D1 checker rejects a weakened manual-review cursor index', () => {
  const database = currentDatabase(false);
  try {
    database.exec(`DROP INDEX commerce_stripe_checkouts_manual_review_cursor;
      CREATE INDEX commerce_stripe_checkouts_manual_review_cursor ON commerce_documents (document_path)`);
    assert.throws(() => checkCommerceD1(localQuery(database)), schemaError('commerce_stripe_checkouts_manual_review_cursor'));
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

for (const index of ['commerce_receipt_claim_workflow_operation', 'commerce_receipt_claim_workflow_due']) {
  test(`Commerce D1 checker rejects a weakened ${index}`, () => {
    const database = currentDatabase(false);
    try {
      database.exec(`DROP INDEX ${index}; CREATE INDEX ${index} ON commerce_documents (document_path)`);
      assert.throws(() => checkCommerceD1(localQuery(database)), schemaError(index));
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
      assert.throws(() => checkCommerceD1(localQuery(database)), schemaError(index));
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
      assert.throws(() => checkCommerceD1(localQuery(database)), schemaError(index));
    } finally {
      database.close();
    }
  });
}

for (const mutation of [
  "UPDATE d1_migrations SET name = '0014_unexpected.sql' WHERE id = 14",
  'DELETE FROM d1_migrations WHERE id = 4',
  "INSERT INTO d1_migrations (name) VALUES ('0015_unexpected.sql')",
  `UPDATE d1_migrations SET id = -1 WHERE id = 1;
    UPDATE d1_migrations SET id = 1 WHERE id = 2;
    UPDATE d1_migrations SET id = 2 WHERE id = -1`,
  "INSERT INTO d1_migrations (name) VALUES ('9999_future.sql')",
]) {
  test(`Commerce D1 checker rejects migration history mutation: ${mutation}`, () => {
    const database = currentDatabase(false);
    try {
      database.exec(mutation);
      const query = localQuery(database);
      let catalogReads = 0;
      assert.throws(() => checkCommerceD1((sql) => {
        if (/\bFROM sqlite_(?:schema|master)\b/i.test(sql)) catalogReads += 1;
        return query(sql);
      }), /schema baseline is invalid|requires the latest migration/);
      assert.equal(catalogReads, 0);
    } finally {
      database.close();
    }
  });
}

test('Commerce D1 checker rejects legacy inventory for inspection and deployment', () => {
  const database = currentDatabase(false);
  try {
    const query = localQuery(database);
    const legacy: CheckCommerceD1Query = (sql) => query(sql).map((row) =>
      sql === 'SELECT * FROM commerce_authority_control' ? { ...row, dude_inventory_mode: 'legacy' } : row);
    assert.throws(() => checkCommerceD1(legacy), /requires initialized figure inventory/);
    assert.throws(() => checkCommerceD1(legacy, { forDeployment: true }), /requires initialized figure inventory/);
  } finally { database.close(); }
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

for (const column of ['dude_id', 'pool_position'] as const) {
  test(`Commerce D1 checker rejects out-of-range inventory ${column}`, () => {
    const database = currentDatabase(false);
    try {
      const config = inventoryDropConfigs()[0];
      const guard = String(database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'commerce_available_dude_update_guard'").get()!.sql);
      database.exec('DROP TRIGGER commerce_available_dude_update_guard');
      database.prepare(`UPDATE commerce_available_dudes SET ${column} = ? WHERE drop_id = ?`)
        .run(config.maxDudeId + 1, config.dropId);
      database.exec(guard);
      assert.throws(() => checkCommerceD1(localQuery(database)), /inventory state is invalid/);
    } finally { database.close(); }
  });
}

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
    assert.throws(() => checkCommerceD1(localQuery(database)), schemaError('commerce_dude_pool_insert_fence'));
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
    database.exec(`DROP INDEX commerce_stripe_checkout_state_reconciliation_due;
      CREATE INDEX commerce_stripe_checkout_state_reconciliation_due
      ON commerce_stripe_checkout_state (document_path)`);
    assert.throws(
      () => checkCommerceD1(localQuery(database)),
      schemaError('commerce_stripe_checkout_state_reconciliation_due'),
    );
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects a missing or malformed due ready-notification index', () => {
  const database = currentDatabase();
  try {
    database.exec('DROP INDEX commerce_notification_outbox_family_due');
    assert.throws(() => checkCommerceD1(localQuery(database)), schemaError('commerce_notification_outbox_family_due'));
    database.exec('CREATE INDEX commerce_notification_outbox_family_due ON commerce_notification_outbox (parent_path)');
    assert.throws(() => checkCommerceD1(localQuery(database)), schemaError('commerce_notification_outbox_family_due'));
  } finally { database.close(); }
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
  const database = currentDatabase();
  try {
    database.exec(`DROP INDEX commerce_notification_outbox_stripe_due_at;
      CREATE INDEX commerce_notification_outbox_stripe_due_at ON commerce_notification_outbox_stripe_due (parent_path)`);
    assert.throws(() => checkCommerceD1(localQuery(database)), schemaError('commerce_notification_outbox_stripe_due_at'));
  } finally { database.close(); }
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
      const expectedError = schemaError(name);
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
      schemaError('commerce_admin_irl_redeem_workflow_operation'),
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
      schemaError('commerce_admin_irl_redeem_workflow_operation'),
    );
  } finally {
    database.close();
  }
});

test('Commerce D1 checker rejects weakened notification fences and outbox indexes', () => {
  for (const name of ['commerce_notification_legacy_update_fence', 'commerce_notification_outbox_resume_guard', 'commerce_notification_outbox_family_due']) {
    const database = currentDatabase(false);
    try {
      const type = name.endsWith('_due') ? 'INDEX' : 'TRIGGER';
      database.exec(`DROP ${type} ${name}`);
      if (type === 'INDEX') database.exec(`CREATE INDEX ${name} ON commerce_notification_outbox (family)`);
      else database.exec(`CREATE TRIGGER ${name} BEFORE UPDATE ON commerce_documents BEGIN SELECT 1; END`);
      assert.throws(() => checkCommerceD1(localQuery(database)), schemaError(name));
    } finally { database.close(); }
  }
});

test('Commerce D1 checker rejects missing or stale pending-owner lookup entries', () => {
  for (const corruption of ['missing', 'wrong-owner', 'terminal-row'] as const) {
    const database = currentDatabase();
    try {

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

test('delivery recovery checker rejects reintroduced frozen metadata after cleanup', () => {
  const database = currentDatabase();
  try {
    const query = localQuery(database);
    const updateGuard = String(query("SELECT sql FROM sqlite_schema WHERE name = 'commerce_delivery_recovery_parent_update_guard'")[0].sql);
    database.exec(`DROP TRIGGER commerce_delivery_recovery_parent_update_guard;
      UPDATE commerce_documents SET document_json = json_set(document_json, '$.receiptRecovery', null), version = version + 1
        WHERE document_path = 'drops/drop/deliveryOrders/0';
      UPDATE commerce_authority_control SET documents_revision = documents_revision + 1;
      ${updateGuard}`);
    assert.throws(() => checkCommerceD1(query), /delivery recovery metadata is not canonical/);
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
      assert.throws(() => checkCommerceD1(localQuery(database)), schemaError(name));
    } finally { database.close(); }
  }
  const database = currentDatabase(false);
  try {
    const query = localQuery(database);
    for (const name of ['commerce_commit_guards', 'commerce_wipe_guards', 'commerce_delivery_recovery']) {
      assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) => row.name === name && row.type === 'table'
        ? { ...row, sql: String(row.sql).replace('STRICT', '') } : row)), schemaError(name));
    }
  } finally { database.close(); }
});

test('delivery recovery checker rejects missing, malformed, and orphan authoritative rows', () => {
  const database = currentPackStatusDatabase();
  try {
    const query = localQuery(database);
    assert.equal(checkCommerceD1(query, { forDeployment: true }).deliveryRecoveryStateRows, 1);
    assert.throws(() => checkCommerceD1((sql) => sql.includes('AND recovery.parent_path IS NULL LIMIT 1')
      ? [{ document_path: 'drops/card_nft_2/deliveryOrders/999' }] : query(sql)), /state is missing/);
    for (const corruption of [{ revision: 0 }, { generation: 'broken' }, { prepared_delay_ms: 120000 }]) {
      assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) => sql.startsWith('SELECT recovery.*,')
        ? { ...row, ...corruption } : row)), /Invalid delivery recovery/);
    }
    assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) => sql.startsWith('SELECT recovery.*,')
      ? { ...row, document_path: 'drops/card_nft_2/deliveryOrders/999' } : row)), /parent is invalid/);
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
    const database = currentPackStatusDatabase();
    try {
      resumeDatabase(database);
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
        if (sql.startsWith('SELECT document.document_path, document.document_kind,') && !changed) {
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


test('Commerce D1 batches small checks and preserves paged payload validation in both modes', () => {
  const database = currentDatabase();
  try {
    for (let index = 0; index < 256; index += 1) {
      const parentPath = `drops/drop/deliveryOrders/${index}`;
      insertRow(database, 'commerce_pack_status_outbox', packStatusOutboxRow({
        parentPath, dropId: 'drop', generation: FIXTURE_GENERATION, state: 'pending', revision: 1,
        failureCount: 0, nextAttemptAtMs: 0, completedAtMs: null, failedAtMs: null, lastErrorCode: null,
        createdAtMs: 0, updatedAtMs: 0,
      }));
      for (const family of ['ready', 'shipped']) {
        if (index === 0 && family === 'ready') continue;
        database.prepare(`INSERT INTO commerce_notification_outbox (
          parent_path, family, drop_id, generation, outcome, state, entries_json, revision,
          attempt_count, next_attempt_at_ms, claim_id, claim_expires_at_ms, retry_until_ms,
          created_at_ms, updated_at_ms, last_error_code
        ) VALUES (?, ?, 'drop', ?, NULL, 'failed', ?, 1, 0, NULL, NULL, NULL, 10000, 0, 0, 'fixture')`).run(
          parentPath, family, FIXTURE_GENERATION, JSON.stringify([{
            kind: family === 'ready' ? 'buyer_order_received' : 'buyer_order_shipped',
            jobId: FIXTURE_GENERATION, idempotencyKey: `drop:${index}:${family}`, state: 'failed',
          }]),
        );
      }
    }
    for (let index = 0; index < 201; index += 1) {
      database.prepare('INSERT INTO stripe_order_disputes VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        index < 150 ? 0 : 1, index < 150 ? 'cs_test_history' : 'cs_live_history',
        `du_${String(index).padStart(3, '0')}`, 'drop', 'ch_history', 'pi_history', 1, 2,
      );
    }
    const query = localQuery(database);
    const expected = checkCommerceD1(query);
    assert.equal(expected.authoritativeDocuments, 513);
    assert.equal(expected.notificationOutboxGroups, 511);
    assert.equal(expected.packStatusOutboxRows, 256);
    assert.deepEqual(expected.notificationOutboxFailures, [
      { family: 'ready', last_error_code: 'fixture', count: 255 },
      { family: 'shipped', last_error_code: 'fixture', count: 256 },
    ]);
    for (const forDeployment of [false, true]) {
      let commands = 0;
      let batches = 0;
      const pages = new Map<string, number[]>();
      const runner = createD1MaintenanceRunner('commerce', (_file, args) => {
        commands += 1;
        const sql = args[args.indexOf('--command') + 1];
        const statements = sql.split(';\n');
        if (statements.length > 1) batches += 1;
        return JSON.stringify(statements.map((statement) => {
          const results = query(statement);
          if (statement.startsWith('SELECT ') && statement.endsWith('LIMIT 100')) {
            const table = /FROM (\w+) AS/.exec(statement)![1];
            assert.ok(results.length <= 100);
            pages.set(table, [...(pages.get(table) ?? []), results.length]);
          }
          return { success: true, results };
        }));
      });
      assert.deepEqual(checkCommerceD1(runner.query, { queryBatch: runner.queryBatch, forDeployment }), expected);
      assert.equal(batches, 5);
      assert.ok(commands < 40, String(commands));
      assert.deepEqual(Object.fromEntries(pages), {
        stripe_order_disputes: [100, 100, 1],
        commerce_documents: [100, 100, 100, 100, 100, 13],
        commerce_notification_outbox: [100, 100, 100, 100, 100, 11],
        commerce_delivery_recovery: [100, 100, 56],
        commerce_pack_status_outbox: [100, 100, 56],
        commerce_stripe_checkout_state: [100, 100, 56],
      });
      for (const [table, corruption, error] of [
        ['commerce_documents', { document_json: '{"nested":{"authSubject":"invalid"}}' }, /invalid identity document/],
        ['commerce_notification_outbox', { entries_json: '[]' }, /Invalid notification outbox/],
        ['commerce_pack_status_outbox', { revision: 0 }, /Invalid pack-status outbox/],
        ['commerce_stripe_checkout_state', { document_version: -1 }, /Invalid Stripe checkout state/],
        ['commerce_delivery_recovery', { prepared_delay_ms: -1 }, /Invalid delivery recovery projections/],
        ['stripe_order_disputes', { payment_intent_id: 'invalid' }, /chargeback history identity is invalid/],
      ] as const) {
        let changed = false;
        assert.throws(() => checkCommerceD1((sql) => query(sql).map((row) => {
          if (sql.includes(`FROM ${table} AS`) && sql.includes(' > ') && sql.endsWith('LIMIT 100')) {
            changed = true;
            return { ...row, ...corruption };
          }
          return row;
        }), { forDeployment }), error);
        assert.equal(changed, true, table);
      }
    }
  } finally { database.close(); }
});

test('Commerce D1 rejects lossy UTF-8 high-water keys in both audit modes', () => {
  const database = currentDatabase(false);
  try {
    database.exec(`INSERT INTO stripe_order_disputes VALUES
      (1, CAST(X'63735f6c6976655fff' AS TEXT), 'dp_valid', 'drop', 'ch_valid', 'pi_valid', 0, 0)`);
    assert.equal(database.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
    for (const forDeployment of [false, true]) {
      assert.throws(() => checkCommerceD1(localQuery(database), { forDeployment }),
        /Commerce D1 audit page is invalid for stripe_order_disputes/);
    }
  } finally { database.close(); }
});

test('Commerce D1 validates cursor bytes before yielding rows and preserves valid Unicode', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE audit_rows (id TEXT PRIMARY KEY) STRICT');
    const insert = database.prepare('INSERT INTO audit_rows VALUES (?)');
    for (const id of [...Array.from({ length: 101 }, (_, index) => `${index}-é\uFFFD😀`), '\uE000', '𐀀']) insert.run(id);
    assert.deepEqual([...commerceD1AuditRows(localQuery(database), { table: 'audit_rows', keys: ['id'] })],
      localQuery(database)('SELECT id FROM audit_rows ORDER BY id'));
    database.exec('DELETE FROM audit_rows');
    for (let index = 0; index < 99; index += 1) insert.run(`a${String(index).padStart(2, '0')}`);
    insert.run('z');
    database.exec("INSERT INTO audit_rows VALUES (CAST(X'61ff' AS TEXT))");
    const rows = commerceD1AuditRows(localQuery(database), { table: 'audit_rows', keys: ['id'] });
    for (let index = 0; index < 99; index += 1) assert.equal(rows.next().value!.id, `a${String(index).padStart(2, '0')}`);
    assert.throws(() => rows.next(), /Commerce D1 audit page is invalid for audit_rows/);
  } finally { database.close(); }
});

for (const count of [0, 100, 101, 200]) {
  test(`Commerce D1 audit handles ${count} rows and escaped cursor values`, () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('CREATE TABLE audit_rows (id TEXT PRIMARY KEY, payload TEXT) STRICT');
      for (let index = 0; index < count; index += 1) {
        database.prepare('INSERT INTO audit_rows VALUES (?, ?)').run(`key\'${String(index).padStart(3, '0')}`, 'payload');
      }
      let pages = 0;
      const rows = [...commerceD1AuditRows((sql) => {
        if (sql.endsWith('LIMIT 100')) pages += 1;
        return localQuery(database)(sql);
      }, { table: 'audit_rows', keys: ['id'] })];
      assert.equal(rows.length, count);
      assert.equal(new Set(rows.map((row) => row.id)).size, count);
      assert.equal(pages, Math.ceil(count / 100));
    } finally { database.close(); }
  });
}

test('Commerce D1 audit defers appended keys and tolerates deletion of its high-water row', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE audit_rows (id INTEGER PRIMARY KEY, payload TEXT) STRICT');
    for (let index = 0; index < 201; index += 1) database.prepare('INSERT INTO audit_rows VALUES (?, ?)').run(index, 'payload');
    let pages = 0;
    const rows = [...commerceD1AuditRows((sql) => {
      const result = localQuery(database)(sql);
      if (sql.endsWith('LIMIT 100')) {
        pages += 1;
        database.prepare('INSERT INTO audit_rows VALUES (?, ?)').run(200 + pages, 'appended');
        if (pages === 1) database.exec('DELETE FROM audit_rows WHERE id IN (0, 150, 200)');
      }
      return result;
    }, { table: 'audit_rows', keys: ['id'] })];
    assert.equal(pages, 2);
    assert.equal(rows.length, 199);
    assert.ok(rows.some((row) => row.id === 0));
    assert.ok(rows.every((row) => Number(row.id) < 200 && row.id !== 150));
  } finally { database.close(); }
});

test('Commerce D1 audit rejects malformed, oversized, out-of-range, or nonadvancing pages', () => {
  for (const result of [
    null, {}, [null], [[]], [{ id: null }], [{ id: 101 }],
    [{ id: 1 }, { id: 1 }], [{ id: 2 }, { id: 1 }],
    Array.from({ length: 101 }, (_, id) => ({ id })),
  ]) {
    const query = (sql: string) => sql.endsWith('LIMIT 1') ? [{ id: 100 }] : result;
    assert.throws(() => [...commerceD1AuditRows(query as CheckCommerceD1Query, {
      table: 'audit_rows', keys: ['id'],
    })], /Commerce D1 audit page is invalid/);
  }
  let pages = 0;
  assert.throws(() => [...commerceD1AuditRows((sql) => {
    if (sql.endsWith('LIMIT 1')) return [{ id: 199 }];
    pages += 1;
    return Array.from({ length: 100 }, (_, id) => ({ id }));
  }, { table: 'audit_rows', keys: ['id'] })], /Commerce D1 audit page is invalid/);
  assert.equal(pages, 2);
});
