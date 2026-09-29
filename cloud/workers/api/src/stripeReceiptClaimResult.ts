import type { StripeReceiptClaimResult } from '../../../../shared/contracts.js';
import { BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX } from '../../../../shared/boxMinterProtocol.js';
import type { ProviderContext } from './adminIrlRedeemOnchain.js';
import { raceWithSignal } from './boundedRequest.js';
import type { CommerceRepositoryContext as CommerceContext } from './commerceTransactions.js';
import { loadClaimAssignment, type ReceiptKind, type startClaim } from './stripeReceiptClaimStore.js';
import { ownsAllFigureReceipts, runtimeForDrop } from './stripeReceiptClaimOnchain.js';

export function responseForClaim(args: {
  dropId: string;
  deliveryId: number;
  receiptTxs: string[];
  receiptKind?: ReceiptKind;
  receiptsTransferred?: number;
  figureIds?: number[];
  receiptAssetIds?: string[];
}): StripeReceiptClaimResult {
  const figureIds = args.figureIds?.length ? args.figureIds : undefined;
  const receiptAssetIds = Array.from(new Set((args.receiptAssetIds || []).map((value) => value.trim()).filter(Boolean)));
  const receiptsTransferred = args.receiptsTransferred && args.receiptsTransferred > 0
    ? args.receiptsTransferred
    : args.receiptKind === 'figure' && figureIds ? figureIds.length : 1;
  return {
    processed: true,
    dropId: args.dropId,
    deliveryId: args.deliveryId,
    receiptsTransferred,
    receiptTxs: args.receiptTxs,
    ...(args.receiptKind ? { receiptKind: args.receiptKind } : {}),
    ...(figureIds ? { figureIds } : {}),
    ...(receiptAssetIds.length ? { receiptAssetIds } : {}),
  };
}

export async function responseForAlreadyClaimed(
  commerce: CommerceContext,
  claim: Extract<Awaited<ReturnType<typeof startClaim>>, { status: 'already_claimed' }>,
  recipient: string,
  provider?: ProviderContext,
): Promise<StripeReceiptClaimResult> {
  if (claim.receiptKind) return responseForClaim(claim);
  let runtime: ReturnType<typeof runtimeForDrop> | null = null;
  try { runtime = runtimeForDrop(claim.dropId); }
  catch {}
  if (provider && runtime && runtime.itemsPerBox >= BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX) {
    try {
      const assignment = await raceWithSignal(loadClaimAssignment(commerce, {
        dropId: claim.dropId,
        deliveryId: claim.deliveryId,
        boxId: claim.boxId,
        itemsPerBox: runtime.itemsPerBox,
        maxDudeId: runtime.maxDudeId,
      }), provider.signal);
      if (assignment && await ownsAllFigureReceipts(provider, recipient, runtime, assignment.dudeIds)) {
        return responseForClaim({
          dropId: claim.dropId,
          deliveryId: claim.deliveryId,
          receiptTxs: claim.receiptTxs,
          receiptKind: 'figure',
          receiptsTransferred: assignment.dudeIds.length,
          figureIds: assignment.dudeIds,
        });
      }
    } catch {}
  }
  return responseForClaim({
    dropId: claim.dropId,
    deliveryId: claim.deliveryId,
    receiptTxs: claim.receiptTxs,
    ...(runtime ? { receiptKind: 'box' as const } : {}),
  });
}
