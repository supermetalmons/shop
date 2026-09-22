import type { FulfillmentManualReviewCheckout } from '../types';
import { formatFulfillmentAddressText } from '../lib/fulfillmentExports';
import {
  formatManualReviewAmount,
  formatOrderDate,
  manualReviewCheckoutKey,
  manualReviewIssueText,
  shortenStripeSessionId,
} from './manualReview';

type FulfillmentManualReviewMenuProps = {
  checkouts: readonly FulfillmentManualReviewCheckout[];
  showDropId: boolean;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  onLoadMore: () => void | Promise<void>;
};

export function FulfillmentManualReviewMenu({
  checkouts,
  showDropId,
  hasMore,
  loading,
  error,
  onLoadMore,
}: FulfillmentManualReviewMenuProps) {
  const count = `${checkouts.length}${hasMore ? '+' : ''}`;
  return (
    <div className="manual-review-menu" role="dialog" aria-label="Needs manual review">
      <div className="manual-review-menu__head">
        <div className="manual-review-menu__title">Needs manual review</div>
        <div className="muted small">
          {count} {checkouts.length === 1 && !hasMore ? 'checkout' : 'checkouts'}
        </div>
      </div>
      <div className="manual-review-menu__list">
        {checkouts.map((checkout) => {
          const addressText = formatFulfillmentAddressText(checkout.address);
          const contactEmail = checkout.address.full !== '***' ? checkout.address.email : '';
          const quantityText = typeof checkout.quantity === 'number' ? `${checkout.quantity} item${checkout.quantity === 1 ? '' : 's'}` : 'Quantity pending';
          const ownerText = checkout.owner || checkout.authSubject || 'Owner unavailable';
          return (
            <div key={manualReviewCheckoutKey(checkout)} className="manual-review-row">
              <div className="manual-review-row__top">
                <div className="manual-review-row__title">
                  {showDropId ? `${checkout.dropId} · ` : ''}
                  {quantityText} · {formatManualReviewAmount(checkout.amountTotal, checkout.currency)}
                </div>
                <div className="muted small">{formatOrderDate(checkout.failedAt || checkout.createdAt)}</div>
              </div>
              <div className="manual-review-row__meta">
                <span className="mono small">{shortenStripeSessionId(checkout.sessionId)}</span>
                <span className="mono small">{ownerText}</span>
              </div>
              {contactEmail ? <div className="manual-review-contact small">{contactEmail}</div> : null}
              <div className="manual-review-address small">{addressText || 'Address unavailable'}</div>
              <div className="manual-review-reason small">{manualReviewIssueText(checkout)}</div>
            </div>
          );
        })}
      </div>
      <div className="manual-review-menu__footer">
        {error ? <div className="small" role="alert">{error}</div> : null}
        {hasMore || error || loading ? (
          <button type="button" disabled={loading} onClick={() => { void onLoadMore(); }}>
            {loading ? 'Loading…' : error ? 'Retry' : 'Load more'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
