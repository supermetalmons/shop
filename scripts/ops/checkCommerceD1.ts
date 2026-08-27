import { pathToFileURL } from 'node:url';
import { canonicalizeCommerceIdentity } from '../shared/commerceIdentityCanonicalization.ts';
import {
  commerceD1DocumentIdentity,
  queryRemoteCommerceD1,
  safeInteger,
} from '../shared/commerceD1Maintenance.ts';

function fail(message: string): never {
  throw new Error(message);
}

function requireIndex(plan: Record<string, unknown>[], indexName: string): void {
  if (!plan.some((row) => String(row.detail || '').includes(indexName))) {
    fail(`Commerce D1 query plan does not use ${indexName}.`);
  }
}

export function checkCommerceD1(): Record<string, unknown> {
  const quick = queryRemoteCommerceD1('PRAGMA quick_check');
  if (quick.length !== 1 || quick[0].quick_check !== 'ok') fail('Commerce D1 quick check failed.');
  if (queryRemoteCommerceD1('PRAGMA foreign_key_check').length !== 0) fail('Commerce D1 foreign-key check failed.');

  const migrations = queryRemoteCommerceD1(`SELECT name FROM d1_migrations ORDER BY id`);
  if (!migrations.some((row) => String(row.name).endsWith('0001_read_models.sql'))) {
    fail('Commerce D1 migration history is incomplete.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0002_per_kind_dual_cycles.sql'))) {
    fail('Commerce D1 per-kind cutover migration is missing.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0003_queue_health.sql'))) {
    fail('Commerce D1 queue-health migration is missing.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0004_authoritative_store.sql'))) {
    fail('Commerce D1 authoritative-store migration is missing.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0005_remove_read_model.sql'))) {
    fail('Commerce D1 read-model cleanup migration is missing.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0006_paused_wipe.sql'))) {
    fail('Commerce D1 paused-wipe migration is missing.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0007_native_repository_expand.sql'))) {
    fail('Commerce D1 native-repository expansion migration is missing.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0008_canonicalize_identity_documents.sql'))) {
    fail('Commerce D1 identity canonicalization migration is missing.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0009_remove_firestore_compatibility.sql'))) {
    fail('Commerce D1 contract migration is missing.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0010_cloudflare_native_identity_queries.sql'))) {
    fail('Commerce D1 native identity and query migration is missing.');
  }

  const authoritativeTables = queryRemoteCommerceD1(`SELECT name, strict
    FROM pragma_table_list
    WHERE schema = 'main' AND name IN (
      'commerce_authority_control',
      'commerce_documents',
      'commerce_commit_guards',
      'commerce_wipe_guards',
      'commerce_import_manifests'
    ) ORDER BY name`);
  if (authoritativeTables.length !== 5 || authoritativeTables.some((row) => row.strict !== 1)) {
    fail('Commerce D1 authoritative strict table inventory is invalid.');
  }
  const authorityRows = queryRemoteCommerceD1('SELECT * FROM commerce_authority_control');
  if (authorityRows.length !== 1) fail('Commerce D1 authority singleton is invalid.');
  const authority = authorityRows[0];
  if (!['paused', 'd1'].includes(String(authority.authority_state))) {
    fail('Commerce D1 authority state is invalid.');
  }
  safeInteger(authority.revision, 'Commerce authority revision');
  safeInteger(authority.documents_revision, 'Commerce document revision');

  const authoritativeDocuments = queryRemoteCommerceD1(`SELECT
    document_path, document_kind, drop_id, document_id, document_json
    FROM commerce_documents ORDER BY document_path`);
  for (const row of authoritativeDocuments) {
    const identity = commerceD1DocumentIdentity(String(row.document_path));
    if (
      !identity ||
      identity.kind !== row.document_kind ||
      identity.dropId !== row.drop_id ||
      identity.documentId !== row.document_id
    ) fail('Commerce D1 contains an invalid authoritative document identity.');
    let document: Record<string, unknown>;
    try {
      const parsedDocument = JSON.parse(String(row.document_json)) as unknown;
      if (!parsedDocument || typeof parsedDocument !== 'object' || Array.isArray(parsedDocument)) throw new Error('fields');
      document = parsedDocument as Record<string, unknown>;
    } catch {
      fail('Commerce D1 contains invalid authoritative fields JSON.');
    }
    try {
      if (canonicalizeCommerceIdentity(document).changed) {
        fail('Commerce D1 contains a legacy identity document after canonicalization.');
      }
    } catch {
      fail('Commerce D1 contains an invalid or legacy identity document after canonicalization.');
    }
  }

  const removedState = queryRemoteCommerceD1(`SELECT
    (SELECT COUNT(*) FROM pragma_table_info('commerce_documents') WHERE name = 'fields_json') AS fields_json_count,
    (SELECT COUNT(*) FROM pragma_table_list
      WHERE name IN ('commerce_transactions', 'commerce_transaction_reads')) AS transaction_table_count,
    (SELECT COUNT(*) FROM commerce_documents
      WHERE json_type(document_json, '$.uid') IS NOT NULL) AS root_uid_count`);
  if (
    removedState.length !== 1 ||
    safeInteger(removedState[0].fields_json_count, 'Commerce compatibility column count') !== 0 ||
    safeInteger(removedState[0].transaction_table_count, 'Commerce transaction table count') !== 0 ||
    safeInteger(removedState[0].root_uid_count, 'Commerce root UID count') !== 0
  ) fail('Commerce D1 compatibility state remains after contract migration.');

  const requiredTriggers = new Set([
    'commerce_authority_transition_guard',
    'commerce_authority_delete_guard',
    'commerce_authority_d1_manifest_guard',
    'commerce_authority_revision_guard',
    'commerce_commit_guard_validate',
    'commerce_wipe_guard_validate',
    'commerce_documents_insert_authority_guard',
    'commerce_documents_update_authority_guard',
    'commerce_documents_delete_authority_guard',
    'commerce_documents_identity_insert_guard',
    'commerce_documents_identity_update_guard',
  ]);
  const triggers = queryRemoteCommerceD1(`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'commerce_%' ORDER BY name`);
  if (
    triggers.length !== requiredTriggers.size ||
    triggers.some((row) => !requiredTriggers.has(String(row.name)))
  ) fail('Commerce D1 trigger inventory is invalid.');

  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND owner = 'owner'
      ORDER BY document_path LIMIT 450`),
    'commerce_documents_delivery_owner_path',
  );
  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND fulfillment_status = 'pending'`),
    'commerce_documents_fulfillment_status',
  );
  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM commerce_documents
      WHERE document_kind = 'stripe_checkout' AND drop_id = 'drop'
        AND manual_refund_review_required = 1`),
    'commerce_documents_manual_review',
  );
  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND drop_id = 'drop' AND status = 'ready_to_ship'
      ORDER BY processed_at_seconds DESC, processed_at_nanos DESC, document_path DESC`),
    'commerce_documents_drop_processed_cursor',
  );
  const notificationPlan = queryRemoteCommerceD1(`EXPLAIN QUERY PLAN WITH candidate_paths AS (
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
  requireIndex(notificationPlan, 'commerce_delivery_orders_buyer_notifications_pending');
  requireIndex(notificationPlan, 'commerce_delivery_orders_shipper_notifications_pending');
  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND drop_id = 'drop'
        AND pack_projection_state = 'pending' AND pack_projection_next_attempt_ms <= 1
      ORDER BY pack_projection_next_attempt_ms, document_path LIMIT 4`),
    'commerce_documents_pack_projection',
  );
  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path FROM commerce_documents
      WHERE document_kind = 'stripe_checkout'
        AND fulfillment_processor = 'cloudflare_queue_v1'
        AND status IN ('fulfillment_pending', 'processing')
        AND json_type(document_json, '$.updatedAt') IN ('integer', 'real')
        AND json_type(document_json, '$.lastStripeWebhookEventId') = 'text'
        AND CAST(json_extract(document_json, '$.updatedAt') AS INTEGER) <= 1
      ORDER BY CAST(json_extract(document_json, '$.updatedAt') AS INTEGER), document_path LIMIT 100`),
    'commerce_stripe_checkouts_reconciliation_due',
  );

  const invalidProcessedTimeRows = queryRemoteCommerceD1(`SELECT COUNT(*) AS count
    FROM commerce_documents
    WHERE
      (processed_at_seconds IS NULL) <> (processed_at_nanos IS NULL) OR
      processed_at_seconds < 0 OR
      processed_at_nanos < 0 OR
      processed_at_nanos > 999999999`);
  if (
    invalidProcessedTimeRows.length !== 1 ||
    safeInteger(invalidProcessedTimeRows[0].count, 'Commerce processed-time invalid count') !== 0
  ) fail('Commerce D1 processed-time projections are invalid.');

  const kindCounts = Object.fromEntries(queryRemoteCommerceD1(`SELECT document_kind, COUNT(*) AS count
    FROM commerce_documents GROUP BY document_kind ORDER BY document_kind`).map((row) => [
      String(row.document_kind),
      safeInteger(row.count, 'Commerce document-kind count'),
    ]));
  return {
    authorityState: authority.authority_state,
    authorityRevision: safeInteger(authority.revision, 'Commerce authority revision'),
    authoritativeDocuments: authoritativeDocuments.length,
    kindCounts,
  };
}

async function main(): Promise<void> {
  console.log(JSON.stringify(checkCommerceD1(), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
