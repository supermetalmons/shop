export function sanitizeFulfillmentTrackingCode(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeOptionalFulfillmentTrackingCode(value: unknown): string | undefined {
  const normalized = sanitizeFulfillmentTrackingCode(value);
  return normalized || undefined;
}
