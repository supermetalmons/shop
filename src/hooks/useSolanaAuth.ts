import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from '../lib/firebase';
import {
  ensureAuthenticated,
  loadProfileShipmentsFromServer,
  reconcileProfileState,
  solanaAuth,
  type ReconcileProfileStateRequest,
  type ReconcileProfileStateResponse,
} from '../lib/api';
import { isRetryableCallableError, retryWithBackoff } from '../lib/callableErrors';
import type { DeliveryOrderSummary, Profile } from '../types';
import { buildSignInMessage } from '../lib/solana';
import { normalizeCallableErrorCode } from '../../functions/src/shared/callableErrorCode';
import {
  deliveryOrderSummaryEqual,
  deliveryOrderSummaryKey,
  deliveryOrderSummarySortAt,
} from '../../functions/src/shared/deliveryOrderSummary.js';
import {
  deliveryOrderSummariesEqual,
  firebaseAuthChangeInvalidatesSession,
  firestoreErrorInvalidatesSession,
  firestoreListenerErrorIsRetryable,
  listenToProfile,
  listenToProfileShipments,
  listenToSessionBinding,
  profileListenerIsCurrent,
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
  loadProfileShipmentsFromServer: (wallet: string) => Promise<DeliveryOrderSummary[]>;
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
  loadProfileShipmentsFromServer,
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
const SHIPMENT_SERVER_SYNC_DELAY_MS = 5_000;
const SHIPMENT_SERVER_REFRESH_DELAY_MS = 60_000;
const SHIPMENT_SERVER_VALIDATION_DELAY_MS = 5 * 60_000;
const SHIPMENT_SERVER_HEALTHY_VALIDATION_DELAY_MS = 60 * 60_000;
const SHIPMENT_SERVER_RETRY_DELAYS_MS = [
  ...PERSISTENT_RETRY_DELAYS_MS,
  30_000,
  SHIPMENT_SERVER_REFRESH_DELAY_MS,
] as const;

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

function mergeShipmentsForDisplay(
  {
    serverShipments,
    listenerShipments,
    listenerBaseline,
    listenerAuthoritative,
  }: {
    serverShipments: DeliveryOrderSummary[];
    listenerShipments: DeliveryOrderSummary[];
    listenerBaseline: DeliveryOrderSummary[];
    listenerAuthoritative: boolean;
  },
): DeliveryOrderSummary[] {
  const merged = new Map<string, DeliveryOrderSummary>();
  const baseline = new Map<string, DeliveryOrderSummary>();
  for (const shipment of serverShipments) {
    merged.set(deliveryOrderSummaryKey(shipment), shipment);
  }
  for (const shipment of listenerBaseline) {
    baseline.set(deliveryOrderSummaryKey(shipment), shipment);
  }
  for (const shipment of listenerShipments) {
    const key = deliveryOrderSummaryKey(shipment);
    const previous = baseline.get(key);
    const changedSinceServer = !previous || !deliveryOrderSummaryEqual(previous, shipment);
    if (changedSinceServer && (listenerAuthoritative || !merged.has(key))) {
      merged.set(key, shipment);
    }
  }
  return shipmentsInDisplayOrder([...merged.values()]);
}

export function useSolanaAuthWithRuntime(
  walletState: SolanaAuthWalletState,
  runtime: SolanaAuthRuntime,
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
  const sessionUidRef = useRef<string | null>(null);
  const firebaseUidRef = useRef<string | null>(runtime.currentUid());
  const mismatchSignOutRef = useRef<string | null>(null);
  const mismatchSignOutTimerRef = useRef<unknown>(null);
  const contextGenerationRef = useRef(0);
  const ownerGenerationRef = useRef(0);
  const deliveryRecoveryRequestGenerationRef = useRef(0);
  const deliveryRecoveryAppliedGenerationRef = useRef(0);
  const signInAttemptRef = useRef<SignInAttempt | null>(null);
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
      if (previousUid !== nextUid) {
        clearMismatchSignOutTimer();
        mismatchSignOutRef.current = null;
      }
      if (!invalidatesSession) return;
      contextGenerationRef.current += 1;
      deactivateOwner(false);
      setError(null);
      setAuthUserRevision((revision) => revision + 1);
    });
  }, [clearMismatchSignOutTimer, deactivateOwner, runtime]);

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

  useEffect(() => {
    const currentUid = firebaseUidRef.current;
    const activeWallet = sessionWalletRef.current;
    if (mismatchSignOutRef.current) {
      setSessionResolution('resolving');
      return;
    }
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

    const contextGeneration = contextGenerationRef.current + 1;
    contextGenerationRef.current = contextGeneration;
    if (!activeWallet && connectedWallet) {
      setState((current) => ({ ...current, loading: true }));
    }
    setError(null);
    const hasValidatedSession = Boolean(
      activeWallet &&
        currentUid &&
        sessionUidRef.current === currentUid &&
        (!connectedWallet || activeWallet === connectedWallet),
    );
    setSessionResolution(hasValidatedSession ? 'settled' : 'resolving');

    let cancelled = false;
    let unsubscribeSession = () => {};
    let retryTimer: unknown = null;
    let retryCount = 0;
    let subscriptionGeneration = 0;
    const isCurrentContext = () =>
      !cancelled &&
      contextGenerationRef.current === contextGeneration &&
      connectedWalletRef.current === connectedWallet;
    const clearRetryTimer = () => {
      if (retryTimer === null) return;
      runtime.clearTimer(retryTimer);
      retryTimer = null;
    };
    const scheduleRetry = (sessionError: unknown, retry: () => void) => {
      if (!firestoreListenerErrorIsRetryable(sessionError)) return false;
      const delay = retryDelay(PERSISTENT_RETRY_DELAYS_MS, retryCount);
      retryCount += 1;
      const hasValidatedSession = Boolean(
        sessionWalletRef.current && sessionUidRef.current === firebaseUidRef.current,
      );
      setSessionResolution(hasValidatedSession ? 'settled' : 'resolving');
      clearRetryTimer();
      retryTimer = runtime.setTimer(() => {
        retryTimer = null;
        retry();
      }, delay);
      return true;
    };
    const invalidateBinding = (message?: string) => {
      if (!isCurrentContext()) return;
      clearRetryTimer();
      deactivateOwner(false);
      setSessionResolution('settled');
      if (message) setError(message);
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
            if (!binding) {
              invalidateBinding();
              return;
            }
            if (connectedWallet !== null && binding.wallet !== connectedWallet) {
              endMismatchedFirebaseSession(uid, binding.wallet, connectedWallet);
              return;
            }
            retryCount = 0;
            clearRetryTimer();
            setError(null);
            activateOwner(binding.wallet, token, uid);
            setSessionResolution('settled');
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
      clearRetryTimer();
      unsubscribeSession();
    };
  }, [
    activateOwner,
    authUserRevision,
    connectedWallet,
    deactivateOwner,
    endMismatchedFirebaseSession,
    runtime,
    sessionListenerRevision,
  ]);

  useEffect(() => {
    const sessionWallet = state.sessionWallet;
    const allowDisconnected = !connectedWallet;
    if (!sessionWallet || (connectedWallet !== sessionWallet && !allowDisconnected)) return;
    const wallet = sessionWallet;
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
        const delay = retryDelay(PERSISTENT_RETRY_DELAYS_MS, retryCount);
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

    let shipmentServerSyncTimer: unknown = null;
    let shipmentServerSyncTimerAt: number | null = null;
    let shipmentServerSyncInFlight = false;
    let shipmentServerSyncGeneration = 0;
    let shipmentServerSyncRetryCount = 0;
    let shipmentListenerAuthoritative = false;
    let shipmentProjectionValidated = false;
    let listenerShipments: DeliveryOrderSummary[] | null = null;
    let listenerBaselineAtServerSync: DeliveryOrderSummary[] = [];
    let serverShipments: DeliveryOrderSummary[] | null = null;
    let displayedShipments = state.shipments;
    const clearShipmentServerSyncTimer = () => {
      if (shipmentServerSyncTimer === null) return;
      runtime.clearTimer(shipmentServerSyncTimer);
      shipmentServerSyncTimer = null;
      shipmentServerSyncTimerAt = null;
    };
    const applyShipments = (update: SnapshotUpdate<DeliveryOrderSummary[]>) => {
      const authoritative = snapshotIsAuthoritative(update);
      const shipments = shipmentsInDisplayOrder(update.value);
      const listenerChanged = listenerShipments === null
        ? !deliveryOrderSummariesEqual(displayedShipments, shipments)
        : !deliveryOrderSummariesEqual(listenerShipments, shipments);
      const changed = !deliveryOrderSummariesEqual(displayedShipments, shipments);
      const authorityChanged = shipmentListenerAuthoritative !== authoritative;
      shipmentListenerAuthoritative = authoritative;
      listenerShipments = shipments;
      if (listenerChanged || authorityChanged) {
        shipmentProjectionValidated = false;
      }
      if (listenerChanged) {
        shipmentServerSyncGeneration += 1;
        shipmentServerSyncRetryCount = 0;
      }

      if (
        serverShipments !== null &&
        !deliveryOrderSummariesEqual(serverShipments, shipments)
      ) {
        const displayShipments = mergeShipmentsForDisplay({
          serverShipments,
          listenerShipments: shipments,
          listenerBaseline: listenerBaselineAtServerSync,
          listenerAuthoritative: authoritative,
        });
        const displayReady = authoritative || deliveryOrderSummariesEqual(
          displayShipments,
          serverShipments,
        );
        displayedShipments = displayShipments;
        if (listenerChanged || authorityChanged) {
          scheduleShipmentServerSync(SHIPMENT_SERVER_SYNC_DELAY_MS);
        } else {
          scheduleShipmentServerSync(
            authoritative
              ? SHIPMENT_SERVER_VALIDATION_DELAY_MS
              : SHIPMENT_SERVER_REFRESH_DELAY_MS,
          );
        }
        setState((current) => {
          if (
            current.sessionWallet !== wallet ||
            (
              current.shipmentsReady === displayReady &&
              current.shipmentsError === null &&
              deliveryOrderSummariesEqual(current.shipments, displayShipments)
            )
          ) {
            return current;
          }
          return {
            ...current,
            shipments: displayShipments,
            shipmentsReady: displayReady,
            shipmentsError: null,
          };
        });
        return;
      }

      displayedShipments = shipments;
      if (shipmentProjectionValidated) {
        shipmentServerSyncRetryCount = 0;
        scheduleShipmentServerSync(SHIPMENT_SERVER_HEALTHY_VALIDATION_DELAY_MS);
      } else if (listenerChanged || authorityChanged) {
        scheduleShipmentServerSync(SHIPMENT_SERVER_SYNC_DELAY_MS);
      }
      setState((current) => {
        if (current.sessionWallet !== wallet) return current;
        const shipmentsReady = authoritative
          ? true
          : changed
            ? false
            : current.shipmentsReady;
        const shipmentsError = authoritative ? null : current.shipmentsError;
        if (
          current.shipmentsReady === shipmentsReady &&
          current.shipmentsError === shipmentsError &&
          deliveryOrderSummariesEqual(current.shipments, shipments)
        ) {
          return current;
        }
        return {
          ...current,
          shipments,
          shipmentsReady,
          shipmentsError,
        };
      });
    };
    const reportShipmentFailure = (snapshotError: unknown) => {
      const shipmentsError = errorMessage(snapshotError, 'Unable to load shipments');
      setState((current) => {
        if (
          current.sessionWallet !== wallet ||
          (!current.shipmentsReady && current.shipmentsError === shipmentsError)
        ) {
          return current;
        }
        return { ...current, shipmentsReady: false, shipmentsError };
      });
    };
    const unsubscribeShipments = isCurrent()
      ? attachRetriableListener<DeliveryOrderSummary[]>(
          (handlers) => runtime.listenToProfileShipments(wallet, handlers),
          {
            next: applyShipments,
            error: (snapshotError) => {
              shipmentListenerAuthoritative = false;
              shipmentProjectionValidated = false;
              reportShipmentFailure(snapshotError);
              scheduleShipmentServerSync(SHIPMENT_SERVER_SYNC_DELAY_MS);
            },
          },
        )
      : () => {};
    function scheduleShipmentServerSync(delay: number) {
      const requestedAt = runtime.now() + delay;
      if (
        !isCurrent() ||
        shipmentServerSyncInFlight ||
        (shipmentServerSyncTimerAt !== null && shipmentServerSyncTimerAt <= requestedAt)
      ) {
        return;
      }
      clearShipmentServerSyncTimer();
      shipmentServerSyncTimerAt = requestedAt;
      shipmentServerSyncTimer = runtime.setTimer(syncShipmentsFromServer, delay);
    }
    function syncShipmentsFromServer() {
      shipmentServerSyncTimer = null;
      shipmentServerSyncTimerAt = null;
      if (!isCurrent()) return;
      const requestGeneration = shipmentServerSyncGeneration + 1;
      shipmentServerSyncGeneration = requestGeneration;
      shipmentServerSyncInFlight = true;
      void runtime.loadProfileShipmentsFromServer(wallet).then(
        (shipments) => {
          shipmentServerSyncInFlight = false;
          if (!isCurrent()) return;
          if (shipmentServerSyncGeneration !== requestGeneration) {
            scheduleShipmentServerSync(SHIPMENT_SERVER_SYNC_DELAY_MS);
            return;
          }
          const orderedShipments = shipmentsInDisplayOrder(shipments);
          serverShipments = orderedShipments;
          listenerBaselineAtServerSync = listenerShipments ?? [];
          displayedShipments = orderedShipments;
          shipmentServerSyncRetryCount = 0;
          shipmentProjectionValidated = Boolean(
            shipmentListenerAuthoritative &&
            listenerShipments &&
            deliveryOrderSummariesEqual(listenerShipments, orderedShipments),
          );
          setState((current) => {
            if (current.sessionWallet !== wallet) return current;
            if (
              current.shipmentsReady &&
              current.shipmentsError === null &&
              deliveryOrderSummariesEqual(current.shipments, orderedShipments)
            ) {
              return current;
            }
            return {
              ...current,
              shipments: orderedShipments,
              shipmentsReady: true,
              shipmentsError: null,
            };
          });
          scheduleShipmentServerSync(
            shipmentProjectionValidated
              ? SHIPMENT_SERVER_HEALTHY_VALIDATION_DELAY_MS
              : shipmentListenerAuthoritative
                ? SHIPMENT_SERVER_VALIDATION_DELAY_MS
                : SHIPMENT_SERVER_REFRESH_DELAY_MS,
          );
        },
        (snapshotError) => {
          shipmentServerSyncInFlight = false;
          if (!isCurrent()) return;
          if (shipmentServerSyncGeneration !== requestGeneration) {
            scheduleShipmentServerSync(SHIPMENT_SERVER_SYNC_DELAY_MS);
            return;
          }
          const callableCode = normalizeCallableErrorCode(
            (snapshotError as { code?: unknown } | null)?.code,
          );
          if (callableCode === 'unauthenticated') {
            contextGenerationRef.current += 1;
            deactivateOwner(true);
            setError(null);
            setSessionResolution('resolving');
            setSessionListenerRevision((revision) => revision + 1);
            return;
          }
          if (shipmentProjectionValidated) {
            scheduleShipmentServerSync(SHIPMENT_SERVER_HEALTHY_VALIDATION_DELAY_MS);
            return;
          }
          if (
            isRetryableCallableError(snapshotError) ||
            firestoreListenerErrorIsRetryable(snapshotError)
          ) {
            const delay = retryDelay(SHIPMENT_SERVER_RETRY_DELAYS_MS, shipmentServerSyncRetryCount);
            shipmentServerSyncRetryCount += 1;
            if (delay === SHIPMENT_SERVER_REFRESH_DELAY_MS && !shipmentListenerAuthoritative) {
              reportShipmentFailure(snapshotError);
            }
            scheduleShipmentServerSync(delay);
            return;
          }
          shipmentServerSyncRetryCount = 0;
          if (!shipmentListenerAuthoritative) reportShipmentFailure(snapshotError);
          scheduleShipmentServerSync(SHIPMENT_SERVER_REFRESH_DELAY_MS);
        },
      );
    }
    scheduleShipmentServerSync(SHIPMENT_SERVER_SYNC_DELAY_MS);

    let reconcileRetryTimer: unknown = null;
    let reconcileRetryCount = 0;
    const clearReconcileRetryTimer = () => {
      if (reconcileRetryTimer === null) return;
      runtime.clearTimer(reconcileRetryTimer);
      reconcileRetryTimer = null;
    };
    const reconcileWhenCurrent = () => {
      if (!isCurrent()) return;
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
          const delay = retryDelay(PERSISTENT_RETRY_DELAYS_MS, reconcileRetryCount);
          reconcileRetryCount += 1;
          reconcileRetryTimer = runtime.setTimer(reconcileWhenCurrent, delay);
        });
    };
    reconcileWhenCurrent();

    return () => {
      cancelled = true;
      clearReconcileRetryTimer();
      clearShipmentServerSyncTimer();
      unsubscribeProfile();
      unsubscribeShipments();
    };
  }, [
    connectedWallet,
    deactivateOwner,
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
        activateOwner(wallet, token, attempt.uid);
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
    clearMismatchSignOutTimer();
    mismatchSignOutRef.current = null;
    deactivateOwner(false);
    setError(null);
    lastSignedRef.current = null;
    await runtime.signOut();
  }, [clearMismatchSignOutTimer, deactivateOwner, runtime]);

  const hasAuthenticatedWalletSession = useCallback(
    (wallet: string | null | undefined) =>
      Boolean(
        wallet &&
          sessionWalletRef.current === wallet &&
          sessionUidRef.current === firebaseUidRef.current,
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
    beginDeliveryRecoveryScheduleUpdate,
    hasAuthenticatedWalletSession,
  };
}

export function useSolanaAuth() {
  const walletState = useWallet();
  return useSolanaAuthWithRuntime(walletState, DEFAULT_RUNTIME);
}
