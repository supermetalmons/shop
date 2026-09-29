import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeDeliveryRecoveryCursor,
  encodeDeliveryRecoveryCursor,
  type DeliveryRecoveryCursor,
} from '../shared/deliveryRecoveryPagination.ts';
import { createCommerceApiClient, parseRecoverDeliveryOrdersResult } from '../src/api/commerce.ts';

const cursor: DeliveryRecoveryCursor = {
  version: 1,
  owner: '11111111111111111111111111111111',
  dropId: 'card_nft_2',
  force: false,
  phase: 'processing',
  path: 'drops/card_nft_2/deliveryOrders/42',
};

const result = {
  attempted: 0,
  recovered: 0,
  remainingProcessing: 0,
  walletRecovery: { remainingProcessing: 0, nextCheckAt: null },
  results: [],
};

test('recovery cursors round trip strict wallet, drop, force and immutable phase/path scopes', () => {
  assert.deepEqual(decodeDeliveryRecoveryCursor(encodeDeliveryRecoveryCursor(cursor)), cursor);
  for (const value of [
    undefined, null, '', 'invalid', '=', 'a'.repeat(1025),
    btoa(JSON.stringify({ ...cursor, extra: true })),
    btoa(JSON.stringify({ ...cursor, version: 2 })),
    btoa(JSON.stringify({ ...cursor, force: 'false' })),
    btoa(JSON.stringify({ ...cursor, phase: 'all' })),
    btoa(JSON.stringify({ ...cursor, owner: 'not-a-wallet' })),
    btoa(JSON.stringify({ ...cursor, path: 'drops/other/deliveryOrders/42' })),
  ]) assert.equal(decodeDeliveryRecoveryCursor(value), null);
});

test('recovery response decoding preserves legacy shape and validates optional continuation', () => {
  assert.deepEqual(parseRecoverDeliveryOrdersResult(result), result);
  assert.deepEqual(parseRecoverDeliveryOrdersResult({ ...result, nextCursor: null }), { ...result, nextCursor: null });
  const nextCursor = encodeDeliveryRecoveryCursor(cursor);
  assert.deepEqual(parseRecoverDeliveryOrdersResult({ ...result, nextCursor }), { ...result, nextCursor });
  for (const nextCursor of ['invalid', 1, {}, true]) {
    assert.equal(parseRecoverDeliveryOrdersResult({ ...result, nextCursor }), null);
  }
  assert.equal(parseRecoverDeliveryOrdersResult({ ...result, extra: true }), null);
});

test('recovery client opts in explicitly and rejects missing or mismatched page responses', async () => {
  const requests: unknown[] = [];
  let response: unknown = { ...result, nextCursor: encodeDeliveryRecoveryCursor(cursor) };
  const api = createCommerceApiClient(async (_path, body) => { requests.push(body); return response; });
  await api.recoverMyDeliveryOrders({ dropId: 'card_nft_2', cursor: null });
  assert.deepEqual(requests, [{ dropId: 'card_nft_2', cursor: null }]);
  await api.recoverMyDeliveryOrders({ dropId: 'card_nft_2', cursor: encodeDeliveryRecoveryCursor(cursor) });
  assert.deepEqual(requests[1], { dropId: 'card_nft_2', cursor: encodeDeliveryRecoveryCursor(cursor) });
  await assert.rejects(api.recoverMyDeliveryOrders({ dropId: 'card_nft_2', force: true, cursor: null }), /Invalid delivery recovery response/);
  await assert.rejects(api.recoverMyDeliveryOrders({ cursor: null }), /Invalid delivery recovery response/);
  response = result;
  await assert.rejects(api.recoverMyDeliveryOrders({ cursor: null }), /Invalid delivery recovery response/);
  assert.deepEqual(await api.recoverMyDeliveryOrders(), result);
});
