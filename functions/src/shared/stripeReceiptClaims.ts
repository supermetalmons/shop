const STRIPE_RECEIPT_CLAIM_CODE_PATTERN = /^[A-Z]{6}-\d{10}$/;

function normalizedString(value: unknown): string {
  return String(value || '').trim();
}

export function normalizeStripeReceiptClaimCode(code: unknown): string {
  return normalizedString(code).toUpperCase();
}

export function requireStripeReceiptClaimCode(code: unknown): string {
  const normalized = normalizeStripeReceiptClaimCode(code);
  if (!STRIPE_RECEIPT_CLAIM_CODE_PATTERN.test(normalized)) {
    throw new Error('Invalid Stripe receipt claim code');
  }
  return normalized;
}
