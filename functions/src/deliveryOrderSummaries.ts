import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from './shared/fulfillmentSources.js';
import { normalizeDropId } from './shared/deploymentCore.js';
import { normalizeOptionalFulfillmentTrackingCode } from './shared/fulfillmentTracking.js';
import { normalizeFulfillmentStatus } from './shared/fulfillmentStatus.js';
import { parseDropDeliveryOrderPath, type DropDeliveryOrderPathIdentity } from './dropPaths.js';
import type { DeliveryOrderItemSummary, DeliveryOrderSummary } from './shared/contracts.js';
import { parsePositiveSafeInteger } from './shared/positiveInteger.js';
import { toMillisMaybe } from './time.js';

export const DELIVERY_ORDER_SUMMARY_FIELDS = [
  'dropId', 'deliveryId', 'source', 'status', 'stripeCheckoutSessionId', 'createdAt', 'processingAt',
  'processedAt', 'items', 'fulfillmentStatus', 'fulfillmentTrackingCode', 'fulfillmentUpdatedAt',
] as const;

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeDropIdMaybe(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const dropId = normalizeDropId(value);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(dropId) ? dropId : null;
}

function finiteMillisMaybe(value: unknown): number | undefined {
  const millis = toMillisMaybe(value);
  return typeof millis === 'number' && Number.isFinite(millis) ? millis : undefined;
}

export type DeliveryOrderIdentityResolution =
  | { identity: DropDeliveryOrderPathIdentity }
  | { reason: 'invalid_path' | 'invalid_delivery_id' | 'delivery_id_mismatch' };

export function resolveDeliveryOrderIdentity(
  documentId: string,
  order: unknown,
  path: string,
): DeliveryOrderIdentityResolution {
  const pathIdentity = parseDropDeliveryOrderPath(path);
  if (!pathIdentity) {
    const parts = String(path || '').split('/');
    return parts.length === 4 && parts[0] === 'drops' && parts[1] && parts[2] === 'deliveryOrders'
      ? { reason: 'invalid_delivery_id' }
      : { reason: 'invalid_path' };
  }
  const dropId = normalizeDropIdMaybe(pathIdentity.dropId);
  if (!dropId) return { reason: 'invalid_path' };
  if (documentId !== pathIdentity.documentId) return { reason: 'delivery_id_mismatch' };
  const storedDeliveryId = (order as { deliveryId?: unknown } | null)?.deliveryId;
  if (storedDeliveryId !== undefined) {
    const parsed = parsePositiveSafeInteger(storedDeliveryId);
    if (parsed === null) return { reason: 'invalid_delivery_id' };
    if (parsed !== pathIdentity.deliveryId) return { reason: 'delivery_id_mismatch' };
  }
  return { identity: { ...pathIdentity, dropId } };
}

export function dropIdFromDeliveryOrderPath(path: string): string | null {
  return normalizeDropIdMaybe(parseDropDeliveryOrderPath(path)?.dropId);
}

export function resolveDeliveryOrderDropId(order: unknown, path: string): string | null {
  return normalizeDropIdMaybe((order as { dropId?: unknown } | null)?.dropId) || dropIdFromDeliveryOrderPath(path);
}

function toDeliveryOrderSummary(documentId: string, value: unknown, path: string): DeliveryOrderSummary | null {
  const order = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!order || order.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) return null;
  const resolution = resolveDeliveryOrderIdentity(documentId, order, path);
  if (!('identity' in resolution)) return null;
  const { deliveryId, dropId } = resolution.identity;
  if (order.dropId !== undefined && normalizeDropIdMaybe(order.dropId) !== dropId) return null;
  const items = (Array.isArray(order.items) ? order.items : []).flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const refId = Math.floor(Number(item.refId));
    if ((item.kind !== 'box' && item.kind !== 'dude') || !Number.isSafeInteger(refId) || refId <= 0) return [];
    return [{ kind: item.kind, refId } satisfies DeliveryOrderItemSummary];
  });
  return {
    dropId,
    deliveryId,
    status: typeof order.status === 'string' ? order.status : 'unknown',
    stripeCheckoutSessionId: optionalTrimmedString(order.stripeCheckoutSessionId),
    createdAt: finiteMillisMaybe(order.createdAt),
    processingAt: finiteMillisMaybe(order.processingAt),
    processedAt: finiteMillisMaybe(order.processedAt),
    items,
    fulfillmentStatus: normalizeFulfillmentStatus(order.fulfillmentStatus),
    fulfillmentTrackingCode: normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode),
    fulfillmentUpdatedAt: finiteMillisMaybe(order.fulfillmentUpdatedAt),
  };
}

export function toDeliveryOrderSummaries(
  documents: Array<{ id: string; data(): unknown; ref: { path: string } }>,
): DeliveryOrderSummary[] {
  return documents.flatMap((document) => {
    const summary = toDeliveryOrderSummary(document.id, document.data(), document.ref.path);
    return summary ? [summary] : [];
  });
}
