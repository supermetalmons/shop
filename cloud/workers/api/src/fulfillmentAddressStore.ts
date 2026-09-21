import {
  isActiveShipStationLabel,
  storedFulfillmentShipStationLabel,
} from '../../../../shared/shipstationLabels.js';
import type { FulfillmentOrderAddress, UpdateFulfillmentAddressResponse } from '../../../../shared/contracts.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import { commerceFieldValue } from './commerceRepository.js';
import { mutateDeliveryOrder } from './fulfillmentStorePersistence.js';
import type { FulfillmentStoreContext } from './profileWriteCommerce.js';
import { optionalString } from './profileWriteRates.js';
import { rejectIrlShipStationOrder, shipStationState, SHIPSTATION_CLAIM_TTL_MS } from './shipstation/state.js';

export async function setFulfillmentAddress(args: {
  common: FulfillmentStoreContext;
  deliveryId: number;
  dropId: string;
  full: string;
  encrypted: string;
  hint: string;
  wallet: string;
}): Promise<UpdateFulfillmentAddressResponse> {
  return mutateDeliveryOrder<UpdateFulfillmentAddressResponse>({
    common: args.common,
    dropId: args.dropId,
    deliveryId: args.deliveryId,
    build: ({ fields: order }) => {
      rejectIrlShipStationOrder(order);
      const shipstation = shipStationState(order);
      if (optionalString(shipstation.shipmentId)) {
        throw new ProfileReadError(
          'failed-precondition',
          409,
          'This order is already in ShipStation. Update its delivery address in ShipStation.',
        );
      }
      if (isActiveShipStationLabel(storedFulfillmentShipStationLabel(shipstation.label))) {
        throw new ProfileReadError(
          'failed-precondition',
          409,
          'This order already has a ShipStation label. Void it before changing the delivery address.',
        );
      }
      const labelPurchase = isRecord(shipstation.labelPurchase) ? shipstation.labelPurchase : {};
      const purchaseStatus = typeof labelPurchase.status === 'string' ? labelPurchase.status : '';
      if (purchaseStatus === 'purchasing' || purchaseStatus === 'unknown') {
        throw new ProfileReadError(
          'aborted',
          409,
          'Check the ShipStation label purchase status before editing this address.',
        );
      }
      const shipmentClaimedAt = typeof shipstation.claimedAt === 'number' ? shipstation.claimedAt : 0;
      if (shipmentClaimedAt && args.common.nowMs - shipmentClaimedAt < SHIPSTATION_CLAIM_TTL_MS) {
        throw new ProfileReadError(
          'aborted',
          409,
          'This order is being added to ShipStation. Try editing the address again in a moment.',
        );
      }
      const ratesClaimedAt = typeof shipstation.ratesClaimedAt === 'number' ? shipstation.ratesClaimedAt : 0;
      if (ratesClaimedAt && args.common.nowMs - ratesClaimedAt < SHIPSTATION_CLAIM_TTL_MS) {
        throw new ProfileReadError(
          'aborted',
          409,
          'ShipStation rates are being refreshed. Try editing the address again in a moment.',
        );
      }
      const snapshot = isRecord(order.addressSnapshot) ? order.addressSnapshot : {};
      const address: FulfillmentOrderAddress = {
        full: args.full,
        encrypted: args.encrypted,
        hint: args.hint,
        ...(typeof snapshot.label === 'string' ? { label: snapshot.label } : {}),
        ...(typeof snapshot.email === 'string' ? { email: snapshot.email } : {}),
        ...(typeof snapshot.phone === 'string' ? { phone: snapshot.phone } : {}),
        ...(typeof snapshot.country === 'string' ? { country: snapshot.country } : {}),
        ...(typeof snapshot.countryCode === 'string' ? { countryCode: snapshot.countryCode } : {}),
      };
      return {
        value: { deliveryId: args.deliveryId, address },
        updates: {
          'addressSnapshot.encrypted': args.encrypted,
          'addressSnapshot.hint': args.hint,
          fulfillmentAddressUpdatedBy: args.wallet,
          fulfillmentAddressUpdatedAt: commerceFieldValue.serverTimestamp(),
          'shipstation.rateQuotes': commerceFieldValue.delete(),
          'shipstation.ratesClaimId': commerceFieldValue.delete(),
          'shipstation.ratesClaimedAt': commerceFieldValue.delete(),
          'shipstation.ratesClaimedBy': commerceFieldValue.delete(),
        },
      };
    },
  });
}
