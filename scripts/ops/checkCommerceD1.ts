import { pathToFileURL } from 'node:url';
import { assertCanonicalCommerceIdentity } from '../shared/commerceIdentityValidation.ts';
import {
  commerceD1DocumentIdentity,
  queryRemoteCommerceD1,
  safeInteger,
} from '../shared/commerceD1Maintenance.ts';
import { sqlSchemaFingerprint } from '../shared/sqlSchemaFingerprint.ts';

function fail(message: string): never {
  throw new Error(message);
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHORITY_UPDATE_GUARD_SCHEMA_FINGERPRINT = '0564c72e0abee388a0138b0dc80e5ce4a8ab93801c85a3b109106e1b81171c73';
const LEASE_SCHEMA_FINGERPRINT = 'a243cba949108449376cf4df9b99eadb75d80e118120dd367f093636e57eb752';
const WIPE_GUARD_SCHEMA_FINGERPRINT = 'b6aca59498285edd6d66adb915170774a8fb17903802bcce4c783b81317cb40a';

function requireIndex(plan: Record<string, unknown>[], indexName: string): void {
  if (!plan.some((row) => String(row.detail || '').includes(indexName))) {
    fail(`Commerce D1 query plan does not use ${indexName}.`);
  }
}

export function checkCommerceD1(): Record<string, unknown> {
  const quick = queryRemoteCommerceD1('PRAGMA quick_check');
  if (quick.length !== 1 || quick[0].quick_check !== 'ok') fail('Commerce D1 quick check failed.');
  if (queryRemoteCommerceD1('PRAGMA foreign_key_check').length !== 0) fail('Commerce D1 foreign-key check failed.');

  const migrations = queryRemoteCommerceD1('SELECT name FROM d1_migrations ORDER BY id');
  if (
    migrations.length !== 3 ||
    migrations[0].name !== '0001_current_schema.sql' ||
    migrations[1].name !== '0002_authority_control_lease.sql' ||
    migrations[2].name !== '0003_wipe_readiness_guard.sql'
  ) {
    fail('Commerce D1 schema baseline is invalid.');
  }

  const authoritativeTables = queryRemoteCommerceD1(`SELECT name, strict
    FROM pragma_table_list
    WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*'
      AND name <> 'd1_migrations'
    ORDER BY name`);
  const requiredTables = [
    'commerce_authority_control',
    'commerce_authority_control_lease',
    'commerce_commit_guards',
    'commerce_documents',
    'commerce_wipe_guards',
  ];
  if (
    authoritativeTables.length !== requiredTables.length ||
    authoritativeTables.some((row, index) => row.name !== requiredTables[index] || row.strict !== 1)
  ) {
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
      assertCanonicalCommerceIdentity(document);
    } catch {
      fail('Commerce D1 contains an invalid identity document.');
    }
  }

  const authorityColumns = queryRemoteCommerceD1(
    "SELECT name FROM pragma_table_info('commerce_authority_control') ORDER BY cid",
  ).map((row) => String(row.name));
  const leaseColumns = queryRemoteCommerceD1(
    "SELECT name FROM pragma_table_info('commerce_authority_control_lease') ORDER BY cid",
  ).map((row) => String(row.name));
  const wipeGuardColumns = queryRemoteCommerceD1(
    "SELECT name FROM pragma_table_info('commerce_wipe_guards') ORDER BY cid",
  ).map((row) => String(row.name));
  const leaseSchema = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'commerce_authority_control_lease'`);
  const leaseFingerprint = leaseSchema.length === 1
    ? sqlSchemaFingerprint(String(leaseSchema[0].sql || ''))
    : '';
  const wipeGuardSchema = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'commerce_wipe_guard_validate'`);
  const wipeGuardFingerprint = wipeGuardSchema.length === 1
    ? sqlSchemaFingerprint(String(wipeGuardSchema[0].sql || ''))
    : '';
  const authorityUpdateGuardSchema = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'commerce_authority_update_guard'`);
  const authorityUpdateGuardFingerprint = authorityUpdateGuardSchema.length === 1
    ? sqlSchemaFingerprint(String(authorityUpdateGuardSchema[0].sql || ''))
    : '';
  const leaseRows = queryRemoteCommerceD1('SELECT lease_token, acquired_at_ms, expires_at_ms FROM commerce_authority_control_lease');
  if (leaseRows.length > 1 || leaseRows.some((row) => {
    const acquiredAtMs = safeInteger(row.acquired_at_ms, 'Commerce authority lease acquisition');
    const expiresAtMs = safeInteger(row.expires_at_ms, 'Commerce authority lease expiry');
    return !UUID_V4_PATTERN.test(String(row.lease_token || '')) || expiresAtMs <= acquiredAtMs;
  })) fail('Commerce D1 authority coordination lease is invalid.');
  const identityState = queryRemoteCommerceD1(`SELECT COUNT(*) AS root_uid_count
    FROM commerce_documents WHERE json_type(document_json, '$.uid') IS NOT NULL`);
  if (
    authorityColumns.join(',') !== 'singleton,authority_state,revision,documents_revision,paused_at_ms,updated_at_ms' ||
    leaseColumns.join(',') !== 'singleton,lease_token,acquired_at_ms,expires_at_ms' ||
    wipeGuardColumns.join(',') !== 'guard_id,expectations_json,expected_documents_revision,created_at_ms,expected_authority_revision' ||
    authorityUpdateGuardFingerprint !== AUTHORITY_UPDATE_GUARD_SCHEMA_FINGERPRINT ||
    leaseFingerprint !== LEASE_SCHEMA_FINGERPRINT ||
    wipeGuardFingerprint !== WIPE_GUARD_SCHEMA_FINGERPRINT ||
    identityState.length !== 1 ||
    safeInteger(identityState[0].root_uid_count, 'Commerce root UID count') !== 0
  ) fail('Commerce D1 contains noncanonical schema or identity state.');

  const requiredTriggers = new Set([
    'commerce_authority_transition_guard',
    'commerce_authority_update_guard',
    'commerce_authority_delete_guard',
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

  const deliveryOwnerIndex = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND name = 'commerce_documents_delivery_owner_path'`);
  const deliveryOwnerIndexSql = String(deliveryOwnerIndex[0]?.sql || '').replace(/\s+/g, ' ').trim();
  if (
    deliveryOwnerIndex.length !== 1 ||
    deliveryOwnerIndexSql !== `CREATE INDEX commerce_documents_delivery_owner_path
      ON commerce_documents (owner, document_path)
      WHERE document_kind = 'delivery_order'`.replace(/\s+/g, ' ').trim()
  ) fail('Commerce D1 delivery-owner partial index is invalid.');

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
