import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runDudeInventoryControl, parseDudeInventoryControlArgs } from '../scripts/ops/dudeInventoryControl.ts';
import {
  initializeNewInventoryDrop, readAvailableInventory, validateManifestInventory, type InventoryDropConfig,
} from '../scripts/shared/dudeInventoryMaintenance.ts';
import { sqlString } from '../scripts/shared/commerceD1Maintenance.ts';
import { miNoteManifestFixture } from './helpers/miNoteManifest.ts';
import {
  bootstrapTestCommerce, commerceTestConfig, commerceTestLease, commerceTestNow,
  commerceTestQuery, createCurrentCommerceDatabase,
} from './helpers/commerceDatabase.ts';

function resume(database: DatabaseSync) {
  commerceTestLease(database, () => database.exec(`UPDATE commerce_authority_control SET authority_state = 'd1',
    revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${commerceTestNow}`));
}

function insertPreorders(database: DatabaseSync, fixture: ReturnType<typeof miNoteManifestFixture>) {
  const { config, snapshot } = fixture;
  database.exec(`INSERT INTO commerce_preorder_orders (
    order_id, preorder_id, cluster, collection, buyer, request_id, card_ids_json, assets_json,
    status, prepared_transaction, blockhash, blockhash_context_slot, last_valid_block_height,
    expires_at_ms, created_at_ms, updated_at_ms, next_check_at_ms, ethereum_address
  ) VALUES ('order', ${sqlString(config.preorderId)}, ${sqlString(config.cluster)}, ${sqlString(config.collection)},
    'buyer', 'request', '[1,4]', ${sqlString(JSON.stringify(snapshot.orders[0].assets))}, 'prepared', 'prepared', 'blockhash', 1, 2,
    1000, 0, 0, 1000, '0x1111111111111111111111111111111111111111');
    INSERT INTO commerce_preorder_claims VALUES
      (${sqlString(config.cluster)}, ${sqlString(config.collection)}, 1, 'order'),
      (${sqlString(config.cluster)}, ${sqlString(config.collection)}, 4, 'order');
    UPDATE commerce_preorder_orders SET status = 'submitted', signed_transaction = 'signed', signature = 'signature', revision = revision + 1;
    UPDATE commerce_preorder_orders SET status = 'succeeded', revision = revision + 1;`);
}

async function setup(context: Parameters<typeof createCurrentCommerceDatabase>[0]) {
  const database = createCurrentCommerceDatabase(context);
  await bootstrapTestCommerce(database);
  resume(database);
  const fixture = miNoteManifestFixture();
  insertPreorders(database, fixture);
  const manifest = await fixture.manifest();
  const config: InventoryDropConfig = { dropId: 'new', dropFamily: 'mi_note_cards', itemsPerBox: 2, maxDudeId: 1430,
    inventoryManifest: { sha256: manifest.sha256, cardIds: manifest.eligibleCardIds } };
  const query = commerceTestQuery(database);
  const options = ['initialize-new', '--drop', config.dropId, '--manifest', '/unused-manifest.json'];
  const dependencies = { query, configs: [commerceTestConfig, config], readManifest: () => manifest,
    verifyManifest: async () => undefined, verifyNewDrop: async () => undefined };
  return { database, fixture, manifest, config, query, options, dependencies };
}

test('online initialization is explicit, scoped and read-only without --write', async (t) => {
  const fixture = await setup(t);
  assert.throws(() => parseDudeInventoryControlArgs(['initialize-new', '--write']), /requires --drop and --manifest/);
  const before = fixture.query('SELECT * FROM commerce_authority_control');
  const result = await runDudeInventoryControl(fixture.options, { ...fixture.dependencies,
    query: (sql) => { assert.match(sql, /^SELECT/); return fixture.query(sql); } });
  assert.equal('write' in result && result.write, false);
  assert.equal(result.drops[0].ready, false);
  assert.deepEqual(fixture.query('SELECT * FROM commerce_authority_control'), before);
  assert.equal(fixture.query('SELECT COUNT(*) AS count FROM commerce_inventory_initializations')[0].count, 0);
});

test('new sparse inventory is initialized atomically while authority and preorders remain unchanged', async (t) => {
  const fixture = await setup(t);
  const beforeAuthority = fixture.query('SELECT * FROM commerce_authority_control');
  const beforePreorders = fixture.query('SELECT * FROM commerce_preorder_orders');
  const beforeClaims = fixture.query('SELECT * FROM commerce_preorder_claims');
  const beforeOther = await readAvailableInventory(fixture.query, commerceTestConfig.dropId);
  const result = await runDudeInventoryControl([...fixture.options, '--write'], fixture.dependencies);
  assert.equal(result.drops[0].ready, true);
  assert.equal(result.drops[0].available, 4);
  assert.deepEqual(await readAvailableInventory(fixture.query, fixture.config.dropId), [
    { dudeId: 2, poolPosition: 0 }, { dudeId: 3, poolPosition: 1 }, { dudeId: 1401, poolPosition: 2 }, { dudeId: 1430, poolPosition: 3 },
  ]);
  assert.deepEqual(fixture.query('SELECT * FROM commerce_authority_control'), beforeAuthority);
  assert.deepEqual(fixture.query('SELECT * FROM commerce_preorder_orders'), beforePreorders);
  assert.deepEqual(fixture.query('SELECT * FROM commerce_preorder_claims'), beforeClaims);
  assert.deepEqual(await readAvailableInventory(fixture.query, commerceTestConfig.dropId), beforeOther);
  assert.equal(fixture.query('SELECT COUNT(*) AS count FROM commerce_authority_control_lease')[0].count, 0);
  assert.equal(fixture.query('SELECT completed_at_ms IS NOT NULL AS completed FROM commerce_inventory_initializations')[0].completed, 1);
  await assert.rejects(runDudeInventoryControl([...fixture.options, '--write'], { ...fixture.dependencies,
    configs: [{ ...fixture.config, inventoryManifest: { sha256: 'b'.repeat(64), cardIds: [2, 3, 1401, 1430] } }],
  }), /does not match/);
});

test('uncertain completion can be retried without replenishing assigned cards', async (t) => {
  const fixture = await setup(t);
  let responseLost = false;
  await runDudeInventoryControl([...fixture.options, '--write'], { ...fixture.dependencies, query: (sql) => {
    const result = fixture.query(sql);
    if (!responseLost && sql.startsWith('INSERT INTO commerce_inventory_initializations')) {
      responseLost = true;
      throw new Error('lost response after committed statement');
    }
    return result;
  } });
  const record = fixture.query('SELECT * FROM commerce_inventory_initializations')[0];
  fixture.database.exec(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
  ) VALUES ('drops/new/dudeAssignments/1430', 'dude_assignment', 'new', '1430',
    ${sqlString(JSON.stringify({ dudeId: 1430, boxAssetId: 'reserved-box', inventoryGeneration: record.generation }))},
    1, '2026-10-09T10:00:00.000Z', '2026-10-09T10:00:00.000Z')`);
  const before = fixture.query('SELECT * FROM commerce_inventory_initializations');
  const result = await runDudeInventoryControl([...fixture.options, '--write'], { ...fixture.dependencies,
    verifyManifest: async () => { throw new Error('an exact ready retry must not prepare fresh inventory'); },
    verifyNewDrop: async () => { throw new Error('an exact ready retry may audit an active drop'); },
  });
  assert.equal(result.drops[0].available, 3);
  assert.equal(result.drops[0].assigned, 1);
  assert.deepEqual(fixture.query('SELECT * FROM commerce_inventory_initializations'), before);
  assert.deepEqual((await readAvailableInventory(fixture.query, 'new')).map((row) => row.dudeId), [2, 3, 1401]);
});

test('trigger failure rolls back metadata, pool and authorization together', async (t) => {
  const fixture = await setup(t);
  fixture.database.exec(`CREATE TRIGGER reject_last_test_card BEFORE INSERT ON commerce_available_dudes
    WHEN NEW.drop_id = 'new' AND NEW.dude_id = 1430 BEGIN SELECT RAISE(ABORT, 'injected card failure'); END;`);
  await assert.rejects(runDudeInventoryControl([...fixture.options, '--write'], fixture.dependencies), /injected card failure/);
  for (const table of ['commerce_inventory_initializations', 'commerce_inventory_drops', 'commerce_available_dudes']) {
    assert.equal(fixture.query(`SELECT COUNT(*) AS count FROM ${table} WHERE drop_id = 'new'`)[0].count, 0);
  }
  assert.equal(fixture.query('SELECT authority_state FROM commerce_authority_control')[0].authority_state, 'd1');
});

test('the database rejects an expired lease and stale preorder exclusions', async (t) => {
  const fixture = await setup(t);
  const lease = randomUUID();
  fixture.database.exec(`INSERT INTO commerce_authority_control_lease VALUES (1, ${sqlString(lease)}, ${commerceTestNow} - 2000, ${commerceTestNow} - 1000)`);
  const args = { query: fixture.query, config: fixture.config, manifest: fixture.manifest,
    authorityRevision: 3, leaseToken: lease, generation: randomUUID() };
  await assert.rejects(initializeNewInventoryDrop(args), /coordination lease/);
  fixture.database.exec(`UPDATE commerce_authority_control_lease SET expires_at_ms = ${commerceTestNow} + 60000`);
  await assert.rejects(initializeNewInventoryDrop({ ...args,
    query: (sql) => fixture.query(sql.startsWith('INSERT INTO commerce_inventory_initializations') ? sql.replace("'[1,4]'", "'[1,5]'") : sql),
  }), /preorder exclusions changed/);
  assert.equal(fixture.query("SELECT COUNT(*) AS count FROM commerce_inventory_drops WHERE drop_id = 'new'")[0].count, 0);
});

test('target history and unfinished authority transitions prevent online initialization', async (t) => {
  const fixture = await setup(t);
  fixture.database.exec("INSERT INTO commerce_document_path_revisions VALUES ('drops/new/boxAssignments/old', 1)");
  await assert.rejects(runDudeInventoryControl([...fixture.options, '--write'], fixture.dependencies), /public commerce history/);
  commerceTestLease(fixture.database, () => fixture.database.exec(`UPDATE commerce_authority_control
    SET authority_state = 'paused', revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${commerceTestNow}`));
  await assert.rejects(runDudeInventoryControl([...fixture.options, '--write'], fixture.dependencies), /requires active Commerce/);
});

test('root claim-code documents count as public drop history in both preflight and SQL', async (t) => {
  const fixture = await setup(t);
  fixture.database.exec(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
  ) VALUES ('claimCodes/PRIOR', 'claim_code', NULL, 'PRIOR', '{"dropId":"new","status":"unused"}',
    1, '2026-10-09T10:00:00.000Z', '2026-10-09T10:00:00.000Z')`);
  await assert.rejects(runDudeInventoryControl([...fixture.options, '--write'], fixture.dependencies), /public commerce history/);
  const token = randomUUID();
  fixture.database.exec(`INSERT INTO commerce_authority_control_lease VALUES (1, ${sqlString(token)}, ${commerceTestNow}, ${commerceTestNow} + 60000)`);
  await assert.rejects(initializeNewInventoryDrop({ query: fixture.query, config: fixture.config, manifest: fixture.manifest,
    authorityRevision: 3, leaseToken: token, generation: randomUUID() }), /public commerce history/);
});

test('manifest conservation rejects missing cards, bad positions, overlap and out-of-manifest assignments', async (t) => {
  const { config } = await setup(t);
  const available = [{ dudeId: 2, poolPosition: 0 }, { dudeId: 3, poolPosition: 1 }, { dudeId: 1401, poolPosition: 2 }];
  validateManifestInventory(config, available, new Set([1430]));
  assert.throws(() => validateManifestInventory(config, available, new Set()), /exactly match/);
  assert.throws(() => validateManifestInventory(config, available, new Set([2, 1430])), /exactly match/);
  assert.throws(() => validateManifestInventory(config, available, new Set([1])), /exactly match/);
  assert.throws(() => validateManifestInventory(config, [{ ...available[0], poolPosition: 2 }, ...available.slice(1)], new Set([1430])), /exactly match/);
});
