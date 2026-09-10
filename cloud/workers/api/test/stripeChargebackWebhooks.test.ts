import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STRIPE_DISPUTE_EVENT_TYPES,
  type StripeChargebackWebhookConfigurationRequest,
} from '../../../../shared/stripeChargebacks.ts';
import { configureStripeChargebackWebhooks } from '../src/stripeChargebackWebhooks.ts';
import { StripeChargebackError, type StripeChargebackEnv } from '../src/stripeChargebacks.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';

const TARGET_URL = 'https://api.mons.shop/webhooks/stripe';

function endpoint(overrides: Record<string, unknown> = {}) {
  return {
    object: 'webhook_endpoint',
    id: 'we_orders',
    url: TARGET_URL,
    livemode: true,
    status: 'enabled',
    enabled_events: ['checkout.session.completed', 'checkout.session.async_payment_succeeded'],
    api_version: '2026-07-29.dahlia',
    description: 'Existing order notifications',
    metadata: { retained: 'true' },
    secret: 'whsec_never_return_this',
    ...overrides,
  };
}

function env(): StripeChargebackEnv {
  return {
    COMMERCE_DB: createCommerceD1Harness().db,
    STRIPE_SECRET_KEY_LIVE: 'sk_live_primary',
    STRIPE_RESTRICTED_KEY_LIVE: 'rk_live_fallback',
    STRIPE_SECRET_KEY: 'sk_test_primary',
    STRIPE_RESTRICTED_KEY: 'rk_test_fallback',
  };
}

function list(data: unknown[], has_more = false) {
  return { object: 'list', data, has_more };
}

function options(handler: (url: URL, init: RequestInit) => unknown | Response | Promise<unknown | Response>) {
  return {
    signal: new AbortController().signal,
    providerFetch: (async (input, init) => {
      assert.equal(init?.redirect, 'manual');
      const value = await handler(new URL(String(input)), init || {});
      return value instanceof Response ? value : Response.json(value);
    }) satisfies typeof fetch,
  };
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof StripeChargebackError && error.code === code;
}

for (const mode of ['live', 'test'] as const) {
  test(`${mode} webhook configuration defaults to dry run and returns no provider secrets`, async () => {
    const original = endpoint({ livemode: mode === 'live', enabled_events: ['charge.dispute.created', 'invoice.paid'] });
    const result = await configureStripeChargebackWebhooks({ mode }, env(), options((url, init) => {
      assert.equal(url.pathname, '/v1/webhook_endpoints');
      assert.equal(url.searchParams.get('limit'), '100');
      assert.equal(init.method, undefined);
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer sk_${mode}_primary`);
      return list([original]);
    }));
    assert.deepEqual(result, {
      mode,
      write: false,
      endpoints: [{
        id: 'we_orders',
        url: TARGET_URL,
        enabledEvents: ['charge.dispute.created', 'invoice.paid'],
        missingEvents: STRIPE_DISPUTE_EVENT_TYPES.filter((type) => type !== 'charge.dispute.created'),
        updated: false,
      }],
      complete: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /whsec_|sk_|rk_|api_version|metadata|description|secret/);
  });
}

test('webhook configuration changes only event subscriptions and verifies them with a fresh read', async () => {
  const original = endpoint();
  let stored = structuredClone(original);
  const calls: string[] = [];
  const result = await configureStripeChargebackWebhooks({ mode: 'live', write: true }, env(), options((url, init) => {
    calls.push(`${init.method || 'GET'} ${url.pathname}`);
    if (url.pathname === '/v1/webhook_endpoints') return list([stored]);
    assert.equal(url.pathname, '/v1/webhook_endpoints/we_orders');
    assert.equal(url.search, '');
    if (init.method === 'POST') {
      assert.equal(new Headers(init.headers).get('content-type'), 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(String(init.body));
      assert.deepEqual([...new Set(form.keys())], ['enabled_events[]']);
      assert.deepEqual(form.getAll('enabled_events[]'), [...original.enabled_events, ...STRIPE_DISPUTE_EVENT_TYPES]);
      stored = { ...stored, enabled_events: form.getAll('enabled_events[]') };
    }
    return stored;
  }));
  assert.deepEqual(calls, [
    'GET /v1/webhook_endpoints',
    'GET /v1/webhook_endpoints/we_orders',
    'POST /v1/webhook_endpoints/we_orders',
    'GET /v1/webhook_endpoints/we_orders',
  ]);
  assert.deepEqual({ ...stored, enabled_events: original.enabled_events }, original);
  assert.equal(result.complete, true);
  assert.equal(result.endpoints[0].updated, true);
  assert.deepEqual(result.endpoints[0].missingEvents, []);
  assert.doesNotMatch(JSON.stringify(result), /whsec_|sk_live_primary/);
});

test('wildcard and already configured endpoints are complete without any mutation', async () => {
  const entries = [
    endpoint({ id: 'we_wildcard', enabled_events: ['*'] }),
    endpoint({ id: 'we_complete', enabled_events: [...STRIPE_DISPUTE_EVENT_TYPES, 'checkout.session.completed'] }),
  ];
  const result = await configureStripeChargebackWebhooks({ mode: 'live', write: true }, env(), options((url, init) => {
    assert.equal(init.method, undefined);
    return url.pathname === '/v1/webhook_endpoints'
      ? list(entries)
      : entries.find((entry) => url.pathname === `/v1/webhook_endpoints/${entry.id}`);
  }));
  assert.equal(result.complete, true);
  assert.equal(result.endpoints.length, 2);
  assert.equal(result.endpoints.every((value) => !value.updated && value.missingEvents.length === 0), true);
});

test('configuration paginates all endpoints and updates every active exact target only', async () => {
  const entries = new Map([
    ['we_one', endpoint({ id: 'we_one', enabled_events: ['charge.dispute.created'] })],
    ['we_two', endpoint({ id: 'we_two', enabled_events: ['checkout.session.completed'] })],
  ]);
  const writes: string[] = [];
  const result = await configureStripeChargebackWebhooks({ mode: 'live', write: true }, env(), options((url, init) => {
    if (url.pathname === '/v1/webhook_endpoints') {
      const cursor = url.searchParams.get('starting_after');
      if (!cursor) return list([
        endpoint({ id: 'we_disabled', status: 'disabled' }),
        endpoint({ id: 'we_other', url: `${TARGET_URL}/` }),
        entries.get('we_one'),
      ], true);
      assert.equal(cursor, 'we_one');
      return list([entries.get('we_two')]);
    }
    const id = url.pathname.split('/').at(-1)!;
    const current = entries.get(id);
    assert.ok(current);
    if (init.method === 'POST') {
      writes.push(id);
      entries.set(id, { ...current, enabled_events: new URLSearchParams(String(init.body)).getAll('enabled_events[]') });
    }
    return entries.get(id);
  }));
  assert.deepEqual(writes, ['we_one', 'we_two']);
  assert.deepEqual(result.endpoints.map((value) => value.id), ['we_one', 'we_two']);
  assert.equal(result.complete, true);
});

test('configuration rejects missing or disabled exact targets without creating or enabling endpoints', async () => {
  for (const entries of [[], [endpoint({ status: 'disabled' })], [endpoint({ url: `${TARGET_URL}?old=1` })]]) {
    await assert.rejects(configureStripeChargebackWebhooks({ mode: 'live', write: true }, env(), options((url, init) => {
      assert.equal(url.pathname, '/v1/webhook_endpoints');
      assert.equal(init.method, undefined);
      return list(entries);
    })), errorCode('stripe-webhook-not-active'));
  }
});

test('configuration rejects mode mismatches, invalid lists and repeated pagination before any update', async () => {
  for (const page of [
    list([endpoint({ livemode: false })]),
    list([endpoint({ enabled_events: ['checkout.session.completed', 'secret event'] })]),
    list([], true),
    list([endpoint(), endpoint()]),
    { object: 'list', data: [], has_more: 'yes' },
  ]) {
    await assert.rejects(configureStripeChargebackWebhooks({ mode: 'live', write: true }, env(), options((_url, init) => {
      assert.equal(init.method, undefined);
      return page;
    })), errorCode('stripe-webhook-invalid-response'));
  }
  let calls = 0;
  await assert.rejects(configureStripeChargebackWebhooks({ mode: 'live', write: true }, env(), options((_url, init) => {
    assert.equal(init.method, undefined);
    calls += 1;
    return list([endpoint()], true);
  })), errorCode('stripe-webhook-invalid-response'));
  assert.equal(calls, 2);
});

test('configuration rejects a response that changes identity, status or drops prior subscriptions', async () => {
  for (const corrupt of [
    { id: 'we_wrong' },
    { url: 'https://elsewhere.example/webhook' },
    { status: 'disabled' },
    { enabled_events: [...STRIPE_DISPUTE_EVENT_TYPES] },
    { enabled_events: ['checkout.session.completed', 'checkout.session.async_payment_succeeded'] },
  ]) {
    let calls = 0;
    let updated = false;
    await assert.rejects(configureStripeChargebackWebhooks({ mode: 'live', write: true }, env(), options((url, init) => {
      calls += 1;
      if (url.pathname === '/v1/webhook_endpoints') return list([endpoint()]);
      const configured = endpoint({ enabled_events: [...endpoint().enabled_events, ...STRIPE_DISPUTE_EVENT_TYPES] });
      if (init.method === 'POST') {
        updated = true;
        return configured;
      }
      return updated ? { ...configured, ...corrupt } : endpoint();
    })), errorCode('stripe-webhook-verification-failed'));
    assert.equal(calls, 4);
  }
});

test('configuration uses only same-mode fallback credentials for list, update and verification', async () => {
  let stored = endpoint({ livemode: false });
  const authorizations: string[] = [];
  const result = await configureStripeChargebackWebhooks({ mode: 'test', write: true }, env(), options((url, init) => {
    const authorization = new Headers(init.headers).get('authorization') || '';
    authorizations.push(authorization);
    if (authorization === 'Bearer sk_test_primary') return new Response('private provider details', { status: 403 });
    assert.equal(authorization, 'Bearer rk_test_fallback');
    if (url.pathname === '/v1/webhook_endpoints') return list([stored]);
    if (init.method === 'POST') stored = { ...stored, enabled_events: new URLSearchParams(String(init.body)).getAll('enabled_events[]') };
    return stored;
  }));
  assert.equal(result.complete, true);
  assert.deepEqual(authorizations, Array.from({ length: 4 }, () => ['Bearer sk_test_primary', 'Bearer rk_test_fallback']).flat());
});

test('configuration merges subscriptions changed after discovery and rechecks whether a write is needed', async () => {
  for (const enabledEvents of [
    ['checkout.session.completed', 'invoice.paid'],
    ['invoice.paid'],
    ['*'],
  ]) {
    let stored = endpoint();
    let writes = 0;
    const result = await configureStripeChargebackWebhooks({ mode: 'live', write: true }, env(), options((url, init) => {
      if (url.pathname === '/v1/webhook_endpoints') {
        const snapshot = structuredClone(stored);
        stored = { ...stored, enabled_events: enabledEvents };
        return list([snapshot]);
      }
      if (init.method === 'POST') {
        writes += 1;
        stored = { ...stored, enabled_events: new URLSearchParams(String(init.body)).getAll('enabled_events[]') };
      }
      return stored;
    }));
    assert.equal(result.complete, true);
    assert.deepEqual(stored.enabled_events, enabledEvents.includes('*')
      ? enabledEvents
      : [...enabledEvents, ...STRIPE_DISPUTE_EVENT_TYPES]);
    assert.equal(writes, enabledEvents.includes('*') ? 0 : 1);
  }
});

test('configuration refuses to write when endpoint identity or status changes after discovery', async () => {
  for (const changes of [{ id: 'we_other' }, { url: 'https://elsewhere.example/webhook' }, { status: 'disabled' }]) {
    let writes = 0;
    await assert.rejects(configureStripeChargebackWebhooks({ mode: 'live', write: true }, env(), options((url, init) => {
      if (init.method === 'POST') writes += 1;
      return url.pathname === '/v1/webhook_endpoints' ? list([endpoint()]) : endpoint(changes);
    })), errorCode('stripe-webhook-verification-failed'));
    assert.equal(writes, 0);
  }
});

test('configuration reports HTTP failures safely and rejects invalid requests without provider work', async () => {
  for (const status of [302, 429, 500]) {
    await assert.rejects(configureStripeChargebackWebhooks({ mode: 'live' }, env(), options(() =>
      new Response('secret provider response', { status }))), errorCode(status === 302 ? 'stripe-redirect-rejected' : `stripe-http-${status}`));
  }
  await assert.rejects(configureStripeChargebackWebhooks({ mode: 'live' }, env(), options(() =>
    new Response('secret provider response', { status: 401 }))), errorCode('stripe-credentials-rejected'));
  await assert.rejects(configureStripeChargebackWebhooks({ mode: 'live', write: true }, env(), options((url) =>
    url.pathname === '/v1/webhook_endpoints' ? list([endpoint()]) : new Response('secret provider response', { status: 500 }))),
  (error: unknown) => {
    assert.ok(error instanceof StripeChargebackError);
    assert.equal(error.code, 'stripe-http-500');
    assert.doesNotMatch(error.message, /secret provider response/);
    return true;
  });
  for (const request of [null, {}, { mode: 'invalid' }, { mode: 'live', write: 'yes' }, { mode: 'live', url: TARGET_URL }]) {
    await assert.rejects(configureStripeChargebackWebhooks(request as StripeChargebackWebhookConfigurationRequest, env(), options(() => {
      throw new Error('Unexpected provider request');
    })), errorCode('invalid-argument'));
  }
});
