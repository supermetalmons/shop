import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeStripeCheckoutRecoverySessionIds,
  pendingStripeCheckoutRecoverySessionIds,
  resolveStripeCheckoutDataOwner,
  stripeCheckoutRetryDelay,
  shouldUseAnonymousStripeHistory,
} from '../src/lib/stripeCheckoutRecovery.ts';

test('connected and authenticated wallets take precedence over the recovered Stripe owner', () => {
  assert.equal(resolveStripeCheckoutDataOwner('connected', 'authenticated', 'recovered'), 'connected');
  assert.equal(resolveStripeCheckoutDataOwner(null, 'authenticated', 'recovered'), 'authenticated');
  assert.equal(resolveStripeCheckoutDataOwner(null, null, 'recovered'), 'recovered');
  assert.equal(resolveStripeCheckoutDataOwner(undefined, null, null), undefined);
});

test('Stripe recovery session ids are normalized and deduplicated', () => {
  assert.deepEqual(
    mergeStripeCheckoutRecoverySessionIds(['session-b', 'session-a', 'session-b'], ' session-c '),
    ['session-a', 'session-b', 'session-c'],
  );
});

test('Stripe recovery remains pending until every checkout reaches the wallet profile', () => {
  assert.deepEqual(
    pendingStripeCheckoutRecoverySessionIds(
      ['session-a', 'session-b', 'session-c'],
      ['session-c', 'session-a'],
    ),
    ['session-b'],
  );
  assert.deepEqual(
    pendingStripeCheckoutRecoverySessionIds(
      ['session-a', 'session-b'],
      ['session-b', 'session-a'],
    ),
    [],
  );
});

test('Stripe recovery backs off adaptively and schedules a final deadline attempt', () => {
  const base = { hasPendingWork: true, retryable: true, now: 1_000, stopAt: 30_000 };
  assert.equal(stripeCheckoutRetryDelay({ ...base, retryIndex: 0 }), 3_000);
  assert.equal(stripeCheckoutRetryDelay({ ...base, retryIndex: 1 }), 6_000);
  assert.equal(stripeCheckoutRetryDelay({ ...base, retryIndex: 2 }), 12_000);
  assert.equal(stripeCheckoutRetryDelay({ ...base, retryIndex: 3 }), 15_000);
  assert.equal(
    stripeCheckoutRetryDelay({ ...base, now: 29_500, retryIndex: 3 }),
    500,
  );
  assert.equal(
    stripeCheckoutRetryDelay({ ...base, now: 30_000, retryIndex: 0 }),
    null,
  );
  assert.equal(
    stripeCheckoutRetryDelay({ ...base, hasPendingWork: false, retryIndex: 0 }),
    null,
  );
  assert.equal(
    stripeCheckoutRetryDelay({ ...base, retryable: false, retryIndex: 0 }),
    null,
  );
});

test('anonymous Stripe history is limited to returns without a connected or recovered owner', () => {
  assert.equal(
    shouldUseAnonymousStripeHistory({
      connectedWallet: null,
      recoveredWallet: null,
      hasCompletedCheckout: true,
      recoveryFallbackReady: true,
    }),
    true,
  );
  assert.equal(
    shouldUseAnonymousStripeHistory({
      connectedWallet: null,
      recoveredWallet: 'recovered',
      hasCompletedCheckout: true,
      recoveryFallbackReady: true,
    }),
    false,
  );
  assert.equal(
    shouldUseAnonymousStripeHistory({
      connectedWallet: 'connected',
      recoveredWallet: null,
      hasCompletedCheckout: true,
      recoveryFallbackReady: true,
    }),
    false,
  );
  assert.equal(
    shouldUseAnonymousStripeHistory({
      connectedWallet: null,
      recoveredWallet: null,
      hasCompletedCheckout: false,
      recoveryFallbackReady: true,
    }),
    false,
  );
  assert.equal(
    shouldUseAnonymousStripeHistory({
      connectedWallet: null,
      recoveredWallet: null,
      hasCompletedCheckout: true,
      recoveryFallbackReady: false,
    }),
    false,
  );
});
