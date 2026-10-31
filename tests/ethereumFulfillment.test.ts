import assert from 'node:assert/strict';
import test from 'node:test';
import { fulfillmentOrderFromRecord } from '../shared/fulfillmentReadModel.ts';
import { createFulfillmentApiClient } from '../src/api/fulfillment.ts';
import { loadEthereumFulfillmentPreview } from '../src/fulfillment/EthereumFulfillmentCard.tsx';
import { parseDeliveryOrderSummary } from '../shared/deliveryOrderSummary.ts';

const HASH = `0x${'ab'.repeat(32)}`;
const fields = {
  source: 'ethereum', chainId: 11155111, deliverySignature: HASH,
  status: 'ready_to_ship', owner: '0x1111111111111111111111111111111111111111', items: [],
};
const options = { canViewSensitiveAddress: false, decryptAddress: () => null, dropId: '111k_devnet' };

test('monument delivery identities survive fulfillment and profile adapters without crate claims', async () => {
  const items = [{ kind: 'monument', refId: 18 }, { kind: 'dude', refId: 7 }, { kind: 'monument', refId: 1 }];
  const order = fulfillmentOrderFromRecord('42', { ...fields, items }, options)!;
  assert.deepEqual(order.monuments, [1, 18]);
  assert.deepEqual(order.boxes, []);
  assert.deepEqual(order.looseDudes, [7]);
  assert.deepEqual(order.cardClaims, []);
  const api = createFulfillmentApiClient(async () => ({ orders: [order] }));
  assert.deepEqual((await api.listFulfillmentOrders({ dropId: options.dropId })).orders[0].monuments, [1, 18]);
  assert.deepEqual(parseDeliveryOrderSummary({ ...fields, dropId: options.dropId, deliveryId: 42, items })?.items, items);
});

test('fulfillment API defaults legacy monument lists and rejects malformed lists', async () => {
  const order = fulfillmentOrderFromRecord('42', fields, options)!;
  assert.deepEqual(order.monuments, []);
  const legacy = { ...order, monuments: undefined };
  const api = createFulfillmentApiClient(async () => ({ orders: [legacy] }));
  assert.deepEqual((await api.listFulfillmentOrders({ dropId: options.dropId })).orders[0].monuments, []);
  for (const monuments of [null, {}, '1', [0], [-1], [1.5], ['1'], [NaN]]) {
    const invalid = createFulfillmentApiClient(async () => ({ orders: [{ ...order, monuments }] }));
    await assert.rejects(invalid.listFulfillmentOrders({ dropId: options.dropId }), /Invalid fulfillment orders response/);
  }
});

test('Ethereum fulfillment transactions survive the stored order and API adapters', async () => {
  for (const chainId of [11155111, 31337]) {
    const order = fulfillmentOrderFromRecord('42', {
      ...fields, chainId, deliverySignature: `0x${'AB'.repeat(32)}`,
    }, options);
    assert.deepEqual(order?.ethereumTransaction, { chainId, hash: HASH });
    const api = createFulfillmentApiClient(async () => ({ orders: [order] }));
    const response = await api.listFulfillmentOrders({ dropId: options.dropId });
    assert.deepEqual(response.orders[0].ethereumTransaction, { chainId, hash: HASH });
  }
});

test('fulfillment adapters omit invalid or unrelated stored Ethereum transactions', () => {
  for (const changes of [
    { source: 'onchain' }, { source: undefined }, { chainId: 1 }, { chainId: '11155111' },
    { chainId: undefined }, { deliverySignature: null }, { deliverySignature: '0xab' },
    { deliverySignature: `https://example.com/${HASH}` },
  ]) {
    const order = fulfillmentOrderFromRecord('42', { ...fields, ...changes }, options);
    assert.ok(order);
    assert.equal(order.ethereumTransaction, undefined);
  }
});

test('fulfillment API rejects malformed transaction references and accepts legacy orders', async () => {
  const order = fulfillmentOrderFromRecord('42', fields, options)!;
  for (const ethereumTransaction of [
    { chainId: 1, hash: HASH }, { chainId: '11155111', hash: HASH },
    { chainId: 11155111, hash: 'javascript:alert(1)' }, { chainId: 11155111 },
    { chainId: 11155111, hash: HASH, explorerUrl: 'https://example.com' }, null,
  ]) {
    const api = createFulfillmentApiClient(async () => ({ orders: [{ ...order, ethereumTransaction }] }));
    await assert.rejects(api.listFulfillmentOrders({ dropId: options.dropId }), /Invalid fulfillment orders response/);
  }
  const api = createFulfillmentApiClient(async () => ({ orders: [{ ...order, ethereumTransaction: undefined }] }));
  assert.equal((await api.listFulfillmentOrders({ dropId: options.dropId })).orders.length, 1);
});

test('fulfillment previews deduplicate only pending reads within the same scope and refetch later edits', async t => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let image = 'data:image/svg+xml;base64,Zmlyc3Q=';
  const requests: RequestInit[] = [];
  const fetch = t.mock.method(globalThis, 'fetch', async (_input, init) => {
    requests.push(init ?? {});
    await held;
    return Response.json({ image });
  });
  const first = loadEthereumFulfillmentPreview('artwork_receipt', 222222, 'deployment-a');
  const duplicate = loadEthereumFulfillmentPreview('artwork_receipt', 222222, 'deployment-a');
  const other = loadEthereumFulfillmentPreview('artwork_receipt', 222222, 'deployment-b');
  assert.equal(first, duplicate);
  assert.notEqual(first, other);
  assert.equal(fetch.mock.callCount(), 2);
  release();
  assert.deepEqual(await Promise.all([first, duplicate, other]), [image, image, image]);
  image = 'https://future-cdn.example/artwork-receipt.webp';
  assert.equal(await loadEthereumFulfillmentPreview('artwork_receipt', 222222, 'deployment-a'), image);
  assert.equal(fetch.mock.callCount(), 3);
  assert.ok(requests.every(request => request.cache === 'no-store'));
});

test('fulfillment previews reject unsafe image URLs', async t => {
  let image = '';
  t.mock.method(globalThis, 'fetch', async () => Response.json({ image }));
  for (image of ['http://wip.lil.org/receipt.webp', 'https://user@wip.lil.org/receipt.webp', 'javascript:alert(1)']) {
    await assert.rejects(loadEthereumFulfillmentPreview('crate_receipt', 1), /Invalid Ethereum preview/);
  }
});
