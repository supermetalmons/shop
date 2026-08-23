import { normalizeOptionalFulfillmentTrackingCode } from '../../shared/fulfillmentTracking.js';

export {
  normalizeOptionalFulfillmentTrackingCode,
  resolveFulfillmentTrackingHref,
  sanitizeFulfillmentTrackingCode,
} from '../../shared/fulfillmentTracking.js';

export function shouldDisplayFulfillmentTrackingCode(status: unknown, trackingCode: unknown): boolean {
  return status === 'Shipped' && Boolean(normalizeOptionalFulfillmentTrackingCode(trackingCode));
}
