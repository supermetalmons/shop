import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
  STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
  isAdminIrlRedeemDeliveryOrderSource,
  isReceiptClaimDeliveryOrderSource,
  isStripeOffchainDeliveryOrderSource,
} from '../shared/fulfillmentSources.ts';
import { buildPackStatusCountersFromRebuildInputs } from '../shared/packStatus.ts';
import {
  filterFulfillmentOrdersByVisibility,
  isRedeemedForIrlFulfillmentOrder,
} from '../src/lib/fulfillmentOrderVisibility.ts';

test('delivery-order source predicates preserve exact unknown and missing behavior', () => {
  assert.equal(
    isAdminIrlRedeemDeliveryOrderSource(ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE),
    true,
  );
  assert.equal(
    isStripeOffchainDeliveryOrderSource(STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE),
    true,
  );
  assert.equal(
    isReceiptClaimDeliveryOrderSource(
      ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
    ),
    true,
  );
  assert.equal(
    isReceiptClaimDeliveryOrderSource(
      STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
    ),
    true,
  );
  assert.equal(isReceiptClaimDeliveryOrderSource('manual_delivery'), false);
  assert.equal(isReceiptClaimDeliveryOrderSource(''), false);
  assert.equal(isReceiptClaimDeliveryOrderSource(undefined), false);
  assert.equal(isReceiptClaimDeliveryOrderSource(null), false);
});

test('frontend visibility still isolates only canonical Admin IRL orders', () => {
  const orders: ReadonlyArray<{
    deliveryId: number;
    fulfillmentStatus: 'Preparing' | 'Shipped';
    source?: string;
  }> = [
    { deliveryId: 1, fulfillmentStatus: 'Preparing' },
    {
      deliveryId: 2,
      source: 'manual_delivery',
      fulfillmentStatus: 'Shipped',
    },
    {
      deliveryId: 3,
      source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
      fulfillmentStatus: 'Preparing',
    },
  ];

  assert.deepEqual(
    filterFulfillmentOrdersByVisibility(orders, 'all').map(
      (order) => order.deliveryId,
    ),
    [1, 2],
  );
  assert.deepEqual(
    filterFulfillmentOrdersByVisibility(orders, 'redeemed_for_irl').map(
      (order) => order.deliveryId,
    ),
    [3],
  );
  assert.equal(isRedeemedForIrlFulfillmentOrder(orders[2]), true);
  assert.equal(isRedeemedForIrlFulfillmentOrder(orders[1]), false);
  assert.equal(isRedeemedForIrlFulfillmentOrder(orders[0]), false);
});

test('pack rebuild keeps Stripe quantity and Admin IRL card exclusion behavior', () => {
  const counters = buildPackStatusCountersFromRebuildInputs({
    dropRuntime: {
      dropId: 'card_nft_2',
      cluster: 'mainnet-beta',
      itemsPerBox: 3,
      maxSupply: 10,
    },
    assignmentCount: 0,
    irlClaimAssignmentCount: 0,
    adminIrlAssignmentCount: 0,
    inFlightNormalAssignments: 0,
    deliveryOrders: [
      {
        status: 'ready_to_ship',
        source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
        metadataIds: [101, 102],
        quantity: 9,
      },
      {
        status: 'ready_to_ship',
        source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
        adminIrlRedeem: { targetKind: 'card_receipt' },
        items: [{ kind: 'dude' }],
      },
      {
        status: 'ready_to_ship',
        source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
        adminIrlRedeem: { targetKind: 'pack' },
        items: [{ kind: 'box' }],
      },
      {
        status: 'ready_to_ship',
        source: 'manual_delivery',
        items: [{ kind: 'box' }, { kind: 'dude' }],
      },
      {
        status: 'ready_to_ship',
        items: [{ kind: 'box' }],
      },
    ],
  });

  assert.equal(counters.redeemedIrlStripe, 2);
  assert.equal(counters.redeemedIrlNormal, 3);
  assert.equal(counters.redeemedUnsealedCards, 1);
});
