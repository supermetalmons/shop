import { randomInt } from 'crypto';
import { commerceFieldValue, commerceKeys, type CommerceDocumentKey } from '../commerceRepository.js';
import { commerceTimestamp, runCommerceTransaction } from '../commerceTransactions.js';
import {
  getStripeCheckout,
  mergeStripeCheckout,
  stripeCheckoutRecord,
  stripeCheckoutWriteData,
  updateStripeCheckout,
  validateStripeCheckoutForFulfillment,
  type StripeCheckoutCommerceContext,
  type StripeCheckoutRecord,
  type StripeCheckoutUpdate,
  type ValidatedStripeCheckoutRecord,
} from './commerce.js';
import {
  buildStripeOffchainDeliveryOrderDocument,
  buildStripeOffchainOrderMarkerDocument,
  requireStripeReceiptClaimCode,
  STRIPE_CHECKOUT_PROCESSING_LEASE_MS,
  STRIPE_CHECKOUT_STATUS,
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  type StripeOffchainDeliveryOrderDocumentInput,
} from './contract.js';
import { StripeCheckoutProcessingAttemptOwnershipCheckError } from './errors.js';
import { createStripeTerminalNotificationOutboxFields } from './notificationOutboxState.js';

const STRIPE_MANUAL_REFUND_REASON = 'fulfillment_failed_after_payment';
export const STRIPE_CHECKOUT_FULFILLMENT_MAX_ATTEMPTS = 2;

export type StripeCheckoutFulfillmentStart =
  | {
      started: true;
      checkoutKey: CommerceDocumentKey<'stripe_checkout'>;
      checkout: ValidatedStripeCheckoutRecord;
      variantKey?: string;
      processingAttemptId: string;
    }
  | {
      started: false;
      reason: StripeCheckoutFulfillmentStartSkippedReason;
    };

export type StripeCheckoutFulfillmentStartSkippedReason =
  | 'already_fulfilled'
  | 'processing'
  | 'not_pending'
  | 'failed';

type StripeOffchainDeliveryOrderMarker = {
  deliveryId: number;
  metadataId?: number;
  metadataIds?: number[];
  receiptTx?: string | null;
};
export type StripeOffchainDeliveryOrderDraft = Omit<StripeOffchainDeliveryOrderDocumentInput, 'deliveryId'>;
export type StripeOffchainDeliveryOrderResult =
  | { checkoutStatus: 'fulfilled'; deliveryId: number; created?: boolean }
  | { checkoutStatus: 'already_fulfilled'; deliveryId?: number }
  | { checkoutStatus: 'stale_processing_attempt' };

type StripeReceiptClaimCreate = {
  version: 1;
  namespace: typeof STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE;
  code: string;
  dropId: string;
  deliveryId: number;
  owner: string;
  ownerKind: StripeOffchainDeliveryOrderDraft['ownerKind'];
  authSubject?: string;
  receiptOwner: string;
  boxId: number;
  variantKey?: string;
  offchainOrderHash: string;
  stripeCheckoutSessionId?: string | null;
  status: 'unclaimed';
  createdAt: ReturnType<typeof commerceFieldValue.serverTimestamp>;
};

function createStripeCheckoutProcessingAttemptId(nowMs: number): string {
  return `${nowMs.toString(36)}:${randomInt(0, 2 ** 32).toString(36)}`;
}

function isStripeCheckoutProcessingLeaseExpired(checkoutData: StripeCheckoutRecord, nowMs: number): boolean {
  const leaseExpiresAt = checkoutData.processingLeaseExpiresAtMs;
  if (leaseExpiresAt !== undefined) return leaseExpiresAt <= nowMs;

  const processingStartedAt = checkoutData.processingStartedAtMs;
  if (processingStartedAt === undefined) return false;
  return nowMs - processingStartedAt >= STRIPE_CHECKOUT_PROCESSING_LEASE_MS;
}

export async function recordStripeCheckoutRetryableFulfillmentError(params: {
  commerce: StripeCheckoutCommerceContext;
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>;
  summarizeError: (err: unknown) => unknown;
  err: unknown;
  attempt: number;
  retryDelayMs: number;
  processingAttemptId?: string;
}): Promise<'recorded' | 'stale'> {
  const update: StripeCheckoutUpdate = {
    lastRetryableFulfillmentError: params.summarizeError(params.err),
    lastRetryableFulfillmentErrorAt: commerceFieldValue.serverTimestamp(),
    lastRetryableFulfillmentAttempt: params.attempt,
    nextFulfillmentRetryAt: commerceTimestamp(Date.now() + params.retryDelayMs),
    updatedAt: commerceFieldValue.serverTimestamp(),
  };

  if (!params.processingAttemptId) {
    await runCommerceTransaction(params.commerce, async (tx) => {
      await updateStripeCheckout(tx, params.checkoutKey, update);
    }, { shouldRetry: (error) => error.code === 'aborted' }).catch(() => undefined);
    return 'recorded';
  }

  return runCommerceTransaction(params.commerce, async (tx) => {
    const checkout = await getStripeCheckout(tx, params.checkoutKey);
    const currentAttemptId = checkout?.processingAttemptId ?? '';
    if (currentAttemptId !== params.processingAttemptId) return 'stale' as const;
    await updateStripeCheckout(tx, params.checkoutKey, update);
    return 'recorded' as const;
  }, { shouldRetry: (error) => error.code === 'aborted' }).catch((err) => {
    throw new StripeCheckoutProcessingAttemptOwnershipCheckError(err);
  });
}

function stripeCheckoutFailureStateClearUpdate(): StripeCheckoutUpdate {
  return {
    lastFulfillmentError: commerceFieldValue.delete(),
    lastRetryableFulfillmentAttempt: commerceFieldValue.delete(),
    lastRetryableFulfillmentError: commerceFieldValue.delete(),
    lastRetryableFulfillmentErrorAt: commerceFieldValue.delete(),
    manualRefundReviewRequired: commerceFieldValue.delete(),
    manualRefundReviewReason: commerceFieldValue.delete(),
    nextFulfillmentRetryAt: commerceFieldValue.delete(),
    failedAt: commerceFieldValue.delete(),
  };
}

function stripeCheckoutProcessingStateClearUpdate(): StripeCheckoutUpdate {
  return {
    processingAttemptId: commerceFieldValue.delete(),
    processingLeaseExpiresAt: commerceFieldValue.delete(),
  };
}

function stripeCheckoutFulfillmentClearUpdate(): StripeCheckoutUpdate {
  return {
    ...stripeCheckoutFailureStateClearUpdate(),
    ...stripeCheckoutProcessingStateClearUpdate(),
  };
}

export type StripeCheckoutFulfillmentCompletionFields = {
  fulfillmentCompletedBy: string;
  fulfillmentCompletedAt?: number;
};

function stripeCheckoutFulfilledUpdate(params: {
  before: Record<string, unknown> | null;
  deliveryId: number;
  metadataId?: number;
  metadataIds?: number[];
  receiptTx?: string | null;
  fulfillmentCompletionFields?: StripeCheckoutFulfillmentCompletionFields;
}): StripeCheckoutUpdate {
  const metadataIds = normalizedMetadataIds(params.metadataIds, params.metadataId);
  const metadataId = metadataIds.length === 1 ? metadataIds[0] : undefined;
  return {
    status: STRIPE_CHECKOUT_STATUS.FULFILLED,
    ...createStripeTerminalNotificationOutboxFields(params.before, 'fulfilled'),
    deliveryId: params.deliveryId,
    ...(metadataId ? { metadataId } : metadataIds.length > 1 ? { metadataId: commerceFieldValue.delete() } : {}),
    ...(metadataIds.length ? { metadataIds, quantity: metadataIds.length } : {}),
    ...(typeof params.receiptTx === 'string' || params.receiptTx === null ? { receiptTx: params.receiptTx } : {}),
    ...(params.fulfillmentCompletionFields ? {
      fulfillmentCompletedBy: params.fulfillmentCompletionFields.fulfillmentCompletedBy,
      fulfillmentCompletedAt: params.fulfillmentCompletionFields.fulfillmentCompletedAt ?? commerceFieldValue.serverTimestamp(),
    } : {}),
    fulfilledAt: commerceFieldValue.serverTimestamp(),
    ...stripeCheckoutFulfillmentClearUpdate(),
    updatedAt: commerceFieldValue.serverTimestamp(),
  };
}

type StripeCheckoutFulfillmentSuccessMarkResult =
  | { status: 'fulfilled' }
  | { status: 'already_fulfilled' }
  | { status: 'stale_processing_attempt' };

type StripeCheckoutProcessingAttemptWriteStatus = 'current' | 'already_fulfilled' | 'stale_processing_attempt';

function stripeCheckoutProcessingAttemptWriteStatus(
  checkout: StripeCheckoutRecord | null,
  processingAttemptId: string | undefined,
): StripeCheckoutProcessingAttemptWriteStatus {
  const checkoutStatus = checkout?.status ?? '';
  if (checkoutStatus === STRIPE_CHECKOUT_STATUS.FULFILLED) return 'already_fulfilled';
  if (!processingAttemptId) return 'current';
  const currentAttemptId = checkout?.processingAttemptId ?? '';
  return currentAttemptId === processingAttemptId ? 'current' : 'stale_processing_attempt';
}

function stripeCheckoutFulfilledWriteStatus(
  checkout: StripeCheckoutRecord | null,
  processingAttemptId: string | undefined,
): StripeCheckoutFulfillmentSuccessMarkResult['status'] {
  const writeStatus = stripeCheckoutProcessingAttemptWriteStatus(checkout, processingAttemptId);
  return writeStatus === 'current' ? 'fulfilled' : writeStatus;
}

export async function markStripeCheckoutFulfillmentFulfilled(
  commerce: StripeCheckoutCommerceContext,
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>,
  params: {
    deliveryId: number;
    metadataId?: number;
    metadataIds?: number[];
    receiptTx?: string | null;
    processingAttemptId?: string;
    fulfillmentCompletionFields?: StripeCheckoutFulfillmentCompletionFields;
  },
): Promise<StripeCheckoutFulfillmentSuccessMarkResult> {
  return runCommerceTransaction(commerce, async (tx) => {
    const checkout = await getStripeCheckout(tx, checkoutKey);
    if (params.processingAttemptId) {
      const status = stripeCheckoutFulfilledWriteStatus(checkout, params.processingAttemptId);
      if (status === 'already_fulfilled') return { status: 'already_fulfilled' as const };
      if (status === 'stale_processing_attempt') return { status: 'stale_processing_attempt' as const };
    }
    await updateStripeCheckout(tx, checkoutKey, stripeCheckoutFulfilledUpdate({ ...params, before: checkout?.fields ?? null }));
    return { status: 'fulfilled' as const };
  }, { shouldRetry: (error) => error.code === 'aborted' }).catch((err) => {
    if (!params.processingAttemptId) throw err;
    throw new StripeCheckoutProcessingAttemptOwnershipCheckError(err);
  });
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function normalizedPositiveIntegers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((candidate) => Math.floor(Number(candidate)))
    .filter((candidate) => Number.isFinite(candidate) && candidate > 0 && candidate <= 0xffff_ffff);
}

export function normalizedMetadataIds(metadataIds: unknown, metadataId: unknown): number[] {
  const explicitMetadataIds = normalizedPositiveIntegers(metadataIds);
  if (explicitMetadataIds.length) return explicitMetadataIds;
  const legacyMetadataId = positiveInteger(metadataId);
  return legacyMetadataId ? [legacyMetadataId] : [];
}

function receiptTxMaybe(value: unknown): string | null | undefined {
  if (typeof value === 'string') return value;
  if (value === null) return null;
  return undefined;
}

function readStripeOffchainDeliveryOrderMarker(marker: Record<string, unknown>): StripeOffchainDeliveryOrderMarker | null {
  const deliveryId = Math.floor(Number(marker.deliveryId));
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) return null;
  const metadataId = positiveInteger(marker.metadataId);
  const metadataIds = normalizedMetadataIds(marker.metadataIds, metadataId);
  const receiptTx = receiptTxMaybe(marker.receiptTx);
  return {
    deliveryId,
    ...(metadataId ? { metadataId } : {}),
    ...(metadataIds.length ? { metadataIds } : {}),
    ...(typeof receiptTx === 'string' || receiptTx === null ? { receiptTx } : {}),
  };
}

export async function fetchStripeOffchainDeliveryOrderMarker(params: {
  commerce: StripeCheckoutCommerceContext;
  dropId: string;
  orderHashHex: string;
}): Promise<StripeOffchainDeliveryOrderMarker | null> {
  params.commerce.signal?.throwIfAborted();
  const marker = await params.commerce.repository.get(commerceKeys.offchainOrder(params.dropId, params.orderHashHex));
  params.commerce.signal?.throwIfAborted();
  return marker ? readStripeOffchainDeliveryOrderMarker(marker.data) : null;
}

export async function startStripeCheckoutFulfillmentDocument(params: {
  commerce: StripeCheckoutCommerceContext;
  dropId: string;
  sessionId: string;
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>;
  expectedLivemode?: boolean;
  nowMs?: number;
}): Promise<StripeCheckoutFulfillmentStart> {
  const { commerce, dropId, sessionId, checkoutKey } = params;
  const nowMs = Math.floor(Number(params.nowMs ?? Date.now()));
  const processingAttemptId = createStripeCheckoutProcessingAttemptId(nowMs);
  return runCommerceTransaction(commerce, async (tx) => {
    const checkoutData = await getStripeCheckout(tx, checkoutKey);
    if (!checkoutData) return { started: false, reason: 'not_pending' };
    const { status } = checkoutData;
    if (status === STRIPE_CHECKOUT_STATUS.FULFILLED) return { started: false, reason: 'already_fulfilled' };
    if (status === STRIPE_CHECKOUT_STATUS.PROCESSING && !isStripeCheckoutProcessingLeaseExpired(checkoutData, nowMs)) {
      return { started: false, reason: 'processing' };
    }
    if (status === STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED) return { started: false, reason: 'failed' };
    if (status !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING && status !== STRIPE_CHECKOUT_STATUS.PROCESSING) {
      return { started: false, reason: 'not_pending' };
    }

    const variantKey = String(checkoutData.fields.variantKey || '').trim();
    const checkout = validateStripeCheckoutForFulfillment(checkoutData, {
      dropId,
      ...(variantKey ? { variantKey } : {}),
      sessionId,
      expectedLivemode: params.expectedLivemode,
    });

    await updateStripeCheckout(tx, checkoutKey, {
      status: STRIPE_CHECKOUT_STATUS.PROCESSING,
      processingStartedAt: commerceFieldValue.serverTimestamp(),
      processingAttemptCount: commerceFieldValue.increment(1),
      ...stripeCheckoutFailureStateClearUpdate(),
      processingAttemptId,
      processingLeaseExpiresAt: commerceTimestamp(nowMs + STRIPE_CHECKOUT_PROCESSING_LEASE_MS),
      updatedAt: commerceFieldValue.serverTimestamp(),
    });
    return { started: true, checkoutKey, checkout, ...(variantKey ? { variantKey } : {}), processingAttemptId };
  }, { shouldRetry: (error) => error.code === 'aborted' });
}

type StripeCheckoutFulfillmentFailureMarkResult =
  | { status: 'failed' }
  | { status: 'already_fulfilled' }
  | { status: 'stale_processing_attempt' };

type StripeCheckoutFulfillmentRetryReleaseResult =
  | { status: 'released' }
  | { status: 'already_fulfilled' }
  | { status: 'stale_processing_attempt' };

export async function releaseStripeCheckoutFulfillmentForRetry(
  commerce: StripeCheckoutCommerceContext,
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>,
  err: unknown,
  params: {
    summarizeError: (err: unknown) => unknown;
    processingAttemptId: string;
  },
): Promise<StripeCheckoutFulfillmentRetryReleaseResult> {
  return runCommerceTransaction(commerce, async (tx) => {
    const checkout = await getStripeCheckout(tx, checkoutKey);
    const writeStatus = stripeCheckoutProcessingAttemptWriteStatus(checkout, params.processingAttemptId);
    if (writeStatus !== 'current') return { status: writeStatus };
    await updateStripeCheckout(tx, checkoutKey, {
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
      lastRetryableFulfillmentAttempt: STRIPE_CHECKOUT_FULFILLMENT_MAX_ATTEMPTS,
      lastRetryableFulfillmentError: params.summarizeError(err),
      lastRetryableFulfillmentErrorAt: commerceFieldValue.serverTimestamp(),
      nextFulfillmentRetryAt: commerceFieldValue.delete(),
      processingStartedAt: commerceFieldValue.delete(),
      ...stripeCheckoutProcessingStateClearUpdate(),
      updatedAt: commerceFieldValue.serverTimestamp(),
    });
    return { status: 'released' as const };
  }, { shouldRetry: (error) => error.code === 'aborted' }).catch((error) => {
    throw new StripeCheckoutProcessingAttemptOwnershipCheckError(error);
  });
}

export async function markStripeCheckoutFulfillmentFailed(
  commerce: StripeCheckoutCommerceContext,
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>,
  err: unknown,
  params: {
    summarizeError: (err: unknown) => unknown;
    sessionIdentity?: { dropId: string; sessionId: string };
    processingAttemptId?: string;
  },
): Promise<StripeCheckoutFulfillmentFailureMarkResult> {
  const error = params.summarizeError(err);
  const identityUpdate = params.sessionIdentity
    ? { dropId: params.sessionIdentity.dropId, sessionId: params.sessionIdentity.sessionId }
    : {};
  return runCommerceTransaction(commerce, async (tx) => {
    const checkout = await getStripeCheckout(tx, checkoutKey);
    const writeStatus = stripeCheckoutProcessingAttemptWriteStatus(checkout, params.processingAttemptId);
    if (writeStatus === 'already_fulfilled') {
      return { status: 'already_fulfilled' as const };
    }
    if (writeStatus === 'stale_processing_attempt') {
      return { status: 'stale_processing_attempt' as const };
    }

    await mergeStripeCheckout(
      tx, checkoutKey,
      {
        ...identityUpdate,
        status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
        ...createStripeTerminalNotificationOutboxFields(checkout?.fields ?? null, 'manual_review'),
        failedAt: commerceFieldValue.serverTimestamp(),
        lastFulfillmentError: error,
        manualRefundReviewRequired: true,
        manualRefundReviewReason: STRIPE_MANUAL_REFUND_REASON,
        nextFulfillmentRetryAt: commerceFieldValue.delete(),
        ...stripeCheckoutProcessingStateClearUpdate(),
        updatedAt: commerceFieldValue.serverTimestamp(),
      },
    );
    return { status: 'failed' as const };
  }, { shouldRetry: (error) => error.code === 'aborted' });
}

export function publishStripeOffchainDeliveryOrder(params: {
  commerce: StripeCheckoutCommerceContext;
  order: StripeOffchainDeliveryOrderDraft;
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>;
  deliveryId: number;
  claimCodes: readonly string[];
  processingAttemptId?: string;
  fulfillmentCompletionFields?: StripeCheckoutFulfillmentCompletionFields;
}): Promise<StripeOffchainDeliveryOrderResult> {
  const { commerce, order, checkoutKey, deliveryId, claimCodes } = params;
  const { dropId, orderHashHex } = order;
  const metadataIds = normalizedMetadataIds(order.metadataIds, order.metadataId);
  const markerKey = commerceKeys.offchainOrder(dropId, orderHashHex);
  const orderKey = commerceKeys.deliveryOrder(dropId, String(deliveryId));
  const claimKeys = claimCodes.map((claimCode) => commerceKeys.claimCode(claimCode));
  return runCommerceTransaction(commerce, async (tx) => {
    const [marker, checkoutSnap] = await tx.getMany([markerKey, checkoutKey]);
    const checkout = stripeCheckoutRecord(checkoutKey, checkoutSnap);
    const checkoutStatus = stripeCheckoutFulfilledWriteStatus(
      params.processingAttemptId ? checkout : null,
      params.processingAttemptId,
    );
    if (marker) {
      const existingOrder = readStripeOffchainDeliveryOrderMarker(marker.data);
      if (existingOrder) {
        if (checkoutStatus === 'stale_processing_attempt') {
          return { checkoutStatus };
        }
        if (checkoutStatus === 'fulfilled') {
          await updateStripeCheckout(
            tx, checkoutKey,
            stripeCheckoutFulfilledUpdate({
              before: checkout?.fields ?? null,
              deliveryId: existingOrder.deliveryId,
              metadataId: existingOrder.metadataId,
              metadataIds: existingOrder.metadataIds,
              receiptTx: existingOrder.receiptTx,
              fulfillmentCompletionFields: params.fulfillmentCompletionFields,
            }),
          );
        }
        return { deliveryId: existingOrder.deliveryId, checkoutStatus };
      }
    }

    if (checkoutStatus === 'stale_processing_attempt') {
      return { checkoutStatus };
    }
    if (checkoutStatus === 'already_fulfilled') {
      const deliveryId = positiveInteger(checkout?.fields.deliveryId);
      return deliveryId ? { deliveryId, checkoutStatus } : { checkoutStatus };
    }

    const stripeReceiptClaims = metadataIds.map((boxId, index) => ({
      code: requireStripeReceiptClaimCode(claimCodes[index]),
      boxId,
      status: 'unclaimed',
    }));
    const deliveryOrder = {
      ...order,
      deliveryId,
      metadataIds,
      stripeReceiptClaims,
    };
    await tx.getMany([orderKey, ...claimKeys]);
    await tx.create(orderKey, stripeCheckoutWriteData({
      ...buildStripeOffchainDeliveryOrderDocument(deliveryOrder),
      processedAt: commerceFieldValue.serverTimestamp(),
      createdAt: commerceFieldValue.serverTimestamp(),
    }));
    await tx.create(markerKey, stripeCheckoutWriteData({
      ...buildStripeOffchainOrderMarkerDocument(deliveryOrder),
      createdAt: commerceFieldValue.serverTimestamp(),
    }));
    for (const [index, claim] of stripeReceiptClaims.entries()) {
      await tx.create(claimKeys[index], stripeCheckoutWriteData({
        version: 1,
        namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
        code: claim.code,
        dropId,
        deliveryId,
        owner: order.owner,
        ownerKind: order.ownerKind,
        ...(order.authSubject ? { authSubject: order.authSubject } : {}),
        receiptOwner: order.receiptOwner,
        boxId: claim.boxId,
        ...(order.variantKey ? { variantKey: order.variantKey } : {}),
        offchainOrderHash: order.orderHashHex,
        stripeCheckoutSessionId: order.stripeSession.id,
        status: 'unclaimed',
        createdAt: commerceFieldValue.serverTimestamp(),
      } satisfies StripeReceiptClaimCreate));
    }
    if (checkoutStatus === 'fulfilled') {
      await updateStripeCheckout(
        tx, checkoutKey,
        stripeCheckoutFulfilledUpdate({
          before: checkout?.fields ?? null,
          deliveryId,
          ...(metadataIds.length === 1 ? { metadataId: metadataIds[0] } : {}),
          metadataIds,
          receiptTx: order.receiptTx,
          fulfillmentCompletionFields: params.fulfillmentCompletionFields,
        }),
      );
    }
    return { deliveryId, checkoutStatus, created: true };
  }, { shouldRetry: (error) => error.code === 'aborted' });
}
