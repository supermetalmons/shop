import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNotificationOutboxControlArgs, runNotificationOutboxControl } from '../scripts/ops/notificationOutboxControl.ts';
import { commerceKeys } from '../cloud/workers/api/src/commerceRepository.ts';
import { createCommerceD1Harness, seedCommerceDocuments, seedNotificationOutbox } from '../cloud/workers/api/test/commerceD1Harness.ts';
import { parseNotificationOutboxRow, type NotificationOutboxRecord } from '../shared/notificationOutbox.ts';
import { commerceTestQuery, createCurrentCommerceDatabase } from './helpers/commerceDatabase.ts';

function record(id: number): NotificationOutboxRecord {
  return { parentPath: `drops/drop/deliveryOrders/${id}`, family: 'ready', dropId: 'drop', generation: crypto.randomUUID(),
    outcome: null, state: 'pending', entries: [{ kind: 'buyer_order_received', jobId: crypto.randomUUID(),
      idempotencyKey: `drop:${id}:order_received`, state: 'pending' }], revision: 1, attemptCount: 0,
    nextAttemptAtMs: 0, claimId: null, claimExpiresAtMs: null, retryUntilMs: 10000,
    createdAtMs: 0, updatedAtMs: 0, lastErrorCode: null };
}

function fixture(t: test.TestContext, count = 1) {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  seedCommerceDocuments(harness, Array.from({ length: count }, (_, index) => ({
    key: commerceKeys.deliveryOrder('drop', String(index + 1)), data: { status: 'ready_to_ship', deliveryId: index + 1 },
  })));
  for (let id = 1; id <= count; id += 1) seedNotificationOutbox(harness, record(id));
  return { harness, query: commerceTestQuery(harness.database) };
}

test('notification inspection accepts only read-only status', () => {
  assert.deepEqual(parseNotificationOutboxControlArgs(['status']), { command: 'status' });
  for (const args of [[], ['prepare'], ['activate'], ['status', '--write'], ['status', '--expected-revision', '2']]) {
    assert.throws(() => parseNotificationOutboxControlArgs(args), /read-only/);
  }
});

test('uninitialized status reports readiness without importing any historical data', async (t) => {
  const database = createCurrentCommerceDatabase(t);
  const query = commerceTestQuery(database);
  const result = await runNotificationOutboxControl(['status'], { query: (sql) => { assert.match(sql, /^SELECT/); return query(sql); } });
  assert.equal(result.mode, 'legacy');
  assert.equal(result.preparation, 'idle');
  assert.match(result.validationError || '', /not initialized/);
  assert.deepEqual(result.groups, []);
});

test('active notification status validates bounded pages without writes or payload changes', async (t) => {
  const { query } = fixture(t, 53);
  const before = query('SELECT * FROM commerce_notification_outbox ORDER BY parent_path');
  let pages = 0;
  const result = await runNotificationOutboxControl(['status'], { query: (sql) => {
    assert.match(sql, /^SELECT/);
    if (sql.includes('SELECT outbox.*, document.document_kind')) { pages += 1; assert.match(sql, /LIMIT 25$/); }
    return query(sql);
  } });
  assert.equal(pages, 3);
  assert.equal(result.mode, 'table');
  assert.equal(result.validationError, null);
  assert.equal(result.groups[0].count, 53);
  assert.deepEqual(query('SELECT * FROM commerce_notification_outbox ORDER BY parent_path'), before);
});

test('notification diagnostics retain current validation errors and failed-state groups', async (t) => {
  const { harness, query } = fixture(t);
  const failed = parseNotificationOutboxRow(query('SELECT * FROM commerce_notification_outbox')[0]);
  failed.revision += 1; failed.updatedAtMs = 1;
  failed.state = 'failed'; failed.nextAttemptAtMs = null; failed.lastErrorCode = 'expired';
  failed.entries = failed.entries.map((entry) => ({ ...entry, state: 'failed', errorCode: 'expired' }));
  seedNotificationOutbox(harness, failed);
  const status = await runNotificationOutboxControl(['status'], { query });
  assert.equal(status.validationError, null);
  assert.equal(status.failures[0].last_error_code, 'expired');
  for (const patch of [{ parent_kind: 'stripe_checkout' }, { parent_drop_id: 'other' }, { attempt_count: -1 }]) {
    const result = await runNotificationOutboxControl(['status'], { query: (sql) => query(sql).map((row) =>
      sql.includes('SELECT outbox.*, document.document_kind') ? { ...row, ...patch } : row) });
    assert.ok(result.validationError);
  }
});
