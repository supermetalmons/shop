import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOptimisticStripeCheckoutMintProgress,
  completeStripeCheckoutMarker,
  completedStripeCheckoutMarkerKeyForFirebaseUid,
  completedStripeCheckoutMarkerSummaryForFirebaseUid,
  forgetCompletedStripeCheckoutMarkersForFirebaseUid,
  isStripeCheckoutMintProgressSettled,
  loadStripeCheckoutMarkers,
  parseStripeCheckoutMarkers,
  rememberStripeCheckoutStarted,
  stripeCheckoutMintProgressForSession,
  type StripeCheckoutMarkerStorage,
} from '../src/lib/stripeCheckoutMarkers.ts';

const STRIPE_CHECKOUT_MARKERS_STORAGE_KEY = 'monsStripeCheckoutMarkers:v1';

class MemoryStorage implements StripeCheckoutMarkerStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test('parseStripeCheckoutMarkers keeps valid markers and flags invalid entries for cleanup', () => {
  const parsed = parseStripeCheckoutMarkers(
    JSON.stringify([
      {
        sessionId: 'cs_test_123',
        dropId: 'Little_Swag_Hoodies_Devnet',
        firebaseUid: 'anon_uid_123',
        status: 'started',
        createdAt: 100,
      },
      {
        sessionId: 'cs_test_456',
        dropId: 'little_swag_hoodies_devnet',
        firebaseUid: 'anon_uid_123',
        status: 'completed',
        createdAt: 200,
        completedAt: 300,
      },
      { sessionId: '', status: 'completed' },
    ]),
  );

  assert.equal(parsed.needsCleanup, true);
  assert.equal(parsed.markers.length, 2);
  assert.equal(parsed.markers[0].sessionId, 'cs_test_456');
  assert.equal(parsed.markers[1].dropId, 'little_swag_hoodies_devnet');
});

test('loadStripeCheckoutMarkers removes malformed storage', () => {
  const storage = new MemoryStorage();
  storage.setItem(STRIPE_CHECKOUT_MARKERS_STORAGE_KEY, '{not json');

  assert.deepEqual(loadStripeCheckoutMarkers(storage), []);
  assert.equal(storage.getItem(STRIPE_CHECKOUT_MARKERS_STORAGE_KEY), null);
});

test('loadStripeCheckoutMarkers normalizes persisted marker shape', () => {
  const storage = new MemoryStorage();
  storage.setItem(
    STRIPE_CHECKOUT_MARKERS_STORAGE_KEY,
    JSON.stringify([
      {
        sessionId: 'cs_test_123',
        dropId: 'Little_Swag_Hoodies_Devnet',
        firebaseUid: 'anon_uid_123',
        status: 'started',
        createdAt: 100,
        extra: 'ignored',
      },
    ]),
  );

  const markers = loadStripeCheckoutMarkers(storage);

  assert.deepEqual(markers, [
    {
      sessionId: 'cs_test_123',
      dropId: 'little_swag_hoodies_devnet',
      firebaseUid: 'anon_uid_123',
      status: 'started',
      createdAt: 100,
    },
  ]);
  assert.equal(storage.getItem(STRIPE_CHECKOUT_MARKERS_STORAGE_KEY), JSON.stringify(markers));
});

test('completeStripeCheckoutMarker only completes a matching local checkout marker', () => {
  const storage = new MemoryStorage();
  rememberStripeCheckoutStarted(
    {
      sessionId: 'cs_test_123',
      dropId: 'little_swag_hoodies_devnet',
      firebaseUid: 'anon_uid_123',
      createdAt: 100,
      quantity: 3,
      remainingBeforeCheckout: 12,
      variantKey: 'large',
      variantRemainingBeforeCheckout: 4,
    },
    storage,
  );

  const wrongUid = completeStripeCheckoutMarker(
    { sessionId: 'cs_test_123', firebaseUid: 'other_uid', completedAt: 200 },
    storage,
  );
  assert.equal(wrongUid.completed, false);
  assert.equal(Boolean(completedStripeCheckoutMarkerKeyForFirebaseUid('anon_uid_123', wrongUid.markers)), false);

  const completed = completeStripeCheckoutMarker(
    { sessionId: 'cs_test_123', firebaseUid: 'anon_uid_123', completedAt: 300 },
    storage,
  );
  assert.equal(completed.completed, true);
  assert.equal(completedStripeCheckoutMarkerKeyForFirebaseUid('anon_uid_123', completed.markers), 'cs_test_123');
  assert.deepEqual(stripeCheckoutMintProgressForSession('anon_uid_123', 'cs_test_123', completed.markers), {
    dropId: 'little_swag_hoodies_devnet',
    quantity: 3,
    remainingBeforeCheckout: 12,
    variantKey: 'large',
    variantRemainingBeforeCheckout: 4,
  });
  assert.equal(
    stripeCheckoutMintProgressForSession('other_uid', 'cs_test_123', completed.markers),
    null,
  );
  assert.deepEqual(completedStripeCheckoutMarkerSummaryForFirebaseUid('anon_uid_123', completed.markers), {
    markerKey: 'cs_test_123',
    sessionIds: ['cs_test_123'],
    latestCompletedAt: 300,
  });
});

test('optimistic Stripe mint progress caps stale stats without double decrementing updated stats', () => {
  const progress = {
    dropId: 'little_swag_hoodies_devnet',
    quantity: 1,
    remainingBeforeCheckout: 10,
    variantKey: 'large',
    variantRemainingBeforeCheckout: 2,
  };
  const staleStats = {
    minted: 5,
    total: 15,
    remaining: 10,
    maxPerTx: 1,
    mintSelectionAvailability: {
      medium: 3,
      large: 2,
    },
  };
  const updatedStats = {
    ...staleStats,
    minted: 6,
    remaining: 9,
    mintSelectionAvailability: {
      medium: 3,
      large: 1,
    },
  };
  const totalOnlyUpdatedStats = {
    ...updatedStats,
    mintSelectionAvailability: staleStats.mintSelectionAvailability,
  };

  assert.deepEqual(applyOptimisticStripeCheckoutMintProgress(staleStats, progress), updatedStats);
  assert.equal(applyOptimisticStripeCheckoutMintProgress(updatedStats, progress), updatedStats);
  assert.equal(isStripeCheckoutMintProgressSettled(staleStats, progress), false);
  assert.equal(isStripeCheckoutMintProgressSettled(totalOnlyUpdatedStats, progress), false);
  assert.equal(isStripeCheckoutMintProgressSettled(updatedStats, progress), true);
});

test('completed Stripe checkout gate is scoped to the current Firebase uid', () => {
  const storage = new MemoryStorage();
  rememberStripeCheckoutStarted(
    {
      sessionId: 'cs_test_123',
      dropId: 'little_swag_hoodies_devnet',
      firebaseUid: 'anon_uid_123',
      createdAt: 100,
    },
    storage,
  );
  const { markers } = completeStripeCheckoutMarker(
    { sessionId: 'cs_test_123', firebaseUid: 'anon_uid_123', completedAt: 200 },
    storage,
  );

  assert.equal(Boolean(completedStripeCheckoutMarkerKeyForFirebaseUid('anon_uid_123', markers)), true);
  assert.equal(Boolean(completedStripeCheckoutMarkerKeyForFirebaseUid('other_uid', markers)), false);
  assert.equal(Boolean(completedStripeCheckoutMarkerKeyForFirebaseUid(null, markers)), false);
});

test('forgetCompletedStripeCheckoutMarkersForFirebaseUid removes only wallet-resolved checkout sessions', () => {
  const storage = new MemoryStorage();
  rememberStripeCheckoutStarted(
    {
      sessionId: 'cs_test_resolved',
      dropId: 'little_swag_hoodies_devnet',
      firebaseUid: 'anon_uid_123',
      createdAt: 100,
    },
    storage,
  );
  rememberStripeCheckoutStarted(
    {
      sessionId: 'cs_test_waiting',
      dropId: 'little_swag_hoodies_devnet',
      firebaseUid: 'anon_uid_123',
      createdAt: 110,
    },
    storage,
  );
  rememberStripeCheckoutStarted(
    {
      sessionId: 'cs_test_other_uid',
      dropId: 'little_swag_hoodies_devnet',
      firebaseUid: 'other_uid',
      createdAt: 120,
    },
    storage,
  );
  completeStripeCheckoutMarker(
    { sessionId: 'cs_test_resolved', firebaseUid: 'anon_uid_123', completedAt: 200 },
    storage,
  );
  completeStripeCheckoutMarker(
    { sessionId: 'cs_test_waiting', firebaseUid: 'anon_uid_123', completedAt: 210 },
    storage,
  );
  completeStripeCheckoutMarker(
    { sessionId: 'cs_test_other_uid', firebaseUid: 'other_uid', completedAt: 220 },
    storage,
  );

  const result = forgetCompletedStripeCheckoutMarkersForFirebaseUid(
    { firebaseUid: 'anon_uid_123', sessionIds: ['cs_test_resolved'] },
    storage,
  );

  assert.equal(result.removed, true);
  assert.deepEqual(result.removedSessionIds, ['cs_test_resolved']);
  assert.equal(completedStripeCheckoutMarkerKeyForFirebaseUid('anon_uid_123', result.markers), 'cs_test_waiting');
  assert.equal(completedStripeCheckoutMarkerKeyForFirebaseUid('other_uid', result.markers), 'cs_test_other_uid');
});
