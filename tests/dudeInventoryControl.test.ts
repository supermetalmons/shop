import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDudeInventoryControlArgs, runDudeInventoryControl } from '../scripts/ops/dudeInventoryControl.ts';
import { inventoryDropConfigs, validateInventoryOwnership } from '../scripts/shared/dudeInventoryMaintenance.ts';
import { parseCommerceD1DocumentRow } from '../scripts/shared/commerceD1Maintenance.ts';
import { bootstrapTestCommerce, commerceTestConfig, commerceTestLease, commerceTestNow,
  commerceTestQuery, createCurrentCommerceDatabase } from './helpers/commerceDatabase.ts';

const prepare = ['prepare', '--expected-revision', '2', '--write'];
function ownershipRow(dropId: string, kind = 'dude_assignment', data: Record<string, unknown> = { dudeId: 1, boxAssetId: 'box' }) {
  const documentId = kind === 'dude_assignment' ? '1' : 'box';
  return { document_path: `drops/${dropId}/${kind === 'dude_assignment' ? 'dudeAssignments' : 'boxAssignments'}/${documentId}`,
    document_kind: kind, drop_id: dropId, document_id: documentId, document_json: JSON.stringify(data),
    version: 1, create_time: '2026-09-01T00:00:00.000Z', update_time: '2026-09-01T00:00:00.000Z' };
}

test('inventory keeps status and explicit prepare while rejecting retired activation', () => {
  assert.deepEqual(parseDudeInventoryControlArgs(['status']), { command: 'status', write: false });
  assert.throws(() => parseDudeInventoryControlArgs(['activate', '--write', '--expected-revision', '2']), /Usage/);
  assert.throws(() => parseDudeInventoryControlArgs(['prepare']), /requires --write/);
  assert.throws(() => parseDudeInventoryControlArgs(['status', '--write']), /read-only/);
  assert.throws(() => parseDudeInventoryControlArgs(['prepare', '--write', '--expected-revision', '0']), /positive/);
  assert.ok(inventoryDropConfigs().every((config) => config.maxDudeId >= config.itemsPerBox));
});

test('ownership validation preserves assignment consistency and orphan reservation accounting', () => {
  const marker = parseCommerceD1DocumentRow(ownershipRow('drop'));
  assert.equal(validateInventoryOwnership(commerceTestConfig, [marker]).orphanAssignments, 1);
  const box = parseCommerceD1DocumentRow(ownershipRow('drop', 'box_assignment', { dudeIds: [1] }));
  assert.equal(validateInventoryOwnership(commerceTestConfig, [marker, box]).orphanAssignments, 0);
  assert.equal(validateInventoryOwnership(commerceTestConfig, [marker, box]).assignedCount, 1);
  assert.throws(() => validateInventoryOwnership(commerceTestConfig,
    [marker, { ...box, data: { dudeIds: [2] } }]), /disagree/);
  assert.throws(() => validateInventoryOwnership(commerceTestConfig,
    [{ ...marker, data: { dudeId: 2, boxAssetId: 'box' } }]), /invalid figure marker/);
});

test('status is read-only and reports ready stock and missing new configurations', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  await bootstrapTestCommerce(database);
  const query = commerceTestQuery(database);
  const result = await runDudeInventoryControl(['status'], { configs: [commerceTestConfig, { ...commerceTestConfig, dropId: 'new' }],
    query: (sql) => { assert.match(sql, /^SELECT/); return query(sql); } });
  assert.equal(result.mode, 'rows');
  assert.equal(result.drops[0].ready, true);
  assert.equal(result.drops[0].available, 3);
  assert.equal(result.drops[1].ready, false);
  assert.equal(result.drops[1].configMatches, false);
});

test('prepare initializes only new drops and never replenishes spent ready inventory', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  await bootstrapTestCommerce(database);
  const query = commerceTestQuery(database);
  const before = query('SELECT * FROM commerce_inventory_drops')[0];
  commerceTestLease(database, () => database.exec('DELETE FROM commerce_available_dudes WHERE dude_id = 2'));
  const next = { ...commerceTestConfig, dropId: 'new', maxDudeId: 2 };
  const result = await runDudeInventoryControl(prepare, { query, configs: [commerceTestConfig, next] });
  assert.deepEqual(query("SELECT * FROM commerce_inventory_drops WHERE drop_id = 'drop'")[0], before);
  assert.deepEqual(query("SELECT dude_id FROM commerce_available_dudes WHERE drop_id = 'drop' ORDER BY dude_id").map((row) => row.dude_id), [1, 3]);
  assert.equal(result.drops[1].available, 2);
  const newBefore = query("SELECT * FROM commerce_inventory_drops WHERE drop_id = 'new'");
  await runDudeInventoryControl([...prepare, '--drop', 'new'], { query, configs: [commerceTestConfig, next] });
  assert.deepEqual(query("SELECT * FROM commerce_inventory_drops WHERE drop_id = 'new'"), newBefore);
});

test('prepare rejects uninitialized mode, stale revisions and incomplete pause', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  const query = commerceTestQuery(database);
  await assert.rejects(runDudeInventoryControl(prepare, { query, configs: [commerceTestConfig] }), /requires rows mode/);
  await bootstrapTestCommerce(database);
  await assert.rejects(runDudeInventoryControl(['prepare', '--write', '--expected-revision', '3'], { query, configs: [commerceTestConfig] }), /pause\/drain/);
  commerceTestLease(database, () => database.exec(`UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
    paused_at_ms = NULL, updated_at_ms = ${commerceTestNow}`));
  await assert.rejects(runDudeInventoryControl(['prepare', '--write', '--expected-revision', '3'], { query, configs: [commerceTestConfig] }), /pause\/drain/);
});

test('prepare rejects unfinished wipes and admin operations before inventory changes', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  await bootstrapTestCommerce(database);
  const query = commerceTestQuery(database);
  const configs = [commerceTestConfig, { ...commerceTestConfig, dropId: 'new' }];
  for (const block of ['wipe', 'admin']) {
    await assert.rejects(runDudeInventoryControl(prepare, { configs, query: (sql) => {
      if (block === 'wipe' && sql === 'SELECT guard_id FROM commerce_wipe_guards LIMIT 1') return [{ guard_id: 'unfinished' }];
      if (block === 'admin' && sql.includes("WHERE document_kind = 'admin_irl_redeem_request'")) return [{ document_path: 'processing' }];
      return query(sql);
    } }), block === 'wipe' ? /wipe is unfinished/ : /Admin finalization/);
    assert.equal(query("SELECT COUNT(*) AS count FROM commerce_inventory_drops WHERE drop_id = 'new'")[0].count, 0);
  }
});

test('existing or unknown ownership blocks initialization and assigned overlap blocks ready validation', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  await bootstrapTestCommerce(database);
  const query = commerceTestQuery(database);
  for (const dropId of ['new', 'unknown', 'drop']) {
    await assert.rejects(runDudeInventoryControl(prepare, { configs: [commerceTestConfig, { ...commerceTestConfig, dropId: 'new' }],
      query: (sql) => sql.includes("WHERE document_kind IN ('dude_pool', 'dude_assignment', 'box_assignment')")
        ? [ownershipRow(dropId)] : query(sql),
    }), dropId === 'unknown' ? /Unconfigured inventory ownership/ : dropId === 'drop' ? /Assigned figures remain available/ : /existing ownership/);
  }
  assert.equal(query('SELECT COUNT(*) AS count FROM commerce_inventory_drops')[0].count, 1);
});
