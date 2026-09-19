import assert from 'node:assert/strict';
import test from 'node:test';
import {
  D1CommerceRepository,
  commerceKeys,
  type CommerceDocumentData,
} from '../src/commerceRepository.ts';
import {
  markDeliveryOrderShippedEmailQueued,
  setDeliveryOrderFulfillment,
} from '../src/deliveryOrderCommerce.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

const DROP_ID = 'card_nft_2';
const DELIVERY_ID = 7;
const NOW_MS = 1_800_000_000_000;
const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const REPLACEMENT_JOB_ID = '123e4567-e89b-42d3-a456-426614174001';
const TRACKING_URL = 'https://carrier.example/track?id=AB123';
const IDEMPOTENCY_KEY = `${DROP_ID}:${DELIVERY_ID}:order_shipped`;
const key = commerceKeys.deliveryOrder(DROP_ID, String(DELIVERY_ID));

test('delivery fulfillment updates validate legacy fields and reject missing orders', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const update = (deliveryId: number) => setDeliveryOrderFulfillment({
    common: { repository, nowMs: NOW_MS },
    createNotificationJobId: () => JOB_ID,
    deliveryId,
    dropId: DROP_ID,
    status: 'Preparing',
    wallet: 'staff',
  });
  await assert.rejects(update(DELIVERY_ID), { code: 'not-found', status: 404 });

  const cases: CommerceDocumentData[] = [
    {},
    {
      fulfillmentStatus: 'unknown',
      fulfillmentTrackingCode: 123,
      buyerOrderShippedEmailState: { pending: true },
      buyerOrderShippedEmailJobId: 'invalid',
      buyerOrderShippedEmailIdempotencyKey: [],
      futureField: { preserved: true },
    },
    {
      fulfillmentStatus: 'Shipped',
      fulfillmentTrackingCode: `  ${TRACKING_URL}  `,
      buyerOrderShippedEmailState: 'queued',
      buyerOrderShippedEmailJobId: JOB_ID,
      buyerOrderShippedEmailIdempotencyKey: IDEMPOTENCY_KEY,
    },
  ];
  for (const [index, data] of cases.entries()) {
    const deliveryId = DELIVERY_ID + index;
    const orderKey = commerceKeys.deliveryOrder(DROP_ID, String(deliveryId));
    seedCommerceDocument(harness, { key: orderKey, data });
    const mutation = await update(deliveryId);
    assert.deepEqual(mutation.response, {
      deliveryId,
      fulfillmentStatus: 'Preparing',
      ...(index === 2 ? {
        fulfillmentTrackingCode: TRACKING_URL,
        buyerOrderShippedEmailState: 'queued',
      } : {}),
    });
    assert.deepEqual(mutation.decision, {
      kind: 'skip',
      clearPending: false,
      reason: index === 2 ? 'already-queued' : 'not-first-shipped-with-tracking',
    });
    assert.deepEqual((await repository.get(orderKey))?.data, {
      ...data,
      dropId: DROP_ID,
      fulfillmentStatus: 'Preparing',
      fulfillmentUpdatedAt: NOW_MS,
      fulfillmentUpdatedBy: 'staff',
    });
  }
});

test('delivery fulfillment updates sparse orders without replacing unrelated data', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seedCommerceDocument(harness, { key, data: { futureField: { preserved: true } } });
  const repository = new D1CommerceRepository(harness.db);
  const mutation = await setDeliveryOrderFulfillment({
    common: { repository, nowMs: NOW_MS },
    createNotificationJobId: () => JOB_ID,
    deliveryId: DELIVERY_ID,
    dropId: DROP_ID,
    status: 'Preparing',
    wallet: 'staff',
  });
  assert.deepEqual(mutation.response, { deliveryId: DELIVERY_ID, fulfillmentStatus: 'Preparing' });
  assert.deepEqual((await repository.get(key))?.data, {
    dropId: DROP_ID,
    fulfillmentStatus: 'Preparing',
    fulfillmentUpdatedAt: NOW_MS,
    fulfillmentUpdatedBy: 'staff',
    futureField: { preserved: true },
  });
});

test('pending shipment retries replace malformed IDs and preserve the original order', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seedCommerceDocument(harness, {
    key,
    data: {
      deliveryId: DELIVERY_ID,
      addressSnapshot: { email: 'buyer@example.com' },
      fulfillmentStatus: 'Shipped',
      fulfillmentTrackingCode: TRACKING_URL,
      buyerOrderShippedEmailState: 'pending',
      buyerOrderShippedEmailJobId: 123,
      buyerOrderShippedEmailIdempotencyKey: { invalid: true },
      buyerOrderShippedEmailQueuedAt: 100,
      futureField: ['preserved'],
    },
  });
  const repository = new D1CommerceRepository(harness.db);
  const mutation = await setDeliveryOrderFulfillment({
    common: { repository, nowMs: NOW_MS },
    createNotificationJobId: () => JOB_ID,
    deliveryId: DELIVERY_ID,
    dropId: DROP_ID,
    status: 'Shipped',
    trackingCode: TRACKING_URL,
    wallet: 'staff',
  });
  assert.deepEqual(mutation.decision, {
    kind: 'send',
    deliveryId: DELIVERY_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    jobId: JOB_ID,
  });
  const stored = (await repository.get(key))?.data;
  assert.equal(stored?.buyerOrderShippedEmailState, 'pending');
  assert.equal(stored?.buyerOrderShippedEmailJobId, JOB_ID);
  assert.equal(stored?.buyerOrderShippedEmailIdempotencyKey, IDEMPOTENCY_KEY);
  assert.equal(Object.hasOwn(stored || {}, 'buyerOrderShippedEmailQueuedAt'), false);
  assert.deepEqual(stored?.futureField, ['preserved']);
  assert.deepEqual(mutation.order.futureField, ['preserved']);
});

test('shipment notification finalization retries a conflict and leaves a replacement job pending', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seedCommerceDocument(harness, {
    key,
    data: {
      buyerOrderShippedEmailState: 'pending',
      buyerOrderShippedEmailJobId: JOB_ID,
      buyerOrderShippedEmailIdempotencyKey: IDEMPOTENCY_KEY,
    },
  });
  const repository = new D1CommerceRepository(harness.db);
  let attempts = 0;
  const finalized = await markDeliveryOrderShippedEmailQueued({
    common: {
      nowMs: NOW_MS,
      repository: {
        run: (nowMs, operation) => repository.run(nowMs, async (unit) => {
          attempts += 1;
          const result = await operation(unit);
          if (attempts === 1) {
            await repository.run(nowMs + 1, (competing) => competing.update(key, {
              buyerOrderShippedEmailJobId: REPLACEMENT_JOB_ID,
            }));
          }
          return result;
        }),
      },
    },
    deliveryId: DELIVERY_ID,
    dropId: DROP_ID,
    jobId: JOB_ID,
  });
  assert.equal(finalized, false);
  assert.equal(attempts, 2);
  assert.deepEqual((await repository.get(key))?.data, {
    buyerOrderShippedEmailState: 'pending',
    buyerOrderShippedEmailJobId: REPLACEMENT_JOB_ID,
    buyerOrderShippedEmailIdempotencyKey: IDEMPOTENCY_KEY,
  });
});

test('shipment notification finalization requires a validated matching pending job', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seedCommerceDocument(harness, {
    key,
    data: {
      buyerOrderShippedEmailState: 'pending',
      buyerOrderShippedEmailJobId: 'malformed',
    },
  });
  const repository = new D1CommerceRepository(harness.db);
  assert.equal(await markDeliveryOrderShippedEmailQueued({
    common: { repository, nowMs: NOW_MS },
    deliveryId: DELIVERY_ID,
    dropId: DROP_ID,
    jobId: 'malformed',
  }), false);
  assert.deepEqual((await repository.get(key))?.data, {
    buyerOrderShippedEmailState: 'pending',
    buyerOrderShippedEmailJobId: 'malformed',
  });
});
