import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement, type PropsWithChildren } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { encodeCall } from '../shared/ethereum/abi.ts';
import { ETHEREUM_FUNCTIONS, ethereumAssetId } from '../shared/ethereum/protocol.ts';
import type { EthereumInventoryItem, EthereumTransactionConfirmResponse } from '../shared/ethereum/api.ts';
import type { EthereumRevealTransactionResponse } from '../shared/ethereum/reveal.ts';
import type { EIP1193Provider } from '../src/wallet/injectedEthereumProviders.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useEthereum111k } = await import('../src/ethereum/useEthereum111k.ts');
const { ethereumApi, EthereumApiError } = await import('../src/ethereum/api.ts');
const { ethereumRevealApi } = await import('../src/ethereum/revealApi.ts');
const { ethereumDiscounts, EMPTY_ETHEREUM_DISCOUNT_ROOT } = await import('../src/ethereum/discounts.ts');
const { ethereumInventoryScope, readEthereumExpected, readEthereumPending, readEthereumRevealJobs, rememberEthereumRevealJob, writeEthereumStorage } = await import('../src/ethereum/state.ts');
const { ETHEREUM_DROP_OPERATION_TTL, readEthereumDropOperations, writeEthereumDropOperation } = await import('../src/ethereum/dropOperations.ts');
const { rememberEthereumConfirmedInventory } = await import('../src/ethereum/confirmedInventory.ts');
type Wallet = Parameters<typeof useEthereum111k>[0];
dom.window.close();

const owner = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const contract = '0x3333333333333333333333333333333333333333';
const config = resolveEthereum111kConfig({ contractAddress: contract });
const scope = ethereumInventoryScope(config, owner)!;
const hashFor = (index: number) => `0x${index.toString(16).padStart(64, 'a')}`;
const statistics = { chainId: config.chainId, contractAddress: contract, owner, allocatedCrates: 0, warehousesMinted: 0, relicsAllocated: 0, relicsMinted: 0, artworksMinted: 0,
  cratePriceWei: config.cratePriceWei, warehousePriceWei: config.warehousePriceWei, saleActive: true, remainingCrates: 5555, remainingWarehouses: 505, remainingRelics: 18,
  discountMerkleRoot: EMPTY_ETHEREUM_DISCOUNT_ROOT, discountCratePriceWei: '50000000000000', discountAllowance: 1, discountUsed: 0 };
const relicStatus = { chainId: config.chainId, contractAddress: contract, owner, observedBlock: 1, blockHash: `0x${'0'.repeat(64)}`,
  saleActive: true, relicsAllocated: 18, relicsMinted: 0, remainingRelics: 18, claimedMask: 0, relicLimit: 2, relicsUsed: 0, remainingAllowance: 2 };
const clients: InstanceType<typeof QueryClient>[] = [];
let confirmations: Map<string, EthereumTransactionConfirmResponse | Error>;
let reveals: Map<string, EthereumRevealTransactionResponse>;

beforeEach(context => {
  const t = context as TestContext;
  ({ dom } = setupFrontendDom());
  confirmations = new Map();
  reveals = new Map();
  t.mock.method(ethereumApi, 'config', async () => config);
  t.mock.method(ethereumApi, 'stats', async (_config, address) => ({ ...statistics, owner: address }));
  t.mock.method(ethereumApi, 'relics', async (_config, address) => ({ ...relicStatus, owner: address }));
  t.mock.method(ethereumApi, 'relicMetadata', async () => []);
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [], nextCursor: null, observedBlock: 1 }));
  t.mock.method(ethereumApi, 'confirm', async transactionHash => {
    const result = confirmations.get(transactionHash);
    if (result instanceof Error) throw result;
    return result ?? { status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] };
  });
  t.mock.method(ethereumRevealApi, 'transaction', async (_config, transactionHash) => reveals.get(transactionHash) ?? {
    chainId: config.chainId, contractAddress: contract, dropId: config.dropId, deploymentId: 'test', status: 'pending', artworks: [], retryAfterMs: 2_000,
  });
  t.mock.method(ethereumRevealApi, 'tokens', async (_config, tokenIds) => ({ chainId: config.chainId, contractAddress: contract,
    dropId: config.dropId, deploymentId: 'test', artworks: [], retryAfterMs: 2_000,
    unresolved: tokenIds.map(tokenId => ({ tokenId, status: 'recovering' as const })) }));
  const schedule = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    schedule(callback, delay === 4_000 ? 20 : delay, ...args));
});
afterEach(async () => {
  await act(async () => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
  dom.window.close();
});

function token(tokenId = '111112', address = owner, kind: EthereumInventoryItem['kind'] = 'crate'): EthereumInventoryItem {
  return { id: ethereumAssetId(config.chainId, contract, tokenId), tokenId, chainId: config.chainId, contractAddress: contract,
    owner: address, displayId: Number(tokenId), kind, name: `${kind} ${tokenId}`, image: 'data:image/svg+xml,%3Csvg/%3E' };
}
function wallet(address: string | null = owner) {
  const transactions = new Map<string, Record<string, unknown>>();
  const sent: unknown[] = [];
  const provider: EIP1193Provider = { request: async ({ method, params }) => {
    if (method === 'eth_accounts') return address ? [address] : [];
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_sendTransaction') {
      sent.push(params);
      const hash = hashFor(sent.length);
      const transaction = (params as Record<string, unknown>[])[0];
      transactions.set(hash, { ...transaction, input: transaction.data, hash, nonce: `0x${sent.length.toString(16)}` });
      return hash;
    }
    if (method === 'eth_getTransactionByHash') return transactions.get((params as string[])[0]) ?? null;
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_getTransactionReceipt') return null;
    throw new Error(`Unexpected ${method}`);
  } };
  let connections = 0;
  const result: Wallet = { address, provider: address ? provider : null, status: address ? 'connected' : 'disconnected', ready: true,
    wallets: [], error: null, connect() { connections++; }, disconnect() {}, cancel() {}, selectWallet() {}, chooseWallet() {}, changeAccount() {}, checkAccount() {} };
  return { ...result, sent, transactions, get connections() { return connections; } };
}
function harness(initialWallet = wallet(), kind: Parameters<typeof useEthereum111k>[1] = 'crate', strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return { ...renderHook(({ wallet: current, mintKind }) => useEthereum111k(current, mintKind), {
    initialProps: { wallet: initialWallet, mintKind: kind }, wrapper, reactStrictMode: strict,
  }), client };
}
async function ready(view: ReturnType<typeof harness>) {
  await waitFor(() => assert.equal(view.result.current.stats.isSuccess, true));
  await waitFor(() => assert.equal(view.result.current.inventory.isSuccess, true));
}
async function mint(view: ReturnType<typeof harness>, kind: 'crate' | 'warehouse' = 'crate', quantity = 1) {
  let succeeded = false;
  await act(async () => { succeeded = await view.result.current.mint(kind, quantity); });
  assert.equal(succeeded, true);
}
function savedOperation(hash = hashFor(1), submittedAt = Date.now()) {
  return { id: 'restored', scope, action: 'mint' as const, kind: 'crate' as const, quantity: 1, sourceTokenIds: [], discountedQuantity: 0, submittedAt, hash,
    intent: { to: contract, data: encodeCall(ETHEREUM_FUNCTIONS.mintCrates, ['uint256'], [1]), value: '0x0' } };
}

function manualRecoveryTicks(t: TestContext) {
  const schedule = globalThis.setInterval;
  const cancel = globalThis.clearInterval;
  const callbacks = new Map<ReturnType<typeof setInterval>, () => void>();
  t.mock.method(globalThis, 'setInterval', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const timer = schedule(callback, delay === 4_000 ? 2_147_483_647 : delay, ...args);
    if (delay === 4_000) callbacks.set(timer, () => callback(...args));
    return timer;
  });
  t.mock.method(globalThis, 'clearInterval', (timer: Parameters<typeof clearInterval>[0]) => {
    callbacks.delete(timer as ReturnType<typeof setInterval>);
    cancel(timer);
  });
  return async () => { await act(async () => { for (const callback of [...callbacks.values()]) callback(); }); };
}

async function foreignCompletedCrateReveal(t: TestContext, confirmed = true) {
  const tick = manualRecoveryTicks(t);
  const source = token();
  const hash = hashFor(1);
  const response: EthereumRevealTransactionResponse = { chainId: config.chainId, contractAddress: contract,
    dropId: config.dropId, deploymentId: 'test', status: 'revealed', retryAfterMs: 0, artworks: [{
      tokenId: '1', crateTokenId: source.tokenId, name: 'Painting', description: '', image: 'https://cdn.mons.shop/111k/paintings/1.png', category: 'painting',
      attributes: [], aspectRatio: { width: 1, height: 1 }, observation: { transactionHash: hash, blockHash: hashFor(9), blockNumber: 1 },
    }] };
  if (confirmed) confirmations.set(hash, { status: 'confirmed', confirmations: 1,
    items: [token('1', owner, 'artwork')], burnedTokenIds: [source.tokenId] });
  const gate = Promise.withResolvers<EthereumRevealTransactionResponse>();
  const signals: AbortSignal[] = [];
  const request = t.mock.method(ethereumRevealApi, 'transaction', async (_config, transactionHash, signal) => {
    assert.equal(transactionHash, hash);
    signals.push(signal!);
    return signals.length === 1 ? gate.promise : response;
  });
  const first = harness();
  await ready(first);
  await act(async () => { assert.equal(await first.result.current.unbox(source), hash); });
  await waitFor(() => assert.equal(request.mock.callCount(), 1));
  if (confirmed) await waitFor(() => assert.equal(first.result.current.operations.length, 0));
  const second = harness();
  await waitFor(() => assert.equal(second.result.current.unpackResults[hash]?.length, 1));
  await waitFor(() => assert.deepEqual(readEthereumRevealJobs(scope), []));
  assert.equal(request.mock.callCount(), 2);
  assert.equal(first.result.current.unpackResults[hash], undefined);
  return { first, second, gate, response, hash, tick, request, signals };
}

test('inventory loads without Solana or a wallet interaction, and late old-owner inventory cannot replace the new owner', async t => {
  let finish!: (result: { items: EthereumInventoryItem[]; nextCursor: null; observedBlock: number }) => void;
  t.mock.method(ethereumApi, 'inventory', async (_config, address) => address === owner ? new Promise(resolve => { finish = resolve; }) : { items: [token('111113', other)], nextCursor: null, observedBlock: 1 });
  const first = wallet();
  const view = harness(first);
  await waitFor(() => assert.ok(finish));
  view.rerender({ wallet: wallet(other), mintKind: 'crate' });
  await waitFor(() => assert.equal(view.result.current.items[0]?.owner, other));
  await act(async () => finish({ items: [token()], nextCursor: null, observedBlock: 1 }));
  assert.equal(view.result.current.items[0]?.owner, other);
  assert.equal(first.connections, 0);
  assert.equal(first.sent.length, 0);
});

test('two mint submissions keep independent placeholders and confirm in either order', async () => {
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await mint(view, 'crate', 2);
  assert.equal(view.result.current.busy, null);
  await mint(view, 'warehouse');
  assert.equal(connected.sent.length, 2);
  assert.deepEqual(view.result.current.pendingMints.map(item => [item.kind, item.quantity]), [['crate', 2], ['warehouse', 1]]);
  confirmations.set(hashFor(2), { status: 'confirmed', confirmations: 1, items: [token('116667', owner, 'warehouse')], burnedTokenIds: [] });
  await waitFor(() => assert.equal(view.result.current.pendingMints.length, 1));
  assert.equal(view.result.current.pendingMints[0].kind, 'crate');
  confirmations.set(hashFor(1), { status: 'confirmed', confirmations: 1, items: [token(), token('111113')], burnedTokenIds: [] });
  await waitFor(() => assert.equal(view.result.current.pendingMints.length, 0));
  assert.deepEqual(new Set(readEthereumExpected(scope)), new Set(['116667', '111112', '111113']));
  assert.equal(readEthereumPending(scope), null);
});

test('a pending mint allows an unrelated unpack and only its source is locked', async () => {
  const view = harness();
  await ready(view);
  await mint(view);
  let unpackHash: string | null = null;
  await act(async () => { unpackHash = await view.result.current.unbox(token('116667', owner, 'warehouse')); });
  assert.equal(unpackHash, hashFor(2));
  assert.deepEqual([...view.result.current.pendingItemIds], [token('116667', owner, 'warehouse').id]);
  await act(async () => { assert.equal(await view.result.current.unbox(token('116667', owner, 'warehouse')), null); });
  await act(async () => { assert.equal(await view.result.current.unbox(token('117172', owner, 'relic')), hashFor(3)); });
  confirmations.set(hashFor(2), { status: 'confirmed', confirmations: 1, items: [token(), token('111113')], burnedTokenIds: ['116667'] });
  await waitFor(() => assert.equal(view.result.current.unpackResults[hashFor(2)]?.length, 2));
  assert.equal(view.result.current.pendingMints.length, 1);
  assert.equal(view.result.current.pendingItemIds.has(token('116667', owner, 'warehouse').id), false);
  assert.equal(view.result.current.pendingItemIds.has(token('117172', owner, 'relic').id), true);
});

test('the wallet request guard rejects duplicate calls only until broadcast', async t => {
  const connected = wallet();
  let release!: () => void;
  const original = connected.provider!.request;
  t.mock.method(connected.provider!, 'request', async request => {
    if (request.method === 'eth_sendTransaction' && !release) await new Promise<void>(resolve => { release = resolve; });
    return original(request);
  });
  const view = harness(connected);
  await ready(view);
  let sending!: Promise<boolean>;
  act(() => { sending = view.result.current.mint('crate', 1); });
  await waitFor(() => assert.ok(release));
  assert.ok(view.result.current.busy);
  await act(async () => { assert.equal(await view.result.current.mint('warehouse', 1), false); });
  await act(async () => { release(); assert.equal(await sending, true); });
  assert.equal(view.result.current.busy, null);
  await mint(view, 'warehouse');
  assert.equal(connected.sent.length, 2);
});

test('rejected approval removes its hint while an uncertain send remains locally pending and never auto-resubmits', async t => {
  const connected = wallet();
  let ambiguous = false;
  const original = connected.provider!.request;
  const request = t.mock.method(connected.provider!, 'request', async value => {
    if (value.method === 'eth_sendTransaction') throw ambiguous ? new Error('Connection lost') : Object.assign(new Error('Rejected'), { code: 4001 });
    return original(value);
  });
  const view = harness(connected);
  await ready(view);
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), false); });
  assert.equal(view.result.current.pendingMints.length, 0);
  ambiguous = true;
  await act(async () => { assert.equal(await view.result.current.mint('warehouse', 2), false); });
  assert.equal(view.result.current.pendingMints.length, 1);
  assert.equal(view.result.current.pendingMints[0].quantity, 2);
  assert.equal(view.result.current.busy, null);
  assert.equal(readEthereumDropOperations(scope)[0].hash, undefined);
  await act(async () => { view.result.current.refresh(); });
  assert.equal(request.mock.calls.filter(call => call.arguments[0].method === 'eth_sendTransaction').length, 2);
});

test('local storage failure preserves pending hints in memory and never prevents submission', async t => {
  t.mock.method(window.Storage.prototype, 'setItem', () => { throw new Error('Storage unavailable'); });
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await mint(view);
  assert.equal(connected.sent.length, 1);
  assert.equal(view.result.current.pendingMints.length, 1);
  assert.equal(view.result.current.error, null);
  confirmations.set(hashFor(1), { status: 'confirmed', confirmations: 1, items: [token()], burnedTokenIds: [] });
  await waitFor(() => assert.equal(view.result.current.pendingMints.length, 0));
});

test('restored operations reconcile silently and never expose a gallery-open state', async () => {
  writeEthereumDropOperation(scope, 'restored', savedOperation());
  const view = harness(wallet(), 'crate', true);
  await ready(view);
  assert.equal(view.result.current.pendingMints.length, 1);
  confirmations.set(hashFor(1), { status: 'confirmed', confirmations: 1, items: [token()], burnedTokenIds: [] });
  await waitFor(() => assert.equal(view.result.current.pendingMints.length, 0));
  assert.equal(view.result.current.error, null);
  assert.equal('revealed' in view.result.current, false);
  assert.deepEqual(view.result.current.unpackResults, {});
});

test('legacy mint state migrates once without changing disabled checkout delivery state', async () => {
  const legacy = savedOperation();
  writeEthereumStorage(`${scope}:pending`, legacy);
  const view = harness();
  await ready(view);
  await waitFor(() => assert.equal(view.result.current.pendingMints.length, 1));
  assert.equal(readEthereumPending(scope), null);
  assert.equal(readEthereumDropOperations(scope)[0].id, `legacy-${legacy.hash.slice(2)}`);
  await act(async () => { view.unmount(); });
  writeEthereumStorage(`${scope}:pending`, { ...legacy, action: 'delivery', orderId: 42 });
  const next = harness();
  await ready(next);
  assert.equal(readEthereumPending(scope)?.action, 'delivery');
  await mint(next, 'warehouse');
  assert.equal(readEthereumPending(scope)?.action, 'delivery');
});

test('a migrated legacy reveal preserves its delayed receipt and inventory hints while indexing lags', async t => {
  const source = token();
  const minted = token('1', owner, 'artwork');
  const hash = hashFor(1);
  const submittedAt = Date.now() - 1000;
  writeEthereumStorage(`${scope}:pending`, { scope, action: 'unbox', hash, submittedAt,
    intent: { to: contract, data: encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [source.tokenId]), value: '0x0' } });
  writeEthereumStorage(`${scope}:reveals`, [{ transactionHash: hash, submittedAt }]);
  const receipt = Promise.withResolvers<EthereumTransactionConfirmResponse>();
  t.mock.method(ethereumApi, 'confirm', async () => receipt.promise);
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected) => ({
    items: expected?.includes(minted.tokenId) ? [minted] : [], nextCursor: null, observedBlock: 1,
  }));
  const artwork = { tokenId: minted.tokenId, crateTokenId: source.tokenId, name: 'Painting', description: '', image: 'https://cdn.mons.shop/111k/paintings/1.png', category: 'painting' as const,
    attributes: [], aspectRatio: { width: 1, height: 1 }, observation: { transactionHash: hash, blockHash: hashFor(9), blockNumber: 1 } };
  const revealRequest = t.mock.method(ethereumRevealApi, 'transaction', async () => ({ chainId: config.chainId, contractAddress: contract,
    dropId: config.dropId, deploymentId: 'test', status: 'revealed' as const, artworks: [artwork], retryAfterMs: 0 }));
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await waitFor(() => assert.equal(view.result.current.unpackResults[hash]?.[0].name, 'Painting'));
  assert.deepEqual(view.result.current.unpackErrors, {});
  assert.equal(readEthereumDropOperations(scope).length, 1);
  assert.equal(readEthereumPending(scope), null);
  await act(async () => { receipt.resolve({ status: 'confirmed', confirmations: 1, items: [minted], burnedTokenIds: [source.tokenId] }); });
  await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [minted.tokenId]));
  assert.deepEqual(readEthereumExpected(scope), [minted.tokenId]);
  assert.deepEqual(readEthereumDropOperations(scope), []);
  assert.deepEqual(readEthereumRevealJobs(scope), []);
  view.unmount();
  const restored = harness(connected);
  await ready(restored);
  assert.deepEqual(restored.result.current.items.map(item => item.tokenId), [minted.tokenId]);
  assert.deepEqual(restored.result.current.unpackResults, {});
  assert.equal(revealRequest.mock.callCount(), 1);
  assert.equal(connected.sent.length, 0);
});

test('expired restored hints disappear without declaring cancellation or retrying the transaction', async () => {
  writeEthereumDropOperation(scope, 'restored', savedOperation(hashFor(1), Date.now() - ETHEREUM_DROP_OPERATION_TTL - 1));
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await waitFor(() => assert.equal(view.result.current.pendingMints.length, 0));
  assert.equal(readEthereumDropOperations(scope, Date.now(), true).length, 0);
  assert.equal(view.result.current.error, null);
  assert.equal(connected.sent.length, 0);
});

test('transient receipt errors preserve other pending transactions and explicit revert removes only its hint', async () => {
  const view = harness();
  await ready(view);
  await mint(view);
  await mint(view, 'warehouse');
  confirmations.set(hashFor(1), new Error('RPC unavailable'));
  confirmations.set(hashFor(2), new EthereumApiError(409, 'Reverted', 'transaction-reverted'));
  await waitFor(() => assert.equal(view.result.current.pendingMints.length, 1));
  assert.equal(view.result.current.pendingMints[0].kind, 'crate');
  assert.equal(view.result.current.busy, null);
});

test('a consumed observed nonce retires only a missing-receipt hint and refreshes inventory', async t => {
  const connected = wallet();
  let count = '0x0';
  let receipt: unknown = { status: '0x1' };
  const original = connected.provider!.request;
  t.mock.method(connected.provider!, 'request', async request => request.method === 'eth_getTransactionCount' ? count : request.method === 'eth_getTransactionReceipt' ? receipt : original(request));
  const view = harness(connected);
  await ready(view);
  await mint(view);
  await waitFor(() => assert.equal(readEthereumDropOperations(scope)[0]?.nonce, '0x1'));
  count = '0x2';
  confirmations.set(hashFor(1), { status: 'pending', confirmations: 1, items: [], burnedTokenIds: [] });
  await act(async () => { view.result.current.refresh(); });
  assert.equal(view.result.current.pendingMints.length, 1);
  receipt = null;
  await waitFor(() => assert.equal(view.result.current.pendingMints.length, 0));
  assert.equal(view.result.current.error, null);
  assert.deepEqual(readEthereumExpected(scope), []);
});

test('pending discounts reserve allowance without changing warehouse prices or blocking a public mint', async t => {
  const root = `0x${'d'.repeat(64)}`;
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, discountMerkleRoot: root, discountAllowance: 2 }));
  t.mock.method(ethereumDiscounts, 'proof', async () => []);
  const view = harness();
  await ready(view);
  await waitFor(() => assert.equal(view.result.current.mintQuote('crate', 2)?.discounted, true));
  await mint(view, 'crate', 2);
  assert.equal(view.result.current.mintQuote('crate', 1)?.discounted, false);
  assert.equal(view.result.current.mintQuote('warehouse', 1)?.unitPriceWei, statistics.warehousePriceWei);
  await mint(view, 'crate');
  assert.deepEqual(readEthereumDropOperations(scope).map(item => item.discountedQuantity), [2, 0]);
});

test('pending discounts reserve the global cap and leave public-price minting available', async t => {
  const root = `0x${'d'.repeat(64)}`;
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, discountMerkleRoot: root, discountAllowance: 2,
    maxDiscountedMints: 10, totalDiscountedMints: 9 }));
  t.mock.method(ethereumDiscounts, 'proof', async () => []);
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await waitFor(() => assert.equal(view.result.current.mintQuote('crate', 1)?.discounted, true));
  await mint(view);
  const quote = view.result.current.mintQuote('crate', 1)!;
  assert.equal(quote.discounted, false);
  assert.equal(quote.unitPriceWei, statistics.cratePriceWei);
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1, quote), true); });
  assert.equal(connected.sent.length, 2);
  const request = (connected.sent[1] as Record<string, unknown>[])[0];
  assert.equal(request.data, encodeCall(ETHEREUM_FUNCTIONS.mintCrates, ['uint256'], [1]));
  assert.equal(BigInt(request.value as string), BigInt(statistics.cratePriceWei));
  assert.deepEqual(readEthereumDropOperations(scope).map(item => item.discountedQuantity), [1, 0]);
});

test('a reverted discounted mint releases both the final crate and global discount slot', async t => {
  const root = `0x${'d'.repeat(64)}`;
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, remainingCrates: 1, remainingWarehouses: 0,
    discountMerkleRoot: root, discountAllowance: 2, maxDiscountedMints: 10, totalDiscountedMints: 9 }));
  t.mock.method(ethereumDiscounts, 'proof', async () => []);
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await waitFor(() => assert.equal(view.result.current.mintQuote('crate', 1)?.discounted, true));
  await mint(view);
  assert.equal(view.result.current.mintQuote('crate', 1)?.discounted, false);
  confirmations.set(hashFor(1), new EthereumApiError(409, 'Reverted', 'transaction-reverted'));
  await waitFor(() => assert.equal(view.result.current.pendingMints.length, 0));
  assert.equal(view.result.current.mintQuote('crate', 1)?.discounted, true);
  await mint(view);
  assert.equal(connected.sent.length, 2);
  const request = (connected.sent[1] as Record<string, unknown>[])[0];
  assert.equal(request.data, encodeCall(ETHEREUM_FUNCTIONS.mintCratesDiscounted, ['uint256', 'bytes32[]'], [1, []]));
  assert.equal(BigInt(request.value as string), BigInt(statistics.discountCratePriceWei));
});

for (const scenario of [
  { name: 'an exhausted discount allowance permits a public mint despite earlier receipt metadata failures', allowance: 1, used: 1, quantity: 1, discounted: false, allowed: true },
  { name: 'a quantity above the remaining discount allowance permits a public mint despite earlier receipt metadata failures', allowance: 4, used: 1, quantity: 4, discounted: false, allowed: true },
  { name: 'an unaffected discounted price permits another mint despite earlier receipt metadata failures', allowance: 4, used: 1, quantity: 1, discounted: true, allowed: true },
  { name: 'an uncertain discount price still blocks a mint when its earlier receipt cannot be confirmed', allowance: 1, used: 0, quantity: 1, discounted: false, allowed: false },
]) test(scenario.name, async t => {
  const root = `0x${'d'.repeat(64)}`;
  let used = 0;
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, discountMerkleRoot: root, discountAllowance: scenario.allowance, discountUsed: used }));
  t.mock.method(ethereumDiscounts, 'proof', async () => []);
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await waitFor(() => assert.equal(view.result.current.mintQuote('crate', 1)?.discounted, true));
  await mint(view);
  used = scenario.used;
  confirmations.set(hashFor(1), new EthereumApiError(503, 'Ethereum metadata is temporarily unavailable.', 'unavailable'));
  await act(async () => { await view.result.current.stats.refetch(); });
  await waitFor(() => assert.equal(view.result.current.stats.data?.discountUsed, used));
  const quote = view.result.current.mintQuote('crate', scenario.quantity)!;
  assert.equal(quote.discounted, scenario.discounted);
  await act(async () => { assert.equal(await view.result.current.mint('crate', scenario.quantity, quote), scenario.allowed); });
  assert.equal(connected.sent.length, scenario.allowed ? 2 : 1);
  assert.ok(readEthereumDropOperations(scope).some(operation => operation.hash === hashFor(1)));
  if (scenario.allowed) {
    const request = (connected.sent[1] as Record<string, unknown>[])[0];
    const unitPrice = scenario.discounted ? statistics.discountCratePriceWei : statistics.cratePriceWei;
    const signature = scenario.discounted ? ETHEREUM_FUNCTIONS.mintCratesDiscounted : ETHEREUM_FUNCTIONS.mintCrates;
    assert.equal(BigInt(request.value as string), BigInt(unitPrice) * BigInt(scenario.quantity));
    assert.equal((request.data as string).slice(0, 10), encodeCall(signature, [], []));
    assert.equal(view.result.current.error, null);
  } else assert.match(view.result.current.error!, /metadata is temporarily unavailable/);
});

test('mint rechecks changed price and supply before requesting a transaction', async t => {
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  const originalQuote = view.result.current.mintQuote('crate', 1)!;
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, cratePriceWei: '999' }));
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1, originalQuote), false); });
  assert.match(view.result.current.error!, /terms changed/);
  assert.equal(connected.sent.length, 0);
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, remainingWarehouses: 0 }));
  await act(async () => { assert.equal(await view.result.current.mint('warehouse', 1), false); });
  assert.match(view.result.current.error!, /no longer available/);
});

test('a pending mint reserves the final crate before another wallet request', async t => {
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, remainingCrates: 1, remainingWarehouses: 0 }));
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await mint(view);
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), false); });
  assert.match(view.result.current.error!, /no longer available/);
  assert.equal(connected.sent.length, 1);
  assert.equal(view.result.current.pendingMints.length, 1);
});

for (const remainingCrates of [11, 12]) test(`a pending warehouse reserves eleven crates from the shared ${remainingCrates}-crate supply`, async t => {
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, remainingCrates, remainingWarehouses: 1 }));
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await mint(view, 'warehouse');
  if (remainingCrates === 12) await mint(view);
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), false); });
  assert.match(view.result.current.error!, /no longer available/);
  assert.equal(connected.sent.length, remainingCrates === 12 ? 2 : 1);
  assert.deepEqual(view.result.current.pendingMints.map(item => item.kind), remainingCrates === 12 ? ['warehouse', 'crate'] : ['warehouse']);
});

test('a pending crate prevents a warehouse mint when fewer than eleven unreserved crates remain', async t => {
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, remainingCrates: 11, remainingWarehouses: 1 }));
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await mint(view);
  await act(async () => { assert.equal(await view.result.current.mint('warehouse', 1), false); });
  assert.match(view.result.current.error!, /no longer available/);
  assert.equal(connected.sent.length, 1);
});

test('a just-confirmed mint is reconciled before its supply reservation rejects a valid mint', async t => {
  manualRecoveryTicks(t);
  let remainingCrates = 2;
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, remainingCrates, remainingWarehouses: 0 }));
  const background = Promise.withResolvers<EthereumTransactionConfirmResponse>();
  let firstMintChecks = 0;
  t.mock.method(ethereumApi, 'confirm', async hash => {
    if (hash !== hashFor(1)) return { status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] };
    if (++firstMintChecks === 1) return background.promise;
    return { status: 'confirmed', confirmations: 1, items: [token()], burnedTokenIds: [] };
  });
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await mint(view);
  await waitFor(() => assert.equal(firstMintChecks, 1));
  remainingCrates = 1;
  await mint(view);
  assert.equal(connected.sent.length, 2);
  assert.deepEqual(readEthereumDropOperations(scope).map(item => item.hash), [hashFor(2)]);
  await act(async () => { background.resolve({ status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] }); });
  assert.deepEqual(readEthereumDropOperations(scope).map(item => item.hash), [hashFor(2)]);
});

test('pending relic claims reserve selected IDs and allowance while leaving the next eligible claim available', async () => {
  const view = harness(wallet(), 'relic');
  await ready(view);
  await waitFor(() => assert.equal(view.result.current.relics.isSuccess, true));
  await act(async () => { assert.equal(await view.result.current.claimRelic(1), true); });
  assert.equal(view.result.current.relics.data?.remainingAllowance, 1);
  assert.equal(view.result.current.relics.data?.claimedMask, 1);
  await act(async () => { assert.equal(await view.result.current.claimRelic(1), false); });
  await act(async () => { assert.equal(await view.result.current.claimRelic(2), true); });
  assert.equal(view.result.current.relics.data?.remainingAllowance, 0);
  await act(async () => { assert.equal(await view.result.current.claimRelic(3), false); });
  assert.deepEqual([...view.result.current.pendingRelicIds], [1, 2]);
});

test('a warehouse unpack returns all 111 results under its hash without restoring a presentation', async () => {
  const source = token('117172', owner, 'relic');
  const result = Array.from({ length: 111 }, (_, index) => token(String(111112 + index)));
  const view = harness();
  await ready(view);
  let hash: string | null = null;
  await act(async () => { hash = await view.result.current.unbox(source); });
  confirmations.set(hash!, { status: 'confirmed', confirmations: 1, items: result, burnedTokenIds: [source.tokenId] });
  await waitFor(() => assert.equal(view.result.current.unpackResults[hash!]?.length, 111));
  assert.equal(view.result.current.pendingItemIds.size, 0);
  assert.equal(readEthereumExpected(scope).length, 111);
  assert.equal('revealed' in view.result.current, false);
});

test('published crate artworks arrive by transaction hash before the receipt and survive later receipt placeholders', async () => {
  const view = harness();
  await ready(view);
  let hash: string | null = null;
  await act(async () => { hash = await view.result.current.unbox(token()); });
  await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'reveal-transaction', config.chainId, contract, hash])?.status, 'success'));
  const artwork = { tokenId: '1', crateTokenId: '111112', name: 'Revealed painting', description: '', image: 'https://cdn.mons.shop/111k/paintings/1.png', category: 'painting' as const, attributes: [], aspectRatio: { width: 1, height: 1 }, observation: { transactionHash: hash!, blockHash: hashFor(9), blockNumber: 1 } };
  reveals.set(hash!, { chainId: config.chainId, contractAddress: contract, dropId: config.dropId, deploymentId: 'test', status: 'revealed', artworks: [artwork], retryAfterMs: 0 });
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'reveal-transaction'] }); });
  await waitFor(() => assert.equal(view.result.current.unpackResults[hash!]?.[0].name, 'Revealed painting'), { timeout: 3_500 });
  confirmations.set(hash!, { status: 'confirmed', confirmations: 1, items: [token('1', owner, 'artwork')], burnedTokenIds: ['111112'] });
  await waitFor(() => assert.equal(view.result.current.operations.length, 0));
  assert.equal(view.result.current.unpackResults[hash!][0].name, 'Revealed painting');
});

test('restored reveal jobs return data silently and results never leak to another account', async () => {
  const hash = hashFor(5);
  const pending = { ...savedOperation(hash), action: 'unbox' as const, sourceTokenIds: ['111112'], intent: { to: contract, data: encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], ['111112']), value: '0x0' } };
  rememberEthereumRevealJob(scope, hash, Date.now(), pending);
  reveals.set(hash, { chainId: config.chainId, contractAddress: contract, dropId: config.dropId, deploymentId: 'test', status: 'revealed', retryAfterMs: 0,
    artworks: [{ tokenId: '1', crateTokenId: '111112', name: 'Painting', description: '', image: 'https://cdn.mons.shop/111k/paintings/1.png', category: 'painting', attributes: [], aspectRatio: { width: 1, height: 1 }, observation: { transactionHash: hash, blockHash: hashFor(9), blockNumber: 1 } }] });
  const view = harness();
  await ready(view);
  await waitFor(() => assert.equal(view.result.current.unpackResults[hash]?.length, 1));
  assert.equal('revealed' in view.result.current, false);
  view.rerender({ wallet: wallet(other), mintKind: 'crate' });
  await waitFor(() => assert.equal(view.result.current.owner, other));
  assert.deepEqual(view.result.current.unpackResults, {});
});

for (const status of ['reverted', 'not_unpack'] as const) {
  test(`a terminal ${status} reveal releases the source and gives only its active session a retry outcome`, async () => {
    const view = harness();
    await ready(view);
    let hash: string | null = null;
    await act(async () => { hash = await view.result.current.unbox(token()); });
    reveals.set(hash!, { chainId: config.chainId, contractAddress: contract, dropId: config.dropId, deploymentId: 'test', status, artworks: [], retryAfterMs: 0 });
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'reveal-transaction'] }); });
    await waitFor(() => assert.ok(view.result.current.unpackErrors[hash!]), { timeout: 3_500 });
    assert.equal(view.result.current.pendingItemIds.size, 0);
    assert.equal(view.result.current.error, null);
  });
}

test('lease expiry releases an open unpack session without a permanent spinner or a false cancellation notice', async () => {
  const view = harness();
  await ready(view);
  let hash: string | null = null;
  await act(async () => { hash = await view.result.current.unbox(token('116667', owner, 'warehouse')); });
  const [operation] = readEthereumDropOperations(scope);
  act(() => { writeEthereumDropOperation(scope, operation.id, { ...operation, submittedAt: Date.now() - ETHEREUM_DROP_OPERATION_TTL }); });
  await waitFor(() => assert.ok(view.result.current.unpackErrors[hash!]));
  assert.equal(view.result.current.pendingItemIds.size, 0);
  assert.equal(view.result.current.error, null);
});

test('bounded receipt polling checks every operation with at most four concurrent requests', async t => {
  for (let index = 0; index < 9; index++) writeEthereumDropOperation(scope, `pending-${index}`, { ...savedOperation(hashFor(index + 1)), id: `pending-${index}` });
  const gates = Array.from({ length: 9 }, () => Promise.withResolvers<void>());
  const seen: string[] = [];
  let concurrent = 0, maximum = 0;
  t.mock.method(ethereumApi, 'confirm', async hash => {
    seen.push(hash);
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    try {
      const index = Array.from({ length: 9 }, (_, index) => hashFor(index + 1)).indexOf(hash);
      await gates[index].promise;
      return { status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] };
    } finally { concurrent--; }
  });
  const view = harness();
  await ready(view);
  await waitFor(() => assert.equal(seen.length, 4));
  await act(async () => { gates.slice(0, 4).forEach(gate => gate.resolve()); });
  await waitFor(() => assert.equal(seen.length, 8));
  await act(async () => { gates.slice(4).forEach(gate => gate.resolve()); });
  await waitFor(() => assert.equal(new Set(seen).size, 9));
  assert.equal(maximum, 4);
});

test('account changes release a hung wallet request and preserve a late broadcast only for its original scope', async t => {
  const connected = wallet();
  const gate = Promise.withResolvers<void>();
  let waiting = false;
  const original = connected.provider!.request;
  t.mock.method(connected.provider!, 'request', async request => {
    if (request.method === 'eth_sendTransaction' && !waiting) { waiting = true; await gate.promise; }
    return original(request);
  });
  const view = harness(connected);
  await ready(view);
  let sending!: Promise<boolean>;
  act(() => { sending = view.result.current.mint('crate', 1); });
  await waitFor(() => assert.equal(waiting, true));
  view.rerender({ wallet: wallet(other), mintKind: 'crate' });
  await act(async () => { assert.equal(await sending, false); });
  assert.equal(view.result.current.busy, null);
  await act(async () => { gate.resolve(); });
  await waitFor(() => assert.equal(readEthereumDropOperations(scope)[0]?.hash, hashFor(1)));
  assert.equal(view.result.current.pendingMints.length, 0);
  view.rerender({ wallet: connected, mintKind: 'crate' });
  await ready(view);
  await mint(view, 'warehouse');
  assert.equal(connected.sent.length, 2);
});

test('a hung confirmation cannot starve later operations or prevent lease cleanup', async t => {
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => timeout(milliseconds === 10_000 ? 40 : milliseconds));
  for (let index = 0; index < 5; index++) writeEthereumDropOperation(scope, `pending-${index}`, { ...savedOperation(hashFor(index + 1)), id: `pending-${index}` });
  const seen = new Set<string>();
  t.mock.method(ethereumApi, 'confirm', async hash => {
    seen.add(hash);
    if (hash === hashFor(1)) return new Promise<EthereumTransactionConfirmResponse>(() => {});
    return { status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] };
  });
  const view = harness();
  await ready(view);
  await waitFor(() => assert.equal(seen.size, 5));
  const operation = readEthereumDropOperations(scope).find(item => item.hash === hashFor(1))!;
  act(() => writeEthereumDropOperation(scope, operation.id, { ...operation, submittedAt: Date.now() - ETHEREUM_DROP_OPERATION_TTL }));
  await waitFor(() => assert.equal(view.result.current.pendingMints.length, 4));
});

test('an account network change during a nonce read cannot retire a hint using another chain’s result', async t => {
  const connected = wallet();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  connected.provider!.on = (event, listener) => { const entries = listeners.get(event) ?? new Set(); entries.add(listener); listeners.set(event, entries); };
  connected.provider!.removeListener = (event, listener) => { listeners.get(event)?.delete(listener); };
  const gate = Promise.withResolvers<string>();
  let requested = false;
  let switched = false;
  const original = connected.provider!.request;
  t.mock.method(connected.provider!, 'request', async request => {
    if (request.method === 'eth_getTransactionCount') {
      if (!switched) { requested = true; return gate.promise; }
      return '0x0';
    }
    return original(request);
  });
  writeEthereumDropOperation(scope, 'restored', { ...savedOperation(), nonce: '0x1', transactionSender: owner });
  const view = harness(connected);
  await ready(view);
  await waitFor(() => assert.equal(requested, true));
  act(() => {
    switched = true;
    for (const listener of listeners.get('chainChanged') ?? []) listener('0x1');
    for (const listener of listeners.get('chainChanged') ?? []) listener('0xaa36a7');
    gate.resolve('0x99');
  });
  await act(async () => {});
  assert.equal(view.result.current.pendingMints.length, 1);
  assert.equal(readEthereumDropOperations(scope)[0].hash, hashFor(1));
});

test('another tab retiring an unpack hint does not strand its initiating session', async () => {
  const view = harness();
  await ready(view);
  let hash: string | null = null;
  await act(async () => { hash = await view.result.current.unbox(token('116667', owner, 'warehouse')); });
  const [operation] = readEthereumDropOperations(scope);
  act(() => writeEthereumDropOperation(scope, operation.id, null));
  confirmations.set(hash!, { status: 'confirmed', confirmations: 1, items: [token()], burnedTokenIds: ['116667'] });
  await waitFor(() => assert.equal(view.result.current.unpackResults[hash!]?.length, 1));
});

test('a delayed older mint confirmation cannot resurrect a container burned by a newer unpack when refetch fails', async t => {
  const minted = token();
  const artwork = token('1', owner, 'artwork');
  const first = savedOperation(hashFor(1));
  const unpack = { ...savedOperation(hashFor(2)), id: 'unpack', action: 'unbox' as const, sourceTokenIds: [minted.tokenId],
    intent: { to: contract, data: encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [minted.tokenId]), value: '0x0' } };
  writeEthereumDropOperation(scope, first.id, first);
  writeEthereumDropOperation(scope, unpack.id, unpack);
  const gate = Promise.withResolvers<EthereumTransactionConfirmResponse>();
  let loaded = false;
  t.mock.method(ethereumApi, 'inventory', async () => {
    if (loaded) throw new Error('Indexer unavailable');
    loaded = true;
    return { items: [minted], nextCursor: null, observedBlock: 1 };
  });
  t.mock.method(ethereumApi, 'confirm', async hash => hash === first.hash ? gate.promise : { status: 'confirmed', confirmations: 1, items: [artwork], burnedTokenIds: [minted.tokenId] });
  const view = harness();
  await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), ['1']));
  await act(async () => { gate.resolve({ status: 'confirmed', confirmations: 1, items: [minted], burnedTokenIds: [] }); });
  await waitFor(() => assert.equal(view.result.current.operations.length, 0));
  assert.deepEqual(view.result.current.items.map(item => item.tokenId), ['1']);
  assert.deepEqual(readEthereumExpected(scope), ['1']);
});

test('a just-mined discounted mint is reconciled before another public-price request can charge more than the new quote', async t => {
  const root = `0x${'d'.repeat(64)}`;
  let used = 0;
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, discountMerkleRoot: root, discountAllowance: 4, discountUsed: used }));
  t.mock.method(ethereumDiscounts, 'proof', async () => []);
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await waitFor(() => assert.equal(view.result.current.mintQuote('crate', 2)?.discounted, true));
  await mint(view, 'crate', 2);
  used = 2;
  await act(async () => { await view.result.current.stats.refetch(); });
  await waitFor(() => assert.equal(view.result.current.stats.data?.discountUsed, 2));
  const stalePublicQuote = view.result.current.mintQuote('crate', 1)!;
  assert.equal(stalePublicQuote.discounted, false);
  confirmations.set(hashFor(1), { status: 'confirmed', confirmations: 1, items: [token(), token('111113')], burnedTokenIds: [] });
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1, stalePublicQuote), false); });
  assert.match(view.result.current.error!, /terms changed/);
  assert.equal(connected.sent.length, 1);
  assert.equal(view.result.current.mintQuote('crate', 1)?.discounted, true);
});

test('two completed fifteen-crate unpacks retain all 600 artworks while ownership indexing lags', async t => {
  const artworks = Array.from({ length: 600 }, (_, index) => token(String(index + 1), owner, 'artwork'));
  const indexed = new Map(artworks.map(item => [item.tokenId, item]));
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expectedIds) => ({
    items: (expectedIds ?? []).flatMap(id => indexed.has(id) ? [indexed.get(id)!] : []), nextCursor: null, observedBlock: 10,
  }));
  for (let index = 0; index < 2; index++) {
    const sourceTokenIds = Array.from({ length: 15 }, (_, offset) => String(111112 + index * 15 + offset));
    const operation = { ...savedOperation(hashFor(index + 1)), id: `unpack-${index}`, action: 'unbox' as const, quantity: 15, sourceTokenIds,
      intent: { to: contract, data: encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [sourceTokenIds]), value: '0x0' } };
    writeEthereumDropOperation(scope, operation.id, operation);
    confirmations.set(operation.hash, { status: 'confirmed', confirmations: 1, items: artworks.slice(index * 300, index * 300 + 300), burnedTokenIds: sourceTokenIds });
  }
  const view = harness();
  await waitFor(() => assert.equal(view.result.current.operations.length, 0));
  await waitFor(() => assert.equal(view.result.current.items.length, 600));
  await act(async () => { await view.result.current.inventory.refetch(); });
  await waitFor(() => assert.equal(view.result.current.inventory.isFetching, false));
  assert.equal(view.result.current.items.length, 600);
  assert.equal(readEthereumExpected(scope).length, 500);
});

test('a canceled pre-send read cannot resume after the original deployment scope returns', async t => {
  const connected = wallet();
  const gate = Promise.withResolvers<void>();
  let waiting = false;
  let completedRead = false;
  const original = connected.provider!.request;
  t.mock.method(connected.provider!, 'request', async request => {
    if (request.method === 'eth_accounts') {
      waiting = true;
      await gate.promise;
      completedRead = true;
    }
    return original(request);
  });
  const view = harness(connected);
  await ready(view);
  let sending!: Promise<boolean>;
  act(() => { sending = view.result.current.mint('crate', 1); });
  await waitFor(() => assert.equal(waiting, true));
  const changed = resolveEthereum111kConfig({ contractAddress: '0x4444444444444444444444444444444444444444' });
  act(() => view.client.setQueryData(['ethereum111k', 'config'], changed));
  await waitFor(() => assert.equal(view.result.current.config.contractAddress, changed.contractAddress));
  await act(async () => { assert.equal(await sending, false); });
  act(() => view.client.setQueryData(['ethereum111k', 'config'], config));
  await waitFor(() => assert.equal(view.result.current.config.contractAddress, contract));
  await act(async () => { gate.resolve(); });
  await waitFor(() => assert.equal(completedRead, true));
  assert.equal(connected.sent.length, 0);
  assert.equal(readEthereumDropOperations(scope).length, 0);
  await mint(view);
  assert.equal(connected.sent.length, 1);
});

for (const [label, update, expectedError] of [
  ['claimed ID', { claimedMask: 1 }, /already|just claimed/],
  ['paused sale', { saleActive: false }, /availability changed/],
  ['exhausted allowance', { remainingAllowance: 0 }, /no relic claims remaining/],
] as const) {
  test(`relic submission rechecks a newer ${label} snapshot before opening the wallet transaction`, async t => {
    const connected = wallet();
    const gate = Promise.withResolvers<void>();
    let waiting = false;
    let latest = { ...relicStatus };
    t.mock.method(ethereumApi, 'relics', async () => latest);
    const original = connected.provider!.request;
    t.mock.method(connected.provider!, 'request', async request => {
      if (request.method === 'eth_accounts') { waiting = true; await gate.promise; }
      return original(request);
    });
    const view = harness(connected, 'relic');
    await ready(view);
    let claiming!: Promise<boolean>;
    act(() => { claiming = view.result.current.claimRelic(1); });
    await waitFor(() => assert.equal(waiting, true));
    latest = { ...latest, ...update, observedBlock: 2 };
    act(() => view.client.setQueryData(['ethereum111k', 'relics', config.chainId, contract, owner], latest));
    await act(async () => { gate.resolve(); assert.equal(await claiming, false); });
    assert.equal(connected.sent.length, 0);
    assert.equal(view.result.current.pendingMints.length, 0);
    assert.match(view.result.current.error!, expectedError);
  });
}

test('another observer confirming a mint refreshes this observer before its older pending response settles', async t => {
  const gate = Promise.withResolvers<EthereumTransactionConfirmResponse>();
  const minted = token();
  const reads: string[][] = [];
  let confirmationCalls = 0;
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected) => {
    reads.push([...(expected ?? [])]);
    return { items: expected?.includes(minted.tokenId) ? [minted] : [], nextCursor: null, observedBlock: 1 };
  });
  t.mock.method(ethereumApi, 'confirm', async () => ++confirmationCalls === 1 ? gate.promise : {
    status: 'confirmed', confirmations: 1, items: [minted], burnedTokenIds: [],
  });
  const first = harness();
  await ready(first);
  await mint(first);
  await waitFor(() => assert.equal(confirmationCalls, 1));
  const second = harness();
  await waitFor(() => assert.equal(second.result.current.items.length, 1));
  await waitFor(() => assert.equal(first.result.current.pendingMints.length, 0));
  await waitFor(() => assert.equal(first.result.current.items.length, 1));
  await act(async () => { gate.resolve({ status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] }); });
  await waitFor(() => assert.equal(first.result.current.inventory.isFetching || second.result.current.inventory.isFetching, false));
  assert.equal(reads.filter(ids => ids.includes(minted.tokenId)).length, 2);
  const readCount = reads.length;
  await act(async () => { window.dispatchEvent(new window.StorageEvent('storage', { key: `ethereum111k:drop-operation:v1:${scope}:duplicate` })); });
  assert.equal(reads.length, readCount);
});

test('local confirmation performs one inventory refresh and foreign-scope ledger changes do not refresh it', async t => {
  let reads = 0;
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected) => {
    reads++;
    return { items: expected?.includes('111112') ? [token()] : [], nextCursor: null, observedBlock: 1 };
  });
  const view = harness();
  await ready(view);
  assert.equal(reads, 1);
  await mint(view);
  confirmations.set(hashFor(1), { status: 'confirmed', confirmations: 1, items: [token()], burnedTokenIds: [] });
  await waitFor(() => assert.equal(view.result.current.items.length, 1));
  await waitFor(() => assert.equal(view.result.current.inventory.isFetching, false));
  assert.equal(reads, 2);
  const otherScope = ethereumInventoryScope(config, other)!;
  await act(async () => {
    writeEthereumDropOperation(otherScope, 'foreign', { ...savedOperation(), id: 'foreign', scope: otherScope });
    writeEthereumDropOperation(otherScope, 'foreign', null);
  });
  assert.equal(reads, 2);
});

test('a hashless discounted mint cannot charge public price while chain allowance remains', async t => {
  const root = `0x${'d'.repeat(64)}`;
  let used = 0;
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, discountMerkleRoot: root, discountAllowance: 4, discountUsed: used }));
  t.mock.method(ethereumDiscounts, 'proof', async () => []);
  const connected = wallet();
  let first = true;
  const original = connected.provider!.request;
  t.mock.method(connected.provider!, 'request', async request => {
    if (request.method === 'eth_sendTransaction' && first) {
      first = false;
      await original(request);
      used = 2;
      throw new Error('Connection lost after broadcast');
    }
    return original(request);
  });
  const view = harness(connected);
  await ready(view);
  await waitFor(() => assert.equal(view.result.current.mintQuote('crate', 2)?.discounted, true));
  await act(async () => { assert.equal(await view.result.current.mint('crate', 2), false); });
  await act(async () => { await view.result.current.stats.refetch(); });
  await waitFor(() => assert.equal(view.result.current.stats.data?.discountUsed, 2));
  assert.equal(readEthereumDropOperations(scope)[0]?.hash, undefined);
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), false); });
  assert.match(view.result.current.error!, /earlier mint is still being checked/);
  assert.equal(connected.sent.length, 1);
  await act(async () => { assert.equal(await view.result.current.unbox(token('116667', owner, 'warehouse')), hashFor(2)); });
  await mint(view, 'warehouse');
  await mint(view, 'crate', 3);
  const request = (connected.sent[3] as Record<string, unknown>[])[0];
  assert.equal(BigInt(request.value as string), BigInt(statistics.cratePriceWei) * 3n);
});

test('foreign confirmation replaces an in-flight initial inventory read with confirmed hints', async t => {
  const operation = savedOperation();
  const minted = token();
  writeEthereumDropOperation(scope, operation.id, operation);
  const initial = Promise.withResolvers<{ items: EthereumInventoryItem[]; nextCursor: null; observedBlock: number }>();
  const reads: { signal: AbortSignal | undefined; expected: string[] }[] = [];
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, signal, expected) => {
    reads.push({ signal, expected: [...expected ?? []] });
    if (reads.length === 1) return initial.promise;
    return { items: expected?.includes(minted.tokenId) ? [minted] : [], nextCursor: null, observedBlock: 2 };
  });
  const view = harness();
  await waitFor(() => assert.equal(reads.length, 1));
  act(() => {
    rememberEthereumConfirmedInventory(scope, operation.id, [minted.tokenId], [], operation.submittedAt);
    writeEthereumDropOperation(scope, operation.id, null);
  });
  await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [minted.tokenId]));
  assert.equal(reads[0].signal?.aborted, true);
  assert.deepEqual(reads[1].expected, [minted.tokenId]);
  await act(async () => { initial.resolve({ items: [], nextCursor: null, observedBlock: 1 }); });
  assert.deepEqual(view.result.current.items.map(item => item.tokenId), [minted.tokenId]);
  assert.equal(reads.length, 2);
});

test('a stale discounted preflight cannot cancel the foreign confirmation inventory refresh', async t => {
  const operation = { ...savedOperation(hashFor(99)), discountedQuantity: 1 };
  writeEthereumDropOperation(scope, operation.id, operation);
  const root = `0x${'d'.repeat(64)}`;
  let used = 0;
  t.mock.method(ethereumApi, 'stats', async () => ({ ...statistics, discountMerkleRoot: root, discountAllowance: 1, discountUsed: used }));
  t.mock.method(ethereumDiscounts, 'proof', async () => []);
  const background = Promise.withResolvers<EthereumTransactionConfirmResponse>();
  const preflight = Promise.withResolvers<EthereumTransactionConfirmResponse>();
  let oldChecks = 0;
  t.mock.method(ethereumApi, 'confirm', async hash => hash === operation.hash ? (++oldChecks === 1 ? background.promise : preflight.promise) :
    { status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] });
  const inventory = Promise.withResolvers<{ items: EthereumInventoryItem[]; nextCursor: null; observedBlock: number }>();
  const signals: AbortSignal[] = [];
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, signal) => {
    signals.push(signal!);
    return signals.length === 1 ? { items: [], nextCursor: null, observedBlock: 1 } : inventory.promise;
  });
  const view = harness();
  await ready(view);
  await waitFor(() => assert.equal(view.result.current.discountProof.isSuccess, true));
  assert.equal(view.result.current.mintQuote('crate', 1)?.discounted, false);
  let sending!: Promise<boolean>;
  act(() => { sending = view.result.current.mint('crate', 1); });
  await waitFor(() => assert.equal(oldChecks, 2));
  act(() => {
    used = 1;
    rememberEthereumConfirmedInventory(scope, operation.id, ['111112'], [], operation.submittedAt);
    writeEthereumDropOperation(scope, operation.id, null);
  });
  await waitFor(() => assert.equal(signals.length, 2));
  await act(async () => {
    preflight.resolve({ status: 'confirmed', confirmations: 1, items: [token()], burnedTokenIds: [] });
    assert.equal(await sending, true);
  });
  assert.equal(signals[1].aborted, false);
  await act(async () => { inventory.resolve({ items: [token()], nextCursor: null, observedBlock: 2 }); });
  await waitFor(() => assert.equal(view.result.current.items.length, 1));
  assert.equal(signals.length, 2);
});

test('a submitted mint still populates inventory when storage is cleared before confirmation', async t => {
  const minted = token();
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected) => ({
    items: expected?.includes(minted.tokenId) ? [minted] : [], nextCursor: null, observedBlock: 1,
  }));
  const gate = Promise.withResolvers<EthereumTransactionConfirmResponse>();
  let requested = false;
  t.mock.method(ethereumApi, 'confirm', async () => { requested = true; return gate.promise; });
  const view = harness();
  await ready(view);
  await mint(view);
  await waitFor(() => assert.equal(requested, true));
  act(() => { window.localStorage.clear(); window.dispatchEvent(new window.StorageEvent('storage', { key: null })); });
  await act(async () => { gate.resolve({ status: 'confirmed', confirmations: 1, items: [minted], burnedTokenIds: [] }); });
  await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [minted.tokenId]));
  assert.deepEqual(readEthereumExpected(scope), [minted.tokenId]);
  assert.equal(view.result.current.operations.length, 0);
});

test('a restored mint still populates inventory when storage is cleared during confirmation', async t => {
  const minted = token();
  writeEthereumDropOperation(scope, 'restored', savedOperation());
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected) => ({
    items: expected?.includes(minted.tokenId) ? [minted] : [], nextCursor: null, observedBlock: 1,
  }));
  const gate = Promise.withResolvers<EthereumTransactionConfirmResponse>();
  let requested = false;
  t.mock.method(ethereumApi, 'confirm', async () => { requested = true; return gate.promise; });
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await waitFor(() => assert.equal(requested, true));
  act(() => { window.localStorage.clear(); window.dispatchEvent(new window.StorageEvent('storage', { key: null })); });
  await act(async () => { gate.resolve({ status: 'confirmed', confirmations: 1, items: [minted], burnedTokenIds: [] }); });
  await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [minted.tokenId]));
  assert.deepEqual(readEthereumExpected(scope), [minted.tokenId]);
  assert.deepEqual(view.result.current.unpackResults, {});
  assert.equal(connected.sent.length, 0);
});

test('restored mints queued behind the receipt batch survive storage loss', async t => {
  const minted = Array.from({ length: 5 }, (_, index) => token(String(111112 + index)));
  for (let index = 0; index < minted.length; index++) {
    writeEthereumDropOperation(scope, `queued-${index}`, { ...savedOperation(hashFor(index + 1)), id: `queued-${index}` });
  }
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected) => ({
    items: minted.filter(item => expected?.includes(item.tokenId)), nextCursor: null, observedBlock: 1,
  }));
  const gate = Promise.withResolvers<void>();
  const seen = new Set<string>();
  t.mock.method(ethereumApi, 'confirm', async hash => {
    seen.add(hash);
    await gate.promise;
    const index = minted.findIndex((_item, index) => hashFor(index + 1) === hash);
    return { status: 'confirmed', confirmations: 1, items: [minted[index]], burnedTokenIds: [] };
  });
  const view = harness();
  await ready(view);
  await waitFor(() => assert.equal(seen.size, 4));
  act(() => { window.localStorage.clear(); window.dispatchEvent(new window.StorageEvent('storage', { key: null })); });
  await act(async () => { gate.resolve(); });
  await waitFor(() => assert.equal(view.result.current.items.length, minted.length));
  assert.equal(seen.size, minted.length);
  assert.deepEqual(new Set(readEthereumExpected(scope)), new Set(minted.map(item => item.tokenId)));
});

test('an early crate reveal keeps its source guarded and reconciles after storage loss', async t => {
  const source = token();
  const minted = token('1', owner, 'artwork');
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected) => ({
    items: expected?.includes(minted.tokenId) ? [minted] : [], nextCursor: null, observedBlock: 1,
  }));
  const gate = Promise.withResolvers<EthereumTransactionConfirmResponse>();
  t.mock.method(ethereumApi, 'confirm', async () => gate.promise);
  const hash = hashFor(1);
  const artwork = { tokenId: '1', crateTokenId: source.tokenId, name: 'Painting', description: '', image: 'https://cdn.mons.shop/111k/paintings/1.png', category: 'painting' as const,
    attributes: [], aspectRatio: { width: 1, height: 1 }, observation: { transactionHash: hash, blockHash: hashFor(9), blockNumber: 1 } };
  const revealRequest = t.mock.method(ethereumRevealApi, 'transaction', async () => ({ chainId: config.chainId, contractAddress: contract,
    dropId: config.dropId, deploymentId: 'test', status: 'revealed' as const, artworks: [artwork], retryAfterMs: 0 }));
  const connected = wallet();
  const view = harness(connected);
  await ready(view);
  await act(async () => { assert.equal(await view.result.current.unbox(source), hash); });
  await waitFor(() => assert.equal(view.result.current.unpackResults[hash]?.length, 1));
  act(() => { window.localStorage.clear(); window.dispatchEvent(new window.StorageEvent('storage', { key: null })); });
  await act(async () => { assert.equal(await view.result.current.unbox(source), null); });
  assert.match(view.result.current.error!, /already opening/);
  assert.equal(connected.sent.length, 1);
  await act(async () => { gate.resolve({ status: 'confirmed', confirmations: 1, items: [minted], burnedTokenIds: [source.tokenId] }); });
  await waitFor(() => assert.deepEqual(view.result.current.items.map(item => item.tokenId), [minted.tokenId]));
  assert.deepEqual(readEthereumExpected(scope), [minted.tokenId]);
  assert.equal(view.result.current.unpackResults[hash][0].name, 'Painting');
  assert.equal(revealRequest.mock.calls.length, 1);
});

test('a slower initiating observer receives its crate reveal after another observer completes the shared job', async t => {
  const { first, second, gate, response, hash, tick, request } = await foreignCompletedCrateReveal(t);
  await act(async () => { gate.resolve(response); });
  await waitFor(() => assert.equal(first.result.current.unpackResults[hash]?.[0].name, 'Painting'));
  assert.equal(second.result.current.unpackResults[hash]?.[0].name, 'Painting');
  await tick();
  await tick();
  assert.equal(request.mock.callCount(), 2);
  assert.deepEqual(readEthereumRevealJobs(scope), []);
  assert.deepEqual(first.result.current.unpackErrors, {});
});

test('a retained reveal cannot publish into another wallet after foreign completion', async t => {
  const { first, gate, response, hash, tick, request, signals } = await foreignCompletedCrateReveal(t);
  first.rerender({ wallet: wallet(other), mintKind: 'crate' });
  await waitFor(() => assert.equal(first.result.current.owner, other));
  await act(async () => { gate.resolve(response); });
  await tick();
  assert.equal(signals[0].aborted, true);
  assert.equal(first.result.current.unpackResults[hash], undefined);
  assert.deepEqual(first.result.current.unpackErrors, {});
  assert.equal(request.mock.callCount(), 2);
});

test('unmounting the initiating observer cancels its retained reveal after foreign completion', async t => {
  const { first, gate, response, tick, request, signals } = await foreignCompletedCrateReveal(t);
  first.unmount();
  await act(async () => { gate.resolve(response); });
  await tick();
  assert.equal(signals[0].aborted, true);
  assert.equal(first.client.getQueryData(['ethereum111k', 'revealed-artworks', config.chainId, contract]), undefined);
  assert.equal(request.mock.callCount(), 2);
  assert.deepEqual(readEthereumRevealJobs(scope), []);
});

test('an expired active opening discards a retained response after foreign completion', async t => {
  const { first, gate, response, hash, tick, request } = await foreignCompletedCrateReveal(t);
  const expired = Date.now() + ETHEREUM_DROP_OPERATION_TTL + 1;
  t.mock.method(Date, 'now', () => expired);
  await tick();
  await waitFor(() => assert.ok(first.result.current.unpackErrors[hash]));
  await act(async () => { gate.resolve(response); });
  await tick();
  assert.equal(first.result.current.unpackResults[hash], undefined);
  assert.equal(request.mock.callCount(), 2);
  assert.deepEqual(readEthereumRevealJobs(scope), []);
});

test('a terminal receipt failure discards a retained response after foreign completion', async t => {
  const { first, gate, response, hash, tick, request } = await foreignCompletedCrateReveal(t, false);
  confirmations.set(hash, new EthereumApiError(409, 'Reverted', 'transaction-reverted'));
  await tick();
  await waitFor(() => assert.match(first.result.current.unpackErrors[hash] ?? '', /reverted/));
  await act(async () => { gate.resolve(response); });
  await tick();
  assert.equal(first.result.current.unpackResults[hash], undefined);
  assert.equal(request.mock.callCount(), 2);
  assert.deepEqual(readEthereumRevealJobs(scope), []);
});
