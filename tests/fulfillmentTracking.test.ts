import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOptionalFulfillmentTrackingCode as normalizeClientTrackingCode,
  sanitizeFulfillmentTrackingCode as sanitizeClientTrackingCode,
  shouldDisplayFulfillmentTrackingCode,
} from '../src/lib/fulfillmentTracking.ts';
import {
  normalizeOptionalFulfillmentTrackingCode as normalizeFunctionTrackingCode,
  sanitizeFulfillmentTrackingCode as sanitizeFunctionTrackingCode,
} from '../functions/src/fulfillmentTracking.ts';

test('fulfillment tracking code sanitizers remove all whitespace', () => {
  assert.equal(sanitizeClientTrackingCode('AB 123\t\n CD'), 'AB123CD');
  assert.equal(sanitizeFunctionTrackingCode('AB 123\t\n CD'), 'AB123CD');
});

test('fulfillment tracking code normalizers omit empty sanitized values', () => {
  assert.equal(normalizeClientTrackingCode('   \t\n'), undefined);
  assert.equal(normalizeFunctionTrackingCode('   \t\n'), undefined);
});

test('fulfillment tracking code display requires Shipped status and a non-empty code', () => {
  assert.equal(shouldDisplayFulfillmentTrackingCode('Shipped', 'AB 123'), true);
  assert.equal(shouldDisplayFulfillmentTrackingCode('Preparing', 'AB 123'), false);
  assert.equal(shouldDisplayFulfillmentTrackingCode('', 'AB 123'), false);
  assert.equal(shouldDisplayFulfillmentTrackingCode('Shipped', '   '), false);
});
