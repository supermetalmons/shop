import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseNotificationOutboxRow } from '../../shared/notificationOutbox.ts';
import { planNotificationOutboxBackfill } from '../shared/notificationOutboxMaintenance.ts';
import { assertCanonicalCommerceIdentity } from '../shared/commerceIdentityValidation.ts';
import {
  commerceD1DocumentIdentity,
  parseCommerceD1DocumentRow,
  queryRemoteCommerceD1 as defaultQueryRemoteCommerceD1,
  safeInteger,
} from '../shared/commerceD1Maintenance.ts';
import { sqlSchemaFingerprint } from '../shared/sqlSchemaFingerprint.ts';
import { inventoryDropConfigs } from '../shared/dudeInventoryMaintenance.ts';
import { isCommerceDocumentSegment } from '../../shared/commerceDocumentPath.ts';
import { isStripeChargebackSessionId, isStripeDisputeId } from '../../shared/stripeChargebacks.ts';
import {
  adminIrlRedeemWorkflowStatusQuery,
  deliveryOrderOwnersQuery,
  deliveryRecoveryOrdersQuery,
  duePackStatusProjectionsQuery,
  dueReadyNotificationsQuery,
  dueStripeTerminalNotificationsQuery,
  fulfillmentOrdersQuery,
  manualReviewCheckoutsQuery,
  pendingReadyNotificationsQuery,
  notificationOutboxDueQuery,
  staleStripeFulfillmentsQuery,
  stripeChargebackLinkedSessionsQuery,
  stripeChargebackMatchedDocumentsQuery,
  type CommerceSqlQuery,
} from '../../cloud/workers/api/src/commerceQueries.ts';
import { renderCommerceQuerySql } from '../shared/commerceQuerySql.ts';

function fail(message: string): never {
  throw new Error(message);
}

const NOTIFICATION_SCHEMA_FINGERPRINTS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  commerce_commit_guard_notification_outbox_validate: ['trigger', 'ab98d81736bc0927987abf669d9b0bffb8d41f5b61a22fa2e6bb2c0905adbca7'],
  commerce_notification_legacy_insert_fence: ['trigger', '0dbe842e565314c6247a3e8d9a6717daa1df00840f0bc061e5acde00179ed0bf'],
  commerce_notification_legacy_update_fence: ['trigger', 'd62e43b923b7575c8059821ab57159483f1944b151c39a127ba04aeeed810340'],
  commerce_notification_outbox: ['table', '929002240cc9b6bdc4ad070cb7b3beff103687c4daa2819d1847e54b4c5be986'],
  commerce_notification_outbox_control: ['table', '7ba8128b4cbed9569851c913f7c0d7ebb7171728dba0556fca0189808733284e'],
  commerce_notification_outbox_control_delete_guard: ['trigger', '7066c5566748ee845d3ef223326c2a4176462087f4002538c26e604bd0bef331'],
  commerce_notification_outbox_control_insert_guard: ['trigger', 'bbd9280a3c7680efc71558459186be0fdf84ac308c04850985c6a970cc807f3f'],
  commerce_notification_outbox_control_update_guard: ['trigger', 'a8f61963452b798c3763a058fc8c9953507b3d11923086152de60311731c9c89'],
  commerce_notification_outbox_delete_guard: ['trigger', '0bd6dbf7c0a44193862b61a8ad0484ce7a7795106319fc7b505a889b24706821'],
  commerce_notification_outbox_drop: ['index', '6695c84402bec160831be68e5a163d104e00293aaa28ccce5b21da74458b04af'],
  commerce_notification_outbox_due: ['index', '0c41e4ed80645314f38b7a743ff629b8d48094f62c2688eac6d420e5594cba70'],
  commerce_notification_outbox_family_due: ['index', '77bf8dbb5045e3d29727f5ec1e24ba200e2d2d7703bf1137e365511751e76f3b'],
  commerce_notification_outbox_insert_guard: ['trigger', 'c0184390d1422d395dd3ee3464a7ec263a99195d8525b63aca2cb93ba5c73352'],
  commerce_notification_outbox_pending_owner_insert: ['trigger', '289dfdbdd4b62a43efce7c8f7a57f4b344ad5b55722bdfec42f56f547279d51e'],
  commerce_notification_outbox_pending_owner_path: ['index', 'b12c746376afd70803ab0936f3501f6aab1f6c402da1f5573aeaa8edc7ace346'],
  commerce_notification_outbox_pending_owner_source: ['trigger', '2cde471901e82575575329a663604ba061c4dcf9755806b72ac14f8478d0dc94'],
  commerce_notification_outbox_pending_owner_state: ['trigger', '7bcc978359b0ce245db50f451e30a03e52bd45564a7bf49e80839fbae5fc7a17'],
  commerce_notification_outbox_pending_owners: ['table', '5a8d5783c9d2d2e25648f1bf82b4684519d2f91b3ba36fb986fb831f3fb5da0b'],
  commerce_notification_outbox_pending_path: ['index', '1359f130f5e0cafc7995d45288f5d2cfe5482cc07bce319b43b831da6ef4d4bf'],
  commerce_notification_outbox_resume_guard: ['trigger', '0a73b8805ba7d15e3399265969ca02ca5873178b2b7b38a33fb80a1a0f8cf331'],
  commerce_notification_outbox_stripe_due: ['table', '5afa0b407a916e626402b876a0d3bc2992af426d21e6914c71c7c49b61ef06d7'],
  commerce_notification_outbox_stripe_due_at: ['index', '8a4d0e2385d715badc63e633140e5b2d2a1b7ab02521fbb04b858ea6d83c5f06'],
  commerce_notification_outbox_stripe_due_insert: ['trigger', 'b756dc5d600bb1344ffdd08f86848fc7243598ea4113d98879538df3269d17fb'],
  commerce_notification_outbox_stripe_due_source: ['trigger', '8c13c3a33bad1e89807dfc9740128a3f60e34d41f152a5b3c1f8f9c4d7c8dad4'],
  commerce_notification_outbox_stripe_due_state: ['trigger', '55a3f2c4ea6b3d140c1fd9a8470d2330ea0dacbe8a45d35b5143c79868b6443e'],
  commerce_notification_outbox_update_guard: ['trigger', 'f1b74eef1fc6e0fedc0c849a1128f99c7b42285062667de0ca0e709c9d25705c'],
});
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHORITY_UPDATE_GUARD_SCHEMA_FINGERPRINT = '376e5c3579dd47c8742fb68171df543c2c35fc144a8c2277d66d68fd73c82b07';
const COMMIT_GUARD_SCHEMA_FINGERPRINT = '13c79bbc939b01898f4a4ebc429d7d83899158f0e65a54d3b9592290d4884f80';
const COMMIT_GUARD_TABLE_SCHEMA_FINGERPRINT = '1556298f47f92ca475dae746d1a730706cdcc5ff1df34ac21e911ffcbd570c26';
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
const STRIPE_IDENTITY_INDEX_SQL: Readonly<Record<string, string>> = Object.freeze({
  commerce_documents_stripe_payment_intent: `CREATE INDEX commerce_documents_stripe_payment_intent
    ON commerce_documents (json_extract(document_json, '$.stripePaymentIntentId'))
    WHERE document_kind IN ('stripe_checkout', 'delivery_order')`,
  commerce_stripe_checkouts_session_id: `CREATE INDEX commerce_stripe_checkouts_session_id
    ON commerce_documents (document_id)
    WHERE document_kind = 'stripe_checkout'`,
  commerce_stripe_delivery_orders_session_id: `CREATE INDEX commerce_stripe_delivery_orders_session_id
    ON commerce_documents (source, json_extract(document_json, '$.stripeCheckoutSessionId'))
    WHERE document_kind = 'delivery_order'`,
});
const ADMIN_IRL_WORKFLOW_OPERATION_INDEX_SQL = `CREATE INDEX commerce_admin_irl_redeem_workflow_operation
  ON commerce_documents (
    json_extract(document_json, '$.workflowFinalizeV1.operationId'),
    document_path
  )
  WHERE document_kind = 'admin_irl_redeem_request'`;
const READY_NOTIFICATION_DUE_INDEX_SQL = `CREATE INDEX commerce_ready_notifications_due
  ON commerce_documents (
    CASE WHEN
      json_type(document_json, '$.readyToShipNotificationPublishClaimId') = 'text' AND
      json_extract(document_json, '$.readyToShipNotificationPublishClaimId') <> '' AND
      json_type(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') IN ('integer', 'real') AND
      json_extract(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_extract(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') = CAST(json_extract(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') AS INTEGER)
    THEN CAST(json_extract(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') AS INTEGER) ELSE 0 END,
    document_path
  )
  WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship' AND
    (buyer_notification_state = 'pending' OR shipper_notification_state = 'pending')`;

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

function requireIdentitySearchIndex(
  plan: Record<string, unknown>[],
  indexName: string,
  identityConstraint: string,
): void {
  if (!plan.some((row) => {
    const detail = normalizedSql(row.detail);
    return detail.startsWith('SEARCH ') && detail.includes(`${indexName} (${identityConstraint})`);
  })) fail(`Commerce D1 query plan does not search ${indexName} by Stripe identity.`);
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
    migrations.length !== 13 ||
    migrations[0].name !== '0001_current_schema.sql' ||
    migrations[1].name !== '0002_authority_control_lease.sql' ||
    migrations[2].name !== '0003_wipe_readiness_guard.sql' ||
    migrations[3].name !== '0004_ready_notification_owner_indexes.sql' ||
    migrations[4].name !== '0005_delivery_owner_query_revisions.sql' ||
    migrations[5].name !== '0006_document_path_revisions.sql' ||
    migrations[6].name !== '0007_stripe_terminal_notifications.sql' ||
    migrations[7].name !== '0008_admin_irl_redeem_workflow_operation.sql' ||
    migrations[8].name !== '0009_ready_notification_due_index.sql' ||
    migrations[9].name !== '0010_dude_inventory.sql' ||
    migrations[10].name !== '0011_stripe_order_disputes.sql' ||
    migrations[11].name !== '0012_stripe_identity_lookup_indexes.sql' ||
    migrations[12].name !== '0013_notification_outbox.sql'
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
    'commerce_notification_outbox',
    'commerce_notification_outbox_control',
    'commerce_notification_outbox_pending_owners',
    'commerce_notification_outbox_stripe_due',
    'commerce_wipe_guards',
    'stripe_order_disputes',
  ];
  if (
    authoritativeTables.length !== requiredTables.length ||
    authoritativeTables.some((row, index) => row.name !== requiredTables[index] || row.strict !== 1)
  ) {
    fail('Commerce D1 authoritative strict table inventory is invalid.');
  }
  const chargebackSchema = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'stripe_order_disputes'`);
  const chargebackIndex = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND name = 'stripe_order_disputes_drop_session'`);
  if (chargebackSchema.length !== 1 ||
    sqlSchemaFingerprint(String(chargebackSchema[0].sql)) !== '722711e091525e0b50cced4e2c85593574bc0dbcc471f9232f156db94de5754f' ||
    chargebackIndex.length !== 1 ||
    sqlSchemaFingerprint(String(chargebackIndex[0].sql)) !== '6f82bc70a76c4d1d960e01da07a6a9df42c067965134d4cd68a5abf0d4b3600e') {
    fail('Stripe chargeback history schema is invalid.');
  }
  for (const row of queryRemoteCommerceD1('SELECT * FROM stripe_order_disputes')) {
    if ((row.livemode !== 0 && row.livemode !== 1) || !isStripeChargebackSessionId(row.session_id) ||
      row.session_id.startsWith('cs_live_') !== (row.livemode === 1) || !isStripeDisputeId(row.dispute_id) ||
      !isCommerceDocumentSegment(row.drop_id) || typeof row.charge_id !== 'string' ||
      row.charge_id.length > 256 || !/^(?:ch|py)_[A-Za-z0-9_]+$/.test(row.charge_id) ||
      typeof row.payment_intent_id !== 'string' || row.payment_intent_id.length > 256 ||
      !/^pi_[A-Za-z0-9_]+$/.test(row.payment_intent_id)) fail('Stripe chargeback history identity is invalid.');
    safeInteger(row.dispute_created_at, 'Stripe dispute creation time');
    safeInteger(row.recorded_at_ms, 'Stripe chargeback recording time');
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
    document_path, document_kind, drop_id, document_id, document_json, version, create_time, update_time
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
      'guard_id,expectations_json,expected_documents_revision,created_at_ms,delivery_owner_expectations_json,notification_outbox_expectations_json' ||
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
    ...Object.entries(NOTIFICATION_SCHEMA_FINGERPRINTS).filter(([, [type]]) => type === 'trigger').map(([name]) => name),
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

  for (const [name, expectedSql] of Object.entries(STRIPE_IDENTITY_INDEX_SQL)) {
    const index = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
      WHERE type = 'index' AND name = '${name}'`);
    if (
      index.length !== 1 ||
      sqlSchemaFingerprint(String(index[0].sql || '')) !== sqlSchemaFingerprint(expectedSql)
    ) fail(`Commerce D1 Stripe identity index ${name} is invalid.`);
  }

  const adminIrlWorkflowOperationIndex = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND name = 'commerce_admin_irl_redeem_workflow_operation'`);
  if (
    adminIrlWorkflowOperationIndex.length !== 1 ||
    normalizedSql(adminIrlWorkflowOperationIndex[0].sql) !== normalizedSql(ADMIN_IRL_WORKFLOW_OPERATION_INDEX_SQL)
  ) fail('Commerce D1 Admin IRL Workflow operation index is invalid.');

  const readyNotificationDueIndex = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND name = 'commerce_ready_notifications_due'`);
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

  for (const [name, [type, fingerprint]] of Object.entries(NOTIFICATION_SCHEMA_FINGERPRINTS)) {
    const rows = queryRemoteCommerceD1(`SELECT sql FROM sqlite_schema WHERE type = '${type}' AND name = '${name}'`);
    if (rows.length !== 1 || sqlSchemaFingerprint(String(rows[0].sql)) !== fingerprint) {
      fail(`Notification outbox schema is invalid: ${name}.`);
    }
  }

  const queryPlan = (query: CommerceSqlQuery) =>
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN ${renderCommerceQuerySql(query)}`);

  const initialDeliveryOwnerPlan = queryPlan(deliveryOrderOwnersQuery({ limit: 501 }));
  requireSearchIndex(initialDeliveryOwnerPlan, 'commerce_documents_delivery_owner_path');
  requireNoTemporaryBTree(initialDeliveryOwnerPlan, 'initial delivery-owner');
  const keysetDeliveryOwnerPlan = queryPlan(deliveryOrderOwnersQuery({
    limit: 501,
    startAfterOwner: '11111111111111111111111111111111',
  }));
  requireSearchIndex(keysetDeliveryOwnerPlan, 'commerce_documents_delivery_owner_path');
  requireNoTemporaryBTree(keysetDeliveryOwnerPlan, 'keyset delivery-owner');
  const deliveryRecoveryPlan = queryPlan(deliveryRecoveryOrdersQuery('11111111111111111111111111111111'));
  requireSearchIndex(deliveryRecoveryPlan, 'commerce_documents_delivery_owner_status');
  if (!deliveryRecoveryPlan.some((row) => normalizedSql(row.detail).includes(
    'commerce_documents_delivery_owner_status (document_kind=? AND owner=? AND status=?)',
  ))) fail('Commerce D1 delivery-recovery query plan does not use the full owner-status prefix.');
  requireNoTemporaryBTree(deliveryRecoveryPlan, 'delivery-recovery');
  queryRemoteCommerceD1(renderCommerceQuerySql(deliveryOrderOwnersQuery({ limit: 1 })));
  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND fulfillment_status = 'pending'`),
    'commerce_documents_fulfillment_status',
  );
  requireIndex(
    queryPlan(manualReviewCheckoutsQuery({ dropId: 'drop' })),
    'commerce_documents_manual_review',
  );
  requireIndex(
    queryPlan(fulfillmentOrdersQuery({ dropId: 'drop', limit: 1001 })),
    'commerce_documents_drop_processed_cursor',
  );
  requireIndex(
    queryPlan(fulfillmentOrdersQuery({
      dropId: 'drop',
      limit: 1001,
      startAfter: {
        processedAt: { seconds: 1, nanos: 1 },
        documentPath: 'drops/drop/deliveryOrders/1',
      },
    })),
    'commerce_documents_drop_processed_cursor',
  );
  const ownerNotificationPlan = queryPlan(pendingReadyNotificationsQuery({
    limit: 8,
    owner: 'owner',
    startAfterPath: 'drops/a/deliveryOrders/1',
  }));
  requireSearchIndex(ownerNotificationPlan, 'commerce_notification_outbox_pending_owner_path');
  requireNoTemporaryBTree(ownerNotificationPlan, 'owner ready-notification');
  const ownerlessNotificationPlan = queryPlan(pendingReadyNotificationsQuery({
    limit: 8,
    startAfterPath: 'drops/a/deliveryOrders/1',
  }));
  requireSearchIndex(ownerlessNotificationPlan, 'commerce_notification_outbox_pending_path');
  requireIndex(
    queryPlan(duePackStatusProjectionsQuery({ dropId: 'drop', dueAtMs: 1, limit: 4 })),
    'commerce_documents_pack_projection',
  );
  requireIndex(
    queryPlan(staleStripeFulfillmentsQuery(1)),
    'commerce_stripe_checkouts_reconciliation_due',
  );

  const readyNotificationDuePlan = queryPlan(dueReadyNotificationsQuery({ dueAtMs: 1, limit: 8 }));
  requireSearchIndex(readyNotificationDuePlan, 'commerce_notification_outbox_family_due');
  requireNoTemporaryBTree(readyNotificationDuePlan, 'due ready-notification');

  const stripeTerminalNotificationPlan = queryPlan(dueStripeTerminalNotificationsQuery({ dueAtMs: 1, limit: 20 }));
  requireSearchIndex(stripeTerminalNotificationPlan, 'commerce_notification_outbox_stripe_due_at');
  requireNoTemporaryBTree(stripeTerminalNotificationPlan, 'Stripe terminal-notification');

  const stripeLinkedSessionsPlan = queryPlan(stripeChargebackLinkedSessionsQuery('pi_check'));
  requireIdentitySearchIndex(stripeLinkedSessionsPlan, 'commerce_documents_stripe_payment_intent', '<expr>=?');
  const stripeMatchedDocumentsPlan = queryPlan(stripeChargebackMatchedDocumentsQuery('cs_live_check'));
  requireIdentitySearchIndex(stripeMatchedDocumentsPlan, 'commerce_stripe_checkouts_session_id', 'document_id=?');
  requireIdentitySearchIndex(
    stripeMatchedDocumentsPlan,
    'commerce_stripe_delivery_orders_session_id',
    'source=? AND <expr>=?',
  );

  const adminIrlWorkflowStatusPlan = queryPlan(adminIrlRedeemWorkflowStatusQuery(`airf-v1-${'0'.repeat(64)}`));
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

  const notificationControls = queryRemoteCommerceD1('SELECT * FROM commerce_notification_outbox_control');
  const notificationControl = notificationControls[0];
  if (notificationControls.length !== 1 || !['legacy', 'table'].includes(String(notificationControl.storage_mode)) ||
    !['idle', 'preparing', 'ready'].includes(String(notificationControl.preparation_state))) fail('Notification outbox control is invalid.');
  const notificationRows = queryRemoteCommerceD1('SELECT * FROM commerce_notification_outbox ORDER BY parent_path, family')
    .map(parseNotificationOutboxRow);
  const parents = new Map(authoritativeDocuments.map((document) => [document.document_path, document]));
  for (const row of notificationRows) {
    const parent = parents.get(row.parentPath);
    if (!parent || parent.drop_id !== row.dropId || parent.document_kind !==
      (row.family === 'stripe_terminal' ? 'stripe_checkout' : 'delivery_order')) fail('Notification outbox parent identity is invalid.');
  }
  const invalidNotificationOwners = queryRemoteCommerceD1(`SELECT COUNT(*) AS count FROM (
    SELECT outbox.parent_path, outbox.family
    FROM commerce_notification_outbox AS outbox
    JOIN commerce_documents AS document ON document.document_path = outbox.parent_path
    LEFT JOIN commerce_notification_outbox_pending_owners AS pending
      ON pending.parent_path = outbox.parent_path AND pending.family = outbox.family
    WHERE outbox.state = 'pending' AND document.owner IS NOT NULL
      AND (outbox.family <> 'ready' OR document.status = 'ready_to_ship')
      AND (pending.parent_path IS NULL OR pending.owner IS NOT document.owner)
    UNION ALL
    SELECT pending.parent_path, pending.family
    FROM commerce_notification_outbox_pending_owners AS pending
    LEFT JOIN commerce_notification_outbox AS outbox
      ON outbox.parent_path = pending.parent_path AND outbox.family = pending.family
    LEFT JOIN commerce_documents AS document ON document.document_path = pending.parent_path
    WHERE outbox.state IS NOT 'pending' OR pending.owner IS NOT document.owner
      OR (pending.family = 'ready' AND document.status IS NOT 'ready_to_ship')
  )`);
  if (invalidNotificationOwners.length !== 1 ||
    safeInteger(invalidNotificationOwners[0].count, 'Notification outbox owner invalid count') !== 0) {
    fail('Notification outbox pending-owner lookup is inconsistent.');
  }
  const invalidStripeDue = queryRemoteCommerceD1(`SELECT COUNT(*) AS count FROM (
    SELECT outbox.parent_path
    FROM commerce_notification_outbox AS outbox
    JOIN commerce_documents AS document ON document.document_path = outbox.parent_path
    LEFT JOIN commerce_notification_outbox_stripe_due AS due
      ON due.parent_path = outbox.parent_path AND due.family = outbox.family
    WHERE outbox.family = 'stripe_terminal' AND outbox.state = 'pending'
      AND ((outbox.outcome = 'fulfilled' AND document.status = 'fulfilled') OR
        (outbox.outcome = 'manual_review' AND document.status = 'fulfillment_failed' AND document.manual_refund_review_required = 1))
      AND (due.parent_path IS NULL OR due.next_attempt_at_ms IS NOT outbox.next_attempt_at_ms)
    UNION ALL
    SELECT due.parent_path FROM commerce_notification_outbox_stripe_due AS due
    WHERE NOT EXISTS (
      SELECT 1 FROM commerce_notification_outbox AS outbox
      JOIN commerce_documents AS document ON document.document_path = outbox.parent_path
      WHERE outbox.parent_path = due.parent_path AND outbox.family = due.family
        AND outbox.family = 'stripe_terminal' AND outbox.state = 'pending'
        AND outbox.next_attempt_at_ms = due.next_attempt_at_ms
        AND ((outbox.outcome = 'fulfilled' AND document.status = 'fulfilled') OR
          (outbox.outcome = 'manual_review' AND document.status = 'fulfillment_failed' AND document.manual_refund_review_required = 1))
    )
  )`);
  if (invalidStripeDue.length !== 1 || safeInteger(invalidStripeDue[0].count, 'Stripe notification due invalid count') !== 0) {
    fail('Notification outbox Stripe due lookup is inconsistent.');
  }
  if (notificationControl.storage_mode === 'legacy' && notificationControl.preparation_state === 'ready') {
    const expected = authoritativeDocuments.map(parseCommerceD1DocumentRow).flatMap(planNotificationOutboxBackfill)
      .sort((left, right) => left.parentPath.localeCompare(right.parentPath) || left.family.localeCompare(right.family));
    if (notificationControl.source_documents_revision !== authority.documents_revision ||
      !isDeepStrictEqual(notificationRows.slice().sort((left, right) => left.parentPath.localeCompare(right.parentPath) || left.family.localeCompare(right.family)), expected)) {
      fail('Notification outbox preparation differs from source documents.');
    }
  }
  if (options.forDeployment && notificationControl.storage_mode !== 'table' && !(
    authority.authority_state === 'paused' && authority.paused_at_ms !== null &&
    notificationControl.preparation_state === 'ready' && notificationControl.source_documents_revision === authority.documents_revision
  )) fail('API deployment requires activated notification outbox storage or fully paused, verified preparation. Follow scripts/docs/notification_outbox_cutover.md.');
  for (const family of ['ready', 'stripe_terminal', 'shipped'] as const) {
    const plan = queryPlan(notificationOutboxDueQuery({ family, dueAtMs: 1, limit: 8 }));
    requireSearchIndex(plan, 'commerce_notification_outbox_family_due');
    requireNoTemporaryBTree(plan, 'notification outbox due');
  }
  const notificationFailures = queryRemoteCommerceD1(`SELECT family, last_error_code, COUNT(*) AS count
    FROM commerce_notification_outbox WHERE state = 'failed' GROUP BY family, last_error_code ORDER BY family, last_error_code`);

  const kindCounts = Object.fromEntries(queryRemoteCommerceD1(`SELECT document_kind, COUNT(*) AS count
    FROM commerce_documents GROUP BY document_kind ORDER BY document_kind`).map((row) => [
      String(row.document_kind),
      safeInteger(row.count, 'Commerce document-kind count'),
    ]));
  return {
    authorityState: authority.authority_state,
    authorityRevision: safeInteger(authority.revision, 'Commerce authority revision'),
    inventoryMode: authority.dude_inventory_mode,
    notificationOutboxMode: notificationControl.storage_mode,
    notificationOutboxPreparation: notificationControl.preparation_state,
    notificationOutboxGroups: notificationRows.length,
    notificationOutboxFailures: notificationFailures,
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
