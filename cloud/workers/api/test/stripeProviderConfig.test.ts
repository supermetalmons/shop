import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import {
  isStripeCredentialError,
  selectStripeApiKeys,
  stripeApiKeyKindForLog,
  stripeCredentialErrorSummary,
  stripeKeysForMode,
  STRIPE_API_VERSION,
} from '../src/stripeProviderConfig.ts';
import { stripeClientForKey } from '../src/stripeCheckout/provider.ts';

test('Stripe credentials retain mode separation, supplied order, trimming, and deduplication', () => {
  const keys = [' rk_test_secondary ', 'sk_live_primary', '', 'sk_test_primary', 'rk_test_secondary', 'invalid'];
  assert.deepEqual(selectStripeApiKeys(keys, 'test'), ['rk_test_secondary', 'sk_test_primary']);
  assert.deepEqual(selectStripeApiKeys(keys, 'live'), ['sk_live_primary']);
  assert.deepEqual(stripeKeysForMode({
    STRIPE_SECRET_KEY: ' sk_test_primary ',
    STRIPE_RESTRICTED_KEY: 'rk_test_secondary',
    STRIPE_SECRET_KEY_LIVE: 'sk_live_primary',
    STRIPE_RESTRICTED_KEY_LIVE: ' rk_live_secondary ',
  }, 'live'), ['sk_live_primary', 'rk_live_secondary']);
  assert.deepEqual(stripeKeysForMode({ STRIPE_SECRET_KEY: 'sk_live_wrong' }, 'test'), []);
  assert.deepEqual(stripeKeysForMode({
    STRIPE_SECRET_KEY: ' sk_test_same ', STRIPE_RESTRICTED_KEY: 'sk_test_same',
  }, 'test'), ['sk_test_same']);
  assert.deepEqual(stripeKeysForMode({}, 'live'), []);
});

test('Stripe credential failures are classified without copying sensitive error details', () => {
  const sdkError = new Stripe.errors.StripeAuthenticationError({ message: 'sensitive provider message' });
  for (const error of [sdkError, { rawType: 'StripePermissionError' }, { statusCode: 401 }, { raw: { statusCode: '403' } }]) {
    assert.equal(isStripeCredentialError(error), true);
  }
  for (const error of [null, undefined, false, '401', [], {}, { raw: null }, { statusCode: 500 }, { statusCode: 'invalid' }]) {
    assert.equal(isStripeCredentialError(error), false);
  }
  assert.equal(isStripeCredentialError({ statusCode: 500, raw: { statusCode: 401 } }), false);
  assert.deepEqual(stripeCredentialErrorSummary({
    type: 'StripePermissionError', rawType: 'other', raw: { statusCode: 403, secret: 'hidden' },
    message: 'sensitive provider message',
  }), { type: 'StripePermissionError', statusCode: 403 });
  assert.deepEqual(stripeCredentialErrorSummary(null), { type: 'StripeCredentialError', statusCode: undefined });
  assert.equal(stripeApiKeyKindForLog(' sk_test_private_value '), 'sk_test');
  assert.equal(stripeApiKeyKindForLog('invalid'), 'unknown');
});

test('fulfillment Stripe clients retain their cache and explicitly use the existing API version', async () => {
  const client = await stripeClientForKey(' sk_test_config_test ', 'test');
  assert.equal(client.getApiField('version'), STRIPE_API_VERSION);
  assert.equal(STRIPE_API_VERSION, '2026-07-29.dahlia');
  assert.equal(await stripeClientForKey('sk_test_config_test', 'test'), client);
  await assert.rejects(stripeClientForKey('sk_test_config_test', 'live'), /Stripe live key is not configured/);
});
