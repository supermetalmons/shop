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

type DeliveryRecoveryOptions = {
  auth: ReturnType<typeof useSolanaAuth>;
  authenticatedWallet: string | undefined;
  hasAuthenticatedAccount: boolean;
  isViewerMode: boolean;
  currentOwnerDeliveryRecoveryNextCheckAt: number | null;
  refetchInventory: () => Promise<unknown>;
};
export function useDeliveryRecovery({ auth, authenticatedWallet, hasAuthenticatedAccount, isViewerMode, currentOwnerDeliveryRecoveryNextCheckAt, refetchInventory }: DeliveryRecoveryOptions) {
  const { hasAuthenticatedWalletSession, beginDeliveryRecoveryScheduleUpdate, reconcileProfile, refreshProfileState } = auth;
  const deliveryRecoveryRunRef = useRef<WalletScopedSerialRun<RecoverDeliveryOrdersArgs> | null>(null);
  const lastTriggeredDeliveryRecoveryAtRef = useRef<number | null>(null);
  useEffect(() => {
    invalidateWalletScopedSerialRun(deliveryRecoveryRunRef);
    lastTriggeredDeliveryRecoveryAtRef.current = null;
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

          try {
            const result = await recoverMyDeliveryOrders(activeRequest);
            const stillCurrent =
              isCurrentRun() &&
              hasAuthenticatedWalletSession(recoveryWallet);

            if (stillCurrent) {
              const nextCheckAt = walletDeliveryRecoveryNextCheckAt(result);
              if (nextCheckAt === undefined) {
                await reconcileProfile({ includeDeliveryRecovery: true });
              } else {
                commitRecoverySchedule(nextCheckAt);
                void refreshProfileState().catch(() => undefined);
              }
              if (result.attempted > 0 || result.recovered > 0) {
                await refetchInventory().catch(() => undefined);
              }
            }
          } catch (err) {
            console.warn('Delivery recovery failed', err);
            if (
              isCurrentRun() &&
              hasAuthenticatedWalletSession(recoveryWallet)
            ) {
              commitRecoverySchedule(Date.now() + 30_000);
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
      void runDeliveryRecovery();
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
