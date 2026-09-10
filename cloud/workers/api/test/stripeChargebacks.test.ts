import assert from 'node:assert/strict';
import test from 'node:test';
import { commerceKeys } from '../src/commerceRepository.ts';
import {
  loadStripeChargebackSessionIds,
  recordStripeChargeback,
  StripeChargebackStoreError,
  type StripeChargebackRecord,
} from '../src/stripeChargebackStore.ts';
import {
  backfillStripeChargebacks,
  processStripeDispute,
  stripeRead,
  StripeChargebackError,
  type StripeChargebackEnv,
} from '../src/stripeChargebacks.ts';
import {
  createCommerceD1Harness,
  seedCommerceDocument,
  type CommerceD1Harness,
} from './commerceD1Harness.ts';
import { normalizeStripeDispute } from '../../../../shared/stripeChargebacks.ts';

function rawDispute(overrides: Record<string, unknown> = {}) {
  return { object: 'dispute', id: 'du_history', charge: 'ch_history', payment_intent: 'pi_history',
    livemode: true, created: 100, status: 'warning_closed', ...overrides };
}

function session(overrides: Record<string, unknown> = {}) {
  return { object: 'checkout.session', id: 'cs_live_history', payment_intent: 'pi_history',
    livemode: true, metadata: { dropId: 'retired_drop', fulfillmentMode: 'admin_variant_receipt' }, ...overrides };
}

function list(data: unknown[], has_more = false) {
  return { object: 'list', data, has_more };
}

function env(harness: CommerceD1Harness): StripeChargebackEnv {
  return { COMMERCE_DB: harness.db, STRIPE_SECRET_KEY_LIVE: 'sk_live_secret',
    STRIPE_RESTRICTED_KEY_LIVE: 'rk_live_fallback', STRIPE_SECRET_KEY: 'sk_test_secret' };
}

function seedOrder(harness: CommerceD1Harness, options: {
  checkout?: boolean; delivery?: boolean; sessionId?: string; dropId?: string;
  livemode?: boolean; paymentIntentId?: string; source?: string;
} = {}) {
  const dropId = options.dropId || 'retired_drop';
  const sessionId = options.sessionId || 'cs_live_history';
  if (options.checkout !== false) seedCommerceDocument(harness, {
    key: commerceKeys.stripeCheckout(dropId, sessionId),
    data: { dropId, sessionId, livemode: options.livemode !== false, status: 'fulfilled' },
  });
  if (options.delivery !== false) seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder(dropId, '42'),
    data: { dropId, source: options.source || 'stripe_offchain', status: 'ready_to_ship',
      fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: 'untouched', stripeCheckoutSessionId: sessionId,
      ...(options.paymentIntentId ? { stripePaymentIntentId: options.paymentIntentId } : {}),
      itemIds: [1, 2], quantity: 2, receiptsMinted: 2, owner: 'historical_owner' },
  });
}

function commerceSnapshot(harness: CommerceD1Harness) {
  return JSON.stringify(['commerce_documents', 'commerce_authority_control', 'commerce_document_path_revisions',
    'commerce_delivery_owner_revisions'].map((table) => harness.database.prepare(`SELECT * FROM ${table}`).all()));
}

function provider(handler: (url: URL, init?: RequestInit) => unknown | Response | Promise<unknown | Response>): typeof fetch {
  return async (input, init) => {
    const result = await handler(new URL(String(input)), init);
    return result instanceof Response ? result : Response.json(result);
  };
}

function storedRecord(overrides: Partial<StripeChargebackRecord> = {}): StripeChargebackRecord {
  return { livemode: true, sessionId: 'cs_live_history', disputeId: 'du_history', dropId: 'retired_drop',
    chargeId: 'ch_history', paymentIntentId: 'pi_history', disputeCreatedAt: 100, recordedAtMs: 200, ...overrides };
}

function serviceOptions(providerFetch: typeof fetch) {
  return { signal: new AbortController().signal, providerFetch, nowMs: () => 200 };
}

test('chargeback storage is idempotent, detects identity conflicts, and never changes commerce rows or revisions', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness);
  const before = commerceSnapshot(harness);
  assert.equal(await recordStripeChargeback(harness.db, storedRecord(), false), 'unwritten');
  assert.equal(await recordStripeChargeback(harness.db, storedRecord()), 'inserted');
  assert.deepEqual(await Promise.all([
    recordStripeChargeback(harness.db, storedRecord({ recordedAtMs: 300 })),
    recordStripeChargeback(harness.db, storedRecord({ recordedAtMs: 400 })),
  ]), ['existing', 'existing']);
  assert.equal(await recordStripeChargeback(harness.db, storedRecord(), false), 'existing');
  assert.equal(harness.database.prepare('SELECT recorded_at_ms FROM stripe_order_disputes').get()?.recorded_at_ms, 200);
  for (const mismatch of [{ dropId: 'other_drop' }, { paymentIntentId: 'pi_wrong' }, { chargeId: 'ch_wrong' },
    { disputeCreatedAt: 101 }, { livemode: false }]) {
    await assert.rejects(recordStripeChargeback(harness.db, storedRecord(mismatch)), StripeChargebackStoreError);
  }
  assert.equal(commerceSnapshot(harness), before);
  assert.equal(harness.database.prepare('SELECT count(*) AS count FROM stripe_order_disputes').get()?.count, 1);
  harness.database.close();
});

test('chargeback lookup is scoped to exact drop/session identities and returns a deduplicated set', async () => {
  const harness = createCommerceD1Harness();
  await recordStripeChargeback(harness.db, storedRecord());
  await recordStripeChargeback(harness.db, storedRecord({ disputeId: 'du_second' }));
  await recordStripeChargeback(harness.db, storedRecord({ sessionId: 'cs_test_history', livemode: false }));
  const ids = Array.from({ length: 55 }, (_, i) => `cs_live_other${i}`);
  assert.deepEqual(await loadStripeChargebackSessionIds(harness.db, 'retired_drop', [
    ...ids, 'cs_live_history', 'cs_test_history', 'cs_live_history', ' cs_live_history',
  ]), new Set(['cs_live_history', 'cs_test_history']));
  assert.deepEqual(await loadStripeChargebackSessionIds(harness.db, 'other_drop', ['cs_live_history']), new Set());
  assert.deepEqual(await loadStripeChargebackSessionIds(harness.db, 'retired_drop', []), new Set());
  harness.database.close();
});

test('disputes match retired fulfilled checkouts and shipped orders without mutating processing data', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness);
  const before = commerceSnapshot(harness);
  const calls: string[] = [];
  const options = serviceOptions(provider((url, init) => {
    calls.push(url.pathname);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer sk_live_secret');
    assert.equal(new Headers(init?.headers).get('Stripe-Version'), '2026-07-29.dahlia');
    assert.equal(url.searchParams.get('payment_intent'), 'pi_history');
    return list([session()]);
  }));
  const dispute = normalizeStripeDispute(rawDispute())!;
  assert.deepEqual(await processStripeDispute(dispute, env(harness), options), {
    matchedOrders: 1, inserted: 1, existing: 0, unrelated: 0,
  });
  assert.deepEqual(await processStripeDispute(dispute, env(harness), options), {
    matchedOrders: 1, inserted: 0, existing: 1, unrelated: 0,
  });
  assert.equal(commerceSnapshot(harness), before);
  assert.deepEqual(calls, ['/v1/checkout/sessions', '/v1/checkout/sessions']);
  harness.database.close();
});

test('legacy Stripe delivery orders match without checkout metadata or stored PaymentIntent', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness, { checkout: false });
  const result = await processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness),
    serviceOptions(provider(() => list([session({ metadata: {} })]))));
  assert.equal(result.inserted, 1);
  assert.equal(result.matchedOrders, 1);
  harness.database.close();
});

test('missing dispute PaymentIntent is resolved through its validated charge, including expanded IDs', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness);
  const calls: string[] = [];
  const result = await processStripeDispute(normalizeStripeDispute(rawDispute({ payment_intent: null }))!, env(harness),
    serviceOptions(provider((url) => {
      calls.push(url.pathname);
      if (url.pathname === '/v1/charges/ch_history') return {
        object: 'charge', id: 'ch_history', livemode: true, payment_intent: { id: 'pi_history', livemode: true },
      };
      return list([session({ payment_intent: { id: 'pi_history', livemode: true } })]);
    })));
  assert.equal(result.inserted, 1);
  assert.deepEqual(calls, ['/v1/charges/ch_history', '/v1/checkout/sessions']);
  harness.database.close();
});

test('stored PaymentIntent linkage retrieves the exact session if filtered Stripe listing omits it', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness, { checkout: false, paymentIntentId: 'pi_history' });
  const calls: string[] = [];
  const result = await processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness),
    serviceOptions(provider((url) => {
      calls.push(url.pathname);
      return url.pathname === '/v1/checkout/sessions' ? list([]) : session({ metadata: {} });
    })));
  assert.equal(result.inserted, 1);
  assert.deepEqual(calls, ['/v1/checkout/sessions', '/v1/checkout/sessions/cs_live_history']);
  harness.database.close();
});

test('charge fallback rejects wrong identities, modes, and missing fields rather than treating them as unrelated', async () => {
  const harness = createCommerceD1Harness();
  for (const value of [
    { object: 'charge', id: 'ch_wrong', livemode: true, payment_intent: 'pi_history' },
    { object: 'charge', id: 'ch_history', livemode: false, payment_intent: 'pi_history' },
    { object: 'charge', id: 'ch_history', livemode: true },
  ]) {
    await assert.rejects(processStripeDispute(normalizeStripeDispute(rawDispute({ payment_intent: null }))!, env(harness),
      serviceOptions(provider(() => value))), { code: 'stripe-invalid-response' });
  }
  harness.database.close();
});

test('session pagination scans past unrelated sessions and guards repeated provider cursors', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness);
  const cursors: Array<string | null> = [];
  const result = await processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness),
    serviceOptions(provider((url) => {
      cursors.push(url.searchParams.get('starting_after'));
      return cursors.length === 1 ? list([session({ id: 'cs_live_unrelated', metadata: {} })], true) : list([session()]);
    })));
  assert.equal(result.inserted, 1);
  assert.deepEqual(cursors, [null, 'cs_live_unrelated']);
  await assert.rejects(processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness),
    serviceOptions(provider(() => list([session()], true)))), { code: 'stripe-invalid-response' });
  harness.database.close();
});

test('test-mode lookups use only test credentials and same-mode credential rejection falls back safely', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness, { sessionId: 'cs_test_history', livemode: false });
  const options = serviceOptions(provider((_url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer sk_test_secret');
    return list([session({ id: 'cs_test_history', livemode: false })]);
  }));
  assert.equal((await processStripeDispute(normalizeStripeDispute(rawDispute({ livemode: false }))!, env(harness), options)).inserted, 1);
  const keys: Array<string | null> = [];
  await processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness), serviceOptions(provider((_url, init) => {
    const key = new Headers(init?.headers).get('Authorization');
    keys.push(key);
    return key === 'Bearer sk_live_secret' ? new Response(null, { status: 403 }) : list([]);
  })));
  assert.deepEqual(keys, ['Bearer sk_live_secret', 'Bearer rk_live_fallback']);
  await assert.rejects(processStripeDispute(normalizeStripeDispute(rawDispute())!,
    { COMMERCE_DB: harness.db, STRIPE_SECRET_KEY: 'sk_test_secret' }, options), { code: 'stripe-not-configured' });
  harness.database.close();
});

test('provider and stored-order identity mismatches never create a chargeback association', async () => {
  for (const overrides of [{ livemode: false }, { payment_intent: 'pi_wrong' }, { id: 'cs_test_history' },
    { payment_intent: { id: 'pi_history', livemode: false } }]) {
    const harness = createCommerceD1Harness();
    seedOrder(harness);
    await assert.rejects(processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness),
      serviceOptions(provider(() => list([session(overrides)])))), { code: 'stripe-invalid-response' });
    assert.equal(harness.database.prepare('SELECT count(*) AS count FROM stripe_order_disputes').get()?.count, 0);
    harness.database.close();
  }
  const harness = createCommerceD1Harness();
  seedOrder(harness, { livemode: false, paymentIntentId: 'pi_wrong' });
  await assert.rejects(processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness),
    serviceOptions(provider(() => list([session()])))), { code: 'chargeback-identity-conflict' });
  harness.database.close();
});

test('app-marked unmatched sessions retry while unrelated sessions and non-Checkout charges are ignored', async () => {
  const harness = createCommerceD1Harness();
  await assert.rejects(processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness),
    serviceOptions(provider(() => list([session()])))), { code: 'chargeback-order-pending' });
  const unrelated = await processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness),
    serviceOptions(provider(() => list([session({ metadata: {} })]))));
  assert.equal(unrelated.unrelated, 1);
  const nonCheckout = await processStripeDispute(normalizeStripeDispute(rawDispute({ payment_intent: null }))!, env(harness),
    serviceOptions(provider(() => ({ object: 'charge', id: 'ch_history', livemode: true, payment_intent: null }))));
  assert.equal(nonCheckout.unrelated, 1);
  seedOrder(harness, { checkout: false, source: 'admin_irl' });
  assert.equal((await processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness),
    serviceOptions(provider(() => list([session({ metadata: {} })]))))).unrelated, 1);
  harness.database.close();
});

test('inquiry recorded before the delivery order exists is visible when fulfillment creates that order', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness, { delivery: false });
  await processStripeDispute(normalizeStripeDispute(rawDispute({ status: 'warning_under_review' }))!, env(harness),
    serviceOptions(provider(() => list([session()]))));
  seedOrder(harness, { checkout: false });
  assert.deepEqual(await loadStripeChargebackSessionIds(harness.db, 'retired_drop', ['cs_live_history']), new Set(['cs_live_history']));
  const data = harness.database.prepare("SELECT document_json FROM commerce_documents WHERE document_kind = 'delivery_order'").get();
  assert.equal(JSON.parse(String(data?.document_json)).fulfillmentStatus, 'Shipped');
  harness.database.close();
});

test('backfill pages all statuses, defaults to dry-run, and reports idempotent apply counts', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness);
  const requests: URL[] = [];
  const options = serviceOptions(provider((url) => {
    requests.push(url);
    if (url.pathname === '/v1/disputes') {
      assert.equal(url.searchParams.get('limit'), '1');
      assert.equal(url.searchParams.get('status'), null);
      return url.searchParams.get('starting_after') === 'du_history'
        ? list([rawDispute({ id: 'du_second', status: 'warning_closed' })])
        : list([rawDispute({ status: 'won' })], true);
    }
    return list([session()]);
  }));
  assert.deepEqual(await backfillStripeChargebacks({ mode: 'live', cursor: 'du_previous' }, env(harness), options), {
    mode: 'live', write: false, nextCursor: 'du_history', scanned: 1, matchedOrders: 1,
    inserted: 0, existing: 0, unrelated: 0, failures: [],
  });
  assert.equal(requests[0].searchParams.get('starting_after'), 'du_previous');
  assert.deepEqual(await backfillStripeChargebacks({ mode: 'live', cursor: 'du_history' }, env(harness), options), {
    mode: 'live', write: false, nextCursor: null, scanned: 1, matchedOrders: 1,
    inserted: 0, existing: 0, unrelated: 0, failures: [],
  });
  assert.equal(harness.database.prepare('SELECT count(*) AS count FROM stripe_order_disputes').get()?.count, 0);
  for (const cursor of ['du_previous', 'du_history']) {
    assert.equal((await backfillStripeChargebacks({ mode: 'live', write: true, cursor }, env(harness), options)).inserted, 1);
    const repeated = await backfillStripeChargebacks({ mode: 'live', write: true, cursor }, env(harness), options);
    assert.equal(repeated.inserted, 0);
    assert.equal(repeated.existing, 1);
  }
  harness.database.close();
});

test('dispute reads accept large Unicode pages and backfill advances one dispute at a time', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness);
  const evidence = Object.fromEntries([
    'product_description', 'uncategorized_text', 'refund_policy_disclosure', 'refund_refusal_explanation',
  ].map((field) => [field, '界'.repeat(20_000)]));
  const page = list(Array.from({ length: 10 }, (_, index) => rawDispute({ id: `du_unicode${index}`, evidence })), true);
  const body = JSON.stringify(page);
  assert.ok(Buffer.byteLength(body) > 2 * 1024 * 1024);
  assert.deepEqual(await stripeRead('disputes', { limit: '10' }, 'live', env(harness),
    serviceOptions(provider(() => new Response(body, { headers: { 'Content-Type': 'application/json' } })))), page);
  const cursors: Array<string | null> = [];
  const options = serviceOptions(provider((url) => {
    if (url.pathname !== '/v1/disputes') return list([session()]);
    assert.equal(url.searchParams.get('limit'), '1');
    const cursor = url.searchParams.get('starting_after');
    cursors.push(cursor);
    return cursor === null
      ? list([page.data[0]], true)
      : list([rawDispute({ id: 'du_final' })]);
  }));
  const first = await backfillStripeChargebacks({ mode: 'live', write: true }, env(harness), options);
  assert.deepEqual(first, {
    mode: 'live', write: true, nextCursor: 'du_unicode0', scanned: 1, matchedOrders: 1,
    inserted: 1, existing: 0, unrelated: 0, failures: [],
  });
  const next = await backfillStripeChargebacks({ mode: 'live', write: true, cursor: first.nextCursor! }, env(harness), options);
  assert.equal(next.nextCursor, null);
  assert.equal(next.inserted, 1);
  assert.deepEqual(next.failures, []);
  assert.deepEqual(cursors, [null, 'du_unicode0']);
  assert.equal(harness.database.prepare('SELECT count(*) AS count FROM stripe_order_disputes').get()?.count, 2);
  harness.database.close();
});

test('dispute listing rejects response bodies larger than 12 MiB', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness);
  const page = list([rawDispute({ evidence: { uncategorized_text: 'x'.repeat(12 * 1024 * 1024) } })]);
  await assert.rejects(backfillStripeChargebacks({ mode: 'live', write: true }, env(harness),
    serviceOptions(provider(() => page))), { code: 'stripe-invalid-response', status: 502 });
  assert.equal(harness.database.prepare('SELECT count(*) AS count FROM stripe_order_disputes').get()?.count, 0);
  harness.database.close();
});

test('a failed backfill page retains its cursor and successful inserts are safe to replay', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness);
  let fail = true;
  const options = serviceOptions(provider((url) => {
    if (url.pathname === '/v1/disputes') return list([rawDispute()], true);
    return fail ? new Response('do not disclose this provider body', { status: 500 }) : list([session()]);
  }));
  const first = await backfillStripeChargebacks({ mode: 'live', write: true, cursor: 'du_previous' }, env(harness), options);
  assert.equal(first.nextCursor, 'du_previous');
  assert.equal(first.inserted, 0);
  assert.deepEqual(first.failures, [{ disputeId: 'du_history', code: 'stripe-http-500' }]);
  fail = false;
  const retry = await backfillStripeChargebacks({ mode: 'live', write: true, cursor: 'du_previous' }, env(harness), options);
  assert.equal(retry.nextCursor, 'du_history');
  assert.equal(retry.inserted, 1);
  assert.deepEqual(retry.failures, []);
  const replay = await backfillStripeChargebacks({ mode: 'live', write: true, cursor: 'du_previous' }, env(harness), options);
  assert.equal(replay.nextCursor, 'du_history');
  assert.equal(replay.inserted, 0);
  assert.equal(replay.existing, 1);
  harness.database.close();
});

test('backfill rejects malformed pagination and wrong-mode disputes without flagging orders', async () => {
  const harness = createCommerceD1Harness();
  seedOrder(harness);
  for (const payload of [list([], true), { object: 'list', data: [], has_more: 'false' }, list([{}]),
    list([rawDispute(), rawDispute({ id: 'du_second' })])]) {
    await assert.rejects(backfillStripeChargebacks({ mode: 'live' }, env(harness),
      serviceOptions(provider(() => payload))), { code: 'stripe-invalid-response' });
  }
  const result = await backfillStripeChargebacks({ mode: 'live', write: true }, env(harness),
    serviceOptions(provider(() => list([rawDispute({ livemode: false })]))));
  assert.deepEqual(result.failures, [{ disputeId: 'du_history', code: 'invalid-dispute' }]);
  assert.equal(result.nextCursor, null);
  assert.equal(harness.database.prepare('SELECT count(*) AS count FROM stripe_order_disputes').get()?.count, 0);
  harness.database.close();
});

test('chargeback provider reads bound response size and propagate cancellation without leaking provider errors', async () => {
  const harness = createCommerceD1Harness();
  const controller = new AbortController();
  const cancel = new Error('cancelled');
  controller.abort(cancel);
  await assert.rejects(processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness), {
    signal: controller.signal, providerFetch: provider(() => { throw new Error('must not call provider'); }),
  }), (error) => error === cancel);
  await assert.rejects(backfillStripeChargebacks({ mode: 'live' }, env(harness), {
    signal: controller.signal, providerFetch: provider(() => { throw new Error('must not call provider'); }),
  }), (error) => error === cancel);
  await assert.rejects(processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness),
    serviceOptions(provider(() => new Response('secret', { headers: { 'Content-Type': 'application/json', 'Content-Length': '3000000' } })))),
  { code: 'stripe-invalid-response' });
  await assert.rejects(processStripeDispute(normalizeStripeDispute(rawDispute())!, env(harness),
    serviceOptions(provider(() => { throw new Error('secret provider response'); }))),
  (error) => error instanceof StripeChargebackError && !error.message.includes('secret'));
  harness.database.close();
});

test('Stripe provider errors expose only safe HTTP classification and never provider bodies', async () => {
  const harness = createCommerceD1Harness();
  const secret = 'sk_live_do_not_disclose';
  for (const status of [400, 404, 408, 429, 500]) {
    for (const response of [
      new Response(`${secret}: provider details`, { status }),
      Response.json({ error: { message: `${secret}: provider details` } }, { status }),
      new Response(secret, { status, headers: { 'Content-Type': 'application/json', 'Content-Length': '20000' } }),
    ]) {
      await assert.rejects(stripeRead('webhook_endpoints', {}, 'live', env(harness), serviceOptions(provider(() => response))),
      (error: unknown) => {
        assert.ok(error instanceof StripeChargebackError);
        assert.equal(error.code, `stripe-http-${status}`);
        assert.equal(error.status, status === 408 || status === 429 || status >= 500 ? 503 : 502);
        assert.doesNotMatch(`${error}\n${JSON.stringify(error)}`, /sk_live_do_not_disclose|provider details/);
        return true;
      });
    }
  }
  for (const message of [`Invalid Stripe API version: ${secret}`, `Invalid Stripe API Version: ${secret}`]) {
    await assert.rejects(stripeRead('webhook_endpoints', {}, 'live', env(harness), serviceOptions(provider(() =>
      Response.json({ error: { message } }, { status: 400 })))),
    (error: unknown) => {
      assert.ok(error instanceof StripeChargebackError);
      assert.equal(error.code, 'stripe-api-version-unsupported');
      assert.equal(error.status, 502);
      assert.doesNotMatch(`${error}\n${JSON.stringify(error)}`, /sk_live_do_not_disclose/);
      return true;
    });
  }
  await assert.rejects(stripeRead('webhook_endpoints', {}, 'live', env(harness), serviceOptions(provider(() => {
    throw new Error(`${secret}: transport details`);
  }))), (error: unknown) => {
    assert.ok(error instanceof StripeChargebackError);
    assert.equal(error.code, 'stripe-network-error');
    assert.equal(error.status, 503);
    assert.doesNotMatch(`${error}\n${JSON.stringify(error)}`, /sk_live_do_not_disclose|transport details/);
    return true;
  });
  harness.database.close();
});

test('Stripe provider request timeout has its own safe retryable code', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = createCommerceD1Harness();
  const request = stripeRead('webhook_endpoints', {}, 'live', env(harness), {
    signal: new AbortController().signal,
    providerFetch: () => new Promise<Response>(() => undefined),
  });
  const rejected = assert.rejects(request, { code: 'stripe-request-timeout', status: 503 });
  context.mock.timers.tick(10_000);
  await rejected;
  harness.database.close();
});

test('Stripe provider GET and POST reject redirects without forwarding credentials or exposing the location', async () => {
  const harness = createCommerceD1Harness();
  for (const status of [301, 302, 303, 307, 308]) {
    for (const form of [undefined, new URLSearchParams({ 'enabled_events[]': 'charge.dispute.created' })]) {
      const requests: URL[] = [];
      await assert.rejects(stripeRead('webhook_endpoints', {}, 'live', env(harness), serviceOptions(provider((url, init) => {
        requests.push(url);
        assert.equal(url.origin, 'https://api.stripe.com');
        assert.equal(init?.redirect, 'manual');
        assert.equal(init?.method, form ? 'POST' : undefined);
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk_live_secret');
        return new Response('private redirect body', {
          status,
          headers: { Location: 'https://untrusted.example/collect?secret=sk_live_secret' },
        });
      })), form), (error: unknown) => {
        assert.ok(error instanceof StripeChargebackError);
        assert.equal(error.code, 'stripe-redirect-rejected');
        assert.equal(error.status, 502);
        assert.doesNotMatch(`${error}\n${JSON.stringify(error)}`, /sk_live_secret|untrusted\.example|private redirect body/);
        return true;
      });
      assert.equal(requests.length, 1);
    }
  }
  harness.database.close();
});
