export const READY_NOTIFICATION_PENDING_STATE = 'pending';
export const READY_NOTIFICATION_BUYER_STATE_FIELD = 'buyerOrderReceivedEmailState';
export const READY_NOTIFICATION_SHIPPER_STATE_FIELD = 'shipperReadyToShipEmailState';
const READY_NOTIFICATION_RECONCILIATION_MAX_QUERY_LIMIT = 32;
const READY_NOTIFICATION_CURSOR_DROP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type ReadyNotificationReconciliationQueryArgs = {
  limit: number;
  startAfterDocumentPath?: string;
};

function boundedQueryLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Ready-notification reconciliation query limit is invalid');
  }
  return Math.min(value, READY_NOTIFICATION_RECONCILIATION_MAX_QUERY_LIMIT);
}

export function isCanonicalReadyNotificationCursorPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  if (
    parts.length !== 4 ||
    parts[0] !== 'drops' ||
    !READY_NOTIFICATION_CURSOR_DROP_ID_PATTERN.test(parts[1] || '') ||
    parts[2] !== 'deliveryOrders' ||
    !/^[1-9][0-9]*$/.test(parts[3] || '')
  ) return false;
  const deliveryId = Number(parts[3]);
  return Number.isSafeInteger(deliveryId) && deliveryId > 0;
}

export function buildReadyNotificationReconciliationQuery(
  args: ReadyNotificationReconciliationQueryArgs,
): Record<string, unknown> {
  const startAfterDocumentPath = args.startAfterDocumentPath?.trim();
  if (args.startAfterDocumentPath !== undefined && !startAfterDocumentPath) {
    throw new Error('Ready-notification reconciliation cursor is invalid');
  }
  const pendingFilter = (fieldPath: string) => ({
    fieldFilter: {
      field: { fieldPath },
      op: 'EQUAL',
      value: { stringValue: READY_NOTIFICATION_PENDING_STATE },
    },
  });
  return {
    structuredQuery: {
      from: [{ collectionId: 'deliveryOrders', allDescendants: true }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: 'status' },
                op: 'EQUAL',
                value: { stringValue: 'ready_to_ship' },
              },
            },
            {
              compositeFilter: {
                op: 'OR',
                filters: [
                  pendingFilter(READY_NOTIFICATION_BUYER_STATE_FIELD),
                  pendingFilter(READY_NOTIFICATION_SHIPPER_STATE_FIELD),
                ],
              },
            },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      ...(startAfterDocumentPath ? {
        startAt: {
          before: false,
          values: [{ referenceValue: startAfterDocumentPath }],
        },
      } : {}),
      limit: boundedQueryLimit(args.limit),
    },
  };
}
