import type { StripeReceiptClaimRequest } from './contracts.js';

export const STRIPE_RECEIPT_CLAIM_START_PATH = '/receipts/stripe/claim/start';
export const STRIPE_RECEIPT_CLAIM_STATUS_PATH = '/receipts/stripe/claim/status';
export const STRIPE_RECEIPT_CLAIM_REQUEST_HEADER = 'X-Mons-Receipt-Claim-Request';
export const STRIPE_RECEIPT_CLAIM_HTTP_TIMEOUT_MS = 20_000;
export const STRIPE_RECEIPT_CLAIM_POLL_INTERVAL_MS = 2_000;
export const STRIPE_RECEIPT_CLAIM_OVERALL_TIMEOUT_MS = 190_000;

export type StripeReceiptClaimOperationId = `src-v1-${string}`;

export type StripeReceiptClaimStatusRequest = StripeReceiptClaimRequest & {
  operationId: StripeReceiptClaimOperationId;
};

export type StripeReceiptClaimPendingResponse = {
  accepted: true;
  operationId: StripeReceiptClaimOperationId;
  status: 'pending';
  retryAfterMs: typeof STRIPE_RECEIPT_CLAIM_POLL_INTERVAL_MS;
};

export function isStripeReceiptClaimOperationId(value: unknown): value is StripeReceiptClaimOperationId {
  return typeof value === 'string' &&
    /^src-v1-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}

export function parseStripeReceiptClaimPendingResponse(value: unknown): StripeReceiptClaimPendingResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 4 ||
    !['accepted', 'operationId', 'status', 'retryAfterMs'].every((key) => Object.hasOwn(record, key)) ||
    record.accepted !== true ||
    !isStripeReceiptClaimOperationId(record.operationId) ||
    record.status !== 'pending' ||
    record.retryAfterMs !== STRIPE_RECEIPT_CLAIM_POLL_INTERVAL_MS
  ) return null;
  return {
    accepted: true,
    operationId: record.operationId,
    status: 'pending',
    retryAfterMs: STRIPE_RECEIPT_CLAIM_POLL_INTERVAL_MS,
  };
}
