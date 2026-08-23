import {
  normalizeFulfillmentStatus as normalizeSharedFulfillmentStatus,
} from '../../shared/fulfillmentStatus.js';
import type { FulfillmentStatus } from '../../shared/fulfillmentStatus.js';

export { FULFILLMENT_STATUS_OPTIONS } from '../../shared/fulfillmentStatus.js';
export type { FulfillmentStatus } from '../../shared/fulfillmentStatus.js';

export function normalizeFulfillmentStatus(value: unknown): FulfillmentStatus | '' {
  return normalizeSharedFulfillmentStatus(value) || '';
}
