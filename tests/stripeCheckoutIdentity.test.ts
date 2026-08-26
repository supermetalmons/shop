import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
  STRIPE_CHECKOUT_OWNER_KIND_WALLET,
  buildStripeCheckoutDocument,
  buildStripeCheckoutSessionMetadata,
  stripeCheckoutAnonymousOwnerId,
} from '../shared/stripeCheckoutSession.ts';
import { normalizeStripeCheckoutIdentity } from '../shared/checkoutIdentity.ts';
import { validateStripeCheckoutDocumentData } from '../shared/stripeWebhook.ts';

const AUTH_SUBJECT = 'anon:00000000-0000-4000-8000-000000000001';
const WALLET = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';

function checkoutDocument() {
  return buildStripeCheckoutDocument({
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_123',
    uid: AUTH_SUBJECT,
    quantity: 1,
    unitAmountCents: 100,
    createdAt: 'created',
    updatedAt: 'updated',
  });
}

test('new anonymous checkout documents use only the canonical identity contract', () => {
  const checkout = checkoutDocument();
  assert.equal(stripeCheckoutAnonymousOwnerId(AUTH_SUBJECT), `anonymous:${AUTH_SUBJECT}`);
  assert.equal(checkout.uid, AUTH_SUBJECT);
  assert.equal(checkout.authSubject, AUTH_SUBJECT);
  assert.equal(checkout.owner, `anonymous:${AUTH_SUBJECT}`);
  assert.equal(checkout.ownerKind, STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS);
  assert.deepEqual(
    buildStripeCheckoutSessionMetadata({ dropId: 'card_nft_binder_devnet', uid: AUTH_SUBJECT }),
    {
      dropId: 'card_nft_binder_devnet',
      uid: AUTH_SUBJECT,
      fulfillmentMode: 'admin_variant_receipt',
      placeholder: 'stripe_direct_delivery',
      quantity: '1',
    },
  );
});

test('checkout identity normalization preserves the canonical document contract', () => {
  const checkout: Record<string, unknown> = checkoutDocument();
  assert.deepEqual(validateStripeCheckoutDocumentData({
    checkout,
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_123',
  }), {
    uid: AUTH_SUBJECT,
    owner: `anonymous:${AUTH_SUBJECT}`,
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
    authSubject: AUTH_SUBJECT,
    quantity: 1,
    unitAmountCents: 100,
    livemode: false,
    status: 'created',
  });
});

test('checkout identity normalization rejects mismatched and contaminated records', () => {
  const canonical = checkoutDocument();
  for (const invalid of [
    { ...canonical, authSubject: `${AUTH_SUBJECT}-other` },
    { ...canonical, owner: `anonymous:${AUTH_SUBJECT}-other` },
    { ...canonical, ownerKind: 'unknown' },
  ]) {
    assert.throws(() => normalizeStripeCheckoutIdentity(invalid));
  }

  assert.deepEqual(normalizeStripeCheckoutIdentity({
    uid: WALLET,
    owner: WALLET,
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_WALLET,
  }), {
    uid: WALLET,
    owner: WALLET,
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_WALLET,
  });
  assert.throws(() => normalizeStripeCheckoutIdentity({
    uid: WALLET,
    owner: WALLET,
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_WALLET,
    authSubject: '',
  }));
});
