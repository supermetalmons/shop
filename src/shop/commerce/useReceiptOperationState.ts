import { useCallback, useMemo, useRef, useState } from 'react';
import {
  canonicalReceiptPublicKey,
  rebaseReceiptOperationsAfterWalletChange,
  removeReceiptOperationsForAssets,
  receiptOperationAssetIds,
  receiptOperationKey,
  setReceiptOperation,
  transitionReceiptOperation,
  type ReceiptOperation,
  type ReceiptOperationRegistry,
} from '../../lib/receiptTransfer';

import { RECEIPT_HIDDEN_OPERATION_PHASES } from './transactionSupport';

export function useReceiptOperationState(connectedWallet: string | undefined) {
  const [receiptOperations, setReceiptOperations] = useState<ReceiptOperationRegistry>(() => new Map());
  const receiptOperationsRef = useRef<ReceiptOperationRegistry>(receiptOperations);
  const receiptOperationGenerationRef = useRef(0);
  const updateReceiptOperations = useCallback(
    (update: (current: ReceiptOperationRegistry) => ReceiptOperationRegistry) => {
      const current = receiptOperationsRef.current;
      const next = update(current);
      if (next === current) return;
      receiptOperationsRef.current = next;
      setReceiptOperations(next);
    },
    [],
  );

  const beginReceiptOperation = useCallback(
    (args: { wallet: string; assetId: string; dropId: string }): ReceiptOperation => {
      const wallet = canonicalReceiptPublicKey(args.wallet);
      const assetId = canonicalReceiptPublicKey(args.assetId);
      if (!wallet || !assetId) throw new Error('Invalid receipt operation identity');
      const operation: ReceiptOperation = {
        key: receiptOperationKey(wallet, assetId),
        wallet,
        assetId,
        dropId: args.dropId,
        createdGeneration: ++receiptOperationGenerationRef.current,
        generation: receiptOperationGenerationRef.current,
        phase: 'in-flight',
      };
      updateReceiptOperations((current) => setReceiptOperation(current, operation));
      return operation;
    },
    [updateReceiptOperations],
  );

  const updateReceiptOperation = useCallback(
    (
      operation: Pick<ReceiptOperation, 'key' | 'generation'>,
      update: (current: ReceiptOperation) => ReceiptOperation | null,
    ): boolean => {
      let applied = false;
      updateReceiptOperations((current) =>
        transitionReceiptOperation(current, operation.key, operation.generation, (entry) => {
          const replacement = update(entry);
          applied = replacement !== entry;
          return replacement;
        }),
      );
      return applied;
    },
    [updateReceiptOperations],
  );
  const recordReceiptSubmission = useCallback(
    (
      operation: ReceiptOperation,
      submission: {
        phase: Extract<ReceiptOperation['phase'], 'in-flight' | 'hidden'>;
        signature: string;
        recentBlockhash: string;
        adminFinalizeRequestId?: string;
      },
    ): { operation: ReceiptOperation; applied: boolean } => {
      const nextOperation = { ...operation, ...submission };
      const applied = updateReceiptOperation(operation, () => nextOperation);
      return { operation: nextOperation, applied };
    },
    [updateReceiptOperation],
  );
  const resetReceiptSubmissionForRetry = useCallback(
    (operation: ReceiptOperation): ReceiptOperation | null => {
      const nextOperation: ReceiptOperation = {
        ...operation,
        phase: 'in-flight',
        signature: undefined,
        recentBlockhash: undefined,
        adminFinalizeRequestId: undefined,
      };
      return updateReceiptOperation(operation, () => nextOperation) ? nextOperation : null;
    },
    [updateReceiptOperation],
  );
  const isReceiptOperationCurrent = useCallback(
    (operation: ReceiptOperation | null): boolean => Boolean(
      operation && receiptOperationsRef.current.get(operation.key)?.generation === operation.generation,
    ),
    [],
  );
  const clearAuthoritativelyReturnedReceiptOperations = useCallback(
    (wallet: string, assetIds: readonly string[], maximumCreatedGeneration: number) => {
      updateReceiptOperations((current) =>
        removeReceiptOperationsForAssets(current, wallet, assetIds, maximumCreatedGeneration),
      );
    },
    [updateReceiptOperations],
  );
  const receiptOperationHiddenAssets = useMemo(
    () => receiptOperationAssetIds(receiptOperations, connectedWallet, RECEIPT_HIDDEN_OPERATION_PHASES),
    [connectedWallet, receiptOperations],
  );

  const rebaseReceiptOperations = useCallback((wallet: string) => {
    updateReceiptOperations((current) => {
      const rebased = rebaseReceiptOperationsAfterWalletChange(current, wallet, receiptOperationGenerationRef.current);
      receiptOperationGenerationRef.current = rebased.lastGeneration;
      return rebased.registry;
    });
  }, [updateReceiptOperations]);

  return {
    receiptOperations,
    receiptOperationsRef,
    receiptOperationGenerationRef,
    receiptOperationHiddenAssets,
    beginReceiptOperation,
    updateReceiptOperation,
    recordReceiptSubmission,
    resetReceiptSubmissionForRetry,
    isReceiptOperationCurrent,
    clearAuthoritativelyReturnedReceiptOperations,
    rebaseReceiptOperations,
  };
}
