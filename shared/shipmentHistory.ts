import type { DeliveryOrderSummary } from './contracts.ts';
import { isCommerceDocumentSegment } from './commerceDocumentPath.ts';

export const DEFAULT_SHIPMENT_PAGE_LIMIT = 50;
export const MAX_SHIPMENT_PAGE_LIMIT = 100;
export const MAX_SHIPMENT_PRESENCE_SELECTORS = 50;

export type ShipmentHistoryCursor = {
  version: 1;
  owner: string;
  sortAtMs: number;
  documentPath: string;
};

export type ShipmentPageRequest = {
  limit?: number;
  cursor?: ShipmentHistoryCursor | null;
};

export type ShipmentHistoryPage = {
  orders: DeliveryOrderSummary[];
  nextCursor: ShipmentHistoryCursor | null;
};

export type ShipmentDeliveryReference = { dropId: string; deliveryId: number };

export type ShipmentPresenceRequest = ({
  scope: 'wallet';
  expectedWallet: string;
} | {
  scope: 'anonymous';
  expectedWallet?: never;
}) & {
  stripeSessionIds?: string[];
  deliveries?: ShipmentDeliveryReference[];
};

export type ShipmentPresenceResponse = {
  stripeSessionIds: string[];
  deliveries: ShipmentDeliveryReference[];
};

export function isShipmentHistoryCursor(value: unknown, owner?: string): value is ShipmentHistoryCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  const keys = ['version', 'owner', 'sortAtMs', 'documentPath'];
  const path = typeof cursor.documentPath === 'string' ? cursor.documentPath.split('/') : [];
  return Object.keys(cursor).length === keys.length && keys.every((key) => Object.hasOwn(cursor, key)) &&
    cursor.version === 1 && typeof cursor.owner === 'string' && cursor.owner.length > 0 && cursor.owner.length <= 256 &&
    (owner === undefined || cursor.owner === owner) &&
    typeof cursor.sortAtMs === 'number' && Number.isFinite(cursor.sortAtMs) &&
    typeof cursor.documentPath === 'string' && cursor.documentPath.length <= 512 &&
    path.length === 4 && path[0] === 'drops' && path[2] === 'deliveryOrders' &&
    isCommerceDocumentSegment(path[1]) && isCommerceDocumentSegment(path[3]);
}
