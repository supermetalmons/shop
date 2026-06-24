export function sanitizeFulfillmentTrackingCode(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, '') : '';
}

export function normalizeOptionalFulfillmentTrackingCode(value: unknown): string | undefined {
  const normalized = sanitizeFulfillmentTrackingCode(value);
  return normalized || undefined;
}

export function shouldDisplayFulfillmentTrackingCode(status: unknown, trackingCode: unknown): boolean {
  return status === 'Shipped' && Boolean(normalizeOptionalFulfillmentTrackingCode(trackingCode));
}
