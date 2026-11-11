import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { checkCommerceReadiness } from '../scripts/ops/checkCommerceReadiness.ts';
import { COMMERCE_STORAGE_CONTROLS } from '../scripts/shared/commerceStateControl.ts';
import { inventoryDropConfigs } from '../scripts/shared/dudeInventoryMaintenance.ts';
import { readCommerceMigrations } from '../scripts/shared/commerceMigrationReplay.ts';
import { sequentialD1QueryBatch } from '../scripts/shared/commerceD1Audit.ts';
import { getPreorderConfig } from '../shared/preorders.ts';
import { commerceTestLease, commerceTestNow, commerceTestQuery, createCurrentCommerceDatabase } from './helpers/commerceDatabase.ts';

const generation = '00000000-0000-4000-8000-000000001099';

function fixture(t: TestContext) {
  const database = createCurrentCommerceDatabase(t);
  const configs = inventoryDropConfigs();
  commerceTestLease(database, () => {
    const insert = database.prepare(`INSERT INTO commerce_inventory_drops
      (drop_id, generation, ready, drop_family, items_per_box, max_dude_id, initialized_at_ms)
      VALUES (?, ?, 0, ?, ?, ?, 1000)`);
    for (const config of configs) insert.run(config.dropId, generation, config.dropFamily, config.itemsPerBox, config.maxDudeId);
    const names = ['commerce_inventory_initialization_insert_guard', 'commerce_inventory_initialization_apply'];
    const triggers = names.map(name => String(database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name)!.sql));
    for (const name of names) database.exec(`DROP TRIGGER ${name}`);
    try {
      const preorder = getPreorderConfig('mi_note_cards_devnet')!;
      for (const config of configs.filter(value => value.inventoryManifest)) database.prepare(`INSERT INTO commerce_inventory_initializations (
        drop_id, generation, lease_token, authority_revision, manifest_sha256, catalog_sha256, preorder_snapshot_sha256,
        source_preorder_id, source_cluster, source_collection, drop_family, items_per_box, pack_count, max_dude_id,
        excluded_card_ids_json, eligible_card_ids_json, created_at_ms, completed_at_ms
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 1000, 1000)`).run(
        config.dropId, generation, generation, config.inventoryManifest!.sha256, '0'.repeat(64), '0'.repeat(64),
        preorder.preorderId, preorder.cluster, preorder.collection, config.dropFamily, config.itemsPerBox,
        config.inventoryManifest!.cardIds.length / config.itemsPerBox, config.maxDudeId, JSON.stringify(config.inventoryManifest!.cardIds));
    } finally {
      for (const trigger of triggers) database.exec(trigger);
    }
    database.exec("UPDATE commerce_inventory_drops SET ready=1; UPDATE commerce_authority_control SET dude_inventory_mode='rows'");
    for (const table of COMMERCE_STORAGE_CONTROLS) database.exec(`UPDATE ${table}
      SET preparation_state='preparing', source_documents_revision=0;
      UPDATE ${table} SET preparation_state='ready', prepared_at_ms=1;
      UPDATE ${table} SET storage_mode='table'`);
  });
  const queries: string[] = [];
  const execute = commerceTestQuery(database);
  const query = (sql: string) => { queries.push(sql); return execute(sql); };
  return { database, configs, query, queries };
}

test('readiness accepts initialized paused and active Commerce without scanning business rows', async t => {
  const { database, configs, query, queries } = fixture(t);
  const paused = await checkCommerceReadiness(query);
  assert.equal(paused.authorityState, 'paused');
  assert.equal(paused.inventoryDrops, configs.length);
  assert.equal(paused.inventoryMode, 'rows');
  assert.deepEqual(Object.values(paused.controls), Array(4).fill('table'));
  const businessTables = ['commerce_documents', 'commerce_available_dudes', 'commerce_notification_outbox',
    'commerce_delivery_recovery', 'commerce_pack_status_outbox', 'commerce_stripe_checkout_state',
    'commerce_receipt_claim_failure_outbox', 'stripe_order_disputes'];
  for (const table of businessTables) {
    const pattern = new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`, 'i');
    assert.match(`SELECT * FROM ${table}`, pattern);
    for (const sql of queries) assert.doesNotMatch(sql, pattern);
  }
  assert.ok(queries.length <= 13, `Readiness used ${queries.length} queries`);
  commerceTestLease(database, () => database.exec(`UPDATE commerce_authority_control SET authority_state='d1',
    revision=revision+1, paused_at_ms=NULL, updated_at_ms=${commerceTestNow}`));
  assert.equal((await checkCommerceReadiness(query)).authorityState, 'd1');
});

test('readiness supports an explicit schema query batch', async t => {
  const { query } = fixture(t);
  const expected = await checkCommerceReadiness(query);
  const batches: string[][] = [];
  const executeBatch = sequentialD1QueryBatch(query);
  const actual = await checkCommerceReadiness(query, { queryBatch: statements => {
    batches.push(Object.keys(statements));
    return executeBatch(statements);
  } });
  assert.deepEqual(actual, expected);
  assert.deepEqual(batches, [['quick', 'foreignKeys', 'migrations'], ['catalog', 'tables']]);
});

test('readiness rejects missing migrations and altered schema', async t => {
  const { database, query } = fixture(t);
  const migration = readCommerceMigrations().at(-1)!;
  database.prepare('DELETE FROM d1_migrations WHERE name=?').run(migration.name);
  await assert.rejects(checkCommerceReadiness(query), /requires the latest migration/);
  database.prepare('INSERT INTO d1_migrations(name) VALUES (?)').run(migration.name);
  database.exec('DROP INDEX commerce_notification_outbox_family_due');
  await assert.rejects(checkCommerceReadiness(query), /schema .* invalid/);
});

test('readiness rejects missing or non-ready storage controls', async t => {
  for (const table of COMMERCE_STORAGE_CONTROLS) {
    const { query } = fixture(t);
    for (const patch of [null, { storage_mode: 'legacy' }, { preparation_state: 'preparing' }, { prepared_at_ms: null }]) {
      await assert.rejects(checkCommerceReadiness(sql => {
        const rows = query(sql);
        return sql.includes(`JOIN ${table} AS state`) ? patch === null ? [] : rows.map(row => ({ ...row, ...patch })) : rows;
      }), /control is invalid|requires ready table storage/);
    }
  }
});

test('readiness rejects uninitialized or mismatched inventory headers and authority mode', async t => {
  const { query } = fixture(t);
  for (const patch of [null, { ready: 0 }, { generation: 'invalid' }, { items_per_box: 999 }, { initialized_at_ms: -1 }]) {
    await assert.rejects(checkCommerceReadiness(sql => {
      const rows = query(sql);
      return sql.includes('FROM commerce_inventory_drops AS inventory') ? patch === null ? rows.slice(1)
        : rows.map((row, index) => index ? row : { ...row, ...patch }) : rows;
    }), /inventory|Inventory/);
  }
  await assert.rejects(checkCommerceReadiness(sql => {
    const rows = query(sql);
    return sql.includes('FROM commerce_authority_control') && !sql.includes(' JOIN ')
      ? rows.map(row => ({ ...row, dude_inventory_mode: 'legacy' })) : rows;
  }), /initialized figure inventory/);
});

test('readiness verifies manifest metadata without reading individual available cards', async t => {
  const { query } = fixture(t);
  for (const patch of [{ manifest_sha256: '0'.repeat(64) }, { initialization_generation: 'another' },
    { eligible_card_ids_json: '[]' }, { completed_at_ms: null }]) {
    await assert.rejects(checkCommerceReadiness(sql => {
      const rows = query(sql);
      return sql.includes('FROM commerce_inventory_drops AS inventory')
        ? rows.map(row => row.manifest_sha256 == null ? row : { ...row, ...patch }) : rows;
    }), /manifest header is invalid/);
  }
});

test('readiness propagates remote query failures', async () => {
  await assert.rejects(checkCommerceReadiness(() => { throw new Error('D1 unavailable'); }), /D1 unavailable/);
});
