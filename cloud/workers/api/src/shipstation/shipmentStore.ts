import type { ShipStationPackageInput } from '../../../../../shared/shipstationPackage.js';
import { ProfileReadError } from '../dataAccess.js';
import { commerceFieldValue, type CommerceDocumentData } from '../commerceRepository.js';
import { mutateDeliveryOrder } from '../fulfillmentStorePersistence.js';
import type { FulfillmentDeliveryOrderUpdates } from '../fulfillmentDeliveryOrderUpdates.js';
import type { FulfillmentStoreContext } from '../profileWriteCommerce.js';
import { commercePackage, optionalString } from '../profileWriteRates.js';
import { rejectIrlShipStationOrder, shipStationState, SHIPSTATION_CLAIM_TTL_MS } from './state.js';

type ShipStationShipmentClaim =
  | { alreadyAdded: true; shipmentId: string; addedAt?: number }
  | { alreadyAdded: false; claimId: string; order: CommerceDocumentData };

export async function claimFulfillmentShipStationShipment(args: {
  claimId: string;
  common: FulfillmentStoreContext;
  deliveryId: number;
  dropId: string;
  onWriteAttempt: () => void;
  wallet: string;
}): Promise<ShipStationShipmentClaim> {
  return mutateDeliveryOrder<ShipStationShipmentClaim>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ data: order }) => {
      rejectIrlShipStationOrder(order);
      const shipstation = shipStationState(order);
      const shipmentId = optionalString(shipstation.shipmentId);
      if (shipmentId) {
        const addedAt = typeof shipstation.createdAt === 'number' ? shipstation.createdAt : undefined;
        return { value: { alreadyAdded: true, shipmentId, ...(addedAt ? { addedAt } : {}) } };
      }
      const claimedAt = typeof shipstation.claimedAt === 'number' ? shipstation.claimedAt : 0;
      if (claimedAt && args.common.nowMs - claimedAt < SHIPSTATION_CLAIM_TTL_MS) {
        throw new ProfileReadError(
          'aborted',
          409,
          'This order is already being added to ShipStation. Try again in a moment.',
        );
      }
      args.onWriteAttempt();
      return {
        value: { alreadyAdded: false, claimId: args.claimId, order },
        updates: {
          dropId: args.dropId,
          'shipstation.claimId': args.claimId,
          'shipstation.claimedBy': args.wallet,
          'shipstation.claimFenceId': commerceFieldValue.delete(),
          'shipstation.claimedAt': commerceFieldValue.serverTimestamp(),
        } satisfies FulfillmentDeliveryOrderUpdates,
      };
    },
  });
}

export async function transitionFulfillmentShipStationShipmentClaim(args: {
  claimId: string;
  common: FulfillmentStoreContext;
  deliveryId: number;
  dropId: string;
  errorMessage: string;
  retain: boolean;
  wallet: string;
}): Promise<void> {
  await mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ data: order }) => {
      const shipstation = shipStationState(order);
      const currentClaimId = optionalString(shipstation.claimId);
      const currentClaimedBy = optionalString(shipstation.claimedBy);
      if (currentClaimId !== args.claimId || currentClaimedBy !== args.wallet) return { value: undefined };
      const updates: FulfillmentDeliveryOrderUpdates = args.retain
        ? {
            'shipstation.claimId': args.claimId,
            'shipstation.claimedBy': args.wallet,
            'shipstation.claimFenceId': commerceFieldValue.delete(),
            'shipstation.lastError': args.errorMessage,
            'shipstation.claimedAt': commerceFieldValue.serverTimestamp(),
          }
        : {
            'shipstation.claimId': commerceFieldValue.delete(),
            'shipstation.claimedAt': commerceFieldValue.delete(),
            'shipstation.claimedBy': commerceFieldValue.delete(),
            'shipstation.claimFenceId': args.claimId,
            'shipstation.lastError': args.errorMessage,
          };
      return {
        value: undefined,
        updates: {
          ...updates,
          'shipstation.lastErrorAt': commerceFieldValue.serverTimestamp(),
        } satisfies FulfillmentDeliveryOrderUpdates,
      };
    },
  });
}

export async function persistFulfillmentShipStationShipment(args: {
  claimId: string;
  common: FulfillmentStoreContext;
  deliveryId: number;
  dropId: string;
  externalShipmentId: string;
  packageCount: number;
  shipmentId: string;
  storedPackage?: ShipStationPackageInput;
  wallet: string;
}): Promise<void> {
  await mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ data: order }) => {
      const shipstation = shipStationState(order);
      if (
        optionalString(shipstation.claimId) !== args.claimId ||
        optionalString(shipstation.claimedBy) !== args.wallet
      ) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation shipment claim changed. Try again.');
      }
      const currentShipmentId = optionalString(shipstation.shipmentId);
      if (currentShipmentId && currentShipmentId !== args.shipmentId) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
      }
      return {
        value: undefined,
        updates: {
          dropId: args.dropId,
          'shipstation.shipmentId': args.shipmentId,
          'shipstation.externalShipmentId': args.externalShipmentId,
          'shipstation.shipmentNumber': String(args.deliveryId),
          'shipstation.createdBy': args.wallet,
          ...(args.storedPackage ? { 'shipstation.package': commercePackage(args.storedPackage) } : {}),
          'shipstation.packageCount': args.packageCount,
          'shipstation.claimId': commerceFieldValue.delete(),
          'shipstation.claimedAt': commerceFieldValue.delete(),
          'shipstation.claimedBy': commerceFieldValue.delete(),
          'shipstation.claimFenceId': commerceFieldValue.delete(),
          'shipstation.lastError': commerceFieldValue.delete(),
          'shipstation.lastErrorAt': commerceFieldValue.delete(),
          'shipstation.createdAt': commerceFieldValue.serverTimestamp(),
        } satisfies FulfillmentDeliveryOrderUpdates,
      };
    },
  });
}
