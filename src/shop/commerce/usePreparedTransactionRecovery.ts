import { useCallback, useEffect, useRef, type RefObject } from 'react';
import {
  PENDING_PREPARED_TRANSACTION_PREPARING_TTL_MS,
  pendingPreparingTransactionExpired,
  samePendingPreparedTransaction,
  type PendingSubmittedTransaction,
} from '../../lib/pendingPreparedTransactions';
import { reconcileSubmittedTransaction, shortAddress } from '../../lib/solana';
import type { FrontendDeploymentConfig } from '../../config/deployment';
import type { DeliveryOrderSummary } from '../../types';
import type { usePreparedTransactionState } from './usePreparedTransactionState';
import type { useClaimPresentation } from './useClaimPresentation';
import type { CommerceInventoryRefresh, DeliveryRecovery, DropConnection } from './contracts';
import {
  pendingSubmittedTransactionKey,
  DELIVERY_SHIPMENT_REFRESH_INITIAL_DELAY_MS,
  DELIVERY_SHIPMENT_REFRESH_MAX_DELAY_MS,
  DELIVERY_SHIPMENT_REFRESH_TIMEOUT_MS,
  type PendingPreparedResolution,
} from './transactionSupport';

type PreparedRecoveryOptions = {
  prepared: ReturnType<typeof usePreparedTransactionState>;
  connectedWallet: string | undefined;
  requireKnownDropConfig: (dropId: string | undefined, context: string) => FrontendDeploymentConfig;
  connectedWalletRef: RefObject<string | null>;
  ownerRef: RefObject<string | undefined>;
  claimModalGenerationRef: RefObject<number>;
  isViewerMode: boolean;
  suspended: boolean;
  isSignedInWallet: boolean;
  getDropConnection: DropConnection;
  hasAuthenticatedWalletSession: (wallet: string) => boolean;
  profileShipments: DeliveryOrderSummary[];
  hideAssetsForWallet: (wallet: string, ids: readonly string[]) => void;
  runDeliveryRecovery: DeliveryRecovery;
  refetchInventory: CommerceInventoryRefresh;
  refreshProfileState: () => Promise<unknown>;
  showToast: (message: string) => void;
  presentConfirmedNumericClaim: ReturnType<typeof useClaimPresentation>;
};

export function usePreparedTransactionRecovery({
  prepared,
  connectedWallet,
  requireKnownDropConfig,
  connectedWalletRef,
  ownerRef,
  claimModalGenerationRef,
  isViewerMode,
  suspended,
  isSignedInWallet,
  getDropConnection,
  hasAuthenticatedWalletSession,
  profileShipments,
  hideAssetsForWallet,
  runDeliveryRecovery,
  refetchInventory,
  refreshProfileState,
  showToast,
  presentConfirmedNumericClaim,
}: PreparedRecoveryOptions) {
  const {
    pendingPreparedTransaction,
    pendingPreparedSubmissionKeysRef,
    readPendingPreparedTransaction,
    forgetPendingPreparedTransaction,
  } = prepared;
  const pendingPreparedReconciliationsRef = useRef<Map<string, Promise<PendingPreparedResolution>>>(new Map());
  const pendingPreparedRetryTimersRef = useRef<Map<string, number>>(new Map());
  const shipmentRefreshStopsRef = useRef<Set<() => void>>(new Set());
  const shipmentRefreshStopsByTransactionKeyRef = useRef<Map<string, () => void>>(new Map());
  const shipmentRefreshMountedRef = useRef(false);

  const profileShipmentsRef = useRef({ shipments: profileShipments });
  useEffect(() => {
    profileShipmentsRef.current = { shipments: profileShipments };
  }, [profileShipments]);
  useEffect(() => {
    shipmentRefreshMountedRef.current = true;
    return () => {
      shipmentRefreshMountedRef.current = false;
      pendingPreparedRetryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      pendingPreparedRetryTimersRef.current.clear();
      shipmentRefreshStopsRef.current.forEach((stop) => stop());
      shipmentRefreshStopsRef.current.clear();
      shipmentRefreshStopsByTransactionKeyRef.current.clear();
    };
  }, []);

  function reconcilePendingPreparedTransaction(
    record: PendingSubmittedTransaction,
    options: {
      announce?: boolean;
      claimUiIsCurrent?: () => boolean;
      previousReceiptIds?: ReadonlySet<string>;
    } = {},
  ): Promise<PendingPreparedResolution> {
    const key = pendingSubmittedTransactionKey(record);
    const existing = pendingPreparedReconciliationsRef.current.get(key);
    if (existing) return existing;
    const scheduledRetry = pendingPreparedRetryTimersRef.current.get(key);
    if (scheduledRetry !== undefined) {
      window.clearTimeout(scheduledRetry);
      pendingPreparedRetryTimersRef.current.delete(key);
    }

    const run = (async (): Promise<PendingPreparedResolution> => {
      let resolution: PendingPreparedResolution = 'unknown';
      try {
        const connection = getDropConnection(requireKnownDropConfig(record.dropId, 'pending transaction').dropId);
        resolution = await reconcileSubmittedTransaction(
          connection,
          {
            signature: record.signature,
            recentBlockhash: record.recentBlockhash,
            blockhashContextSlot: record.blockhashContextSlot,
          },
          { timeoutMs: 75_000 },
        );
      } catch (err) {
        console.warn(`[mons] failed to reconcile pending ${record.kind} transaction`, err);
      }

      const walletIsCurrent = (
        connectedWalletRef.current === record.wallet &&
        ownerRef.current === record.wallet
      );
      if (resolution === 'confirmed') {
        if (record.kind === 'delivery') hideAssetsForWallet(record.wallet, record.itemIds);
        await forgetPendingPreparedTransaction(record);
        if (record.kind === 'delivery') {
          void runDeliveryRecovery({ dropId: record.dropId, deliveryId: record.deliveryId, force: true });
          await refetchInventory().catch((err) => {
            console.warn('[mons] failed to refresh inventory after pending shipment', err);
          });
          if (options.announce !== false && walletIsCurrent) {
            showToast(`Shipment confirmed · id ${record.deliveryId} · ${shortAddress(record.signature)}`);
          }
        } else {
          presentConfirmedNumericClaim(
            record,
            options.previousReceiptIds,
            options.claimUiIsCurrent,
          );
          if (options.announce !== false && walletIsCurrent) {
            showToast(`Claim confirmed · ${shortAddress(record.signature)}`);
          }
        }
        return resolution;
      }

      if (resolution === 'failed' || resolution === 'expired') {
        if (record.kind === 'delivery') shipmentRefreshStopsByTransactionKeyRef.current.get(key)?.();
        await forgetPendingPreparedTransaction(record);
        if (options.announce !== false && walletIsCurrent) {
          const label = record.kind === 'delivery' ? 'Shipment' : 'Claim';
          showToast(`${label} transaction ${resolution} · you can retry`);
        }
        return resolution;
      }

      if (record.kind === 'delivery') {
        void runDeliveryRecovery({ dropId: record.dropId, deliveryId: record.deliveryId, force: true });
      }
      if (
        typeof window !== 'undefined' &&
        !pendingPreparedRetryTimersRef.current.has(key)
      ) {
        const retry = window.setTimeout(() => {
          pendingPreparedRetryTimersRef.current.delete(key);
          if (
            connectedWalletRef.current !== record.wallet ||
            ownerRef.current !== record.wallet ||
            !hasAuthenticatedWalletSession(record.wallet)
          ) return;
          const current = readPendingPreparedTransaction(record.wallet, false);
          const retryReconciliation = (entry: PendingSubmittedTransaction) => {
            void reconcilePendingPreparedTransaction(entry, {
              ...options,
              announce: false,
            });
          };
          if (current?.phase === 'submitted' && current.signature === record.signature) {
            retryReconciliation(current);
            return;
          }
          if (shipmentRefreshStopsByTransactionKeyRef.current.has(key)) retryReconciliation(record);
        }, 30_000);
        pendingPreparedRetryTimersRef.current.set(key, retry);
      }
      if (options.announce !== false && walletIsCurrent) {
        const label = record.kind === 'delivery' ? 'Shipment' : 'Claim';
        showToast(`${label} confirmation is still pending · do not submit again`);
      }
      return resolution;
    })();

    pendingPreparedReconciliationsRef.current.set(key, run);
    const clearRun = () => {
      if (pendingPreparedReconciliationsRef.current.get(key) === run) {
        pendingPreparedReconciliationsRef.current.delete(key);
      }
    };
    void run.then(clearRun, clearRun);
    return run;
  }

  const startShipmentRefresh = useCallback((
    wallet: string,
    dropId: string,
    deliveryId: number,
    transactionKey?: string,
  ) => {
    if (!shipmentRefreshMountedRef.current) return;
    let refreshDelay = DELIVERY_SHIPMENT_REFRESH_INITIAL_DELAY_MS;
    let retryTimer: number | null = null;
    let deadline: number | null = null;
    let stopped = false;
    const isVisible = () => profileShipmentsRef.current.shipments.some(
      (shipment) => shipment.dropId === dropId && shipment.deliveryId === deliveryId,
    );
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (deadline !== null) {
        window.clearTimeout(deadline);
        deadline = null;
      }
      shipmentRefreshStopsRef.current.delete(stop);
      if (
        transactionKey &&
        shipmentRefreshStopsByTransactionKeyRef.current.get(transactionKey) === stop
      ) {
        shipmentRefreshStopsByTransactionKeyRef.current.delete(transactionKey);
      }
    };
    const refresh = async () => {
      if (stopped) return;
      if (!hasAuthenticatedWalletSession(wallet) || isVisible()) {
        stop();
        return;
      }
      try {
        await refreshProfileState();
      } catch (err) {
        console.warn('[mons] failed to refresh pending shipment', err);
      }
      if (stopped) return;
      if (!hasAuthenticatedWalletSession(wallet) || isVisible()) {
        stop();
        return;
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void refresh();
      }, refreshDelay);
      refreshDelay = Math.min(refreshDelay * 2, DELIVERY_SHIPMENT_REFRESH_MAX_DELAY_MS);
    };
    if (transactionKey) shipmentRefreshStopsByTransactionKeyRef.current.get(transactionKey)?.();
    deadline = window.setTimeout(stop, DELIVERY_SHIPMENT_REFRESH_TIMEOUT_MS);
    shipmentRefreshStopsRef.current.add(stop);
    if (transactionKey) shipmentRefreshStopsByTransactionKeyRef.current.set(transactionKey, stop);
    void refresh();
  }, [hasAuthenticatedWalletSession, refreshProfileState]);

  useEffect(() => {
    const entry = pendingPreparedTransaction;
    if (!connectedWallet || !entry || entry.wallet !== connectedWallet || isViewerMode || suspended) return;
    if (pendingPreparedSubmissionKeysRef.current.has(entry.wallet)) return;
    if (entry.phase === 'preparing') {
      const key = `${entry.wallet}:preparing:${entry.operationId}`;
      if (pendingPreparingTransactionExpired(entry)) {
        forgetPendingPreparedTransaction(entry);
        return;
      }
      if (pendingPreparedRetryTimersRef.current.has(key)) return;
      const retry = window.setTimeout(() => {
        pendingPreparedRetryTimersRef.current.delete(key);
        const current = readPendingPreparedTransaction(entry.wallet);
        if (current && samePendingPreparedTransaction(current, entry) && pendingPreparingTransactionExpired(current)) {
          forgetPendingPreparedTransaction(current);
        }
      }, Math.max(1, entry.createdAt + PENDING_PREPARED_TRANSACTION_PREPARING_TTL_MS - Date.now()));
      pendingPreparedRetryTimersRef.current.set(key, retry);
      return;
    }
    if (!isSignedInWallet) return;
    const claimGeneration = claimModalGenerationRef.current;
    void reconcilePendingPreparedTransaction(entry, {
      claimUiIsCurrent: () => (
        connectedWalletRef.current === entry.wallet &&
        claimModalGenerationRef.current === claimGeneration
      ),
    });
  }, [connectedWallet, isSignedInWallet, isViewerMode, pendingPreparedTransaction, suspended]);

  return { reconcilePendingPreparedTransaction, startShipmentRefresh };
}
