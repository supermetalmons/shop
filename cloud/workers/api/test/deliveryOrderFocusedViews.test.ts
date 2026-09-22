import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { preparedDeliveryRecoveryNextCheckMs, processingDeliveryRecoveryNextCheckMs } from '../../../../shared/deliveryRecovery.ts';
import { parseDeliveryOrderOwnership, parseDeliveryRecoveryState, parseDeliveryShipmentItemCounts } from '../src/deliveryOrderReadModel.ts';
import { parseDeliveryOrderReceiptView } from '../src/deliveryOrderReceiptView.ts';
import { confirmedReceiptTransactions } from '../src/deliveryReceiptStore.ts';
import { parseDeliveryOrderNotificationView } from '../src/deliveryOrderNotificationView.ts';
import { parseDeliveryOrderProjectionView } from '../src/deliveryOrderProjectionView.ts';
import type { CommerceDocumentData } from '../src/commerceRepository.ts';

test('delivery ownership retains truthy malformed owners so wallet guards reject them', () => {
  for (const owner of [true, 1, [], {}]) {
    const view = parseDeliveryOrderOwnership({ owner });
    assert.equal(view.hasOwner, true);
    assert.equal(view.owner, undefined);
  }
  for (const owner of [undefined, null, false, 0, '']) {
    assert.equal(parseDeliveryOrderOwnership({ owner }).hasOwner, false);
  }
  assert.deepEqual(parseDeliveryOrderOwnership({ owner: ' wallet ' }), { owner: ' wallet ', hasOwner: true });
});

test('ready receipt strings remain distinct from validated confirmed transaction signatures', () => {
  const signature = bs58.encode(new Uint8Array(64).fill(1));
  const order = { receiptTxs: ['legacy', signature, signature, 1, null], receiptsMinted: '03' };
  const view = parseDeliveryOrderReceiptView(order);
  assert.deepEqual(view.receiptTxs, ['legacy', signature, signature]);
  assert.deepEqual(confirmedReceiptTransactions(order), [signature]);
  assert.equal(view.receiptsMinted, 3);
  assert.equal(view.closeDeliveryTx, null);
});

test('receipt validation is lazy and preserves legacy fee fallback and per-item coercion', () => {
  const raw = { itemIds: null, items: [{ assetId: 'asset', kind: 'box', refId: '2' }], deliveryLamports: null, shippingLamports: '3' };
  const receipt = parseDeliveryOrderReceiptView(raw);
  assert.equal(receipt.deliveryLamports, 3);
  assert.equal(receipt.items[0].refId, 2);
  assert.throws(() => receipt.itemIds, /invalid itemIds/);
  assert.doesNotThrow(() => parseDeliveryOrderReceiptView({ items: [{ refId: Symbol('legacy') }], receiptRecovery: { pendingSubmission: false } }));
  assert.deepEqual(raw, { itemIds: null, items: [{ assetId: 'asset', kind: 'box', refId: '2' }], deliveryLamports: null, shippingLamports: '3' });
});

test('recovery scheduling preserves shared legacy timing and exhaustion rules', () => {
  const orders: CommerceDocumentData[] = [
    {},
    { status: 'prepared', createdAt: 1_000, receiptRecovery: { preparedProbeCount: '1' } },
    { status: 'prepared', createdAt: 1_000, receiptRecovery: { preparedProbeCount: 3 } },
    { status: 'prepared', receiptRecovery: { nextPreparedProbeAt: 4_000 } },
    { status: 'processing', receiptRecovery: { lastAttemptAt: 1_000, leaseExpiresAt: 90_000 } },
    { status: 'processing', receiptRecovery: null },
  ];
  for (const order of orders) {
    const view = parseDeliveryRecoveryState(order);
    assert.equal(view.preparedNextCheckAt(2_000), preparedDeliveryRecoveryNextCheckMs(order, 2_000));
    assert.equal(view.processingNextCheckAt(2_000), processingDeliveryRecoveryNextCheckMs(order, 2_000));
  }
});

test('notification and shipment views preserve their different item-count policies', () => {
  const order = { items: [{ kind: 'box', refId: '1.9' }, { kind: 'dude', refId: 0 }, null], addressSnapshot: { email: ' Buyer@Example.com ' }, deliveryId: '2' };
  const notification = parseDeliveryOrderNotificationView(order);
  assert.deepEqual(notification.shipperSummary, { itemCount: 3, boxCount: 1, dudeCount: 1 });
  assert.deepEqual(parseDeliveryShipmentItemCounts(order), { boxCount: 1, looseItemCount: 0 });
  assert.equal(notification.buyerRecipient, 'Buyer@Example.com');
  assert.equal(notification.resolveDeliveryId(2), 2);
  assert.equal(notification.resolveDeliveryId(1), null);
});

test('projection views preserve strict safe integer state and item filtering', () => {
  const view = parseDeliveryOrderProjectionView({
    status: 'ready_to_ship', packStatusProjectionState: 'pending',
    packStatusProjectionNextAttemptAtMs: '500', packStatusProjectionFailureCount: -1,
    items: [{ kind: 'box', refId: 1 }, { kind: 'dude', refId: 2 }],
    adminIrlRedeem: { targetKind: 'card_receipt' },
  });
  assert.equal(view.nextAttemptAtMs, 0);
  assert.equal(view.failureCount, 0);
  assert.equal(view.packQuantity, 1);
  assert.equal(view.cardQuantity, 1);
  assert.equal(view.adminTargetKind, 'card_receipt');
});
