export const STRIPE_OWNER_MERGE_LIMIT_ERROR_REASON = 'stripe-owner-merge-limit';
export const WALLET_SESSION_SUPERSEDED_ERROR_REASON = 'wallet-session-superseded';

export function normalizeApiErrorCode(code: unknown): string {
  return typeof code === 'string' ? code : '';
}
