import type { D1CommerceRepository, CommerceUnitOfWork } from '../commerceRepository.js';
import {
  commerceFieldValue,
  CommerceRepositoryError,
  isCommerceArrayUnion,
  isCommerceDeleteField,
  isCommerceIncrement,
  isCommerceServerTimestamp,
  isCommerceTimestamp,
  type CommerceDocumentWriteData,
  type CommerceDocumentData,
  type CommerceDocumentKey,
  type CommerceDocumentRecord,
  type CommerceJsonValue,
  type CommerceUpdateValue,
} from '../commerceRepositoryTypes.js';
import { isRecord } from '../dataAccess.js';
import { toMillisMaybe } from '../time.js';
import {
  STRIPE_CHECKOUT_STATUS,
  validateStripeCheckoutDocumentData,
  type StripeCheckoutDocumentData,
} from './contract.js';
import { StripeCheckoutFulfillmentError } from './errors.js';
import type { StripeTerminalNotificationFields } from './notificationOutboxState.js';

export type StripeCheckoutCommerceContext = {
  repository: Pick<D1CommerceRepository, 'get' | 'run'>;
  nowMs: () => number;
  signal?: AbortSignal;
};

export type StripeReconciliationFailure = { name: string; message?: string };

export type StripeCheckoutRecord = {
  key: CommerceDocumentKey<'stripe_checkout'>;
  fields: CommerceDocumentData;
  status: string;
  processingAttemptId: string;
  processingStartedAtMs: number | undefined;
  processingLeaseExpiresAtMs: number | undefined;
  fulfillmentQueueReenqueuedAtMs: number | undefined;
  lastFulfillmentReconciliationError: StripeReconciliationFailure | undefined;
  lastFulfillmentReconciliationErrorAtMs: number | undefined;
};

export type ValidatedStripeCheckoutRecord = StripeCheckoutDocumentData & {
  key: CommerceDocumentKey<'stripe_checkout'>;
};

type DeleteField = ReturnType<typeof commerceFieldValue.delete>;
type TimestampWrite = number | ReturnType<typeof commerceFieldValue.timestamp> |
  ReturnType<typeof commerceFieldValue.serverTimestamp>;

export type StripeCheckoutUpdate = StripeTerminalNotificationFields & {
  status?: typeof STRIPE_CHECKOUT_STATUS[keyof typeof STRIPE_CHECKOUT_STATUS];
  dropId?: string;
  sessionId?: string;
  processingAttemptId?: string | DeleteField;
  processingAttemptCount?: number | ReturnType<typeof commerceFieldValue.increment>;
  processingStartedAt?: TimestampWrite | DeleteField;
  processingLeaseExpiresAt?: TimestampWrite | DeleteField;
  lastRetryableFulfillmentAttempt?: number | DeleteField;
  lastRetryableFulfillmentError?: unknown;
  lastRetryableFulfillmentErrorAt?: TimestampWrite | DeleteField;
  nextFulfillmentRetryAt?: TimestampWrite | DeleteField;
  lastFulfillmentError?: unknown;
  manualRefundReviewRequired?: boolean | DeleteField;
  manualRefundReviewReason?: string | DeleteField;
  failedAt?: TimestampWrite | DeleteField;
  fulfilledAt?: TimestampWrite;
  fulfillmentCompletedBy?: string;
  fulfillmentCompletedAt?: TimestampWrite;
  deliveryId?: number;
  metadataId?: number | DeleteField;
  metadataIds?: number[];
  quantity?: number;
  receiptTx?: string | null;
  fulfillmentQueueReenqueuedAt?: TimestampWrite;
  lastFulfillmentReconciliationError?: StripeReconciliationFailure;
  lastFulfillmentReconciliationErrorAt?: TimestampWrite;
  updatedAt?: TimestampWrite;
};

export function stripeCheckoutRecord(
  key: CommerceDocumentKey<'stripe_checkout'>,
  record: CommerceDocumentRecord | null,
): StripeCheckoutRecord | null {
  if (!record) return null;
  if (
    record.key.kind !== 'stripe_checkout' || record.key.path !== key.path ||
    record.key.dropId !== key.dropId || record.key.documentId !== key.documentId
  ) throw new CommerceRepositoryError('unavailable', 'Invalid Stripe checkout document identity.');
  const fields = record.data;
  const failure = fields.lastFulfillmentReconciliationError;
  return {
    key,
    fields,
    status: typeof fields.status === 'string' ? fields.status : '',
    processingAttemptId: typeof fields.processingAttemptId === 'string' ? fields.processingAttemptId : '',
    processingStartedAtMs: toMillisMaybe(fields.processingStartedAt),
    processingLeaseExpiresAtMs: toMillisMaybe(fields.processingLeaseExpiresAt),
    fulfillmentQueueReenqueuedAtMs: toMillisMaybe(fields.fulfillmentQueueReenqueuedAt),
    lastFulfillmentReconciliationError: isRecord(failure) && typeof failure.name === 'string'
      ? { name: failure.name, ...(typeof failure.message === 'string' ? { message: failure.message } : {}) }
      : undefined,
    lastFulfillmentReconciliationErrorAtMs: toMillisMaybe(fields.lastFulfillmentReconciliationErrorAt),
  };
}

export async function getStripeCheckout(
  reader: Pick<D1CommerceRepository, 'get'>,
  key: CommerceDocumentKey<'stripe_checkout'>,
): Promise<StripeCheckoutRecord | null> {
  return stripeCheckoutRecord(key, await reader.get(key));
}

export function validateStripeCheckoutForFulfillment(
  record: StripeCheckoutRecord,
  expected: { dropId: string; sessionId: string; variantKey?: string; expectedLivemode?: boolean },
): ValidatedStripeCheckoutRecord {
  try {
    return { key: record.key, ...validateStripeCheckoutDocumentData({ ...expected, checkout: record.fields }) };
  } catch (error) {
    throw new StripeCheckoutFulfillmentError(
      'failed-precondition',
      error instanceof Error ? error.message : String(error),
      { dropId: expected.dropId, sessionId: expected.sessionId },
    );
  }
}

export function updateStripeCheckout(
  transaction: Pick<CommerceUnitOfWork, 'update'>,
  key: CommerceDocumentKey<'stripe_checkout'>,
  updates: StripeCheckoutUpdate,
): Promise<void> {
  return transaction.update(key, stripeCheckoutWriteData(updates));
}

export function mergeStripeCheckout(
  transaction: Pick<CommerceUnitOfWork, 'set'>,
  key: CommerceDocumentKey<'stripe_checkout'>,
  updates: StripeCheckoutUpdate,
): Promise<void> {
  return transaction.set(key, stripeCheckoutWriteData(updates), { merge: true });
}

function jsonValue(value: unknown): CommerceJsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, jsonValue(entry)]),
    );
  }
  throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe checkout document value.');
}

function updateValue(value: unknown): CommerceUpdateValue {
  if (isCommerceTimestamp(value)) {
    const { seconds, nanos } = value.value;
    const milliseconds = seconds * 1000 + nanos / 1_000_000;
    if (
      !Number.isSafeInteger(seconds) || seconds < 0 ||
      !Number.isInteger(nanos) || nanos < 0 || nanos > 999_999_999 ||
      !Number.isSafeInteger(milliseconds) || milliseconds < 0
    ) throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe checkout timestamp.');
    return value;
  }
  if (
    isCommerceServerTimestamp(value) || isCommerceDeleteField(value) ||
    isCommerceIncrement(value) || isCommerceArrayUnion(value)
  ) return value;
  return jsonValue(value);
}

export function stripeCheckoutWriteData(data: Record<string, unknown>): CommerceDocumentWriteData {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([field, value]) => [field, updateValue(value)]),
  );
}
