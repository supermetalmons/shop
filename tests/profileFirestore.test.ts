import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliveryOrderSummaryFromDocument,
  firebaseAuthChangeInvalidatesSession,
  firestoreErrorInvalidatesSession,
  firestoreListenerErrorIsRetryable,
  ownProfileShipmentsEmptyState,
  profileFromDocument,
  profileForAuthorizedView,
  profileListenerIsCurrent,
  profileShipmentFromDocument,
  profileShipmentsFromDocuments,
  sessionBindingFromDocument,
  stripeProfileRecoveryAfterSnapshot,
  stripeMergeReconciliationOptions,
} from '../src/lib/profileFirestore.ts';

const WALLET = '11111111111111111111111111111111';

test('session wallet restoration ignores legacy expiry metadata', () => {
  for (const expiresAt of [undefined, { toMillis: () => 0 }, 'later']) {
    assert.deepEqual(
      sessionBindingFromDocument({
        exists: true,
        data: { wallet: WALLET, ...(expiresAt === undefined ? {} : { expiresAt }) },
      }),
      { wallet: WALLET },
    );
  }
  assert.equal(sessionBindingFromDocument({ exists: false }), null);
  assert.deepEqual(sessionBindingFromDocument({ uid: WALLET, exists: false }), { wallet: WALLET });
  assert.equal(sessionBindingFromDocument({ uid: 'firebase-uid', exists: false }), null);
  assert.equal(
    sessionBindingFromDocument({
      uid: WALLET,
      exists: true,
      data: { wallet: ` ${WALLET}` },
    }),
    null,
  );
});

test('only authorization listener failures invalidate a wallet session', () => {
  assert.equal(firestoreErrorInvalidatesSession({ code: 'permission-denied' }), true);
  assert.equal(firestoreErrorInvalidatesSession({ code: 'unauthenticated' }), true);
  assert.equal(firestoreErrorInvalidatesSession({ code: 'unavailable' }), false);
  assert.equal(firestoreErrorInvalidatesSession(new Error('network')), false);
  assert.equal(firestoreListenerErrorIsRetryable({ code: 'unavailable' }), true);
  assert.equal(firestoreListenerErrorIsRetryable({ code: 'permission-denied' }), false);
  assert.equal(
    firestoreListenerErrorIsRetryable({ code: 'auth/network-request-failed' }),
    true,
  );
});

test('profile documents expose only the owner wallet and email', () => {
  assert.deepEqual(
    profileFromDocument(WALLET, {
      wallet: 'attacker-controlled-value',
      email: ' customer@example.com ',
      address: { encrypted: 'secret' },
      orders: [{ claimCode: 'secret' }],
      admin: true,
    }),
    { wallet: WALLET, email: 'customer@example.com' },
  );
  assert.deepEqual(profileFromDocument(WALLET), { wallet: WALLET });
});

test('shipment documents are allowlisted and malformed items are discarded', () => {
  assert.equal(deliveryOrderSummaryFromDocument(null), null);
  assert.equal(deliveryOrderSummaryFromDocument([]), null);
  assert.deepEqual(
    profileShipmentFromDocument({
      dropId: 'drop',
      deliveryId: 7,
      sortAt: 900,
      status: 'processing',
      stripeCheckoutSessionId: 'cs_test',
      createdAt: 100,
      processingAt: 200,
      processedAt: 300,
      items: [
        { kind: 'box', refId: 1, claimCode: 'secret' },
        { kind: 'dude', refId: 2 },
        { kind: 'box', refId: 0 },
        { kind: 'certificate', refId: 3 },
        { kind: 'box', refId: '4' },
      ],
      fulfillmentStatus: 'Shipped',
      fulfillmentTrackingCode: 'tracking',
      fulfillmentUpdatedAt: 400,
      address: { encrypted: 'secret' },
      claimCode: 'secret',
      stripeCustomerId: 'cus_secret',
      paymentIntentId: 'pi_secret',
      receiptRecovery: { leaseExpiresAt: 123 },
    }),
    {
      dropId: 'drop',
      deliveryId: 7,
      status: 'processing',
      items: [
        { kind: 'box', refId: 1 },
        { kind: 'dude', refId: 2 },
      ],
      sortAt: 900,
      stripeCheckoutSessionId: 'cs_test',
      createdAt: 100,
      processingAt: 200,
      processedAt: 300,
      fulfillmentStatus: 'Shipped',
      fulfillmentTrackingCode: 'tracking',
      fulfillmentUpdatedAt: 400,
    },
  );
});

test('shipment snapshots stay newest-first and do not expose sortAt', () => {
  const documents = [
    {
      data: () => ({ dropId: 'older', deliveryId: 1, status: 'ready_to_ship', items: [], sortAt: 10 }),
    },
    {
      data: () => ({ dropId: 'invalid', deliveryId: 2, status: 'processing', items: [] }),
    },
    {
      data: () => ({ dropId: 'newer', deliveryId: 3, status: 'processing', items: [], sortAt: 30 }),
    },
  ];

  assert.deepEqual(profileShipmentsFromDocuments(documents as any), [
    { dropId: 'newer', deliveryId: 3, status: 'processing', items: [] },
    { dropId: 'older', deliveryId: 1, status: 'ready_to_ship', items: [] },
  ]);
});

test('profile listeners reject stale epochs and wallet switches', () => {
  const current = {
    expectedWallet: WALLET,
    expectedEpoch: 4,
    currentWallet: WALLET,
    currentEpoch: 4,
    connectedWallet: WALLET,
  };
  assert.equal(profileListenerIsCurrent(current), true);
  assert.equal(profileListenerIsCurrent({ ...current, currentEpoch: 5 }), false);
  assert.equal(profileListenerIsCurrent({ ...current, currentWallet: null }), false);
  assert.equal(profileListenerIsCurrent({ ...current, connectedWallet: null }), false);
  assert.equal(
    profileListenerIsCurrent({ ...current, connectedWallet: null, allowDisconnected: true }),
    true,
  );
  assert.equal(
    profileListenerIsCurrent({
      ...current,
      connectedWallet: 'So11111111111111111111111111111111111111112',
    }),
    false,
  );
});

test('Firebase UID changes only preserve the expected initial sign-in authentication', () => {
  assert.equal(
    firebaseAuthChangeInvalidatesSession({
      previousUid: null,
      nextUid: 'anonymous-user',
      signInActive: true,
      activeSignInUid: null,
    }),
    false,
  );
  assert.equal(
    firebaseAuthChangeInvalidatesSession({
      previousUid: 'signed-user',
      nextUid: 'different-user',
      signInActive: true,
      activeSignInUid: 'signed-user',
    }),
    true,
  );
  assert.equal(
    firebaseAuthChangeInvalidatesSession({
      previousUid: 'signed-user',
      nextUid: null,
      signInActive: false,
      activeSignInUid: null,
    }),
    true,
  );
});

test('profile view selection drops cached owner and admin data when authorization disappears', () => {
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
  assert.equal(
    profileForAuthorizedView({
      ...base,
      canUseAdminViewer: true,
      isViewerMode: true,
    }),
    adminProfile,
  );
  assert.equal(
    profileForAuthorizedView({
      ...base,
      canReadOwnProfile: false,
      canUseAdminViewer: false,
      isViewerMode: false,
    }),
    null,
  );
  assert.equal(
    profileForAuthorizedView({
      ...base,
      canUseAdminViewer: false,
      isViewerMode: true,
    }),
    null,
  );
});

test('a late shipment snapshot recovers even after callable fallback', () => {
  const fallback = { key: 'firebase:cs_one', phase: 'fallback' as const };
  assert.equal(stripeProfileRecoveryAfterSnapshot(fallback, fallback.key, false), fallback);
  assert.deepEqual(stripeProfileRecoveryAfterSnapshot(fallback, fallback.key, true), {
    key: fallback.key,
    phase: 'recovered',
  });
});

test('Stripe merge retries include recovery scheduling until recovery state loads', () => {
  assert.deepEqual(stripeMergeReconciliationOptions(false), {
    mergeStripeDeliveryOrders: true,
    includeDeliveryRecovery: true,
  });
  assert.deepEqual(stripeMergeReconciliationOptions(true), {
    mergeStripeDeliveryOrders: true,
    includeDeliveryRecovery: false,
  });
});

test('own shipment empty states distinguish loading, recovery, failure, and settled emptiness', () => {
  assert.equal(
    ownProfileShipmentsEmptyState({ ready: false, error: null, checkoutRecoveryPending: true }),
    'loading',
  );
  assert.equal(
    ownProfileShipmentsEmptyState({ ready: true, error: null, checkoutRecoveryPending: true }),
    'preparing',
  );
  assert.equal(
    ownProfileShipmentsEmptyState({ ready: true, error: null, checkoutRecoveryPending: false }),
    'empty',
  );
  assert.equal(
    ownProfileShipmentsEmptyState({ ready: true, error: 'denied', checkoutRecoveryPending: true }),
    'error',
  );
});

test('shipment documents reject statuses and identifiers outside the public history contract', () => {
  assert.equal(
    profileShipmentFromDocument({
      dropId: 'drop',
      deliveryId: 1,
      sortAt: 1,
      status: 'prepared',
      items: [],
    }),
    null,
  );
  for (const deliveryId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.equal(
      profileShipmentFromDocument({
        dropId: 'drop',
        deliveryId,
        sortAt: 1,
        status: 'processing',
        items: [],
      }),
      null,
    );
  }
});
