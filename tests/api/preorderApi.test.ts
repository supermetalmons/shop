import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { getPreorderConfig, type PreorderOrder } from '../../shared/preorders.ts';
import { createPreorderApi } from '../../src/lib/preorderApi.ts';
import { ProfileApiError, requestProfileApi } from '../../src/api/transport.ts';

const config = getPreorderConfig('mi_note_cards_devnet')!;
const buyer = config.authority;
const session = {
  address: '0x0000000000000000000000000000000000000001', token: 'ethereum-session',
  preorderId: config.preorderId, expiresAtMs: Date.now() + 3_600_000,
};
const order: PreorderOrder = {
  orderId: 'order-1', preorderId: config.preorderId, buyer, ethereumAddress: session.address, cardIds: [1],
  assets: [{ id: 1, address: config.collection }], status: 'prepared',
  expiresAtMs: 123_456, signature: null,
};

function client(payload: unknown, status = 200) {
  const calls: { input: string; init: RequestInit | undefined }[] = [];
  let credentialCalls = 0;
  const fetchResponse: typeof fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return Response.json(payload, { status });
  };
  const api = createPreorderApi({
    fetch: fetchResponse,
    authenticatedCall: (path, data, capture, options) => requestProfileApi(path, data, {
      fetch: fetchResponse,
      getCredential: async () => { credentialCalls += 1; return { authSubject: buyer, token: 'test' }; },
      origin: () => '/api', timeoutMs: 65_000,
    }, capture, options),
    publicOrigin: () => 'https://api.example',
  });
  return { api, calls, get credentialCalls() { return credentialCalls; } };
}

test('availability sends Ethereum verification and accepts only distinct wallet-scoped card IDs', async () => {
  const payload = { preorderId: config.preorderId, ethereumAddress: session.address, ownershipStatus: 'success', requiresAdminSignIn: false,
    items: [1, 12, 1395].map((id) => ({ id, status: 'available' })) };
  const runtime = client(payload);
  assert.deepEqual(await runtime.api.availability(config.preorderId, session), payload);
  assert.equal(runtime.credentialCalls, 0);
  assert.equal(runtime.calls[0].input, `https://api.example/preorders/availability?preorderId=${config.preorderId}`);
  assert.equal(runtime.calls[0].init?.credentials, 'omit');
  assert.deepEqual(runtime.calls[0].init?.headers, { 'X-Mi-Note-Session': session.token });
  for (const items of [[], payload.items.slice(1)]) {
    assert.deepEqual(await client({ ...payload, items }).api.availability(config.preorderId, session), { ...payload, items });
  }
  for (const items of [[...payload.items, payload.items[1]], [{ id: 1396, status: 'available' }], payload.items.map((item) => ({ ...item, status: 'sold' }))]) {
    await assert.rejects(client({ ...payload, items }).api.availability(config.preorderId, session), /invalid response/);
  }
  await assert.rejects(client({ ...payload, ethereumAddress: '0x0000000000000000000000000000000000000002' }).api.availability(config.preorderId, session), /invalid response/);
  const signedIn = client(payload);
  assert.deepEqual(await signedIn.api.availability(config.preorderId, session, true), payload);
  assert.equal(signedIn.calls.length, 1);
  assert.equal(signedIn.credentialCalls, 1);
  assert.equal(signedIn.calls[0].input, '/api/preorders/availability');
  assert.equal(signedIn.calls[0].init?.method, 'POST');
  assert.equal(signedIn.calls[0].init?.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(signedIn.calls[0].init?.body)), { preorderId: config.preorderId });
  assert.equal(new Headers(signedIn.calls[0].init?.headers).get('X-Mi-Note-Session'), session.token);
  assert.equal(new Headers(signedIn.calls[0].init?.headers).get('Authorization'), 'Bearer test');
});

test('expired Solana authentication falls back to Ethereum-verified availability without Solana credentials', async () => {
  const payload = { preorderId: config.preorderId, ethereumAddress: session.address, ownershipStatus: 'success', requiresAdminSignIn: true,
    items: [{ id: 12, status: 'available' }] };
  const getCalls: { input: string; init?: RequestInit }[] = [];
  let postCalls = 0;
  const api = createPreorderApi({
    publicOrigin: () => 'https://api.example',
    authenticatedCall: async (path, data, _capture, options) => {
      postCalls += 1;
      assert.equal(path, '/preorders/availability');
      assert.deepEqual(data, { preorderId: config.preorderId });
      assert.equal(new Headers(options?.headers).get('X-Mi-Note-Session'), session.token);
      throw new ProfileApiError({ status: 401, code: 'unauthenticated', message: 'Solana session expired.' });
    },
    fetch: async (input, init) => {
      getCalls.push({ input: String(input), init });
      return Response.json(payload);
    },
  });
  assert.deepEqual(await api.availability(config.preorderId, session, true), payload);
  assert.equal(postCalls, 1);
  assert.equal(getCalls.length, 1);
  assert.equal(getCalls[0].input, `https://api.example/preorders/availability?preorderId=${config.preorderId}`);
  assert.equal(getCalls[0].init?.method, 'GET');
  assert.equal(getCalls[0].init?.credentials, 'omit');
  assert.deepEqual(getCalls[0].init?.headers, { 'X-Mi-Note-Session': session.token });
  assert.equal(session.token, 'ethereum-session');
});

for (const status of [403, 500]) {
  test(`availability does not fall back after an authenticated ${status} response`, async () => {
    const failure = new ProfileApiError({ status, code: 'unavailable', message: 'Availability failed.' });
    let fetched = false;
    const api = createPreorderApi({
      authenticatedCall: async () => { throw failure; },
      fetch: async () => { fetched = true; throw new Error('Unexpected fallback'); },
    });
    await assert.rejects(api.availability(config.preorderId, session, true), (error: unknown) => error === failure);
    assert.equal(fetched, false);
  });
}

test('prepare uses authenticated cookie transport and validates buyer and exact card mapping', async () => {
  const input = { preorderId: config.preorderId, buyer, cardIds: [1], requestId: 'request-1' };
  const runtime = client({ order, transactionBase64: 'AQ==' });
  assert.deepEqual(await runtime.api.prepare(input, session), { order, transactionBase64: 'AQ==' });
  assert.equal(runtime.calls[0].input, '/api/preorders/prepare');
  assert.equal(runtime.calls[0].init?.credentials, 'same-origin');
  assert.deepEqual(runtime.calls[0].init?.headers, { Authorization: 'Bearer test', 'X-Mons-CSRF': '1', 'Content-Type': 'application/json', 'X-Mi-Note-Session': session.token });
  assert.deepEqual(JSON.parse(String(runtime.calls[0].init?.body)), input);
  for (const changed of [
    { ...order, buyer: config.collection },
    { ...order, ethereumAddress: null },
    { ...order, ethereumAddress: '0x0000000000000000000000000000000000000002' },
    { ...order, cardIds: [2], assets: [{ id: 2, address: config.collection }] },
    { ...order, assets: [{ id: 2, address: config.collection }] },
    { ...order, assets: [] },
    { ...order, expiresAtMs: -1 },
    { ...order, signature: 'invalid' },
    { ...order, status: 'maybe' },
  ]) await assert.rejects(client({ order: changed, transactionBase64: 'AQ==' }).api.prepare(input, session), /invalid response/);
});

test('status reads an authenticated order without preparing or submitting a transaction', async () => {
  const runtime = client({ order: { ...order, status: 'succeeded', signature: bs58.encode(new Uint8Array(64).fill(1)) } });
  assert.equal((await runtime.api.status(config.preorderId, 'order-1')).order?.status, 'succeeded');
  assert.equal(runtime.calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(runtime.calls[0].init?.body)), { preorderId: config.preorderId, orderId: 'order-1' });
  assert.equal(runtime.calls[0].input, '/api/preorders/status');
  assert.equal(new Headers(runtime.calls[0].init?.headers).has('X-Mi-Note-Session'), false);
  assert.deepEqual(await client({ order: null }).api.status(config.preorderId), { order: null });
  assert.equal((await client({ order: { ...order, ethereumAddress: null } }).api.status(config.preorderId)).order?.ethereumAddress, null);
});

test('submit sends signed bytes only to authenticated API and surfaces server conflicts', async () => {
  const input = { preorderId: config.preorderId, orderId: order.orderId, transactionBase64: 'signed' };
  const runtime = client({ order });
  await runtime.api.submit(input, session);
  assert.equal(runtime.calls[0].input, '/api/preorders/submit');
  assert.deepEqual(JSON.parse(String(runtime.calls[0].init?.body)), input);
  assert.equal(new Headers(runtime.calls[0].init?.headers).get('X-Mi-Note-Session'), session.token);
  await assert.rejects(client({ error: { code: 'failed-precondition', message: 'Card already reserved.' } }, 409).api.submit(input, session), /already reserved/);
  await assert.rejects(client({ order: null }).api.submit(input, session), /invalid response/);
  await assert.rejects(client({ order: { ...order, orderId: 'another-order' } }).api.submit(input, session), /invalid response/);
});

test('cancel keeps original order identity and rejects malformed response envelopes', async () => {
  const runtime = client({ order: { ...order, status: 'cancelled' } });
  assert.equal((await runtime.api.cancel({ preorderId: config.preorderId, orderId: order.orderId })).order?.status, 'cancelled');
  assert.deepEqual(JSON.parse(String(runtime.calls[0].init?.body)), { preorderId: config.preorderId, orderId: order.orderId });
  await assert.rejects(client({ ok: true }).api.status(config.preorderId), /invalid response/);
});
