import assert from 'node:assert/strict';
import test from 'node:test';
import { createProfileApiClient, parseProfileState } from '../src/api/profile.ts';
import type { AuthenticatedApiCall } from '../src/api/transport.ts';
import type { ShipmentHistoryCursor, ShipmentPresenceRequest } from '../shared/shipmentHistory.ts';

const OWNER = 'So11111111111111111111111111111111111111112';
const CURSOR: ShipmentHistoryCursor = {
  version: 1, owner: OWNER, sortAtMs: 100, documentPath: 'drops/drop/deliveryOrders/1',
};
const ORDER = { dropId: 'drop', deliveryId: 1, status: 'processing', items: [] };
function client(callProfileApi: AuthenticatedApiCall) {
  return createProfileApiClient({ callProfileApi, createProfileAddressId: () => 'AbCdEfGhIjKlMnOpQrSt' });
}

test('shipment API clients opt into paging and validate continuation owners', async () => {
  const calls: unknown[] = [];
  const api = client(async (path, body) => {
    calls.push({ path, body });
    if (path === '/admin/profile') return { profile: { wallet: OWNER, orders: [ORDER] }, nextCursor: CURSOR };
    if (path === '/profile/anonymous-stripe-delivery-history') return { orders: [ORDER], nextCursor: null };
    return { responseMode: 'shipments', wallet: OWNER, orders: [ORDER], nextCursor: CURSOR };
  });
  assert.deepEqual(await api.getProfileShipments(OWNER, { limit: 50 }), { orders: [ORDER], nextCursor: CURSOR });
  assert.equal((await api.getAdminProfileView(OWNER, { cursor: CURSOR })).nextCursor, CURSOR);
  assert.deepEqual(await api.getAnonymousStripeDeliveryHistory({ limit: 50 }), { orders: [ORDER], nextCursor: null });
  assert.deepEqual(calls, [
    { path: '/profile/shipments', body: { ownerWallet: OWNER, shipmentsPage: { limit: 50 } } },
    { path: '/admin/profile', body: { ownerWallet: OWNER, shipmentsPage: { cursor: CURSOR } } },
    { path: '/profile/anonymous-stripe-delivery-history', body: { shipmentsPage: { limit: 50 } } },
  ]);
  const invalid = client(async () => ({ responseMode: 'shipments', wallet: OWNER, orders: [], nextCursor: { ...CURSOR, owner: 'another-wallet' } }));
  await assert.rejects(invalid.getProfileShipments(OWNER), /Invalid shipment history/);
  const missing = client(async () => ({ responseMode: 'shipments', wallet: OWNER, orders: [] }));
  await assert.rejects(missing.getProfileShipments(OWNER), /Invalid shipment history/);
});

test('profile state accepts legacy and opted-in responses but never a cursor for failed shipments', () => {
  const state = {
    responseMode: 'profile-state', sessionWallet: OWNER,
    profile: { status: 'ready', value: { wallet: OWNER } },
    shipments: { status: 'ready', value: [ORDER] },
  };
  assert.deepEqual(parseProfileState(state), state);
  assert.deepEqual(parseProfileState({ ...state, nextCursor: CURSOR }), { ...state, nextCursor: CURSOR });
  assert.equal(parseProfileState({ ...state, nextCursor: { ...CURSOR, owner: 'another-wallet' } }), null);
  assert.equal(parseProfileState({ ...state, shipments: { status: 'error', error: { code: 'unavailable', message: 'Try later' } }, nextCursor: CURSOR }), null);
  assert.equal(parseProfileState({ responseMode: 'profile-state', sessionWallet: null, profile: null, shipments: null, nextCursor: CURSOR }), null);
});

test('presence batches independent selectors and only accepts requested matches', async () => {
  const calls: ShipmentPresenceRequest[] = [];
  const api = client(async (path, body) => {
    assert.equal(path, '/profile/shipment-presence');
    const request = body as ShipmentPresenceRequest;
    calls.push(request);
    return { stripeSessionIds: request.stripeSessionIds ?? [], deliveries: request.deliveries ?? [] };
  });
  const ids = Array.from({ length: 51 }, (_, index) => `cs_test_${index}`);
  const deliveries = [{ dropId: 'drop', deliveryId: 1 }];
  assert.deepEqual(await api.getShipmentPresence({ scope: 'wallet', expectedWallet: OWNER, stripeSessionIds: [...ids, ids[0]], deliveries }), { stripeSessionIds: ids, deliveries });
  assert.deepEqual(calls.map((request) => (request.stripeSessionIds?.length ?? 0) + (request.deliveries?.length ?? 0)), [50, 2]);
  assert.ok(calls.every((request) => request.scope === 'wallet' && request.expectedWallet === OWNER));
  const malformed = client(async () => ({ stripeSessionIds: ['cs_somebody_else'], deliveries: [] }));
  await assert.rejects(malformed.getShipmentPresence({ scope: 'anonymous', stripeSessionIds: ['cs_requested'] }), /Invalid shipment presence/);
});

test('presence failures propagate instead of returning an absent shipment', async () => {
  const failure = new Error('database unavailable');
  const api = client(async () => { throw failure; });
  await assert.rejects(api.getShipmentPresence({ scope: 'wallet', expectedWallet: OWNER, deliveries: [{ dropId: 'drop', deliveryId: 100 }] }), (error) => error === failure);
});

test('presence batches cannot combine results from different authenticated subjects', async () => {
  let calls = 0;
  const api = client(async (_path, body, _capture, options) => {
    calls += 1;
    options?.onCredential?.(calls === 1 ? 'subject-a' : 'subject-b');
    return { stripeSessionIds: (body as ShipmentPresenceRequest).stripeSessionIds, deliveries: [] };
  });
  await assert.rejects(api.getShipmentPresence({
    scope: 'wallet', expectedWallet: OWNER, stripeSessionIds: Array.from({ length: 51 }, (_, index) => `cs_${index}`),
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'auth-subject-changed');
  assert.equal(calls, 2);
});
