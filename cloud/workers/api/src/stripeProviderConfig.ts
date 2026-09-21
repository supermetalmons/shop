import type Stripe from 'stripe';
import type { StripeCheckoutMode } from '../../../../shared/stripeCheckoutCore.js';
import { isRecord } from './dataAccess.js';

export type StripeApiMode = StripeCheckoutMode;
export type StripeProviderEnv = Partial<Pick<Env,
  'STRIPE_SECRET_KEY' | 'STRIPE_RESTRICTED_KEY' | 'STRIPE_SECRET_KEY_LIVE' | 'STRIPE_RESTRICTED_KEY_LIVE'
>>;

export const STRIPE_API_VERSION = '2026-07-29.dahlia' satisfies Stripe.LatestApiVersion;
export const STRIPE_API_BASE_URL = 'https://api.stripe.com/v1';

export function isStripeApiKeyForMode(key: string, mode: StripeApiMode): boolean {
  const pattern = mode === 'live' ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/;
  return pattern.test(String(key || '').trim());
}

export function selectStripeApiKeys(keys: readonly string[], mode: StripeApiMode): string[] {
  return Array.from(new Set(keys
    .map((value) => String(value || '').trim())
    .filter((key) => isStripeApiKeyForMode(key, mode))));
}

export function stripeKeysForMode(env: StripeProviderEnv, mode: StripeApiMode): string[] {
  const keys = mode === 'live'
    ? [env.STRIPE_SECRET_KEY_LIVE, env.STRIPE_RESTRICTED_KEY_LIVE]
    : [env.STRIPE_SECRET_KEY, env.STRIPE_RESTRICTED_KEY];
  return selectStripeApiKeys(keys.map((key) => key || ''), mode);
}

export function stripeApiKeyKindForLog(key: string): string {
  const match = /^(sk|rk)_(test|live)_/.exec(String(key || '').trim());
  return match ? `${match[1]}_${match[2]}` : 'unknown';
}

export function stripeCredentialErrorSummary(error: unknown): {
  type: string;
  statusCode: number | undefined;
} {
  const record = isRecord(error) ? error : {};
  const raw = isRecord(record.raw) ? record.raw : {};
  return {
    type: String(record.type || record.rawType || record.name || 'StripeCredentialError'),
    statusCode: Number(record.statusCode ?? raw.statusCode) || undefined,
  };
}

export function isStripeCredentialError(error: unknown): boolean {
  const { type, statusCode } = stripeCredentialErrorSummary(error);
  return type === 'StripeAuthenticationError' || type === 'StripePermissionError' ||
    statusCode === 401 || statusCode === 403;
}
