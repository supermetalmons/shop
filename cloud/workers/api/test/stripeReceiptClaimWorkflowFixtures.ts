import type { StripeReceiptClaimResult } from '../../../../shared/contracts.js';
import type { ReceiptClaimWorkflowSnapshot, ReceiptClaimWorkflowSubmission } from '../src/stripeReceiptClaimWorkflowState.js';

export const RECEIPT_OPERATION_ID = 'src-v1-123e4567-e89b-42d3-a456-426614174000';
export const RECEIPT_REQUEST_ID = '123e4567-e89b-42d3-a456-426614174001';
export const RECEIPT_RETRY_ID = '123e4567-e89b-42d3-a456-426614174002';
export const RECEIPT_RECIPIENT = '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM';
export const RECEIPT_RESULT: StripeReceiptClaimResult = {
  processed: true, dropId: 'card_nft_2', deliveryId: 1, receiptTxs: ['signature'], receiptKind: 'box', receiptsTransferred: 1,
};

export function receiptWorkflowSnapshot(): ReceiptClaimWorkflowSnapshot {
  const started = {
    status: 'started' as const,
    dropId: 'card_nft_2', deliveryId: 1, boxId: 1,
    attemptId: `${RECEIPT_OPERATION_ID}-g1`,
    orderPath: 'drops/card_nft_2/deliveryOrders/1',
    orderIrlClaims: [], resumingPreviousProcessingClaim: false,
    hasPreviousClaimFailure: false, updatePluralOrderClaim: false, updateSingularOrderClaim: true,
    receiptTxs: [], receiptTxSubmissions: [],
  };
  return {
    code: 'ABCDEF-1234567890', started,
    operation: {
      version: 1, operationId: RECEIPT_OPERATION_ID, requestId: RECEIPT_REQUEST_ID,
      requestIds: [RECEIPT_REQUEST_ID],
      generation: 1, recipient: RECEIPT_RECIPIENT, phase: 'pending', createdAtMs: 1000,
      deadlineAtMs: 901000, nextAttemptAtMs: 1000, dispatchLeaseUntilMs: null,
      claim: started, submissionHistory: [],
    },
  };
}

export function receiptWorkflowSubmission(): ReceiptClaimWorkflowSubmission {
  return {
    signature: 'signature', signedTransactionBase64: 'signed-bytes', blockhash: 'blockhash',
    lastValidBlockHeight: 100, preparedAtMs: 1000, status: 'prepared',
    target: {
      flow: 'legacy_pack', receiptAssetId: 'asset', figureIds: [], dropId: 'card_nft_2', network: 'mainnet-beta',
      programId: 'program', collectionMint: 'collection', receiptsMerkleTree: 'tree', adminWallet: 'admin',
    },
  };
}
