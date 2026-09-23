import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { createCommerceApiClient } from '../src/api/commerce.ts';
import { anonymousSessionTestHooks, ensureAnonymousSession } from '../src/lib/anonymousSession.ts';
import {
  ProfileApiError,
  profileApiTimeoutMs,
  requestProfileApi,
  type AuthenticatedApiCall,
  type AuthenticatedApiCallOptions,
} from '../src/api/transport.ts';
import {
  STRIPE_RECEIPT_CLAIM_HTTP_TIMEOUT_MS,
  STRIPE_RECEIPT_CLAIM_OVERALL_TIMEOUT_MS,
  STRIPE_RECEIPT_CLAIM_POLL_INTERVAL_MS,
  STRIPE_RECEIPT_CLAIM_REQUEST_HEADER,
  STRIPE_RECEIPT_CLAIM_START_PATH,
  STRIPE_RECEIPT_CLAIM_STATUS_PATH,
  isStripeReceiptClaimOperationId,
  parseStripeReceiptClaimPendingResponse,
} from '../shared/stripeReceiptClaimWorkflow.ts';

const RECIPIENT = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const REQUEST = { code: 'ABCDEF-1234567890', recipient: RECIPIENT };
const OPERATION_ID = 'src-v1-11111111-1111-4111-8111-111111111111';
const OTHER_OPERATION_ID = 'src-v1-22222222-2222-4222-8222-222222222222';
const PENDING = {
  accepted: true,
  operationId: OPERATION_ID,
  status: 'pending',
  retryAfterMs: STRIPE_RECEIPT_CLAIM_POLL_INTERVAL_MS,
};
const RESULT = {
  processed: true,
  dropId: 'card_nft_2',
  deliveryId: 7,
  receiptsTransferred: 1,
  receiptTxs: [bs58.encode(new Uint8Array(64).fill(5))],
  receiptKind: 'figure',
  figureIds: [1],
  receiptAssetIds: [RECIPIENT],
};

type Call = { pathname: string; data: unknown; options: AuthenticatedApiCallOptions | undefined };
type Outcome = { status: number; body: unknown } | Error;

function client(outcomes: Outcome[], overallTimeoutMs = STRIPE_RECEIPT_CLAIM_OVERALL_TIMEOUT_MS) {
  let now = 0;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const api = createCommerceApiClient(async (pathname, data, _credential, options) => {
    calls.push({ pathname, data, options });
    const outcome = outcomes.shift() || assert.fail('Unexpected request');
    if (outcome instanceof Error) throw outcome;
    options?.onResponseStatus?.(outcome.status);
    return outcome.body;
  }, {}, {
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    overallTimeoutMs,
  });
  return { api, calls, sleeps };
}

test('receipt claim pending contract validates an opaque UUID and exact fields', () => {
  assert.equal(isStripeReceiptClaimOperationId(OPERATION_ID), true);
  assert.deepEqual(parseStripeReceiptClaimPendingResponse(PENDING), PENDING);
  for (const invalid of [
    null,
    [],
    { ...PENDING, operationId: 'src-v1-invalid' },
    { ...PENDING, operationId: OPERATION_ID.toUpperCase() },
    { ...PENDING, operationId: `src-v1-${'a'.repeat(64)}` },
    { ...PENDING, accepted: false },
    { ...PENDING, status: 'complete' },
    { ...PENDING, retryAfterMs: 1 },
    { ...PENDING, extra: true },
    { accepted: true, operationId: OPERATION_ID, status: 'pending' },
  ]) assert.equal(parseStripeReceiptClaimPendingResponse(invalid), null);
});

test('receipt claim start and status use short HTTP deadlines while the legacy route stays compatible', () => {
  assert.equal(profileApiTimeoutMs(STRIPE_RECEIPT_CLAIM_START_PATH), 20_000);
  assert.equal(profileApiTimeoutMs(STRIPE_RECEIPT_CLAIM_STATUS_PATH), 20_000);
  assert.equal(profileApiTimeoutMs('/receipts/stripe/claim'), 190_000);
});

test('receipt claim returns an already complete result without polling', async () => {
  const { api, calls, sleeps } = client([{ status: 200, body: RESULT }]);
  assert.deepEqual(await api.claimStripeReceipt(REQUEST), RESULT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, STRIPE_RECEIPT_CLAIM_START_PATH);
  assert.deepEqual(calls[0].data, REQUEST);
  assert.equal(calls[0].options?.timeoutMs, STRIPE_RECEIPT_CLAIM_HTTP_TIMEOUT_MS);
  assert.equal(calls[0].options?.replaySafe, true);
  assert.deepEqual(sleeps, []);
});

test('receipt claim polls with the same code and receiver until completion', async () => {
  const { api, calls, sleeps } = client([
    { status: 202, body: PENDING },
    { status: 202, body: PENDING },
    { status: 200, body: RESULT },
  ]);
  assert.deepEqual(await api.claimStripeReceipt({ code: ' abcdef-1234567890 ', recipient: ` ${RECIPIENT} ` }), RESULT);
  assert.deepEqual(calls.map(({ pathname, data }) => ({ pathname, data })), [
    { pathname: STRIPE_RECEIPT_CLAIM_START_PATH, data: REQUEST },
    { pathname: STRIPE_RECEIPT_CLAIM_STATUS_PATH, data: { ...REQUEST, operationId: OPERATION_ID } },
    { pathname: STRIPE_RECEIPT_CLAIM_STATUS_PATH, data: { ...REQUEST, operationId: OPERATION_ID } },
  ]);
  assert.ok(calls.every(({ options }) => options?.replaySafe && options.timeoutMs === 20_000));
  assert.deepEqual(sleeps, [2_000, 2_000]);
});

test('receipt claim retries an ambiguous start and keeps polling the known operation after a status disconnect', async () => {
  const { api, calls } = client([
    new TypeError('Connection closed'),
    { status: 202, body: PENDING },
    new DOMException('Network error', 'NetworkError'),
    { status: 200, body: RESULT },
  ]);
  assert.deepEqual(await api.claimStripeReceipt(REQUEST), RESULT);
  assert.deepEqual(calls.map(({ pathname }) => pathname), [
    STRIPE_RECEIPT_CLAIM_START_PATH,
    STRIPE_RECEIPT_CLAIM_START_PATH,
    STRIPE_RECEIPT_CLAIM_STATUS_PATH,
    STRIPE_RECEIPT_CLAIM_STATUS_PATH,
  ]);
  assert.deepEqual(calls[0].data, calls[1].data);
  assert.deepEqual(calls[2].data, calls[3].data);
  const requestId = calls[0].options?.headers?.[STRIPE_RECEIPT_CLAIM_REQUEST_HEADER];
  assert.match(requestId || '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(calls[1].options?.headers?.[STRIPE_RECEIPT_CLAIM_REQUEST_HEADER], requestId);
  assert.equal(calls[2].options?.headers, undefined);
  assert.equal(calls[3].options?.headers, undefined);
});

test('receipt claim respects retry-after only for explicitly retryable errors', async () => {
  const { api, sleeps } = client([
    new ProfileApiError({ code: 'unavailable', message: 'Retry', status: 503, retrySameOperation: true, retryAfterMs: 5_000 }),
    { status: 200, body: RESULT },
  ]);
  assert.deepEqual(await api.claimStripeReceipt(REQUEST), RESULT);
  assert.deepEqual(sleeps, [5_000]);
});

test('persisted terminal failures end polling even when they are unavailable, rate limited or deadline-exceeded', async () => {
  for (const code of ['unavailable', 'resource-exhausted', 'deadline-exceeded', 'failed-precondition', 'auth-subject-changed']) {
    const terminal = new ProfileApiError({ code, message: 'Stored terminal failure', status: code === 'resource-exhausted' ? 429 : 503 });
    const { api, calls } = client([{ status: 202, body: PENDING }, terminal]);
    await assert.rejects(() => api.claimStripeReceipt(REQUEST), (error) => error === terminal);
    assert.deepEqual(calls.map(({ pathname }) => pathname), [STRIPE_RECEIPT_CLAIM_START_PATH, STRIPE_RECEIPT_CLAIM_STATUS_PATH]);
  }
});

test('credential availability and replacement errors remain bounded by the receipt claim deadline', async () => {
  class StaffAuthError extends Error {
    readonly code = 'unavailable';
    override name = 'StaffAuthError';
  }
  for (const unavailable of [
    Object.assign(new Error('Anonymous authentication is temporarily unavailable.'), { code: 'unavailable' }),
    new StaffAuthError('Staff authentication is temporarily unavailable.'),
    new ProfileApiError({ code: 'auth-subject-changed', message: 'Authentication changed. Please retry.' }),
  ]) {
    const { api, calls, sleeps } = client([{ status: 202, body: PENDING }, unavailable, unavailable], 5_000);
    await assert.rejects(() => api.claimStripeReceipt(REQUEST), (error) => {
      assert.ok(error instanceof ProfileApiError);
      assert.equal(error.code, 'deadline-exceeded');
      assert.equal(error.retrySameOperation, true);
      return true;
    });
    assert.deepEqual(calls.map(({ pathname }) => pathname), [
      STRIPE_RECEIPT_CLAIM_START_PATH, STRIPE_RECEIPT_CLAIM_STATUS_PATH, STRIPE_RECEIPT_CLAIM_STATUS_PATH,
    ]);
    assert.deepEqual(calls.slice(1).map(({ data }) => data), Array(2).fill({ ...REQUEST, operationId: OPERATION_ID }));
    assert.deepEqual(calls.map(({ options }) => options?.timeoutMs), [5_000, 3_000, 1_000]);
    assert.deepEqual(sleeps, [2_000, 2_000, 1_000]);
  }
});

test('credential backoff is capped and resets after a successful claim response', async () => {
  const unavailable = Object.assign(new Error('Authentication is temporarily unavailable.'), { code: 'unavailable' });
  const { api, sleeps } = client([
    ...Array<Outcome>(7).fill(unavailable),
    { status: 202, body: PENDING },
    unavailable,
    { status: 200, body: RESULT },
  ]);
  assert.deepEqual(await api.claimStripeReceipt(REQUEST), RESULT);
  assert.deepEqual(sleeps, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 2_000, 2_000]);
});

test('credential rate limits cannot extend the overall claim deadline', async () => {
  const limited = Object.assign(new Error('Too many authentication attempts.'), { code: 'resource-exhausted', retryAfterMs: 60_000 });
  const { api, calls, sleeps } = client([{ status: 202, body: PENDING }, limited], 5_000);
  await assert.rejects(() => api.claimStripeReceipt(REQUEST), (error) => {
    assert.ok(error instanceof ProfileApiError);
    assert.equal(error.code, 'deadline-exceeded');
    assert.equal(error.retrySameOperation, true);
    return true;
  });
  assert.deepEqual(sleeps, [2_000, 3_000]);
  assert.deepEqual(calls.map(({ options }) => options?.timeoutMs), [5_000, 3_000]);
  assert.deepEqual(calls[1].data, { ...REQUEST, operationId: OPERATION_ID });
});

test('raw invalid credential errors stop receipt claim polling', async () => {
  const invalid = Object.assign(new Error('Authentication is required.'), { code: 'unauthenticated' });
  const { api, calls, sleeps } = client([{ status: 202, body: PENDING }, invalid]);
  await assert.rejects(() => api.claimStripeReceipt(REQUEST), (error) => error === invalid);
  assert.deepEqual(calls.map(({ pathname }) => pathname), [STRIPE_RECEIPT_CLAIM_START_PATH, STRIPE_RECEIPT_CLAIM_STATUS_PATH]);
  assert.deepEqual(sleeps, [2_000]);
});

test('a fresh receipt claim invocation can explicitly restart after terminal failure', async () => {
  const terminal = new ProfileApiError({ code: 'unavailable', message: 'Stored failure', status: 503 });
  const { api, calls } = client([
    { status: 202, body: PENDING }, terminal,
    { status: 202, body: { ...PENDING, operationId: OTHER_OPERATION_ID } },
    { status: 200, body: RESULT },
  ]);
  await assert.rejects(() => api.claimStripeReceipt(REQUEST), (error) => error === terminal);
  assert.deepEqual(await api.claimStripeReceipt(REQUEST), RESULT);
  assert.equal(calls[2].pathname, STRIPE_RECEIPT_CLAIM_START_PATH);
  assert.deepEqual(calls[3].data, { ...REQUEST, operationId: OTHER_OPERATION_ID });
  assert.notEqual(
    calls[0].options?.headers?.[STRIPE_RECEIPT_CLAIM_REQUEST_HEADER],
    calls[2].options?.headers?.[STRIPE_RECEIPT_CLAIM_REQUEST_HEADER],
  );
});

test('receipt claim rejects malformed contracts, status mismatches and operation changes', async () => {
  const cases: Outcome[][] = [
    [{ status: 200, body: PENDING }],
    [{ status: 202, body: RESULT }],
    [{ status: 202, body: { ...PENDING, extra: true } }],
    [{ status: 200, body: { ...RESULT, processed: false } }],
    [{ status: 202, body: PENDING }, { status: 202, body: { ...PENDING, operationId: OTHER_OPERATION_ID } }],
  ];
  for (const outcomes of cases) {
    const { api } = client(outcomes);
    await assert.rejects(() => api.claimStripeReceipt(REQUEST), /Invalid Stripe receipt claim response/);
  }
});

test('receipt claim overall timeout preserves pending wording and bounds every remaining request', async () => {
  const { api, calls, sleeps } = client(Array.from({ length: 3 }, () => ({ status: 202, body: PENDING })), 5_000);
  await assert.rejects(() => api.claimStripeReceipt(REQUEST), (error) => {
    assert.ok(error instanceof ProfileApiError);
    assert.equal(error.code, 'deadline-exceeded');
    assert.equal(error.message, 'Claim is still processing. Retry with the same code and receiver.');
    assert.equal(error.retrySameOperation, true);
    return true;
  });
  assert.deepEqual(calls.map(({ options }) => options?.timeoutMs), [5_000, 3_000, 1_000]);
  assert.deepEqual(sleeps, [2_000, 2_000, 1_000]);
  assert.equal(calls.filter(({ pathname }) => pathname === STRIPE_RECEIPT_CLAIM_START_PATH).length, 1);
});

test('receipt claim status remains readable when the anonymous session changes between requests', async () => {
  let now = 0;
  let credentials = 0;
  let requests = 0;
  const call: AuthenticatedApiCall = (pathname, data, capture, options) => requestProfileApi(pathname, data, {
    fetch: async (_input, init) => {
      requests += 1;
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      assert.deepEqual(JSON.parse(String(init?.body)), requests === 1 ? REQUEST : { ...REQUEST, operationId: OPERATION_ID });
      return Response.json(requests === 1 ? PENDING : RESULT, { status: requests === 1 ? 202 : 200 });
    },
    getCredential: async () => ({ authSubject: `anonymous-${++credentials}` }),
    origin: () => 'https://api.mons.shop',
    timeoutMs: 20_000,
  }, capture, options);
  const api = createCommerceApiClient(call, {}, { now: () => now, sleep: async (ms) => { now += ms; } });
  assert.deepEqual(await api.claimStripeReceipt(REQUEST), RESULT);
  assert.equal(credentials, 2);
});

for (const phase of ['start', 'status']) {
  test(`receipt claim resumes the same ${phase} after a successful anonymous subject replacement`, async (t) => {
    anonymousSessionTestHooks.resetValidation();
    t.after(() => anonymousSessionTestHooks.resetValidation());
    let now = 0;
    let authRequests = 0;
    const trace: string[] = [];
    const bodies: unknown[] = [];
    const requestIds: (string | null)[] = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/anonymous/session')) {
        authRequests += 1;
        trace.push(`auth:${authRequests}`);
        return Response.json({
          subject: authRequests === 1
            ? 'anon:11111111-1111-4111-8111-111111111111'
            : 'anon:22222222-2222-4222-8222-222222222222',
          refreshedAt: Date.now(), expiresAt: Date.now() + 86_400_000,
        });
      }
      const requestPhase = url.endsWith(STRIPE_RECEIPT_CLAIM_START_PATH) ? 'start' : 'status';
      assert.ok(requestPhase === 'start' || url.endsWith(STRIPE_RECEIPT_CLAIM_STATUS_PATH));
      const status = requestPhase === phase && authRequests === 1 ? 401 : requestPhase === 'start' ? 202 : 200;
      bodies.push(JSON.parse(String(init?.body)));
      requestIds.push(new Headers(init?.headers).get(STRIPE_RECEIPT_CLAIM_REQUEST_HEADER));
      trace.push(`${requestPhase}:${status}`);
      return Response.json(status === 401
        ? { error: { code: 'unauthenticated', message: 'Session expired.' } }
        : status === 202 ? PENDING : RESULT, { status });
    });
    const call: AuthenticatedApiCall = (pathname, data, capture, options) => requestProfileApi(pathname, data, {
      fetch: (input, init) => globalThis.fetch(input, init),
      getCredential: async (forceRefresh) => ({ authSubject: (await ensureAnonymousSession(forceRefresh)).subject }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 20_000,
    }, capture, options);
    const api = createCommerceApiClient(call, {}, { now: () => now, sleep: async (ms) => { now += ms; } });
    assert.deepEqual(await api.claimStripeReceipt(REQUEST), RESULT);
    assert.deepEqual(trace, phase === 'start'
      ? ['auth:1', 'start:401', 'auth:2', 'start:202', 'status:200']
      : ['auth:1', 'start:202', 'status:401', 'auth:2', 'status:200']);
    assert.deepEqual(bodies, phase === 'start'
      ? [REQUEST, REQUEST, { ...REQUEST, operationId: OPERATION_ID }]
      : [REQUEST, { ...REQUEST, operationId: OPERATION_ID }, { ...REQUEST, operationId: OPERATION_ID }]);
    assert.ok(requestIds[0]);
    assert.deepEqual(requestIds, phase === 'start'
      ? [requestIds[0], requestIds[0], null]
      : [requestIds[0], null, null]);
    assert.equal(now, 4_000);
  });
}

for (const scenario of [
  { name: 'structured service failure', response: () => Response.json({ error: { code: 'unavailable', message: 'Authentication is temporarily unavailable.' } }, { status: 503 }), outcome: 'recover' },
  { name: 'HTML gateway failure', response: () => new Response('<html>Bad gateway</html>', { status: 502 }), outcome: 'recover' },
  { name: 'generic JSON service failure', response: () => Response.json({ error: 'internal' }, { status: 503 }), outcome: 'recover' },
  { name: 'malformed successful JSON', response: () => new Response('{', { status: 200 }), outcome: 'recover' },
  { name: 'invalid successful session', response: () => Response.json({ subject: 'invalid' }), outcome: 'recover' },
  { name: 'rate limit header', response: () => Response.json({ error: { code: 'resource-exhausted' } }, { status: 429, headers: { 'Retry-After': '60' } }), outcome: 'recover', retryAfterMs: 60_000 },
  { name: 'extended rate limit header', response: () => Response.json({ error: { code: 'resource-exhausted' } }, { status: 429, headers: { 'Retry-After': '120' } }), outcome: 'recover', retryAfterMs: 120_000 },
  { name: 'rate limit body', response: () => Response.json({ error: { code: 'resource-exhausted', retryAfterMs: 60_000 } }, { status: 429 }), outcome: 'recover', retryAfterMs: 60_000 },
  { name: 'malformed rate limit response', response: () => new Response('{', { status: 429 }), outcome: 'recover', retryAfterMs: 60_000 },
  { name: 'repeated gateway failures', response: () => new Response('<html>Bad gateway</html>', { status: 502 }), outcome: 'deadline-exceeded' },
  { name: 'HTML unauthorized response', response: () => new Response('<html>Unauthorized</html>', { status: 401 }), outcome: 'unauthenticated' },
  { name: 'malformed forbidden response', response: () => new Response('{', { status: 403 }), outcome: 'permission-denied' },
] as const) {
  test(`receipt claim handles anonymous refresh ${scenario.name} without changing its operation`, async (t) => {
    anonymousSessionTestHooks.resetValidation();
    t.after(() => anonymousSessionTestHooks.resetValidation());
    let now = 0;
    let authRequests = 0;
    const trace: string[] = [];
    const statusBodies: unknown[] = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/anonymous/session')) {
        authRequests += 1;
        const response = authRequests === 2 || (authRequests > 2 && scenario.outcome !== 'recover')
          ? scenario.response()
          : Response.json({
            subject: 'anon:11111111-1111-4111-8111-111111111111',
            refreshedAt: Date.now(), expiresAt: Date.now() + 86_400_000,
          });
        trace.push(`auth:${response.status}`);
        return response;
      }
      const body = JSON.parse(String(init?.body));
      if (url.endsWith(STRIPE_RECEIPT_CLAIM_START_PATH)) {
        assert.deepEqual(body, REQUEST);
        trace.push('start:202');
        return Response.json(PENDING, { status: 202 });
      }
      assert.ok(url.endsWith(STRIPE_RECEIPT_CLAIM_STATUS_PATH));
      statusBodies.push(body);
      const status = authRequests < 3 ? 401 : 200;
      trace.push(`status:${status}`);
      return status === 401
        ? Response.json({ error: { code: 'unauthenticated', message: 'Session expired.' } }, { status })
        : Response.json(RESULT);
    });
    const call: AuthenticatedApiCall = (pathname, data, capture, options) => requestProfileApi(pathname, data, {
      fetch: (input, init) => globalThis.fetch(input, init),
      getCredential: async (forceRefresh) => ({ authSubject: (await ensureAnonymousSession(forceRefresh)).subject }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 20_000,
    }, capture, options);
    const api = createCommerceApiClient(call, {}, {
      now: () => now, sleep: async (ms) => { now += ms; },
      ...(scenario.outcome === 'deadline-exceeded' ? { overallTimeoutMs: 5_000 } : {}),
    });
    if (scenario.outcome === 'recover') {
      assert.deepEqual(await api.claimStripeReceipt(REQUEST), RESULT);
      assert.deepEqual(trace, ['auth:200', 'start:202', 'status:401', `auth:${scenario.response().status}`, 'status:401', 'auth:200', 'status:200']);
      assert.equal(now, 2_000 + ('retryAfterMs' in scenario ? scenario.retryAfterMs : 2_000));
    } else {
      await assert.rejects(() => api.claimStripeReceipt(REQUEST), (error) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, scenario.outcome);
        if (scenario.outcome === 'deadline-exceeded') {
          assert.ok(error instanceof ProfileApiError);
          assert.equal(error.message, 'Claim is still processing. Retry with the same code and receiver.');
          assert.equal(error.retrySameOperation, true);
        }
        return true;
      });
      assert.deepEqual(trace, scenario.outcome === 'deadline-exceeded'
        ? ['auth:200', 'start:202', 'status:401', 'auth:502', 'status:401', 'auth:502']
        : ['auth:200', 'start:202', 'status:401', `auth:${scenario.response().status}`]);
      assert.equal(now, scenario.outcome === 'deadline-exceeded' ? 5_000 : 2_000);
    }
    assert.deepEqual(statusBodies, Array(statusBodies.length).fill({ ...REQUEST, operationId: OPERATION_ID }));
  });
}

test('a new anonymous claimant survives a prolonged authentication outage without exhausting creation limits', async (t) => {
  anonymousSessionTestHooks.resetValidation();
  t.after(() => anonymousSessionTestHooks.resetValidation());
  let now = 0;
  let rateLimited = false;
  let claimRequests = 0;
  const authRequestTimes: number[] = [];
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/auth/anonymous/session')) {
      authRequestTimes.push(now);
      if (authRequestTimes.filter((time) => time > now - 60_000).length > 20) {
        rateLimited = true;
        return Response.json({ error: { code: 'resource-exhausted' } }, { status: 429, headers: { 'Retry-After': '60' } });
      }
      if (now < 45_000) {
        return Response.json({ error: { code: 'unavailable' } }, { status: 503 });
      }
      return Response.json({
        subject: 'anon:11111111-1111-4111-8111-111111111111',
        refreshedAt: Date.now(), expiresAt: Date.now() + 86_400_000,
      });
    }
    assert.ok(String(input).endsWith(STRIPE_RECEIPT_CLAIM_START_PATH));
    assert.deepEqual(JSON.parse(String(init?.body)), REQUEST);
    claimRequests += 1;
    return Response.json(RESULT);
  });
  const call: AuthenticatedApiCall = (pathname, data, capture, options) => {
    calls.push({ pathname, data, options });
    return requestProfileApi(pathname, data, {
      fetch: (input, init) => globalThis.fetch(input, init),
      getCredential: async (forceRefresh) => ({ authSubject: (await ensureAnonymousSession(forceRefresh)).subject }),
      origin: () => 'https://api.mons.shop', timeoutMs: 20_000,
    }, capture, options);
  };
  const api = createCommerceApiClient(call, {}, { now: () => now, sleep: async (ms) => { now += ms; } });
  assert.deepEqual(await api.claimStripeReceipt(REQUEST), RESULT);
  assert.equal(rateLimited, false);
  assert.ok(authRequestTimes.length < 20);
  assert.ok(now >= 45_000 && now < STRIPE_RECEIPT_CLAIM_OVERALL_TIMEOUT_MS);
  assert.equal(claimRequests, 1);
  const requestId = calls[0].options?.headers?.[STRIPE_RECEIPT_CLAIM_REQUEST_HEADER];
  assert.ok(requestId);
  assert.ok(calls.every(({ pathname, data, options }) => pathname === STRIPE_RECEIPT_CLAIM_START_PATH &&
    options?.headers?.[STRIPE_RECEIPT_CLAIM_REQUEST_HEADER] === requestId && JSON.stringify(data) === JSON.stringify(REQUEST)));
});

test('receipt claim retries malformed transport JSON without allocating a different start request', async () => {
  let now = 0;
  const bodies: unknown[] = [];
  const call: AuthenticatedApiCall = (pathname, data, capture, options) => requestProfileApi(pathname, data, {
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? new Response('{', { status: 202 })
        : Response.json(RESULT);
    },
    getCredential: async () => ({ authSubject: 'anonymous' }),
    origin: () => 'https://api.mons.shop',
    timeoutMs: 20_000,
  }, capture, options);
  const api = createCommerceApiClient(call, {}, { now: () => now, sleep: async (ms) => { now += ms; } });
  assert.deepEqual(await api.claimStripeReceipt(REQUEST), RESULT);
  assert.deepEqual(bodies, [REQUEST, REQUEST]);
});
