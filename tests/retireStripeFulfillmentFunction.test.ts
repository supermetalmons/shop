import assert from 'node:assert/strict';
import test from 'node:test';
import { STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR } from '../functions/src/shared/stripeCheckoutFulfillmentJob.ts';
import { STRIPE_CHECKOUT_STATUS } from '../functions/src/shared/stripeCheckoutSession.ts';
import { retireStripeFulfillmentTestHooks } from '../scripts/retire-stripe-checkout-fulfillment-function.ts';
import { encodeFirestoreRestFields } from '../scripts/shared/firebaseCliFirestoreRest.ts';

const VERSION = '839c6586-102c-4daa-9feb-297c21bd2697';
const DOCUMENT_PREFIX = 'projects/mons-shop/databases/(default)/documents/';

function firestoreDocument(path: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { name: `${DOCUMENT_PREFIX}${path}`, fields: encodeFirestoreRestFields(fields) };
}

test('Stripe fulfillment retirement requires exact production proof arguments', () => {
  assert.deepEqual(retireStripeFulfillmentTestHooks.parseArgs([
    '--api-version-id', VERSION,
    '--drop-id', 'card_nft_binder_devnet',
    '--session-id', 'cs_test_retirement',
    '--confirm',
  ]), {
    apiVersionId: VERSION,
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_retirement',
    confirm: true,
  });
  assert.throws(() => retireStripeFulfillmentTestHooks.parseArgs([
    '--api-version-id', VERSION,
    '--drop-id', 'card_nft_binder_devnet',
    '--session-id', 'cs_test_retirement',
  ]), /requires --confirm/);
  assert.throws(() => retireStripeFulfillmentTestHooks.parseArgs([
    '--api-version-id', VERSION,
    '--drop-id', 'card_nft_binder',
    '--session-id', 'cs_test_retirement',
    '--confirm',
  ]), /must use card_nft_binder_devnet/);
});

test('Stripe fulfillment retirement scans every active checkout page and rejects legacy work', async () => {
  type QueryBody = {
    readTime?: string;
    structuredQuery: { startAt?: unknown; where?: unknown };
  };
  const readTime = '2026-08-23T07:30:00.000000Z';
  const requests: QueryBody[] = [];
  const pages = [
    [
      { document: firestoreDocument('drops/a/stripeCheckouts/1', {
        fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
        status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
      }), readTime },
      { document: firestoreDocument('drops/b/stripeCheckouts/2', {
        fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
        status: STRIPE_CHECKOUT_STATUS.PROCESSING,
      }), readTime },
    ],
    [{ readTime }],
  ];
  await retireStripeFulfillmentTestHooks.verifyNoLegacyActiveCheckouts({
    documentsUrl: () => new URL('https://firestore.googleapis.com/documents:runQuery'),
    request: async (request) => {
      requests.push(request.body as QueryBody);
      return pages.shift();
    },
  }, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].structuredQuery.where, undefined);
  assert.equal(requests[1].readTime, readTime);
  assert.deepEqual(requests[1].structuredQuery.startAt, {
    before: false,
    values: [{ referenceValue: `${DOCUMENT_PREFIX}drops/b/stripeCheckouts/2` }],
  });

  await assert.rejects(
    retireStripeFulfillmentTestHooks.verifyNoLegacyActiveCheckouts({
      documentsUrl: () => new URL('https://firestore.googleapis.com/documents:runQuery'),
      request: async () => [{
        document: firestoreDocument('drops/legacy/stripeCheckouts/3', {
          status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
        }),
        readTime,
      }],
    }, 2),
    /Legacy active Stripe checkout remains/,
  );
});

test('Stripe fulfillment retirement requires a recent Worker-owned completion proof', async () => {
  const nowMs = Date.parse('2026-08-23T08:00:00.000Z');
  const options = retireStripeFulfillmentTestHooks.parseArgs([
    '--api-version-id', VERSION,
    '--drop-id', 'card_nft_binder_devnet',
    '--session-id', 'cs_test_retirement',
    '--confirm',
  ]);
  const client = (completedAt: string, completedBy: string) => ({
    documentUrl: (path: string) => new URL(`https://firestore.googleapis.com/${path}`),
    documentsUrl: () => new URL('https://firestore.googleapis.com/documents'),
    request: async ({ url }: { url: URL }) => url.pathname.includes('/stripeCheckouts/')
      ? firestoreDocument('drops/card_nft_binder_devnet/stripeCheckouts/cs_test_retirement', {
          deliveryId: 7,
          fulfillmentCompletedAt: completedAt,
          fulfillmentCompletedBy: completedBy,
          fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
          status: STRIPE_CHECKOUT_STATUS.FULFILLED,
        })
      : firestoreDocument('drops/card_nft_binder_devnet/deliveryOrders/7', {
          source: 'stripe_offchain',
          status: 'ready_to_ship',
          stripeCheckoutSessionId: 'cs_test_retirement',
        }),
  });
  await retireStripeFulfillmentTestHooks.verifyFirestoreProof(
    options,
    client('2026-08-23T07:30:00.000Z', STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR),
    nowMs,
  );
  await assert.rejects(
    retireStripeFulfillmentTestHooks.verifyFirestoreProof(
      options,
      client('2026-08-23T07:30:00.000Z', 'legacy_function'),
      nowMs,
    ),
    /not completed by the Cloudflare fulfillment processor/,
  );
  await assert.rejects(
    retireStripeFulfillmentTestHooks.verifyFirestoreProof(
      options,
      client('2026-08-23T06:00:00.000Z', STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR),
      nowMs,
    ),
    /from the last hour/,
  );
});

test('Stripe fulfillment retirement reads back resumed queue delivery and the reviewed cron', async () => {
  const requests: URL[] = [];
  await retireStripeFulfillmentTestHooks.verifyCloudflareFulfillmentRuntime(
    'scoped-token',
    async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped-token');
      if (url.pathname.endsWith('/queues')) {
        assert.equal(url.searchParams.get('name'), 'mons-shop-stripe-fulfillment');
        return Response.json({
          success: true,
          result: [
            {
              queue_name: 'another-queue',
              settings: { delivery_paused: false },
            },
            {
              queue_name: 'mons-shop-stripe-fulfillment',
              settings: { delivery_paused: false },
            },
          ],
        });
      }
      assert.match(url.pathname, /\/workers\/scripts\/mons-shop-api\/schedules$/);
      return Response.json({ success: true, result: { schedules: [{ cron: '*/5 * * * *' }] } });
    },
  );
  assert.equal(requests.length, 2);
  assert.throws(
    () => retireStripeFulfillmentTestHooks.assertFulfillmentQueueResumed({
      success: true,
      result: [{
        queue_name: 'mons-shop-stripe-fulfillment',
        settings: { delivery_paused: true },
      }],
    }),
    /not confirmed resumed/,
  );
  assert.throws(
    () => retireStripeFulfillmentTestHooks.assertReviewedCronInstalled({ success: true, result: { schedules: [] } }),
    /schedule is not installed/,
  );
});
