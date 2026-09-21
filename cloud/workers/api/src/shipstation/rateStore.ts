import { parseDeliveryOrderShipStation } from '../deliveryOrderReadModel.js';
import { isActiveShipStationLabel } from '../../../../../shared/shipstationLabels.js';
import type { ShipStationPackageInput } from '../../../../../shared/shipstationPackage.js';
import type { GetFulfillmentShipStationRatesResponse } from '../../../../../shared/contracts.js';
import { ProfileReadError } from '../dataAccess.js';
import { commerceFieldValue, type CommerceDocumentData } from '../commerceRepository.js';
import { mutateDeliveryOrder } from '../fulfillmentStorePersistence.js';
import type { FulfillmentDeliveryOrderUpdates } from '../fulfillmentDeliveryOrderUpdates.js';
import type { FulfillmentStoreContext } from '../profileWriteCommerce.js';
import { commercePackage, commerceRateQuotes } from '../profileWriteRates.js';
import {
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
      const shipstation = requireRateMutationState(order, args.expected);
      if (isActiveShipStationLabel(shipstation.label)) {
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
      const shipstation = parseDeliveryOrderShipStation(order);
      if (shipstation.shipmentId !== args.shipmentId) return { value: undefined };
      const currentClaimId = shipstation.ratesClaimId;
      if (currentClaimId && (
        currentClaimId !== args.claimId || shipstation.ratesClaimedBy !== args.wallet
      )) {
        return { value: undefined };
      }
      if (!currentClaimId && shipstation.ratesClaimFenceId === args.claimId) {
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
      const currentPurchaseStatus = currentShipstation.labelPurchase.status;
      if (currentPurchaseStatus === 'purchasing' || currentPurchaseStatus === 'unknown') {
        throw new ProfileReadError('aborted', 409, 'A label purchase may already be in progress. Check purchase status first.');
      }
      if (isActiveShipStationLabel(currentShipstation.label)) {
        throw new ProfileReadError('failed-precondition', 409, 'This shipment already has a label.');
      }
      const claimedAt = currentShipstation.ratesClaimedAt ?? 0;
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
      const shipstation = requireRateMutationState(currentOrder, args.expected);
      if (isActiveShipStationLabel(shipstation.label)) {
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
