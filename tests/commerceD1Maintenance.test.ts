import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  parseCommerceD1DocumentRow,
  withCommerceMaintenanceLease,
} from '../scripts/shared/commerceD1Maintenance.ts';

function row(overrides: Record<string, unknown> = {}) {
  return {
    document_path: 'drops/card_nft_2/deliveryOrders/123',
    document_kind: 'delivery_order',
    drop_id: 'card_nft_2',
    document_id: '123',
    document_json: JSON.stringify({ deliveryId: 123, status: 'processing' }),
    version: 2,
    create_time: '2026-08-25T10:00:00.000000000Z',
    update_time: '2026-08-25T10:01:00.000000002Z',
    ...overrides,
  };
}

test('Commerce D1 document rows decode exact identity and JSON data', () => {
  const document = parseCommerceD1DocumentRow(row());
  assert.equal(document.path, 'drops/card_nft_2/deliveryOrders/123');
  assert.equal(document.kind, 'delivery_order');
  assert.equal(document.dropId, 'card_nft_2');
  assert.equal(document.documentId, '123');
  assert.equal(document.version, 2);
  assert.deepEqual(document.data, { deliveryId: 123, status: 'processing' });
});

test('Commerce D1 document rows reject malformed data and inconsistent identity', () => {
  assert.throws(() => parseCommerceD1DocumentRow(row({ document_json: '{' })), /JSON is invalid/);
  assert.throws(() => parseCommerceD1DocumentRow(row({ document_json: '[]' })), /JSON is invalid/);
  assert.throws(() => parseCommerceD1DocumentRow(row({ drop_id: 'other' })), /identity is inconsistent/);
  assert.throws(() => parseCommerceD1DocumentRow(row({ document_kind: 'claim_code' })), /identity is inconsistent/);
  assert.throws(() => parseCommerceD1DocumentRow(row({ version: 0 })), /version is invalid/);
  assert.throws(() => parseCommerceD1DocumentRow(row({ update_time: 'invalid' })), /identity is inconsistent/);
  assert.throws(() => parseCommerceD1DocumentRow(row({ document_path: 'unsupported/path' })), /path is unsupported/);
  assert.throws(() => parseCommerceD1DocumentRow(row({
    document_path: 'drops/dröp/deliveryOrders/7',
    drop_id: 'dröp',
  })), /path is unsupported/);
});

const leaseToken = '00000000-0000-4000-8000-000000000abc';
const releaseFailureMessage = 'Maintenance failed and its lease release could not be confirmed.';

function leaseDatabase(context: { after: (cleanup: () => void) => void }) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  db.exec(`CREATE TABLE commerce_authority_control_lease (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    lease_token TEXT NOT NULL,
    acquired_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  ) STRICT`);
  const statements: string[] = [];
  const query = (sql: string) => {
    statements.push(sql);
    return db.prepare(sql).all().map((row) => ({ ...row }));
  };
  const count = () => Number(db.prepare('SELECT COUNT(*) AS count FROM commerce_authority_control_lease').get()!.count);
  return { db, query, statements, count };
}

test('maintenance lease remains owned until the final asynchronous result settles', async (context) => {
  const { db, query, count } = leaseDatabase(context);
  const started = Promise.withResolvers<void>();
  const summary = Promise.withResolvers<{ ready: boolean }>();
  const result = withCommerceMaintenanceLease({ query, token: leaseToken.toUpperCase(), releaseFailureMessage }, async ({ token }) => {
    assert.equal(token, leaseToken);
    assert.equal(db.prepare('SELECT lease_token FROM commerce_authority_control_lease').get()!.lease_token, token);
    started.resolve();
    return summary.promise;
  });
  await started.promise;
  assert.equal(count(), 1);
  const expected = { ready: true };
  summary.resolve(expected);
  assert.equal(await result, expected);
  assert.equal(count(), 0);
});

test('maintenance acquisition failure neither runs the operation nor releases another owner', async (context) => {
  const { db, query, statements, count } = leaseDatabase(context);
  db.prepare('INSERT INTO commerce_authority_control_lease VALUES (1, ?, 0, ?)')
    .run('00000000-0000-4000-8000-000000000def', Date.now() + 60_000);
  await assert.rejects(withCommerceMaintenanceLease({ query, token: leaseToken, releaseFailureMessage }, async () => {
    assert.fail('The operation must not run without its lease.');
  }), /already running/);
  assert.equal(count(), 1);
  assert.equal(statements.length, 1);
});

test('maintenance renewal waits sixty seconds from acquisition and successful renewal completion', async (context) => {
  const { query, count } = leaseDatabase(context);
  let now = 1_000;
  let renewals = 0;
  const timedQuery = (sql: string) => {
    const rows = query(sql);
    if (sql.startsWith('UPDATE commerce_authority_control_lease')) {
      renewals += 1;
      now += 7;
    }
    return rows;
  };
  await withCommerceMaintenanceLease({ query: timedQuery, token: leaseToken, releaseFailureMessage, now: () => now }, async ({ renew }) => {
    now = 60_999;
    await renew();
    assert.equal(renewals, 0);
    now = 61_000;
    await renew();
    assert.equal(renewals, 1);
    now = 121_006;
    await renew();
    assert.equal(renewals, 1);
    now = 121_007;
    await renew();
    assert.equal(renewals, 2);
  });
  assert.equal(count(), 0);
});

test('maintenance renewal failure still releases the expired lease', async (context) => {
  const { db, query, count } = leaseDatabase(context);
  let now = 0;
  await assert.rejects(withCommerceMaintenanceLease({ query, token: leaseToken, releaseFailureMessage, now: () => now }, async ({ renew }) => {
    db.exec('UPDATE commerce_authority_control_lease SET expires_at_ms = 0');
    now = 60_000;
    await renew();
  }), /lease ownership was lost/);
  assert.equal(count(), 0);
});

test('maintenance operation failure is preserved after successful cleanup', async (context) => {
  const { query, count } = leaseDatabase(context);
  const operationError = new Error('Operation failed.');
  await assert.rejects(withCommerceMaintenanceLease({ query, token: leaseToken, releaseFailureMessage }, async () => {
    throw operationError;
  }), (error) => error === operationError);
  assert.equal(count(), 0);
});

test('maintenance release failure overrides a successful result', async (context) => {
  const { query, count } = leaseDatabase(context);
  const failingQuery = (sql: string) => {
    if (sql.startsWith('DELETE FROM commerce_authority_control_lease')) throw new Error('Release failed.');
    return query(sql);
  };
  await assert.rejects(withCommerceMaintenanceLease({ query: failingQuery, token: leaseToken, releaseFailureMessage }, async () => 'done'),
    /Commerce authority coordination lease could not be released/);
  assert.equal(count(), 1);
});

test('maintenance preserves both operation and release failures in order', async (context) => {
  const { query, count } = leaseDatabase(context);
  const operationError = new Error('Operation failed.');
  const failingQuery = (sql: string) => {
    if (sql.startsWith('DELETE FROM commerce_authority_control_lease')) throw new Error('Release failed.');
    return query(sql);
  };
  await assert.rejects(withCommerceMaintenanceLease({ query: failingQuery, token: leaseToken, releaseFailureMessage }, async () => {
    throw operationError;
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, releaseFailureMessage);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0], operationError);
    assert.match(error.errors[1].message, /lease could not be released/);
    return true;
  });
  assert.equal(count(), 1);
});
