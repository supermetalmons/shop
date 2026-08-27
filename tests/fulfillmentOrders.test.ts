import test from 'node:test';
import assert from 'node:assert/strict';
import type { FulfillmentManualReviewCheckout, FulfillmentOrder } from '../src/types.ts';
import {
  dedupeManualReviewCheckouts,
  formatManualReviewAmount,
  formatOrderDate,
  manualReviewCheckoutKey,
  manualReviewIssueText,
  shortenStripeSessionId,
  sortManualReviewCheckouts,
} from '../src/fulfillment/manualReview.ts';
import {
  canCollapseFulfillmentOrderGroupContact,
  dedupeOrdersByKey,
  fulfillmentOrderKey,
  groupFulfillmentOrders,
  sortFulfillmentOrders,
} from '../src/fulfillment/orders.ts';

function fulfillmentOrder(
  deliveryId: number,
  overrides: Partial<FulfillmentOrder> = {},
): FulfillmentOrder {
  return {
    dropId: 'card_nft_2',
    deliveryId,
    owner: `owner-${deliveryId}`,
    status: 'processed',
    address: {
      email: `owner-${deliveryId}@example.com`,
      full: `Owner ${deliveryId}\n${deliveryId} Main Street\nIstanbul`,
    },
    boxes: [],
    looseDudes: [],
    ...overrides,
  };
}

function manualReviewCheckout(
  dropId: string,
  sessionId: string,
  overrides: Partial<FulfillmentManualReviewCheckout> = {},
): FulfillmentManualReviewCheckout {
  return {
    dropId,
    sessionId,
    owner: `owner-${sessionId}`,
    address: {},
    ...overrides,
  };
}

test('fulfillment orders sort deterministically and dedupe by drop and delivery', () => {
  const latest = fulfillmentOrder(1, { dropId: 'z-drop', processedAt: 300 });
  const tiedDropA3 = fulfillmentOrder(3, { dropId: 'a-drop', createdAt: 200 });
  const tiedDropA1 = fulfillmentOrder(1, { dropId: 'a-drop', createdAt: 200 });
  const tiedDropB = fulfillmentOrder(9, { dropId: 'b-drop', createdAt: 200 });
  const input = [tiedDropA1, tiedDropB, latest, tiedDropA3];

  assert.deepEqual(sortFulfillmentOrders(input), [latest, tiedDropA3, tiedDropA1, tiedDropB]);
  assert.deepEqual(input, [tiedDropA1, tiedDropB, latest, tiedDropA3]);

  const duplicate = fulfillmentOrder(3, { dropId: 'a-drop', owner: 'duplicate-owner' });
  const unseen = fulfillmentOrder(4, { dropId: 'a-drop' });
  assert.deepEqual(
    dedupeOrdersByKey([tiedDropA3, duplicate, tiedDropA1, unseen], new Set([fulfillmentOrderKey(tiedDropA1)])),
    [tiedDropA3, unseen],
  );
});

test('fulfillment grouping preserves page boundaries, owner groups, visibility, and contact collapse', () => {
  const sharedAddress = { email: 'Owner@Example.com', full: 'Owner Name\n12 Main Street\nIstanbul' };
  const pageZeroFirst = fulfillmentOrder(1, { owner: 'shared-owner', address: sharedAddress });
  const pageZeroSecond = fulfillmentOrder(2, {
    owner: 'shared-owner',
    address: { email: ' owner@example.com ', full: 'owner name\r\n12 main street\nistanbul' },
  });
  const pageOneSameOwner = fulfillmentOrder(3, { owner: 'shared-owner', address: sharedAddress });
  const ownerless = fulfillmentOrder(4, { owner: '   ' });
  const hidden = fulfillmentOrder(5, { owner: 'hidden-owner' });
  const orders = [pageZeroFirst, pageZeroSecond, pageOneSameOwner, ownerless, hidden];
  const visibleOrderKeys = new Set(orders.slice(0, 4).map(fulfillmentOrderKey));

  const groups = groupFulfillmentOrders({
    orders,
    pageOrderKeys: [
      [fulfillmentOrderKey(pageZeroFirst), fulfillmentOrderKey(pageZeroSecond)],
      [
        fulfillmentOrderKey(pageOneSameOwner),
        fulfillmentOrderKey(ownerless),
        fulfillmentOrderKey(hidden),
        'missing:99',
      ],
    ],
    visibleOrderKeys,
  });

  assert.deepEqual(
    groups.map((group) => ({
      pageIndex: group.pageIndex,
      groupKey: group.groupKey,
      deliveryIds: group.orders.map((order) => order.deliveryId),
      collapseSharedContact: group.collapseSharedContact,
    })),
    [
      {
        pageIndex: 0,
        groupKey: 'owner:shared-owner',
        deliveryIds: [1, 2],
        collapseSharedContact: true,
      },
      {
        pageIndex: 1,
        groupKey: 'owner:shared-owner',
        deliveryIds: [3],
        collapseSharedContact: false,
      },
      {
        pageIndex: 1,
        groupKey: 'delivery:card_nft_2:4',
        deliveryIds: [4],
        collapseSharedContact: false,
      },
    ],
  );
});

test('contact collapse requires the same normalized name, address, and email', () => {
  const first = fulfillmentOrder(1, {
    address: { email: 'Person@Example.com', full: 'Person Name\n10 Example Road\nLondon' },
  });
  const equivalent = fulfillmentOrder(2, {
    address: { email: ' person@example.com ', full: 'person\u200b name\r\n10 example road\n london ' },
  });

  assert.equal(canCollapseFulfillmentOrderGroupContact([first, equivalent]), true);
  assert.equal(
    canCollapseFulfillmentOrderGroupContact([
      first,
      fulfillmentOrder(3, { address: { ...equivalent.address, email: 'other@example.com' } }),
    ]),
    false,
  );
  assert.equal(canCollapseFulfillmentOrderGroupContact([first, fulfillmentOrder(4, { address: { full: '***' } })]), false);
  assert.equal(canCollapseFulfillmentOrderGroupContact([first]), false);
});

test('manual-review helpers preserve priority, dedupe, issue, and display fallbacks', () => {
  const latest = manualReviewCheckout('z-drop', 'cs_latest', { failedAt: 300 });
  const tiedSessionZ = manualReviewCheckout('a-drop', 'cs_z', { createdAt: 200 });
  const tiedSessionA = manualReviewCheckout('a-drop', 'cs_a', { createdAt: 200 });
  const duplicate = manualReviewCheckout('a-drop', 'cs_z', { errorMessage: 'duplicate' });

  assert.deepEqual(sortManualReviewCheckouts([tiedSessionA, latest, tiedSessionZ]), [latest, tiedSessionZ, tiedSessionA]);
  assert.deepEqual(dedupeManualReviewCheckouts([tiedSessionZ, duplicate, tiedSessionA]), [tiedSessionZ, tiedSessionA]);
  assert.equal(manualReviewCheckoutKey(tiedSessionZ), 'a-drop:cs_z');
  assert.equal(manualReviewIssueText({ ...latest, errorMessage: 'provider failed' }), 'provider failed');
  assert.equal(manualReviewIssueText({ ...latest, manualRefundReviewReason: 'refund review' }), 'refund review');
  assert.equal(manualReviewIssueText(latest), 'Manual review required');
  assert.equal(formatOrderDate(), 'Date pending');
  assert.equal(formatManualReviewAmount(Number.NaN, 'USD'), 'Amount pending');
  assert.equal(shortenStripeSessionId(''), 'Session unavailable');
  assert.equal(shortenStripeSessionId('cs_short'), 'cs_short');
  assert.equal(shortenStripeSessionId('cs_123456789012345678901234567890'), 'cs_123456789…567890');
});
