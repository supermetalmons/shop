import {
  isPositiveSafeInteger,
  parseCanonicalPositiveInteger,
} from '../../../../shared/positiveInteger.js';

export type DropDeliveryOrderPathIdentity = {
  dropId: string;
  documentId: string;
  deliveryId: number;
};

export function parseDropDeliveryOrderPath(path: string): DropDeliveryOrderPathIdentity | null {
  const parts = String(path || '').split('/');
  if (parts.length !== 4 || parts[0] !== 'drops' || !parts[1] || parts[2] !== 'deliveryOrders') {
    return null;
  }
  const deliveryId = parseCanonicalPositiveInteger(parts[3]);
  return deliveryId === null
    ? null
    : { dropId: parts[1], documentId: parts[3], deliveryId };
}

function dropRootPath(dropId: string): string {
  return `drops/${dropId}`;
}

function dropDeliveryOrdersCollectionPath(dropId: string): string {
  return `${dropRootPath(dropId)}/deliveryOrders`;
}

export function dropDeliveryOrderPath(dropId: string, deliveryId: number): string {
  if (!isPositiveSafeInteger(deliveryId)) {
    throw new Error('Delivery id must be a positive safe integer');
  }
  return `${dropDeliveryOrdersCollectionPath(dropId)}/${deliveryId}`;
}

export function dropAdminIrlRedeemRequestPath(dropId: string, requestId: string): string {
  return `${dropRootPath(dropId)}/adminIrlRedeemRequests/${requestId}`;
}

export function dropAdminIrlRedeemReceiptMarkerPath(dropId: string, receiptAssetId: string): string {
  return `${dropRootPath(dropId)}/adminIrlRedeemReceiptMarkers/${receiptAssetId}`;
}
