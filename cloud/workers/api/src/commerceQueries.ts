import { STRIPE_CHECKOUT_STATUS } from '../../../../shared/stripeCheckoutSession.js';
import { STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR } from '../../../../shared/stripeCheckoutFulfillmentJob.js';
import { READY_NOTIFICATION_DUE_SQL } from '../../../../shared/readyNotificationDueSql.js';

export type CommerceSqlQuery = {
  bindings: Array<string | number>;
  sql: string;
};

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

export const COMMERCE_DOCUMENT_COLUMNS = DOCUMENT_COLUMN_NAMES.join(', ');

const PENDING_READY_NOTIFICATION_INDEXES = Object.freeze({
  buyer: Object.freeze({
    owner: 'commerce_delivery_orders_buyer_notifications_pending_owner_path',
    ownerless: 'commerce_delivery_orders_buyer_notifications_pending',
  }),
  shipper: Object.freeze({
    owner: 'commerce_delivery_orders_shipper_notifications_pending_owner_path',
    ownerless: 'commerce_delivery_orders_shipper_notifications_pending',
  }),
});

function qualifiedDocumentColumns(alias: string): string {
  return DOCUMENT_COLUMN_NAMES.map((name) => `${alias}.${name}`).join(', ');
}

export function adminIrlRedeemWorkflowStatusQuery(operationId: string): CommerceSqlQuery {
  return {
    sql: `SELECT ${COMMERCE_DOCUMENT_COLUMNS}
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
  startAfterPath?: string;
}>): CommerceSqlQuery {
  const indexVariant = args.owner === undefined ? 'ownerless' : 'owner';
  const buyerIndex = PENDING_READY_NOTIFICATION_INDEXES.buyer[indexVariant];
  const shipperIndex = PENDING_READY_NOTIFICATION_INDEXES.shipper[indexVariant];
  const ownerPredicate = args.owner === undefined ? '' : ' AND document.owner = ?';
  const cursorPredicate = args.startAfterPath === undefined ? '' : ' AND document.document_path > ?';
  const armBindings = [
    ...(args.owner === undefined ? [] : [args.owner]),
    ...(args.startAfterPath === undefined ? [] : [args.startAfterPath]),
  ];
  return {
    sql: `WITH candidate_paths AS (
      SELECT document.document_path
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents AS document
        INDEXED BY ${buyerIndex}
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document.document_kind = 'delivery_order' AND
        document.status = 'ready_to_ship' AND
        document.buyer_notification_state = 'pending'${ownerPredicate}${cursorPredicate}
      UNION
      SELECT document.document_path
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents AS document
        INDEXED BY ${shipperIndex}
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document.document_kind = 'delivery_order' AND
        document.status = 'ready_to_ship' AND
        document.shipper_notification_state = 'pending'${ownerPredicate}${cursorPredicate}
    )
    SELECT ${qualifiedDocumentColumns('document')}
    FROM commerce_documents AS document
    JOIN candidate_paths USING (document_path)
    ORDER BY document.document_path ASC
    LIMIT ?`,
    bindings: [...armBindings, ...armBindings, args.limit],
  };
}

export function dueReadyNotificationsQuery(args: Readonly<{
  dueAtMs: number;
  limit: number;
}>): CommerceSqlQuery {
  const { indexName, dueAtExpression, pendingPredicate } = READY_NOTIFICATION_DUE_SQL;
  return {
    sql: `SELECT ${COMMERCE_DOCUMENT_COLUMNS}
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents INDEXED BY ${indexName}
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        ${pendingPredicate} AND
        (${dueAtExpression}) <= ?
      ORDER BY (${dueAtExpression}) ASC, document_path ASC
      LIMIT ?`,
    bindings: [args.dueAtMs, args.limit],
  };
}

export function duePackStatusProjectionsQuery(args: Readonly<{
  dropId: string;
  dueAtMs: number;
  limit: number;
}>): CommerceSqlQuery {
  return {
    sql: `SELECT ${COMMERCE_DOCUMENT_COLUMNS}
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
    sql: `SELECT ${COMMERCE_DOCUMENT_COLUMNS}
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents INDEXED BY commerce_stripe_checkouts_reconciliation_due
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document_kind = 'stripe_checkout' AND
        fulfillment_processor = '${STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR}' AND
        status IN ('${STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING}', '${STRIPE_CHECKOUT_STATUS.PROCESSING}') AND
        json_type(document_json, '$.updatedAt') IN ('integer', 'real') AND
        json_type(document_json, '$.lastStripeWebhookEventId') = 'text' AND
        CAST(json_extract(document_json, '$.updatedAt') AS INTEGER) <= ?
      ORDER BY CAST(json_extract(document_json, '$.updatedAt') AS INTEGER) ASC, document_path ASC
      LIMIT 100`,
    bindings: [cutoffMs],
  };
}

export function dueStripeTerminalNotificationsQuery(args: Readonly<{
  dueAtMs: number;
  limit: number;
}>): CommerceSqlQuery {
  return {
    sql: `SELECT ${COMMERCE_DOCUMENT_COLUMNS}
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents INDEXED BY commerce_stripe_terminal_notifications_due
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document_kind = 'stripe_checkout' AND
        (status = 'fulfilled' OR (status = 'fulfillment_failed' AND manual_refund_review_required = 1)) AND
        json_extract(document_json, '$.stripeTerminalNotificationState') = 'pending' AND
        CAST(json_extract(document_json, '$.stripeTerminalNotificationNextAttemptAtMs') AS INTEGER) <= ?
      ORDER BY CAST(json_extract(document_json, '$.stripeTerminalNotificationNextAttemptAtMs') AS INTEGER) ASC,
        document_path ASC
      LIMIT ?`,
    bindings: [args.dueAtMs, args.limit],
  };
}
