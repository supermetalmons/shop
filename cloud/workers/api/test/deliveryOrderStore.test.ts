import assert from 'node:assert/strict';
import test from 'node:test';
import { D1CommerceRepository, commerceFieldValue, commerceKeys } from '../src/commerceRepository.ts';
import {
  deliveryOrderFulfillmentDocument,
  deliveryOrderRecoveryDocument,
  loadDeliveryOrderDocument,
  readDeliveryOrder,
  updateDeliveryOrder,
} from '../src/deliveryOrderStore.ts';
import type { DeliveryRecoveryPatch, ReadyToShipNotificationUpdates } from '../src/deliveryOrderUpdates.ts';
import type { FulfillmentDeliveryOrderUpdates } from '../src/fulfillmentDeliveryOrderUpdates.ts';
import { mutateDeliveryOrder } from '../src/fulfillmentStorePersistence.ts';
import { ProfileReadError } from '../src/dataAccess.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

const DROP_ID = 'card_nft_2';
const DELIVERY_ID = 7;
const NOW_MS = 1_800_000_000_000;
const key = commerceKeys.deliveryOrder(DROP_ID, String(DELIVERY_ID));

if (false) {
  const transaction = { update: async () => {} };
  // @ts-expect-error Delivery mutations must reject checkout keys.
  void updateDeliveryOrder(transaction, commerceKeys.stripeCheckout(DROP_ID, 'session'), {});
  // @ts-expect-error Delivery operational fields must be spelled correctly.
  void updateDeliveryOrder(transaction, key, { buyerOrderShippedEmailJobID: 'job' });
  // @ts-expect-error A recovery lease must use a native timestamp transform.
  void ({ 'receiptRecovery.leaseExpiresAt': 'tomorrow' } satisfies DeliveryRecoveryPatch);
  // @ts-expect-error Notification state must be supported.
  void ({ buyerOrderReceivedEmailState: 'sent' } satisfies ReadyToShipNotificationUpdates);
  // @ts-expect-error Notification attempts must be numeric.
  void ({ readyToShipNotificationPublishAttemptCount: '1' } satisfies ReadyToShipNotificationUpdates);
  const common = { repository: { get: async () => null }, signal: new AbortController().signal };
  // @ts-expect-error Delivery readers must reject checkout keys.
  void readDeliveryOrder(common, commerceKeys.stripeCheckout(DROP_ID, 'session'));
  // @ts-expect-error Unrelated order lifecycle fields are outside fulfillment patches.
  void ({ status: 'ready_to_ship' } satisfies FulfillmentDeliveryOrderUpdates);
  // @ts-expect-error Fulfillment patch fields must be spelled correctly.
  void ({ fulfillmentTrackingCod: 'tracking' } satisfies FulfillmentDeliveryOrderUpdates);
  // @ts-expect-error Package counts must be numeric.
  void ({ 'shipstation.packageCount': '2' } satisfies FulfillmentDeliveryOrderUpdates);
  // @ts-expect-error Stored timestamps must not accept strings.
  void ({ fulfillmentAddressUpdatedAt: 'today' } satisfies FulfillmentDeliveryOrderUpdates);
  // @ts-expect-error Nested lifecycle status must be supported.
  void ({ 'shipstation.labelPurchase.status': 'complete' } satisfies FulfillmentDeliveryOrderUpdates);
  // @ts-expect-error Plain JSON cannot impersonate a delete operation.
  void ({ fulfillmentTrackingCode: { kind: 'delete-field' } } satisfies FulfillmentDeliveryOrderUpdates);
  void ({
    fulfillmentAddressUpdatedAt: commerceFieldValue.serverTimestamp(),
    fulfillmentTrackingCode: commerceFieldValue.delete(),
    'shipstation.createdAt': NOW_MS,
    'shipstation.claimedAt': commerceFieldValue.delete(),
  } satisfies FulfillmentDeliveryOrderUpdates);
}

test('delivery operational views preserve the envelope and raw legacy fields without extra reads', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const data = {
    status: 'processing',
    fulfillmentStatus: 'Shipped',
    fulfillmentTrackingCode: '  TRACKING  ',
    receiptRecovery: { attemptCount: '2', lastAttemptAt: NOW_MS, legacy: true },
    shipstation: { package: 'malformed but unrelated' },
    legacy: { retained: [true, null] },
  };
  seedCommerceDocument(harness, { key, data });
  const repository = new D1CommerceRepository(harness.db);
  const document = await loadDeliveryOrderDocument({ repository }, DROP_ID, DELIVERY_ID);
  const fulfillment = deliveryOrderFulfillmentDocument(document);
  const recovery = deliveryOrderRecoveryDocument(document);
  assert.equal(fulfillment.data, document.data);
  assert.equal(recovery.data, document.data);
  assert.equal(fulfillment.version, document.version);
  assert.equal(recovery.updateTime, document.updateTime);
  assert.equal(fulfillment.fulfillment.fulfillmentTrackingCode, 'TRACKING');
  assert.equal(recovery.recovery.rawAttemptCount, '2');
  assert.equal(recovery.recovery.lastAttemptAtMs, NOW_MS);
  assert.deepEqual(document.data, data);
  await repository.run(NOW_MS, (unit) => updateDeliveryOrder(unit, key, {
    buyerOrderShippedEmailState: 'pending',
    'receiptRecovery.leaseExpiresAt': commerceFieldValue.timestamp(Math.floor(NOW_MS / 1000), 0),
  }));
  const updated = await repository.get(key);
  assert.deepEqual(updated?.data.legacy, data.legacy);
  assert.deepEqual(updated?.data.shipstation, data.shipstation);
  assert.deepEqual(updated?.data.receiptRecovery, { ...data.receiptRecovery, leaseExpiresAt: NOW_MS });
});

test('required delivery reads and no-op fulfillment mutations preserve the full canonical record', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const expected = {
    key,
    data: { legacy: { retained: [true, null, 'old'] }, fulfillmentTrackingCode: 123 },
    createTime: '2025-01-01T00:00:00.000Z',
    updateTime: '2026-01-02T03:04:05.000Z',
    processedAt: { seconds: 1_700_000_000, nanos: 123_000_000 },
    version: 9,
  };
  seedCommerceDocument(harness, expected);
  const repository = new D1CommerceRepository(harness.db);
  const canonical = await loadDeliveryOrderDocument({ repository }, DROP_ID, DELIVERY_ID);
  assert.deepEqual(canonical, expected);
  const readCounts: number[] = [];
  const value = { unchanged: true };
  const result = await mutateDeliveryOrder({
    common: {
      nowMs: NOW_MS,
      signal: new AbortController().signal,
      repository: {
        get: async () => assert.fail('Mutation must read inside its transaction'),
        run: (nowMs, operation) => repository.run(nowMs, async (unit) => {
          const reads = context.mock.method(unit, 'get', unit.get.bind(unit));
          const result = await operation(unit);
          readCounts.push(reads.mock.callCount());
          return result;
        }),
      },
    },
    deliveryId: DELIVERY_ID,
    dropId: DROP_ID,
    build: (document) => {
      assert.deepEqual(document, canonical);
      return { value };
    },
  });
  assert.equal(result, value);
  assert.deepEqual(readCounts, [1]);
  assert.deepEqual(await repository.get(key), expected);
});

test('delivery reads retain nullable and required missing-order behavior', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const common = { repository, nowMs: NOW_MS, signal: new AbortController().signal };
  assert.equal(await readDeliveryOrder(common, key), null);
  const missingOrder = (error: unknown) => error instanceof ProfileReadError &&
    error.code === 'not-found' && error.status === 404 && error.message === 'Delivery order not found';
  await assert.rejects(loadDeliveryOrderDocument(common, DROP_ID, DELIVERY_ID), missingOrder);
  await assert.rejects(mutateDeliveryOrder({
    common,
    deliveryId: DELIVERY_ID,
    dropId: DROP_ID,
    build: () => assert.fail('Missing orders must not reach the mutation builder'),
  }), missingOrder);
});

test('required delivery reads and fulfillment mutations preserve raw repository failures', async (context) => {
  const failure = new Error('repository read failed');
  const get = async () => { throw failure; };
  const sameFailure = (error: unknown) => error === failure;
  const readContext = { repository: { get }, signal: new AbortController().signal };
  await assert.rejects(readDeliveryOrder(readContext, key), sameFailure);
  await assert.rejects(loadDeliveryOrderDocument(readContext, DROP_ID, DELIVERY_ID), sameFailure);

  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  await assert.rejects(mutateDeliveryOrder({
    common: {
      nowMs: NOW_MS,
      signal: readContext.signal,
      repository: {
        get,
        run: (nowMs, operation) => repository.run(nowMs, (unit) => {
          context.mock.method(unit, 'get', get);
          return operation(unit);
        }),
      },
    },
    deliveryId: DELIVERY_ID,
    dropId: DROP_ID,
    build: () => assert.fail('Failed reads must not reach the mutation builder'),
  }), sameFailure);
});

test('fulfillment mutations preserve nested siblings and legacy data while applying native transforms', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seedCommerceDocument(harness, {
    key,
    data: {
      fulfillmentTrackingCode: 'old-tracking',
      shipstation: { shipmentId: 'shipment', unknownLegacyField: { retained: true } },
      legacy: [false, null, 'retained'],
    },
  });
  const repository = new D1CommerceRepository(harness.db);
  const storedPackage = { length: 12, width: 9, height: 2, weight: 4 };
  const updates: FulfillmentDeliveryOrderUpdates = {
    'shipstation.package': storedPackage,
    fulfillmentTrackingCode: commerceFieldValue.delete(),
    fulfillmentAddressUpdatedAt: commerceFieldValue.serverTimestamp(),
  };
  await mutateDeliveryOrder({
    common: { repository, nowMs: NOW_MS, signal: new AbortController().signal },
    deliveryId: DELIVERY_ID,
    dropId: DROP_ID,
    build: () => ({ value: undefined, updates }),
  });
  const stored = await loadDeliveryOrderDocument({ repository }, DROP_ID, DELIVERY_ID);
  assert.deepEqual(stored.data, {
    shipstation: {
      shipmentId: 'shipment',
      unknownLegacyField: { retained: true },
      package: storedPackage,
    },
    legacy: [false, null, 'retained'],
    fulfillmentAddressUpdatedAt: NOW_MS,
  });
  assert.equal(stored.version, 2);
});
