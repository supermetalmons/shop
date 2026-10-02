import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { PREORDER_CARD_IDS } from '../../shared/preorderCardIds.generated.ts';
import { parseDeliveryRecoveryRow } from '../../shared/deliveryRecoveryState.ts';
import { LEGACY_DELIVERY_RECOVERY_JSON_SQL, planDeliveryRecoveryStateBackfill } from '../shared/deliveryRecoveryStateMaintenance.ts';
import { parseNotificationOutboxRow } from '../../shared/notificationOutbox.ts';
import { parsePackStatusOutboxRow } from '../../shared/packStatusOutbox.ts';
import { planNotificationOutboxBackfill } from '../shared/notificationOutboxMaintenance.ts';
import { LEGACY_PACK_STATUS_PROJECTION_FIELDS, legacyPackStatusProjectionsQuery, planPackStatusOutboxBackfill } from '../shared/packStatusOutboxMaintenance.ts';
import { planStripeCheckoutStateBackfill } from '../shared/stripeCheckoutStateMaintenance.ts';
import { parseStripeCheckoutStateRow } from '../../shared/stripeCheckoutState.ts';
import { stripeCheckoutStateSelectColumns } from '../../cloud/workers/api/src/stripeCheckoutStateStore.ts';
import { assertCanonicalCommerceIdentity } from '../shared/commerceIdentityValidation.ts';
import {
  commerceD1DocumentIdentity,
  parseCommerceD1DocumentRow,
  queryRemoteCommerceD1 as defaultQueryRemoteCommerceD1,
  safeInteger,
} from '../shared/commerceD1Maintenance.ts';
import { sqlSchemaFingerprint } from '../shared/sqlSchemaFingerprint.ts';
import { readCommerceSchemaManifest, selectCommerceSchemaCheckpoint, type CommerceSchemaManifest, type CommerceSchemaCheckpoint } from '../shared/commerceSchemaManifest.ts';
import { inventoryDropConfigs } from '../shared/dudeInventoryMaintenance.ts';
import { isCommerceDocumentSegment } from '../../shared/commerceDocumentPath.ts';
import { isStripeChargebackSessionId, isStripeDisputeId } from '../../shared/stripeChargebacks.ts';
import {
  adminIrlRedeemWorkflowStatusQuery,
  deliveryOrderOwnersQuery,
  deliveryRecoveryStateQuery,
  packStatusOutboxDueQuery,
  dueReadyNotificationsQuery,
  dueStripeTerminalNotificationsQuery,
  fulfillmentOrdersQuery,
  manualReviewCheckoutsQuery,
  pendingReadyNotificationsQuery,
  shipmentHistoryPageQuery,
  shipmentPresenceQuery,
  notificationOutboxDueQuery,
  staleStripeFulfillmentsQuery,
  stripeChargebackLinkedSessionsQuery,
  stripeChargebackMatchedDocumentsQuery,
  type CommerceSqlQuery,
} from '../../cloud/workers/api/src/commerceQueries.ts';
import { renderCommerceQuerySql } from '../shared/commerceQuerySql.ts';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  throw new Error(message);
}

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

function createCommerceSchemaCatalog(query: CheckCommerceD1Query) {
  type Rows = ReturnType<CheckCommerceD1Query>;
  let catalog: { rows: Rows; objects: Map<string, Rows> } | undefined;
  const load = () => {
    if (catalog) return catalog;
    const rows = query(`SELECT type, name, sql,
      type = 'trigger' AND name LIKE 'commerce_%' AS commerce_trigger
      FROM sqlite_schema ORDER BY name`);
    const objects = new Map<string, Rows>();
    for (const row of rows) {
      const key = `${String(row.type)}:${String(row.name)}`;
      const existing = objects.get(key);
      if (existing) existing.push(row);
      else objects.set(key, [row]);
    }
    catalog = { rows, objects };
    return catalog;
  };
  return {
    get: (type: string, name: string): Rows => load().objects.get(`${type}:${name}`) || [],
    commerceTriggers: (): Rows => load().rows.filter((row) => row.commerce_trigger === 1),
  };
}

function validateCommerceSchema(
  manifest: CommerceSchemaManifest,
  checkpoint: CommerceSchemaCheckpoint,
  catalog: ReturnType<typeof createCommerceSchemaCatalog>,
  query: CheckCommerceD1Query,
  migration: string,
): void {
  const invalidObject = (name: string): never => fail(`Commerce D1 schema ${name} is invalid at ${migration}.`);
  const expected = new Set(checkpoint.objects.map(({ type, name }) => `${type}:${name}`));
  for (const { type, name, fingerprint } of checkpoint.objects) {
    const rows = catalog.get(type, name);
    if (rows.length !== 1 || typeof rows[0].sql !== 'string' || sqlSchemaFingerprint(rows[0].sql) !== fingerprint) {
      invalidObject(name);
    }
  }
  const historicalObjects = new Map(Object.values(manifest.checkpoints)
    .flatMap((version) => version.objects).map((object) => [`${object.type}:${object.name}`, object]));
  for (const [key, { type, name }] of historicalObjects) {
    if (!expected.has(key) && catalog.get(type, name).length) invalidObject(name);
  }
  const tables = query(`SELECT name, strict
    FROM pragma_table_list
    WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*'
      AND name <> 'd1_migrations'
    ORDER BY name`);
  const expectedTables = checkpoint.objects.filter(({ type }) => type === 'table').map(({ name }) => name).sort();
  if (tables.length !== expectedTables.length || tables.some((row, index) => row.name !== expectedTables[index] || row.strict !== 1)) {
    fail('Commerce D1 authoritative strict table inventory is invalid.');
  }
  const expectedTriggers = new Set(checkpoint.objects.filter(({ type, name }) =>
    type === 'trigger' && /^commerce./i.test(name)).map(({ name }) => name));
  const triggers = catalog.commerceTriggers();
  if (triggers.length !== expectedTriggers.size || triggers.some((row) => !expectedTriggers.has(String(row.name)))) {
    fail('Commerce D1 trigger inventory is invalid.');
  }
  if (checkpoint.preorderCardIds) {
    const cards = query('SELECT card_id FROM commerce_preorder_cards ORDER BY card_id').map((row) => row.card_id);
    if (!isDeepStrictEqual(cards, checkpoint.preorderCardIds)) fail('Commerce D1 preorder catalog is invalid.');
  }
}

function legacyCheckoutQuery(query: CommerceSqlQuery): CommerceSqlQuery {
  let sql = query.sql;
  for (const alias of ['commerce_documents', 'document']) {
    sql = sql.replaceAll(`, ${stripeCheckoutStateSelectColumns(alias)}`, '');
  }
  sql = sql.replace(/AND EXISTS \(SELECT 1 FROM commerce_stripe_checkout_state AS checkout_state\s+WHERE checkout_state.document_path = commerce_documents.document_path\s+AND checkout_state.status = 'fulfillment_failed'\)/,
    "AND status = 'fulfillment_failed'");
  sql = sql.replace(/AND EXISTS \(SELECT 1 FROM commerce_stripe_checkout_state AS checkout_state\s+WHERE checkout_state.document_path = document.document_path\s+AND \(\(outbox.outcome = 'fulfilled' AND checkout_state.status = 'fulfilled'\) OR\s+\(outbox.outcome = 'manual_review' AND checkout_state.status = 'fulfillment_failed' AND document.manual_refund_review_required = 1\)\)\)/,
    "AND ((outbox.outcome = 'fulfilled' AND document.status = 'fulfilled') OR (outbox.outcome = 'manual_review' AND document.status = 'fulfillment_failed' AND document.manual_refund_review_required = 1))");
  if (sql.includes('INDEXED BY commerce_stripe_checkout_state_reconciliation_due')) {
    sql = `SELECT document_path FROM commerce_documents
      WHERE document_kind = 'stripe_checkout' AND fulfillment_processor = 'cloudflare_queue_v1'
        AND status IN ('fulfillment_pending', 'processing')
        AND json_type(document_json, '$.updatedAt') IN ('integer', 'real')
        AND json_type(document_json, '$.lastStripeWebhookEventId') = 'text'
        AND CAST(json_extract(document_json, '$.updatedAt') AS INTEGER) <= ?
      ORDER BY CAST(json_extract(document_json, '$.updatedAt') AS INTEGER), document_path LIMIT 100`;
  }
  return { ...query, sql };
}

export function checkCommerceD1(
  queryRemoteCommerceD1: CheckCommerceD1Query = defaultQueryRemoteCommerceD1,
  options: { forDeployment?: boolean } = {},
): Record<string, unknown> {
  const schemaCatalog = createCommerceSchemaCatalog(queryRemoteCommerceD1);
  const quick = queryRemoteCommerceD1('PRAGMA quick_check');
  if (quick.length !== 1 || quick[0].quick_check !== 'ok') fail('Commerce D1 quick check failed.');
  if (queryRemoteCommerceD1('PRAGMA foreign_key_check').length !== 0) fail('Commerce D1 foreign-key check failed.');

  const manifest = readCommerceSchemaManifest();
  const migrations = queryRemoteCommerceD1('SELECT name FROM d1_migrations ORDER BY id');
  const checkpoint = selectCommerceSchemaCheckpoint(manifest, migrations.map((migration) => migration.name));
  if (options.forDeployment && migrations.length !== manifest.migrations.length) {
    fail(`Commerce D1 deployment requires the latest migration: ${manifest.migrations.at(-1)!.name}.`);
  }
  if (options.forDeployment && !isDeepStrictEqual(checkpoint.preorderCardIds, PREORDER_CARD_IDS)) {
    fail('Commerce D1 deployment catalog differs from the generated application catalog.');
  }
  const hasMigration = (name: string) => migrations.some((migration) => migration.name === name);
  const stripeCheckoutStateReady = hasMigration('0026_stripe_checkout_state.sql');
  const deliveryRecoveryStateReady = hasMigration('0030_delivery_recovery.sql');
  const deliveryRecoveryMetadataClean = hasMigration('0033_delivery_recovery_metadata_cleanup.sql');
  const packStatusOutboxReady = hasMigration('0029_pack_status_outbox.sql');
  const manualReviewPaginationReady = hasMigration('0015_manual_review_pagination.sql');
  const shipmentPaginationReady = hasMigration('0016_shipment_history_pagination.sql');
  const receiptClaimWorkflowReady = hasMigration('0017_receipt_claim_workflow.sql');
  validateCommerceSchema(manifest, checkpoint, schemaCatalog, queryRemoteCommerceD1, String(migrations.at(-1)!.name));

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
  const stripeCheckoutControls = stripeCheckoutStateReady ? queryRemoteCommerceD1('SELECT * FROM commerce_stripe_checkout_state_control') : [];
  const stripeCheckoutControl = stripeCheckoutControls[0];
  if (stripeCheckoutStateReady && (stripeCheckoutControls.length !== 1 ||
    !['legacy', 'table'].includes(String(stripeCheckoutControl.storage_mode)) ||
    !['idle', 'preparing', 'ready'].includes(String(stripeCheckoutControl.preparation_state)))) fail('Stripe checkout state control is invalid.');
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

  if (deliveryRecoveryMetadataClean) {
    const legacyRecovery = queryRemoteCommerceD1(`SELECT COUNT(*) AS count FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND json_type(document_json, '$.receiptRecovery') IS NOT NULL`);
    if (legacyRecovery.length !== 1 || safeInteger(legacyRecovery[0].count, 'Legacy delivery recovery metadata count') !== 0) {
      fail('Commerce D1 delivery recovery metadata is not canonical.');
    }
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

  if (receiptClaimWorkflowReady) {
    requireSearchIndex(queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path FROM commerce_documents INDEXED BY commerce_receipt_claim_workflow_operation
      WHERE document_kind = 'claim_code' AND json_extract(document_json, '$.receiptClaimWorkflowV1.operationId') = 'src-v1-check'`),
    'commerce_receipt_claim_workflow_operation');
    requireSearchIndex(queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path FROM commerce_documents INDEXED BY commerce_receipt_claim_workflow_due
      WHERE document_kind = 'claim_code' AND json_extract(document_json, '$.receiptClaimWorkflowV1.phase') = 'pending'
        AND json_extract(document_json, '$.receiptClaimWorkflowV1.nextAttemptAtMs') <= 0
      ORDER BY json_extract(document_json, '$.receiptClaimWorkflowV1.nextAttemptAtMs'), document_path LIMIT 20`),
    'commerce_receipt_claim_workflow_due');
  }

  const queryPlan = (query: CommerceSqlQuery) =>
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN ${renderCommerceQuerySql(stripeCheckoutStateReady ? query : legacyCheckoutQuery(query))}`);

  const initialDeliveryOwnerPlan = queryPlan(deliveryOrderOwnersQuery({ limit: 501 }));
  requireSearchIndex(initialDeliveryOwnerPlan, 'commerce_documents_delivery_owner_path');
  requireNoTemporaryBTree(initialDeliveryOwnerPlan, 'initial delivery-owner');
  const keysetDeliveryOwnerPlan = queryPlan(deliveryOrderOwnersQuery({
    limit: 501,
    startAfterOwner: '11111111111111111111111111111111',
  }));
  requireSearchIndex(keysetDeliveryOwnerPlan, 'commerce_documents_delivery_owner_path');
  requireNoTemporaryBTree(keysetDeliveryOwnerPlan, 'keyset delivery-owner');
  if (deliveryRecoveryStateReady) {
    const deliveryRecoveryPlan = queryPlan(deliveryRecoveryStateQuery('11111111111111111111111111111111', 1, 1));
    requireSearchIndex(deliveryRecoveryPlan, 'commerce_documents_delivery_owner_status');
    if (!deliveryRecoveryPlan.some((row) => normalizedSql(row.detail).includes(
      'commerce_documents_delivery_owner_status (document_kind=? AND owner=? AND status=?)',
    ))) fail('Commerce D1 delivery-recovery summary does not use the full owner-status prefix.');
    requireNoTemporaryBTree(deliveryRecoveryPlan, 'delivery-recovery summary');
  }
  if (shipmentPaginationReady) {
    const owner = '11111111111111111111111111111111';
    for (const startAfter of [undefined, {
      version: 1 as const, owner, sortAtMs: 1, documentPath: 'drops/drop/deliveryOrders/1',
    }]) {
      const plan = queryPlan(shipmentHistoryPageQuery({ owner, limit: 51, startAfter }));
      requireSearchIndex(plan, 'commerce_delivery_orders_shipment_cursor');
      requireNoTemporaryBTree(plan, 'shipment-history');
      if (startAfter && !plan.some((row) => normalizedSql(row.detail).includes(
        '(shipment_sort_at_ms,document_path)<(?,?)',
      ))) fail('Commerce D1 shipment-history query plan does not seek the full cursor.');
    }
    for (const selectors of [
      { stripeSessionIds: ['cs_cursor'] },
      { documentPaths: ['drops/drop/deliveryOrders/1'] },
      { stripeSessionIds: ['cs_cursor'], documentPaths: ['drops/drop/deliveryOrders/1'] },
    ]) {
      const plan = queryPlan(shipmentPresenceQuery({ owner, ...selectors }));
      if (selectors.stripeSessionIds && !plan.some((row) => normalizedSql(row.detail).includes(
        'SEARCH commerce_documents USING INDEX commerce_delivery_orders_shipment_session (owner=? AND <expr>=?)',
      ))) fail('Commerce D1 shipment presence query plan does not search by owner and Stripe session.');
      if (selectors.documentPaths) requireSearchIndex(plan, 'sqlite_autoindex_commerce_documents_1');
      requireNoTemporaryBTree(plan, 'shipment presence');
    }
  }
  queryRemoteCommerceD1(renderCommerceQuerySql(deliveryOrderOwnersQuery({ limit: 1 })));
  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND fulfillment_status = 'pending'`),
    'commerce_documents_fulfillment_status',
  );
  if (manualReviewPaginationReady) {
    for (const startAfter of [undefined, {
      version: 1 as const, dropId: 'drop', sortAtMs: 1, sessionId: 'cs_cursor',
      documentPath: 'drops/drop/stripeCheckouts/cs_cursor',
    }]) {
      const plan = queryPlan(manualReviewCheckoutsQuery({ dropId: 'drop', limit: 26, startAfter }));
      requireSearchIndex(plan, 'commerce_stripe_checkouts_manual_review_cursor');
      requireNoTemporaryBTree(plan, 'manual-review');
      if (startAfter && !plan.some((row) => normalizedSql(row.detail).includes(
        '(manual_review_sort_at_ms,manual_review_session_id,document_path)<(?,?,?)',
      ))) fail('Commerce D1 manual-review query plan does not seek the full cursor.');
    }
  } else {
    requireIndex(queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path FROM commerce_documents
      WHERE document_kind = 'stripe_checkout' AND drop_id = 'drop' AND manual_refund_review_required = 1
      ORDER BY document_path ASC`), 'commerce_documents_manual_review');
  }
  for (const startAfter of [undefined, {
    processedAt: { seconds: 1, nanos: 1 },
    documentPath: 'drops/drop/deliveryOrders/1',
  }]) {
    const plan = queryPlan(fulfillmentOrdersQuery({ dropId: 'drop', limit: 1001, startAfter }));
    requireSearchIndex(plan, 'commerce_documents_drop_processed_cursor');
    requireNoTemporaryBTree(plan, 'fulfillment');
    const searches = plan.map((row) => normalizedSql(row.detail)).filter((detail) => detail.startsWith(
      'SEARCH commerce_documents USING INDEX commerce_documents_drop_processed_cursor ',
    ));
    if (startAfter && !searches.some((detail) => detail.includes(
      '(document_kind=? AND drop_id=? AND status=? AND (processed_at_seconds,processed_at_nanos,document_path)<(?,?,?))',
    ))) fail('Commerce D1 fulfillment query plan does not seek the full cursor.');
    if (startAfter && !searches.some((detail) => detail.includes(
      '(document_kind=? AND drop_id=? AND status=? AND processed_at_seconds=?)',
    ))) fail('Commerce D1 fulfillment query plan does not search the null-timestamp tail.');
  }
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
  if (packStatusOutboxReady) {
    const plan = queryPlan(packStatusOutboxDueQuery({ dropId: 'drop', dueAtMs: 1, limit: 4 }));
    requireSearchIndex(plan, 'commerce_pack_status_outbox_due');
    if (!plan.some((row) => normalizedSql(row.detail).includes('(drop_id=? AND next_attempt_at_ms<?)'))) {
      fail('Commerce D1 pack-status outbox query plan does not seek the full drop-due prefix.');
    }
    requireNoTemporaryBTree(plan, 'pack-status outbox');
  } else {
    requireIndex(
      queryPlan(legacyPackStatusProjectionsQuery({ dropId: 'drop', dueAtMs: 1, limit: 4 })),
      'commerce_documents_pack_projection',
    );
  }
  requireIndex(
    queryPlan(staleStripeFulfillmentsQuery(1)),
    stripeCheckoutStateReady ? 'commerce_stripe_checkout_state_reconciliation_due' : 'commerce_stripe_checkouts_reconciliation_due',
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
  const recoveryControls = deliveryRecoveryStateReady
    ? queryRemoteCommerceD1('SELECT * FROM commerce_delivery_recovery_control') : [];
  const recoveryControl = recoveryControls[0];
  if (deliveryRecoveryStateReady) {
    if (recoveryControls.length !== 1 || recoveryControl.singleton !== 1 ||
      !['legacy', 'table'].includes(String(recoveryControl.storage_mode)) ||
      !['idle', 'preparing', 'ready'].includes(String(recoveryControl.preparation_state)) ||
      (recoveryControl.storage_mode === 'table' && recoveryControl.preparation_state !== 'ready') ||
      (recoveryControl.preparation_state === 'ready' &&
        (recoveryControl.source_documents_revision === null || recoveryControl.prepared_at_ms === null))) {
      fail('Delivery recovery state control is invalid.');
    }
    if (recoveryControl.source_documents_revision !== null) safeInteger(recoveryControl.source_documents_revision, 'Delivery recovery source revision');
    if (recoveryControl.prepared_at_ms !== null) safeInteger(recoveryControl.prepared_at_ms, 'Delivery recovery preparation timestamp');
  }
  const recoveryParentColumns = `document.document_path, document.document_kind, document.drop_id, document.document_id,
    json_remove(document.document_json, '$.receiptRecovery') AS document_json,
    document.version, document.create_time, document.update_time`;
  const recoveryJoinedRows = deliveryRecoveryStateReady
    ? queryRemoteCommerceD1(`SELECT recovery.*, ${recoveryParentColumns}
      FROM commerce_documents AS document
      LEFT JOIN commerce_delivery_recovery AS recovery ON recovery.parent_path = document.document_path
      WHERE document.document_kind = 'delivery_order'
      UNION ALL
      SELECT recovery.*, ${recoveryParentColumns}
      FROM commerce_delivery_recovery AS recovery
      LEFT JOIN commerce_documents AS document ON document.document_path = recovery.parent_path
      WHERE document.document_kind IS NOT 'delivery_order'
      ORDER BY parent_path`) : [];
  for (const row of recoveryJoinedRows) {
    if (row.parent_path === null) {
      if (recoveryControl?.storage_mode === 'table') fail(`Delivery recovery state is missing: ${String(row.document_path)}.`);
    } else {
      if (row.document_kind !== 'delivery_order' || row.document_path !== row.parent_path) fail('Delivery recovery state parent is invalid.');
      parseCommerceD1DocumentRow(row);
    }
  }
  const recoveryRows = recoveryJoinedRows.filter((row) => row.parent_path !== null).map(parseDeliveryRecoveryRow);
  const recoveryStates = new Map(recoveryRows.map((record) => [record.parentPath, record]));
  if (recoveryControl?.storage_mode === 'legacy' && recoveryControl.preparation_state === 'ready') {
    if (recoveryControl.source_documents_revision !== authority.documents_revision) fail('Delivery recovery state preparation is stale.');
    const sources = queryRemoteCommerceD1(`SELECT document_path, ${LEGACY_DELIVERY_RECOVERY_JSON_SQL} AS receipt_recovery_json
      FROM commerce_documents WHERE document_kind = 'delivery_order' ORDER BY document_path`);
    if (sources.length !== recoveryRows.length) fail('Delivery recovery state preparation differs from source documents.');
    const recoveryParents = new Map(recoveryJoinedRows.map((row) => [row.document_path, row]));
    for (const source of sources) {
      const actual = recoveryStates.get(String(source.document_path));
      const parent = recoveryParents.get(source.document_path);
      if (!actual || !parent || (source.receipt_recovery_json !== null && typeof source.receipt_recovery_json !== 'string') ||
        !isDeepStrictEqual(actual, planDeliveryRecoveryStateBackfill(parseCommerceD1DocumentRow(parent),
          source.receipt_recovery_json as string | null, actual.generation))) fail('Delivery recovery state preparation differs from source documents.');
    }
  }
  const packStatusControls = packStatusOutboxReady
    ? queryRemoteCommerceD1('SELECT * FROM commerce_pack_status_outbox_control') : [];
  const packStatusControl = packStatusControls[0];
  if (packStatusOutboxReady) {
    if (packStatusControls.length !== 1 || packStatusControl.singleton !== 1 ||
      !['legacy', 'table'].includes(String(packStatusControl.storage_mode)) ||
      !['idle', 'preparing', 'ready'].includes(String(packStatusControl.preparation_state)) ||
      (packStatusControl.storage_mode === 'table' && packStatusControl.preparation_state !== 'ready') ||
      (packStatusControl.preparation_state === 'ready' &&
        (packStatusControl.source_documents_revision === null || packStatusControl.prepared_at_ms === null))) {
      fail('Pack-status outbox control is invalid.');
    }
    if (packStatusControl.source_documents_revision !== null) {
      safeInteger(packStatusControl.source_documents_revision, 'Pack-status outbox source revision');
    }
    if (packStatusControl.prepared_at_ms !== null) {
      safeInteger(packStatusControl.prepared_at_ms, 'Pack-status outbox preparation timestamp');
    }
  }
  const packStatusRows = packStatusOutboxReady
    ? queryRemoteCommerceD1('SELECT * FROM commerce_pack_status_outbox ORDER BY parent_path').map(parsePackStatusOutboxRow)
    : [];
  for (const row of packStatusRows) {
    const parent = parents.get(row.parentPath);
    if (!parent || parent.document_kind !== 'delivery_order' || parent.drop_id !== row.dropId) {
      fail('Pack-status outbox parent identity is invalid.');
    }
  }
  if (packStatusControl?.storage_mode === 'table') {
    const outboxPaths = new Set(packStatusRows.map((row) => row.parentPath));
    for (const document of authoritativeDocuments) {
      const data = JSON.parse(String(document.document_json)) as Record<string, unknown>;
      if (LEGACY_PACK_STATUS_PROJECTION_FIELDS.some((field) => Object.hasOwn(data, field)) &&
        !outboxPaths.has(String(document.document_path))) {
        fail(`Pack-status outbox is missing for source document: ${String(document.document_path)}.`);
      }
    }
  }
  if (packStatusControl?.storage_mode === 'legacy' && packStatusControl.preparation_state === 'ready') {
    const expected = authoritativeDocuments.map(parseCommerceD1DocumentRow)
      .flatMap((document) => planPackStatusOutboxBackfill(document) || [])
      .sort((left, right) => left.parentPath.localeCompare(right.parentPath));
    if (packStatusControl.source_documents_revision !== authority.documents_revision ||
      !isDeepStrictEqual(packStatusRows.slice().sort((left, right) => left.parentPath.localeCompare(right.parentPath)), expected)) {
      fail('Pack-status outbox preparation differs from source documents.');
    }
  }
  const stripeCheckoutJoinedRows = stripeCheckoutStateReady ? queryRemoteCommerceD1(`SELECT checkout.*,
      document.document_kind AS parent_kind, document.version AS parent_version
    FROM commerce_stripe_checkout_state AS checkout
    LEFT JOIN commerce_documents AS document ON document.document_path = checkout.document_path`) : [];
  const stripeCheckoutRows = stripeCheckoutJoinedRows.map(parseStripeCheckoutStateRow);
  const checkoutStates = new Map(stripeCheckoutRows.map((row) => [row.documentPath, row]));
  for (const row of stripeCheckoutJoinedRows) {
    if (row.parent_kind !== 'stripe_checkout' || row.parent_version !== row.document_version) fail('Stripe checkout state parent or version is invalid.');
  }
  if (stripeCheckoutControl?.storage_mode === 'table') {
    const missing = queryRemoteCommerceD1(`SELECT COUNT(*) AS count FROM commerce_documents AS document
      LEFT JOIN commerce_stripe_checkout_state AS checkout ON checkout.document_path = document.document_path
      WHERE document.document_kind = 'stripe_checkout' AND checkout.document_path IS NULL`);
    if (missing.length !== 1 || safeInteger(missing[0].count, 'Missing checkout state count') !== 0) fail('Stripe checkout state differs from source documents.');
  } else if (stripeCheckoutControl?.preparation_state === 'ready') {
    for (const parent of authoritativeDocuments.filter((row) => row.document_kind === 'stripe_checkout')) {
      const actual = checkoutStates.get(String(parent.document_path));
      if (!actual || !isDeepStrictEqual(actual, planStripeCheckoutStateBackfill(parseCommerceD1DocumentRow(parent)))) fail('Stripe checkout state preparation differs from source documents.');
    }
    if (stripeCheckoutControl.storage_mode === 'legacy' && stripeCheckoutControl.source_documents_revision !== authority.documents_revision) fail('Stripe checkout state preparation is stale.');
  }
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
  const stripeStatus = stripeCheckoutControl?.storage_mode === 'table'
    ? '(SELECT status FROM commerce_stripe_checkout_state WHERE document_path = document.document_path)' : 'document.status';
  const invalidStripeDue = queryRemoteCommerceD1(`SELECT COUNT(*) AS count FROM (
    SELECT outbox.parent_path
    FROM commerce_notification_outbox AS outbox
    JOIN commerce_documents AS document ON document.document_path = outbox.parent_path
    LEFT JOIN commerce_notification_outbox_stripe_due AS due
      ON due.parent_path = outbox.parent_path AND due.family = outbox.family
    WHERE outbox.family = 'stripe_terminal' AND outbox.state = 'pending'
      AND ((outbox.outcome = 'fulfilled' AND ${stripeStatus} = 'fulfilled') OR
        (outbox.outcome = 'manual_review' AND ${stripeStatus} = 'fulfillment_failed' AND document.manual_refund_review_required = 1))
      AND (due.parent_path IS NULL OR due.next_attempt_at_ms IS NOT outbox.next_attempt_at_ms)
    UNION ALL
    SELECT due.parent_path FROM commerce_notification_outbox_stripe_due AS due
    WHERE NOT EXISTS (
      SELECT 1 FROM commerce_notification_outbox AS outbox
      JOIN commerce_documents AS document ON document.document_path = outbox.parent_path
      WHERE outbox.parent_path = due.parent_path AND outbox.family = due.family
        AND outbox.family = 'stripe_terminal' AND outbox.state = 'pending'
        AND outbox.next_attempt_at_ms = due.next_attempt_at_ms
        AND ((outbox.outcome = 'fulfilled' AND ${stripeStatus} = 'fulfilled') OR
          (outbox.outcome = 'manual_review' AND ${stripeStatus} = 'fulfillment_failed' AND document.manual_refund_review_required = 1))
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
  if (options.forDeployment && stripeCheckoutControl?.storage_mode !== 'table' && !(
    authority.authority_state === 'paused' && authority.paused_at_ms !== null &&
    stripeCheckoutControl?.preparation_state === 'ready' && stripeCheckoutControl.source_documents_revision === authority.documents_revision
  )) fail('API deployment requires activated Stripe checkout state or fully paused, verified preparation. Follow scripts/docs/stripe_checkout_state_cutover.md.');
  if (options.forDeployment && packStatusControl?.storage_mode !== 'table' && !(
    authority.authority_state === 'paused' && authority.paused_at_ms !== null &&
    packStatusControl?.preparation_state === 'ready' && packStatusControl.source_documents_revision === authority.documents_revision
  )) fail('API deployment requires activated pack-status outbox storage or fully paused, verified preparation. Follow scripts/docs/pack_status_outbox_cutover.md.');
  if (options.forDeployment && recoveryControl?.storage_mode !== 'table' && !(
    authority.authority_state === 'paused' && authority.paused_at_ms !== null &&
    recoveryControl?.preparation_state === 'ready' && recoveryControl.source_documents_revision === authority.documents_revision
  )) fail('API deployment requires activated delivery recovery state or fully paused, verified preparation. Follow scripts/docs/delivery_recovery_state_cutover.md.');
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
    ...(stripeCheckoutStateReady ? {
      stripeCheckoutStateMode: stripeCheckoutControl.storage_mode,
      stripeCheckoutStatePreparation: stripeCheckoutControl.preparation_state,
      stripeCheckoutStateRows: stripeCheckoutRows.length,
    } : {}),
    ...(packStatusOutboxReady ? {
      packStatusOutboxMode: packStatusControl.storage_mode,
      packStatusOutboxPreparation: packStatusControl.preparation_state,
      packStatusOutboxRows: packStatusRows.length,
    } : {}),
    ...(deliveryRecoveryStateReady ? {
      deliveryRecoveryStateMode: recoveryControl.storage_mode,
      deliveryRecoveryStatePreparation: recoveryControl.preparation_state,
      deliveryRecoveryStateRows: recoveryRows.length,
    } : {}),
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
