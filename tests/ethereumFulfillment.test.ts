import assert from 'node:assert/strict';
import test from 'node:test';
import { fulfillmentOrderFromRecord } from '../shared/fulfillmentReadModel.ts';
import { createFulfillmentApiClient } from '../src/api/fulfillment.ts';

const HASH = `0x${'ab'.repeat(32)}`;
const fields = {
  source: 'ethereum', chainId: 11155111, deliverySignature: HASH,
  status: 'ready_to_ship', owner: '0x1111111111111111111111111111111111111111', items: [],
};
const options = { canViewSensitiveAddress: false, decryptAddress: () => null, dropId: '111k_devnet' };

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
