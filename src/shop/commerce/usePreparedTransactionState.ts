import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  forgetPendingPreparedTransaction as forgetStoredPendingPreparedTransaction,
  loadPendingPreparedTransaction,
  pendingDeliveryAssetIds,
  pendingPreparedTransactionStorageKey,
  persistPendingPreparedTransaction,
  replacePendingPreparedTransaction,
  type PendingPreparedTransaction,
  type PendingPreparingClaimTransaction,
  type PendingPreparingDeliveryTransaction,
  type PendingSubmittedTransaction,
} from '../../lib/pendingPreparedTransactions';

export function usePreparedTransactionState(
  connectedWallet: string | undefined,
  connectedWalletRef: RefObject<string | null>,
) {
  const [pendingPreparedTransaction, setPendingPreparedTransaction] = useState<PendingPreparedTransaction | null>(
    () => (connectedWallet ? loadPendingPreparedTransaction(connectedWallet) : null),
  );
  const pendingPreparedTransactionRef = useRef(pendingPreparedTransaction);
  pendingPreparedTransactionRef.current = pendingPreparedTransaction;
  const pendingPreparedSubmissionKeysRef = useRef<Set<string>>(new Set());
  const syncPendingPreparedTransaction = useCallback((entry: PendingPreparedTransaction | null) => {
    pendingPreparedTransactionRef.current = entry;
    setPendingPreparedTransaction(entry);
  }, []);

  const readPendingPreparedTransaction = useCallback((wallet: string, sync = true) => {
    const memory = pendingPreparedTransactionRef.current;
    const stored = loadPendingPreparedTransaction(wallet);
    const entry =
      memory?.wallet === wallet &&
      memory.phase === 'submitted' &&
      (!stored || (
        stored.phase === 'preparing' &&
        stored.kind === memory.kind &&
        stored.operationId === memory.operationId
      ))
        ? memory
        : stored;
    if (sync && connectedWalletRef.current === wallet) {
      syncPendingPreparedTransaction(entry);
    }
    return entry;
  }, [syncPendingPreparedTransaction]);

  const rememberPendingPreparedTransaction = useCallback((entry: PendingPreparedTransaction) => {
    const durable = persistPendingPreparedTransaction(entry);
    if (durable && connectedWalletRef.current === entry.wallet) {
      syncPendingPreparedTransaction(entry);
    }
    return durable;
  }, [syncPendingPreparedTransaction]);

  const submitPendingPreparedTransaction = useCallback((
    preparing: PendingPreparingClaimTransaction | PendingPreparingDeliveryTransaction,
    submitted: PendingSubmittedTransaction,
  ) => {
    const durable = replacePendingPreparedTransaction(preparing, submitted);
    if (durable && connectedWalletRef.current === submitted.wallet) {
      syncPendingPreparedTransaction(submitted);
    }
    return durable;
  }, [syncPendingPreparedTransaction]);

  const forgetPendingPreparedTransaction = useCallback((entry: PendingPreparedTransaction) => {
    const durable = forgetStoredPendingPreparedTransaction(entry);
    if (durable && connectedWalletRef.current === entry.wallet) {
      syncPendingPreparedTransaction(loadPendingPreparedTransaction(entry.wallet));
    }
    return durable;
  }, [syncPendingPreparedTransaction]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const syncFromStorage = (event: StorageEvent) => {
      if (connectedWallet && event.key === pendingPreparedTransactionStorageKey(connectedWallet)) {
        syncPendingPreparedTransaction(loadPendingPreparedTransaction(connectedWallet));
      }
    };
    window.addEventListener('storage', syncFromStorage);
    return () => window.removeEventListener('storage', syncFromStorage);
  }, [connectedWallet, syncPendingPreparedTransaction]);

  useEffect(() => {
    syncPendingPreparedTransaction(
      connectedWallet ? loadPendingPreparedTransaction(connectedWallet) : null,
    );
  }, [connectedWallet, syncPendingPreparedTransaction]);

  const pendingDeliveryItemIds = useMemo(
    () => pendingDeliveryAssetIds(pendingPreparedTransaction, connectedWallet),
    [connectedWallet, pendingPreparedTransaction],
  );

  return {
    pendingPreparedTransaction,
    pendingPreparedSubmissionKeysRef,
    pendingDeliveryItemIds,
    readPendingPreparedTransaction,
    rememberPendingPreparedTransaction,
    submitPendingPreparedTransaction,
    forgetPendingPreparedTransaction,
  };
}
