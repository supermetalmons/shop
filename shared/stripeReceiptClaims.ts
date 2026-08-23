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

export type StripeAssignedIrlClaim = {
  boxId: number;
  boxAssetId: string;
  dudeIds: number[];
};

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveBoxIdOrNull(value: unknown): number | null {
  const boxId = Math.floor(Number(value));
  return Number.isFinite(boxId) && boxId > 0 ? boxId : null;
}

export function orderStripeReceiptClaimByBoxId(
  order: unknown,
  boxId: number,
  options: { includeSingularFallback?: boolean; acceptClaim?: (claim: Record<string, unknown>) => boolean } = {},
): Record<string, unknown> | null {
  if (!plainObject(order)) return null;
  const normalizedBoxId = positiveBoxIdOrNull(boxId);
  if (!normalizedBoxId) return null;
  const acceptClaim = options.acceptClaim || (() => true);
  const byBoxId = order.stripeReceiptClaimsByBoxId;
  if (plainObject(byBoxId)) {
    const claim = byBoxId[stripeReceiptClaimBoxMapKey(normalizedBoxId)] || byBoxId[String(normalizedBoxId)];
    if (plainObject(claim) && acceptClaim(claim)) return claim;
  }
  const claims = Array.isArray(order.stripeReceiptClaims) ? order.stripeReceiptClaims : [];
  const pluralClaim = claims.find((claim) =>
    plainObject(claim) && positiveBoxIdOrNull(claim.boxId) === normalizedBoxId && acceptClaim(claim));
  if (plainObject(pluralClaim)) return pluralClaim;
  if (!options.includeSingularFallback || !plainObject(order.stripeReceiptClaim)) return null;
  const items = Array.isArray(order.items) ? order.items : [];
  const firstItem = plainObject(items[0]) ? items[0] : {};
  const singularBoxId = positiveBoxIdOrNull(order.stripeReceiptClaim.boxId) || positiveBoxIdOrNull(firstItem.refId);
  return singularBoxId === normalizedBoxId && acceptClaim(order.stripeReceiptClaim)
    ? order.stripeReceiptClaim
    : null;
}

export function hasPluralStripeReceiptClaims(order: unknown): boolean {
  if (!plainObject(order)) return false;
  const byBoxId = order.stripeReceiptClaimsByBoxId;
  if (plainObject(byBoxId) && Object.keys(byBoxId).length > 0) return true;
  return Array.isArray(order.stripeReceiptClaims) && order.stripeReceiptClaims.length > 0;
}

export function stripeAssignedIrlClaimForBox(
  order: unknown,
  boxId: number,
  options: { itemsPerBox: number; maxDudeId: number },
): StripeAssignedIrlClaim | null {
  if (!plainObject(order)) return null;
  const normalizedBoxId = positiveBoxIdOrNull(boxId);
  if (!normalizedBoxId) throw new Error('Stripe IRL claim box id is invalid');
  const expectedCount = Math.floor(Number(options.itemsPerBox));
  if (!Number.isFinite(expectedCount) || expectedCount < 1) throw new Error('Stripe IRL claim itemsPerBox is invalid');
  const maxDudeId = Math.floor(Number(options.maxDudeId));
  if (!Number.isFinite(maxDudeId) || maxDudeId < 1) throw new Error('Stripe IRL claim maxDudeId is invalid');
  const claims = Array.isArray(order.irlClaims) ? order.irlClaims : [];
  const matchingClaims = claims.filter((entry) => plainObject(entry) && positiveBoxIdOrNull(entry.boxId) === normalizedBoxId);
  if (matchingClaims.length > 1) throw new Error('Stripe IRL claim has duplicate assigned box entries');
  const claim = matchingClaims[0];
  if (!plainObject(claim)) return null;
  if (!Array.isArray(claim.dudeIds)) throw new Error('Stripe IRL claim is missing assigned receipt ids');
  const dudeIds = claim.dudeIds.map(Number);
  if (dudeIds.length !== expectedCount) {
    throw new Error(`Stripe IRL claim has invalid assigned receipt count (expected ${expectedCount})`);
  }
  for (const dudeId of dudeIds) {
    if (!Number.isInteger(dudeId) || dudeId < 1 || dudeId > maxDudeId) {
      throw new Error(`Stripe IRL claim has invalid assigned receipt id: ${dudeId}`);
    }
  }
  if (new Set(dudeIds).size !== dudeIds.length) throw new Error('Stripe IRL claim has duplicate assigned receipt ids');
  const boxAssetId = typeof claim.boxAssetId === 'string' ? claim.boxAssetId.trim() : '';
  if (!boxAssetId) throw new Error('Stripe IRL claim is missing assigned pack receipt asset id');
  return { boxId: normalizedBoxId, boxAssetId, dudeIds };
}
