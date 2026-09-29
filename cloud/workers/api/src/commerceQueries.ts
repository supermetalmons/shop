import { STRIPE_CHECKOUT_STATUS } from '../../../../shared/stripeCheckoutSession.js';
import { STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR } from '../../../../shared/stripeCheckoutFulfillmentJob.js';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.js';
import type { CommerceTimestamp } from './commerceRepositoryTypes.js';
import type { NotificationOutboxFamily } from '../../../../shared/notificationOutbox.js';
import type { FulfillmentManualReviewCursor } from '../../../../shared/contracts.js';
import type { ShipmentHistoryCursor } from '../../../../shared/shipmentHistory.js';
import { stripeCheckoutStateSelectColumns } from './stripeCheckoutStateStore.js';
import { DELIVERY_RECOVERY_CURSOR_MAX_PATH_LENGTH } from '../../../../shared/deliveryRecoveryPagination.js';

export type CommerceSqlQuery = {
  bindings: Array<string | number>;
  sql: string;
};

export type FulfillmentOrdersQueryArgs = Readonly<{
  dropId: string;
  limit: number;
  startAfter?: Readonly<{
    processedAt: CommerceTimestamp;
    documentPath: string;
  }>;
}>;

export type ManualReviewCheckoutsQueryArgs = Readonly<{
  dropId: string;
  limit: number;
  startAfter?: FulfillmentManualReviewCursor;
}>;

const DOCUMENT_COLUMN_NAMES = [
  'document_path',
  'document_kind',
  'drop_id',
  'document_id',
  'document_json',
  'version',
  'create_time',
  'update_time',
  'processed_at_seconds',
  'processed_at_nanos',
] as const;

const DOCUMENT_COLUMNS = DOCUMENT_COLUMN_NAMES.join(', ');
export const COMMERCE_DOCUMENT_COLUMNS = `${DOCUMENT_COLUMNS}, ${stripeCheckoutStateSelectColumns()}`;
const SHIPMENT_FIELDS = [
  'source', 'dropId', 'deliveryId', 'status', 'items', 'stripeCheckoutSessionId',
  'createdAt', 'processingAt', 'processedAt', 'fulfillmentStatus',
  'fulfillmentTrackingCode', 'fulfillmentUpdatedAt',
] as const;
const SHIPMENT_COLUMNS = DOCUMENT_COLUMN_NAMES.map((name) => name === 'document_json'
  ? `json_object(${SHIPMENT_FIELDS.map((field) => `'${field}', document_json -> '$.${field}'`).join(', ')}) AS document_json`
  : name).join(', ');
const SHIPMENT_PREDICATE = `document_kind = 'delivery_order'
  AND status IN ('processing', 'ready_to_ship') AND source IS NOT 'admin_irl_redeem'`;
export const NOTIFICATION_OUTBOX_COLUMNS = 'parent_path, family, drop_id, generation, outcome, state, entries_json, revision, attempt_count, next_attempt_at_ms, claim_id, claim_expires_at_ms, retry_until_ms, created_at_ms, updated_at_ms, last_error_code';
const NOTIFICATION_OUTBOX_ACTIVE_SQL = `EXISTS (
  SELECT 1 FROM commerce_authority_control AS authority
  CROSS JOIN commerce_notification_outbox_control AS control
  WHERE authority.singleton = 1 AND authority.authority_state = 'd1'
    AND control.singleton = 1 AND control.storage_mode = 'table'
)`;

export function notificationOutboxDueQuery(args: { family?: NotificationOutboxFamily; dueAtMs: number; limit: number }): CommerceSqlQuery {
  return {
    sql: `SELECT ${NOTIFICATION_OUTBOX_COLUMNS.split(', ').map((name) => `outbox.${name}`).join(', ')}
      FROM commerce_notification_outbox AS outbox
        INDEXED BY ${args.family ? 'commerce_notification_outbox_family_due' : 'commerce_notification_outbox_due'}
      WHERE outbox.state = 'pending' AND outbox.next_attempt_at_ms <= ?${args.family ? ' AND outbox.family = ?' : ''}
      ORDER BY outbox.next_attempt_at_ms, outbox.parent_path, outbox.family
      LIMIT CASE WHEN ${NOTIFICATION_OUTBOX_ACTIVE_SQL} THEN ? ELSE 0 END`,
    bindings: [args.dueAtMs, ...(args.family ? [args.family] : []), args.limit],
  };
}

function qualifiedDocumentColumns(alias: string, checkoutState = false): string {
  const columns = DOCUMENT_COLUMN_NAMES.map((name) => `${alias}.${name}`).join(', ');
  return checkoutState ? `${columns}, ${stripeCheckoutStateSelectColumns(alias)}` : columns;
}

export function stripeChargebackLinkedSessionsQuery(paymentIntentId: string): CommerceSqlQuery {
  return {
    sql: `SELECT DISTINCT
      CASE WHEN document_kind = 'stripe_checkout' THEN document_id
        ELSE json_extract(document_json, '$.stripeCheckoutSessionId') END AS session_id
      FROM commerce_documents
      WHERE document_kind IN ('stripe_checkout', 'delivery_order')
        AND (document_kind = 'stripe_checkout' OR (document_kind = 'delivery_order' AND source = ?))
        AND json_extract(document_json, '$.stripePaymentIntentId') = ?`,
    bindings: [STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE, paymentIntentId],
  };
}

export function stripeChargebackMatchedDocumentsQuery(sessionId: string): CommerceSqlQuery {
  return {
    sql: `SELECT document_path, document_kind, document_id, drop_id, document_json
      FROM commerce_documents
      WHERE (document_kind = 'stripe_checkout' AND document_id = ?)
        OR (document_kind = 'delivery_order' AND source = ?
          AND json_extract(document_json, '$.stripeCheckoutSessionId') = ?)`,
    bindings: [sessionId, STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE, sessionId],
  };
}

export function shipmentHistoryPageQuery(args: {
  owner: string;
  limit: number;
  startAfter?: ShipmentHistoryCursor;
}): CommerceSqlQuery {
  return {
    sql: `SELECT ${SHIPMENT_COLUMNS}, shipment_sort_at_ms
      FROM commerce_documents INDEXED BY commerce_delivery_orders_shipment_cursor
      WHERE ${SHIPMENT_PREDICATE} AND owner = ?
        AND length(CAST(document_path AS BLOB)) <= 512
        AND EXISTS (SELECT 1 FROM commerce_authority_control WHERE singleton = 1 AND authority_state = 'd1')
        ${args.startAfter ? 'AND (shipment_sort_at_ms, document_path) < (?, ?)' : ''}
      ORDER BY shipment_sort_at_ms DESC, document_path DESC LIMIT ?`,
    bindings: [args.owner, ...(args.startAfter ? [args.startAfter.sortAtMs, args.startAfter.documentPath] : []), args.limit],
  };
}

export function shipmentPresenceQuery(args: {
  owner: string;
  stripeSessionIds?: readonly string[];
  documentPaths?: readonly string[];
}): CommerceSqlQuery {
  const selectors = [
    { values: args.stripeSessionIds ?? [], field: "json_extract(document_json, '$.stripeCheckoutSessionId')", index: 'commerce_delivery_orders_shipment_session' },
    { values: args.documentPaths ?? [], field: 'document_path', index: 'sqlite_autoindex_commerce_documents_1' },
  ].filter(({ values }) => values.length);
  return {
    sql: selectors.map(({ values, field, index }) => `SELECT ${SHIPMENT_COLUMNS}
      FROM commerce_documents INDEXED BY ${index}
      WHERE ${SHIPMENT_PREDICATE} AND owner = ? AND ${field} IN (${values.map(() => '?').join(', ')})
        AND EXISTS (SELECT 1 FROM commerce_authority_control WHERE singleton = 1 AND authority_state = 'd1')`).join(' UNION ALL '),
    bindings: selectors.flatMap(({ values }) => [args.owner, ...values]),
  };
}

export function fulfillmentOrdersQuery(args: FulfillmentOrdersQueryArgs): CommerceSqlQuery {
  const cursor = args.startAfter;
  const cursorPredicate = cursor === undefined ? '' : ` AND (
        processed_at_seconds IS NULL OR
        processed_at_seconds < ? OR
        (processed_at_seconds = ? AND processed_at_nanos < ?) OR
        (processed_at_seconds = ? AND processed_at_nanos = ? AND document_path < ?)
      )`;
  return {
    sql: `SELECT ${DOCUMENT_COLUMNS}
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents INDEXED BY commerce_documents_drop_processed_cursor
      WHERE authority.singleton = 1 AND authority.authority_state = 'd1'
        AND document_kind = 'delivery_order' AND drop_id = ? AND status = 'ready_to_ship'${cursorPredicate}
      ORDER BY processed_at_seconds DESC, processed_at_nanos DESC, document_path DESC
      LIMIT ?`,
    bindings: [args.dropId, ...(cursor === undefined ? [] : [
      cursor.processedAt.seconds,
      cursor.processedAt.seconds,
      cursor.processedAt.nanos,
      cursor.processedAt.seconds,
      cursor.processedAt.nanos,
      cursor.documentPath,
    ]), args.limit],
  };
}

export function manualReviewCheckoutsQuery(args: ManualReviewCheckoutsQueryArgs): CommerceSqlQuery {
  const cursor = args.startAfter;
  return {
    sql: `SELECT ${COMMERCE_DOCUMENT_COLUMNS}
      FROM commerce_documents INDEXED BY commerce_stripe_checkouts_manual_review_cursor
      WHERE EXISTS (SELECT 1 FROM commerce_authority_control
        WHERE singleton = 1 AND authority_state = 'd1')
        AND document_kind = 'stripe_checkout' AND drop_id = ?
        AND manual_refund_review_required = 1
        AND EXISTS (SELECT 1 FROM commerce_stripe_checkout_state AS checkout_state
          WHERE checkout_state.document_path = commerce_documents.document_path
            AND checkout_state.status = 'fulfillment_failed')
        AND json_type(document_json, '$.manualRefundReviewRequired') = 'true'
        AND length(CAST(manual_review_session_id AS BLOB)) <= 256
        AND length(CAST(document_path AS BLOB)) <= 512${cursor === undefined ? '' : `
        AND (manual_review_sort_at_ms, manual_review_session_id, document_path) < (?, ?, ?)`}
      ORDER BY manual_review_sort_at_ms DESC, manual_review_session_id COLLATE BINARY DESC,
        document_path COLLATE BINARY DESC
      LIMIT ?`,
    bindings: [args.dropId, ...(cursor === undefined ? [] : [
      cursor.sortAtMs, cursor.sessionId, cursor.documentPath,
    ]), args.limit],
  };
}

export function legacyClaimAssignmentsQuery(args: Readonly<{ code: string }>): CommerceSqlQuery {
  return {
    sql: `SELECT ${DOCUMENT_COLUMNS}
      FROM commerce_authority_control AS authority CROSS JOIN commerce_documents
      WHERE authority.singleton = 1 AND authority.authority_state = 'd1'
        AND document_kind = 'box_assignment' AND irl_claim_code = ?
      ORDER BY document_path ASC
      LIMIT 2`,
    bindings: [args.code],
  };
}

export function adminIrlRedeemWorkflowStatusQuery(operationId: string): CommerceSqlQuery {
  return {
    sql: `SELECT ${DOCUMENT_COLUMNS}
      FROM commerce_authority_control AS authority CROSS JOIN commerce_documents
      WHERE
        authority.singleton = 1 AND
        document_kind = 'admin_irl_redeem_request' AND
        json_type(document_json, '$.workflowFinalizeV1.operationId') = 'text' AND
        json_extract(document_json, '$.workflowFinalizeV1.operationId') = ?
      ORDER BY document_path ASC
      LIMIT 2`,
    bindings: [operationId],
  };
}

export function deliveryOrderOwnersQuery(args: Readonly<{
  startAfterOwner?: string;
  limit: number;
}>): CommerceSqlQuery {
  const cursorPredicate = args.startAfterOwner === undefined ? '' : ' AND\n        document.owner > ?';
  return {
    sql: `SELECT DISTINCT document.owner AS owner
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
        document.owner NOT GLOB '*[0OIl]*'${cursorPredicate}
      ORDER BY document.owner ASC
      LIMIT ?`,
    bindings: args.startAfterOwner === undefined ? [args.limit] : [args.startAfterOwner, args.limit],
  };
}

export function deliveryRecoveryOrdersQuery(owner: string): CommerceSqlQuery {
  return {
    sql: `SELECT ${qualifiedDocumentColumns('document')}
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents AS document INDEXED BY commerce_documents_delivery_owner_status
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document.document_kind = 'delivery_order' AND
        document.owner = ? AND
        document.status IN ('processing', 'prepared')`,
    bindings: [owner],
  };
}

export type DeliveryRecoveryPageQuery = Readonly<{
  owner: string;
  dropId?: string;
  phase: 'processing' | 'prepared' | 'ready';
  startAfterPath?: string;
  limit: number;
}>;

export function deliveryRecoveryPageQuery(args: DeliveryRecoveryPageQuery): CommerceSqlQuery {
  if (args.phase === 'ready') return pendingReadyNotificationsQuery(args, true);
  return {
    sql: `SELECT ${qualifiedDocumentColumns('document')}
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents AS document INDEXED BY commerce_documents_delivery_owner_status
      WHERE authority.singleton = 1 AND authority.authority_state = 'd1'
        AND document.document_kind = 'delivery_order' AND document.owner = ? AND document.status = ?
        AND length(CAST(document.document_path AS BLOB)) <= ${DELIVERY_RECOVERY_CURSOR_MAX_PATH_LENGTH}
        ${args.dropId === undefined ? '' : 'AND document.drop_id = ? AND document.document_path >= ? AND document.document_path < ?'}
        ${args.startAfterPath === undefined ? '' : 'AND document.document_path > ?'}
      ORDER BY document.document_path ASC LIMIT ?`,
    bindings: [args.owner, args.phase, ...(args.dropId === undefined ? [] : [args.dropId,
      `drops/${args.dropId}/deliveryOrders/`, `drops/${args.dropId}/deliveryOrders0`]),
      ...(args.startAfterPath === undefined ? [] : [args.startAfterPath]), args.limit],
  };
}

export function deliveryOrdersByOwnerQuery(args: Readonly<{
  owner: string;
  limit: number;
}>): CommerceSqlQuery {
  return {
    sql: `SELECT ${qualifiedDocumentColumns('document')},
          COALESCE(path_revision.revision, 0) AS path_revision
        FROM commerce_documents AS document INDEXED BY commerce_documents_delivery_owner_path
        LEFT JOIN commerce_document_path_revisions AS path_revision
          ON path_revision.document_path = document.document_path
        WHERE document.document_kind = 'delivery_order' AND document.owner = ?
        ORDER BY document.document_path ASC
        LIMIT ?`,
    bindings: [args.owner, args.limit],
  };
}

export function pendingReadyNotificationsQuery(args: Readonly<{
  limit: number;
  owner?: string;
  dropId?: string;
  startAfterPath?: string;
}>, recoveryPage = false): CommerceSqlQuery {
  const ownerPredicate = args.owner === undefined ? '' : ' AND pending.owner = ? AND document.owner = pending.owner';
  const orderedPath = args.owner === undefined ? 'outbox.parent_path' : 'pending.parent_path';
  const cursorPredicate = args.startAfterPath === undefined ? '' : ` AND ${orderedPath} > ?`;
  const bindings = [
    ...(args.owner === undefined ? [] : [args.owner]),
    ...(args.startAfterPath === undefined ? [] : [args.startAfterPath]),
    ...(args.dropId === undefined ? [] : [args.dropId,
      `drops/${args.dropId}/deliveryOrders/`, `drops/${args.dropId}/deliveryOrders0`]),
  ];
  return {
    sql: `SELECT ${qualifiedDocumentColumns('document')}
    ${args.owner === undefined
      ? `FROM commerce_notification_outbox AS outbox INDEXED BY commerce_notification_outbox_pending_path
    CROSS JOIN commerce_documents AS document`
      : `FROM commerce_notification_outbox_pending_owners AS pending INDEXED BY commerce_notification_outbox_pending_owner_path
    CROSS JOIN commerce_notification_outbox AS outbox
    CROSS JOIN commerce_documents AS document`}
    WHERE outbox.parent_path = document.document_path
      AND document.document_kind = 'delivery_order' AND document.status = 'ready_to_ship'
      ${recoveryPage ? `AND length(CAST(document.document_path AS BLOB)) <= ${DELIVERY_RECOVERY_CURSOR_MAX_PATH_LENGTH}` : ''}
      AND outbox.family = 'ready' AND outbox.state = 'pending'${args.owner === undefined ? '' : " AND pending.parent_path = outbox.parent_path AND pending.family = 'ready'"}${ownerPredicate}${cursorPredicate}${args.dropId === undefined ? '' : ` AND document.drop_id = ? AND ${orderedPath} >= ? AND ${orderedPath} < ?`}
    ORDER BY ${orderedPath} ASC
    LIMIT CASE WHEN ${NOTIFICATION_OUTBOX_ACTIVE_SQL} THEN ? ELSE 0 END`,
    bindings: [...bindings, args.limit],
  };
}

export function dueReadyNotificationsQuery(args: Readonly<{
  dueAtMs: number;
  limit: number;
}>): CommerceSqlQuery {
  return {
    sql: `SELECT ${qualifiedDocumentColumns('document')}
      FROM commerce_notification_outbox AS outbox INDEXED BY commerce_notification_outbox_family_due
      CROSS JOIN commerce_documents AS document
      WHERE document.document_path = outbox.parent_path
        AND outbox.family = 'ready' AND outbox.state = 'pending' AND outbox.next_attempt_at_ms <= ?
        AND document.document_kind = 'delivery_order' AND document.status = 'ready_to_ship'
      ORDER BY outbox.next_attempt_at_ms, outbox.parent_path
      LIMIT CASE WHEN ${NOTIFICATION_OUTBOX_ACTIVE_SQL} THEN ? ELSE 0 END`,
    bindings: [args.dueAtMs, args.limit],
  };
}

export function duePackStatusProjectionsQuery(args: Readonly<{
  dropId: string;
  dueAtMs: number;
  limit: number;
}>): CommerceSqlQuery {
  return {
    sql: `SELECT ${DOCUMENT_COLUMNS}
      FROM commerce_authority_control AS authority CROSS JOIN commerce_documents
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document_kind = 'delivery_order' AND
        drop_id = ? AND
        pack_projection_state = 'pending' AND
        pack_projection_next_attempt_ms <= ?
      ORDER BY pack_projection_next_attempt_ms ASC, document_path ASC
      LIMIT ?`,
    bindings: [args.dropId, args.dueAtMs, args.limit],
  };
}

export function staleStripeFulfillmentsQuery(cutoffMs: number): CommerceSqlQuery {
  return {
    sql: `SELECT ${qualifiedDocumentColumns('document', true)}
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_stripe_checkout_state AS checkout_state INDEXED BY commerce_stripe_checkout_state_reconciliation_due
      CROSS JOIN commerce_documents AS document
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document.document_path = checkout_state.document_path AND
        document.document_kind = 'stripe_checkout' AND
        document.fulfillment_processor = '${STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR}' AND
        checkout_state.status IN ('${STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING}', '${STRIPE_CHECKOUT_STATUS.PROCESSING}') AND
        json_type(document.document_json, '$.lastStripeWebhookEventId') = 'text' AND
        checkout_state.updated_at_ms <= ?
      ORDER BY checkout_state.updated_at_ms ASC, checkout_state.document_path ASC
      LIMIT 100`,
    bindings: [cutoffMs],
  };
}

export function dueStripeTerminalNotificationsQuery(args: Readonly<{
  dueAtMs: number;
  limit: number;
}>): CommerceSqlQuery {
  return {
    sql: `SELECT ${qualifiedDocumentColumns('document', true)}
      FROM commerce_notification_outbox_stripe_due AS due INDEXED BY commerce_notification_outbox_stripe_due_at
      CROSS JOIN commerce_notification_outbox AS outbox
      CROSS JOIN commerce_documents AS document
      WHERE due.parent_path = outbox.parent_path AND due.family = outbox.family
        AND document.document_path = outbox.parent_path
        AND outbox.family = 'stripe_terminal' AND outbox.state = 'pending'
        AND due.next_attempt_at_ms <= ? AND outbox.next_attempt_at_ms = due.next_attempt_at_ms
        AND document.document_kind = 'stripe_checkout'
        AND EXISTS (SELECT 1 FROM commerce_stripe_checkout_state AS checkout_state
          WHERE checkout_state.document_path = document.document_path
            AND ((outbox.outcome = 'fulfilled' AND checkout_state.status = 'fulfilled') OR
              (outbox.outcome = 'manual_review' AND checkout_state.status = 'fulfillment_failed' AND document.manual_refund_review_required = 1)))
      ORDER BY due.next_attempt_at_ms, due.parent_path
      LIMIT CASE WHEN ${NOTIFICATION_OUTBOX_ACTIVE_SQL} THEN ? ELSE 0 END`,
    bindings: [args.dueAtMs, args.limit],
  };
}
