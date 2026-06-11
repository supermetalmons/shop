import type { FulfillmentOrderBox } from '../types';

export function fulfillmentBoxSecretCode(
  box: Pick<FulfillmentOrderBox, 'receiptClaimCode' | 'claimCode'>,
): string {
  const receiptClaimCode = String(box.receiptClaimCode || '').trim();
  if (receiptClaimCode) return receiptClaimCode;
  return String(box.claimCode || '').trim();
}
