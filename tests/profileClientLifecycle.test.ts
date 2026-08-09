import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authoritativeProfileShipmentsContainStripeSessions,
  beginKeyedInventoryRecovery,
  cappedDeadlineStep,
  getOrStartKeyedInventoryRefresh,
  invalidateWalletScopedSerialRun,
  keyedInventoryRecoveryPendingForOwner,
  observeKeyedInventoryRefresh,
  profileSectionReadiness,
  retainMatchingOwnerRecoveryKey,
  retainedProfileShipmentsError,
  runWalletScopedSerial,
  settleKeyedInventoryRecovery,
  stripeInventoryRecoveryTargetForResolvedSessions,
  walletDeliveryRecoveryNextCheckAt,
  type WalletScopedSerialRun,
} from '../src/lib/profileClientLifecycle.ts';
import { stripeProfileRecoveryAfterSnapshot } from '../src/lib/profileFirestore.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('wallet-scoped recovery starts the rebound wallet and stale completion cannot clear it', async () => {
  type Request = { id: string };
  const runRef: { current: WalletScopedSerialRun<Request> | null } = { current: null };
  const walletA = deferred();
  const walletB = deferred();
  const executed: string[] = [];

  const runA = runWalletScopedSerial({
    runRef,
    wallet: 'wallet-a',
    request: { id: 'a' },
    execute: async (request) => {
      executed.push(request.id);
      await walletA.promise;
    },
  });
  invalidateWalletScopedSerialRun(runRef);
  const runB = runWalletScopedSerial({
    runRef,
    wallet: 'wallet-b',
    request: { id: 'b' },
    execute: async (request) => {
      executed.push(request.id);
      await walletB.promise;
    },
  });
  assert.deepEqual(executed, ['a', 'b']);
  const activeB = runRef.current;
  assert.equal(activeB?.wallet, 'wallet-b');
  walletA.resolve();
  await runA;
  assert.equal(runRef.current, activeB);
  walletB.resolve();
  await runB;
  assert.equal(runRef.current, null);
});

test('synchronous same-wallet recovery requests remain serialized', async () => {
  const runRef: { current: WalletScopedSerialRun<string> | null } = { current: null };
  const firstRequest = deferred();
  const executed: string[] = [];
  const execute = async (request: string) => {
    executed.push(request);
    if (request === 'first') await firstRequest.promise;
  };

  const firstRun = runWalletScopedSerial({
    runRef,
    wallet: 'wallet-a',
    request: 'first',
    execute,
  });
  const secondRun = runWalletScopedSerial({
    runRef,
    wallet: 'wallet-a',
    request: 'second',
    execute,
  });

  assert.equal(firstRun, secondRun);
  assert.deepEqual(executed, ['first']);
  firstRequest.resolve();
  await firstRun;
  assert.deepEqual(executed, ['first', 'second']);
  assert.equal(runRef.current, null);
});

test('a request arriving at the worker completion boundary starts a new run', async () => {
  const runRef: { current: WalletScopedSerialRun<string> | null } = { current: null };
  const executed: string[] = [];
  let contextChecks = 0;
  let lateRun: Promise<void> | null = null;

  const start = (request: string) =>
    runWalletScopedSerial({
      runRef,
      wallet: 'wallet-a',
      request,
      execute: async (activeRequest) => {
        executed.push(activeRequest);
      },
      isContextCurrent: () => {
        contextChecks += 1;
        if (contextChecks === 2) {
          queueMicrotask(() => {
            lateRun = start('second');
          });
        }
        return true;
      },
    });

  const firstRun = start('first');
  await firstRun;
  assert.ok(lateRun);
  assert.notEqual(lateRun, firstRun);
  await lateRun;
  assert.deepEqual(executed, ['first', 'second']);
  assert.equal(runRef.current, null);
});

test('a rejected wallet-scoped run clears its identity before rejection settles', async () => {
  const runRef: { current: WalletScopedSerialRun<string> | null } = { current: null };
  const failure = new Error('recovery failed');
  const executed: string[] = [];

  const rejectedRun = runWalletScopedSerial({
    runRef,
    wallet: 'wallet-a',
    request: 'failed',
    execute: async () => {
      throw failure;
    },
  });

  await assert.rejects(rejectedRun, failure);
  assert.equal(runRef.current, null);

  await runWalletScopedSerial({
    runRef,
    wallet: 'wallet-a',
    request: 'next',
    execute: async (request) => {
      executed.push(request);
    },
  });
  assert.deepEqual(executed, ['next']);
});

test('wallet-scoped recovery preserves every scope and force flag in FIFO order', async () => {
  type Request = { dropId?: string; deliveryId?: number; force?: boolean };
  const runRef: { current: WalletScopedSerialRun<Request> | null } = { current: null };
  const first = deferred();
  const executed: Request[] = [];
  const execute = async (request: Request) => {
    executed.push(request);
    if (executed.length === 1) await first.promise;
  };

  const active = runWalletScopedSerial({
    runRef,
    wallet: 'wallet-a',
    request: { dropId: 'drop-a', deliveryId: 1 },
    execute,
  });
  runWalletScopedSerial({ runRef, wallet: 'wallet-a', request: {}, execute });
  runWalletScopedSerial({
    runRef,
    wallet: 'wallet-a',
    request: { dropId: 'drop-b', deliveryId: 2, force: true },
    execute,
  });

  first.resolve();
  await active;
  assert.deepEqual(executed, [
    { dropId: 'drop-a', deliveryId: 1 },
    {},
    { dropId: 'drop-b', deliveryId: 2, force: true },
  ]);
});

test('wallet recovery schedule decoding requires the wallet-global response', () => {
  assert.equal(
    walletDeliveryRecoveryNextCheckAt({ walletRecovery: { nextCheckAt: 123 } }),
    123,
  );
  assert.equal(
    walletDeliveryRecoveryNextCheckAt({ walletRecovery: { nextCheckAt: null } }),
    null,
  );
  assert.equal(walletDeliveryRecoveryNextCheckAt({ nextCheckAt: 456 }), undefined);
  assert.equal(
    walletDeliveryRecoveryNextCheckAt({ walletRecovery: { nextCheckAt: Number.NaN } }),
    undefined,
  );
  assert.equal(walletDeliveryRecoveryNextCheckAt(null), undefined);
});

test('a new Stripe recovery key retriggers refresh and stale settlement cannot finish it', async () => {
  const key1 = { owner: 'wallet-a', key: 'checkout-1' };
  const key2 = { owner: 'wallet-a', key: 'checkout-2' };
  const key1Refresh = deferred();
  const key2Refresh = deferred();
  const refreshRef = { current: null };
  let starts = 0;
  let recoveryState = beginKeyedInventoryRecovery(null, key1, 10);
  const first = getOrStartKeyedInventoryRefresh({
    runRef: refreshRef,
    target: key1,
    start: () => {
      starts += 1;
      return { inventoryPromise: key1Refresh.promise, completionPromise: key1Refresh.promise };
    },
  });
  const duplicateFirst = getOrStartKeyedInventoryRefresh({
    runRef: refreshRef,
    target: key1,
    start: () => {
      throw new Error('matching recovery must reuse its active refresh');
    },
  });
  const observeFirst = observeKeyedInventoryRefresh({
    run: first.run,
    isCancelled: () => false,
    reportError: () => {},
    settle: (target) => {
      recoveryState = settleKeyedInventoryRecovery(recoveryState, target)!;
    },
  });

  recoveryState = beginKeyedInventoryRecovery(recoveryState, key2, 20);
  const second = getOrStartKeyedInventoryRefresh({
    runRef: refreshRef,
    target: key2,
    start: () => {
      starts += 1;
      return { inventoryPromise: key2Refresh.promise, completionPromise: key2Refresh.promise };
    },
  });
  const observeSecond = observeKeyedInventoryRefresh({
    run: second.run,
    isCancelled: () => false,
    reportError: () => {},
    settle: (target) => {
      recoveryState = settleKeyedInventoryRecovery(recoveryState, target)!;
    },
  });

  assert.equal(starts, 2);
  assert.equal(first.started, true);
  assert.equal(duplicateFirst.started, false);
  assert.equal(duplicateFirst.run, first.run);
  assert.equal(second.started, true);
  key1Refresh.resolve();
  await observeFirst;
  assert.deepEqual(recoveryState, { ...key2, phase: 'pending', baselineUpdatedAt: 20 });
  assert.equal(refreshRef.current, second.run);
  key2Refresh.resolve();
  await observeSecond;
  assert.deepEqual(recoveryState, {
    ...key2,
    phase: 'complete',
    baselineUpdatedAt: 20,
  });
});

test('authoritative Stripe subsets publish one stable inventory refresh target per resolved subset', () => {
  const firstResolved = stripeInventoryRecoveryTargetForResolvedSessions({
    owner: ' wallet-a ',
    firebaseUid: ' uid-a ',
    sessionIds: ['cs_b', 'cs_a', 'cs_a', ''],
  });
  assert.deepEqual(firstResolved, {
    owner: 'wallet-a',
    key: 'uid-a:cs_a|cs_b',
  });

  let published = retainMatchingOwnerRecoveryKey(null, firstResolved!);
  const repeated = retainMatchingOwnerRecoveryKey(published, {
    owner: 'wallet-a',
    key: 'uid-a:cs_a|cs_b',
  });
  assert.equal(repeated, published);

  const laterResolved = stripeInventoryRecoveryTargetForResolvedSessions({
    owner: 'wallet-a',
    firebaseUid: 'uid-a',
    sessionIds: ['cs_c'],
  });
  published = retainMatchingOwnerRecoveryKey(repeated, laterResolved!);
  assert.deepEqual(published, {
    owner: 'wallet-a',
    key: 'uid-a:cs_c',
  });

  const aggregateForTheSameSnapshot = retainMatchingOwnerRecoveryKey(published, {
    owner: 'wallet-a',
    key: 'uid-a:cs_c',
  });
  assert.equal(aggregateForTheSameSnapshot, published);
  assert.equal(
    stripeInventoryRecoveryTargetForResolvedSessions({
      owner: 'wallet-a',
      firebaseUid: 'uid-a',
      sessionIds: [],
    }),
    null,
  );
});

test('capped deadline steps rearm until the deadline and never report due early', () => {
  const deadlineAt = 250;
  const maximumDelay = 100;
  const waits: number[] = [];
  let now = 0;
  let dueCount = 0;

  while (dueCount === 0) {
    const step = cappedDeadlineStep(deadlineAt, now, maximumDelay);
    if (step.kind === 'due') {
      dueCount += 1;
      break;
    }
    waits.push(step.delayMs);
    now += step.delayMs;
  }

  assert.deepEqual(waits, [100, 100, 50]);
  assert.equal(now, deadlineAt);
  assert.equal(dueCount, 1);
  assert.deepEqual(cappedDeadlineStep(deadlineAt, deadlineAt - 1, maximumDelay), {
    kind: 'wait',
    delayMs: 1,
  });
  assert.deepEqual(cappedDeadlineStep(deadlineAt, deadlineAt, maximumDelay), { kind: 'due' });
  assert.deepEqual(cappedDeadlineStep(deadlineAt, deadlineAt + 1, maximumDelay), { kind: 'due' });
});

test('a rejected inventory refresh keeps its matching key pending for retry', async () => {
  const recovered = { owner: 'wallet-a', key: 'checkout-2' };
  const failure = new Error('refresh failed');
  const inventoryPromise = Promise.reject(failure);
  const refreshRef = { current: null };
  let recoveryState = beginKeyedInventoryRecovery(null, recovered, 20);
  let reportedError: unknown = null;
  const { run } = getOrStartKeyedInventoryRefresh({
    runRef: refreshRef,
    target: recovered,
    start: () => ({
      inventoryPromise,
      completionPromise: Promise.allSettled([inventoryPromise]),
    }),
  });

  const succeeded = await observeKeyedInventoryRefresh({
    run,
    isCancelled: () => false,
    reportError: (error) => {
      reportedError = error;
    },
    settle: (target) => {
      recoveryState = settleKeyedInventoryRecovery(recoveryState, target)!;
    },
  });

  assert.equal(succeeded, false);
  assert.equal(reportedError, failure);
  assert.equal(recoveryState.phase, 'pending');
  assert.equal(
    keyedInventoryRecoveryPendingForOwner({
      owner: recovered.owner,
      recovered,
      inventoryRecovery: recoveryState,
    }),
    true,
  );
  assert.equal(refreshRef.current, null);
});

test('shipment content waits for the initial inventory response', () => {
  const recovered = { owner: 'wallet-a', key: 'checkout-2' };
  const inventoryRecovery = beginKeyedInventoryRecovery(null, recovered, 20);
  assert.equal(
    keyedInventoryRecoveryPendingForOwner({
      owner: recovered.owner,
      recovered,
      inventoryRecovery,
    }),
    true,
  );
  assert.deepEqual(
    profileSectionReadiness({
      shipmentCount: 1,
      shipmentsEmptyStateReady: false,
      inventoryInitialResponseReady: false,
      receiptItemCount: 0,
      inventoryEmptyStateVisible: false,
    }),
    { shipments: false, receipts: false },
  );
  assert.deepEqual(
    profileSectionReadiness({
      shipmentCount: 1,
      shipmentsEmptyStateReady: false,
      inventoryInitialResponseReady: true,
      receiptItemCount: 0,
      inventoryEmptyStateVisible: false,
    }),
    { shipments: true, receipts: false },
  );
  assert.deepEqual(
    profileSectionReadiness({
      shipmentCount: 0,
      shipmentsEmptyStateReady: true,
      inventoryInitialResponseReady: false,
      receiptItemCount: 0,
      inventoryEmptyStateVisible: false,
    }),
    { shipments: false, receipts: false },
  );
  assert.deepEqual(
    profileSectionReadiness({
      shipmentCount: 0,
      shipmentsEmptyStateReady: true,
      inventoryInitialResponseReady: true,
      receiptItemCount: 0,
      inventoryEmptyStateVisible: false,
    }),
    { shipments: true, receipts: false },
  );
});

test('receipt readiness remains independent of the initial inventory response', () => {
  assert.deepEqual(
    profileSectionReadiness({
      shipmentCount: 0,
      shipmentsEmptyStateReady: false,
      inventoryInitialResponseReady: false,
      receiptItemCount: 1,
      inventoryEmptyStateVisible: false,
    }),
    { shipments: false, receipts: true },
  );
});

test('only authoritative shipment snapshots prove Stripe recovery', () => {
  const shipments = [{ stripeCheckoutSessionId: 'cs_one' }];
  const expectedSessionIds = ['cs_one'];
  const recoveryKey = 'uid:cs_one';
  const cachedMatch = authoritativeProfileShipmentsContainStripeSessions({
    shipments,
    ready: false,
    expectedSessionIds,
  });
  assert.equal(cachedMatch, false);

  const authoritativeMatch = authoritativeProfileShipmentsContainStripeSessions({
    shipments,
    ready: true,
    expectedSessionIds,
  });
  assert.equal(authoritativeMatch, true);
  for (const phase of ['pending', 'fallback'] as const) {
    const current = { key: recoveryKey, phase };
    assert.equal(stripeProfileRecoveryAfterSnapshot(current, recoveryKey, cachedMatch), current);
    assert.deepEqual(
      stripeProfileRecoveryAfterSnapshot(current, recoveryKey, authoritativeMatch),
      { key: recoveryKey, phase: 'recovered' },
    );
  }
  assert.equal(
    authoritativeProfileShipmentsContainStripeSessions({
      shipments,
      ready: true,
      expectedSessionIds: ['cs_one', 'cs_two'],
    }),
    false,
  );
});

test('retained shipment failures show a local warning only when rows remain', () => {
  const warning = 'Unable to refresh shipments. Showing previously loaded data.';
  assert.equal(
    retainedProfileShipmentsError({
      isOwnProfileView: true,
      shipmentCount: 1,
      error: 'offline',
    }),
    warning,
  );
  assert.equal(
    retainedProfileShipmentsError({
      isOwnProfileView: true,
      shipmentCount: 0,
      error: 'offline',
    }),
    null,
  );
  assert.equal(
    retainedProfileShipmentsError({
      isOwnProfileView: false,
      shipmentCount: 1,
      error: 'offline',
    }),
    null,
  );
  assert.deepEqual(
    profileSectionReadiness({
      shipmentCount: 1,
      shipmentsEmptyStateReady: true,
      inventoryInitialResponseReady: true,
      receiptItemCount: 1,
      inventoryEmptyStateVisible: false,
    }),
    { shipments: true, receipts: true },
  );
});
