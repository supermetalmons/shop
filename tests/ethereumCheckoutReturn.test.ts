import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import type { EthereumCheckoutStatusResponse } from '../shared/ethereum/checkout.ts';
import type { EthereumCheckoutReturnStatus } from '../src/ethereum/EthereumCheckoutReturn.tsx';
import { setupFrontendDom } from './helpers/frontendDom.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { EthereumCheckoutReturn } = await import('../src/ethereum/EthereumCheckoutReturn.tsx');
const { checkoutApi, CheckoutApiError } = await import('../src/checkout/api.ts');
const { rememberCheckoutReservation } = await import('../src/ethereum/checkoutReservations.ts');
dom.window.close();

const checkoutId = '11111111-1111-4111-8111-111111111111';
const otherCheckoutId = '22222222-2222-4222-8222-222222222222';
const contract = '0x3333333333333333333333333333333333333333';
const config = resolveEthereum111kConfig({ contractAddress: contract });
const clients: InstanceType<typeof QueryClient>[] = [];

function checkout(status: EthereumCheckoutStatusResponse['status'], id = checkoutId): EthereumCheckoutStatusResponse {
  return {
    checkoutId: id, dropId: '111k_devnet', chainId: config.chainId, contractAddress: contract, config,
    tokenIds: ['111112'], items: [], unavailableTokenIds: [], wallet: null, status,
    orderId: null, transactionHash: null, confirmations: status === 'success' ? config.confirmationBlocks : 0,
    requiredConfirmations: config.confirmationBlocks, quoteExpiresAtMs: null, attempt: null,
  };
}

function returnPage(onConfirmed: (checkout: EthereumCheckoutStatusResponse) => void, id = checkoutId,
  initialize?: (client: InstanceType<typeof QueryClient>) => void, onStatus?: (status: EthereumCheckoutReturnStatus) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  initialize?.(client);
  const tree = (nextId = id, confirmed = onConfirmed) => createElement(QueryClientProvider, { client },
    createElement(EthereumCheckoutReturn, { checkoutId: nextId, onConfirmed: confirmed, onStatus }));
  const view = render(tree());
  return { ...view, client, rerenderReturn(nextId = id, confirmed = onConfirmed) { view.rerender(tree(nextId, confirmed)); } };
}

beforeEach(() => {
  ({ dom } = setupFrontendDom());
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  window.history.replaceState(null, '', `/111k_devnet?checkout_id=${checkoutId}`);
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  dom.window.close();
});

test('a forged success return waits for server status and shows pending without confirming', async t => {
  window.history.replaceState(null, '', `/111k_devnet?checkout_id=${checkoutId}&result=success&tx_hash=0x${'ab'.repeat(32)}`);
  let resolve!: (value: EthereumCheckoutStatusResponse) => void;
  const status = t.mock.method(checkoutApi, 'status', () => new Promise<EthereumCheckoutStatusResponse>(done => { resolve = done; }));
  let confirmed = 0;
  const view = returnPage(() => { confirmed++; });
  assert.ok(view.getByText('Checking your checkout…'));
  assert.equal(view.queryByText('Your test redemption is confirmed.'), null);
  assert.equal(confirmed, 0);
  assert.equal(status.mock.calls[0].arguments[0], checkoutId);
  await act(async () => { resolve(checkout('pending')); });
  await waitFor(() => assert.ok(view.getByText('Your redemption is pending. Processing continues even when you leave.')));
  const resume = view.getByRole('link', { name: 'Resume checkout' });
  assert.equal(resume.getAttribute('href'), `/checkout/${checkoutId}`);
  assert.equal(confirmed, 0);
  fireEvent.click(resume);
  assert.equal(window.location.pathname, `/checkout/${checkoutId}`);
  assert.equal(window.location.search, '');
});

test('server confirmation refreshes inventory once even when URL says canceled and callbacks rerender', async t => {
  window.history.replaceState(null, '', `/111k_devnet?checkout_id=${checkoutId}&result=canceled`);
  const successful = checkout('success');
  t.mock.method(checkoutApi, 'status', async () => successful);
  let confirmed = 0;
  const view = returnPage(response => { assert.deepEqual(response, successful); confirmed++; });
  await waitFor(() => assert.equal(confirmed, 1));
  assert.ok(view.getByText('Your test redemption is confirmed.'));
  assert.ok(view.getByRole('link', { name: 'View checkout' }));
  view.rerenderReturn(checkoutId, () => { confirmed++; });
  await act(async () => { await view.client.refetchQueries({ queryKey: ['ethereum-checkout', 'return', checkoutId] }); });
  assert.equal(confirmed, 1);
});

test('pending return becomes confirmed from refreshed server data without a wallet connection', async t => {
  Object.defineProperty(window, 'ethereum', { configurable: true, get() { throw new Error('A wallet must not be required to read checkout status'); } });
  let response = checkout('pending');
  t.mock.method(checkoutApi, 'status', async () => response);
  let confirmed = 0;
  const view = returnPage(() => { confirmed++; });
  await waitFor(() => assert.ok(view.getByText('Your redemption is pending. Processing continues even when you leave.')));
  assert.equal(confirmed, 0);
  response = checkout('success');
  await act(async () => { await view.client.refetchQueries({ queryKey: ['ethereum-checkout', 'return', checkoutId] }); });
  await waitFor(() => assert.equal(confirmed, 1));
  assert.ok(view.getByRole('link', { name: 'View checkout' }));
});

test('each newly returned confirmed checkout refreshes its inventory independently', async t => {
  t.mock.method(checkoutApi, 'status', async id => checkout('success', id));
  let confirmed = 0;
  const view = returnPage(() => { confirmed++; });
  await waitFor(() => assert.equal(confirmed, 1));
  view.rerenderReturn(otherCheckoutId);
  await waitFor(() => assert.equal(confirmed, 2));
  assert.equal(view.getByRole('link', { name: 'View checkout' }).getAttribute('href'), `/checkout/${otherCheckoutId}`);
  view.rerenderReturn(checkoutId);
  await act(async () => { await view.client.refetchQueries({ queryKey: ['ethereum-checkout', 'return', checkoutId] }); });
  assert.equal(confirmed, 2);
});

test('cached success cannot confirm before a fresh successful status response', async t => {
  let resolve!: (value: EthereumCheckoutStatusResponse) => void;
  let response = new Promise<EthereumCheckoutStatusResponse>(done => { resolve = done; });
  t.mock.method(checkoutApi, 'status', () => response);
  let confirmed = 0;
  const view = returnPage(() => { confirmed++; }, checkoutId,
    client => client.setQueryData(['ethereum-checkout', 'return', checkoutId], checkout('success')));
  assert.equal(confirmed, 0);
  await act(async () => { resolve(checkout('pending')); });
  await waitFor(() => assert.ok(view.getByText(/Your redemption is pending/)));
  assert.equal(confirmed, 0);
  response = Promise.resolve(checkout('success'));
  await act(async () => { await view.client.refetchQueries({ queryKey: ['ethereum-checkout', 'return', checkoutId] }); });
  await waitFor(() => assert.equal(confirmed, 1));
  response = Promise.resolve(checkout('pending'));
  await act(async () => { await view.client.refetchQueries({ queryKey: ['ethereum-checkout', 'return', checkoutId] }); });
  response = Promise.resolve(checkout('success'));
  await act(async () => { await view.client.refetchQueries({ queryKey: ['ethereum-checkout', 'return', checkoutId] }); });
  await waitFor(() => assert.equal(confirmed, 2));
});

for (const available of [true, false]) test(`cached success ${available ? 'confirms after an identical fresh response' : 'does not confirm after a failed fresh read'}`, async t => {
  let resolve!: (value: EthereumCheckoutStatusResponse) => void;
  let reject!: (error: Error) => void;
  const response = new Promise<EthereumCheckoutStatusResponse>((success, failure) => { resolve = success; reject = failure; });
  t.mock.method(checkoutApi, 'status', () => response);
  let confirmed = 0;
  const view = returnPage(() => { confirmed++; }, checkoutId,
    client => client.setQueryData(['ethereum-checkout', 'return', checkoutId], checkout('success')));
  assert.equal(confirmed, 0);
  await act(async () => { if (available) resolve(checkout('success')); else reject(new Error('Unavailable')); });
  if (available) await waitFor(() => assert.equal(confirmed, 1));
  else {
    await waitFor(() => assert.ok(view.getByText(/Couldn’t check your checkout/)));
    assert.equal(confirmed, 0);
  }
});

test('cached return failure preserves a restored reservation until a fresh terminal response', async t => {
  const attemptId = '33333333-3333-4333-8333-333333333333';
  const pending: EthereumCheckoutStatusResponse = { ...checkout('pending'), wallet: '0x1111111111111111111111111111111111111111',
    attempt: { attemptId, status: 'submitted', transactionHash: null } };
  const failed: EthereumCheckoutStatusResponse = { ...pending, status: 'failed' };
  const key = `mons.shop.ethereum-checkout-reservation:${checkoutId}:${attemptId}`;
  const reserved = () => Object.keys(window.localStorage).some(stored => stored.startsWith(key));
  let resolve!: (value: EthereumCheckoutStatusResponse) => void;
  let response = new Promise<EthereumCheckoutStatusResponse>(done => { resolve = done; });
  t.mock.method(checkoutApi, 'status', () => response);
  rememberCheckoutReservation(pending);
  const view = returnPage(() => {}, checkoutId, client => client.setQueryData(['ethereum-checkout', 'return', checkoutId], failed));
  assert.ok(reserved());
  await act(async () => { resolve(pending); });
  await waitFor(() => assert.ok(view.getByText(/Your redemption is pending/)));
  assert.ok(reserved());
  response = Promise.resolve(failed);
  await act(async () => { await view.client.refetchQueries({ queryKey: ['ethereum-checkout', 'return', checkoutId] }); });
  assert.equal(reserved(), false);
});

for (const inactive of ['ready', 'prepared', 'success', 'failed'] as const) {
  for (const available of [true, false]) test(`cached ${inactive} releases the inventory guard only after a fresh successful read (${available ? 'available' : 'unavailable'})`, async t => {
    let resolve!: (value: EthereumCheckoutStatusResponse) => void;
    let reject!: (error: Error) => void;
    let response = new Promise<EthereumCheckoutStatusResponse>((success, failure) => { resolve = success; reject = failure; });
    t.mock.method(checkoutApi, 'status', () => response);
    const cached = checkout(inactive);
    const statuses: EthereumCheckoutReturnStatus[] = [];
    const view = returnPage(() => {}, checkoutId,
      client => client.setQueryData(['ethereum-checkout', 'return', checkoutId], cached), status => statuses.push(status));
    assert.deepEqual(statuses, []);
    await act(async () => { if (available) resolve(cached); else reject(new Error('Unavailable')); });
    if (!available) {
      await waitFor(() => assert.ok(view.getByText(/Couldn’t check your checkout/)));
      assert.deepEqual(statuses, []);
      response = Promise.resolve(checkout('pending'));
      await act(async () => { await view.client.refetchQueries({ queryKey: ['ethereum-checkout', 'return', checkoutId] }); });
    }
    await waitFor(() => assert.deepEqual(statuses.map(status => status.status), [available ? inactive : 'pending']));
  });
}

for (const pending of ['pending', 'submitting'] as const) test(`cached ${pending} status preserves the inventory guard when its fresh read fails`, async t => {
  let reject!: (error: Error) => void;
  t.mock.method(checkoutApi, 'status', () => new Promise<EthereumCheckoutStatusResponse>((_resolve, failure) => { reject = failure; }));
  const statuses: EthereumCheckoutReturnStatus[] = [];
  const view = returnPage(() => {}, checkoutId,
    client => client.setQueryData(['ethereum-checkout', 'return', checkoutId], checkout(pending)), status => statuses.push(status));
  assert.deepEqual(statuses.map(status => status.status), [pending]);
  await act(async () => { reject(new Error('Unavailable')); });
  await waitFor(() => assert.ok(view.getByText(/Couldn’t check your checkout/)));
  assert.ok(statuses.length > 0 && statuses.every(status => status.status === pending));
});

test('invalid checkout IDs do not request server status or display a resume link', t => {
  const status = t.mock.method(checkoutApi, 'status');
  const view = returnPage(() => assert.fail('Invalid checkout cannot confirm'), 'invalid-id');
  assert.equal(view.getByRole('alert').textContent, 'This checkout link is invalid.');
  assert.equal(status.mock.callCount(), 0);
  assert.equal(view.queryByRole('link'), null);
});

test('a fresh not-found response explains the expired checkout and links to the collection', async t => {
  t.mock.method(checkoutApi, 'status', async () => { throw new CheckoutApiError(404, 'Checkout not found.', null, 'not-found'); });
  const view = returnPage(() => assert.fail('A missing checkout cannot confirm'));
  await waitFor(() => assert.ok(view.getByText('This checkout has expired or no longer exists.')));
  assert.equal(view.getByRole('link', { name: 'Continue to collection' }).getAttribute('href'), '/111k_devnet');
  assert.equal(view.queryByRole('link', { name: 'Resume checkout' }), null);
});

for (const outcome of ['pending', 'unavailable'] as const) test(`a cached not-found error waits for its fresh ${outcome} response`, async t => {
  let resolve!: (value: EthereumCheckoutStatusResponse) => void;
  let reject!: (error: Error) => void;
  const fresh = new Promise<EthereumCheckoutStatusResponse>((success, failure) => { resolve = success; reject = failure; });
  t.mock.method(checkoutApi, 'status', () => fresh);
  const view = returnPage(() => assert.fail('A missing checkout cannot confirm'), checkoutId, client => {
    const queryKey = ['ethereum-checkout', 'return', checkoutId];
    client.setQueryData(queryKey, checkout('ready'));
    client.getQueryCache().find({ queryKey })!.setState({ status: 'error', errorUpdateCount: 1,
      error: new CheckoutApiError(404, 'Checkout not found.', null, 'not-found'), errorUpdatedAt: Date.now() });
  });
  assert.equal(view.queryByRole('link', { name: 'Continue to collection' }), null);
  await act(async () => {
    if (outcome === 'pending') resolve(checkout('pending'));
    else reject(new Error('Network unavailable'));
  });
  await waitFor(() => assert.ok(view.getByText(outcome === 'pending' ? /Your redemption is pending/ : /Couldn’t check your checkout/)));
  assert.equal(view.queryByRole('link', { name: 'Continue to collection' }), null);
  assert.ok(view.getByRole('link', { name: 'Resume checkout' }));
});

test('an unrecognized 404 remains a retryable checkout error', async t => {
  t.mock.method(checkoutApi, 'status', async () => { throw new CheckoutApiError(404, 'Unavailable route.', null); });
  const view = returnPage(() => assert.fail('An unavailable checkout cannot confirm'));
  await waitFor(() => assert.ok(view.getByText(/Couldn’t check your checkout/)));
  assert.equal(view.queryByRole('link', { name: 'Continue to collection' }), null);
  assert.ok(view.getByRole('link', { name: 'Resume checkout' }));
});

for (const outcome of ['failed', 'unavailable'] as const) {
  test(`${outcome} server status never trusts a success query parameter and allows reopening checkout`, async t => {
    window.history.replaceState(null, '', `/111k_devnet?checkout_id=${checkoutId}&result=success`);
    t.mock.method(checkoutApi, 'status', async () => {
      if (outcome === 'unavailable') throw new Error('Network unavailable');
      return checkout('failed');
    });
    const view = returnPage(() => assert.fail('Failed or unavailable checkout cannot confirm'));
    await waitFor(() => assert.ok(view.getByText(outcome === 'failed'
      ? 'This redemption attempt failed. Open checkout for details.'
      : 'Couldn’t check your checkout. You can reopen it to try again.')));
    assert.equal(view.queryByText('Your test redemption is confirmed.'), null);
    assert.equal(view.getByRole('link', { name: 'Resume checkout' }).getAttribute('href'), `/checkout/${checkoutId}`);
  });
}
