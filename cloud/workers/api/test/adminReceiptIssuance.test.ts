import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_RECEIPT_ISSUANCE_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.ts';
import { decideBuyerOrderShippedNotification } from '../src/buyerOrderShipped.ts';
import { commerceKeys, D1CommerceRepository } from '../src/commerceRepository.ts';
import { deliveryOrderSummaryFromDocument } from '../src/deliveryOrderSummaries.ts';
import { planReadyToShipNotifications } from '../src/readyToShipNotifications.ts';
import { rejectIrlShipStationOrder } from '../src/shipstation/state.ts';
import { reserveReceiptClaimWorkflow } from '../src/stripeReceiptClaimWorkflowStore.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

const DROP = 'card_nft_binder';
const CODE = 'ABCDEF-1234567890';
const OWNER = '11111111111111111111111111111111';
const NOW = 1_800_000_000_000;
const order = {
  dropId: DROP, deliveryId: 7, source: ADMIN_RECEIPT_ISSUANCE_DELIVERY_ORDER_SOURCE,
  status: 'ready_to_ship', owner: OWNER, items: [{ kind: 'box', refId: 21 }],
  addressSnapshot: { email: 'buyer@example.com' },
  stripeReceiptClaimsByBoxId: {
    box_21: { namespace: 'stripe_receipt_v1', code: CODE, boxId: 21, status: 'unclaimed' },
  },
};

test('manual binder codes reserve the existing claim workflow without a Stripe checkout', async (t) => {
  const fixture = createCommerceD1Harness();
  t.after(() => fixture.database.close());
  seedCommerceDocument(fixture, { key: commerceKeys.deliveryOrder(DROP, '7'), data: order });
  seedCommerceDocument(fixture, { key: commerceKeys.claimCode(CODE), data: {
    namespace: 'stripe_receipt_v1', code: CODE, dropId: DROP, deliveryId: 7, boxId: 21, status: 'unclaimed',
  } });
  const context = { repository: new D1CommerceRepository(fixture.db), signal: new AbortController().signal, nowMs: NOW };
  const result = await reserveReceiptClaimWorkflow(context, CODE, OWNER, NOW);
  assert.equal(result.status, 'pending');
  if (result.status !== 'pending') return;
  assert.equal(result.snapshot.started.boxId, 21);
  assert.equal(result.snapshot.started.dropId, DROP);
  const saved = await context.repository.get(commerceKeys.deliveryOrder(DROP, '7'));
  assert.equal((saved?.data.stripeReceiptClaimsByBoxId as Record<string, { status: string }>).box_21.status, 'processing');
  await assert.rejects(reserveReceiptClaimWorkflow(context, CODE, 'another-recipient', NOW), /original receiver/);
});

test('manual receipt issuance cannot trigger shipping or appear in customer shipment history', async (t) => {
  assert.throws(() => rejectIrlShipStationOrder(order), /do not have a delivery address/);
  assert.deepEqual(planReadyToShipNotifications({ before: {}, after: order, dropId: DROP, deliveryId: 7 }), []);
  assert.deepEqual(decideBuyerOrderShippedNotification({
    before: order, after: { ...order, fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: 'TRACKING-7' },
    dropId: DROP, deliveryDocId: 7,
  }), { kind: 'skip', clearPending: false, reason: 'ignored-source' });
  const fixture = createCommerceD1Harness();
  t.after(() => fixture.database.close());
  const key = commerceKeys.deliveryOrder(DROP, '7');
  seedCommerceDocument(fixture, { key, data: order });
  assert.equal(deliveryOrderSummaryFromDocument({ key, data: order }), null);
  const repository = new D1CommerceRepository(fixture.db);
  assert.deepEqual(await repository.queryShipmentHistoryPage({ owner: OWNER, limit: 1 }), { orders: [], nextCursor: null });
});
