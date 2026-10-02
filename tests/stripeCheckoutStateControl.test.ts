import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStripeCheckoutStateControlArgs, runStripeCheckoutStateControl } from '../scripts/ops/stripeCheckoutStateControl.ts';
import { queryRemoteCommerceDocuments } from '../scripts/shared/commerceD1Maintenance.ts';
import { commerceKeys } from '../cloud/workers/api/src/commerceDocumentCodec.ts';
import { createCommerceD1Harness, seedCommerceDocument, seedCommerceDocuments,
  type CommerceD1Harness } from '../cloud/workers/api/test/commerceD1Harness.ts';
import { commerceTestQuery, createCurrentCommerceDatabase } from './helpers/commerceDatabase.ts';

const sourceSql = "SELECT * FROM commerce_documents WHERE document_kind = 'stripe_checkout' ORDER BY document_path";

function currentHarness(context: { after: (cleanup: () => void) => void }): CommerceD1Harness {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  return harness;
}

function seed(harness: CommerceD1Harness, id: string, data: Record<string, unknown> = {}, version = 1): void {
  seedCommerceDocument(harness, {
    key: commerceKeys.stripeCheckout('drop', id),
    data: { status: 'processing', updatedAt: 1000, ...data },
    version,
  });
}

test('checkout control exposes only read-only status and rejects retired writes before querying', async () => {
  assert.deepEqual(parseStripeCheckoutStateControlArgs(['status']), { command: 'status' });
  for (const args of [[], ['prepare'], ['activate', '--write', '--expected-revision', '2', '--worker-deployed'],
    ['status', '--write'], ['status', '--expected-revision', '2']]) {
    assert.throws(() => parseStripeCheckoutStateControlArgs(args), /read-only/);
    await assert.rejects(runStripeCheckoutStateControl(args, {
      query: () => { assert.fail('Invalid commands must not access the database.'); },
    }), /read-only/);
  }
});

test('checkout status reports uninitialized storage without migrating it', async (context) => {
  const database = createCurrentCommerceDatabase(context);
  const query = commerceTestQuery(database);
  const before = query('SELECT * FROM commerce_stripe_checkout_state_control');
  const status = await runStripeCheckoutStateControl(['status'], { query: (sql) => {
    assert.match(sql, /^SELECT/);
    return query(sql);
  } });
  assert.equal(status.mode, 'legacy');
  assert.equal(status.preparation, 'idle');
  assert.match(status.validationError!, /not initialized/);
  assert.deepEqual(query('SELECT * FROM commerce_stripe_checkout_state_control'), before);
});

test('checkout status validates native rows in bounded read-only pages', async (context) => {
  const harness = currentHarness(context);
  seedCommerceDocuments(harness, Array.from({ length: 56 }, (_, index) => ({
    key: commerceKeys.stripeCheckout('drop', 'cs_' + String(index).padStart(3, '0')),
    data: { status: 'processing', updatedAt: 1000, processingLeaseExpiresAt: 1 },
  })));
  const query = commerceTestQuery(harness.database);
  const before = query('SELECT * FROM commerce_stripe_checkout_state ORDER BY document_path');
  let pages = 0;
  const result = await runStripeCheckoutStateControl(['status'], { query: (sql) => {
    assert.match(sql, /^SELECT/);
    const rows = query(sql);
    if (sql.startsWith('SELECT checkout.*,')) {
      pages += 1;
      assert.ok(rows.length <= 25);
    }
    return rows;
  } });
  assert.equal(result.mode, 'table');
  assert.equal(result.preparation, 'ready');
  assert.equal(result.checkoutCount, 56);
  assert.equal(result.validationError, null);
  assert.equal(result.groups[0].expired_claims, 56);
  assert.equal(pages, 3);
  assert.deepEqual(query('SELECT * FROM commerce_stripe_checkout_state ORDER BY document_path'), before);
});

test('maintenance hydration preserves checkout lifecycle fields and ignores stale metadata copies', (context) => {
  const harness = currentHarness(context);
  const fields = { status: 'processing', updatedAt: 1000, processingAttemptId: 'attempt', processingAttemptCount: 3,
    processingStartedAt: 900, processingLeaseExpiresAt: 2000, lastRetryableFulfillmentAttempt: 2,
    lastRetryableFulfillmentErrorAt: 800, nextFulfillmentRetryAt: 2100, fulfillmentQueueReenqueuedAt: 700,
    lastFulfillmentReconciliationErrorAt: 600, payment: { futureMetadata: 'preserved' } };
  seed(harness, 'cs_1', fields);
  const query = commerceTestQuery(harness.database);
  const before = query('SELECT * FROM commerce_documents');
  assert.equal(Object.hasOwn(JSON.parse(String(before[0].document_json)), 'status'), false);
  const hydrated = queryRemoteCommerceDocuments(sourceSql, (sql) => query(sql).map((row) =>
    sql.startsWith('SELECT snapshot.document_path,') ? { ...row,
      document_json: JSON.stringify({ ...JSON.parse(String(row.document_json)), status: 'fulfilled', updatedAt: 9999 }),
    } : row));
  assert.deepEqual(hydrated[0].data, fields);
  assert.equal(hydrated[0].version, 1);
  assert.deepEqual(query('SELECT * FROM commerce_documents'), before);
});

test('checkout status and hydration reject missing, mismatched, and malformed state without repairing it', async (context) => {
  const harness = currentHarness(context);
  seed(harness, 'cs_1');
  const query = commerceTestQuery(harness.database);
  const before = query('SELECT * FROM commerce_stripe_checkout_state');
  for (const change of [{ document_version: 2 }, { processing_attempt_count: -1 }]) {
    const status = await runStripeCheckoutStateControl(['status'], { query: (sql) => {
      assert.match(sql, /^SELECT/);
      return query(sql).map((row) => sql.startsWith('SELECT checkout.*,') ? { ...row, ...change } : row);
    } });
    assert.match(status.validationError!, /differs from source|Invalid Stripe checkout state/);
    assert.throws(() => queryRemoteCommerceDocuments(sourceSql, (sql) => query(sql).map((row) =>
      sql.startsWith('SELECT snapshot.document_path,') ? { ...row,
        checkout_state_json: JSON.stringify({ ...JSON.parse(String(row.checkout_state_json)), ...change }),
      } : row)), /missing or stale|Invalid Stripe checkout state/);
  }
  assert.throws(() => queryRemoteCommerceDocuments(sourceSql, (sql) => query(sql).map((row) =>
    sql.startsWith('SELECT snapshot.document_path,') ? { ...row, checkout_state_json: null } : row)), /missing or stale/);
  const status = await runStripeCheckoutStateControl(['status'], { query: (sql) => query(sql).map((row) =>
    sql.startsWith('SELECT checkout.*,') ? { ...row, document_path: null } : row) });
  assert.match(status.validationError!, /Invalid Stripe checkout state/);
  assert.deepEqual(query('SELECT * FROM commerce_stripe_checkout_state'), before);
});

test('checkout hydration returns one coherent snapshot across concurrent metadata and lifecycle updates', (context) => {
  for (const moment of ['before-snapshot', 'after-snapshot'] as const) {
    const harness = currentHarness(context);
    seed(harness, 'cs_1', { snapshotLabel: 'original' });
    const query = commerceTestQuery(harness.database);
    let updated = false;
    let snapshots = 0;
    const documents = queryRemoteCommerceDocuments(sourceSql, (sql) => {
      assert.notEqual(sql, sourceSql);
      const rows = query(sql);
      const snapshot = sql.startsWith('SELECT snapshot.document_path,');
      if (snapshot) snapshots += 1;
      if (!updated && (moment === 'before-snapshot' ? !snapshot : snapshot)) {
        seed(harness, 'cs_1', { snapshotLabel: 'updated', status: 'fulfilled', updatedAt: 2000 }, 2);
        updated = true;
      }
      return rows;
    });
    assert.equal(updated, true);
    assert.equal(snapshots, 1);
    const fresh = moment === 'before-snapshot';
    assert.equal(documents[0].version, fresh ? 2 : 1);
    assert.equal(documents[0].data.snapshotLabel, fresh ? 'updated' : 'original');
    assert.equal(documents[0].data.status, fresh ? 'fulfilled' : 'processing');
    assert.equal(documents[0].data.updatedAt, fresh ? 2000 : 1000);
  }
});

test('maintenance hydration retains source filtering, ordering, limits, and noncheckout fields', (context) => {
  const harness = currentHarness(context);
  for (const id of ['cs_1', 'cs_2', 'cs_3']) seed(harness, id);
  seedCommerceDocument(harness, { key: commerceKeys.claimCode('CODE'), data: { status: 'unused' } });
  const query = commerceTestQuery(harness.database);
  const selected = queryRemoteCommerceDocuments("SELECT * FROM commerce_documents WHERE document_kind = 'stripe_checkout' " +
    "AND document_id <> 'cs_2' ORDER BY document_id DESC LIMIT 1;", query);
  assert.deepEqual(selected.map((document) => document.documentId), ['cs_3']);
  assert.deepEqual(queryRemoteCommerceDocuments("SELECT * FROM commerce_documents WHERE document_kind = 'claim_code'", query)[0].data,
    { status: 'unused' });
});

test('maintenance reads require current tables and active modes even when their result is empty', (context) => {
  const initial = createCurrentCommerceDatabase(context);
  assert.throws(() => queryRemoteCommerceDocuments(sourceSql, commerceTestQuery(initial)), /requires active checkout/);
  for (const table of ['commerce_stripe_checkout_state_control', 'commerce_stripe_checkout_state']) {
    const harness = currentHarness(context);
    const query = commerceTestQuery(harness.database);
    assert.deepEqual(queryRemoteCommerceDocuments(sourceSql, query), []);
    harness.database.exec('DROP TABLE ' + table);
    assert.throws(() => queryRemoteCommerceDocuments(sourceSql, query), /no such table/);
  }
  const harness = currentHarness(context);
  const query = commerceTestQuery(harness.database);
  for (const changes of [{ checkout_state_mode: 'legacy' }, { recovery_state_mode: null }]) {
    assert.throws(() => queryRemoteCommerceDocuments(sourceSql, (sql) => query(sql).map((row) => ({ ...row, ...changes }))),
      /requires active checkout/);
  }
});
