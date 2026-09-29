import { isCommerceDocumentSegment } from './commerceDocumentPath.ts';

export const STRIPE_CHECKOUT_STATE_FIELD_COLUMNS = {
  status: 'status',
  processingAttemptId: 'processing_attempt_id',
  processingAttemptCount: 'processing_attempt_count',
  processingStartedAt: 'processing_started_at_ms',
  processingLeaseExpiresAt: 'processing_lease_expires_at_ms',
  lastRetryableFulfillmentAttempt: 'last_retryable_fulfillment_attempt',
  lastRetryableFulfillmentErrorAt: 'last_retryable_fulfillment_error_at_ms',
  nextFulfillmentRetryAt: 'next_fulfillment_retry_at_ms',
  fulfillmentQueueReenqueuedAt: 'fulfillment_queue_reenqueued_at_ms',
  lastFulfillmentReconciliationErrorAt: 'last_fulfillment_reconciliation_error_at_ms',
  updatedAt: 'updated_at_ms',
} as const;

export const STRIPE_CHECKOUT_STATE_FIELDS = Object.keys(STRIPE_CHECKOUT_STATE_FIELD_COLUMNS) as Array<keyof typeof STRIPE_CHECKOUT_STATE_FIELD_COLUMNS>;

export type StripeCheckoutStatus = 'created' | 'fulfillment_pending' | 'processing' | 'fulfilled' | 'fulfillment_failed';

export type StripeCheckoutState = {
  documentPath: string;
  documentVersion: number;
  status: StripeCheckoutStatus;
  processingAttemptId: string | null;
  processingAttemptCount: number | null;
  processingStartedAt: number | null;
  processingLeaseExpiresAt: number | null;
  lastRetryableFulfillmentAttempt: number | null;
  lastRetryableFulfillmentErrorAt: number | null;
  nextFulfillmentRetryAt: number | null;
  fulfillmentQueueReenqueuedAt: number | null;
  lastFulfillmentReconciliationErrorAt: number | null;
  updatedAt: number | null;
};

function invalid(): never {
  throw new Error('Invalid Stripe checkout state.');
}

function optionalInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

export function stripeCheckoutStateFromDocument(
  documentPath: string,
  data: Readonly<Record<string, unknown>>,
  documentVersion: number,
): StripeCheckoutState {
  const match = /^drops\/([^/]+)\/stripeCheckouts\/([^/]+)$/.exec(documentPath);
  if (!match || !isCommerceDocumentSegment(match[1]) || !isCommerceDocumentSegment(match[2]) ||
    !Number.isSafeInteger(documentVersion) || documentVersion < 1) invalid();
  if (!['created', 'fulfillment_pending', 'processing', 'fulfilled', 'fulfillment_failed'].includes(String(data.status)) ||
    typeof data.status !== 'string') invalid();
  const attemptId = data.processingAttemptId;
  if (attemptId !== undefined && attemptId !== null &&
    (typeof attemptId !== 'string' || attemptId.length < 1 || attemptId.length > 128)) invalid();
  return {
    documentPath, documentVersion, status: data.status as StripeCheckoutStatus,
    processingAttemptId: attemptId == null ? null : attemptId as string,
    processingAttemptCount: optionalInteger(data.processingAttemptCount),
    processingStartedAt: optionalInteger(data.processingStartedAt),
    processingLeaseExpiresAt: optionalInteger(data.processingLeaseExpiresAt),
    lastRetryableFulfillmentAttempt: optionalInteger(data.lastRetryableFulfillmentAttempt),
    lastRetryableFulfillmentErrorAt: optionalInteger(data.lastRetryableFulfillmentErrorAt),
    nextFulfillmentRetryAt: optionalInteger(data.nextFulfillmentRetryAt),
    fulfillmentQueueReenqueuedAt: optionalInteger(data.fulfillmentQueueReenqueuedAt),
    lastFulfillmentReconciliationErrorAt: optionalInteger(data.lastFulfillmentReconciliationErrorAt),
    updatedAt: optionalInteger(data.updatedAt),
  };
}

export function stripeCheckoutStateRow(state: StripeCheckoutState): Record<string, string | number | null> {
  return {
    document_path: state.documentPath,
    document_version: state.documentVersion,
    ...Object.fromEntries(STRIPE_CHECKOUT_STATE_FIELDS.map((field) => [STRIPE_CHECKOUT_STATE_FIELD_COLUMNS[field], state[field]])),
  };
}

export function parseStripeCheckoutStateRow(value: unknown): StripeCheckoutState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (typeof row.document_path !== 'string' || typeof row.document_version !== 'number' ||
    STRIPE_CHECKOUT_STATE_FIELDS.some((field) => !Object.hasOwn(row, STRIPE_CHECKOUT_STATE_FIELD_COLUMNS[field]))) invalid();
  return stripeCheckoutStateFromDocument(row.document_path, Object.fromEntries(
    STRIPE_CHECKOUT_STATE_FIELDS.map((field) => [field, row[STRIPE_CHECKOUT_STATE_FIELD_COLUMNS[field]]]),
  ), row.document_version);
}

export function hydrateStripeCheckoutState<T extends Record<string, unknown>>(data: T, state: StripeCheckoutState): T {
  const hydrated = { ...data } as Record<string, unknown>;
  for (const field of STRIPE_CHECKOUT_STATE_FIELDS) {
    delete hydrated[field];
    if (state[field] !== null) hydrated[field] = state[field];
  }
  return hydrated as T;
}

export function stripeCheckoutStateMetadata<T extends Record<string, unknown>>(data: T, originalRawData: T): T {
  const metadata = { ...data };
  for (const field of STRIPE_CHECKOUT_STATE_FIELDS) {
    delete metadata[field];
    if (Object.hasOwn(originalRawData, field)) metadata[field as keyof T] = originalRawData[field] as T[keyof T];
  }
  return metadata;
}
