import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from '../lib/firebase';
import {
  ensureAuthenticated,
  reconcileProfileState,
  solanaAuth,
  type ReconcileProfileStateRequest,
  type ReconcileProfileStateResponse,
} from '../lib/api';
import { isRetryableCallableError, retryWithBackoff } from '../lib/callableErrors';
import type { DeliveryOrderSummary, Profile } from '../types';
import { buildSignInMessage } from '../lib/solana';
import {
  deliveryOrderSummariesEqual,
  firebaseAuthChangeInvalidatesSession,
  firestoreErrorInvalidatesSession,
  firestoreListenerErrorIsRetryable,
  listenToProfile,
  listenToProfileShipments,
  listenToSessionBinding,
  profileListenerIsCurrent,
  sessionExpiryDelay,
  type SessionBinding,
  type SnapshotUpdate,
} from '../lib/profileFirestore';

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

export type SolanaAuthOptions = {
  observeDisconnectedSession?: boolean;
};

type SnapshotHandlers<T> = {
  next: (update: SnapshotUpdate<T>) => void;
  error: (error: unknown) => void;
};

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
  listenToSessionBinding: (uid: string, handlers: SnapshotHandlers<SessionBinding | null>) => () => void;
  listenToProfile: (wallet: string, handlers: SnapshotHandlers<Profile>) => () => void;
  listenToProfileShipments: (
    wallet: string,
    handlers: SnapshotHandlers<DeliveryOrderSummary[]>,
  ) => () => void;
  reconcileProfileState: (options?: ReconcileProfileStateRequest) => Promise<ReconcileProfileStateResponse>;
  authenticateWallet: (wallet: string, message: string, signature: Uint8Array) => Promise<{ wallet: string }>;
  signOut: () => Promise<void>;
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

const DEFAULT_RUNTIME: SolanaAuthRuntime = {
  currentUid: () => auth?.currentUser?.uid || null,
  subscribeAuthUser: (listener) => {
    if (!auth) return () => {};
    return onAuthStateChanged(auth, (user) => listener(user?.uid || null));
  },
  ensureAuthenticated,
  getIdToken: async () => (await auth?.currentUser?.getIdToken()) || null,
  listenToSessionBinding,
  listenToProfile,
  listenToProfileShipments,
  reconcileProfileState,
  authenticateWallet: (wallet, message, signature) =>
    solanaAuth(wallet, message, signature, { responseMode: 'session' }),
  signOut: async () => {
    if (auth) await firebaseSignOut(auth);
  },
  now: () => Date.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isInvalidSignatureError(error: unknown): boolean {
  const value = error as { message?: unknown; details?: unknown } | null;
  if (typeof value?.message === 'string' && /invalid signature/i.test(value.message)) return true;
  return typeof value?.details === 'string' && /invalid signature/i.test(value.details);
}

function normalizedRecoveryNextCheckAt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function snapshotIsAuthoritative(update: Pick<SnapshotUpdate<unknown>, 'fromCache' | 'hasPendingWrites'>) {
  return !update.fromCache && !update.hasPendingWrites;
}

const PERSISTENT_RETRY_DELAYS_MS = [400, 800, 1_600, 5_000] as const;

function persistentRetryDelay(retryCount: number): number {
  return PERSISTENT_RETRY_DELAYS_MS[
    Math.min(retryCount, PERSISTENT_RETRY_DELAYS_MS.length - 1)
  ];
}

export function useSolanaAuthWithRuntime(
  walletState: SolanaAuthWalletState,
  runtime: SolanaAuthRuntime,
  options: SolanaAuthOptions = {},
) {
  const { publicKey, signMessage, connected } = walletState;
  const connectedWallet = connected ? publicKey?.toBase58() || null : null;
  const [state, setState] = useState<SolanaAuthState>(EMPTY_AUTH_STATE);
  const [error, setError] = useState<string | null>(null);
  const [authUserRevision, setAuthUserRevision] = useState(0);
  const [sessionListenerRevision, setSessionListenerRevision] = useState(0);
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
  const firebaseUidRef = useRef<string | null>(runtime.currentUid());
  const contextGenerationRef = useRef(0);
  const ownerGenerationRef = useRef(0);
  const deliveryRecoveryRequestGenerationRef = useRef(0);
  const deliveryRecoveryAppliedGenerationRef = useRef(0);
  const signInAttemptRef = useRef<SignInAttempt | null>(null);
  const mountedRef = useRef(true);
  connectedWalletRef.current = connectedWallet;
  connectedRef.current = connected;

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      contextGenerationRef.current += 1;
      signInAttemptRef.current = null;
    };
  }, []);

  const deactivateOwner = useCallback((loading = false) => {
    sessionWalletRef.current = null;
    ownerGenerationRef.current += 1;
    deliveryRecoveryRequestGenerationRef.current = 0;
    deliveryRecoveryAppliedGenerationRef.current = 0;
    setState({ ...EMPTY_AUTH_STATE, loading });
  }, []);

  const activateOwner = useCallback((wallet: string, token: string) => {
    const previousWallet = sessionWalletRef.current;
    sessionWalletRef.current = wallet;
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

  const beginDeliveryRecoveryScheduleUpdate = useCallback(() => {
    const wallet = sessionWalletRef.current;
    const contextGeneration = contextGenerationRef.current;
    const ownerGeneration = ownerGenerationRef.current;
    if (!wallet) return (_nextCheckAt: number | null) => false;
    const requestGeneration = deliveryRecoveryRequestGenerationRef.current + 1;
    deliveryRecoveryRequestGenerationRef.current = requestGeneration;
    return (nextCheckAt: number | null) => {
      if (
        contextGenerationRef.current !== contextGeneration ||
        ownerGenerationRef.current !== ownerGeneration ||
        sessionWalletRef.current !== wallet ||
        requestGeneration <= deliveryRecoveryAppliedGenerationRef.current
      ) {
        return false;
      }
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
      ) {
        return null;
      }
      if (commitSchedule) {
        commitSchedule(normalizedRecoveryNextCheckAt(result.deliveryRecovery?.nextCheckAt));
      }
      return result;
    },
    [beginDeliveryRecoveryScheduleUpdate, runtime],
  );

  useEffect(() => {
    return runtime.subscribeAuthUser((nextUid) => {
      const previousUid = firebaseUidRef.current;
      const activeSignIn = signInAttemptRef.current;
      const invalidatesSession = firebaseAuthChangeInvalidatesSession({
        previousUid,
        nextUid,
        signInActive: Boolean(activeSignIn),
        activeSignInUid: activeSignIn?.uid ?? null,
      });
      firebaseUidRef.current = nextUid;
      if (!invalidatesSession) return;
      contextGenerationRef.current += 1;
      deactivateOwner(false);
      setError(null);
      setAuthUserRevision((revision) => revision + 1);
    });
  }, [deactivateOwner, runtime]);

  useEffect(() => {
    const allowDisconnected = !connectedWallet && options.observeDisconnectedSession === true;
    const shouldObserve = Boolean(connectedWallet || allowDisconnected);
    const contextGeneration = contextGenerationRef.current + 1;
    contextGenerationRef.current = contextGeneration;
    if (sessionWalletRef.current !== connectedWallet) {
      deactivateOwner(Boolean(connectedWallet));
    }
    setError(null);
    setSessionResolution(shouldObserve ? 'resolving' : 'disabled');
    if (!shouldObserve) return;

    let cancelled = false;
    let unsubscribeSession = () => {};
    let expiryTimer: unknown = null;
    let retryTimer: unknown = null;
    let retryCount = 0;
    let subscriptionGeneration = 0;
    const retryDelays = [400, 800, 1_600];
    const isCurrentContext = () =>
      !cancelled &&
      contextGenerationRef.current === contextGeneration &&
      connectedWalletRef.current === connectedWallet;
    const clearExpiryTimer = () => {
      if (expiryTimer === null) return;
      runtime.clearTimer(expiryTimer);
      expiryTimer = null;
    };
    const clearRetryTimer = () => {
      if (retryTimer === null) return;
      runtime.clearTimer(retryTimer);
      retryTimer = null;
    };
    const scheduleRetry = (sessionError: unknown, retry: () => void) => {
      if (
        !firestoreListenerErrorIsRetryable(sessionError) ||
        retryCount >= retryDelays.length
      ) {
        return false;
      }
      const delay = retryDelays[retryCount];
      retryCount += 1;
      setSessionResolution('resolving');
      clearRetryTimer();
      retryTimer = runtime.setTimer(() => {
        retryTimer = null;
        retry();
      }, delay);
      return true;
    };
    const invalidateBinding = (message?: string) => {
      if (!isCurrentContext()) return;
      clearExpiryTimer();
      clearRetryTimer();
      deactivateOwner(false);
      setSessionResolution('settled');
      if (message) setError(message);
    };
    const armExpiry = (binding: SessionBinding) => {
      clearExpiryTimer();
      if (binding.expiresAt === null) {
        invalidateBinding();
        return;
      }
      const expiresAt = binding.expiresAt;
      const scheduleNext = () => {
        if (!isCurrentContext() || sessionWalletRef.current !== binding.wallet) return;
        const delay = sessionExpiryDelay(expiresAt, runtime.now());
        if (delay === 0) {
          invalidateBinding('Wallet session expired. Sign in again.');
          return;
        }
        expiryTimer = runtime.setTimer(scheduleNext, delay);
      };
      scheduleNext();
    };

    const subscribe = (uid: string, token: string) => {
      if (!isCurrentContext()) return;
      unsubscribeSession();
      unsubscribeSession = () => {};
      const generation = subscriptionGeneration + 1;
      subscriptionGeneration = generation;
      try {
        const unsubscribe = runtime.listenToSessionBinding(uid, {
          next: (update) => {
            if (
              !isCurrentContext() ||
              generation !== subscriptionGeneration ||
              !snapshotIsAuthoritative(update)
            ) {
              return;
            }
            const binding = update.value;
            if (
              !binding ||
              binding.expiresAt === null ||
              binding.expiresAt <= runtime.now() ||
              (connectedWallet !== null && binding.wallet !== connectedWallet)
            ) {
              invalidateBinding();
              return;
            }
            retryCount = 0;
            clearRetryTimer();
            setError(null);
            activateOwner(binding.wallet, token);
            setSessionResolution('settled');
            armExpiry(binding);
          },
          error: (sessionError) => {
            if (!isCurrentContext() || generation !== subscriptionGeneration) return;
            subscriptionGeneration += 1;
            unsubscribeSession();
            unsubscribeSession = () => {};
            if (scheduleRetry(sessionError, () => subscribe(uid, token))) return;
            invalidateBinding(errorMessage(sessionError, 'Unable to validate wallet session'));
          },
        });
        if (isCurrentContext() && generation === subscriptionGeneration) {
          unsubscribeSession = unsubscribe;
        }
        else unsubscribe();
      } catch (sessionError) {
        if (!isCurrentContext() || generation !== subscriptionGeneration) return;
        subscriptionGeneration += 1;
        if (scheduleRetry(sessionError, () => subscribe(uid, token))) return;
        invalidateBinding(errorMessage(sessionError, 'Unable to validate wallet session'));
      }
    };

    const startObservation = () => {
      void (async () => {
        try {
          const uid = await runtime.ensureAuthenticated();
          const token = await runtime.getIdToken();
          if (!isCurrentContext()) return;
          if (runtime.currentUid() !== uid || !token) {
            invalidateBinding();
            return;
          }
          retryCount = 0;
          subscribe(uid, token);
        } catch (sessionError) {
          if (!isCurrentContext()) return;
          if (scheduleRetry(sessionError, startObservation)) return;
          invalidateBinding(errorMessage(sessionError, 'Unable to validate wallet session'));
        }
      })();
    };
    startObservation();

    return () => {
      cancelled = true;
      subscriptionGeneration += 1;
      clearExpiryTimer();
      clearRetryTimer();
      unsubscribeSession();
    };
  }, [
    activateOwner,
    authUserRevision,
    connectedWallet,
    deactivateOwner,
    options.observeDisconnectedSession,
    runtime,
    sessionListenerRevision,
  ]);

  useEffect(() => {
    const wallet = state.sessionWallet;
    const allowDisconnected =
      !connectedWallet && options.observeDisconnectedSession === true;
    if (!wallet || (connectedWallet !== wallet && !allowDisconnected)) return;
    const ownerGeneration = ownerGenerationRef.current;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled && profileListenerIsCurrent({
        expectedWallet: wallet,
        expectedEpoch: ownerGeneration,
        currentWallet: sessionWalletRef.current,
        currentEpoch: ownerGenerationRef.current,
        connectedWallet: connectedWalletRef.current,
        allowDisconnected,
      });
    const invalidateFromListener = (listenerError: unknown) => {
      if (!isCurrent() || !firestoreErrorInvalidatesSession(listenerError)) return false;
      deactivateOwner(false);
      setError(errorMessage(listenerError, 'Wallet session is no longer authorized'));
      return true;
    };
    const attachRetriableListener = <T,>(
      listen: (handlers: SnapshotHandlers<T>) => () => void,
      handlers: SnapshotHandlers<T>,
    ) => {
      let unsubscribe = () => {};
      let retryTimer: unknown = null;
      let retryCount = 0;
      let generation = 0;
      const clearRetryTimer = () => {
        if (retryTimer === null) return;
        runtime.clearTimer(retryTimer);
        retryTimer = null;
      };
      const reportFailure = (listenerError: unknown) => {
        if (!isCurrent() || invalidateFromListener(listenerError)) return;
        handlers.error(listenerError);
        if (!firestoreListenerErrorIsRetryable(listenerError)) return;
        const delay = persistentRetryDelay(retryCount);
        retryCount += 1;
        clearRetryTimer();
        retryTimer = runtime.setTimer(() => {
          retryTimer = null;
          subscribe();
        }, delay);
      };
      const subscribe = () => {
        if (!isCurrent()) return;
        clearRetryTimer();
        unsubscribe();
        unsubscribe = () => {};
        const activeGeneration = generation + 1;
        generation = activeGeneration;
        try {
          const nextUnsubscribe = listen({
            next: (update) => {
              if (!isCurrent() || generation !== activeGeneration) return;
              if (snapshotIsAuthoritative(update)) retryCount = 0;
              handlers.next(update);
            },
            error: (listenerError) => {
              if (!isCurrent() || generation !== activeGeneration) return;
              generation += 1;
              unsubscribe();
              unsubscribe = () => {};
              reportFailure(listenerError);
            },
          });
          if (isCurrent() && generation === activeGeneration) unsubscribe = nextUnsubscribe;
          else nextUnsubscribe();
        } catch (listenerError) {
          if (!isCurrent() || generation !== activeGeneration) return;
          generation += 1;
          reportFailure(listenerError);
        }
      };
      subscribe();
      return () => {
        generation += 1;
        clearRetryTimer();
        unsubscribe();
      };
    };

    const unsubscribeProfile = attachRetriableListener<Profile>(
      (handlers) => runtime.listenToProfile(wallet, handlers),
      {
        next: (update) => {
          const authoritative = snapshotIsAuthoritative(update);
          setState((current) =>
            current.sessionWallet === wallet
              ? {
                  ...current,
                  profile: update.value,
                  ...(authoritative ? { profileReady: true, profileError: null } : {}),
                }
              : current,
          );
        },
        error: (snapshotError) => {
          setState((current) =>
            current.sessionWallet === wallet
              ? {
                  ...current,
                  profileReady: false,
                  profileError: errorMessage(snapshotError, 'Unable to load profile'),
                }
              : current,
          );
        },
      },
    );

    const unsubscribeShipments = isCurrent()
      ? attachRetriableListener<DeliveryOrderSummary[]>(
          (handlers) => runtime.listenToProfileShipments(wallet, handlers),
          {
            next: (update) => {
              const authoritative = snapshotIsAuthoritative(update);
              const shipments = update.value;
              setState((current) => {
                if (current.sessionWallet !== wallet) return current;
                const changed = !deliveryOrderSummariesEqual(current.shipments, shipments);
                return {
                  ...current,
                  shipments,
                  ...(authoritative
                    ? { shipmentsReady: true, shipmentsError: null }
                    : changed
                      ? { shipmentsReady: false }
                      : {}),
                };
              });
            },
            error: (snapshotError) => {
              setState((current) =>
                current.sessionWallet === wallet
                  ? {
                      ...current,
                      shipmentsReady: false,
                      shipmentsError: errorMessage(snapshotError, 'Unable to load shipments'),
                    }
                  : current,
              );
            },
          },
        )
      : () => {};

    let reconcileRetryTimer: unknown = null;
    let reconcileRetryCount = 0;
    const clearReconcileRetryTimer = () => {
      if (reconcileRetryTimer === null) return;
      runtime.clearTimer(reconcileRetryTimer);
      reconcileRetryTimer = null;
    };
    const reconcileWhenCurrent = () => {
      if (!isCurrent() || connectedWallet !== wallet) return;
      clearReconcileRetryTimer();
      void reconcileProfile()
        .then(() => {
          reconcileRetryCount = 0;
        })
        .catch((reconcileError) => {
          if (!isCurrent()) return;
          if (!isRetryableCallableError(reconcileError)) {
            console.warn('[mons] failed to reconcile profile state', reconcileError);
            return;
          }
          const delay = persistentRetryDelay(reconcileRetryCount);
          reconcileRetryCount += 1;
          reconcileRetryTimer = runtime.setTimer(reconcileWhenCurrent, delay);
        });
    };
    reconcileWhenCurrent();

    return () => {
      cancelled = true;
      clearReconcileRetryTimer();
      unsubscribeProfile();
      unsubscribeShipments();
    };
  }, [
    connectedWallet,
    deactivateOwner,
    options.observeDisconnectedSession,
    reconcileProfile,
    runtime,
    state.sessionWallet,
  ]);

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
    if (
      existingAttempt?.wallet === wallet &&
      existingAttempt.contextGeneration === contextGeneration
    ) {
      return existingAttempt.promise;
    }

    let resolveAttempt!: (result: SignInResult) => void;
    let rejectAttempt!: (error: unknown) => void;
    const promise = new Promise<SignInResult>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const attempt: SignInAttempt = {
      wallet,
      contextGeneration,
      uid: null,
      promise,
    };
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
        if (
          cached &&
          cached.wallet === wallet &&
          cached.uid === uid &&
          now - cached.createdAt <= reuseWindowMs
        ) {
          ({ message, signature } = cached);
        } else {
          message = buildSignInMessage(wallet, uid);
          signature = await signMessage(new TextEncoder().encode(message));
          ensureAttemptCurrent();
          lastSignedRef.current = { wallet, uid, message, signature, createdAt: now };
        }

        const session = await retryWithBackoff(
          () =>
            authenticateWalletInOrder(uid, async () => {
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
        if (session.wallet !== wallet) {
          throw new Error('Wallet session response did not match the connected wallet');
        }

        const token = await runtime.getIdToken();
        ensureAttemptCurrent();
        if (!token) throw new Error('Missing Firebase auth token');
        setError(null);
        activateOwner(wallet, token);
        setSessionResolution('settled');
        setSessionListenerRevision((revision) => revision + 1);
        resolveAttempt({ wallet, token });
      } catch (signInError) {
        console.error(signInError);
        if (attemptIsCurrent() && isInvalidSignatureError(signInError)) lastSignedRef.current = null;
        const attemptStillOwnsContext =
          mountedRef.current &&
          attemptIsCurrent() &&
          contextGenerationRef.current === contextGeneration &&
          connectedWalletRef.current === wallet;
        if (attemptStillOwnsContext) {
          setState((current) => ({ ...current, loading: false }));
        }
        if (
          attemptStillOwnsContext &&
          (signInError as { code?: string } | null)?.code !== 'wallet-changed'
        ) {
          setError(errorMessage(signInError, 'Failed to sign in'));
        }
        rejectAttempt(signInError);
      } finally {
        if (attemptIsCurrent()) signInAttemptRef.current = null;
      }
    })();

    return promise;
  }, [activateOwner, publicKey, runtime, signMessage]);

  const signOut = useCallback(async () => {
    contextGenerationRef.current += 1;
    deactivateOwner(false);
    setError(null);
    lastSignedRef.current = null;
    await runtime.signOut();
  }, [deactivateOwner, runtime]);

  const hasCurrentWalletSession = useCallback(
    (wallet: string | null | undefined) =>
      Boolean(
        wallet &&
          connectedRef.current &&
          connectedWalletRef.current === wallet &&
          sessionWalletRef.current === wallet,
      ),
    [],
  );

  const stateIsVisible = Boolean(
    (connectedWallet && state.sessionWallet === connectedWallet) ||
      (!connectedWallet && options.observeDisconnectedSession && state.sessionWallet),
  );
  return {
    ...(stateIsVisible
      ? state
      : { ...EMPTY_AUTH_STATE, loading: Boolean(connectedWallet && state.loading) }),
    sessionResolution,
    error,
    signIn,
    signOut,
    reconcileProfile,
    beginDeliveryRecoveryScheduleUpdate,
    hasCurrentWalletSession,
  };
}

export function useSolanaAuth(options: SolanaAuthOptions = {}) {
  const walletState = useWallet();
  return useSolanaAuthWithRuntime(walletState, DEFAULT_RUNTIME, options);
}
