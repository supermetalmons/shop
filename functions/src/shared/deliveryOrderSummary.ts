import type { DeliveryOrderSummary } from './contracts.js';
import { isFulfillmentStatus } from './fulfillmentStatus.js';
import { isPositiveSafeInteger } from './positiveInteger.js';

export const PROFILE_SHIPMENT_STATUSES = ['processing', 'ready_to_ship'] as const;

export function isProfileShipmentStatus(
  value: unknown,
): value is (typeof PROFILE_SHIPMENT_STATUSES)[number] {
  return PROFILE_SHIPMENT_STATUSES.some((status) => status === value);
}

export function deliveryOrderSummarySortAt(
  order: Pick<DeliveryOrderSummary, 'createdAt' | 'processingAt' | 'processedAt'>,
): number {
  return order.processedAt ?? order.processingAt ?? order.createdAt ?? 0;
}

export function deliveryOrderSummaryKey(
  order: Pick<DeliveryOrderSummary, 'dropId' | 'deliveryId'>,
): string {
  return `${order.dropId}:${order.deliveryId}`;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseDeliveryOrderSummary(value: unknown): DeliveryOrderSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const dropId = typeof data.dropId === 'string' ? data.dropId.trim() : '';
  const deliveryId = isPositiveSafeInteger(data.deliveryId) ? data.deliveryId : undefined;
  const status = data.status;
  if (!dropId || deliveryId === undefined || !isProfileShipmentStatus(status)) return null;

  const items = (Array.isArray(data.items) ? data.items : [])
    .map((item): DeliveryOrderSummary['items'][number] | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const entry = item as Record<string, unknown>;
      const kind = entry.kind;
      const refId = isPositiveSafeInteger(entry.refId) ? entry.refId : undefined;
      if ((kind !== 'box' && kind !== 'dude') || refId === undefined) return null;
      return { kind, refId };
    })
    .filter((item): item is DeliveryOrderSummary['items'][number] => Boolean(item));

  const stripeCheckoutSessionId =
    typeof data.stripeCheckoutSessionId === 'string' && data.stripeCheckoutSessionId
      ? data.stripeCheckoutSessionId
      : undefined;
  const fulfillmentStatus = isFulfillmentStatus(data.fulfillmentStatus)
    ? data.fulfillmentStatus
    : undefined;
  const fulfillmentTrackingCode =
    typeof data.fulfillmentTrackingCode === 'string' && data.fulfillmentTrackingCode
      ? data.fulfillmentTrackingCode
      : undefined;
  const createdAt = optionalFiniteNumber(data.createdAt);
  const processingAt = optionalFiniteNumber(data.processingAt);
  const processedAt = optionalFiniteNumber(data.processedAt);
  const fulfillmentUpdatedAt = optionalFiniteNumber(data.fulfillmentUpdatedAt);

  return {
    dropId,
    deliveryId,
    status,
    items,
    ...(stripeCheckoutSessionId ? { stripeCheckoutSessionId } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(processingAt !== undefined ? { processingAt } : {}),
    ...(processedAt !== undefined ? { processedAt } : {}),
    ...(fulfillmentStatus ? { fulfillmentStatus } : {}),
    ...(fulfillmentTrackingCode ? { fulfillmentTrackingCode } : {}),
    ...(fulfillmentUpdatedAt !== undefined ? { fulfillmentUpdatedAt } : {}),
  };
}

export function deliveryOrderSummaryEqual(
  left: DeliveryOrderSummary,
  right: DeliveryOrderSummary,
): boolean {
  return (
    left.dropId === right.dropId &&
    left.deliveryId === right.deliveryId &&
    left.status === right.status &&
    left.stripeCheckoutSessionId === right.stripeCheckoutSessionId &&
    left.createdAt === right.createdAt &&
    left.processingAt === right.processingAt &&
    left.processedAt === right.processedAt &&
    left.fulfillmentStatus === right.fulfillmentStatus &&
    left.fulfillmentTrackingCode === right.fulfillmentTrackingCode &&
    left.fulfillmentUpdatedAt === right.fulfillmentUpdatedAt &&
    left.items.length === right.items.length &&
    left.items.every(
      (item, index) =>
        item.kind === right.items[index]?.kind &&
        item.refId === right.items[index]?.refId,
    )
  );
}
