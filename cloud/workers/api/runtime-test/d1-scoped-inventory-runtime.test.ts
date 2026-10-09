import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { assignCommerceDudes } from '../src/commerceDudeAssignments.ts';
import { D1CommerceRepository } from '../src/commerceRepository.ts';

const LEASE = '00000000-0000-4000-8000-000000000036';
const GENERATION = '00000000-0000-4000-8000-000000001036';
const NEW_DROP = 'mi_note_cards_devnet_runtime';
const NOW = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

function runtimeServer() {
  const productionConfig = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const config = {
    ...productionConfig, main: resolve('cloud/workers/api/src/index.ts'), routes: undefined,
    d1_databases: productionConfig.d1_databases.map((database: Record<string, unknown>) => ({
      ...database, migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)),
    })),
  };
  delete config.$schema;
  delete config.secrets;
  return createTestHarness({ root: resolve('.'), workers: [{ config }] });
}

function initialization(db: D1Database, revision: number, token = LEASE) {
  return db.prepare(`INSERT INTO commerce_inventory_initializations (
    drop_id, generation, lease_token, authority_revision, manifest_sha256, catalog_sha256, preorder_snapshot_sha256,
    source_preorder_id, source_cluster, source_collection, drop_family, items_per_box, pack_count, max_dude_id,
    excluded_card_ids_json, eligible_card_ids_json, created_at_ms, completed_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'mi_note_cards_devnet', 'devnet',
    '65JF5n29WqB5Z7YsHQXLAPvgsytHRZDixKzqSq2D1RMv', 'mi_note_cards', 2, 2, 1430, '[]', '[2,3,1401,1430]', ${NOW}, NULL)`)
    .bind(NEW_DROP, GENERATION, token, revision, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64));
}

test('D1 atomically initializes new sparse inventory while another drop keeps assigning cards', async () => {
  const server = runtimeServer();
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    const { COMMERCE_DB: db } = await worker.getEnv();
    await db.batch([
      db.prepare(`INSERT INTO commerce_authority_control_lease VALUES (1, ?, ${NOW}, ${NOW} + 60000)`).bind(LEASE),
      db.prepare(`UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = ${NOW} WHERE authority_state = 'd1'`),
      db.prepare(`UPDATE commerce_authority_control SET paused_at_ms = ${NOW}, updated_at_ms = ${NOW} WHERE paused_at_ms IS NULL`),
      db.prepare(`INSERT INTO commerce_inventory_drops VALUES ('mainnet-live', ?, 0, 'poncho_drifella', 1, 4, ${NOW})`).bind(GENERATION),
      db.prepare("INSERT INTO commerce_available_dudes VALUES ('mainnet-live', 1, 0), ('mainnet-live', 2, 1), ('mainnet-live', 3, 2), ('mainnet-live', 4, 3)"),
      db.prepare("UPDATE commerce_inventory_drops SET ready = 1 WHERE drop_id = 'mainnet-live'"),
      db.prepare("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows'"),
      db.prepare(`UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = ${NOW}`),
    ]);
    const before = await db.prepare('SELECT * FROM commerce_authority_control').first<Record<string, unknown>>();
    const revision = Number(before!.revision);
    await assert.rejects(initialization(db, revision, '00000000-0000-4000-8000-000000000999').run(), /coordination lease/);
    await db.prepare(`CREATE TRIGGER scoped_inventory_test_failure BEFORE INSERT ON commerce_available_dudes
      WHEN NEW.drop_id = '${NEW_DROP}' AND NEW.dude_id = 1430
      BEGIN SELECT RAISE(ABORT, 'injected final-card failure'); END`).run();
    await assert.rejects(initialization(db, revision).run(), /injected final-card failure/);
    for (const table of ['commerce_inventory_initializations', 'commerce_inventory_drops', 'commerce_available_dudes']) {
      assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE drop_id = ?`).bind(NEW_DROP).first<{ count: number }>())!.count, 0);
    }
    await db.prepare('DROP TRIGGER scoped_inventory_test_failure').run();
    await initialization(db, revision).run();
    const inventory = await db.prepare('SELECT * FROM commerce_inventory_drops WHERE drop_id = ?').bind(NEW_DROP).first<Record<string, unknown>>();
    assert.equal(inventory!.ready, 1);
    assert.equal(inventory!.max_dude_id, 1430);
    const initialized = await db.prepare('SELECT completed_at_ms FROM commerce_inventory_initializations WHERE drop_id = ?')
      .bind(NEW_DROP).first<{ completed_at_ms: number }>();
    assert.ok(Number.isSafeInteger(initialized!.completed_at_ms));
    assert.deepEqual(await db.prepare('SELECT * FROM commerce_authority_control').first(), before);

    const repository = new D1CommerceRepository(db);
    const common = { nowMs: 100, randomInt: () => 0, repository, signal: new AbortController().signal, sleep: async () => undefined };
    assert.deepEqual(await assignCommerceDudes({ ...common, dropId: 'mainnet-live', dropFamily: 'poncho_drifella',
      itemsPerBox: 1, maxDudeId: 4, boxAssetId: 'mainnet-box' }), { dudeIds: [1], outcome: 'created' });
    assert.equal((await db.prepare('SELECT authority_state FROM commerce_authority_control').first<{ authority_state: string }>())!.authority_state, 'd1');
    await assert.rejects(db.prepare('DELETE FROM commerce_available_dudes WHERE drop_id = ? AND dude_id = 2').bind(NEW_DROP).run(),
      /removal requires an assignment/);
    await assert.rejects(db.prepare('UPDATE commerce_inventory_initializations SET completed_at_ms = NULL WHERE drop_id = ?').bind(NEW_DROP).run(),
      /immutable/);
    await assert.rejects(db.prepare('INSERT INTO commerce_available_dudes VALUES (?, 1, 4)').bind(NEW_DROP).run(), /maintenance is not ready/);

    const args = { ...common, dropId: NEW_DROP, dropFamily: 'mi_note_cards', itemsPerBox: 2, maxDudeId: 1430,
      inventoryManifest: { sha256: 'a'.repeat(64), cardIds: [2, 3, 1401, 1430] } };
    const first = await assignCommerceDudes({ ...args, boxAssetId: 'devnet-box-1' });
    const second = await assignCommerceDudes({ ...args, boxAssetId: 'devnet-box-2' });
    assert.deepEqual([...first.dudeIds, ...second.dudeIds], [2, 3, 1401, 1430]);
    await assert.rejects(assignCommerceDudes({ ...args, boxAssetId: 'devnet-box-3' }), /No figures remaining/);
    await assert.rejects(initialization(db, revision).run(), /new drop without public commerce history/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM commerce_available_dudes WHERE drop_id = ?')
      .bind(NEW_DROP).first<{ count: number }>())!.count, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM commerce_preorder_orders').first<{ count: number }>())!.count, 0);
  } finally {
    await server.close();
  }
});
