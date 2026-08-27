import type { FulfillmentManualReviewCheckout } from '../types';

export function formatOrderDate(ts?: number) {
  if (!ts) return 'Date pending';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function formatManualReviewAmount(amountTotal?: number, currency?: string) {
  if (typeof amountTotal !== 'number' || !Number.isFinite(amountTotal)) return 'Amount pending';
  const currencyCode = String(currency || '').trim().toUpperCase();
  const amount = amountTotal / 100;
  if (currencyCode) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amount);
    } catch {
      return `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currencyCode}`;
    }
  }
  return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function shortenStripeSessionId(sessionId: string) {
  const value = String(sessionId || '').trim();
  if (value.length <= 24) return value || 'Session unavailable';
  return `${value.slice(0, 12)}…${value.slice(-6)}`;
}

export function manualReviewCheckoutKey(
  checkout: Pick<FulfillmentManualReviewCheckout, 'dropId' | 'sessionId'>,
): string {
  return `${checkout.dropId}:${checkout.sessionId}`;
}

function manualReviewSortValue(checkout: FulfillmentManualReviewCheckout): number {
  return checkout.failedAt || checkout.createdAt || 0;
}

export function sortManualReviewCheckouts(
  checkouts: readonly FulfillmentManualReviewCheckout[],
): FulfillmentManualReviewCheckout[] {
  return [...checkouts].sort(
    (a, b) =>
      manualReviewSortValue(b) - manualReviewSortValue(a) ||
      a.dropId.localeCompare(b.dropId) ||
      b.sessionId.localeCompare(a.sessionId),
  );
}

export function dedupeManualReviewCheckouts(
  checkouts: readonly FulfillmentManualReviewCheckout[],
): FulfillmentManualReviewCheckout[] {
  const seen = new Set<string>();
  return checkouts.filter((checkout) => {
    const key = manualReviewCheckoutKey(checkout);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function manualReviewIssueText(checkout: FulfillmentManualReviewCheckout): string {
  return checkout.errorMessage || checkout.manualRefundReviewReason || 'Manual review required';
}
