import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import {
  ensureAuthenticated,
  loadProfileStateFromServer,
  reconcileProfileState,
  solanaAuth,
  type ReconcileProfileStateRequest,
  type ReconcileProfileStateResponse,
} from '../lib/api';
import { isRetryableApiError, retryWithBackoff } from '../lib/apiErrors';
import type { DeliveryOrderSummary, GetProfileStateResponse, Profile } from '../types';
import { buildSignInMessage } from '../lib/solana';
import { normalizeApiErrorCode } from '../../shared/apiErrorCode';
import { deliveryOrderSummarySortAt } from '../../shared/deliveryOrderSummary.js';
import {
  deliveryOrderSummariesEqual,
  authSubjectChangeInvalidatesSession,
} from '../lib/profileState';
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

export type SolanaAuthState = {
  profile: Profile | null;
  shipments: DeliveryOrderSummary[];
  sessionWallet: string | null;
  authenticated: boolean;
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
  currentAuthSubject: () => string | null;
  subscribeAuthSubject: (listener: (authSubject: string | null) => void) => () => void;
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
    const emit = () => listener(readStaffWalletSession()?.wallet || currentAnonymousSubject());
    const unsubscribeStaff = subscribeStaffWalletSession(emit);
    const unsubscribeAnonymous = subscribeAnonymousSession(emit);
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
  const sessionSubjectRef = useRef<string | null>(null);
  const authSubjectRef = useRef<string | null>(runtime.currentAuthSubject());
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
    sessionSubjectRef.current = null;
    ownerGenerationRef.current += 1;
    deliveryRecoveryRequestGenerationRef.current = 0;
    deliveryRecoveryAppliedGenerationRef.current = 0;
    setState({ ...EMPTY_AUTH_STATE, loading });
  }, []);

  const activateOwner = useCallback((wallet: string, uid: string) => {
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
    setState((current) => {
      const base = current.sessionWallet === wallet
        ? current
        : { ...EMPTY_AUTH_STATE, sessionWallet: wallet, authenticated: true };
      const nextShipments = response.shipments?.status === 'ready'
        ? shipmentsInDisplayOrder(response.shipments.value)
        : base.shipments;
      const next: SolanaAuthState = {
        ...base,
        sessionWallet: wallet,
        authenticated: true,
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
        current.authenticated === next.authenticated &&
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
  }, [deactivateOwner, endMismatchedAuthSession, runtime]);

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
        if (!isCurrent() || runtime.currentAuthSubject() !== uid) return true;
        const response = await runtime.loadProfileState();
        if (!isCurrent() || runtime.currentAuthSubject() !== uid) return true;
        return applyProfileState(response, uid);
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
          sessionWalletRef.current && sessionSubjectRef.current === authSubjectRef.current,
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

  useEffect(() => runtime.subscribeAuthSubject((nextSubject) => {
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
    contextGenerationRef.current += 1;
    refreshRunRef.current = null;
    deactivateOwner(false);
    setError(null);
    setAuthUserRevision((revision) => revision + 1);
  }), [clearMismatchSignOutTimer, deactivateOwner, runtime]);

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

  useEffect(() => {
    if (mismatchSignOutRef.current) return;
    const currentAuthSubject = authSubjectRef.current;
    const activeWallet = sessionWalletRef.current;
    contextGenerationRef.current += 1;
    refreshRunRef.current = null;
    if (!activeWallet && connectedWallet) setState((current) => ({ ...current, loading: true }));
    const validated = Boolean(
      activeWallet && currentAuthSubject && sessionSubjectRef.current === currentAuthSubject && (!connectedWallet || connectedWallet === activeWallet),
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
          if (isRetryableApiError(refreshError)) {
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
  }, [authUserRevision, connectedWallet, refreshProfileState, runtime]);

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
          if (!isRetryableApiError(reconcileError)) {
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
          uid = await runtime.ensureAuthenticated();
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
  }, [activateOwner, publicKey, refreshProfileState, runtime, signMessage]);

  const signOut = useCallback(async () => {
    contextGenerationRef.current += 1;
    clearMismatchSignOutTimer();
    mismatchSignOutRef.current = null;
    refreshRunRef.current = null;
    deactivateOwner(false);
    setError(null);
    lastSignedRef.current = null;
    try {
      await runtime.signOut();
    } catch (signOutError) {
      await refreshProfileState().catch(() => false);
      throw signOutError;
    }
  }, [clearMismatchSignOutTimer, deactivateOwner, refreshProfileState, runtime]);

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
    authSubject: authSubjectRef.current,
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
