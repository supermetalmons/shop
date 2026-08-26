import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';
import { useLayoutEffect } from 'react';
import type { DeliveryOrderSummary, GetProfileStateResponse, ReconcileProfileStateResponse } from '../src/types.ts';
import {
  useSolanaAuthWithRuntime,
  type SolanaAuthRuntime,
  type SolanaAuthWalletState,
} from '../src/hooks/useSolanaAuth.ts';
import { walletSessionSignInReadiness } from '../src/lib/profileClientLifecycle.ts';
import type { StaffWalletSession } from '../src/lib/staffWalletSession.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: dom.window.MutationObserver });
Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: dom.window.getComputedStyle });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

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

function shipment(deliveryId: number, status = 'processing'): DeliveryOrderSummary {
  return { dropId: 'drop', deliveryId, status, items: [] };
}

function readyState(
  wallet: string,
  shipments: DeliveryOrderSummary[] = [],
  email = 'owner@example.com',
): GetProfileStateResponse {
  return {
    responseMode: 'profile-state',
    sessionWallet: wallet,
    profile: { status: 'ready', value: { wallet, email } },
    shipments: { status: 'ready', value: shipments },
  };
}

function emptyState(): GetProfileStateResponse {
  return {
    responseMode: 'profile-state',
    sessionWallet: null,
    profile: null,
    shipments: null,
  };
}

class RuntimeHarness {
  uid: string | null = 'auth-a';
  staffSession: StaffWalletSession | null = null;
  anonymousUidCounter = 0;
  nowMs = 1_000;
  visible = true;
  signOutCalls = 0;
  loadCalls = 0;
  reconcileCalls = 0;
  authenticateCalls = 0;
  nextState: GetProfileStateResponse = readyState(WALLET_A, [shipment(1)]);
  loadImpl: () => Promise<GetProfileStateResponse> = async () => this.nextState;
  reconcileImpl: () => Promise<ReconcileProfileStateResponse> = async () => ({ mergedStripeDeliveryOrders: 0 });
  signOutImpl: () => Promise<void> = async () => {
    this.nextState = emptyState();
    this.emitAuthSubject(null);
  };
  authenticateImpl: (wallet: string) => Promise<{ wallet: string }> = async (wallet) => {
    this.nextState = readyState(wallet);
    return { wallet };
  };
  authSubjectListeners = new Set<(uid: string | null) => void>();
  refreshListeners = new Set<() => void>();
  nextTimerId = 1;
  timers = new Map<number, { at: number; callback: () => void; delay: number }>();

  runtime: SolanaAuthRuntime = {
    currentAuthSubject: () => this.uid,
    subscribeAuthSubject: (listener) => {
      this.authSubjectListeners.add(listener);
      return () => this.authSubjectListeners.delete(listener);
    },
    ensureAuthenticated: async () => {
      if (!this.uid) {
        this.anonymousUidCounter += 1;
        this.emitAuthSubject(`auth-anonymous-${this.anonymousUidCounter}`);
      }
      return this.uid!;
    },
    loadProfileState: async () => {
      this.loadCalls += 1;
      return this.loadImpl();
    },
    reconcileProfileState: async () => {
      this.reconcileCalls += 1;
      return this.reconcileImpl();
    },
    authenticateWallet: async (wallet) => {
      this.authenticateCalls += 1;
      return this.authenticateImpl(wallet);
    },
    signOut: async () => {
      this.signOutCalls += 1;
      await this.signOutImpl();
    },
    subscribeRefreshEvents: (listener) => {
      this.refreshListeners.add(listener);
      return () => this.refreshListeners.delete(listener);
    },
    isPageVisible: () => this.visible,
    now: () => this.nowMs,
    setTimer: (callback, delay) => {
      const id = this.nextTimerId++;
      this.timers.set(id, { at: this.nowMs + delay, callback, delay });
      return id;
    },
    clearTimer: (timer) => {
      if (typeof timer === 'number') this.timers.delete(timer);
    },
    currentStaffSession: () => this.staffSession,
    installStaffSession: async (session, expectedToken) => {
      if ((this.staffSession?.token || null) !== expectedToken) return this.staffSession;
      this.staffSession = session;
      this.emitAuthSubject(session.wallet);
      return session;
    },
  };

  emitAuthSubject(uid: string | null) {
    this.uid = uid;
    this.authSubjectListeners.forEach((listener) => listener(uid));
  }

  emitRefresh() {
    this.refreshListeners.forEach((listener) => listener());
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
    signMessage: async () => new Uint8Array(64),
  };
}

test('disconnected sessions restore complete profile state through the API', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
  assert.equal(result.current.sessionResolution, 'settled');
  assert.deepEqual(result.current.profile, { wallet: WALLET_A, email: 'owner@example.com' });
  assert.deepEqual(result.current.shipments, [shipment(1)]);
  assert.equal(result.current.profileReady, true);
  assert.equal(result.current.shipmentsReady, true);
  assert.equal(result.current.hasAuthenticatedWalletSession(WALLET_A), true);
  assert.deepEqual(harness.timerDelays(), [60_000]);
});

test('an authenticated Auth user without a wallet session settles signed out', async () => {
  const harness = new RuntimeHarness();
  harness.nextState = emptyState();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionResolution, 'settled'));
  assert.equal(result.current.sessionWallet, null);
  assert.equal(result.current.loading, false);
  assert.equal(walletSessionSignInReadiness({
    hasAuthenticatedSession: false,
    sessionResolution: result.current.sessionResolution,
    authLoading: result.current.loading,
  }), 'sign');
});

test('the auth subject observes identities created after render', async () => {
  const harness = new RuntimeHarness();
  harness.uid = null;
  harness.nextState = emptyState();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionResolution, 'settled'));
  assert.match(result.current.authSubject || '', /^auth-anonymous-/);
  await act(async () => harness.emitAuthSubject('auth-replacement'));
  assert.equal(result.current.authSubject, 'auth-replacement');
});

test('a connected-wallet mismatch clears state and signs Auth out once', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_B), harness.runtime));
  await waitFor(() => assert.equal(harness.signOutCalls, 1));
  await waitFor(() => assert.equal(result.current.sessionWallet, null));
});

test('switching the connected extension account begins logout before refresh effects', async () => {
  const harness = new RuntimeHarness();
  harness.reconcileImpl = () => new Promise(() => {});
  harness.signOutImpl = () => new Promise(() => {});
  const layoutSignOutCalls: number[] = [];
  const { result, rerender } = renderHook(
    ({ wallet }: { wallet: string | null }) => {
      const authState = useSolanaAuthWithRuntime(walletState(wallet), harness.runtime);
      useLayoutEffect(() => {
        layoutSignOutCalls.push(harness.signOutCalls);
      }, [wallet]);
      return authState;
    },
    { initialProps: { wallet: null as string | null } },
  );
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
  const loadCalls = harness.loadCalls;

  rerender({ wallet: WALLET_B });
  assert.equal(result.current.sessionWallet, null);
  assert.equal(layoutSignOutCalls.at(-1), 1);
  await act(async () => Promise.resolve());
  assert.equal(harness.loadCalls, loadCalls);
});

test('partial API failures retain state and recover section-by-section', async () => {
  const harness = new RuntimeHarness();
  const first = shipment(1);
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await waitFor(() => assert.equal(result.current.shipmentsReady, true));
  harness.nextState = {
    responseMode: 'profile-state',
    sessionWallet: WALLET_A,
    profile: { status: 'error', error: { code: 'unavailable', message: 'profile unavailable' } },
    shipments: { status: 'error', error: { code: 'deadline-exceeded', message: 'shipments timed out' } },
  };
  await act(async () => assert.equal(await result.current.refreshProfileState(), false));
  assert.deepEqual(result.current.shipments, [first]);
  assert.equal(result.current.profileError, 'profile unavailable');
  assert.equal(result.current.shipmentsError, 'shipments timed out');
  assert.equal(result.current.sessionResolution, 'settled');

  harness.nextState = readyState(WALLET_A, [shipment(2)], 'new@example.com');
  await act(async () => result.current.refreshProfileState());
  assert.deepEqual(result.current.profile, { wallet: WALLET_A, email: 'new@example.com' });
  assert.deepEqual(result.current.shipments, [shipment(2)]);
  assert.equal(result.current.profileError, null);
  assert.equal(result.current.shipmentsError, null);
});

test('steady polling waits sixty seconds and refresh events run immediately', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
  await waitFor(() => assert.equal(harness.reconcileCalls, 1));
  const baseline = harness.loadCalls;
  await act(async () => harness.advance(59_999));
  assert.equal(harness.loadCalls, baseline);
  await act(async () => harness.advance(1));
  await waitFor(() => assert.equal(harness.loadCalls, baseline + 1));
  harness.nextState = readyState(WALLET_A, [shipment(3)]);
  await act(async () => harness.emitRefresh());
  await waitFor(() => assert.deepEqual(result.current.shipments, [shipment(3)]));
});

test('steady polling pauses while hidden and resumes from a visibility event', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
  await waitFor(() => assert.equal(harness.reconcileCalls, 1));
  const baseline = harness.loadCalls;
  harness.visible = false;
  await act(async () => harness.advance(60_000));
  assert.equal(harness.loadCalls, baseline);
  assert.deepEqual(harness.timerDelays(), []);
  harness.visible = true;
  await act(async () => harness.emitRefresh());
  await waitFor(() => assert.equal(harness.loadCalls, baseline + 1));
});

test('transient failures use the bounded retry schedule', async () => {
  const harness = new RuntimeHarness();
  harness.loadImpl = async () => {
    throw Object.assign(new Error('offline'), { code: 'unavailable' });
  };
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await waitFor(() => assert.deepEqual(harness.timerDelays(), [400]));
  assert.equal(result.current.sessionResolution, 'resolving');
  const expectedNext = [800, 1_600, 5_000, 30_000, 60_000, 60_000];
  for (const [index, delay] of [400, 800, 1_600, 5_000, 30_000, 60_000].entries()) {
    await act(async () => harness.advance(delay));
    await waitFor(() => assert.equal(harness.loadCalls, index + 2));
    assert.deepEqual(harness.timerDelays(), [expectedNext[index]]);
  }
});

test('reconciliation awaits a fresh profile state before resolving', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
  await waitFor(() => assert.equal(harness.reconcileCalls, 1));
  const baseline = harness.reconcileCalls;
  harness.nextState = readyState(WALLET_A, [shipment(4)]);
  await act(async () => {
    assert.deepEqual(await result.current.reconcileProfile({ includeDeliveryRecovery: true }), {
      mergedStripeDeliveryOrders: 0,
    });
  });
  assert.equal(harness.reconcileCalls, baseline + 1);
  assert.deepEqual(result.current.shipments, [shipment(4)]);
});

test('concurrent refreshes share one request and queue one follow-up', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
  const first = deferred<GetProfileStateResponse>();
  let calls = 0;
  harness.loadImpl = () => {
    calls += 1;
    return calls === 1 ? first.promise : Promise.resolve(readyState(WALLET_A, [shipment(5)]));
  };
  await act(async () => {
    const firstRefresh = result.current.refreshProfileState();
    const secondRefresh = result.current.refreshProfileState();
    assert.equal(firstRefresh, secondRefresh);
    first.resolve(readyState(WALLET_A, [shipment(4)]));
    await firstRefresh;
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.current.shipments, [shipment(5)]);
});

test('stale in-flight responses cannot restore a replaced Auth user', async () => {
  const harness = new RuntimeHarness();
  harness.nextState = emptyState();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionResolution, 'settled'));
  const stale = deferred<GetProfileStateResponse>();
  harness.loadImpl = () => stale.promise;
  await act(async () => {
    void result.current.refreshProfileState();
  });
  harness.loadImpl = async () => emptyState();
  await act(async () => harness.emitAuthSubject('auth-b'));
  await act(async () => stale.resolve(readyState(WALLET_A)));
  await waitFor(() => assert.equal(result.current.sessionWallet, null));
});

test('sign-in establishes and refreshes API-backed profile state', async () => {
  const harness = new RuntimeHarness();
  harness.nextState = emptyState();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionResolution, 'settled'));
  await act(async () => result.current.signIn());
  assert.equal(harness.authenticateCalls, 1);
  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.deepEqual(result.current.profile, { wallet: WALLET_A, email: 'owner@example.com' });
});

test('restored Auth staff sessions are discarded before wallet-only sign-in', async () => {
  const harness = new RuntimeHarness();
  harness.runtime.isStaffWallet = (wallet) => wallet === WALLET_A;
  harness.runtime.hasStaffSession = () => false;
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await waitFor(() => assert.equal(harness.signOutCalls, 1));
  await waitFor(() => assert.equal(result.current.sessionWallet, null));
  await waitFor(() => assert.equal(result.current.sessionResolution, 'settled'));
  assert.equal(result.current.loading, false);
});

test('allowlisted staff sign-in uses the server challenge without Auth wallet binding', async () => {
  const harness = new RuntimeHarness();
  harness.nextState = emptyState();
  let staffChallengeCalls = 0;
  let staffSessionCalls = 0;
  let signedMessage = '';
  harness.runtime.isStaffWallet = (wallet) => wallet === WALLET_A;
  harness.runtime.hasStaffSession = (wallet) => harness.uid === wallet;
  harness.runtime.createStaffChallenge = async () => {
    staffChallengeCalls += 1;
    return { challengeId: 'challenge', message: 'server staff challenge', expiresAt: 10_000 };
  };
  harness.runtime.authenticateStaffWallet = async (_challengeId, signature) => {
    staffSessionCalls += 1;
    assert.deepEqual(signature, new Uint8Array(64).fill(9));
    harness.nextState = readyState(WALLET_A);
    return {
      wallet: WALLET_A,
      token: 'staff-token',
      refreshedAt: 1_000,
      expiresAt: 100_000,
    };
  };
  const wallet: SolanaAuthWalletState = {
    ...walletState(WALLET_A),
    signMessage: async (message) => {
      signedMessage = new TextDecoder().decode(message);
      return new Uint8Array(64).fill(9);
    },
  };
  const { result } = renderHook(() => useSolanaAuthWithRuntime(wallet, harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionResolution, 'settled'));
  const baselineAuthAuthentications = harness.anonymousUidCounter;
  await act(async () => result.current.signIn());
  assert.equal(staffChallengeCalls, 1);
  assert.equal(staffSessionCalls, 1);
  assert.equal(signedMessage, 'server staff challenge');
  assert.equal(harness.authenticateCalls, 0);
  assert.equal(harness.anonymousUidCounter, baselineAuthAuthentications);
  assert.equal(result.current.sessionWallet, WALLET_A);
  assert.equal(result.current.authenticated, true);
  assert.equal(result.current.authSubject, WALLET_A);
});

test('wallet switching during staff exchange cannot install the stale credential', async () => {
  const harness = new RuntimeHarness();
  harness.nextState = emptyState();
  harness.runtime.isStaffWallet = (wallet) => wallet === WALLET_A;
  harness.runtime.hasStaffSession = (wallet) => harness.staffSession?.wallet === wallet;
  harness.runtime.createStaffChallenge = async () => ({
    challengeId: 'challenge',
    message: 'server staff challenge',
    expiresAt: 10_000,
  });
  const exchange = deferred<StaffWalletSession>();
  harness.runtime.authenticateStaffWallet = async () => exchange.promise;
  const { result, rerender } = renderHook(
    ({ wallet }: { wallet: string | null }) => useSolanaAuthWithRuntime(walletState(wallet), harness.runtime),
    { initialProps: { wallet: WALLET_A as string | null } },
  );
  await waitFor(() => assert.equal(result.current.sessionResolution, 'settled'));
  let signIn!: Promise<{ wallet: string }>;
  await act(async () => {
    signIn = result.current.signIn();
    await Promise.resolve();
  });
  rerender({ wallet: WALLET_B });
  const rejected = assert.rejects(signIn, /Wallet changed during sign-in/);
  await act(async () => exchange.resolve({
    wallet: WALLET_A,
    token: 'stale-staff-token',
    refreshedAt: 1_000,
    expiresAt: 100_000,
  }));
  await rejected;
  assert.equal(harness.staffSession, null);
  assert.notEqual(result.current.authSubject, WALLET_A);
});

test('same-wallet cross-tab replacement wins over an in-flight staff exchange', async () => {
  const harness = new RuntimeHarness();
  harness.nextState = emptyState();
  harness.runtime.isStaffWallet = (wallet) => wallet === WALLET_A;
  harness.runtime.hasStaffSession = (wallet) => harness.staffSession?.wallet === wallet;
  harness.runtime.createStaffChallenge = async () => ({
    challengeId: 'challenge',
    message: 'server staff challenge',
    expiresAt: 10_000,
  });
  const exchange = deferred<StaffWalletSession>();
  harness.runtime.authenticateStaffWallet = async () => exchange.promise;
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionResolution, 'settled'));
  let signIn!: Promise<{ wallet: string }>;
  await act(async () => {
    signIn = result.current.signIn();
    await Promise.resolve();
  });
  const replacement: StaffWalletSession = {
    wallet: WALLET_A,
    token: 'replacement-staff-token',
    refreshedAt: 1_001,
    expiresAt: 100_001,
  };
  await act(async () => {
    harness.staffSession = replacement;
    harness.emitAuthSubject(WALLET_A);
  });
  await act(async () => exchange.resolve({
    wallet: WALLET_A,
    token: 'stale-staff-token',
    refreshedAt: 1_000,
    expiresAt: 100_000,
  }));
  assert.deepEqual(await signIn, { wallet: WALLET_A });
  assert.deepEqual(harness.staffSession, replacement);
});

test('terminal unauthenticated refreshes clear state and reset Auth auth', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
  harness.loadImpl = async () => {
    throw Object.assign(new Error('authentication expired'), { code: 'unauthenticated' });
  };
  harness.signOutImpl = async () => {
    harness.loadImpl = async () => emptyState();
    harness.emitAuthSubject(null);
  };
  await act(async () => assert.rejects(result.current.refreshProfileState(), /authentication expired/));
  assert.equal(harness.signOutCalls, 1);
  assert.equal(result.current.sessionWallet, null);
});

test('partial reads do not turn successful reconciliation into a failed mutation', async () => {
  const harness = new RuntimeHarness();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(null), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
  await waitFor(() => assert.equal(harness.reconcileCalls, 1));
  harness.nextState = {
    responseMode: 'profile-state',
    sessionWallet: WALLET_A,
    profile: { status: 'error', error: { code: 'unavailable', message: 'profile unavailable' } },
    shipments: { status: 'ready', value: [shipment(6)] },
  };
  const baseline = harness.reconcileCalls;
  await act(async () => {
    assert.deepEqual(await result.current.reconcileProfile(), { mergedStripeDeliveryOrders: 0 });
  });
  assert.equal(harness.reconcileCalls, baseline + 1);
  assert.deepEqual(result.current.shipments, [shipment(6)]);
});

test('same-wallet connectivity changes restart an invalidated initial reconciliation', async () => {
  const harness = new RuntimeHarness();
  const first = deferred<ReconcileProfileStateResponse>();
  let calls = 0;
  harness.reconcileImpl = () => {
    calls += 1;
    return calls === 1
      ? first.promise
      : Promise.resolve({ mergedStripeDeliveryOrders: 0, deliveryRecovery: { nextCheckAt: 5_000 } });
  };
  const { result, rerender } = renderHook(
    ({ wallet }: { wallet: string | null }) => useSolanaAuthWithRuntime(walletState(wallet), harness.runtime),
    { initialProps: { wallet: null as string | null } },
  );
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
  await waitFor(() => assert.equal(calls, 1));
  rerender({ wallet: WALLET_A });
  await waitFor(() => assert.equal(calls, 2));
  await act(async () => first.resolve({ mergedStripeDeliveryOrders: 0, deliveryRecovery: { nextCheckAt: 1_000 } }));
  await waitFor(() => assert.equal(result.current.deliveryRecoveryNextCheckAt, 5_000));
});
