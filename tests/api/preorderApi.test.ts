import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { getPreorderConfig, type PreorderOrder } from '../../shared/preorders.ts';
import { createPreorderApi } from '../../src/lib/preorderApi.ts';
import { requestProfileApi } from '../../src/api/transport.ts';

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

test('confirmed order markers are validated and recovery pagination uses the opt-in status envelope', async () => {
  const confirmed = { ...order, status: 'submitted', signature: bs58.encode(new Uint8Array(64).fill(1)), confirmedSlot: 500 };
  const payload = { order: null, recoveries: [confirmed], nextRecoveryCursor: 'next-page' };
  const runtime = client(payload);
  assert.deepEqual(await runtime.api.recoveries(config.preorderId, 'previous-page'), payload);
  assert.deepEqual(JSON.parse(String(runtime.calls[0].init?.body)), { preorderId: config.preorderId, includeRecoveries: true, recoveryCursor: 'previous-page' });
  for (const confirmedSlot of [-1, 1.5, '500']) {
    await assert.rejects(client({ order: { ...confirmed, confirmedSlot } }).api.status(config.preorderId, order.orderId), /invalid response/);
  }
  for (const recoveries of [[{ ...confirmed, confirmedSlot: null }], [confirmed, confirmed], [{ ...confirmed, status: 'succeeded' }]]) {
    await assert.rejects(client({ ...payload, recoveries }).api.recoveries(config.preorderId), /invalid response/);
  }
});

function client(payload: unknown, status = 200) {
  const calls: { input: string; init: RequestInit | undefined }[] = [];
  let credentialCalls = 0;
  const fetchResponse: typeof fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return Response.json(payload, { status });
  };
  const api = createPreorderApi({
    authenticatedCall: (path, data, capture, options) => requestProfileApi(path, data, {
      fetch: fetchResponse,
      getCredential: async () => { credentialCalls += 1; return { authSubject: buyer, token: 'test' }; },
      origin: () => '/api', timeoutMs: 65_000,
    }, capture, options),
  });
  return { api, calls, get credentialCalls() { return credentialCalls; } };
}

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

test('cancel keeps original order identity and rejects malformed response envelopes', async () => {
  const runtime = client({ order: { ...order, status: 'cancelled' } });
  assert.equal((await runtime.api.cancel({ preorderId: config.preorderId, orderId: order.orderId })).order?.status, 'cancelled');
  assert.deepEqual(JSON.parse(String(runtime.calls[0].init?.body)), { preorderId: config.preorderId, orderId: order.orderId });
  await assert.rejects(client({ ok: true }).api.status(config.preorderId), /invalid response/);
});

test('status rejects malformed order identities and card mappings', async () => {
  for (const changed of [
    { ...order, preorderId: 'mi_note_cards' },
    { ...order, assets: [{ id: 2, address: config.collection }] },
    { ...order, assets: [] },
    { ...order, expiresAtMs: -1 },
    { ...order, signature: 'invalid' },
    { ...order, status: 'maybe' },
    { ...order, ethereumAddress: 'invalid' },
    { ...order, buyer: 'invalid' },
  ]) await assert.rejects(client({ order: changed }).api.status(config.preorderId, order.orderId), /invalid response/);
  await assert.rejects(client({ order: { ...order, orderId: 'another-order' } }).api.status(config.preorderId, order.orderId), /invalid response/);
});
