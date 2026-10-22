import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { checkoutReturnUrl, normalizeCheckoutState, type EthereumCheckoutStatusResponse } from '../shared/ethereum/checkout.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { ethereumAssetId } from '../shared/ethereum/protocol.ts';
import { checkoutApi } from '../src/checkout/api.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const checkoutId = '11111111-1111-4111-8111-111111111111';
const config = resolveEthereum111kConfig({ contractAddress: '0x3333333333333333333333333333333333333333' });
let dom: ReturnType<typeof setupFrontendDom>['dom'];

beforeEach(() => { ({ dom } = setupFrontendDom()); });
afterEach(() => { dom.window.close(); });

function snapshot(state: string): EthereumCheckoutStatusResponse {
  return {
    checkoutId, dropId: '111k_devnet', chainId: config.chainId, contractAddress: config.contractAddress!, config,
    tokenIds: ['1'], items: [{ id: ethereumAssetId(config.chainId, config.contractAddress!, '1'), chainId: config.chainId,
      contractAddress: config.contractAddress!, owner: '0x1111111111111111111111111111111111111111', tokenId: '1',
      kind: 'crate', displayId: 1, name: 'Crate #1', image: 'data:image/svg+xml,%3Csvg%2F%3E' }],
    unavailableTokenIds: [], wallet: null, status: 'ready', orderId: null, transactionHash: null, confirmations: 0,
    requiredConfirmations: config.confirmationBlocks, quoteExpiresAtMs: null, attempt: null,
    returnUrl: checkoutReturnUrl({ callbackUrl: 'https://vvv.so/callback', checkoutId, state,
      result: 'canceled', chainId: config.chainId }),
  };
}

for (const operation of ['create', 'status'] as const) {
  const request = (state = '') => operation === 'create'
    ? checkoutApi.create({ requestId: checkoutId, dropId: '111k_devnet', tokenIds: ['1'], state })
    : checkoutApi.status(checkoutId);

  test(`checkout ${operation} preserves the maximum accepted Unicode state`, async context => {
    const state = '漢'.repeat(512);
    assert.equal(normalizeCheckoutState(state), state);
    const response = snapshot(state);
    assert.ok(response.returnUrl!.length > 4096);
    context.mock.method(globalThis, 'fetch', async () => Response.json(response));
    const checkout = await request(state);
    assert.equal(checkout.returnUrl, response.returnUrl);
    assert.equal(new URL(checkout.returnUrl!).searchParams.get('state'), state);
  });

  test(`checkout ${operation} rejects oversized return URLs`, async context => {
    const response = snapshot('a'.repeat(8192));
    assert.ok(response.returnUrl!.length > 8192);
    context.mock.method(globalThis, 'fetch', async () => Response.json(response));
    await assert.rejects(request(), /invalid response/);
  });

  test(`checkout ${operation} still rejects unsafe callbacks`, async context => {
    let response = snapshot('opaque');
    context.mock.method(globalThis, 'fetch', async () => Response.json(response));
    for (const callback of ['https://evil.example/callback', 'https://user@vvv.so/callback',
      'https://vvv.so:8443/callback', 'https://vvv.so/other', 'https://vvv.so/callback#fragment']) {
      response = snapshot('opaque');
      const url = new URL(callback);
      url.search = new URL(response.returnUrl!).search;
      response.returnUrl = url.href;
      await assert.rejects(request(), /not allowed/, callback);
    }
  });
}
