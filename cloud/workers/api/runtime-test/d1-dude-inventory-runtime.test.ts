import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { assignCommerceDudes } from '../src/commerceDudeAssignments.ts';
import { CommerceRepositoryError, D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';

const DROP_ID = 'inventory-runtime';
const GENERATION = '00000000-0000-4000-8000-000000000010';
const NEXT_GENERATION = '00000000-0000-4000-8000-000000000011';
const LEASE = '00000000-0000-4000-8000-000000000210';

async function pause(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`INSERT INTO commerce_authority_control_lease (
      singleton, lease_token, acquired_at_ms, expires_at_ms
    ) VALUES (1, ?, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000)`).bind(LEASE),
    db.prepare(`UPDATE commerce_authority_control
      SET authority_state = 'paused', revision = revision + 1, paused_at_ms = NULL,
        updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE singleton = 1 AND authority_state = 'd1'`),
    db.prepare(`UPDATE commerce_authority_control
      SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE singleton = 1 AND paused_at_ms IS NULL`),
  ]);
}

function resumeStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(`UPDATE commerce_authority_control
    SET authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
      updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1 AND authority_state = 'paused'`);
}

async function resume(db: D1Database): Promise<void> {
  await db.batch([
    resumeStatement(db),
    db.prepare('DELETE FROM commerce_authority_control_lease WHERE singleton = 1 AND lease_token = ?').bind(LEASE),
  ]);
}

function metadata(db: D1Database, generation = GENERATION, maxDudeId = 4): D1PreparedStatement {
  return db.prepare(`INSERT INTO commerce_inventory_drops (
    drop_id, generation, ready, drop_family, items_per_box, max_dude_id, initialized_at_ms
  ) VALUES (?, ?, 0, 'poncho_drifella', 1, ?, 100)`).bind(DROP_ID, generation, maxDudeId);
}

function marker(db: D1Database, id: number, box: string, generation?: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json,
    version, create_time, update_time
  ) VALUES (?, 'dude_assignment', ?, ?, ?, 1,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).bind(
    commerceKeys.dudeAssignment(DROP_ID, String(id)).path,
    DROP_ID,
    String(id),
    JSON.stringify({ dudeId: id, boxAssetId: box, ...(generation ? { inventoryGeneration: generation } : {}) }),
  );
}

async function available(db: D1Database): Promise<number[]> {
  const result = await db.prepare(`SELECT dude_id FROM commerce_available_dudes
    WHERE drop_id = ? ORDER BY pool_position`).bind(DROP_ID).all<{ dude_id: number }>();
  return result.results.map((row) => row.dude_id);
}

function inventoryRuntimeServer() {
  const productionConfig = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const runtimeConfig = {
    ...productionConfig,
    main: resolve('cloud/workers/api/src/index.ts'),
    routes: undefined,
    d1_databases: productionConfig.d1_databases.map((database: Record<string, unknown>) => ({
      ...database,
      migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)),
    })),
  };
  delete runtimeConfig.$schema;
  delete runtimeConfig.secrets;
  return createTestHarness({ root: resolve('.'), workers: [{ config: runtimeConfig }] });
}

test('native inventory activation, atomic claims, and legacy fences work in the D1 runtime', async () => {
  const server = inventoryRuntimeServer();
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    const { COMMERCE_DB: db } = await worker.getEnv();
    await pause(db);
    await resume(db);
    const repository = new D1CommerceRepository(db);
    const args = {
      dropFamily: 'poncho_drifella', dropId: DROP_ID, itemsPerBox: 1, maxDudeId: 4,
      boxAssetId: 'box', nowMs: 100, randomInt: () => 0,
      repository, signal: new AbortController().signal, sleep: async () => undefined,
    };
    await assert.rejects(assignCommerceDudes(args), CommerceRepositoryError);
    await repository.run(1, async (transaction) => {
      await transaction.create(commerceKeys.dudePool(DROP_ID), { available: [1, 2, 3, 4] });
    });
    await assert.rejects(metadata(db).run(), /maintenance is not ready/);
    await assert.rejects(db.prepare("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows'").run(),
      /maintenance is not ready/);

    await pause(db);
    await metadata(db).run();
    await assert.rejects(resumeStatement(db).run(), /initialization is incomplete/);
    await db.batch([1, 2, 3, 4].map((id) => db.prepare(`INSERT INTO commerce_available_dudes
      (drop_id, dude_id, pool_position) VALUES (?, ?, ?)`).bind(DROP_ID, id, id - 1)));
    await db.batch([
      db.prepare('UPDATE commerce_inventory_drops SET ready = 1 WHERE drop_id = ?').bind(DROP_ID),
      db.prepare("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1"),
    ]);
    await resume(db);

    assert.deepEqual(await assignCommerceDudes(args), { dudeIds: [1], outcome: 'created' });
    assert.deepEqual(await assignCommerceDudes(args), { dudeIds: [1], outcome: 'existing' });
    assert.deepEqual(await available(db), [2, 3, 4]);
    await assert.rejects(repository.run(100, async (transaction) => {
      await transaction.set(commerceKeys.dudePool(DROP_ID), { available: [2, 3] });
    }), /legacy commerce inventory writes are disabled/);
    await assert.rejects(marker(db, 2, 'old-worker').run(), /commerce transaction conflict/);
    await assert.rejects(marker(db, 2, 'stale-worker', NEXT_GENERATION).run(), /commerce transaction conflict/);
    await assert.rejects(db.batch([
      marker(db, 2, 'partial-box', GENERATION),
      marker(db, 3, 'partial-box'),
    ]), /commerce transaction conflict/);
    assert.deepEqual(await available(db), [2, 3, 4]);
    assert.equal(await repository.get(commerceKeys.dudeAssignment(DROP_ID, '2')), null);
    await assert.rejects(db.prepare(`UPDATE commerce_documents
      SET document_json = json_set(document_json, '$.boxAssetId', 'replacement'), version = version + 1
      WHERE document_kind = 'dude_assignment'`).run(), /ownership is immutable/);
    await assert.rejects(db.prepare('DELETE FROM commerce_available_dudes WHERE dude_id = 2').run(),
      /removal requires an assignment/);
    await assert.rejects(db.prepare('DELETE FROM commerce_inventory_drops').run(), /maintenance is not ready/);

    await pause(db);
    await db.prepare('DELETE FROM commerce_inventory_drops WHERE drop_id = ?').bind(DROP_ID).run();
    await metadata(db, NEXT_GENERATION).run();
    await db.batch([2, 3, 4].map((id) => db.prepare(`INSERT INTO commerce_available_dudes
      (drop_id, dude_id, pool_position) VALUES (?, ?, ?)`).bind(DROP_ID, id, id - 1)));
    await db.prepare('UPDATE commerce_inventory_drops SET ready = 1 WHERE drop_id = ?').bind(DROP_ID).run();
    await assert.rejects(db.prepare("UPDATE commerce_authority_control SET dude_inventory_mode = 'legacy'").run(),
      /cannot move backward/);
    await resume(db);
    await assert.rejects(marker(db, 2, 'stale-attempt', GENERATION).run(), /commerce transaction conflict/);
    assert.deepEqual(await assignCommerceDudes({ ...args, boxAssetId: 'second-box' }),
      { dudeIds: [2], outcome: 'created' });
    assert.deepEqual(await available(db), [3, 4]);

    await pause(db);
    await db.batch([
      db.prepare('DELETE FROM commerce_inventory_drops WHERE drop_id = ?').bind(DROP_ID),
      db.prepare('DELETE FROM commerce_documents WHERE drop_id = ?').bind(DROP_ID),
      db.prepare(`UPDATE commerce_authority_control SET documents_revision = documents_revision + 1
        WHERE singleton = 1`),
    ]);
    await resume(db);
    assert.deepEqual(await available(db), []);
    await assert.rejects(assignCommerceDudes({ ...args, boxAssetId: 'after-wipe' }), CommerceRepositoryError);
    await assert.rejects(repository.run(100, async (transaction) => {
      await transaction.create(commerceKeys.dudePool(DROP_ID), { available: [1, 2, 3, 4] });
    }), /legacy commerce inventory writes are disabled/);
    await assert.rejects(marker(db, 1, 'old-after-wipe').run(), /commerce transaction conflict/);
  } finally {
    await server.close();
  }
});

test('inventory guards bound assignment reads during backfill and allocation', async () => {
  const inventorySize = 1000;
  const server = inventoryRuntimeServer();
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    const { COMMERCE_DB: db } = await worker.getEnv();
    await pause(db);
    await resume(db);
    await db.batch([
      db.prepare(`INSERT INTO commerce_documents (
        document_path, document_kind, drop_id, document_id, document_json,
        version, create_time, update_time
      ) WITH RECURSIVE ids(dude_id) AS (
        SELECT ? UNION ALL SELECT dude_id + 1 FROM ids WHERE dude_id < ?
      ) SELECT ? || dude_id, 'dude_assignment', ?, CAST(dude_id AS TEXT),
        json_object('dudeId', dude_id, 'boxAssetId', 'legacy-box-' || dude_id),
        1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        FROM ids`).bind(inventorySize + 1, inventorySize * 2, `drops/${DROP_ID}/dudeAssignments/`, DROP_ID),
      db.prepare(`UPDATE commerce_authority_control SET documents_revision = documents_revision + 1
        WHERE singleton = 1`),
    ]);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM commerce_documents
      WHERE document_kind = 'dude_assignment' AND drop_id = ?`)
      .bind(DROP_ID).first<{ count: number }>())?.count, inventorySize);

    await pause(db);
    await metadata(db, GENERATION, inventorySize * 2).run();
    const backfill = await db.prepare(`INSERT INTO commerce_available_dudes (
      drop_id, dude_id, pool_position
    ) WITH RECURSIVE ids(dude_id) AS (
      SELECT 1 UNION ALL SELECT dude_id + 1 FROM ids WHERE dude_id < ?
    ) SELECT ?, dude_id, dude_id - 1 FROM ids`).bind(inventorySize, DROP_ID).run();
    assert.equal(backfill.meta.changes, inventorySize);
    assert.ok(backfill.meta.rows_read <= inventorySize * 10,
      `Backfill read ${backfill.meta.rows_read} rows for ${inventorySize} available figures.`);
    const expectedAvailable = Array.from({ length: inventorySize }, (_, index) => index + 1);
    assert.deepEqual(await available(db), expectedAvailable);
    await db.batch([
      db.prepare('UPDATE commerce_inventory_drops SET ready = 1 WHERE drop_id = ?').bind(DROP_ID),
      db.prepare("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1"),
    ]);
    await resume(db);

    const dudeId = inventorySize - 1;
    const allocation = await marker(db, dudeId, 'new-box', GENERATION).run();
    assert.ok(allocation.meta.rows_read <= 64,
      `Allocating one figure read ${allocation.meta.rows_read} rows.`);
    assert.deepEqual(await available(db), expectedAvailable.filter((id) => id !== dudeId));
    const repository = new D1CommerceRepository(db);
    assert.deepEqual((await repository.get(commerceKeys.dudeAssignment(DROP_ID, String(dudeId))))?.data,
      { dudeId, boxAssetId: 'new-box', inventoryGeneration: GENERATION });
  } finally {
    await server.close();
  }
});
