import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import {
  ensureAuthenticated,
  loadProfileStateFromServer,
  reconcileProfileState,
  solanaAuth,
} from '../api/profile';
import { isRetryableApiError, retryWithBackoff } from '../lib/apiErrors';
import type {
  GetProfileStateResponse,
  ReconcileProfileStateRequest,
  ReconcileProfileStateResponse,
} from '../types';
import { buildSignInMessage } from '../lib/solana';
import { normalizeApiErrorCode } from '../../shared/apiErrorCode';
import {
  mergeProfileState,
  authSubjectChangeInvalidatesSession,
  type ProfileSnapshotState,
} from '../lib/profileState';
import { useProfileRefreshController } from './useProfileRefreshController';
import { useProfileRefreshLifecycle } from './useProfileRefreshLifecycle';
import { isStaffWalletAddress } from '../../shared/fulfillmentAccess';
import {
  createStaffWalletChallenge,
  exchangeStaffWalletChallenge,
  installStaffWalletSessionIfUnchanged,
  logoutStaffWalletSession,
  readStaffWalletSession,
  subscribeStaffWalletSession,
  type StaffWalletChallenge,
  type StaffWalletSession,
} from '../lib/staffWalletSession';
import {
  currentAnonymousSubject,
  logoutAnonymousSession,
  subscribeAnonymousSession,
} from '../lib/anonymousSession';

export type SolanaAuthState = ProfileSnapshotState & {
  deliveryRecoveryNextCheckAt: number | null;
};

export type SessionResolution = 'disabled' | 'resolving' | 'settled';
export type WalletSessionRestoration = 'restored' | 'sign-in-required' | 'cancelled';

export type SolanaAuthWalletState = {
  connected: boolean;
  publicKey: { toBase58: () => string } | null;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
};

export type SolanaAuthRuntime = {
  currentAuthSubject: () => string | null;
  subscribeAuthSubject: (listener: (authSubject: string | null, reason?: 'credential-expired' | 'session-renewed') => void) => () => void;
  ensureAuthenticated: () => Promise<string>;
  loadProfileState: () => Promise<GetProfileStateResponse>;
  reconcileProfileState: (options?: ReconcileProfileStateRequest) => Promise<ReconcileProfileStateResponse>;
  authenticateWallet: (wallet: string, message: string, signature: Uint8Array) => Promise<{ wallet: string }>;
  signOut: () => Promise<void>;
  subscribeRefreshEvents: (listener: () => void) => () => void;
  isPageVisible: () => boolean;
  now: () => number;
  setTimer: (callback: () => void, delay: number) => unknown;
  clearTimer: (timer: unknown) => void;
  isStaffWallet?: (wallet: string) => boolean;
  createStaffChallenge?: (wallet: string) => Promise<StaffWalletChallenge>;
  authenticateStaffWallet?: (challengeId: string, signature: Uint8Array) => Promise<StaffWalletSession>;
  currentStaffSession?: () => StaffWalletSession | null;
  installStaffSession?: (
    session: StaffWalletSession,
    expectedToken: string | null,
  ) => Promise<StaffWalletSession | null>;
  hasStaffSession?: (wallet: string) => boolean;
};

type SignInResult = {
  wallet: string;
};

type SignInAttempt = {
  wallet: string;
  contextGeneration: number;
  uid: string | null;
  promise: Promise<SignInResult>;
};

type SessionReset = {
  promise: Promise<void>;
  status: 'pending' | 'complete' | 'failed';
  error?: unknown;
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
  currentAuthSubject: () => readStaffWalletSession()?.wallet || currentAnonymousSubject(),
  subscribeAuthSubject: (listener) => {
    const emit = (reason?: 'credential-expired' | 'session-renewed') => listener(readStaffWalletSession()?.wallet || currentAnonymousSubject(), reason);
    const unsubscribeStaff = subscribeStaffWalletSession((_wallet, reason) => emit(reason));
    const unsubscribeAnonymous = subscribeAnonymousSession((_subject, reason) => emit(reason));
    return () => {
      unsubscribeStaff();
      unsubscribeAnonymous();
    };
  },
  ensureAuthenticated,
  loadProfileState: loadProfileStateFromServer,
  reconcileProfileState,
  authenticateWallet: solanaAuth,
  signOut: async () => {
    const staffSession = readStaffWalletSession();
    if (staffSession) {
      await logoutAnonymousSession().catch(() => undefined);
      await logoutStaffWalletSession(staffSession);
    } else {
      await logoutAnonymousSession();
    }
  },
  subscribeRefreshEvents: subscribeBrowserRefreshEvents,
  isPageVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  now: () => Date.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  isStaffWallet: isStaffWalletAddress,
  createStaffChallenge: createStaffWalletChallenge,
  authenticateStaffWallet: exchangeStaffWalletChallenge,
  currentStaffSession: readStaffWalletSession,
  installStaffSession: installStaffWalletSessionIfUnchanged,
  hasStaffSession: (wallet) => readStaffWalletSession()?.wallet === wallet,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function errorCode(error: unknown): string {
  return normalizeApiErrorCode(
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

const PERSISTENT_RETRY_DELAYS_MS = [400, 800, 1_600, 5_000] as const;
const ACTION_RESTORATION_TIMEOUT_MS = 20_000;

export function useSolanaAuthWithRuntime(
  walletState: SolanaAuthWalletState,
  runtime: SolanaAuthRuntime,
) {
  const { publicKey, signMessage, connected } = walletState;
  const connectedWallet = connected ? publicKey?.toBase58() || null : null;
  const [state, setState] = useState<SolanaAuthState>(EMPTY_AUTH_STATE);
  const [error, setError] = useState<string | null>(null);
  const [authUserRevision, setAuthUserRevision] = useState(0);
  const [intentController, setIntentController] = useState(() => new AbortController());
  const intentControllerRef = useRef(intentController);
  const [sessionResolution, setSessionResolution] = useState<SessionResolution>('disabled');
  const sessionResolutionRef = useRef(sessionResolution);
  sessionResolutionRef.current = sessionResolution;
  const lastSignedRef = useRef<{
    wallet: string;
    uid: string;
    message: string;
    signature: Uint8Array;
    createdAt: number;
  } | null>(null);
  const connectedWalletRef = useRef<string | null>(connectedWallet);
  const previousConnectedWalletRef = useRef<string | null>(connectedWallet);
  const connectedRef = useRef<boolean>(connected);
  const sessionWalletRef = useRef<string | null>(null);
  const sessionSubjectRef = useRef<string | null>(null);
  const authSubjectRef = useRef<string | null>(runtime.currentAuthSubject());
  const mismatchSignOutRef = useRef<string | null>(null);
  const mismatchSignOutTimerRef = useRef<unknown>(null);
  const contextGenerationRef = useRef(0);
  const sessionRevisionRef = useRef(0);
  const ownerGenerationRef = useRef(0);
  const deliveryRecoveryRequestGenerationRef = useRef(0);
  const deliveryRecoveryAppliedGenerationRef = useRef(0);
  const signInAttemptRef = useRef<SignInAttempt | null>(null);
  const {
    refresh: refreshProfile,
    getCurrentRun: getProfileRefreshRun,
    invalidate: invalidateProfileRefresh,
  } = useProfileRefreshController();
  const sessionResetRef = useRef<SessionReset | null>(null);
  const authBootstrapInFlightRef = useRef(0);
  const restorationGenerationRef = useRef(0);
  const restorationWaitersRef = useRef(new Set<() => void>());
  const activeRestorationGatesRef = useRef(0);
  const mountedRef = useRef(true);
  connectedWalletRef.current = connectedWallet;
  connectedRef.current = connected;

  const clearMismatchSignOutTimer = useCallback(() => {
    if (mismatchSignOutTimerRef.current === null) return;
    runtime.clearTimer(mismatchSignOutTimerRef.current);
    mismatchSignOutTimerRef.current = null;
  }, [runtime]);

  const cancelRestorationWaits = useCallback(() => {
    restorationGenerationRef.current += 1;
    restorationWaitersRef.current.forEach((cancel) => cancel());
  }, []);

  const invalidateIntentContext = useCallback(() => {
    const previous = intentControllerRef.current;
    const next = new AbortController();
    intentControllerRef.current = next;
    if (mountedRef.current) setIntentController(next);
    previous.abort();
    cancelRestorationWaits();
  }, [cancelRestorationWaits]);

  useLayoutEffect(() => {
    const previousWallet = previousConnectedWalletRef.current;
    previousConnectedWalletRef.current = connectedWallet;
    if (previousWallet === connectedWallet) return;
    if (previousWallet) {
      invalidateIntentContext();
      return;
    }
    cancelRestorationWaits();
  }, [cancelRestorationWaits, connectedWallet, invalidateIntentContext]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    setIntentController(intentControllerRef.current);
    return () => {
      mountedRef.current = false;
      invalidateIntentContext();
      contextGenerationRef.current += 1;
      signInAttemptRef.current = null;
      invalidateProfileRefresh();
      clearMismatchSignOutTimer();
    };
  }, [clearMismatchSignOutTimer, invalidateIntentContext, invalidateProfileRefresh]);

  const ensureAuthSubject = useCallback(async () => {
    authBootstrapInFlightRef.current += 1;
    try {
      return await runtime.ensureAuthenticated();
    } finally {
      authBootstrapInFlightRef.current -= 1;
    }
  }, [runtime]);

  const resetAuthSession = useCallback(() => {
    if (sessionResetRef.current?.status === 'pending') return sessionResetRef.current.promise;
    const reset: SessionReset = { promise: Promise.resolve(), status: 'pending' };
    sessionResetRef.current = reset;
    reset.promise = runtime.signOut().then(
      () => { reset.status = 'complete'; },
      (resetError) => {
        reset.status = 'failed';
        reset.error = resetError;
        throw resetError;
      },
    );
    return reset.promise;
  }, [runtime]);

  const deactivateOwner = useCallback((loading = false) => {
    sessionWalletRef.current = null;
    sessionSubjectRef.current = null;
    ownerGenerationRef.current += 1;
    deliveryRecoveryRequestGenerationRef.current = 0;
    deliveryRecoveryAppliedGenerationRef.current = 0;
    setState({ ...EMPTY_AUTH_STATE, loading });
  }, []);

  const activateOwner = useCallback((wallet: string, uid: string) => {
    sessionRevisionRef.current += 1;
    const previousWallet = sessionWalletRef.current;
    sessionWalletRef.current = wallet;
    sessionSubjectRef.current = uid;
    if (previousWallet !== wallet) {
      ownerGenerationRef.current += 1;
      deliveryRecoveryRequestGenerationRef.current = 0;
      deliveryRecoveryAppliedGenerationRef.current = 0;
      setState({ ...EMPTY_AUTH_STATE, sessionWallet: wallet, authenticated: true });
      return;
    }
    setState((current) =>
      current.sessionWallet === wallet
        ? { ...current, authenticated: true, loading: false }
        : { ...EMPTY_AUTH_STATE, sessionWallet: wallet, authenticated: true },
    );
  }, []);

  const endMismatchedAuthSession = useCallback(
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
        void resetAuthSession().catch((signOutError) => {
          if (!mountedRef.current || mismatchSignOutRef.current !== mismatchKey) return;
          if (!activeRestorationGatesRef.current) {
            setError(errorMessage(signOutError, 'Unable to end the previous wallet session'));
          }
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
    [clearMismatchSignOutTimer, deactivateOwner, resetAuthSession, runtime],
  );

  const applyProfileState = useCallback((response: GetProfileStateResponse, uid: string) => {
    const wallet = response.sessionWallet;
    if (!wallet) {
      deactivateOwner(false);
      setError(null);
      setSessionResolution('settled');
      return true;
    }
    const activeConnectedWallet = connectedWalletRef.current;
    if (runtime.isStaffWallet?.(wallet) && runtime.hasStaffSession && !runtime.hasStaffSession(wallet)) {
      endMismatchedAuthSession(uid, wallet, activeConnectedWallet || wallet);
      return true;
    }
    if (activeConnectedWallet && wallet !== activeConnectedWallet) {
      endMismatchedAuthSession(uid, wallet, activeConnectedWallet);
      return true;
    }
    const previousWallet = sessionWalletRef.current;
    sessionWalletRef.current = wallet;
    sessionSubjectRef.current = uid;
    if (previousWallet !== wallet) {
      ownerGenerationRef.current += 1;
      deliveryRecoveryRequestGenerationRef.current = 0;
      deliveryRecoveryAppliedGenerationRef.current = 0;
    }
    const profileError = response.profile?.status === 'error' ? response.profile.error : null;
    const shipmentsError = response.shipments?.status === 'error' ? response.shipments.error : null;
    setState((current) => mergeProfileState(current, response, wallet, EMPTY_AUTH_STATE));
    setError(null);
    setSessionResolution('settled');
    return !profileError && !shipmentsError;
  }, [deactivateOwner, endMismatchedAuthSession, runtime]);

  const refreshProfileState = useCallback((): Promise<boolean> => {
    const contextGeneration = contextGenerationRef.current;
    const sessionRevision = sessionRevisionRef.current;
    return refreshProfile({
      contextGeneration,
      sessionRevision,
      isCurrent: () => mountedRef.current && contextGenerationRef.current === contextGeneration &&
        sessionRevisionRef.current === sessionRevision,
      ensureAuthSubject,
      applyProfileState,
      onError: (refreshError) => {
        if (errorCode(refreshError) === 'unauthenticated') {
          contextGenerationRef.current += 1;
          deactivateOwner(true);
          setError(null);
          setSessionResolution('resolving');
          return (async () => {
            try {
              await resetAuthSession();
            } catch (signOutError) {
              if (!activeRestorationGatesRef.current) {
                setError(errorMessage(signOutError, 'Unable to reset authentication'));
              }
            }
          })();
        }
        const message = errorMessage(refreshError, 'Unable to refresh profile');
        const hasValidatedSession = Boolean(
          sessionWalletRef.current && sessionSubjectRef.current === authSubjectRef.current,
        );
        if (hasValidatedSession) {
          setState((current) => current.sessionWallet === sessionWalletRef.current
            ? { ...current, profileError: message, shipmentsError: message }
            : current);
          setSessionResolution('settled');
        } else {
          setState((current) => ({ ...current, loading: true }));
          if (!activeRestorationGatesRef.current) setError(message);
          setSessionResolution('resolving');
        }
      },
    }, runtime);
  }, [applyProfileState, deactivateOwner, ensureAuthSubject, refreshProfile, resetAuthSession, runtime]);

  const awaitWalletSessionRestoration = useCallback(async (
    expectedWallet: string,
    signal?: AbortSignal,
  ): Promise<WalletSessionRestoration> => {
    const generation = restorationGenerationRef.current;
    const isCurrent = () => mountedRef.current && !signal?.aborted &&
      restorationGenerationRef.current === generation && connectedWalletRef.current === expectedWallet;
    const restored = () => sessionWalletRef.current === expectedWallet &&
      sessionSubjectRef.current !== null && sessionSubjectRef.current === authSubjectRef.current;
    if (!isCurrent()) return 'cancelled';
    if (restored()) return 'restored';
    if (sessionResolutionRef.current === 'settled' && !getProfileRefreshRun() && !mismatchSignOutRef.current &&
      sessionResetRef.current?.status !== 'pending') return 'sign-in-required';

    let cancel!: () => void;
    const cancelled = new Promise<'cancelled'>((resolve) => { cancel = () => resolve('cancelled'); });
    let timer: unknown = null;
    const expired = new Promise<'timed-out'>((resolve) => {
      timer = runtime.setTimer(() => resolve('timed-out'), ACTION_RESTORATION_TIMEOUT_MS);
    });
    const waitFor = (operation: Promise<unknown>) => Promise.race([
      operation.then(() => 'complete' as const, () => 'failed' as const),
      cancelled,
      expired,
    ]);
    restorationWaitersRef.current.add(cancel);
    signal?.addEventListener('abort', cancel, { once: true });
    activeRestorationGatesRef.current += 1;
    setError(null);
    try {
      while (isCurrent()) {
        const reset = sessionResetRef.current;
        if (reset?.status === 'pending') {
          const outcome = await waitFor(reset.promise);
          if (!isCurrent() || outcome === 'cancelled') return 'cancelled';
          if (outcome === 'timed-out') throw new Error('Unable to sign in. Please try again.');
          if (outcome === 'failed') throw new Error('Unable to sign in. Please try again.', { cause: reset.error });
          if (restored()) return 'restored';
          return 'sign-in-required';
        }
        if (reset?.status === 'failed' && mismatchSignOutRef.current) {
          throw new Error('Unable to sign in. Please try again.', { cause: reset.error });
        }
        if (restored()) return 'restored';

        let run = getProfileRefreshRun();
        if (!run || run.contextGeneration !== contextGenerationRef.current) {
          void refreshProfileState().catch(() => undefined);
          run = getProfileRefreshRun();
        }
        if (!run) return 'sign-in-required';
        const resetBeforeAttempt = sessionResetRef.current;
        const outcome = await waitFor(run.attempt);
        if (!isCurrent() || outcome === 'cancelled') return 'cancelled';
        if (restored()) return 'restored';
        if (outcome === 'timed-out') {
          if (sessionResetRef.current?.status === 'pending') {
            throw new Error('Unable to sign in. Please try again.');
          }
          contextGenerationRef.current += 1;
          invalidateProfileRefresh();
          return 'sign-in-required';
        }
        if (sessionResetRef.current?.status === 'pending') continue;
        if (sessionResetRef.current?.status === 'failed' &&
          (sessionResetRef.current !== resetBeforeAttempt || mismatchSignOutRef.current)) {
          throw new Error('Unable to sign in. Please try again.', { cause: sessionResetRef.current.error });
        }
        if (outcome === 'failed' || run.contextGeneration === contextGenerationRef.current) {
          return 'sign-in-required';
        }
      }
      return 'cancelled';
    } finally {
      if (timer !== null) runtime.clearTimer(timer);
      signal?.removeEventListener('abort', cancel);
      restorationWaitersRef.current.delete(cancel);
      activeRestorationGatesRef.current -= 1;
    }
  }, [getProfileRefreshRun, invalidateProfileRefresh, refreshProfileState, runtime]);

  const beginDeliveryRecoveryScheduleUpdate = useCallback(() => {
    const wallet = sessionWalletRef.current;
    const uid = sessionSubjectRef.current;
    const ownerGeneration = ownerGenerationRef.current;
    if (!wallet || !uid) return (_nextCheckAt: number | null) => false;
    const requestGeneration = deliveryRecoveryRequestGenerationRef.current + 1;
    deliveryRecoveryRequestGenerationRef.current = requestGeneration;
    return (nextCheckAt: number | null) => {
      if (
        sessionSubjectRef.current !== uid ||
        authSubjectRef.current !== uid ||
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

  useEffect(() => runtime.subscribeAuthSubject((nextSubject, reason) => {
    const previousSubject = authSubjectRef.current;
    const activeSignIn = signInAttemptRef.current;
    const invalidatesSession = authSubjectChangeInvalidatesSession({
      previousSubject,
      nextSubject,
      signInActive: Boolean(activeSignIn),
      activeSignInSubject: activeSignIn?.uid ?? null,
    });
    authSubjectRef.current = nextSubject;
    if (previousSubject !== nextSubject) {
      clearMismatchSignOutTimer();
      mismatchSignOutRef.current = null;
    }
    if (!invalidatesSession) return;
    const internalReset = nextSubject === null && sessionResetRef.current?.status === 'pending';
    const internalBootstrap = authBootstrapInFlightRef.current > 0 &&
      previousSubject === null && nextSubject !== null;
    if (!internalReset && !internalBootstrap && reason !== 'credential-expired' && reason !== 'session-renewed') invalidateIntentContext();
    contextGenerationRef.current += 1;
    invalidateProfileRefresh();
    deactivateOwner(false);
    setError(null);
    setAuthUserRevision((revision) => revision + 1);
  }), [clearMismatchSignOutTimer, deactivateOwner, invalidateIntentContext, invalidateProfileRefresh, runtime]);

  useLayoutEffect(() => {
    const currentAuthSubject = authSubjectRef.current;
    const activeWallet = sessionWalletRef.current;
    if (
      connectedWallet &&
      activeWallet &&
      activeWallet !== connectedWallet &&
      currentAuthSubject &&
      sessionSubjectRef.current === currentAuthSubject
    ) {
      endMismatchedAuthSession(currentAuthSubject, activeWallet, connectedWallet);
    }
  }, [connectedWallet, endMismatchedAuthSession]);

  const beginProfileRefreshCycle = useCallback(() => {
    if (mismatchSignOutRef.current) return false;
    const currentAuthSubject = authSubjectRef.current;
    const activeWallet = sessionWalletRef.current;
    contextGenerationRef.current += 1;
    invalidateProfileRefresh();
    if (!activeWallet && connectedWallet) setState((current) => ({ ...current, loading: true }));
    const validated = Boolean(
      activeWallet && currentAuthSubject && sessionSubjectRef.current === currentAuthSubject && (!connectedWallet || connectedWallet === activeWallet),
    );
    setSessionResolution(validated ? 'settled' : 'resolving');
    return true;
  }, [connectedWallet, invalidateProfileRefresh]);

  useProfileRefreshLifecycle({
    runtime,
    connectedWallet,
    authUserRevision,
    sessionWallet: state.sessionWallet,
    beginCycle: beginProfileRefreshCycle,
    refreshProfileState,
    reconcileProfile,
  });

  const signIn = useCallback((): Promise<SignInResult> => {
    if (!mountedRef.current) {
      const unmountedError = new Error('Wallet changed during sign-in. Please try again.');
      (unmountedError as Error & { code?: string }).code = 'wallet-changed';
      return Promise.reject(unmountedError);
    }
    if (!publicKey) return Promise.reject(new Error('Select a wallet to sign in.'));
    if (!signMessage) return Promise.reject(new Error('Wallet cannot sign messages'));
    const wallet = publicKey.toBase58();
    let contextGeneration = contextGenerationRef.current;
    const existingAttempt = signInAttemptRef.current;
    if (existingAttempt?.wallet === wallet && existingAttempt.contextGeneration === contextGeneration) {
      return existingAttempt.promise;
    }
    contextGeneration += 1;
    contextGenerationRef.current = contextGeneration;
    invalidateProfileRefresh();
    let resolveAttempt!: (result: SignInResult) => void;
    let rejectAttempt!: (error: unknown) => void;
    const promise = new Promise<SignInResult>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const attempt: SignInAttempt = { wallet, contextGeneration, uid: null, promise };
    signInAttemptRef.current = attempt;
    const attemptIsCurrent = () => signInAttemptRef.current === attempt;
    const ensureAttemptCurrent = (requireIdentity = true) => {
      if (requireIdentity && (!attempt.uid || runtime.currentAuthSubject() !== attempt.uid)) {
        const authChangedError = new Error('Authentication changed during sign-in. Please try again.');
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
        const staffSignIn = Boolean(runtime.isStaffWallet?.(wallet));
        let uid: string;
        let session: { wallet: string };
        if (staffSignIn) {
          if (
            !runtime.createStaffChallenge ||
            !runtime.authenticateStaffWallet ||
            !runtime.currentStaffSession ||
            !runtime.installStaffSession
          ) {
            throw new Error('Staff wallet authentication is unavailable.');
          }
          const startingToken = runtime.currentStaffSession()?.token || null;
          attempt.uid = wallet;
          ensureAttemptCurrent(false);
          const challenge = await runtime.createStaffChallenge(wallet);
          ensureAttemptCurrent(false);
          const signature = await signMessage(new TextEncoder().encode(challenge.message));
          ensureAttemptCurrent(false);
          const exchangedSession = await runtime.authenticateStaffWallet(challenge.challengeId, signature);
          ensureAttemptCurrent(false);
          if (exchangedSession.wallet !== wallet) {
            throw new Error('Wallet session response did not match the connected wallet');
          }
          const staffSession = await runtime.installStaffSession(exchangedSession, startingToken);
          if (!staffSession || staffSession.wallet !== wallet) {
            const authChangedError = new Error('Authentication changed during sign-in. Please try again.');
            (authChangedError as Error & { code?: string }).code = 'auth-user-changed';
            throw authChangedError;
          }
          uid = wallet;
          session = staffSession;
          ensureAttemptCurrent();
        } else {
          uid = await ensureAuthSubject();
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
          session = await retryWithBackoff(
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
                return isRetryableApiError(retryError);
              },
            },
          );
          ensureAttemptCurrent();
        }
        if (session.wallet !== wallet) throw new Error('Wallet session response did not match the connected wallet');
        setError(null);
        activateOwner(wallet, uid);
        setSessionResolution('settled');
        await refreshProfileState().catch(() => undefined);
        ensureAttemptCurrent();
        if (sessionWalletRef.current !== wallet || sessionSubjectRef.current !== uid) {
          throw new Error('Unable to sign in. Please try again.');
        }
        resolveAttempt({ wallet });
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
  }, [activateOwner, ensureAuthSubject, invalidateProfileRefresh, publicKey, refreshProfileState, runtime, signMessage]);

  const signOut = useCallback(async () => {
    invalidateIntentContext();
    contextGenerationRef.current += 1;
    clearMismatchSignOutTimer();
    mismatchSignOutRef.current = null;
    invalidateProfileRefresh();
    deactivateOwner(false);
    setError(null);
    lastSignedRef.current = null;
    try {
      await resetAuthSession();
    } catch (signOutError) {
      await refreshProfileState().catch(() => false);
      throw signOutError;
    }
  }, [clearMismatchSignOutTimer, deactivateOwner, invalidateIntentContext, invalidateProfileRefresh, refreshProfileState, resetAuthSession]);

  const hasAuthenticatedWalletSession = useCallback(
    (wallet: string | null | undefined) => Boolean(
      wallet && sessionWalletRef.current === wallet && sessionSubjectRef.current === authSubjectRef.current,
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
    intentCancellationSignal: intentController.signal,
    authSubject: authSubjectRef.current,
    error,
    signIn,
    signOut,
    reconcileProfile,
    refreshProfileState,
    awaitWalletSessionRestoration,
    beginDeliveryRecoveryScheduleUpdate,
    hasAuthenticatedWalletSession,
  };
}

export function useSolanaAuth() {
  const walletState = useWallet();
  return useSolanaAuthWithRuntime(walletState, DEFAULT_RUNTIME);
}
