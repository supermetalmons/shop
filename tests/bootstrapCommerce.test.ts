import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBootstrapCommerceArgs, runBootstrapCommerce } from '../scripts/ops/bootstrapCommerce.ts';
import { checkCommerceD1 } from '../scripts/ops/checkCommerceD1.ts';
import { COMMERCE_STORAGE_CONTROLS } from '../scripts/shared/commerceStateControl.ts';
import { bootstrapTestCommerce, commerceTestConfig, commerceTestLease, commerceTestNow,
  commerceTestQuery, createCurrentCommerceDatabase } from './helpers/commerceDatabase.ts';

const args = ['--expected-revision', '2', '--write'];

function snapshot(query: ReturnType<typeof commerceTestQuery>) {
  return Object.fromEntries(query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .map((row) => [String(row.name), query(`SELECT * FROM ${row.name} ORDER BY rowid`)]));
}

test('bootstrap requires an explicit write and positive expected revision', () => {
  assert.deepEqual(parseBootstrapCommerceArgs(args), { expectedRevision: 2, write: true });
  for (const invalid of [[], ['--write'], ['--expected-revision', '2'], ['--expected-revision', '0', '--write'],
    [...args, '--write'], [...args, '--expected-revision', '2'], [...args, '--worker-deployed']]) {
    assert.throws(() => parseBootstrapCommerceArgs(invalid));
  }
});

test('fresh replay bootstraps registry inventory and passes current deployment checks while remaining paused', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  const query = commerceTestQuery(database);
  const before = query('SELECT * FROM commerce_authority_control');
  const result = await runBootstrapCommerce(args, { query });
  assert.equal(result.authorityState, 'paused');
  assert.equal(result.inventoryMode, 'rows');
  assert.equal(query('SELECT COUNT(*) AS count FROM commerce_documents')[0].count, 0);
  assert.equal(query('SELECT COUNT(*) AS count FROM commerce_authority_control_lease')[0].count, 0);
  const authority = query('SELECT * FROM commerce_authority_control')[0];
  assert.equal(authority.revision, before[0].revision);
  assert.equal(authority.documents_revision, 0);
  for (const table of COMMERCE_STORAGE_CONTROLS) {
    const row = query(`SELECT * FROM ${table}`)[0];
    assert.equal(row.storage_mode, 'table');
    assert.equal(row.preparation_state, 'ready');
    assert.equal(row.source_documents_revision, 0);
  }
  assert.equal(checkCommerceD1(query, { forDeployment: true }).authorityState, 'paused');
  const initialized = snapshot(query);
  await runBootstrapCommerce(args, { query });
  assert.deepEqual(snapshot(query), initialized);
});

test('bootstrap rejects stale schema, missing drain and wrong authority revision before writes', async (t) => {
  for (const condition of ['schema', 'drain', 'revision'] as const) {
    const database = createCurrentCommerceDatabase(t, condition !== 'drain');
    if (condition === 'schema') database.exec('DELETE FROM d1_migrations WHERE id = 33');
    const query = commerceTestQuery(database);
    const before = snapshot(query);
    await assert.rejects(runBootstrapCommerce(condition === 'revision' ? ['--expected-revision', '3', '--write'] : args,
      { query, configs: [commerceTestConfig] }), condition === 'schema' ? /latest migration/ : /pause\/drain/);
    assert.deepEqual(snapshot(query), before);
  }
});

test('bootstrap rejects history and all nonempty business or maintenance tables before acquiring a lease', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  const query = commerceTestQuery(database);
  const before = snapshot(query);
  const tables = ['commerce_documents', 'commerce_document_path_revisions', 'commerce_delivery_owner_revisions',
    'commerce_commit_guards', 'commerce_wipe_guards', 'commerce_delivery_recovery', 'commerce_notification_outbox',
    'commerce_notification_outbox_pending_owners', 'commerce_notification_outbox_stripe_due', 'commerce_pack_status_outbox',
    'commerce_preorder_claims', 'commerce_preorder_orders', 'commerce_stripe_checkout_state', 'stripe_order_disputes'];
  for (const table of tables) {
    await assert.rejects(runBootstrapCommerce(args, { configs: [commerceTestConfig], query: (sql) => {
      assert.doesNotMatch(sql, /^(?:INSERT|UPDATE|DELETE)/);
      return query(sql).map((row) => row.table_name === table ? { ...row, count: 1 } : row);
    } }), /refuses business data/);
  }
  database.exec('UPDATE commerce_authority_control SET documents_revision = 1');
  await assert.rejects(bootstrapTestCommerce(database), /no business history/);
  database.exec('UPDATE commerce_authority_control SET documents_revision = 0');
  assert.deepEqual(snapshot(query), before);
});

test('all committed initialization mutations reconcile lost acknowledgements without duplication', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  const normal = commerceTestQuery(database);
  let uncertain = 0;
  const config = { ...commerceTestConfig, maxDudeId: 3006 };
  const result = await runBootstrapCommerce(args, { configs: [config], query: (sql) => {
    const rows = normal(sql);
    if (/^(?:INSERT INTO commerce_inventory_drops|INSERT INTO commerce_available_dudes|UPDATE commerce_inventory_drops|UPDATE commerce_authority_control SET dude_inventory_mode|UPDATE commerce_(?:notification_outbox|stripe_checkout_state|pack_status_outbox|delivery_recovery)_control)/.test(sql)) {
      uncertain += 1;
      throw new Error('lost acknowledgement');
    }
    return rows;
  } });
  assert.equal(uncertain, 19);
  assert.equal(result.inventoryMode, 'rows');
  assert.equal(normal('SELECT COUNT(*) AS count FROM commerce_available_dudes')[0].count, 3006);
  const before = snapshot(normal);
  await bootstrapTestCommerce(database, [config]);
  assert.deepEqual(snapshot(normal), before);
});

test('interrupted inventory initialization resumes its generation and exact existing rows', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  const normal = commerceTestQuery(database);
  const config = { ...commerceTestConfig, maxDudeId: 2006 };
  let chunks = 0;
  await assert.rejects(runBootstrapCommerce(args, { configs: [config], query: (sql) => {
    if (sql.startsWith('INSERT INTO commerce_available_dudes') && ++chunks === 2) throw new Error('offline');
    return normal(sql);
  } }), /offline/);
  const saved = normal('SELECT * FROM commerce_available_dudes ORDER BY dude_id');
  const generation = normal('SELECT generation FROM commerce_inventory_drops')[0].generation;
  assert.equal(saved.length, 1000);
  await bootstrapTestCommerce(database, [config]);
  assert.equal(normal('SELECT generation FROM commerce_inventory_drops')[0].generation, generation);
  assert.deepEqual(normal('SELECT * FROM commerce_available_dudes ORDER BY dude_id LIMIT 1000'), saved);
  assert.equal(normal('SELECT COUNT(*) AS count FROM commerce_available_dudes')[0].count, 2006);
});

test('bootstrap refuses mismatched or spent ready inventory without replenishing it', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  await bootstrapTestCommerce(database);
  const query = commerceTestQuery(database);
  await assert.rejects(bootstrapTestCommerce(database, [{ ...commerceTestConfig, maxDudeId: 4 }]), /differs from the registry/);
  commerceTestLease(database, () => database.exec("DELETE FROM commerce_available_dudes WHERE dude_id = 2"));
  const before = snapshot(query);
  await assert.rejects(bootstrapTestCommerce(database), /configured full range/);
  assert.deepEqual(snapshot(query), before);
});

test('bootstrap rejects malformed partial inventory and unknown configured drops', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  const query = commerceTestQuery(database);
  commerceTestLease(database, () => database.exec(`INSERT INTO commerce_inventory_drops VALUES
    ('drop', '00000000-0000-4000-8000-000000000001', 0, 'poncho_drifella', 1, 3, ${commerceTestNow});
    INSERT INTO commerce_available_dudes VALUES ('drop', 1, 2)`));
  await assert.rejects(bootstrapTestCommerce(database), /configured full range/);
  await assert.rejects(bootstrapTestCommerce(database, [{ ...commerceTestConfig, dropId: 'other' }]), /unconfigured inventory/);
  assert.equal(query('SELECT COUNT(*) AS count FROM commerce_available_dudes')[0].count, 1);
});

test('overlapping or expired lease ownership cannot authorize bootstrap writes', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  const query = commerceTestQuery(database);
  database.exec(`INSERT INTO commerce_authority_control_lease VALUES
    (1, '00000000-0000-4000-8000-000000000099', ${commerceTestNow}, ${commerceTestNow} + 60000)`);
  await assert.rejects(bootstrapTestCommerce(database), /already running/);
  assert.equal(query('SELECT lease_token FROM commerce_authority_control_lease')[0].lease_token, '00000000-0000-4000-8000-000000000099');
  database.exec('DELETE FROM commerce_authority_control_lease');
  let expired = false;
  await assert.rejects(runBootstrapCommerce(args, { configs: [commerceTestConfig], query: (sql) => {
    if (!expired && sql.startsWith('INSERT INTO commerce_available_dudes')) {
      expired = true;
      database.exec(`UPDATE commerce_authority_control_lease SET acquired_at_ms = ${commerceTestNow} - 2000, expires_at_ms = ${commerceTestNow} - 1000`);
    }
    return query(sql);
  } }), /configured full range/);
  assert.equal(query('SELECT COUNT(*) AS count FROM commerce_available_dudes')[0].count, 0);
  assert.equal(query('SELECT ready FROM commerce_inventory_drops')[0].ready, 0);
  assert.equal(query('SELECT dude_inventory_mode FROM commerce_authority_control')[0].dude_inventory_mode, 'legacy');
});

test('unconfirmed zero-row control writes fail closed and leave initialization resumable', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  const normal = commerceTestQuery(database);
  await assert.rejects(runBootstrapCommerce(args, { configs: [commerceTestConfig], query: (sql) =>
    sql.startsWith('UPDATE commerce_notification_outbox_control') ? [] : normal(sql) }), /not confirmed/);
  assert.equal(normal('SELECT preparation_state FROM commerce_notification_outbox_control')[0].preparation_state, 'idle');
  assert.equal(normal('SELECT authority_state FROM commerce_authority_control')[0].authority_state, 'paused');
  await bootstrapTestCommerce(database);
});
