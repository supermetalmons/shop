import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement, useCallback, useRef, useState } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { ETHEREUM_FUNCTIONS, ETHEREUM_MAX_EXPECTED_IDS, ethereumAssetId } from '../shared/ethereum/protocol.ts';
import { encodeCall } from '../shared/ethereum/abi.ts';
import type { EthereumInventoryItem, EthereumInventoryResponse, EthereumStats } from '../shared/ethereum/api.ts';
import type { EthereumWallet } from '../src/ethereum/useEthereum111k.ts';
import type { EthereumCheckoutStatusResponse } from '../shared/ethereum/checkout.ts';
import type { HeaderWallet } from '../src/shop/account/useHeaderWallet.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: Ethereum111kPage } = await import('../src/ethereum/Ethereum111kPage.tsx');
const { ShopHeader } = await import('../src/components/ShopHeader.tsx');
const { ShopHeaderActions } = await import('../src/shop/ui/ShopHeaderActions.tsx');
const { ShopWalletControl } = await import('../src/shop/ui/ShopWalletControl.tsx');
const { useHeaderWallet } = await import('../src/shop/account/useHeaderWallet.ts');
const { useShopSignIn } = await import('../src/shop/account/useShopSignIn.ts');
const { useShopActionContinuation } = await import('../src/shop/account/useShopActionContinuation.ts');
const { useShopActionHandlers } = await import('../src/shop/useShopActionHandlers.ts');
const { BackgroundBlurProvider } = await import('../src/components/BackgroundBlurLayer.tsx');
const { useMiNoteEthereumWallet } = await import('../src/hooks/useMiNoteEthereumWallet.ts');
const { ethereumApi } = await import('../src/ethereum/api.ts');
const { ethereumRevealApi } = await import('../src/ethereum/revealApi.ts');
const { ethereumDiscounts, EMPTY_ETHEREUM_DISCOUNT_ROOT } = await import('../src/ethereum/discounts.ts');
const { ethereumInventoryQueryKey, ethereumInventoryScope, readEthereumExpected, readEthereumPending, readEthereumSubmission, writeEthereumExpected, writeEthereumStorage } = await import('../src/ethereum/state.ts');
const { checkoutApi, CheckoutApiError } = await import('../src/checkout/api.ts');
const { checkoutReservesItems, observeCheckoutReservation, rememberCheckoutReservation } = await import('../src/ethereum/checkoutReservations.ts');
dom.window.close();
const clients: InstanceType<typeof QueryClient>[] = [];
const owner = '0x1111111111111111111111111111111111111111';
const contract = '0x3333333333333333333333333333333333333333';
const config = resolveEthereum111kConfig({ contractAddress: contract });
function previewImage(kind: string): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720"><title>${kind}</title><rect width="720" height="720" fill="#e5c986"/></svg>`)}`;
}
const image = previewImage('crate');
function item(tokenId = '111112', kind: EthereumInventoryItem['kind'] = 'crate'): EthereumInventoryItem {
  return { id: ethereumAssetId(config.chainId, contract, tokenId), tokenId, kind, name: kind === 'crate_receipt' ? 'Crate receipt #1' : 'Crate #1', displayId: 1,
    chainId: config.chainId, contractAddress: contract, owner, image };
}
const wallet: EthereumWallet = {
  address: owner, provider: { request: async ({ method }) => method === 'eth_chainId' ? '0xaa36a7' : method === 'eth_getTransactionCount' ? '0x7' : [owner] },
  ready: true, status: 'connected', wallets: [], error: null,
  connect() {}, cancel() {}, disconnect() {}, selectWallet() {},
  chooseWallet() {}, changeAccount() {}, checkAccount() {},
};
function stats(overrides: Partial<EthereumStats> = {}): EthereumStats {
  return { allocatedCrates: 0, warehousesMinted: 0, monumentsMinted: 0, artworksMinted: 0, cratePriceWei: config.cratePriceWei,
    warehousePriceWei: config.warehousePriceWei, monumentPriceWei: config.monumentPriceWei, saleActive: true, remainingCrates: 5555, remainingWarehouses: 505, remainingMonuments: 18,
    chainId: config.chainId, contractAddress: contract, owner, discountMerkleRoot: EMPTY_ETHEREUM_DISCOUNT_ROOT,
    discountCratePriceWei: '50000000000000', discountAllowance: 1, discountUsed: 0, ...overrides };
}
beforeEach(context => {
  const t = context as TestContext;
  ({ dom } = setupFrontendDom());
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => callback({}),
  } });
  window.history.replaceState(null, '', '/111k_devnet');
  t.mock.method(ethereumApi, 'config', async () => config);
  t.mock.method(ethereumApi, 'stats', async () => stats());
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [item()], nextCursor: null, observedBlock: 10 }));
  t.mock.method(ethereumRevealApi, 'transaction', async () => ({ chainId: config.chainId, contractAddress: contract,
    dropId: config.dropId, deploymentId: 'test', status: 'pending', artworks: [], retryAfterMs: 2_000 }));
  t.mock.method(ethereumRevealApi, 'tokens', async (_config, tokenIds) => ({ chainId: config.chainId, contractAddress: contract,
    dropId: config.dropId, deploymentId: 'test', artworks: [], retryAfterMs: 2_000,
    unresolved: tokenIds.map(tokenId => ({ tokenId, status: 'recovering' as const })) }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); dom.window.close(); });
function page(overrides: Partial<Parameters<typeof Ethereum111kPage>[0]> = {}, initialize?: (client: InstanceType<typeof QueryClient>) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  initialize?.(client);
  const props: Parameters<typeof Ethereum111kPage>[0] = {
    wallet, addressEncryptionPublicKey: '', solanaInventoryItems: [], solanaSelected: new Set<string>(),
    onSolanaToggle() {}, clearSolanaSelection() {}, pendingRevealIds: new Set<string>(), onSolanaReveal() {}, onSolanaView() {},
    canOpenSolanaBoxes: () => true, solanaRevealLoading: null, solanaInventoryReady: true,
    ...overrides,
  };
  const tree = () => createElement(QueryClientProvider, { client }, createElement(Ethereum111kPage, props));
  const view = render(tree());
  return { ...view, client, rerenderPage(next: Partial<typeof props>) {
    Object.assign(props, next);
    view.rerender(tree());
  } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

type ShopActionHandlerOptions = Parameters<typeof useShopActionHandlers>[0];

function headerSignInOptions(
  continuation: ShopActionHandlerOptions['continuation'],
  showToast: ShopActionHandlerOptions['showToast'],
): ShopActionHandlerOptions {
  const unexpected = (dependency: string): never => assert.fail(`Unexpected ${dependency} in Ethereum header sign-in`);
  return {
    continuation, showToast, owner: undefined, routeDropId: '111k_devnet',
    blockViewerModeAction: () => unexpected('viewer mode check'),
    get selection() { return unexpected('selection'); },
    get selectionState() { return unexpected('selection state'); },
    get inventory() { return unexpected('inventory'); },
    get queries() { return unexpected('inventory queries'); },
    get modals() { return unexpected('commerce modals'); },
    get preorder() { return unexpected('preorder'); },
    get purchase() { return unexpected('purchase'); },
    get delivery() { return unexpected('delivery'); },
    get claim() { return unexpected('claim'); },
    get receipts() { return unexpected('receipts'); },
    get reveal() { return unexpected('reveal'); },
  };
}

const returnedCheckoutId = '11111111-1111-4111-8111-111111111111';
const returnedAttemptId = '22222222-2222-4222-8222-222222222222';
function returnedCheckout(overrides: Partial<EthereumCheckoutStatusResponse> = {}): EthereumCheckoutStatusResponse {
  return { checkoutId: returnedCheckoutId, dropId: '111k_devnet', chainId: config.chainId, contractAddress: contract, config,
    tokenIds: ['111112'], items: [item()], unavailableTokenIds: [], wallet: owner, status: 'pending', orderId: 42,
    transactionHash: `0x${'ab'.repeat(32)}`, confirmations: 0, requiredConfirmations: 3, quoteExpiresAtMs: Date.now() + 600000,
    attempt: { attemptId: returnedAttemptId, status: 'submitted', transactionHash: `0x${'ab'.repeat(32)}` }, ...overrides };
}

test('confirmed checkout receipts survive lagging inventory indexing, refreshes, and a reorg', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  const sources = [item(), { ...item('332', 'artwork'), displayId: 821, name: 'Artwork #821' }];
  const receipts = [item('2000001', 'crate_receipt'), { ...item('1000821', 'artwork_receipt'), displayId: 821, name: 'Artwork receipt #821' }];
  const recovery = { hash: `0x${'cd'.repeat(32)}`, sourceIds: ['99'], mintedIds: ['77'] };
  writeEthereumExpected(scope, ['77'], recovery);
  const fresh = deferred<EthereumCheckoutStatusResponse>();
  let response = fresh.promise;
  t.mock.method(checkoutApi, 'status', () => response);
  let reverted = false;
  const inventory = t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({
    items: (reverted ? sources : receipts).filter(token => expected.includes(token.tokenId)), nextCursor: null, observedBlock: 10,
  }));
  const view = page({ checkoutReturnId: returnedCheckoutId });
  await waitFor(() => assert.equal(view.client.getQueryState(ethereumInventoryQueryKey(scope))?.fetchStatus, 'idle'));
  assert.equal(view.queryByRole('button', { name: 'View Crate receipt #1' }), null);
  const successful = returnedCheckout({ status: 'success', confirmations: 3, tokenIds: sources.map(token => token.tokenId), items: sources });
  await act(async () => { fresh.resolve(successful); });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'View Crate receipt #1' })));
  assert.ok(view.getByRole('button', { name: 'View Artwork receipt #821' }));
  assert.deepEqual(readEthereumExpected(scope), ['77', '111112', '332', '2000001', '1000821']);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(`ethereum111k:${scope}:expected`)!).recovery, recovery);
  const refreshed = inventory.mock.callCount();
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Refresh' })); });
  await waitFor(() => assert.ok(inventory.mock.callCount() > refreshed));
  assert.ok(view.getByRole('button', { name: 'View Crate receipt #1' }));
  assert.ok(view.getByRole('button', { name: 'View Artwork receipt #821' }));
  reverted = true;
  response = Promise.resolve({ ...successful, status: 'pending', confirmations: 0 });
  await act(async () => {
    await view.client.refetchQueries({ queryKey: ['ethereum-checkout', 'return', returnedCheckoutId] });
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
  });
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${sources[1].id}"]`)));
  assert.equal(view.queryByRole('button', { name: 'View Crate receipt #1' }), null);
  reverted = false;
  response = Promise.resolve(successful);
  await act(async () => { await view.client.refetchQueries({ queryKey: ['ethereum-checkout', 'return', returnedCheckoutId] }); });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'View Crate receipt #1' })));
});

test('checkout confirmation replaces an in-flight inventory read that predates the receipt hints', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  const initialInventory = deferred<EthereumInventoryResponse>();
  const fresh = deferred<EthereumCheckoutStatusResponse>();
  t.mock.method(checkoutApi, 'status', () => fresh.promise);
  const receipt = item('2000001', 'crate_receipt');
  const inventory = t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => {
    if (!expected.includes(receipt.tokenId)) return initialInventory.promise;
    return { items: [receipt], nextCursor: null, observedBlock: 11 };
  });
  const view = page({ checkoutReturnId: returnedCheckoutId });
  await waitFor(() => assert.equal(view.client.getQueryState(ethereumInventoryQueryKey(scope))?.fetchStatus, 'fetching'));
  await act(async () => { fresh.resolve(returnedCheckout({ status: 'success', confirmations: 3 })); });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'View Crate receipt #1' })));
  assert.ok(inventory.mock.callCount() >= 2);
  await act(async () => { initialInventory.resolve({ items: [], nextCursor: null, observedBlock: 10 }); });
  assert.ok(view.getByRole('button', { name: 'View Crate receipt #1' }));
});

for (const connected of [false, true]) test(`checkout receipt hints stay with their owner while ${connected ? 'another wallet is connected' : 'disconnected'}`, async t => {
  const otherOwner = '0x2222222222222222222222222222222222222222';
  const scope = ethereumInventoryScope(config, owner)!;
  const otherScope = ethereumInventoryScope(config, otherOwner)!;
  const otherContractScope = ethereumInventoryScope({ ...config, contractAddress: otherOwner }, owner)!;
  writeEthereumExpected(scope, ['88']);
  writeEthereumExpected(otherScope, ['99']);
  writeEthereumExpected(otherContractScope, ['77']);
  const fresh = deferred<EthereumCheckoutStatusResponse>();
  t.mock.method(checkoutApi, 'status', () => fresh.promise);
  const receipt = item('2000001', 'crate_receipt');
  const inventory = t.mock.method(ethereumApi, 'inventory', async (_config, requestedOwner, _cursor, _signal, expected = []) => ({
    items: requestedOwner === owner && expected.includes(receipt.tokenId) ? [receipt] : [], nextCursor: null, observedBlock: 10,
  }));
  const initialWallet: EthereumWallet = connected ? { ...wallet, address: otherOwner } :
    { ...wallet, address: null, provider: null, status: 'disconnected' };
  const view = page({ checkoutReturnId: returnedCheckoutId, wallet: initialWallet });
  if (connected) await waitFor(() => assert.equal(view.client.getQueryState(ethereumInventoryQueryKey(otherScope))?.fetchStatus, 'idle'));
  const beforeConfirmation = inventory.mock.callCount();
  await act(async () => { fresh.resolve(returnedCheckout({ status: 'success', confirmations: 3 })); });
  await waitFor(() => assert.deepEqual(readEthereumExpected(scope), ['88', '111112', '2000001']));
  assert.deepEqual(readEthereumExpected(otherScope), ['99']);
  assert.deepEqual(readEthereumExpected(otherContractScope), ['77']);
  assert.equal(inventory.mock.callCount(), beforeConfirmation);
  view.rerenderPage({ wallet });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'View Crate receipt #1' })));
});

test('checkout receipt hints honor the existing expected ID bound', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumExpected(scope, Array.from({ length: ETHEREUM_MAX_EXPECTED_IDS }, (_, index) => String(index + 1)));
  t.mock.method(checkoutApi, 'status', async () => returnedCheckout({ status: 'success', confirmations: 3 }));
  page({ checkoutReturnId: returnedCheckoutId });
  await waitFor(() => assert.equal(readEthereumExpected(scope).at(-1), '2000001'));
  assert.equal(readEthereumExpected(scope).length, ETHEREUM_MAX_EXPECTED_IDS);
});

async function selectCrate(view: ReturnType<typeof page>, tokenId = '111112') {
  const id = item(tokenId).id;
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${id}"]`)));
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${id}"]`)!);
  return view.getByRole('button', { name: 'Open crate' }) as HTMLButtonElement;
}

test('a returned redemption blocks opening its same crate before status loads and while pending, without blocking mint', async t => {
  const response = deferred<EthereumCheckoutStatusResponse>();
  t.mock.method(checkoutApi, 'status', () => response.promise);
  const sent: unknown[] = [];
  const connected: EthereumWallet = { ...wallet, provider: { request: async ({ method, params }) => {
    if (method === 'eth_sendTransaction') { sent.push(params); return `0x${'cd'.repeat(32)}`; }
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') return '0x8';
    return [owner];
  } } };
  const view = page({ checkoutReturnId: returnedCheckoutId, wallet: connected });
  const open = await selectCrate(view);
  assert.equal(open.disabled, true);
  assert.equal((view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement).disabled, false);
  await act(async () => { response.resolve(returnedCheckout()); });
  await waitFor(() => assert.ok(view.getByText(/Your redemption is pending/)));
  assert.equal(open.disabled, true);
  await act(async () => { fireEvent.click(open); });
  assert.equal(sent.length, 0);
});

for (const cachedState of ['ready', 'prepared'] as const) for (const outcome of ['pending', 'unavailable'] as const) {
  test(`cached ${cachedState} return cannot open a crate before a fresh ${outcome} result`, async t => {
    const fresh = deferred<EthereumCheckoutStatusResponse>();
    t.mock.method(checkoutApi, 'status', () => fresh.promise);
    let sends = 0;
    const connected: EthereumWallet = { ...wallet, provider: { request: async ({ method }) => {
      if (method === 'eth_sendTransaction') { sends++; return `0x${'cd'.repeat(32)}`; }
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_getTransactionCount') return '0x8';
      return [owner];
    } } };
    const cached = returnedCheckout({ status: cachedState, wallet: cachedState === 'ready' ? null : owner,
      orderId: cachedState === 'ready' ? null : 42, transactionHash: null, attempt: null });
    const view = page({ checkoutReturnId: returnedCheckoutId, wallet: connected }, client => client.setQueryData(
      ['ethereum-checkout', 'return', returnedCheckoutId], cached));
    const open = await selectCrate(view);
    assert.equal(checkoutReservesItems([item()]), false);
    assert.equal(open.disabled, true);
    await act(async () => { fireEvent.click(open); });
    assert.equal(sends, 0);
    await act(async () => {
      if (outcome === 'pending') fresh.resolve(returnedCheckout());
      else fresh.reject(new Error('Network unavailable'));
    });
    await waitFor(() => assert.ok(view.getByText(outcome === 'pending' ? /Your redemption is pending/ : /Couldn’t check your checkout/)));
    assert.equal(open.disabled, true);
    await act(async () => { fireEvent.click(open); });
    assert.equal(sends, 0);
    const scope = ethereumInventoryScope(config, owner)!;
    assert.equal(readEthereumPending(scope), null);
    assert.equal(readEthereumSubmission(scope), null);
  });
}

for (const reserved of [false, true]) test(`leaving a deleted draft return ${reserved ? 'preserves an independent reservation' : 'restores collection opening'}`, async t => {
  const pending = returnedCheckout({ checkoutId: '44444444-4444-4444-8444-444444444444' });
  t.mock.method(checkoutApi, 'status', async id => {
    if (id === pending.checkoutId) return pending;
    throw new CheckoutApiError(404, 'Checkout not found.', null, 'not-found');
  });
  if (reserved) rememberCheckoutReservation(pending);
  window.history.replaceState(null, '', `/111k_devnet?checkout_id=${returnedCheckoutId}&result=canceled`);
  const view = page({ checkoutReturnId: returnedCheckoutId });
  await waitFor(() => assert.ok(view.getByText('This checkout has expired or no longer exists.')));
  assert.equal((await selectCrate(view)).disabled, true);
  const link = view.getByRole('link', { name: 'Continue to collection' }) as HTMLAnchorElement;
  let destination: string | undefined;
  document.addEventListener('click', event => {
    assert.equal(event.defaultPrevented, false);
    event.preventDefault();
    destination = link.href;
  }, { once: true });
  fireEvent.click(link);
  assert.equal(destination, 'https://mons.shop/111k_devnet');
  window.history.replaceState(null, '', destination);
  view.unmount();
  const collection = page();
  assert.equal(window.location.search, '');
  assert.equal((await selectCrate(collection)).disabled, reserved);
  assert.equal(checkoutReservesItems([item()]), reserved);
});

for (const unrelated of ['token', 'wallet'] as const) test(`a pending checkout for another ${unrelated} does not block opening this crate`, async t => {
  t.mock.method(checkoutApi, 'status', async () => returnedCheckout(unrelated === 'token'
    ? { tokenIds: ['111113'], items: [item('111113')] }
    : { wallet: '0x2222222222222222222222222222222222222222' }));
  const view = page({ checkoutReturnId: returnedCheckoutId });
  await waitFor(() => assert.ok(view.getByText(/Your redemption is pending/)));
  const open = await selectCrate(view);
  assert.equal(open.disabled, false);
});

for (const discovered of ['matching', 'other token', 'other wallet', 'unknown return'] as const) {
  test(`opening rechecks checkout state discovered during wallet checks (${discovered})`, async t => {
    const nonce = deferred<string>();
    const status = deferred<EthereumCheckoutStatusResponse>();
    let requestedNonce = false;
    let sends = 0;
    const checkout = returnedCheckout(discovered === 'other token' ? { tokenIds: ['111113'], items: [item('111113')] } :
      discovered === 'other wallet' ? { wallet: '0x2222222222222222222222222222222222222222' } : {});
    t.mock.method(checkoutApi, 'status', () => discovered === 'unknown return' ? status.promise : Promise.resolve(checkout));
    t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] }));
    t.mock.method(wallet.provider!, 'request', async ({ method }) => {
      if (method === 'eth_sendTransaction') { sends++; return `0x${'cd'.repeat(32)}`; }
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_getTransactionCount') { requestedNonce = true; return nonce.promise; }
      if (method === 'eth_getTransactionByHash') return null;
      return [owner];
    });
    const view = page();
    const open = await selectCrate(view);
    await act(async () => { fireEvent.click(open); });
    await waitFor(() => assert.equal(requestedNonce, true));
    await act(async () => {
      if (discovered === 'unknown return') view.rerenderPage({ checkoutReturnId: returnedCheckoutId });
      else rememberCheckoutReservation(checkout);
      nonce.resolve('0x7');
    });
    if (discovered === 'matching' || discovered === 'unknown return') {
      await waitFor(() => assert.ok(view.getByText(/Check the redemption status/)));
      assert.equal(sends, 0);
      const scope = ethereumInventoryScope(config, owner)!;
      assert.equal(readEthereumPending(scope), null);
      assert.equal(readEthereumSubmission(scope), null);
    } else await waitFor(() => assert.equal(sends, 1));
  });
}

for (const terminal of ['success', 'failed'] as const) test(`a known pending reservation survives a fetch error and clears after ${terminal}`, async t => {
  let response: EthereumCheckoutStatusResponse | Error = returnedCheckout();
  t.mock.method(checkoutApi, 'status', async () => { if (response instanceof Error) throw response; return response; });
  const view = page({ checkoutReturnId: returnedCheckoutId });
  await waitFor(() => assert.ok(view.getByText(/Your redemption is pending/)));
  const open = await selectCrate(view);
  assert.equal(open.disabled, true);
  response = new Error('Network unavailable');
  await act(async () => { await view.client.refetchQueries({ queryKey: ['ethereum-checkout', 'return', returnedCheckoutId] }); });
  await waitFor(() => assert.ok(view.getByText(/Couldn’t check your checkout/)));
  assert.equal(open.disabled, true);
  assert.equal(checkoutReservesItems([item()]), true);
  response = returnedCheckout({ status: terminal, ...(terminal === 'failed'
    ? { attempt: { attemptId: returnedAttemptId, status: 'failed', transactionHash: `0x${'ab'.repeat(32)}` } }
    : { confirmations: 3 }) });
  await act(async () => { await view.client.refetchQueries({ queryKey: ['ethereum-checkout', 'return', returnedCheckoutId] }); });
  await waitFor(() => assert.equal(open.disabled, false));
  assert.equal(checkoutReservesItems([item()]), false);
});

test('pending checkout reservations survive ordinary Back and page remount without a return parameter', async t => {
  const response = returnedCheckout();
  t.mock.method(checkoutApi, 'status', async () => response);
  assert.equal(rememberCheckoutReservation(response), true);
  const first = page();
  assert.equal((await selectCrate(first)).disabled, true);
  first.unmount();
  const returned = page();
  assert.equal((await selectCrate(returned)).disabled, true);
  assert.equal(window.location.search, '');
});

test('cross-tab checkout storage events block an already selected crate and stale terminal cleanup cannot remove a new attempt', async t => {
  let response = returnedCheckout();
  t.mock.method(checkoutApi, 'status', async () => response);
  let sends = 0;
  t.mock.method(wallet.provider!, 'request', async ({ method }) => {
    if (method === 'eth_sendTransaction') { sends++; return `0x${'cd'.repeat(32)}`; }
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') return '0x8';
    return [owner];
  });
  const view = page();
  const open = await selectCrate(view);
  assert.equal(open.disabled, false);
  const revision = crypto.randomUUID();
  const key = `mons.shop.ethereum-checkout-reservation:${returnedCheckoutId}:${returnedAttemptId}:${revision}`;
  window.localStorage.setItem(key, JSON.stringify({ checkoutId: response.checkoutId, chainId: response.chainId,
    contractAddress: response.contractAddress, wallet: response.wallet, tokenIds: response.tokenIds, attemptId: returnedAttemptId, revision }));
  await act(async () => { fireEvent.click(open); });
  assert.equal(sends, 0);
  await act(async () => { window.dispatchEvent(new window.StorageEvent('storage', { key })); });
  await waitFor(() => assert.equal(open.disabled, true));
  const nextAttemptId = '33333333-3333-4333-8333-333333333333';
  response = returnedCheckout({ attempt: { attemptId: nextAttemptId, status: 'started', transactionHash: null } });
  await act(async () => {
    const observe = observeCheckoutReservation(returnedCheckoutId);
    rememberCheckoutReservation(response);
    observe(returnedCheckout({ status: 'failed' }));
  });
  assert.equal(checkoutReservesItems([item()]), true);
  assert.equal(open.disabled, true);
  assert.ok(Object.keys(window.localStorage).some(key => key.startsWith(`mons.shop.ethereum-checkout-reservation:${returnedCheckoutId}:${nextAttemptId}`)));
});

test('cached terminal reservation data cannot clear a restored pending checkout before a fresh read', async t => {
  const pending = returnedCheckout();
  const fresh = deferred<EthereumCheckoutStatusResponse>();
  let response = fresh.promise;
  t.mock.method(checkoutApi, 'status', () => response);
  rememberCheckoutReservation(pending);
  const view = page({}, client => client.setQueryData(
    ['ethereumCheckoutReservation', returnedCheckoutId, returnedAttemptId], returnedCheckout({ status: 'failed' })));
  const open = await selectCrate(view);
  assert.equal(open.disabled, true);
  assert.equal(checkoutReservesItems([item()]), true);
  await act(async () => { fresh.resolve(pending); });
  assert.equal(checkoutReservesItems([item()]), true);
  response = Promise.resolve(returnedCheckout({ status: 'failed' }));
  await act(async () => { await view.client.refetchQueries({ queryKey: ['ethereumCheckoutReservation', returnedCheckoutId] }); });
  await waitFor(() => assert.equal(open.disabled, false));
  assert.equal(checkoutReservesItems([item()]), false);
});

test('a delayed terminal read cannot clear the same attempt restored while its observer remains mounted', async t => {
  const reads: ReturnType<typeof deferred<EthereumCheckoutStatusResponse>>[] = [];
  t.mock.method(checkoutApi, 'status', () => {
    const read = deferred<EthereumCheckoutStatusResponse>();
    reads.push(read);
    return read.promise;
  });
  const pending = returnedCheckout();
  rememberCheckoutReservation(pending);
  const view = page();
  const open = await selectCrate(view);
  await waitFor(() => assert.equal(reads.length, 1));
  await act(async () => {
    observeCheckoutReservation(returnedCheckoutId)(returnedCheckout({ status: 'failed' }));
    rememberCheckoutReservation(pending);
  });
  await act(async () => { reads[0].resolve(returnedCheckout({ status: 'failed' })); });
  assert.equal(checkoutReservesItems([item()]), true);
  assert.equal(open.disabled, true);
  let refetch!: Promise<void>;
  await act(async () => { refetch = view.client.refetchQueries({ queryKey: ['ethereumCheckoutReservation', returnedCheckoutId] }); });
  await waitFor(() => assert.equal(reads.length, 2));
  await act(async () => { reads[1].resolve(pending); await refetch; });
  assert.equal(checkoutReservesItems([item()]), true);
  assert.equal(open.disabled, true);
});

test('a newer live pending observation prevents an older terminal read from clearing its reservation', async t => {
  const fresh = deferred<EthereumCheckoutStatusResponse>();
  const newer = deferred<EthereumCheckoutStatusResponse>();
  t.mock.method(checkoutApi, 'status', () => fresh.promise);
  const pending = returnedCheckout();
  rememberCheckoutReservation(pending);
  const view = page();
  const open = await selectCrate(view);
  const observed = newer.promise.then(observeCheckoutReservation(returnedCheckoutId));
  await act(async () => { newer.resolve(pending); await observed; });
  await act(async () => { fresh.resolve(returnedCheckout({ status: 'failed' })); });
  assert.equal(checkoutReservesItems([item()]), true);
  assert.equal(open.disabled, true);
});

test('crate discounts reuse the existing button state and use public pricing above the remaining allowance', async t => {
  const discount = stats({ discountMerkleRoot: `0x${'12'.repeat(32)}` });
  t.mock.method(ethereumApi, 'stats', async () => discount);
  t.mock.method(ethereumDiscounts, 'proof', async () => []);
  const view = page();
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Mint with discount for 0.00005 ETH. Regular price 0.0001 ETH.' })));
  assert.ok(view.container.querySelector('.mint-panel__submit--discounted'));
  assert.equal(view.container.querySelector('.mint-panel__submit-price-old')?.textContent, '0.0001');
  fireEvent.change(view.getByRole('slider', { name: 'Mint quantity' }), { target: { value: '2' } });
  assert.ok(view.getByRole('button', { name: /Mint\s*2 crates.*0.0002 ETH/ }));
  assert.equal(view.container.querySelector('.mint-panel__submit--discounted'), null);
  act(() => view.client.setQueryData(['ethereum111k', 'stats', config.chainId, contract, owner], { ...discount, discountAllowance: 3 }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Mint with discount for 0.0001 ETH. Regular price 0.0002 ETH.' })));
  fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
  assert.ok(view.getByRole('button', { name: /Mint\s*2 warehouses.*0.0022 ETH/ }));
  assert.equal(view.container.querySelector('.mint-panel__submit--discounted'), null);
  fireEvent.click(view.getByRole('radio', { name: 'Crate' }));
  act(() => view.client.setQueryData(['ethereum111k', 'stats', config.chainId, contract, owner], { ...discount, discountUsed: 1 }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: /Mint\s*2 crates.*0.0002 ETH/ })));
  assert.equal(view.container.querySelector('.mint-panel__submit--discounted'), null);
});

async function delayedMintPage(t: TestContext, status: 'connected' | 'disconnected' | 'restoring' = 'connected') {
  const configuration = deferred<typeof config>();
  const availability = deferred<EthereumStats>();
  t.mock.method(ethereumApi, 'config', () => configuration.promise);
  t.mock.method(ethereumApi, 'stats', () => availability.promise);
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] }));
  const transactions: Array<{ to: string; data: string; value: string }> = [];
  const messages: string[] = [];
  const calls = { connect: 0, cancel: 0 };
  let updateWallet = (_wallet: EthereumWallet) => {};
  const disconnected: EthereumWallet = { ...wallet, address: null, provider: null, status: 'disconnected',
    connect() { calls.connect++; updateWallet({ ...disconnected, status: 'connecting' }); },
    cancel() { calls.cancel++; updateWallet(disconnected); } };
  const connected: EthereumWallet = { ...wallet, provider: { request: async ({ method, params }) => {
    if (method === 'eth_sendTransaction') {
      transactions.push((params as typeof transactions)[0]);
      return `0x${'ab'.repeat(32)}`;
    }
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_getTransactionByHash') return null;
    return [owner];
  } } };
  let view!: ReturnType<typeof page>;
  await act(async () => {
    view = page({
      wallet: status === 'connected' ? connected : { ...disconnected, status, ready: status !== 'restoring' },
      showToast: message => messages.push(message),
    });
  });
  updateWallet = next => view.rerenderPage({ wallet: next });
  return { ...view, configuration, availability, disconnected, connected, transactions, messages, calls };
}

test('connect-and-mint waits for the connected wallet discount proof before sending its discounted crate', async t => {
  const proof = deferred<string[] | null>();
  t.mock.method(ethereumDiscounts, 'proof', () => proof.promise);
  const view = await delayedMintPage(t, 'disconnected');
  await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint\s*1 crate/ })); });
  await act(async () => {
    view.configuration.resolve(config);
    view.availability.resolve(stats({ discountMerkleRoot: `0x${'12'.repeat(32)}` }));
    view.rerenderPage({ wallet: view.connected });
  });
  await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'stats', config.chainId, contract, owner])?.status, 'success'));
  assert.equal(view.transactions.length, 0);
  assert.equal((view.getByRole('button', { name: 'Minting…' }) as HTMLButtonElement).disabled, true);
  await act(async () => { proof.resolve([]); });
  await waitFor(() => assert.equal(view.transactions.length, 1));
  assert.equal(view.transactions[0].data, encodeCall(ETHEREUM_FUNCTIONS.mintCratesDiscounted, ['uint256', 'bytes32[]'], [1, []]));
  assert.equal(BigInt(view.transactions[0].value), 50_000_000_000_000n);
});

for (const change of [
  { name: 'public price', stats: { cratePriceWei: '200000000000000' }, proof: null, payment: 200_000_000_000_000n },
  { name: 'discount price', stats: { discountCratePriceWei: '80000000000000' }, proof: [], payment: 80_000_000_000_000n },
  { name: 'discount root', stats: { discountMerkleRoot: `0x${'34'.repeat(32)}` }, proof: [], payment: 50_000_000_000_000n },
] satisfies { name: string; stats: Partial<EthereumStats>; proof: string[] | null; payment: bigint }[]) {
  test(`a ${change.name} change while eligibility loads requires another Mint click`, async t => {
    const proof = deferred<string[] | null>();
    t.mock.method(ethereumDiscounts, 'proof', () => proof.promise);
    const view = await delayedMintPage(t);
    let current = stats({ discountMerkleRoot: `0x${'12'.repeat(32)}` });
    t.mock.method(ethereumApi, 'stats', async () => current);
    await act(async () => { view.configuration.resolve(config); view.availability.resolve(current); });
    await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'stats', config.chainId, contract, owner])?.status, 'success'));
    fireEvent.click(view.getByRole('button', { name: /Mint\s*1 crate.*0.0001 ETH/ }));
    assert.equal(view.transactions.length, 0);
    current = { ...current, ...change.stats };
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'stats'] }); });
    await waitFor(() => assert.ok(view.messages.includes('Your mint terms changed. Check the updated price and try again.')));
    await act(async () => { proof.resolve(change.proof); });
    assert.equal(view.transactions.length, 0);
    const button = view.container.querySelector<HTMLButtonElement>('.mint-panel button[type="submit"]')!;
    await waitFor(() => assert.equal(button.disabled, false));
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => assert.equal(view.transactions.length, 1));
    assert.equal(BigInt(view.transactions[0].value), change.payment);
  });
}

test('a failed discount proof blocks crate minting while warehouses remain available at their public price', async t => {
  t.mock.method(ethereumDiscounts, 'proof', async () => { throw new Error('Wrong discount root'); });
  const view = await delayedMintPage(t);
  await act(async () => {
    view.configuration.resolve(config);
    view.availability.resolve(stats({ discountMerkleRoot: `0x${'12'.repeat(32)}` }));
  });
  await waitFor(() => assert.ok(view.getByRole('alert').textContent?.includes('Couldn’t check your mint discount.')));
  const button = view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  fireEvent.click(button);
  assert.equal(view.transactions.length, 0);
  fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint\s*1 warehouse/ })); });
  await waitFor(() => assert.equal(view.transactions.length, 1));
  assert.equal(view.transactions[0].data, encodeCall(ETHEREUM_FUNCTIONS.mintWarehouses, ['uint256'], [1]));
  assert.equal(BigInt(view.transactions[0].value), BigInt(config.warehousePriceWei));
});

test('an exhausted allowance clears a prior proof error and restores public crate minting', async t => {
  const discount = stats({ discountMerkleRoot: `0x${'12'.repeat(32)}` });
  t.mock.method(ethereumDiscounts, 'proof', async () => { throw new Error('Wrong discount root'); });
  const view = await delayedMintPage(t);
  await act(async () => {
    view.configuration.resolve(config);
    view.availability.resolve(discount);
  });
  await waitFor(() => assert.ok(view.getByRole('alert').textContent?.includes('Couldn’t check your mint discount.')));
  const exhausted = { ...discount, discountUsed: 1 };
  t.mock.method(ethereumApi, 'stats', async () => exhausted);
  act(() => view.client.setQueryData(['ethereum111k', 'stats', config.chainId, contract, owner], exhausted));
  await waitFor(() => assert.equal(view.queryAllByRole('alert').length, 0));
  const button = view.getByRole('button', { name: /Mint\s*1 crate.*0.0001 ETH/ }) as HTMLButtonElement;
  assert.equal(button.disabled, false);
  await act(async () => { fireEvent.click(button); });
  await waitFor(() => assert.equal(view.transactions.length, 1));
  assert.equal(view.transactions[0].data, encodeCall(ETHEREUM_FUNCTIONS.mintCrates, ['uint256'], [1]));
  assert.equal(BigInt(view.transactions[0].value), BigInt(config.cratePriceWei));
});

test('the mint panel shares the drop frame and previews the selected crate quantity', async () => {
  const view = page({ header: createElement('header', {}, 'Shop header') });
  const crateImage = view.getByRole('img', { name: '111K crate' });
  assert.equal(crateImage.getAttribute('src'), 'https://wip.lil.org/111k/crate_clean.webp');
  assert.equal(crateImage.getAttribute('width'), '1218');
  assert.equal(crateImage.getAttribute('height'), '833');
  const previewStyle = (view.container.querySelector('.mint-panel__boxes') as HTMLElement).style;
  assert.equal(previewStyle.getPropertyValue('--box-width'), `${Math.floor(120 * 1218 / 833)}px`);
  assert.equal(previewStyle.getPropertyValue('--box-height'), '120px');
  await waitFor(() => assert.match(view.container.querySelector('.mint-panel')!.textContent!, /5555\s*\/\s*5555 left/));
  const frame = view.container.querySelector('.drop-page-frame--active')!;
  assert.ok(frame.contains(view.getByText('Shop header')));
  assert.ok(frame.contains(view.getByText('111K')));
  assert.ok(frame.contains(view.container.querySelector('.mint-panel')));
  const quantity = view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement;
  assert.equal(quantity.max, '15');
  fireEvent.change(quantity, { target: { value: '3' } });
  assert.equal(view.getAllByRole('img', { name: '111K crate' }).length, 3);
  assert.ok(view.getByRole('button', { name: /Mint\s*3 crates.*0.0003 ETH/ }));
  fireEvent.change(quantity, { target: { value: '15' } });
  assert.ok(view.getByRole('button', { name: /Mint\s*15 crates.*0.0015 ETH/ }));
  assert.equal(view.getAllByRole('img', { name: '111K crate' }).length, 15);
  fireEvent.change(quantity, { target: { value: '1' } });
  assert.equal(view.getAllByRole('img', { name: '111K crate' }).length, 1);
  assert.equal(view.getByRole('img', { name: '111K crate' }), crateImage);
  assert.equal(view.queryByRole('img', { name: '111K warehouse' }), null);
  assert.equal(view.getByRole('group', { name: 'Container type' }).querySelectorAll('input[type="radio"]').length, 3);
  assert.equal((view.getByRole('radio', { name: 'Crate' }) as HTMLInputElement).checked, true);
  assert.equal((view.getByRole('radio', { name: 'Warehouse' }) as HTMLInputElement).checked, false);
  assert.equal(view.queryByRole('button', { name: /Connect Ethereum|Disconnect Ethereum/ }), null);
  assert.equal(view.queryByText('A crate of 20 artworks. Crate #5555 holds 31.'), null);
  assert.equal(view.queryByText('Testnet only. Test ETH; no physical shipments.'), null);
  assert.equal(view.container.querySelector('.ethereum111k__edition'), null);
});

test('mint quantity follows the transaction maximum and clamps when available supply falls', async t => {
  t.mock.method(ethereumApi, 'config', async () => ({ ...config, maxMintQuantity: 4 }));
  const view = page();
  const quantity = view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement;
  await waitFor(() => assert.equal(quantity.max, '4'));
  fireEvent.change(quantity, { target: { value: '4' } });
  assert.ok(view.getByRole('button', { name: /Mint\s*4 crates.*0.0004 ETH/ }));
  act(() => view.client.setQueryData(['ethereum111k', 'stats', config.chainId, config.contractAddress, owner], stats({ remainingCrates: 2 })));
  await waitFor(() => assert.equal(quantity.value, '2'));
  assert.equal(quantity.max, '2');
  assert.ok(view.getByRole('button', { name: /Mint\s*2 crates.*0.0002 ETH/ }));
});

test('switching containers preserves quantity unless it exceeds the available supply', async t => {
  t.mock.method(ethereumApi, 'stats', async () => stats({
    allocatedCrates: 5543, remainingCrates: 12, warehousesMinted: 502, remainingWarehouses: 3,
  }));
  const view = page();
  const quantity = view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement;
  await waitFor(() => assert.equal(quantity.max, '12'));
  assert.match(view.container.querySelector('.mint-panel')!.textContent!, /12\s*\/\s*5555 left/);
  fireEvent.change(quantity, { target: { value: '2' } });
  fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
  assert.equal(quantity.value, '2');
  assert.equal(quantity.max, '3');
  assert.equal(view.queryByRole('img', { name: '111K crate' }), null);
  assert.equal(view.getAllByRole('img', { name: '111K warehouse' }).length, 2);
  const warehouseImage = view.getAllByRole('img', { name: '111K warehouse' })[0];
  assert.equal(warehouseImage.getAttribute('src'), 'https://wip.lil.org/111k/warehouse_clean.webp');
  assert.equal(warehouseImage.getAttribute('width'), '1254');
  assert.equal(warehouseImage.getAttribute('height'), '1104');
  const previewStyle = (view.container.querySelector('.mint-panel__boxes') as HTMLElement).style;
  assert.equal(previewStyle.getPropertyValue('--box-width'), `${Math.floor(120 * 1254 / 1104)}px`);
  assert.equal(previewStyle.getPropertyValue('--box-height'), '120px');
  assert.match(view.container.querySelector('.mint-panel')!.textContent!, /3\s*\/\s*505 left/);
  assert.ok(view.getByRole('button', { name: /Mint\s*2 warehouses.*0.0022 ETH/ }));
  fireEvent.click(view.getByRole('radio', { name: 'Crate' }));
  assert.equal(quantity.value, '2');
  fireEvent.change(quantity, { target: { value: '4' } });
  fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
  assert.equal(quantity.value, '3');
  assert.equal(view.getAllByRole('img', { name: '111K warehouse' }).length, 3);
  assert.ok(view.getByRole('button', { name: /Mint\s*3 warehouses.*0.0033 ETH/ }));
  act(() => view.client.setQueryData(['ethereum111k', 'stats', config.chainId, config.contractAddress, owner], stats({
    allocatedCrates: 5543, remainingCrates: 12, warehousesMinted: 503, remainingWarehouses: 2,
  })));
  await waitFor(() => assert.equal(quantity.value, '2'));
  assert.equal(quantity.max, '2');
  assert.match(view.container.querySelector('.mint-panel')!.textContent!, /2\s*\/\s*505 left/);
  fireEvent.click(view.getByRole('radio', { name: 'Crate' }));
  assert.equal(quantity.value, '2');
  assert.equal(quantity.max, '12');
  assert.equal(view.queryByRole('img', { name: '111K warehouse' }), null);
  assert.equal(view.getAllByRole('img', { name: '111K crate' }).length, 2);
  assert.ok(view.getByRole('button', { name: /Mint\s*2 crates.*0.0002 ETH/ }));
});

test('a sold-out container does not block switching to one still available', async t => {
  t.mock.method(ethereumApi, 'stats', async () => stats({ allocatedCrates: 5545, remainingCrates: 10, remainingWarehouses: 0 }));
  const view = page();
  await waitFor(() => assert.match(view.container.querySelector('.mint-panel')!.textContent!, /10\s*\/\s*5555 left/));
  fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
  assert.match(view.container.querySelector('.mint-panel')!.textContent!, /0\s*\/\s*505 left/);
  assert.equal((view.getByRole('button', { name: /Mint.*0.0011 ETH/ }) as HTMLButtonElement).disabled, true);
  const crate = view.getByRole('radio', { name: 'Crate' });
  assert.equal(crate.matches(':disabled'), false);
  fireEvent.click(crate);
  assert.equal((view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement).disabled, false);
  assert.equal((view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement).max, '10');
});

test('external actions and suspension disable container selection but a paused sale does not', async t => {
  t.mock.method(ethereumApi, 'stats', async () => stats({ saleActive: false }));
  const view = page();
  await waitFor(() => assert.ok(view.getByText('Minting is paused')));
  const warehouse = view.getByRole('radio', { name: 'Warehouse' });
  assert.equal(warehouse.matches(':disabled'), false);
  assert.equal((view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement).disabled, false);
  fireEvent.click(warehouse);
  assert.equal((warehouse as HTMLInputElement).checked, true);
  assert.equal((view.getByRole('button', { name: /Mint\s*1 warehouse/ }) as HTMLButtonElement).disabled, true);
  view.rerenderPage({ externalBusy: true });
  assert.ok(view.getAllByRole('radio').every(input => input.matches(':disabled')));
  view.rerenderPage({ externalBusy: false, suspended: true });
  assert.ok(view.getAllByRole('radio').every(input => input.matches(':disabled')));
  view.rerenderPage({ suspended: false });
  assert.ok(view.getAllByRole('radio').every(input => !input.matches(':disabled')));
});

for (const kind of ['crate', 'warehouse', 'monument'] as const) test(`disconnected mint connects once and submits the captured ${kind} quantity with exact wei pricing`, async t => {
  const unitPriceWei = '123456789012345678';
  t.mock.method(ethereumApi, 'stats', async () => stats({ [`${kind}PriceWei`]: unitPriceWei }));
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] }));
  const transactions: Array<{ data: string; value: string }> = [];
  let connections = 0;
  let startConnecting = () => {};
  const disconnected: EthereumWallet = { ...wallet, address: null, provider: null, status: 'disconnected',
    connect() { connections++; startConnecting(); } };
  const connected: EthereumWallet = { ...wallet, provider: { request: async ({ method, params }) => {
    if (method === 'eth_sendTransaction') {
      transactions.push((params as Array<{ data: string; value: string }>)[0]);
      return `0x${'ab'.repeat(32)}`;
    }
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_getTransactionByHash') return null;
    return [owner];
  } } };
  const view = page({ wallet: disconnected });
  startConnecting = () => view.rerenderPage({ wallet: { ...disconnected, status: 'connecting' } });
  if (kind !== 'crate') fireEvent.click(view.getByRole('radio', { name: kind === 'warehouse' ? 'Warehouse' : 'Monument' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: new RegExp(`Mint\\s*1 ${kind}.*0.123456 ETH`) })));
  fireEvent.change(view.getByRole('slider', { name: 'Mint quantity' }), { target: { value: '3' } });
  const mintButton = view.getByRole('button', { name: new RegExp(`Mint\\s*3 ${kind === 'monument' ? 'monuments' : `${kind}s`}.*0.37037 ETH`) }) as HTMLButtonElement;
  fireEvent.click(mintButton);
  fireEvent.click(mintButton);
  assert.equal(connections, 1);
  assert.equal(mintButton.disabled, true);
  assert.ok(view.getAllByRole('radio').every(input => input.matches(':disabled')));
  assert.equal(transactions.length, 0);
  view.rerenderPage({ wallet: connected });
  await waitFor(() => assert.equal(transactions.length, 1));
  assert.equal(transactions[0].data, encodeCall({ crate: ETHEREUM_FUNCTIONS.mintCrates, warehouse: ETHEREUM_FUNCTIONS.mintWarehouses, monument: ETHEREUM_FUNCTIONS.mintMonuments }[kind], ['uint256'], [3]));
  assert.equal(transactions[0].value, `0x${(BigInt(unitPriceWei) * 3n).toString(16)}`);
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Transaction changed?' })));
  assert.ok(view.getAllByRole('radio').every(input => input.matches(':disabled')));
  view.rerenderPage({ wallet: { ...connected } });
  await act(async () => { await Promise.resolve(); });
  assert.equal(transactions.length, 1);
});

for (const status of ['connected', 'disconnected', 'restoring'] as const) {
  test(`an early Mint with a ${status} wallet waits for actual configuration and availability`, async t => {
    const view = await delayedMintPage(t, status);
    const kind = status === 'disconnected' ? 'warehouse' : 'crate';
    if (kind !== 'crate') fireEvent.click(view.getByRole('radio', { name: kind === 'warehouse' ? 'Warehouse' : 'Monument' }));
    const quantity = view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement;
    assert.equal(quantity.disabled, false);
    assert.equal(quantity.max, '15');
    fireEvent.change(quantity, { target: { value: '3' } });
    const fallbackPrice = kind === 'crate' ? '0.0003' : '0.0033';
    const mintButton = view.getByRole('button', { name: new RegExp(`Mint\\s*3 ${kind}s.*${fallbackPrice} ETH`) }) as HTMLButtonElement;
    assert.equal(mintButton.disabled, false);
    fireEvent.click(mintButton);
    fireEvent.click(mintButton);
    assert.equal(mintButton.disabled, true);
    assert.equal(quantity.disabled, true);
    assert.ok(view.getAllByRole('radio').every(input => input.matches(':disabled')));
    assert.equal(view.calls.connect, status === 'disconnected' ? 1 : 0);
    assert.equal(view.transactions.length, 0);
    if (status === 'disconnected') view.rerenderPage({ wallet: view.connected });
    await act(async () => { view.configuration.resolve(config); });
    await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'config'])?.status, 'success'));
    assert.equal(view.transactions.length, 0);
    const unitPriceWei = '234567890123456789';
    await act(async () => { view.availability.resolve(stats({
      [`${kind}PriceWei`]: unitPriceWei,
    })); });
    if (status === 'restoring') {
      await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'stats', config.chainId, config.contractAddress, null])?.status, 'success'));
      assert.equal(view.transactions.length, 0);
      view.rerenderPage({ wallet: view.connected });
    }
    await waitFor(() => assert.equal(view.transactions.length, 1));
    assert.equal(view.transactions[0].to, contract);
    assert.equal(view.transactions[0].data, encodeCall({ crate: ETHEREUM_FUNCTIONS.mintCrates, warehouse: ETHEREUM_FUNCTIONS.mintWarehouses, monument: ETHEREUM_FUNCTIONS.mintMonuments }[kind], ['uint256'], [3]));
    assert.equal(view.transactions[0].value, `0x${(BigInt(unitPriceWei) * 3n).toString(16)}`);
    await waitFor(() => assert.ok(view.getByRole('button', { name: 'Transaction changed?' })));
    assert.equal(view.transactions.length, 1);
  });
}

for (const source of ['configuration', 'availability'] as const) {
  test(`a failed ${source} read releases the early mint and clears its error after recovery`, async t => {
    const view = await delayedMintPage(t);
    await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint\s*1 crate/ })); });
    if (source === 'availability') {
      await act(async () => { view.configuration.resolve(config); });
      await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'stats', config.chainId, config.contractAddress, owner])?.fetchStatus, 'fetching'));
    }
    await act(async () => { view[source].reject(new Error('Network unavailable')); });
    const message = source === 'configuration' ? 'Couldn’t load this drop. Please try again.' : 'Couldn’t load availability. Please try again.';
    await waitFor(() => assert.deepEqual(view.messages, [message]));
    assert.equal((view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement).disabled, false);
    assert.ok(view.getAllByRole('radio').every(input => !input.matches(':disabled')));
    assert.equal(view.transactions.length, 0);
    await act(async () => { view.rerenderPage({ wallet: { ...view.connected } }); });
    assert.deepEqual(view.messages, [message]);
    if (source === 'configuration') {
      t.mock.method(ethereumApi, 'config', async () => config);
      await act(async () => { view.availability.resolve(stats()); fireEvent.click(view.getByRole('button', { name: 'Retry' })); });
    } else {
      t.mock.method(ethereumApi, 'stats', async () => stats());
      await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'stats'] }); });
    }
    await waitFor(() => assert.match(view.container.querySelector('.mint-panel')!.textContent!, /5555\s*\/\s*5555 left/));
    await waitFor(() => assert.equal(view.queryAllByRole('alert').length, 0));
    assert.equal((view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement).disabled, false);
    assert.equal(view.transactions.length, 0);
  });
}

test('a restored pending transaction reports its confirmation failure after configuration retry', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash: `0x${'cd'.repeat(32)}`, action: 'mint', submittedAt: Date.now() });
  const view = await delayedMintPage(t);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint\s*1 crate/ })); });
  await act(async () => { view.configuration.reject(new Error('Network unavailable')); });
  const loadingError = 'Couldn’t load this drop. Please try again.';
  await waitFor(() => assert.deepEqual(view.messages, [loadingError]));
  const confirmationError = 'Couldn’t confirm the saved transaction.';
  t.mock.method(ethereumApi, 'config', async () => config);
  t.mock.method(ethereumApi, 'confirm', async () => { throw new Error(confirmationError); });
  await act(async () => { view.availability.resolve(stats()); fireEvent.click(view.getByRole('button', { name: 'Retry' })); });
  await waitFor(() => assert.ok(view.messages.includes(confirmationError)));
  assert.ok(view.getAllByRole('alert').some(alert => alert.textContent?.includes(confirmationError)));
  assert.ok(view.getAllByRole('alert').every(alert => !alert.textContent?.includes(loadingError)));
  assert.ok(view.getByRole('button', { name: 'Transaction changed?' }));
  assert.equal(view.transactions.length, 0);
});

test('a queued mint blocks newly loaded inventory actions until it fails', async t => {
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [item(), item('2000001', 'crate_receipt')], nextCursor: null, observedBlock: 10 }));
  const view = await delayedMintPage(t);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint\s*1 crate/ })); });
  await act(async () => { view.configuration.resolve(config); });
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${item().id}"]`)));
  const crate = view.container.querySelector(`[data-inventory-id="${item().id}"]`)!;
  fireEvent.click(crate);
  assert.equal(crate.getAttribute('aria-pressed'), 'false');
  assert.equal(view.queryByRole('button', { name: 'Send' }), null);
  fireEvent.click(view.getByRole('button', { name: 'View Crate receipt #1' }));
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal((view.getByRole('button', { name: 'Sign in with Ethereum to see shipments' }) as HTMLButtonElement).disabled, true);
  await act(async () => { view.availability.resolve(stats({ saleActive: false })); });
  await waitFor(() => assert.deepEqual(view.messages, ['Minting is paused.']));
  fireEvent.click(crate);
  assert.equal(crate.getAttribute('aria-pressed'), 'true');
  fireEvent.click(view.getByRole('button', { name: 'Send' }));
  assert.equal(window.location.pathname, '/checkout');
  assert.equal(window.location.search, '?drop=111k_devnet&ids=111112');
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(view.transactions.length, 0);
});

test('a queued mint disables existing selection actions and cancellation restores checkout navigation', async t => {
  const view = await delayedMintPage(t);
  await act(async () => { view.configuration.resolve(config); });
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${item().id}"]`)));
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${item().id}"]`)!);
  const send = view.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
  assert.equal(send.disabled, false);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint\s*1 crate/ })); });
  for (const name of ['Send', 'View', 'Open crate']) {
    const action = view.getByRole('button', { name }) as HTMLButtonElement;
    assert.equal(action.disabled, true);
    fireEvent.click(action);
  }
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(window.location.pathname, '/111k_devnet');
  await act(async () => { window.dispatchEvent(new window.Event('pagehide')); });
  assert.equal(send.disabled, false);
  fireEvent.click(send);
  assert.equal(window.location.pathname, '/checkout');
  assert.equal(window.location.search, '?drop=111k_devnet&ids=111112');
  await act(async () => { view.availability.resolve(stats()); });
  await waitFor(() => assert.match(view.container.querySelector('.mint-panel')!.textContent!, /5555\s*\/\s*5555 left/));
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(view.transactions.length, 0);
});

test('a claim link waits for a queued mint to be cancelled before opening its form', async t => {
  const receipt = item('2000001', 'crate_receipt');
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [receipt], nextCursor: null, observedBlock: 10 }));
  const view = await delayedMintPage(t);
  view.rerenderPage({ claimReceiptId: receipt.tokenId, claimCode: 'ABCDEF123456' });
  await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint\s*1 crate/ })); });
  await act(async () => { view.configuration.resolve(config); });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'View Crate receipt #1' })));
  assert.equal(view.queryByRole('dialog'), null);
  await act(async () => { window.dispatchEvent(new window.Event('pagehide')); });
  await waitFor(() => assert.ok(view.getByRole('dialog', { name: 'Crate receipt #1' })));
  assert.equal((view.getByLabelText('Crate claim code') as HTMLInputElement).value, 'ABCDEF123456');
  await act(async () => { view.availability.resolve(stats()); });
  await waitFor(() => assert.match(view.container.querySelector('.mint-panel')!.textContent!, /5555\s*\/\s*5555 left/));
  assert.ok(view.getByRole('dialog', { name: 'Crate receipt #1' }));
  assert.equal((view.getByLabelText('Crate claim code') as HTMLInputElement).value, 'ABCDEF123456');
  assert.equal(view.transactions.length, 0);
});

for (const result of [
  { name: 'paused', data: stats({ saleActive: false }), message: 'Minting is paused.' },
  { name: 'sold out', data: stats({ remainingCrates: 0, remainingWarehouses: 0 }), message: 'Crates are sold out.' },
  { name: 'too little stock', data: stats({ remainingCrates: 2, remainingWarehouses: 0 }), message: 'That quantity is no longer available. Choose fewer crates.' },
] as const) {
  test(`an early Mint does not submit when loading reveals ${result.name}`, async t => {
    const view = await delayedMintPage(t);
    await act(async () => { fireEvent.change(view.getByRole('slider', { name: 'Mint quantity' }), { target: { value: '4' } }); });
    await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint\s*4 crates/ })); });
    await act(async () => { view.configuration.resolve(config); view.availability.resolve(result.data); });
    await waitFor(() => assert.deepEqual(view.messages, [result.message]));
    await act(async () => { await Promise.resolve(); });
    assert.equal(view.transactions.length, 0);
    assert.ok(view.getAllByRole('radio').every(input => !input.matches(':disabled')));
    if (result.name === 'too little stock') assert.equal((view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement).value, '2');
  });
}

for (const failure of [
  { method: 'eth_getTransactionCount', error: new Error('Unable to open crate'), message: 'Unable to open crate' },
  { method: 'eth_sendTransaction', error: Object.assign(new Error('Rejected'), { code: 4001 }), message: 'Request cancelled in your wallet.' },
] as const) {
  test(`a crate opening failure at ${failure.method} replaces the earlier mint error in alerts and toasts`, async t => {
    const view = await delayedMintPage(t);
    await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint\s*1 crate/ })); });
    await act(async () => { view.configuration.resolve(config); view.availability.resolve(stats({ saleActive: false })); });
    await waitFor(() => assert.deepEqual(view.messages, ['Minting is paused.']));
    await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${item().id}"]`)));
    const provider = view.connected.provider!;
    const request = provider.request.bind(provider);
    t.mock.method(provider, 'request', async input => {
      if (input.method === failure.method) throw failure.error;
      return request(input);
    });
    fireEvent.click(view.container.querySelector(`[data-inventory-id="${item().id}"]`)!);
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Open crate' })); });
    await waitFor(() => assert.deepEqual(view.messages, ['Minting is paused.', failure.message]));
    assert.ok(view.getAllByRole('alert').some(alert => alert.textContent?.includes(failure.message)));
    assert.ok(view.getAllByRole('alert').every(alert => !alert.textContent?.includes('Minting is paused.')));
  });
}

for (const ending of ['wallet cancellation', 'suspension'] as const) {
  test(`${ending} clears an early Mint before late data and wallet results arrive`, async t => {
    const view = await delayedMintPage(t, 'disconnected');
    await act(async () => { fireEvent.click(view.getByRole('button', { name: /Mint\s*1 crate/ })); });
    assert.equal(view.calls.connect, 1);
    await act(async () => {
      if (ending === 'wallet cancellation') view.rerenderPage({ wallet: { ...view.disconnected, error: 'Wallet connection was cancelled.' } });
      else view.rerenderPage({ suspended: true });
    });
    await act(async () => { view.rerenderPage({ wallet: view.connected, suspended: false }); });
    await act(async () => { view.configuration.resolve(config); });
    await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'stats', config.chainId, config.contractAddress, owner])?.fetchStatus, 'fetching'));
    await act(async () => { view.availability.resolve(stats()); });
    await waitFor(() => assert.match(view.container.querySelector('.mint-panel')!.textContent!, /5555\s*\/\s*5555 left/));
    assert.equal((view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement).disabled, false);
    assert.equal(view.transactions.length, 0);
  });
}

test('a disconnected claim link connects within its claim dialog without initiating a mint', async t => {
  const receipt = item('2000001', 'crate_receipt');
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [receipt], nextCursor: null, observedBlock: 10 }));
  let connections = 0;
  let transactions = 0;
  const disconnected: EthereumWallet = { ...wallet, address: null, provider: null, status: 'disconnected', connect() { connections++; } };
  const connected: EthereumWallet = { ...wallet, provider: { request: async ({ method }) => {
    if (method === 'eth_sendTransaction') { transactions++; return `0x${'ab'.repeat(32)}`; }
    if (method === 'eth_chainId') return '0xaa36a7';
    return [owner];
  } } };
  const modalChanges: boolean[] = [];
  const view = page({ wallet: disconnected, claimReceiptId: receipt.tokenId, claimCode: 'ABCDEF123456',
    onModalOpenChange: open => modalChanges.push(open) });
  assert.ok(view.getByRole('dialog', { name: 'Claim crate contents' }));
  assert.equal(modalChanges.at(-1), true);
  fireEvent.click(view.getByRole('button', { name: 'Connect wallet' }));
  assert.equal(connections, 1);
  view.rerenderPage({ wallet: { ...disconnected, status: 'connecting' } });
  view.rerenderPage({ wallet: connected });
  await waitFor(() => assert.equal((view.getByLabelText('Crate claim code') as HTMLInputElement).value, 'ABCDEF123456'));
  assert.ok(view.getByRole('dialog', { name: 'Crate receipt #1' }));
  assert.equal(transactions, 0);
  assert.equal(modalChanges.at(-1), true);
  fireEvent.click(view.getByRole('button', { name: 'Close' }));
  assert.equal(modalChanges.at(-1), false);
});

test('closing a claim connection restores mint and collection actions and ignores a late wallet response', async t => {
  const receipt = item('2000001', 'crate_receipt');
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [receipt], nextCursor: null, observedBlock: 10 }));
  let finishConnection!: (accounts: string[]) => void;
  const connection = new Promise<string[]>(resolve => { finishConnection = resolve; });
  let requested = false;
  Object.defineProperty(window, 'ethereum', { configurable: true, value: {
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') { requested = true; return connection; }
      return method === 'eth_chainId' ? '0xaa36a7' : [owner];
    },
  } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  let currentWallet!: EthereumWallet;
  function ClaimPage() {
    currentWallet = useMiNoteEthereumWallet(true);
    return createElement(Ethereum111kPage, {
      wallet: currentWallet, claimReceiptId: receipt.tokenId, claimCode: 'ABCDEF123456',
      addressEncryptionPublicKey: '', solanaInventoryItems: [], solanaSelected: new Set<string>(),
      onSolanaToggle() {}, clearSolanaSelection() {}, pendingRevealIds: new Set<string>(), onSolanaReveal() {}, onSolanaView() {},
      canOpenSolanaBoxes: () => true, solanaRevealLoading: null, solanaInventoryReady: true,
    });
  }
  const view = render(createElement(QueryClientProvider, { client }, createElement(ClaimPage)));
  const mintButton = view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement;
  const collectionButton = view.getByRole('button', { name: 'View collection' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(mintButton.disabled, false));
  fireEvent.click(view.getByRole('button', { name: 'Connect wallet' }));
  await waitFor(() => assert.equal(requested, true));
  assert.equal(currentWallet.status, 'connecting');
  assert.equal(mintButton.disabled, true);
  assert.equal(collectionButton.disabled, true);
  fireEvent.click(view.getByRole('button', { name: 'Close' }));
  assert.equal(currentWallet.status, 'disconnected');
  assert.equal(mintButton.disabled, false);
  assert.equal(collectionButton.disabled, false);
  assert.equal(view.queryByRole('dialog'), null);
  await act(async () => { finishConnection([owner]); });
  assert.equal(currentWallet.status, 'disconnected');
  assert.equal(currentWallet.address, null);
  assert.equal(view.queryByRole('dialog'), null);
});

test('wallet connection errors toast once per occurrence and can repeat after clearing', () => {
  const messages: string[] = [];
  const disconnected: EthereumWallet = { ...wallet, address: null, provider: null, status: 'disconnected' };
  const error = 'Wallet connection was cancelled. Try again when you’re ready.';
  const view = page({ wallet: disconnected, showToast: message => messages.push(message) });
  assert.deepEqual(messages, []);
  view.rerenderPage({ wallet: { ...disconnected, error } });
  assert.deepEqual(messages, [error]);
  view.rerenderPage({ wallet: { ...disconnected, error }, showToast: message => messages.push(message) });
  assert.deepEqual(messages, [error]);
  view.rerenderPage({ wallet: { ...disconnected, status: 'connecting' } });
  assert.deepEqual(messages, [error]);
  view.rerenderPage({ wallet: { ...disconnected, error } });
  assert.deepEqual(messages, [error, error]);
});

for (const state of ['paused', 'sold out'] as const) {
  test(`disconnected mint stays disabled while availability is ${state}`, async t => {
    t.mock.method(ethereumApi, 'stats', async () => stats({ saleActive: state !== 'paused', remainingCrates: state === 'sold out' ? 0 : 5555 }));
    let connections = 0;
    const view = page({ wallet: { ...wallet, address: null, provider: null, status: 'disconnected', connect() { connections++; } } });
    await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'config'])?.status, 'success'));
    await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'stats', config.chainId, config.contractAddress, null])?.status, 'success'));
    const button = view.container.querySelector<HTMLButtonElement>('.mint-panel button[type="submit"]')!;
    await waitFor(() => assert.equal(button.disabled, true));
    fireEvent.click(button);
    assert.equal(connections, 0);
  });
}

test('viewing a collection connects below the mint panel while the sale is paused without minting', async t => {
  t.mock.method(ethereumApi, 'stats', async () => stats({ saleActive: false }));
  let connections = 0;
  let transactions = 0;
  let startConnecting = () => {};
  const disconnected: EthereumWallet = { ...wallet, address: null, provider: null, status: 'disconnected',
    connect() { connections++; startConnecting(); } };
  const connected: EthereumWallet = { ...wallet, provider: { request: async ({ method }) => {
    if (method === 'eth_sendTransaction') { transactions++; return `0x${'ab'.repeat(32)}`; }
    if (method === 'eth_chainId') return '0xaa36a7';
    return [owner];
  } } };
  const view = page({ wallet: disconnected });
  startConnecting = () => view.rerenderPage({ wallet: { ...disconnected, status: 'connecting' } });
  await waitFor(() => assert.ok(view.getByText('Minting is paused')));
  const mintButton = view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement;
  const collectionButton = view.getByRole('button', { name: 'View collection' }) as HTMLButtonElement;
  assert.equal(mintButton.disabled, true);
  assert.equal(collectionButton.disabled, false);
  assert.equal(view.container.querySelector('.drop-page-frame--active')!.contains(collectionButton), false);
  fireEvent.click(collectionButton);
  fireEvent.click(collectionButton);
  assert.equal(connections, 1);
  assert.equal(collectionButton.disabled, true);
  view.rerenderPage({ wallet: connected });
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${item().id}"]`)));
  assert.ok(view.getByRole('button', { name: 'Refresh' }));
  assert.equal(view.queryByRole('button', { name: 'View collection' }), null);
  assert.equal(mintButton.disabled, true);
  assert.equal(transactions, 0);
});

for (const [ethereumPending, settleOnOpen] of [
  ['choosing', false], ['connecting', false], ['receipt viewer', false], ['artwork viewer', false], ['receipt viewer', true],
] as const) test(`Ethereum ${ethereumPending} cancels an early Solana header sign-in${settleOnOpen ? ' when restoration finishes simultaneously' : ''}`, async t => {
  const viewedItem = ethereumPending === 'receipt viewer' ? item('2000001', 'crate_receipt')
    : ethereumPending === 'artwork viewer' ? { ...item('332', 'artwork'), name: 'Artwork #332', displayId: 332 } : null;
  if (viewedItem) t.mock.method(ethereumApi, 'inventory', async () => ({ items: [viewedItem], nextCursor: null, observedBlock: 10 }));
  let finishLoading!: () => void;
  let cancelEthereum!: () => void;
  let signInCalls = 0;
  let solanaPickerOpens = 0;
  const showToast = (message: string) => assert.fail(message);
  function Harness() {
    const [resolved, setResolved] = useState(false);
    const [ethereumStatus, setEthereumStatus] = useState<EthereumWallet['status']>(viewedItem ? 'connected' : 'disconnected');
    const [ethereumModalOpen, setEthereumModalOpen] = useState(false);
    const [solanaPicker, setSolanaPicker] = useState(false);
    const signal = useRef(new AbortController().signal);
    finishLoading = () => setResolved(true);
    cancelEthereum = () => setEthereumStatus('disconnected');
    const auth = {
      authenticated: false, sessionWallet: null, sessionResolution: resolved ? 'settled' as const : 'resolving' as const,
      loading: false, error: null, refreshProfileState: async () => true, signOut: async () => {},
      intentCancellationSignal: signal.current, hasAuthenticatedWalletSession: () => false,
      awaitWalletSessionRestoration: async () => 'sign-in-required' as const,
      signIn: async () => { throw new Error('Unexpected signature'); },
    };
    const solanaWallet = { connected: false, connecting: false, disconnecting: false, publicKey: null, wallet: null, disconnect: async () => {} };
    const signIn = useShopSignIn({
      auth, wallet: solanaWallet, connectedWallet: undefined, publicKey: null, walletModalVisible: solanaPicker,
      setVisible: visible => { if (visible) solanaPickerOpens += 1; setSolanaPicker(visible); },
      showToast, isUserRejectedError: () => false,
    });
    const continuation = useShopActionContinuation({
      connectedWallet: undefined, scopeKey: '/111k_devnet', cancellationSignal: signal.current,
      ensureSignedIn: signIn.ensureSignedIn, ensureWalletConnected: signIn.ensureWalletConnected, showToast,
    });
    const handlers = useShopActionHandlers(headerSignInOptions(continuation, showToast));
    const model = useHeaderWallet({
      auth, wallet: solanaWallet,
      signIn: request => { signInCalls += 1; return handlers.handleHeaderSignIn(request); },
      joinPendingSignIn: signIn.joinPendingSignIn, signInPending: continuation.pendingAction?.phase === 'authenticating',
      mutationPending: continuation.pendingAction?.phase === 'running', walletModalVisible: solanaPicker,
      suspended: ethereumModalOpen || ethereumStatus === 'choosing' || ethereumStatus === 'connecting', showToast,
    });
    const onModalOpenChange = useCallback((open: boolean) => {
      if (open) model.close();
      setEthereumModalOpen(open);
    }, [model.close]);
    return createElement(Ethereum111kPage, {
      header: createElement(ShopHeader, { renderRight: ({ interactive }) => createElement(ShopWalletControl, { interactive, model }) }),
      wallet: { ...wallet, address: viewedItem ? owner : null, provider: viewedItem ? wallet.provider : null, status: ethereumStatus,
        connect: () => setEthereumStatus(ethereumPending === 'choosing' ? 'choosing' : 'connecting'), cancel: cancelEthereum },
      onModalOpenChange,
      addressEncryptionPublicKey: '', solanaInventoryItems: [], solanaSelected: new Set<string>(),
      onSolanaToggle() {}, clearSolanaSelection() {}, pendingRevealIds: new Set<string>(), onSolanaReveal() {}, onSolanaView() {},
      canOpenSolanaBoxes: () => true, solanaRevealLoading: null, solanaInventoryReady: true,
      externalBusy: Boolean(continuation.pendingAction), suspended: solanaPicker,
    });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const view = render(createElement(QueryClientProvider, { client }, createElement(BackgroundBlurProvider, null, createElement(Harness))));
  const headerButton = view.getByRole('button', { name: 'Wallet' });
  fireEvent.click(headerButton);
  assert.ok(view.getByText('Loading wallet…'));
  if (ethereumPending === 'artwork viewer') {
    const selector = `[data-inventory-id="${viewedItem!.id}"]`;
    await waitFor(() => assert.ok(view.container.querySelector(selector)));
    const tile = view.container.querySelector<HTMLElement>(selector)!;
    tile.focus();
    fireEvent.keyDown(tile, { key: 'Enter' });
  }
  const collectionButton = await view.findByRole('button', {
    name: ethereumPending === 'artwork viewer' ? 'View' : viewedItem ? `View ${viewedItem.name}` : 'View collection',
  });
  collectionButton.focus();
  act(() => {
    if (settleOnOpen) finishLoading();
    fireEvent.keyDown(collectionButton, { key: 'Enter' });
    fireEvent.click(collectionButton, { detail: 0 });
  });
  const ethereumDialog = view.queryByRole('dialog', { name: viewedItem?.name ?? 'Connect Ethereum' });
  if (ethereumPending !== 'connecting') assert.ok(ethereumDialog?.contains(document.activeElement));
  assert.equal(Boolean(view.container.querySelector('.top__wallet-popup')), false);
  await act(async () => { finishLoading(); });
  assert.equal(signInCalls, 0);
  assert.equal(solanaPickerOpens, 0);
  if (ethereumPending !== 'connecting') {
    assert.ok(ethereumDialog?.contains(document.activeElement));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    assert.equal(document.activeElement, collectionButton);
  } else {
    await act(async () => { cancelEthereum(); });
  }
  assert.equal(Boolean(view.queryByRole('dialog', { name: viewedItem?.name ?? 'Connect Ethereum' })), false);
  assert.equal(signInCalls, 0);
  assert.equal(view.container.querySelector('.top__wallet-popup'), null);
  await act(async () => { fireEvent.click(headerButton); });
  assert.equal(signInCalls, 1);
  assert.equal(solanaPickerOpens, 1);
});

test('Ethereum modal reporting respects suspension and resets on unmount', () => {
  const changes: boolean[] = [];
  const view = page({ wallet: { ...wallet, status: 'choosing' }, onModalOpenChange: open => changes.push(open) });
  assert.equal(changes.at(-1), true);
  view.rerenderPage({ suspended: true });
  assert.equal(changes.at(-1), false);
  view.rerenderPage({ suspended: false });
  assert.equal(changes.at(-1), true);
  view.unmount();
  assert.equal(changes.at(-1), false);
});

test('an Ethereum confirmation waits for the active Solana picker before showing its reveal', async t => {
  const artwork = { ...item('1', 'artwork'), name: 'Artwork #1' };
  const confirmation = deferred<Awaited<ReturnType<typeof ethereumApi.confirm>>>();
  let confirmationCalls = 0;
  t.mock.method(ethereumApi, 'confirm', async () => { confirmationCalls += 1; return confirmation.promise; });
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash: `0x${'ab'.repeat(32)}`, action: 'unbox', submittedAt: Date.now() });
  let pickerVisible = false;
  let dismissPicker!: () => void;
  let signInCalls = 0;
  const showToast = (message: string) => assert.fail(message);
  function Harness() {
    const [solanaPicker, setSolanaPicker] = useState(false);
    const [ethereumModalOpen, setEthereumModalOpen] = useState(false);
    const signal = useRef(new AbortController().signal);
    pickerVisible = solanaPicker;
    dismissPicker = () => setSolanaPicker(false);
    const auth = {
      authenticated: false, sessionWallet: null, sessionResolution: 'settled' as const, loading: false, error: null,
      refreshProfileState: async () => true, signOut: async () => {}, intentCancellationSignal: signal.current,
      hasAuthenticatedWalletSession: () => false, awaitWalletSessionRestoration: async () => 'sign-in-required' as const,
      signIn: async () => { throw new Error('Unexpected signature'); },
    };
    const solanaWallet = { connected: false, connecting: false, disconnecting: false, publicKey: null, wallet: null, disconnect: async () => {} };
    const signIn = useShopSignIn({
      auth, wallet: solanaWallet, connectedWallet: undefined, publicKey: null, walletModalVisible: solanaPicker,
      setVisible: setSolanaPicker, showToast, isUserRejectedError: () => false,
    });
    const continuation = useShopActionContinuation({
      connectedWallet: undefined, scopeKey: '/111k_devnet', cancellationSignal: signal.current,
      ensureSignedIn: signIn.ensureSignedIn, ensureWalletConnected: signIn.ensureWalletConnected, showToast,
    });
    const handlers = useShopActionHandlers(headerSignInOptions(continuation, showToast));
    const model = useHeaderWallet({
      auth, wallet: solanaWallet, signIn: request => { signInCalls += 1; return handlers.handleHeaderSignIn(request); },
      joinPendingSignIn: signIn.joinPendingSignIn, signInPending: continuation.pendingAction?.phase === 'authenticating',
      mutationPending: continuation.pendingAction?.phase === 'running', walletModalVisible: solanaPicker,
      suspended: ethereumModalOpen, showToast,
    });
    const onModalOpenChange = useCallback((open: boolean) => {
      if (open) model.close();
      setEthereumModalOpen(open);
    }, [model.close]);
    return createElement(Ethereum111kPage, {
      header: createElement(ShopHeader, { renderRight: ({ interactive }) => createElement(ShopWalletControl, { interactive, model }) }),
      wallet, onModalOpenChange, addressEncryptionPublicKey: '', solanaInventoryItems: [], solanaSelected: new Set<string>(),
      onSolanaToggle() {}, clearSolanaSelection() {}, pendingRevealIds: new Set<string>(), onSolanaReveal() {}, onSolanaView() {},
      canOpenSolanaBoxes: () => true, solanaRevealLoading: null, solanaInventoryReady: true,
      externalBusy: Boolean(continuation.pendingAction), suspended: solanaPicker,
    });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const view = render(createElement(QueryClientProvider, { client }, createElement(BackgroundBlurProvider, null, createElement(Harness))));
  await waitFor(() => assert.equal(confirmationCalls, 1));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Wallet' })); });
  assert.equal(pickerVisible, true);
  await act(async () => { confirmation.resolve({ status: 'confirmed', confirmations: 1, items: [artwork], burnedTokenIds: [] }); });
  await waitFor(() => assert.ok(document.querySelector('.ethereum111k__reveal')));
  assert.equal(pickerVisible, true);
  assert.equal(view.queryByRole('dialog', { name: 'Your artworks' }), null);
  assert.equal(signInCalls, 1);
  await act(async () => { dismissPicker(); });
  assert.ok(view.getByRole('dialog', { name: 'Your artworks' }));
  assert.equal(signInCalls, 1);
});

for (const control of ['Wallet', 'App menu'] as const) test(`the Ethereum picker handles Escape while the unfocused ${control} stays open`, () => {
  function AccountHeader() {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => {
      if (control === 'Wallet') setOpen(false);
    }, []);
    const settingsRef = useRef<HTMLDivElement>(null);
    const model: HeaderWallet = {
      address: 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz', open: control === 'Wallet' && open,
      status: 'account', loadingError: null, retryLoading: () => undefined,
      buttonDisabled: false, disconnectDisabled: false, disconnecting: false, disconnectError: null,
      balanceLamports: 0, balanceLoading: false, balanceError: false,
      activate: async () => setOpen(value => !value), close,
      disconnect: async () => undefined, retryBalance: () => undefined,
    };
    return createElement(ShopHeader, {
      renderRight: ({ interactive }) => control === 'Wallet'
        ? createElement(ShopWalletControl, { interactive, model })
        : createElement(ShopHeaderActions, {
          interactive, walletControl: model, canUseAdminMenu: true, mainnetOnlyStaff: false, canUseAdminViewer: false,
          settingsRef, settingsOpen: open, setSettingsOpen: setOpen, ownerPickerOpened: false, setOwnerPickerOpened() {},
          authenticatedWallet: model.address, adminViewedOwner: null, setAdminViewedOwner() {}, deliveryOrderOwners: [],
          wipPickerOpened: false, setWipPickerOpened() {}, devnetDropsPickerOpened: false, setDevnetDropsPickerOpened() {},
          deliveryOrderOwnersLoadingMore: false, deliveryOrderOwnersHasNextPage: false, deliveryOrderOwnersError: null,
          fetchNextDeliveryOrderOwners: async () => { throw new Error('Unexpected owners request'); },
          owner: model.address, adminMenuDevnetDrops: [],
        }),
    });
  }
  const disconnected: EthereumWallet = {
    ...wallet, address: null, provider: null, status: 'disconnected',
    connect() { view.rerenderPage({ wallet: { ...disconnected, status: 'choosing' } }); },
    cancel() { view.rerenderPage({ wallet: disconnected }); },
  };
  const view = page({ wallet: disconnected, header: createElement(AccountHeader) });
  const popupRole = control === 'Wallet' ? 'dialog' : 'menu';
  const headerButton = view.getByRole('button', { name: control });
  fireEvent.click(headerButton);
  assert.equal(document.activeElement, view.getByRole(popupRole, { name: control }));
  const collectionButton = view.getByRole('button', { name: 'View collection' });
  collectionButton.focus();
  fireEvent.keyDown(collectionButton, { key: 'Enter' });
  fireEvent.click(collectionButton, { detail: 0 });
  assert.ok(view.getByRole('dialog', { name: 'Connect Ethereum' }).contains(document.activeElement));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  assert.equal(view.queryByRole('dialog', { name: 'Connect Ethereum' }), null);
  assert.ok(view.getByRole(popupRole, { name: control }));
  assert.equal(document.activeElement, collectionButton);
  headerButton.focus();
  fireEvent.keyDown(headerButton, { key: 'Escape' });
  assert.equal(view.queryByRole(popupRole, { name: control }), null);
  assert.equal(document.activeElement, headerButton);
});

test('Ethereum and Solana appear in one inventory while selection dispatch stays on its own chain', async () => {
  let cleared = 0;
  const toggled: string[] = [];
  const view = page({
    solanaInventoryItems: [{ id: 'solana-item', dropId: 'card_nft_2', kind: 'box', name: 'Solana pack', image }],
    clearSolanaSelection() { cleared++; }, onSolanaToggle(id) { toggled.push(id); },
  });
  await waitFor(() => assert.equal(view.container.querySelectorAll('[data-inventory-id]').length, 2));
  const ethereumTile = view.container.querySelector(`[data-inventory-id="${item().id}"]`)!;
  const crateImage = ethereumTile.querySelector('img')!;
  assert.equal(crateImage.getAttribute('src'), 'https://wip.lil.org/111k/crate_clean.webp');
  assert.equal(crateImage.getAttribute('width'), '1218');
  assert.equal(crateImage.getAttribute('height'), '833');
  fireEvent.click(ethereumTile);
  assert.equal(cleared, 1);
  assert.ok(view.getByRole('button', { name: 'Open crate' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(view.queryByRole('button', { name: 'Open crate' }), null);
  fireEvent.click(ethereumTile);
  fireEvent.click(view.container.querySelector('[data-inventory-id="solana-item"]')!);
  assert.deepEqual(toggled, ['solana-item']);
  assert.equal(view.queryByRole('button', { name: 'Open crate' }), null);
});

for (const selection of [
  { name: 'crate', tokens: [item()], expected: '111112' },
  { name: 'artwork', tokens: [{ ...item('332', 'artwork'), displayId: 332, name: 'Artwork #332' }], expected: '332' },
  { name: 'mixed crate and artwork', tokens: [
    { ...item('111113'), displayId: 2, name: 'Crate #2' },
    { ...item('553', 'artwork'), displayId: 553, name: 'Artwork #553' },
    item(),
  ], expected: '553,111112,111113' },
]) {
  test(`sending a ${selection.name} selection opens checkout with onchain token IDs and no transaction`, async t => {
    const methods: string[] = [];
    const sendingWallet: EthereumWallet = { ...wallet, provider: { request: async args => {
      methods.push(args.method);
      return wallet.provider!.request(args);
    } } };
    const prepare = t.mock.method(ethereumApi, 'prepareDelivery');
    const saveAddress = t.mock.method(ethereumApi, 'saveAddress');
    t.mock.method(ethereumApi, 'inventory', async () => ({ items: selection.tokens, nextCursor: null, observedBlock: 10 }));
    const view = page({ wallet: sendingWallet });
    await waitFor(() => assert.equal(view.container.querySelectorAll('[data-inventory-id]').length, selection.tokens.length));
    for (const token of selection.tokens) fireEvent.click(view.container.querySelector(`[data-inventory-id="${token.id}"]`)!);
    fireEvent.click(view.getByRole('button', { name: 'Send' }));
    assert.equal(window.location.pathname, '/checkout');
    assert.deepEqual([...new URLSearchParams(window.location.search)], [['drop', '111k_devnet'], ['ids', selection.expected]]);
    assert.equal(view.queryByRole('dialog'), null);
    assert.equal(prepare.mock.callCount(), 0);
    assert.equal(saveAddress.mock.callCount(), 0);
    assert.equal(methods.some(method => ['eth_sendTransaction', 'personal_sign', 'wallet_switchEthereumChain'].includes(method)), false);
  });
}

test('warehouses and receipts keep their existing actions without offering checkout', async t => {
  const warehouse = { ...item('116667', 'warehouse'), name: 'Warehouse #1' };
  const receipt = item('2000001', 'crate_receipt');
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [warehouse, receipt], nextCursor: null, observedBlock: 10 }));
  const view = page();
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${warehouse.id}"]`)));
  const warehouseImage = view.container.querySelector(`[data-inventory-id="${warehouse.id}"] img`)!;
  assert.equal(warehouseImage.getAttribute('src'), 'https://wip.lil.org/111k/warehouse_clean.webp');
  assert.equal(warehouseImage.getAttribute('width'), '1254');
  assert.equal(warehouseImage.getAttribute('height'), '1104');
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${warehouse.id}"]`)!);
  assert.ok(view.getByRole('button', { name: 'Open warehouse' }));
  assert.equal(view.queryByRole('button', { name: 'Send' }), null);
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(view.getByRole('button', { name: 'View Crate receipt #1' }));
  assert.ok(view.getByRole('button', { name: 'Claim crate contents' }));
  assert.ok(view.getByRole('button', { name: 'Transfer receipt' }));
  assert.equal(view.queryByRole('button', { name: 'Send' }), null);
  assert.equal(window.location.pathname, '/111k_devnet');
});

test('crate opening is capped at fifteen without truncating fifty-item delivery selections', async t => {
  const crates = Array.from({ length: 51 }, (_, index) => ({ ...item(String(111112 + index)), displayId: index + 1, name: `Crate #${index + 1}` }));
  const artwork = { ...item('1', 'artwork'), name: 'Artwork #1' };
  const warehouse = { ...item('116667', 'warehouse'), name: 'Warehouse #1' };
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [...crates, artwork, warehouse], nextCursor: null, observedBlock: 10 }));
  const view = page();
  const select = (token: EthereumInventoryItem) => fireEvent.click(view.container.querySelector(`[data-inventory-id="${token.id}"]`)!);
  await waitFor(() => assert.equal(view.container.querySelectorAll('[data-inventory-id]').length, 53));
  select(crates[0]);
  assert.equal((view.getByRole('button', { name: 'Open crate' }) as HTMLButtonElement).disabled, false);
  for (const crate of crates.slice(1, 15)) select(crate);
  assert.equal((view.getByRole('button', { name: 'Open 15 crates' }) as HTMLButtonElement).disabled, false);
  select(crates[15]);
  assert.equal((view.getByRole('button', { name: 'Open 16 crates' }) as HTMLButtonElement).disabled, true);
  assert.ok(view.getByText(/Open up to 15 crates at once/));
  for (const crate of crates.slice(16)) select(crate);
  assert.equal((view.getByRole('button', { name: 'Open 50 crates' }) as HTMLButtonElement).disabled, true);
  assert.equal((view.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, false);
  assert.equal(view.container.querySelectorAll('.inventory__item--selected').length, 50);
  select(crates[0]);
  select(artwork);
  assert.equal(view.queryByRole('button', { name: /Open \d+ crates/ }), null);
  assert.equal((view.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, false);
  select(warehouse);
  assert.equal(view.container.querySelectorAll('.inventory__item--selected').length, 1);
  assert.equal((view.getByRole('button', { name: 'Open warehouse' }) as HTMLButtonElement).disabled, false);
  assert.equal(view.queryByRole('button', { name: 'Send' }), null);
});

test('the complete bonus batch reveal keeps all 311 artworks reachable with lazy image decoding', async t => {
  const artworks: EthereumInventoryItem[] = Array.from({ length: 311 }, (_, index) => ({
    ...item(String(index + 1), 'artwork'), displayId: index + 1, name: `Artwork #${index + 1}`,
  }));
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash: `0x${'ab'.repeat(32)}`, action: 'unbox', submittedAt: Date.now() });
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({
    items: artworks.filter(item => expected.includes(item.tokenId)), nextCursor: null, observedBlock: 10,
  }));
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'confirmed', confirmations: 1, items: artworks, burnedTokenIds: [] }));
  const modalChanges: boolean[] = [];
  const view = page({ onModalOpenChange: open => modalChanges.push(open) });
  await waitFor(() => assert.ok(view.getByRole('dialog', { name: 'Your artworks' })));
  assert.equal(modalChanges.at(-1), true);
  const reveal = document.querySelector('.ethereum111k__reveal-grid')!;
  assert.equal(reveal.querySelectorAll('button').length, 311);
  assert.ok(view.getByText('311 artworks'));
  assert.ok([...reveal.querySelectorAll('img')].every(image => image.getAttribute('loading') === 'lazy' && image.getAttribute('decoding') === 'async'));
  const previousChanges = modalChanges.length;
  fireEvent.click(reveal.querySelectorAll('button')[310]);
  assert.ok(view.getByRole('dialog', { name: 'Artwork #311' }));
  assert.equal(modalChanges.at(-1), true);
  assert.ok(modalChanges.slice(previousChanges).every(Boolean));
  fireEvent.click(view.getByRole('button', { name: 'Close' }));
  assert.equal(modalChanges.at(-1), false);
});

test('claim links load the owned receipt, prefill its code, and remove the code from the address bar', async t => {
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [item('2000001', 'crate_receipt')], nextCursor: null, observedBlock: 10 }));
  window.history.replaceState(null, '', '/111k_devnet?receiptId=2000001&claim=ABCDEF123456');
  const view = page({ claimReceiptId: '2000001', claimCode: 'ABCDEF123456' });
  await waitFor(() => assert.equal((view.getByLabelText('Crate claim code') as HTMLInputElement).value, 'ABCDEF123456'));
  assert.equal(window.location.search, '');
  assert.ok(view.getByRole('button', { name: 'Claim contents' }));
  await act(async () => { await Promise.resolve(); });
  assert.ok(view.getByRole('dialog', { name: 'Crate receipt #1' }));
});

test('claim-link codes survive an unrelated cross-tab transaction and stay scoped to their receipt', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  const receipt = item('2000001', 'crate_receipt');
  const otherReceipt = { ...item('2000002', 'crate_receipt'), name: 'Crate receipt #2', displayId: 2 };
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [receipt, otherReceipt], nextCursor: null, observedBlock: 10 }));
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] }));
  window.history.replaceState(null, '', '/111k_devnet?receiptId=2000001&claim=ABCDEF123456');
  const view = page({ claimReceiptId: '2000001', claimCode: 'ABCDEF123456' });
  await waitFor(() => assert.equal((view.getByLabelText('Crate claim code') as HTMLInputElement).value, 'ABCDEF123456'));
  assert.equal(window.location.search, '');
  const key = `ethereum111k:${scope}:pending`;
  act(() => {
    const newValue = JSON.stringify({ scope, hash: `0x${'ab'.repeat(32)}`, action: 'mint', submittedAt: Date.now() });
    window.localStorage.setItem(key, newValue);
    window.dispatchEvent(new window.StorageEvent('storage', { key, newValue, storageArea: window.localStorage }));
  });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Transaction changed?' })));
  assert.equal(view.queryByLabelText('Crate claim code'), null);
  act(() => {
    window.localStorage.removeItem(key);
    window.dispatchEvent(new window.StorageEvent('storage', { key, newValue: null, storageArea: window.localStorage }));
  });
  await waitFor(() => assert.equal(view.queryByRole('button', { name: 'Transaction changed?' }), null));
  fireEvent.click(view.getByRole('button', { name: 'View Crate receipt #1' }));
  fireEvent.click(view.getByRole('button', { name: 'Claim crate contents' }));
  assert.equal((view.getByLabelText('Crate claim code') as HTMLInputElement).value, 'ABCDEF123456');
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(view.getByRole('button', { name: 'View Crate receipt #2' }));
  fireEvent.click(view.getByRole('button', { name: 'Claim crate contents' }));
  assert.equal((view.getByLabelText('Crate claim code') as HTMLInputElement).value, '');
});

test('a deferred claim link replaces the recovery dialog and keeps the claim field focused', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  const crate = item();
  const receipt = item('2000001', 'crate_receipt');
  let finishInventory!: (response: EthereumInventoryResponse) => void;
  const inventoryResponse = new Promise<EthereumInventoryResponse>(resolve => { finishInventory = resolve; });
  t.mock.method(ethereumApi, 'inventory', () => inventoryResponse);
  writeEthereumStorage(`${scope}:pending`, { scope, hash: `0x${'ab'.repeat(32)}`, action: 'mint', submittedAt: Date.now() });
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] }));
  window.history.replaceState(null, '', '/111k_devnet?receiptId=2000001&claim=ABCDEF123456');
  const view = page({ claimReceiptId: '2000001', claimCode: 'ABCDEF123456' }, client => {
    client.setQueryData(['ethereum111k', 'config'], config);
    client.setQueryData(ethereumInventoryQueryKey(scope), {
      pageParams: [null], pages: [{ items: [crate], nextCursor: null, observedBlock: 10 }],
    });
  });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Transaction changed?' })));
  fireEvent.click(view.getByRole('button', { name: 'Transaction changed?' }));
  fireEvent.click(view.getByRole('button', { name: 'Stop tracking…' }));
  assert.ok(view.getByRole('dialog', { name: 'Recover a pending transaction' }));
  await act(async () => { finishInventory({ items: [crate, receipt], nextCursor: null, observedBlock: 11 }); });
  await waitFor(() => assert.ok(view.getByRole('dialog', { name: 'Crate receipt #1' })));
  assert.equal(view.queryAllByRole('dialog').length, 1);
  assert.equal(view.queryByRole('dialog', { name: 'Recover a pending transaction' }), null);
  const claimInput = view.getByLabelText('Crate claim code') as HTMLInputElement;
  assert.equal(claimInput.value, 'ABCDEF123456');
  act(() => claimInput.focus());
  assert.equal(document.activeElement, claimInput);
});

test('an unconfigured contract has a clear state and never offers a transaction', async t => {
  t.mock.method(ethereumApi, 'config', async () => resolveEthereum111kConfig());
  const view = page();
  await waitFor(() => assert.ok(view.getByText('Mint unavailable')));
  assert.equal((view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement).disabled, true);
});

test('an interrupted submission blocks minting and offers hash recovery or explicit stop tracking', async () => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash: `0x${'0'.repeat(64)}`, awaitingHash: true, action: 'mint', submittedAt: Date.now(),
    intent: { to: contract, data: '0x1234', value: '0x1' } });
  const modalChanges: boolean[] = [];
  const view = page({ onModalOpenChange: open => modalChanges.push(open) });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Recover transaction' })));
  assert.equal((view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement).disabled, true);
  assert.ok(view.getByText('Check your wallet. The previous transaction may have been sent.'));
  fireEvent.click(view.getByRole('button', { name: 'Recover transaction' }));
  assert.equal(modalChanges.at(-1), true);
  assert.ok(view.getByLabelText('Transaction hash'));
  assert.ok(view.getByRole('button', { name: 'Track transaction' }));
  fireEvent.click(view.getByRole('button', { name: 'Stop tracking…' }));
  assert.ok(view.getByText(/The original transaction may still execute/));
  fireEvent.click(view.getByRole('button', { name: 'Stop tracking this transaction' }));
  await waitFor(() => assert.equal(view.queryByRole('button', { name: 'Recover transaction' }), null));
  assert.equal(modalChanges.at(-1), false);
  assert.equal((view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement).disabled, false);
});

test('interrupted-submission recovery retains rejected hashes and closes after successful verification', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  const hash = `0x${'cd'.repeat(32)}`;
  const intent = { to: contract, data: '0x1234', value: '0x1' };
  writeEthereumStorage(`${scope}:pending`, { scope, hash: `0x${'0'.repeat(64)}`, awaitingHash: true,
    action: 'mint', submittedAt: Date.now(), nonce: '0x7', intent });
  let transactionExists = false;
  const recoveringWallet: EthereumWallet = { ...wallet, provider: { request: async ({ method }) => {
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionByHash') return transactionExists
      ? { hash, from: owner, to: contract, input: intent.data, value: intent.value, nonce: '0x7', chainId: '0xaa36a7' } : null;
    return [owner];
  } } };
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] }));
  const view = page({ wallet: recoveringWallet });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Recover transaction' })));
  fireEvent.click(view.getByRole('button', { name: 'Recover transaction' }));
  for (const [value, message] of [
    ['incorrect hash', 'Paste the transaction hash from your wallet.'],
    [hash, 'That transaction does not match the saved Ethereum request.'],
  ]) {
    fireEvent.change(view.getByLabelText('Transaction hash'), { target: { value } });
    fireEvent.click(view.getByRole('button', { name: 'Track transaction' }));
    await waitFor(() => assert.ok(view.getAllByText(message).length));
    assert.ok(view.getByRole('dialog', { name: 'Recover a pending transaction' }));
    assert.equal((view.getByLabelText('Transaction hash') as HTMLInputElement).value, value);
  }
  transactionExists = true;
  fireEvent.click(view.getByRole('button', { name: 'Track transaction' }));
  await waitFor(() => assert.equal(Boolean(view.queryByRole('dialog', { name: 'Recover a pending transaction' })), false));
  assert.ok(view.getByRole('button', { name: 'Transaction changed?' }));
});

test('an unbox reveal replaces an already-open receipt viewer instead of creating two focus traps', async t => {
  const transactionHash = `0x${'ab'.repeat(32)}`;
  let confirmed = false;
  const receipt = item('2000001', 'crate_receipt');
  const artwork = { ...item('1', 'artwork'), name: 'Artwork #1' };
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [item(), receipt], nextCursor: null, observedBlock: 10 }));
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: confirmed ? 'confirmed' : 'pending', confirmations: confirmed ? 1 : 0,
    items: confirmed ? [artwork] : [], burnedTokenIds: confirmed ? ['111112'] : [] }));
  const sendingWallet: EthereumWallet = { ...wallet, provider: { request: async ({ method }) => {
    if (method === 'eth_sendTransaction') return transactionHash;
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_getTransactionByHash') return null;
    return [owner];
  } } };
  const view = page({ wallet: sendingWallet });
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${item().id}"]`)));
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${item().id}"]`)!);
  fireEvent.click(view.getByRole('button', { name: 'Open crate' }));
  await waitFor(() => assert.ok(view.getByText(/Opening your container/)));
  fireEvent.click(view.getByRole('button', { name: 'View Crate receipt #1' }));
  assert.ok(view.getByRole('dialog', { name: 'Crate receipt #1' }));
  confirmed = true;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
  await waitFor(() => assert.ok(view.getByRole('dialog', { name: 'Your artworks' })));
  assert.equal(view.queryAllByRole('dialog').length, 1);
  assert.equal(view.queryByRole('dialog', { name: 'Crate receipt #1' }), null);
});

test('completing a transaction clears recovery state before the next transaction', async t => {
  const firstHash = `0x${'ab'.repeat(32)}`;
  const nextHash = `0x${'cd'.repeat(32)}`;
  let confirmed = false;
  let sends = 0;
  t.mock.method(ethereumApi, 'confirm', async transactionHash => ({
    status: confirmed && transactionHash === firstHash ? 'confirmed' : 'pending',
    confirmations: confirmed && transactionHash === firstHash ? 1 : 0, items: [], burnedTokenIds: [],
  }));
  const sendingWallet: EthereumWallet = { ...wallet, provider: { request: async ({ method }) => {
    if (method === 'eth_sendTransaction') return ++sends === 1 ? firstHash : nextHash;
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_getTransactionByHash') return null;
    return [owner];
  } } };
  const view = page({ wallet: sendingWallet });
  await waitFor(() => assert.match(view.container.querySelector('.mint-panel')!.textContent!, /5555\s*\/\s*5555 left/));
  fireEvent.click(view.getByRole('button', { name: /Mint\s*1 crate/ }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Transaction changed?' })));
  fireEvent.click(view.getByRole('button', { name: 'Transaction changed?' }));
  fireEvent.change(view.getByLabelText('Replacement transaction hash'), { target: { value: nextHash } });
  fireEvent.click(view.getByRole('button', { name: 'Stop tracking…' }));

  confirmed = true;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
  await waitFor(() => assert.equal(Boolean(view.queryByRole('dialog', { name: 'Recover a pending transaction' })), false));
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${item().id}"]`)!);
  assert.ok(view.getByRole('button', { name: 'Open crate' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(Boolean(view.queryByRole('button', { name: 'Open crate' })), false);

  fireEvent.click(view.getByRole('button', { name: /Mint\s*1 crate/ }));
  await waitFor(() => assert.equal(sends, 2));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Transaction changed?' })));
  assert.equal(Boolean(view.queryByRole('dialog', { name: 'Recover a pending transaction' })), false);
  fireEvent.click(view.getByRole('button', { name: 'Transaction changed?' }));
  assert.equal((view.getByLabelText('Replacement transaction hash') as HTMLInputElement).value, '');
  assert.ok(view.getByRole('button', { name: 'Stop tracking…' }));
  assert.equal(Boolean(view.queryByRole('button', { name: 'Stop tracking this transaction' })), false);
});

test('monument minting uses its preview and clips quantity to the available capped supply', async t => {
  t.mock.method(ethereumApi, 'stats', async () => stats({ monumentsMinted: 16, remainingMonuments: 2 }));
  const view = page();
  await waitFor(() => assert.ok(view.getByRole('radio', { name: 'Monument' })));
  fireEvent.click(view.getByRole('radio', { name: 'Monument' }));
  await waitFor(() => assert.match(view.container.querySelector('.mint-panel')!.textContent!, /2\s*\/\s*18 left/));
  const preview = view.getByRole('img', { name: '111K monument' });
  assert.equal(preview.getAttribute('src'), 'https://wip.lil.org/111k/monuments/1.webp');
  assert.equal(preview.getAttribute('width'), '1400');
  assert.equal(preview.getAttribute('height'), '1400');
  fireEvent.change(view.getByRole('slider', { name: 'Mint quantity' }), { target: { value: '2' } });
  assert.ok(view.getByRole('button', { name: /Mint\s*2 monuments.*0.0176 ETH/ }));
  act(() => view.client.setQueryData(['ethereum111k', 'stats', config.chainId, contract, owner], stats({ monumentsMinted: 17, remainingMonuments: 1 })));
  await waitFor(() => assert.ok(view.getByRole('button', { name: /Mint.*0.0088 ETH/ })));
  assert.equal(view.queryByRole('slider', { name: 'Mint quantity' }), null);
  act(() => view.client.setQueryData(['ethereum111k', 'stats', config.chainId, contract, owner], stats({ monumentsMinted: 18, remainingMonuments: 0 })));
  await waitFor(() => assert.equal((view.getByRole('button', { name: /Mint.*0.0088 ETH/ }) as HTMLButtonElement).disabled, true));
});

test('monuments preserve their numbered images and offer opening without direct checkout', async t => {
  const monument = { ...item('117189', 'monument'), displayId: 18, name: 'Monument #18', image: 'https://wip.lil.org/111k/monuments/18.webp' };
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [monument, item()], nextCursor: null, observedBlock: 10 }));
  const view = page();
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${monument.id}"]`)));
  assert.equal(view.container.querySelector(`[data-inventory-id="${monument.id}"] img`)!.getAttribute('src'), monument.image);
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${item().id}"]`)!);
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${monument.id}"]`)!);
  assert.equal(view.container.querySelectorAll('.inventory__item--selected').length, 1);
  assert.ok(view.getByRole('button', { name: 'Open monument' }));
  assert.equal(view.queryByRole('button', { name: 'Send' }), null);
});
