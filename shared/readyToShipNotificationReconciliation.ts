export const READY_NOTIFICATION_CONTROL_PATH = 'workerControls/readyNotifications';
export const READY_NOTIFICATION_PENDING_STATE = 'pending';
export const READY_NOTIFICATION_BUYER_STATE_FIELD = 'buyerOrderReceivedEmailState';
export const READY_NOTIFICATION_SHIPPER_STATE_FIELD = 'shipperReadyToShipEmailState';
const READY_NOTIFICATION_RECONCILIATION_MAX_QUERY_LIMIT = 32;

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
