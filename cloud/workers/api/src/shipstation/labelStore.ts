import { normalizeOptionalFulfillmentTrackingCode } from '../../../../../shared/fulfillmentTracking.js';
import {
  isActiveShipStationLabel,
  shipStationTrackingCodeUpdate,
  shouldClearShipStationPurchaseState,
  shouldTransitionShipStationPurchaseState,
  storedFulfillmentShipStationLabel,
  type ShipStationLabelResult,
} from '../../../../../shared/shipstationLabels.js';
import { shipStationMoneyMatches } from '../../../../../shared/shipstationRates.js';
import type { FulfillmentShipStationLabel } from '../../../../../shared/contracts.js';
import { isRecord, ProfileReadError } from '../dataAccess.js';
import {
  commerceFieldValue,
  type CommerceDocumentData,
  type CommerceUpdateValue,
} from '../commerceRepository.js';
import { mutateDeliveryOrder } from '../fulfillmentStorePersistence.js';
import type { FulfillmentStoreContext } from '../profileWriteCommerce.js';
import { commerceMoney, optionalString, storedShipStationRateQuotes } from '../profileWriteRates.js';
import {
  type ShipStationRateMutationExpectation,
  shipStationState,
  requireRateMutationState,
  shipStationLabelIdentity,
  rejectIrlShipStationOrder,
} from './state.js';

type ShipStationLabelPurchaseInput = {
  deliveryId: number;
  rateId: string;
  expectedTotal: { currency: string; amount: number };
  requestId: string;
};

function labelDocumentFields(
  label: FulfillmentShipStationLabel,
  wallet: string,
): CommerceDocumentData {
  if (!label.purchasedAt) throw new ProfileReadError('internal', 500, 'Profile request failed.');
  return {
    labelId: label.labelId,
    shipmentId: label.shipmentId,
    status: label.status,
    ...(label.rateId ? { rateId: label.rateId } : {}),
    ...(label.trackingNumber ? { trackingNumber: label.trackingNumber } : {}),
    ...(label.carrierId ? { carrierId: label.carrierId } : {}),
    ...(label.carrierCode ? { carrierCode: label.carrierCode } : {}),
    ...(label.carrierName ? { carrierName: label.carrierName } : {}),
    ...(label.serviceCode ? { serviceCode: label.serviceCode } : {}),
    ...(label.serviceName ? { serviceName: label.serviceName } : {}),
    ...(label.shipmentCost ? { shipmentCost: commerceMoney(label.shipmentCost) } : {}),
    ...(label.insuranceCost ? { insuranceCost: commerceMoney(label.insuranceCost) } : {}),
    ...(label.totalCost ? { totalCost: commerceMoney(label.totalCost) } : {}),
    ...(label.purchasedBy ? { purchasedBy: label.purchasedBy } : {}),
    purchasedAt: label.purchasedAt,
    recordedBy: wallet,
  };
}

export async function persistFulfillmentShipStationLabel(args: {
  common: FulfillmentStoreContext;
  confirmedPurchase?: boolean;
  deliveryId: number;
  dropId: string;
  expectedCurrentLabel?: FulfillmentShipStationLabel | null;
  expectedPurchaseRequestId?: string;
  expectedRateMutation?: ShipStationRateMutationExpectation;
  fallbackLabel?: Partial<FulfillmentShipStationLabel>;
  result: ShipStationLabelResult;
  wallet: string;
}): Promise<FulfillmentShipStationLabel> {
  const label: FulfillmentShipStationLabel = {
    ...args.fallbackLabel,
    ...args.result.label,
    purchasedAt: args.result.label.purchasedAt || args.fallbackLabel?.purchasedAt || args.common.nowMs,
  };
  const labelFields = labelDocumentFields(label, args.wallet);
  return mutateDeliveryOrder({
    common: args.common,
    dropId: args.dropId,
    deliveryId: args.deliveryId,
    build: ({ fields: order }) => {
      const shipstation = shipStationState(order);
      if (args.expectedRateMutation) requireRateMutationState(order, args.expectedRateMutation);
      if (optionalString(shipstation.shipmentId) !== label.shipmentId) {
        throw new ProfileReadError(
          'aborted',
          409,
          'The ShipStation shipment changed. Refresh the order and try again.',
        );
      }
      const currentLabel = storedFulfillmentShipStationLabel(shipstation.label);
      const currentLabelIdentity = shipStationLabelIdentity(currentLabel);
      if (
        args.expectedPurchaseRequestId
        && currentLabel
        && isActiveShipStationLabel(currentLabel)
        && currentLabelIdentity !== shipStationLabelIdentity(label)
      ) {
        return { value: currentLabel };
      }
      if (args.expectedPurchaseRequestId) {
        const purchase = isRecord(shipstation.labelPurchase) ? shipstation.labelPurchase : {};
        if (!shouldTransitionShipStationPurchaseState(purchase, args.expectedPurchaseRequestId, false)) {
          throw new ProfileReadError('aborted', 409, 'The ShipStation label purchase changed. Check its status again.');
        }
      }
      if (
        args.expectedCurrentLabel !== undefined
        && currentLabelIdentity !== shipStationLabelIdentity(args.expectedCurrentLabel)
        && currentLabelIdentity !== shipStationLabelIdentity(label)
      ) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation label changed. Check its status again.');
      }
      const trackingCodeUpdate = shipStationTrackingCodeUpdate(
        normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode),
        currentLabel,
        label,
      );
      const updates: Record<string, CommerceUpdateValue> = {
        dropId: args.dropId,
        'shipstation.label': labelFields,
        'shipstation.rateQuotes': commerceFieldValue.delete(),
      };
      if (args.expectedRateMutation) {
        updates['shipstation.ratesClaimId'] = commerceFieldValue.delete();
        updates['shipstation.ratesClaimedAt'] = commerceFieldValue.delete();
        updates['shipstation.ratesClaimedBy'] = commerceFieldValue.delete();
      }
      if (trackingCodeUpdate !== undefined) {
        updates.fulfillmentTrackingCode = trackingCodeUpdate || commerceFieldValue.delete();
      }
      if (shouldClearShipStationPurchaseState(label, args.confirmedPurchase)) {
        updates['shipstation.labelPurchase'] = commerceFieldValue.delete();
      }
      return {
        value: label,
        updates,
      };
    },
  });
}

export async function transitionShipStationPurchaseState(args: {
  common: FulfillmentStoreContext;
  deliveryId: number;
  dropId: string;
  expectedRequestId?: string;
  expectedShipmentId: string;
  wallet: string;
}): Promise<{ label?: FulfillmentShipStationLabel; purchaseUnknown: boolean }> {
  return mutateDeliveryOrder<{ label?: FulfillmentShipStationLabel; purchaseUnknown: boolean }>({
    common: args.common,
    dropId: args.dropId,
    deliveryId: args.deliveryId,
    build: ({ fields: order }) => {
      const shipstation = shipStationState(order);
      if (optionalString(shipstation.shipmentId) !== args.expectedShipmentId) {
        throw new ProfileReadError(
          'aborted',
          409,
          'The ShipStation shipment changed. Refresh the order and try again.',
        );
      }
      const label = storedFulfillmentShipStationLabel(shipstation.label);
      if (isActiveShipStationLabel(label)) return { value: { label, purchaseUnknown: false } };
      const purchase = shipstation.labelPurchase;
      const status = isRecord(purchase) && typeof purchase.status === 'string' ? purchase.status : '';
      if (!shouldTransitionShipStationPurchaseState(purchase, args.expectedRequestId, false)) {
        return { value: { purchaseUnknown: status === 'purchasing' || status === 'unknown' } };
      }
      return {
        value: { purchaseUnknown: true },
        updates: {
          'shipstation.labelPurchase.status': 'unknown',
          'shipstation.labelPurchase.checkedBy': args.wallet,
          'shipstation.labelPurchase.checkedAt': commerceFieldValue.serverTimestamp(),
        },
      };
    },
  });
}

type ShipStationLabelPurchaseClaim =
  | { alreadyPurchased: true; label: FulfillmentShipStationLabel }
  | { alreadyPurchased: false };

export async function claimFulfillmentShipStationLabelPurchase(args: {
  body: ShipStationLabelPurchaseInput;
  common: FulfillmentStoreContext;
  dropId: string;
  shipmentId: string;
  wallet: string;
}): Promise<ShipStationLabelPurchaseClaim> {
  return mutateDeliveryOrder<ShipStationLabelPurchaseClaim>({
    common: args.common,
    deliveryId: args.body.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order }) => {
      rejectIrlShipStationOrder(order);
      const shipstation = shipStationState(order);
      if (optionalString(shipstation.shipmentId) !== args.shipmentId) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
      }
      const currentLabel = storedFulfillmentShipStationLabel(shipstation.label);
      if (currentLabel && isActiveShipStationLabel(currentLabel)) {
        return { value: { alreadyPurchased: true, label: currentLabel } };
      }
      const quotedRate = storedShipStationRateQuotes(shipstation.rateQuotes)
        .find((candidate) => candidate.rateId === args.body.rateId);
      if (!quotedRate || quotedRate.shipmentId !== args.shipmentId) {
        throw new ProfileReadError('failed-precondition', 409, 'Refresh rates before purchasing this label.');
      }
      if (!shipStationMoneyMatches(args.body.expectedTotal, quotedRate.totalAmount)) {
        throw new ProfileReadError(
          'failed-precondition',
          409,
          'The selected quote changed. Refresh rates before purchasing.',
        );
      }
      const purchase = isRecord(shipstation.labelPurchase) ? shipstation.labelPurchase : {};
      const status = optionalString(purchase.status) ?? '';
      const previousRequestId = optionalString(purchase.requestId) ?? '';
      if (status === 'purchasing' || status === 'unknown') {
        throw new ProfileReadError(
          'aborted',
          409,
          'A label purchase may already be in progress. Check purchase status before retrying.',
        );
      }
      if (status === 'failed' && previousRequestId === args.body.requestId) {
        throw new ProfileReadError(
          'aborted',
          409,
          'This label purchase request was already handled. Review the purchase again.',
        );
      }
      return {
        value: { alreadyPurchased: false },
        updates: {
          'shipstation.labelPurchase.status': 'purchasing',
          'shipstation.labelPurchase.requestId': args.body.requestId,
          'shipstation.labelPurchase.rateId': args.body.rateId,
          'shipstation.labelPurchase.expectedTotal': commerceMoney(args.body.expectedTotal),
          'shipstation.labelPurchase.claimedBy': args.wallet,
          'shipstation.labelPurchase.lastError': commerceFieldValue.delete(),
          'shipstation.labelPurchase.lastErrorAt': commerceFieldValue.delete(),
          'shipstation.labelPurchase.lastErrorBy': commerceFieldValue.delete(),
          'shipstation.labelPurchase.checkedAt': commerceFieldValue.delete(),
          'shipstation.labelPurchase.checkedBy': commerceFieldValue.delete(),
          'shipstation.labelPurchase.claimedAt': commerceFieldValue.serverTimestamp(),
        },
      };
    },
  });
}

export async function transitionFulfillmentShipStationLabelPurchase(args: {
  body: ShipStationLabelPurchaseInput;
  common: FulfillmentStoreContext;
  dropId: string;
  message: string;
  nextStatus: 'unknown' | 'failed';
  shipmentId: string;
  wallet: string;
}): Promise<{ label?: FulfillmentShipStationLabel; purchaseUnknown: boolean }> {
  return mutateDeliveryOrder<{ label?: FulfillmentShipStationLabel; purchaseUnknown: boolean }>({
    common: args.common,
    deliveryId: args.body.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order }) => {
      const shipstation = shipStationState(order);
      if (optionalString(shipstation.shipmentId) !== args.shipmentId) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
      }
      const label = storedFulfillmentShipStationLabel(shipstation.label);
      if (isActiveShipStationLabel(label)) return { value: { label, purchaseUnknown: false } };
      const purchase = isRecord(shipstation.labelPurchase) ? shipstation.labelPurchase : {};
      const status = optionalString(purchase.status) ?? '';
      if (!shouldTransitionShipStationPurchaseState(purchase, args.body.requestId, false)) {
        return { value: { purchaseUnknown: status === 'purchasing' || status === 'unknown' } };
      }
      return {
        value: { purchaseUnknown: args.nextStatus === 'unknown' },
        updates: {
          'shipstation.labelPurchase.status': args.nextStatus,
          'shipstation.labelPurchase.requestId': args.body.requestId,
          'shipstation.labelPurchase.rateId': args.body.rateId,
          'shipstation.labelPurchase.expectedTotal': commerceMoney(args.body.expectedTotal),
          'shipstation.labelPurchase.lastError': args.message.slice(0, 500),
          'shipstation.labelPurchase.lastErrorBy': args.wallet,
          'shipstation.labelPurchase.lastErrorAt': commerceFieldValue.serverTimestamp(),
        },
      };
    },
  });
}
