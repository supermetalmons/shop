export const TAROT_MAX_CARDS = 777;

export function isTarotTokenId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= TAROT_MAX_CARDS;
}

export function isTarotClaimCode(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
