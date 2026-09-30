import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { unstable_splitSqlQuery } from 'wrangler';
import { createCommerceD1Harness } from '../cloud/workers/api/test/commerceD1Harness.ts';
import { listPreorderInventoryAssets, PreorderStore, type StoredPreorder } from '../cloud/workers/api/src/preorderStore.ts';
import { getPreorderConfig } from '../shared/preorders.ts';
import { sqlSchemaFingerprint } from '../scripts/shared/sqlSchemaFingerprint.ts';

function reservation(id: number, overrides: Partial<StoredPreorder> = {}): StoredPreorder {
  const config = getPreorderConfig('mi_note_cards_devnet')!;
  return {
    orderId: `expiry-${id}`, preorderId: config.preorderId, cluster: config.cluster, collection: config.collection,
    buyer: `buyer-${id}`, ethereumAddress: '0x0000000000000000000000000000000000000001', requestId: `request-${id}`,
    cardIds: [id], assets: [{ id, address: `asset-${id}` }], status: 'prepared', expiresAtMs: 2000,
    signature: null, preparedTransaction: 'partial', signedTransaction: null, blockhash: 'hash',
    blockhashContextSlot: 1, lastValidBlockHeight: 100, createdAtMs: 1000, revision: 1, ...overrides,
  };
}

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

test('confirmation migration has the same guards and indexes when split for remote D1', (context) => {
  const directory = new URL('../cloud/workers/api/commerce-migrations/', import.meta.url);
  const migrationName = '0022_preorder_confirmation.sql';
  const sql = readFileSync(new URL(migrationName, directory), 'utf8');
  assert.doesNotMatch(sql, /\bSELECT\s+CASE\b/i);
  const whole = new DatabaseSync(':memory:');
  const split = new DatabaseSync(':memory:');
  context.after(() => { whole.close(); split.close(); });
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < migrationName).sort()) {
    const previous = readFileSync(new URL(name, directory), 'utf8');
    whole.exec(previous);
    split.exec(previous);
  }
  whole.exec(sql);
  for (const statement of unstable_splitSqlQuery(sql)) split.prepare(statement).run();
  const schema = (database: DatabaseSync) => database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name GLOB 'commerce_preorder_*' ORDER BY name")
    .all().map((row) => ({ type: row.type, name: row.name, fingerprint: sqlSchemaFingerprint(String(row.sql)) }));
  assert.deepEqual(schema(split), schema(whole));
});

for (const migration of [
  { name: '0023_preorder_card_range.sql', options: { preorderCardRangeMigration: false },
    previousMaximum: 1395, maximum: 1398, newIds: [1396, 1397, 1398], reservedIds: [], statements: 8 },
  { name: '0024_preorder_card_range_1400.sql', options: { preorderCardRange1400Migration: false },
    previousMaximum: 1398, maximum: 1400, newIds: [1399, 1400], reservedIds: [], statements: 8 },
  { name: '0028_preorder_card_range_1413.sql', options: { preorderCardRange1413Migration: false },
    previousMaximum: 1400, maximum: 1413, newIds: [1409, 1410, 1411, 1412, 1413],
    reservedIds: [1401, 1402, 1403, 1404, 1405, 1406, 1407, 1408], statements: 10 },
] as const) {
  for (const mode of ['whole', 'remote split'] as const) {
    test(`${migration.name} preserves orders, claims and guards when applied ${mode}`, async (context) => {
      const { database, db } = createCommerceD1Harness(migration.options);
      context.after(() => database.close());
      const store = new PreorderStore(db);
      const config = getPreorderConfig('mi_note_cards_devnet')!;
      const reserve = (id: number): Promise<StoredPreorder> => store.reserve({
        orderId: `range-${id}`, preorderId: config.preorderId, cluster: config.cluster, collection: config.collection,
        buyer: `buyer-${id}`, ethereumAddress: '0x0000000000000000000000000000000000000001', requestId: `request-${id}`,
        cardIds: [id], assets: [{ id, address: `asset-${id}` }], status: 'prepared', expiresAtMs: 2000,
        signature: null, preparedTransaction: 'partial', signedTransaction: null, blockhash: 'hash',
        blockhashContextSlot: 1, lastValidBlockHeight: 100, createdAtMs: 1000, revision: 1,
      });
      await reserve(1);
      await store.submit(await reserve(2), { transactionBase64: 'signed-2', signature: 'signature-2' }, 1500);
      await store.finish(await store.submit(await reserve(migration.previousMaximum), {
        transactionBase64: `signed-${migration.previousMaximum}`, signature: `signature-${migration.previousMaximum}`,
      }, 1500), 'succeeded', 1600);
      const claims = () => database.prepare('SELECT * FROM commerce_preorder_claims ORDER BY card_id').all();
      const orders = () => database.prepare('SELECT * FROM commerce_preorder_orders ORDER BY order_id').all();
      const guards = () => database.prepare(`SELECT type, name, sql FROM sqlite_schema
        WHERE name GLOB 'commerce_preorder_*' AND type IN ('index', 'trigger') ORDER BY name`).all();
      const before = { claims: claims(), orders: orders(), guards: guards() };
      for (const id of migration.newIds) {
        await assert.rejects(reserve(id), /CHECK constraint/);
        assert.equal(await store.get(`range-${id}`), null);
      }
      const sql = readFileSync(new URL(`../cloud/workers/api/commerce-migrations/${migration.name}`, import.meta.url), 'utf8');
      assert.doesNotMatch(sql, /\bSELECT\s+CASE\b/i);
      if (mode === 'whole') database.exec(sql);
      else {
        const statements = unstable_splitSqlQuery(sql);
        assert.equal(statements.length, migration.statements);
        for (const statement of statements) database.prepare(statement).run();
      }
      assert.deepEqual({ claims: claims(), orders: orders(), guards: guards() }, before);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(database.prepare("SELECT strict FROM pragma_table_list WHERE name = 'commerce_preorder_claims'").get()!.strict, 1);
      for (const id of migration.newIds) await reserve(id);
      assert.deepEqual(claims().map((claim) => claim.card_id), [1, 2, migration.previousMaximum, ...migration.newIds]);
      for (const id of [0, ...migration.reservedIds, migration.maximum + 1]) {
        await assert.rejects(reserve(id), /CHECK constraint/);
        assert.equal(await store.get(`range-${id}`), null);
      }
      assert.throws(() => database.prepare('INSERT INTO commerce_preorder_claims VALUES (?, ?, ?, ?)')
        .run(config.cluster, config.collection, 3, 'range-1'), /invalid preorder claim/);
      assert.throws(() => database.exec('UPDATE commerce_preorder_claims SET card_id = 3 WHERE card_id = 1'), /immutable/);
      for (const id of [1, 2, migration.previousMaximum, migration.maximum]) {
        assert.throws(() => database.prepare('DELETE FROM commerce_preorder_claims WHERE card_id = ?').run(id), /permanent/);
      }
      await store.finish((await store.get(`range-${migration.maximum}`))!, 'cancelled', 1700);
      assert.equal(claims().some((claim) => claim.card_id === migration.maximum), false);
    });
  }
}

test('recent preorder inventory uses the buyer index without scanning or sorting order history', async (context) => {
  let query = '';
  const { database, db } = createCommerceD1Harness({ observeCall(call) {
    if (call.method === 'all') query = call.sql;
  } });
  context.after(() => database.close());
  assert.deepEqual(await listPreorderInventoryAssets(db, 'buyer'), []);
  assert.ok(query.includes('commerce_preorder_orders'));
  const plan = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all('buyer').map((row) => String(row.detail)).join('\n');
  assert.match(plan, /SEARCH commerce_preorder_orders USING INDEX commerce_preorder_(?:succeeded|inventory)_buyer/);
  assert.doesNotMatch(plan, /SCAN commerce_preorder_orders|TEMP B-TREE/);
});

test('expiry uses collection and order indexes without scanning permanent claims or history', async (context) => {
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
  await store.expirePrepared(config.cluster, config.collection, 5000);
  assert.equal(statements.length, 1);
  const expiryPlan = database.prepare(`EXPLAIN QUERY PLAN ${statements[0]}`)
    .all(5000, config.cluster, config.collection, 5000).map((row) => String(row.detail)).join('\n');
  const trigger = database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'commerce_preorder_expiry_claim_release'").get()!;
  const releaseSql = String(trigger.sql).match(/DELETE FROM commerce_preorder_claims[^;]+/)![0].replace('NEW.order_id', '?');
  const releasePlan = database.prepare(`EXPLAIN QUERY PLAN ${releaseSql}`)
    .all(due.orderId).map((row) => String(row.detail)).join('\n');
  const plans = [expiryPlan, releasePlan];
  assert.match(expiryPlan, /SEARCH commerce_preorder_orders USING (?:COVERING )?INDEX commerce_preorder_prepared_expiry \(cluster=\? AND collection=\? AND expires_at_ms<\?\)/);
  assert.match(releasePlan, /SEARCH commerce_preorder_claims USING (?:COVERING )?INDEX commerce_preorder_claim_order \(order_id=\?\)/);
  assert.ok(plans.every((plan) => !/SCAN commerce_preorder_(orders|claims)/.test(plan)));
  assert.equal((await store.get(due.orderId))!.status, 'expired');
  assert.equal((await store.get(submitted.orderId))!.status, 'submitted');
  assert.deepEqual((await store.claims(config.cluster, config.collection)).map((claim) => claim.id).sort(), [3, 4, 5]);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM commerce_preorder_orders').get()!.count, 5);
  const beforeRepeat = database.prepare('SELECT * FROM commerce_preorder_orders ORDER BY order_id').all();
  statements.length = 0;
  await store.expirePrepared(config.cluster, config.collection, 5000);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^UPDATE/);
  assert.deepEqual(database.prepare('SELECT * FROM commerce_preorder_orders ORDER BY order_id').all(), beforeRepeat);
});

test('selected preorder claims use the full card index and empty selections skip the database', async (context) => {
  const statements: string[] = [];
  const { database, db } = createCommerceD1Harness({ observeStatement(call) { statements.push(call.sql); } });
  context.after(() => database.close());
  const store = new PreorderStore(db);
  const config = getPreorderConfig('mi_note_cards_devnet')!;
  assert.deepEqual(await store.claims(config.cluster, config.collection, []), []);
  assert.equal(statements.length, 0);
  assert.deepEqual(await store.claims(config.cluster, config.collection, [1, 7, 1400]), []);
  const plan = database.prepare(`EXPLAIN QUERY PLAN ${statements[0]}`)
    .all(config.cluster, config.collection, 1, 7, 1400).map((row) => String(row.detail)).join('\n');
  assert.match(plan, /SEARCH claims USING INDEX .* \(cluster=\? AND collection=\? AND card_id=\?\)/);
  assert.doesNotMatch(plan, /SCAN (claims|orders)/);
});

for (const winner of ['submission', 'expiry'] as const) {
  test(`${winner} winning preserves the current order and its matching claim state`, async (context) => {
    const { database, db } = createCommerceD1Harness();
    context.after(() => database.close());
    const store = new PreorderStore(db);
    const order = await store.reserve(reservation(1));
    const submit = () => store.submit(order, { transactionBase64: 'signed', signature: 'signature' }, 1999);
    const expire = () => store.expirePrepared(order.cluster, order.collection, 2000);
    if (winner === 'submission') {
      await submit();
      await expire();
    } else {
      await expire();
      assert.equal((await submit()).status, 'expired');
    }
    const current = (await store.get(order.orderId))!;
    assert.equal(current.status, winner === 'submission' ? 'submitted' : 'expired');
    assert.equal(current.signature, winner === 'submission' ? 'signature' : null);
    assert.equal(current.revision, 2);
    assert.deepEqual((await store.claims(order.cluster, order.collection)).map((claim) => claim.id), winner === 'submission' ? [1] : []);
  });
}

for (const mode of ['whole', 'remote split'] as const) {
  test(`expiry claim release migration preserves existing rows and older cleanup when applied ${mode}`, async (context) => {
    const { database, db } = createCommerceD1Harness({ preorderExpiryClaimReleaseMigration: false });
    context.after(() => database.close());
    const store = new PreorderStore(db);
    const expired = await store.reserve(reservation(1));
    await store.reserve(reservation(2, { expiresAtMs: 3000 }));
    const submitted = await store.submit(await store.reserve(reservation(3)), { transactionBase64: 'signed', signature: 'signature' }, 1500);
    await store.finish(await store.submit(await store.reserve(reservation(4)), { transactionBase64: 'signed-4', signature: 'signature-4' }, 1500), 'succeeded', 1600);
    const snapshot = () => ({ orders: database.prepare('SELECT * FROM commerce_preorder_orders ORDER BY order_id').all(),
      claims: database.prepare('SELECT * FROM commerce_preorder_claims ORDER BY card_id').all() });
    const before = snapshot();
    const sql = readFileSync(new URL('../cloud/workers/api/commerce-migrations/0027_preorder_expiry_claim_release.sql', import.meta.url), 'utf8');
    if (mode === 'whole') database.exec(sql);
    else {
      const statements = unstable_splitSqlQuery(sql);
      assert.equal(statements.length, 1);
      for (const statement of statements) database.prepare(statement).run();
    }
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    const due = await db.prepare(`SELECT order_id FROM commerce_preorder_orders
      WHERE cluster = ? AND collection = ? AND status = 'prepared' AND expires_at_ms <= ?`)
      .bind(expired.cluster, expired.collection, 2000).all<{ order_id: string }>();
    const orderIds = JSON.stringify(due.results.map((row) => row.order_id));
    const legacyResult = await db.batch([
      db.prepare(`UPDATE commerce_preorder_orders SET status = 'expired', updated_at_ms = ?, revision = revision + 1
        WHERE order_id IN (SELECT value FROM json_each(?)) AND status = 'prepared' AND expires_at_ms <= ?`).bind(2000, orderIds, 2000),
      db.prepare(`DELETE FROM commerce_preorder_claims WHERE order_id IN (SELECT value FROM json_each(?)) AND EXISTS (
        SELECT 1 FROM commerce_preorder_orders WHERE order_id = commerce_preorder_claims.order_id
          AND status = 'expired' AND signature IS NULL)`).bind(orderIds),
    ]);
    assert.equal(legacyResult[1].meta.changes, 0);
    assert.equal((await store.get(expired.orderId))!.status, 'expired');
    assert.deepEqual(await store.get(submitted.orderId), submitted);
    assert.deepEqual((await store.claims(expired.cluster, expired.collection)).map((claim) => claim.id), [2, 3, 4]);
    await store.finish((await store.get('expiry-2'))!, 'expired', 3000);
    assert.deepEqual((await store.claims(expired.cluster, expired.collection)).map((claim) => claim.id), [3, 4]);
  });
}

test('expiry trigger releases only unsigned prepared transitions', async (context) => {
  const { database, db } = createCommerceD1Harness();
  context.after(() => database.close());
  const store = new PreorderStore(db);
  const order = await store.reserve(reservation(1));
  await store.reserve(reservation(2));
  const submitted = await store.submit(await store.reserve(reservation(3)), { transactionBase64: 'signed', signature: 'signature' }, 1500);
  database.prepare(`UPDATE commerce_preorder_orders SET status = 'expired', revision = revision + 1
    WHERE order_id = ?`).run(order.orderId);
  database.prepare(`UPDATE commerce_preorder_orders SET status = 'expired', signature = 'signed-expiry',
    signed_transaction = 'signed', revision = revision + 1 WHERE order_id = 'expiry-2'`).run();
  database.prepare(`UPDATE commerce_preorder_orders SET status = 'expired', revision = revision + 1
    WHERE order_id = ?`).run(submitted.orderId);
  assert.deepEqual((await store.claims(order.cluster, order.collection)).map((claim) => claim.id), [2, 3]);
});

test('expiry has no page limit and a claim failure rolls back the entire collection', async (context) => {
  const { database, db } = createCommerceD1Harness();
  context.after(() => database.close());
  const store = new PreorderStore(db);
  const orders = await Promise.all(Array.from({ length: 105 }, (_, index) => store.reserve(reservation(index + 1))));
  const snapshot = () => ({ orders: database.prepare('SELECT * FROM commerce_preorder_orders ORDER BY order_id').all(),
    claims: database.prepare('SELECT * FROM commerce_preorder_claims ORDER BY card_id').all() });
  const before = snapshot();
  database.exec(`CREATE TRIGGER expiry_cleanup_failure BEFORE DELETE ON commerce_preorder_claims
    WHEN OLD.card_id = 105 BEGIN SELECT RAISE(ABORT, 'forced claim deletion failure'); END`);
  await assert.rejects(store.expirePrepared(orders[0].cluster, orders[0].collection, 2000), /forced claim deletion failure/);
  assert.deepEqual(snapshot(), before);
  database.exec('DROP TRIGGER expiry_cleanup_failure');
  await store.expirePrepared(orders[0].cluster, orders[0].collection, 2000);
  assert.deepEqual(await store.claims(orders[0].cluster, orders[0].collection), []);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM commerce_preorder_orders WHERE status = 'expired' AND revision = 2").get()!.count, 105);
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
  database.exec(readFileSync(new URL('../cloud/workers/api/commerce-migrations/0022_preorder_confirmation.sql', import.meta.url), 'utf8'));
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
