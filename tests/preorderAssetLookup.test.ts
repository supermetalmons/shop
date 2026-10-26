import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { unstable_splitSqlQuery } from 'wrangler';
import { createCommerceD1Harness } from '../cloud/workers/api/test/commerceD1Harness.ts';
import {
  listPreorderInventoryAssets, listRecentPreorderInventoryAssets, PreorderStore,
  type StoredPreorder,
} from '../cloud/workers/api/src/preorderStore.ts';
import { requestedPreorderInventoryQuery } from '../cloud/workers/api/src/preorderInventoryQueries.ts';
import { readCommerceMigrations } from '../scripts/shared/commerceMigrationReplay.ts';
import { readCommerceSchemaManifest, selectCommerceSchemaCheckpoint } from '../scripts/shared/commerceSchemaManifest.ts';
import { captureD1SchemaObjects } from '../scripts/shared/d1SchemaManifest.ts';
import { checkCommerceD1 } from '../scripts/ops/checkCommerceD1.ts';
import { getPreorderConfig } from '../shared/preorders.ts';

const migrations = readCommerceMigrations();
const migration = migrations.find(({ name }) => name === '0045_preorder_asset_lookup.sql')!;
const config = getPreorderConfig('mi_note_cards_devnet')!;

function reservation(id: number, overrides: Partial<StoredPreorder> = {}): StoredPreorder {
  return {
    orderId: `order-${String(id).padStart(3, '0')}`, preorderId: config.preorderId,
    cluster: config.cluster, collection: config.collection, buyer: 'buyer',
    ethereumAddress: '0x0000000000000000000000000000000000000001', requestId: `request-${id}`,
    cardIds: [id], assets: [{ id, address: `asset-${id}` }], status: 'prepared', expiresAtMs: 10000,
    signature: null, preparedTransaction: 'partial', signedTransaction: null, blockhash: 'hash',
    blockhashContextSlot: 1, lastValidBlockHeight: 100, createdAtMs: id, revision: 1,
    ...overrides,
  };
}

async function confirmed(store: PreorderStore, order: StoredPreorder, finalized = true): Promise<StoredPreorder> {
  const reserved = await store.reserve(order);
  const submitted = await store.submit(reserved, { transactionBase64: 'signed', signature: `signature-${order.orderId}` }, 100);
  const result = await store.confirm(submitted, 100 + order.cardIds[0], 200);
  return finalized ? store.finish(result, 'succeeded', 300, 200 + order.cardIds[0]) : result;
}

function lookupRows(database: DatabaseSync) {
  return database.prepare(`SELECT order_id, asset_ordinal, asset_address
    FROM commerce_preorder_asset_lookup ORDER BY order_id, asset_ordinal`).all().map(row => ({ ...row }));
}

function registerMigrations(database: DatabaseSync, through = migrations.at(-1)!.name): void {
  database.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  for (const [index, entry] of migrations.filter(({ name }) => name <= through).entries()) {
    database.prepare('INSERT INTO d1_migrations VALUES (?, ?)').run(index + 1, entry.name);
  }
}

function withoutTrigger(database: DatabaseSync, name: string, change: () => void): void {
  const sql = String(database.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(name)!.sql);
  database.exec(`DROP TRIGGER ${name}`);
  try { change(); } finally { database.exec(sql); }
}

for (const split of [false, true]) {
  test(`preorder asset lookup backfills immutable history with ${split ? 'remote-split' : 'whole'} SQL`, async context => {
    const h = createCommerceD1Harness({ preorderAssetLookupMigration: false });
    context.after(() => h.database.close());
    const store = new PreorderStore(h.db);
    await confirmed(store, reservation(1, {
      cardIds: [1, 2, 3], assets: [{ id: 1, address: 'duplicate' }, { id: 2, address: 'duplicate' }, { id: 3, address: 'third' }],
    }));
    await confirmed(store, reservation(4), false);
    const cancelled = await store.reserve(reservation(5, { buyer: 'cancelled-buyer' }));
    await store.finish(cancelled, 'cancelled', 300);
    await store.reserve(reservation(6, { buyer: 'historical-shape',
      assets: [null] as unknown as StoredPreorder['assets'] }));
    const history = () => ['commerce_preorder_orders', 'commerce_preorder_claims', 'commerce_authority_control']
      .map(table => h.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = history();
    h.database.exec('BEGIN');
    if (split) {
      for (const statement of unstable_splitSqlQuery(migration.sql)) h.database.prepare(statement).run();
    } else h.database.exec(migration.sql);
    h.database.exec('COMMIT');
    assert.deepEqual(history(), before);
    assert.deepEqual(lookupRows(h.database), [
      { order_id: 'order-001', asset_ordinal: 0, asset_address: 'duplicate' },
      { order_id: 'order-001', asset_ordinal: 1, asset_address: 'duplicate' },
      { order_id: 'order-001', asset_ordinal: 2, asset_address: 'third' },
      { order_id: 'order-004', asset_ordinal: 0, asset_address: 'asset-4' },
      { order_id: 'order-005', asset_ordinal: 0, asset_address: 'asset-5' },
    ]);
    assert.deepEqual(h.database.prepare('PRAGMA foreign_key_check').all(), []);
    registerMigrations(h.database, migration.name);
    const checkpoint = selectCommerceSchemaCheckpoint(readCommerceSchemaManifest(),
      h.database.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map(({ name }) => name));
    assert.deepEqual(captureD1SchemaObjects(h.database).map(({ type, name, fingerprint }) => ({ type, name, fingerprint })),
      checkpoint.objects);
    assert.deepEqual(h.database.prepare('SELECT card_id FROM commerce_preorder_cards ORDER BY card_id').all().map(({ card_id }) => card_id),
      checkpoint.preorderCardIds);
    await store.reserve(reservation(7, { buyer: 'old-writer' }));
    assert.deepEqual(lookupRows(h.database).at(-1), { order_id: 'order-007', asset_ordinal: 0, asset_address: 'asset-7' });
  });
}

test('preorder lookup guards preserve source identity and failed reservations roll back projected rows', async context => {
  const h = createCommerceD1Harness();
  context.after(() => h.database.close());
  const store = new PreorderStore(h.db);
  await confirmed(store, reservation(1));
  assert.throws(() => h.database.exec(`INSERT INTO commerce_preorder_asset_lookup VALUES ('order-001', 1, 'unexpected')`), /invalid preorder asset lookup/);
  assert.throws(() => h.database.exec(`INSERT INTO commerce_preorder_asset_lookup VALUES ('absent', 0, 'unexpected')`), /invalid preorder asset lookup/);
  assert.throws(() => h.database.exec(`UPDATE commerce_preorder_asset_lookup SET asset_address = 'changed'`), /immutable/);
  assert.throws(() => h.database.exec('DELETE FROM commerce_preorder_asset_lookup'), /permanent/);
  await assert.rejects(store.reserve(reservation(2, { cardIds: [1], assets: [{ id: 1, address: 'conflict' }] })), /already reserved/);
  assert.equal(await store.get('order-002'), null);
  assert.deepEqual(lookupRows(h.database), [{ order_id: 'order-001', asset_ordinal: 0, asset_address: 'asset-1' }]);
  await store.reserve(reservation(3));
  await store.expirePrepared(config.cluster, config.collection, 10000);
  assert.equal(lookupRows(h.database).length, 2);
  assert.deepEqual(await listPreorderInventoryAssets(h.db, 'buyer', ['asset-3']), [{
    id: 1, address: 'asset-1', preorderId: config.preorderId, status: 'succeeded', confirmedSlot: 201,
  }]);
});

test('requested inventory preserves transfer, claims, confirmation, scope and candidate limits', async context => {
  let recentReads = 0;
  let requestedReads = 0;
  const h = createCommerceD1Harness({ observeCall(call) {
    if (call.method !== 'all') return;
    if (call.sql.includes('ORDER BY preorder.created_at_ms DESC LIMIT 15')) recentReads++;
    if (call.sql.includes('json_each(?) AS expected')) requestedReads++;
  } });
  context.after(() => h.database.close());
  const store = new PreorderStore(h.db);
  await confirmed(store, reservation(1, { cardIds: [1, 2, 3], assets: [1, 2, 3].map(id => ({ id, address: `asset-${id}` })) }));
  for (let id = 4; id <= 20; id++) await confirmed(store, reservation(id));
  const pending = await confirmed(store, reservation(21), false);
  const unconfirmed = await store.reserve(reservation(22, { buyer: 'unconfirmed' }));
  await store.submit(unconfirmed, { signature: 'pending', transactionBase64: 'signed' }, 100);
  await confirmed(store, reservation(23, { preorderId: 'unconfigured', buyer: 'other' }));
  await confirmed(store, reservation(24, { collection: 'unconfigured', buyer: 'other' }));
  await confirmed(store, reservation(25, { cluster: 'mainnet-beta', buyer: 'other' }));
  const released = await confirmed(store, reservation(26, { buyer: 'released' }), false);
  await store.finish(released, 'failed', 300);
  const requested = await listPreorderInventoryAssets(h.db, 'transferred-owner', [
    'asset-1', 'asset-2', 'asset-3', 'asset-1', 'asset-21', 'asset-22', 'asset-23', 'asset-24', 'asset-25', 'asset-26', 'missing',
  ]);
  assert.deepEqual(requested.map(asset => asset.address), ['asset-1', 'asset-2', 'asset-3']);
  const own = await listPreorderInventoryAssets(h.db, 'buyer', ['asset-1', 'asset-21']);
  assert.equal(own.length, 15);
  assert.deepEqual(own.slice(0, 2).map(asset => asset.address), ['asset-1', 'asset-21']);
  assert.equal(own[1].confirmedSlot, pending.confirmedSlot);
  assert.equal(own[1].status, 'submitted');
  const capped = await listPreorderInventoryAssets(h.db, 'transferred-owner', Array.from({ length: 20 }, (_, index) => `asset-${index + 1}`));
  assert.equal(capped.length, 15);
  assert.deepEqual(new Set(capped.map(asset => asset.address)), new Set(Array.from({ length: 15 }, (_, index) => `asset-${index + 1}`)));
  recentReads = 0;
  requestedReads = 0;
  const recent = listRecentPreorderInventoryAssets(h.db, 'buyer');
  await Promise.all([['asset-1'], ['asset-2']].map(addresses => listPreorderInventoryAssets(h.db, 'buyer', addresses, recent)));
  assert.equal(recentReads, 1);
  assert.equal(requestedReads, 2);
  const query = requestedPreorderInventoryQuery('buyer', ['asset-1', 'asset-2']);
  const plan = h.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings)
    .map(row => String(row.detail)).join('\n');
  assert.match(plan, /SEARCH lookup USING COVERING INDEX commerce_preorder_asset_lookup_address \(asset_address=\?\)/);
  assert.match(plan, /SEARCH preorder USING INDEX sqlite_autoindex_commerce_preorder_orders_1 \(order_id=\?\)/);
  assert.match(plan, /SEARCH claim USING INDEX commerce_preorder_claim_order \(order_id=\?\)/);
  assert.doesNotMatch(plan, /SCAN (?:preorder|lookup)(?:\s|$)|TEMP B-TREE/);
});

for (const corruption of ['missing', 'mismatched', 'extra'] as const) {
  test(`Commerce integrity check rejects ${corruption} preorder asset lookup rows`, async context => {
    const h = createCommerceD1Harness();
    context.after(() => h.database.close());
    await confirmed(new PreorderStore(h.db), reservation(1));
    registerMigrations(h.database);
    if (corruption === 'missing') {
      withoutTrigger(h.database, 'commerce_preorder_asset_lookup_delete_guard', () => {
        h.database.exec('DELETE FROM commerce_preorder_asset_lookup');
      });
    } else if (corruption === 'mismatched') {
      withoutTrigger(h.database, 'commerce_preorder_asset_lookup_update_guard', () => {
        h.database.exec(`UPDATE commerce_preorder_asset_lookup SET asset_address = 'changed'`);
      });
    } else {
      withoutTrigger(h.database, 'commerce_preorder_asset_lookup_insert_guard', () => {
        h.database.exec(`INSERT INTO commerce_preorder_asset_lookup VALUES ('order-001', 1, 'extra')`);
      });
    }
    assert.throws(() => checkCommerceD1(sql => h.database.prepare(sql).all().map(row => ({ ...row }))),
      /preorder asset lookup differs from source/);
  });
}
