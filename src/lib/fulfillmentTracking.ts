import { normalizeOptionalFulfillmentTrackingCode } from '../../functions/src/shared/fulfillmentTracking.js';

export {
  normalizeOptionalFulfillmentTrackingCode,
  resolveFulfillmentTrackingHref,
  sanitizeFulfillmentTrackingCode,
} from '../../functions/src/shared/fulfillmentTracking.js';

export function shouldDisplayFulfillmentTrackingCode(status: unknown, trackingCode: unknown): boolean {
  return status === 'Shipped' && Boolean(normalizeOptionalFulfillmentTrackingCode(trackingCode));
}
