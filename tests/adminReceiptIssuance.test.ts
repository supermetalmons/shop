import assert from 'node:assert/strict';
import test from 'node:test';
import { fulfillmentOrderFromRecord } from '../shared/fulfillmentReadModel.ts';
import {
  ADMIN_RECEIPT_ISSUANCE_DELIVERY_ORDER_SOURCE,
  isAdminIrlRedeemDeliveryOrderSource,
  isInternalReceiptDeliveryOrderSource,
  isReceiptClaimDeliveryOrderSource,
  isStripeOffchainDeliveryOrderSource,
} from '../shared/fulfillmentSources.ts';
import { canEditFulfillmentOrderAddress, filterFulfillmentOrdersByVisibility } from '../src/lib/fulfillmentOrderVisibility.ts';

test('manual binder receipts remain visible for packing with their own label and claim codes', () => {
  const source = ADMIN_RECEIPT_ISSUANCE_DELIVERY_ORDER_SOURCE;
  assert.equal(isReceiptClaimDeliveryOrderSource(source), true);
  assert.equal(isInternalReceiptDeliveryOrderSource(source), true);
  assert.equal(isAdminIrlRedeemDeliveryOrderSource(source), false);
  assert.equal(isStripeOffchainDeliveryOrderSource(source), false);
  const codes = ['ABCDEF-1234567890', 'UVWXYZ-1234567890'];
  const order = fulfillmentOrderFromRecord('7', {
    source, deliveryId: 7, status: 'ready_to_ship', fulfillmentStatus: 'Preparing',
    items: [{ kind: 'box', refId: 21 }, { kind: 'box', refId: 22 }],
    stripeReceiptClaimsByBoxId: {
      box_21: { code: codes[0], boxId: 21, status: 'unclaimed' },
      box_22: { code: codes[1], boxId: 22, status: 'unclaimed' },
    },
    addressSnapshot: { email: 'private@example.com', phone: '+123', encrypted: 'private' },
  }, {
    dropId: 'card_nft_binder', canViewSensitiveAddress: true,
    decryptAddress: () => { throw new Error('Internal packing orders have no shipping address'); },
  });
  assert.ok(order);
  assert.equal(order.address.full, 'Packing replacements');
  assert.equal(order.address.label, 'Packing replacements');
  assert.equal(order.address.email, undefined);
  assert.equal(order.address.phone, undefined);
  assert.equal(order.address.encrypted, undefined);
  assert.deepEqual(order.boxes.map((box) => box.receiptClaimCode), codes);
  for (const filter of ['all', 'not_shipped'] as const) {
    assert.deepEqual(filterFulfillmentOrdersByVisibility([order], filter), [order]);
  }
  assert.deepEqual(filterFulfillmentOrdersByVisibility([order], 'redeemed_for_irl'), []);
  assert.equal(canEditFulfillmentOrderAddress(order, { showFullAddress: true, hasAddressAccess: true }), false);
});
