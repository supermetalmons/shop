import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from '../lib/firebase';
import {
  ensureAuthenticated,
  loadProfileStateFromServer,
  reconcileProfileState,
  solanaAuth,
  type ReconcileProfileStateRequest,
  type ReconcileProfileStateResponse,
} from '../lib/api';
import { isRetryableCallableError, retryWithBackoff } from '../lib/callableErrors';
import type { DeliveryOrderSummary, GetProfileStateResponse, Profile } from '../types';
import { buildSignInMessage } from '../lib/solana';
import { normalizeCallableErrorCode } from '../../functions/src/shared/callableErrorCode';
import { deliveryOrderSummarySortAt } from '../../functions/src/shared/deliveryOrderSummary.js';
import {
  deliveryOrderSummariesEqual,
  firebaseAuthChangeInvalidatesSession,
} from '../lib/profileState';

export type SolanaAuthState = {
  profile: Profile | null;
  shipments: DeliveryOrderSummary[];
  sessionWallet: string | null;
  token: string | null;
  loading: boolean;
  profileReady: boolean;
  shipmentsReady: boolean;
  profileError: string | null;
  shipmentsError: string | null;
  deliveryRecoveryNextCheckAt: number | null;
};

export type SessionResolution = 'disabled' | 'resolving' | 'settled';

export type SolanaAuthWalletState = {
  connected: boolean;
  publicKey: { toBase58: () => string } | null;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
};

export type SolanaAuthRuntime = {
  currentUid: () => string | null;
  subscribeAuthUser: (listener: (uid: string | null) => void) => () => void;
  ensureAuthenticated: () => Promise<string>;
  getIdToken: () => Promise<string | null>;
  loadProfileState: () => Promise<GetProfileStateResponse>;
  reconcileProfileState: (options?: ReconcileProfileStateRequest) => Promise<ReconcileProfileStateResponse>;
  authenticateWallet: (wallet: string, message: string, signature: Uint8Array) => Promise<{ wallet: string }>;
  signOut: () => Promise<void>;
  subscribeRefreshEvents: (listener: () => void) => () => void;
  isPageVisible: () => boolean;
  now: () => number;
  setTimer: (callback: () => void, delay: number) => unknown;
  clearTimer: (timer: unknown) => void;
};

type SignInResult = {
  wallet: string;
  token: string;
};

type SignInAttempt = {
  wallet: string;
  contextGeneration: number;
  uid: string | null;
  promise: Promise<SignInResult>;
};

type RefreshRun = {
  contextGeneration: number;
  queued: boolean;
  promise: Promise<boolean>;
};

const authenticateWalletTails = new Map<string, Promise<void>>();

function authenticateWalletInOrder<T>(uid: string, operation: () => Promise<T>): Promise<T> {
  const previous = authenticateWalletTails.get(uid) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  authenticateWalletTails.set(uid, tail);
  void tail.then(() => {
    if (authenticateWalletTails.get(uid) === tail) authenticateWalletTails.delete(uid);
  });
  return result;
}

const EMPTY_AUTH_STATE: SolanaAuthState = {
  profile: null,
  shipments: [],
  sessionWallet: null,
  token: null,
  loading: false,
  profileReady: false,
  shipmentsReady: false,
  profileError: null,
  shipmentsError: null,
  deliveryRecoveryNextCheckAt: null,
};

function subscribeBrowserRefreshEvents(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const onVisible = () => {
    if (document.visibilityState !== 'hidden') listener();
  };
  window.addEventListener('focus', onVisible);
  window.addEventListener('online', onVisible);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.removeEventListener('focus', onVisible);
    window.removeEventListener('online', onVisible);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

const DEFAULT_RUNTIME: SolanaAuthRuntime = {
  currentUid: () => auth?.currentUser?.uid || null,
  subscribeAuthUser: (listener) => {
    if (!auth) return () => {};
    return onAuthStateChanged(auth, (user) => listener(user?.uid || null));
  },
  ensureAuthenticated,
  getIdToken: async () => (await auth?.currentUser?.getIdToken()) || null,
  loadProfileState: loadProfileStateFromServer,
  reconcileProfileState,
  authenticateWallet: (wallet, message, signature) =>
    solanaAuth(wallet, message, signature, { responseMode: 'session' }),
  signOut: async () => {
    if (auth) await firebaseSignOut(auth);
  },
  subscribeRefreshEvents: subscribeBrowserRefreshEvents,
  isPageVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  now: () => Date.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function errorCode(error: unknown): string {
  return normalizeCallableErrorCode(
    typeof error === 'object' && error ? (error as { code?: unknown }).code : undefined,
  );
}

function isInvalidSignatureError(error: unknown): boolean {
  const value = error as { message?: unknown; details?: unknown } | null;
  if (typeof value?.message === 'string' && /invalid signature/i.test(value.message)) return true;
  return typeof value?.details === 'string' && /invalid signature/i.test(value.details);
}

function normalizedRecoveryNextCheckAt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function retryDelay(delays: readonly [number, ...number[]], retryCount: number): number {
  return delays[Math.min(retryCount, delays.length - 1)];
}

function shipmentsInDisplayOrder(shipments: DeliveryOrderSummary[]): DeliveryOrderSummary[] {
  return [...shipments].sort((left, right) => {
    const leftAt = deliveryOrderSummarySortAt(left);
    const rightAt = deliveryOrderSummarySortAt(right);
    if (leftAt !== rightAt) return rightAt - leftAt;
    if (left.dropId !== right.dropId) return left.dropId < right.dropId ? -1 : 1;
    return left.deliveryId - right.deliveryId;
  });
}

const PERSISTENT_RETRY_DELAYS_MS = [400, 800, 1_600, 5_000] as const;
const PROFILE_REFRESH_RETRY_DELAYS_MS = [400, 800, 1_600, 5_000, 30_000, 60_000] as const;
const PROFILE_REFRESH_INTERVAL_MS = 60_000;

export function useSolanaAuthWithRuntime(
  walletState: SolanaAuthWalletState,
  runtime: SolanaAuthRuntime,
) {
  const { publicKey, signMessage, connected } = walletState;
  const connectedWallet = connected ? publicKey?.toBase58() || null : null;
  const [state, setState] = useState<SolanaAuthState>(EMPTY_AUTH_STATE);
  const [error, setError] = useState<string | null>(null);
  const [authUserRevision, setAuthUserRevision] = useState(0);
  const [sessionResolution, setSessionResolution] = useState<SessionResolution>('disabled');
  const lastSignedRef = useRef<{
    wallet: string;
    uid: string;
    message: string;
    signature: Uint8Array;
    createdAt: number;
  } | null>(null);
  const connectedWalletRef = useRef<string | null>(connectedWallet);
  const connectedRef = useRef<boolean>(connected);
  const sessionWalletRef = useRef<string | null>(null);
  const sessionUidRef = useRef<string | null>(null);
  const firebaseUidRef = useRef<string | null>(runtime.currentUid());
  const mismatchSignOutRef = useRef<string | null>(null);
  const mismatchSignOutTimerRef = useRef<unknown>(null);
  const contextGenerationRef = useRef(0);
  const ownerGenerationRef = useRef(0);
  const deliveryRecoveryRequestGenerationRef = useRef(0);
  const deliveryRecoveryAppliedGenerationRef = useRef(0);
  const signInAttemptRef = useRef<SignInAttempt | null>(null);
  const refreshRunRef = useRef<RefreshRun | null>(null);
  const mountedRef = useRef(true);
  connectedWalletRef.current = connectedWallet;
  connectedRef.current = connected;

  const clearMismatchSignOutTimer = useCallback(() => {
    if (mismatchSignOutTimerRef.current === null) return;
    runtime.clearTimer(mismatchSignOutTimerRef.current);
    mismatchSignOutTimerRef.current = null;
  }, [runtime]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      contextGenerationRef.current += 1;
      signInAttemptRef.current = null;
      refreshRunRef.current = null;
      clearMismatchSignOutTimer();
    };
  }, [clearMismatchSignOutTimer]);

  const deactivateOwner = useCallback((loading = false) => {
    sessionWalletRef.current = null;
    sessionUidRef.current = null;
    ownerGenerationRef.current += 1;
    deliveryRecoveryRequestGenerationRef.current = 0;
    deliveryRecoveryAppliedGenerationRef.current = 0;
    setState({ ...EMPTY_AUTH_STATE, loading });
  }, []);

  const activateOwner = useCallback((wallet: string, token: string, uid: string) => {
    const previousWallet = sessionWalletRef.current;
    sessionWalletRef.current = wallet;
    sessionUidRef.current = uid;
    if (previousWallet !== wallet) {
      ownerGenerationRef.current += 1;
      deliveryRecoveryRequestGenerationRef.current = 0;
      deliveryRecoveryAppliedGenerationRef.current = 0;
      setState({ ...EMPTY_AUTH_STATE, sessionWallet: wallet, token });
      return;
    }
    setState((current) =>
      current.sessionWallet === wallet
        ? { ...current, token, loading: false }
        : { ...EMPTY_AUTH_STATE, sessionWallet: wallet, token },
    );
  }, []);

  const endMismatchedFirebaseSession = useCallback(
    (uid: string, boundWallet: string, nextWallet: string) => {
      const mismatchKey = `${uid}:${boundWallet}:${nextWallet}`;
      if (mismatchSignOutRef.current === mismatchKey) return;
      mismatchSignOutRef.current = mismatchKey;
      contextGenerationRef.current += 1;
      deactivateOwner(true);
      setError(null);
      setSessionResolution('resolving');
      clearMismatchSignOutTimer();
      let retryCount = 0;
      const attemptSignOut = () => {
        if (!mountedRef.current || mismatchSignOutRef.current !== mismatchKey) return;
        void runtime.signOut().catch((signOutError) => {
          if (!mountedRef.current || mismatchSignOutRef.current !== mismatchKey) return;
          setError(errorMessage(signOutError, 'Unable to end the previous wallet session'));
          const delay = retryDelay(PERSISTENT_RETRY_DELAYS_MS, retryCount);
          retryCount += 1;
          clearMismatchSignOutTimer();
          mismatchSignOutTimerRef.current = runtime.setTimer(() => {
            mismatchSignOutTimerRef.current = null;
            attemptSignOut();
          }, delay);
        });
      };
      attemptSignOut();
    },
    [clearMismatchSignOutTimer, deactivateOwner, runtime],
  );

  const applyProfileState = useCallback((response: GetProfileStateResponse, token: string, uid: string) => {
    const wallet = response.sessionWallet;
    if (!wallet) {
      deactivateOwner(false);
      setError(null);
      setSessionResolution('settled');
      return true;
    }
    const activeConnectedWallet = connectedWalletRef.current;
    if (activeConnectedWallet && wallet !== activeConnectedWallet) {
      endMismatchedFirebaseSession(uid, wallet, activeConnectedWallet);
      return true;
    }
    const previousWallet = sessionWalletRef.current;
    sessionWalletRef.current = wallet;
    sessionUidRef.current = uid;
    if (previousWallet !== wallet) {
      ownerGenerationRef.current += 1;
      deliveryRecoveryRequestGenerationRef.current = 0;
      deliveryRecoveryAppliedGenerationRef.current = 0;
    }
    const profileError = response.profile?.status === 'error' ? response.profile.error : null;
    const shipmentsError = response.shipments?.status === 'error' ? response.shipments.error : null;
    setState((current) => {
      const base = current.sessionWallet === wallet
        ? current
        : { ...EMPTY_AUTH_STATE, sessionWallet: wallet, token };
      const nextShipments = response.shipments?.status === 'ready'
        ? shipmentsInDisplayOrder(response.shipments.value)
        : base.shipments;
      const next: SolanaAuthState = {
        ...base,
        sessionWallet: wallet,
        token,
        loading: false,
        profile: response.profile?.status === 'ready' ? response.profile.value : base.profile,
        profileReady: response.profile?.status === 'ready' ? true : base.profileReady,
        profileError: response.profile?.status === 'ready' ? null : profileError?.message || base.profileError,
        shipments: nextShipments,
        shipmentsReady: response.shipments?.status === 'ready' ? true : base.shipmentsReady,
        shipmentsError: response.shipments?.status === 'ready' ? null : shipmentsError?.message || base.shipmentsError,
      };
      if (
        current.sessionWallet === next.sessionWallet &&
        current.token === next.token &&
        current.loading === next.loading &&
        current.profile === next.profile &&
        current.profileReady === next.profileReady &&
        current.profileError === next.profileError &&
        current.shipmentsReady === next.shipmentsReady &&
        current.shipmentsError === next.shipmentsError &&
        deliveryOrderSummariesEqual(current.shipments, next.shipments)
      ) return current;
      return next;
    });
    setError(null);
    setSessionResolution('settled');
    return !profileError && !shipmentsError;
  }, [deactivateOwner, endMismatchedFirebaseSession]);

  const refreshProfileState = useCallback((): Promise<boolean> => {
    const requestedGeneration = contextGenerationRef.current;
    const existing = refreshRunRef.current;
    if (existing && existing.contextGeneration === requestedGeneration) {
      existing.queued = true;
      return existing.promise;
    }
    const run: RefreshRun = {
      contextGeneration: requestedGeneration,
      queued: false,
      promise: Promise.resolve(true),
    };
    const isCurrent = () => mountedRef.current && contextGenerationRef.current === run.contextGeneration;
    const execute = async (): Promise<boolean> => {
      try {
        const uid = await runtime.ensureAuthenticated();
        if (!isCurrent() || runtime.currentUid() !== uid) return true;
        const response = await runtime.loadProfileState();
        const token = await runtime.getIdToken();
        if (!isCurrent() || runtime.currentUid() !== uid || !token) return true;
        return applyProfileState(response, token, uid);
      } catch (refreshError) {
        if (!isCurrent()) return true;
        if (errorCode(refreshError) === 'unauthenticated') {
          contextGenerationRef.current += 1;
          deactivateOwner(true);
          setError(null);
          setSessionResolution('resolving');
          try {
            await runtime.signOut();
          } catch (signOutError) {
            setError(errorMessage(signOutError, 'Unable to reset authentication'));
          }
          throw refreshError;
        }
        const message = errorMessage(refreshError, 'Unable to refresh profile');
        const hasValidatedSession = Boolean(
          sessionWalletRef.current && sessionUidRef.current === firebaseUidRef.current,
        );
        if (hasValidatedSession) {
          setState((current) => current.sessionWallet === sessionWalletRef.current
            ? { ...current, profileError: message, shipmentsError: message }
            : current);
          setSessionResolution('settled');
        } else {
          setState((current) => ({ ...current, loading: true }));
          setError(message);
          setSessionResolution('resolving');
        }
        throw refreshError;
      }
    };
    run.promise = (async () => {
      let complete = true;
      do {
        run.queued = false;
        complete = await execute();
      } while (run.queued && isCurrent());
      return complete;
    })().finally(() => {
      if (refreshRunRef.current === run) refreshRunRef.current = null;
    });
    refreshRunRef.current = run;
    return run.promise;
  }, [applyProfileState, deactivateOwner, runtime]);

  const beginDeliveryRecoveryScheduleUpdate = useCallback(() => {
    const wallet = sessionWalletRef.current;
    const uid = sessionUidRef.current;
    const ownerGeneration = ownerGenerationRef.current;
    if (!wallet || !uid) return (_nextCheckAt: number | null) => false;
    const requestGeneration = deliveryRecoveryRequestGenerationRef.current + 1;
    deliveryRecoveryRequestGenerationRef.current = requestGeneration;
    return (nextCheckAt: number | null) => {
      if (
        sessionUidRef.current !== uid ||
        firebaseUidRef.current !== uid ||
        ownerGenerationRef.current !== ownerGeneration ||
        sessionWalletRef.current !== wallet ||
        requestGeneration <= deliveryRecoveryAppliedGenerationRef.current
      ) return false;
      deliveryRecoveryAppliedGenerationRef.current = requestGeneration;
      const normalizedNextCheckAt = normalizedRecoveryNextCheckAt(nextCheckAt);
      setState((current) =>
        current.sessionWallet === wallet
          ? { ...current, deliveryRecoveryNextCheckAt: normalizedNextCheckAt }
          : current,
      );
      return true;
    };
  }, []);

  const reconcileProfile = useCallback(
    async (options?: ReconcileProfileStateRequest): Promise<ReconcileProfileStateResponse | null> => {
      const wallet = sessionWalletRef.current;
      if (!wallet) return null;
      const contextGeneration = contextGenerationRef.current;
      const ownerGeneration = ownerGenerationRef.current;
      const includesDeliveryRecovery = options?.includeDeliveryRecovery !== false;
      const commitSchedule = includesDeliveryRecovery ? beginDeliveryRecoveryScheduleUpdate() : null;
      const result = await runtime.reconcileProfileState(options);
      if (
        contextGenerationRef.current !== contextGeneration ||
        ownerGenerationRef.current !== ownerGeneration ||
        sessionWalletRef.current !== wallet
      ) return null;
      if (commitSchedule) commitSchedule(normalizedRecoveryNextCheckAt(result.deliveryRecovery?.nextCheckAt));
      await refreshProfileState().catch(() => false);
      return result;
    },
    [beginDeliveryRecoveryScheduleUpdate, refreshProfileState, runtime],
  );

  useEffect(() => runtime.subscribeAuthUser((nextUid) => {
    const previousUid = firebaseUidRef.current;
    const activeSignIn = signInAttemptRef.current;
    const invalidatesSession = firebaseAuthChangeInvalidatesSession({
      previousUid,
      nextUid,
      signInActive: Boolean(activeSignIn),
      activeSignInUid: activeSignIn?.uid ?? null,
    });
    firebaseUidRef.current = nextUid;
    if (previousUid !== nextUid) {
      clearMismatchSignOutTimer();
      mismatchSignOutRef.current = null;
    }
    if (!invalidatesSession) return;
    contextGenerationRef.current += 1;
    refreshRunRef.current = null;
    deactivateOwner(false);
    setError(null);
    setAuthUserRevision((revision) => revision + 1);
  }), [clearMismatchSignOutTimer, deactivateOwner, runtime]);

  useEffect(() => {
    const currentUid = firebaseUidRef.current;
    const activeWallet = sessionWalletRef.current;
    if (
      connectedWallet &&
      activeWallet &&
      activeWallet !== connectedWallet &&
      currentUid &&
      sessionUidRef.current === currentUid
    ) {
      endMismatchedFirebaseSession(currentUid, activeWallet, connectedWallet);
      return;
    }
    contextGenerationRef.current += 1;
    refreshRunRef.current = null;
    if (!activeWallet && connectedWallet) setState((current) => ({ ...current, loading: true }));
    const validated = Boolean(
      activeWallet && currentUid && sessionUidRef.current === currentUid && (!connectedWallet || connectedWallet === activeWallet),
    );
    setSessionResolution(validated ? 'settled' : 'resolving');
    let cancelled = false;
    let timer: unknown = null;
    let retryCount = 0;
    const clearTimer = () => {
      if (timer === null) return;
      runtime.clearTimer(timer);
      timer = null;
    };
    const schedule = (delay: number) => {
      clearTimer();
      if (cancelled || !runtime.isPageVisible()) return;
      timer = runtime.setTimer(() => {
        timer = null;
        if (!runtime.isPageVisible()) return;
        run();
      }, delay);
    };
    const run = () => {
      if (cancelled) return;
      clearTimer();
      void refreshProfileState().then(
        (complete) => {
          if (cancelled) return;
          if (complete) {
            retryCount = 0;
            schedule(PROFILE_REFRESH_INTERVAL_MS);
          } else {
            const delay = retryDelay(PROFILE_REFRESH_RETRY_DELAYS_MS, retryCount);
            retryCount += 1;
            schedule(delay);
          }
        },
        (refreshError) => {
          if (cancelled) return;
          if (isRetryableCallableError(refreshError)) {
            const delay = retryDelay(PROFILE_REFRESH_RETRY_DELAYS_MS, retryCount);
            retryCount += 1;
            schedule(delay);
          } else {
            retryCount = 0;
            schedule(PROFILE_REFRESH_INTERVAL_MS);
          }
        },
      );
    };
    const unsubscribeRefreshEvents = runtime.subscribeRefreshEvents(run);
    run();
    return () => {
      cancelled = true;
      clearTimer();
      unsubscribeRefreshEvents();
    };
  }, [authUserRevision, connectedWallet, endMismatchedFirebaseSession, refreshProfileState, runtime]);

  useEffect(() => {
    if (!state.sessionWallet) return;
    let cancelled = false;
    let retryTimer: unknown = null;
    let retryCount = 0;
    const clearRetryTimer = () => {
      if (retryTimer === null) return;
      runtime.clearTimer(retryTimer);
      retryTimer = null;
    };
    const run = () => {
      if (cancelled) return;
      clearRetryTimer();
      void reconcileProfile()
        .then(() => {
          retryCount = 0;
        })
        .catch((reconcileError) => {
          if (cancelled) return;
          if (!isRetryableCallableError(reconcileError)) {
            console.warn('[mons] failed to reconcile profile state', reconcileError);
            return;
          }
          const delay = retryDelay(PERSISTENT_RETRY_DELAYS_MS, retryCount);
          retryCount += 1;
          retryTimer = runtime.setTimer(run, delay);
        });
    };
    run();
    return () => {
      cancelled = true;
      clearRetryTimer();
    };
  }, [connectedWallet, reconcileProfile, runtime, state.sessionWallet]);

  const signIn = useCallback((): Promise<SignInResult> => {
    if (!mountedRef.current) {
      const unmountedError = new Error('Wallet changed during sign-in. Please try again.');
      (unmountedError as Error & { code?: string }).code = 'wallet-changed';
      return Promise.reject(unmountedError);
    }
    if (!publicKey) return Promise.reject(new Error('Connect a wallet first'));
    if (!signMessage) return Promise.reject(new Error('Wallet cannot sign messages'));
    const wallet = publicKey.toBase58();
    const contextGeneration = contextGenerationRef.current;
    const existingAttempt = signInAttemptRef.current;
    if (existingAttempt?.wallet === wallet && existingAttempt.contextGeneration === contextGeneration) {
      return existingAttempt.promise;
    }
    let resolveAttempt!: (result: SignInResult) => void;
    let rejectAttempt!: (error: unknown) => void;
    const promise = new Promise<SignInResult>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const attempt: SignInAttempt = { wallet, contextGeneration, uid: null, promise };
    signInAttemptRef.current = attempt;
    const attemptIsCurrent = () => signInAttemptRef.current === attempt;
    const ensureAttemptCurrent = () => {
      if (!attempt.uid || runtime.currentUid() !== attempt.uid) {
        const authChangedError = new Error('Firebase authentication changed during sign-in. Please try again.');
        (authChangedError as Error & { code?: string }).code = 'auth-user-changed';
        throw authChangedError;
      }
      const stale =
        !mountedRef.current ||
        !attemptIsCurrent() ||
        contextGenerationRef.current !== contextGeneration ||
        !connectedRef.current ||
        connectedWalletRef.current !== wallet;
      if (!stale) return;
      const walletChangedError = new Error('Wallet changed during sign-in. Please try again.');
      (walletChangedError as Error & { code?: string }).code = 'wallet-changed';
      throw walletChangedError;
    };
    setState((current) => ({ ...current, loading: true }));
    setError(null);
    void (async () => {
      try {
        const uid = await runtime.ensureAuthenticated();
        attempt.uid = uid;
        ensureAttemptCurrent();
        const reuseWindowMs = 2 * 60 * 1000;
        const cached = lastSignedRef.current;
        const now = runtime.now();
        let message: string;
        let signature: Uint8Array;
        if (cached && cached.wallet === wallet && cached.uid === uid && now - cached.createdAt <= reuseWindowMs) {
          ({ message, signature } = cached);
        } else {
          message = buildSignInMessage(wallet, uid);
          signature = await signMessage(new TextEncoder().encode(message));
          ensureAttemptCurrent();
          lastSignedRef.current = { wallet, uid, message, signature, createdAt: now };
        }
        const session = await retryWithBackoff(
          () => authenticateWalletInOrder(uid, async () => {
            ensureAttemptCurrent();
            const response = await runtime.authenticateWallet(wallet, message, signature);
            ensureAttemptCurrent();
            return response;
          }),
          {
            maxAttempts: 4,
            baseDelayMs: 400,
            maxDelayMs: 4000,
            jitterRatio: 0.2,
            shouldRetry: (retryError) => {
              ensureAttemptCurrent();
              return isRetryableCallableError(retryError);
            },
          },
        );
        if (session.wallet !== wallet) throw new Error('Wallet session response did not match the connected wallet');
        const token = await runtime.getIdToken();
        ensureAttemptCurrent();
        if (!token) throw new Error('Missing Firebase auth token');
        setError(null);
        activateOwner(wallet, token, uid);
        setSessionResolution('settled');
        await refreshProfileState().catch(() => undefined);
        resolveAttempt({ wallet, token });
      } catch (signInError) {
        console.error(signInError);
        if (attemptIsCurrent() && isInvalidSignatureError(signInError)) lastSignedRef.current = null;
        const attemptStillOwnsContext =
          mountedRef.current &&
          attemptIsCurrent() &&
          contextGenerationRef.current === contextGeneration &&
          connectedWalletRef.current === wallet;
        if (attemptStillOwnsContext) setState((current) => ({ ...current, loading: false }));
        if (attemptStillOwnsContext && errorCode(signInError) !== 'wallet-changed') {
          setError(errorMessage(signInError, 'Failed to sign in'));
        }
        rejectAttempt(signInError);
      } finally {
        if (attemptIsCurrent()) signInAttemptRef.current = null;
      }
    })();
    return promise;
  }, [activateOwner, publicKey, refreshProfileState, runtime, signMessage]);

  const signOut = useCallback(async () => {
    contextGenerationRef.current += 1;
    clearMismatchSignOutTimer();
    mismatchSignOutRef.current = null;
    refreshRunRef.current = null;
    deactivateOwner(false);
    setError(null);
    lastSignedRef.current = null;
    await runtime.signOut();
  }, [clearMismatchSignOutTimer, deactivateOwner, runtime]);

  const hasAuthenticatedWalletSession = useCallback(
    (wallet: string | null | undefined) => Boolean(
      wallet && sessionWalletRef.current === wallet && sessionUidRef.current === firebaseUidRef.current,
    ),
    [],
  );

  const stateIsVisible = Boolean(
    state.sessionWallet && (!connectedWallet || state.sessionWallet === connectedWallet),
  );
  const exposedSessionResolution =
    connectedWallet && state.sessionWallet && state.sessionWallet !== connectedWallet
      ? 'resolving'
      : sessionResolution;
  return {
    ...(stateIsVisible
      ? state
      : { ...EMPTY_AUTH_STATE, loading: Boolean(connectedWallet && state.loading) }),
    sessionResolution: exposedSessionResolution,
    error,
    signIn,
    signOut,
    reconcileProfile,
    refreshProfileState,
    beginDeliveryRecoveryScheduleUpdate,
    hasAuthenticatedWalletSession,
  };
}

export function useSolanaAuth() {
  const walletState = useWallet();
  return useSolanaAuthWithRuntime(walletState, DEFAULT_RUNTIME);
}
