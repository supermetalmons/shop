import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeStripeCheckoutRecoverySessionIds,
  pendingStripeCheckoutRecoverySessionIds,
  resolveStripeCheckoutDataOwner,
  shouldContinueStripeCheckoutRecovery,
  shouldUseAnonymousStripeHistory,
} from '../src/lib/stripeCheckoutRecovery.ts';

test('connected wallet takes precedence over the recovered Stripe owner', () => {
  assert.equal(resolveStripeCheckoutDataOwner('connected', 'recovered'), 'connected');
  assert.equal(resolveStripeCheckoutDataOwner(null, 'recovered'), 'recovered');
  assert.equal(resolveStripeCheckoutDataOwner(undefined, null), undefined);
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

test('Stripe recovery retries only retryable unsettled work inside the polling window', () => {
  assert.equal(
    shouldContinueStripeCheckoutRecovery({
      pendingSessionIds: ['session-a'],
      retryable: true,
      nextAttemptAt: 9_000,
      stopAt: 10_000,
    }),
    true,
  );
  assert.equal(
    shouldContinueStripeCheckoutRecovery({
      pendingSessionIds: [],
      retryable: true,
      nextAttemptAt: 9_000,
      stopAt: 10_000,
    }),
    false,
  );
  assert.equal(
    shouldContinueStripeCheckoutRecovery({
      pendingSessionIds: ['session-a'],
      retryable: false,
      nextAttemptAt: 9_000,
      stopAt: 10_000,
    }),
    false,
  );
  assert.equal(
    shouldContinueStripeCheckoutRecovery({
      pendingSessionIds: ['session-a'],
      retryable: true,
      nextAttemptAt: 11_000,
      stopAt: 10_000,
    }),
    false,
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
