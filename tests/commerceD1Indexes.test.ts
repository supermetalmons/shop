import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const migrations = new URL('../cloud/workers/api/commerce-migrations/', import.meta.url);

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    if (file.startsWith('0009_')) {
      db.exec(`UPDATE commerce_authority_control SET
        authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
        WHERE singleton = 1`);
    }
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  return db;
}

function indexColumns(db: DatabaseSync, name: string): string[] {
  return db.prepare(`PRAGMA index_info(${name})`).all().map((row) => String(row.name));
}

function planDetails(db: DatabaseSync, sql: string): string {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => String(row.detail)).join('\n');
}

test('the final Commerce D1 schema retains its reconciliation indexes', () => {
  const db = database();
  try {
    db.prepare(`INSERT OR IGNORE INTO commerce_import_manifests (
      manifest_sha256, document_count, kind_counts_json, source_updated_at_ms, imported_at_ms, archive_object_prefix
    ) VALUES (?, 0, '{}', 1, 1, 'test')`).run('a'.repeat(64));
    db.prepare(`UPDATE commerce_authority_control SET
      authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
      import_manifest_sha256 = ?, updated_at_ms = 2 WHERE singleton = 1`).run('a'.repeat(64));
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
      'document_kind',
      'owner',
      'document_path',
    ]);
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
    assert.deepEqual(
      db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN (
        'commerce_documents_checkout_reconciliation',
        'commerce_documents_ready_notifications'
      )`).all(),
      [],
    );
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

test('the contract migration preserves every document kind and removes compatibility state', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const files = readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files.filter((name) => name < '0009_')) {
      db.exec(readFileSync(new URL(file, migrations), 'utf8'));
    }
    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
      WHERE singleton = 1`);
    db.prepare(`INSERT INTO commerce_import_manifests (
      manifest_sha256, document_count, kind_counts_json, source_updated_at_ms, imported_at_ms, archive_object_prefix
    ) VALUES (?, 10, '{}', 1, 1, 'test')`).run('a'.repeat(64));
    db.prepare(`UPDATE commerce_authority_control SET
      authority_state = 'd1', revision = 3, paused_at_ms = NULL, cutover_at_ms = 2,
      import_manifest_sha256 = ?, updated_at_ms = 2 WHERE singleton = 1`).run('a'.repeat(64));
    const fixtures = [
      ['claimCodes/code', 'claim_code', null, 'code'],
      ['drops/drop/adminIrlRedeemPackMarkers/pack', 'admin_irl_redeem_pack_marker', 'drop', 'pack'],
      ['drops/drop/adminIrlRedeemReceiptMarkers/receipt', 'admin_irl_redeem_receipt_marker', 'drop', 'receipt'],
      ['drops/drop/adminIrlRedeemRequests/request', 'admin_irl_redeem_request', 'drop', 'request'],
      ['drops/drop/boxAssignments/box', 'box_assignment', 'drop', 'box'],
      ['drops/drop/deliveryOrders/7', 'delivery_order', 'drop', '7'],
      ['drops/drop/dudeAssignments/1', 'dude_assignment', 'drop', '1'],
      ['drops/drop/meta/dudePool', 'dude_pool', 'drop', 'dudePool'],
      ['drops/drop/offchainOrders/hash', 'offchain_order', 'drop', 'hash'],
      ['drops/drop/stripeCheckouts/session', 'stripe_checkout', 'drop', 'session'],
    ] as const;
    const insert = db.prepare(`INSERT INTO commerce_documents (
      document_path, document_kind, drop_id, document_id, fields_json, document_json,
      version, create_time, update_time, processed_at_seconds, processed_at_nanos
    ) VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)`);
    fixtures.forEach(([path, kind, dropId, documentId], index) => insert.run(
      path,
      kind,
      dropId,
      documentId,
      JSON.stringify({ marker: documentId, owner: 'wallet', status: 'ready_to_ship' }),
      index + 1,
      `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000000001Z`,
      kind === 'delivery_order' ? 1_787_054_400 : null,
      kind === 'delivery_order' ? 123_456_789 : null,
    ));
    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', revision = 4, paused_at_ms = 3, updated_at_ms = 3
      WHERE singleton = 1`);
    const before = db.prepare(`SELECT document_path, document_kind, drop_id, document_id, document_json,
      version, create_time, update_time, processed_at_seconds, processed_at_nanos
      FROM commerce_documents ORDER BY document_path`).all().map((row) => ({ ...row }));

    db.exec(readFileSync(new URL('0009_remove_firestore_compatibility.sql', migrations), 'utf8'));

    const after = db.prepare(`SELECT document_path, document_kind, drop_id, document_id, document_json,
      version, create_time, update_time, processed_at_seconds, processed_at_nanos
      FROM commerce_documents ORDER BY document_path`).all().map((row) => ({ ...row }));
    assert.deepEqual(after, before);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('commerce_documents')
      WHERE name = 'fields_json'`).get()!.count, 0);
    assert.deepEqual(db.prepare(`SELECT name FROM pragma_table_list
      WHERE name IN ('commerce_transactions', 'commerce_transaction_reads')`).all(), []);
    assert.deepEqual({ ...db.prepare(`SELECT authority_state, revision, documents_revision
      FROM commerce_authority_control`).get() }, {
      authority_state: 'paused',
      revision: 4,
      documents_revision: 0,
    });
    assert.throws(() => db.exec(`UPDATE commerce_documents SET document_json = '{}'
      WHERE document_path = 'drops/drop/deliveryOrders/7'`), /commerce authority is not d1/);
    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'd1', revision = 5, paused_at_ms = NULL, updated_at_ms = 4
      WHERE singleton = 1`);
    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', revision = 6, paused_at_ms = 5, updated_at_ms = 5
      WHERE singleton = 1`);
    assert.throws(() => db.exec(`UPDATE commerce_authority_control SET authority_state = 'firestore'
      WHERE singleton = 1`), /commerce authority revision conflict|CHECK constraint failed/);
  } finally {
    db.close();
  }
});

test('native identity migration removes only root UID data and preserves row metadata', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const files = readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files.filter((name) => name < '0010_')) {
      if (file.startsWith('0009_')) {
        db.exec(`UPDATE commerce_authority_control SET
          authority_state = 'paused', revision = revision + 1, paused_at_ms = 1, updated_at_ms = 1
          WHERE singleton = 1`);
      }
      db.exec(readFileSync(new URL(file, migrations), 'utf8'));
    }
    db.prepare(`INSERT INTO commerce_import_manifests (
      manifest_sha256, document_count, kind_counts_json, source_updated_at_ms, imported_at_ms, archive_object_prefix
    ) VALUES (?, 1, '{"stripe_checkout":1}', 1, 1, 'test')`).run('a'.repeat(64));
    db.prepare(`UPDATE commerce_authority_control SET
      authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
      import_manifest_sha256 = ?, updated_at_ms = 2 WHERE singleton = 1`).run('a'.repeat(64));
    const document = {
      sessionId: 'cs_test_123',
      uid: 'anon:subject',
      owner: 'anonymous:anon:subject',
      ownerKind: 'anonymous',
      authSubject: 'anon:subject',
      stripeSessionSummary: { metadata: { uid: 'anon:subject', quantity: '1' } },
      status: 'created',
      updatedAt: 1,
    };
    db.prepare(`INSERT INTO commerce_documents (
      document_path, document_kind, drop_id, document_id, document_json,
      version, create_time, update_time, processed_at_seconds, processed_at_nanos
    ) VALUES (?, 'stripe_checkout', 'drop', 'cs_test_123', ?, 7, 'created', 'updated', NULL, NULL)`)
      .run('drops/drop/stripeCheckouts/cs_test_123', JSON.stringify(document));
    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', revision = revision + 1, paused_at_ms = 3, updated_at_ms = 3
      WHERE singleton = 1`);
    db.exec(readFileSync(new URL('0010_cloudflare_native_identity_queries.sql', migrations), 'utf8'));
    const row = db.prepare(`SELECT document_json, version, create_time, update_time
      FROM commerce_documents WHERE document_path = 'drops/drop/stripeCheckouts/cs_test_123'`).get()!;
    const migrated = JSON.parse(String(row.document_json));
    assert.equal(Object.hasOwn(migrated, 'uid'), false);
    assert.equal(migrated.stripeSessionSummary.metadata.uid, 'anon:subject');
    assert.deepEqual({ version: row.version, create_time: row.create_time, update_time: row.update_time }, {
      version: 7,
      create_time: 'created',
      update_time: 'updated',
    });
    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL, updated_at_ms = 4
      WHERE singleton = 1`);
    assert.throws(() => db.prepare(`UPDATE commerce_documents
      SET document_json = json_set(document_json, '$.uid', 'legacy')
      WHERE document_path = 'drops/drop/stripeCheckouts/cs_test_123'`).run(), /legacy identity data/);
  } finally {
    db.close();
  }
});
