import { pathToFileURL } from 'node:url';
import { assertCanonicalCommerceIdentity } from '../shared/commerceIdentityValidation.ts';
import {
  commerceD1DocumentIdentity,
  queryRemoteCommerceD1 as defaultQueryRemoteCommerceD1,
  safeInteger,
} from '../shared/commerceD1Maintenance.ts';
import { sqlSchemaFingerprint } from '../shared/sqlSchemaFingerprint.ts';
import { inventoryDropConfigs } from '../shared/dudeInventoryMaintenance.ts';
import { READY_NOTIFICATION_DUE_SQL } from '../../shared/readyNotificationDueSql.ts';

function fail(message: string): never {
  throw new Error(message);
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHORITY_UPDATE_GUARD_SCHEMA_FINGERPRINT = '376e5c3579dd47c8742fb68171df543c2c35fc144a8c2277d66d68fd73c82b07';
const COMMIT_GUARD_SCHEMA_FINGERPRINT = '13c79bbc939b01898f4a4ebc429d7d83899158f0e65a54d3b9592290d4884f80';
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
const DOCUMENT_PATH_REVISION_SCHEMA_FINGERPRINT = '42f79a74554f9e4b2972ed201a410831af814ad5c5d83bed2efbcf5f4b245926';
const DOCUMENT_PATH_REVISION_TRIGGER_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  commerce_document_path_revision_delete: '758e743aee5c022d52a902753d53d9b0ce9eec1e28387f049cda87c280c3c2f8',
  commerce_document_path_revision_delete_guard: 'bd0013872b66a14fcf62ef56ad879820a8db2809e382c39988951a9e576fee01',
  commerce_document_path_revision_insert: 'aaff9c60e93c89324dd22ff69cf4fc464b23cfb0d31aa566e2785d4bc9a945cd',
  commerce_document_path_revision_insert_guard: '7cb5d8ad678cb5a9e3a85360da0349beb4708e41a69a2932124d30250a25e5c8',
  commerce_document_path_revision_path_departure: '4a52b4b3f42e69e3bb1d2d4677337f1cb8271b3e750effa38dd9ee46e5669f1e',
  commerce_document_path_revision_update: '666f6fe344b6d8a32520ce68483b6a99cce7cbfd58f1448fb7cbb0ab2bf9c54f',
  commerce_document_path_revision_update_guard: '1c50faac9f28884b0c63a981861a870c4ac24c81aaf79deb4b3c38ae063720cf',
});
const DOCUMENT_VERSION_UPDATE_GUARD_SCHEMA_FINGERPRINT = '4d4dbe364e9ffcae153407fd64732d1593adf240d59f06d7b05837f61c5ce106';
const LEASE_SCHEMA_FINGERPRINT = 'a243cba949108449376cf4df9b99eadb75d80e118120dd367f093636e57eb752';
const WIPE_GUARD_SCHEMA_FINGERPRINT = 'b6aca59498285edd6d66adb915170774a8fb17903802bcce4c783b81317cb40a';
const INVENTORY_TABLE_SCHEMA_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  commerce_authority_control: '56e85468c566ce15194d936c2a4e71da19973420e0b51631e5088d226ccad794',
  commerce_inventory_drops: '0d7e041097d610fd56347c7041916ed093d9daad1a7e998192098d7c6188f841',
  commerce_available_dudes: '566abda64362ec252f4dbfa5738cf94964dee392c60c88ab53cf826e53958628',
});
const INVENTORY_TRIGGER_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  commerce_inventory_drop_insert_guard: '0dee5e9624568019fd0f8ab5df005c17ac6693855fea12f393e0a313687ed480',
  commerce_inventory_drop_update_guard: 'bad6152a599de6ea051984d96e4221170687b68733c81798e46243b8a5b8ac7f',
  commerce_inventory_drop_delete_guard: 'b983b9d424bbddcd5788d83667c99c92c36fc5639e1ad126e30b07b4238f84cb',
  commerce_available_dude_insert_guard: 'd1c5d9e4b6077e10a7b0fa1c24d3cf3a57029532290b766e2911aac5f2b08b73',
  commerce_available_dude_update_guard: '2130fd3767482323bad5255db8e03af5cc50292921cf16d5825714d9d76a2a54',
  commerce_available_dude_delete_guard: '2dc3cc3ef3b6c68aa2a392a063135411127ae299dfd490f8db3e00e5636c83a4',
  commerce_dude_inventory_mode_guard: '0ead2fac0102823fd8a5e391692d746d1ad11658352a14e31179cbd44ce75636',
  commerce_dude_inventory_resume_guard: '7999f72d6f05b67963540e20bc20d6f657accc9e33bc380480ec900692b4daa6',
  commerce_dude_pool_insert_fence: 'ac36b14758fb354600e977dfd5fc974f048725076fffa1105ad880c834950a21',
  commerce_dude_pool_update_fence: '7991f212aa00ed7bca2a85e083600df3a796f9976104c5d0b458744cd9169413',
  commerce_dude_assignment_inventory_guard: '69cc411cd7bdbfb77283c3bdba4e18f50f0a16f72007c848ab2cfe21a2b9a557',
  commerce_dude_assignment_consume_inventory: 'f91f17ad32a84cb2fa3474608b2c8c258c853e55e1f9c585ee4c1b9fd0bb2991',
  commerce_dude_assignment_update_guard: '6b6bda941dcd1a028c08b930378053164d52f595e4722c8f287e62d65f6ef2f3',
  commerce_dude_assignment_delete_guard: 'e8a6a8d3f8e2597282ac5f0cc2ca39a1dddf1123435a61372de12adabed42557',
});
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
const STRIPE_RECONCILIATION_INDEX_SQL = `CREATE INDEX commerce_stripe_checkouts_reconciliation_due
  ON commerce_documents (
    CAST(json_extract(document_json, '$.updatedAt') AS INTEGER),
    document_path
  )
  WHERE
    document_kind = 'stripe_checkout' AND
    fulfillment_processor = 'cloudflare_queue_v1' AND
    status IN ('fulfillment_pending', 'processing')`;
const STRIPE_TERMINAL_NOTIFICATION_INDEX_SQL = `CREATE INDEX commerce_stripe_terminal_notifications_due
  ON commerce_documents (
    CAST(json_extract(document_json, '$.stripeTerminalNotificationNextAttemptAtMs') AS INTEGER),
    document_path
  )
  WHERE
    document_kind = 'stripe_checkout' AND
    (status = 'fulfilled' OR (status = 'fulfillment_failed' AND manual_refund_review_required = 1)) AND
    json_extract(document_json, '$.stripeTerminalNotificationState') = 'pending'`;
const ADMIN_IRL_WORKFLOW_OPERATION_INDEX_SQL = `CREATE INDEX commerce_admin_irl_redeem_workflow_operation
  ON commerce_documents (
    json_extract(document_json, '$.workflowFinalizeV1.operationId'),
    document_path
  )
  WHERE document_kind = 'admin_irl_redeem_request'`;
const READY_NOTIFICATION_DUE_INDEX_SQL = `CREATE INDEX ${READY_NOTIFICATION_DUE_SQL.indexName}
  ON commerce_documents (
    ${READY_NOTIFICATION_DUE_SQL.dueAtExpression},
    document_path
  )
  WHERE ${READY_NOTIFICATION_DUE_SQL.pendingPredicate}`;

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

export type CheckCommerceD1Query = typeof defaultQueryRemoteCommerceD1;

export function checkCommerceD1(
  queryRemoteCommerceD1: CheckCommerceD1Query = defaultQueryRemoteCommerceD1,
  options: { forDeployment?: boolean } = {},
): Record<string, unknown> {
  const quick = queryRemoteCommerceD1('PRAGMA quick_check');
  if (quick.length !== 1 || quick[0].quick_check !== 'ok') fail('Commerce D1 quick check failed.');
  if (queryRemoteCommerceD1('PRAGMA foreign_key_check').length !== 0) fail('Commerce D1 foreign-key check failed.');

  const migrations = queryRemoteCommerceD1('SELECT name FROM d1_migrations ORDER BY id');
  if (
    migrations.length !== 10 ||
    migrations[0].name !== '0001_current_schema.sql' ||
    migrations[1].name !== '0002_authority_control_lease.sql' ||
    migrations[2].name !== '0003_wipe_readiness_guard.sql' ||
    migrations[3].name !== '0004_ready_notification_owner_indexes.sql' ||
    migrations[4].name !== '0005_delivery_owner_query_revisions.sql' ||
    migrations[5].name !== '0006_document_path_revisions.sql' ||
    migrations[6].name !== '0007_stripe_terminal_notifications.sql' ||
    migrations[7].name !== '0008_admin_irl_redeem_workflow_operation.sql' ||
    migrations[8].name !== '0009_ready_notification_due_index.sql' ||
    migrations[9].name !== '0010_dude_inventory.sql'
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
    'commerce_available_dudes',
    'commerce_commit_guards',
    'commerce_delivery_owner_revisions',
    'commerce_document_path_revisions',
    'commerce_documents',
    'commerce_inventory_drops',
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
  if (authority.dude_inventory_mode !== 'legacy' && authority.dude_inventory_mode !== 'rows') {
    fail('Commerce D1 inventory mode is invalid.');
  }
  if (options.forDeployment && authority.dude_inventory_mode !== 'rows') {
    fail('API deployment requires activated figure inventory (rows mode). Follow scripts/docs/dude_inventory_cutover.md for the initial cutover.');
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
  const documentPathRevisionColumns = queryRemoteCommerceD1(
    "SELECT name FROM pragma_table_info('commerce_document_path_revisions') ORDER BY cid",
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
  const documentPathRevisionSchema = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'commerce_document_path_revisions'`);
  const documentPathRevisionFingerprint = documentPathRevisionSchema.length === 1
    ? sqlSchemaFingerprint(String(documentPathRevisionSchema[0].sql || ''))
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
  const documentPathRevisionState = queryRemoteCommerceD1(`SELECT
      (SELECT COUNT(*) FROM commerce_document_path_revisions) AS count,
      (SELECT COUNT(*) FROM commerce_document_path_revisions
        WHERE revision NOT BETWEEN 1 AND 9007199254740991) AS invalid_count,
      (SELECT COUNT(*) FROM commerce_document_path_revisions
        WHERE revision > (
          SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1
        )) AS future_count,
      (SELECT COUNT(*)
        FROM commerce_documents AS document
        LEFT JOIN commerce_document_path_revisions AS path_revision
          ON path_revision.document_path = document.document_path
        WHERE path_revision.document_path IS NULL) AS missing_live_count`);
  if (
    authorityColumns.join(',') !== 'singleton,authority_state,revision,documents_revision,paused_at_ms,updated_at_ms,dude_inventory_mode' ||
    commitGuardColumns.join(',') !==
      'guard_id,expectations_json,expected_documents_revision,created_at_ms,delivery_owner_expectations_json' ||
    documentPathRevisionColumns.join(',') !== 'document_path,revision' ||
    leaseColumns.join(',') !== 'singleton,lease_token,acquired_at_ms,expires_at_ms' ||
    wipeGuardColumns.join(',') !== 'guard_id,expectations_json,expected_documents_revision,created_at_ms,expected_authority_revision' ||
    authorityUpdateGuardFingerprint !== AUTHORITY_UPDATE_GUARD_SCHEMA_FINGERPRINT ||
    commitGuardFingerprint !== COMMIT_GUARD_SCHEMA_FINGERPRINT ||
    commitGuardTableFingerprint !== COMMIT_GUARD_TABLE_SCHEMA_FINGERPRINT ||
    deliveryOwnerRevisionFingerprint !== DELIVERY_OWNER_REVISION_SCHEMA_FINGERPRINT ||
    documentPathRevisionFingerprint !== DOCUMENT_PATH_REVISION_SCHEMA_FINGERPRINT ||
    documentVersionUpdateGuardFingerprint !== DOCUMENT_VERSION_UPDATE_GUARD_SCHEMA_FINGERPRINT ||
    leaseFingerprint !== LEASE_SCHEMA_FINGERPRINT ||
    wipeGuardFingerprint !== WIPE_GUARD_SCHEMA_FINGERPRINT ||
    identityState.length !== 1 ||
    safeInteger(identityState[0].root_uid_count, 'Commerce root UID count') !== 0 ||
    commitGuardState.length !== 1 ||
    safeInteger(commitGuardState[0].count, 'Commerce commit-guard count') !== 0 ||
    deliveryOwnerRevisionState.length !== 1 ||
    safeInteger(deliveryOwnerRevisionState[0].invalid_count, 'Commerce invalid delivery-owner revision count') !== 0 ||
    safeInteger(deliveryOwnerRevisionState[0].future_count, 'Commerce future delivery-owner revision count') !== 0 ||
    documentPathRevisionState.length !== 1 ||
    safeInteger(documentPathRevisionState[0].invalid_count, 'Commerce invalid document-path revision count') !== 0 ||
    safeInteger(documentPathRevisionState[0].future_count, 'Commerce future document-path revision count') !== 0 ||
    safeInteger(documentPathRevisionState[0].missing_live_count, 'Commerce missing live path-revision count') !== 0
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
    'commerce_document_path_revision_delete',
    'commerce_document_path_revision_delete_guard',
    'commerce_document_path_revision_insert',
    'commerce_document_path_revision_insert_guard',
    'commerce_document_path_revision_path_departure',
    'commerce_document_path_revision_update',
    'commerce_document_path_revision_update_guard',
    'commerce_delivery_owner_revision_arrival',
    'commerce_delivery_owner_revision_delete',
    'commerce_delivery_owner_revision_delete_guard',
    'commerce_delivery_owner_revision_departure',
    'commerce_delivery_owner_revision_insert',
    'commerce_delivery_owner_revision_insert_guard',
    'commerce_delivery_owner_revision_path',
    'commerce_delivery_owner_revision_update_guard',
    ...Object.keys(INVENTORY_TRIGGER_FINGERPRINTS),
  ]);
  const triggers = queryRemoteCommerceD1(`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'commerce_%' ORDER BY name`);
  if (
    triggers.length !== requiredTriggers.size ||
    triggers.some((row) => !requiredTriggers.has(String(row.name)))
  ) fail('Commerce D1 trigger inventory is invalid.');

  for (const [type, fingerprints] of [
    ['table', INVENTORY_TABLE_SCHEMA_FINGERPRINTS],
    ['trigger', INVENTORY_TRIGGER_FINGERPRINTS],
  ] as const) {
    const inventorySchema = queryRemoteCommerceD1(`SELECT name, sql FROM sqlite_schema
      WHERE type = '${type}' AND name IN (${Object.keys(fingerprints).map((name) => `'${name}'`).join(', ')})`);
    if (
      inventorySchema.length !== Object.keys(fingerprints).length ||
      inventorySchema.some((row) => sqlSchemaFingerprint(String(row.sql || '')) !== fingerprints[String(row.name)])
    ) fail(`Commerce D1 inventory ${type} schema is invalid.`);
  }

  const inventory = queryRemoteCommerceD1(`SELECT inventory.*,
      (SELECT COUNT(*) FROM commerce_available_dudes WHERE drop_id = inventory.drop_id) AS available_count,
      (SELECT COUNT(*) FROM commerce_available_dudes
        WHERE drop_id = inventory.drop_id AND
          (dude_id > inventory.max_dude_id OR pool_position >= inventory.max_dude_id)) AS invalid_available_count,
      (SELECT COUNT(*) FROM commerce_available_dudes AS available
        JOIN commerce_documents AS assignment
          ON assignment.document_path = 'drops/' || available.drop_id || '/dudeAssignments/' || available.dude_id
        WHERE available.drop_id = inventory.drop_id) AS assigned_overlap_count
    FROM commerce_inventory_drops AS inventory ORDER BY inventory.drop_id`);
  const inventoryConfigs = new Map(inventoryDropConfigs().map((config) => [config.dropId, config]));
  const readyInventoryDrops = new Set<string>();
  let availableDudes = 0;
  for (const row of inventory) {
    const config = inventoryConfigs.get(String(row.drop_id));
    if (
      !config || !UUID_V4_PATTERN.test(String(row.generation || '')) ||
      row.drop_family !== config.dropFamily || row.items_per_box !== config.itemsPerBox ||
      row.max_dude_id !== config.maxDudeId || (row.ready !== 0 && row.ready !== 1) ||
      safeInteger(row.invalid_available_count, 'Commerce invalid inventory availability count') !== 0 ||
      safeInteger(row.assigned_overlap_count, 'Commerce assigned inventory overlap count') !== 0
    ) fail(`Commerce D1 inventory state is invalid for ${String(row.drop_id)}.`);
    safeInteger(row.initialized_at_ms, 'Commerce inventory initialization timestamp');
    availableDudes += safeInteger(row.available_count, 'Commerce available inventory count');
    if (row.ready === 1) readyInventoryDrops.add(config.dropId);
  }
  if (authority.dude_inventory_mode === 'rows' && (
    [...inventoryConfigs.keys()].some((dropId) => !readyInventoryDrops.has(dropId)) ||
    authoritativeDocuments.some((document) =>
      ['dude_pool', 'dude_assignment', 'box_assignment'].includes(String(document.document_kind)) &&
      !readyInventoryDrops.has(String(document.drop_id)))
  )) fail('Commerce D1 inventory initialization is incomplete.');

  const deliveryOwnerRevisionTriggers = queryRemoteCommerceD1(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND name GLOB 'commerce_delivery_owner_revision_*'
    ORDER BY name`);
  if (
    deliveryOwnerRevisionTriggers.length !== Object.keys(DELIVERY_OWNER_REVISION_TRIGGER_FINGERPRINTS).length ||
    deliveryOwnerRevisionTriggers.some((row) =>
      sqlSchemaFingerprint(String(row.sql || '')) !== DELIVERY_OWNER_REVISION_TRIGGER_FINGERPRINTS[String(row.name)])
  ) fail('Commerce D1 delivery-owner revision triggers are invalid.');

  const documentPathRevisionTriggers = queryRemoteCommerceD1(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND name GLOB 'commerce_document_path_revision_*'
    ORDER BY name`);
  if (
    documentPathRevisionTriggers.length !== Object.keys(DOCUMENT_PATH_REVISION_TRIGGER_FINGERPRINTS).length ||
    documentPathRevisionTriggers.some((row) =>
      sqlSchemaFingerprint(String(row.sql || '')) !== DOCUMENT_PATH_REVISION_TRIGGER_FINGERPRINTS[String(row.name)])
  ) fail('Commerce D1 document-path revision triggers are invalid.');

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

  const stripeReconciliationIndex = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND name = 'commerce_stripe_checkouts_reconciliation_due'`);
  if (
    stripeReconciliationIndex.length !== 1 ||
    normalizedSql(stripeReconciliationIndex[0].sql) !== normalizedSql(STRIPE_RECONCILIATION_INDEX_SQL)
  ) fail('Commerce D1 Stripe-reconciliation index is invalid.');

  const stripeTerminalNotificationIndex = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND name = 'commerce_stripe_terminal_notifications_due'`);
  if (
    stripeTerminalNotificationIndex.length !== 1 ||
    normalizedSql(stripeTerminalNotificationIndex[0].sql) !== normalizedSql(STRIPE_TERMINAL_NOTIFICATION_INDEX_SQL)
  ) fail('Commerce D1 Stripe terminal-notification index is invalid.');

  const adminIrlWorkflowOperationIndex = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND name = 'commerce_admin_irl_redeem_workflow_operation'`);
  if (
    adminIrlWorkflowOperationIndex.length !== 1 ||
    normalizedSql(adminIrlWorkflowOperationIndex[0].sql) !== normalizedSql(ADMIN_IRL_WORKFLOW_OPERATION_INDEX_SQL)
  ) fail('Commerce D1 Admin IRL Workflow operation index is invalid.');

  const readyNotificationDueIndex = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND name = '${READY_NOTIFICATION_DUE_SQL.indexName}'`);
  if (
    readyNotificationDueIndex.length !== 1 ||
    normalizedSql(readyNotificationDueIndex[0].sql) !== normalizedSql(READY_NOTIFICATION_DUE_INDEX_SQL)
  ) fail('Commerce D1 due ready-notification index is invalid.');

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
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM commerce_documents INDEXED BY commerce_stripe_checkouts_reconciliation_due
      WHERE document_kind = 'stripe_checkout'
        AND fulfillment_processor = 'cloudflare_queue_v1'
        AND status IN ('fulfillment_pending', 'processing')
        AND json_type(document_json, '$.updatedAt') IN ('integer', 'real')
        AND json_type(document_json, '$.lastStripeWebhookEventId') = 'text'
        AND CAST(json_extract(document_json, '$.updatedAt') AS INTEGER) <= 1
      ORDER BY CAST(json_extract(document_json, '$.updatedAt') AS INTEGER), document_path LIMIT 100`),
    'commerce_stripe_checkouts_reconciliation_due',
  );

  const readyNotificationDuePlan = queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
    FROM commerce_authority_control AS authority
    CROSS JOIN commerce_documents INDEXED BY ${READY_NOTIFICATION_DUE_SQL.indexName}
    WHERE
      authority.singleton = 1 AND
      authority.authority_state = 'd1' AND
      ${READY_NOTIFICATION_DUE_SQL.pendingPredicate} AND
      (${READY_NOTIFICATION_DUE_SQL.dueAtExpression}) <= 1
    ORDER BY (${READY_NOTIFICATION_DUE_SQL.dueAtExpression}), document_path
    LIMIT 8`);
  requireSearchIndex(readyNotificationDuePlan, READY_NOTIFICATION_DUE_SQL.indexName);
  requireNoTemporaryBTree(readyNotificationDuePlan, 'due ready-notification');

  const stripeTerminalNotificationPlan = queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
    FROM commerce_authority_control AS authority
    CROSS JOIN commerce_documents INDEXED BY commerce_stripe_terminal_notifications_due
    WHERE
      authority.singleton = 1 AND
      authority.authority_state = 'd1' AND
      document_kind = 'stripe_checkout' AND
      (status = 'fulfilled' OR (status = 'fulfillment_failed' AND manual_refund_review_required = 1)) AND
      json_extract(document_json, '$.stripeTerminalNotificationState') = 'pending' AND
      CAST(json_extract(document_json, '$.stripeTerminalNotificationNextAttemptAtMs') AS INTEGER) <= 1
    ORDER BY CAST(json_extract(document_json, '$.stripeTerminalNotificationNextAttemptAtMs') AS INTEGER),
      document_path
    LIMIT 20`);
  requireSearchIndex(stripeTerminalNotificationPlan, 'commerce_stripe_terminal_notifications_due');

  const adminIrlWorkflowStatusPlan = queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
    FROM commerce_authority_control AS authority CROSS JOIN commerce_documents
    WHERE
      authority.singleton = 1 AND
      document_kind = 'admin_irl_redeem_request' AND
      json_type(document_json, '$.workflowFinalizeV1.operationId') = 'text' AND
      json_extract(document_json, '$.workflowFinalizeV1.operationId') = 'airf-v1-${'0'.repeat(64)}'
    ORDER BY document_path ASC
    LIMIT 2`);
  requireSearchIndex(adminIrlWorkflowStatusPlan, 'commerce_admin_irl_redeem_workflow_operation');
  requireNoTemporaryBTree(adminIrlWorkflowStatusPlan, 'Admin IRL Workflow status');

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
    inventoryMode: authority.dude_inventory_mode,
    inventoryDrops: inventory.length,
    availableDudes,
    authoritativeDocuments: authoritativeDocuments.length,
    deliveryOwnerRevisions: safeInteger(deliveryOwnerRevisionState[0].count, 'Commerce delivery-owner revision count'),
    documentPathRevisions: safeInteger(documentPathRevisionState[0].count, 'Commerce document-path revision count'),
    kindCounts,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--for-deployment')) {
    fail('Usage: npm run check:commerce-d1 -- [--for-deployment]');
  }
  console.log(JSON.stringify(checkCommerceD1(undefined, { forDeployment: args.length === 1 }), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
