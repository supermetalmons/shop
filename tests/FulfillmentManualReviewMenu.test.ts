import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createElement } from 'react';
import type { FulfillmentManualReviewCheckout } from '../src/types.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

setupFrontendDom();

const { cleanup, fireEvent, render } = await import('@testing-library/react');
const { FulfillmentManualReviewMenu } = await import('../src/fulfillment/FulfillmentManualReviewMenu.tsx');
const { formatManualReviewAmount, formatOrderDate, shortenStripeSessionId } = await import('../src/fulfillment/manualReview.ts');
type Props = Parameters<typeof FulfillmentManualReviewMenu>[0];

afterEach(cleanup);

function checkout(overrides: Partial<FulfillmentManualReviewCheckout> = {}): FulfillmentManualReviewCheckout {
  return {
    dropId: 'card_nft_2',
    sessionId: 'cs_live_a_very_long_session_identifier',
    owner: 'owner-wallet',
    quantity: 2,
    amountTotal: 1234,
    currency: 'usd',
    createdAt: Date.UTC(2026, 8, 21, 12),
    failedAt: Date.UTC(2026, 8, 22, 12),
    errorMessage: 'Payment needs attention',
    address: { full: 'Ada Example\n123 Main Street', email: 'ada@example.com' },
    ...overrides,
  };
}

function props(overrides: Partial<Props> = {}): Props {
  return {
    checkouts: [],
    showDropId: false,
    hasMore: false,
    loading: false,
    error: null,
    onLoadMore: () => undefined,
    ...overrides,
  };
}

test('an empty page with more results keeps Load more usable', (t) => {
  const onLoadMore = t.mock.fn<Props['onLoadMore']>();
  const view = render(createElement(FulfillmentManualReviewMenu, props({ hasMore: true, onLoadMore })));
  assert.ok(view.getByRole('dialog', { name: 'Needs manual review' }));
  assert.ok(view.getByText('0+ checkouts'));
  const button = view.getByRole('button', { name: 'Load more' });
  assert.equal((button as HTMLButtonElement).disabled, false);
  fireEvent.click(button);
  assert.equal(onLoadMore.mock.callCount(), 1);
});

test('loaded counts retain plus until the final page and preserve checkout details', () => {
  const review = checkout();
  const initial = props({ checkouts: [review], showDropId: true, hasMore: true });
  const view = render(createElement(FulfillmentManualReviewMenu, initial));
  assert.ok(view.getByText('1+ checkouts'));
  const itemText = `2 items · ${formatManualReviewAmount(review.amountTotal, review.currency)}`;
  assert.ok(view.getByText(`card_nft_2 · ${itemText}`));
  assert.ok(view.getByText(formatOrderDate(review.failedAt)));
  assert.ok(view.getByText(shortenStripeSessionId(review.sessionId)));
  assert.ok(view.getByText('owner-wallet'));
  assert.ok(view.getByText('ada@example.com'));
  assert.equal(view.container.querySelector('.manual-review-address')?.textContent, 'Ada Example\n123 Main Street');
  assert.ok(view.getByText('Payment needs attention'));

  view.rerender(createElement(FulfillmentManualReviewMenu, { ...initial, hasMore: false, showDropId: false }));
  assert.ok(view.getByText('1 checkout'));
  assert.ok(view.getByText(itemText));
  assert.equal(view.queryByRole('button'), null);
});

test('loading disables further requests while keeping loaded checkouts visible', (t) => {
  const onLoadMore = t.mock.fn<Props['onLoadMore']>();
  const view = render(createElement(FulfillmentManualReviewMenu, props({
    checkouts: [checkout()], hasMore: true, loading: true, onLoadMore,
  })));
  const button = view.getByRole('button', { name: 'Loading…' });
  assert.equal((button as HTMLButtonElement).disabled, true);
  assert.ok(view.getByText('1+ checkouts'));
  assert.ok(view.getByText('Payment needs attention'));
  fireEvent.click(button);
  assert.equal(onLoadMore.mock.callCount(), 0);
});

test('errors offer Retry even without a continuation page', (t) => {
  const onLoadMore = t.mock.fn<Props['onLoadMore']>();
  const initial = props({ error: 'Review unavailable', onLoadMore });
  const view = render(createElement(FulfillmentManualReviewMenu, initial));
  assert.equal(view.getByRole('alert').textContent, 'Review unavailable');
  const retry = view.getByRole('button', { name: 'Retry' });
  assert.equal((retry as HTMLButtonElement).disabled, false);
  fireEvent.click(retry);
  assert.equal(onLoadMore.mock.callCount(), 1);

  view.rerender(createElement(FulfillmentManualReviewMenu, { ...initial, loading: true }));
  assert.equal((view.getByRole('button', { name: 'Loading…' }) as HTMLButtonElement).disabled, true);
  assert.equal(view.getByRole('alert').textContent, 'Review unavailable');
});

test('masked addresses show only their country and never expose contact email', () => {
  const review = checkout({ address: { full: '***', countryCode: 'US', email: 'hidden@example.com' } });
  const initial = props({ checkouts: [review] });
  const view = render(createElement(FulfillmentManualReviewMenu, initial));
  assert.equal(view.container.querySelector('.manual-review-address')?.textContent, 'United States');
  assert.equal(view.queryByText('hidden@example.com'), null);
  assert.equal(view.container.querySelector('.manual-review-contact'), null);

  view.rerender(createElement(FulfillmentManualReviewMenu, {
    ...initial,
    checkouts: [checkout({ address: { full: '***', email: 'hidden@example.com' } })],
  }));
  assert.equal(view.container.querySelector('.manual-review-address')?.textContent, '***');
  assert.equal(view.queryByText('hidden@example.com'), null);
});

test('pending values and identity and reason fallbacks stay readable', () => {
  const view = render(createElement(FulfillmentManualReviewMenu, props({ checkouts: [checkout({
    owner: '', authSubject: 'anonymous-customer', quantity: undefined, amountTotal: undefined,
    createdAt: undefined, failedAt: undefined, errorMessage: undefined,
    manualRefundReviewReason: 'Needs a refund', address: {},
  })] })));
  assert.ok(view.getByText('Quantity pending · Amount pending'));
  assert.ok(view.getByText('Date pending'));
  assert.ok(view.getByText('anonymous-customer'));
  assert.ok(view.getByText('Needs a refund'));
  assert.ok(view.getByText('Address unavailable'));
});
