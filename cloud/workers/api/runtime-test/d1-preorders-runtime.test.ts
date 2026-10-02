import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { createTestHarness } from 'wrangler';
import { PreorderStore, publicPreorder, type StoredPreorder } from '../src/preorderStore.ts';
import { getPreorderConfig } from '../../../../shared/preorders.ts';
import { recoverPreorder } from '../../../../scripts/ops/recoverPreorder.ts';

test('real D1 atomically claims preorders, fences submission and safely recovers verified outcomes', async (t) => {
  const production = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const runtime = { ...production, main: resolve('cloud/workers/api/src/index.ts'), routes: undefined,
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({ ...database,
      migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)) })) };
  delete runtime.$schema;
  delete runtime.secrets;
  const server = createTestHarness({ root: resolve('.'), workers: [{ config: runtime }] });
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    const { COMMERCE_DB: db } = await worker.getEnv();
    await db.batch([
      db.prepare(`INSERT INTO commerce_authority_control_lease (singleton, lease_token, acquired_at_ms, expires_at_ms)
        VALUES (1, '00000000-0000-4000-8000-000000001801', CAST(strftime('%s', 'now') AS INTEGER) * 1000,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000)`),
      db.prepare(`UPDATE commerce_authority_control SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`),
      db.prepare(`UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`),
      db.prepare('DELETE FROM commerce_authority_control_lease WHERE singleton = 1'),
    ]);
    const store = new PreorderStore(db);
    const config = getPreorderConfig('mi_note_cards_devnet')!;
    const candidate = (buyer: string, ids: number[]): StoredPreorder => ({
      orderId: crypto.randomUUID(), preorderId: config.preorderId, cluster: config.cluster, collection: config.collection,
      buyer, ethereumAddress: '0x0000000000000000000000000000000000000001', requestId: crypto.randomUUID(), cardIds: ids, assets: ids.map((id) => ({ id, address: `asset-${buyer}-${id}` })),
      status: 'prepared', preparedTransaction: 'partial', signedTransaction: null, signature: null, confirmedSlot: null,
      blockhash: 'blockhash', blockhashContextSlot: 1, lastValidBlockHeight: 100,
      expiresAtMs: 121_000, createdAtMs: 1000, revision: 1,
    });
    const left = candidate('left', [1, 2]);
    const right = candidate('right', [2, 3]);
    const results = await Promise.allSettled([store.reserve(left), store.reserve(right)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const winner = results[0].status === 'fulfilled' ? left : right;
    assert.equal((await store.claims(config.cluster, config.collection)).length, 2);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM commerce_preorder_orders').first<{ count: number }>())!.count, 1);
    await Promise.all([
      store.submit(winner, { transactionBase64: 'authorized', signature: 'signature' }, 2000),
      store.expirePrepared(config.cluster, config.collection, 121_000),
    ]);
    const raced = (await store.get(winner.orderId))!;
    assert.ok(raced.status === 'submitted' || raced.status === 'expired');
    assert.equal((await store.claims(config.cluster, config.collection)).length, raced.status === 'submitted' ? 2 : 0);
    if (raced.status === 'submitted') {
      const succeeded = await store.finish(raced, 'succeeded', 130_000);
      assert.equal(succeeded.status, 'succeeded');
      await assert.rejects(db.prepare('DELETE FROM commerce_preorder_claims WHERE order_id = ?').bind(winner.orderId).run(), /permanent/);
    }
    await assert.rejects(db.prepare('DELETE FROM commerce_preorder_orders WHERE order_id = ?').bind(winner.orderId).run(), /permanent/);
    const repeatBuyer = Keypair.generate().publicKey.toBase58();
    const early = await store.reserve(candidate(repeatBuyer, [20]));
    const submittedEarly = await store.submit(early, { transactionBase64: 'signed-early', signature: 'signature-early' }, 2000);
    const confirmedEarly = await store.confirm(submittedEarly, 550, 3000);
    assert.equal(confirmedEarly.status, 'submitted');
    assert.equal(confirmedEarly.confirmedSlot, 550);
    assert.equal(await store.active(config.preorderId, repeatBuyer), null);
    const nextOrders = await Promise.allSettled([
      store.reserve(candidate(repeatBuyer, [21])), store.reserve(candidate(repeatBuyer, [22])),
    ]);
    assert.equal(nextOrders.filter((result) => result.status === 'fulfilled').length, 1);
    const nextOrder = nextOrders.find((result) => result.status === 'fulfilled');
    assert.ok(nextOrder?.status === 'fulfilled');
    const discovery = await store.recoveries(config.preorderId, repeatBuyer);
    assert.deepEqual(discovery.foreground, publicPreorder(nextOrder.value));
    assert.deepEqual(discovery.orders, [publicPreorder(confirmedEarly)]);
    assert.equal(discovery.nextCursor, null);
    const discoveryBuyer = Keypair.generate().publicKey.toBase58();
    const discoveryPrepared = await store.reserve(candidate(discoveryBuyer, [24]));
    const discoverySubmitted = await store.submit(discoveryPrepared, { transactionBase64: 'signed-discovery', signature: 'signature-discovery' }, 2000);
    const [snapshot] = await Promise.all([
      store.recoveries(config.preorderId, discoveryBuyer),
      store.confirm(discoverySubmitted, 580, 3000),
    ]);
    assert.deepEqual([...(snapshot.foreground ? [snapshot.foreground] : []), ...snapshot.orders].map(order => order.orderId), [discoveryPrepared.orderId]);
    assert.equal(snapshot.foreground ? snapshot.foreground.confirmedSlot : snapshot.orders[0]?.confirmedSlot, snapshot.foreground ? null : 580);
    assert.equal((await store.get(discoveryPrepared.orderId))?.confirmedSlot, 580);
    await assert.rejects(store.reserve(candidate(Keypair.generate().publicKey.toBase58(), [20])), /already reserved/);
    const staleExpiry = await store.finish(submittedEarly, 'expired', 4000);
    assert.equal(staleExpiry.status, 'submitted');
    assert.equal(staleExpiry.confirmedSlot, 550);
    const finalizedEarly = await store.finish(confirmedEarly, 'succeeded', 5000, 560);
    assert.equal(finalizedEarly.confirmedSlot, 560);
    assert.deepEqual(await store.confirm(submittedEarly, 570, 6000), finalizedEarly);
    await assert.rejects(db.prepare('DELETE FROM commerce_preorder_claims WHERE order_id = ?').bind(early.orderId).run(), /permanent/);
    for (const [index, status] of (['expired', 'failed', 'finalized'] as const).entries()) {
      const buyer = Keypair.generate().publicKey.toBase58();
      const source = candidate(buyer, [10 + index]);
      source.assets = source.cardIds.map((id) => ({ id, address: Keypair.generate().publicKey.toBase58() }));
      await store.reserve(source);
      const submitted = await store.submit(source, {
        transactionBase64: Buffer.from(`signed-transaction-${index}`).toString('base64'),
        signature: bs58.encode(new Uint8Array(64).fill(index + 1)),
      }, 2000);
      const dependencies = {
        query: async (sql: string) => (await db.prepare(sql).all<Record<string, unknown>>()).results,
        probe: async () => ({ status, slot: 120 }),
      };
      const preview = await recoverPreorder({ orderId: source.orderId, write: false }, dependencies);
      assert.equal(preview.verifiedOutcome, status);
      assert.deepEqual(await store.get(source.orderId), submitted);
      assert.ok((await store.claims(config.cluster, config.collection)).some((claim) => claim.orderId === source.orderId));
      const recovered = await recoverPreorder({ orderId: source.orderId, write: true }, dependencies);
      assert.equal(recovered.status, status === 'finalized' ? 'succeeded' : status);
      const claimed = (await store.claims(config.cluster, config.collection)).some((claim) => claim.orderId === source.orderId);
      assert.equal(claimed, status === 'finalized');
      if (status === 'finalized') {
        await assert.rejects(store.reserve(candidate(Keypair.generate().publicKey.toBase58(), source.cardIds)), /already reserved/);
      } else {
        const replacement = await store.reserve(candidate(buyer, source.cardIds));
        assert.equal(replacement.status, 'prepared');
        await store.finish(replacement, 'cancelled', 3000);
      }
    }
    const newCardIds = [1398, 1399, 1400, 1409, 1410, 1411, 1412, 1413, 1414, 1415, 1416, 1417, 1418, 1419];
    const newOrders: StoredPreorder[] = [];
    for (let index = 0; index < newCardIds.length; index += 3) {
      newOrders.push(await store.reserve(candidate(Keypair.generate().publicKey.toBase58(), newCardIds.slice(index, index + 3))));
    }
    assert.deepEqual((await store.claims(config.cluster, config.collection))
      .filter((claim) => newOrders.some((order) => order.orderId === claim.orderId)).map((claim) => claim.id), newCardIds);
    for (const id of [0, 1401, 1402, 1403, 1404, 1405, 1406, 1407, 1408, 1420]) {
      const invalid = candidate(Keypair.generate().publicKey.toBase58(), [id]);
      await assert.rejects(store.reserve(invalid), /CHECK constraint/);
      assert.equal(await store.get(invalid.orderId), null);
    }
    await assert.rejects(db.prepare('UPDATE commerce_preorder_claims SET card_id = 100 WHERE card_id = 1400').run(), /immutable/);
    await assert.rejects(db.prepare('DELETE FROM commerce_preorder_claims WHERE card_id = 1400').run(), /permanent/);
    for (const order of newOrders) await store.finish(order, 'cancelled', 3000);
    assert.equal((await store.claims(config.cluster, config.collection)).some((claim) => claim.id >= 1398), false);

    await t.test('expiry releases only scoped expired preparations and selected claims stay accurate', async () => {
      const collection = `${config.collection}-expiry`;
      const source = (buyer: string, id: number) => ({ ...candidate(buyer, [id]), collection });
      const expired = await store.reserve(source('expired', 30));
      const fresh = await store.reserve({ ...source('fresh', 31), expiresAtMs: 121_001 });
      const otherCollection = await store.reserve({ ...source('other-collection', 30), collection: `${collection}-other` });
      const otherCluster = await store.reserve({ ...source('other-cluster', 30), cluster: 'mainnet-beta' });
      const submitted = await store.submit(await store.reserve(source('submitted', 32)),
        { transactionBase64: 'signed-submitted', signature: 'signature-submitted' }, 2000);
      const confirmed = await store.confirm(await store.submit(await store.reserve(source('confirmed', 33)),
        { transactionBase64: 'signed-confirmed', signature: 'signature-confirmed' }, 2000), 600, 3000);
      const succeeded = await store.finish(await store.submit(await store.reserve(source('succeeded', 34)),
        { transactionBase64: 'signed-succeeded', signature: 'signature-succeeded' }, 2000), 'succeeded', 3000);
      const untouched = await Promise.all([fresh, otherCollection, otherCluster, submitted, confirmed, succeeded]
        .map(order => store.get(order.orderId)));

      await store.expirePrepared(config.cluster, collection, 120_999);
      assert.deepEqual(await store.get(expired.orderId), expired);
      await store.expirePrepared(config.cluster, collection, 121_000);

      assert.equal((await store.get(expired.orderId))?.status, 'expired');
      const expiredState = await store.get(expired.orderId);
      await store.expirePrepared(config.cluster, collection, 121_000);
      assert.deepEqual(await store.get(expired.orderId), expiredState);
      for (const order of untouched) {
        assert.deepEqual(await store.get(order!.orderId), order);
        assert.equal((await store.claims(order!.cluster, order!.collection, order!.cardIds))[0]?.orderId, order!.orderId);
      }
      assert.deepEqual(await store.claims(config.cluster, collection, []), []);
      assert.deepEqual(await store.claims(config.cluster, collection, [30, 99]), []);
      assert.deepEqual((await store.claims(config.cluster, collection, [31, 33, 34]))
        .map(({ id, status }) => ({ id, status })).sort((a, b) => a.id - b.id), [
        { id: 31, status: 'reserved' }, { id: 33, status: 'preordered' }, { id: 34, status: 'preordered' },
      ]);
      const replacement = await store.reserve({ ...source(expired.buyer, 30), expiresAtMs: 121_001 });
      assert.equal((await store.claims(config.cluster, collection, [30]))[0]?.orderId, replacement.orderId);
    });

    await t.test('claim deletion failure rolls back every expired preparation', async () => {
      const collection = `${config.collection}-rollback`;
      const orders = await Promise.all([40, 41].map(id => store.reserve({ ...candidate(`rollback-${id}`, [id]), collection })));
      const before = await Promise.all(orders.map(order => store.get(order.orderId)));
      const claimsBefore = await store.claims(config.cluster, collection);
      await db.prepare(`CREATE TRIGGER preorder_cleanup_failure BEFORE DELETE ON commerce_preorder_claims
        WHEN OLD.card_id = 41 BEGIN SELECT RAISE(ABORT, 'forced claim deletion failure'); END`).run();
      try {
        await assert.rejects(store.expirePrepared(config.cluster, collection, 121_000), /forced claim deletion failure/);
        assert.deepEqual(await Promise.all(orders.map(order => store.get(order.orderId))), before);
        assert.deepEqual(await store.claims(config.cluster, collection), claimsBefore);
      } finally {
        await db.prepare('DROP TRIGGER preorder_cleanup_failure').run();
      }
      await store.expirePrepared(config.cluster, collection, 121_000);
      assert.deepEqual(await store.claims(config.cluster, collection), []);
    });

    await t.test('new expiry trigger remains compatible with previous API cleanup', async () => {
      const collection = `${config.collection}-legacy-cleanup`;
      const expired = await store.reserve({ ...candidate('legacy-expired', [50]), collection });
      const fresh = await store.reserve({ ...candidate('legacy-fresh', [51]), collection, expiresAtMs: 121_001 });
      const submitted = await store.submit(await store.reserve({ ...candidate('legacy-submitted', [52]), collection }),
        { transactionBase64: 'legacy-signed', signature: 'legacy-signature' }, 2000);
      const ids = JSON.stringify([expired.orderId, fresh.orderId, submitted.orderId]);
      const results = await db.batch([
        db.prepare(`UPDATE commerce_preorder_orders SET status = 'expired', updated_at_ms = ?, revision = revision + 1
          WHERE order_id IN (SELECT value FROM json_each(?)) AND status = 'prepared' AND expires_at_ms <= ?`)
          .bind(121_000, ids, 121_000),
        db.prepare(`DELETE FROM commerce_preorder_claims WHERE order_id IN (SELECT value FROM json_each(?)) AND EXISTS (
          SELECT 1 FROM commerce_preorder_orders WHERE order_id = commerce_preorder_claims.order_id
            AND status = 'expired' AND signature IS NULL)`).bind(ids),
      ]);
      assert.equal(results[1].meta.changes, 0);
      assert.equal((await store.get(expired.orderId))?.status, 'expired');
      assert.deepEqual(await store.get(fresh.orderId), fresh);
      assert.deepEqual(await store.get(submitted.orderId), submitted);
      assert.deepEqual((await store.claims(config.cluster, collection)).map(({ id }) => id), [51, 52]);
    });

    await t.test('commerce pause prevents expiry and claim release', async () => {
      const collection = `${config.collection}-paused-expiry`;
      const order = await store.reserve({ ...candidate('paused-expiry', [60]), collection });
      await db.batch([
        db.prepare(`INSERT INTO commerce_authority_control_lease (singleton, lease_token, acquired_at_ms, expires_at_ms)
          VALUES (1, '00000000-0000-4000-8000-000000000027', CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000)`),
        db.prepare(`UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
          paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`),
      ]);
      await assert.rejects(store.expirePrepared(config.cluster, collection, 121_000), /authority is not d1/);
      assert.deepEqual(await store.get(order.orderId), order);
      assert.equal((await store.claims(config.cluster, collection))[0]?.orderId, order.orderId);
    });
  } finally {
    await server.close();
  }
});
