import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isStripeChargebackSessionId,
  isStripeDisputeEventType,
  normalizeStripeDispute,
} from '../shared/stripeChargebacks.ts';

const dispute = {
  object: 'dispute', id: 'du_history', livemode: true, charge: 'ch_history',
  payment_intent: 'pi_history', created: 100,
};

test('chargeback normalization counts all dispute outcomes and inquiry states as historical disputes', () => {
  for (const status of ['needs_response', 'under_review', 'lost', 'won', 'warning_needs_response',
    'warning_under_review', 'warning_closed', 'prevented']) {
    assert.deepEqual(normalizeStripeDispute({ ...dispute, status }), {
      id: 'du_history', livemode: true, chargeId: 'ch_history', paymentIntentId: 'pi_history', created: 100,
    });
  }
  assert.equal(isStripeDisputeEventType('charge.dispute.created'), true);
  assert.equal(isStripeDisputeEventType('charge.dispute.updated'), true);
  assert.equal(isStripeDisputeEventType('charge.dispute.closed'), true);
  assert.equal(isStripeDisputeEventType('charge.dispute.funds_withdrawn'), true);
  assert.equal(isStripeDisputeEventType('charge.dispute.funds_reinstated'), true);
  assert.equal(isStripeDisputeEventType('charge.refunded'), false);
  assert.equal(isStripeDisputeEventType('radar.early_fraud_warning.created'), false);
});

test('chargeback normalization accepts expanded IDs and missing PaymentIntent for charge fallback', () => {
  assert.deepEqual(normalizeStripeDispute({ ...dispute, id: 'dp_legacy',
    charge: { id: 'ch_history', livemode: true }, payment_intent: { id: 'pi_history' } }), {
    id: 'dp_legacy', livemode: true, chargeId: 'ch_history', paymentIntentId: 'pi_history', created: 100,
  });
  assert.deepEqual(normalizeStripeDispute({ ...dispute, payment_intent: null }), {
    id: 'du_history', livemode: true, chargeId: 'ch_history', created: 100,
  });
  for (const invalid of [null, {}, { ...dispute, created: -1 }, { ...dispute, created: '100' },
    { ...dispute, object: 'charge' }, { ...dispute, livemode: 1 }, { ...dispute, id: 'du_bad/path' },
    { ...dispute, charge: { id: 'ch_history', livemode: false } },
    { ...dispute, payment_intent: { id: 'pi_history', livemode: false } }]) {
    assert.equal(normalizeStripeDispute(invalid), null);
  }
});

test('chargeback session lookup accepts exact Stripe modes and rejects malformed IDs', () => {
  assert.equal(isStripeChargebackSessionId('cs_live_order'), true);
  assert.equal(isStripeChargebackSessionId('cs_test_order'), true);
  for (const invalid of [undefined, null, 'cs_order', ' cs_test_order', 'cs_live_order ',
    'cs_live_order/path', 'cs_test_', `cs_live_${'a'.repeat(249)}`]) {
    assert.equal(isStripeChargebackSessionId(invalid), false);
  }
});
