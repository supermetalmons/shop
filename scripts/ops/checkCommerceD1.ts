import { pathToFileURL } from 'node:url';
import { parseDeliveryRecoveryRow } from '../../shared/deliveryRecoveryState.ts';
import { parseNotificationOutboxRow } from '../../shared/notificationOutbox.ts';
import { parsePackStatusOutboxRow } from '../../shared/packStatusOutbox.ts';
import { LEGACY_PACK_STATUS_PROJECTION_FIELDS } from '../shared/packStatusProjectionFields.ts';
import { parseStripeCheckoutStateRow } from '../../shared/stripeCheckoutState.ts';
import { assertCanonicalCommerceIdentity } from '../shared/commerceIdentityValidation.ts';
import {
  commerceD1DocumentIdentity,
  parseCommerceD1DocumentRow,
  queryRemoteCommerceD1 as defaultQueryRemoteCommerceD1,
  queryRemoteCommerceD1Batch,
  safeInteger,
} from '../shared/commerceD1Maintenance.ts';
import { commerceD1AuditRows, sequentialD1QueryBatch } from '../shared/commerceD1Audit.ts';
import type { D1MaintenanceQueryBatch } from '../shared/d1MaintenanceRunner.ts';
import { checkCurrentCommerceSchema } from '../shared/currentCommerceSchema.ts';
import { inventoryDropConfigs, validateInventoryOwnership, validateManifestInventory } from '../shared/dudeInventoryMaintenance.ts';
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

type QueryPlan = { sql: string; checks: Array<(rows: Record<string, unknown>[]) => void> };

function requirePlan(
  plan: QueryPlan,
  predicate: (rows: Record<string, unknown>[]) => boolean,
  message: string,
): void {
  plan.checks.push((rows) => { if (!predicate(rows)) fail(message); });
}

function requireIndex(plan: QueryPlan, indexName: string): void {
  requirePlan(plan, (rows) => rows.some((row) => String(row.detail || '').includes(indexName)),
    `Commerce D1 query plan does not use ${indexName}.`);
}

function requireSearchIndex(plan: QueryPlan, indexName: string): void {
  requirePlan(plan, (rows) => rows.some((row) => {
    const detail = String(row.detail || '');
    return detail.includes('SEARCH ') && detail.includes(indexName);
  }), `Commerce D1 query plan does not search ${indexName}.`);
}

function requireIdentitySearchIndex(plan: QueryPlan, indexName: string, identityConstraint: string): void {
  requirePlan(plan, (rows) => rows.some((row) => {
    const detail = normalizedSql(row.detail);
    return detail.startsWith('SEARCH ') && detail.includes(`${indexName} (${identityConstraint})`);
  }), `Commerce D1 query plan does not search ${indexName} by Stripe identity.`);
}

function requireNoTemporaryBTree(plan: QueryPlan, operation: string): void {
  requirePlan(plan, (rows) => !rows.some((row) => String(row.detail || '').includes('USE TEMP B-TREE')),
    `Commerce D1 ${operation} query plan uses a temporary B-tree.`);
}

function readCommerceD1Checks(queryBatch: D1MaintenanceQueryBatch) {
  const stripeStatus = '(SELECT status FROM commerce_stripe_checkout_state WHERE document_path = document.document_path)';
  return queryBatch({
    authorityRows: 'SELECT * FROM commerce_authority_control',
    stripeCheckoutControls: 'SELECT * FROM commerce_stripe_checkout_state_control',
    leaseRows: 'SELECT lease_token, acquired_at_ms, expires_at_ms FROM commerce_authority_control_lease',
    identityState: `SELECT COUNT(*) AS root_uid_count
    FROM commerce_documents WHERE json_type(document_json, '$.uid') IS NOT NULL`,
    commitGuardState: 'SELECT COUNT(*) AS count FROM commerce_commit_guards',
    deliveryOwnerRevisionState: `SELECT
      COUNT(*) AS count,
      COALESCE(SUM(revision < 1), 0) AS invalid_count,
      COALESCE(SUM(revision > (
        SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1
      )), 0) AS future_count
    FROM commerce_delivery_owner_revisions`,
    documentPathRevisionState: `SELECT
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
        WHERE path_revision.document_path IS NULL) AS missing_live_count`,
    legacyRecovery: `SELECT COUNT(*) AS count FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND json_type(document_json, '$.receiptRecovery') IS NOT NULL`,
    inventory: `SELECT inventory.*,
      (SELECT COUNT(*) FROM commerce_available_dudes WHERE drop_id = inventory.drop_id) AS available_count,
      (SELECT COUNT(*) FROM commerce_available_dudes
        WHERE drop_id = inventory.drop_id AND
          (dude_id > inventory.max_dude_id OR pool_position >= inventory.max_dude_id)) AS invalid_available_count,
      (SELECT COUNT(*) FROM commerce_available_dudes AS available
        JOIN commerce_documents AS assignment
          ON assignment.document_path = 'drops/' || available.drop_id || '/dudeAssignments/' || available.dude_id
        WHERE available.drop_id = inventory.drop_id) AS assigned_overlap_count,
      initialization.generation AS initialization_generation,
      initialization.manifest_sha256, initialization.eligible_card_ids_json, initialization.completed_at_ms,
      CASE WHEN initialization.drop_id IS NOT NULL THEN (
        SELECT COALESCE(json_group_array(json_object('dudeId', dude_id, 'poolPosition', pool_position)), '[]')
        FROM commerce_available_dudes WHERE drop_id = inventory.drop_id
      ) END AS manifest_available_json,
      CASE WHEN initialization.drop_id IS NOT NULL THEN (
        SELECT COALESCE(json_group_array(json_object(
          'document_path', document_path, 'document_kind', document_kind, 'drop_id', drop_id, 'document_id', document_id,
          'document_json', document_json, 'version', version, 'create_time', create_time, 'update_time', update_time
        )), '[]') FROM commerce_documents
        WHERE drop_id = inventory.drop_id AND document_kind IN ('dude_pool', 'dude_assignment', 'box_assignment')
      ) END AS manifest_documents_json
    FROM commerce_inventory_drops AS inventory
    LEFT JOIN commerce_inventory_initializations AS initialization ON initialization.drop_id = inventory.drop_id
    ORDER BY inventory.drop_id`,
    invalidProcessedTimeRows: `SELECT COUNT(*) AS count
    FROM commerce_documents
    WHERE
      (processed_at_seconds IS NULL) <> (processed_at_nanos IS NULL) OR
      processed_at_seconds < 0 OR
      processed_at_nanos < 0 OR
      processed_at_nanos > 999999999`,
    notificationControls: 'SELECT * FROM commerce_notification_outbox_control',
    recoveryControls: 'SELECT * FROM commerce_delivery_recovery_control',
    packStatusControls: 'SELECT * FROM commerce_pack_status_outbox_control',
    missingRecovery: `SELECT document.document_path
    FROM commerce_documents AS document
    LEFT JOIN commerce_delivery_recovery AS recovery ON recovery.parent_path = document.document_path
    WHERE document.document_kind = 'delivery_order' AND recovery.parent_path IS NULL LIMIT 1`,
    missing: `SELECT COUNT(*) AS count FROM commerce_documents AS document
      LEFT JOIN commerce_stripe_checkout_state AS checkout ON checkout.document_path = document.document_path
      WHERE document.document_kind = 'stripe_checkout' AND checkout.document_path IS NULL`,
    invalidNotificationOwners: `SELECT COUNT(*) AS count FROM (
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
  )`,
    invalidStripeDue: `SELECT COUNT(*) AS count FROM (
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
  )`,
    deliveryOwnerSmoke: renderCommerceQuerySql(deliveryOrderOwnersQuery({ limit: 1 })),
  });
}

export type CheckCommerceD1Query = typeof defaultQueryRemoteCommerceD1;

export function checkCommerceD1(
  queryRemoteCommerceD1: CheckCommerceD1Query = defaultQueryRemoteCommerceD1,
  options: { forDeployment?: boolean; queryBatch?: D1MaintenanceQueryBatch } = {},
): Record<string, unknown> {
  const queryBatch = options.queryBatch ?? (queryRemoteCommerceD1 === defaultQueryRemoteCommerceD1
    ? queryRemoteCommerceD1Batch : sequentialD1QueryBatch(queryRemoteCommerceD1));
  checkCurrentCommerceSchema(queryRemoteCommerceD1, queryBatch);
  const {
    authorityRows, stripeCheckoutControls, leaseRows, identityState, commitGuardState, deliveryOwnerRevisionState, documentPathRevisionState,
    legacyRecovery, inventory, invalidProcessedTimeRows, notificationControls, recoveryControls, packStatusControls,
    missingRecovery, missing, invalidNotificationOwners, invalidStripeDue,
  } = readCommerceD1Checks(queryBatch);

  for (const row of commerceD1AuditRows(queryRemoteCommerceD1, {
    table: 'stripe_order_disputes', keys: ['livemode', 'session_id', 'dispute_id'],
  })) {
    if ((row.livemode !== 0 && row.livemode !== 1) || !isStripeChargebackSessionId(row.session_id) ||
      row.session_id.startsWith('cs_live_') !== (row.livemode === 1) || !isStripeDisputeId(row.dispute_id) ||
      !isCommerceDocumentSegment(row.drop_id) || typeof row.charge_id !== 'string' ||
      row.charge_id.length > 256 || !/^(?:ch|py)_[A-Za-z0-9_]+$/.test(row.charge_id) ||
      typeof row.payment_intent_id !== 'string' || row.payment_intent_id.length > 256 ||
      !/^pi_[A-Za-z0-9_]+$/.test(row.payment_intent_id)) fail('Stripe chargeback history identity is invalid.');
    safeInteger(row.dispute_created_at, 'Stripe dispute creation time');
    safeInteger(row.recorded_at_ms, 'Stripe chargeback recording time');
  }
  if (authorityRows.length !== 1) fail('Commerce D1 authority singleton is invalid.');
  const authority = authorityRows[0];
  const stripeCheckoutControl = stripeCheckoutControls[0];
  if (stripeCheckoutControls.length !== 1 || stripeCheckoutControl.storage_mode !== 'table' ||
    stripeCheckoutControl.preparation_state !== 'ready') fail('Stripe checkout state control is invalid.');
  if (!['paused', 'd1'].includes(String(authority.authority_state))) {
    fail('Commerce D1 authority state is invalid.');
  }
  if (authority.dude_inventory_mode !== 'legacy' && authority.dude_inventory_mode !== 'rows') {
    fail('Commerce D1 inventory mode is invalid.');
  }
  if (authority.dude_inventory_mode !== 'rows') {
    fail('Commerce requires initialized figure inventory (rows mode). See scripts/docs/commerce_operations.md.');
  }
  safeInteger(authority.revision, 'Commerce authority revision');
  safeInteger(authority.documents_revision, 'Commerce document revision');

  if (leaseRows.length > 1 || leaseRows.some((row) => {
    const acquiredAtMs = safeInteger(row.acquired_at_ms, 'Commerce authority lease acquisition');
    const expiresAtMs = safeInteger(row.expires_at_ms, 'Commerce authority lease expiry');
    return !UUID_V4_PATTERN.test(String(row.lease_token || '')) || expiresAtMs <= acquiredAtMs;
  })) fail('Commerce D1 authority coordination lease is invalid.');
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

  {
    if (legacyRecovery.length !== 1 || safeInteger(legacyRecovery[0].count, 'Legacy delivery recovery metadata count') !== 0) {
      fail('Commerce D1 delivery recovery metadata is not canonical.');
    }
  }

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
    if (config.inventoryManifest) {
      if (row.initialization_generation !== row.generation || row.manifest_sha256 !== config.inventoryManifest.sha256 ||
        row.eligible_card_ids_json !== JSON.stringify(config.inventoryManifest.cardIds) || row.completed_at_ms == null ||
        typeof row.manifest_available_json !== 'string' || typeof row.manifest_documents_json !== 'string') {
        fail(`Commerce D1 committed inventory manifest is invalid for ${config.dropId}.`);
      }
      safeInteger(row.completed_at_ms, 'Commerce inventory completion timestamp');
      const available = JSON.parse(row.manifest_available_json);
      const documents = JSON.parse(row.manifest_documents_json).map(parseCommerceD1DocumentRow);
      const ownership = validateInventoryOwnership(config, documents);
      validateManifestInventory(config, available, ownership.assignedIds);
    } else if (row.manifest_sha256 != null) {
      fail(`Commerce D1 has an unconfigured inventory manifest for ${config.dropId}.`);
    }
    availableDudes += safeInteger(row.available_count, 'Commerce available inventory count');
    if (row.ready === 1) readyInventoryDrops.add(config.dropId);
  }
  if (authority.dude_inventory_mode === 'rows' && (
    [...inventoryConfigs.keys()].some((dropId) => !readyInventoryDrops.has(dropId))
  )) fail('Commerce D1 inventory initialization is incomplete.');

  let authoritativeDocuments = 0;
  for (const row of commerceD1AuditRows(queryRemoteCommerceD1, {
    table: 'commerce_documents', alias: 'document', keys: ['document_path'],
    columns: `document.document_path, document.document_kind, document.drop_id, document.document_id,
      document.document_json, document.version, document.create_time, document.update_time,
      outbox.parent_path AS pack_status_parent_path`,
    joins: 'LEFT JOIN commerce_pack_status_outbox AS outbox ON outbox.parent_path = document.document_path',
  })) {
    authoritativeDocuments += 1;
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
    if (['dude_pool', 'dude_assignment', 'box_assignment'].includes(String(row.document_kind)) &&
      !readyInventoryDrops.has(String(row.drop_id))) fail('Commerce D1 inventory initialization is incomplete.');
    if (LEGACY_PACK_STATUS_PROJECTION_FIELDS.some((field) => Object.hasOwn(document, field)) &&
      row.pack_status_parent_path !== row.document_path) {
      fail(`Pack-status outbox is missing for source document: ${String(row.document_path)}.`);
    }
  }

  const plans: QueryPlan[] = [];
  const rawPlan = (sql: string): QueryPlan => {
    const plan = { sql, checks: [] };
    plans.push(plan);
    return plan;
  };
  {
    requireSearchIndex(rawPlan(`EXPLAIN QUERY PLAN SELECT document_path FROM commerce_documents INDEXED BY commerce_receipt_claim_workflow_operation
      WHERE document_kind = 'claim_code' AND json_extract(document_json, '$.receiptClaimWorkflowV1.operationId') = 'src-v1-check'`),
    'commerce_receipt_claim_workflow_operation');
    requireSearchIndex(rawPlan(`EXPLAIN QUERY PLAN SELECT document_path FROM commerce_documents INDEXED BY commerce_receipt_claim_workflow_due
      WHERE document_kind = 'claim_code' AND json_extract(document_json, '$.receiptClaimWorkflowV1.phase') = 'pending'
        AND json_extract(document_json, '$.receiptClaimWorkflowV1.nextAttemptAtMs') <= 0
      ORDER BY json_extract(document_json, '$.receiptClaimWorkflowV1.nextAttemptAtMs'), document_path LIMIT 20`),
    'commerce_receipt_claim_workflow_due');
  }

  const queryPlan = (query: CommerceSqlQuery) =>
    rawPlan(`EXPLAIN QUERY PLAN ${renderCommerceQuerySql(query)}`);

  const initialDeliveryOwnerPlan = queryPlan(deliveryOrderOwnersQuery({ limit: 501 }));
  requireSearchIndex(initialDeliveryOwnerPlan, 'commerce_documents_delivery_owner_path');
  requireNoTemporaryBTree(initialDeliveryOwnerPlan, 'initial delivery-owner');
  const keysetDeliveryOwnerPlan = queryPlan(deliveryOrderOwnersQuery({
    limit: 501,
    startAfterOwner: '11111111111111111111111111111111',
  }));
  requireSearchIndex(keysetDeliveryOwnerPlan, 'commerce_documents_delivery_owner_path');
  requireNoTemporaryBTree(keysetDeliveryOwnerPlan, 'keyset delivery-owner');
  {
    const deliveryRecoveryPlan = queryPlan(deliveryRecoveryStateQuery('11111111111111111111111111111111', 1, 1));
    requireSearchIndex(deliveryRecoveryPlan, 'commerce_documents_delivery_owner_status');
    requirePlan(deliveryRecoveryPlan, (rows) => rows.some((row) => normalizedSql(row.detail).includes(
      'commerce_documents_delivery_owner_status (document_kind=? AND owner=? AND status=?)',
    )), 'Commerce D1 delivery-recovery summary does not use the full owner-status prefix.');
    requireNoTemporaryBTree(deliveryRecoveryPlan, 'delivery-recovery summary');
  }
  {
    const owner = '11111111111111111111111111111111';
    for (const startAfter of [undefined, {
      version: 1 as const, owner, sortAtMs: 1, documentPath: 'drops/drop/deliveryOrders/1',
    }]) {
      const plan = queryPlan(shipmentHistoryPageQuery({ owner, limit: 51, startAfter }));
      requireSearchIndex(plan, 'commerce_delivery_orders_shipment_cursor');
      requireNoTemporaryBTree(plan, 'shipment-history');
      if (startAfter) requirePlan(plan, (rows) => rows.some((row) => normalizedSql(row.detail).includes(
        '(shipment_sort_at_ms,document_path)<(?,?)',
      )), 'Commerce D1 shipment-history query plan does not seek the full cursor.');
    }
    for (const selectors of [
      { stripeSessionIds: ['cs_cursor'] },
      { documentPaths: ['drops/drop/deliveryOrders/1'] },
      { stripeSessionIds: ['cs_cursor'], documentPaths: ['drops/drop/deliveryOrders/1'] },
    ]) {
      const plan = queryPlan(shipmentPresenceQuery({ owner, ...selectors }));
      if (selectors.stripeSessionIds) requirePlan(plan, (rows) => rows.some((row) => normalizedSql(row.detail).includes(
        'SEARCH commerce_documents USING INDEX commerce_delivery_orders_shipment_session (owner=? AND <expr>=?)',
      )), 'Commerce D1 shipment presence query plan does not search by owner and Stripe session.');
      if (selectors.documentPaths) requireSearchIndex(plan, 'sqlite_autoindex_commerce_documents_1');
      requireNoTemporaryBTree(plan, 'shipment presence');
    }
  }
  requireIndex(
    rawPlan(`EXPLAIN QUERY PLAN SELECT document_path
      FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND fulfillment_status = 'pending'`),
    'commerce_documents_fulfillment_status',
  );
  {
    for (const startAfter of [undefined, {
      version: 1 as const, dropId: 'drop', sortAtMs: 1, sessionId: 'cs_cursor',
      documentPath: 'drops/drop/stripeCheckouts/cs_cursor',
    }]) {
      const plan = queryPlan(manualReviewCheckoutsQuery({ dropId: 'drop', limit: 26, startAfter }));
      requireSearchIndex(plan, 'commerce_stripe_checkouts_manual_review_cursor');
      requireNoTemporaryBTree(plan, 'manual-review');
      if (startAfter) requirePlan(plan, (rows) => rows.some((row) => normalizedSql(row.detail).includes(
        '(manual_review_sort_at_ms,manual_review_session_id,document_path)<(?,?,?)',
      )), 'Commerce D1 manual-review query plan does not seek the full cursor.');
    }
  }
  for (const startAfter of [undefined, {
    processedAt: { seconds: 1, nanos: 1 },
    documentPath: 'drops/drop/deliveryOrders/1',
  }]) {
    const plan = queryPlan(fulfillmentOrdersQuery({ dropId: 'drop', limit: 1001, startAfter }));
    requireSearchIndex(plan, 'commerce_documents_drop_processed_cursor');
    requireNoTemporaryBTree(plan, 'fulfillment');
    if (startAfter) {
      for (const [constraint, error] of [
        ['(document_kind=? AND drop_id=? AND status=? AND (processed_at_seconds,processed_at_nanos,document_path)<(?,?,?))',
          'Commerce D1 fulfillment query plan does not seek the full cursor.'],
        ['(document_kind=? AND drop_id=? AND status=? AND processed_at_seconds=?)',
          'Commerce D1 fulfillment query plan does not search the null-timestamp tail.'],
      ]) requirePlan(plan, (rows) => rows.some((row) => {
        const detail = normalizedSql(row.detail);
        return detail.startsWith('SEARCH commerce_documents USING INDEX commerce_documents_drop_processed_cursor ') &&
          detail.includes(constraint);
      }), error);
    }
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
  {
    const plan = queryPlan(packStatusOutboxDueQuery({ dropId: 'drop', dueAtMs: 1, limit: 4 }));
    requireSearchIndex(plan, 'commerce_pack_status_outbox_due');
    requirePlan(plan, (rows) => rows.some((row) => normalizedSql(row.detail).includes('(drop_id=? AND next_attempt_at_ms<?)')),
      'Commerce D1 pack-status outbox query plan does not seek the full drop-due prefix.');
    requireNoTemporaryBTree(plan, 'pack-status outbox');
  }
  requireIndex(
    queryPlan(staleStripeFulfillmentsQuery(1)),
    'commerce_stripe_checkout_state_reconciliation_due',
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

  for (const family of ['ready', 'stripe_terminal', 'shipped'] as const) {
    const plan = queryPlan(notificationOutboxDueQuery({ family, dueAtMs: 1, limit: 8 }));
    requireSearchIndex(plan, 'commerce_notification_outbox_family_due');
    requireNoTemporaryBTree(plan, 'notification outbox due');
  }
  const planResults = queryBatch(Object.fromEntries(plans.map((plan, index) => [String(index), plan.sql])));
  plans.forEach((plan, index) => plan.checks.forEach((check) => check(planResults[String(index)])));

  if (
    invalidProcessedTimeRows.length !== 1 ||
    safeInteger(invalidProcessedTimeRows[0].count, 'Commerce processed-time invalid count') !== 0
  ) fail('Commerce D1 processed-time projections are invalid.');

  const notificationControl = notificationControls[0];
  if (notificationControls.length !== 1 || notificationControl.storage_mode !== 'table' ||
    notificationControl.preparation_state !== 'ready') fail('Notification outbox control is invalid.');
  let notificationRows = 0;
  for (const joined of commerceD1AuditRows(queryRemoteCommerceD1, {
    table: 'commerce_notification_outbox', alias: 'outbox', keys: ['parent_path', 'family'],
    columns: `outbox.*, document.document_path AS parent_document_path,
      document.document_kind AS parent_kind, document.drop_id AS parent_drop_id`,
    joins: 'LEFT JOIN commerce_documents AS document ON document.document_path = outbox.parent_path',
  })) {
    const row = parseNotificationOutboxRow(joined);
    if (joined.parent_document_path !== row.parentPath || joined.parent_drop_id !== row.dropId || joined.parent_kind !==
      (row.family === 'stripe_terminal' ? 'stripe_checkout' : 'delivery_order')) fail('Notification outbox parent identity is invalid.');
    notificationRows += 1;
  }
  const recoveryControl = recoveryControls[0];
  if (recoveryControls.length !== 1 || recoveryControl.singleton !== 1 ||
    recoveryControl.storage_mode !== 'table' || recoveryControl.preparation_state !== 'ready' ||
    recoveryControl.source_documents_revision === null || recoveryControl.prepared_at_ms === null) {
    fail('Delivery recovery state control is invalid.');
  }
  safeInteger(recoveryControl.source_documents_revision, 'Delivery recovery source revision');
  safeInteger(recoveryControl.prepared_at_ms, 'Delivery recovery preparation timestamp');
  const recoveryParentColumns = `document.document_path, document.document_kind, document.drop_id, document.document_id,
    json_remove(document.document_json, '$.receiptRecovery') AS document_json,
    document.version, document.create_time, document.update_time`;
  if (missingRecovery.length > 0) fail(`Delivery recovery state is missing: ${String(missingRecovery[0].document_path)}.`);
  let recoveryRows = 0;
  for (const row of commerceD1AuditRows(queryRemoteCommerceD1, {
    table: 'commerce_delivery_recovery', alias: 'recovery', keys: ['parent_path'],
    columns: `recovery.*, ${recoveryParentColumns}`,
    joins: 'LEFT JOIN commerce_documents AS document ON document.document_path = recovery.parent_path',
  })) {
    if (row.parent_path === null) fail(`Delivery recovery state is missing: ${String(row.document_path)}.`);
    if (row.document_kind !== 'delivery_order' || row.document_path !== row.parent_path) fail('Delivery recovery state parent is invalid.');
    parseCommerceD1DocumentRow(row);
    parseDeliveryRecoveryRow(row);
    recoveryRows += 1;
  }

  const packStatusControl = packStatusControls[0];
  if (packStatusControls.length !== 1 || packStatusControl.singleton !== 1 ||
    packStatusControl.storage_mode !== 'table' || packStatusControl.preparation_state !== 'ready' ||
    packStatusControl.source_documents_revision === null || packStatusControl.prepared_at_ms === null) {
    fail('Pack-status outbox control is invalid.');
  }
  safeInteger(packStatusControl.source_documents_revision, 'Pack-status outbox source revision');
  safeInteger(packStatusControl.prepared_at_ms, 'Pack-status outbox preparation timestamp');
  let packStatusRows = 0;
  for (const joined of commerceD1AuditRows(queryRemoteCommerceD1, {
    table: 'commerce_pack_status_outbox', alias: 'outbox', keys: ['parent_path'],
    columns: `outbox.*, document.document_path AS parent_document_path,
      document.document_kind AS parent_kind, document.drop_id AS parent_drop_id`,
    joins: 'LEFT JOIN commerce_documents AS document ON document.document_path = outbox.parent_path',
  })) {
    const row = parsePackStatusOutboxRow(joined);
    if (joined.parent_document_path !== row.parentPath || joined.parent_kind !== 'delivery_order' || joined.parent_drop_id !== row.dropId) {
      fail('Pack-status outbox parent identity is invalid.');
    }
    packStatusRows += 1;
  }

  let stripeCheckoutRows = 0;
  for (const row of commerceD1AuditRows(queryRemoteCommerceD1, {
    table: 'commerce_stripe_checkout_state', alias: 'checkout', keys: ['document_path'],
    columns: `checkout.*, document.document_kind AS parent_kind, document.version AS parent_version`,
    joins: 'LEFT JOIN commerce_documents AS document ON document.document_path = checkout.document_path',
  })) {
    parseStripeCheckoutStateRow(row);
    if (row.parent_kind !== 'stripe_checkout' || row.parent_version !== row.document_version) fail('Stripe checkout state parent or version is invalid.');
    stripeCheckoutRows += 1;
  }
  {
    if (missing.length !== 1 || safeInteger(missing[0].count, 'Missing checkout state count') !== 0) fail('Stripe checkout state differs from source documents.');
  }
  if (invalidNotificationOwners.length !== 1 ||
    safeInteger(invalidNotificationOwners[0].count, 'Notification outbox owner invalid count') !== 0) {
    fail('Notification outbox pending-owner lookup is inconsistent.');
  }
  if (invalidStripeDue.length !== 1 || safeInteger(invalidStripeDue[0].count, 'Stripe notification due invalid count') !== 0) {
    fail('Notification outbox Stripe due lookup is inconsistent.');
  }

  const { notificationFailures, documentKindCounts } = queryBatch({
    notificationFailures: `SELECT family, last_error_code, COUNT(*) AS count
    FROM commerce_notification_outbox WHERE state = 'failed' GROUP BY family, last_error_code ORDER BY family, last_error_code`,
    documentKindCounts: `SELECT document_kind, COUNT(*) AS count
    FROM commerce_documents GROUP BY document_kind ORDER BY document_kind`,
  });
  const kindCounts = Object.fromEntries(documentKindCounts.map((row) => [
      String(row.document_kind),
      safeInteger(row.count, 'Commerce document-kind count'),
    ]));
  return {
    authorityState: authority.authority_state,
    authorityRevision: safeInteger(authority.revision, 'Commerce authority revision'),
    inventoryMode: authority.dude_inventory_mode,
    notificationOutboxMode: notificationControl.storage_mode,
    notificationOutboxPreparation: notificationControl.preparation_state,
    notificationOutboxGroups: notificationRows,
    notificationOutboxFailures: notificationFailures,
    stripeCheckoutStateMode: stripeCheckoutControl.storage_mode,
    stripeCheckoutStatePreparation: stripeCheckoutControl.preparation_state,
    stripeCheckoutStateRows: stripeCheckoutRows,
    packStatusOutboxMode: packStatusControl.storage_mode,
    packStatusOutboxPreparation: packStatusControl.preparation_state,
    packStatusOutboxRows: packStatusRows,
    deliveryRecoveryStateMode: recoveryControl.storage_mode,
    deliveryRecoveryStatePreparation: recoveryControl.preparation_state,
    deliveryRecoveryStateRows: recoveryRows,
    inventoryDrops: inventory.length,
    availableDudes,
    authoritativeDocuments,
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
