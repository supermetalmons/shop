import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement, type PropsWithChildren } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { decodeReturn, encodeAbi, encodeCall, ETHEREUM_EVENT_TOPICS } from '../shared/ethereum/abi.ts';
import { ethereumReceiptIdsHash } from '../shared/ethereum/crypto.ts';
import { ethereumAssetId } from '../shared/ethereum/protocol.ts';
import type { EthereumInventoryItem, EthereumInventoryResponse, EthereumSession, EthereumTransactionConfirmResponse } from '../shared/ethereum/api.ts';
import type { EIP1193Provider } from '../src/wallet/injectedEthereumProviders.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useEthereum111k } = await import('../src/ethereum/useEthereum111k.ts');
const { ethereumApi, EthereumApiError } = await import('../src/ethereum/api.ts');
const { ethereumInventoryScope, readEthereumExpected, readEthereumOperation, readEthereumPending, readEthereumSession, readEthereumSubmission, reserveEthereumSubmission, saveEthereumSession, writeEthereumStorage } = await import('../src/ethereum/state.ts');
type Wallet = Parameters<typeof useEthereum111k>[0];
dom.window.close();

const owner = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const contract = '0x3333333333333333333333333333333333333333';
const hash = `0x${'ab'.repeat(32)}`;
const config = resolveEthereum111kConfig({ contractAddress: contract });
const statistics = { allocatedCrates: 0, warehousesMinted: 0, artworksMinted: 0, cratePriceWei: config.cratePriceWei, warehousePriceWei: config.warehousePriceWei, saleActive: true, remainingCrates: 5555, remainingWarehouses: 505 };
const clients: InstanceType<typeof QueryClient>[] = [];

beforeEach(context => {
  const t = context as TestContext;
  ({ dom } = setupFrontendDom());
  const held = new Set<string>();
  const waiting = new Map<string, (() => void)[]>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    async request(name: string, options: { ifAvailable?: boolean }, callback: (lock: object | null) => unknown) {
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        await new Promise<void>(resolve => {
          const queue = waiting.get(name) ?? [];
          queue.push(resolve);
          waiting.set(name, queue);
        });
      } else held.add(name);
      try { return await callback({ name }); }
      finally {
        const next = waiting.get(name)?.shift();
        if (next) next();
        else held.delete(name);
      }
    },
  } });
  t.mock.method(ethereumApi, 'config', async () => config);
  t.mock.method(ethereumApi, 'stats', async () => statistics);
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [], nextCursor: null, observedBlock: 1 }));
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'pending', confirmations: 1, items: [], burnedTokenIds: [] }));
});
afterEach(async () => {
  await act(async () => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
  dom.window.close();
});

function token(address = owner, tokenId = '111112'): EthereumInventoryItem {
  return { id: ethereumAssetId(config.chainId, contract, tokenId), tokenId, chainId: config.chainId, contractAddress: contract,
    owner: address, displayId: 1, kind: 'crate', name: 'Crate #1', image: 'data:image/svg+xml,%3Csvg/%3E' };
}
function wallet(address: string | null = owner): Wallet & { sent: unknown[]; connections: number } {
  const sent: unknown[] = [];
  const provider: EIP1193Provider = { request: async ({ method, params }) => {
    if (method === 'eth_accounts') return address ? [address] : [];
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionCount') { assert.deepEqual(params, [address, 'pending']); return '0x7'; }
    if (method === 'eth_sendTransaction') { sent.push(params); return hash; }
    throw new Error(`Unexpected ${method}`);
  } };
  const result: Wallet & { sent: unknown[]; connections: number } = {
    address, provider: address ? provider : null, status: address ? 'connected' : 'disconnected', ready: true,
    wallets: [], error: null, connect() { result.connections++; }, disconnect() {}, cancel() {}, selectWallet() {},
    sent, connections: 0,
  };
  return result;
}
function harness(initialWallet = wallet(), strict = false, encryptionKey = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return { ...renderHook(({ wallet: current }) => useEthereum111k(current, encryptionKey), { initialProps: { wallet: initialWallet }, wrapper, reactStrictMode: strict }), client };
}
function speedUpConfirmationPolls(t: TestContext) {
  const schedule = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    schedule(callback, delay === 4_000 ? 25 : delay, ...args));
}

test('111k auto-connect waits for quiet restoration and prompts once even in StrictMode', async () => {
  const disconnected = wallet(null);
  disconnected.ready = false;
  const view = harness(disconnected, true);
  assert.equal(disconnected.connections, 0);
  view.rerender({ wallet: { ...disconnected, ready: true } });
  await waitFor(() => assert.equal(disconnected.connections, 1));
  view.rerender({ wallet: { ...disconnected, ready: true, error: 'Cancelled' } });
  await act(async () => { await Promise.resolve(); });
  assert.equal(disconnected.connections, 1);
});

test('Ethereum inventory works without a Solana wallet and discards late results from another owner', async t => {
  let finishFirst: (result: EthereumInventoryResponse) => void = () => {};
  t.mock.method(ethereumApi, 'inventory', async (_config, address) => address === owner
    ? await new Promise<EthereumInventoryResponse>(resolve => { finishFirst = resolve; })
    : { items: [token(other)], nextCursor: null, observedBlock: 2 });
  const view = harness();
  await waitFor(() => assert.equal(view.result.current.inventory.isFetching, true));
  view.rerender({ wallet: wallet(other) });
  await waitFor(() => assert.equal(view.result.current.items[0]?.owner, other));
  await act(async () => { finishFirst({ items: [token(owner)], nextCursor: null, observedBlock: 1 }); });
  assert.ok(view.result.current.items.every(item => item.owner === other));
  view.rerender({ wallet: wallet(null) });
  assert.deepEqual(view.result.current.items, []);
});

test('one mint transaction is captured, confirmed and reconciled through expected token IDs', async t => {
  let confirmed = false;
  const minted = token();
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: confirmed ? 'confirmed' : 'pending', confirmations: 1, items: confirmed ? [minted] : [], burnedTokenIds: [] }));
  t.mock.method(ethereumApi, 'inventory', async (_config, _address, _cursor, _signal, expected = []) => ({ items: expected.includes(minted.tokenId) ? [minted] : [], nextCursor: null, observedBlock: 4 }));
  const connected = wallet();
  const view = harness(connected);
  await waitFor(() => assert.equal(view.result.current.stats.data?.saleActive, true));
  await act(async () => { assert.equal(await view.result.current.mint('crate', 2), true); });
  assert.equal(connected.sent.length, 1);
  const sent = (connected.sent[0] as [{ value: string; from: string; to: string }])[0];
  assert.equal(BigInt(sent.value), BigInt(config.cratePriceWei) * 2n);
  assert.equal(sent.from, owner);
  assert.equal(sent.to, contract);
  const scope = ethereumInventoryScope(config, owner)!;
  assert.equal(readEthereumPending(scope)?.hash, hash);
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), false); });
  assert.equal(connected.sent.length, 1);
  confirmed = true;
  act(() => view.result.current.refresh());
  await waitFor(() => assert.equal(view.result.current.pending, null));
  await waitFor(() => assert.equal(view.result.current.items[0]?.id, minted.id));
  assert.deepEqual(readEthereumExpected(scope), [minted.tokenId]);
});

test('a captured pending transaction recovers only for its Ethereum account', async () => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: Date.now() });
  const view = harness();
  await waitFor(() => assert.equal(view.result.current.pending?.hash, hash));
  await waitFor(() => assert.equal(view.result.current.confirmations, 1));
  view.rerender({ wallet: wallet(other) });
  assert.equal(view.result.current.pending, null);
  assert.equal(readEthereumPending(scope)?.hash, hash);
  await waitFor(() => assert.equal(view.result.current.inventory.isFetching, false));
});

test('dismissing a polling error preserves recovery and allows later errors and confirmation', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let failure: Error | null = new EthereumApiError(503, 'RPC temporarily unavailable');
  const confirm = t.mock.method(ethereumApi, 'confirm', async () => {
    if (failure) throw failure;
    return { status: 'confirmed' as const, confirmations: 1, items: [token()], burnedTokenIds: [] };
  });
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: now });
  const view = harness();
  await waitFor(() => assert.equal(view.result.current.error, 'RPC temporarily unavailable'));
  act(() => view.result.current.clearError());
  assert.equal(view.result.current.error, null);
  assert.equal(readEthereumPending(scope)?.hash, hash);
  now += 4_000;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
  await waitFor(() => assert.equal(view.result.current.error, 'RPC temporarily unavailable'));
  failure = null;
  now += 4_000;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
  await waitFor(() => assert.equal(view.result.current.pending, null));
  assert.equal(view.result.current.error, null);
  assert.ok(confirm.mock.callCount() >= 3);
});

test('a dismissed polling error does not hide errors for a replacement transaction', async t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(ethereumApi, 'confirm', async () => { throw new EthereumApiError(503, 'RPC temporarily unavailable'); });
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: now });
  const view = harness();
  await waitFor(() => assert.equal(view.result.current.error, 'RPC temporarily unavailable'));
  act(() => view.result.current.clearError());
  assert.equal(view.result.current.error, null);
  act(() => writeEthereumStorage(`${scope}:pending`, { scope, hash: `0x${'cd'.repeat(32)}`, action: 'mint', submittedAt: now }));
  await waitFor(() => assert.equal(view.result.current.error, 'RPC temporarily unavailable'));
});

test('an explicitly reverted transaction clears recovery; unknown transactions remain pending', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: Date.now() });
  t.mock.method(ethereumApi, 'confirm', async () => { throw new EthereumApiError(409, 'Reverted', 'transaction-reverted'); });
  const view = harness();
  await waitFor(() => assert.match(view.result.current.error ?? '', /reverted/));
  assert.equal(view.result.current.pending, null);
  assert.equal(readEthereumPending(scope), null);
});

test('ambiguous successful mints keep tracking and block another purchase', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: Date.now() });
  t.mock.method(ethereumApi, 'confirm', async () => {
    throw new EthereumApiError(409, 'This transaction contains multiple matching operations.', 'operation-ambiguous');
  });
  const connected = wallet();
  const view = harness(connected);
  await waitFor(() => assert.match(view.result.current.error ?? '', /multiple matching operations/));
  assert.equal(readEthereumPending(scope)?.hash, hash);
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), false); });
  assert.equal(connected.sent.length, 0);
  assert.equal(readEthereumPending(scope)?.hash, hash);
});

for (const action of ['delivery', 'claim'] as const) {
  test(`a re-mined ${action} without its operation restores inventory and clears failed tracking`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    const original: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '111112' : '2000001'),
      kind: action === 'delivery' ? 'crate' : 'crate_receipt' };
    const receipt: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '2000001' : '1000001'),
      kind: action === 'delivery' ? 'crate_receipt' : 'artwork_receipt' };
    let state: 'included' | 'pending' | 'failed' = 'included';
    writeEthereumStorage(`${scope}:pending`, { scope, hash, action, orderId: 42, claimId: hash, submittedAt: Date.now() });
    writeEthereumStorage(`${scope}:expected`, [original.tokenId]);
    t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({
      items: [state === 'included' ? receipt : original].filter(item => expected.includes(item.tokenId)), nextCursor: null, observedBlock: 10,
    }));
    const confirm = t.mock.method(ethereumApi, 'confirm', async () => {
      if (state === 'failed') throw new EthereumApiError(409, 'The Ethereum operation did not succeed.', 'operation-failed');
      return { status: state === 'included' ? 'confirmed' : 'pending', confirmations: 1,
        items: state === 'included' ? [receipt] : [], burnedTokenIds: state === 'included' ? [original.tokenId] : [] };
    });
    const view = harness();
    await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]));
    assert.equal(confirm.mock.calls[0].arguments[4]?.action, action);
    state = 'pending';
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
    assert.equal(readEthereumPending(scope)?.hash, hash);
    state = 'failed';
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.equal(view.result.current.pending, null));
    assert.match(view.result.current.error ?? '', /operation did not succeed/);
    assert.ok(readEthereumExpected(scope).includes(original.tokenId));
  });
}

test('Ethereum delivery sends once, encrypts the address and automatically publishes at three confirmations', async t => {
  speedUpConfirmationPolls(t);
  let confirmations = 1;
  let published = 0;
  let confirmationAttempts = 0;
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'confirmed', confirmations, items: [], burnedTokenIds: ['111112'] }));
  t.mock.method(ethereumApi, 'confirmDelivery', async () => {
    confirmationAttempts++;
    if (confirmationAttempts === 1) return { status: 'pending', confirmations: 2 };
    published++;
    return { status: 'confirmed', confirmations: 3 };
  });
  const scope = ethereumInventoryScope(config, owner)!;
  window.sessionStorage.setItem(`ethereum111k:${scope}:session`, JSON.stringify({
    token: 'ethereum-session', address: owner, chainId: config.chainId, dropId: '111k_devnet', expiresAtMs: Date.now() + 3_600_000,
  }));
  t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
  t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
  let savedEncrypted = '';
  t.mock.method(ethereumApi, 'saveAddress', async (body, session) => {
    assert.equal(session.address, owner);
    savedEncrypted = body.encrypted;
    return { address: { ...body, id: 'saved-ethereum-address' } };
  });
  t.mock.method(ethereumApi, 'prepareDelivery', async (ids, addressId, requestId, session) => {
    assert.deepEqual(ids, ['111112']);
    assert.equal(addressId, 'saved-ethereum-address');
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.equal(session.address, owner);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const signature = `0x${'ab'.repeat(65)}`;
    const receiptIdsHash = ethereumReceiptIdsHash(['2000001']);
    return { orderId: 42, expiresAtMs: deadline * 1000, signature, quote: { orderId: 42, wallet: owner, fee: config.deliveryFeeWei, deadline, receiptIdsHash },
      transaction: { to: contract, data: encodeCall('redeemForDelivery(uint256[],(uint256,address,uint256,uint256,bytes32),bytes)', ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'], [ids, [42, owner, config.deliveryFeeWei, deadline, receiptIdsHash], signature]), value: `0x${BigInt(config.deliveryFeeWei).toString(16)}`, chainId: config.chainId } };
  });
  const connected = wallet();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const view = renderHook(() => useEthereum111k(connected, 'OeuwTqGXImT/vfBBV6j6G89Hs6tU1Ij5+Gd2fQSCQB4='), { wrapper });
  await waitFor(() => assert.ok(view.result.current.session));
  await act(async () => { assert.equal(await view.result.current.deliver([token()], { formatted: 'Test Name\n123 Example Street', country: 'United States', countryCode: 'US', email: 'test@example.com' }), true); });
  assert.ok(savedEncrypted.length > 60);
  assert.ok(!savedEncrypted.includes('Example Street'));
  assert.equal(readEthereumPending(scope)?.orderId, 42);
  assert.equal(connected.sent.length, 1);
  await waitFor(() => assert.equal(view.result.current.confirmations, 1));
  assert.equal(view.result.current.error, null);
  assert.equal(published, 0);
  confirmations = 2;
  await waitFor(() => assert.equal(view.result.current.confirmations, 2));
  assert.equal(published, 0);
  assert.equal(view.result.current.error, null);
  confirmations = 3;
  await waitFor(() => assert.equal(view.result.current.pending, null));
  assert.equal(published, 1);
  assert.equal(confirmationAttempts, 2);
  assert.equal(connected.sent.length, 1);
  assert.equal(readEthereumPending(scope), null);
});

for (const differentArtworkOrder of [false, true]) test(`delivery sorts a copy of mixed tokens numerically${differentArtworkOrder ? ' when artwork numbers have another order' : ''}`, async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  saveEthereumSession(scope, {
    token: 'ethereum-session', address: owner, chainId: config.chainId, dropId: config.dropId, expiresAtMs: Date.now() + 3_600_000,
  });
  t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
  t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
  t.mock.method(ethereumApi, 'saveAddress', async body => ({ address: { ...body, id: 'saved-ethereum-address' } }));
  const selected: EthereumInventoryItem[] = [
    token(),
    { ...token(owner, '10'), kind: 'artwork', displayId: 850, name: 'Artwork #850' },
    { ...token(owner, '2'), kind: 'artwork', displayId: 842, name: 'Artwork #842' },
  ];
  if (differentArtworkOrder) selected.push({ ...token(owner, '21'), kind: 'artwork', displayId: 1, name: 'Artwork #1' });
  const originalSelection = structuredClone(selected);
  Object.freeze(selected);
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: selected, nextCursor: null, observedBlock: 1 }));
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const signature = `0x${'ab'.repeat(65)}`;
  const tokenIds = differentArtworkOrder ? ['2', '10', '21', '111112'] : ['2', '10', '111112'];
  const receiptIdsHash = ethereumReceiptIdsHash(differentArtworkOrder ? ['1000842', '1000850', '1000001', '2000001'] : ['1000842', '1000850', '2000001']);
  const prepare = t.mock.method(ethereumApi, 'prepareDelivery', async ids => {
    assert.deepEqual(ids, tokenIds);
    return { orderId: 42, expiresAtMs: deadline * 1000, signature, quote: { orderId: 42, wallet: owner, fee: config.deliveryFeeWei, deadline, receiptIdsHash },
      transaction: { to: contract, data: encodeCall('redeemForDelivery(uint256[],(uint256,address,uint256,uint256,bytes32),bytes)', ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'], [ids, [42, owner, config.deliveryFeeWei, deadline, receiptIdsHash], signature]), value: `0x${BigInt(config.deliveryFeeWei).toString(16)}`, chainId: config.chainId } };
  });
  const connected = wallet();
  const view = harness(connected, false, 'OeuwTqGXImT/vfBBV6j6G89Hs6tU1Ij5+Gd2fQSCQB4=');
  await waitFor(() => assert.equal(view.result.current.items.length, selected.length));
  await act(async () => {
    assert.equal(await view.result.current.deliver(selected, {
      formatted: 'Test Name\n123 Example Street', country: 'United States', countryCode: 'US', email: 'test@example.com',
    }), true);
  });
  assert.equal(prepare.mock.callCount(), 1);
  assert.equal(connected.sent.length, 1);
  const [sent] = connected.sent[0] as [{ data: string }];
  assert.deepEqual(decodeReturn(['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'], `0x${sent.data.slice(10)}`), [
    tokenIds.map(BigInt), [42n, owner, BigInt(config.deliveryFeeWei), BigInt(deadline), receiptIdsHash], signature,
  ]);
  assert.equal(readEthereumPending(scope)?.intent?.data, sent.data);
  assert.deepEqual(selected, originalSelection);
  assert.deepEqual(view.result.current.items, originalSelection);
});

test('unboxing reveals artwork at first inclusion without waiting for fulfillment confirmations', async t => {
  const artworks: EthereumInventoryItem[] = Array.from({ length: 20 }, (_, index) => ({
    ...token(owner, String(index + 1)), kind: 'artwork', displayId: 821 + index, name: `Artwork #${821 + index}`,
  }));
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'confirmed', confirmations: 1, items: artworks, burnedTokenIds: ['111153'] }));
  const connected = wallet();
  const view = harness(connected);
  await waitFor(() => assert.ok(view.result.current.scope));
  await act(async () => { assert.equal(await view.result.current.unbox({ ...token(owner, '111153'), displayId: 42 }), true); });
  await waitFor(() => assert.equal(view.result.current.revealed?.length, 20));
  assert.equal(view.result.current.revealed?.[0].displayId, 821);
  assert.equal(view.result.current.pending, null);
  assert.equal(connected.sent.length, 1);
});

for (const count of [1, 15, 16, 50]) {
  test(`opening ${count} selected crates ${count <= 15 ? 'submits one ordered transaction' : 'rejects before wallet submission'}`, async () => {
    const selected = Array.from({ length: count }, (_, index) => ({
      ...token(owner, String(111112 + count - index - 1)), displayId: count - index,
    }));
    const originalIds = selected.map(item => item.tokenId);
    const connected = wallet();
    const view = harness(connected);
    await waitFor(() => assert.ok(view.result.current.scope));
    await act(async () => { assert.equal(await view.result.current.unbox(selected), count <= 15); });
    assert.deepEqual(selected.map(item => item.tokenId), originalIds);
    assert.equal(connected.sent.length, count <= 15 ? 1 : 0);
    const scope = ethereumInventoryScope(config, owner)!;
    if (count <= 15) {
      const [sent] = connected.sent[0] as [{ data: string }];
      const expected = count === 1 ? encodeCall('unboxCrate(uint256)', ['uint256'], [originalIds[0]])
        : encodeCall('unboxCrates(uint256[])', ['uint256[]'], [originalIds]);
      assert.equal(sent.data, expected);
      assert.equal(readEthereumPending(scope)?.intent?.data, expected);
    } else {
      assert.match(view.result.current.error ?? '', /up to 15/);
      assert.equal(readEthereumPending(scope), null);
      assert.equal(readEthereumSubmission(scope), null);
    }
  });
}

test('opening rejects duplicate, mixed, foreign and multiple warehouse selections', async () => {
  const connected = wallet();
  const view = harness(connected);
  await waitFor(() => assert.ok(view.result.current.scope));
  const crate = token();
  const warehouse: EthereumInventoryItem = { ...token(owner, '116667'), kind: 'warehouse' };
  for (const selected of [[], [crate, crate], [crate, warehouse], [warehouse, { ...warehouse, tokenId: '116668' }],
    [{ ...crate, kind: 'artwork' as const }], [token(other)], [{ ...crate, chainId: 1 }], [{ ...crate, contractAddress: other }]]) {
    await act(async () => { assert.equal(await view.result.current.unbox(selected), false); });
  }
  assert.equal(connected.sent.length, 0);
  await act(async () => { assert.equal(await view.result.current.unbox([warehouse]), true); });
  assert.equal(connected.sent.length, 1);
  assert.equal((connected.sent[0] as [{ data: string }])[0].data, encodeCall('unboxWarehouse(uint256)', ['uint256'], ['116667']));
});

test('a fifteen-crate bonus batch retains all 311 artworks through first inclusion, stale indexing and reload', async t => {
  const selected = [...Array.from({ length: 14 }, (_, index) => ({ ...token(owner, String(111112 + index)), displayId: index + 1 })),
    { ...token(owner, '116666'), displayId: 5555 }];
  const artworks: EthereumInventoryItem[] = Array.from({ length: 311 }, (_, index) => ({
    ...token(owner, String(index + 1)), kind: 'artwork', displayId: index < 280 ? index + 1 : 111081 + index - 280,
    name: `Artwork #${index + 1}`,
  }));
  const previous: EthereumInventoryItem[] = Array.from({ length: 100 }, (_, index) => ({
    ...token(owner, String(index + 50000)), kind: 'artwork', displayId: index + 50000,
  }));
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:expected`, previous.map(item => item.tokenId));
  let included = false;
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({
    items: included ? [...previous, ...artworks].filter(item => expected.includes(item.tokenId)) : [...previous, ...selected],
    nextCursor: null, observedBlock: 10,
  }));
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: included ? 'confirmed' : 'pending', confirmations: included ? 1 : 0,
    items: included ? artworks : [], burnedTokenIds: included ? selected.map(item => item.tokenId) : [] }));
  const connected = wallet();
  let view = harness(connected);
  await waitFor(() => assert.equal(view.result.current.items.length, 115));
  await act(async () => { assert.equal(await view.result.current.unbox(selected), true); });
  assert.equal(connected.sent.length, 1);
  included = true;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
  await waitFor(() => assert.equal(view.result.current.revealed?.length, 311));
  assert.equal(view.result.current.pending, null);
  const expectedIds = new Set([...previous, ...artworks].map(item => item.tokenId));
  assert.deepEqual(new Set(readEthereumExpected(scope)), expectedIds);
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'inventory', scope] }); });
  assert.deepEqual(new Set(view.result.current.items.map(item => item.tokenId)), expectedIds);
  view.unmount();
  view.client.clear();
  view = harness(connected);
  await waitFor(() => assert.deepEqual(new Set(view.result.current.items.map(item => item.tokenId)), expectedIds));
  assert.equal(view.result.current.items.length, 411);
  assert.equal(connected.sent.length, 1);
});

test('crate receipt claims keep polling until three confirmations without another wallet transaction', async t => {
  speedUpConfirmationPolls(t);
  let confirmations = 1;
  let published = 0;
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'confirmed', confirmations, items: [], burnedTokenIds: ['2000001'] }));
  t.mock.method(ethereumApi, 'confirmClaim', async () => { published++; return { status: 'confirmed', confirmations: 3 }; });
  const scope = ethereumInventoryScope(config, owner)!;
  window.sessionStorage.setItem(`ethereum111k:${scope}:session`, JSON.stringify({
    token: 'ethereum-session', address: owner, chainId: config.chainId, dropId: '111k_devnet', expiresAtMs: Date.now() + 3_600_000,
  }));
  t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
  t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
  t.mock.method(ethereumApi, 'prepareClaim', async (receiptId, code) => {
    assert.equal(receiptId, '2000001');
    assert.equal(code, 'ABCDEF123456');
    const claimId = `0x${'cd'.repeat(32)}`;
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const signature = `0x${'ab'.repeat(65)}`;
    return { claimId, receiptId, expiresAtMs: deadline * 1000, deadline, signature,
      transaction: { to: contract, data: encodeCall('claimCrateReceipt(uint256,bytes32,uint256,bytes)', ['uint256', 'bytes32', 'uint256', 'bytes'], [receiptId, claimId, deadline, signature]), value: '0x0', chainId: config.chainId } };
  });
  const connected = wallet();
  const view = harness(connected);
  await waitFor(() => assert.ok(view.result.current.session));
  const receipt = { ...token(owner, '2000001'), kind: 'crate_receipt' as const };
  await act(async () => { assert.equal(await view.result.current.claim(receipt, 'ABCDEF123456'), true); });
  assert.equal(readEthereumPending(scope)?.action, 'claim');
  assert.equal(connected.sent.length, 1);
  await waitFor(() => assert.equal(view.result.current.confirmations, 1));
  assert.equal(published, 0);
  confirmations = 2;
  await waitFor(() => assert.equal(view.result.current.confirmations, 2));
  assert.equal(published, 0);
  assert.equal(view.result.current.error, null);
  confirmations = 3;
  await waitFor(() => assert.equal(view.result.current.pending, null));
  assert.equal(published, 1);
  assert.equal(connected.sent.length, 1);
});

for (const action of ['delivery', 'claim'] as const) {
  for (const authenticated of [true, false]) {
    test(`${action} updates inventory at first inclusion while ${authenticated ? 'signed in' : 'restored without a session'} and finalizes at three confirmations`, async t => {
      const original: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '111112' : '2000001'),
        kind: action === 'delivery' ? 'crate' : 'crate_receipt' };
      const receipt: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '2000001' : '1000001'),
        kind: action === 'delivery' ? 'crate_receipt' : 'artwork_receipt' };
      let confirmations = 0;
      const scope = ethereumInventoryScope(config, owner)!;
      if (authenticated) savedSession(owner);
      writeEthereumStorage(`${scope}:pending`, { scope, hash, action, submittedAt: Date.now(), orderId: 42, claimId: hash });
      writeEthereumStorage(`${scope}:expected`, [original.tokenId]);
      const inventory = t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({
        items: [confirmations === 0 ? original : receipt].filter(item => expected.includes(item.tokenId)),
        nextCursor: null, observedBlock: 10 + confirmations,
      }));
      t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
      t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
      t.mock.method(ethereumApi, 'confirm', async () => ({ status: confirmations === 0 ? 'pending' : 'confirmed', confirmations,
        items: confirmations === 0 ? [] : [receipt], burnedTokenIds: confirmations === 0 ? [] : [original.tokenId] }));
      const finalize = t.mock.method(ethereumApi, action === 'delivery' ? 'confirmDelivery' : 'confirmClaim', async () => ({ status: 'confirmed', confirmations: 3 }));
      const connected = wallet();
      const view = harness(connected);
      await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
      assert.equal(view.result.current.confirmations, 0);
      assert.equal(inventory.mock.callCount(), 1);
      confirmations = 1;
      await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
      await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]));
      assert.equal(inventory.mock.callCount(), 1);
      assert.deepEqual(readEthereumExpected(scope), [receipt.tokenId]);
      assert.equal(readEthereumPending(scope)?.hash, hash);
      assert.equal(finalize.mock.callCount(), 0);
      confirmations = 2;
      await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
      await waitFor(() => assert.equal(view.result.current.confirmations, 2));
      assert.equal(readEthereumPending(scope)?.hash, hash);
      assert.equal(finalize.mock.callCount(), 0);
      confirmations = 3;
      await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
      if (!authenticated) {
        await waitFor(() => assert.equal(view.result.current.confirmations, 3));
        assert.equal(readEthereumPending(scope)?.hash, hash);
        assert.equal(finalize.mock.callCount(), 0);
        savedSession(owner);
        await act(async () => { assert.equal(await view.result.current.signIn(), true); });
      }
      await waitFor(() => assert.equal(view.result.current.pending, null));
      assert.equal(finalize.mock.callCount(), 1);
      assert.deepEqual(readEthereumExpected(scope), [receipt.tokenId]);
      assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]);
      assert.equal(connected.sent.length, 0);
    });
  }
}

for (const action of ['delivery', 'claim'] as const) {
  test(`${action} restores unindexed originals after reorgs and reloads before applying a re-mined inclusion`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    const original: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '111112' : '2000001'),
      kind: action === 'delivery' ? 'crate' : 'crate_receipt' };
    const receipt: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '2000001' : '1000001'),
      kind: action === 'delivery' ? 'crate_receipt' : 'artwork_receipt' };
    let included = false;
    writeEthereumStorage(`${scope}:pending`, { scope, hash, action, orderId: 42, claimId: hash, submittedAt: Date.now() });
    writeEthereumStorage(`${scope}:expected`, [original.tokenId]);
    const inventory = t.mock.method(ethereumApi, 'inventory', async (currentConfig, currentOwner, _cursor, _signal, expected = []) => ({
      items: [included ? receipt : original].filter(item => item.owner === currentOwner &&
        item.chainId === currentConfig.chainId && item.contractAddress === currentConfig.contractAddress && expected.includes(item.tokenId)),
      nextCursor: null, observedBlock: 10,
    }));
    t.mock.method(ethereumApi, 'confirm', async () => ({ status: included ? 'confirmed' : 'pending', confirmations: included ? 1 : 0,
      items: included ? [receipt] : [], burnedTokenIds: included ? [original.tokenId] : [] }));
    const finalize = t.mock.method(ethereumApi, action === 'delivery' ? 'confirmDelivery' : 'confirmClaim');
    let view = harness();
    await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
    included = true;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]));
    assert.equal(inventory.mock.callCount(), 1);
    included = false;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
    assert.equal(view.result.current.confirmations, 0);
    assert.equal(inventory.mock.callCount(), 2);
    assert.equal(readEthereumPending(scope)?.hash, hash);
    included = true;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]));
    assert.equal(view.result.current.confirmations, 1);
    assert.equal(inventory.mock.callCount(), 2);
    assert.equal(finalize.mock.callCount(), 0);
    assert.equal(readEthereumPending(scope)?.hash, hash);
    view.unmount();
    view.client.clear();
    included = false;
    view = harness();
    await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
    assert.equal(view.result.current.confirmations, 0);
    const reloadReads = inventory.mock.callCount();
    assert.ok(reloadReads >= 3);
    assert.equal(readEthereumPending(scope)?.hash, hash);
    included = true;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]));
    assert.equal(inventory.mock.callCount(), reloadReads);
    assert.equal(finalize.mock.callCount(), 0);
  });
}

for (const action of ['delivery', 'claim'] as const) {
  test(`${action} restores an unindexed original when a previously included transaction reverts`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    const original: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '111112' : '2000001'),
      kind: action === 'delivery' ? 'crate' : 'crate_receipt' };
    const receipt: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '2000001' : '1000001'),
      kind: action === 'delivery' ? 'crate_receipt' : 'artwork_receipt' };
    let state: 'pending' | 'included' | 'reverted' = 'pending';
    writeEthereumStorage(`${scope}:pending`, { scope, hash, action, orderId: 42, claimId: hash, submittedAt: Date.now() });
    writeEthereumStorage(`${scope}:expected`, [original.tokenId]);
    t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({
      items: [state === 'included' ? receipt : original].filter(item => expected.includes(item.tokenId)), nextCursor: null, observedBlock: 10,
    }));
    t.mock.method(ethereumApi, 'confirm', async () => {
      if (state === 'reverted') throw new EthereumApiError(409, 'The transaction reverted.', 'transaction-reverted');
      return { status: state === 'included' ? 'confirmed' : 'pending', confirmations: state === 'included' ? 1 : 0,
        items: state === 'included' ? [receipt] : [], burnedTokenIds: state === 'included' ? [original.tokenId] : [] };
    });
    const view = harness();
    await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
    state = 'included';
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]));
    state = 'reverted';
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => {
      assert.equal(view.result.current.pending, null);
      assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]);
    });
    assert.match(view.result.current.error ?? '', /reverted/);
    assert.ok(readEthereumExpected(scope).includes(original.tokenId));
  });
}

for (const action of ['delivery', 'claim'] as const) {
  test(`${action} ignores cached success after a definitive revert without retrying finalization`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    let reverted = false;
    savedSession(owner);
    writeEthereumStorage(`${scope}:pending`, { scope, hash, action, orderId: 42, claimId: hash, submittedAt: Date.now() });
    t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
    t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
    t.mock.method(ethereumApi, 'confirm', async () => {
      if (reverted) throw new EthereumApiError(409, 'The transaction reverted.', 'transaction-reverted');
      return { status: 'confirmed', confirmations: 3, items: [], burnedTokenIds: [] };
    });
    const finalize = t.mock.method(ethereumApi, action === 'delivery' ? 'confirmDelivery' : 'confirmClaim', async () => {
      if (reverted) throw new EthereumApiError(409, 'The transaction reverted.', 'transaction-reverted');
      return { status: 'pending', confirmations: 2, orderId: 42 };
    });
    const view = harness();
    await waitFor(() => assert.equal(finalize.mock.callCount(), 1));
    reverted = true;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.equal(view.result.current.pending, null));
    assert.equal(finalize.mock.callCount(), 1);
    assert.match(view.result.current.error ?? '', /reverted/);
  });

  test(`late ${action} finalization cannot consume recovery after a definitive revert`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    const original: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '111112' : '2000001'),
      kind: action === 'delivery' ? 'crate' : 'crate_receipt' };
    const receipt: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '2000001' : '1000001'),
      kind: action === 'delivery' ? 'crate_receipt' : 'artwork_receipt' };
    let confirmations = 0;
    let reverted = false;
    let finish: (() => void) | undefined;
    savedSession(owner);
    writeEthereumStorage(`${scope}:pending`, { scope, hash, action, orderId: 42, claimId: hash, submittedAt: Date.now() });
    writeEthereumStorage(`${scope}:expected`, [original.tokenId]);
    t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
    t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
    t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({
      items: [confirmations && !reverted ? receipt : original].filter(item => expected.includes(item.tokenId)), nextCursor: null, observedBlock: 10,
    }));
    t.mock.method(ethereumApi, 'confirm', async () => {
      if (reverted) throw new EthereumApiError(409, 'The transaction reverted.', 'transaction-reverted');
      return { status: confirmations ? 'confirmed' : 'pending', confirmations, items: confirmations ? [receipt] : [],
        burnedTokenIds: confirmations ? [original.tokenId] : [] };
    });
    const finalize = t.mock.method(ethereumApi, action === 'delivery' ? 'confirmDelivery' : 'confirmClaim', async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { status: 'confirmed', confirmations: 3, orderId: 42 };
    });
    const view = harness();
    await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
    confirmations = 3;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => { assert.ok(finish); assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]); });
    reverted = true;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await act(async () => { finish!(); });
    await waitFor(() => {
      assert.equal(view.result.current.pending, null);
      assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]);
    });
    assert.deepEqual(readEthereumExpected(scope), [original.tokenId]);
    assert.equal(finalize.mock.callCount(), 1);
    assert.match(view.result.current.error ?? '', /reverted/);
  });

  for (const stage of ['overlay', 'cleanup'] as const) {
    test(`${action} ${stage} queued behind the submission lock cannot commit cached success after a definitive revert`, async t => {
      const scope = ethereumInventoryScope(config, owner)!;
      const original: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '111112' : '2000001'),
        kind: action === 'delivery' ? 'crate' : 'crate_receipt' };
      const receipt: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '2000001' : '1000001'),
        kind: action === 'delivery' ? 'crate_receipt' : 'artwork_receipt' };
      let confirmations = 0;
      let reverted = false;
      let finish: (() => void) | undefined;
      if (stage === 'cleanup') savedSession(owner);
      writeEthereumStorage(`${scope}:pending`, { scope, hash, action, orderId: 42, claimId: hash, submittedAt: Date.now() });
      writeEthereumStorage(`${scope}:expected`, [original.tokenId]);
      t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
      t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
      t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({
        items: [confirmations && !reverted ? receipt : original].filter(item => expected.includes(item.tokenId)), nextCursor: null, observedBlock: 10,
      }));
      t.mock.method(ethereumApi, 'confirm', async () => {
        if (reverted) throw new EthereumApiError(409, 'The transaction reverted.', 'transaction-reverted');
        return { status: confirmations ? 'confirmed' : 'pending', confirmations, items: confirmations ? [receipt] : [],
          burnedTokenIds: confirmations ? [original.tokenId] : [] };
      });
      t.mock.method(ethereumApi, action === 'delivery' ? 'confirmDelivery' : 'confirmClaim', async () => {
        await new Promise<void>(resolve => { finish = resolve; });
        return { status: 'confirmed', confirmations: 3, orderId: 42 };
      });
      const view = harness();
      await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
      if (stage === 'cleanup') {
        confirmations = 3;
        await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
        await waitFor(() => assert.ok(finish));
      }
      let release: (() => void) | undefined;
      const competing = navigator.locks.request(`ethereum111k-submission:${scope}`, { ifAvailable: true }, async lock => {
        assert.ok(lock);
        await new Promise<void>(resolve => { release = resolve; });
      });
      const requests = t.mock.method(navigator.locks, 'request');
      try {
        if (stage === 'cleanup') await act(async () => { finish!(); });
        else {
          confirmations = 1;
          await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
        }
        await waitFor(() => assert.ok(requests.mock.callCount() > 0));
        reverted = true;
        await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
      } finally {
        await act(async () => { release!(); await competing; });
      }
      await waitFor(() => {
        assert.equal(view.result.current.pending, null);
        assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]);
      });
      assert.deepEqual(readEthereumExpected(scope), [original.tokenId]);
      assert.match(view.result.current.error ?? '', /reverted/);
    });
  }

  test(`dismissing an included ${action} preserves its original NFT through a later orphan and unrelated mint`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    const original: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '111112' : '2000001'),
      kind: action === 'delivery' ? 'crate' : 'crate_receipt' };
    const receipt: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '2000001' : '1000001'),
      kind: action === 'delivery' ? 'crate_receipt' : 'artwork_receipt' };
    const minted = token(owner, '111113');
    const nextHash = `0x${'cd'.repeat(32)}`;
    let included = false;
    let nextMinted = false;
    writeEthereumStorage(`${scope}:pending`, { scope, hash, action, orderId: 42, claimId: hash, submittedAt: Date.now() });
    writeEthereumStorage(`${scope}:expected`, [original.tokenId]);
    t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({
      items: [included ? receipt : original, ...(nextMinted ? [minted] : [])].filter(item => expected.includes(item.tokenId)), nextCursor: null, observedBlock: 10,
    }));
    t.mock.method(ethereumApi, 'confirm', async transactionHash => {
      if (transactionHash === nextHash) {
        nextMinted = true;
        return { status: 'confirmed', confirmations: 1, items: [minted], burnedTokenIds: [] };
      }
      return { status: included ? 'confirmed' : 'pending', confirmations: included ? 1 : 0,
        items: included ? [receipt] : [], burnedTokenIds: included ? [original.tokenId] : [] };
    });
    const connected = wallet();
    const request = connected.provider!.request;
    connected.provider!.request = async args => args.method === 'eth_sendTransaction' ? nextHash : request(args);
    let view = harness(connected);
    await waitFor(() => { assert.ok(view.result.current.stats.data); assert.equal(view.result.current.items[0]?.tokenId, original.tokenId); });
    included = true;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.equal(view.result.current.items[0]?.tokenId, receipt.tokenId));
    await act(async () => { await view.result.current.dismissPending(); });
    assert.equal(view.result.current.pending, null);
    included = false;
    await act(async () => { assert.equal(await view.result.current.mint('crate', 1), true); });
    await waitFor(() => { assert.equal(view.result.current.pending, null); assert.equal(nextMinted, true); });
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'inventory', scope] }); });
    assert.deepEqual(new Set(view.result.current.items.map(item => item.tokenId)), new Set([original.tokenId, minted.tokenId]));
    view.unmount();
    view.client.clear();
    view = harness(connected);
    await waitFor(() => assert.deepEqual(new Set(view.result.current.items.map(item => item.tokenId)), new Set([original.tokenId, minted.tokenId])));
  });
}

for (const reload of [false, true]) {
  test(`a reorg of fifty indexed delivery items preserves one hundred unrelated unindexed holdings${reload ? ' across reload' : ''}`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    const selected: EthereumInventoryItem[] = Array.from({ length: 50 }, (_, index) => ({
      ...token(owner, String(index + 1)), kind: 'artwork', displayId: index + 1,
    }));
    const untouched: EthereumInventoryItem[] = Array.from({ length: 100 }, (_, index) => ({
      ...token(owner, String(index + 51)), kind: 'artwork', displayId: index + 51,
    }));
    const receipts: EthereumInventoryItem[] = selected.map(item => ({
      ...token(owner, String(1_000_000 + item.displayId)), kind: 'artwork_receipt', displayId: item.displayId,
    }));
    let included = false;
    writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'delivery', orderId: 42, submittedAt: Date.now() });
    writeEthereumStorage(`${scope}:expected`, untouched.map(item => item.tokenId));
    t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({
      items: [...(included ? [] : selected.slice(0, 30)), ...[...untouched, ...(included ? receipts : [])].filter(item => expected.includes(item.tokenId))],
      nextCursor: null, observedBlock: 10,
    }));
    t.mock.method(ethereumApi, 'confirm', async () => ({ status: included ? 'confirmed' : 'pending', confirmations: included ? 1 : 0,
      items: included ? receipts : [], burnedTokenIds: included ? selected.map(item => item.tokenId) : [] }));
    let view = harness();
    await waitFor(() => assert.equal(view.result.current.items.length, 130));
    included = true;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.equal(view.result.current.items.length, 150));
    if (reload) {
      view.unmount();
      view.client.clear();
      included = false;
      view = harness();
    } else {
      included = false;
      await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    }
    await waitFor(() => {
      const ids = new Set(view.result.current.items.map(item => item.tokenId));
      assert.ok(untouched.every(item => ids.has(item.tokenId)));
      assert.ok(receipts.every(item => !ids.has(item.tokenId)));
    });
    assert.equal(readEthereumPending(scope)?.hash, hash);
  });
}

for (const reorg of [false, true]) {
  test(`a fifty-item delivery preserves one hundred unindexed holdings through ${reorg ? 'reorgs and reloads' : 'ordinary finalization'}`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    const originals: EthereumInventoryItem[] = Array.from({ length: 100 }, (_, index) => ({
      ...token(owner, String(index + 1)), kind: 'artwork', displayId: index + 1,
    }));
    const selected = originals.slice(0, 50);
    const untouched = originals.slice(50);
    const receipts: EthereumInventoryItem[] = selected.map(item => ({
      ...token(owner, String(1_000_000 + item.displayId)), kind: 'artwork_receipt', displayId: item.displayId,
    }));
    const originalIds = new Set(originals.map(item => item.tokenId));
    const deliveredIds = new Set([...untouched, ...receipts].map(item => item.tokenId));
    let confirmations = 0;
    savedSession(owner);
    writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'delivery', orderId: 42, submittedAt: Date.now() });
    writeEthereumStorage(`${scope}:expected`, [...originalIds]);
    t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
    t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
    t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({
      items: (confirmations ? [...untouched, ...receipts] : originals).filter(item => expected.includes(item.tokenId)), nextCursor: null, observedBlock: 10,
    }));
    t.mock.method(ethereumApi, 'confirm', async () => ({ status: confirmations ? 'confirmed' : 'pending', confirmations,
      items: confirmations ? receipts : [], burnedTokenIds: confirmations ? selected.map(item => item.tokenId) : [] }));
    t.mock.method(ethereumApi, 'confirmDelivery', async () => ({ status: 'confirmed', confirmations: 3, orderId: 42 }));
    let view = harness();
    await waitFor(() => assert.deepEqual(new Set(view.result.current.items.map(item => item.tokenId)), originalIds));
    confirmations = 1;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.deepEqual(new Set(view.result.current.items.map(item => item.tokenId)), deliveredIds));
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'inventory', scope] }); });
    assert.deepEqual(new Set(view.result.current.items.map(item => item.tokenId)), deliveredIds);
    assert.equal(view.result.current.items.length, 100);
    if (reorg) {
      confirmations = 0;
      await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
      await waitFor(() => assert.deepEqual(new Set(view.result.current.items.map(item => item.tokenId)), originalIds));
      assert.equal(view.result.current.items.length, 100);
      assert.equal(readEthereumPending(scope)?.hash, hash);
      confirmations = 1;
      await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
      await waitFor(() => assert.deepEqual(new Set(view.result.current.items.map(item => item.tokenId)), deliveredIds));
      view.unmount();
      view.client.clear();
      confirmations = 0;
      view = harness();
      await waitFor(() => assert.deepEqual(new Set(view.result.current.items.map(item => item.tokenId)), originalIds));
      assert.equal(view.result.current.items.length, 100);
      assert.equal(readEthereumPending(scope)?.hash, hash);
      confirmations = 1;
      await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
      await waitFor(() => assert.deepEqual(new Set(view.result.current.items.map(item => item.tokenId)), deliveredIds));
    }
    confirmations = 3;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.equal(view.result.current.pending, null));
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'inventory', scope] }); });
    assert.deepEqual(new Set(view.result.current.items.map(item => item.tokenId)), deliveredIds);
    assert.equal(view.result.current.items.length, 100);
  });
}

test('transient confirmation errors do not replay an inclusion over newer receipt ownership', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  const original = token();
  const receipt: EthereumInventoryItem = { ...token(owner, '2000001'), kind: 'crate_receipt' };
  let included = false;
  let transferred = false;
  let failure = false;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'delivery', orderId: 42, submittedAt: Date.now() });
  const inventory = t.mock.method(ethereumApi, 'inventory', async () => ({
    items: transferred ? [] : included ? [receipt] : [original], nextCursor: null, observedBlock: 10,
  }));
  t.mock.method(ethereumApi, 'confirm', async () => {
    if (failure) throw new EthereumApiError(503, 'Temporary RPC failure');
    return { status: included ? 'confirmed' : 'pending', confirmations: included ? 1 : 0,
      items: included ? [receipt] : [], burnedTokenIds: included ? [original.tokenId] : [] };
  });
  const view = harness();
  await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
  included = true;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
  await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]));
  transferred = true;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'inventory', scope] }); });
  await waitFor(() => assert.deepEqual(view.result.current.items, []));
  failure = true;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
  await waitFor(() => assert.equal(view.result.current.error, 'Temporary RPC failure'));
  assert.deepEqual(view.result.current.items, []);
  failure = false;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
  await waitFor(() => assert.equal(view.result.current.error, null));
  assert.deepEqual(view.result.current.items, []);
  assert.equal(inventory.mock.callCount(), 2);
  assert.equal(readEthereumPending(scope)?.hash, hash);
});

test('first-inclusion work queued behind the submission lock cannot apply an orphaned receipt', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  const original = token();
  const receipt: EthereumInventoryItem = { ...token(owner, '2000001'), kind: 'crate_receipt' };
  let included = false;
  let finishInventory: ((response: EthereumInventoryResponse) => void) | undefined;
  let inventorySignal: AbortSignal | undefined;
  let reads = 0;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'delivery', orderId: 42, submittedAt: Date.now() });
  writeEthereumStorage(`${scope}:expected`, [original.tokenId]);
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, signal) => {
    if (++reads === 1) return { items: [original], nextCursor: null, observedBlock: 10 };
    inventorySignal = signal;
    return new Promise<EthereumInventoryResponse>(resolve => { finishInventory = resolve; });
  });
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: included ? 'confirmed' : 'pending', confirmations: included ? 1 : 0,
    items: included ? [receipt] : [], burnedTokenIds: included ? [original.tokenId] : [] }));
  const view = harness();
  await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
  let release: (() => void) | undefined;
  const competing = navigator.locks.request(`ethereum111k-submission:${scope}`, { ifAvailable: true }, async lock => {
    assert.ok(lock);
    await new Promise<void>(resolve => { release = resolve; });
  });
  const requests = t.mock.method(navigator.locks, 'request');
  try {
    included = true;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => assert.equal(requests.mock.callCount(), 1));
    included = false;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
    await waitFor(() => { assert.equal(view.result.current.confirmations, 0); assert.ok(finishInventory); });
  } finally {
    await act(async () => { release!(); await competing; });
  }
  assert.equal(inventorySignal?.aborted, false);
  await act(async () => { finishInventory!({ items: [original], nextCursor: null, observedBlock: 10 }); });
  assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]);
  assert.deepEqual(readEthereumExpected(scope), [original.tokenId]);
  assert.equal(readEthereumPending(scope)?.hash, hash);
});

for (const action of ['delivery', 'claim'] as const) {
  for (const outcome of ['confirmed', 'pending', 'error'] as const) {
    test(`late ${action} finalization returning ${outcome} cannot clear a re-mined transaction that has only one confirmation`, async t => {
      const scope = ethereumInventoryScope(config, owner)!;
      const original: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '111112' : '2000001'),
        kind: action === 'delivery' ? 'crate' : 'crate_receipt' };
      const receipt: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '2000001' : '1000001'),
        kind: action === 'delivery' ? 'crate_receipt' : 'artwork_receipt' };
      let confirmations = 0;
      let finish: (() => void) | undefined;
      savedSession(owner);
      writeEthereumStorage(`${scope}:pending`, { scope, hash, action, orderId: 42, claimId: hash, submittedAt: Date.now() });
      t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
      t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
      t.mock.method(ethereumApi, 'inventory', async () => ({
        items: confirmations ? [receipt] : [original], nextCursor: null, observedBlock: 10,
      }));
      t.mock.method(ethereumApi, 'confirm', async () => ({ status: confirmations ? 'confirmed' : 'pending', confirmations,
        items: confirmations ? [receipt] : [], burnedTokenIds: confirmations ? [original.tokenId] : [] }));
      const finalize = t.mock.method(ethereumApi, action === 'delivery' ? 'confirmDelivery' : 'confirmClaim', async () => {
        await new Promise<void>(resolve => { finish = resolve; });
        if (outcome === 'error') throw new EthereumApiError(503, 'Finalization temporarily unavailable');
        return { status: outcome, confirmations: outcome === 'confirmed' ? 3 : 0 };
      });
      const view = harness();
      await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
      confirmations = 1;
      await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
      await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]));
      confirmations = 3;
      await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
      await waitFor(() => assert.ok(finish));
      try {
        confirmations = 0;
        await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
        await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
        confirmations = 1;
        await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
        await waitFor(() => assert.equal(view.result.current.confirmations, 1));
      } finally {
        await act(async () => { finish!(); });
      }
      await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]));
      assert.equal(view.result.current.pending?.hash, hash);
      assert.equal(readEthereumPending(scope)?.hash, hash);
      assert.equal(finalize.mock.callCount(), 1);
    });
  }
}

for (const action of ['delivery', 'claim'] as const) {
  test(`reloading a pending ${action} restarts an interrupted inventory load`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    const original = token(owner, action === 'delivery' ? '111112' : '2000001');
    const receipt: EthereumInventoryItem = { ...token(owner, action === 'delivery' ? '2000001' : '1000001'),
      kind: action === 'delivery' ? 'crate_receipt' : 'artwork_receipt' };
    const unrelated = token(owner, '111113');
    let finishInventory: ((response: EthereumInventoryResponse) => void) | undefined;
    let inventorySignal: AbortSignal | undefined;
    writeEthereumStorage(`${scope}:pending`, { scope, hash, action, orderId: 42, claimId: hash, submittedAt: Date.now() });
    const inventory = t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, signal, expected = []) => {
      if (!finishInventory) {
        inventorySignal = signal;
        return new Promise<EthereumInventoryResponse>(resolve => { finishInventory = resolve; });
      }
      assert.ok(expected.includes(receipt.tokenId));
      return { items: [receipt, unrelated], nextCursor: 'next-page', observedBlock: 11 };
    });
    t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'confirmed', confirmations: 1,
      items: [receipt], burnedTokenIds: [original.tokenId] }));
    const view = harness();
    await waitFor(() => {
      assert.equal(inventory.mock.callCount(), 2);
      assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId, unrelated.tokenId]);
      assert.equal(view.result.current.inventory.hasNextPage, true);
    });
    assert.equal(inventorySignal?.aborted, true);
    await act(async () => { finishInventory!({ items: [original], nextCursor: null, observedBlock: 10 }); });
    assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId, unrelated.tokenId]);
    assert.equal(view.result.current.inventory.hasNextPage, true);
    assert.equal(readEthereumPending(scope)?.hash, hash);
    assert.equal(view.result.current.session, null);
  });
}

test('first-inclusion receipts survive an older inventory request completing afterward', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  const original = token();
  const receipt: EthereumInventoryItem = { ...token(owner, '2000001'), kind: 'crate_receipt' };
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'delivery', orderId: 42, submittedAt: Date.now() });
  let included = false;
  let finishInventory: ((response: EthereumInventoryResponse) => void) | undefined;
  let inventorySignal: AbortSignal | undefined;
  let reads = 0;
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, signal) => {
    if (++reads === 1) return { items: [original], nextCursor: null, observedBlock: 10 };
    if (reads > 2) return { items: [receipt], nextCursor: null, observedBlock: 11 };
    inventorySignal = signal;
    return new Promise<EthereumInventoryResponse>(resolve => { finishInventory = resolve; });
  });
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: included ? 'confirmed' : 'pending', confirmations: included ? 1 : 0,
    items: included ? [receipt] : [], burnedTokenIds: included ? [original.tokenId] : [] }));
  const view = harness();
  await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]));
  act(() => { void view.client.invalidateQueries({ queryKey: ['ethereum111k', 'inventory', scope] }); });
  await waitFor(() => assert.ok(finishInventory));
  included = true;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] }); });
  await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]));
  assert.equal(inventorySignal?.aborted, true);
  await act(async () => { finishInventory!({ items: [original], nextCursor: null, observedBlock: 10 }); });
  assert.deepEqual(view.result.current.items.map(item => item.tokenId), [receipt.tokenId]);
  assert.equal(readEthereumPending(scope)?.hash, hash);
});

for (const newer of ['reservation', 'transaction', 'cleared'] as const) {
  test(`first-inclusion inventory rejects ${newer} pending state after waiting for the submission lock`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    const original = token();
    const receipt: EthereumInventoryItem = { ...token(owner, '2000001'), kind: 'crate_receipt' };
    writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'delivery', orderId: 42, submittedAt: 1 });
    t.mock.method(ethereumApi, 'inventory', async () => ({ items: [original], nextCursor: null, observedBlock: 10 }));
    let finish: ((result: EthereumTransactionConfirmResponse) => void) | undefined;
    t.mock.method(ethereumApi, 'confirm', () => new Promise<EthereumTransactionConfirmResponse>(resolve => { finish = resolve; }));
    const view = harness();
    await waitFor(() => { assert.ok(finish); assert.equal(view.result.current.items.length, 1); });
    let release: (() => void) | undefined;
    const competing = navigator.locks.request(`ethereum111k-submission:${scope}`, { ifAvailable: true }, async lock => {
      assert.ok(lock);
      await new Promise<void>(resolve => { release = resolve; });
    });
    const requests = t.mock.method(navigator.locks, 'request');
    await act(async () => { finish!({ status: 'confirmed', confirmations: 1, items: [receipt], burnedTokenIds: [original.tokenId] }); });
    await waitFor(() => assert.equal(requests.mock.callCount(), 1));
    assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]);
    const key = `ethereum111k:${scope}:pending`;
    const replacement = newer === 'cleared' ? null : JSON.stringify({ scope, action: 'mint', submittedAt: 2, nonce: '0x8',
      hash: `0x${(newer === 'reservation' ? '00' : 'cd').repeat(32)}`, ...(newer === 'reservation' ? { awaitingHash: true } : {}) });
    if (replacement === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, replacement);
    await act(async () => { release!(); await competing; });
    assert.equal(window.localStorage.getItem(key), replacement);
    assert.deepEqual(readEthereumExpected(scope), []);
    assert.deepEqual(view.result.current.items.map(item => item.tokenId), [original.tokenId]);
  });
}

test('a wallet cancellation replacement recovers after reload and is acknowledged only after three confirmations', async t => {
  speedUpConfirmationPolls(t);
  const scope = ethereumInventoryScope(config, owner)!;
  const replacementHash = `0x${'cd'.repeat(32)}`;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: Date.now(), nonce: '0x7',
    intent: { to: contract, data: '0x12345678', value: '0x123' } });
  let confirmations = 1;
  t.mock.method(ethereumApi, 'confirm', async transactionHash => ({ status: transactionHash === replacementHash ? 'confirmed' : 'pending',
    confirmations: transactionHash === replacementHash ? confirmations : 0, items: [], burnedTokenIds: [] }));
  const connected = wallet();
  const originalRequest = connected.provider!.request;
  connected.provider!.request = async args => args.method === 'eth_getTransactionByHash'
    ? { hash: replacementHash, from: owner, to: owner, input: '0x', value: '0x0', nonce: '0x7', chainId: '0xaa36a7' }
    : originalRequest(args);
  const view = harness(connected);
  await waitFor(() => assert.equal(view.result.current.pending?.hash, hash));
  await act(async () => { assert.equal(await view.result.current.replacePending(replacementHash), true); });
  await waitFor(() => assert.equal(view.result.current.confirmations, 1));
  assert.equal(view.result.current.pending?.action, 'cancel');
  assert.equal(view.result.current.notice, null);
  assert.equal(connected.sent.length, 0);
  confirmations = 3;
  await waitFor(() => assert.equal(view.result.current.pending, null));
  assert.match(view.result.current.notice ?? '', /cancellation is confirmed/);
  assert.equal(readEthereumPending(scope), null);
  assert.equal(connected.sent.length, 0);
});

test('explicit stop-tracking unlocks the UI without claiming cancellation or submitting again', async () => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: Date.now() });
  const connected = wallet();
  const view = harness(connected);
  await waitFor(() => assert.equal(view.result.current.pending?.hash, hash));
  await act(async () => { await view.result.current.dismissPending(); });
  assert.equal(view.result.current.pending, null);
  assert.equal(readEthereumPending(scope), null);
  assert.match(view.result.current.notice ?? '', /may still execute/);
  assert.equal(connected.sent.length, 0);
});

function savedSession(address: string): EthereumSession {
  const session: EthereumSession = { token: `session-${address}`, address, chainId: config.chainId, dropId: config.dropId, expiresAtMs: Date.now() + 3_600_000 };
  saveEthereumSession(ethereumInventoryScope(config, address)!, session);
  return session;
}

test('a late delivery 401 cannot clear the session restored for another account', async t => {
  const originalSession = savedSession(owner);
  const otherSession = savedSession(other);
  t.mock.method(ethereumApi, 'profile', async session => ({ wallet: session.address, addresses: [] }));
  t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
  let rejectAddress: ((cause: Error) => void) | undefined;
  t.mock.method(ethereumApi, 'saveAddress', () => new Promise((_resolve, reject) => { rejectAddress = reject; }));
  const view = harness(wallet(), false, 'OeuwTqGXImT/vfBBV6j6G89Hs6tU1Ij5+Gd2fQSCQB4=');
  await waitFor(() => assert.equal(view.result.current.session?.address, owner));
  let delivery: Promise<boolean> | undefined;
  act(() => { delivery = view.result.current.deliver([token()], { formatted: 'Name\n123 Street', country: 'United States', countryCode: 'US', email: 'test@example.com' }); });
  await waitFor(() => assert.ok(rejectAddress));
  view.rerender({ wallet: wallet(other) });
  await waitFor(() => assert.deepEqual(view.result.current.session, otherSession));
  await act(async () => { rejectAddress!(new EthereumApiError(401, 'Session expired', null, originalSession.token)); assert.equal(await delivery, false); });
  assert.deepEqual(view.result.current.session, otherSession);
  assert.equal(readEthereumSession(ethereumInventoryScope(config, owner)!, config, owner), null);
  assert.equal(view.result.current.error, null);
});

test('sign-in restores a valid cached session without another wallet signature', async t => {
  t.mock.method(ethereumApi, 'profile', async session => ({ wallet: session.address, addresses: [] }));
  t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
  const challenge = t.mock.method(ethereumApi, 'challenge', async () => { throw new Error('Unexpected authentication challenge'); });
  const view = harness();
  await waitFor(() => assert.ok(view.result.current.scope));
  assert.equal(view.result.current.session, null);
  const session = savedSession(owner);
  await act(async () => { assert.equal(await view.result.current.signIn(), true); });
  assert.deepEqual(view.result.current.session, session);
  assert.equal(challenge.mock.callCount(), 0);
});

test('returning before wallet approval tracks the transaction submitted by the unmounted page', async t => {
  let finishSend: ((hash: string) => void) | undefined;
  let sends = 0;
  const connected = wallet();
  const originalRequest = connected.provider!.request;
  connected.provider!.request = async args => {
    if (args.method !== 'eth_sendTransaction') return originalRequest(args);
    sends++;
    return await new Promise<string>(resolve => { finishSend = resolve; });
  };
  let confirmed = false;
  const confirmation = t.mock.method(ethereumApi, 'confirm', async () => ({ status: confirmed ? 'confirmed' as const : 'pending' as const,
    confirmations: confirmed ? 1 : 0, items: [], burnedTokenIds: [] }));
  const first = harness(connected);
  await waitFor(() => assert.ok(first.result.current.stats.data));
  let mint: Promise<boolean> | undefined;
  act(() => { mint = first.result.current.mint('crate', 1); });
  await waitFor(() => assert.ok(finishSend));
  first.unmount();
  const second = harness(connected);
  await waitFor(() => assert.ok(second.result.current.scope));
  assert.equal(second.result.current.pending, null);
  assert.equal(second.result.current.busy, 'Confirm mint in your wallet…');
  await act(async () => { assert.equal(await second.result.current.mint('crate', 1), false); });
  assert.equal(sends, 1);
  await act(async () => { finishSend!(hash); assert.equal(await mint, true); });
  await waitFor(() => assert.equal(second.result.current.pending?.hash, hash));
  assert.equal(second.result.current.busy, null);
  await waitFor(() => assert.ok(confirmation.mock.callCount()));
  confirmed = true;
  act(() => second.result.current.refresh());
  await waitFor(() => assert.equal(second.result.current.pending, null));
  assert.equal(readEthereumPending(ethereumInventoryScope(config, owner)!), null);
});

for (const cancellation of [false, true]) {
  test(`approval after navigating away captures the nonce for ${cancellation ? 'cancellation' : 'speed-up'} recovery`, async () => {
    const connected = wallet();
    const request = connected.provider!.request;
    const replacementHash = `0x${'cd'.repeat(32)}`;
    let finishSend: ((hash: string) => void) | undefined;
    let sentTransaction: Record<string, unknown> | undefined;
    let originalAvailable = true;
    let originalLookups = 0;
    connected.provider!.request = async args => {
      if (args.method === 'eth_sendTransaction') {
        sentTransaction = (args.params as Record<string, unknown>[])[0];
        return new Promise(resolve => { finishSend = resolve; });
      }
      if (args.method !== 'eth_getTransactionByHash') return request(args);
      const requestedHash = (args.params as string[])[0];
      if (requestedHash === hash) {
        originalLookups++;
        if (!originalAvailable) return null;
      }
      const cancelled = requestedHash === replacementHash && cancellation;
      return { hash: requestedHash, from: owner, to: cancelled ? owner : contract,
        input: cancelled ? '0x' : sentTransaction!.data, value: cancelled ? '0x0' : sentTransaction!.value,
        nonce: '0x8', chainId: '0xaa36a7' };
    };
    const first = harness(connected);
    await waitFor(() => assert.ok(first.result.current.stats.data));
    let mint: Promise<boolean> | undefined;
    act(() => { mint = first.result.current.mint('crate', 1); });
    await waitFor(() => assert.ok(finishSend));
    first.unmount();
    await act(async () => { finishSend!(hash); assert.equal(await mint, true); });
    const scope = ethereumInventoryScope(config, owner)!;
    await waitFor(() => assert.equal(readEthereumPending(scope)?.nonce, '0x8'));
    assert.equal(originalLookups, 1);
    originalAvailable = false;
    const second = harness(connected);
    await waitFor(() => assert.equal(second.result.current.pending?.hash, hash));
    await act(async () => { assert.equal(await second.result.current.replacePending(replacementHash), true); });
    assert.equal(readEthereumPending(scope)?.hash, replacementHash);
    assert.equal(readEthereumPending(scope)?.action, cancellation ? 'cancel' : 'mint');
    assert.equal(originalLookups, 1);
  });
}

test('a rejected approval releases the shared guard after its initiating page unmounts', async () => {
  const connected = wallet();
  const originalRequest = connected.provider!.request;
  let rejectSend: ((cause: Error) => void) | undefined;
  let firstRequest = true;
  connected.provider!.request = async args => {
    if (args.method !== 'eth_sendTransaction' || !firstRequest) return originalRequest(args);
    firstRequest = false;
    return await new Promise<string>((_resolve, reject) => { rejectSend = reject; });
  };
  const first = harness(connected);
  await waitFor(() => assert.ok(first.result.current.stats.data));
  let mint: Promise<boolean> | undefined;
  act(() => { mint = first.result.current.mint('crate', 1); });
  await waitFor(() => assert.ok(rejectSend));
  first.unmount();
  const second = harness(connected);
  await waitFor(() => assert.equal(second.result.current.busy, 'Confirm mint in your wallet…'));
  assert.equal(window.localStorage.length, 1);
  await act(async () => { rejectSend!(Object.assign(new Error('Cancelled'), { code: 4001 })); assert.equal(await mint, false); });
  await waitFor(() => assert.equal(second.result.current.busy, null));
  const scope = ethereumInventoryScope(config, owner)!;
  assert.equal(readEthereumOperation(scope), null);
  assert.equal(readEthereumPending(scope), null);
  assert.equal(readEthereumSubmission(scope), null);
  await act(async () => { assert.equal(await second.result.current.mint('crate', 1), true); });
  assert.equal(connected.sent.length, 1);
  assert.equal(readEthereumPending(scope)?.hash, hash);
});

test('a browser lock held by another tab rejects an action without queuing a wallet request', async () => {
  const scope = ethereumInventoryScope(config, owner)!;
  const lockName = `ethereum111k-submission:${scope}`;
  let release: (() => void) | undefined;
  const competing = navigator.locks.request(lockName, { ifAvailable: true }, async lock => {
    assert.ok(lock);
    await new Promise<void>(resolve => { release = resolve; });
  });
  const connected = wallet();
  const view = harness(connected);
  await waitFor(() => assert.ok(view.result.current.stats.data && release));
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), false); });
  assert.match(view.result.current.error ?? '', /already in progress/);
  assert.equal(connected.sent.length, 0);
  assert.equal(readEthereumOperation(scope), null);
  release!();
  await competing;
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), true); });
  assert.equal(connected.sent.length, 1);
});

test('a missing browser lock API fails before any wallet transaction request', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  const connected = wallet();
  const view = harness(connected);
  await waitFor(() => assert.ok(view.result.current.stats.data));
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), false); });
  assert.match(view.result.current.error ?? '', /Update your browser/);
  assert.equal(connected.sent.length, 0);
  assert.equal(view.result.current.busy, null);
});

test('pending storage is rechecked after acquiring the browser lock', async t => {
  let grant: (() => void) | undefined;
  t.mock.method(navigator.locks, 'request', async (_name, _options, callback) => {
    await new Promise<void>(resolve => { grant = resolve; });
    return callback({ name: 'granted', mode: 'exclusive' });
  });
  const connected = wallet();
  const view = harness(connected);
  await waitFor(() => assert.ok(view.result.current.stats.data));
  let mint: Promise<boolean> | undefined;
  act(() => { mint = view.result.current.mint('crate', 1); });
  await waitFor(() => assert.ok(grant));
  const scope = ethereumInventoryScope(config, owner)!;
  act(() => writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: Date.now() }));
  await act(async () => { grant!(); assert.equal(await mint, false); });
  assert.equal(connected.sent.length, 0);
  assert.equal(view.result.current.busy, null);
  assert.equal(readEthereumPending(scope)?.hash, hash);
});

for (const change of ['account', 'provider', 'unmount'] as const) {
  test(`a ${change} change before lock acquisition prevents the old action from sending`, async t => {
    let grant: (() => void) | undefined;
    t.mock.method(navigator.locks, 'request', async (_name, _options, callback) => {
      await new Promise<void>(resolve => { grant = resolve; });
      return callback({ name: 'granted', mode: 'exclusive' });
    });
    const connected = wallet();
    const view = harness(connected);
    await waitFor(() => assert.ok(view.result.current.stats.data));
    let mint: Promise<boolean> | undefined;
    act(() => { mint = view.result.current.mint('crate', 1); });
    await waitFor(() => assert.ok(grant));
    const replacement = wallet(change === 'account' ? other : owner);
    if (change === 'unmount') view.unmount();
    else view.rerender({ wallet: replacement });
    await act(async () => { grant!(); assert.equal(await mint, false); });
    assert.equal(connected.sent.length, 0);
    assert.equal(replacement.sent.length, 0);
    assert.equal(readEthereumOperation(ethereumInventoryScope(config, owner)!), null);
    assert.equal(readEthereumPending(ethereumInventoryScope(config, owner)!), null);
  });
}

for (const blockedStorage of [false, true]) {
  test(`a late finalization 401 preserves a fresh session for the same account${blockedStorage ? ' with blocked session storage' : ''}`, async t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const previousSession = savedSession(owner);
    const freshSession = { ...previousSession, token: 'fresh-session' };
    const scope = ethereumInventoryScope(config, owner)!;
    writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'delivery', orderId: 42, submittedAt: Date.now() });
    t.mock.method(ethereumApi, 'profile', async session => ({ wallet: session.address, addresses: [] }));
    t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
    t.mock.method(ethereumApi, 'logout', async () => ({}));
    t.mock.method(ethereumApi, 'challenge', async () => ({ challengeId: 'new-challenge', message: 'Sign in', expiresAtMs: Date.now() + 60_000 }));
    t.mock.method(ethereumApi, 'verify', async () => freshSession);
    t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'confirmed', confirmations: 3, items: [], burnedTokenIds: [] }));
    let rejectFinalization: ((cause: Error) => void) | undefined;
    const finalizedTokens: string[] = [];
    t.mock.method(ethereumApi, 'confirmDelivery', async (_order, _hash, session) => {
      finalizedTokens.push(session.token);
      if (session.token === previousSession.token) await new Promise<void>((_resolve, reject) => { rejectFinalization = reject; });
      return { status: 'confirmed', confirmations: 3, orderId: 42 };
    });
    const connected = wallet();
    const originalRequest = connected.provider!.request;
    connected.provider!.request = async args => args.method === 'personal_sign' ? `0x${'ab'.repeat(65)}` : originalRequest(args);
    const view = harness(connected);
    await waitFor(() => assert.ok(rejectFinalization));
    act(() => view.result.current.disconnect());
    view.rerender({ wallet: wallet(null) });
    view.rerender({ wallet: connected });
    if (blockedStorage) Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
    await act(async () => { assert.equal(await view.result.current.signIn(), true); });
    assert.equal(view.result.current.session?.token, freshSession.token);
    await act(async () => { rejectFinalization!(new EthereumApiError(401, 'Old session expired', null, previousSession.token)); });
    assert.equal(view.result.current.session?.token, freshSession.token);
    assert.equal(view.result.current.error, null);
    if (!blockedStorage) assert.equal(readEthereumSession(scope, config, owner)?.token, freshSession.token);
    now++;
    act(() => view.result.current.refresh());
    await waitFor(() => assert.equal(view.result.current.pending, null));
    assert.deepEqual(finalizedTokens, [previousSession.token, freshSession.token]);
  });
}

for (const endpoint of ['profile', 'shipments'] as const) {
  test(`a current ${endpoint} 401 clears its session even when storage becomes blocked`, async t => {
    const session = savedSession(owner);
    t.mock.method(ethereumApi, 'profile', async current => ({ wallet: current.address, addresses: [] }));
    t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
    let rejectRequest: ((cause: Error) => void) | undefined;
    t.mock.method(ethereumApi, endpoint, () => new Promise((_resolve, reject) => { rejectRequest = reject; }));
    const view = harness();
    await waitFor(() => assert.ok(rejectRequest));
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
    await act(async () => { rejectRequest!(new EthereumApiError(401, 'Session expired', null, session.token)); });
    await waitFor(() => assert.equal(view.result.current.session, null));
  });
}

test('two mounted trackers both clear when one finishes the shared transaction', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: Date.now() });
  const minted = token();
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({
    items: expected.includes(minted.tokenId) ? [minted] : [], nextCursor: null, observedBlock: 1,
  }));
  const confirmations: ((result: EthereumTransactionConfirmResponse) => void)[] = [];
  t.mock.method(ethereumApi, 'confirm', () => new Promise<EthereumTransactionConfirmResponse>(resolve => { confirmations.push(resolve); }));
  const first = harness();
  await waitFor(() => assert.equal(confirmations.length, 1));
  const second = harness();
  await waitFor(() => assert.equal(confirmations.length, 2));
  const result: EthereumTransactionConfirmResponse = { status: 'confirmed', confirmations: 1, items: [minted], burnedTokenIds: [] };
  await act(async () => { confirmations[0](result); });
  await waitFor(() => assert.equal(first.result.current.pending, null));
  await waitFor(() => assert.equal(second.result.current.pending, null));
  await waitFor(() => assert.deepEqual(first.result.current.items, [minted]));
  await waitFor(() => assert.deepEqual(second.result.current.items, [minted]));
  await act(async () => { confirmations[1](result); });
  assert.equal(second.result.current.pending, null);
  assert.equal(readEthereumPending(scope), null);
});

test('browser storage events synchronize another tab’s replacement and completion', async () => {
  const scope = ethereumInventoryScope(config, owner)!;
  const key = `ethereum111k:${scope}:pending`;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: Date.now() });
  const view = harness();
  await waitFor(() => assert.equal(view.result.current.pending?.hash, hash));
  const replacementHash = `0x${'cd'.repeat(32)}`;
  act(() => {
    const newValue = JSON.stringify({ scope, hash: replacementHash, action: 'mint', submittedAt: Date.now() });
    window.localStorage.setItem(key, newValue);
    window.dispatchEvent(new window.StorageEvent('storage', { key, newValue, storageArea: window.localStorage }));
  });
  await waitFor(() => assert.equal(view.result.current.pending?.hash, replacementHash));
  act(() => {
    window.localStorage.removeItem(key);
    window.dispatchEvent(new window.StorageEvent('storage', { key, newValue: null, storageArea: window.sessionStorage }));
  });
  assert.equal(view.result.current.pending?.hash, replacementHash);
  act(() => {
    window.dispatchEvent(new window.StorageEvent('storage', { key, newValue: null, storageArea: window.localStorage }));
  });
  await waitFor(() => assert.equal(view.result.current.pending, null));
});

test('storage failure after broadcast retains the hash, warns, and reconciles the unboxed inventory', async t => {
  let confirmed = false;
  const artwork: EthereumInventoryItem = { ...token(owner, '1'), kind: 'artwork', name: 'Artwork #1' };
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: confirmed ? 'confirmed' as const : 'pending' as const, confirmations: confirmed ? 1 : 0,
    items: confirmed ? [artwork] : [], burnedTokenIds: confirmed ? ['111112'] : [] }));
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => ({ items: expected.includes('1') ? [artwork] : [token()], nextCursor: null, observedBlock: 1 }));
  const connected = wallet();
  const request = connected.provider!.request;
  connected.provider!.request = async args => {
    const result = await request(args);
    if (args.method === 'eth_sendTransaction') Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
    return result;
  };
  const first = harness(connected);
  await waitFor(() => assert.ok(first.result.current.scope));
  await act(async () => { assert.equal(await first.result.current.unbox(token()), true); });
  const scope = ethereumInventoryScope(config, owner)!;
  assert.equal(readEthereumPending(scope)?.hash, hash);
  assert.match(first.result.current.storageWarning ?? '', new RegExp(hash));
  first.unmount();
  const second = harness(connected);
  await waitFor(() => assert.equal(second.result.current.pending?.hash, hash));
  assert.match(second.result.current.storageWarning ?? '', /Keep this tab open/);
  await act(async () => { assert.equal(await second.result.current.mint('crate', 1), false); });
  assert.equal(connected.sent.length, 1);
  confirmed = true;
  act(() => second.result.current.refresh());
  await waitFor(() => assert.equal(second.result.current.pending, null));
  await waitFor(() => assert.deepEqual(second.result.current.items, [artwork]));
  assert.deepEqual(second.result.current.revealed, [artwork]);
  assert.deepEqual(readEthereumExpected(scope), ['1']);
  assert.equal(readEthereumPending(scope), null);
});

for (const failure of ['blocked', 'full', 'silent'] as const) {
  test(`${failure} browser storage prevents wallet submission in separate windows`, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) {
        const locks = navigator.locks;
        await act(async () => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
        dom.window.close();
        ({ dom } = setupFrontendDom());
        Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
      }
      if (failure === 'blocked') Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
      else Object.defineProperty(window, 'localStorage', { configurable: true, value: {
        getItem: () => null, removeItem() {}, setItem() { if (failure === 'full') throw new Error('Quota exceeded'); },
      } });
      const connected = wallet();
      const view = harness(connected);
      await waitFor(() => assert.ok(view.result.current.stats.data));
      await act(async () => { assert.equal(await view.result.current.mint('crate', 1), false); });
      assert.match(view.result.current.error ?? '', /Browser storage is unavailable/);
      assert.equal(connected.sent.length, 0);
      assert.equal(view.result.current.pending, null);
    }
  });
}

for (const actualNonce of ['0x7', '0x8']) test(`a failed post-broadcast write recovers wallet nonce ${actualNonce} after reload`, async () => {
  const connected = wallet();
  const request = connected.provider!.request;
  const storage = window.localStorage;
  connected.provider!.request = async args => {
    const result = await request(args);
    if (args.method === 'eth_sendTransaction') Object.defineProperty(window, 'localStorage', { configurable: true, value: {
      getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage), setItem() { throw new Error('Quota exceeded'); },
    } });
    return result;
  };
  const first = harness(connected);
  await waitFor(() => assert.ok(first.result.current.stats.data));
  await act(async () => { assert.equal(await first.result.current.mint('crate', 1), true); });
  assert.equal(first.result.current.pending?.hash, hash);
  assert.equal(first.result.current.pending?.nonce, undefined);
  assert.match(first.result.current.storageWarning ?? '', /Transaction sent/);
  const scope = ethereumInventoryScope(config, owner)!;
  const key = `ethereum111k:${scope}:pending`;
  const reserved = storage.getItem(key)!;
  assert.equal(JSON.parse(reserved).awaitingHash, true);
  assert.equal(JSON.parse(reserved).nonce, '0x7');
  const locks = navigator.locks;
  await act(async () => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
  dom.window.close();
  ({ dom } = setupFrontendDom());
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
  window.localStorage.setItem(key, reserved);
  const nextWallet = wallet();
  const nextRequest = nextWallet.provider!.request;
  const oldHash = `0x${'cd'.repeat(32)}`;
  let matchingIntent = false;
  nextWallet.provider!.request = async args => args.method === 'eth_getTransactionByHash'
    ? { hash: (args.params as string[])[0], from: owner, to: contract, input: matchingIntent ? JSON.parse(reserved).intent.data : '0x1234', value: JSON.parse(reserved).intent.value,
      nonce: (args.params as string[])[0] === oldHash ? '0x6' : actualNonce, chainId: '0xaa36a7' }
    : nextRequest(args);
  const second = harness(nextWallet);
  await waitFor(() => assert.ok(second.result.current.stats.data));
  assert.ok(second.result.current.submission);
  assert.equal(second.result.current.pending, null);
  await act(async () => { assert.equal(await second.result.current.mint('crate', 1), false); });
  assert.equal(nextWallet.sent.length, 0);
  await act(async () => { assert.equal(await second.result.current.replacePending(hash), false); });
  assert.match(second.result.current.error ?? '', /does not match the saved/);
  assert.ok(second.result.current.submission);
  matchingIntent = true;
  await act(async () => { assert.equal(await second.result.current.replacePending(oldHash), false); });
  assert.match(second.result.current.error ?? '', /does not match the saved Ethereum request nonce/);
  assert.ok(second.result.current.submission);
  assert.equal(second.result.current.pending, null);
  await act(async () => { assert.equal(await second.result.current.replacePending(hash), true); });
  assert.equal(second.result.current.pending?.hash, hash);
  assert.equal(second.result.current.pending?.nonce, actualNonce);
  assert.equal(second.result.current.submission, null);
  assert.equal(second.result.current.storageWarning, null);
  assert.equal(readEthereumSubmission(scope), null);
  assert.equal(JSON.parse(window.localStorage.getItem(key)!).hash, hash);
});

for (const readBlocked of [false, true]) {
  for (const replacement of ['reservation', 'transaction', 'removed'] as const) {
    test(`recovery fallback yields to ${replacement} before storage events after ${readBlocked ? 'blocked' : 'readable'} storage failure`, () => {
      const scope = ethereumInventoryScope(config, owner)!;
      const key = `ethereum111k:${scope}:pending`;
      const storage = window.localStorage;
      const submittedAt = Date.now();
      const intent = { to: contract, data: '0x', value: '0x0' };
      reserveEthereumSubmission({ scope, action: 'mint', nonce: '0x7', submittedAt, intent });
      if (readBlocked) Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
      else Object.defineProperty(window, 'localStorage', { configurable: true, value: {
        getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage), setItem() { throw new Error('Quota exceeded'); },
      } });
      writeEthereumStorage(`${scope}:pending`, { scope, action: 'mint', hash, submittedAt, intent });
      assert.equal(readEthereumPending(scope)?.hash, hash);
      Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
      assert.equal(readEthereumPending(scope)?.hash, hash, 'The original reservation must retain its actual in-memory hash');
      const nextHash = `0x${'cd'.repeat(32)}`;
      if (replacement === 'removed') storage.removeItem(key);
      else storage.setItem(key, JSON.stringify({ scope, action: 'mint', submittedAt: submittedAt + 1, nonce: '0x8', intent,
        hash: replacement === 'transaction' ? nextHash : `0x${'0'.repeat(64)}`,
        ...(replacement === 'reservation' ? { awaitingHash: true } : {}),
      }));
      assert.equal(readEthereumPending(scope)?.hash ?? null, replacement === 'transaction' ? nextHash : null);
      assert.equal(readEthereumSubmission(scope)?.nonce ?? null, replacement === 'reservation' ? '0x8' : null);
    });
  }
}

for (const method of ['eth_accounts', 'eth_chainId']) {
  test(`a repeated ${method} failure leaves no submission marker and permits retry after remount`, async () => {
    const connected = wallet();
    const request = connected.provider!.request;
    let nonceRead = false;
    let fail = true;
    connected.provider!.request = async args => {
      if (args.method === 'eth_getTransactionCount') nonceRead = true;
      if (args.method === method && nonceRead && fail) throw new Error('Provider temporarily unavailable');
      return request(args);
    };
    const first = harness(connected);
    await waitFor(() => assert.ok(first.result.current.stats.data));
    await act(async () => { assert.equal(await first.result.current.mint('crate', 1), false); });
    const scope = ethereumInventoryScope(config, owner)!;
    assert.equal(first.result.current.error, 'Provider temporarily unavailable');
    assert.equal(connected.sent.length, 0);
    assert.equal(readEthereumSubmission(scope), null);
    assert.equal(window.localStorage.getItem(`ethereum111k:${scope}:pending`), null);
    first.unmount();
    fail = false;
    const second = harness(connected);
    await waitFor(() => assert.ok(second.result.current.stats.data));
    await act(async () => { assert.equal(await second.result.current.mint('crate', 1), true); });
    assert.equal(connected.sent.length, 1);
    assert.equal(readEthereumPending(scope)?.hash, hash);
  });
}

test('an uncertain wallet error preserves the submission marker for recovery', async () => {
  const connected = wallet();
  const request = connected.provider!.request;
  connected.provider!.request = async args => {
    if (args.method === 'eth_sendTransaction') {
      assert.ok(readEthereumSubmission(ethereumInventoryScope(config, owner)!));
      throw new Error('Wallet disconnected');
    }
    return request(args);
  };
  const view = harness(connected);
  await waitFor(() => assert.ok(view.result.current.stats.data));
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), false); });
  assert.ok(view.result.current.submission);
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), false); });
  assert.match(view.result.current.error ?? '', /recover the previous/);
  await act(async () => { await view.result.current.dismissPending(); });
  assert.equal(view.result.current.submission, null);
});

test('an invalid pending nonce prevents wallet submission before reserving recovery', async () => {
  const connected = wallet();
  const request = connected.provider!.request;
  connected.provider!.request = async args => args.method === 'eth_getTransactionCount' ? null : request(args);
  const view = harness(connected);
  await waitFor(() => assert.ok(view.result.current.stats.data));
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), false); });
  assert.match(view.result.current.error ?? '', /valid transaction nonce/);
  assert.equal(connected.sent.length, 0);
  assert.equal(view.result.current.submission, null);
  assert.equal(view.result.current.pending, null);
  assert.equal(readEthereumSubmission(view.result.current.scope!), null);
  assert.equal(readEthereumPending(view.result.current.scope!), null);
});

test('a confirmed transaction finishes when its stored record has already disappeared', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: Date.now() });
  let finish: ((result: EthereumTransactionConfirmResponse) => void) | undefined;
  t.mock.method(ethereumApi, 'confirm', () => new Promise<EthereumTransactionConfirmResponse>(resolve => { finish = resolve; }));
  const view = harness();
  await waitFor(() => assert.ok(finish));
  window.localStorage.removeItem(`ethereum111k:${scope}:pending`);
  await act(async () => { finish!({ status: 'confirmed', confirmations: 1, items: [token()], burnedTokenIds: [] }); });
  await waitFor(() => assert.equal(view.result.current.pending, null));
  assert.deepEqual(readEthereumExpected(scope), [token().tokenId]);
});

for (const outcome of ['confirmed', 'reverted'] as const) {
  for (const newer of ['none', 'reservation', 'transaction'] as const) {
    test(`${outcome} cleanup waits for the submission lock and rechecks ${newer === 'none' ? 'the original transaction' : `a newer ${newer}`}`, async t => {
      const scope = ethereumInventoryScope(config, owner)!;
      const key = `ethereum111k:${scope}:pending`;
      writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: 1 });
      let finish: (() => void) | undefined;
      t.mock.method(ethereumApi, 'confirm', () => new Promise<EthereumTransactionConfirmResponse>((resolve, reject) => {
        finish = () => outcome === 'confirmed'
          ? resolve({ status: 'confirmed', confirmations: 1, items: [token()], burnedTokenIds: [] })
          : reject(new EthereumApiError(409, 'Reverted', 'transaction-reverted'));
      }));
      const view = harness();
      await waitFor(() => assert.ok(finish));
      let release: (() => void) | undefined;
      const competing = navigator.locks.request(`ethereum111k-submission:${scope}`, { ifAvailable: true }, async lock => {
        assert.ok(lock);
        await new Promise<void>(resolve => { release = resolve; });
      });
      const requests = t.mock.method(navigator.locks, 'request');
      await act(async () => { finish!(); });
      await waitFor(() => assert.equal(requests.mock.callCount(), 1));
      assert.equal(readEthereumPending(scope)?.hash, hash);
      assert.doesNotMatch(view.result.current.error ?? '', /already in progress/);
      const replacement = newer === 'none' ? null : JSON.stringify({ scope, action: 'mint', submittedAt: 2, nonce: '0x8',
        hash: `0x${(newer === 'reservation' ? '00' : 'cd').repeat(32)}`, ...(newer === 'reservation' ? { awaitingHash: true } : {}) });
      if (replacement) window.localStorage.setItem(key, replacement);
      await act(async () => { release!(); await competing; });
      assert.equal(window.localStorage.getItem(key), replacement);
      assert.deepEqual(readEthereumExpected(scope), outcome === 'confirmed' && newer === 'none' ? [token().tokenId] : []);
      if (newer === 'none') assert.equal(view.result.current.pending, null);
    });
  }
}

test('stop-tracking rechecks the displayed transaction after waiting for another tab', async () => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: 1 });
  const view = harness();
  await waitFor(() => assert.equal(view.result.current.pending?.hash, hash));
  let release: (() => void) | undefined;
  const competing = navigator.locks.request(`ethereum111k-submission:${scope}`, { ifAvailable: true }, async lock => {
    assert.ok(lock);
    await new Promise<void>(resolve => { release = resolve; });
  });
  let dismissed: Promise<void> | undefined;
  act(() => { dismissed = view.result.current.dismissPending(); });
  assert.equal(readEthereumPending(scope)?.hash, hash);
  const nextHash = `0x${'cd'.repeat(32)}`;
  window.localStorage.setItem(`ethereum111k:${scope}:pending`, JSON.stringify({ scope, hash: nextHash, action: 'mint', submittedAt: 2 }));
  await act(async () => { release!(); await competing; await dismissed; });
  assert.equal(readEthereumPending(scope)?.hash, nextHash);
  assert.equal(view.result.current.notice, null);
});

for (const failure of ['missing', 'error'] as const) {
  for (const reload of [false, true]) {
    test(`nonce capture retries ${failure} RPC results${reload ? ' after reload' : ''} and enables replacement recovery`, async t => {
      speedUpConfirmationPolls(t);
      const connected = wallet();
      const request = connected.provider!.request;
      const replacementHash = `0x${'cd'.repeat(32)}`;
      let sentTransaction: Record<string, unknown> | undefined;
      let visible = false;
      let removed = false;
      let lookups = 0;
      connected.provider!.request = async args => {
        if (args.method === 'eth_sendTransaction') sentTransaction = (args.params as Record<string, unknown>[])[0];
        if (args.method !== 'eth_getTransactionByHash') return request(args);
        const requestedHash = (args.params as string[])[0];
        if (requestedHash === hash) {
          lookups++;
          if (removed) return null;
          if (!visible) {
            if (failure === 'error') throw new Error('RPC temporarily unavailable');
            return null;
          }
        }
        return { hash: requestedHash, from: owner, to: contract, input: sentTransaction!.data,
          value: sentTransaction!.value, nonce: '0x8', chainId: '0xaa36a7' };
      };
      let view = harness(connected);
      await waitFor(() => assert.ok(view.result.current.stats.data));
      await act(async () => { assert.equal(await view.result.current.mint('crate', 1), true); });
      await waitFor(() => assert.ok(lookups > 0));
      const scope = ethereumInventoryScope(config, owner)!;
      assert.equal(readEthereumPending(scope)?.nonce, undefined);
      if (reload) {
        view.unmount();
        view.client.clear();
        const previousLookups = lookups;
        view = harness(connected);
        await waitFor(() => assert.ok(lookups > previousLookups));
        assert.equal(readEthereumPending(scope)?.nonce, undefined);
      }
      visible = true;
      await waitFor(() => assert.equal(readEthereumPending(scope)?.nonce, '0x8'));
      removed = true;
      const capturedLookups = lookups;
      await act(async () => { assert.equal(await view.result.current.replacePending(replacementHash), true); });
      assert.equal(readEthereumPending(scope)?.hash, replacementHash);
      assert.equal(readEthereumPending(scope)?.nonce, '0x8');
      assert.equal(lookups, capturedLookups);
    });
  }
}

test('late nonce enrichment rechecks the transaction under the submission lock', async t => {
  const connected = wallet();
  const request = connected.provider!.request;
  const finishLookups: ((value: unknown) => void)[] = [];
  let sentTransaction: Record<string, unknown> | undefined;
  connected.provider!.request = async args => {
    if (args.method === 'eth_getTransactionByHash') return new Promise(resolve => { finishLookups.push(resolve); });
    if (args.method === 'eth_sendTransaction') sentTransaction = (args.params as Record<string, unknown>[])[0];
    return request(args);
  };
  const view = harness(connected);
  await waitFor(() => assert.ok(view.result.current.stats.data));
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), true); });
  assert.ok(finishLookups.length && sentTransaction);
  const scope = ethereumInventoryScope(config, owner)!;
  let release: (() => void) | undefined;
  const competing = navigator.locks.request(`ethereum111k-submission:${scope}`, { ifAvailable: true }, async lock => {
    assert.ok(lock);
    await new Promise<void>(resolve => { release = resolve; });
  });
  const requests = t.mock.method(navigator.locks, 'request');
  await act(async () => { finishLookups.forEach(finish => finish({ hash, from: owner, to: contract, input: sentTransaction!.data,
    value: sentTransaction!.value, nonce: '0x7', chainId: '0xaa36a7' })); });
  assert.equal(requests.mock.callCount(), finishLookups.length);
  assert.equal(readEthereumPending(scope)?.nonce, undefined);
  const nextHash = `0x${'cd'.repeat(32)}`;
  window.localStorage.setItem(`ethereum111k:${scope}:pending`, JSON.stringify({ scope, hash: nextHash, action: 'mint', submittedAt: 2 }));
  await act(async () => { release!(); await competing; });
  assert.equal(readEthereumPending(scope)?.hash, nextHash);
  assert.equal(readEthereumPending(scope)?.nonce, undefined);
});

test('late delivery finalization cannot clear a newer replacement transaction', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  savedSession(owner);
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'delivery', orderId: 42, submittedAt: Date.now() });
  const replacementHash = `0x${'cd'.repeat(32)}`;
  t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
  t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
  t.mock.method(ethereumApi, 'confirm', async transactionHash => ({ status: transactionHash === hash ? 'confirmed' as const : 'pending' as const,
    confirmations: transactionHash === hash ? 3 : 0, items: [], burnedTokenIds: [] }));
  let finishDelivery: (() => void) | undefined;
  t.mock.method(ethereumApi, 'confirmDelivery', async () => {
    await new Promise<void>(resolve => { finishDelivery = resolve; });
    return { status: 'confirmed', confirmations: 3 };
  });
  const view = harness();
  await waitFor(() => assert.ok(finishDelivery));
  act(() => writeEthereumStorage(`${scope}:pending`, { ...readEthereumPending(scope), hash: replacementHash }));
  await waitFor(() => assert.equal(view.result.current.pending?.hash, replacementHash));
  await act(async () => { finishDelivery!(); });
  assert.equal(view.result.current.pending?.hash, replacementHash);
  assert.equal(readEthereumPending(scope)?.hash, replacementHash);
});

for (const action of ['delivery', 'claim'] as const) {
  test(`late ${action} finalization preserves a new transaction reservation`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    savedSession(owner);
    writeEthereumStorage(`${scope}:pending`, { scope, hash, action, orderId: 42, claimId: hash, submittedAt: Date.now() });
    const nextHash = `0x${'cd'.repeat(32)}`;
    t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
    t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
    t.mock.method(ethereumApi, 'confirm', async transactionHash => ({
      status: transactionHash === hash ? 'confirmed' as const : 'pending' as const,
      confirmations: transactionHash === hash ? 3 : 0, items: [], burnedTokenIds: [],
    }));
    let finishOld: (() => void) | undefined;
    t.mock.method(ethereumApi, action === 'delivery' ? 'confirmDelivery' : 'confirmClaim', async () => {
      await new Promise<void>(resolve => { finishOld = resolve; });
      return { status: 'confirmed', confirmations: 3 };
    });
    const connected = wallet();
    const request = connected.provider!.request;
    let finishSend: ((hash: string) => void) | undefined;
    connected.provider!.request = async args => args.method === 'eth_sendTransaction'
      ? new Promise<string>(resolve => { finishSend = resolve; }) : request(args);
    const view = harness(connected);
    await waitFor(() => { assert.ok(finishOld); assert.ok(view.result.current.stats.data); });
    await act(async () => { await view.result.current.dismissPending(); });
    let nextMint: Promise<boolean> | undefined;
    act(() => { nextMint = view.result.current.mint('crate', 1); });
    await waitFor(() => assert.ok(finishSend));
    const key = `ethereum111k:${scope}:pending`;
    const reserved = window.localStorage.getItem(key);
    assert.equal(readEthereumSubmission(scope)?.action, 'mint');
    try {
      await act(async () => { finishOld!(); });
      assert.equal(window.localStorage.getItem(key), reserved);
      assert.equal(view.result.current.submission?.action, 'mint');
      assert.equal(readEthereumPending(scope), null);
    } finally {
      await act(async () => { finishSend!(nextHash); await nextMint; });
    }
    assert.equal(readEthereumPending(scope)?.hash, nextHash);
    assert.equal(readEthereumSubmission(scope), null);
  });
}

for (const failureCode of ['transaction-reverted', 'operation-failed']) test(`${failureCode} cleanup preserves a new reservation before its storage event arrives`, async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: Date.now() });
  let rejectConfirmation: ((error: Error) => void) | undefined;
  t.mock.method(ethereumApi, 'confirm', () => new Promise<EthereumTransactionConfirmResponse>((_resolve, reject) => {
    rejectConfirmation = reject;
  }));
  harness();
  await waitFor(() => assert.ok(rejectConfirmation));
  const key = `ethereum111k:${scope}:pending`;
  const reserved = JSON.stringify({ scope, hash: `0x${'0'.repeat(64)}`, awaitingHash: true,
    action: 'mint', nonce: '0x8', submittedAt: Date.now(), intent: { to: contract, data: '0x', value: '0x0' } });
  window.localStorage.setItem(key, reserved);
  await act(async () => { rejectConfirmation!(new EthereumApiError(409, 'Failed', failureCode)); });
  assert.equal(window.localStorage.getItem(key), reserved);
  assert.equal(readEthereumSubmission(scope)?.nonce, '0x8');
});

for (const action of ['delivery', 'claim'] as const) {
  test(`late ${action} finalization cannot clear a newer saved reservation hidden by its old fallback`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    savedSession(owner);
    const key = `ethereum111k:${scope}:pending`;
    const storage = window.localStorage;
    const submittedAt = Date.now();
    const intent = { to: contract, data: '0x', value: '0x0' };
    const submission = { scope, action, orderId: 42, claimId: hash, submittedAt, intent };
    reserveEthereumSubmission({ ...submission, nonce: '0x7' });
    Object.defineProperty(window, 'localStorage', { configurable: true, value: {
      getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage), setItem() { throw new Error('Quota exceeded'); },
    } });
    writeEthereumStorage(`${scope}:pending`, { ...submission, hash });
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
    t.mock.method(ethereumApi, 'profile', async () => ({ wallet: owner, addresses: [] }));
    t.mock.method(ethereumApi, 'shipments', async () => ({ orders: [] }));
    t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'confirmed' as const, confirmations: 3, items: [], burnedTokenIds: [] }));
    let finishOld: (() => void) | undefined;
    t.mock.method(ethereumApi, action === 'delivery' ? 'confirmDelivery' : 'confirmClaim', async () => {
      await new Promise<void>(resolve => { finishOld = resolve; });
      return { status: 'confirmed', confirmations: 3 };
    });
    const view = harness();
    await waitFor(() => assert.ok(finishOld));
    assert.equal(view.result.current.pending?.hash, hash);
    const reserved = JSON.stringify({ scope, hash: `0x${'0'.repeat(64)}`, awaitingHash: true,
      action: 'mint', nonce: '0x8', submittedAt: submittedAt + 1, intent });
    storage.setItem(key, reserved);
    await act(async () => { finishOld!(); });
    assert.equal(storage.getItem(key), reserved);
    assert.equal(readEthereumSubmission(scope)?.nonce, '0x8');
    act(() => window.dispatchEvent(new window.StorageEvent('storage', { key, storageArea: storage })));
    assert.equal(view.result.current.pending, null);
    assert.equal(view.result.current.submission?.nonce, '0x8');
  });
}

for (const submitted of [false, true]) {
  test(`a collection change ${submitted ? 'preserves an already submitted transaction' : 'aborts transaction preparation'}`, async () => {
    const connected = wallet();
    const request = connected.provider!.request;
    let resume: (() => void) | undefined;
    connected.provider!.request = async args => {
      const result = await request(args);
      if (args.method === (submitted ? 'eth_sendTransaction' : 'eth_getTransactionCount')) {
        await new Promise<void>(resolve => { resume = resolve; });
      }
      return result;
    };
    const view = harness(connected);
    await waitFor(() => assert.ok(view.result.current.stats.data));
    const previousScope = view.result.current.scope!;
    let mint: Promise<boolean> | undefined;
    act(() => { mint = view.result.current.mint('crate', 1); });
    await waitFor(() => assert.ok(resume));
    assert.equal(connected.sent.length, submitted ? 1 : 0);
    const replacement = resolveEthereum111kConfig({ contractAddress: '0x4444444444444444444444444444444444444444' });
    act(() => { view.client.setQueryData(['ethereum111k', 'config'], replacement); });
    await waitFor(() => assert.equal(view.result.current.scope, ethereumInventoryScope(replacement, owner)));
    await act(async () => { resume!(); assert.equal(await mint, submitted); });
    assert.equal(connected.sent.length, submitted ? 1 : 0);
    assert.equal(readEthereumPending(previousScope)?.hash ?? null, submitted ? hash : null);
    assert.equal(readEthereumSubmission(previousScope), null);
    assert.equal(readEthereumOperation(previousScope), null);
    assert.equal(view.result.current.pending, null);
    assert.equal(view.result.current.busy, null);
  });
}

const wrappedBlockHash = `0x${'ef'.repeat(32)}`;
function wrappedMintReceipt(transactionHash: string) {
  return { transactionHash, from: other, to: owner, status: '0x1', blockNumber: '0x65', blockHash: wrappedBlockHash, logs: [{
    address: contract,
    topics: ['0xf74beeed6afd1c86b1e7db3a5e02e09ce36876cd81ef0a532aab80ccab145aed', encodeAbi(['address'], [owner])],
    data: encodeAbi(['uint256', 'uint256', 'uint256'], [111112, 1, config.cratePriceWei]),
  }] };
}

for (const action of ['mint', 'transfer', 'unbox'] as const) {
  test(`a contract-wallet ${action} ${action === 'unbox' ? 'recovers its lost hash without a chain-height checkpoint' : 'keeps an ambiguous lost-hash submission blocked'} after reload`, async () => {
    const connected = wallet();
    const request = connected.provider!.request;
    const storage = window.localStorage;
    connected.provider!.request = async args => {
      if (args.method === 'eth_getTransactionByHash') return null;
      const result = await request(args);
      if (args.method === 'eth_sendTransaction') Object.defineProperty(window, 'localStorage', { configurable: true, value: {
        getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage), setItem() { throw new Error('Quota exceeded'); },
      } });
      return result;
    };
    const first = harness(connected);
    await waitFor(() => assert.ok(first.result.current.stats.data));
    await act(async () => {
      const submitted = action === 'mint' ? first.result.current.mint('crate', 1) : action === 'unbox' ? first.result.current.unbox(token()) :
        first.result.current.transfer({ ...token(owner, '2000001'), kind: 'crate_receipt' }, other);
      assert.equal(await submitted, true);
    });
    const scope = ethereumInventoryScope(config, owner)!;
    const key = `ethereum111k:${scope}:pending`;
    const reserved = storage.getItem(key)!;
    assert.equal(JSON.parse(reserved).awaitingHash, true);
    assert.equal(JSON.parse(reserved).nonce, '0x7');
    assert.equal(connected.sent.length, 1);
    const locks = navigator.locks;
    await act(async () => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
    dom.window.close();
    ({ dom } = setupFrontendDom());
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
    window.localStorage.setItem(key, reserved);
    const receipt = { ...wrappedMintReceipt(hash), blockNumber: '0x1' };
    if (action === 'unbox') receipt.logs = [{ address: contract,
      topics: ['0xe69ab792dddbde960afe57d10ae0b0010bff06941200790103ff188c4f2e00e1', encodeAbi(['uint256'], [111112]), encodeAbi(['address'], [owner])],
      data: encodeAbi(['uint256', 'uint256'], [1, 20]),
    }];
    if (action === 'transfer') receipt.logs = [{ address: contract,
      topics: [ETHEREUM_EVENT_TOPICS.Transfer, encodeAbi(['address'], [owner]), encodeAbi(['address'], [other]), encodeAbi(['uint256'], [2000001])], data: '0x',
    }];
    const restoredWallet = wallet();
    const restoredRequest = restoredWallet.provider!.request;
    restoredWallet.provider!.request = async args => {
      if (args.method === 'eth_getTransactionByHash') return { hash, from: other, to: owner, input: '0x1234', value: '0x0', nonce: '0x2', chainId: '0xaa36a7' };
      if (args.method === 'eth_getCode') { assert.deepEqual(args.params, [owner, 'latest']); return '0x6000'; }
      if (args.method === 'eth_getTransactionReceipt') { assert.deepEqual(args.params, [hash]); return receipt; }
      if (args.method === 'eth_getBlockByNumber') { assert.deepEqual(args.params, ['0x1', false]); return { hash: wrappedBlockHash }; }
      return restoredRequest(args);
    };
    const restored = harness(restoredWallet);
    await waitFor(() => assert.ok(restored.result.current.submission));
    await act(async () => { assert.equal(await restored.result.current.mint('crate', 1), false); });
    await act(async () => { assert.equal(await restored.result.current.replacePending(hash), action === 'unbox'); });
    assert.equal(restoredWallet.sent.length, 0);
    if (action !== 'unbox') {
      assert.match(restored.result.current.error ?? '', /cannot.*safely recover/i);
      assert.equal(restored.result.current.submission?.action, action);
      assert.equal(restored.result.current.pending, null);
      assert.equal(window.localStorage.getItem(key), reserved);
      await act(async () => { assert.equal(await restored.result.current.mint('crate', 1), false); });
      assert.equal(restoredWallet.sent.length, 0);
      return;
    }
    assert.equal(restored.result.current.submission, null);
    assert.equal(restored.result.current.pending?.hash, hash);
    assert.equal(restored.result.current.pending?.nonce, '0x2');
    assert.equal(restored.result.current.pending?.transactionSender, other);
    assert.equal(restored.result.current.pending?.intent?.to, contract);
    assert.equal(readEthereumSubmission(scope), null);
    assert.equal(JSON.parse(window.localStorage.getItem(key)!).hash, hash);
  });
}

test('a contract-wallet mint persists the relayer nonce and recovers a mined replacement after remount', async () => {
  const connected = wallet();
  const request = connected.provider!.request;
  const replacementHash = `0x${'cd'.repeat(32)}`;
  let originalAvailable = true;
  let originalLookups = 0;
  connected.provider!.request = async args => {
    if (args.method === 'eth_getTransactionByHash') {
      const transactionHash = (args.params as string[])[0];
      if (transactionHash === hash) {
        originalLookups++;
        if (!originalAvailable) return null;
      }
      return { hash: transactionHash, from: other, to: owner, input: '0x1234', value: '0x0', nonce: '0x2', chainId: '0xaa36a7' };
    }
    if (args.method === 'eth_getCode') { assert.deepEqual(args.params, [owner, 'latest']); return '0x6000'; }
    if (args.method === 'eth_getTransactionReceipt') { assert.deepEqual(args.params, [replacementHash]); return wrappedMintReceipt(replacementHash); }
    if (args.method === 'eth_getBlockByNumber') { assert.deepEqual(args.params, ['0x65', false]); return { hash: wrappedBlockHash }; }
    return request(args);
  };
  const first = harness(connected);
  await waitFor(() => assert.ok(first.result.current.stats.data));
  await act(async () => { assert.equal(await first.result.current.mint('crate', 1), true); });
  const scope = ethereumInventoryScope(config, owner)!;
  await waitFor(() => assert.equal(readEthereumPending(scope)?.nonce, '0x2'));
  assert.equal(readEthereumPending(scope)?.transactionSender, other);
  const transactionCallHash = readEthereumPending(scope)?.transactionCallHash;
  assert.match(transactionCallHash ?? '', /^0x[0-9a-f]{64}$/);
  assert.equal(connected.sent.length, 1);
  first.unmount();
  first.client.clear();
  originalAvailable = false;
  const completedLookups = originalLookups;
  const restored = harness(connected);
  await waitFor(() => assert.equal(restored.result.current.pending?.hash, hash));
  assert.equal(restored.result.current.pending?.transactionCallHash, transactionCallHash);
  await act(async () => { assert.equal(await restored.result.current.replacePending(replacementHash), true); });
  assert.equal(originalLookups, completedLookups);
  assert.equal(connected.sent.length, 1);
  assert.equal(restored.result.current.pending?.hash, replacementHash);
  assert.equal(restored.result.current.pending?.nonce, '0x2');
  assert.equal(restored.result.current.pending?.transactionSender, other);
  assert.equal(restored.result.current.pending?.transactionCallHash, transactionCallHash);
  assert.equal(restored.result.current.pending?.action, 'mint');
  assert.equal(readEthereumSubmission(scope), null);
});

test('a known contract-wallet unbox recovers a new relayer transaction and unblocks subsequent actions', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  const replacementHash = `0x${'cd'.repeat(32)}`;
  const newRelayer = '0x4444444444444444444444444444444444444444';
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'unbox', submittedAt: Date.now(), nonce: '0x2', transactionSender: other,
    intent: { to: contract, data: encodeCall('unboxCrate(uint256)', ['uint256'], [111112]), value: '0x0' } });
  const connected = wallet();
  const request = connected.provider!.request;
  let originalLookups = 0;
  connected.provider!.request = async args => {
    if (args.method === 'eth_getTransactionByHash') {
      if ((args.params as string[])[0] === hash) { originalLookups++; return null; }
      return { hash: replacementHash, from: newRelayer, to: owner, input: '0x5678', value: '0x0', nonce: '0x9', chainId: '0xaa36a7' };
    }
    if (args.method === 'eth_getCode') return '0x6000';
    if (args.method === 'eth_getTransactionReceipt') return { ...wrappedMintReceipt(replacementHash), from: newRelayer, logs: [{ address: contract,
      topics: ['0xe69ab792dddbde960afe57d10ae0b0010bff06941200790103ff188c4f2e00e1', encodeAbi(['uint256'], [111112]), encodeAbi(['address'], [owner])],
      data: encodeAbi(['uint256', 'uint256'], [1, 20]),
    }] };
    if (args.method === 'eth_getBlockByNumber') return { hash: wrappedBlockHash };
    return request(args);
  };
  const view = harness(connected);
  await waitFor(() => { assert.equal(view.result.current.pending?.hash, hash); assert.ok(view.result.current.stats.data); });
  await act(async () => { assert.equal(await view.result.current.replacePending(replacementHash), true); });
  assert.equal(view.result.current.pending?.hash, replacementHash);
  assert.equal(view.result.current.pending?.transactionSender, newRelayer);
  assert.equal(view.result.current.pending?.nonce, '0x9');
  assert.equal(originalLookups, 0);
  t.mock.method(ethereumApi, 'confirm', async transactionHash => ({ status: transactionHash === replacementHash ? 'confirmed' : 'pending',
    confirmations: transactionHash === replacementHash ? 1 : 0,
    items: transactionHash === replacementHash ? [{ ...token(owner, '1'), kind: 'artwork' }] : [],
    burnedTokenIds: transactionHash === replacementHash ? ['111112'] : [] }));
  act(() => view.result.current.refresh());
  await waitFor(() => assert.equal(view.result.current.pending, null));
  assert.equal(readEthereumPending(scope), null);
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), true); });
  assert.equal(connected.sent.length, 1);
});
