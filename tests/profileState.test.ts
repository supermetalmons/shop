import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliveryOrderSummariesEqual,
  authSubjectChangeInvalidatesSession,
  mergeProfileState,
  ownProfileShipmentsEmptyState,
  profileForAuthorizedView,
  stripeMergeReconciliationOptions,
  stripeProfileRecoveryAfterRefresh,
  type ProfileSnapshotState,
} from '../src/lib/profileState.ts';
import type { DeliveryOrderSummary, GetProfileStateResponse } from '../src/types.ts';
import type { ShipmentHistoryCursor } from '../shared/shipmentHistory.ts';

const WALLET = '11111111111111111111111111111111';

type Snapshot = ProfileSnapshotState & { deliveryRecoveryNextCheckAt: number | null };

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    profile: null,
    shipments: [],
    shipmentsNextCursor: null,
    shipmentsRevision: 0,
    sessionWallet: null,
    authenticated: false,
    loading: false,
    profileReady: false,
    shipmentsReady: false,
    profileError: null,
    shipmentsError: null,
    deliveryRecoveryNextCheckAt: null,
    ...overrides,
  };
}

function profileResponse(overrides: Partial<GetProfileStateResponse> = {}): GetProfileStateResponse {
  return {
    responseMode: 'profile-state',
    sessionWallet: WALLET,
    profile: null,
    shipments: null,
    ...overrides,
  };
}

const CURSOR: ShipmentHistoryCursor = {
  version: 1,
  owner: WALLET,
  sortAtMs: 100,
  documentPath: 'drops/drop/deliveryOrders/1',
};

test('partial refresh failures retain visible data, pagination, and recovery state', () => {
  const current = snapshot({
    sessionWallet: WALLET,
    authenticated: true,
    profile: { wallet: WALLET, email: 'saved@example.com' },
    profileReady: true,
    shipments: [{ dropId: 'drop', deliveryId: 1, status: 'processing', items: [] }],
    shipmentsReady: true,
    shipmentsNextCursor: CURSOR,
    shipmentsRevision: 5,
    deliveryRecoveryNextCheckAt: 5_000,
  });
  const response = profileResponse({
    profile: { status: 'error', error: { code: 'unavailable', message: 'Profile unavailable' } },
    shipments: { status: 'error', error: { code: 'deadline-exceeded', message: 'Shipments timed out' } },
  });

  const next = mergeProfileState(current, response, WALLET, snapshot());

  assert.equal(next.profile, current.profile);
  assert.equal(next.shipments, current.shipments);
  assert.equal(next.shipmentsNextCursor, CURSOR);
  assert.equal(next.shipmentsRevision, 5);
  assert.equal(next.profileReady, true);
  assert.equal(next.shipmentsReady, true);
  assert.equal(next.profileError, 'Profile unavailable');
  assert.equal(next.shipmentsError, 'Shipments timed out');
  assert.equal(next.deliveryRecoveryNextCheckAt, 5_000);
  assert.equal(next.authenticated, true);
  assert.equal(next.loading, false);
  assert.equal(current.profileError, null);
  assert.equal(current.shipmentsError, null);
});

test('validated owner changes discard the previous wallet snapshot even when sections fail', () => {
  const current = snapshot({
    sessionWallet: 'previous-wallet',
    authenticated: true,
    profile: { wallet: 'previous-wallet' },
    profileReady: true,
    shipments: [{ dropId: 'drop', deliveryId: 1, status: 'processing', items: [] }],
    shipmentsReady: true,
    shipmentsNextCursor: CURSOR,
    shipmentsRevision: 9,
    deliveryRecoveryNextCheckAt: 5_000,
    profileError: 'Previous profile error',
  });
  const emptyState = snapshot();
  const next = mergeProfileState(current, profileResponse({
    shipments: { status: 'error', error: { code: 'unavailable', message: 'Shipments unavailable' } },
  }), WALLET, emptyState);

  assert.deepEqual(next, {
    ...emptyState,
    sessionWallet: WALLET,
    authenticated: true,
    shipmentsError: 'Shipments unavailable',
  });
  assert.equal(emptyState.sessionWallet, null);
});

test('a ready section clears its error while another section retains its data and error', () => {
  const current = snapshot({
    sessionWallet: WALLET,
    authenticated: true,
    loading: true,
    profileError: 'Profile unavailable',
    shipmentsError: 'Shipments unavailable',
    shipmentsNextCursor: CURSOR,
  });
  const profile = { wallet: WALLET, email: 'loaded@example.com' };
  const next = mergeProfileState(current, profileResponse({
    profile: { status: 'ready', value: profile },
  }), WALLET, snapshot());

  assert.equal(next.profile, profile);
  assert.equal(next.profileReady, true);
  assert.equal(next.profileError, null);
  assert.equal(next.shipments, current.shipments);
  assert.equal(next.shipmentsError, 'Shipments unavailable');
  assert.equal(next.shipmentsReady, false);
  assert.equal(next.shipmentsNextCursor, CURSOR);
  assert.equal(next.shipmentsRevision, 0);
  assert.equal(next.loading, false);
});

test('legacy shipment responses sort by display timestamp and tie breakers without mutating the response', () => {
  const shipments: DeliveryOrderSummary[] = [
    { dropId: 'z', deliveryId: 1, status: 'processing', items: [], createdAt: 100 },
    { dropId: 'a', deliveryId: 2, status: 'processing', items: [], createdAt: 200, processedAt: 100 },
    { dropId: 'a', deliveryId: 1, status: 'processing', items: [], createdAt: 300, processingAt: 100 },
    { dropId: 'a', deliveryId: 3, status: 'processing', items: [], createdAt: 400 },
    { dropId: 'a', deliveryId: 4, status: 'processing', items: [] },
  ];
  const originalOrder = shipments.map((shipment) => `${shipment.dropId}:${shipment.deliveryId}`);
  const current = snapshot({ sessionWallet: WALLET, authenticated: true, shipmentsNextCursor: CURSOR });
  const next = mergeProfileState(current, profileResponse({
    shipments: { status: 'ready', value: shipments },
  }), WALLET, snapshot());

  assert.deepEqual(next.shipments.map((shipment) => `${shipment.dropId}:${shipment.deliveryId}`), [
    'a:3', 'a:1', 'a:2', 'z:1', 'a:4',
  ]);
  assert.deepEqual(shipments.map((shipment) => `${shipment.dropId}:${shipment.deliveryId}`), originalOrder);
  assert.equal(next.shipmentsNextCursor, null);
  assert.equal(next.shipmentsRevision, 1);
});

test('paginated shipment responses retain server order and advance revision even for identical results', () => {
  const shipments: DeliveryOrderSummary[] = [
    { dropId: 'drop', deliveryId: 1, status: 'processing', items: [], createdAt: 100 },
    { dropId: 'drop', deliveryId: 2, status: 'processing', items: [], createdAt: 200 },
  ];
  const current = snapshot({ sessionWallet: WALLET, authenticated: true, shipmentsError: 'Unavailable' });
  const response = profileResponse({
    shipments: { status: 'ready', value: shipments },
    nextCursor: CURSOR,
  });
  const next = mergeProfileState(current, response, WALLET, snapshot());
  const repeated = mergeProfileState(next, response, WALLET, snapshot());
  const finalPage = mergeProfileState(repeated, { ...response, nextCursor: null }, WALLET, snapshot());

  assert.equal(next.shipments, shipments);
  assert.equal(next.shipmentsReady, true);
  assert.equal(next.shipmentsError, null);
  assert.equal(next.shipmentsNextCursor, CURSOR);
  assert.equal(next.shipmentsRevision, 1);
  assert.notEqual(repeated, next);
  assert.equal(repeated.shipmentsRevision, 2);
  assert.equal(finalPage.shipments, shipments);
  assert.equal(finalPage.shipmentsNextCursor, null);
  assert.equal(finalPage.shipmentsRevision, 3);
});

test('unchanged partial responses reuse the snapshot and retain previous section errors', () => {
  const current = snapshot({
    sessionWallet: WALLET,
    authenticated: true,
    profile: { wallet: WALLET },
    profileReady: true,
    profileError: 'Profile unavailable',
    shipmentsError: 'Shipments unavailable',
  });

  assert.equal(mergeProfileState(current, profileResponse(), WALLET, snapshot()), current);
  assert.equal(mergeProfileState(current, profileResponse({
    profile: { status: 'error', error: { code: 'unavailable', message: '' } },
    shipments: { status: 'error', error: { code: 'unavailable', message: 'Shipments unavailable' } },
  }), WALLET, snapshot()), current);

  const ready = snapshot({ ...current, profileError: null });
  assert.equal(mergeProfileState(ready, profileResponse({
    profile: { status: 'ready', value: ready.profile! },
  }), WALLET, snapshot()), ready);
});

test('Auth UID changes preserve only the expected initial sign-in authentication', () => {
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
  const fallback = { key: 'anonymous:cs_one', phase: 'fallback' as const };
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
