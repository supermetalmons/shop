import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseDudeInventoryControlArgs, runDudeInventoryControl } from '../scripts/ops/dudeInventoryControl.ts';
import { inventoryDropConfigs, planInventoryBackfill } from '../scripts/shared/dudeInventoryMaintenance.ts';
import { parseCommerceD1DocumentRow } from '../scripts/shared/commerceD1Maintenance.ts';

const config = { dropId: 'drop', dropFamily: 'poncho_drifella', itemsPerBox: 1, maxDudeId: 3 };
const timestamp = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

function database(context: { after: (cleanup: () => void) => void }) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../cloud/workers/api/commerce-migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  withLease(db, () => {
    db.exec(`UPDATE commerce_authority_control SET paused_at_ms = ${timestamp}, updated_at_ms = ${timestamp};
      UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = ${timestamp}`);
  });
  return db;
}

function withLease(db: DatabaseSync, operation: () => void) {
  db.exec(`INSERT INTO commerce_authority_control_lease VALUES
    (1, '00000000-0000-4000-8000-000000001010', ${timestamp}, ${timestamp} + 60000)`);
  try { operation(); } finally { db.exec('DELETE FROM commerce_authority_control_lease'); }
}

function pause(db: DatabaseSync) {
  withLease(db, () => db.exec(`UPDATE commerce_authority_control SET authority_state = 'paused',
      revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${timestamp};
    UPDATE commerce_authority_control SET paused_at_ms = ${timestamp}, updated_at_ms = ${timestamp}`));
}

function insert(db: DatabaseSync, kind: string, id: string, data: unknown, dropId = 'drop') {
  const collection = { dude_pool: 'meta', dude_assignment: 'dudeAssignments', box_assignment: 'boxAssignments',
    admin_irl_redeem_request: 'adminIrlRedeemRequests' }[kind];
  db.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
  ) VALUES (?, ?, ?, ?, ?, 1, '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')`)
    .run(`drops/${dropId}/${collection}/${id}`, kind, dropId, id, JSON.stringify(data));
  db.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
}

function source(db: DatabaseSync) {
  return db.prepare('SELECT * FROM commerce_documents').all().map(parseCommerceD1DocumentRow);
}

function query(db: DatabaseSync) {
  return (sql: string) => db.prepare(sql).all().map((row) => ({ ...row }));
}

function execute(db: DatabaseSync, command: string, extra: string[] = [], overrides = {}) {
  const revision = db.prepare('SELECT revision FROM commerce_authority_control').get()!.revision;
  return runDudeInventoryControl([command, ...(command === 'status' ? [] : ['--write', '--expected-revision', String(revision)]), ...extra],
    { query: query(db), configs: [config], ...overrides });
}

test('inventory commands require explicit writes and reject partial activation', () => {
  assert.throws(() => parseDudeInventoryControlArgs(['prepare']), /requires --write/);
  assert.throws(() => parseDudeInventoryControlArgs(['status', '--write']), /read-only/);
  assert.throws(() => parseDudeInventoryControlArgs(['activate', '--write', '--expected-revision', '1', '--drop', 'drop']), /every configured drop/);
  assert.ok(inventoryDropConfigs().every((drop) => drop.itemsPerBox > 0 && drop.maxDudeId <= 0xffff));
});

test('backfill preserves sanitation, order, exclusions, and orphan reservations', (context) => {
  const db = database(context);
  insert(db, 'dude_pool', 'dudePool', { available: ['3', 2, 3, -1, 'invalid', 1] });
  insert(db, 'dude_assignment', '2', { dudeId: 2, boxAssetId: 'orphan' });
  const plan = planInventoryBackfill(config, source(db));
  assert.deepEqual(plan.available, [{ dudeId: 3, poolPosition: 0 }, { dudeId: 1, poolPosition: 2 }]);
  assert.equal(plan.orphanAssignments, 1);
  assert.equal(plan.usedDefaultPool, false);
});

test('backfill distinguishes a missing pool from exhausted inventory', async (context) => {
  const db = database(context);
  assert.equal(planInventoryBackfill(config, []).available.length, 3);
  insert(db, 'dude_pool', 'dudePool', { available: [] });
  assert.deepEqual(planInventoryBackfill(config, source(db)).available, []);
  pause(db);
  const prepared = await execute(db, 'prepare');
  assert.equal(prepared.drops[0].ready, true);
  assert.equal(prepared.drops[0].available, 0);
  assert.equal((await execute(db, 'activate')).mode, 'rows');
});

test('ownership disagreements stop backfill without initializing inventory', async (context) => {
  const db = database(context);
  insert(db, 'box_assignment', 'box', { dudeIds: [1] });
  insert(db, 'dude_assignment', '1', { dudeId: 1, boxAssetId: 'different-box' });
  pause(db);
  await assert.rejects(execute(db, 'prepare'), /ownership conflict/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commerce_inventory_drops').get()!.n, 0);
});

test('prepare and activation require the current paused authority epoch', async (context) => {
  const db = database(context);
  await assert.rejects(execute(db, 'prepare'), /pause\/drain/);
  pause(db);
  await assert.rejects(runDudeInventoryControl(['prepare', '--write', '--expected-revision', '1'],
    { query: query(db), configs: [config] }), /expected authority revision/);
  await assert.rejects(execute(db, 'activate'), /missing, incomplete/);
  assert.equal((await execute(db, 'status')).mode, 'legacy');
});

test('status distinguishes registry mismatch from legacy pool drift even when counts match', async (context) => {
  const db = database(context);
  insert(db, 'dude_pool', 'dudePool', { available: [1, 3] });
  pause(db);
  await execute(db, 'prepare');
  const changedConfig = { ...config, dropFamily: 'little_swag_boxes' };
  const mismatch = await execute(db, 'status', [], { configs: [changedConfig] });
  assert.equal(mismatch.drops[0].ready, true);
  assert.equal(mismatch.drops[0].configMatches, false);
  assert.equal(mismatch.drops[0].matchesLegacyPool, true);
  withLease(db, () => db.exec(`UPDATE commerce_authority_control SET authority_state = 'd1',
    revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${timestamp}`));
  db.exec(`UPDATE commerce_documents SET document_json = '{"available":[3,1]}', version = version + 1
    WHERE document_kind = 'dude_pool';
    UPDATE commerce_authority_control SET documents_revision = documents_revision + 1`);
  const drifted = await execute(db, 'status');
  assert.equal(drifted.drops[0].configMatches, true);
  assert.equal(drifted.drops[0].available, drifted.drops[0].plannedAvailable);
  assert.equal(drifted.drops[0].matchesLegacyPool, false);
});

test('activation requires every configured drop and its matching configuration even without ownership documents', async (context) => {
  const db = database(context);
  const second = { ...config, dropId: 'second' };
  const configs = [config, second];
  pause(db);
  await execute(db, 'prepare', ['--drop', 'drop'], { configs });
  await assert.rejects(execute(db, 'activate', [], { configs }), /Inventory for second is missing/);
  assert.equal((await execute(db, 'status')).mode, 'legacy');
  await execute(db, 'prepare', ['--drop', 'second'], { configs });
  await assert.rejects(execute(db, 'activate', [], {
    configs: [config, { ...second, itemsPerBox: 2 }],
  }), /Inventory for second .*differs from the registry/);
  assert.equal((await execute(db, 'status')).mode, 'legacy');
  const activated = await execute(db, 'activate', [], { configs });
  assert.equal(activated.mode, 'rows');
  assert.deepEqual(activated.drops.map((drop) => drop.dropId), ['drop', 'second']);
});

test('staged inventory refreshes before activation, then preparation never restores spent stock', async (context) => {
  const db = database(context);
  pause(db);
  const prepared = await execute(db, 'prepare');
  assert.equal(prepared.mode, 'legacy');
  const refreshed = await execute(db, 'prepare');
  assert.notEqual(refreshed.drops[0].generation, prepared.drops[0].generation);
  const activated = await execute(db, 'activate');
  assert.equal(activated.mode, 'rows');
  assert.deepEqual((await execute(db, 'activate')).drops, activated.drops);
  withLease(db, () => db.exec(`UPDATE commerce_authority_control SET authority_state = 'd1',
    revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${timestamp}`));
  insert(db, 'dude_assignment', '1', { dudeId: 1, boxAssetId: 'box', inventoryGeneration: activated.drops[0].generation });
  insert(db, 'box_assignment', 'box', { dudeIds: [1] });
  pause(db);
  const existing = await execute(db, 'prepare');
  assert.equal(existing.drops[0].available, 2);
  assert.equal(existing.drops[0].generation, activated.drops[0].generation);
  assert.throws(() => db.exec("UPDATE commerce_authority_control SET dude_inventory_mode = 'legacy'"), /cannot move backward/);
});

test('interrupted backfill blocks resume and is recoverable by rerunning prepare', async (context) => {
  const db = database(context);
  pause(db);
  const normalQuery = query(db);
  let interrupted = false;
  await assert.rejects(execute(db, 'prepare', [], { query: (sql: string) => {
    const rows = normalQuery(sql);
    if (!interrupted && sql.startsWith('INSERT INTO commerce_available_dudes')) {
      interrupted = true;
      throw new Error('lost backfill acknowledgement');
    }
    return rows;
  } }), /lost backfill acknowledgement/);
  assert.equal(db.prepare('SELECT ready FROM commerce_inventory_drops').get()!.ready, 0);
  withLease(db, () => assert.throws(() => db.exec(`UPDATE commerce_authority_control SET authority_state = 'd1',
    revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${timestamp}`), /initialization is incomplete/));
  const recovered = await execute(db, 'prepare');
  assert.equal(recovered.drops[0].ready, true);
  assert.equal(recovered.drops[0].available, 3);
});

test('an uncertain backfill and failed lease release preserve both errors and remain paused', async (context) => {
  const db = database(context);
  pause(db);
  const normalQuery = query(db);
  const primaryError = new Error('lost backfill acknowledgement');
  await assert.rejects(execute(db, 'prepare', [], { query: (sql: string) => {
    if (sql.startsWith('DELETE FROM commerce_authority_control_lease')) throw new Error('lease release unavailable');
    const rows = normalQuery(sql);
    if (sql.startsWith('INSERT INTO commerce_available_dudes')) throw primaryError;
    return rows;
  } }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /keep Commerce paused/);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0], primaryError);
    assert.match(error.errors[1].message, /authority coordination lease could not be released/);
    return true;
  });
  assert.equal(db.prepare('SELECT authority_state FROM commerce_authority_control').get()!.authority_state, 'paused');
  assert.equal(db.prepare('SELECT ready FROM commerce_inventory_drops').get()!.ready, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commerce_available_dudes').get()!.n, 3);
});

test('activation reconciles a lost acknowledgement without reversing the switch', async (context) => {
  const db = database(context);
  pause(db);
  await execute(db, 'prepare');
  const normalQuery = query(db);
  const result = await execute(db, 'activate', [], { query: (sql: string) => {
    const rows = normalQuery(sql);
    if (sql.startsWith("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows'")) {
      throw new Error('lost activation acknowledgement');
    }
    return rows;
  } });
  assert.equal(result.mode, 'rows');
});

test('an unfinished wipe blocks preparation and activation before inventory writes', async (context) => {
  const db = database(context);
  pause(db);
  const normalQuery = query(db);
  const guardedQuery = (sql: string) => sql.startsWith('SELECT guard_id FROM commerce_wipe_guards')
    ? [{ guard_id: 'unfinished-wipe' }]
    : normalQuery(sql);
  for (const command of ['prepare', 'activate']) {
    await assert.rejects(execute(db, command, [], { query: guardedQuery }), /drop wipe is unfinished/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commerce_inventory_drops').get()!.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commerce_authority_control_lease').get()!.n, 0);
});

test('in-flight finalizations and unknown ownership prevent preparation', async (context) => {
  const db = database(context);
  insert(db, 'admin_irl_redeem_request', 'active', { status: 'processing' });
  pause(db);
  await assert.rejects(execute(db, 'prepare'), /finalization must finish/);
  db.exec('DELETE FROM commerce_documents');
  withLease(db, () => db.exec(`UPDATE commerce_authority_control SET authority_state = 'd1',
    revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${timestamp}`));
  insert(db, 'dude_pool', 'dudePool', { available: [] }, 'unknown');
  await assert.rejects(execute(db, 'status'), /Unconfigured inventory ownership/);
});
