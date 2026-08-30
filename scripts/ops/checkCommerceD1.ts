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
const COMMIT_GUARD_SCHEMA_FINGERPRINT = '7dd30e68a5b3182ce62f732ff56e768456c9e56fe0e9ff3698d9f15a27ad0a9f';
const COMMIT_GUARD_TABLE_SCHEMA_FINGERPRINT = 'f8195cb0d586aeb91c7e872148f227524a83498a5357e02ae83553a8d888da02';
const DELIVERY_OWNER_REVISION_SCHEMA_FINGERPRINT = '64fd01604169a0b6c3834a5f88e8dd3b6f08f0d7a9404882ced957aca35225a5';
const DELIVERY_OWNER_REVISION_TRIGGER_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  commerce_delivery_owner_revision_arrival: '46b377200b52c8e68da92a817c05c9184bdd643096fd91dbfde6990d06a34e1c',
  commerce_delivery_owner_revision_delete: 'a45238a9712999ab3134b09902b3db44b0b60d4aa67e2c705dc92d0f105cd948',
  commerce_delivery_owner_revision_delete_guard: '8ec4759f31ac8ef627540b38625716146a207b3148a85aedeb17789a4be5f3b7',
  commerce_delivery_owner_revision_departure: '8dda9c6b40f0dd6f90f23a0c99240f822a4d31acf3ba2bae020d65017db811d8',
  commerce_delivery_owner_revision_insert: '077b04d7a03627aae9d6682afd1e8e3051fc955c9218d58ce50c3966314c4b7c',
  commerce_delivery_owner_revision_insert_guard: 'd907d773cda243f0aa33d4f91c6974b5d27296f40e21cb20e39c4248fb89f1ff',
  commerce_delivery_owner_revision_path: '87a255cadf25e3783bc9899e46efdeff9a7d66af9c6e28156ec6be246dbbca59',
  commerce_delivery_owner_revision_update_guard: '2dd28173ec6f7db767181fc6cddac53e15fd863e149b59365497eaf51bf5b91f',
});
const DOCUMENT_VERSION_UPDATE_GUARD_SCHEMA_FINGERPRINT = '4d4dbe364e9ffcae153407fd64732d1593adf240d59f06d7b05837f61c5ce106';
const LEASE_SCHEMA_FINGERPRINT = 'a243cba949108449376cf4df9b99eadb75d80e118120dd367f093636e57eb752';
const WIPE_GUARD_SCHEMA_FINGERPRINT = 'b6aca59498285edd6d66adb915170774a8fb17903802bcce4c783b81317cb40a';
const PENDING_READY_NOTIFICATION_INDEX_SQL: Readonly<Record<string, string>> = Object.freeze({
  commerce_delivery_orders_buyer_notifications_pending: `CREATE INDEX
    commerce_delivery_orders_buyer_notifications_pending ON commerce_documents (document_path)
    WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship' AND
      buyer_notification_state = 'pending'`,
  commerce_delivery_orders_buyer_notifications_pending_owner_path: `CREATE INDEX
    commerce_delivery_orders_buyer_notifications_pending_owner_path ON commerce_documents (owner, document_path)
    WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship' AND
      buyer_notification_state = 'pending'`,
  commerce_delivery_orders_shipper_notifications_pending: `CREATE INDEX
    commerce_delivery_orders_shipper_notifications_pending ON commerce_documents (document_path)
    WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship' AND
      shipper_notification_state = 'pending'`,
  commerce_delivery_orders_shipper_notifications_pending_owner_path: `CREATE INDEX
    commerce_delivery_orders_shipper_notifications_pending_owner_path ON commerce_documents (owner, document_path)
    WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship' AND
      shipper_notification_state = 'pending'`,
});
const DELIVERY_RECOVERY_INDEX_SQL = `CREATE INDEX commerce_documents_delivery_owner_status
  ON commerce_documents (document_kind, owner, status, document_path)`;

function normalizedSql(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function requireIndex(plan: Record<string, unknown>[], indexName: string): void {
  if (!plan.some((row) => String(row.detail || '').includes(indexName))) {
    fail(`Commerce D1 query plan does not use ${indexName}.`);
  }
}

function requireSearchIndex(plan: Record<string, unknown>[], indexName: string): void {
  if (!plan.some((row) => {
    const detail = String(row.detail || '');
    return detail.includes('SEARCH ') && detail.includes(indexName);
  })) fail(`Commerce D1 query plan does not search ${indexName}.`);
}

function requireNoTemporaryBTree(plan: Record<string, unknown>[], operation: string): void {
  if (plan.some((row) => String(row.detail || '').includes('USE TEMP B-TREE'))) {
    fail(`Commerce D1 ${operation} query plan uses a temporary B-tree.`);
  }
}

export function checkCommerceD1(): Record<string, unknown> {
  const quick = queryRemoteCommerceD1('PRAGMA quick_check');
  if (quick.length !== 1 || quick[0].quick_check !== 'ok') fail('Commerce D1 quick check failed.');
  if (queryRemoteCommerceD1('PRAGMA foreign_key_check').length !== 0) fail('Commerce D1 foreign-key check failed.');

  const migrations = queryRemoteCommerceD1('SELECT name FROM d1_migrations ORDER BY id');
  if (
    migrations.length !== 5 ||
    migrations[0].name !== '0001_current_schema.sql' ||
    migrations[1].name !== '0002_authority_control_lease.sql' ||
    migrations[2].name !== '0003_wipe_readiness_guard.sql' ||
    migrations[3].name !== '0004_ready_notification_owner_indexes.sql' ||
    migrations[4].name !== '0005_delivery_owner_query_revisions.sql'
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
    'commerce_delivery_owner_revisions',
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
  const commitGuardColumns = queryRemoteCommerceD1(
    "SELECT name FROM pragma_table_info('commerce_commit_guards') ORDER BY cid",
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
  const commitGuardSchema = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'commerce_commit_guard_validate'`);
  const commitGuardFingerprint = commitGuardSchema.length === 1
    ? sqlSchemaFingerprint(String(commitGuardSchema[0].sql || ''))
    : '';
  const commitGuardTableSchema = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'commerce_commit_guards'`);
  const commitGuardTableFingerprint = commitGuardTableSchema.length === 1
    ? sqlSchemaFingerprint(String(commitGuardTableSchema[0].sql || ''))
    : '';
  const deliveryOwnerRevisionSchema = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'commerce_delivery_owner_revisions'`);
  const deliveryOwnerRevisionFingerprint = deliveryOwnerRevisionSchema.length === 1
    ? sqlSchemaFingerprint(String(deliveryOwnerRevisionSchema[0].sql || ''))
    : '';
  const documentVersionUpdateGuardSchema = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'commerce_documents_version_update_guard'`);
  const documentVersionUpdateGuardFingerprint = documentVersionUpdateGuardSchema.length === 1
    ? sqlSchemaFingerprint(String(documentVersionUpdateGuardSchema[0].sql || ''))
    : '';
  const leaseRows = queryRemoteCommerceD1('SELECT lease_token, acquired_at_ms, expires_at_ms FROM commerce_authority_control_lease');
  if (leaseRows.length > 1 || leaseRows.some((row) => {
    const acquiredAtMs = safeInteger(row.acquired_at_ms, 'Commerce authority lease acquisition');
    const expiresAtMs = safeInteger(row.expires_at_ms, 'Commerce authority lease expiry');
    return !UUID_V4_PATTERN.test(String(row.lease_token || '')) || expiresAtMs <= acquiredAtMs;
  })) fail('Commerce D1 authority coordination lease is invalid.');
  const identityState = queryRemoteCommerceD1(`SELECT COUNT(*) AS root_uid_count
    FROM commerce_documents WHERE json_type(document_json, '$.uid') IS NOT NULL`);
  const commitGuardState = queryRemoteCommerceD1('SELECT COUNT(*) AS count FROM commerce_commit_guards');
  const deliveryOwnerRevisionState = queryRemoteCommerceD1(`SELECT
      COUNT(*) AS count,
      COALESCE(SUM(revision < 1), 0) AS invalid_count,
      COALESCE(SUM(revision > (
        SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1
      )), 0) AS future_count
    FROM commerce_delivery_owner_revisions`);
  if (
    authorityColumns.join(',') !== 'singleton,authority_state,revision,documents_revision,paused_at_ms,updated_at_ms' ||
    commitGuardColumns.join(',') !==
      'guard_id,expectations_json,expected_documents_revision,created_at_ms,delivery_owner_expectations_json' ||
    leaseColumns.join(',') !== 'singleton,lease_token,acquired_at_ms,expires_at_ms' ||
    wipeGuardColumns.join(',') !== 'guard_id,expectations_json,expected_documents_revision,created_at_ms,expected_authority_revision' ||
    authorityUpdateGuardFingerprint !== AUTHORITY_UPDATE_GUARD_SCHEMA_FINGERPRINT ||
    commitGuardFingerprint !== COMMIT_GUARD_SCHEMA_FINGERPRINT ||
    commitGuardTableFingerprint !== COMMIT_GUARD_TABLE_SCHEMA_FINGERPRINT ||
    deliveryOwnerRevisionFingerprint !== DELIVERY_OWNER_REVISION_SCHEMA_FINGERPRINT ||
    documentVersionUpdateGuardFingerprint !== DOCUMENT_VERSION_UPDATE_GUARD_SCHEMA_FINGERPRINT ||
    leaseFingerprint !== LEASE_SCHEMA_FINGERPRINT ||
    wipeGuardFingerprint !== WIPE_GUARD_SCHEMA_FINGERPRINT ||
    identityState.length !== 1 ||
    safeInteger(identityState[0].root_uid_count, 'Commerce root UID count') !== 0 ||
    commitGuardState.length !== 1 ||
    safeInteger(commitGuardState[0].count, 'Commerce commit-guard count') !== 0 ||
    deliveryOwnerRevisionState.length !== 1 ||
    safeInteger(deliveryOwnerRevisionState[0].invalid_count, 'Commerce invalid delivery-owner revision count') !== 0 ||
    safeInteger(deliveryOwnerRevisionState[0].future_count, 'Commerce future delivery-owner revision count') !== 0
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
    'commerce_documents_version_update_guard',
    'commerce_delivery_owner_revision_arrival',
    'commerce_delivery_owner_revision_delete',
    'commerce_delivery_owner_revision_delete_guard',
    'commerce_delivery_owner_revision_departure',
    'commerce_delivery_owner_revision_insert',
    'commerce_delivery_owner_revision_insert_guard',
    'commerce_delivery_owner_revision_path',
    'commerce_delivery_owner_revision_update_guard',
  ]);
  const triggers = queryRemoteCommerceD1(`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'commerce_%' ORDER BY name`);
  if (
    triggers.length !== requiredTriggers.size ||
    triggers.some((row) => !requiredTriggers.has(String(row.name)))
  ) fail('Commerce D1 trigger inventory is invalid.');

  const deliveryOwnerRevisionTriggers = queryRemoteCommerceD1(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND name GLOB 'commerce_delivery_owner_revision_*'
    ORDER BY name`);
  if (
    deliveryOwnerRevisionTriggers.length !== Object.keys(DELIVERY_OWNER_REVISION_TRIGGER_FINGERPRINTS).length ||
    deliveryOwnerRevisionTriggers.some((row) =>
      sqlSchemaFingerprint(String(row.sql || '')) !== DELIVERY_OWNER_REVISION_TRIGGER_FINGERPRINTS[String(row.name)])
  ) fail('Commerce D1 delivery-owner revision triggers are invalid.');

  const deliveryOwnerIndex = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND name = 'commerce_documents_delivery_owner_path'`);
  const deliveryOwnerIndexSql = String(deliveryOwnerIndex[0]?.sql || '').replace(/\s+/g, ' ').trim();
  if (
    deliveryOwnerIndex.length !== 1 ||
    deliveryOwnerIndexSql !== `CREATE INDEX commerce_documents_delivery_owner_path
      ON commerce_documents (owner, document_path)
      WHERE document_kind = 'delivery_order'`.replace(/\s+/g, ' ').trim()
  ) fail('Commerce D1 delivery-owner partial index is invalid.');

  const deliveryRecoveryIndex = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND name = 'commerce_documents_delivery_owner_status'`);
  if (
    deliveryRecoveryIndex.length !== 1 ||
    normalizedSql(deliveryRecoveryIndex[0].sql) !== normalizedSql(DELIVERY_RECOVERY_INDEX_SQL)
  ) fail('Commerce D1 delivery-recovery index is invalid.');

  const pendingReadyNotificationIndexes = queryRemoteCommerceD1(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'index' AND name GLOB 'commerce_delivery_orders_*_notifications_pending*'
    ORDER BY name`);
  if (
    pendingReadyNotificationIndexes.length !== Object.keys(PENDING_READY_NOTIFICATION_INDEX_SQL).length ||
    pendingReadyNotificationIndexes.some((row) =>
      normalizedSql(row.sql) !== normalizedSql(PENDING_READY_NOTIFICATION_INDEX_SQL[String(row.name)]))
  ) fail('Commerce D1 pending ready-notification indexes are invalid.');

  const initialDeliveryOwnerPlan = queryRemoteCommerceD1(`EXPLAIN QUERY PLAN
    SELECT DISTINCT document.owner AS owner
    FROM commerce_authority_control AS authority
    CROSS JOIN commerce_documents AS document INDEXED BY commerce_documents_delivery_owner_path
    WHERE
      authority.singleton = 1 AND
      authority.authority_state = 'd1' AND
      document.document_kind = 'delivery_order' AND
      document.owner IS NOT NULL AND
      typeof(document.owner) = 'text' AND
      length(document.owner) BETWEEN 32 AND 44 AND
      document.owner NOT GLOB '*[^0-9A-Za-z]*' AND
      document.owner NOT GLOB '*[0OIl]*'
    ORDER BY document.owner ASC
    LIMIT 501`);
  requireSearchIndex(initialDeliveryOwnerPlan, 'commerce_documents_delivery_owner_path');
  requireNoTemporaryBTree(initialDeliveryOwnerPlan, 'initial delivery-owner');
  const keysetDeliveryOwnerPlan = queryRemoteCommerceD1(`EXPLAIN QUERY PLAN
    SELECT DISTINCT document.owner AS owner
    FROM commerce_authority_control AS authority
    CROSS JOIN commerce_documents AS document INDEXED BY commerce_documents_delivery_owner_path
    WHERE
      authority.singleton = 1 AND
      authority.authority_state = 'd1' AND
      document.document_kind = 'delivery_order' AND
      document.owner IS NOT NULL AND
      typeof(document.owner) = 'text' AND
      length(document.owner) BETWEEN 32 AND 44 AND
      document.owner NOT GLOB '*[^0-9A-Za-z]*' AND
      document.owner NOT GLOB '*[0OIl]*' AND
      document.owner > '11111111111111111111111111111111'
    ORDER BY document.owner ASC
    LIMIT 501`);
  requireSearchIndex(keysetDeliveryOwnerPlan, 'commerce_documents_delivery_owner_path');
  requireNoTemporaryBTree(keysetDeliveryOwnerPlan, 'keyset delivery-owner');
  const deliveryRecoveryPlan = queryRemoteCommerceD1(`EXPLAIN QUERY PLAN
    SELECT
      document.document_path,
      document.document_kind,
      document.drop_id,
      document.document_id,
      document.document_json,
      document.version,
      document.create_time,
      document.update_time,
      document.processed_at_seconds,
      document.processed_at_nanos
    FROM commerce_authority_control AS authority
    CROSS JOIN commerce_documents AS document INDEXED BY commerce_documents_delivery_owner_status
    WHERE
      authority.singleton = 1 AND
      authority.authority_state = 'd1' AND
      document.document_kind = 'delivery_order' AND
      document.owner = '11111111111111111111111111111111' AND
      document.status IN ('processing', 'prepared')`);
  requireSearchIndex(deliveryRecoveryPlan, 'commerce_documents_delivery_owner_status');
  if (!deliveryRecoveryPlan.some((row) => normalizedSql(row.detail).includes(
    'commerce_documents_delivery_owner_status (document_kind=? AND owner=? AND status=?)',
  ))) fail('Commerce D1 delivery-recovery query plan does not use the full owner-status prefix.');
  requireNoTemporaryBTree(deliveryRecoveryPlan, 'delivery-recovery');
  queryRemoteCommerceD1(`SELECT DISTINCT document.owner AS owner
    FROM commerce_authority_control AS authority
    CROSS JOIN commerce_documents AS document INDEXED BY commerce_documents_delivery_owner_path
    WHERE
      authority.singleton = 1 AND
      authority.authority_state = 'd1' AND
      document.document_kind = 'delivery_order' AND
      document.owner IS NOT NULL AND
      typeof(document.owner) = 'text' AND
      length(document.owner) BETWEEN 32 AND 44 AND
      document.owner NOT GLOB '*[^0-9A-Za-z]*' AND
      document.owner NOT GLOB '*[0OIl]*'
    ORDER BY document.owner ASC
    LIMIT 1`);
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
  const ownerNotificationPlan = queryRemoteCommerceD1(`EXPLAIN QUERY PLAN WITH candidate_paths AS (
    SELECT document_path FROM commerce_documents
      INDEXED BY commerce_delivery_orders_buyer_notifications_pending_owner_path
    WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship'
      AND buyer_notification_state = 'pending' AND owner = 'owner'
      AND document_path > 'drops/a/deliveryOrders/1'
    UNION
    SELECT document_path FROM commerce_documents
      INDEXED BY commerce_delivery_orders_shipper_notifications_pending_owner_path
    WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship'
      AND shipper_notification_state = 'pending' AND owner = 'owner'
      AND document_path > 'drops/a/deliveryOrders/1'
  ) SELECT document_path FROM candidate_paths ORDER BY document_path LIMIT 8`);
  requireSearchIndex(ownerNotificationPlan, 'commerce_delivery_orders_buyer_notifications_pending_owner_path');
  requireSearchIndex(ownerNotificationPlan, 'commerce_delivery_orders_shipper_notifications_pending_owner_path');
  const ownerlessNotificationPlan = queryRemoteCommerceD1(`EXPLAIN QUERY PLAN WITH candidate_paths AS (
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
  requireSearchIndex(ownerlessNotificationPlan, 'commerce_delivery_orders_buyer_notifications_pending');
  requireSearchIndex(ownerlessNotificationPlan, 'commerce_delivery_orders_shipper_notifications_pending');
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
    deliveryOwnerRevisions: safeInteger(deliveryOwnerRevisionState[0].count, 'Commerce delivery-owner revision count'),
    kindCounts,
  };
}

async function main(): Promise<void> {
  console.log(JSON.stringify(checkCommerceD1(), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
