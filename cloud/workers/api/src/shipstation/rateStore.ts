import {
  isActiveShipStationLabel,
  storedFulfillmentShipStationLabel,
} from '../../../../../shared/shipstationLabels.js';
import type { ShipStationPackageInput } from '../../../../../shared/shipstationPackage.js';
import type { GetFulfillmentShipStationRatesResponse } from '../../../../../shared/contracts.js';
import { isRecord, ProfileReadError } from '../dataAccess.js';
import { commerceFieldValue, type CommerceDocumentData } from '../commerceRepository.js';
import { mutateDeliveryOrder } from '../fulfillmentStorePersistence.js';
import type { FulfillmentDeliveryOrderUpdates } from '../fulfillmentDeliveryOrderUpdates.js';
import type { FulfillmentStoreContext } from '../profileWriteCommerce.js';
import { commercePackage, commerceRateQuotes, optionalString } from '../profileWriteRates.js';
import {
  shipStationState,
  type ShipStationRateMutationExpectation,
  requireRateMutationState,
  SHIPSTATION_CLAIM_TTL_MS,
} from './state.js';

export async function persistUnsupportedShipStationPackageCount(args: {
  common: FulfillmentStoreContext;
  deliveryId: number;
  dropId: string;
  expected: ShipStationRateMutationExpectation;
  packageCount: number;
}): Promise<void> {
  await mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ data: order }) => {
      requireRateMutationState(order, args.expected);
      return {
        value: undefined,
        updates: {
          'shipstation.packageCount': args.packageCount,
          'shipstation.package': commerceFieldValue.delete(),
          'shipstation.rateQuotes': commerceFieldValue.delete(),
          'shipstation.rateRequest': commerceFieldValue.delete(),
          'shipstation.ratesClaimId': commerceFieldValue.delete(),
          'shipstation.ratesClaimedAt': commerceFieldValue.delete(),
          'shipstation.ratesClaimedBy': commerceFieldValue.delete(),
        } satisfies FulfillmentDeliveryOrderUpdates,
      };
    },
  });
}

export async function persistPendingShipStationRateRequest(args: {
  common: FulfillmentStoreContext;
  deliveryId: number;
  dropId: string;
  expected: ShipStationRateMutationExpectation;
  inputHash: string;
  package: ShipStationPackageInput;
  request: { requestId: string; createdAt?: string };
  shipmentId: string;
}): Promise<void> {
  await mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ data: order }) => {
      requireRateMutationState(order, args.expected);
      if (isActiveShipStationLabel(storedFulfillmentShipStationLabel(shipStationState(order).label))) {
        throw new ProfileReadError('failed-precondition', 409, 'This shipment already has a label.');
      }
      return {
        value: undefined,
        updates: {
          'shipstation.rateRequest.requestId': args.request.requestId,
          'shipstation.rateRequest.createdAt': args.request.createdAt || commerceFieldValue.delete(),
          'shipstation.rateRequest.shipmentId': args.shipmentId,
          'shipstation.rateRequest.inputHash': args.inputHash,
          'shipstation.rateRequest.package': commercePackage(args.package),
          'shipstation.rateRequest.requestedAt': commerceFieldValue.serverTimestamp(),
        } satisfies FulfillmentDeliveryOrderUpdates,
      };
    },
  });
}

export async function releaseShipStationRatesClaim(args: {
  claimId: string;
  common: FulfillmentStoreContext;
  deliveryId: number;
  dropId: string;
  shipmentId: string;
  wallet: string;
}): Promise<void> {
  return mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ data: order }) => {
      const shipstation = shipStationState(order);
      if (optionalString(shipstation.shipmentId) !== args.shipmentId) return { value: undefined };
      const currentClaimId = optionalString(shipstation.ratesClaimId);
      if (currentClaimId && (
        currentClaimId !== args.claimId || optionalString(shipstation.ratesClaimedBy) !== args.wallet
      )) {
        return { value: undefined };
      }
      if (!currentClaimId && optionalString(shipstation.ratesClaimFenceId) === args.claimId) {
        return { value: undefined };
      }
      const updates: FulfillmentDeliveryOrderUpdates = currentClaimId
        ? {
            'shipstation.ratesClaimId': commerceFieldValue.delete(),
            'shipstation.ratesClaimedAt': commerceFieldValue.delete(),
            'shipstation.ratesClaimedBy': commerceFieldValue.delete(),
            'shipstation.ratesClaimFenceId': commerceFieldValue.delete(),
          }
        : { 'shipstation.ratesClaimFenceId': args.claimId };
      return {
        value: undefined,
        updates,
      };
    },
  });
}

export async function claimShipStationRateRefresh(args: {
  common: FulfillmentStoreContext;
  deliveryId: number;
  dropId: string;
  expected: ShipStationRateMutationExpectation;
  claimId: string;
  wallet: string;
  onWriteAttempt: () => void;
}): Promise<CommerceDocumentData> {
  return mutateDeliveryOrder<CommerceDocumentData>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ data: currentOrder }) => {
      const currentShipstation = requireRateMutationState(currentOrder, args.expected);
      const currentPurchase = isRecord(currentShipstation.labelPurchase) ? currentShipstation.labelPurchase : {};
      const currentPurchaseStatus = optionalString(currentPurchase.status);
      if (currentPurchaseStatus === 'purchasing' || currentPurchaseStatus === 'unknown') {
        throw new ProfileReadError('aborted', 409, 'A label purchase may already be in progress. Check purchase status first.');
      }
      if (isActiveShipStationLabel(storedFulfillmentShipStationLabel(currentShipstation.label))) {
        throw new ProfileReadError('failed-precondition', 409, 'This shipment already has a label.');
      }
      const claimedAt = typeof currentShipstation.ratesClaimedAt === 'number'
        ? currentShipstation.ratesClaimedAt
        : 0;
      if (claimedAt && args.common.nowMs - claimedAt < SHIPSTATION_CLAIM_TTL_MS) {
        throw new ProfileReadError('aborted', 409, 'Rates are already being refreshed for this shipment. Try again in a moment.');
      }
      args.onWriteAttempt();
      return {
        value: currentOrder,
        updates: {
          'shipstation.rateQuotes': commerceFieldValue.delete(),
          'shipstation.ratesClaimId': args.claimId,
          'shipstation.ratesClaimedBy': args.wallet,
          'shipstation.ratesClaimFenceId': commerceFieldValue.delete(),
          'shipstation.ratesClaimedAt': commerceFieldValue.serverTimestamp(),
        } satisfies FulfillmentDeliveryOrderUpdates,
      };
    },
  });
}

export async function persistShipStationRatePackage(args: {
  common: FulfillmentStoreContext;
  deliveryId: number;
  dropId: string;
  expected: ShipStationRateMutationExpectation;
  package: ShipStationPackageInput;
}): Promise<void> {
  return mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ data: currentOrder }) => {
      requireRateMutationState(currentOrder, args.expected);
      return {
        value: undefined,
        updates: {
          'shipstation.package': commercePackage(args.package),
          'shipstation.packageCount': 1,
        } satisfies FulfillmentDeliveryOrderUpdates,
      };
    },
  });
}

export async function completeShipStationRateRefresh(args: {
  common: FulfillmentStoreContext;
  deliveryId: number;
  dropId: string;
  expected: ShipStationRateMutationExpectation;
  package: ShipStationPackageInput;
  rates: GetFulfillmentShipStationRatesResponse['rates'];
  wallet: string;
}): Promise<void> {
  return mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ data: currentOrder }) => {
      requireRateMutationState(currentOrder, args.expected);
      if (isActiveShipStationLabel(storedFulfillmentShipStationLabel(shipStationState(currentOrder).label))) {
        throw new ProfileReadError('failed-precondition', 409, 'This shipment already has a label.');
      }
      return {
        value: undefined,
        updates: {
          'shipstation.package': commercePackage(args.package),
          'shipstation.packageCount': 1,
          'shipstation.rateQuotes': commerceRateQuotes(args.rates),
          'shipstation.rateRequest': commerceFieldValue.delete(),
          'shipstation.ratesUpdatedBy': args.wallet,
          'shipstation.ratesClaimId': commerceFieldValue.delete(),
          'shipstation.ratesClaimedAt': commerceFieldValue.delete(),
          'shipstation.ratesClaimedBy': commerceFieldValue.delete(),
          'shipstation.ratesUpdatedAt': commerceFieldValue.serverTimestamp(),
        } satisfies FulfillmentDeliveryOrderUpdates,
      };
    },
  });
}
