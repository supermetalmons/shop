import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';
import { StrictMode, createElement, type PropsWithChildren } from 'react';
import { WALLET_SESSION_SUPERSEDED_ERROR_REASON } from '../functions/src/shared/callableErrorCode.ts';
import type { DeliveryOrderSummary, Profile, ReconcileProfileStateResponse } from '../src/types.ts';
import {
  useSolanaAuthWithRuntime,
  type SolanaAuthRuntime,
  type SolanaAuthWalletState,
} from '../src/hooks/useSolanaAuth.ts';
import type { SessionBinding, SnapshotUpdate } from '../src/lib/profileFirestore.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: dom.window.MutationObserver });
Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: dom.window.getComputedStyle });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');

afterEach(() => cleanup());

const WALLET_A = '11111111111111111111111111111111';
const WALLET_B = 'So11111111111111111111111111111111111111112';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function StrictModeWrapper({ children }: PropsWithChildren) {
  return createElement(StrictMode, null, children);
}

type Handlers<T> = {
  next: (update: SnapshotUpdate<T>) => void;
  error: (error: unknown) => void;
};

type Subscription<T> = {
  active: boolean;
  handlers: Handlers<T>;
};

class RuntimeHarness {
  uid: string | null = 'firebase-a';
  anonymousUidCounter = 0;
  signOutCalls = 0;
  nowMs = 1_000;
  sessionSubscriptions = new Map<string, Subscription<SessionBinding | null>[]>();
  profileSubscriptions = new Map<string, Subscription<Profile>[]>();
  shipmentSubscriptions = new Map<string, Subscription<DeliveryOrderSummary[]>[]>();
  authListeners = new Set<(uid: string | null) => void>();
  signOutImpl: () => Promise<void> = async () => {
    this.emitAuthUid(null);
  };
  reconcileImpl: () => Promise<ReconcileProfileStateResponse> = async () => ({
    mergedStripeDeliveryOrders: 0,
  });
  shipmentServerLoadImpl: (wallet: string) => Promise<DeliveryOrderSummary[]> = () => new Promise(() => {});
  reconcileCalls = 0;
  shipmentServerLoadCalls = 0;
  shipmentServerLoadWallets: string[] = [];
  sessionSubscribeCount = 0;
  nextTimerId = 1;
  timers = new Map<number, { at: number; callback: () => void; delay: number }>();

  runtime: SolanaAuthRuntime = {
    currentUid: () => this.uid,
    subscribeAuthUser: (listener) => {
      this.authListeners.add(listener);
      return () => this.authListeners.delete(listener);
    },
    ensureAuthenticated: async () => {
      if (!this.uid) {
        this.anonymousUidCounter += 1;
        this.emitAuthUid(`firebase-anonymous-${this.anonymousUidCounter}`);
      }
      return this.uid!;
    },
    getIdToken: async () => (this.uid ? `token:${this.uid}` : null),
    listenToSessionBinding: (uid, handlers) => this.subscribe(this.sessionSubscriptions, uid, handlers, true),
    listenToProfile: (wallet, handlers) => this.subscribe(this.profileSubscriptions, wallet, handlers),
    listenToProfileShipments: (wallet, handlers) =>
      this.subscribe(this.shipmentSubscriptions, wallet, handlers),
    loadProfileShipmentsFromServer: (wallet) => {
      this.shipmentServerLoadCalls += 1;
      this.shipmentServerLoadWallets.push(wallet);
      return this.shipmentServerLoadImpl(wallet);
    },
    reconcileProfileState: () => {
      this.reconcileCalls += 1;
      return this.reconcileImpl();
    },
    authenticateWallet: async (wallet) => ({ wallet }),
    signOut: async () => {
      this.signOutCalls += 1;
      await this.signOutImpl();
    },
    now: () => this.nowMs,
    setTimer: (callback, delay) => {
      const id = this.nextTimerId++;
      this.timers.set(id, { at: this.nowMs + delay, callback, delay });
      return id;
    },
    clearTimer: (timer) => {
      if (typeof timer === 'number') this.timers.delete(timer);
    },
  };

  private subscribe<T>(
    collection: Map<string, Subscription<T>[]>,
    key: string,
    handlers: Handlers<T>,
    session = false,
  ) {
    const subscription = { active: true, handlers };
    const subscriptions = collection.get(key) || [];
    subscriptions.push(subscription);
    collection.set(key, subscriptions);
    if (session) this.sessionSubscribeCount += 1;
    return () => {
      subscription.active = false;
    };
  }

  latestSession(uid = this.uid || '') {
    return this.latest(this.sessionSubscriptions, uid);
  }

  latestProfile(wallet: string) {
    return this.latest(this.profileSubscriptions, wallet);
  }

  latestShipments(wallet: string) {
    return this.latest(this.shipmentSubscriptions, wallet);
  }

  private latest<T>(collection: Map<string, Subscription<T>[]>, key: string) {
    const values = collection.get(key) || [];
    return [...values].reverse().find((subscription) => subscription.active) || null;
  }

  emitAuthUid(uid: string | null) {
    this.uid = uid;
    this.authListeners.forEach((listener) => listener(uid));
  }

  advance(ms: number) {
    const target = this.nowMs + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.nowMs = timer.at;
      timer.callback();
    }
    this.nowMs = target;
  }

  timerDelays() {
    return [...this.timers.values()].map((timer) => timer.delay);
  }
}

function walletState(wallet: string | null): SolanaAuthWalletState {
  return {
    connected: Boolean(wallet),
    publicKey: wallet ? { toBase58: () => wallet } : null,
    signMessage: async () => new Uint8Array([1, 2, 3]),
  };
}

function serverUpdate<T>(value: T): SnapshotUpdate<T> {
  return { value, fromCache: false, hasPendingWrites: false };
}

function cacheUpdate<T>(value: T): SnapshotUpdate<T> {
  return { value, fromCache: true, hasPendingWrites: false };
}

function pendingUpdate<T>(value: T): SnapshotUpdate<T> {
  return { value, fromCache: false, hasPendingWrites: true };
}

function shipmentFixture(
  dropId: string,
  deliveryId: number,
  overrides: Omit<Partial<DeliveryOrderSummary>, 'dropId' | 'deliveryId'> = {},
): DeliveryOrderSummary {
  return { dropId, deliveryId, status: 'processing', items: [], ...overrides };
}

function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function activateSession(
  harness: RuntimeHarness,
  result: { current: ReturnType<typeof useSolanaAuthWithRuntime> },
  wallet = WALLET_A,
) {
  await waitFor(() => assert.ok(harness.latestSession()));
  await act(async () => {
    harness.latestSession()!.handlers.next(serverUpdate({ wallet }));
  });
  await waitFor(() => assert.equal(result.current.sessionWallet, wallet));
}

test('disconnected sessions restore unconditionally without granting signing authority', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await waitFor(() => assert.ok(harness.latestSession()));
  assert.equal(result.current.sessionResolution, 'resolving');
  const binding = { wallet: WALLET_A };
  await act(async () => {
    harness.latestSession()!.handlers.next(cacheUpdate(binding));
    harness.latestSession()!.handlers.next(pendingUpdate(binding));
  });
  assert.equal(result.current.sessionWallet, null);
  assert.equal(result.current.sessionResolution, 'resolving');

  await act(async () => {
    harness.latestSession()!.handlers.next(serverUpdate(binding));
  });
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
  assert.equal(result.current.sessionResolution, 'settled');
  assert.equal(result.current.hasAuthenticatedWalletSession(WALLET_A), true);
  await assert.rejects(result.current.signIn(), /Connect a wallet first/);
  await waitFor(() => assert.ok(harness.latestProfile(WALLET_A)));
  await act(async () => {
    harness.latestProfile(WALLET_A)!.handlers.next(
      serverUpdate({ wallet: WALLET_A, email: 'owner@example.com' }),
    );
    harness.latestShipments(WALLET_A)!.handlers.next(
      serverUpdate([{ dropId: 'drop', deliveryId: 1, status: 'processing', items: [] }]),
    );
  });
  assert.deepEqual(result.current.profile, { wallet: WALLET_A, email: 'owner@example.com' });
  assert.equal(Object.hasOwn(result.current.profile || {}, 'orders'), false);
  assert.equal(result.current.shipments.length, 1);
  assert.equal(harness.reconcileCalls, 1);
});

test('connecting another wallet ends Firebase once and rejects stale owner callbacks', async () => {
  const harness = new RuntimeHarness();
  let signatureCount = 0;
  const { result, rerender } = renderHook(
    ({ wallet }: { wallet: string | null }) => {
      const state = walletState(wallet);
      state.signMessage = async () => {
        signatureCount += 1;
        return new Uint8Array([1, 2, 3]);
      };
      return useSolanaAuthWithRuntime(state, harness.runtime);
    },
    { initialProps: { wallet: null as string | null } },
  );
  await activateSession(harness, result, WALLET_A);
  const staleProfile = harness.latestProfile(WALLET_A)!;
  rerender({ wallet: WALLET_B });
  assert.equal(result.current.sessionWallet, null);
  assert.equal(result.current.token, null);
  await waitFor(() => assert.equal(harness.signOutCalls, 1));
  await waitFor(() => assert.ok(harness.latestSession('firebase-anonymous-1')));
  await act(async () => {
    staleProfile.handlers.next(serverUpdate({ wallet: WALLET_A, email: 'stale@example.com' }));
  });
  assert.equal(result.current.profile, null);
  assert.equal(result.current.hasAuthenticatedWalletSession(WALLET_A), false);
  assert.equal(harness.signOutCalls, 1);

  await act(async () => {
    harness.latestSession('firebase-anonymous-1')!.handlers.next(serverUpdate(null));
  });
  assert.equal(result.current.sessionResolution, 'settled');
  assert.equal(result.current.sessionWallet, null);
  assert.equal(signatureCount, 0);

  await act(async () => {
    await result.current.signIn();
  });
  assert.equal(result.current.sessionWallet, WALLET_B);
  assert.equal(signatureCount, 1);
  assert.equal(harness.signOutCalls, 1);
});

test('a transient mismatch sign-out failure retries without restoring the old owner', async () => {
  const harness = new RuntimeHarness();
  let signOutAttempts = 0;
  harness.signOutImpl = async () => {
    signOutAttempts += 1;
    if (signOutAttempts === 1) throw new Error('temporary sign-out failure');
    harness.emitAuthUid(null);
  };
  const { result, rerender } = renderHook(
    ({ wallet }: { wallet: string | null }) =>
      useSolanaAuthWithRuntime(walletState(wallet), harness.runtime),
    { initialProps: { wallet: null as string | null } },
  );
  await activateSession(harness, result, WALLET_A);
  const staleSession = harness.latestSession()!;

  rerender({ wallet: WALLET_B });
  await waitFor(() => assert.equal(harness.signOutCalls, 1));
  await waitFor(() => assert.equal(result.current.error, 'temporary sign-out failure'));
  assert.equal(result.current.sessionWallet, null);
  assert.equal(result.current.sessionResolution, 'resolving');
  assert.equal(harness.timers.size, 1);

  rerender({ wallet: null });
  await act(async () => {
    staleSession.handlers.next(serverUpdate({ wallet: WALLET_A }));
  });
  assert.equal(result.current.sessionWallet, null);

  await act(async () => harness.advance(400));
  await waitFor(() => assert.equal(harness.signOutCalls, 2));
  await waitFor(() => assert.ok(harness.latestSession('firebase-anonymous-1')));
  assert.equal(result.current.sessionWallet, null);
});

test('disconnecting and reconnecting the same wallet preserve the validated account', async () => {
  const harness = new RuntimeHarness();
  harness.reconcileImpl = () => new Promise(() => {});
  const { result, rerender } = renderHook(
    ({ wallet }: { wallet: string | null }) =>
      useSolanaAuthWithRuntime(walletState(wallet), harness.runtime),
    { initialProps: { wallet: WALLET_A as string | null } },
  );
  await activateSession(harness, result, WALLET_A);

  const commitAfterDisconnect = result.current.beginDeliveryRecoveryScheduleUpdate();
  rerender({ wallet: null });
  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.equal(result.current.hasAuthenticatedWalletSession(WALLET_A), true);
  assert.equal(result.current.sessionResolution, 'settled');
  await act(async () => {
    assert.equal(commitAfterDisconnect(2_000), true);
  });
  assert.equal(result.current.deliveryRecoveryNextCheckAt, 2_000);
  await waitFor(() => assert.ok(harness.latestSession()));
  await act(async () => {
    harness.latestSession()!.handlers.next(serverUpdate({ wallet: WALLET_A }));
  });
  const commitAfterReconnect = result.current.beginDeliveryRecoveryScheduleUpdate();
  rerender({ wallet: WALLET_A });
  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.equal(result.current.sessionResolution, 'settled');
  await act(async () => {
    assert.equal(commitAfterReconnect(3_000), true);
  });
  assert.equal(result.current.deliveryRecoveryNextCheckAt, 3_000);
  await waitFor(() => assert.ok(harness.latestSession()));
  await act(async () => {
    harness.latestSession()!.handlers.next(serverUpdate({ wallet: WALLET_A }));
  });
  await waitFor(() => assert.equal(result.current.sessionResolution, 'settled'));
  assert.equal(harness.signOutCalls, 0);
});

test('session listener retries transient failures indefinitely without clearing a validated account', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await activateSession(harness, result, WALLET_A);

  for (const delay of [400, 800, 1_600, 5_000, 5_000]) {
    await act(async () => {
      harness.latestSession()!.handlers.error({ code: 'unavailable', message: 'offline' });
    });
    assert.equal(result.current.sessionResolution, 'settled');
    assert.equal(result.current.sessionWallet, WALLET_A);
    await act(async () => harness.advance(delay));
    await waitFor(() => assert.ok(harness.latestSession()));
  }
  assert.equal(harness.sessionSubscribeCount, 6);
  assert.equal(result.current.sessionWallet, WALLET_A);
});

test('disconnected session setup retries a transient token failure', async () => {
  const harness = new RuntimeHarness();
  let tokenAttempts = 0;
  harness.runtime.getIdToken = async () => {
    tokenAttempts += 1;
    if (tokenAttempts === 1) {
      throw Object.assign(new Error('network unavailable'), { code: 'auth/network-request-failed' });
    }
    return harness.uid ? `token:${harness.uid}` : null;
  };
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));

  await waitFor(() => assert.equal(harness.timers.size, 1));
  assert.equal(result.current.sessionResolution, 'resolving');
  await act(async () => harness.advance(400));
  await waitFor(() => assert.ok(harness.latestSession()));
  assert.equal(tokenAttempts, 2);
  await act(async () => {
    harness.latestSession()!.handlers.next(serverUpdate({ wallet: WALLET_A }));
  });
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
});

test('session snapshots own identity, shipments settle independently, and stale callbacks cannot repopulate state', async () => {
  const harness = new RuntimeHarness();
  harness.reconcileImpl = () => new Promise(() => {});
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));

  await activateSession(harness, result, WALLET_A);
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));
  assert.equal(result.current.profileReady, false);

  const staleProfile = harness.latestProfile(WALLET_A)!;
  const staleShipments = harness.latestShipments(WALLET_A)!;
  await act(async () => {
    staleShipments.handlers.next(
      serverUpdate([{ dropId: 'drop', deliveryId: 1, status: 'processing', items: [] }]),
    );
  });
  assert.equal(result.current.shipmentsReady, true);
  assert.equal(result.current.shipments.length, 1);
  assert.equal(result.current.profileReady, false);

  await act(async () => {
    harness.latestSession()!.handlers.next(
      serverUpdate({ wallet: WALLET_B }),
    );
  });
  await waitFor(() => assert.equal(result.current.sessionWallet, null));
  await waitFor(() => assert.equal(staleShipments.active, false));

  await act(async () => {
    staleProfile.handlers.next(serverUpdate({ wallet: WALLET_A, email: 'stale@example.com' }));
    staleShipments.handlers.next(
      serverUpdate([{ dropId: 'stale', deliveryId: 2, status: 'processing', items: [] }]),
    );
  });
  assert.equal(result.current.profile, null);
  assert.deepEqual(result.current.shipments, []);
  assert.equal(harness.signOutCalls, 1);
});

test('cached and pending session snapshots wait for identical authoritative metadata', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await waitFor(() => assert.ok(harness.latestSession()));
  const binding = { wallet: WALLET_A };

  await act(async () => {
    harness.latestSession()!.handlers.next(cacheUpdate(binding));
    harness.latestSession()!.handlers.next(pendingUpdate(binding));
  });
  assert.equal(result.current.sessionWallet, null);
  assert.equal(result.current.loading, true);
  assert.equal(harness.timers.size, 0);

  await act(async () => {
    harness.latestSession()!.handlers.next(serverUpdate(binding));
  });
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
  assert.deepEqual(harness.timerDelays(), [5_000]);
});

test('fast authentication survives cached bindings until the server observer confirms or rejects them', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await waitFor(() => assert.ok(harness.latestSession()));

  await act(async () => {
    await result.current.signIn();
  });
  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.deepEqual(harness.timerDelays(), [5_000]);
  await waitFor(() => assert.ok(harness.sessionSubscribeCount >= 2));
  const observer = harness.latestSession()!;
  const binding = { wallet: WALLET_A };

  await act(async () => {
    observer.handlers.next(cacheUpdate(null));
    observer.handlers.next(cacheUpdate({ wallet: WALLET_B }));
    observer.handlers.next(pendingUpdate(binding));
  });
  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.deepEqual(harness.timerDelays(), [5_000]);

  await act(async () => {
    observer.handlers.next(serverUpdate(binding));
  });
  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.deepEqual(harness.timerDelays(), [5_000]);

  await act(async () => {
    observer.handlers.next(serverUpdate(null));
  });
  assert.equal(result.current.sessionWallet, null);
});

test('profile and shipment listeners reattach after failures and require server authority to recover', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestProfile(WALLET_A) && harness.latestShipments(WALLET_A)));
  const cachedProfile = { wallet: WALLET_A, email: 'cached@example.com' };
  const cachedShipments: DeliveryOrderSummary[] = [
    { dropId: 'cached', deliveryId: 1, status: 'processing', items: [] },
  ];

  await act(async () => {
    harness.latestProfile(WALLET_A)!.handlers.next(cacheUpdate(cachedProfile));
    harness.latestShipments(WALLET_A)!.handlers.next(cacheUpdate(cachedShipments));
  });
  assert.equal(result.current.profile?.email, 'cached@example.com');
  assert.deepEqual(result.current.shipments, cachedShipments);
  assert.equal(result.current.profileReady, false);
  assert.equal(result.current.shipmentsReady, false);

  const failedProfile = harness.latestProfile(WALLET_A)!;
  const failedShipments = harness.latestShipments(WALLET_A)!;
  await act(async () => {
    failedProfile.handlers.error(
      Object.assign(new Error('profile offline'), { code: 'unavailable' }),
    );
    failedShipments.handlers.error(
      Object.assign(new Error('shipments offline'), { code: 'unavailable' }),
    );
  });
  assert.equal(result.current.profileError, 'profile offline');
  assert.equal(result.current.shipmentsError, 'shipments offline');
  assert.equal(result.current.profileReady, false);
  assert.equal(result.current.shipmentsReady, false);

  await act(async () => harness.advance(400));
  await waitFor(() => {
    assert.ok(harness.latestProfile(WALLET_A));
    assert.ok(harness.latestShipments(WALLET_A));
    assert.notEqual(harness.latestProfile(WALLET_A), failedProfile);
    assert.notEqual(harness.latestShipments(WALLET_A), failedShipments);
  });
  await act(async () => {
    harness.latestProfile(WALLET_A)!.handlers.next(cacheUpdate(cachedProfile));
    harness.latestShipments(WALLET_A)!.handlers.next(cacheUpdate(cachedShipments));
  });
  assert.equal(result.current.profileError, 'profile offline');
  assert.equal(result.current.shipmentsError, 'shipments offline');

  await act(async () => {
    harness.latestProfile(WALLET_A)!.handlers.next(serverUpdate(cachedProfile));
    harness.latestShipments(WALLET_A)!.handlers.next(serverUpdate(cachedShipments));
  });
  assert.equal(result.current.profileReady, true);
  assert.equal(result.current.shipmentsReady, true);
  assert.equal(result.current.profileError, null);
  assert.equal(result.current.shipmentsError, null);
});

test('cache-only shipment changes render without inheriting prior server authority', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));
  const shipment = shipmentFixture('stripe', 1, { stripeCheckoutSessionId: 'cs_pending' });

  await act(async () => {
    harness.latestShipments(WALLET_A)!.handlers.next(serverUpdate([]));
  });
  assert.equal(result.current.shipmentsReady, true);

  await act(async () => {
    harness.latestShipments(WALLET_A)!.handlers.next(pendingUpdate([shipment]));
  });
  assert.deepEqual(result.current.shipments, [shipment]);
  assert.equal(result.current.shipmentsReady, false);

  await act(async () => {
    harness.latestShipments(WALLET_A)!.handlers.next(serverUpdate([shipment]));
  });
  assert.equal(result.current.shipmentsReady, true);

  await act(async () => {
    harness.latestShipments(WALLET_A)!.handlers.next(cacheUpdate([shipment]));
    harness.advance(4_999);
  });
  assert.equal(result.current.shipmentsReady, true);
  assert.equal(harness.shipmentServerLoadCalls, 0);
  await act(async () => harness.advance(1));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 1));
});

test('a shipment listener without server authority uses a slow ordered server watchdog', async () => {
  const harness = new RuntimeHarness();
  const firstShipment = shipmentFixture('alpha', 1);
  const secondShipment = shipmentFixture('zeta', 2);
  harness.shipmentServerLoadImpl = async () => [secondShipment, firstShipment];
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestProfile(WALLET_A) && harness.latestShipments(WALLET_A)));
  const profile = harness.latestProfile(WALLET_A)!;
  const shipments = harness.latestShipments(WALLET_A)!;

  await act(async () => harness.advance(4_999));
  assert.equal(harness.shipmentServerLoadCalls, 0);
  await act(async () => harness.advance(1));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 1));
  assert.deepEqual(harness.shipmentServerLoadWallets, [WALLET_A]);
  await waitFor(() => assert.deepEqual(result.current.shipments, [firstShipment, secondShipment]));
  assert.equal(harness.latestShipments(WALLET_A), shipments);
  assert.equal(shipments.active, true);
  assert.equal(harness.latestProfile(WALLET_A), profile);
  assert.equal(result.current.shipmentsReady, true);
  assert.deepEqual(harness.timerDelays(), [60_000]);

  await act(async () => {
    shipments.handlers.next(cacheUpdate([secondShipment, firstShipment]));
    harness.advance(59_999);
  });
  assert.equal(harness.shipmentServerLoadCalls, 1);
  assert.equal(result.current.shipmentsReady, true);
  await act(async () => harness.advance(1));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 2));
  assert.deepEqual(harness.timerDelays(), [60_000]);
});

test('a transient shipment server sync failure is retried without showing an error', async () => {
  const harness = new RuntimeHarness();
  const shipment = shipmentFixture('stripe', 1);
  harness.shipmentServerLoadImpl = async () => {
    if (harness.shipmentServerLoadCalls === 1) {
      throw codedError('shipments offline', 'functions/unavailable');
    }
    return [shipment];
  };
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));

  await act(async () => harness.advance(5_000));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 1));
  assert.equal(result.current.shipmentsError, null);
  assert.equal(result.current.shipmentsReady, false);
  assert.deepEqual(harness.timerDelays(), [400]);

  await act(async () => harness.advance(400));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 2));
  await waitFor(() => assert.deepEqual(result.current.shipments, [shipment]));
  assert.equal(result.current.shipmentsReady, true);
  assert.equal(result.current.shipmentsError, null);
});

test('a shipment server sync session mismatch clears and re-resolves identity', async () => {
  const harness = new RuntimeHarness();
  harness.shipmentServerLoadImpl = async () => {
    throw codedError('wallet session changed', 'functions/unauthenticated');
  };
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));
  const staleShipments = harness.latestShipments(WALLET_A)!;
  const initialSessionSubscribeCount = harness.sessionSubscribeCount;

  await act(async () => harness.advance(5_000));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 1));
  await waitFor(() => assert.equal(result.current.sessionWallet, null));
  await waitFor(() => assert.equal(staleShipments.active, false));
  await waitFor(() => assert.ok(harness.sessionSubscribeCount > initialSessionSubscribeCount));
  assert.equal(result.current.sessionResolution, 'resolving');
  assert.equal(result.current.error, null);

  await act(async () => {
    harness.latestSession()!.handlers.next(serverUpdate({ wallet: WALLET_B }));
  });
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_B));
});

test('a shipment server sync permission failure remains section-local', async () => {
  const harness = new RuntimeHarness();
  harness.shipmentServerLoadImpl = async () => {
    throw codedError('shipment fallback denied', 'functions/permission-denied');
  };
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));
  const shipments = harness.latestShipments(WALLET_A)!;

  await act(async () => harness.advance(5_000));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 1));

  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.equal(result.current.error, null);
  assert.equal(result.current.shipmentsError, 'shipment fallback denied');
  assert.equal(result.current.shipmentsReady, false);
  assert.equal(shipments.active, true);
});

test('repeated shipment server sync failures back off to one minute', async () => {
  const harness = new RuntimeHarness();
  harness.shipmentServerLoadImpl = async () => {
    throw codedError('shipments offline', 'functions/unavailable');
  };
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));

  await act(async () => harness.advance(5_000));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 1));

  const delays = [400, 800, 1_600, 5_000, 30_000, 60_000, 60_000];
  for (const [index, delay] of delays.entries()) {
    assert.deepEqual(harness.timerDelays(), [delay]);
    await act(async () => harness.advance(delay));
    await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, index + 2));
  }

  assert.equal(result.current.shipmentsError, 'shipments offline');
  assert.equal(result.current.shipmentsReady, false);
});

test('ordered shipments survive projection drift and back off after catch-up', async () => {
  const harness = new RuntimeHarness();
  const shipment = shipmentFixture('stripe', 1);
  harness.shipmentServerLoadImpl = async () => [shipment];
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));
  const shipments = harness.latestShipments(WALLET_A)!;

  await act(async () => {
    shipments.handlers.next(serverUpdate([]));
  });
  await act(async () => harness.advance(5_000));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 1));
  await waitFor(() => assert.deepEqual(result.current.shipments, [shipment]));
  assert.deepEqual(harness.timerDelays(), [5 * 60_000]);

  await act(async () => {
    shipments.handlers.next(serverUpdate([]));
  });
  assert.deepEqual(harness.timerDelays(), [5 * 60_000]);

  await act(async () => {
    shipments.handlers.next(cacheUpdate([]));
  });
  assert.deepEqual(result.current.shipments, [shipment]);

  await act(async () => {
    shipments.handlers.next(serverUpdate([]));
  });
  assert.deepEqual(result.current.shipments, [shipment]);

  await act(async () => {
    shipments.handlers.next(serverUpdate([shipment]));
  });
  await act(async () => harness.advance(5_000));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 2));
  assert.deepEqual(harness.timerDelays(), [60 * 60_000]);
  harness.shipmentServerLoadImpl = async () => {
    throw codedError('shipments offline', 'functions/unavailable');
  };
  await act(async () => harness.advance(60 * 60_000));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 3));
  assert.deepEqual(harness.timerDelays(), [60 * 60_000]);

  assert.equal(harness.latestShipments(WALLET_A), shipments);
  assert.equal(harness.shipmentSubscriptions.get(WALLET_A)?.length, 1);
  assert.equal(harness.shipmentServerLoadCalls, 3);
  assert.deepEqual(result.current.shipments, [shipment]);
  assert.equal(result.current.shipmentsReady, true);
});

test('listener additions remain visible while server revalidation retries', async () => {
  const harness = new RuntimeHarness();
  const firstShipment = shipmentFixture('alpha', 1);
  const secondShipment = shipmentFixture('beta', 2);
  const thirdShipment = shipmentFixture('gamma', 3);
  const updatedFirstShipment: DeliveryOrderSummary = {
    ...firstShipment,
    fulfillmentStatus: 'Shipped',
  };
  harness.shipmentServerLoadImpl = async () => [firstShipment];
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));
  const shipments = harness.latestShipments(WALLET_A)!;

  await act(async () => harness.advance(5_000));
  await waitFor(() => assert.deepEqual(result.current.shipments, [firstShipment]));
  harness.shipmentServerLoadImpl = async () => {
    throw codedError('shipments offline', 'functions/unavailable');
  };
  await act(async () => {
    shipments.handlers.next(serverUpdate([firstShipment, secondShipment]));
  });
  assert.deepEqual(result.current.shipments, [firstShipment, secondShipment]);

  await act(async () => harness.advance(5_000));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 2));

  for (const [index, delay] of [400, 800, 1_600, 5_000, 30_000].entries()) {
    await act(async () => harness.advance(delay));
    await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, index + 3));
  }

  assert.deepEqual(result.current.shipments, [firstShipment, secondShipment]);
  assert.equal(result.current.shipmentsReady, true);
  assert.equal(result.current.shipmentsError, null);
  assert.equal(result.current.sessionWallet, WALLET_A);

  harness.shipmentServerLoadImpl = async () => [firstShipment];
  await act(async () => harness.advance(60_000));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 8));
  await waitFor(() => assert.deepEqual(result.current.shipments, [firstShipment]));
  await act(async () => {
    shipments.handlers.next(serverUpdate([firstShipment, secondShipment]));
  });
  assert.deepEqual(result.current.shipments, [firstShipment]);
  await act(async () => {
    shipments.handlers.next(serverUpdate([updatedFirstShipment, secondShipment, thirdShipment]));
  });
  assert.deepEqual(result.current.shipments, [updatedFirstShipment, thirdShipment]);
});

test('a stale in-flight server sync cannot invalidate a listener that later loses authority', async () => {
  const harness = new RuntimeHarness();
  const serverLoad = deferred<DeliveryOrderSummary[]>();
  const cachedShipment = shipmentFixture('cached', 1);
  harness.shipmentServerLoadImpl = () => serverLoad.promise;
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));
  const shipments = harness.latestShipments(WALLET_A)!;

  await act(async () => harness.advance(5_000));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 1));
  await act(async () => {
    shipments.handlers.next(serverUpdate([]));
    shipments.handlers.next(cacheUpdate([cachedShipment]));
    serverLoad.reject(codedError('stale fallback denied', 'functions/permission-denied'));
    await Promise.resolve();
  });

  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.deepEqual(result.current.shipments, [cachedShipment]);
  assert.equal(result.current.shipmentsReady, false);
  assert.equal(result.current.shipmentsError, null);
  assert.equal(result.current.error, null);
});

test('a shipment listener error accelerates an existing server refresh', async () => {
  const harness = new RuntimeHarness();
  const shipment = shipmentFixture('stripe', 1);
  harness.shipmentServerLoadImpl = async () => [shipment];
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));
  const shipments = harness.latestShipments(WALLET_A)!;

  await act(async () => harness.advance(5_000));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 1));
  await waitFor(() => assert.deepEqual(result.current.shipments, [shipment]));

  await act(async () => {
    shipments.handlers.error(codedError('shipments offline', 'unavailable'));
  });
  assert.equal(result.current.shipmentsReady, false);
  assert.equal(result.current.shipmentsError, 'shipments offline');

  await act(async () => harness.advance(4_999));
  assert.equal(harness.shipmentServerLoadCalls, 1);
  await act(async () => harness.advance(1));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 2));
  assert.equal(result.current.shipmentsReady, true);
  assert.equal(result.current.shipmentsError, null);
});

test('repeated shipment listener errors preserve one scheduled and in-flight server sync', async () => {
  const harness = new RuntimeHarness();
  const serverLoad = deferred<DeliveryOrderSummary[]>();
  const shipment = shipmentFixture('stripe', 1);
  harness.shipmentServerLoadImpl = () => serverLoad.promise;
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));

  await act(async () => {
    harness.latestShipments(WALLET_A)!.handlers.error(codedError('shipments offline', 'unavailable'));
  });
  await act(async () => harness.advance(400));
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));
  await act(async () => {
    harness.latestShipments(WALLET_A)!.handlers.error(codedError('shipments still offline', 'unavailable'));
    harness.advance(4_599);
  });
  assert.equal(harness.shipmentServerLoadCalls, 0);
  await act(async () => harness.advance(1));
  await waitFor(() => assert.equal(harness.shipmentServerLoadCalls, 1));

  await act(async () => {
    harness.advance(800);
    harness.latestShipments(WALLET_A)!.handlers.error(codedError('shipments remain offline', 'unavailable'));
    harness.advance(5_000);
  });
  assert.equal(harness.shipmentServerLoadCalls, 1);

  await act(async () => serverLoad.resolve([shipment]));
  await waitFor(() => assert.deepEqual(result.current.shipments, [shipment]));
  assert.equal(result.current.shipmentsReady, true);
  assert.equal(result.current.shipmentsError, null);
});

test('terminal session errors clear identity and a later sign-in reattaches the authoritative observer', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  const failedSubscription = harness.latestSession()!;
  const initialSubscribeCount = harness.sessionSubscribeCount;

  await act(async () => {
    failedSubscription.handlers.error(new Error('listener terminated'));
  });
  assert.equal(result.current.sessionWallet, null);

  await act(async () => {
    await result.current.signIn();
  });
  assert.equal(result.current.sessionWallet, WALLET_A);
  await waitFor(() => assert.ok(harness.sessionSubscribeCount > initialSubscribeCount));
  const renewedSubscription = harness.latestSession()!;
  assert.notEqual(renewedSubscription, failedSubscription);
  await act(async () => {
    renewedSubscription.handlers.next(
      serverUpdate({ wallet: WALLET_A, expiresAt: harness.nowMs + 5_000 }),
    );
  });
  assert.equal(result.current.sessionWallet, WALLET_A);
});

test('successful fast authentication clears a listener error that arrives while signing', async () => {
  const harness = new RuntimeHarness();
  let resolveAuthentication!: (value: { wallet: string }) => void;
  let signalAuthenticationStarted!: () => void;
  const authenticationStarted = new Promise<void>((resolve) => {
    signalAuthenticationStarted = resolve;
  });
  harness.runtime.authenticateWallet = async () => {
    signalAuthenticationStarted();
    return new Promise((resolve) => {
      resolveAuthentication = resolve;
    });
  };
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  const failedSubscription = harness.latestSession()!;
  let signInPromise!: ReturnType<typeof result.current.signIn>;

  await act(async () => {
    signInPromise = result.current.signIn();
    await authenticationStarted;
  });
  await act(async () => {
    failedSubscription.handlers.error(new Error('listener failed during sign-in'));
  });
  assert.equal(result.current.error, 'listener failed during sign-in');

  await act(async () => {
    resolveAuthentication({ wallet: WALLET_A });
    await signInPromise;
  });
  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.equal(result.current.error, null);
  await waitFor(() => assert.notEqual(harness.latestSession(), failedSubscription));
  await act(async () => {
    harness.latestSession()!.handlers.next(cacheUpdate(null));
  });
  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.equal(result.current.error, null);
});

test('wallet and Firebase-user changes clean up owner listeners and reject old callbacks', async () => {
  const harness = new RuntimeHarness();
  const { result, rerender } = renderHook(
    ({ wallet }) => useSolanaAuthWithRuntime(walletState(wallet), harness.runtime),
    { initialProps: { wallet: WALLET_A as string | null } },
  );
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestShipments(WALLET_A)));
  const oldShipments = harness.latestShipments(WALLET_A)!;

  rerender({ wallet: WALLET_B });
  assert.equal(result.current.sessionWallet, null);
  await waitFor(() => assert.equal(oldShipments.active, false));
  await waitFor(() => assert.ok(harness.latestSession()));
  await act(async () => {
    harness.latestSession()!.handlers.next(
      serverUpdate({ wallet: WALLET_B, expiresAt: harness.nowMs + 5_000 }),
    );
  });
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_B));

  await act(async () => harness.emitAuthUid('firebase-b'));
  assert.equal(result.current.sessionWallet, null);
  await waitFor(() => assert.ok(harness.latestSession('firebase-b')));
  await act(async () => {
    oldShipments.handlers.next(
      serverUpdate([{ dropId: 'stale', deliveryId: 3, status: 'processing', items: [] }]),
    );
  });
  assert.deepEqual(result.current.shipments, []);
});

test('section-local listener failures preserve identity while authorization failures invalidate it', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestProfile(WALLET_A) && harness.latestShipments(WALLET_A)));

  const failedProfile = harness.latestProfile(WALLET_A)!;
  const failedShipments = harness.latestShipments(WALLET_A)!;
  await act(async () => {
    failedProfile.handlers.error(
      Object.assign(new Error('profile temporarily unavailable'), { code: 'unavailable' }),
    );
    failedShipments.handlers.error(
      Object.assign(new Error('shipments temporarily unavailable'), { code: 'unavailable' }),
    );
  });
  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.equal(result.current.profileError, 'profile temporarily unavailable');
  assert.equal(result.current.shipmentsError, 'shipments temporarily unavailable');

  await act(async () => harness.advance(400));
  await waitFor(() => {
    assert.ok(harness.latestShipments(WALLET_A));
    assert.notEqual(harness.latestShipments(WALLET_A), failedShipments);
  });
  await act(async () => {
    harness.latestShipments(WALLET_A)!.handlers.error(
      Object.assign(new Error('shipment access revoked'), { code: 'permission-denied' }),
    );
  });
  assert.equal(result.current.sessionWallet, null);
  assert.equal(result.current.error, 'shipment access revoked');
});

test('section listener retries continue at a capped interval', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.ok(harness.latestProfile(WALLET_A)));

  for (const delay of [400, 800, 1_600]) {
    const failedProfile = harness.latestProfile(WALLET_A)!;
    await act(async () => {
      failedProfile.handlers.error(
        Object.assign(new Error('profile temporarily unavailable'), { code: 'unavailable' }),
      );
    });
    assert.equal(harness.latestProfile(WALLET_A), null);
    await act(async () => harness.advance(delay));
    await waitFor(() => {
      assert.ok(harness.latestProfile(WALLET_A));
      assert.notEqual(harness.latestProfile(WALLET_A), failedProfile);
    });
  }

  const finalProfile = harness.latestProfile(WALLET_A)!;
  await act(async () => {
    finalProfile.handlers.error(
      Object.assign(new Error('profile still unavailable'), { code: 'unavailable' }),
    );
  });
  assert.equal(harness.latestProfile(WALLET_A), null);
  await act(async () => harness.advance(4_999));
  assert.equal(harness.latestProfile(WALLET_A), null);
  await act(async () => harness.advance(1));
  await waitFor(() => assert.ok(harness.latestProfile(WALLET_A)));
  assert.equal(harness.profileSubscriptions.get(WALLET_A)?.length, 5);
  assert.equal(result.current.sessionWallet, WALLET_A);
});

test('background reconciliation failures do not invalidate direct profile state', async () => {
  const harness = new RuntimeHarness();
  harness.reconcileImpl = async () => {
    throw new Error('optional reconciliation failed');
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
    await activateSession(harness, result);
    await waitFor(() => assert.ok(harness.reconcileCalls > 0));
    assert.equal(result.current.sessionWallet, WALLET_A);
    assert.equal(result.current.error, null);
  } finally {
    console.warn = originalWarn;
  }
});

test('retryable background reconciliation failures restore the recovery schedule', async () => {
  const harness = new RuntimeHarness();
  let attempts = 0;
  harness.reconcileImpl = async () => {
    attempts += 1;
    if (attempts <= 4) {
      throw Object.assign(new Error('reconciliation temporarily unavailable'), {
        code: 'functions/unavailable',
      });
    }
    return {
      mergedStripeDeliveryOrders: 0,
      deliveryRecovery: { nextCheckAt: 9_000 },
    };
  };

  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.equal(harness.reconcileCalls, 1));
  for (const [index, delay] of [400, 800, 1_600, 5_000].entries()) {
    await act(async () => harness.advance(delay));
    await waitFor(() => assert.equal(harness.reconcileCalls, index + 2));
  }
  await waitFor(() => assert.equal(result.current.deliveryRecoveryNextCheckAt, 9_000));
  assert.equal(harness.reconcileCalls, 5);
  assert.equal(result.current.sessionWallet, WALLET_A);
});

test('background reconciliation retries stop after the owner context is invalidated', async () => {
  const harness = new RuntimeHarness();
  harness.reconcileImpl = async () => {
    throw Object.assign(new Error('reconciliation temporarily unavailable'), {
      code: 'functions/unavailable',
    });
  };

  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);
  await waitFor(() => assert.equal(harness.reconcileCalls, 1));
  await act(async () => {
    harness.latestSession()!.handlers.next(
      serverUpdate({ wallet: WALLET_B, expiresAt: harness.nowMs + 10_000 }),
    );
  });
  await waitFor(() => assert.equal(result.current.sessionWallet, null));
  await act(async () => harness.advance(5_000));
  assert.equal(harness.reconcileCalls, 1);
});

test('an in-flight fast sign-in cannot reactivate identity after the Firebase UID changes', async () => {
  const harness = new RuntimeHarness();
  const originalError = console.error;
  console.error = () => {};
  let resolveAuthentication!: (value: { wallet: string }) => void;
  let signalAuthenticationStarted!: () => void;
  const authenticationStarted = new Promise<void>((resolve) => {
    signalAuthenticationStarted = resolve;
  });
  harness.runtime.authenticateWallet = async (_wallet) => {
    signalAuthenticationStarted();
    return new Promise((resolve) => {
      resolveAuthentication = resolve;
    });
  };
  try {
    const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
    let signInPromise!: ReturnType<typeof result.current.signIn>;

    await act(async () => {
      signInPromise = result.current.signIn();
      await authenticationStarted;
    });
    await act(async () => {
      harness.emitAuthUid('firebase-b');
    });
    await act(async () => {
      resolveAuthentication({ wallet: WALLET_A });
      await assert.rejects(signInPromise, /authentication changed during sign-in/i);
    });
    assert.equal(result.current.sessionWallet, null);
  } finally {
    console.error = originalError;
  }
});

test('concurrent same-wallet sign-ins share one signature and one session write', async () => {
  const harness = new RuntimeHarness();
  let signatureCount = 0;
  let authenticationCount = 0;
  let resolveAuthentication!: (value: { wallet: string }) => void;
  harness.runtime.authenticateWallet = async () => {
    authenticationCount += 1;
    return new Promise((resolve) => {
      resolveAuthentication = resolve;
    });
  };
  const state: SolanaAuthWalletState = {
    connected: true,
    publicKey: { toBase58: () => WALLET_A },
    signMessage: async () => {
      signatureCount += 1;
      return new Uint8Array([1, 2, 3]);
    },
  };
  const { result } = renderHook(() => useSolanaAuthWithRuntime(state, harness.runtime));
  let first!: ReturnType<typeof result.current.signIn>;
  let second!: ReturnType<typeof result.current.signIn>;

  await act(async () => {
    first = result.current.signIn();
    second = result.current.signIn();
    assert.equal(first, second);
    await waitFor(() => assert.equal(authenticationCount, 1));
  });
  await act(async () => {
    resolveAuthentication({ wallet: WALLET_A });
    assert.deepEqual(await Promise.all([first, second]), [
      { wallet: WALLET_A, token: 'token:firebase-a' },
      { wallet: WALLET_A, token: 'token:firebase-a' },
    ]);
  });
  assert.equal(signatureCount, 1);
  assert.equal(authenticationCount, 1);
});

test('a newer wallet session write waits for an older in-flight write and finishes last', async () => {
  const harness = new RuntimeHarness();
  const originalError = console.error;
  console.error = () => {};
  const calls: string[] = [];
  let resolveWalletA!: (value: { wallet: string }) => void;
  let signalWalletAStarted!: () => void;
  const walletAStarted = new Promise<void>((resolve) => {
    signalWalletAStarted = resolve;
  });
  harness.runtime.authenticateWallet = async (wallet) => {
    calls.push(wallet);
    if (wallet === WALLET_A) {
      signalWalletAStarted();
      return new Promise((resolve) => {
        resolveWalletA = resolve;
      });
    }
    return { wallet };
  };

  try {
    const { result, rerender } = renderHook(
      ({ wallet }) => useSolanaAuthWithRuntime(walletState(wallet), harness.runtime),
      { initialProps: { wallet: WALLET_A } },
    );
    let walletAPromise!: ReturnType<typeof result.current.signIn>;
    await act(async () => {
      walletAPromise = result.current.signIn();
      await walletAStarted;
    });
    const walletARejected = assert.rejects(walletAPromise, /wallet changed during sign-in/i);

    await act(async () => {
      rerender({ wallet: WALLET_B });
    });
    let walletBPromise!: ReturnType<typeof result.current.signIn>;
    await act(async () => {
      walletBPromise = result.current.signIn();
      await Promise.resolve();
    });
    assert.deepEqual(calls, [WALLET_A]);

    await act(async () => {
      resolveWalletA({ wallet: WALLET_A });
      await walletARejected;
      assert.deepEqual(await walletBPromise, {
        wallet: WALLET_B,
        token: 'token:firebase-a',
      });
    });
    assert.deepEqual(calls, [WALLET_A, WALLET_B]);
    assert.equal(result.current.sessionWallet, WALLET_B);
  } finally {
    console.error = originalError;
  }
});

test('an unmounted hook cannot dispatch authentication after its signature resolves', async () => {
  const harness = new RuntimeHarness();
  const signatureStarted = deferred<void>();
  const signature = deferred<Uint8Array>();
  const authenticationCalls: string[] = [];
  const originalError = console.error;
  console.error = () => {};
  harness.runtime.authenticateWallet = async (wallet) => {
    authenticationCalls.push(wallet);
    return { wallet };
  };

  try {
    const first = renderHook(() =>
      useSolanaAuthWithRuntime(
        {
          ...walletState(WALLET_A),
          signMessage: async () => {
            signatureStarted.resolve();
            return signature.promise;
          },
        },
        harness.runtime,
      ),
    );
    let staleSignIn!: ReturnType<typeof first.result.current.signIn>;
    await act(async () => {
      staleSignIn = first.result.current.signIn();
      await signatureStarted.promise;
    });
    const staleRejection = assert.rejects(staleSignIn, /wallet changed during sign-in/i);
    first.unmount();

    const second = renderHook(() =>
      useSolanaAuthWithRuntime(walletState(WALLET_B), harness.runtime),
    );
    await act(async () => {
      await second.result.current.signIn();
    });
    await act(async () => {
      signature.resolve(new Uint8Array([1, 2, 3]));
      await staleRejection;
    });

    assert.deepEqual(authenticationCalls, [WALLET_B]);
  } finally {
    console.error = originalError;
  }
});

test('a running authentication settles before a newer hook instance dispatches', async () => {
  const harness = new RuntimeHarness();
  const walletAStarted = deferred<void>();
  const walletAResponse = deferred<{ wallet: string }>();
  const walletBSigned = deferred<void>();
  const events: string[] = [];
  const originalError = console.error;
  console.error = () => {};
  harness.runtime.authenticateWallet = async (wallet) => {
    events.push(`start:${wallet}`);
    if (wallet === WALLET_A) {
      walletAStarted.resolve();
      const response = await walletAResponse.promise;
      events.push(`finish:${wallet}`);
      return response;
    }
    events.push(`finish:${wallet}`);
    return { wallet };
  };

  try {
    const first = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
    let staleSignIn!: ReturnType<typeof first.result.current.signIn>;
    await act(async () => {
      staleSignIn = first.result.current.signIn();
      await walletAStarted.promise;
    });
    const staleRejection = assert.rejects(staleSignIn, /wallet changed during sign-in/i);
    first.unmount();

    const second = renderHook(() =>
      useSolanaAuthWithRuntime(
        {
          ...walletState(WALLET_B),
          signMessage: async () => {
            walletBSigned.resolve();
            return new Uint8Array([4, 5, 6]);
          },
        },
        harness.runtime,
      ),
    );
    let currentSignIn!: ReturnType<typeof second.result.current.signIn>;
    await act(async () => {
      currentSignIn = second.result.current.signIn();
      await walletBSigned.promise;
    });
    assert.deepEqual(events, [`start:${WALLET_A}`]);

    await act(async () => {
      walletAResponse.resolve({ wallet: WALLET_A });
      await staleRejection;
      assert.deepEqual(await currentSignIn, {
        wallet: WALLET_B,
        token: 'token:firebase-a',
      });
    });
    assert.deepEqual(events, [
      `start:${WALLET_A}`,
      `finish:${WALLET_A}`,
      `start:${WALLET_B}`,
      `finish:${WALLET_B}`,
    ]);
  } finally {
    console.error = originalError;
  }
});

test('wallet-session supersession is not retried', async () => {
  const harness = new RuntimeHarness();
  const originalError = console.error;
  console.error = () => {};
  let authenticationCount = 0;
  harness.runtime.authenticateWallet = async () => {
    authenticationCount += 1;
    throw Object.assign(new Error('Wallet session superseded'), {
      code: 'functions/aborted',
      details: { reason: WALLET_SESSION_SUPERSEDED_ERROR_REASON },
    });
  };

  try {
    const { result } = renderHook(() =>
      useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime),
    );
    await act(async () => {
      await assert.rejects(result.current.signIn(), /wallet session superseded/i);
    });
    assert.equal(authenticationCount, 1);
    assert.equal(result.current.sessionWallet, null);
    assert.equal(result.current.loading, false);
  } finally {
    console.error = originalError;
  }
});

test('StrictMode lifecycle replay leaves the current hook able to sign in', async () => {
  const harness = new RuntimeHarness();
  let authenticationCount = 0;
  harness.runtime.authenticateWallet = async (wallet) => {
    authenticationCount += 1;
    return { wallet };
  };
  const { result } = renderHook(
    () => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime),
    { wrapper: StrictModeWrapper },
  );

  await waitFor(() => assert.ok(harness.latestSession()));
  await act(async () => {
    await result.current.signIn();
  });
  assert.equal(authenticationCount, 1);
  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.equal(result.current.token, 'token:firebase-a');
});

test('recovery schedule commits are current-owner guarded and newest successful request wins', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await activateSession(harness, result);

  const older = result.current.beginDeliveryRecoveryScheduleUpdate();
  const newer = result.current.beginDeliveryRecoveryScheduleUpdate();
  await act(async () => {
    assert.equal(newer(2_000), true);
    assert.equal(older(1_500), false);
  });
  assert.equal(result.current.deliveryRecoveryNextCheckAt, 2_000);

  const usefulOlder = result.current.beginDeliveryRecoveryScheduleUpdate();
  result.current.beginDeliveryRecoveryScheduleUpdate();
  await act(async () => {
    assert.equal(usefulOlder(3_000), true);
  });
  assert.equal(result.current.deliveryRecoveryNextCheckAt, 3_000);

  const staleOwnerCommit = result.current.beginDeliveryRecoveryScheduleUpdate();
  await act(async () => {
    harness.latestSession()!.handlers.next(
      serverUpdate({ wallet: WALLET_B, expiresAt: harness.nowMs + 5_000 }),
    );
  });
  await act(async () => {
    assert.equal(staleOwnerCommit(4_000), false);
  });
  assert.equal(result.current.deliveryRecoveryNextCheckAt, null);
});
