import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { createTestHarness } from 'wrangler';
import { PreorderStore, type StoredPreorder } from '../src/preorderStore.ts';
import { getPreorderConfig } from '../../../../shared/preorders.ts';
import { recoverPreorder } from '../../../../scripts/ops/recoverPreorder.ts';

test('real D1 atomically claims preorders, fences submission and safely recovers verified outcomes', async () => {
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
      buyer, requestId: crypto.randomUUID(), cardIds: ids, assets: ids.map((id) => ({ id, address: `asset-${buyer}-${id}` })),
      status: 'prepared', preparedTransaction: 'partial', signedTransaction: null, signature: null,
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
      store.finish(winner, 'expired', 121_000),
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
    for (const [index, status] of (['expired', 'failed', 'confirmed'] as const).entries()) {
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
        probe: async () => ({ status }),
      };
      const preview = await recoverPreorder({ orderId: source.orderId, write: false }, dependencies);
      assert.equal(preview.verifiedOutcome, status);
      assert.deepEqual(await store.get(source.orderId), submitted);
      assert.ok((await store.claims(config.cluster, config.collection)).some((claim) => claim.orderId === source.orderId));
      const recovered = await recoverPreorder({ orderId: source.orderId, write: true }, dependencies);
      assert.equal(recovered.status, status === 'confirmed' ? 'succeeded' : status);
      const claimed = (await store.claims(config.cluster, config.collection)).some((claim) => claim.orderId === source.orderId);
      assert.equal(claimed, status === 'confirmed');
      if (status === 'confirmed') {
        await assert.rejects(store.reserve(candidate(Keypair.generate().publicKey.toBase58(), source.cardIds)), /already reserved/);
      } else {
        const replacement = await store.reserve(candidate(buyer, source.cardIds));
        assert.equal(replacement.status, 'prepared');
        await store.finish(replacement, 'cancelled', 3000);
      }
    }
  } finally {
    await server.close();
  }
});
