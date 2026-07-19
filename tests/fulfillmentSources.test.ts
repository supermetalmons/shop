import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE as CANONICAL_ADMIN_IRL_REDEEM_SOURCE,
  STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE as CANONICAL_STRIPE_OFFCHAIN_SOURCE,
  isAdminIrlRedeemDeliveryOrderSource,
  isReceiptClaimDeliveryOrderSource as isCanonicalReceiptClaimDeliveryOrderSource,
  isStripeOffchainDeliveryOrderSource,
} from '../functions/src/shared/fulfillmentSources.ts';
import { buildPackStatusCountersFromRebuildInputs } from '../functions/src/shared/packStatus.ts';
import {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
  STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
  isReceiptClaimDeliveryOrderSource,
} from '../functions/src/stripeCheckout/contract.ts';
import {
  ADMIN_IRL_REDEEM_FULFILLMENT_ORDER_SOURCE,
  filterFulfillmentOrdersByVisibility,
  isRedeemedForIrlFulfillmentOrder,
} from '../src/lib/fulfillmentOrderVisibility.ts';

test('legacy delivery-order source exports resolve to the canonical contract', () => {
  assert.equal(
    ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
    CANONICAL_ADMIN_IRL_REDEEM_SOURCE,
  );
  assert.equal(
    ADMIN_IRL_REDEEM_FULFILLMENT_ORDER_SOURCE,
    CANONICAL_ADMIN_IRL_REDEEM_SOURCE,
  );
  assert.equal(
    STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
    CANONICAL_STRIPE_OFFCHAIN_SOURCE,
  );
  assert.equal(
    isReceiptClaimDeliveryOrderSource,
    isCanonicalReceiptClaimDeliveryOrderSource,
  );
});

test('delivery-order source predicates preserve exact unknown and missing behavior', () => {
  assert.equal(
    isAdminIrlRedeemDeliveryOrderSource(CANONICAL_ADMIN_IRL_REDEEM_SOURCE),
    true,
  );
  assert.equal(
    isStripeOffchainDeliveryOrderSource(CANONICAL_STRIPE_OFFCHAIN_SOURCE),
    true,
  );
  assert.equal(
    isCanonicalReceiptClaimDeliveryOrderSource(
      CANONICAL_ADMIN_IRL_REDEEM_SOURCE,
    ),
    true,
  );
  assert.equal(
    isCanonicalReceiptClaimDeliveryOrderSource(
      CANONICAL_STRIPE_OFFCHAIN_SOURCE,
    ),
    true,
  );
  assert.equal(isCanonicalReceiptClaimDeliveryOrderSource('manual_delivery'), false);
  assert.equal(isCanonicalReceiptClaimDeliveryOrderSource(''), false);
  assert.equal(isCanonicalReceiptClaimDeliveryOrderSource(undefined), false);
  assert.equal(isCanonicalReceiptClaimDeliveryOrderSource(null), false);
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
      source: CANONICAL_ADMIN_IRL_REDEEM_SOURCE,
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
        source: CANONICAL_STRIPE_OFFCHAIN_SOURCE,
        metadataIds: [101, 102],
        quantity: 9,
      },
      {
        status: 'ready_to_ship',
        source: CANONICAL_ADMIN_IRL_REDEEM_SOURCE,
        adminIrlRedeem: { targetKind: 'card_receipt' },
        items: [{ kind: 'dude' }],
      },
      {
        status: 'ready_to_ship',
        source: CANONICAL_ADMIN_IRL_REDEEM_SOURCE,
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
