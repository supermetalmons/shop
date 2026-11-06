import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement, useCallback, useRef, useState } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { ETHEREUM_FUNCTIONS, ethereumAssetId } from '../shared/ethereum/protocol.ts';
import { encodeCall } from '../shared/ethereum/abi.ts';
import type { EthereumInventoryItem, EthereumRelicStatus, EthereumStats } from '../shared/ethereum/api.ts';
import type { EthereumRevealedArtwork } from '../shared/ethereum/reveal.ts';
import type { EthereumWallet } from '../src/ethereum/useEthereum111k.ts';
import type { HeaderWallet } from '../src/shop/account/useHeaderWallet.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: Ethereum111kPage } = await import('../src/ethereum/Ethereum111kPage.tsx');
const { ShopHeader } = await import('../src/components/ShopHeader.tsx');
const { ShopHeaderActions } = await import('../src/shop/ui/ShopHeaderActions.tsx');
const { ShopWalletControl } = await import('../src/shop/ui/ShopWalletControl.tsx');
const { BackgroundBlurProvider } = await import('../src/components/BackgroundBlurLayer.tsx');
const { ethereumApi, EthereumApiError } = await import('../src/ethereum/api.ts');
const { ethereumRevealApi } = await import('../src/ethereum/revealApi.ts');
const { checkoutApi } = await import('../src/checkout/api.ts');
const { checkoutReservesItems, rememberCheckoutReservation } = await import('../src/ethereum/checkoutReservations.ts');
const { ethereumDiscounts, EMPTY_ETHEREUM_DISCOUNT_ROOT } = await import('../src/ethereum/discounts.ts');
const { ethereumInventoryScope, writeEthereumStorage } = await import('../src/ethereum/state.ts');
const { readEthereumDropOperations } = await import('../src/ethereum/dropOperations.ts');
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
  return { allocatedCrates: 0, warehousesMinted: 0, relicsAllocated: 0, relicsMinted: 0, artworksMinted: 0, cratePriceWei: config.cratePriceWei,
    warehousePriceWei: config.warehousePriceWei, saleActive: true, remainingCrates: 5555, remainingWarehouses: 505, remainingRelics: 0,
    chainId: config.chainId, contractAddress: contract, owner, discountMerkleRoot: EMPTY_ETHEREUM_DISCOUNT_ROOT,
    discountCratePriceWei: '50000000000000', discountAllowance: 1, discountUsed: 0, ...overrides };
}
function relicStatus(address: string | null = owner, overrides: Partial<EthereumRelicStatus> = {}): EthereumRelicStatus {
  return { chainId: config.chainId, contractAddress: contract, owner: address, observedBlock: 10, blockHash: `0x${'ab'.repeat(32)}`,
    saleActive: true, relicsAllocated: 12, relicsMinted: 0, remainingRelics: 12, claimedMask: 0,
    relicLimit: address ? 3 : 0, relicsUsed: 0, remainingAllowance: address ? 3 : 0, ...overrides };
}
const relicQueryKey = (address: string | null = owner) => ['ethereum111k', 'relics', config.chainId, contract, address];
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
  t.mock.method(ethereumApi, 'relics', async (_config, address) => relicStatus(address));
  t.mock.method(ethereumApi, 'relicMetadata', async () => Array.from({ length: 18 }, (_, i) => ({ name: `Relic #${i + 1}`, image })));
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] }));
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [item()], nextCursor: null, observedBlock: 10 }));
  t.mock.method(ethereumRevealApi, 'transaction', async () => ({ chainId: config.chainId, contractAddress: contract,
    dropId: config.dropId, deploymentId: 'test', status: 'pending', artworks: [], retryAfterMs: 2_000 }));
  t.mock.method(ethereumRevealApi, 'tokens', async (_config, tokenIds) => ({ chainId: config.chainId, contractAddress: contract,
    dropId: config.dropId, deploymentId: 'test', artworks: [], retryAfterMs: 2_000,
    unresolved: tokenIds.map(tokenId => ({ tokenId, status: 'recovering' as const })) }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); dom.window.close(); });
function page(overrides: Partial<Parameters<typeof Ethereum111kPage>[0]> = {}, initialize?: (client: InstanceType<typeof QueryClient>) => void,
  Page = Ethereum111kPage) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  initialize?.(client);
  const props: Parameters<typeof Ethereum111kPage>[0] = {
    wallet, solanaInventoryItems: [], solanaSelected: new Set<string>(),
    onSolanaToggle() {}, clearSolanaSelection() {}, pendingRevealIds: new Set<string>(), onSolanaReveal() {}, onSolanaView() {},
    canOpenSolanaBoxes: () => true, solanaRevealLoading: null, solanaInventoryReady: true,
    ...overrides,
  };
  const tree = () => createElement(QueryClientProvider, { client }, createElement(BackgroundBlurProvider, { children: createElement(Page, props) }));
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
  await waitFor(() => assert.ok(view.messages.includes('Couldn’t check your mint discount. Please try again.')));
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

for (const exhaustedAllowance of [{ discountUsed: 1 }, { maxDiscountedMints: 500, totalDiscountedMints: 500 }]) {
  test(`an exhausted allowance clears a prior proof error and restores public crate minting: ${JSON.stringify(exhaustedAllowance)}`, async t => {
    const discount = stats({ discountMerkleRoot: `0x${'12'.repeat(32)}` });
    t.mock.method(ethereumDiscounts, 'proof', async () => { throw new Error('Wrong discount root'); });
    const view = await delayedMintPage(t);
    await act(async () => {
      view.configuration.resolve(config);
      view.availability.resolve(discount);
    });
    await waitFor(() => assert.ok(view.messages.includes('Couldn’t check your mint discount. Please try again.')));
    const exhausted = { ...discount, ...exhaustedAllowance };
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
}

test('the mint panel shares the drop frame and previews the selected crate quantity', async () => {
  const view = page({ header: createElement('header', {}, 'Shop header') });
  const crateImage = view.getByRole('img', { name: '111K crate' });
  assert.equal(crateImage.getAttribute('src'), 'https://wip.lil.org/111k/crate_clean.webp');
  assert.equal(crateImage.getAttribute('width'), '1218');
  assert.equal(crateImage.getAttribute('height'), '833');
  const previewStyle = (view.container.querySelector('.mint-panel__boxes') as HTMLElement).style;
  assert.equal(previewStyle.getPropertyValue('--box-width'), `${Math.floor(120 * 1218 / 833)}px`);
  assert.equal(previewStyle.getPropertyValue('--box-height'), '120px');
  await waitFor(() => assert.equal(view.container.querySelector('.mint-panel__availability')?.textContent, '5555 / 5555 left'));
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
  assert.equal(view.container.querySelector('.mint-panel__availability')?.textContent, '0012 / 5555 left');
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
  assert.equal(view.container.querySelector('.mint-panel__availability')?.textContent, '003 / 505 left');
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
  assert.equal(view.container.querySelector('.mint-panel__availability')?.textContent, '002 / 505 left');
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
  await waitFor(() => assert.equal(view.container.querySelector('.mint-panel__availability')?.textContent, '0010 / 5555 left'));
  fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
  assert.equal(view.container.querySelector('.mint-panel__availability')?.textContent, '000 / 505 left');
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

for (const kind of ['crate', 'warehouse'] as const) test(`disconnected mint connects once and submits the captured ${kind} quantity with exact wei pricing`, async t => {
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
  if (kind !== 'crate') fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: new RegExp(`Mint\\s*1 ${kind}.*0.123456 ETH`) })));
  fireEvent.change(view.getByRole('slider', { name: 'Mint quantity' }), { target: { value: '3' } });
  const mintButton = view.getByRole('button', { name: new RegExp(`Mint\\s*3 ${kind}s.*0.37037 ETH`) }) as HTMLButtonElement;
  fireEvent.click(mintButton);
  fireEvent.click(mintButton);
  assert.equal(connections, 1);
  assert.equal(mintButton.disabled, true);
  assert.ok(view.getAllByRole('radio').every(input => input.matches(':disabled')));
  assert.equal(transactions.length, 0);
  view.rerenderPage({ wallet: connected });
  await waitFor(() => assert.equal(transactions.length, 1));
  assert.equal(transactions[0].data, encodeCall({ crate: ETHEREUM_FUNCTIONS.mintCrates, warehouse: ETHEREUM_FUNCTIONS.mintWarehouses }[kind], ['uint256'], [3]));
  assert.equal(transactions[0].value, `0x${(BigInt(unitPriceWei) * 3n).toString(16)}`);
  await waitFor(() => assert.ok(view.container.querySelector('[data-inventory-id^="ethereum-pending:"]')));
  await waitFor(() => assert.ok(view.getAllByRole('radio').every(input => !input.matches(':disabled'))));
  view.rerenderPage({ wallet: { ...connected } });
  await act(async () => { await Promise.resolve(); });
  assert.equal(transactions.length, 1);
});

for (const status of ['connected', 'disconnected', 'restoring'] as const) {
  test(`an early Mint with a ${status} wallet waits for actual configuration and availability`, async t => {
    const view = await delayedMintPage(t, status);
    const kind = status === 'disconnected' ? 'warehouse' : 'crate';
    if (kind !== 'crate') fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
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
    assert.equal(view.transactions[0].data, encodeCall({ crate: ETHEREUM_FUNCTIONS.mintCrates, warehouse: ETHEREUM_FUNCTIONS.mintWarehouses }[kind], ['uint256'], [3]));
    assert.equal(view.transactions[0].value, `0x${(BigInt(unitPriceWei) * 3n).toString(16)}`);
    await waitFor(() => assert.ok(view.container.querySelector('[data-inventory-id^="ethereum-pending:"]')));
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
      await act(async () => { view.availability.resolve(stats()); await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'config'] }); });
    } else {
      t.mock.method(ethereumApi, 'stats', async () => stats());
      await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'stats'] }); });
    }
    await waitFor(() => assert.equal(view.container.querySelector('.mint-panel__availability')?.textContent, '5555 / 5555 left'));
    await waitFor(() => assert.equal(view.queryAllByRole('alert').length, 0));
    assert.equal((view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement).disabled, false);
    assert.equal(view.transactions.length, 0);
  });
}

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
  const collectionButton = view.getByRole('button', { name: /Mint\s*1 crate/ });
  collectionButton.focus();
  fireEvent.keyDown(collectionButton, { key: 'Enter' });
  fireEvent.click(collectionButton, { detail: 0 });
  assert.ok(view.getByRole('dialog', { name: 'Connect wallet' }).contains(document.activeElement));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  assert.equal(view.queryByRole('dialog', { name: 'Connect wallet' }), null);
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
  assert.ok(view.getByRole('button', { name: 'Open' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(view.queryByRole('button', { name: 'Open' }), null);
  fireEvent.click(ethereumTile);
  fireEvent.click(view.container.querySelector('[data-inventory-id="solana-item"]')!);
  assert.deepEqual(toggled, ['solana-item']);
  assert.equal(view.queryByRole('button', { name: 'Open' }), null);
});

test('the relic icon opens claims without adding a public relic mint', async t => {
  t.mock.method(ethereumApi, 'stats', async () => stats({ relicsAllocated: 18, relicsMinted: 16, remainingRelics: 2,
    allocatedCrates: 1998, remainingCrates: 3557, remainingWarehouses: 323 }));
  const view = page();
  await waitFor(() => assert.ok(view.getByRole('radio', { name: 'Crate' })));
  assert.deepEqual(view.getAllByRole('radio').map(input => input.getAttribute('aria-label')), ['Crate', 'Warehouse', 'Relic']);
  assert.equal(view.queryByRole('button', { name: /Mint.*relic/i }), null);
});

test('the relic panel shows all eighteen selectable IDs, hides slider and price, and dims claimed IDs', async t => {
  t.mock.method(ethereumApi, 'relics', async () => relicStatus(owner, { claimedMask: 1 << 3, relicsMinted: 1, remainingRelics: 11 }));
  const view = page();
  await waitFor(() => assert.ok(view.getByRole('radio', { name: 'Relic' })));
  fireEvent.click(view.getByRole('radio', { name: 'Relic' }));
  await waitFor(() => assert.equal((view.getByRole('radio', { name: 'Relic #18' }) as HTMLInputElement).disabled, false));
  const grid = view.getByRole('radiogroup', { name: 'Choose a relic' });
  assert.equal(grid.querySelectorAll('input[type=radio]').length, 18);
  assert.equal(grid.querySelectorAll('a').length, 0);
  const claimed = view.getByRole('radio', { name: 'Relic #4, claimed' }) as HTMLInputElement;
  assert.equal(claimed.disabled, true);
  assert.equal(claimed.closest('label')!.getAttribute('data-claimed'), 'true');
  assert.equal(view.queryByRole('slider', { name: 'Mint quantity' }), null);
  assert.equal(view.container.querySelector('.mint-panel__submit-price'), null);
  assert.match(view.container.querySelector('.mint-panel__availability')!.textContent!, /3 claims left/);
  const button = view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  fireEvent.click(view.getByRole('radio', { name: 'Relic #18' }));
  assert.equal(button.disabled, false);
  assert.equal((view.getByRole('radio', { name: 'Relic #18' }) as HTMLInputElement).checked, true);
  fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
  assert.ok(view.getByRole('slider', { name: 'Mint quantity' }));
  assert.ok(view.getByRole('button', { name: /Mint.*warehouse/ }));
});

test('external claims clear selected IDs, reorgs restore availability, and exhausted allocation disables unclaimed IDs', async () => {
  const view = page();
  await waitFor(() => assert.ok(view.getByRole('radio', { name: 'Relic' })));
  fireEvent.click(view.getByRole('radio', { name: 'Relic' }));
  const relic = () => view.getByRole('radio', { name: 'Relic #18' }) as HTMLInputElement;
  await waitFor(() => assert.equal(relic().disabled, false));
  fireEvent.click(relic());
  act(() => view.client.setQueryData(relicQueryKey(), relicStatus(owner, { claimedMask: 1 << 17, relicsMinted: 1, remainingRelics: 11 })));
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, true));
  assert.equal((view.getByRole('radio', { name: 'Relic #18, claimed' }) as HTMLInputElement).checked, false);
  act(() => view.client.setQueryData(relicQueryKey(), relicStatus()));
  await waitFor(() => assert.equal(relic().disabled, false));
  assert.equal(relic().checked, false);
  act(() => view.client.setQueryData(relicQueryKey(), relicStatus(owner, { claimedMask: (1 << 12) - 1, relicsMinted: 12, remainingRelics: 0 })));
  await waitFor(() => assert.equal(relic().disabled, true));
  assert.equal(relic().closest('label')!.getAttribute('data-claimed'), 'false');
  assert.equal(view.getByRole('radiogroup', { name: 'Choose a relic' }).querySelectorAll('input').length, 18);
  assert.match(view.container.querySelector('.mint-panel__availability')!.textContent!, /Sold out/);
});

for (const [label, state, expected] of [
  ['ineligible', { relicLimit: 0, remainingAllowance: 0 }, 'Not eligible'],
  ['exhausted', { relicsUsed: 3, remainingAllowance: 0 }, '0 claims left'],
  ['paused', { saleActive: false }, 'Paused'],
] as const) test(`the relic panel lets ${label} wallets browse without enabling Claim`, async t => {
  t.mock.method(ethereumApi, 'relics', async () => relicStatus(owner, state));
  const view = page();
  await waitFor(() => assert.ok(view.getByRole('radio', { name: 'Relic' })));
  fireEvent.click(view.getByRole('radio', { name: 'Relic' }));
  await waitFor(() => assert.equal((view.getByRole('radio', { name: 'Relic #18' }) as HTMLInputElement).disabled, false));
  fireEvent.click(view.getByRole('radio', { name: 'Relic #18' }));
  assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, true);
  assert.equal(view.container.querySelector('.mint-panel__availability')!.textContent, expected);
});

test('stale or failed relic reads disable Claim until a fresh snapshot arrives', async t => {
  const view = page();
  await waitFor(() => assert.ok(view.getByRole('radio', { name: 'Relic' })));
  fireEvent.click(view.getByRole('radio', { name: 'Relic' }));
  await waitFor(() => assert.equal((view.getByRole('radio', { name: 'Relic #18' }) as HTMLInputElement).disabled, false));
  fireEvent.click(view.getByRole('radio', { name: 'Relic #18' }));
  act(() => view.client.setQueryData(relicQueryKey(), relicStatus(), { updatedAt: Date.now() - 8_001 }));
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, true));
  act(() => view.client.setQueryData(relicQueryKey(), relicStatus()));
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false));
  t.mock.method(ethereumApi, 'relics', async () => { throw new Error('RPC unavailable'); });
  await act(async () => { await view.client.invalidateQueries({ queryKey: relicQueryKey() }); });
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, true));
  assert.equal(view.queryByRole('button', { name: 'Refresh' }), null);
});

test('guest Claim preserves the chosen ID through connection and submits it once without payment', async t => {
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] }));
  let connects = 0;
  const transactions: Array<{ data: string; value: string }> = [];
  const provider = { request: async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === 'eth_sendTransaction') { transactions.push((params as typeof transactions)[0]); return `0x${'ab'.repeat(32)}`; }
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_getTransactionByHash') return null;
    return [owner];
  } };
  let view!: ReturnType<typeof page>;
  const disconnected: EthereumWallet = { ...wallet, address: null, provider: null, status: 'disconnected',
    connect() { connects++; view.rerenderPage({ wallet: { ...disconnected, status: 'connecting' } }); } };
  view = page({ wallet: disconnected });
  await waitFor(() => assert.ok(view.getByRole('radio', { name: 'Relic' })));
  fireEvent.click(view.getByRole('radio', { name: 'Relic' }));
  await waitFor(() => assert.equal((view.getByRole('radio', { name: 'Relic #18' }) as HTMLInputElement).disabled, false));
  fireEvent.click(view.getByRole('radio', { name: 'Relic #18' }));
  fireEvent.click(view.getByRole('button', { name: 'Claim' }));
  assert.equal(connects, 1);
  await act(async () => view.rerenderPage({ wallet: { ...wallet, provider } }));
  await waitFor(() => assert.equal(transactions.length, 1));
  assert.equal(transactions[0].data, encodeCall(ETHEREUM_FUNCTIONS.claimRelic, ['uint256'], [18]));
  assert.equal(transactions[0].value, '0x0');
  assert.equal(readEthereumDropOperations(ethereumInventoryScope(config, owner)!)[0].action, 'relic-claim');
  assert.equal(view.queryByRole('button', { name: 'Sign in to finish' }), null);
});

test('changing the connected wallet clears relic selection without discarding the metadata cache', async () => {
  const view = page();
  await waitFor(() => assert.ok(view.getByRole('radio', { name: 'Relic' })));
  fireEvent.click(view.getByRole('radio', { name: 'Relic' }));
  await waitFor(() => assert.equal((view.getByRole('radio', { name: 'Relic #18' }) as HTMLInputElement).disabled, false));
  fireEvent.click(view.getByRole('radio', { name: 'Relic #18' }));
  view.rerenderPage({ wallet: { ...wallet, address: '0x2222222222222222222222222222222222222222' } });
  await waitFor(() => assert.equal((view.getByRole('radio', { name: 'Relic #18' }) as HTMLInputElement).checked, false));
  assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, true);
  assert.ok(view.client.getQueryData(['ethereum111k', 'relic-metadata', config.chainId, contract, config.metadataBaseUri]));
});

for (const connected of [true, false]) test(`the ${connected ? 'connected' : 'guest'} drop has no Ethereum account, history, refresh or recovery controls`, async t => {
  const receipt = { ...item('2000001', 'crate_receipt'), name: 'Hidden receipt' };
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [receipt, item()], nextCursor: null, observedBlock: 10 }));
  const view = page({ wallet: connected ? wallet : { ...wallet, address: null, provider: null, status: 'disconnected' } });
  await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'config'])?.status, 'success'));
  if (connected) await waitFor(() => assert.equal(view.container.querySelectorAll('[data-inventory-id]').length, 1));
  assert.equal(view.queryByText('Hidden receipt'), null);
  assert.equal(view.queryByText(/111K (receipts|shipments)/), null);
  assert.equal(view.queryByRole('button', { name: /Refresh|Load more|View collection|Connect|Disconnect|Transaction changed|Recover|Send|Transfer receipt|Claim crate contents/i }), null);
  assert.equal(view.queryByText(owner), null);
  assert.equal(view.queryByRole('dialog'), null);
});

test('the combined inventory automatically loads every page and groups Ethereum containers before artworks and Solana', async t => {
  const artwork = { ...item('1', 'artwork'), name: 'Artwork #1', revealStatus: 'revealed' as const };
  const warehouse = { ...item('116667', 'warehouse'), name: 'Warehouse #1' };
  const relic = { ...item('117172', 'relic'), name: 'Relic #1' };
  const cursors: Array<string | null> = [];
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, cursor) => {
    cursors.push(cursor);
    return cursor ? { items: [relic, item()], nextCursor: null, observedBlock: 10 }
      : { items: [artwork, item(), warehouse], nextCursor: 'next', observedBlock: 10 };
  });
  const view = page({ solanaInventoryItems: [{ id: 'solana', dropId: 'card_nft_2', kind: 'box', name: 'Solana pack', image }] });
  await waitFor(() => assert.equal(view.container.querySelectorAll('[data-inventory-id]').length, 5));
  assert.deepEqual([...view.container.querySelectorAll<HTMLElement>('[data-inventory-id]')].map(node => node.dataset.inventoryId),
    [warehouse.id, relic.id, item().id, artwork.id, 'solana']);
  assert.deepEqual(cursors, [null, 'next']);
});

test('a pending mint blocks only its placeholders and permits another mint and unrelated selection', async () => {
  let sent = 0;
  const hashes = [`0x${'ab'.repeat(32)}`, `0x${'cd'.repeat(32)}`];
  const connected: EthereumWallet = { ...wallet, provider: { request: async ({ method }) => {
    if (method === 'eth_sendTransaction') return hashes[sent++];
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') return `0x${(7 + sent).toString(16)}`;
    if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') return null;
    return [owner];
  } } };
  const toggled: string[] = [];
  const view = page({ wallet: connected, solanaInventoryItems: [{ id: 'solana', dropId: 'card_nft_2', kind: 'box', name: 'Solana pack', image }],
    onSolanaToggle: id => toggled.push(id) });
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${item().id}"]`)));
  const mint = () => view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement;
  fireEvent.click(mint());
  await waitFor(() => assert.equal(sent, 1));
  await waitFor(() => assert.equal(mint().disabled, false));
  const pending = view.container.querySelector<HTMLElement>('[data-inventory-id^="ethereum-pending:"]')!;
  assert.equal(pending.getAttribute('aria-busy'), 'true');
  fireEvent.click(pending);
  fireEvent.keyDown(pending, { key: 'Enter' });
  assert.equal(view.queryByRole('button', { name: 'Open' }), null);
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${item().id}"]`)!);
  assert.equal((view.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled, false);
  fireEvent.click(view.container.querySelector('[data-inventory-id="solana"]')!);
  assert.deepEqual(toggled, ['solana']);
  fireEvent.click(mint());
  await waitFor(() => assert.equal(sent, 2));
  await waitFor(() => assert.equal(view.container.querySelectorAll('[data-inventory-id^="ethereum-pending:"]').length, 2));
  assert.equal(view.queryByText(/Confirming your transaction/), null);
});

test('a pending warehouse reserves shared supply while its remaining crates stay mintable', async t => {
  t.mock.method(ethereumApi, 'stats', async () => stats({ allocatedCrates: 5542, remainingCrates: 13, remainingWarehouses: 1 }));
  const transactions: Array<{ data: string }> = [];
  const connected: EthereumWallet = { ...wallet, provider: { request: async ({ method, params }) => {
    if (method === 'eth_sendTransaction') {
      transactions.push((params as typeof transactions)[0]);
      return `0x${String(transactions.length).padStart(64, '0')}`;
    }
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') return null;
    return [owner];
  } } };
  const view = page({ wallet: connected });
  await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'stats', config.chainId, contract, owner])?.status, 'success'));
  fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
  fireEvent.click(view.getByRole('button', { name: 'Mint0.0011 ETH' }));
  await waitFor(() => assert.equal(transactions.length, 1));
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Mint0.0011 ETH' }) as HTMLButtonElement).disabled, true));
  assert.equal(view.container.querySelector('.mint-panel__remaining-count')?.textContent, '000');
  assert.equal((view.getByRole('radio', { name: 'Crate' }) as HTMLInputElement).disabled, false);

  fireEvent.click(view.getByRole('radio', { name: 'Crate' }));
  const slider = view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement;
  assert.equal(slider.max, '2');
  assert.equal(view.container.querySelector('.mint-panel__remaining-count')?.textContent, '0002');
  fireEvent.change(slider, { target: { value: '2' } });
  const mintCrates = view.getByRole('button', { name: /Mint\s*2 crates/ }) as HTMLButtonElement;
  assert.equal(mintCrates.disabled, false);
  fireEvent.click(mintCrates);
  await waitFor(() => assert.equal(transactions.length, 2));
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Mint0.0001 ETH' }) as HTMLButtonElement).disabled, true));
  assert.equal(view.container.querySelector('.mint-panel__remaining-count')?.textContent, '0000');
  assert.equal(view.queryByRole('slider', { name: 'Mint quantity' }), null);
  fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
  assert.equal((view.getByRole('radio', { name: 'Warehouse' }) as HTMLInputElement).checked, true);
  assert.equal((view.getByRole('button', { name: 'Mint0.0011 ETH' }) as HTMLButtonElement).disabled, true);
  assert.deepEqual(transactions.map(transaction => transaction.data), [
    encodeCall(ETHEREUM_FUNCTIONS.mintWarehouses, ['uint256'], [1]),
    encodeCall(ETHEREUM_FUNCTIONS.mintCrates, ['uint256'], [2]),
  ]);
});

test('a pending discounted mint switches the next mint to public pricing when it reserves the global cap', async t => {
  t.mock.method(ethereumApi, 'stats', async () => stats({ discountMerkleRoot: `0x${'12'.repeat(32)}`,
    allocatedCrates: 9, remainingCrates: 5546, remainingWarehouses: 504,
    discountAllowance: 3, maxDiscountedMints: 10, totalDiscountedMints: 9 }));
  t.mock.method(ethereumDiscounts, 'proof', async () => []);
  const transactions: Array<{ data: string; value: string }> = [];
  const connected: EthereumWallet = { ...wallet, provider: { request: async ({ method, params }) => {
    if (method === 'eth_sendTransaction') {
      transactions.push((params as typeof transactions)[0]);
      return `0x${String(transactions.length).padStart(64, '0')}`;
    }
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') return null;
    return [owner];
  } } };
  const view = page({ wallet: connected });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Mint with discount for 0.00005 ETH. Regular price 0.0001 ETH.' })));
  fireEvent.click(view.getByRole('button', { name: 'Mint with discount for 0.00005 ETH. Regular price 0.0001 ETH.' }));
  await waitFor(() => assert.equal(transactions.length, 1));
  await waitFor(() => assert.equal((view.getByRole('button', { name: /Mint\s*1 crate.*0.0001 ETH/ }) as HTMLButtonElement).disabled, false));
  assert.equal(view.container.querySelector('.mint-panel__submit--discounted'), null);
  fireEvent.click(view.getByRole('button', { name: /Mint\s*1 crate.*0.0001 ETH/ }));
  await waitFor(() => assert.equal(transactions.length, 2));
  assert.deepEqual(transactions.map(transaction => transaction.data), [
    encodeCall(ETHEREUM_FUNCTIONS.mintCratesDiscounted, ['uint256', 'bytes32[]'], [1, []]),
    encodeCall(ETHEREUM_FUNCTIONS.mintCrates, ['uint256'], [1]),
  ]);
  assert.deepEqual(transactions.map(transaction => BigInt(transaction.value)), [50_000_000_000_000n, 100_000_000_000_000n]);
});

test('unpacking starts only from the static image inside the shared blurry overlay', async t => {
  const warehouse = { ...item('116667', 'warehouse'), name: 'Warehouse #1' };
  const hash = `0x${'ab'.repeat(32)}`;
  let sent = 0;
  const connected: EthereumWallet = { ...wallet, provider: { request: async ({ method }) => {
    if (method === 'eth_sendTransaction') { sent++; return hash; }
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_getTransactionByHash') return null;
    return [owner];
  } } };
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [warehouse], nextCursor: null, observedBlock: 10 }));
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'confirmed', confirmations: 1, items: [item()], burnedTokenIds: [warehouse.tokenId] }));
  const view = page({ wallet: connected });
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${warehouse.id}"]`)));
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${warehouse.id}"]`)!);
  assert.ok(document.querySelector('.selection-panel__thumb'));
  fireEvent.click(view.getByRole('button', { name: 'Open' }));
  const overlay = view.getByRole('dialog', { name: 'Warehouse #1 unboxing' });
  assert.ok(overlay.classList.contains('reveal-overlay'));
  assert.equal(overlay.querySelector('.modal__head'), null);
  assert.equal(sent, 0);
  const reveal = view.getByRole('button', { name: 'Reveal Warehouse #1' });
  fireEvent.click(reveal);
  fireEvent.click(reveal);
  await waitFor(() => assert.equal(sent, 1));
  await waitFor(() => assert.equal(overlay.querySelectorAll('.reveal-overlay__media-item').length, 1));
  assert.equal(view.queryByRole('button', { name: 'Transaction changed?' }), null);
});

test('a stored checkout and callback URL do not affect full-drop unpacking or start checkout requests', async t => {
  const warehouse = { ...item('116667', 'warehouse'), name: 'Warehouse #1' };
  const checkoutId = '11111111-1111-4111-8111-111111111111';
  window.history.replaceState(null, '', `/111k_devnet?checkout_id=${checkoutId}`);
  assert.equal(rememberCheckoutReservation({ checkoutId, dropId: '111k_devnet', chainId: config.chainId,
    contractAddress: contract, config, tokenIds: [warehouse.tokenId], items: [warehouse], unavailableTokenIds: [],
    wallet: owner, status: 'pending', orderId: 42, transactionHash: null, confirmations: 0, requiredConfirmations: 3,
    quoteExpiresAtMs: Date.now() + 60_000,
    attempt: { attemptId: '22222222-2222-4222-8222-222222222222', status: 'started', transactionHash: null },
  }), true);
  const reservationKey = Object.keys(window.localStorage).find(key => key.startsWith('mons.shop.ethereum-checkout-reservation:'))!;
  const reservation = window.localStorage.getItem(reservationKey);
  const status = t.mock.method(checkoutApi, 'status', async () => { throw new Error('Full drops must not check checkout status.'); });
  const refresh = t.mock.method(checkoutApi, 'refresh', async () => { throw new Error('Full drops must not refresh checkouts.'); });
  const transactions: Array<{ data: string }> = [];
  const connected: EthereumWallet = { ...wallet, provider: { request: async ({ method, params }) => {
    if (method === 'eth_sendTransaction') {
      transactions.push((params as typeof transactions)[0]);
      return `0x${'ab'.repeat(32)}`;
    }
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') return null;
    return [owner];
  } } };
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [warehouse], nextCursor: null, observedBlock: 10 }));
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'confirmed', confirmations: 1, items: [item()], burnedTokenIds: [warehouse.tokenId] }));
  const view = page({ wallet: connected });
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${warehouse.id}"]`)));
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${warehouse.id}"]`)!);
  fireEvent.click(view.getByRole('button', { name: 'Open' }));
  fireEvent.click(view.getByRole('button', { name: 'Reveal Warehouse #1' }));
  await waitFor(() => assert.equal(transactions.length, 1));
  assert.equal(transactions[0].data, encodeCall(ETHEREUM_FUNCTIONS.unboxWarehouse, ['uint256'], [warehouse.tokenId]));
  await waitFor(() => assert.equal(document.querySelectorAll('.reveal-overlay__media-item').length, 1));
  assert.equal(status.mock.callCount(), 0);
  assert.equal(refresh.mock.callCount(), 0);
  assert.equal(window.localStorage.getItem(reservationKey), reservation);
  assert.equal(checkoutReservesItems([warehouse]), true);
});

test('restoring a confirmed unpack updates inventory without presenting a reveal', async t => {
  const hash = `0x${'ef'.repeat(32)}`;
  const warehouse = { ...item('116667', 'warehouse'), name: 'Warehouse #1' };
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'unbox', submittedAt: Date.now(),
    intent: { to: contract, value: '0x0', data: encodeCall(ETHEREUM_FUNCTIONS.unboxWarehouse, ['uint256'], [warehouse.tokenId]) } });
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'confirmed', confirmations: 1, items: [item()], burnedTokenIds: [warehouse.tokenId] }));
  const view = page();
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${item().id}"]`)));
  await waitFor(() => assert.equal(readEthereumDropOperations(scope).length, 0));
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(document.querySelector('.reveal-overlay'), null);
});

test('viewing Ethereum artwork uses the shared fullscreen shell without modal or redemption chrome', async t => {
  const artwork = { ...item('1', 'artwork'), name: 'Artwork #1', revealStatus: 'revealed' as const, aspectRatio: { width: 3, height: 2 } };
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [artwork], nextCursor: null, observedBlock: 10 }));
  const view = page();
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${artwork.id}"]`)));
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${artwork.id}"]`)!);
  fireEvent.click(view.getByRole('button', { name: 'View' }));
  const overlay = view.getByRole('dialog', { name: 'Artwork #1 viewer' });
  assert.ok(overlay.classList.contains('reveal-overlay--viewer'));
  assert.equal(overlay.querySelector('.modal__head'), null);
  assert.equal(view.queryByRole('button', { name: /Send|Transfer|Claim|Close/ }), null);
});

for (const category of ['painting', 'video'] as const) test(`an open ${category} viewer receives recovered media and aspect ratio without reopening`, async t => {
  t.mock.method(dom.window.HTMLMediaElement.prototype, 'play', async () => {});
  t.mock.method(dom.window.HTMLMediaElement.prototype, 'pause', () => {});
  const artwork = { ...item('1', 'artwork'), name: 'Artwork #1', revealStatus: 'unrevealed' as const };
  const published: EthereumRevealedArtwork = {
    tokenId: '1', crateTokenId: '111112', name: 'Revealed artwork', description: '', category,
    image: 'https://wip.lil.org/reveal-test/1.webp', aspectRatio: { width: 2, height: 3 }, attributes: [],
    observation: { transactionHash: `0x${'ab'.repeat(32)}`, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: 10 },
    ...(category === 'video' ? { animation_url: 'https://wip.lil.org/reveal-test/1.mp4' } : {}),
  };
  const recovery = deferred<Awaited<ReturnType<typeof ethereumRevealApi.tokens>>>();
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [artwork], nextCursor: null, observedBlock: 10 }));
  t.mock.method(ethereumRevealApi, 'tokens', () => recovery.promise);
  const view = page();
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${artwork.id}"]`)));
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${artwork.id}"]`)!);
  fireEvent.click(view.getByRole('button', { name: 'View' }));
  const overlay = view.getByRole('dialog', { name: 'Artwork #1 viewer' });
  assert.equal(overlay.querySelector('img')!.getAttribute('src'), artwork.image);
  await act(async () => { recovery.resolve({ chainId: config.chainId, contractAddress: contract, dropId: config.dropId,
    deploymentId: 'test', artworks: [published], unresolved: [], retryAfterMs: 0 }); });
  await waitFor(() => assert.equal(overlay.querySelector('img')!.getAttribute('src'), published.image));
  assert.equal(view.getByRole('dialog', { name: 'Revealed artwork viewer' }), overlay);
  assert.ok(Math.abs(parseFloat(overlay.style.getPropertyValue('--reveal-target-width')) /
    parseFloat(overlay.style.getPropertyValue('--reveal-target-height')) - 2 / 3) < 0.01);
  if (category === 'video') assert.equal(overlay.querySelector('video')?.getAttribute('src'), published.animation_url);
  assert.equal(view.container.querySelector<HTMLElement>(`[data-inventory-id="${artwork.id}"]`)!.style.visibility, 'hidden');
});

function unpackWallet(hash: string): EthereumWallet {
  return { ...wallet, provider: { request: async ({ method }) => {
    if (method === 'eth_sendTransaction') return hash;
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') return null;
    return [owner];
  } } };
}

for (const source of ['reveal', 'confirmation'] as const) test(`an active ${source} unpack failure reports one toast and enables retry`, async t => {
  const hash = `0x${'ab'.repeat(32)}`;
  if (source === 'reveal') t.mock.method(ethereumRevealApi, 'transaction', async () => ({ chainId: config.chainId,
    contractAddress: contract, dropId: config.dropId, deploymentId: 'test', status: 'reverted', artworks: [], retryAfterMs: 0 }));
  else t.mock.method(ethereumApi, 'confirm', async () => { throw new EthereumApiError(409, 'Reverted', 'transaction-reverted'); });
  const toasts: string[] = [];
  const view = page({ wallet: unpackWallet(hash), showToast: message => toasts.push(message) });
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${item().id}"]`)));
  fireEvent.click(view.container.querySelector(`[data-inventory-id="${item().id}"]`)!);
  fireEvent.click(view.getByRole('button', { name: 'Open' }));
  const trigger = view.getByRole('button', { name: 'Reveal Crate #1' });
  fireEvent.click(trigger);
  await waitFor(() => assert.equal(toasts.length, 1));
  assert.match(toasts[0], /reverted/);
  assert.equal(trigger.getAttribute('aria-busy'), 'false');
  assert.equal(trigger.getAttribute('aria-disabled'), 'false');
  view.rerenderPage({ solanaInventoryItems: [] });
  assert.equal(toasts.length, 1);
});

for (const mode of ['closed', 'recovered'] as const) test(`${mode} unpack failures stay silent`, async t => {
  const hash = `0x${'ab'.repeat(32)}`;
  const scope = ethereumInventoryScope(config, owner)!;
  const confirmation = deferred<Awaited<ReturnType<typeof ethereumApi.confirm>>>();
  const request = t.mock.method(ethereumApi, 'confirm', () => confirmation.promise);
  if (mode === 'recovered') writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'unbox', submittedAt: Date.now(),
    intent: { to: contract, data: encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], ['111112']), value: '0x0' } });
  const toasts: string[] = [];
  const view = page({ wallet: unpackWallet(hash), showToast: message => toasts.push(message) });
  await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${item().id}"]`)));
  if (mode === 'closed') {
    fireEvent.click(view.container.querySelector(`[data-inventory-id="${item().id}"]`)!);
    fireEvent.click(view.getByRole('button', { name: 'Open' }));
    fireEvent.click(view.getByRole('button', { name: 'Reveal Crate #1' }));
    await waitFor(() => assert.ok(request.mock.callCount()));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => assert.equal(view.queryByRole('dialog'), null));
  } else await waitFor(() => assert.ok(request.mock.callCount()));
  await act(async () => { confirmation.reject(new EthereumApiError(409, 'Reverted', 'transaction-reverted')); });
  await waitFor(() => assert.equal(readEthereumDropOperations(scope).length, 0));
  assert.deepEqual(toasts, []);
  assert.equal(view.queryByRole('dialog'), null);
});
