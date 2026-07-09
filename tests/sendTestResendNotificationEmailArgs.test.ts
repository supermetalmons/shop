import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryOrderById, parseArgs } from '../functions/scripts/sendTestResendNotificationEmail.ts';

function deliveryOrderSnap(docPath: string, data: Record<string, unknown>, exists = true) {
  return {
    exists,
    id: docPath.split('/').pop() || '',
    ref: { path: docPath },
    data: () => data,
  };
}

test('Resend test email args default to latest shipper-ready lookup', () => {
  assert.deepEqual(parseArgs([]), { kind: 'shipper-ready' });
});

test('Resend test email args accept numeric order id with explicit drop id', () => {
  assert.deepEqual(parseArgs(['--kind', 'order-received', '--drop-id', 'card_nft_2', '--order-id', '123']), {
    kind: 'order-received',
    dropId: 'card_nft_2',
    orderId: 123,
  });
});

test('Resend test email args require a drop for bare numeric order ids', () => {
  assert.throws(() => parseArgs(['--order-id', '123']), /requires --drop-id/);
});

test('Resend test email args accept composite order ids', () => {
  assert.deepEqual(parseArgs(['--kind=order-received', '--order-id=card_nft_2:123']), {
    kind: 'order-received',
    dropId: 'card_nft_2',
    orderId: 123,
  });
});

test('Resend test email args accept delivery order document paths', () => {
  assert.deepEqual(parseArgs(['--kind', 'order-shipped', '--order_id', 'drops/card_nft_2/deliveryOrders/456']), {
    kind: 'order-shipped',
    dropId: 'card_nft_2',
    orderId: 456,
  });
});

test('Resend test email args reject conflicting drop ids', () => {
  assert.throws(
    () => parseArgs(['--drop-id', 'card_nft_2', '--order-id', 'little_swag_hoodies:123']),
    /does not match/,
  );
});

test('Resend test email args normalize drop aliases in order ids', () => {
  assert.deepEqual(parseArgs(['--kind', 'shipper-ready', '--order_id', 'card-nft-2:123']), {
    kind: 'shipper-ready',
    dropId: 'card_nft_2',
    orderId: 123,
  });
});

test('Resend test email args reject invalid order ids', () => {
  assert.throws(() => parseArgs(['--drop-id', 'card_nft_2', '--order-id', 'abc']), /Invalid --order-id/);
  assert.throws(() => parseArgs(['--drop-id', 'card_nft_2', '--order-id', '0']), /Invalid --order-id/);
  assert.throws(() => parseArgs(['--order-id', 'card_nft_2:abc']), /Invalid --order-id/);
});

test('Resend test email args reject order ids for non-order-backed kinds', () => {
  assert.throws(
    () => parseArgs(['--kind', 'stripe-manual-review', '--order-id', 'card_nft_2:123']),
    /only supported with order-backed/,
  );
});

test('Resend test email exact lookup loads the requested delivery order document', async () => {
  const selected = await deliveryOrderById('order-received', 'card_nft_2', 123, async (docPath) => {
    assert.equal(docPath, 'drops/card_nft_2/deliveryOrders/123');
    return deliveryOrderSnap(docPath, {
      deliveryId: 123,
      status: 'processing',
      owner: 'owner-wallet',
      items: [],
    });
  });

  assert.equal(selected.docPath, 'drops/card_nft_2/deliveryOrders/123');
  assert.equal(selected.dropId, 'card_nft_2');
  assert.equal(selected.deliveryId, 123);
  assert.equal(selected.status, 'processing');
  assert.equal(selected.owner, 'owner-wallet');
});

test('Resend test email exact lookup rejects missing delivery order documents', async () => {
  await assert.rejects(
    () => deliveryOrderById('order-received', 'card_nft_2', 123, async (docPath) => deliveryOrderSnap(docPath, {}, false)),
    /Delivery order not found: drops\/card_nft_2\/deliveryOrders\/123/,
  );
});

test('Resend test email exact lookup rejects orders that do not match the email kind requirements', async () => {
  await assert.rejects(
    () =>
      deliveryOrderById('order-shipped', 'card_nft_2', 123, async (docPath) =>
        deliveryOrderSnap(docPath, {
          deliveryId: 123,
          status: 'ready_to_ship',
          fulfillmentStatus: 'Preparing',
        }),
      ),
    /does not match order-shipped test email requirements/,
  );
});

test('Resend test email exact lookup rejects stored delivery id mismatches', async () => {
  await assert.rejects(
    () =>
      deliveryOrderById('order-received', 'card_nft_2', 123, async (docPath) =>
        deliveryOrderSnap(docPath, {
          deliveryId: 999,
          status: 'processing',
        }),
      ),
    /does not match requested --order-id 123/,
  );
});
