import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { ETHEREUM_FUNCTIONS, ethereumAssetId } from '../shared/ethereum/protocol.ts';
import { encodeCall } from '../shared/ethereum/abi.ts';
import { ethereumReceiptIdsHash } from '../shared/ethereum/crypto.ts';
import type { EthereumInventoryItem, EthereumInventoryResponse, EthereumStats } from '../shared/ethereum/api.ts';
import type { EthereumWallet } from '../src/ethereum/useEthereum111k.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: Ethereum111kPage } = await import('../src/ethereum/Ethereum111kPage.tsx');
const { useMiNoteEthereumWallet } = await import('../src/hooks/useMiNoteEthereumWallet.ts');
const { ethereumApi } = await import('../src/ethereum/api.ts');
const { ethereumInventoryQueryKey, ethereumInventoryScope, writeEthereumStorage } = await import('../src/ethereum/state.ts');
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
};
function stats(overrides: Partial<EthereumStats> = {}): EthereumStats {
  return { allocatedCrates: 0, warehousesMinted: 0, artworksMinted: 0, cratePriceWei: config.cratePriceWei,
    warehousePriceWei: config.warehousePriceWei, saleActive: true, remainingCrates: 5555, remainingWarehouses: 505, ...overrides };
}
beforeEach(context => {
  const t = context as TestContext;
  ({ dom } = setupFrontendDom());
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => callback({}),
  } });
  window.history.replaceState(null, '', '/111k_devnet');
  t.mock.method(ethereumApi, 'config', async () => config);
  t.mock.method(ethereumApi, 'stats', async () => stats());
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [item()], nextCursor: null, observedBlock: 10 }));
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

test('the mint panel shares the drop frame and previews the selected crate quantity', async () => {
  const view = page({ header: createElement('header', {}, 'Shop header') });
  const crateImage = view.getByRole('img', { name: '111K crate' });
  assert.equal(crateImage.querySelector('text')?.textContent, '?');
  assert.equal(crateImage.getAttribute('viewBox'), '0 0 720 720');
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
  assert.equal(view.getByRole('group', { name: 'Container type' }).querySelectorAll('input[type="radio"]').length, 2);
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
  act(() => view.client.setQueryData(['ethereum111k', 'stats', config.chainId, config.contractAddress], stats({ remainingCrates: 2 })));
  await waitFor(() => assert.equal(quantity.value, '2'));
  assert.equal(quantity.max, '2');
  assert.ok(view.getByRole('button', { name: /Mint\s*2 crates.*0.0002 ETH/ }));
});

test('switching containers resets quantity and changes the preview, availability, price and supply limit', async t => {
  t.mock.method(ethereumApi, 'stats', async () => stats({
    allocatedCrates: 5543, remainingCrates: 12, warehousesMinted: 502, remainingWarehouses: 3,
  }));
  const view = page();
  const quantity = view.getByRole('slider', { name: 'Mint quantity' }) as HTMLInputElement;
  await waitFor(() => assert.equal(quantity.max, '12'));
  assert.match(view.container.querySelector('.mint-panel')!.textContent!, /12\s*\/\s*5555 left/);
  fireEvent.change(quantity, { target: { value: '4' } });
  fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
  assert.equal(quantity.value, '1');
  assert.equal(quantity.max, '3');
  assert.equal(view.queryByRole('img', { name: '111K crate' }), null);
  assert.equal(view.getAllByRole('img', { name: '111K warehouse' }).length, 1);
  assert.match(view.container.querySelector('.mint-panel')!.textContent!, /3\s*\/\s*505 left/);
  assert.ok(view.getByRole('button', { name: /Mint\s*1 warehouse.*0.0011 ETH/ }));
  fireEvent.change(quantity, { target: { value: '3' } });
  assert.equal(view.getAllByRole('img', { name: '111K warehouse' }).length, 3);
  assert.ok(view.getByRole('button', { name: /Mint\s*3 warehouses.*0.0033 ETH/ }));
  act(() => view.client.setQueryData(['ethereum111k', 'stats', config.chainId, config.contractAddress], stats({
    allocatedCrates: 5543, remainingCrates: 12, warehousesMinted: 503, remainingWarehouses: 2,
  })));
  await waitFor(() => assert.equal(quantity.value, '2'));
  assert.equal(quantity.max, '2');
  assert.match(view.container.querySelector('.mint-panel')!.textContent!, /2\s*\/\s*505 left/);
  fireEvent.click(view.getByRole('radio', { name: 'Crate' }));
  assert.equal(quantity.value, '1');
  assert.equal(quantity.max, '12');
  assert.equal(view.queryByRole('img', { name: '111K warehouse' }), null);
  assert.equal(view.getAllByRole('img', { name: '111K crate' }).length, 1);
  assert.ok(view.getByRole('button', { name: /Mint\s*1 crate.*0.0001 ETH/ }));
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

for (const kind of ['crate', 'warehouse'] as const) test(`disconnected mint connects once and submits the captured ${kind} quantity with exact wei pricing`, async t => {
  const unitPriceWei = '123456789012345678';
  t.mock.method(ethereumApi, 'stats', async () => stats({ [kind === 'crate' ? 'cratePriceWei' : 'warehousePriceWei']: unitPriceWei }));
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
  if (kind === 'warehouse') fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
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
  assert.equal(transactions[0].data, encodeCall(kind === 'crate' ? ETHEREUM_FUNCTIONS.mintCrates : ETHEREUM_FUNCTIONS.mintWarehouses, ['uint256'], [3]));
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
    if (kind === 'warehouse') fireEvent.click(view.getByRole('radio', { name: 'Warehouse' }));
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
      [kind === 'crate' ? 'cratePriceWei' : 'warehousePriceWei']: unitPriceWei,
    })); });
    if (status === 'restoring') {
      await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'stats', config.chainId, config.contractAddress])?.status, 'success'));
      assert.equal(view.transactions.length, 0);
      view.rerenderPage({ wallet: view.connected });
    }
    await waitFor(() => assert.equal(view.transactions.length, 1));
    assert.equal(view.transactions[0].to, contract);
    assert.equal(view.transactions[0].data, encodeCall(kind === 'crate' ? ETHEREUM_FUNCTIONS.mintCrates : ETHEREUM_FUNCTIONS.mintWarehouses, ['uint256'], [3]));
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
      await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'stats', config.chainId, config.contractAddress])?.fetchStatus, 'fetching'));
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
  assert.ok(view.getByRole('dialog', { name: 'Send for delivery' }));
  assert.equal(view.transactions.length, 0);
});

test('a queued mint disables existing selection actions and cancellation restores the delivery flow', async t => {
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
  await act(async () => { window.dispatchEvent(new window.Event('pagehide')); });
  assert.equal(send.disabled, false);
  fireEvent.click(send);
  assert.ok(view.getByRole('dialog', { name: 'Send for delivery' }));
  await act(async () => { view.availability.resolve(stats()); });
  await waitFor(() => assert.match(view.container.querySelector('.mint-panel')!.textContent!, /5555\s*\/\s*5555 left/));
  assert.ok(view.getByRole('dialog', { name: 'Send for delivery' }));
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
    await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'stats', config.chainId, config.contractAddress])?.fetchStatus, 'fetching'));
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
  const view = page({ wallet: disconnected, claimReceiptId: receipt.tokenId, claimCode: 'ABCDEF123456' });
  assert.ok(view.getByRole('dialog', { name: 'Claim crate contents' }));
  fireEvent.click(view.getByRole('button', { name: 'Connect wallet' }));
  assert.equal(connections, 1);
  view.rerenderPage({ wallet: { ...disconnected, status: 'connecting' } });
  view.rerenderPage({ wallet: connected });
  await waitFor(() => assert.equal((view.getByLabelText('Crate claim code') as HTMLInputElement).value, 'ABCDEF123456'));
  assert.ok(view.getByRole('dialog', { name: 'Crate receipt #1' }));
  assert.equal(transactions, 0);
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
    await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'stats', config.chainId, config.contractAddress])?.status, 'success'));
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

test('Ethereum and Solana appear in one inventory while selection dispatch stays on its own chain', async () => {
  let cleared = 0;
  const toggled: string[] = [];
  const view = page({
    solanaInventoryItems: [{ id: 'solana-item', dropId: 'card_nft_2', kind: 'box', name: 'Solana pack', image }],
    clearSolanaSelection() { cleared++; }, onSolanaToggle(id) { toggled.push(id); },
  });
  await waitFor(() => assert.equal(view.container.querySelectorAll('[data-inventory-id]').length, 2));
  const ethereumTile = view.container.querySelector(`[data-inventory-id="${item().id}"]`)!;
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
  const view = page();
  await waitFor(() => assert.ok(view.getByRole('dialog', { name: 'Your artworks' })));
  const reveal = document.querySelector('.ethereum111k__reveal-grid')!;
  assert.equal(reveal.querySelectorAll('button').length, 311);
  assert.ok(view.getByText('311 artworks'));
  assert.ok([...reveal.querySelectorAll('img')].every(image => image.getAttribute('loading') === 'lazy' && image.getAttribute('decoding') === 'async'));
  fireEvent.click(reveal.querySelectorAll('button')[310]);
  assert.ok(view.getByRole('dialog', { name: 'Artwork #311' }));
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

for (const dialog of ['delivery', 'recovery'] as const) {
  test(`a deferred claim link replaces the ${dialog} dialog and keeps the claim field focused`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    const crate = item();
    const receipt = item('2000001', 'crate_receipt');
    let finishInventory!: (response: EthereumInventoryResponse) => void;
    const inventoryResponse = new Promise<EthereumInventoryResponse>(resolve => { finishInventory = resolve; });
    t.mock.method(ethereumApi, 'inventory', () => inventoryResponse);
    if (dialog === 'recovery') {
      writeEthereumStorage(`${scope}:pending`, { scope, hash: `0x${'ab'.repeat(32)}`, action: 'mint', submittedAt: Date.now() });
      t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] }));
    }
    window.history.replaceState(null, '', '/111k_devnet?receiptId=2000001&claim=ABCDEF123456');
    const view = page({ claimReceiptId: '2000001', claimCode: 'ABCDEF123456' }, client => {
      client.setQueryData(['ethereum111k', 'config'], config);
      client.setQueryData(ethereumInventoryQueryKey(scope), {
        pageParams: [null], pages: [{ items: [crate], nextCursor: null, observedBlock: 10 }],
      });
    });
    const previousTitle = dialog === 'delivery' ? 'Send for delivery' : 'Recover a pending transaction';
    if (dialog === 'delivery') {
      fireEvent.click(view.container.querySelector(`[data-inventory-id="${crate.id}"]`)!);
      fireEvent.click(view.getByRole('button', { name: 'Send' }));
    } else {
      await waitFor(() => assert.ok(view.getByRole('button', { name: 'Transaction changed?' })));
      fireEvent.click(view.getByRole('button', { name: 'Transaction changed?' }));
      fireEvent.click(view.getByRole('button', { name: 'Stop tracking…' }));
    }
    assert.ok(view.getByRole('dialog', { name: previousTitle }));
    await act(async () => { finishInventory({ items: [crate, receipt], nextCursor: null, observedBlock: 11 }); });
    await waitFor(() => assert.ok(view.getByRole('dialog', { name: 'Crate receipt #1' })));
    assert.equal(view.queryAllByRole('dialog').length, 1);
    assert.equal(view.queryByRole('dialog', { name: previousTitle }), null);
    const claimInput = view.getByLabelText('Crate claim code') as HTMLInputElement;
    assert.equal(claimInput.value, 'ABCDEF123456');
    act(() => claimInput.focus());
    assert.equal(document.activeElement, claimInput);
  });
}

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
  const view = page();
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Recover transaction' })));
  assert.equal((view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement).disabled, true);
  assert.ok(view.getByText('Check your wallet. The previous transaction may have been sent.'));
  fireEvent.click(view.getByRole('button', { name: 'Recover transaction' }));
  assert.ok(view.getByLabelText('Transaction hash'));
  assert.ok(view.getByRole('button', { name: 'Track transaction' }));
  fireEvent.click(view.getByRole('button', { name: 'Stop tracking…' }));
  assert.ok(view.getByText(/The original transaction may still execute/));
  fireEvent.click(view.getByRole('button', { name: 'Stop tracking this transaction' }));
  await waitFor(() => assert.equal(view.queryByRole('button', { name: 'Recover transaction' }), null));
  assert.equal((view.getByRole('button', { name: /Mint\s*1 crate/ }) as HTMLButtonElement).disabled, false);
});

for (const initialChain of ['0xaa36a7', '0x1']) for (const outcome of ['rejected', 'submitted', 'unknown'] as const) {
  test(`delivery drafts from chain ${initialChain} survive wallet approval and handle ${outcome} submissions`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    window.sessionStorage.setItem(`ethereum111k:${scope}:session`, JSON.stringify({
      token: 'session', address: owner, chainId: config.chainId, dropId: config.dropId, expiresAtMs: Date.now() + 3_600_000,
    }));
    t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
    t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
    t.mock.method(ethereumApi, 'saveAddress', async body => ({ address: { ...body, id: 'A'.repeat(20) } }));
    t.mock.method(ethereumApi, 'prepareDelivery', async ids => {
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const signature = `0x${'ab'.repeat(65)}`;
      const receiptIdsHash = ethereumReceiptIdsHash(['2000001']);
      return { orderId: 42, expiresAtMs: deadline * 1000, signature,
        quote: { orderId: 42, wallet: owner, fee: config.deliveryFeeWei, deadline, receiptIdsHash },
        transaction: { to: contract, chainId: config.chainId, value: `0x${BigInt(config.deliveryFeeWei).toString(16)}`,
          data: encodeCall('redeemForDelivery(uint256[],(uint256,address,uint256,uint256,bytes32),bytes)',
            ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'],
            [ids, [42, owner, config.deliveryFeeWei, deadline, receiptIdsHash], signature]) } };
    });
    t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] }));
    let approve: ((hash: string) => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    let currentChain = initialChain;
    const chainListeners = new Set<(chain: unknown) => void>();
    const changeChain = (chain: string) => { currentChain = chain; chainListeners.forEach(listener => listener(chain)); };
    const sendingWallet: EthereumWallet = { ...wallet, provider: {
      on(event, listener) { if (event === 'chainChanged') chainListeners.add(listener); },
      removeListener(event, listener) { if (event === 'chainChanged') chainListeners.delete(listener); },
      request: async ({ method }) => {
        if (method === 'wallet_switchEthereumChain') { changeChain('0xaa36a7'); return null; }
        if (method === 'eth_sendTransaction') return new Promise<string>((resolve, fail) => { approve = resolve; reject = fail; });
        if (method === 'eth_chainId') return currentChain;
        if (method === 'eth_getTransactionCount') return '0x7';
        if (method === 'eth_getTransactionByHash') return null;
        return [owner];
      },
    } };
    const view = page({ wallet: sendingWallet, addressEncryptionPublicKey: 'OeuwTqGXImT/vfBBV6j6G89Hs6tU1Ij5+Gd2fQSCQB4=' });
    await waitFor(() => assert.ok(view.container.querySelector(`[data-inventory-id="${item().id}"]`)));
    fireEvent.click(view.container.querySelector(`[data-inventory-id="${item().id}"]`)!);
    fireEvent.click(view.getByRole('button', { name: 'Send' }));
    const fields = { Email: 'test@example.com', 'Full name': 'Example User', 'Address line 1': '123 Example Street',
      City: 'Portland', 'State / Region': 'OR', 'Postal code': '97201' };
    for (const [label, value] of Object.entries(fields)) fireEvent.change(view.getByLabelText(label), { target: { value } });
    const nameInput = view.getByLabelText('Full name');
    fireEvent.click(view.getByRole('button', { name: /Send for .* ETH/ }));
    await waitFor(() => assert.ok(approve && reject));
    assert.ok(view.getAllByRole('radio').every(input => input.matches(':disabled')));
    assert.ok(view.getByRole('dialog', { name: 'Send for delivery' }));
    assert.equal(view.getByLabelText('Full name'), nameInput);
    await act(async () => {
      if (outcome === 'submitted') approve!(`0x${'ab'.repeat(32)}`);
      else reject!(outcome === 'rejected' ? Object.assign(new Error('Rejected'), { code: 4001 }) : new Error('Wallet connection failed'));
    });
    if (outcome === 'rejected') {
      await waitFor(() => assert.ok(view.getAllByText('Request cancelled in your wallet.').length));
      assert.equal(view.getByLabelText('Full name'), nameInput);
      for (const [label, value] of Object.entries(fields)) assert.equal((view.getByLabelText(label) as HTMLInputElement).value, value);
      assert.ok(view.getByText('1 selected · test order, no physical shipment.'));
      assert.equal((view.getByRole('button', { name: /Send for .* ETH/ }) as HTMLButtonElement).disabled, false);
      act(() => changeChain('0x1'));
      assert.equal(view.queryByRole('dialog', { name: 'Send for delivery' }), null);
      assert.equal(view.queryByRole('button', { name: 'Send' }), null);
    } else {
      await waitFor(() => assert.equal(view.queryByRole('dialog', { name: 'Send for delivery' }), null));
      assert.ok(view.getByRole('button', { name: outcome === 'submitted' ? 'Transaction changed?' : 'Recover transaction' }));
    }
  });
}

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
