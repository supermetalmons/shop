import { StripeCheckoutFulfillmentError } from './errors.js';
import type Stripe from 'stripe';
import {
  isStripeApiKeyForMode,
  STRIPE_API_VERSION,
  type StripeApiMode,
} from '../stripeProviderConfig.js';

const cachedStripeClientsByKey = new Map<string, Stripe>();
let cachedStripeCtor: typeof import('stripe').default | null = null;

async function stripeCtor(): Promise<typeof import('stripe').default> {
  if (cachedStripeCtor) return cachedStripeCtor;
  const mod = await import('stripe');
  cachedStripeCtor = mod.default;
  return cachedStripeCtor;
}

export async function stripeClientForKey(key: string, mode: StripeApiMode): Promise<Stripe> {
  const normalized = String(key || '').trim();
  if (!isStripeApiKeyForMode(normalized, mode)) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', `Stripe ${mode} key is not configured.`);
  }
  const cached = cachedStripeClientsByKey.get(normalized);
  if (cached) return cached;
  const StripeClient = await stripeCtor();
  const client = new StripeClient(normalized, { apiVersion: STRIPE_API_VERSION });
  cachedStripeClientsByKey.set(normalized, client);
  return client;
}
