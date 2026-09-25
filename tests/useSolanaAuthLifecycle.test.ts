import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';
import { useLayoutEffect } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { DeliveryOrderSummary, GetProfileStateResponse, ReconcileProfileStateResponse } from '../src/types.ts';
import {
  useSolanaAuthWithRuntime,
  type SolanaAuthRuntime,
  type SolanaAuthWalletState,
} from '../src/hooks/useSolanaAuth.ts';
import { walletSessionSignInReadiness } from '../src/lib/profileClientLifecycle.ts';
import {
  ensureStaffWalletSession,
  installStaffWalletSessionIfUnchanged,
  readStaffWalletSession,
  saveStaffWalletSession,
  staffWalletSessionTestHooks,
  subscribeStaffWalletSession,
  type StaffWalletSession,
} from '../src/lib/staffWalletSession.ts';
import { useShopSignIn } from '../src/shop/account/useShopSignIn.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mons.shop' });
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
  authSubjectListeners = new Set<(uid: string | null, reason?: 'credential-expired') => void>();
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

  emitAuthSubject(uid: string | null, reason?: 'credential-expired') {
    this.uid = uid;
    this.authSubjectListeners.forEach((listener) => listener(uid, reason));
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
    harness.nextState = readyState(WALLET_A);
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

test('an action joins restoration without waiting for queued profile refreshes', async () => {
  const harness = new RuntimeHarness();
  const initial = deferred<GetProfileStateResponse>();
  const followUp = deferred<GetProfileStateResponse>();
  harness.reconcileImpl = () => new Promise(() => {});
  harness.loadImpl = () => harness.loadCalls === 1 ? initial.promise : followUp.promise;
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await waitFor(() => assert.equal(harness.loadCalls, 1));
  let gate!: ReturnType<typeof result.current.awaitWalletSessionRestoration>;
  let refresh!: Promise<boolean>;
  act(() => {
    gate = result.current.awaitWalletSessionRestoration(WALLET_A);
    refresh = result.current.refreshProfileState();
  });
  await act(async () => {
    initial.resolve(readyState(WALLET_A));
    assert.equal(await gate, 'restored');
  });
  assert.equal(harness.loadCalls, 2);
  assert.equal(harness.authenticateCalls, 0);
  await act(async () => {
    followUp.resolve(readyState(WALLET_A));
    await refresh;
  });
});

test('an action accepts a restored wallet when profile sections are unavailable', async () => {
  const harness = new RuntimeHarness();
  const initial = deferred<GetProfileStateResponse>();
  harness.reconcileImpl = () => new Promise(() => {});
  harness.loadImpl = () => initial.promise;
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  let gate!: ReturnType<typeof result.current.awaitWalletSessionRestoration>;
  act(() => { gate = result.current.awaitWalletSessionRestoration(WALLET_A); });
  await act(async () => {
    initial.resolve({
      responseMode: 'profile-state',
      sessionWallet: WALLET_A,
      profile: { status: 'error', error: { code: 'unavailable', message: 'profile unavailable' } },
      shipments: { status: 'error', error: { code: 'unavailable', message: 'shipments unavailable' } },
    });
    assert.equal(await gate, 'restored');
  });
  assert.equal(result.current.hasAuthenticatedWalletSession(WALLET_A), true);
  assert.equal(harness.authenticateCalls, 0);
});

test('failed restoration permits sign-in without displaying its internal error', async () => {
  const harness = new RuntimeHarness();
  const initial = deferred<GetProfileStateResponse>();
  harness.loadImpl = () => initial.promise;
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  let gate!: ReturnType<typeof result.current.awaitWalletSessionRestoration>;
  act(() => { gate = result.current.awaitWalletSessionRestoration(WALLET_A); });
  await act(async () => {
    initial.reject(Object.assign(new Error('internal restoration error'), { code: 'unavailable' }));
    assert.equal(await gate, 'sign-in-required');
  });
  assert.equal(result.current.error, null);
  assert.equal(result.current.sessionResolution, 'resolving');
  assert.deepEqual(harness.timerDelays(), [400]);
  harness.loadImpl = async () => harness.nextState;
  await act(async () => result.current.signIn());
  assert.equal(result.current.hasAuthenticatedWalletSession(WALLET_A), true);
});

test('a settled missing session permits sign-in without an extra restore request', async () => {
  const harness = new RuntimeHarness();
  harness.nextState = emptyState();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionResolution, 'settled'));
  const loadCalls = harness.loadCalls;
  assert.equal(await result.current.awaitWalletSessionRestoration(WALLET_A), 'sign-in-required');
  assert.equal(harness.loadCalls, loadCalls);
});

test('anonymous identity bootstrap does not cancel an action waiting for restoration', async () => {
  const harness = new RuntimeHarness();
  harness.uid = null;
  harness.nextState = emptyState();
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  let gate!: ReturnType<typeof result.current.awaitWalletSessionRestoration>;
  act(() => { gate = result.current.awaitWalletSessionRestoration(WALLET_A); });
  await act(async () => { assert.equal(await gate, 'sign-in-required'); });
  assert.match(result.current.authSubject || '', /^auth-anonymous-/);
});

test('an expired session resets and signs in within the same action', async () => {
  const harness = new RuntimeHarness();
  const initial = deferred<GetProfileStateResponse>();
  harness.reconcileImpl = () => new Promise(() => {});
  harness.loadImpl = () => initial.promise;
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await waitFor(() => assert.equal(harness.loadCalls, 1));
  let action!: Promise<{ wallet: string }>;
  act(() => {
    action = result.current.awaitWalletSessionRestoration(WALLET_A).then((outcome) => {
      assert.equal(outcome, 'sign-in-required');
      return result.current.signIn();
    });
  });
  await act(async () => {
    harness.loadImpl = async () => harness.nextState;
    initial.reject(Object.assign(new Error('expired session'), { code: 'unauthenticated' }));
    assert.deepEqual(await action, { wallet: WALLET_A });
  });
  assert.equal(harness.signOutCalls, 1);
  assert.equal(harness.authenticateCalls, 1);
  assert.equal(result.current.hasAuthenticatedWalletSession(WALLET_A), true);
});

test('local staff credential expiry during bootstrap permits a fresh staff sign-in', async (t) => {
  for (const expiry of ['http-401', 'timestamp'] as const) {
    await t.test(expiry, async () => {
      const harness = new RuntimeHarness();
      const staffWallet = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
      const token = `mons_staff_v1.123e4567-e89b-42d3-a456-426614174000.${'A'.repeat(43)}`;
      const originalNow = Date.now;
      const now = Date.now();
      const storedSession = { wallet: staffWallet, token, refreshedAt: now - 86_400_001, expiresAt: now + 100_000 };
      await saveStaffWalletSession(storedSession);
      harness.uid = staffWallet;
      harness.nextState = emptyState();
      harness.reconcileImpl = () => new Promise(() => {});
      harness.runtime.isStaffWallet = (wallet) => wallet === staffWallet;
      harness.runtime.hasStaffSession = (wallet) => readStaffWalletSession()?.wallet === wallet;
      harness.runtime.currentStaffSession = readStaffWalletSession;
      harness.runtime.installStaffSession = installStaffWalletSessionIfUnchanged;
      const bootstrap = deferred<void>();
      const originalFetch = globalThis.fetch;
      let refreshCalls = 0;
      globalThis.fetch = async () => {
        refreshCalls += 1;
        return Response.json({ error: { message: 'Staff authentication is required.' } }, { status: 401 });
      };
      const unsubscribe = subscribeStaffWalletSession((wallet, reason) => harness.emitAuthSubject(wallet, reason));
      const ensureAuthenticated = harness.runtime.ensureAuthenticated;
      harness.runtime.ensureAuthenticated = async () => {
        await bootstrap.promise;
        const staffSession = await ensureStaffWalletSession();
        return staffSession?.wallet || ensureAuthenticated();
      };
      let challengeCalls = 0;
      harness.runtime.createStaffChallenge = async () => {
        challengeCalls += 1;
        return { challengeId: 'challenge', message: 'fresh staff challenge', expiresAt: 10_000 };
      };
      harness.runtime.authenticateStaffWallet = async () => {
        harness.nextState = readyState(staffWallet);
        return { ...storedSession, refreshedAt: Date.now(), expiresAt: Date.now() + 100_000 };
      };
      try {
        const { result, unmount } = renderHook(() => useSolanaAuthWithRuntime(walletState(staffWallet), harness.runtime));
        const originalSignal = result.current.intentCancellationSignal;
        let gate!: ReturnType<typeof result.current.awaitWalletSessionRestoration>;
        act(() => { gate = result.current.awaitWalletSessionRestoration(staffWallet); });
        await act(async () => {
          if (expiry === 'timestamp') Date.now = () => storedSession.expiresAt;
          bootstrap.resolve();
          assert.equal(await gate, 'sign-in-required');
        });
        assert.equal(originalSignal.aborted, false);
        assert.equal(refreshCalls, expiry === 'timestamp' ? 0 : 1);
        await act(async () => result.current.signIn());
        assert.equal(challengeCalls, 1);
        assert.equal(result.current.hasAuthenticatedWalletSession(staffWallet), true);
        assert.equal(originalSignal.aborted, false);
        unmount();
      } finally {
        unsubscribe();
        globalThis.fetch = originalFetch;
        Date.now = originalNow;
        dom.window.localStorage.removeItem(staffWalletSessionTestHooks.storageKey);
      }
    });
  }
});

test('shop actions continue through wallet selection and real auth restoration', async (t) => {
  for (const outcome of ['restored', 'signed-out', 'expired', 'failed'] as const) {
    await t.test(outcome, async () => {
      const harness = new RuntimeHarness();
      harness.nextState = emptyState();
      harness.reconcileImpl = () => new Promise(() => {});
      const initial = deferred<GetProfileStateResponse>();
      const signature = deferred<Uint8Array>();
      let signatureCalls = 0;
      const messages: string[] = [];
      const { result, rerender, unmount } = renderHook(
        ({ wallet, modalVisible }: { wallet: string | null; modalVisible: boolean }) => {
          const auth = useSolanaAuthWithRuntime({
            ...walletState(wallet),
            signMessage: () => { signatureCalls += 1; return signature.promise; },
          }, harness.runtime);
          const shopSignIn = useShopSignIn({
            auth,
            connectedWallet: wallet || undefined,
            publicKey: wallet ? new PublicKey(wallet) : null,
            wallet: { connecting: false, disconnecting: false },
            walletModalVisible: modalVisible,
            setVisible: () => undefined,
            isSignedInWallet: Boolean(wallet && auth.sessionWallet === wallet && auth.authenticated),
            hasAuthenticatedAccount: Boolean(auth.sessionWallet && auth.authenticated),
            showToast: (message) => { messages.push(message); },
            isUserRejectedError: () => false,
          });
          return { auth, shopSignIn };
        },
        { initialProps: { wallet: null as string | null, modalVisible: true } },
      );
      await waitFor(() => assert.equal(result.current.auth.sessionResolution, 'settled'));
      const intentSignal = result.current.auth.intentCancellationSignal;
      let action!: Promise<boolean>;
      act(() => { action = result.current.shopSignIn.ensureSignedIn(); });
      harness.loadImpl = () => initial.promise;
      rerender({ wallet: WALLET_A, modalVisible: false });
      await waitFor(() => assert.equal(harness.loadCalls, 2));
      await act(async () => {
        harness.loadImpl = async () => harness.nextState;
        if (outcome === 'expired' || outcome === 'failed') {
          initial.reject(Object.assign(new Error('internal restoration failure'), {
            code: outcome === 'expired' ? 'unauthenticated' : 'unavailable',
          }));
        } else {
          initial.resolve(outcome === 'restored' ? readyState(WALLET_A) : emptyState());
        }
      });
      if (outcome !== 'restored') {
        await waitFor(() => assert.equal(signatureCalls, 1));
        await act(async () => { signature.resolve(new Uint8Array(64)); });
      }
      assert.equal(await action, true);
      assert.equal(signatureCalls, outcome === 'restored' ? 0 : 1);
      assert.equal(result.current.auth.hasAuthenticatedWalletSession(WALLET_A), true);
      assert.equal(intentSignal.aborted, false);
      assert.deepEqual(messages, []);
      unmount();
    });
  }
});

test('an action waits for mismatched-session logout before permitting sign-in', async () => {
  const harness = new RuntimeHarness();
  const logout = deferred<void>();
  harness.signOutImpl = async () => {
    await logout.promise;
    harness.nextState = emptyState();
    harness.emitAuthSubject(null);
  };
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_B), harness.runtime));
  await waitFor(() => assert.equal(harness.signOutCalls, 1));
  let finished = false;
  let gate!: ReturnType<typeof result.current.awaitWalletSessionRestoration>;
  act(() => {
    gate = result.current.awaitWalletSessionRestoration(WALLET_B).then((value) => {
      finished = true;
      return value;
    });
  });
  await act(async () => Promise.resolve());
  assert.equal(finished, false);
  await act(async () => {
    logout.resolve();
    assert.equal(await gate, 'sign-in-required');
  });
  assert.equal(harness.signOutCalls, 1);
});

test('a new action waits for an explicit logout already in progress', async () => {
  const harness = new RuntimeHarness();
  harness.reconcileImpl = () => new Promise(() => {});
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionWallet, WALLET_A));
  const logout = deferred<void>();
  harness.signOutImpl = async () => {
    await logout.promise;
    harness.nextState = emptyState();
    harness.emitAuthSubject(null);
  };
  let signOut!: Promise<void>;
  act(() => { signOut = result.current.signOut(); });
  const newIntent = result.current.intentCancellationSignal;
  let finished = false;
  let gate!: ReturnType<typeof result.current.awaitWalletSessionRestoration>;
  act(() => {
    gate = result.current.awaitWalletSessionRestoration(WALLET_A).then((value) => {
      finished = true;
      return value;
    });
  });
  await act(async () => Promise.resolve());
  assert.equal(finished, false);
  assert.equal(harness.authenticateCalls, 0);
  await act(async () => {
    logout.resolve();
    await signOut;
    assert.equal(await gate, 'sign-in-required');
  });
  assert.equal(newIntent.aborted, false);
  assert.equal(harness.signOutCalls, 1);
});

test('failed mismatched-session cleanup rejects the action gate', async () => {
  const harness = new RuntimeHarness();
  const logout = deferred<void>();
  harness.signOutImpl = () => logout.promise;
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_B), harness.runtime));
  await waitFor(() => assert.equal(harness.signOutCalls, 1));
  let gate!: ReturnType<typeof result.current.awaitWalletSessionRestoration>;
  act(() => { gate = result.current.awaitWalletSessionRestoration(WALLET_B); });
  const rejected = assert.rejects(gate, /Unable to sign in/);
  await act(async () => {
    logout.reject(new Error('logout failed'));
    await rejected;
  });
  assert.equal(result.current.error, null);
  assert.equal(harness.authenticateCalls, 0);
});

test('a timed-out restoration cannot overwrite a subsequently signed-in session', async () => {
  const harness = new RuntimeHarness();
  const initial = deferred<GetProfileStateResponse>();
  harness.reconcileImpl = () => new Promise(() => {});
  harness.loadImpl = () => initial.promise;
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await waitFor(() => assert.equal(harness.loadCalls, 1));
  let gate!: ReturnType<typeof result.current.awaitWalletSessionRestoration>;
  act(() => { gate = result.current.awaitWalletSessionRestoration(WALLET_A); });
  await act(async () => {
    harness.advance(20_000);
    assert.equal(await gate, 'sign-in-required');
  });
  harness.loadImpl = async () => harness.nextState;
  await act(async () => result.current.signIn());
  await act(async () => initial.resolve(emptyState()));
  assert.equal(result.current.hasAuthenticatedWalletSession(WALLET_A), true);
  assert.equal(result.current.sessionWallet, WALLET_A);
});

test('a profile read started during signing cannot overwrite the newly authenticated session', async () => {
  const harness = new RuntimeHarness();
  harness.nextState = emptyState();
  harness.reconcileImpl = () => new Promise(() => {});
  const signature = deferred<Uint8Array>();
  let signatureCalls = 0;
  const { result } = renderHook(() => useSolanaAuthWithRuntime({
    ...walletState(WALLET_A),
    signMessage: () => { signatureCalls += 1; return signature.promise; },
  }, harness.runtime));
  await waitFor(() => assert.equal(result.current.sessionResolution, 'settled'));
  let signedIn = false;
  let signIn!: Promise<{ wallet: string }>;
  act(() => { signIn = result.current.signIn().then((value) => { signedIn = true; return value; }); });
  await waitFor(() => assert.equal(signatureCalls, 1));
  const stale = deferred<GetProfileStateResponse>();
  harness.loadImpl = () => stale.promise;
  const previousLoadCalls = harness.loadCalls;
  await act(async () => harness.emitRefresh());
  await waitFor(() => assert.equal(harness.loadCalls, previousLoadCalls + 1));
  harness.loadImpl = async () => harness.nextState;
  await act(async () => signature.resolve(new Uint8Array(64)));
  await waitFor(() => assert.equal(signedIn, true));
  assert.deepEqual(await signIn, { wallet: WALLET_A });
  await act(async () => stale.resolve(emptyState()));
  assert.equal(result.current.hasAuthenticatedWalletSession(WALLET_A), true);
});

test('action restoration waits cancel promptly when their context ends', async (t) => {
  for (const reason of ['abort', 'wallet-switch', 'disconnect', 'sign-out', 'unmount'] as const) {
    await t.test(reason, async () => {
      const harness = new RuntimeHarness();
      const initial = deferred<GetProfileStateResponse>();
      const controller = new AbortController();
      harness.loadImpl = () => initial.promise;
      const { result, rerender, unmount } = renderHook(
        ({ wallet }: { wallet: string | null }) => useSolanaAuthWithRuntime(walletState(wallet), harness.runtime),
        { initialProps: { wallet: WALLET_A as string | null } },
      );
      let gate!: ReturnType<typeof result.current.awaitWalletSessionRestoration>;
      act(() => { gate = result.current.awaitWalletSessionRestoration(WALLET_A, controller.signal); });
      await act(async () => {
        if (reason === 'abort') controller.abort();
        if (reason === 'wallet-switch') rerender({ wallet: WALLET_B });
        if (reason === 'disconnect') rerender({ wallet: null });
        if (reason === 'sign-out') await result.current.signOut();
        if (reason === 'unmount') unmount();
      });
      assert.equal(await gate, 'cancelled');
      assert.equal(harness.authenticateCalls, 0);
      await act(async () => initial.resolve(emptyState()));
      unmount();
    });
  }
});

test('external same-wallet auth replacement cancels the original intent and restoration wait', async () => {
  const harness = new RuntimeHarness();
  const initial = deferred<GetProfileStateResponse>();
  harness.loadImpl = () => initial.promise;
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  await waitFor(() => assert.equal(harness.loadCalls, 1));
  const originalSignal = result.current.intentCancellationSignal;
  let gate!: ReturnType<typeof result.current.awaitWalletSessionRestoration>;
  act(() => { gate = result.current.awaitWalletSessionRestoration(WALLET_A); });
  await act(async () => harness.emitAuthSubject('auth-replacement'));
  assert.equal(await gate, 'cancelled');
  assert.equal(originalSignal.aborted, true);
  assert.notEqual(result.current.intentCancellationSignal, originalSignal);
  assert.equal(result.current.intentCancellationSignal.aborted, false);
  await act(async () => initial.resolve(emptyState()));
});

test('external logout cancels an action even while auth bootstrap is in flight', async () => {
  const harness = new RuntimeHarness();
  const bootstrap = deferred<string>();
  harness.runtime.ensureAuthenticated = () => bootstrap.promise;
  const { result } = renderHook(() => useSolanaAuthWithRuntime(walletState(WALLET_A), harness.runtime));
  const originalSignal = result.current.intentCancellationSignal;
  let gate!: ReturnType<typeof result.current.awaitWalletSessionRestoration>;
  act(() => { gate = result.current.awaitWalletSessionRestoration(WALLET_A); });
  await act(async () => harness.emitAuthSubject(null));
  assert.equal(await gate, 'cancelled');
  assert.equal(originalSignal.aborted, true);
  assert.equal(result.current.intentCancellationSignal.aborted, false);
  assert.equal(harness.authenticateCalls, 0);
  await act(async () => bootstrap.resolve('auth-a'));
  assert.equal(harness.loadCalls, 0);
});

test('sign-in rejects if its final profile refresh outlives the connected wallet', async () => {
  const harness = new RuntimeHarness();
  harness.nextState = emptyState();
  harness.reconcileImpl = () => new Promise(() => {});
  const { result, rerender } = renderHook(
    ({ wallet }: { wallet: string | null }) => useSolanaAuthWithRuntime(walletState(wallet), harness.runtime),
    { initialProps: { wallet: WALLET_A as string | null } },
  );
  await waitFor(() => assert.equal(result.current.sessionResolution, 'settled'));
  const finalRefresh = deferred<GetProfileStateResponse>();
  harness.loadImpl = () => finalRefresh.promise;
  let signIn!: Promise<{ wallet: string }>;
  act(() => { signIn = result.current.signIn(); });
  const rejected = assert.rejects(signIn, /changed during sign-in/);
  await waitFor(() => assert.equal(harness.authenticateCalls, 1));
  rerender({ wallet: null });
  await act(async () => {
    finalRefresh.resolve(readyState(WALLET_A));
    await rejected;
  });
});
