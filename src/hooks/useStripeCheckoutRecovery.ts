import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAnonymousStripeDeliveryHistory, getShipmentPresence } from '../api/profile';
import { isRetryableApiError } from '../lib/apiErrors';
import {
  retainMatchingOwnerRecoveryKey,
  stripeInventoryRecoveryTargetForResolvedSessions,
  stripeRecoveryKeyForResolvedSessions,
  type OwnerRecoveryKey,
} from '../lib/profileClientLifecycle';
import { stripeProfileRecoveryAfterRefresh, stripeMergeReconciliationOptions } from '../lib/profileState';
import {
  completeStripeCheckoutMarker,
  completedStripeCheckoutMarkerSummaryForAuthSubject,
  forgetCompletedStripeCheckoutMarkersForAuthSubject,
  isStripeCheckoutMintProgressSettled,
  loadStripeCheckoutMarkers,
  rememberStripeCheckoutStarted,
  stripeCheckoutMintProgressForSession,
  type StripeCheckoutMintProgress,
} from '../lib/stripeCheckoutMarkers';
import {
  mergeStripeCheckoutRecoverySessionIds,
  pendingStripeCheckoutRecoverySessionIds,
  resolveStripeCheckoutDataOwner,
  stripeCheckoutRetryDelay,
  shouldUseAnonymousStripeHistory,
  type StripeCheckoutProfileRecoveryStatus,
} from '../lib/stripeCheckoutRecovery';
import type { MintStats } from '../types';
import type { useSolanaAuth } from './useSolanaAuth';

const STRIPE_CHECKOUT_HISTORY_POLL_WINDOW_MS = 2 * 60_000;

type StripeCheckoutReturn =
  | {
      status: 'success';
      sessionId: string;
    }
  | {
      status: 'cancel' | 'unverified_success';
      sessionId?: undefined;
    };
type StripeCheckoutOptimisticMintProgress = StripeCheckoutMintProgress & {
  expiresAt: number;
};

function anonymousStripeDeliveryHistoryQueryKey(authSubject: string | null, markerKey: string) {
  return ['anonymousStripeDeliveryHistory', authSubject, markerKey] as const;
}

function consumeStripeCheckoutReturnFromUrl(): StripeCheckoutReturn | null {
  if (typeof window === 'undefined') return null;
  const parsed = new URL(window.location.href);
  const status = parsed.searchParams.get('stripe_checkout');
  if (status !== 'success' && status !== 'cancel') return null;

  const sessionId = parsed.searchParams.get('session_id')?.trim() || '';
  parsed.searchParams.delete('stripe_checkout');
  parsed.searchParams.delete('session_id');
  window.history.replaceState(window.history.state, '', `${parsed.pathname}${parsed.search}${parsed.hash}`);

  if (status === 'success' && !sessionId) return { status: 'unverified_success' };
  if (status === 'success') return { status, sessionId };
  return { status };
}

type StripeCheckoutRecoveryOptions = {
  auth: Pick<
    ReturnType<typeof useSolanaAuth>,
    | 'authSubject'
    | 'sessionWallet'
    | 'authenticated'
    | 'loading'
    | 'sessionResolution'
    | 'shipmentsRevision'
    | 'reconcileProfile'
    | 'refreshProfileState'
  >;
  connectedWallet: string | undefined;
  dropId: string | undefined;
  mintStats: MintStats | undefined;
  shouldFetchMintStats: boolean;
  refetchStats: () => Promise<unknown>;
  onCompleted: (message: string) => void;
};

export function useStripeCheckoutRecovery({
  auth,
  connectedWallet,
  dropId,
  mintStats,
  shouldFetchMintStats,
  refetchStats,
  onCompleted: showSuccessHud,
}: StripeCheckoutRecoveryOptions) {
  const {
    authSubject,
    sessionWallet,
    authenticated,
    loading: authLoading,
    sessionResolution,
    shipmentsRevision,
    reconcileProfile,
    refreshProfileState,
  } = auth;
  const authReady = sessionResolution === 'settled';
  const authenticatedWallet = authenticated && sessionWallet ? sessionWallet : undefined;
  const queryClient = useQueryClient();
  const [stripeCheckoutMarkers, setStripeCheckoutMarkers] = useState(() => loadStripeCheckoutMarkers());
  const [stripeCheckoutReturnSessionId, setStripeCheckoutReturnSessionId] = useState<string | null>(null);
  const [stripeRecoveryOwner, setStripeRecoveryOwner] = useState<string | null>(null);
  const [stripeCheckoutProfileRecovery, setStripeCheckoutProfileRecovery] =
    useState<StripeCheckoutProfileRecoveryStatus | null>(null);
  const anonymousStripeHistoryCompletion = useMemo(
    () => completedStripeCheckoutMarkerSummaryForAuthSubject(authSubject, stripeCheckoutMarkers),
    [authSubject, stripeCheckoutMarkers],
  );
  const anonymousStripeHistoryMarkerKey = anonymousStripeHistoryCompletion.markerKey;
  const completedStripeCheckoutSessionIds = anonymousStripeHistoryCompletion.sessionIds;
  const stripeCheckoutRecoverySessionIds = useMemo(
    () =>
      mergeStripeCheckoutRecoverySessionIds(
        completedStripeCheckoutSessionIds,
        stripeCheckoutReturnSessionId,
      ),
    [anonymousStripeHistoryMarkerKey, stripeCheckoutReturnSessionId],
  );
  const stripeCheckoutRecoveryKey = stripeRecoveryKeyForResolvedSessions(
    authSubject,
    stripeCheckoutRecoverySessionIds,
  );
  const [stripeCheckoutOptimisticMintProgress, setStripeCheckoutOptimisticMintProgress] =
    useState<StripeCheckoutOptimisticMintProgress | null>(null);
  const [stripeCheckoutRecoveredProfile, setStripeCheckoutRecoveredProfile] =
    useState<OwnerRecoveryKey | null>(null);
  const [walletShipmentPresence, setWalletShipmentPresence] = useState<{
    authSubject: string;
    wallet: string;
    recoveryKey: string;
    sessionIds: string[];
  } | null>(null);
  const stripeCheckoutReturnRef = useRef<StripeCheckoutReturn | null | undefined>(undefined);
  const stripeCheckoutOptimisticMintSessionRef = useRef<string | null>(null);
  const stripeCheckoutCompletionHandledRef = useRef(false);
  const stripeCheckoutReturnPollUntilRef = useRef(0);
  const stripeCheckoutRecoveryLoadedKeysRef = useRef<Set<string>>(new Set());
  const walletShipmentPresenceReady = walletShipmentPresence?.authSubject === authSubject &&
    walletShipmentPresence?.wallet === sessionWallet &&
    walletShipmentPresence?.recoveryKey === stripeCheckoutRecoveryKey;
  const walletShipmentStripeSessionIds = useMemo(
    () => walletShipmentPresenceReady ? walletShipmentPresence?.sessionIds ?? [] : [],
    [walletShipmentPresence, walletShipmentPresenceReady],
  );
  const pendingWalletStripeSessionIds = useMemo(
    () =>
      pendingStripeCheckoutRecoverySessionIds(
        stripeCheckoutRecoverySessionIds,
        walletShipmentStripeSessionIds,
      ),
    [walletShipmentStripeSessionIds, stripeCheckoutRecoverySessionIds],
  );
  const stripeCheckoutProfileRecoveryPending = Boolean(
    stripeCheckoutRecoveryKey &&
      (stripeCheckoutProfileRecovery?.key !== stripeCheckoutRecoveryKey ||
        stripeCheckoutProfileRecovery.phase === 'pending'),
  );
  const stripeCheckoutAnonymousFallbackReady = Boolean(
    stripeCheckoutRecoveryKey &&
      stripeCheckoutProfileRecovery?.key === stripeCheckoutRecoveryKey &&
      stripeCheckoutProfileRecovery.phase === 'fallback',
  );
  const hasLocalCompletedStripeCheckout = Boolean(anonymousStripeHistoryMarkerKey);
  const anonymousStripeHistoryPollUntil = anonymousStripeHistoryCompletion.latestCompletedAt
    ? anonymousStripeHistoryCompletion.latestCompletedAt + STRIPE_CHECKOUT_HISTORY_POLL_WINDOW_MS
    : 0;
  const anonymousStripeHistoryEnabled = shouldUseAnonymousStripeHistory({
    connectedWallet,
    recoveredWallet: authenticatedWallet || stripeRecoveryOwner,
    hasCompletedCheckout: hasLocalCompletedStripeCheckout,
    recoveryFallbackReady: stripeCheckoutAnonymousFallbackReady,
  });
  const anonymousStripeHistoryPollActive =
    anonymousStripeHistoryEnabled &&
    Boolean(anonymousStripeHistoryPollUntil && Date.now() < anonymousStripeHistoryPollUntil);
  const {
    data: anonymousStripeHistoryData,
    dataUpdatedAt: anonymousStripeHistoryUpdatedAt,
    isFetching: anonymousStripeHistoryLoading,
    error: anonymousStripeHistoryError,
  } = useQuery({
    queryKey: anonymousStripeDeliveryHistoryQueryKey(authSubject, anonymousStripeHistoryMarkerKey),
    enabled: anonymousStripeHistoryEnabled,
    queryFn: async () => {
      const presence = await getShipmentPresence({ scope: 'anonymous', stripeSessionIds: stripeCheckoutRecoverySessionIds })
        .then((result) => ({ sessionIds: result.stripeSessionIds, error: null }))
        .catch((error: unknown) => ({ sessionIds: null, error }));
      const page = await getAnonymousStripeDeliveryHistory({ limit: 50 });
      return { ...page, presence };
    },
    refetchInterval: (query) => {
      if (!anonymousStripeHistoryPollActive || !anonymousStripeHistoryPollUntil) return false;
      const error = query.state.error || query.state.data?.presence.error;
      const completedAttempts = query.state.dataUpdateCount + query.state.errorUpdateCount;
      const presentSessionIds = query.state.data?.presence.sessionIds ?? [];
      return stripeCheckoutRetryDelay({
        hasPendingWork: pendingStripeCheckoutRecoverySessionIds(
          stripeCheckoutRecoverySessionIds,
          presentSessionIds,
        ).length > 0,
        retryable: !error || isRetryableApiError(error),
        now: Date.now(),
        stopAt: anonymousStripeHistoryPollUntil,
        retryIndex: Math.max(0, completedAttempts - 1),
      }) ?? false;
    },
    refetchOnReconnect: anonymousStripeHistoryPollActive,
    refetchOnWindowFocus: anonymousStripeHistoryPollActive,
    staleTime: 10_000,
  });

  useEffect(() => {
    if (stripeCheckoutReturnRef.current === undefined) {
      stripeCheckoutReturnRef.current = consumeStripeCheckoutReturnFromUrl();
    }
    const checkoutReturn = stripeCheckoutReturnRef.current;
    if (!checkoutReturn) return;
    if (checkoutReturn.status === 'success') {
      stripeCheckoutReturnPollUntilRef.current = Math.max(
        stripeCheckoutReturnPollUntilRef.current,
        Date.now() + STRIPE_CHECKOUT_HISTORY_POLL_WINDOW_MS,
      );
      setStripeCheckoutReturnSessionId(checkoutReturn.sessionId);
      showSuccessHud('Stripe checkout completed.');
      return;
    }
    if (checkoutReturn.status === 'unverified_success') {
      showSuccessHud('Stripe checkout completed.');
      return;
    }
  }, [showSuccessHud]);

  useEffect(() => {
    if (stripeCheckoutCompletionHandledRef.current || !authSubject) return;
    const checkoutReturn = stripeCheckoutReturnRef.current;
    if (!checkoutReturn || checkoutReturn.status !== 'success') return;
    const result = completeStripeCheckoutMarker({
      sessionId: checkoutReturn.sessionId,
      authSubject,
      completedAt: Date.now(),
    });
    if (result.completed) {
      stripeCheckoutCompletionHandledRef.current = true;
      setStripeCheckoutMarkers(result.markers);
    }
  }, [authSubject]);

  useEffect(() => {
    const sessionId = stripeCheckoutReturnSessionId;
    if (
      !authSubject ||
      !sessionId ||
      stripeCheckoutOptimisticMintSessionRef.current === sessionId
    ) {
      return;
    }
    const markerProgress = stripeCheckoutMintProgressForSession(
      authSubject,
      sessionId,
      stripeCheckoutMarkers,
    );
    if (!markerProgress) return;

    stripeCheckoutOptimisticMintSessionRef.current = sessionId;
    if (
      dropId === markerProgress.dropId &&
      shouldFetchMintStats
    ) {
      void refetchStats().catch(() => undefined);
    }
    if (
      markerProgress.remainingBeforeCheckout == null &&
      markerProgress.variantRemainingBeforeCheckout == null
    ) {
      return;
    }
    setStripeCheckoutOptimisticMintProgress({
      ...markerProgress,
      expiresAt: Math.max(
        stripeCheckoutReturnPollUntilRef.current,
        Date.now() + STRIPE_CHECKOUT_HISTORY_POLL_WINDOW_MS,
      ),
    });
  }, [
    authSubject,
    refetchStats,
    dropId,
    shouldFetchMintStats,
    stripeCheckoutMarkers,
    stripeCheckoutReturnSessionId,
  ]);

  useEffect(() => {
    const progress = stripeCheckoutOptimisticMintProgress;
    if (!progress) return;
    if (
      dropId === progress.dropId &&
      isStripeCheckoutMintProgressSettled(mintStats, progress)
    ) {
      setStripeCheckoutOptimisticMintProgress((current) =>
        current === progress ? null : current,
      );
      return;
    }

    const remainingMs = progress.expiresAt - Date.now();
    if (remainingMs <= 0) {
      setStripeCheckoutOptimisticMintProgress((current) =>
        current === progress ? null : current,
      );
      return;
    }
    const timeout = setTimeout(() => {
      setStripeCheckoutOptimisticMintProgress((current) =>
        current === progress ? null : current,
      );
    }, remainingMs);
    return () => {
      clearTimeout(timeout);
    };
  }, [mintStats, dropId, stripeCheckoutOptimisticMintProgress]);

  useEffect(() => {
    if (connectedWallet) {
      setStripeRecoveryOwner(null);
      return;
    }
    if (
      sessionResolution === 'settled' &&
      stripeRecoveryOwner &&
      sessionWallet !== stripeRecoveryOwner
    ) {
      setStripeRecoveryOwner(null);
    }
  }, [
    connectedWallet,
    sessionResolution,
    sessionWallet,
    stripeRecoveryOwner,
  ]);

  useEffect(() => {
    if (
      !authSubject ||
      !stripeCheckoutRecoveryKey ||
      !stripeCheckoutRecoverySessionIds.length ||
      !walletShipmentPresenceReady
    ) {
      return;
    }
    const markerResult = forgetCompletedStripeCheckoutMarkersForAuthSubject({
      authSubject,
      sessionIds: walletShipmentStripeSessionIds,
    });
    if (markerResult.removed) {
      setStripeCheckoutMarkers(markerResult.markers);
      const inventoryRecoveryTarget = stripeInventoryRecoveryTargetForResolvedSessions({
        owner: sessionWallet,
        authSubject,
        sessionIds: markerResult.removedSessionIds,
      });
      if (inventoryRecoveryTarget) {
        setStripeCheckoutRecoveredProfile((current) =>
          retainMatchingOwnerRecoveryKey(current, inventoryRecoveryTarget),
        );
      }
      if (anonymousStripeHistoryMarkerKey) {
        queryClient.removeQueries({
          queryKey: anonymousStripeDeliveryHistoryQueryKey(authSubject, anonymousStripeHistoryMarkerKey),
          exact: true,
        });
      }
    }
    const returnSessionResolved = Boolean(stripeCheckoutReturnSessionId &&
      walletShipmentStripeSessionIds.includes(stripeCheckoutReturnSessionId));
    if (returnSessionResolved) {
      setStripeCheckoutReturnSessionId((current) =>
        current === stripeCheckoutReturnSessionId ? null : current,
      );
    }
    if (markerResult.removed || returnSessionResolved) {
      void refreshProfileState().catch((error) => {
        console.warn('[mons] failed to refresh shipments after Stripe checkout recovery', error);
      });
    }
    if (!sessionWallet || pendingWalletStripeSessionIds.length) return;
    setStripeCheckoutProfileRecovery((current) =>
      stripeProfileRecoveryAfterRefresh(current, stripeCheckoutRecoveryKey, true),
    );
    setStripeCheckoutRecoveredProfile((current) =>
      retainMatchingOwnerRecoveryKey(current, {
        owner: sessionWallet,
        key: stripeCheckoutRecoveryKey,
      }),
    );
    if (!connectedWallet) setStripeRecoveryOwner(sessionWallet);
  }, [
    anonymousStripeHistoryMarkerKey,
    connectedWallet,
    authSubject,
    pendingWalletStripeSessionIds,
    walletShipmentStripeSessionIds,
    walletShipmentPresenceReady,
    queryClient,
    refreshProfileState,
    sessionWallet,
    stripeCheckoutRecoveryKey,
    stripeCheckoutRecoverySessionIds.length,
    stripeCheckoutReturnSessionId,
  ]);

  useEffect(() => {
    if (!authSubject || !stripeCheckoutRecoveryKey || !stripeCheckoutRecoverySessionIds.length) return;
    if (!sessionWallet) {
      if (connectedWallet && (!authReady || authLoading)) return;
      if (!connectedWallet && sessionResolution !== 'settled') return;
      setStripeCheckoutProfileRecovery({ key: stripeCheckoutRecoveryKey, phase: 'fallback' });
      return;
    }
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const recoveryKey = stripeCheckoutRecoveryKey;
    const stopAt = Math.max(
      Date.now(),
      anonymousStripeHistoryPollUntil,
      stripeCheckoutReturnPollUntilRef.current,
    );
    const ownerRecoveryKey = `${sessionWallet}:${recoveryKey}`;
    let deliveryRecoveryLoaded = stripeCheckoutRecoveryLoadedKeysRef.current.has(ownerRecoveryKey);
    let retryIndex = 0;
    setStripeCheckoutProfileRecovery({ key: recoveryKey, phase: 'pending' });

    const markRecovered = () => {
      setStripeCheckoutProfileRecovery({ key: recoveryKey, phase: 'recovered' });
      setStripeCheckoutRecoveredProfile((current) =>
        retainMatchingOwnerRecoveryKey(current, { owner: sessionWallet, key: recoveryKey }),
      );
      if (!connectedWallet) setStripeRecoveryOwner(sessionWallet);
    };

    const recoverUntilSettled = async () => {
      if (cancelled) return;
      let retryable = true;
      let pendingSessionIds = stripeCheckoutRecoverySessionIds;
      const checkPresence = async () => {
        const presence = await getShipmentPresence({
          scope: 'wallet', expectedWallet: sessionWallet, stripeSessionIds: stripeCheckoutRecoverySessionIds,
        });
        if (cancelled) return;
        pendingSessionIds = pendingStripeCheckoutRecoverySessionIds(
          stripeCheckoutRecoverySessionIds, presence.stripeSessionIds,
        );
        setWalletShipmentPresence({ authSubject, wallet: sessionWallet, recoveryKey, sessionIds: presence.stripeSessionIds });
        if (!pendingSessionIds.length) markRecovered();
      };
      try {
        await checkPresence();
        if (cancelled || !pendingSessionIds.length) return;
        const reconciliationOptions = stripeMergeReconciliationOptions(deliveryRecoveryLoaded);
        const result = await reconcileProfile(reconciliationOptions);
        if (cancelled) return;
        if (!result) retryable = false;
        else {
          if (reconciliationOptions.includeDeliveryRecovery) {
            deliveryRecoveryLoaded = true;
            stripeCheckoutRecoveryLoadedKeysRef.current.add(ownerRecoveryKey);
          }
          await checkPresence();
        }
      } catch (err) {
        retryable = isRetryableApiError(err);
        console.warn('[mons] failed to reconcile profile after Stripe checkout', err);
      } finally {
        if (cancelled || !pendingSessionIds.length) return;
        const retryDelay = stripeCheckoutRetryDelay({
          hasPendingWork: true,
          retryable,
          now: Date.now(),
          stopAt,
          retryIndex,
        });
        if (retryDelay === null) {
          setStripeCheckoutProfileRecovery({ key: recoveryKey, phase: 'fallback' });
          return;
        }
        retryIndex += 1;
        timeout = setTimeout(() => { void recoverUntilSettled(); }, retryDelay);
      }
    };

    void recoverUntilSettled();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [
    anonymousStripeHistoryPollUntil,
    authLoading,
    authReady,
    connectedWallet,
    authSubject,
    reconcileProfile,
    sessionWallet,
    sessionResolution,
    stripeCheckoutRecoveryKey,
    stripeCheckoutRecoverySessionIds,
  ]);

  useEffect(() => {
    if (!authSubject || !sessionWallet || !stripeCheckoutAnonymousFallbackReady) return;
    let cancelled = false;
    void getShipmentPresence({ scope: 'wallet', expectedWallet: sessionWallet, stripeSessionIds: stripeCheckoutRecoverySessionIds })
      .then((presence) => {
        if (cancelled) return;
        setWalletShipmentPresence({
          authSubject, wallet: sessionWallet, recoveryKey: stripeCheckoutRecoveryKey, sessionIds: presence.stripeSessionIds,
        });
      })
      .catch((error) => {
        if (!cancelled) console.warn('[mons] failed to check Stripe shipment presence after profile refresh', error);
      });
    return () => { cancelled = true; };
  }, [
    authSubject, sessionWallet, shipmentsRevision, stripeCheckoutAnonymousFallbackReady,
    stripeCheckoutRecoveryKey, stripeCheckoutRecoverySessionIds,
  ]);

  const anonymousStripeDeliveryOrders = anonymousStripeHistoryData?.orders || [];
  const anonymousStripeHistoryHasOrders = anonymousStripeDeliveryOrders.length > 0;
  const anonymousStripeHistoryInitialLoading =
    anonymousStripeHistoryPollActive && anonymousStripeHistoryLoading && !anonymousStripeHistoryData;
  const anonymousStripeHistoryVisible = shouldUseAnonymousStripeHistory({
    connectedWallet,
    recoveredWallet: authenticatedWallet || stripeRecoveryOwner,
    hasCompletedCheckout: anonymousStripeHistoryPollActive || anonymousStripeHistoryHasOrders,
    recoveryFallbackReady: stripeCheckoutAnonymousFallbackReady,
  });
  const anonymousStripeHistoryWaitingForFulfillment =
    anonymousStripeHistoryPollActive &&
    !anonymousStripeHistoryHasOrders &&
    !anonymousStripeHistoryError &&
    (anonymousStripeHistoryInitialLoading ||
      Boolean(anonymousStripeHistoryPollUntil && Date.now() < anonymousStripeHistoryPollUntil));

  const rememberCheckoutStarted = useCallback((checkout: Parameters<typeof rememberStripeCheckoutStarted>[0]) => {
    setStripeCheckoutMarkers(rememberStripeCheckoutStarted(checkout));
  }, []);

  return {
    dataOwner: resolveStripeCheckoutDataOwner(connectedWallet, authenticatedWallet, stripeRecoveryOwner),
    optimisticMintProgress: stripeCheckoutOptimisticMintProgress,
    profileRecoveryPending: stripeCheckoutProfileRecoveryPending,
    recoveredProfile: stripeCheckoutRecoveredProfile,
    anonymousHistory: {
      orders: anonymousStripeDeliveryOrders,
      nextCursor: anonymousStripeHistoryData?.nextCursor ?? null,
      updatedAt: anonymousStripeHistoryUpdatedAt,
      visible: anonymousStripeHistoryVisible,
      initialLoading: anonymousStripeHistoryInitialLoading,
      waitingForFulfillment: anonymousStripeHistoryWaitingForFulfillment,
      error: anonymousStripeHistoryError,
    },
    rememberCheckoutStarted,
  };
}
