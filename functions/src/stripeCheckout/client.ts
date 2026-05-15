import { HttpsError } from 'firebase-functions/v2/https';
import type Stripe from 'stripe';

const cachedStripeClientsByKey = new Map<string, Stripe>();
let cachedStripeCtor: typeof import('stripe').default | null = null;

async function stripeCtor(): Promise<typeof import('stripe').default> {
  if (cachedStripeCtor) return cachedStripeCtor;
  const mod = await import('stripe');
  cachedStripeCtor = mod.default;
  return cachedStripeCtor;
}

export function isStripeTestApiKey(key: string): boolean {
  return /^(sk|rk)_test_/.test(String(key || '').trim());
}

export async function stripeClientForKey(key: string): Promise<Stripe> {
  const normalized = String(key || '').trim();
  if (!isStripeTestApiKey(normalized)) {
    throw new HttpsError('failed-precondition', 'Stripe test key is not configured.');
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
