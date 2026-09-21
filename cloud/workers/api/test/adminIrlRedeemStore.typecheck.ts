import { commerceKeys } from '../src/commerceRepository.js';
import {
  createPreparedRequest,
  deletePreparedRequestAtRevision,
  persistPendingFinalizeSubmission,
  recordCloseDelivery,
  recordInternalDelivery,
  settlePendingFinalizeSubmission,
} from '../src/adminIrlRedeemRequestStore.js';

function commandTypeContracts(context: Parameters<typeof recordInternalDelivery>[0]): void {
  const request = commerceKeys.adminIrlRedeemRequest('drop', 'request');
  const order = commerceKeys.deliveryOrder('drop', '1');
  void recordInternalDelivery(context, request, 'attempt', { deliveryId: 1, deliveryPda: 'pda' });
  void recordCloseDelivery(context, request, 'attempt', 'signature');
  void deletePreparedRequestAtRevision(context, request, 'revision');

  // @ts-expect-error Only Admin IRL request keys can record processing progress.
  void recordInternalDelivery(context, order, 'attempt', { deliveryId: 1, deliveryPda: 'pda' });
  // @ts-expect-error Progress commands cannot alter request status.
  void recordInternalDelivery(context, request, 'attempt', { deliveryId: 1, deliveryPda: 'pda', status: 'complete' });
  // @ts-expect-error Closing a delivery accepts a signature, not an arbitrary patch.
  void recordCloseDelivery(context, request, 'attempt', { closeDeliveryTx: 'signature', owner: 'wallet' });
  // @ts-expect-error Prepared cleanup cannot delete an order document.
  void deletePreparedRequestAtRevision(context, order, 'revision');
  // @ts-expect-error Internal-delivery submissions require the complete identity.
  void persistPendingFinalizeSubmission(context, request, 'attempt', { kind: 'internal_delivery', signature: 'signature', blockhash: 'blockhash' });
  // @ts-expect-error An unresolved submission cannot be settled.
  void settlePendingFinalizeSubmission(context, request, 'attempt', { kind: 'receipt_mint', signature: 'signature', blockhash: 'blockhash', assetIds: ['asset'] }, 'unresolved');
  const input: Parameters<typeof createPreparedRequest>[1] = {
    dropId: 'drop', requestId: 'request', owner: 'wallet', adminWallet: 'admin',
    targetKind: 'pack', itemIds: ['asset'], items: [{ assetId: 'asset', kind: 'box', refId: 1 }],
    // @ts-expect-error Preparation chooses its own initial status.
    status: 'complete',
  };
  void input;
}

void commandTypeContracts;
