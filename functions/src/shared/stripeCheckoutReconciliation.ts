import { STRIPE_CHECKOUT_STATUS } from './stripeCheckoutSession.js';
import { STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR } from './stripeCheckoutFulfillmentJob.js';

export function stripeCheckoutReconciliationQuery(
  cutoffMs: number,
  limit: number,
): Record<string, unknown> {
  return {
    structuredQuery: {
      select: {
        fields: [
          'fulfillmentProcessor',
          'lastStripeWebhookEventId',
          'lastStripeWebhookEventType',
          'status',
          'updatedAt',
        ].map((fieldPath) => ({ fieldPath })),
      },
      from: [{ collectionId: 'stripeCheckouts', allDescendants: true }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: 'status' },
                op: 'IN',
                value: {
                  arrayValue: {
                    values: [
                      { stringValue: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING },
                      { stringValue: STRIPE_CHECKOUT_STATUS.PROCESSING },
                    ],
                  },
                },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: 'fulfillmentProcessor' },
                op: 'EQUAL',
                value: { stringValue: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: 'updatedAt' },
                op: 'LESS_THAN_OR_EQUAL',
                value: { timestampValue: new Date(cutoffMs).toISOString() },
              },
            },
          ],
        },
      },
      orderBy: [
        { field: { fieldPath: 'updatedAt' }, direction: 'ASCENDING' },
        { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
      ],
      limit,
    },
  };
}
