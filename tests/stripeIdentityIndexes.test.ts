import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  stripeChargebackLinkedSessionsQuery,
  stripeChargebackMatchedDocumentsQuery,
  type CommerceSqlQuery,
} from '../cloud/workers/api/src/commerceQueries.ts';

const migrationName = '0012_stripe_identity_lookup_indexes.sql';
const migrationDirectory = new URL('../cloud/workers/api/commerce-migrations/', import.meta.url);
const migrationSql = readFileSync(new URL(migrationName, migrationDirectory), 'utf8');
const indexNames = [
  'commerce_documents_stripe_payment_intent',
  'commerce_stripe_checkouts_session_id',
  'commerce_stripe_delivery_orders_session_id',
];
const previousLinkedSessionsSql = `SELECT DISTINCT
  CASE WHEN document_kind = 'stripe_checkout' THEN document_id
    ELSE json_extract(document_json, '$.stripeCheckoutSessionId') END AS session_id
  FROM commerce_documents
  WHERE (document_kind = 'stripe_checkout' OR (document_kind = 'delivery_order' AND source = ?))
    AND json_extract(document_json, '$.stripePaymentIntentId') = ?`;
const previousMatchedDocumentsSql = `SELECT document_path, document_kind, document_id, drop_id, document_json
  FROM commerce_documents
  WHERE (document_kind = 'stripe_checkout' AND document_id = ?)
    OR (document_kind = 'delivery_order' AND source = ?
      AND json_extract(document_json, '$.stripeCheckoutSessionId') = ?)`;

function beforeMigration(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(migrationDirectory).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name < migrationName).sort()) {
    db.exec(readFileSync(new URL(name, migrationDirectory), 'utf8'));
  }
  db.exec(`INSERT INTO commerce_authority_control_lease VALUES (
    1, '00000000-0000-4000-8000-000000000712',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
  );
  UPDATE commerce_authority_control SET
    paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1 AND authority_state = 'paused' AND paused_at_ms IS NULL;
  UPDATE commerce_authority_control SET
    authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1 AND authority_state = 'paused';
  DELETE FROM commerce_authority_control_lease;`);
  return db;
}

function seed(db: DatabaseSync, kind: 'stripe_checkout' | 'delivery_order' | 'offchain_order' | 'box_assignment', id: string,
  data: Record<string, unknown>, dropId = 'drop'): void {
  const collection = {
    stripe_checkout: 'stripeCheckouts', delivery_order: 'deliveryOrders',
    offchain_order: 'offchainOrders', box_assignment: 'boxAssignments',
  }[kind];
  db.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json,
    version, create_time, update_time, processed_at_seconds, processed_at_nanos
  ) VALUES (?, ?, ?, ?, ?, 1, '2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z', 100, 123)`)
    .run(`drops/${dropId}/${collection}/${id}`, kind, dropId, id, JSON.stringify(data));
  db.exec(`UPDATE commerce_authority_control SET documents_revision = documents_revision + 1
    WHERE singleton = 1`);
}

function sortedRows(db: DatabaseSync, query: CommerceSqlQuery): string[] {
  return db.prepare(query.sql).all(...query.bindings).map((row) => JSON.stringify(row)).sort();
}

function snapshot(db: DatabaseSync): unknown {
  return {
    documents: db.prepare('SELECT * FROM commerce_documents ORDER BY document_path').all(),
    pathRevisions: db.prepare('SELECT * FROM commerce_document_path_revisions ORDER BY document_path').all(),
    ownerRevisions: db.prepare('SELECT * FROM commerce_delivery_owner_revisions ORDER BY owner').all(),
    authority: db.prepare('SELECT * FROM commerce_authority_control').all(),
    leases: db.prepare('SELECT * FROM commerce_authority_control_lease').all(),
  };
}

test('Stripe identity indexes preserve lookup results for mixed kinds and malformed identity fields', (context) => {
  const db = beforeMigration();
  context.after(() => db.close());
  const missing = Symbol('missing');
  const values = [missing, null, 1, true, {}, [], ['pi_target'], 'pi_target', 'pi_other'];
  let index = 0;
  for (const kind of ['stripe_checkout', 'delivery_order', 'offchain_order'] as const) {
    for (const paymentIntent of values) {
      for (const sessionId of [missing, null, 1, false, {}, [], ['cs_live_target'], 'cs_live_target', 'cs_test_target', 'bad-session']) {
        for (const source of [missing, null, 1, {}, 'stripe_offchain', 'admin_irl_redeem']) {
          seed(db, kind, `cs_live_fixture_${index++}`, Object.fromEntries([
            ['stripePaymentIntentId', paymentIntent], ['stripeCheckoutSessionId', sessionId], ['source', source],
          ].filter(([, value]) => value !== missing)));
        }
      }
    }
  }
  for (const dropId of ['drop_a', 'drop_b']) {
    for (const kind of ['stripe_checkout', 'delivery_order'] as const) {
      seed(db, kind, 'cs_live_target', {
        stripePaymentIntentId: 'pi_target', stripeCheckoutSessionId: 'cs_live_target', source: 'stripe_offchain',
      }, dropId);
    }
  }
  const cases = [
    ...['pi_target', 'pi_other', 'pi_absent'].map((id) => ({
      current: stripeChargebackLinkedSessionsQuery(id), previousSql: previousLinkedSessionsSql,
    })),
    ...['cs_live_target', 'cs_test_target', 'bad-session', 'cs_live_absent'].map((id) => ({
      current: stripeChargebackMatchedDocumentsQuery(id), previousSql: previousMatchedDocumentsSql,
    })),
  ];
  const expected = cases.map(({ current, previousSql }) => sortedRows(db, { ...current, sql: previousSql }));
  db.exec(migrationSql);
  for (const [index, { current }] of cases.entries()) {
    assert.deepEqual(sortedRows(db, current), expected[index]);
  }
  const linked = db.prepare(stripeChargebackLinkedSessionsQuery('pi_target').sql)
    .all(...stripeChargebackLinkedSessionsQuery('pi_target').bindings);
  assert.equal(linked.filter((row) => row.session_id === 'cs_live_target').length, 1);
  assert.ok(linked.some((row) => row.session_id === null));
  const matches = db.prepare(stripeChargebackMatchedDocumentsQuery('cs_live_target').sql)
    .all(...stripeChargebackMatchedDocumentsQuery('cs_live_target').bindings);
  assert.deepEqual(new Set(matches.map((row) => row.drop_id)), new Set(['drop', 'drop_a', 'drop_b']));
});

test('Stripe identity lookups search identifier indexes before and after ANALYZE', (context) => {
  const db = beforeMigration();
  context.after(() => db.close());
  for (let index = 0; index < 512; index += 1) {
    for (const kind of ['stripe_checkout', 'delivery_order', 'offchain_order'] as const) {
      seed(db, kind, `cs_live_${index}`, {
        source: 'stripe_offchain', stripePaymentIntentId: `pi_${index}`, stripeCheckoutSessionId: `cs_live_${index}`,
      });
    }
  }
  db.exec(migrationSql);
  const cases = [
    { query: stripeChargebackLinkedSessionsQuery('pi_255'), searches: [
      ['commerce_documents_stripe_payment_intent', '<expr>=?'],
    ] },
    { query: stripeChargebackMatchedDocumentsQuery('cs_live_255'), searches: [
      ['commerce_stripe_checkouts_session_id', 'document_id=?'],
      ['commerce_stripe_delivery_orders_session_id', 'source=? AND <expr>=?'],
    ] },
  ];
  for (const analyze of [false, true]) {
    if (analyze) db.exec('ANALYZE');
    for (const { query, searches } of cases) {
      const details = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings).map((row) => String(row.detail));
      for (const [indexName, constraint] of searches) {
        assert.ok(details.some((detail) => detail.includes('SEARCH ') && detail.includes(indexName) && detail.includes(constraint)),
          `Expected ${indexName} lookup with ${constraint}: ${details.join('; ')}`);
      }
      assert.ok(details.every((detail) => !/SCAN commerce_documents\b/.test(detail)), details.join('; '));
    }
  }
});

test('Stripe identity migration refreshes statistics for databases with analyzed assignment history', (context) => {
  const db = beforeMigration();
  context.after(() => db.close());
  for (let index = 0; index < 3000; index += 1) {
    seed(db, 'box_assignment', `box_${index}`, { dudeIds: [index + 1] });
  }
  seed(db, 'stripe_checkout', 'cs_live_actual', { stripePaymentIntentId: 'pi_actual' });
  seed(db, 'delivery_order', '42', {
    source: 'stripe_offchain', stripePaymentIntentId: 'pi_actual', stripeCheckoutSessionId: 'cs_live_actual',
  });
  db.exec('ANALYZE');
  db.exec(migrationSql);
  const queries = [stripeChargebackLinkedSessionsQuery('pi_check'), stripeChargebackMatchedDocumentsQuery('cs_live_check')];
  const details = queries.flatMap((query) => db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .all(...query.bindings).map((row) => String(row.detail)));
  for (const [indexName, constraint] of [
    ['commerce_documents_stripe_payment_intent', '<expr>=?'],
    ['commerce_stripe_checkouts_session_id', 'document_id=?'],
    ['commerce_stripe_delivery_orders_session_id', 'source=? AND <expr>=?'],
  ]) {
    assert.ok(details.some((detail) => detail.includes(`SEARCH commerce_documents USING INDEX ${indexName} (${constraint})`)),
      `Expected ${indexName} lookup with ${constraint}: ${details.join('; ')}`);
  }
});

for (const state of ['d1', 'paused'] as const) {
  test(`Stripe identity migration preserves populated commerce data and ${state} authority`, (context) => {
    const db = beforeMigration();
    context.after(() => db.close());
    seed(db, 'stripe_checkout', 'cs_live_target', { stripePaymentIntentId: 'pi_target', livemode: true });
    seed(db, 'delivery_order', '42', {
      owner: 'historical_owner', source: 'stripe_offchain', stripeCheckoutSessionId: 'cs_live_target',
      stripePaymentIntentId: 'pi_target', status: 'ready_to_ship',
    });
    if (state === 'paused') {
      db.exec(`INSERT INTO commerce_authority_control_lease VALUES (
        1, '00000000-0000-4000-8000-000000000713',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
      );
      UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE singleton = 1;
      DELETE FROM commerce_authority_control_lease;`);
    }
    const before = snapshot(db);
    const schemaBefore = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name').all();
    db.exec(migrationSql);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare('SELECT authority_state FROM commerce_authority_control').get()?.authority_state, state);
    const schemaAfter = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name').all();
    assert.deepEqual(schemaAfter.filter((row) => !indexNames.includes(String(row.name))), schemaBefore);
    assert.deepEqual(schemaAfter.filter((row) => indexNames.includes(String(row.name))).map((row) => row.name), indexNames);
  });
}
