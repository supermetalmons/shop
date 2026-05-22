import { HttpsError } from 'firebase-functions/v2/https';
import type Stripe from 'stripe';

const cachedStripeClientsByKey = new Map<string, Stripe>();
let cachedStripeCtor: typeof import('stripe').default | null = null;

export type StripeApiMode = 'test' | 'live';

async function stripeCtor(): Promise<typeof import('stripe').default> {
  if (cachedStripeCtor) return cachedStripeCtor;
  const mod = await import('stripe');
  cachedStripeCtor = mod.default;
  return cachedStripeCtor;
}

export function isStripeTestApiKey(key: string): boolean {
  return /^(sk|rk)_test_/.test(String(key || '').trim());
}

export function isStripeLiveApiKey(key: string): boolean {
  return /^(sk|rk)_live_/.test(String(key || '').trim());
}

export function isStripeApiKeyForMode(key: string, mode: StripeApiMode): boolean {
  return mode === 'live' ? isStripeLiveApiKey(key) : isStripeTestApiKey(key);
}

export function stripeApiKeyKindForLog(key: string): string {
  const match = /^(sk|rk)_(test|live)_/.exec(String(key || '').trim());
  return match ? `${match[1]}_${match[2]}` : 'unknown';
}

export function isStripeCredentialError(err: unknown): boolean {
  const anyErr = err as any;
  const type = String(anyErr?.type || anyErr?.rawType || anyErr?.name || '');
  const statusCode = Number(anyErr?.statusCode ?? anyErr?.raw?.statusCode);
  return (
    type === 'StripeAuthenticationError' ||
    type === 'StripePermissionError' ||
    statusCode === 401 ||
    statusCode === 403
  );
}

export function stripeCredentialErrorSummary(err: unknown): Record<string, unknown> {
  const anyErr = err as any;
  return {
    type: String(anyErr?.type || anyErr?.rawType || anyErr?.name || 'StripeCredentialError'),
    statusCode: Number(anyErr?.statusCode ?? anyErr?.raw?.statusCode) || undefined,
  };
}

export async function stripeClientForKey(key: string, mode: StripeApiMode): Promise<Stripe> {
  const normalized = String(key || '').trim();
  if (!isStripeApiKeyForMode(normalized, mode)) {
    throw new HttpsError('failed-precondition', `Stripe ${mode} key is not configured.`);
  }
  const cached = cachedStripeClientsByKey.get(normalized);
  if (cached) return cached;
  const StripeClient = await stripeCtor();
  const client = new StripeClient(normalized);
  cachedStripeClientsByKey.set(normalized, client);
  return client;
}

export async function constructStripeWebhookEvent(
  rawBody: Buffer,
  signature: string,
  webhookSecret: string,
): Promise<Stripe.Event> {
  const StripeClient = await stripeCtor();
  return StripeClient.webhooks.constructEvent(rawBody, signature, webhookSecret);
}
