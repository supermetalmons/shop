import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../../../../shared/fulfillmentSources.js';
import { storedFulfillmentShipStationLabel } from '../../../../../shared/shipstationLabels.js';
import { isRecord, ProfileReadError } from '../dataAccess.js';
import { optionalString } from '../profileWriteRates.js';

export const SHIPSTATION_CLAIM_TTL_MS = 120_000;

export function rejectIrlShipStationOrder(order: Record<string, unknown>): void {
  if (order.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) {
    throw new ProfileReadError('failed-precondition', 409, 'In-person redemption orders do not have a delivery address');
  }
}

export function shipStationState(order: Record<string, unknown>): Record<string, unknown> {
  return isRecord(order.shipstation) ? order.shipstation : {};
}

export function requireShipStationShipmentId(order: Record<string, unknown>): string {
  const shipmentId = optionalString(shipStationState(order).shipmentId);
  if (!shipmentId) {
    throw new ProfileReadError('failed-precondition', 409, 'Add this order to ShipStation before getting rates.');
  }
  return shipmentId;
}

export type ShipStationRateMutationExpectation = {
  claimId: string | null;
  claimedBy: string | null;
  labelIdentity: string;
  purchaseIdentity: string;
  shipmentId: string;
};

export function shipStationLabelIdentity(value: unknown): string {
  const label = storedFulfillmentShipStationLabel(value);
  return label ? JSON.stringify([
    label.labelId,
    label.shipmentId,
    label.status,
    label.rateId ?? null,
    label.trackingNumber ?? null,
    label.carrierId ?? null,
    label.carrierCode ?? null,
    label.carrierName ?? null,
    label.serviceCode ?? null,
    label.serviceName ?? null,
    label.shipmentCost?.currency ?? null,
    label.shipmentCost?.amount ?? null,
    label.insuranceCost?.currency ?? null,
    label.insuranceCost?.amount ?? null,
    label.totalCost?.currency ?? null,
    label.totalCost?.amount ?? null,
    label.purchasedAt ?? null,
    label.purchasedBy ?? null,
  ]) : '';
}

function shipStationPurchaseIdentity(shipstation: Record<string, unknown>): string {
  const purchase = isRecord(shipstation.labelPurchase) ? shipstation.labelPurchase : {};
  return `${optionalString(purchase.status) ?? ''}\n${optionalString(purchase.requestId) ?? ''}`;
}

export function rateMutationExpectation(
  order: Record<string, unknown>,
  shipmentId: string,
  claim?: { claimId: string; wallet: string },
): ShipStationRateMutationExpectation {
  const shipstation = shipStationState(order);
  return {
    shipmentId,
    labelIdentity: shipStationLabelIdentity(shipstation.label),
    purchaseIdentity: shipStationPurchaseIdentity(shipstation),
    claimId: claim?.claimId ?? optionalString(shipstation.ratesClaimId) ?? null,
    claimedBy: claim?.wallet ?? optionalString(shipstation.ratesClaimedBy) ?? null,
  };
}

export function requireRateMutationState(
  order: Record<string, unknown>,
  expected: ShipStationRateMutationExpectation,
): Record<string, unknown> {
  const shipstation = shipStationState(order);
  if (optionalString(shipstation.shipmentId) !== expected.shipmentId) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
  }
  if (shipStationLabelIdentity(shipstation.label) !== expected.labelIdentity) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation label changed. Check its status again.');
  }
  if (shipStationPurchaseIdentity(shipstation) !== expected.purchaseIdentity) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation label purchase changed. Check its status again.');
  }
  if (
    (optionalString(shipstation.ratesClaimId) ?? null) !== expected.claimId ||
    (optionalString(shipstation.ratesClaimedBy) ?? null) !== expected.claimedBy
  ) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation rate refresh claim changed. Try again.');
  }
  return shipstation;
}
