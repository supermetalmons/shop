export const STRIPE_OWNER_MERGE_LIMIT_ERROR_REASON = 'stripe-owner-merge-limit';
export const WALLET_SESSION_SUPERSEDED_ERROR_REASON = 'wallet-session-superseded';

export function normalizeCallableErrorCode(code: unknown): string {
  const value = typeof code === 'string' ? code : '';
  return value.startsWith('functions/')
    ? value.slice('functions/'.length)
    : value;
}
