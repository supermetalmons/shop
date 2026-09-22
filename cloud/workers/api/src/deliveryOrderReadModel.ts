import { preparedDeliveryRecoveryNextCheckMs, processingDeliveryRecoveryNextCheckMs } from '../../../../shared/deliveryRecovery.js';
import { normalizeFulfillmentStatus, type FulfillmentStatus } from '../../../../shared/fulfillmentStatus.js';
import { normalizeOptionalFulfillmentTrackingCode } from '../../../../shared/fulfillmentTracking.js';
import { storedFulfillmentShipStationLabel } from '../../../../shared/shipstationLabels.js';
import { parseShipStationPackage } from '../../../../shared/shipstationPackage.js';
import type { FulfillmentShipStationLabel } from '../../../../shared/contracts.js';
import type { ShipStationPackageInput } from '../../../../shared/shipstationPackage.js';
import type { CommerceDocumentData, CommerceJsonValue } from './commerceRepositoryTypes.js';
import { isRecord } from './dataAccess.js';
import { optionalString, storedShipStationRateQuotes } from './profileWriteRates.js';

export type DeliveryFulfillmentState = {
  fulfillmentStatus: FulfillmentStatus | undefined;
  fulfillmentTrackingCode: string | undefined;
};

export function parseDeliveryFulfillmentState(order: Record<string, unknown>): DeliveryFulfillmentState {
  return {
    fulfillmentStatus: normalizeFulfillmentStatus(order.fulfillmentStatus),
    fulfillmentTrackingCode: normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode),
  };
}

type DeliveryAddressSnapshot = {
  label?: string;
  email?: string;
  phone?: string;
  country?: string;
  countryCode?: string;
  hint?: string;
  encrypted?: string;
};

export function parseDeliveryAddressSnapshot(order: Record<string, unknown>): DeliveryAddressSnapshot {
  const snapshot = isRecord(order.addressSnapshot) ? order.addressSnapshot : {};
  return {
    ...(typeof snapshot.label === 'string' ? { label: snapshot.label } : {}),
    ...(typeof snapshot.email === 'string' ? { email: snapshot.email } : {}),
    ...(typeof snapshot.phone === 'string' ? { phone: snapshot.phone } : {}),
    ...(typeof snapshot.country === 'string' ? { country: snapshot.country } : {}),
    ...(typeof snapshot.countryCode === 'string' ? { countryCode: snapshot.countryCode } : {}),
    ...(typeof snapshot.hint === 'string' ? { hint: snapshot.hint } : {}),
    ...(typeof snapshot.encrypted === 'string' ? { encrypted: snapshot.encrypted } : {}),
  };
}

export type DeliveryOrderShipStation = {
  shipmentId: string | undefined;
  claimId: string | undefined;
  claimedBy: string | undefined;
  claimFenceId: string | undefined;
  ratesClaimId: string | undefined;
  ratesClaimedBy: string | undefined;
  ratesClaimFenceId: string | undefined;
  createdAt: number | undefined;
  claimedAt: number | undefined;
  ratesClaimedAt: number | undefined;
  labelPurchase: {
    raw: unknown;
    status: string | undefined;
    requestId: string | undefined;
    exactStatus: string | undefined;
    exactRequestId: string | undefined;
  };
  readonly label: FulfillmentShipStationLabel | undefined;
  readonly package: ShipStationPackageInput | undefined;
  readonly packageCount: number;
  readonly rateQuotes: ReturnType<typeof storedShipStationRateQuotes>;
  readonly rateRequest: {
    requestId: string | undefined;
    shipmentId: string | undefined;
    inputHash: string | undefined;
    createdAt: string | undefined;
    package: ShipStationPackageInput | undefined;
    requestedAt: number | undefined;
  };
};

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function parseDeliveryOrderShipStation(order: Record<string, unknown>): DeliveryOrderShipStation {
  const state = isRecord(order.shipstation) ? order.shipstation : {};
  const purchase = isRecord(state.labelPurchase) ? state.labelPurchase : {};
  return {
    shipmentId: optionalString(state.shipmentId),
    claimId: optionalString(state.claimId),
    claimedBy: optionalString(state.claimedBy),
    claimFenceId: optionalString(state.claimFenceId),
    ratesClaimId: optionalString(state.ratesClaimId),
    ratesClaimedBy: optionalString(state.ratesClaimedBy),
    ratesClaimFenceId: optionalString(state.ratesClaimFenceId),
    createdAt: numberValue(state.createdAt),
    claimedAt: numberValue(state.claimedAt),
    ratesClaimedAt: numberValue(state.ratesClaimedAt),
    labelPurchase: {
      raw: state.labelPurchase,
      status: optionalString(purchase.status),
      requestId: optionalString(purchase.requestId),
      exactStatus: typeof purchase.status === 'string' ? purchase.status : undefined,
      exactRequestId: typeof purchase.requestId === 'string' ? purchase.requestId : undefined,
    },
    // Unrelated legacy fields must not trigger coercive validation during other operations.
    get label() {
      return storedFulfillmentShipStationLabel(state.label);
    },
    get package() {
      return parseShipStationPackage(state.package) ?? undefined;
    },
    get packageCount() {
      return Math.max(0, Math.floor(Number(state.packageCount) || 0));
    },
    get rateQuotes() {
      return storedShipStationRateQuotes(state.rateQuotes);
    },
    get rateRequest() {
      const request = isRecord(state.rateRequest) ? state.rateRequest : {};
      return {
        requestId: optionalString(request.requestId),
        shipmentId: optionalString(request.shipmentId),
        inputHash: optionalString(request.inputHash),
        createdAt: optionalString(request.createdAt),
        package: parseShipStationPackage(request.package) ?? undefined,
        requestedAt: numberValue(request.requestedAt),
      };
    },
  };
}

export type DeliveryRecoveryState = {
  status: string | undefined;
  createdAtMs: number | null;
  processingAtMs: number | null;
  lastAttemptAtMs: number | null;
  leaseExpiresAtMs: number | null;
  rawAttemptCount: CommerceJsonValue | undefined;
  rawLastAttemptAt: CommerceJsonValue | undefined;
  rawPreparedProbeCount: CommerceJsonValue | undefined;
  preparedNextCheckAt: (nowMs?: number) => number | null;
  processingNextCheckAt: (nowMs: number) => number | null;
};

function finiteMillis(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseDeliveryRecoveryState(order: CommerceDocumentData): DeliveryRecoveryState {
  const recovery = isRecord(order.receiptRecovery) ? order.receiptRecovery : {};
  return {
    status: typeof order.status === 'string' ? order.status : undefined,
    createdAtMs: finiteMillis(order.createdAt),
    processingAtMs: finiteMillis(order.processingAt),
    lastAttemptAtMs: finiteMillis(recovery.lastAttemptAt),
    leaseExpiresAtMs: finiteMillis(recovery.leaseExpiresAt),
    rawAttemptCount: recovery.attemptCount,
    rawLastAttemptAt: recovery.lastAttemptAt,
    rawPreparedProbeCount: recovery.preparedProbeCount,
    preparedNextCheckAt: (nowMs) => preparedDeliveryRecoveryNextCheckMs(order, nowMs),
    processingNextCheckAt: (nowMs) => processingDeliveryRecoveryNextCheckMs(order, nowMs),
  };
}

export function parseDeliveryOrderOwnership(order: Record<string, unknown>): {
  owner: string | undefined;
  hasOwner: boolean;
} {
  return {
    owner: typeof order.owner === 'string' ? order.owner : undefined,
    hasOwner: Boolean(order.owner),
  };
}

export function parseDeliveryOrderStatus(order: Record<string, unknown>): {
  status: string | undefined;
  source: string | undefined;
} {
  return {
    status: typeof order.status === 'string' ? order.status : undefined,
    source: typeof order.source === 'string' ? order.source : undefined,
  };
}

export function parseDeliveryShipmentItemCounts(order: Record<string, unknown>): {
  boxCount: number;
  looseItemCount: number;
} {
  const items = Array.isArray(order.items) ? order.items : [];
  let boxCount = 0;
  let looseItemCount = 0;
  for (const item of items) {
    if (!isRecord(item) || (item.kind !== 'box' && item.kind !== 'dude')) continue;
    const refId = Math.floor(Number(item.refId));
    if (!Number.isFinite(refId) || refId <= 0) continue;
    if (item.kind === 'box') boxCount += 1;
    else looseItemCount += 1;
  }
  return { boxCount, looseItemCount };
}
