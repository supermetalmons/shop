import { parseDeliveryFulfillmentState, parseDeliveryOrderShipStation } from '../deliveryOrderReadModel.js';
import {
  isActiveShipStationLabel,
  shipStationTrackingCodeUpdate,
  shouldClearShipStationPurchaseState,
  shouldTransitionShipStationPurchaseState,
  type ShipStationLabelResult,
} from '../../../../../shared/shipstationLabels.js';
import { shipStationMoneyMatches } from '../../../../../shared/shipstationRates.js';
import type { FulfillmentShipStationLabel } from '../../../../../shared/contracts.js';
import { ProfileReadError } from '../dataAccess.js';
import { commerceFieldValue } from '../commerceRepository.js';
import { mutateDeliveryOrder } from '../fulfillmentStorePersistence.js';
import type { FulfillmentDeliveryOrderUpdates } from '../fulfillmentDeliveryOrderUpdates.js';
import type { FulfillmentStoreContext } from '../profileWriteCommerce.js';
import { commerceMoney } from '../profileWriteRates.js';
import {
  type ShipStationRateMutationExpectation,
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
): NonNullable<FulfillmentDeliveryOrderUpdates['shipstation.label']> {
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
    build: ({ data: order }) => {
      const shipstation = parseDeliveryOrderShipStation(order);
      if (args.expectedRateMutation) requireRateMutationState(order, args.expectedRateMutation);
      if (shipstation.shipmentId !== label.shipmentId) {
        throw new ProfileReadError(
          'aborted',
          409,
          'The ShipStation shipment changed. Refresh the order and try again.',
        );
      }
      const currentLabel = shipstation.label;
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
        const purchase = shipstation.labelPurchase;
        if (!shouldTransitionShipStationPurchaseState(purchase.raw, args.expectedPurchaseRequestId, false)) {
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
        parseDeliveryFulfillmentState(order).fulfillmentTrackingCode,
        currentLabel,
        label,
      );
      const updates: FulfillmentDeliveryOrderUpdates = {
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
    build: ({ data: order }) => {
      const shipstation = parseDeliveryOrderShipStation(order);
      if (shipstation.shipmentId !== args.expectedShipmentId) {
        throw new ProfileReadError(
          'aborted',
          409,
          'The ShipStation shipment changed. Refresh the order and try again.',
        );
      }
      const label = shipstation.label;
      if (isActiveShipStationLabel(label)) return { value: { label, purchaseUnknown: false } };
      const purchase = shipstation.labelPurchase;
      const status = purchase.exactStatus ?? '';
      if (!shouldTransitionShipStationPurchaseState(purchase.raw, args.expectedRequestId, false)) {
        return { value: { purchaseUnknown: status === 'purchasing' || status === 'unknown' } };
      }
      return {
        value: { purchaseUnknown: true },
        updates: {
          'shipstation.labelPurchase.status': 'unknown',
          'shipstation.labelPurchase.checkedBy': args.wallet,
          'shipstation.labelPurchase.checkedAt': commerceFieldValue.serverTimestamp(),
        } satisfies FulfillmentDeliveryOrderUpdates,
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
    build: ({ data: order }) => {
      rejectIrlShipStationOrder(order);
      const shipstation = parseDeliveryOrderShipStation(order);
      if (shipstation.shipmentId !== args.shipmentId) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
      }
      const currentLabel = shipstation.label;
      if (currentLabel && isActiveShipStationLabel(currentLabel)) {
        return { value: { alreadyPurchased: true, label: currentLabel } };
      }
      const quotedRate = shipstation.rateQuotes
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
      const purchase = shipstation.labelPurchase;
      const status = purchase.status ?? '';
      const previousRequestId = purchase.requestId ?? '';
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
        } satisfies FulfillmentDeliveryOrderUpdates,
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
    build: ({ data: order }) => {
      const shipstation = parseDeliveryOrderShipStation(order);
      if (shipstation.shipmentId !== args.shipmentId) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
      }
      const label = shipstation.label;
      if (isActiveShipStationLabel(label)) return { value: { label, purchaseUnknown: false } };
      const purchase = shipstation.labelPurchase;
      const status = purchase.status ?? '';
      if (!shouldTransitionShipStationPurchaseState(purchase.raw, args.body.requestId, false)) {
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
        } satisfies FulfillmentDeliveryOrderUpdates,
      };
    },
  });
}
