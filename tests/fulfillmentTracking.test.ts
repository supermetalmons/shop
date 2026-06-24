import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOptionalFulfillmentTrackingCode as normalizeClientTrackingCode,
  resolveFulfillmentTrackingHref,
  sanitizeFulfillmentTrackingCode as sanitizeClientTrackingCode,
  shouldDisplayFulfillmentTrackingCode,
} from '../src/lib/fulfillmentTracking.ts';
import {
  normalizeOptionalFulfillmentTrackingCode as normalizeFunctionTrackingCode,
  sanitizeFulfillmentTrackingCode as sanitizeFunctionTrackingCode,
} from '../functions/src/fulfillmentTracking.ts';

test('fulfillment tracking code sanitizers trim outer whitespace only', () => {
  const trackingLink = 'https://carrier.example/track?id=AB 123&ref=CD';
  assert.equal(sanitizeClientTrackingCode(`  ${trackingLink}\t\n`), trackingLink);
  assert.equal(sanitizeFunctionTrackingCode(`  ${trackingLink}\t\n`), trackingLink);
});

test('fulfillment tracking code normalizers omit empty sanitized values', () => {
  assert.equal(normalizeClientTrackingCode('   \t\n'), undefined);
  assert.equal(normalizeFunctionTrackingCode('   \t\n'), undefined);
});

test('fulfillment tracking hrefs allow absolute https urls only', () => {
  assert.equal(resolveFulfillmentTrackingHref(' https://carrier.example/track?id=AB123 '), 'https://carrier.example/track?id=AB123');
  assert.equal(resolveFulfillmentTrackingHref('http://carrier.example/track?id=AB123'), undefined);
  assert.equal(resolveFulfillmentTrackingHref('javascript:alert(1)'), undefined);
  assert.equal(resolveFulfillmentTrackingHref('data:text/html,hello'), undefined);
  assert.equal(resolveFulfillmentTrackingHref('//carrier.example/track?id=AB123'), undefined);
  assert.equal(resolveFulfillmentTrackingHref('https:carrier.example/track?id=AB123'), undefined);
  assert.equal(resolveFulfillmentTrackingHref('AB123'), undefined);
});

test('fulfillment tracking code display requires Shipped status and a non-empty code', () => {
  assert.equal(shouldDisplayFulfillmentTrackingCode('Shipped', 'AB 123'), true);
  assert.equal(shouldDisplayFulfillmentTrackingCode('Preparing', 'AB 123'), false);
  assert.equal(shouldDisplayFulfillmentTrackingCode('', 'AB 123'), false);
  assert.equal(shouldDisplayFulfillmentTrackingCode('Shipped', '   '), false);
});
