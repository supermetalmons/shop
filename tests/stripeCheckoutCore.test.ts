import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRIPE_TEST_UNIT_AMOUNT_CENTS_DEFAULT,
  STRIPE_UNIT_AMOUNT_CENTS_MAX,
  STRIPE_UNIT_AMOUNT_CENTS_MIN,
  classifyStripeCheckoutKind,
  normalizeStripeUnitAmountCents,
  resolveStripeCheckoutUnitAmountCents,
  stripeCheckoutModeForCluster,
  stripeCheckoutModeForDrop,
} from '../functions/src/shared/stripeCheckoutCore.ts';

test('Stripe checkout mode preserves enablement and supported-cluster nullability', () => {
  assert.equal(stripeCheckoutModeForCluster('devnet'), 'test');
  assert.equal(stripeCheckoutModeForCluster('mainnet-beta'), 'live');
  assert.equal(stripeCheckoutModeForCluster('testnet'), null);
  assert.equal(stripeCheckoutModeForCluster(undefined), null);

  assert.equal(stripeCheckoutModeForDrop(null), null);
  assert.equal(stripeCheckoutModeForDrop({ stripeCheckoutEnabled: false, solanaCluster: 'devnet' }), null);
  assert.equal(stripeCheckoutModeForDrop({ stripeCheckoutEnabled: true, solanaCluster: 'devnet' }), 'test');
  assert.equal(stripeCheckoutModeForDrop({ stripeCheckoutEnabled: true, solanaCluster: 'mainnet-beta' }), 'live');
  assert.equal(stripeCheckoutModeForDrop({ stripeCheckoutEnabled: true, solanaCluster: 'testnet' }), null);
  assert.equal(stripeCheckoutModeForDrop({ stripeCheckoutEnabled: 'yes', solanaCluster: 'devnet' }), 'test');
});

test('Stripe checkout kind accepts direct-delivery sizes and standard packs only', () => {
  assert.equal(
    classifyStripeCheckoutKind({ itemsPerBox: 0, mintSelection: { kind: 'size' } }),
    'size_variant',
  );
  assert.equal(
    classifyStripeCheckoutKind({ itemsPerBox: 0.9, mintSelection: { kind: 'size' } }),
    'size_variant',
  );
  assert.equal(classifyStripeCheckoutKind({ itemsPerBox: 1 }), 'standard_pack');
  assert.equal(classifyStripeCheckoutKind({ itemsPerBox: '5.9' }), 'standard_pack');

  assert.equal(classifyStripeCheckoutKind(null), null);
  assert.equal(classifyStripeCheckoutKind({ itemsPerBox: 0 }), null);
  assert.equal(classifyStripeCheckoutKind({ itemsPerBox: 5, mintSelection: { kind: 'size' } }), null);
  assert.equal(classifyStripeCheckoutKind({ itemsPerBox: 5, mintSelection: { kind: 'other' } }), null);
  assert.equal(classifyStripeCheckoutKind({ itemsPerBox: 'not-a-number' }), null);
});

test('Stripe unit amount normalization floors finite values within exact bounds', () => {
  assert.equal(normalizeStripeUnitAmountCents(STRIPE_UNIT_AMOUNT_CENTS_MIN - 1), null);
  assert.equal(normalizeStripeUnitAmountCents(49.999), null);
  assert.equal(normalizeStripeUnitAmountCents(STRIPE_UNIT_AMOUNT_CENTS_MIN), 50);
  assert.equal(normalizeStripeUnitAmountCents(50.99), 50);
  assert.equal(normalizeStripeUnitAmountCents(String(STRIPE_UNIT_AMOUNT_CENTS_MAX)), 99_999_999);
  assert.equal(normalizeStripeUnitAmountCents(99_999_999.99), 99_999_999);
  assert.equal(normalizeStripeUnitAmountCents(STRIPE_UNIT_AMOUNT_CENTS_MAX + 1), null);
  assert.equal(normalizeStripeUnitAmountCents('not-a-number'), null);
  assert.equal(normalizeStripeUnitAmountCents(Number.NaN), null);
  assert.equal(normalizeStripeUnitAmountCents(Number.POSITIVE_INFINITY), null);
});

test('Stripe checkout amount resolution preserves test fallback and missing live null', () => {
  assert.equal(STRIPE_TEST_UNIT_AMOUNT_CENTS_DEFAULT, 100);
  assert.equal(
    resolveStripeCheckoutUnitAmountCents({
      mode: null,
      testConfiguredUnitAmountCents: 250,
      testFallbackUnitAmountCents: 100,
      liveConfiguredUnitAmountCents: 24_900,
    }),
    null,
  );
  assert.equal(
    resolveStripeCheckoutUnitAmountCents({
      mode: 'test',
      testConfiguredUnitAmountCents: '250.9',
      testFallbackUnitAmountCents: 100,
      liveConfiguredUnitAmountCents: undefined,
    }),
    250,
  );
  assert.equal(
    resolveStripeCheckoutUnitAmountCents({
      mode: 'test',
      testConfiguredUnitAmountCents: 'invalid',
      testFallbackUnitAmountCents: STRIPE_TEST_UNIT_AMOUNT_CENTS_DEFAULT,
      liveConfiguredUnitAmountCents: undefined,
    }),
    100,
  );
  assert.equal(
    resolveStripeCheckoutUnitAmountCents({
      mode: 'test',
      testConfiguredUnitAmountCents: 49,
      testFallbackUnitAmountCents: 49,
      liveConfiguredUnitAmountCents: undefined,
    }),
    null,
  );
  assert.equal(
    resolveStripeCheckoutUnitAmountCents({
      mode: 'live',
      testConfiguredUnitAmountCents: 250,
      testFallbackUnitAmountCents: 100,
      liveConfiguredUnitAmountCents: undefined,
    }),
    null,
  );
  assert.equal(
    resolveStripeCheckoutUnitAmountCents({
      mode: 'live',
      testConfiguredUnitAmountCents: 250,
      testFallbackUnitAmountCents: 100,
      liveConfiguredUnitAmountCents: 24_900.9,
    }),
    24_900,
  );
});
