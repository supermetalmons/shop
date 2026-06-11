import test from 'node:test';
import assert from 'node:assert/strict';
import { fulfillmentBoxSecretCode } from '../src/lib/fulfillmentCodes.ts';

test('fulfillmentBoxSecretCode prefers receipt claim codes', () => {
  assert.equal(
    fulfillmentBoxSecretCode({
      receiptClaimCode: 'stripe-receipt-code',
      claimCode: 'legacy-box-code',
    }),
    'stripe-receipt-code',
  );
});

test('fulfillmentBoxSecretCode falls back to legacy claim codes', () => {
  assert.equal(
    fulfillmentBoxSecretCode({
      claimCode: 'legacy-box-code',
    }),
    'legacy-box-code',
  );
});

test('fulfillmentBoxSecretCode returns empty string when no code exists', () => {
  assert.equal(fulfillmentBoxSecretCode({}), '');
});
