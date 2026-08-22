const STRIPE_RECEIPT_CLAIM_CODE_PATTERN = /^[A-Z]{6}-\d{10}$/;
const STRIPE_RECEIPT_CLAIM_CODE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const STRIPE_RECEIPT_CLAIM_DIGIT_MAX = 10 ** 10;

export const STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE = 'stripe_receipt_v1';

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

export function requireStripeReceiptClaimCode(code: unknown): string {
  const normalized = normalizeStripeReceiptClaimCode(code);
  if (!isStripeReceiptClaimCode(normalized)) {
    throw new Error('Invalid Stripe receipt claim code');
  }
  return normalized;
}

function secureRandomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new Error('Invalid random bound');
  const maximum = BigInt(maxExclusive);
  const range = 1n << 64n;
  const limit = range - (range % maximum);
  const bytes = new Uint8Array(8);
  let value: bigint;
  do {
    crypto.getRandomValues(bytes);
    value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  } while (value >= limit);
  return Number(value % maximum);
}

export function generateStripeReceiptClaimCode(): string {
  let prefix = '';
  for (let index = 0; index < 6; index += 1) {
    prefix += STRIPE_RECEIPT_CLAIM_CODE_LETTERS[secureRandomInt(STRIPE_RECEIPT_CLAIM_CODE_LETTERS.length)];
  }
  return `${prefix}-${String(secureRandomInt(STRIPE_RECEIPT_CLAIM_DIGIT_MAX)).padStart(10, '0')}`;
}

export function generateUniqueStripeReceiptClaimCodes(quantity: number): string[] {
  const normalizedQuantity = Math.floor(Number(quantity));
  if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
    throw new Error('Stripe receipt claim code quantity must be positive');
  }
  const codes = new Set<string>();
  while (codes.size < normalizedQuantity) codes.add(generateStripeReceiptClaimCode());
  return [...codes];
}

export function stripeReceiptClaimBoxMapKey(boxId: number): string {
  return `box_${boxId}`;
}

export function stripeReceiptClaimCodeMaybe(rawClaim: unknown): string {
  return rawClaim && typeof rawClaim === 'object' && !Array.isArray(rawClaim) &&
    typeof (rawClaim as { code?: unknown }).code === 'string'
    ? normalizeStripeReceiptClaimCode((rawClaim as { code: string }).code)
    : '';
}

export function buildStripeReceiptClaimsByBoxId(
  claims: Array<{ namespace: string; code: string; boxId: number; status: string }>,
): Record<string, { namespace: string; code: string; boxId: number; status: string }> {
  return Object.fromEntries(claims.map((claim) => [stripeReceiptClaimBoxMapKey(claim.boxId), claim]));
}
