import {
  type ShipStationRateMutationExpectation,
  shipStationState,
  rejectIrlShipStationOrder,
  requireShipStationShipmentId,
} from './state.js';
import {
  persistFulfillmentShipStationLabel,
  transitionShipStationPurchaseState,
  claimFulfillmentShipStationLabelPurchase,
  transitionFulfillmentShipStationLabelPurchase,
} from './labelStore.js';
import { z } from 'zod';
import {
  adoptOrPurchaseShipStationLabel,
  createShipStationLabelFromRate,
  getShipStationLabelById,
  isActiveShipStationLabel,
  listShipStationLabelsForShipment,
  shouldTransitionShipStationPurchaseState,
  storedFulfillmentShipStationLabel,
  ShipStationLabelProviderError,
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
import { loadDeliveryOrderDocument } from '../deliveryOrderStore.js';
import type { CommerceWriteCommon } from '../profileWriteCommerce.js';
import {
  optionalString,
} from '../profileWriteRates.js';
import {
  profileErrorForShipStation,
  supportedDropId,
  requireFulfillmentAccess,
  ShipStationProfileError,
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
  const order = initial.data;
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
        current.data,
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
  rejectIrlShipStationOrder(initial.data);
  const shipmentId = requireShipStationShipmentId(initial.data);
  const initialLabel = expectedFulfillmentShipStationLabelForVoid(initial.data, shipmentId, body.labelId);
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
        order: current.data,
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
  rejectIrlShipStationOrder(initial.data);
  const shipmentId = requireShipStationShipmentId(initial.data);
  const reconciled = await reconcileFulfillmentShipStationLabel({
    apiKey,
    common,
    deliveryId: body.deliveryId,
    dropId,
    order: initial.data,
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
        const currentShipstation = shipStationState(current.data);
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
