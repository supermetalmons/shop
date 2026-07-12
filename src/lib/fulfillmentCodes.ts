import type { FulfillmentOrder, FulfillmentOrderBox, FulfillmentOrderCardClaim } from '../types';

export function fulfillmentBoxSecretCode(
  box: Pick<FulfillmentOrderBox, 'receiptClaimCode' | 'claimCode'>,
): string {
  const receiptClaimCode = String(box.receiptClaimCode || '').trim();
  if (receiptClaimCode) return receiptClaimCode;
  return String(box.claimCode || '').trim();
}

export function isUsedReceiptClaimStatus(status: string | undefined): boolean {
  return status === 'processing' || status === 'claimed';
}

export function fulfillmentCardClaimSecretCode(
  claim: Pick<FulfillmentOrderCardClaim, 'receiptClaimCode'>,
): string {
  return String(claim.receiptClaimCode || '').trim();
}

function subtractFigureIdOccurrences(values: readonly number[], removals: Iterable<number>): number[] {
  const remainingRemovalCounts = new Map<number, number>();
  for (const figureId of removals) {
    remainingRemovalCounts.set(figureId, (remainingRemovalCounts.get(figureId) || 0) + 1);
  }

  return values.filter((figureId) => {
    const remaining = remainingRemovalCounts.get(figureId) || 0;
    if (!remaining) return true;
    if (remaining === 1) remainingRemovalCounts.delete(figureId);
    else remainingRemovalCounts.set(figureId, remaining - 1);
    return false;
  });
}

export function fulfillmentLooseFigureIdsExcludingCardClaims(
  order: Pick<FulfillmentOrder, 'looseDudes' | 'cardClaims'>,
): number[] {
  return subtractFigureIdOccurrences(
    order.looseDudes,
    (order.cardClaims || []).map((claim) => claim.figureId),
  );
}

export function fulfillmentOrderLooseFigureIds(
  order: Pick<FulfillmentOrder, 'looseDudes' | 'cardClaims'>,
): number[] {
  const cardClaimFigureIds = (order.cardClaims || []).map((claim) => claim.figureId);
  const missingClaimFigureIds = subtractFigureIdOccurrences(cardClaimFigureIds, order.looseDudes);
  return [...order.looseDudes, ...missingClaimFigureIds];
}
