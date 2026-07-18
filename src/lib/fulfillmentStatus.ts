export const FULFILLMENT_STATUS_OPTIONS = ['Preparing', 'Shipped'] as const;

export type FulfillmentStatus = (typeof FULFILLMENT_STATUS_OPTIONS)[number];

const FULFILLMENT_STATUS_SET = new Set<string>(FULFILLMENT_STATUS_OPTIONS);

function isFulfillmentStatus(value: unknown): value is FulfillmentStatus {
  return typeof value === 'string' && FULFILLMENT_STATUS_SET.has(value);
}

export function normalizeFulfillmentStatus(value: unknown): FulfillmentStatus | '' {
  return isFulfillmentStatus(value) ? value : '';
}

export function normalizeFulfillmentStatusOrNull(value: unknown): FulfillmentStatus | null {
  return isFulfillmentStatus(value) ? value : null;
}
