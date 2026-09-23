import type { VersionedTransaction } from '@solana/web3.js';
import type { ReceiptOperation } from '../../lib/receiptTransfer';
import type { useReceiptOperationState } from './useReceiptOperationState';

type ReceiptTrackerState = Pick<ReturnType<typeof useReceiptOperationState>,
  'beginReceiptOperation' | 'recordReceiptSubmission' | 'resetReceiptSubmissionForRetry'>;

export function createReceiptOperationTracker(
  state: ReceiptTrackerState,
  identity: Parameters<ReceiptTrackerState['beginReceiptOperation']>[0],
) {
  let operation = state.beginReceiptOperation(identity);

  return {
    get operation() { return operation; },
    recordSubmission({
      phase,
      signature,
      transaction,
      adminFinalizeRequestId,
    }: {
      phase: Extract<ReceiptOperation['phase'], 'in-flight' | 'hidden'>;
      signature: string;
      transaction: VersionedTransaction;
      adminFinalizeRequestId?: string;
    }): boolean {
      const recorded = state.recordReceiptSubmission(operation, {
        phase,
        signature,
        recentBlockhash: transaction.message.recentBlockhash,
        ...(adminFinalizeRequestId === undefined ? {} : { adminFinalizeRequestId }),
      });
      operation = recorded.operation;
      return recorded.applied;
    },
    resetForRetry() {
      operation = state.resetReceiptSubmissionForRetry(operation) ?? operation;
    },
  };
}
