import { z } from 'zod';
import { normalizeOptionalFulfillmentTrackingCode } from '../../../../../shared/fulfillmentTracking.js';
import {
  adoptOrPurchaseShipStationLabel,
  createShipStationLabelFromRate,
  getShipStationLabelById,
  isActiveShipStationLabel,
  listShipStationLabelsForShipment,
  shipStationTrackingCodeUpdate,
  shouldClearShipStationPurchaseState,
  shouldTransitionShipStationPurchaseState,
  storedFulfillmentShipStationLabel,
  ShipStationLabelProviderError,
  type ShipStationLabelResult,
  voidShipStationLabel,
} from '../../../../../shared/shipstationLabels.js';
import {
  getShipStationRateById,
  shipStationMoneyMatches,
  ShipStationRatesProviderError,
} from '../../../../../shared/shipstationRates.js';
import type {
  FulfillmentShipStationLabel,
  GetFulfillmentShipStationLabelResponse,
  PurchaseFulfillmentShipStationLabelResponse,
  VoidFulfillmentShipStationLabelResponse,
} from '../../../../../shared/contracts.js';
import { isSignalCancellationError } from '../boundedRequest.js';
import {
  isRecord,
  ProfileReadError,
} from '../dataAccess.js';
import {
  commerceFieldValue,
  type CommerceDocumentData,
  type CommerceUpdateValue,
} from '../commerceRepository.js';
import {
  loadDeliveryOrderDocument,
  mutateDeliveryOrder,
  type CommerceWriteCommon,
} from '../profileWriteCommerce.js';
import {
  commerceMoney,
  optionalString,
  storedShipStationRateQuotes,
} from '../profileWriteRates.js';
import {
  type ShipStationRateMutationExpectation,
  shipStationState,
  requireRateMutationState,
  shipStationLabelIdentity,
  profileErrorForShipStation,
  supportedDropId,
  requireFulfillmentAccess,
  ShipStationProfileError,
  rejectIrlShipStationOrder,
  requireShipStationShipmentId,
  clientCancellationReason,
} from './common.js';
import {
  type ProfileWriteOperationContext,
  defineProfileWriteOperation,
} from '../profileWriteOperation.js';

const FULFILLMENT_SHIPSTATION_LABEL_PATH = '/fulfillment/shipstation-label';
const FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH = '/fulfillment/shipstation-label-purchase';
const FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH = '/fulfillment/shipstation-label-void';
const SHIPSTATION_LABEL_OPERATION_TIMEOUT_MS = 45_000;
const SHIPSTATION_LABEL_PURCHASE_OPERATION_TIMEOUT_MS = 55_000;
const SHIPSTATION_LABEL_PURCHASE_CLEANUP_TIMEOUT_MS = 5_000;
const SHIPSTATION_LABEL_VOID_OPERATION_TIMEOUT_MS = 45_000;
const SHIPSTATION_LABEL_VOID_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_SHIPSTATION_LABEL_REQUEST_BYTES = 2048;
const MAX_SHIPSTATION_LABEL_PURCHASE_REQUEST_BYTES = 4096;
const MAX_SHIPSTATION_LABEL_VOID_REQUEST_BYTES = 2048;
const shipStationLabelSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

const shipStationLabelPurchaseSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  rateId: z.string().trim().min(1).max(64),
  expectedTotal: z.object({
    currency: z.string().trim().toLowerCase().regex(/^[a-z]{3}$/),
    amount: z.number().finite().nonnegative(),
  }).strict(),
  requestId: z.string().uuid(),
}).strict();

const shipStationLabelVoidSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  labelId: z.string().trim().min(1).max(64),
}).strict();

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

async function persistFulfillmentShipStationLabel(args: {
  common: CommerceWriteCommon;
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

async function transitionShipStationPurchaseState(args: {
  common: CommerceWriteCommon;
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

type ReconciledShipStationLabel = {
  active?: FulfillmentShipStationLabel;
  downloadUrl?: string;
  inactive?: FulfillmentShipStationLabel;
};

function regressesVoidedShipStationLabel(
  current: FulfillmentShipStationLabel | undefined,
  next: FulfillmentShipStationLabel,
): boolean {
  return current?.status === 'voided' && current.labelId === next.labelId && next.status !== 'voided';
}

export async function reconcileFulfillmentShipStationLabel(args: {
  apiKey: string;
  common: CommerceWriteCommon;
  deliveryId: number;
  dropId: string;
  expectedPurchaseRequestId?: string;
  expectedRateMutation?: ShipStationRateMutationExpectation;
  order: Record<string, unknown>;
  refreshInactiveStoredLabel: boolean;
  shipmentId: string;
  wallet: string;
}): Promise<ReconciledShipStationLabel> {
  const storedLabel = storedFulfillmentShipStationLabel(shipStationState(args.order).label);
  let inactive: FulfillmentShipStationLabel | undefined;
  try {
    if (storedLabel?.labelId && (args.refreshInactiveStoredLabel || isActiveShipStationLabel(storedLabel))) {
      const result = await getShipStationLabelById(args.apiKey, storedLabel.labelId, {
        fetch: args.common.providerFetch,
        signal: args.common.signal,
      });
      if (regressesVoidedShipStationLabel(storedLabel, result.label)) {
        inactive = storedLabel;
      } else {
        const label = await persistFulfillmentShipStationLabel({
          common: args.common,
          deliveryId: args.deliveryId,
          dropId: args.dropId,
          expectedCurrentLabel: storedLabel,
          ...(args.expectedPurchaseRequestId ? { expectedPurchaseRequestId: args.expectedPurchaseRequestId } : {}),
          ...(args.expectedRateMutation ? { expectedRateMutation: args.expectedRateMutation } : {}),
          fallbackLabel: storedLabel,
          result,
          wallet: args.wallet,
        });
        if (isActiveShipStationLabel(label)) {
          return { active: label, ...(result.downloadUrl ? { downloadUrl: result.downloadUrl } : {}) };
        }
        inactive = label;
      }
    }
    const adopted = (await listShipStationLabelsForShipment(args.apiKey, args.shipmentId, {
      fetch: args.common.providerFetch,
      signal: args.common.signal,
    })).find((candidate) => !regressesVoidedShipStationLabel(inactive ?? storedLabel, candidate.label));
    if (adopted) {
      const label = await persistFulfillmentShipStationLabel({
        common: args.common,
        deliveryId: args.deliveryId,
        dropId: args.dropId,
        expectedCurrentLabel: inactive ?? storedLabel ?? null,
        ...(args.expectedPurchaseRequestId ? { expectedPurchaseRequestId: args.expectedPurchaseRequestId } : {}),
        ...(args.expectedRateMutation ? { expectedRateMutation: args.expectedRateMutation } : {}),
        result: adopted,
        wallet: args.wallet,
      });
      return { active: label, ...(adopted.downloadUrl ? { downloadUrl: adopted.downloadUrl } : {}) };
    }
    return { ...(inactive ? { inactive } : {}) };
  } catch (error) {
    if (error instanceof ShipStationLabelProviderError) throw profileErrorForShipStation(error);
    throw error;
  }
}

async function getFulfillmentShipStationLabel(
  body: z.infer<typeof shipStationLabelSchema>,
  wallet: string,
  common: CommerceWriteCommon,
  apiKey: string,
): Promise<GetFulfillmentShipStationLabelResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  if (!apiKey) {
    throw new ShipStationProfileError('failed-precondition', 409, 'ShipStation API key is not configured');
  }
  const initial = await loadDeliveryOrderDocument(common, dropId, body.deliveryId);
  const order = initial.fields;
  rejectIrlShipStationOrder(order);
  const shipmentId = requireShipStationShipmentId(order);
  const reconciled = await reconcileFulfillmentShipStationLabel({
    apiKey,
    common,
    deliveryId: body.deliveryId,
    dropId,
    order,
    refreshInactiveStoredLabel: true,
    shipmentId,
    wallet,
  });
  if (reconciled.active) {
    return {
      deliveryId: body.deliveryId,
      shipmentId,
      label: reconciled.active,
      ...(reconciled.downloadUrl ? { labelDownloadUrl: reconciled.downloadUrl } : {}),
    };
  }
  const purchase = shipStationState(order).labelPurchase;
  const purchaseStatus = isRecord(purchase) && typeof purchase.status === 'string' ? purchase.status : '';
  const purchaseRequestId = isRecord(purchase) && typeof purchase.requestId === 'string'
    ? purchase.requestId
    : undefined;
  const resolvedPurchase = purchaseStatus === 'purchasing'
    ? await transitionShipStationPurchaseState({
        common,
        deliveryId: body.deliveryId,
        dropId,
        expectedRequestId: purchaseRequestId,
        expectedShipmentId: shipmentId,
        wallet,
      })
    : { purchaseUnknown: purchaseStatus === 'unknown' };
  return {
    deliveryId: body.deliveryId,
    shipmentId,
    ...(resolvedPurchase.label ? { label: resolvedPurchase.label } : reconciled.inactive ? { label: reconciled.inactive } : {}),
    ...(resolvedPurchase.purchaseUnknown ? { purchaseUnknown: true } : {}),
  };
}

function expectedFulfillmentShipStationLabelForVoid(
  order: Record<string, unknown>,
  shipmentId: string,
  labelId: string,
): FulfillmentShipStationLabel {
  const label = storedFulfillmentShipStationLabel(shipStationState(order).label);
  if (!label || label.labelId !== labelId) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation label changed. Check its status again.');
  }
  if (label.shipmentId !== shipmentId) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
  }
  return label;
}

async function persistVoidedFulfillmentShipStationLabel(args: {
  common: CommerceWriteCommon;
  deliveryId: number;
  dropId: string;
  label: FulfillmentShipStationLabel;
  wallet: string;
}): Promise<FulfillmentShipStationLabel & { status: 'voided' }> {
  const result = await persistFulfillmentShipStationLabel({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    expectedCurrentLabel: args.label,
    fallbackLabel: args.label,
    result: { label: { ...args.label, status: 'voided' } },
    wallet: args.wallet,
  });
  if (result.status !== 'voided') {
    throw new ProfileReadError('aborted', 409, 'The ShipStation label changed. Check its status again.');
  }
  return { ...result, status: 'voided' };
}

function shipStationLabelVoidFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ShipStationLabelProviderError || error instanceof ProfileReadError) {
    return { code: error.code, message: error.message.slice(0, 500) };
  }
  return { code: 'internal', message: 'Failed to void the ShipStation label' };
}

async function recoverAmbiguousFulfillmentShipStationLabelVoid(args: {
  apiKey: string;
  body: z.infer<typeof shipStationLabelVoidSchema>;
  common: CommerceWriteCommon;
  dropId: string;
  shipmentId: string;
  wallet: string;
}): Promise<VoidFulfillmentShipStationLabelResponse | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Label void cleanup timed out', 'TimeoutError')),
    SHIPSTATION_LABEL_VOID_CLEANUP_TIMEOUT_MS,
  );
  const common = { ...args.common, signal: controller.signal };
  try {
    try {
      const current = await loadDeliveryOrderDocument(common, args.dropId, args.body.deliveryId);
      const currentLabel = expectedFulfillmentShipStationLabelForVoid(
        current.fields,
        args.shipmentId,
        args.body.labelId,
      );
      if (currentLabel.status === 'voided') {
        return {
          deliveryId: args.body.deliveryId,
          shipmentId: args.shipmentId,
          label: { ...currentLabel, status: 'voided' },
        };
      }
      const providerResult = await getShipStationLabelById(args.apiKey, args.body.labelId, {
        fetch: common.providerFetch,
        signal: common.signal,
      });
      if (
        providerResult.label.shipmentId !== args.shipmentId ||
        providerResult.label.status !== 'voided'
      ) return undefined;
      const label = await persistVoidedFulfillmentShipStationLabel({
        common,
        deliveryId: args.body.deliveryId,
        dropId: args.dropId,
        label: currentLabel,
        wallet: args.wallet,
      });
      return { deliveryId: args.body.deliveryId, shipmentId: args.shipmentId, label };
    } catch (error) {
      const failure = shipStationLabelVoidFailure(error);
      console.error(JSON.stringify({
        event: 'fulfillment_shipstation_label_void_reconcile_failed',
        dropId: args.dropId,
        deliveryId: args.body.deliveryId,
        code: failure.code,
      }));
      return undefined;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function voidFulfillmentShipStationLabel(
  body: z.infer<typeof shipStationLabelVoidSchema>,
  wallet: string,
  common: ProfileWriteOperationContext,
  apiKey: string,
): Promise<VoidFulfillmentShipStationLabelResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  if (!apiKey) {
    throw new ShipStationProfileError('failed-precondition', 409, 'ShipStation API key is not configured');
  }
  const initial = await loadDeliveryOrderDocument(common, dropId, body.deliveryId);
  rejectIrlShipStationOrder(initial.fields);
  const shipmentId = requireShipStationShipmentId(initial.fields);
  const initialLabel = expectedFulfillmentShipStationLabelForVoid(initial.fields, shipmentId, body.labelId);
  if (initialLabel.status === 'voided') {
    return {
      deliveryId: body.deliveryId,
      shipmentId,
      label: { ...initialLabel, status: 'voided' },
    };
  }
  if (initialLabel.status === 'processing') {
    throw new ProfileReadError('failed-precondition', 409, 'Wait for this ShipStation label to finish processing before voiding it.');
  }
  if (initialLabel.status !== 'completed') {
    throw new ProfileReadError('failed-precondition', 409, 'Only completed ShipStation labels can be voided.');
  }
  let voidAccepted = false;
  let voidAttempted = false;
  try {
    if (common.signal.aborted) throw common.signal.reason;
    voidAttempted = true;
    await voidShipStationLabel(apiKey, body.labelId, {
      fetch: common.providerFetch,
      signal: common.signal,
    });
    voidAccepted = true;
    const label = await persistVoidedFulfillmentShipStationLabel({
      common,
      deliveryId: body.deliveryId,
      dropId,
      label: initialLabel,
      wallet,
    });
    return { deliveryId: body.deliveryId, shipmentId, label };
  } catch (error) {
    const signalCancelled = isSignalCancellationError(common.signal, error);
    const clientCancellation = clientCancellationReason(error, common);
    const failure = shipStationLabelVoidFailure(error);
    const ambiguous = voidAccepted || (
      voidAttempted && (
        signalCancelled || (
          error instanceof ShipStationLabelProviderError &&
          ['deadline-exceeded', 'unavailable', 'internal'].includes(error.code)
        )
      )
    );
    if (ambiguous) {
      const recovered = await recoverAmbiguousFulfillmentShipStationLabelVoid({
        apiKey,
        body,
        common,
        dropId,
        shipmentId,
        wallet,
      });
      if (clientCancellation !== undefined) throw clientCancellation;
      if (recovered) return recovered;
      throw new ProfileReadError(
        'aborted',
        409,
        'ShipStation did not confirm the label void. Check its status before trying again.',
      );
    }
    if (signalCancelled) throw common.signal.reason;
    if (error instanceof ShipStationLabelProviderError) throw profileErrorForShipStation(error);
    if (error instanceof ProfileReadError) throw error;
    throw new ProfileReadError('internal', 500, failure.message);
  }
}

type ShipStationLabelPurchaseClaim =
  | { alreadyPurchased: true; label: FulfillmentShipStationLabel }
  | { alreadyPurchased: false };

async function claimFulfillmentShipStationLabelPurchase(args: {
  body: z.infer<typeof shipStationLabelPurchaseSchema>;
  common: CommerceWriteCommon;
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

function shipStationLabelPurchaseFailure(error: unknown): { code: string; message: string } {
  if (
    error instanceof ShipStationLabelProviderError
    || error instanceof ShipStationRatesProviderError
    || error instanceof ProfileReadError
  ) {
    return { code: error.code, message: error.message.slice(0, 500) };
  }
  return { code: 'internal', message: 'Failed to purchase the ShipStation label' };
}

async function transitionFulfillmentShipStationLabelPurchase(args: {
  body: z.infer<typeof shipStationLabelPurchaseSchema>;
  common: CommerceWriteCommon;
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

async function failFulfillmentShipStationLabelPurchase(args: {
  body: z.infer<typeof shipStationLabelPurchaseSchema>;
  common: CommerceWriteCommon;
  dropId: string;
  message: string;
  shipmentId: string;
  wallet: string;
}): Promise<{ label?: FulfillmentShipStationLabel; purchaseUnknown: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Label purchase cleanup timed out', 'TimeoutError')),
    SHIPSTATION_LABEL_PURCHASE_CLEANUP_TIMEOUT_MS,
  );
  try {
    return await transitionFulfillmentShipStationLabelPurchase({
      ...args,
      common: { ...args.common, signal: controller.signal },
      nextStatus: 'failed',
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function recoverAmbiguousFulfillmentShipStationLabelPurchase(args: {
  apiKey: string;
  body: z.infer<typeof shipStationLabelPurchaseSchema>;
  common: CommerceWriteCommon;
  dropId: string;
  message: string;
  shipmentId: string;
  wallet: string;
}): Promise<PurchaseFulfillmentShipStationLabelResponse | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Label purchase cleanup timed out', 'TimeoutError')),
    SHIPSTATION_LABEL_PURCHASE_CLEANUP_TIMEOUT_MS,
  );
  const common = { ...args.common, signal: controller.signal };
  try {
    try {
      const current = await loadDeliveryOrderDocument(common, args.dropId, args.body.deliveryId);
      const recovered = await reconcileFulfillmentShipStationLabel({
        apiKey: args.apiKey,
        common,
        deliveryId: args.body.deliveryId,
        dropId: args.dropId,
        expectedPurchaseRequestId: args.body.requestId,
        order: current.fields,
        refreshInactiveStoredLabel: false,
        shipmentId: args.shipmentId,
        wallet: args.wallet,
      });
      if (recovered.active) {
        return {
          deliveryId: args.body.deliveryId,
          shipmentId: args.shipmentId,
          label: recovered.active,
          ...(recovered.downloadUrl ? { labelDownloadUrl: recovered.downloadUrl } : {}),
          alreadyPurchased: false,
        };
      }
    } catch (error) {
      const failure = shipStationLabelPurchaseFailure(error);
      console.error(JSON.stringify({
        event: 'fulfillment_shipstation_label_purchase_reconcile_failed',
        dropId: args.dropId,
        deliveryId: args.body.deliveryId,
        code: failure.code,
      }));
    }
    try {
      const failureState = await transitionFulfillmentShipStationLabelPurchase({
        body: args.body,
        common,
        dropId: args.dropId,
        message: args.message,
        nextStatus: 'unknown',
        shipmentId: args.shipmentId,
        wallet: args.wallet,
      });
      if (failureState.label) {
        return {
          deliveryId: args.body.deliveryId,
          shipmentId: args.shipmentId,
          label: failureState.label,
          alreadyPurchased: true,
        };
      }
    } catch (error) {
      const failure = shipStationLabelPurchaseFailure(error);
      console.error(JSON.stringify({
        event: 'fulfillment_shipstation_label_purchase_cleanup_failed',
        dropId: args.dropId,
        deliveryId: args.body.deliveryId,
        code: failure.code,
      }));
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function purchaseFulfillmentShipStationLabel(
  body: z.infer<typeof shipStationLabelPurchaseSchema>,
  wallet: string,
  common: ProfileWriteOperationContext,
  apiKey: string,
): Promise<PurchaseFulfillmentShipStationLabelResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  if (!apiKey) {
    throw new ShipStationProfileError('failed-precondition', 409, 'ShipStation API key is not configured');
  }
  const initial = await loadDeliveryOrderDocument(common, dropId, body.deliveryId);
  rejectIrlShipStationOrder(initial.fields);
  const shipmentId = requireShipStationShipmentId(initial.fields);
  const reconciled = await reconcileFulfillmentShipStationLabel({
    apiKey,
    common,
    deliveryId: body.deliveryId,
    dropId,
    order: initial.fields,
    refreshInactiveStoredLabel: false,
    shipmentId,
    wallet,
  });
  if (reconciled.active) {
    return {
      deliveryId: body.deliveryId,
      shipmentId,
      label: reconciled.active,
      ...(reconciled.downloadUrl ? { labelDownloadUrl: reconciled.downloadUrl } : {}),
      alreadyPurchased: true,
    };
  }
  let claimAcquired = false;
  let purchaseAttempted = false;
  let purchaseAccepted = false;
  try {
    const claim = await claimFulfillmentShipStationLabelPurchase({ body, common, dropId, shipmentId, wallet });
    if (claim.alreadyPurchased) {
      const result = await getShipStationLabelById(apiKey, claim.label.labelId, {
        fetch: common.providerFetch,
        signal: common.signal,
      });
      const label = await persistFulfillmentShipStationLabel({
        common,
        deliveryId: body.deliveryId,
        dropId,
        expectedCurrentLabel: claim.label,
        fallbackLabel: claim.label,
        result,
        wallet,
      });
      if (!isActiveShipStationLabel(label)) {
        throw new ProfileReadError(
          'failed-precondition',
          409,
          'The existing ShipStation label is no longer active. Refresh rates before purchasing.',
        );
      }
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        label,
        ...(result.downloadUrl ? { labelDownloadUrl: result.downloadUrl } : {}),
        alreadyPurchased: true,
      };
    }
    claimAcquired = true;
    const selectedRate = await getShipStationRateById(apiKey, body.rateId, shipmentId, {
      fetch: common.providerFetch,
      signal: common.signal,
    });
    if (selectedRate.shipmentId !== shipmentId) {
      throw new ProfileReadError('permission-denied', 403, 'The selected rate does not belong to this shipment.');
    }
    if (!shipStationMoneyMatches(body.expectedTotal, selectedRate.totalAmount)) {
      throw new ProfileReadError(
        'failed-precondition',
        409,
        'The selected rate changed. Refresh rates before purchasing.',
      );
    }
    let labelAppearedBeforePurchase: FulfillmentShipStationLabel | undefined;
    const resolution = await adoptOrPurchaseShipStationLabel(
      async () => (await listShipStationLabelsForShipment(apiKey, shipmentId, {
        fetch: common.providerFetch,
        signal: common.signal,
      }))[0] ?? null,
      async () => {
        const current = await loadDeliveryOrderDocument(common, dropId, body.deliveryId);
        const currentShipstation = shipStationState(current.fields);
        if (optionalString(currentShipstation.shipmentId) !== shipmentId) {
          throw new ProfileReadError(
            'aborted',
            409,
            'The ShipStation shipment changed. Refresh the order and try again.',
          );
        }
        const currentLabel = storedFulfillmentShipStationLabel(currentShipstation.label);
        if (currentLabel && isActiveShipStationLabel(currentLabel)) {
          labelAppearedBeforePurchase = currentLabel;
          return getShipStationLabelById(apiKey, currentLabel.labelId, {
            fetch: common.providerFetch,
            signal: common.signal,
          });
        }
        const currentPurchase = isRecord(currentShipstation.labelPurchase)
          ? currentShipstation.labelPurchase
          : {};
        if (!shouldTransitionShipStationPurchaseState(currentPurchase, body.requestId, false)) {
          throw new ProfileReadError(
            'aborted',
            409,
            'The ShipStation label purchase changed. Check its status again.',
          );
        }
        purchaseAttempted = true;
        const result = await createShipStationLabelFromRate(apiKey, body.rateId, {
          fetch: common.providerFetch,
          signal: common.signal,
        });
        purchaseAccepted = true;
        return result;
      },
    );
    if (resolution.result.label.shipmentId !== shipmentId) {
      throw new ProfileReadError('internal', 500, 'ShipStation returned a label for the wrong shipment');
    }
    const fallbackLabel = resolution.alreadyPurchased
      ? undefined
      : labelAppearedBeforePurchase ?? {
          rateId: body.rateId,
          purchasedBy: wallet,
          carrierId: selectedRate.carrierId,
          carrierCode: selectedRate.carrierCode,
          carrierName: selectedRate.carrierName,
          serviceCode: selectedRate.serviceCode,
          serviceName: selectedRate.serviceName,
        };
    const label = await persistFulfillmentShipStationLabel({
      common,
      confirmedPurchase: !resolution.alreadyPurchased && labelAppearedBeforePurchase === undefined,
      deliveryId: body.deliveryId,
      dropId,
      expectedPurchaseRequestId: body.requestId,
      ...(fallbackLabel ? { fallbackLabel } : {}),
      result: resolution.result,
      wallet,
    });
    if (labelAppearedBeforePurchase && !isActiveShipStationLabel(label)) {
      throw new ProfileReadError(
        'failed-precondition',
        409,
        'The existing ShipStation label is no longer active. Refresh rates before purchasing.',
      );
    }
    return {
      deliveryId: body.deliveryId,
      shipmentId,
      label,
      ...(label.labelId === resolution.result.label.labelId && resolution.result.downloadUrl
        ? { labelDownloadUrl: resolution.result.downloadUrl }
        : {}),
      alreadyPurchased: resolution.alreadyPurchased
        || labelAppearedBeforePurchase !== undefined
        || label.labelId !== resolution.result.label.labelId,
    };
  } catch (error) {
    if (!claimAcquired) throw error;
    const signalCancelled = isSignalCancellationError(common.signal, error);
    const clientCancellation = clientCancellationReason(error, common);
    const failure = shipStationLabelPurchaseFailure(error);
    const ambiguous = purchaseAccepted || (
      purchaseAttempted
      && ['deadline-exceeded', 'unavailable', 'internal', 'unknown'].includes(failure.code)
    );
    if (ambiguous) {
      const recovered = await recoverAmbiguousFulfillmentShipStationLabelPurchase({
        apiKey,
        body,
        common,
        dropId,
        message: failure.message,
        shipmentId,
        wallet,
      });
      if (clientCancellation !== undefined) throw clientCancellation;
      if (recovered) return recovered;
      throw new ProfileReadError(
        'aborted',
        409,
        'ShipStation did not confirm the label purchase. Check purchase status or open ShipStation before retrying.',
      );
    }
    let failureState: Awaited<ReturnType<typeof failFulfillmentShipStationLabelPurchase>>;
    try {
      failureState = await failFulfillmentShipStationLabelPurchase({
        body,
        common,
        dropId,
        message: failure.message,
        shipmentId,
        wallet,
      });
    } catch (cleanupError) {
      if (clientCancellation !== undefined) throw clientCancellation;
      if (signalCancelled) throw common.signal.reason;
      throw cleanupError;
    }
    if (clientCancellation !== undefined) throw clientCancellation;
    if (signalCancelled) throw common.signal.reason;
    if (failureState.label) {
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        label: failureState.label,
        alreadyPurchased: true,
      };
    }
    if (error instanceof ShipStationLabelProviderError || error instanceof ShipStationRatesProviderError) {
      throw profileErrorForShipStation(error);
    }
    if (error instanceof ProfileReadError) throw error;
    throw new ProfileReadError('internal', 500, 'Failed to purchase the ShipStation label');
  }
}

export const shipStationLabelOperations = [
  defineProfileWriteOperation({
    path: FULFILLMENT_SHIPSTATION_LABEL_PATH,
    schema: shipStationLabelSchema,
    maxBytes: MAX_SHIPSTATION_LABEL_REQUEST_BYTES,
    timeoutMs: SHIPSTATION_LABEL_OPERATION_TIMEOUT_MS,
    handler: (body, { wallet, common, env }) => getFulfillmentShipStationLabel(
      body, wallet, common,
      typeof env.SHIPSTATION_API_KEY === 'string' ? env.SHIPSTATION_API_KEY.trim() : '',
    ),
  }),
  defineProfileWriteOperation({
    path: FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    schema: shipStationLabelPurchaseSchema,
    maxBytes: MAX_SHIPSTATION_LABEL_PURCHASE_REQUEST_BYTES,
    timeoutMs: SHIPSTATION_LABEL_PURCHASE_OPERATION_TIMEOUT_MS,
    handler: (body, { wallet, common, env }) => purchaseFulfillmentShipStationLabel(
      body, wallet, common,
      typeof env.SHIPSTATION_API_KEY === 'string' ? env.SHIPSTATION_API_KEY.trim() : '',
    ),
  }),
  defineProfileWriteOperation({
    path: FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH,
    schema: shipStationLabelVoidSchema,
    maxBytes: MAX_SHIPSTATION_LABEL_VOID_REQUEST_BYTES,
    timeoutMs: SHIPSTATION_LABEL_VOID_OPERATION_TIMEOUT_MS,
    handler: (body, { wallet, common, env }) => voidFulfillmentShipStationLabel(
      body, wallet, common,
      typeof env.SHIPSTATION_API_KEY === 'string' ? env.SHIPSTATION_API_KEY.trim() : '',
    ),
  }),
];
