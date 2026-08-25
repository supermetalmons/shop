import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliveryOrderSummariesEqual,
  authSubjectChangeInvalidatesSession,
  ownProfileShipmentsEmptyState,
  profileForAuthorizedView,
  stripeMergeReconciliationOptions,
  stripeProfileRecoveryAfterRefresh,
} from '../src/lib/profileState.ts';

const WALLET = '11111111111111111111111111111111';

test('Firebase UID changes preserve only the expected initial sign-in authentication', () => {
  assert.equal(authSubjectChangeInvalidatesSession({
    previousSubject: null,
    nextSubject: 'anonymous-user',
    signInActive: true,
    activeSignInSubject: null,
  }), false);
  assert.equal(authSubjectChangeInvalidatesSession({
    previousSubject: 'signed-user',
    nextSubject: 'different-user',
    signInActive: true,
    activeSignInSubject: 'signed-user',
  }), true);
  assert.equal(authSubjectChangeInvalidatesSession({
    previousSubject: 'signed-user',
    nextSubject: null,
    signInActive: false,
    activeSignInSubject: null,
  }), true);
});

test('profile view selection drops data when authorization disappears', () => {
  const ownProfile = { wallet: WALLET };
  const adminProfile = { wallet: 'admin-target' };
  const base = {
    ownProfile,
    adminProfile,
    canReadOwnProfile: true,
    canUseAdminViewer: false,
    isViewerMode: false,
  };
  assert.equal(profileForAuthorizedView(base), ownProfile);
  assert.equal(profileForAuthorizedView({ ...base, canUseAdminViewer: true, isViewerMode: true }), adminProfile);
  assert.equal(profileForAuthorizedView({ ...base, canReadOwnProfile: false }), null);
});

test('profile refresh helpers preserve recovery and empty-state behavior', () => {
  const fallback = { key: 'firebase:cs_one', phase: 'fallback' as const };
  assert.equal(stripeProfileRecoveryAfterRefresh(fallback, fallback.key, false), fallback);
  assert.deepEqual(stripeProfileRecoveryAfterRefresh(fallback, fallback.key, true), {
    key: fallback.key,
    phase: 'recovered',
  });
  assert.deepEqual(stripeMergeReconciliationOptions(false), {
    mergeStripeDeliveryOrders: true,
    includeDeliveryRecovery: true,
  });
  assert.equal(ownProfileShipmentsEmptyState({ ready: false, error: null, checkoutRecoveryPending: true }), 'loading');
  assert.equal(ownProfileShipmentsEmptyState({ ready: true, error: null, checkoutRecoveryPending: true }), 'preparing');
  assert.equal(ownProfileShipmentsEmptyState({ ready: true, error: null, checkoutRecoveryPending: false }), 'empty');
  assert.equal(ownProfileShipmentsEmptyState({ ready: true, error: 'denied', checkoutRecoveryPending: true }), 'error');
});

test('delivery summaries compare exact ordered public fields', () => {
  const summary = { dropId: 'drop', deliveryId: 1, status: 'processing', items: [] };
  assert.equal(deliveryOrderSummariesEqual([summary], [{ ...summary }]), true);
  assert.equal(deliveryOrderSummariesEqual([summary], [{ ...summary, status: 'ready_to_ship' }]), false);
  assert.equal(deliveryOrderSummariesEqual([summary], []), false);
});
