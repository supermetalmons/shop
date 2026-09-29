import { isCommerceDocumentSegment } from './commerceDocumentPath.ts';

export const DELIVERY_RECOVERY_PAGE_SIZE = 8;
export const DELIVERY_RECOVERY_CURSOR_MAX_LENGTH = 1024;
export const DELIVERY_RECOVERY_CURSOR_MAX_PATH_LENGTH = 256;
export const DELIVERY_RECOVERY_PHASES = ['processing', 'prepared', 'ready'] as const;

export type DeliveryRecoveryPhase = typeof DELIVERY_RECOVERY_PHASES[number];

export type DeliveryRecoveryCursor = {
  version: 1;
  owner: string;
  dropId: string | null;
  force: boolean;
  phase: DeliveryRecoveryPhase;
  path: string;
};

function isDeliveryRecoveryCursor(value: unknown): value is DeliveryRecoveryCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  const keys = ['version', 'owner', 'dropId', 'force', 'phase', 'path'];
  const parts = typeof cursor.path === 'string' ? cursor.path.split('/') : [];
  return Object.keys(cursor).length === keys.length && keys.every((key) => Object.hasOwn(cursor, key)) &&
    cursor.version === 1 && typeof cursor.owner === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cursor.owner) &&
    (cursor.dropId === null || (typeof cursor.dropId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(cursor.dropId))) &&
    typeof cursor.force === 'boolean' && DELIVERY_RECOVERY_PHASES.some((phase) => cursor.phase === phase) &&
    typeof cursor.path === 'string' && cursor.path.length <= DELIVERY_RECOVERY_CURSOR_MAX_PATH_LENGTH && parts.length === 4 &&
    parts[0] === 'drops' && parts[2] === 'deliveryOrders' &&
    isCommerceDocumentSegment(parts[1]) && isCommerceDocumentSegment(parts[3]) &&
    (cursor.dropId === null || parts[1] === cursor.dropId);
}

export function encodeDeliveryRecoveryCursor(cursor: DeliveryRecoveryCursor): string {
  if (!isDeliveryRecoveryCursor(cursor)) throw new Error('Invalid delivery recovery cursor.');
  const encoded = btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (encoded.length > DELIVERY_RECOVERY_CURSOR_MAX_LENGTH) throw new Error('Invalid delivery recovery cursor.');
  return encoded;
}

export function decodeDeliveryRecoveryCursor(value: unknown): DeliveryRecoveryCursor | null {
  if (typeof value !== 'string' || !value || value.length > DELIVERY_RECOVERY_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
    return isDeliveryRecoveryCursor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
