import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasAlphabeticClaimCodeCharacters,
  isStripeReceiptClaimCode,
  normalizeStripeReceiptClaimCode,
} from '../src/lib/stripeReceiptClaims.ts';
import {
  normalizeStripeReceiptClaimCode as normalizeBackendStripeReceiptClaimCode,
  requireStripeReceiptClaimCode,
} from '../functions/src/stripeCheckout/contract.ts';

test('Stripe receipt claim helpers normalize and detect canonical codes', () => {
  assert.equal(normalizeStripeReceiptClaimCode('  abcdef-0123456789  '), 'ABCDEF-0123456789');
  assert.equal(isStripeReceiptClaimCode('abcdef-0123456789'), true);
  assert.equal(isStripeReceiptClaimCode('ABCDEF0123456789'), false);
  assert.equal(isStripeReceiptClaimCode('1234567890'), false);
});

test('claim code alphabetic detection separates invalid Stripe-like input from numeric legacy codes', () => {
  assert.equal(hasAlphabeticClaimCodeCharacters('ABCDEF0123456789'), true);
  assert.equal(hasAlphabeticClaimCodeCharacters('123-456 7890'), false);
});

test('frontend and backend Stripe receipt claim code contracts stay aligned', () => {
  const validCodes = ['ABCDEF-0123456789', '  abcdef-0123456789  '];
  for (const code of validCodes) {
    assert.equal(normalizeStripeReceiptClaimCode(code), normalizeBackendStripeReceiptClaimCode(code));
    assert.equal(isStripeReceiptClaimCode(code), true);
    assert.equal(requireStripeReceiptClaimCode(code), normalizeStripeReceiptClaimCode(code));
  }

  for (const code of ['ABCDEF0123456789', '1234567890', 'ABCDE-0123456789', 'ABCDEF-012345678']) {
    assert.equal(isStripeReceiptClaimCode(code), false);
    assert.throws(() => requireStripeReceiptClaimCode(code), /Invalid Stripe receipt claim code/);
  }
});
