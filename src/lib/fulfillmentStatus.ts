import {
  isFulfillmentStatus,
  normalizeFulfillmentStatus as normalizeSharedFulfillmentStatus,
} from '../../functions/src/shared/fulfillmentStatus.js';
import type { FulfillmentStatus } from '../../functions/src/shared/fulfillmentStatus.js';

export { FULFILLMENT_STATUS_OPTIONS } from '../../functions/src/shared/fulfillmentStatus.js';
export type { FulfillmentStatus } from '../../functions/src/shared/fulfillmentStatus.js';

export function normalizeFulfillmentStatus(value: unknown): FulfillmentStatus | '' {
  return normalizeSharedFulfillmentStatus(value) || '';
}

export function normalizeFulfillmentStatusOrNull(value: unknown): FulfillmentStatus | null {
  return isFulfillmentStatus(value) ? value : null;
}
