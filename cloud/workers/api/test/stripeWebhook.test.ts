import test from 'node:test';
import {
  createCommerceD1,
  createCommerceD1Harness,
  seedCommerceDocument,
} from './commerceD1Harness.ts';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import {
  STRIPE_CHECKOUT_STATUS,
  STRIPE_OFFCHAIN_CURRENCY,
  STRIPE_OFFCHAIN_FULFILLMENT_MODE,
  buildStripeCheckoutDocument,
} from '../../../../shared/stripeCheckoutSession.ts';
import {
  resolveStripeWebhookAction,
  stripeWebhookTransition,
  type StripeWebhookEvent,
} from '../../../../shared/stripeWebhook.ts';
import { handleStripeWebhookRequest } from '../src/stripeWebhook.ts';
import { createStripeCheckoutStore } from '../src/stripeCheckout/store.ts';

const DEVNET_SECRET = 'whsec_devnet_test_secret';
const MAINNET_SECRET = 'whsec_mainnet_test_secret';
const DEVNET_DROP = 'card_nft_binder_devnet';
const MAINNET_DROP = 'card_nft_binder';

function queue(send: Queue['send'] = async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } })): Queue {
  return {
    send,
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
}

function env(overrides: Partial<Pick<Env,
  | 'COMMERCE_DB'
  | 'STRIPE_FULFILLMENT_QUEUE'
  | 'STRIPE_WEBHOOK_SECRET_DEVNET'
  | 'STRIPE_WEBHOOK_SECRET'
>> = {}): Pick<Env,
  | 'COMMERCE_DB'
  | 'STRIPE_FULFILLMENT_QUEUE'
  | 'STRIPE_WEBHOOK_SECRET_DEVNET'
  | 'STRIPE_WEBHOOK_SECRET'
> {
  return {
    COMMERCE_DB: createCommerceD1(),
    STRIPE_FULFILLMENT_QUEUE: queue(),
    STRIPE_WEBHOOK_SECRET_DEVNET: DEVNET_SECRET,
    STRIPE_WEBHOOK_SECRET: MAINNET_SECRET,
    ...overrides,
  };
}

function checkoutEnvironment(
  document: Record<string, unknown>,
  overrides: Partial<Pick<Env,
    | 'STRIPE_FULFILLMENT_QUEUE'
    | 'STRIPE_WEBHOOK_SECRET_DEVNET'
    | 'STRIPE_WEBHOOK_SECRET'
  >> = {},
) {
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, storedDocument(document));
  return {
    harness,
    env: env({ ...overrides, COMMERCE_DB: harness.db }),
  };
}

function conflictDatabase(db: D1Database, conflicts: number): D1Database {
  return {
    ...db,
    batch: async (statements) => {
      if (conflicts > 0) {
        conflicts -= 1;
        throw new Error('transaction conflict');
      }
      return db.batch(statements);
    },
  } as D1Database;
}

function stripeEvent(options: {
  dropId?: string;
  eventId?: string;
  eventType?: string;
  livemode?: boolean;
  paymentStatus?: string;
  sessionId?: string;
  fulfillmentMode?: string;
} = {}): Record<string, unknown> {
  return {
    id: options.eventId || 'evt_test_123',
    object: 'event',
    type: options.eventType || 'checkout.session.completed',
    data: {
      object: {
        id: options.sessionId || 'cs_test_123',
        object: 'checkout.session',
        livemode: options.livemode === true,
        mode: 'payment',
        payment_status: options.paymentStatus || 'paid',
        automatic_tax: { enabled: true, status: 'complete' },
        amount_subtotal: 100,
        amount_total: 100,
        total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
        currency: STRIPE_OFFCHAIN_CURRENCY,
        metadata: {
          fulfillmentMode: options.fulfillmentMode ?? STRIPE_OFFCHAIN_FULFILLMENT_MODE,
          dropId: options.dropId || DEVNET_DROP,
          quantity: '1',
        },
      },
    },
  };
}

async function signedRequest(
  event: Record<string, unknown>,
  secret = DEVNET_SECRET,
  headers: HeadersInit = {},
): Promise<Request> {
  const payload = JSON.stringify(event);
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    timestamp: Math.floor(Date.now() / 1000),
    cryptoProvider: Stripe.createSubtleCryptoProvider(crypto.subtle),
  });
  return new Request('https://api.mons.shop/webhooks/stripe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': signature,
      ...headers,
    },
    body: payload,
  });
}

function storedValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return { integerValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(storedValue) } };
  if (value && typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, storedValue(entry)]),
        ),
      },
    };
  }
  throw new Error('unsupported test value');
}

function storedDocument(document: Record<string, unknown>, updateTime = '2026-08-20T10:00:00.000000Z') {
  return {
    name: `projects/mons-shop/databases/(default)/documents/drops/${document.dropId}/stripeCheckouts/${document.sessionId}`,
    fields: Object.fromEntries(
      Object.entries(document).map(([key, value]) => [key, storedValue(value)]),
    ),
    updateTime,
  };
}

function checkoutDocument(options: {
  dropId?: string;
  livemode?: boolean;
  sessionId?: string;
  status?: string;
  deliveryId?: number;
} = {}): Record<string, unknown> {
  const document = buildStripeCheckoutDocument({
    dropId: options.dropId || DEVNET_DROP,
    sessionId: options.sessionId || 'cs_test_123',
    uid: 'auth-user',
    quantity: 1,
    unitAmountCents: 100,
    livemode: options.livemode === true,
    createdAt: 'created',
    updatedAt: 'updated',
  });
  document.status = options.status || STRIPE_CHECKOUT_STATUS.CREATED;
  if (options.deliveryId) document.deliveryId = options.deliveryId;
  return document;
}

test('signed devnet webhook atomically queues the existing checkout', async () => {
  const logs: Record<string, unknown>[] = [];
  const jobs: unknown[] = [];
  const context = checkoutEnvironment(checkoutDocument(), {
    STRIPE_FULFILLMENT_QUEUE: queue(async (body) => {
      jobs.push(body);
      return { metadata: { metrics: { backlogCount: 1, backlogBytes: 128 } } };
    }),
  });
  const result = await handleStripeWebhookRequest(
    await signedRequest(stripeEvent()),
    context.env,
    {
      log: (entry) => logs.push(entry),
    },
  );

  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    received: true,
    queued: true,
    dropId: DEVNET_DROP,
    sessionId: 'cs_test_123',
    checkoutPath: `drops/${DEVNET_DROP}/stripeCheckouts/cs_test_123`,
  });
  assert.equal(result.outcome, 'queued');
  assert.equal(result.metrics.upstreamCalls, 0);
  assert.ok(result.metrics.providerDurationMs >= 0);
  assert.equal(result.response.headers.has('access-control-allow-origin'), false);
  const checkout = await createStripeCheckoutStore({ commerceDb: context.harness.db })
    .doc(`drops/${DEVNET_DROP}/stripeCheckouts/cs_test_123`)
    .get();
  assert.equal(checkout.get('status'), STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING);
  assert.equal(checkout.get('paymentStatus'), 'paid');
  assert.equal(checkout.get('fulfillmentProcessor'), 'cloudflare_queue_v1');
  assert.deepEqual(checkout.get('stripeWebhookEventIds'), ['evt_test_123']);
  assert.equal(checkout.get('manualRefundReviewRequired'), undefined);
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /whsec_|Stripe-Signature|automatic_tax|amount_total/);
  assert.match(serializedLogs, /stripe_webhook_request/);
  assert.match(serializedLogs, /stripe_fulfillment_job_enqueued/);
  assert.match(serializedLogs, /evt_test_123/);
  assert.deepEqual(jobs, [{
    version: 1,
    kind: 'stripe_checkout_fulfillment',
    dropId: DEVNET_DROP,
    sessionId: 'cs_test_123',
    stripeEventId: 'evt_test_123',
    stripeEventType: 'checkout.session.completed',
    enqueuedAtMs: (jobs[0] as { enqueuedAtMs: number }).enqueuedAtMs,
  }]);
});

test('webhook rejects invalid signatures, cross-scope signatures, and invalid secret configuration', async () => {
  const invalidSignature = await handleStripeWebhookRequest(
    new Request('https://api.mons.shop/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=invalid' },
      body: JSON.stringify(stripeEvent()),
    }),
    env(),
    { log: () => undefined },
  );
  assert.equal(invalidSignature.response.status, 400);
  assert.equal(invalidSignature.outcome, 'invalid_signature');

  const scopeMismatch = await handleStripeWebhookRequest(
    await signedRequest(stripeEvent({ dropId: MAINNET_DROP, livemode: true, sessionId: 'cs_live_123' })),
    env(),
    { log: () => undefined },
  );
  assert.equal(scopeMismatch.response.status, 400);
  assert.equal(scopeMismatch.outcome, 'secret_scope_mismatch');
  assert.equal(scopeMismatch.dropId, MAINNET_DROP);

  const missingConfiguration = await handleStripeWebhookRequest(
    new Request('https://api.mons.shop/webhooks/stripe', { method: 'POST' }),
    env({ STRIPE_WEBHOOK_SECRET: '' }),
    { log: () => undefined },
  );
  assert.equal(missingConfiguration.response.status, 500);
  assert.equal(missingConfiguration.outcome, 'configuration_error');

  const duplicateConfiguration = await handleStripeWebhookRequest(
    new Request('https://api.mons.shop/webhooks/stripe', { method: 'POST' }),
    env({ STRIPE_WEBHOOK_SECRET: DEVNET_SECRET }),
    { log: () => undefined },
  );
  assert.equal(duplicateConfiguration.response.status, 500);
  assert.equal(duplicateConfiguration.outcome, 'configuration_error');
});

test('webhook acknowledges unsupported, unrelated, and awaiting-payment events without commerce access', async () => {
  let providerCalls = 0;
  const dependencies = {
    log: () => undefined,
    providerFetch: async () => {
      providerCalls += 1;
      return Response.json({});
    },
  };
  const unsupported = await handleStripeWebhookRequest(
    await signedRequest(stripeEvent({ eventType: 'customer.created' })),
    env(),
    dependencies,
  );
  assert.equal(unsupported.response.status, 200);
  assert.equal(unsupported.outcome, 'unsupported_event');

  const unrelated = await handleStripeWebhookRequest(
    await signedRequest(stripeEvent({ fulfillmentMode: 'other' })),
    env(),
    dependencies,
  );
  assert.equal(unrelated.response.status, 200);
  assert.equal(unrelated.outcome, 'not_app_fulfillment');

  const awaiting = await handleStripeWebhookRequest(
    await signedRequest(stripeEvent({ paymentStatus: 'unpaid' })),
    env(),
    dependencies,
  );
  assert.equal(awaiting.response.status, 200);
  assert.equal(awaiting.outcome, 'awaiting_payment');
  assert.equal(providerCalls, 0);
});

test('webhook enforces methods, content type, bounded bodies, and required signatures', async () => {
  const method = await handleStripeWebhookRequest(
    new Request('https://api.mons.shop/webhooks/stripe'),
    env(),
    { log: () => undefined },
  );
  assert.equal(method.response.status, 405);
  assert.equal(method.response.headers.get('allow'), 'POST');

  const unsigned = await handleStripeWebhookRequest(
    new Request('https://api.mons.shop/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
    env(),
    { log: () => undefined },
  );
  assert.equal(unsigned.response.status, 400);

  const wrongContentType = await handleStripeWebhookRequest(
    new Request('https://api.mons.shop/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Stripe-Signature': 'present' },
      body: '{}',
    }),
    env(),
    { log: () => undefined },
  );
  assert.equal(wrongContentType.response.status, 400);
  assert.equal(wrongContentType.outcome, 'invalid_request');

  const oversized = await handleStripeWebhookRequest(
    new Request('https://api.mons.shop/webhooks/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(256 * 1024 + 1),
        'Stripe-Signature': 'present',
      },
      body: '{}',
    }),
    env(),
    { log: () => undefined },
  );
  assert.equal(oversized.response.status, 400);
  assert.equal(oversized.outcome, 'request_too_large');
});

test('webhook retries optimistic D1 conflicts and surfaces exhausted conflicts', async () => {
  const successContext = checkoutEnvironment(checkoutDocument());
  const request = await signedRequest(stripeEvent());
  const success = await handleStripeWebhookRequest(request, {
    ...successContext.env,
    COMMERCE_DB: conflictDatabase(successContext.harness.db, 1),
  }, {
    log: () => undefined,
  });
  assert.equal(success.response.status, 200);
  assert.equal(success.outcome, 'queued');

  const exhaustedContext = checkoutEnvironment(checkoutDocument());
  const exhausted = await handleStripeWebhookRequest(await signedRequest(stripeEvent()), {
    ...exhaustedContext.env,
    COMMERCE_DB: conflictDatabase(exhaustedContext.harness.db, 3),
  }, {
    log: () => undefined,
  });
  assert.equal(exhausted.response.status, 500);
  assert.equal(exhausted.outcome, 'write_conflict');
});

test('webhook commits before publish and duplicate delivery repairs a failed Queue send', async () => {
  const context = checkoutEnvironment(checkoutDocument(), {
    STRIPE_FULFILLMENT_QUEUE: queue(async () => {
      throw new Error('queue unavailable');
    }),
  });
  const failed = await handleStripeWebhookRequest(
    await signedRequest(stripeEvent()),
    context.env,
    {
      log: () => undefined,
    },
  );
  assert.equal(failed.response.status, 500);
  assert.equal(failed.outcome, 'processing_error');
  const reference = createStripeCheckoutStore({ commerceDb: context.harness.db })
    .doc(`drops/${DEVNET_DROP}/stripeCheckouts/cs_test_123`);
  assert.equal((await reference.get()).get('status'), STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING);

  const jobs: unknown[] = [];
  const events: string[] = [];
  const repaired = await handleStripeWebhookRequest(
    await signedRequest(stripeEvent()),
    {
      ...context.env,
      STRIPE_FULFILLMENT_QUEUE: queue(async (body) => {
        events.push('queue');
        jobs.push(body);
        return { metadata: { metrics: { backlogCount: 1, backlogBytes: 128 } } };
      }),
    },
    {
      log: () => undefined,
    },
  );
  assert.equal(repaired.response.status, 200);
  assert.equal(repaired.outcome, 'already_pending');
  assert.equal(jobs.length, 1);
  assert.deepEqual(events, ['queue']);
});

test('signed mainnet webhook uses the live secret and preserves fulfilled idempotency', async () => {
  const context = checkoutEnvironment(checkoutDocument({
    dropId: MAINNET_DROP,
    livemode: true,
    sessionId: 'cs_live_123',
    status: STRIPE_CHECKOUT_STATUS.FULFILLED,
    deliveryId: 17,
  }));
  const result = await handleStripeWebhookRequest(
    await signedRequest(
      stripeEvent({ dropId: MAINNET_DROP, livemode: true, sessionId: 'cs_live_123' }),
      MAINNET_SECRET,
    ),
    context.env,
    {
      log: () => undefined,
    },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.outcome, 'already_fulfilled');
  assert.deepEqual(await result.response.json(), {
    received: true,
    ignored: true,
    reason: 'already_fulfilled',
    dropId: MAINNET_DROP,
    sessionId: 'cs_live_123',
    deliveryId: 17,
  });
  const checkout = await createStripeCheckoutStore({ commerceDb: context.harness.db })
    .doc(`drops/${MAINNET_DROP}/stripeCheckouts/cs_live_123`)
    .get();
  assert.equal(checkout.get('lastStripeWebhookEventId'), 'evt_test_123');
  assert.equal(checkout.get('status'), STRIPE_CHECKOUT_STATUS.FULFILLED);
});

test('invalid and missing checkout documents stay retryable', async () => {
  const invalidDocument = checkoutDocument();
  delete invalidDocument.uid;
  const invalidContext = checkoutEnvironment(invalidDocument);
  const invalid = await handleStripeWebhookRequest(await signedRequest(stripeEvent()), invalidContext.env, {
    log: () => undefined,
  });
  assert.equal(invalid.response.status, 500);
  assert.equal(invalid.outcome, 'processing_error');

  const missing = await handleStripeWebhookRequest(await signedRequest(stripeEvent()), env(), {
    log: () => undefined,
  });
  assert.equal(missing.response.status, 500);
  assert.equal(missing.outcome, 'processing_error');
});

test('shared transition keeps duplicate deliveries idempotent', () => {
  const event = stripeEvent() as StripeWebhookEvent;
  const action = resolveStripeWebhookAction(event, (dropId) => ({
    dropId,
    solanaCluster: 'devnet',
    itemsPerBox: 0,
    salesMode: 'stripe_receipt_only',
  }));
  assert.equal(action.kind, 'enqueue');
  if (action.kind !== 'enqueue') return;

  const pending = stripeWebhookTransition(
    checkoutDocument({ status: STRIPE_CHECKOUT_STATUS.PROCESSING }),
    action,
  );
  assert.equal(pending.outcome, 'already_pending');
  assert.deepEqual(pending.deleteFields, []);

  const fulfilled = stripeWebhookTransition(
    checkoutDocument({ status: STRIPE_CHECKOUT_STATUS.FULFILLED, deliveryId: 42 }),
    action,
  );
  assert.equal(fulfilled.outcome, 'already_fulfilled');
  assert.equal(fulfilled.deliveryId, 42);

  const failed = stripeWebhookTransition(
    checkoutDocument({ status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED }),
    action,
  );
  assert.equal(failed.outcome, 'queued');
  assert.ok(failed.deleteFields.includes('manualRefundReviewRequired'));
  assert.ok(failed.serverTimestampFields.includes('fulfillmentRequestedAt'));
});
