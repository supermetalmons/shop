import type { RefObject } from 'react';
import type { Connection } from '@solana/web3.js';
import { forgetPendingAdminIrlRedeem } from '../../lib/adminIrlRedeem';
import { reconcileSubmittedTransaction, shortAddress } from '../../lib/solana';
import { receiptReconciliationDisposition, type ReceiptOperation } from '../../lib/receiptTransfer';
import type { CommerceInventoryRefresh, DropConnection } from './contracts';
import type { useReceiptOperationState } from './useReceiptOperationState';
import { RECEIPT_STATUS_CHECK_TIMEOUT_MS } from './transactionSupport';

const DEFAULT_RUNTIME = { reconcileSubmittedTransaction };

type ReceiptReconciliationOptions = {
  receiptState: Pick<ReturnType<typeof useReceiptOperationState>,
    'receiptOperationsRef' | 'receiptOperationGenerationRef' | 'updateReceiptOperation'>;
  connectedWalletRef: RefObject<string | null>;
  getDropConnection: DropConnection;
  refetchInventory: CommerceInventoryRefresh;
  showToast: (message: string) => void;
};

export function useReceiptReconciliation({
  receiptState,
  connectedWalletRef,
  getDropConnection,
  refetchInventory,
  showToast,
}: ReceiptReconciliationOptions, runtime: typeof DEFAULT_RUNTIME = DEFAULT_RUNTIME) {
  const { receiptOperationsRef, receiptOperationGenerationRef, updateReceiptOperation } = receiptState;
  const { reconcileSubmittedTransaction } = runtime;
  const refreshInventoryAfterReceiptReconciliation = () => {
    void refetchInventory()
      .then((result) => {
        if (result.error) {
          console.warn('[mons] failed to refresh inventory after receipt transfer reconciliation', result.error);
        }
      })
      .catch((refreshErr) => {
        console.warn('[mons] failed to refresh inventory after receipt transfer reconciliation', refreshErr);
      });
  };

  const settleReceiptOperation = (
    operation: ReceiptOperation,
    resolution: Awaited<ReturnType<typeof reconcileSubmittedTransaction>>,
    options?: { manual?: boolean; reconciliationError?: unknown },
  ) => {
    const disposition = receiptReconciliationDisposition(resolution);
    const applied = updateReceiptOperation(operation, (current) => {
      if (disposition === 'available') return null;
      return {
        ...current,
        phase: disposition === 'hidden' ? 'hidden' : 'unverified',
      };
    });
    if (!applied) return;
    if (disposition === 'available' && operation.adminFinalizeRequestId) {
      forgetPendingAdminIrlRedeem(operation.wallet, operation.adminFinalizeRequestId);
    }
    if (connectedWalletRef.current !== operation.wallet) return;

    if (disposition === 'hidden') {
      showToast(
        operation.adminFinalizeRequestId
          ? 'Admin IRL transfer confirmed'
          : operation.signature
            ? `Receipt transfer confirmed · ${shortAddress(operation.signature)}`
            : 'Receipt transfer confirmed',
      );
    } else if (disposition === 'available') {
      showToast(
        operation.adminFinalizeRequestId
          ? 'Admin IRL transfer did not complete · receipt restored'
          : 'Receipt transfer did not complete · receipt restored',
      );
    } else {
      console.warn('[mons] receipt transfer confirmation remains unresolved', {
        signature: operation.signature,
        recentBlockhash: operation.recentBlockhash,
        receiptId: operation.assetId,
        adminFinalizeRequestId: operation.adminFinalizeRequestId || null,
        error: options?.reconciliationError,
      });
      showToast(
        options?.manual
          ? 'Receipt transfer status is still unavailable · no new transfer was sent'
          : operation.adminFinalizeRequestId
            ? 'Admin IRL transfer status could not be verified · receipt is view-only for now'
            : 'Receipt transfer status could not be verified · receipt is view-only for now',
      );
    }
    refreshInventoryAfterReceiptReconciliation();
  };

  const reconcilePendingReceiptSubmission = (args: {
    connection: Connection;
    operation: ReceiptOperation;
  }) => {
    if (!args.operation.signature || !args.operation.recentBlockhash) {
      console.warn('[mons] cannot reconcile pending receipt transfer without submission identifiers', {
        receiptId: args.operation.assetId,
        generation: args.operation.generation,
      });
      settleReceiptOperation(args.operation, 'unknown');
      return;
    }
    void reconcileSubmittedTransaction(args.connection, {
      signature: args.operation.signature,
      recentBlockhash: args.operation.recentBlockhash,
    })
      .then((resolution) => {
        settleReceiptOperation(args.operation, resolution);
      })
      .catch((err) => {
        settleReceiptOperation(args.operation, 'unknown', { reconciliationError: err });
      });
  };

  const checkReceiptOperationStatus = (operation: ReceiptOperation) => {
    if (
      operation.phase !== 'unverified' ||
      !operation.signature ||
      !operation.recentBlockhash ||
      connectedWalletRef.current !== operation.wallet
    ) {
      return;
    }
    const started = updateReceiptOperation(operation, (current) => {
      if (current.phase !== 'unverified') return current;
      return {
        ...current,
        generation: ++receiptOperationGenerationRef.current,
        phase: 'checking',
      };
    });
    const checkingOperation = receiptOperationsRef.current.get(operation.key);
    if (
      !started ||
      !checkingOperation ||
      checkingOperation.phase !== 'checking' ||
      checkingOperation.generation === operation.generation ||
      !checkingOperation.signature ||
      !checkingOperation.recentBlockhash
    ) {
      return;
    }
    let statusConnection: Connection;
    try {
      statusConnection = getDropConnection(checkingOperation.dropId);
    } catch (err) {
      settleReceiptOperation(checkingOperation, 'unknown', { manual: true, reconciliationError: err });
      return;
    }
    void reconcileSubmittedTransaction(
      statusConnection,
      {
        signature: checkingOperation.signature,
        recentBlockhash: checkingOperation.recentBlockhash,
      },
      { timeoutMs: RECEIPT_STATUS_CHECK_TIMEOUT_MS },
    )
      .then((resolution) => {
        settleReceiptOperation(checkingOperation, resolution, { manual: true });
      })
      .catch((err) => {
        settleReceiptOperation(checkingOperation, 'unknown', { manual: true, reconciliationError: err });
      });
  };

  return { reconcilePendingReceiptSubmission, checkReceiptOperationStatus };
}
