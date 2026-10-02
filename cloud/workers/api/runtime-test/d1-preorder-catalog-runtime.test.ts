import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { getPreorderConfig } from '../../../../shared/preorders.ts';
import { readCommerceMigrations, DEFAULT_COMMERCE_MIGRATIONS_DIRECTORY } from '../../../../scripts/shared/commerceMigrationReplay.ts';
import { PreorderStore, type StoredPreorder } from '../src/preorderStore.ts';

const BOOTSTRAP_CARD_IDS = [
  ...Array.from({ length: 1400 }, (_, index) => index + 1),
  ...Array.from({ length: 11 }, (_, index) => index + 1409),
];

test('real D1 upgrades populated preorder claims to the catalog atomically', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shop-preorder-catalog-runtime-'));
  const production = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const migrations = readCommerceMigrations();
  for (const migration of migrations.slice(0, 31)) {
    copyFileSync(join(DEFAULT_COMMERCE_MIGRATIONS_DIRECTORY, migration.name), join(directory, migration.name));
  }
  const runtime = {
    ...production,
    main: resolve('cloud/workers/api/src/index.ts'), routes: undefined,
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({ ...database,
      migrations_dir: database.binding === 'COMMERCE_DB' ? directory : resolve('cloud/workers/api', String(database.migrations_dir)) })),
  };
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
        VALUES (1, '00000000-0000-4000-8000-000000003201', CAST(strftime('%s', 'now') AS INTEGER) * 1000,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000)`),
      db.prepare(`UPDATE commerce_authority_control SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`),
      db.prepare(`UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`),
      db.prepare('DELETE FROM commerce_authority_control_lease WHERE singleton = 1'),
    ]);
    const store = new PreorderStore(db);
    const config = getPreorderConfig('mi_note_cards_devnet')!;
    const candidate = (id: number): StoredPreorder => ({
      orderId: `catalog-${id}`, preorderId: config.preorderId, cluster: config.cluster, collection: config.collection,
      buyer: `buyer-${id}`, ethereumAddress: '0x0000000000000000000000000000000000000001', requestId: `request-${id}`,
      cardIds: [id], assets: [{ id, address: `asset-${id}` }], status: 'prepared', preparedTransaction: 'partial',
      signedTransaction: null, signature: null, confirmedSlot: null, blockhash: 'blockhash', blockhashContextSlot: 1,
      lastValidBlockHeight: 100, expiresAtMs: 2000, createdAtMs: 1000, revision: 1,
    });
    await store.reserve(candidate(1));
    await store.submit(await store.reserve(candidate(1409)), { transactionBase64: 'signed-1409', signature: 'signature-1409' }, 1500);
    await store.finish(await store.submit(await store.reserve(candidate(1419)), {
      transactionBase64: 'signed-1419', signature: 'signature-1419',
    }, 1500), 'succeeded', 1600);
    await store.finish(await store.reserve(candidate(2)), 'cancelled', 1600);
    const snapshot = async () => (await db.batch([
      db.prepare('SELECT * FROM commerce_preorder_orders ORDER BY order_id'),
      db.prepare('SELECT * FROM commerce_preorder_claims ORDER BY card_id'),
      db.prepare('SELECT * FROM commerce_authority_control'),
      db.prepare(`SELECT type, name, sql FROM sqlite_schema
        WHERE name GLOB 'commerce_preorder_*' AND type IN ('index', 'trigger') ORDER BY name`),
    ])).map(({ results }) => results);
    const before = await snapshot();
    const migration = migrations.find(({ name }) => name === '0032_preorder_catalog.sql')!;
    writeFileSync(join(directory, migration.name), migration.sql.replace('(1419)', '(1420)'));
    await assert.rejects(worker.applyD1Migrations('COMMERCE_DB'), /FOREIGN KEY constraint/);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await db.prepare("SELECT name FROM sqlite_schema WHERE name = 'commerce_preorder_cards'").first(), null);
    assert.equal(await db.prepare('SELECT name FROM d1_migrations WHERE name = ?').bind(migration.name).first(), null);
    writeFileSync(join(directory, migration.name), migration.sql);
    await worker.applyD1Migrations('COMMERCE_DB');
    assert.deepEqual(await snapshot(), before);
    const cards = await db.prepare('SELECT card_id FROM commerce_preorder_cards ORDER BY card_id').all<{ card_id: number }>();
    assert.deepEqual(cards.results.map(({ card_id }) => card_id), BOOTSTRAP_CARD_IDS);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
    for (const id of [0, 1401, 1408, 1420]) {
      await assert.rejects(store.reserve(candidate(id)), /FOREIGN KEY constraint/);
      assert.equal(await store.get(`catalog-${id}`), null);
    }
    await store.expirePrepared(config.cluster, config.collection, 2000);
    assert.deepEqual((await store.claims(config.cluster, config.collection)).map(({ id }) => id), [1409, 1419]);
    await assert.rejects(db.prepare('DELETE FROM commerce_preorder_claims WHERE card_id = 1419').run(), /permanent/);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
