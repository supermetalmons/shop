import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { getPreorderConfig, PREORDER_CARD_COUNT, type PreorderOrder } from '../../shared/preorders.ts';
import { createPreorderApi } from '../../src/lib/preorderApi.ts';
import { requestProfileApi } from '../../src/api/transport.ts';

const config = getPreorderConfig('mi_note_cards_devnet')!;
const buyer = config.authority;
const order: PreorderOrder = {
  orderId: 'order-1', preorderId: config.preorderId, buyer, cardIds: [1],
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

test('availability uses public API and requires exactly one status per canonical card ID', async () => {
  const payload = { preorderId: config.preorderId, items: Array.from({ length: PREORDER_CARD_COUNT }, (_, index) => ({ id: index + 1, status: 'available' })) };
  const runtime = client(payload);
  assert.deepEqual(await runtime.api.availability(config.preorderId), payload);
  assert.equal(runtime.credentialCalls, 0);
  assert.equal(runtime.calls[0].input, `https://api.example/preorders/availability?preorderId=${config.preorderId}`);
  assert.equal(runtime.calls[0].init?.credentials, 'omit');
  for (const items of [payload.items.slice(1), [...payload.items.slice(1), payload.items[1]], payload.items.map((item) => ({ ...item, status: 'sold' }))]) {
    await assert.rejects(client({ ...payload, items }).api.availability(config.preorderId), /invalid response/);
  }
});

test('prepare uses authenticated cookie transport and validates buyer and exact card mapping', async () => {
  const input = { preorderId: config.preorderId, buyer, cardIds: [1], requestId: 'request-1' };
  const runtime = client({ order, transactionBase64: 'AQ==' });
  assert.deepEqual(await runtime.api.prepare(input), { order, transactionBase64: 'AQ==' });
  assert.equal(runtime.calls[0].input, '/api/preorders/prepare');
  assert.equal(runtime.calls[0].init?.credentials, 'same-origin');
  assert.deepEqual(runtime.calls[0].init?.headers, { Authorization: 'Bearer test', 'X-Mons-CSRF': '1', 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(String(runtime.calls[0].init?.body)), input);
  for (const changed of [
    { ...order, buyer: config.collection },
    { ...order, cardIds: [2], assets: [{ id: 2, address: config.collection }] },
    { ...order, assets: [{ id: 2, address: config.collection }] },
    { ...order, assets: [] },
    { ...order, expiresAtMs: -1 },
    { ...order, signature: 'invalid' },
    { ...order, status: 'maybe' },
  ]) await assert.rejects(client({ order: changed, transactionBase64: 'AQ==' }).api.prepare(input), /invalid response/);
});

test('status reads an authenticated order without preparing or submitting a transaction', async () => {
  const runtime = client({ order: { ...order, status: 'succeeded', signature: bs58.encode(new Uint8Array(64).fill(1)) } });
  assert.equal((await runtime.api.status(config.preorderId, 'order-1')).order?.status, 'succeeded');
  assert.equal(runtime.calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(runtime.calls[0].init?.body)), { preorderId: config.preorderId, orderId: 'order-1' });
  assert.equal(runtime.calls[0].input, '/api/preorders/status');
  assert.deepEqual(await client({ order: null }).api.status(config.preorderId), { order: null });
});

test('submit sends signed bytes only to authenticated API and surfaces server conflicts', async () => {
  const input = { preorderId: config.preorderId, orderId: order.orderId, transactionBase64: 'signed' };
  const runtime = client({ order });
  await runtime.api.submit(input);
  assert.equal(runtime.calls[0].input, '/api/preorders/submit');
  assert.deepEqual(JSON.parse(String(runtime.calls[0].init?.body)), input);
  await assert.rejects(client({ error: { code: 'failed-precondition', message: 'Card already reserved.' } }, 409).api.submit(input), /already reserved/);
  await assert.rejects(client({ order: null }).api.submit(input), /invalid response/);
  await assert.rejects(client({ order: { ...order, orderId: 'another-order' } }).api.submit(input), /invalid response/);
});

test('cancel keeps original order identity and rejects malformed response envelopes', async () => {
  const runtime = client({ order: { ...order, status: 'cancelled' } });
  assert.equal((await runtime.api.cancel({ preorderId: config.preorderId, orderId: order.orderId })).order?.status, 'cancelled');
  assert.deepEqual(JSON.parse(String(runtime.calls[0].init?.body)), { preorderId: config.preorderId, orderId: order.orderId });
  await assert.rejects(client({ ok: true }).api.status(config.preorderId), /invalid response/);
});
