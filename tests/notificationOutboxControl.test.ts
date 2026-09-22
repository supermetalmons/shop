import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseNotificationOutboxControlArgs, runNotificationOutboxControl } from '../scripts/ops/notificationOutboxControl.ts';
import { planNotificationOutboxBackfill } from '../scripts/shared/notificationOutboxMaintenance.ts';
import { parseCommerceD1DocumentRow } from '../scripts/shared/commerceD1Maintenance.ts';
import { parseNotificationOutboxRow } from '../shared/notificationOutbox.ts';

const timestamp = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
const jobId = '00000000-0000-4000-8000-000000000001';
const secondJobId = '00000000-0000-4000-8000-000000000002';
const claimId = '00000000-0000-4000-8000-000000000003';
const time = Date.parse('2026-09-01T00:00:00.000Z');

function withLease(db: DatabaseSync, operation: () => void) {
  db.exec(`INSERT INTO commerce_authority_control_lease VALUES
    (1, '00000000-0000-4000-8000-000000001099', ${timestamp}, ${timestamp} + 60000)`);
  try { operation(); } finally { db.exec('DELETE FROM commerce_authority_control_lease'); }
}
function database(context: { after: (cleanup: () => void) => void }) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../cloud/workers/api/commerce-migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name <= '0013_notification_outbox.sql').sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  withLease(db, () => db.exec(`UPDATE commerce_authority_control SET paused_at_ms = ${timestamp}, updated_at_ms = ${timestamp};
    UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = ${timestamp}`));
  return db;
}
function pause(db: DatabaseSync) {
  withLease(db, () => db.exec(`UPDATE commerce_authority_control SET authority_state = 'paused',
    revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${timestamp};
    UPDATE commerce_authority_control SET paused_at_ms = ${timestamp}, updated_at_ms = ${timestamp}`));
}
function resume(db: DatabaseSync) {
  withLease(db, () => db.exec(`UPDATE commerce_authority_control SET authority_state = 'd1',
    revision = revision + 1, paused_at_ms = NULL, updated_at_ms = ${timestamp}`));
}
function insert(db: DatabaseSync, id: string, data: unknown, kind = 'delivery_order') {
  const collection = kind === 'delivery_order' ? 'deliveryOrders' : 'stripeCheckouts';
  db.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
  ) VALUES (?, ?, 'drop', ?, ?, 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`)
    .run(`drops/drop/${collection}/${id}`, kind, id, JSON.stringify(data));
  db.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
}
function query(db: DatabaseSync) { return (sql: string) => db.prepare(sql).all().map((row) => ({ ...row })); }
function execute(db: DatabaseSync, command: string, overrides = {}) {
  const revision = db.prepare('SELECT revision FROM commerce_authority_control').get()!.revision;
  return runNotificationOutboxControl([command, ...(command === 'status' ? [] : ['--write', '--expected-revision', String(revision)]),
    ...(command === 'activate' ? ['--worker-deployed'] : [])], { query: query(db), ...overrides });
}
function readyFields(id = 1) {
  return {
    status: 'ready_to_ship', deliveryId: id,
    buyerOrderReceivedEmailState: 'pending', buyerOrderReceivedEmailJobId: jobId,
    buyerOrderReceivedEmailIdempotencyKey: `drop:${id}:order_received`,
    shipperReadyToShipEmailState: 'queued', shipperReadyToShipEmailJobId: secondJobId,
    shipperReadyToShipEmailIdempotencyKey: `drop:${id}:ready_to_ship`, shipperReadyToShipEmailQueuedAt: time,
    readyToShipNotificationPublishAttemptCount: 2, readyToShipNotificationRetryUntilMs: time + 9999,
    readyToShipNotificationPublishClaimId: claimId, readyToShipNotificationPublishClaimExpiresAtMs: time + 1000,
  };
}
function payload(id = 1) {
  return { version: 1, jobId, kind: 'buyer_order_received', idempotencyKey: `drop:${id}:order_received`,
    recipients: ['buyer@example.com'], subject: 'Order received', text: 'Saved text', html: '<p>Saved text</p>',
    context: { dropId: 'drop', deliveryId: id } };
}

test('notification control requires deliberate writes and publication confirmation', () => {
  assert.throws(() => parseNotificationOutboxControlArgs(['prepare']), /requires --write/);
  assert.throws(() => parseNotificationOutboxControlArgs(['status', '--write']), /read-only/);
  assert.throws(() => parseNotificationOutboxControlArgs(['activate', '--write', '--expected-revision', '1']), /--worker-deployed/);
});

test('backfill preserves partial batches, payloads, claims, and retry budgets without changing parents', async (context) => {
  const db = database(context);
  insert(db, '1', { ...readyFields(), buyerOrderReceivedEmailJob: payload() });
  insert(db, '2', { status: 'ready_to_ship' });
  const before = query(db)('SELECT * FROM commerce_documents');
  const expected = before.map(parseCommerceD1DocumentRow).flatMap(planNotificationOutboxBackfill);
  pause(db);
  const revisions = query(db)('SELECT documents_revision FROM commerce_authority_control');
  const prepared = await execute(db, 'prepare');
  assert.equal(prepared.preparation, 'ready');
  assert.equal(prepared.plannedGroups, 1);
  assert.deepEqual(query(db)('SELECT * FROM commerce_notification_outbox').map(parseNotificationOutboxRow), expected);
  assert.deepEqual(query(db)('SELECT * FROM commerce_documents'), before);
  assert.deepEqual(query(db)('SELECT documents_revision FROM commerce_authority_control'), revisions);
  assert.throws(() => resume(db), /cutover is incomplete/);
  assert.equal((await execute(db, 'activate')).mode, 'table');
  resume(db);
});

test('legacy shipped pending is terminally ambiguous and queued markers remain queued', async (context) => {
  const db = database(context);
  for (const [id, state] of [[1, 'pending'], [2, 'queued']] as const) insert(db, String(id), {
    buyerOrderShippedEmailState: state, buyerOrderShippedEmailJobId: jobId,
    buyerOrderShippedEmailIdempotencyKey: `drop:${id}:order_shipped`, ...(id === 2 ? { buyerOrderShippedEmailQueuedAt: time } : {}),
  });
  pause(db);
  await execute(db, 'prepare');
  const rows = query(db)('SELECT * FROM commerce_notification_outbox ORDER BY parent_path').map(parseNotificationOutboxRow);
  assert.equal(rows[0].state, 'failed');
  assert.equal(rows[0].lastErrorCode, 'legacy_shipped_delivery_unknown');
  assert.equal(rows[0].entries[0].jobId, jobId);
  assert.equal(rows[0].nextAttemptAtMs, null);
  assert.equal(rows[1].state, 'queued');
  assert.equal(rows[1].entries[0].queuedAtMs, time);
});

test('Stripe terminal backfill retains terminal claims and failed payload snapshots', async (context) => {
  const db = database(context);
  const stripePayload = { ...payload(), kind: 'stripe_checkout_manual_review', idempotencyKey: 'drop:cs_live_1:stripe_manual_review',
    context: { dropId: 'drop', sessionId: 'cs_live_1' } };
  insert(db, 'cs_live_1', { status: 'fulfillment_failed', manualRefundReviewRequired: true,
    stripeTerminalNotificationState: 'failed', stripeTerminalNotificationLastError: 'manual-review-required',
    stripeTerminalNotification: { version: 1, outcome: 'manual_review', jobIds: { stripe_checkout_manual_review: jobId },
      attemptCount: 4, retryUntilMs: time, claimId, jobs: [stripePayload] } }, 'stripe_checkout');
  pause(db);
  await execute(db, 'prepare');
  const row = parseNotificationOutboxRow(query(db)('SELECT * FROM commerce_notification_outbox')[0]);
  assert.equal(row.state, 'failed');
  assert.equal(row.claimId, claimId);
  assert.equal(row.claimExpiresAtMs, null);
  assert.deepEqual(row.entries[0].payload, stripePayload);
});

for (const savedJobs of ['shipper-only', 'empty', 'absent'] as const) {
  test(`Stripe backfill preserves ${savedJobs} saved membership and retry state`, async (context) => {
    const db = database(context);
    const shipper = { ...payload(), jobId: secondJobId, kind: 'shipper_ready_to_ship',
      idempotencyKey: 'drop:1:ready_to_ship', recipients: ['fulfillment@example.com'] };
    const legacy = {
      status: 'fulfilled', deliveryId: 1, stripeTerminalNotificationState: 'pending',
      stripeTerminalNotificationNextAttemptAtMs: time + 1000,
      stripeTerminalNotification: {
        version: 1, outcome: 'fulfilled',
        jobIds: { buyer_order_received: jobId, shipper_ready_to_ship: secondJobId },
        attemptCount: 2, retryUntilMs: time + 9999, claimId,
        ...(savedJobs === 'absent' ? {} : { jobs: savedJobs === 'empty' ? [] : [shipper] }),
      },
    };
    insert(db, 'cs_live_1', legacy, 'stripe_checkout');
    const before = query(db)('SELECT * FROM commerce_documents');
    pause(db);
    await execute(db, 'prepare');
    const row = parseNotificationOutboxRow(query(db)('SELECT * FROM commerce_notification_outbox')[0]);
    assert.deepEqual(row.entries.map((entry) => [entry.kind, entry.jobId, entry.state]), [
      ['buyer_order_received', jobId, savedJobs === 'absent' ? 'pending' : 'queued'],
      ['shipper_ready_to_ship', secondJobId, savedJobs === 'empty' ? 'queued' : 'pending'],
    ]);
    assert.deepEqual(row.entries.map((entry) => entry.idempotencyKey), ['drop:1:order_received', 'drop:1:ready_to_ship']);
    assert.equal(row.attemptCount, 2);
    assert.equal(row.retryUntilMs, time + 9999);
    assert.equal(row.state, savedJobs === 'empty' ? 'queued' : 'pending');
    assert.equal(row.claimId, savedJobs === 'empty' ? null : claimId);
    assert.equal(row.claimExpiresAtMs, savedJobs === 'empty' ? null : time + 1000);
    assert.equal(row.nextAttemptAtMs, savedJobs === 'empty' ? null : time + 1000);
    assert.deepEqual(row.entries[1].payload, savedJobs === 'shipper-only' ? shipper : undefined);
    assert.deepEqual(query(db)('SELECT * FROM commerce_documents'), before);
    await execute(db, 'activate');
    assert.deepEqual(parseNotificationOutboxRow(query(db)('SELECT * FROM commerce_notification_outbox')[0]), row);
  });
}

test('an empty saved Stripe manifest does not revive an already failed group', async (context) => {
  const db = database(context);
  insert(db, 'cs_live_1', { status: 'fulfilled', deliveryId: 1,
    stripeTerminalNotificationState: 'failed', stripeTerminalNotificationLastError: 'manual-review-required',
    stripeTerminalNotification: { version: 1, outcome: 'fulfilled',
      jobIds: { buyer_order_received: jobId, shipper_ready_to_ship: secondJobId },
      attemptCount: 4, retryUntilMs: time, claimId, jobs: [] } }, 'stripe_checkout');
  pause(db);
  await execute(db, 'prepare');
  const row = parseNotificationOutboxRow(query(db)('SELECT * FROM commerce_notification_outbox')[0]);
  assert.equal(row.state, 'failed');
  assert.ok(row.entries.every((entry) => entry.state === 'failed'));
  assert.equal(row.lastErrorCode, 'manual-review-required');
  assert.equal(row.claimId, claimId);
  assert.equal(row.nextAttemptAtMs, null);
});

test('malformed identities block preparation before any cutover writes', async (context) => {
  const db = database(context);
  insert(db, '1', { ...readyFields(), buyerOrderReceivedEmailJobId: 'invalid' });
  pause(db);
  await assert.rejects(execute(db, 'prepare'), /validation failed.*identity/);
  assert.match((await execute(db, 'status')).validationError!, /identity/);
  assert.equal(db.prepare('SELECT preparation_state FROM commerce_notification_outbox_control').get()!.preparation_state, 'idle');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commerce_notification_outbox').get()!.n, 0);
});

test('interrupted import blocks resume and repeated preparation restores a complete identical snapshot', async (context) => {
  const db = database(context);
  for (let id = 1; id <= 30; id += 1) insert(db, String(id), readyFields(id));
  pause(db);
  const normal = query(db);
  let interrupted = false;
  await assert.rejects(execute(db, 'prepare', { query: (sql: string) => {
    const rows = normal(sql);
    if (!interrupted && sql.startsWith('INSERT INTO commerce_notification_outbox (')) {
      interrupted = true;
      throw new Error('lost acknowledgement');
    }
    return rows;
  } }), /lost acknowledgement/);
  assert.throws(() => resume(db), /cutover is incomplete/);
  await assert.rejects(execute(db, 'activate'), /preparation is incomplete/);
  await execute(db, 'prepare');
  const prepared = normal('SELECT * FROM commerce_notification_outbox ORDER BY parent_path');
  await execute(db, 'prepare');
  assert.deepEqual(normal('SELECT * FROM commerce_notification_outbox ORDER BY parent_path'), prepared);
  await execute(db, 'activate');
  assert.throws(() => withLease(db, () => db.exec("UPDATE commerce_notification_outbox_control SET storage_mode = 'legacy'")), /irreversible/);
  assert.deepEqual(normal('SELECT * FROM commerce_notification_outbox ORDER BY parent_path'), prepared);
});

test('activation reconciles lost acknowledgement and active preparation never reimports legacy markers', async (context) => {
  const db = database(context);
  insert(db, '1', readyFields());
  pause(db);
  await execute(db, 'prepare');
  const normal = query(db);
  const activated = await execute(db, 'activate', { query: (sql: string) => {
    const rows = normal(sql);
    if (sql.startsWith("UPDATE commerce_notification_outbox_control SET storage_mode = 'table'")) throw new Error('lost activation acknowledgement');
    return rows;
  } });
  assert.equal(activated.mode, 'table');
  const before = normal('SELECT * FROM commerce_notification_outbox');
  await execute(db, 'prepare');
  assert.deepEqual(normal('SELECT * FROM commerce_notification_outbox'), before);
});

test('maintenance requires a completed pause and refuses stale authority revisions or unfinished wipe', async (context) => {
  const db = database(context);
  await assert.rejects(execute(db, 'prepare'), /pause\/drain/);
  pause(db);
  await assert.rejects(runNotificationOutboxControl(['prepare', '--write', '--expected-revision', '1'], { query: query(db) }), /expected authority revision/);
  const normal = query(db);
  await assert.rejects(execute(db, 'prepare', { query: (sql: string) => sql.startsWith('SELECT guard_id') ? [{ guard_id: 'unfinished' }] : normal(sql) }), /wipe is unfinished/);
});

test('large snapshots are copied within D1 statement bounds', async (context) => {
  const db = database(context);
  insert(db, '1', { ...readyFields(), buyerOrderReceivedEmailJob: { ...payload(), text: 'x'.repeat(30_000), html: 'x'.repeat(60_000) } });
  pause(db);
  const normal = query(db);
  await execute(db, 'prepare', { query: (sql: string) => {
    assert.ok(Buffer.byteLength(sql) < 100_000);
    return normal(sql);
  } });
  assert.equal(parseNotificationOutboxRow(normal('SELECT * FROM commerce_notification_outbox')[0]).entries[0].payload!.html.length, 60_000);
});

test('activation rejects a prepared snapshot after the source epoch changes', async (context) => {
  const db = database(context);
  insert(db, '1', readyFields());
  pause(db);
  await execute(db, 'prepare');
  db.exec('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1');
  await assert.rejects(execute(db, 'activate'), /preparation is incomplete or stale/);
  assert.equal(db.prepare('SELECT storage_mode FROM commerce_notification_outbox_control').get()!.storage_mode, 'legacy');
  assert.throws(() => resume(db), /cutover is incomplete/);
});


test('historical queued shipments without a stored key preserve their confirmed queue identity', async (context) => {
  const db = database(context);
  const queuedAtMs = 1787165800000;
  insert(db, '1', { buyerOrderShippedEmailState: 'queued', buyerOrderShippedEmailJobId: jobId,
    buyerOrderShippedEmailQueuedAt: queuedAtMs });
  const before = query(db)('SELECT * FROM commerce_documents');
  assert.equal((await execute(db, 'status')).validationError, null);
  pause(db);
  await execute(db, 'prepare');
  const [row] = query(db)('SELECT * FROM commerce_notification_outbox').map(parseNotificationOutboxRow);
  assert.equal(row.state, 'queued');
  assert.equal(row.nextAttemptAtMs, null);
  assert.deepEqual(row.entries, [{ kind: 'buyer_order_shipped', jobId, state: 'queued',
    idempotencyKey: 'drop:1:order_shipped', queuedAtMs }]);
  await execute(db, 'activate');
  assert.equal(query(db)("SELECT * FROM commerce_notification_outbox WHERE state = 'pending'").length, 0);
  assert.deepEqual(query(db)('SELECT * FROM commerce_documents'), before);
});

test('historical shipped-key recovery rejects ambiguous or malformed marker data', (context) => {
  const db = database(context);
  insert(db, '1', { buyerOrderShippedEmailState: 'queued', buyerOrderShippedEmailJobId: jobId,
    buyerOrderShippedEmailQueuedAt: 1787165800000 });
  const document = parseCommerceD1DocumentRow(query(db)('SELECT * FROM commerce_documents')[0]);
  for (const changed of [
    { buyerOrderShippedEmailState: 'pending' },
    { buyerOrderShippedEmailIdempotencyKey: null },
    { buyerOrderShippedEmailIdempotencyKey: '' },
    { buyerOrderShippedEmailIdempotencyKey: 'wrong-key' },
    { buyerOrderShippedEmailJobId: 'invalid' },
    { buyerOrderShippedEmailQueuedAt: undefined },
    { buyerOrderShippedEmailQueuedAt: null },
    { buyerOrderShippedEmailQueuedAt: -1 },
    { buyerOrderShippedEmailQueuedAt: 1.5 },
    { buyerOrderShippedEmailQueuedAt: '1787165800000' },
  ]) assert.throws(() => planNotificationOutboxBackfill({ ...document, data: { ...document.data, ...changed } }), /validation failed/);
  assert.throws(() => planNotificationOutboxBackfill({ ...document, data: {
    buyerOrderReceivedEmailState: 'queued', buyerOrderReceivedEmailJobId: jobId,
    buyerOrderReceivedEmailQueuedAt: 1787165800000,
  } }), /validation failed/);
});

test('activation catches an unexpected outbox attached to an unmarked historical document', async (context) => {
  const db = database(context);
  insert(db, '1', readyFields());
  insert(db, '2', { status: 'ready_to_ship' });
  pause(db);
  await execute(db, 'prepare');
  withLease(db, () => db.exec(`UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing', prepared_at_ms = NULL;
    INSERT INTO commerce_notification_outbox SELECT 'drops/drop/deliveryOrders/2', family, drop_id, generation,
      outcome, state, entries_json, revision, attempt_count, next_attempt_at_ms, claim_id, claim_expires_at_ms,
      retry_until_ms, created_at_ms, updated_at_ms, last_error_code
      FROM commerce_notification_outbox WHERE parent_path = 'drops/drop/deliveryOrders/1';
    UPDATE commerce_notification_outbox_control SET preparation_state = 'ready', prepared_at_ms = ${timestamp}`));
  await assert.rejects(execute(db, 'activate'), /unexpected records/);
  assert.equal(db.prepare('SELECT storage_mode FROM commerce_notification_outbox_control').get()!.storage_mode, 'legacy');
  assert.throws(() => resume(db), /cutover is incomplete/);
});
