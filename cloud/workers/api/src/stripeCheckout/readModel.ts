import {
  normalizeStripeCheckoutIdentity,
  type StripeCheckoutIdentity,
} from '../../../../../shared/checkoutIdentity.js';
import {
  isManualReviewCheckout,
  manualReviewCheckoutFromRecord,
} from '../../../../../shared/fulfillmentReadModel.js';
import {
  STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
  type StripeCheckoutFulfillmentEventType,
} from '../../../../../shared/stripeCheckoutFulfillmentJob.js';
import { STRIPE_CHECKOUT_STATUS } from '../../../../../shared/stripeCheckoutSession.js';
import type { CommerceDocumentRecord } from '../commerceRepository.js';
import { isRecord } from '../dataAccess.js';
import { toMillisMaybe } from '../time.js';

export type StripeCheckoutTerminalState = {
  status?: string;
  manualRefundReviewRequired?: boolean;
};

export type StripeCheckoutNotificationView = {
  status: string;
  manualRefundReviewRequired: boolean;
  deliveryId: number | undefined;
  identity: StripeCheckoutIdentity | null;
  livemode: boolean;
  variantKey: string | undefined;
  manualRefundReviewReason: string | undefined;
  lastFulfillmentError: unknown;
  createdAtMs: number | undefined;
  fulfillmentRequestedAtMs: number | undefined;
  processingStartedAtMs: number | undefined;
  failedAtMs: number | undefined;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function stripeCheckoutNotificationView(value: unknown): StripeCheckoutNotificationView {
  const fields = isRecord(value) ? value : {};
  return {
    status: typeof fields.status === 'string' ? fields.status : '',
    manualRefundReviewRequired: fields.manualRefundReviewRequired === true,
    get deliveryId() {
      const deliveryId = Number(fields.deliveryId);
      return Number.isSafeInteger(deliveryId) && deliveryId > 0 ? deliveryId : undefined;
    },
    get identity() {
      try { return normalizeStripeCheckoutIdentity(fields); } catch { return null; }
    },
    livemode: fields.livemode === true,
    variantKey: optionalString(fields.variantKey),
    manualRefundReviewReason: optionalString(fields.manualRefundReviewReason),
    lastFulfillmentError: fields.lastFulfillmentError,
    get createdAtMs() { return toMillisMaybe(fields.createdAt); },
    get fulfillmentRequestedAtMs() { return toMillisMaybe(fields.fulfillmentRequestedAt); },
    get processingStartedAtMs() { return toMillisMaybe(fields.processingStartedAt); },
    get failedAtMs() { return toMillisMaybe(fields.failedAt); },
  };
}

export type StripeCheckoutRequeueCandidate = {
  checkoutPath: string;
  dropId: string;
  sessionId: string;
  stripeEventId: string;
  stripeEventType: StripeCheckoutFulfillmentEventType;
};

export function stripeCheckoutRequeueCandidate(
  document: CommerceDocumentRecord,
  cutoffMs: number,
): StripeCheckoutRequeueCandidate | null {
  if (document.key.kind !== 'stripe_checkout' || !document.key.dropId) return null;
  const fields = document.data;
  if (
    (fields.status !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING && fields.status !== STRIPE_CHECKOUT_STATUS.PROCESSING) ||
    fields.fulfillmentProcessor !== STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR ||
    typeof fields.updatedAt !== 'number' || fields.updatedAt > cutoffMs ||
    typeof fields.lastStripeWebhookEventId !== 'string'
  ) return null;
  return {
    checkoutPath: `drops/${document.key.dropId}/stripeCheckouts/${document.key.documentId}`,
    dropId: document.key.dropId,
    sessionId: document.key.documentId,
    stripeEventId: fields.lastStripeWebhookEventId,
    stripeEventType: fields.lastStripeWebhookEventType === 'checkout.session.async_payment_succeeded'
      ? fields.lastStripeWebhookEventType : 'checkout.session.completed',
  };
}

export function stripeCheckoutManualReviewSessionId(document: CommerceDocumentRecord): string | null {
  if (!isManualReviewCheckout(document.data)) return null;
  const sessionId = optionalString(document.data.sessionId) || document.key.documentId;
  return /^[A-Za-z0-9_:-]{4,256}$/.test(sessionId) ? sessionId : null;
}

export function stripeCheckoutManualReviewSummary(args: {
  document: CommerceDocumentRecord;
  canViewSensitiveAddress: boolean;
  dropId: string;
  session: unknown;
  sessionId: string;
}): ReturnType<typeof manualReviewCheckoutFromRecord> {
  const fields = args.document.data;
  const checkout = Object.fromEntries([
    'manualRefundReviewRequired', 'status', 'sessionId', 'stripeSessionSummary', 'quantity', 'owner',
    'ownerKind', 'authSubject', 'uid', 'manualRefundReviewReason', 'lastFulfillmentError', 'createdAt', 'failedAt',
  ].filter((field) => Object.hasOwn(fields, field)).map((field) => [field, fields[field]]));
  return manualReviewCheckoutFromRecord({ ...args, checkout });
}
