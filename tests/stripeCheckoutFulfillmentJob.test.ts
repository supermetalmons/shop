import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STRIPE_CHECKOUT_FULFILLMENT_JOB_KIND,
  STRIPE_CHECKOUT_FULFILLMENT_JOB_VERSION,
  STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
  createStripeCheckoutFulfillmentJobV1,
  isExactStripeCheckoutFulfillmentJobV1,
} from '../shared/stripeCheckoutFulfillmentJob.ts';

test('Stripe fulfillment queue job uses an exact versioned contract', () => {
  const job = createStripeCheckoutFulfillmentJobV1({
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_123',
    stripeEventId: 'evt_test_123',
    stripeEventType: 'checkout.session.completed',
    enqueuedAtMs: 1_700_000_000_000,
  });
  assert.deepEqual(job, {
    version: STRIPE_CHECKOUT_FULFILLMENT_JOB_VERSION,
    kind: STRIPE_CHECKOUT_FULFILLMENT_JOB_KIND,
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_123',
    stripeEventId: 'evt_test_123',
    stripeEventType: 'checkout.session.completed',
    enqueuedAtMs: 1_700_000_000_000,
  });
  assert.equal(STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR, 'cloudflare_queue_v1');
  assert.equal(isExactStripeCheckoutFulfillmentJobV1(job), true);
  assert.equal(isExactStripeCheckoutFulfillmentJobV1({ ...job, unexpected: true }), false);
  assert.equal(isExactStripeCheckoutFulfillmentJobV1({ ...job, version: 2 }), false);
  assert.equal(isExactStripeCheckoutFulfillmentJobV1({ ...job, stripeEventType: 'customer.created' }), false);
  assert.equal(isExactStripeCheckoutFulfillmentJobV1({ ...job, enqueuedAtMs: 0 }), false);
});

test('Stripe fulfillment queue job creation rejects invalid identifiers', () => {
  assert.throws(() => createStripeCheckoutFulfillmentJobV1({
    dropId: '../bad',
    sessionId: 'cs_test_123',
    stripeEventId: 'evt_test_123',
    stripeEventType: 'checkout.session.completed',
  }), /Invalid Stripe checkout fulfillment job/);
});
