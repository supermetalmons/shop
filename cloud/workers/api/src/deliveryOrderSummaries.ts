import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import { parseDropDeliveryOrderPath, type DropDeliveryOrderPathIdentity } from './dropPaths.js';
import { parsePositiveSafeInteger } from '../../../../shared/positiveInteger.js';

function normalizeDropIdMaybe(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const dropId = normalizeDropId(value);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(dropId) ? dropId : null;
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

function dropIdFromDeliveryOrderPath(path: string): string | null {
  return normalizeDropIdMaybe(parseDropDeliveryOrderPath(path)?.dropId);
}

export function resolveDeliveryOrderDropId(order: unknown, path: string): string | null {
  return normalizeDropIdMaybe((order as { dropId?: unknown } | null)?.dropId) || dropIdFromDeliveryOrderPath(path);
}
