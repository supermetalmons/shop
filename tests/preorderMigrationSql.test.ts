import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { unstable_splitSqlQuery } from 'wrangler';
import { createCommerceD1Harness } from '../cloud/workers/api/test/commerceD1Harness.ts';
import { listSucceededPreorderAssets, PreorderStore, type StoredPreorder } from '../cloud/workers/api/src/preorderStore.ts';
import { getPreorderConfig } from '../shared/preorders.ts';

test('preorder migration preserves complete triggers under remote D1 SQL parsing', (context) => {
  const directory = new URL('../cloud/workers/api/commerce-migrations/', import.meta.url);
  const migrationName = '0018_preorders.sql';
  const sql = readFileSync(new URL(migrationName, directory), 'utf8');
  assert.doesNotMatch(sql, /\bSELECT\s+CASE\b/i, 'D1 remote trigger parsing requires parenthesized CASE expressions');
  const statements = unstable_splitSqlQuery(sql);
  assert.equal(statements.length, 11);
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < migrationName).sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  for (const statement of statements) {
    assert.equal((statement.match(/\bCREATE\b/g) ?? []).length, 1);
    db.prepare(statement).run();
  }
  const expected = [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+(\w+)/g)]
    .map(([, type, name]) => ({ type: type.toLowerCase(), name }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const actual = db.prepare("SELECT type, name FROM sqlite_schema WHERE name LIKE 'commerce_preorder_%'")
    .all().map((row) => ({ type: row.type, name: String(row.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(actual, expected);
  assert.equal(actual.filter((row) => row.type === 'trigger').length, 6);
});

test('recent preorder inventory uses the buyer index without scanning or sorting order history', async (context) => {
  let query = '';
  const { database, db } = createCommerceD1Harness({ observeCall(call) {
    if (call.method === 'all') query = call.sql;
  } });
  context.after(() => database.close());
  assert.deepEqual(await listSucceededPreorderAssets(db, 'buyer'), []);
  assert.ok(query.includes('commerce_preorder_orders'));
  const plan = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all('buyer').map((row) => String(row.detail)).join('\n');
  assert.match(plan, /SEARCH commerce_preorder_orders USING INDEX commerce_preorder_succeeded_buyer/);
  assert.doesNotMatch(plan, /SCAN commerce_preorder_orders|TEMP B-TREE/);
});

test('expiry touches prepared orders and current claims without scanning permanent history', async (context) => {
  const statements: string[] = [];
  const { database, db } = createCommerceD1Harness({ observeStatement(call) { statements.push(call.sql); } });
  context.after(() => database.close());
  const store = new PreorderStore(db);
  const config = getPreorderConfig('mi_note_cards_devnet')!;
  const reserve = (id: number, expiresAtMs = 2000): Promise<StoredPreorder> => store.reserve({
    orderId: crypto.randomUUID(), preorderId: config.preorderId, cluster: config.cluster, collection: config.collection,
    buyer: `buyer-${id}`, ethereumAddress: '0x0000000000000000000000000000000000000001', requestId: crypto.randomUUID(), cardIds: [id], assets: [{ id, address: `asset-${id}` }],
    status: 'prepared', expiresAtMs, signature: null, preparedTransaction: 'partial', signedTransaction: null,
    blockhash: 'hash', blockhashContextSlot: 1, lastValidBlockHeight: 100, createdAtMs: 1000, revision: 1,
  });
  const retired = await reserve(1);
  await store.finish(retired, 'expired', 2001);
  const due = await reserve(2);
  await reserve(3, 10_000);
  const submitted = await store.submit(await reserve(4), { transactionBase64: 'signed', signature: 'signature-4' }, 1500);
  const sold = await store.submit(await reserve(5), { transactionBase64: 'signed', signature: 'signature-5' }, 1500);
  await store.finish(sold, 'succeeded', 1600);
  statements.length = 0;
  await store.expirePrepared(5000);
  assert.equal(statements.length, 2);
  const plans = statements.map((sql, index) => database.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(index === 0 ? [5000, 5000] : [])).map((row) => String(row.detail)).join('\n'));
  assert.match(plans[0], /SEARCH commerce_preorder_orders USING (?:COVERING )?INDEX commerce_preorder_prepared_expiry/);
  assert.match(plans[1], /SEARCH commerce_preorder_orders USING INDEX.*order_id=\?/);
  assert.ok(plans.every((plan) => !plan.includes('SCAN commerce_preorder_orders')));
  assert.equal((await store.get(due.orderId))!.status, 'expired');
  assert.equal((await store.get(submitted.orderId))!.status, 'submitted');
  assert.deepEqual((await store.claims(config.cluster, config.collection)).map((claim) => claim.id).sort(), [3, 4, 5]);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM commerce_preorder_orders').get()!.count, 5);
});

test('Ethereum ownership migration preserves submitted legacy orders and fences unsigned legacy submission', async (context) => {
  const { database, db } = createCommerceD1Harness({ preorderEthereumMigration: false });
  context.after(() => database.close());
  const config = getPreorderConfig('mi_note_cards_devnet')!;
  for (const id of [1, 2]) {
    database.prepare(`INSERT INTO commerce_preorder_orders (
      order_id, preorder_id, cluster, collection, buyer, request_id, card_ids_json, assets_json,
      status, prepared_transaction, blockhash, blockhash_context_slot, last_valid_block_height,
      expires_at_ms, created_at_ms, updated_at_ms, next_check_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 'partial', 'hash', 1, 100, 121000, 1000, 1000, 121000)`)
      .run(`legacy-${id}`, config.preorderId, config.cluster, config.collection, `buyer-${id}`, `request-${id}`,
        JSON.stringify([id]), JSON.stringify([{ id, address: `asset-${id}` }]));
    database.prepare('INSERT INTO commerce_preorder_claims VALUES (?, ?, ?, ?)')
      .run(config.cluster, config.collection, id, `legacy-${id}`);
  }
  database.exec(`UPDATE commerce_preorder_orders SET status = 'submitted', signature = 'signature',
    signed_transaction = 'signed', revision = revision + 1 WHERE order_id = 'legacy-2'`);
  const sql = readFileSync(new URL('../cloud/workers/api/commerce-migrations/0021_preorder_ethereum_ownership.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /\bSELECT\s+CASE\b/i);
  const statements = unstable_splitSqlQuery(sql);
  assert.equal(statements.length, 5);
  for (const statement of statements) database.prepare(statement).run();
  const store = new PreorderStore(db);
  const prepared = (await store.get('legacy-1'))!;
  const submitted = (await store.get('legacy-2'))!;
  assert.equal(prepared.ethereumAddress, null);
  assert.equal(submitted.ethereumAddress, null);
  await assert.rejects(store.submit(prepared, { transactionBase64: 'signed', signature: 'signature' }, 2000), /invalid preorder transition/);
  assert.equal((await store.finish(prepared, 'cancelled', 2000)).status, 'cancelled');
  assert.equal((await store.finish(submitted, 'succeeded', 2000)).status, 'succeeded');
  assert.deepEqual((await store.claims(config.cluster, config.collection)).map((claim) => claim.id), [2]);
});
