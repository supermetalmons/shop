import { stripeCheckoutStateFromDocument, type StripeCheckoutState } from '../../shared/stripeCheckoutState.ts';
import type { CommerceD1Document } from './commerceD1Maintenance.ts';

export function planStripeCheckoutStateBackfill(document: CommerceD1Document): StripeCheckoutState {
  if (document.kind !== 'stripe_checkout') throw new Error(`Not a Stripe checkout: ${document.path}.`);
  try {
    return stripeCheckoutStateFromDocument(document.path, document.data, document.version);
  } catch (cause) {
    throw new Error(`Stripe checkout state validation failed for ${document.path}.`, { cause });
  }
}
