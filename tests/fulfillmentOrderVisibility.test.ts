import test from 'node:test';
import assert from 'node:assert/strict';
import type { FulfillmentOrder } from '../src/types.ts';
import {
  ADMIN_IRL_REDEEM_FULFILLMENT_ORDER_SOURCE,
  filterFulfillmentOrdersByVisibility,
  isRedeemedForIrlFulfillmentOrder,
} from '../src/lib/fulfillmentOrderVisibility.ts';

type TestOrder = Pick<FulfillmentOrder, 'source' | 'fulfillmentStatus'> & { deliveryId: number };

const orders: TestOrder[] = [
  { deliveryId: 1, fulfillmentStatus: 'Preparing' },
  { deliveryId: 2, fulfillmentStatus: 'Shipped' },
  { deliveryId: 3 },
  { deliveryId: 4, source: ADMIN_IRL_REDEEM_FULFILLMENT_ORDER_SOURCE, fulfillmentStatus: 'Preparing' },
  { deliveryId: 5, source: ADMIN_IRL_REDEEM_FULFILLMENT_ORDER_SOURCE, fulfillmentStatus: 'Shipped' },
];

function visibleOrderIds(filter: Parameters<typeof filterFulfillmentOrdersByVisibility>[1]): number[] {
  return filterFulfillmentOrdersByVisibility(orders, filter).map((order) => order.deliveryId);
}

test('fulfillment order visibility isolates IRL redemptions from every standard list', () => {
  assert.deepEqual(visibleOrderIds('not_shipped'), [1, 3]);
  assert.deepEqual(visibleOrderIds('shipped'), [2]);
  assert.deepEqual(visibleOrderIds('all'), [1, 2, 3]);
});

test('Redeemed for IRL includes redeemed orders regardless of fulfillment status', () => {
  assert.deepEqual(visibleOrderIds('redeemed_for_irl'), [4, 5]);
});

test('IRL redemption detection uses the canonical delivery order source', () => {
  assert.equal(isRedeemedForIrlFulfillmentOrder(orders[3]), true);
  assert.equal(isRedeemedForIrlFulfillmentOrder({ source: 'Admin IRL event' }), false);
  assert.equal(isRedeemedForIrlFulfillmentOrder({}), false);
});
