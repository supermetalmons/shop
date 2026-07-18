const STRIPE_RECEIPT_CLAIM_CODE_PATTERN = /^[A-Z]{6}-\d{10}$/;

function normalizedString(value: unknown): string {
  return String(value || '').trim();
}

export function normalizeStripeReceiptClaimCode(code: unknown): string {
  return normalizedString(code).toUpperCase();
}

export function isStripeReceiptClaimCode(code: unknown): boolean {
  return STRIPE_RECEIPT_CLAIM_CODE_PATTERN.test(normalizeStripeReceiptClaimCode(code));
}

export function hasAlphabeticClaimCodeCharacters(code: unknown): boolean {
  return /[A-Za-z]/.test(String(code || ''));
}
