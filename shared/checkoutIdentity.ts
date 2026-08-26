import { canonicalWalletAddress } from './walletLifecycle.ts';

export const STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS = 'anonymous';
export const STRIPE_CHECKOUT_OWNER_KIND_WALLET = 'wallet';

export type StripeCheckoutAnonymousIdentity = {
  authSubject: string;
  owner: string;
  ownerKind: typeof STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS;
  uid: string;
};

export type StripeCheckoutWalletIdentity = {
  owner: string;
  ownerKind: typeof STRIPE_CHECKOUT_OWNER_KIND_WALLET;
  uid: string;
};

export type StripeCheckoutIdentity = StripeCheckoutAnonymousIdentity | StripeCheckoutWalletIdentity;

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requireAuthSubject(value: unknown): string {
  const authSubject = normalizedString(value);
  if (!authSubject || authSubject.length > 128) {
    throw new Error('App-created Stripe checkout has invalid auth subject');
  }
  return authSubject;
}

export function stripeCheckoutAnonymousOwnerId(authSubject: string): string {
  return `${STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS}:${requireAuthSubject(authSubject)}`;
}

export function normalizeStripeCheckoutIdentity(checkout: Record<string, unknown>): StripeCheckoutIdentity {
  const uid = normalizedString(checkout.uid);
  if (!uid) throw new Error('App-created Stripe checkout is missing uid');
  const ownerKind = normalizedString(checkout.ownerKind);

  if (ownerKind === STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS) {
    const authSubject = requireAuthSubject(checkout.authSubject);
    if (uid !== authSubject || normalizedString(checkout.owner) !== stripeCheckoutAnonymousOwnerId(authSubject)) {
      throw new Error('App-created Stripe checkout has invalid anonymous owner');
    }
    return {
      uid,
      owner: stripeCheckoutAnonymousOwnerId(authSubject),
      ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
      authSubject,
    };
  }

  if (ownerKind === STRIPE_CHECKOUT_OWNER_KIND_WALLET) {
    const wallet = canonicalWalletAddress(checkout.owner);
    if (!wallet || uid !== wallet || Object.hasOwn(checkout, 'authSubject')) {
      throw new Error('App-created Stripe checkout has invalid wallet owner');
    }
    return { uid, owner: wallet, ownerKind: STRIPE_CHECKOUT_OWNER_KIND_WALLET };
  }

  throw new Error('App-created Stripe checkout has invalid owner kind');
}
