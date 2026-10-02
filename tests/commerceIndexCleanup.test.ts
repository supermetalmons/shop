import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { commerceKeys } from '../cloud/workers/api/src/commerceRepository.ts';
import {
  manualReviewCheckoutsQuery, packStatusOutboxDueQuery, staleStripeFulfillmentsQuery,
} from '../cloud/workers/api/src/commerceQueries.ts';
import { listPreorderInventoryAssets, PreorderStore } from '../cloud/workers/api/src/preorderStore.ts';
import {
  createCommerceD1Harness, seedCommerceDocuments, seedPackStatusOutbox,
} from '../cloud/workers/api/test/commerceD1Harness.ts';
import { readCommerceMigrations, replayCommerceMigrations } from '../scripts/shared/commerceMigrationReplay.ts';
import { checkCurrentCommerceSchema } from '../scripts/shared/currentCommerceSchema.ts';
import { commerceTestQuery, createCurrentCommerceDatabase } from './helpers/commerceDatabase.ts';

const migrations = readCommerceMigrations();
const cleanup = migrations.find(({ name }) => name === '0034_drop_obsolete_commerce_indexes.sql')!;
const removedIndexes = new Set([
  'commerce_documents_pack_projection', 'commerce_stripe_checkouts_reconciliation_due', 'commerce_preorder_succeeded_buyer',
]);

function snapshot(database: DatabaseSync) {
  const query = commerceTestQuery(database);
  return {
    schema: query("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type, name"),
    tables: Object.fromEntries(query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
      .map(({ name }) => [String(name), query(`SELECT * FROM ${name} ORDER BY rowid`)])),
  };
}

function migrate(database: DatabaseSync): void {
  database.exec('BEGIN');
  try {
    database.exec(cleanup.sql);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function assertCleanup(database: DatabaseSync, before: ReturnType<typeof snapshot>): void {
  const after = snapshot(database);
  assert.deepEqual(after.tables, before.tables);
  assert.deepEqual(after.schema, before.schema.filter(({ name }) => !removedIndexes.has(String(name))));
  assert.equal(database.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
}

test('obsolete index cleanup preserves a fresh database and every retained schema object', (context) => {
  const database = replayCommerceMigrations(migrations.filter(({ name }) => name < cleanup.name));
  context.after(() => database.close());
  const before = snapshot(database);
  assert.equal(before.schema.filter(({ name }) => removedIndexes.has(String(name))).length, 3);
  migrate(database);
  assertCleanup(database, before);
});

test('obsolete index cleanup preserves populated commerce and indexed reconciliation and inventory reads', async (context) => {
  const preorderReads: string[] = [];
  const harness = createCommerceD1Harness({
    obsoleteIndexesMigration: false,
    observeCall: (call) => {
      if (call.method === 'all' && call.sql.startsWith('SELECT preorder_id, assets_json')) preorderReads.push(call.sql);
    },
  });
  const database = harness.database;
  context.after(() => database.close());
  const owner = '123456789ABCDEFG123456789ABCDEFG';
  seedCommerceDocuments(harness, Array.from({ length: 30 }, (_, index) => [
    { key: commerceKeys.deliveryOrder('drop', String(index + 1)), data: { owner, status: 'ready_to_ship', source: 'wallet' } },
    {
      key: commerceKeys.stripeCheckout('drop', `cs_live_${index}`),
      data: {
        status: index % 7 === 0 ? 'fulfillment_failed' : 'processing', manualRefundReviewRequired: index % 7 === 0,
        fulfillmentProcessor: 'cloudflare_queue_v1', updatedAt: 10, lastStripeWebhookEventId: 'evt_1',
      },
    },
  ]).flat());
  seedPackStatusOutbox(harness, {
    parentPath: commerceKeys.deliveryOrder('drop', '1').path, dropId: 'drop', generation: crypto.randomUUID(),
    state: 'pending', revision: 1, failureCount: 0, nextAttemptAtMs: 10, completedAtMs: null, failedAtMs: null,
    lastErrorCode: null, createdAtMs: 0, updatedAtMs: 0,
  });
  const store = new PreorderStore(harness.db);
  for (const id of [1, 2]) {
    let order = await store.reserve({
      orderId: `order${id}`, preorderId: 'preorder', cluster: 'mainnet-beta', collection: 'collection', buyer: owner,
      ethereumAddress: '0x1111111111111111111111111111111111111111', requestId: `request${id}`, cardIds: [id],
      assets: [{ address: `asset${id}`, id }], status: 'prepared', preparedTransaction: 'prepared',
      signedTransaction: null, signature: null, confirmedSlot: null, blockhash: 'hash', blockhashContextSlot: 1,
      lastValidBlockHeight: 10, expiresAtMs: 10000, createdAtMs: id, revision: 1,
    });
    order = await store.submit(order, { transactionBase64: `signed${id}`, signature: `signature${id}` }, 3);
    order = await store.confirm(order, 2, 4);
    if (id === 1) await store.finish(order, 'succeeded', 5, 2);
  }
  const queries = [
    { ...packStatusOutboxDueQuery({ dropId: 'drop', dueAtMs: 20, limit: 10 }), index: 'commerce_pack_status_outbox_due' },
    { ...staleStripeFulfillmentsQuery(20), index: 'commerce_stripe_checkout_state_reconciliation_due' },
    { ...manualReviewCheckoutsQuery({ dropId: 'drop', limit: 26 }), index: 'commerce_stripe_checkouts_manual_review_cursor' },
  ];
  const results = queries.map(({ sql, bindings }) => database.prepare(sql).all(...bindings));
  assert.ok(results.every((rows) => rows.length > 0));
  const assets = await listPreorderInventoryAssets(harness.db, owner, ['asset1']);
  assert.equal(assets.length, 2);
  assert.equal(preorderReads.length, 2);
  const before = snapshot(database);
  migrate(database);
  assertCleanup(database, before);
  assert.deepEqual(queries.map(({ sql, bindings }) => database.prepare(sql).all(...bindings)), results);
  assert.deepEqual(await listPreorderInventoryAssets(harness.db, owner, ['asset1']), assets);
  for (const { sql, bindings, index } of queries) {
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings);
    assert.ok(plan.some(({ detail }) => String(detail).includes(`SEARCH `) && String(detail).includes(index)), index);
  }
  for (const sql of preorderReads.slice(0, 2)) {
    const bindings = sql.includes('json_each(?)') ? [owner, '["asset1"]'] : [owner];
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings);
    assert.ok(plan.some(({ detail }) => String(detail).includes('SEARCH commerce_preorder_orders USING INDEX commerce_preorder_inventory_buyer')));
  }
});

test('obsolete index cleanup rolls back when a required old index is missing', (context) => {
  const database = replayCommerceMigrations(migrations.filter(({ name }) => name < cleanup.name));
  context.after(() => database.close());
  database.exec('DROP INDEX commerce_preorder_succeeded_buyer');
  const before = snapshot(database);
  assert.throws(() => migrate(database), /no such index: commerce_preorder_succeeded_buyer/);
  assert.deepEqual(snapshot(database), before);
});

test('current schema validation rejects reintroduced obsolete indexes', (context) => {
  const old = replayCommerceMigrations(migrations.filter(({ name }) => name < cleanup.name));
  context.after(() => old.close());
  for (const name of removedIndexes) {
    const database = createCurrentCommerceDatabase(context);
    const query = commerceTestQuery(database);
    checkCurrentCommerceSchema(query);
    database.exec(String(old.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').get('index', name)!.sql));
    assert.throws(() => checkCurrentCommerceSchema(query), {
      message: `Commerce D1 schema ${name} is invalid at ${migrations.at(-1)!.name}.`,
    });
  }
});
