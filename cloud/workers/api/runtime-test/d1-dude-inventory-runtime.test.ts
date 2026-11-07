import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { assignCommerceDudes } from '../src/commerceDudeAssignments.ts';
import { CommerceRepositoryError, D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import { pickDudeIdsForAssignment } from '../../../../shared/assignDudesPicker.ts';
import { CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS, CARD_NFT_2_COMMON_CARD_IDS } from '../../../../shared/cardNft2RevealIds.ts';
import { CARD_NFT_2_MAX_CARD_ID } from '../../../../shared/cardNft2AssetCore.ts';

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
  delete runtimeConfig.services;
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

test('D1 compact snapshots preserve pool order for rarity selection in one batch', async () => {
  const server = inventoryRuntimeServer();
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    const { COMMERCE_DB: db } = await worker.getEnv();
    await pause(db);
    const pool = [CARD_NFT_2_COMMON_CARD_IDS[1], CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS[0],
      CARD_NFT_2_COMMON_CARD_IDS[0], CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS[1]];
    await db.batch([
      db.prepare(`INSERT INTO commerce_inventory_drops (drop_id, generation, ready, drop_family, items_per_box, max_dude_id, initialized_at_ms)
        VALUES (?, ?, 0, 'card_nft_2', 3, ?, 100)`).bind(DROP_ID, GENERATION, CARD_NFT_2_MAX_CARD_ID),
      ...pool.map((id, index) => db.prepare('INSERT INTO commerce_available_dudes VALUES (?, ?, ?)').bind(DROP_ID, id, index)),
      db.prepare('UPDATE commerce_inventory_drops SET ready = 1 WHERE drop_id = ?').bind(DROP_ID),
      db.prepare("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1"),
    ]);
    await resume(db);
    let inventoryRows = 0;
    let inventoryBatches = 0;
    const sampledDb = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          inventoryBatches++;
          const results = await target.batch<Record<string, unknown>>(statements);
          for (const result of results) {
            assert.ok(result.results.length <= 1);
            assert.ok(result.results.every(row => !Object.hasOwn(row, 'dude_id') && !Object.hasOwn(row, 'pool_position')));
            inventoryRows += result.results.length;
          }
          return results;
        };
        return Reflect.get(target, property, target);
      },
    });
    const repository = new D1CommerceRepository(sampledDb);
    const randomInt = (maximum: number) => maximum - 1;
    const config = { dropId: DROP_ID, dropFamily: 'card_nft_2', itemsPerBox: 3, maxDudeId: CARD_NFT_2_MAX_CARD_ID };
    const sampled = await repository.getDudeInventory(config);
    assert.deepEqual(sampled.pool, pool);
    const actual = await pickDudeIdsForAssignment({ ...config, pool: sampled.pool, randomInt, isAssigned: () => false });
    const expected = await pickDudeIdsForAssignment({ ...config, pool: [...pool], randomInt, isAssigned: () => false });
    assert.deepEqual(actual, expected);
    assert.equal(inventoryRows, 3);
    assert.equal(inventoryBatches, 1);
  } finally {
    await server.close();
  }
});

test('native D1 snapshots tolerate disjoint assignments after loading and before commit', async () => {
  const server = inventoryRuntimeServer();
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    const { COMMERCE_DB: db } = await worker.getEnv();
    await pause(db);
    await db.batch([
      db.prepare(`INSERT INTO commerce_inventory_drops (drop_id, generation, ready, drop_family, items_per_box, max_dude_id, initialized_at_ms)
        VALUES (?, ?, 0, 'clear_cards', 3, 100, 100)`).bind(DROP_ID, GENERATION),
      ...Array.from({ length: 100 }, (_, index) => db.prepare('INSERT INTO commerce_available_dudes VALUES (?, ?, ?)')
        .bind(DROP_ID, index + 1, index)),
      db.prepare('UPDATE commerce_inventory_drops SET ready = 1 WHERE drop_id = ?').bind(DROP_ID),
      db.prepare("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1"),
    ]);
    await resume(db);
    const repository = new D1CommerceRepository(db);
    const competitor = new D1CommerceRepository(db);
    const config = { dropId: DROP_ID, dropFamily: 'clear_cards', itemsPerBox: 3, maxDudeId: 100,
      nowMs: 100, signal: new AbortController().signal };
    let competitors = 0;
    const allocateCompetitor = () => assignCommerceDudes({ ...config, repository: competitor,
      boxAssetId: `other-${++competitors}`, randomInt: (maximum) => maximum - 1 });
    const loadInventory = repository.getDudeInventory.bind(repository);
    let snapshots = 0;
    repository.getDudeInventory = async (args, signal) => {
      snapshots++;
      const inventory = await loadInventory(args, signal);
      await allocateCompetitor();
      return inventory;
    };
    const run = repository.run.bind(repository);
    repository.run = (nowMs, operation) => run(nowMs, async transaction => {
      const result = await operation(transaction);
      await allocateCompetitor();
      return result;
    });
    let retries = 0;
    const result = await assignCommerceDudes({ ...config, repository, boxAssetId: 'target',
      randomInt: () => 0, sleep: async () => { retries++; } });
    assert.deepEqual(result, { dudeIds: [1, 2, 3], outcome: 'created' });
    assert.equal(snapshots, 1);
    assert.equal(retries, 0);
    assert.equal(competitors, 2);
    assert.equal((await available(db)).length, 91);
  } finally {
    await server.close();
  }
});

test('native D1 returns the winning same-box assignment after a stale snapshot', async () => {
  const server = inventoryRuntimeServer();
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    const { COMMERCE_DB: db } = await worker.getEnv();
    await pause(db);
    await db.batch([
      metadata(db, GENERATION, 1),
      db.prepare('INSERT INTO commerce_available_dudes VALUES (?, 1, 0)').bind(DROP_ID),
      db.prepare('UPDATE commerce_inventory_drops SET ready = 1 WHERE drop_id = ?').bind(DROP_ID),
      db.prepare("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1"),
    ]);
    await resume(db);
    const repository = new D1CommerceRepository(db);
    const winner = new D1CommerceRepository(db);
    const args = { dropId: DROP_ID, dropFamily: 'poncho_drifella', itemsPerBox: 1, maxDudeId: 1,
      nowMs: 100, signal: new AbortController().signal, boxAssetId: 'same-box', randomInt: () => 0 };
    const loadInventory = repository.getDudeInventory.bind(repository);
    repository.getDudeInventory = async (config, signal) => {
      const inventory = await loadInventory(config, signal);
      assert.deepEqual(await assignCommerceDudes({ ...args, repository: winner }),
        { dudeIds: [1], outcome: 'created' });
      return inventory;
    };
    let retries = 0;
    assert.deepEqual(await assignCommerceDudes({ ...args, repository, sleep: async () => { retries++; } }),
      { dudeIds: [1], outcome: 'existing' });
    assert.equal(retries, 1);
    assert.deepEqual(await available(db), []);
    assert.equal((await winner.get(commerceKeys.dudeAssignment(DROP_ID, '1')))?.data.boxAssetId, 'same-box');
  } finally {
    await server.close();
  }
});

test('native D1 retries an overlapping snapshot without assigning a figure twice', async () => {
  const server = inventoryRuntimeServer();
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    const { COMMERCE_DB: db } = await worker.getEnv();
    await pause(db);
    await db.batch([
      metadata(db),
      ...[1, 2, 3, 4].map((id) => db.prepare('INSERT INTO commerce_available_dudes VALUES (?, ?, ?)')
        .bind(DROP_ID, id, id - 1)),
      db.prepare('UPDATE commerce_inventory_drops SET ready = 1 WHERE drop_id = ?').bind(DROP_ID),
      db.prepare("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1"),
    ]);
    await resume(db);
    const repository = new D1CommerceRepository(db);
    const competitor = new D1CommerceRepository(db);
    const args = { dropId: DROP_ID, dropFamily: 'poncho_drifella', itemsPerBox: 1, maxDudeId: 4,
      nowMs: 100, signal: new AbortController().signal, randomInt: () => 0 };
    const loadInventory = repository.getDudeInventory.bind(repository);
    let snapshots = 0;
    repository.getDudeInventory = async (config, signal) => {
      snapshots++;
      return loadInventory(config, signal);
    };
    const run = repository.run.bind(repository);
    let commits = 0;
    repository.run = (nowMs, operation) => run(nowMs, async transaction => {
      const result = await operation(transaction);
      if (++commits === 1) {
        assert.deepEqual(await assignCommerceDudes({ ...args, repository: competitor, boxAssetId: 'competitor' }),
          { dudeIds: [1], outcome: 'created' });
      }
      return result;
    });
    let retries = 0;
    assert.deepEqual(await assignCommerceDudes({ ...args, repository, boxAssetId: 'target',
      sleep: async () => { retries++; } }), { dudeIds: [2], outcome: 'created' });
    assert.equal(snapshots, 2);
    assert.equal(commits, 2);
    assert.equal(retries, 1);
    assert.deepEqual(await available(db), [3, 4]);
    assert.equal((await repository.get(commerceKeys.dudeAssignment(DROP_ID, '1')))?.data.boxAssetId, 'competitor');
    assert.equal((await repository.get(commerceKeys.dudeAssignment(DROP_ID, '2')))?.data.boxAssetId, 'target');
  } finally {
    await server.close();
  }
});

test('native D1 reads a full card inventory once with a compact JSON payload', async (t) => {
  const inventorySize = CARD_NFT_2_MAX_CARD_ID;
  const server = inventoryRuntimeServer();
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    const { COMMERCE_DB: db } = await worker.getEnv();
    await pause(db);
    await db.batch([
      db.prepare(`INSERT INTO commerce_inventory_drops
        (drop_id, generation, ready, drop_family, items_per_box, max_dude_id, initialized_at_ms)
        VALUES (?, ?, 0, 'card_nft_2', 3, ?, 100)`).bind(DROP_ID, GENERATION, inventorySize),
      db.prepare(`INSERT INTO commerce_available_dudes (drop_id, dude_id, pool_position)
        WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < ?)
        SELECT ?, id, id - 1 FROM ids`).bind(inventorySize, DROP_ID),
      db.prepare('UPDATE commerce_inventory_drops SET ready = 1 WHERE drop_id = ?').bind(DROP_ID),
      db.prepare("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1"),
    ]);
    await resume(db);
    const config = { dropId: DROP_ID, dropFamily: 'card_nft_2', itemsPerBox: 3, maxDudeId: inventorySize };
    const pool = Array.from({ length: inventorySize }, (_, index) => index + 1);
    for (const { label, fraction } of [
      { label: 'low', fraction: 0 },
      { label: 'midpoint', fraction: 0.5 },
      { label: 'high', fraction: 0.999999 },
    ]) {
      const batches: { returned: number; rowsRead: number; bytes: number }[] = [];
      const measuredDb = new Proxy(db, {
        get(target, property) {
          if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch<Record<string, unknown>>(statements);
            assert.ok(results.every(result => result.results.length <= 1));
            assert.ok(results.every(result => result.results.every(row =>
              !Object.hasOwn(row, 'dude_id') && !Object.hasOwn(row, 'pool_position'))));
            batches.push({
              returned: results.reduce((sum, result) => sum + result.results.length, 0),
              rowsRead: results.reduce((sum, result) => sum + result.meta.rows_read, 0),
              bytes: new TextEncoder().encode(JSON.stringify(results.map(result => result.results))).length,
            });
            return results;
          };
          return Reflect.get(target, property, target);
        },
      });
      const randomInt = (maximum: number) => Math.floor(maximum * fraction);
      const snapshot = await new D1CommerceRepository(measuredDb).getDudeInventory(config);
      assert.deepEqual(snapshot.pool, pool, label);
      const actual = await pickDudeIdsForAssignment({ ...config, pool: snapshot.pool, randomInt, isAssigned: () => false });
      const expected = await pickDudeIdsForAssignment({ ...config, pool: [...pool], randomInt, isAssigned: () => false });
      assert.deepEqual(actual, expected, label);
      assert.equal(batches.length, 1, label);
      const [{ returned, rowsRead, bytes }] = batches;
      assert.equal(returned, 3, label);
      assert.ok(rowsRead >= inventorySize && rowsRead <= inventorySize + 8,
        `${label} snapshot read ${rowsRead} rows for ${inventorySize} cards.`);
      assert.ok(bytes < 64 * 1024, `${label} snapshot transferred ${bytes} bytes.`);
      t.diagnostic(`${label} picks read ${rowsRead} D1 rows and transferred ${bytes} bytes in one batch for ${inventorySize} cards.`);
    }
  } finally {
    await server.close();
  }
});
