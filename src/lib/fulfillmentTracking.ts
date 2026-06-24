export function sanitizeFulfillmentTrackingCode(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeOptionalFulfillmentTrackingCode(value: unknown): string | undefined {
  const normalized = sanitizeFulfillmentTrackingCode(value);
  return normalized || undefined;
}

export function resolveFulfillmentTrackingHref(value: unknown): string | undefined {
  const normalized = normalizeOptionalFulfillmentTrackingCode(value);
  if (!normalized || !/^https:\/\//i.test(normalized)) return undefined;
  try {
    const url = new URL(normalized);
    return url.protocol === 'https:' && url.hostname ? normalized : undefined;
  } catch {
    return undefined;
  }
}

export function shouldDisplayFulfillmentTrackingCode(status: unknown, trackingCode: unknown): boolean {
  return status === 'Shipped' && Boolean(normalizeOptionalFulfillmentTrackingCode(trackingCode));
}
