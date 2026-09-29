import {
  useCallback,
  useEffect,
  useRef
} from 'react';
import {
  recoverMyDeliveryOrders
} from '../../api/commerce';
import { useSolanaAuth } from '../../hooks/useSolanaAuth';
import {
  cappedDeadlineStep,
  invalidateWalletScopedSerialRun,
  runWalletScopedSerial,
  walletDeliveryRecoveryNextCheckAt,
  type WalletScopedSerialRun
} from '../../lib/profileClientLifecycle';
import {
  RecoverDeliveryOrdersArgs
} from '../../types';
import { decodeDeliveryRecoveryCursor } from '../../../shared/deliveryRecoveryPagination';

type DeliveryRecoveryOptions = {
  auth: ReturnType<typeof useSolanaAuth>;
  authenticatedWallet: string | undefined;
  hasAuthenticatedAccount: boolean;
  isViewerMode: boolean;
  currentOwnerDeliveryRecoveryNextCheckAt: number | null;
  refetchInventory: () => Promise<unknown>;
};
type DeliveryRecoveryContinuation = { wallet: string; request: RecoverDeliveryOrdersArgs & { cursor: string } };

export function useDeliveryRecovery(
  { auth, authenticatedWallet, hasAuthenticatedAccount, isViewerMode, currentOwnerDeliveryRecoveryNextCheckAt, refetchInventory }: DeliveryRecoveryOptions,
  recoverOrders = recoverMyDeliveryOrders,
) {
  const { hasAuthenticatedWalletSession, beginDeliveryRecoveryScheduleUpdate, reconcileProfile, refreshProfileState } = auth;
  const deliveryRecoveryRunRef = useRef<WalletScopedSerialRun<RecoverDeliveryOrdersArgs> | null>(null);
  const lastTriggeredDeliveryRecoveryAtRef = useRef<number | null>(null);
  const continuationRef = useRef<DeliveryRecoveryContinuation | null>(null);
  useEffect(() => {
    invalidateWalletScopedSerialRun(deliveryRecoveryRunRef);
    lastTriggeredDeliveryRecoveryAtRef.current = null;
    continuationRef.current = null;
  }, [authenticatedWallet]);
  const runDeliveryRecovery = useCallback(
    async (request: RecoverDeliveryOrdersArgs = {}) => {
      const recoveryWallet = authenticatedWallet;
      if (!recoveryWallet || !hasAuthenticatedAccount || isViewerMode) return;

      return runWalletScopedSerial({
        runRef: deliveryRecoveryRunRef,
        wallet: recoveryWallet,
        request,
        isContextCurrent: () => hasAuthenticatedWalletSession(recoveryWallet),
        execute: async (activeRequest, isCurrentRun) => {
          const commitRecoverySchedule = beginDeliveryRecoveryScheduleUpdate();
          const continuation = continuationRef.current;
          const sameScope = continuation?.wallet === recoveryWallet && activeRequest.deliveryId === undefined &&
            continuation.request.dropId === activeRequest.dropId &&
            (continuation.request.force === true) === (activeRequest.force === true);
          if (!sameScope) continuationRef.current = null;
          const paginated = activeRequest.deliveryId === undefined;
          let cursor = activeRequest.cursor !== undefined ? activeRequest.cursor : sameScope ? continuation!.request.cursor : null;
          let refreshInventory = false;

          try {
            for (let page = 0; page < (paginated ? 2 : 1); page += 1) {
              if (!isCurrentRun() || !hasAuthenticatedWalletSession(recoveryWallet)) return;
              const result = await recoverOrders(paginated ? { ...activeRequest, cursor } : activeRequest);
              if (!isCurrentRun() || !hasAuthenticatedWalletSession(recoveryWallet)) return;
              refreshInventory ||= result.attempted > 0 || result.recovered > 0;
              const nextCursor = paginated ? result.nextCursor : null;
              if (typeof nextCursor === 'string') {
                if (decodeDeliveryRecoveryCursor(nextCursor)?.owner !== recoveryWallet || nextCursor === cursor) {
                  throw new Error('Invalid delivery recovery continuation');
                }
                cursor = nextCursor;
                continuationRef.current = { wallet: recoveryWallet, request: { ...activeRequest, cursor: nextCursor } };
                if (page === 0) continue;
                commitRecoverySchedule(Date.now() + 30_000);
              } else {
                continuationRef.current = null;
                const nextCheckAt = walletDeliveryRecoveryNextCheckAt(result);
                if (nextCheckAt === undefined) {
                  await reconcileProfile({ includeDeliveryRecovery: true });
                } else {
                  commitRecoverySchedule(nextCheckAt);
                }
              }
              if (isCurrentRun() && hasAuthenticatedWalletSession(recoveryWallet)) {
                void refreshProfileState().catch(() => undefined);
              }
              break;
            }
          } catch (err) {
            console.warn('Delivery recovery failed', err);
            if (
              isCurrentRun() &&
              hasAuthenticatedWalletSession(recoveryWallet)
            ) {
              commitRecoverySchedule(Date.now() + 30_000);
            }
          } finally {
            if (refreshInventory && isCurrentRun() && hasAuthenticatedWalletSession(recoveryWallet)) {
              await refetchInventory().catch(() => undefined);
            }
          }
        },
      });
    },
    [
      beginDeliveryRecoveryScheduleUpdate,
      authenticatedWallet,
      hasAuthenticatedAccount,
      hasAuthenticatedWalletSession,
      isViewerMode,
      reconcileProfile,
      refreshProfileState,
      refetchInventory,
      recoverOrders,
    ],
  );

  const scheduledDeliveryRecoveryAt = currentOwnerDeliveryRecoveryNextCheckAt;

  useEffect(() => {
    if (!authenticatedWallet || !hasAuthenticatedAccount || isViewerMode) {
      return;
    }
    if (scheduledDeliveryRecoveryAt == null) {
      lastTriggeredDeliveryRecoveryAtRef.current = null;
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    const runWhenDue = () => {
      if (cancelled) return;
      timeoutId = null;
      const step = cappedDeadlineStep(scheduledDeliveryRecoveryAt, Date.now());
      if (step.kind === 'wait') {
        timeoutId = window.setTimeout(runWhenDue, step.delayMs);
        return;
      }
      if (lastTriggeredDeliveryRecoveryAtRef.current === scheduledDeliveryRecoveryAt) return;
      lastTriggeredDeliveryRecoveryAtRef.current = scheduledDeliveryRecoveryAt;
      const continuation = continuationRef.current;
      void runDeliveryRecovery(continuation?.wallet === authenticatedWallet ? continuation.request : undefined);
    };
    runWhenDue();
    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [authenticatedWallet, hasAuthenticatedAccount, isViewerMode, runDeliveryRecovery, scheduledDeliveryRecoveryAt]);
  useEffect(() => () => invalidateWalletScopedSerialRun(deliveryRecoveryRunRef), []);
  return runDeliveryRecovery;
}
