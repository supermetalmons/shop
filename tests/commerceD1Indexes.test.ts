import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const schemaSql = readFileSync(
  new URL('../cloud/workers/api/commerce-migrations/0001_current_schema.sql', import.meta.url),
  'utf8',
);

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  return db;
}

function indexColumns(db: DatabaseSync, name: string): string[] {
  return db.prepare(`PRAGMA index_info(${name})`).all().map((row) => String(row.name));
}

function planDetails(db: DatabaseSync, sql: string): string {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => String(row.detail)).join('\n');
}

test('Commerce baseline creates its exact current authority and guard schema', () => {
  const db = database();
  try {
    assert.deepEqual({ ...db.prepare('SELECT * FROM commerce_authority_control').get()! }, {
      singleton: 1,
      authority_state: 'd1',
      revision: 1,
      documents_revision: 0,
      paused_at_ms: null,
      updated_at_ms: 0,
    });
    assert.deepEqual(
      db.prepare(`SELECT name FROM pragma_table_list
        WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`).all().map((row) => String(row.name)),
      [
        'commerce_authority_control',
        'commerce_commit_guards',
        'commerce_documents',
        'commerce_wipe_guards',
      ],
    );
    assert.deepEqual(
      db.prepare(`SELECT name FROM sqlite_schema
        WHERE type = 'trigger' AND name LIKE 'commerce_%'
        ORDER BY name`).all().map((row) => String(row.name)),
      [
        'commerce_authority_delete_guard',
        'commerce_authority_revision_guard',
        'commerce_authority_transition_guard',
        'commerce_commit_guard_validate',
        'commerce_documents_delete_authority_guard',
        'commerce_documents_identity_insert_guard',
        'commerce_documents_identity_update_guard',
        'commerce_documents_insert_authority_guard',
        'commerce_documents_update_authority_guard',
        'commerce_wipe_guard_validate',
      ],
    );
  } finally {
    db.close();
  }
});

test('Commerce authority pause and resume remain revision guarded', () => {
  const db = database();
  try {
    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
      WHERE singleton = 1`);
    assert.throws(() => db.prepare(`INSERT INTO commerce_documents (
      document_path, document_kind, drop_id, document_id, document_json,
      version, create_time, update_time
    ) VALUES ('claimCodes/code', 'claim_code', NULL, 'code', '{}', 1, 'created', 'updated')`).run(),
    /commerce authority is not d1/);
    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'd1', revision = 3, paused_at_ms = NULL, updated_at_ms = 2
      WHERE singleton = 1`);
    assert.throws(() => db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', paused_at_ms = 3, updated_at_ms = 3
      WHERE singleton = 1`), /revision conflict/);
    assert.throws(() => db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'other', revision = 4, updated_at_ms = 3
      WHERE singleton = 1`));
  } finally {
    db.close();
  }
});

test('Commerce baseline keeps required covering and partial indexes', () => {
  const db = database();
  try {
    const insert = db.prepare(`INSERT INTO commerce_documents (
      document_path, document_kind, drop_id, document_id, document_json,
      version, create_time, update_time, processed_at_seconds, processed_at_nanos
    ) VALUES (?, 'delivery_order', 'drop', ?, ?, 1, 'created', 'updated', NULL, NULL)`);
    for (let index = 1; index <= 500; index += 1) {
      insert.run(
        `drops/drop/deliveryOrders/${index}`,
        String(index),
        JSON.stringify({
          owner: index % 2 ? 'owner' : 'other',
          status: 'ready_to_ship',
          buyerOrderReceivedEmailState: index === 100 ? 'pending' : 'queued',
          shipperReadyToShipEmailState: index === 200 ? 'pending' : 'queued',
        }),
      );
    }
    db.exec('ANALYZE');
    assert.deepEqual(indexColumns(db, 'commerce_documents_delivery_owner_path'), [
      'owner',
      'document_path',
    ]);
    assert.equal(
      String(db.prepare(`SELECT sql FROM sqlite_schema
        WHERE type = 'index' AND name = 'commerce_documents_delivery_owner_path'`).get()!.sql)
        .replace(/\s+/g, ' ')
        .trim(),
      `CREATE INDEX commerce_documents_delivery_owner_path ON commerce_documents (owner, document_path)
        WHERE document_kind = 'delivery_order'`.replace(/\s+/g, ' ').trim(),
    );
    assert.deepEqual(indexColumns(db, 'commerce_documents_pack_projection'), [
      'document_kind',
      'drop_id',
      'pack_projection_state',
      'pack_projection_next_attempt_ms',
      'document_path',
    ]);
    assert.deepEqual(indexColumns(db, 'commerce_delivery_orders_buyer_notifications_pending'), ['document_path']);
    assert.deepEqual(indexColumns(db, 'commerce_delivery_orders_shipper_notifications_pending'), ['document_path']);
    assert.deepEqual(indexColumns(db, 'commerce_stripe_checkouts_reconciliation_due'), ['null', 'document_path']);
    assert.match(planDetails(db, `SELECT document_path FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND owner = 'owner'
      ORDER BY document_path LIMIT 450`), /commerce_documents_delivery_owner_path/);
    const notificationPlan = planDetails(db, `WITH candidate_paths AS (
      SELECT document_path FROM commerce_documents
        INDEXED BY commerce_delivery_orders_buyer_notifications_pending
      WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship'
        AND buyer_notification_state = 'pending' AND document_path > 'drops/a/deliveryOrders/1'
      UNION
      SELECT document_path FROM commerce_documents
        INDEXED BY commerce_delivery_orders_shipper_notifications_pending
      WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship'
        AND shipper_notification_state = 'pending' AND document_path > 'drops/a/deliveryOrders/1'
    ) SELECT document_path FROM candidate_paths ORDER BY document_path LIMIT 8`);
    assert.match(notificationPlan, /commerce_delivery_orders_buyer_notifications_pending/);
    assert.match(notificationPlan, /commerce_delivery_orders_shipper_notifications_pending/);
    assert.match(planDetails(db, `SELECT document_path FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND drop_id = 'drop'
        AND pack_projection_state = 'pending' AND pack_projection_next_attempt_ms <= 1
      ORDER BY pack_projection_next_attempt_ms, document_path LIMIT 4`), /commerce_documents_pack_projection/);
    assert.match(planDetails(db, `SELECT document_path FROM commerce_documents
      WHERE document_kind = 'stripe_checkout'
        AND fulfillment_processor = 'cloudflare_queue_v1'
        AND status IN ('fulfillment_pending', 'processing')
        AND json_type(document_json, '$.updatedAt') IN ('integer', 'real')
        AND json_type(document_json, '$.lastStripeWebhookEventId') = 'text'
        AND CAST(json_extract(document_json, '$.updatedAt') AS INTEGER) <= 1
      ORDER BY CAST(json_extract(document_json, '$.updatedAt') AS INTEGER), document_path LIMIT 100`),
    /commerce_stripe_checkouts_reconciliation_due/);
  } finally {
    db.close();
  }
});

test('Commerce baseline rejects root identity subjects and preserves nested snapshots', () => {
  const db = database();
  try {
    const document = {
      authSubject: 'anon:subject',
      owner: 'anonymous:anon:subject',
      ownerKind: 'anonymous',
      snapshot: { uid: 'historical-subject' },
      status: 'created',
    };
    db.prepare(`INSERT INTO commerce_documents (
      document_path, document_kind, drop_id, document_id, document_json,
      version, create_time, update_time
    ) VALUES (?, 'stripe_checkout', 'drop', 'session', ?, 1, 'created', 'updated')`)
      .run('drops/drop/stripeCheckouts/session', JSON.stringify(document));
    assert.equal(
      JSON.parse(String(db.prepare(`SELECT document_json FROM commerce_documents
        WHERE document_path = 'drops/drop/stripeCheckouts/session'`).get()!.document_json)).snapshot.uid,
      'historical-subject',
    );
    assert.throws(() => db.prepare(`UPDATE commerce_documents
      SET document_json = json_set(document_json, '$.uid', 'subject')
      WHERE document_path = 'drops/drop/stripeCheckouts/session'`).run(),
    /noncanonical identity data/);
  } finally {
    db.close();
  }
});
