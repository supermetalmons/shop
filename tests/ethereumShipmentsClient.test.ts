import assert from 'node:assert/strict';
import test from 'node:test';
import { ETHEREUM_SESSION_HEADER, type EthereumSession } from '../shared/ethereum/api.ts';
import type { ShipmentHistoryCursor } from '../shared/shipmentHistory.ts';
import { ethereumApi } from '../src/ethereum/api.ts';

const session: EthereumSession = {
  token: 'shipment-session', address: '0x1111111111111111111111111111111111111111',
  chainId: 31337, dropId: '111k_devnet', expiresAtMs: 2_000_000_000_000,
};
const cursor: ShipmentHistoryCursor = {
  version: 1, owner: session.address, sortAtMs: 10, documentPath: 'drops/111k_devnet/deliveryOrders/1',
};

test('shipment client retains the existing call shape and sends optional pagination with the session and signal', async t => {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  let value: unknown = { orders: [] };
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    calls.push({ url: new URL(String(input), 'https://mons.shop'), init });
    return Response.json(value);
  });
  const controller = new AbortController();
  assert.deepEqual(await ethereumApi.shipments(session, controller.signal), { orders: [], nextCursor: null });
  assert.equal(calls[0].url.pathname, '/ethereum/shipments');
  assert.equal(calls[0].url.search, '');
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(new Headers(calls[0].init?.headers).get(ETHEREUM_SESSION_HEADER), session.token);
  value = { orders: [], nextCursor: cursor };
  assert.deepEqual(await ethereumApi.shipments(session, controller.signal, { limit: 1, cursor }), value);
  assert.equal(calls[1].url.searchParams.get('limit'), '1');
  assert.deepEqual(JSON.parse(calls[1].url.searchParams.get('cursor')!), cursor);
  controller.abort();
  assert.equal(calls[0].init?.signal?.aborted, true);
  assert.equal(calls[1].init?.signal?.aborted, true);
});

test('shipment client rejects malformed and foreign response cursors', async t => {
  let value: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(value));
  for (const nextCursor of ['', {}, { ...cursor, version: 2 }, { ...cursor, owner: 'another-wallet' },
    { ...cursor, documentPath: 'drops/other/deliveryOrders/1' }]) {
    value = { orders: [], nextCursor };
    await assert.rejects(ethereumApi.shipments(session), /invalid response/);
  }
  value = { orders: [], nextCursor: null };
  assert.deepEqual(await ethereumApi.shipments(session), value);
});
