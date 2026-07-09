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
  resolveFulfillmentTrackingHref as resolveFunctionTrackingHref,
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
  const resolvers = [
    { name: 'client', resolve: resolveFulfillmentTrackingHref },
    { name: 'functions', resolve: resolveFunctionTrackingHref },
  ];
  const cases: Array<{ name: string; value: unknown; expected: string | undefined }> = [
    {
      name: 'trimmed HTTPS URL',
      value: ' https://carrier.example/track?id=AB123 ',
      expected: 'https://carrier.example/track?id=AB123',
    },
    {
      name: 'uppercase HTTPS scheme',
      value: 'HTTPS://carrier.example/track?id=AB123',
      expected: 'HTTPS://carrier.example/track?id=AB123',
    },
    { name: 'HTTP URL', value: 'http://carrier.example/track?id=AB123', expected: undefined },
    { name: 'javascript URL', value: 'javascript:alert(1)', expected: undefined },
    { name: 'data URL', value: 'data:text/html,hello', expected: undefined },
    { name: 'protocol-relative URL', value: '//carrier.example/track?id=AB123', expected: undefined },
    { name: 'malformed HTTPS URL', value: 'https:carrier.example/track?id=AB123', expected: undefined },
    { name: 'hostless HTTPS URL', value: 'https://', expected: undefined },
    { name: 'invalid port', value: 'https://carrier.example:99999/track', expected: undefined },
    { name: 'plain tracking code', value: 'AB123', expected: undefined },
    { name: 'empty value', value: '   ', expected: undefined },
    { name: 'non-string value', value: null, expected: undefined },
  ];

  for (const resolver of resolvers) {
    for (const entry of cases) {
      assert.equal(resolver.resolve(entry.value), entry.expected, `${resolver.name}: ${entry.name}`);
    }
  }
});

test('fulfillment tracking code display requires Shipped status and a non-empty code', () => {
  assert.equal(shouldDisplayFulfillmentTrackingCode('Shipped', 'AB 123'), true);
  assert.equal(shouldDisplayFulfillmentTrackingCode('Preparing', 'AB 123'), false);
  assert.equal(shouldDisplayFulfillmentTrackingCode('', 'AB 123'), false);
  assert.equal(shouldDisplayFulfillmentTrackingCode('Shipped', '   '), false);
});
