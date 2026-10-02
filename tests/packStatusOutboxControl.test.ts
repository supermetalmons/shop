import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePackStatusOutboxControlArgs, runPackStatusOutboxControl } from '../scripts/ops/packStatusOutboxControl.ts';
import { commerceKeys } from '../cloud/workers/api/src/commerceRepository.ts';
import { createCommerceD1Harness, seedCommerceDocuments, seedPackStatusOutbox } from '../cloud/workers/api/test/commerceD1Harness.ts';
import type { PackStatusOutboxRecord } from '../shared/packStatusOutbox.ts';
import { commerceTestQuery, createCurrentCommerceDatabase } from './helpers/commerceDatabase.ts';

function record(id: number): PackStatusOutboxRecord {
  return { parentPath: `drops/drop/deliveryOrders/${id}`, dropId: 'drop', generation: crypto.randomUUID(),
    state: 'pending', revision: 1, failureCount: 0, nextAttemptAtMs: 0, completedAtMs: null, failedAtMs: null,
    lastErrorCode: null, createdAtMs: 0, updatedAtMs: 0 };
}
function fixture(t: test.TestContext, count = 1, marker = false) {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  seedCommerceDocuments(harness, Array.from({ length: count }, (_, index) => ({
    key: commerceKeys.deliveryOrder('drop', String(index + 1)), data: { status: 'ready_to_ship', deliveryId: index + 1,
      ...(marker ? { packStatusProjectionState: 'pending' } : {}) },
  })));
  return { harness, query: commerceTestQuery(harness.database) };
}

test('pack-status inspection accepts only read-only status', () => {
  assert.deepEqual(parsePackStatusOutboxControlArgs(['status']), { command: 'status' });
  for (const args of [[], ['prepare'], ['activate'], ['status', '--write'], ['status', '--expected-revision', '2']]) {
    assert.throws(() => parsePackStatusOutboxControlArgs(args), /read-only/);
  }
});

test('uninitialized pack-status reports readiness and never imports markers', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  const query = commerceTestQuery(database);
  const result = await runPackStatusOutboxControl(['status'], { query: (sql) => { assert.match(sql, /^SELECT/); return query(sql); } });
  assert.equal(result.mode, 'legacy');
  assert.equal(result.preparation, 'idle');
  assert.match(result.validationError || '', /not initialized/);
  assert.deepEqual(result.groups, []);
});

test('active pack-status inspection is bounded, read-only and preserves terminal retry metadata', async (t) => {
  const { harness, query } = fixture(t, 53, true);
  for (let id = 1; id <= 53; id += 1) seedPackStatusOutbox(harness, { ...record(id),
    state: 'completed', nextAttemptAtMs: null, completedAtMs: 10, updatedAtMs: 10, failureCount: 2 });
  const before = query('SELECT * FROM commerce_pack_status_outbox ORDER BY parent_path');
  let pages = 0;
  const result = await runPackStatusOutboxControl(['status'], { query: (sql) => {
    assert.match(sql, /^SELECT/);
    if (sql.includes('SELECT outbox.*, document.document_kind')) { pages += 1; assert.match(sql, /LIMIT 25$/); }
    return query(sql);
  } });
  assert.equal(pages, 3);
  assert.equal(result.projectionCount, 53);
  assert.equal(result.validationError, null);
  assert.equal(result.groups[0].state, 'completed');
  assert.deepEqual(query('SELECT * FROM commerce_pack_status_outbox ORDER BY parent_path'), before);
});

test('active status detects lost historical obligations without inventing work for unmarked orders', async (t) => {
  const { harness, query } = fixture(t, 1, true);
  const missing = await runPackStatusOutboxControl(['status'], { query });
  assert.match(missing.validationError || '', /outbox is missing/);
  assert.equal(query('SELECT COUNT(*) AS count FROM commerce_pack_status_outbox')[0].count, 0);
  seedPackStatusOutbox(harness, record(1));
  assert.equal((await runPackStatusOutboxControl(['status'], { query })).validationError, null);
  const unmarked = fixture(t);
  const empty = await runPackStatusOutboxControl(['status'], { query: unmarked.query });
  assert.equal(empty.validationError, null);
  assert.equal(empty.projectionCount, 0);
});

test('active pack-status inspection surfaces corrupt rows and parent mismatches', async (t) => {
  const { harness, query } = fixture(t);
  seedPackStatusOutbox(harness, record(1));
  for (const patch of [{ parent_kind: 'stripe_checkout' }, { parent_drop_id: 'other' }, { failure_count: -1 }]) {
    const result = await runPackStatusOutboxControl(['status'], { query: (sql) => query(sql).map((row) =>
      sql.includes('SELECT outbox.*, document.document_kind') ? { ...row, ...patch } : row) });
    assert.ok(result.validationError);
  }
});
