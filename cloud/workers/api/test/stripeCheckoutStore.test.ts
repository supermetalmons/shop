import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  buildStripeCheckoutDocument,
  createStripeCheckoutIdentity,
  StripeCheckoutSessionError,
} from '../../../../shared/stripeCheckoutSession.ts';
import { CommerceWriteConflict, commerceKeys, D1CommerceRepository } from '../src/commerceRepository.ts';
import type { StripeCheckoutCommerceContext } from '../src/stripeCheckout/commerce.ts';
import {
  createStripeCheckoutDocument,
  markStripeCheckoutReenqueued,
  recordStripeCheckoutReconciliationFailure,
} from '../src/stripeCheckout/sessionStore.ts';
import {
  markStripeCheckoutFulfillmentFulfilled,
  publishStripeOffchainDeliveryOrder,
  type StripeOffchainDeliveryOrderDraft,
} from '../src/stripeCheckout/store.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

const NOW_MS = 1_800_000_000_000;
const CHECKOUT_KEY = commerceKeys.stripeCheckout('drop', 'cs_store');
const ORDER_KEY = commerceKeys.deliveryOrder('drop', '123');
const ORDER_HASH = 'ab'.repeat(32);
const MARKER_KEY = commerceKeys.offchainOrder('drop', ORDER_HASH);
const CLAIM_KEY = commerceKeys.claimCode('ABCDEF-1234567890');

function fixture(context: TestContext) {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const commerce: StripeCheckoutCommerceContext = { repository, nowMs: () => NOW_MS };
  return { harness, repository, commerce };
}

function order(): StripeOffchainDeliveryOrderDraft {
  return {
    ...createStripeCheckoutIdentity('store-subject'),
    dropId: 'drop',
    receiptOwner: 'receipt-owner',
    metadataIds: [7],
    orderHashHex: ORDER_HASH,
    stripeSession: { id: 'cs_store' },
    receiptTx: null,
    addressSnapshot: { country: 'US', historicalAddressField: 'retained' },
  };
}

test('checkout creation retains an advanced same-operation record and rejects conflicting identity', async (context) => {
  const { repository, commerce } = fixture(context);
  const document = buildStripeCheckoutDocument({
    ...createStripeCheckoutIdentity('store-subject'),
    dropId: 'drop',
    sessionId: 'cs_store',
    operationId: 'operation',
    unitAmountCents: 100,
    createdAt: 0,
    updatedAt: 0,
  });
  await createStripeCheckoutDocument(commerce, CHECKOUT_KEY.path, document);
  assert.equal((await repository.get(CHECKOUT_KEY))?.data.createdAt, NOW_MS);
  await repository.run(NOW_MS + 1, (transaction) => transaction.update(CHECKOUT_KEY, {
    status: 'processing',
    processingAttemptId: 'new-attempt',
    historicalField: { retained: true },
  }));
  const advanced = await repository.get(CHECKOUT_KEY);
  await createStripeCheckoutDocument(commerce, CHECKOUT_KEY.path, document);
  assert.deepEqual(await repository.get(CHECKOUT_KEY), advanced);
  await assert.rejects(
    createStripeCheckoutDocument(commerce, CHECKOUT_KEY.path, { ...document, operationId: 'other' }),
    (error: unknown) => error instanceof StripeCheckoutSessionError && error.code === 'failed-precondition',
  );
  assert.deepEqual(await repository.get(CHECKOUT_KEY), advanced);
});

test('reconciliation domain writes preserve checkout state and historical fields', async (context) => {
  const { harness, repository, commerce } = fixture(context);
  seedCommerceDocument(harness, {
    key: CHECKOUT_KEY,
    data: { status: 'processing', processingAttemptId: 'current', historicalField: { retained: true } },
  });
  const identity = { dropId: 'drop', sessionId: 'cs_store' };
  await markStripeCheckoutReenqueued(commerce, identity);
  await recordStripeCheckoutReconciliationFailure(commerce, identity, { name: 'Error', message: 'invalid event' });
  assert.deepEqual((await repository.get(CHECKOUT_KEY))?.data, {
    status: 'processing',
    processingAttemptId: 'current',
    historicalField: { retained: true },
    fulfillmentQueueReenqueuedAt: NOW_MS,
    lastFulfillmentReconciliationError: { name: 'Error', message: 'invalid event' },
    lastFulfillmentReconciliationErrorAt: NOW_MS + 1,
    updatedAt: NOW_MS + 1,
  });
});

test('fulfillment domain writes generate completion timestamps inside the transaction', async (context) => {
  const { harness, repository, commerce } = fixture(context);
  seedCommerceDocument(harness, {
    key: CHECKOUT_KEY,
    data: { status: 'processing', processingAttemptId: 'current', historicalField: 'retained' },
  });
  assert.deepEqual(await markStripeCheckoutFulfillmentFulfilled(commerce, CHECKOUT_KEY, {
    deliveryId: 123,
    processingAttemptId: 'current',
    fulfillmentCompletionFields: { fulfillmentCompletedBy: 'cloudflare_queue_v1' },
  }), { status: 'fulfilled' });
  const checkout = (await repository.get(CHECKOUT_KEY))?.data;
  assert.equal(checkout?.fulfillmentCompletedBy, 'cloudflare_queue_v1');
  assert.equal(checkout?.fulfillmentCompletedAt, NOW_MS);
  assert.equal(checkout?.fulfilledAt, NOW_MS);
  assert.equal(checkout?.historicalField, 'retained');
  assert.equal(checkout?.processingAttemptId, undefined);
});

test('atomic publication retries recheck the lease before creating order, marker, or claim', async (context) => {
  const { harness, repository } = fixture(context);
  seedCommerceDocument(harness, {
    key: CHECKOUT_KEY,
    data: { status: 'processing', processingAttemptId: 'old-attempt' },
  });
  let attempts = 0;
  const commerce: StripeCheckoutCommerceContext = {
    nowMs: () => NOW_MS,
    repository: {
      get: repository.get.bind(repository),
      notificationOutbox: repository.notificationOutbox,
      run: (now, operation) => repository.run(now, async (transaction) => {
        attempts += 1;
        const result = await operation(transaction);
        if (attempts === 1) {
          await repository.run(now, (competing) => competing.update(CHECKOUT_KEY, { processingAttemptId: 'new-attempt' }));
        }
        return result;
      }),
    },
  };
  assert.deepEqual(await publishStripeOffchainDeliveryOrder({
    commerce,
    order: order(),
    checkoutKey: CHECKOUT_KEY,
    deliveryId: 123,
    claimCodes: [CLAIM_KEY.documentId],
    processingAttemptId: 'old-attempt',
  }), { checkoutStatus: 'stale_processing_attempt' });
  assert.equal(attempts, 2);
  assert.equal(await repository.get(ORDER_KEY), null);
  assert.equal(await repository.get(MARKER_KEY), null);
  assert.equal(await repository.get(CLAIM_KEY), null);
  assert.equal((await repository.get(CHECKOUT_KEY))?.data.status, 'processing');
});

test('receipt claim collisions leave all atomic publication documents unchanged', async (context) => {
  const { harness, repository, commerce } = fixture(context);
  seedCommerceDocument(harness, {
    key: CHECKOUT_KEY,
    data: { status: 'processing', processingAttemptId: 'current' },
  });
  seedCommerceDocument(harness, { key: CLAIM_KEY, data: { occupied: true } });
  await assert.rejects(publishStripeOffchainDeliveryOrder({
    commerce,
    order: order(),
    checkoutKey: CHECKOUT_KEY,
    deliveryId: 123,
    claimCodes: [CLAIM_KEY.documentId],
    processingAttemptId: 'current',
  }), (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'already-exists');
  assert.equal(await repository.get(ORDER_KEY), null);
  assert.equal(await repository.get(MARKER_KEY), null);
  assert.deepEqual((await repository.get(CLAIM_KEY))?.data, { occupied: true });
  assert.deepEqual((await repository.get(CHECKOUT_KEY))?.data, { status: 'processing', processingAttemptId: 'current' });
});
