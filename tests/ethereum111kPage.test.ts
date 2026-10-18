import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { ethereumAssetId } from '../shared/ethereum/protocol.ts';
import { encodeCall } from '../shared/ethereum/abi.ts';
import { ethereumReceiptIdsHash } from '../shared/ethereum/crypto.ts';
import type { EthereumInventoryItem, EthereumInventoryResponse } from '../shared/ethereum/api.ts';
import type { EthereumWallet } from '../src/ethereum/useEthereum111k.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: Ethereum111kPage } = await import('../src/ethereum/Ethereum111kPage.tsx');
const { ethereumApi } = await import('../src/ethereum/api.ts');
const { ethereumContainerPreview } = await import('../src/ethereum/preview.ts');
const { ethereumInventoryQueryKey, ethereumInventoryScope, writeEthereumStorage } = await import('../src/ethereum/state.ts');
dom.window.close();
const clients: InstanceType<typeof QueryClient>[] = [];
const owner = '0x1111111111111111111111111111111111111111';
const contract = '0x3333333333333333333333333333333333333333';
const config = resolveEthereum111kConfig({ contractAddress: contract });
const image = ethereumContainerPreview('crate');
function item(tokenId = '111112', kind: EthereumInventoryItem['kind'] = 'crate'): EthereumInventoryItem {
  return { id: ethereumAssetId(config.chainId, contract, tokenId), tokenId, kind, name: kind === 'crate_receipt' ? 'Crate receipt #1' : 'Crate #1', displayId: 1,
    chainId: config.chainId, contractAddress: contract, owner, image };
}
const wallet: EthereumWallet = {
  address: owner, provider: { request: async ({ method }) => method === 'eth_chainId' ? '0xaa36a7' : method === 'eth_getTransactionCount' ? '0x7' : [owner] },
  ready: true, status: 'connected', wallets: [], error: null,
  connect() {}, cancel() {}, disconnect() {}, selectWallet() {},
};
beforeEach(context => {
  const t = context as TestContext;
  ({ dom } = setupFrontendDom());
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => callback({}),
  } });
  window.history.replaceState(null, '', '/111k_devnet');
  t.mock.method(ethereumApi, 'config', async () => config);
  t.mock.method(ethereumApi, 'stats', async () => ({ allocatedCrates: 0, warehousesMinted: 0, artworksMinted: 0,
    cratePriceWei: config.cratePriceWei, warehousePriceWei: config.warehousePriceWei, saleActive: true, remainingCrates: 5555, remainingWarehouses: 505 }));
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [item()], nextCursor: null, observedBlock: 10 }));
  t.mock.method(ethereumApi, 'preview', async kind => ethereumContainerPreview(kind as 'crate' | 'warehouse'));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); dom.window.close(); });
function page(overrides: Partial<Parameters<typeof Ethereum111kPage>[0]> = {}, initialize?: (client: InstanceType<typeof QueryClient>) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  initialize?.(client);
  return { ...render(createElement(QueryClientProvider, { client }, createElement(Ethereum111kPage, {
    wallet, addressEncryptionPublicKey: '', solanaInventoryItems: [], solanaSelected: new Set<string>(),
    onSolanaToggle() {}, clearSolanaSelection() {}, pendingRevealIds: new Set<string>(), onSolanaReveal() {}, onSolanaView() {},
    canOpenSolanaBoxes: () => true, solanaRevealLoading: null, solanaInventoryReady: true,
    ...overrides,
  }))), client };
}

test('the mint panel switches crate and warehouse previews, supports fifteen, and names the 31-artwork crate', async () => {
  const view = page();
  await waitFor(() => assert.ok(view.getByText('5,555 crates available')));
  assert.ok(view.getByText('A crate of 20 artworks. Crate #5555 holds 31.'));
  const crateImage = view.getByAltText('111k crate') as HTMLImageElement;
  assert.ok(crateImage.src.startsWith('data:image/svg+xml,'));
  fireEvent.click(view.getByLabelText('Warehouse'));
  assert.ok(view.getByText('One warehouse. Eleven crates.'));
  assert.ok(view.getByAltText('111k warehouse'));
  const quantity = view.getByRole('slider', { name: /Quantity/ }) as HTMLInputElement;
  assert.equal(quantity.max, '15');
  fireEvent.change(quantity, { target: { value: '15' } });
  assert.ok(view.getByRole('button', { name: /Mint 15 warehouses.*0.0165 ETH/ }));
  assert.ok(view.getByText('Testnet only. Test ETH; no physical shipments.'));
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
  const key = `mons.ethereum111k:${scope}:pending`;
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
  await waitFor(() => assert.ok(view.getByText('Testnet deployment pending')));
  assert.equal((view.getByRole('button', { name: /Mint 1 crate/ }) as HTMLButtonElement).disabled, true);
});

test('an interrupted submission blocks minting and offers hash recovery or explicit stop tracking', async () => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash: `0x${'0'.repeat(64)}`, awaitingHash: true, action: 'mint', submittedAt: Date.now(),
    intent: { to: contract, data: '0x1234', value: '0x1' } });
  const view = page();
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Recover transaction' })));
  assert.equal((view.getByRole('button', { name: /Mint 1 crate/ }) as HTMLButtonElement).disabled, true);
  assert.ok(view.getByText('Check your wallet. The previous transaction may have been sent.'));
  fireEvent.click(view.getByRole('button', { name: 'Recover transaction' }));
  assert.ok(view.getByLabelText('Transaction hash'));
  assert.ok(view.getByRole('button', { name: 'Track transaction' }));
  fireEvent.click(view.getByRole('button', { name: 'Stop tracking…' }));
  assert.ok(view.getByText(/The original transaction may still execute/));
  fireEvent.click(view.getByRole('button', { name: 'Stop tracking this transaction' }));
  await waitFor(() => assert.equal(view.queryByRole('button', { name: 'Recover transaction' }), null));
  assert.equal((view.getByRole('button', { name: /Mint 1 crate/ }) as HTMLButtonElement).disabled, false);
});

for (const initialChain of ['0xaa36a7', '0x1']) for (const outcome of ['rejected', 'submitted', 'unknown'] as const) {
  test(`delivery drafts from chain ${initialChain} survive wallet approval and handle ${outcome} submissions`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    window.sessionStorage.setItem(`mons.ethereum111k:${scope}:session`, JSON.stringify({
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
  await waitFor(() => assert.ok(view.getByText('5,555 crates available')));
  fireEvent.click(view.getByRole('button', { name: /Mint 1 crate/ }));
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

  fireEvent.click(view.getByRole('button', { name: /Mint 1 crate/ }));
  await waitFor(() => assert.equal(sends, 2));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Transaction changed?' })));
  assert.equal(Boolean(view.queryByRole('dialog', { name: 'Recover a pending transaction' })), false);
  fireEvent.click(view.getByRole('button', { name: 'Transaction changed?' }));
  assert.equal((view.getByLabelText('Replacement transaction hash') as HTMLInputElement).value, '');
  assert.ok(view.getByRole('button', { name: 'Stop tracking…' }));
  assert.equal(Boolean(view.queryByRole('button', { name: 'Stop tracking this transaction' })), false);
});
