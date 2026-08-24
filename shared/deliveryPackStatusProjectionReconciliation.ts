export const PACK_STATUS_PROJECTION_PENDING = 'pending';
export const PACK_STATUS_PROJECTION_STATE_FIELD = 'packStatusProjectionState';
export const PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD = 'packStatusProjectionNextAttemptAtMs';

type DeliveryPackStatusProjectionReconciliationQueryArgs = {
  dueAtMs: number;
  limit: number;
};

export function buildDeliveryPackStatusProjectionReconciliationQuery(
  args: DeliveryPackStatusProjectionReconciliationQueryArgs,
): Record<string, unknown> {
  if (!Number.isSafeInteger(args.dueAtMs) || args.dueAtMs < 0) {
    throw new Error('Pack-status projection reconciliation due time is invalid');
  }
  if (!Number.isSafeInteger(args.limit) || args.limit < 1) {
    throw new Error('Pack-status projection reconciliation query limit is invalid');
  }
  return {
    structuredQuery: {
      select: {
        fields: [
          PACK_STATUS_PROJECTION_STATE_FIELD,
          PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD,
          'deliveryId',
        ].map((fieldPath) => ({ fieldPath })),
      },
      from: [{ collectionId: 'deliveryOrders' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: PACK_STATUS_PROJECTION_STATE_FIELD },
                op: 'EQUAL',
                value: { stringValue: PACK_STATUS_PROJECTION_PENDING },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD },
                op: 'LESS_THAN_OR_EQUAL',
                value: { integerValue: String(args.dueAtMs) },
              },
            },
          ],
        },
      },
      orderBy: [
        {
          field: { fieldPath: PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD },
          direction: 'ASCENDING',
        },
        { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
      ],
      limit: args.limit,
    },
  };
}
