import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { checkoutReturnUrl, type EthereumCheckoutStatusResponse } from '../shared/ethereum/checkout.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { ethereumAssetId } from '../shared/ethereum/protocol.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

let { dom } = setupFrontendDom();
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: CheckoutPage } = await import('../src/checkout/CheckoutPage.tsx');
const { checkoutApi, CheckoutApiError } = await import('../src/checkout/api.ts');
const { checkoutReservesItems } = await import('../src/ethereum/checkoutReservations.ts');
dom.window.close();

const checkoutId = '11111111-1111-4111-8111-111111111111';
const contract = '0x3333333333333333333333333333333333333333';
const config = resolveEthereum111kConfig({ contractAddress: contract });
const callback = checkoutReturnUrl({ callbackUrl: 'https://vvv.so/collection', checkoutId,
  result: 'pending', state: 'partner-request', chainId: config.chainId });
const owner = '0x1111111111111111111111111111111111111111';
const pending: EthereumCheckoutStatusResponse = {
  checkoutId, dropId: '111k_devnet', chainId: config.chainId, contractAddress: contract, config,
  tokenIds: ['111112'], items: [{ id: ethereumAssetId(config.chainId, contract, '111112'),
    chainId: config.chainId, contractAddress: contract, tokenId: '111112', owner, kind: 'crate',
    displayId: 1, name: 'Crate #1', image: 'data:image/svg+xml,%3Csvg/%3E' }], unavailableTokenIds: [],
  wallet: owner, status: 'pending', orderId: 42, transactionHash: null, confirmations: 0,
  requiredConfirmations: config.confirmationBlocks, quoteExpiresAtMs: null,
  attempt: { attemptId: '22222222-2222-4222-8222-222222222222', status: 'started', transactionHash: null },
  returnUrl: callback,
};

let client: InstanceType<typeof QueryClient>;
beforeEach(() => {
  ({ dom } = setupFrontendDom());
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  client = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  dom.window.close();
});

function renderCheckout(id: string | undefined, search = '', onAssign?: () => void) {
  dom.reconfigure({ url: `https://mons.shop/checkout${id ? `/${id}` : ''}${search}` });
  const location = { ...dom.window.location, assign(url: string) {
    onAssign?.();
    dom.reconfigure({ url: new URL(url, dom.window.location.href).href });
  } };
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: Object.assign(Object.create(dom.window, { location: { value: location } }), {
      addEventListener: dom.window.addEventListener.bind(dom.window),
      removeEventListener: dom.window.removeEventListener.bind(dom.window),
      dispatchEvent: dom.window.dispatchEvent.bind(dom.window),
    }),
  });
  return render(createElement(QueryClientProvider, { client }, createElement(CheckoutPage, { checkoutId: id, search })));
}

test('a transient saved checkout lookup can be retried with the same arrow and reserves pending items before returning', async t => {
  const status = t.mock.method(checkoutApi, 'status', async () => pending);
  status.mock.mockImplementationOnce(async () => { throw new CheckoutApiError(503, 'Try again later.', null); });
  let reservedOnReturn = false;
  const view = renderCheckout(checkoutId, '', () => { reservedOnReturn = checkoutReservesItems(pending.items); });
  const button = view.getByRole('button', { name: 'return' }) as HTMLButtonElement;
  assert.equal(button.textContent?.trim(), '←');
  assert.equal(status.mock.callCount(), 0);
  fireEvent.click(button);
  await view.findByRole('alert');
  assert.equal(dom.window.location.pathname, `/checkout/${checkoutId}`);
  assert.equal(button.disabled, false);
  assert.equal(checkoutReservesItems(pending.items), false);
  fireEvent.click(button);
  await waitFor(() => assert.equal(dom.window.location.href, callback));
  assert.deepEqual(status.mock.calls.map(call => call.arguments[0]), [checkoutId, checkoutId]);
  assert.equal(reservedOnReturn, true);
});

test('return from a pending checkout waits for durable storage and can be retried', async t => {
  t.mock.method(checkoutApi, 'status', async () => pending);
  const view = renderCheckout(checkoutId);
  const storage = window.localStorage;
  const blockedWrite = t.mock.method(Object.getPrototypeOf(storage), 'setItem', () => {
    throw new Error('Storage quota exceeded');
  });
  const button = view.getByRole('button', { name: 'return' }) as HTMLButtonElement;
  fireEvent.click(button);
  const alert = await view.findByRole('alert');
  assert.match(alert.textContent!, /storage/i);
  assert.match(alert.textContent!, /enable|allow|free up/i);
  assert.equal(dom.window.location.pathname, `/checkout/${checkoutId}`);
  assert.equal(storage.length, 0);
  assert.equal(button.disabled, false);

  blockedWrite.mock.restore();
  fireEvent.click(button);
  await waitFor(() => assert.equal(dom.window.location.href, callback));
  const currentWindow = window;
  const otherTab = new JSDOM('', { url: 'https://mons.shop/' });
  Object.defineProperty(otherTab.window, 'localStorage', { value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: otherTab.window });
  try {
    assert.equal(checkoutReservesItems(pending.items), true);
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: currentWindow });
    otherTab.window.close();
  }
});

test('a missing saved checkout returns to the collection', async t => {
  t.mock.method(checkoutApi, 'status', async () => { throw new CheckoutApiError(404, 'Checkout not found.', null, 'not-found'); });
  const view = renderCheckout(checkoutId);
  fireEvent.click(view.getByRole('button', { name: 'return' }));
  await waitFor(() => assert.equal(dom.window.location.pathname, '/111k_devnet'));
});

test('a partner entry returns to its exact callback with the original state without creating a checkout', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected checkout request'));
  const params = new URLSearchParams({ drop: '111k_devnet', ids: '332,553', state: 'lot+7&result=success',
    callback_url: 'https://www.vvv.so/111k-sepolia-test/floor' });
  const view = renderCheckout(undefined, `?${params}`);
  fireEvent.click(view.getByRole('button', { name: 'return' }));
  await waitFor(() => assert.equal(dom.window.location.href,
    'https://www.vvv.so/111k-sepolia-test/floor?state=lot%2B7%26result%3Dsuccess'));
  assert.equal(fetch.mock.callCount(), 0);
});

test('a blob callback with a partner origin returns to the collection', async () => {
  const params = new URLSearchParams({ drop: '111k_devnet', ids: '111112', callback_url: 'blob:https://vvv.so/missing' });
  const view = renderCheckout(undefined, `?${params}`);
  fireEvent.click(view.getByRole('button', { name: 'return' }));
  await waitFor(() => assert.equal(dom.window.location.href, 'https://mons.shop/111k_devnet'));
});
