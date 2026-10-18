import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement, type PropsWithChildren } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { encodeCall } from '../shared/ethereum/abi.ts';
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
  window.sessionStorage.setItem(`mons.ethereum111k:${scope}:session`, JSON.stringify({
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

test('crate receipt claims keep polling until three confirmations without another wallet transaction', async t => {
  speedUpConfirmationPolls(t);
  let confirmations = 1;
  let published = 0;
  t.mock.method(ethereumApi, 'confirm', async () => ({ status: 'confirmed', confirmations, items: [], burnedTokenIds: ['2000001'] }));
  t.mock.method(ethereumApi, 'confirmClaim', async () => { published++; return { status: 'confirmed', confirmations: 3 }; });
  const scope = ethereumInventoryScope(config, owner)!;
  window.sessionStorage.setItem(`mons.ethereum111k:${scope}:session`, JSON.stringify({
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
  const lockName = `mons:ethereum111k-submission:${scope}`;
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
  const key = `mons.ethereum111k:${scope}:pending`;
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
  const key = `mons.ethereum111k:${scope}:pending`;
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
      const key = `mons.ethereum111k:${scope}:pending`;
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
    assert.equal(window.localStorage.getItem(`mons.ethereum111k:${scope}:pending`), null);
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
});

test('a confirmed transaction finishes when its stored record has already disappeared', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: Date.now() });
  let finish: ((result: EthereumTransactionConfirmResponse) => void) | undefined;
  t.mock.method(ethereumApi, 'confirm', () => new Promise<EthereumTransactionConfirmResponse>(resolve => { finish = resolve; }));
  const view = harness();
  await waitFor(() => assert.ok(finish));
  window.localStorage.removeItem(`mons.ethereum111k:${scope}:pending`);
  await act(async () => { finish!({ status: 'confirmed', confirmations: 1, items: [token()], burnedTokenIds: [] }); });
  await waitFor(() => assert.equal(view.result.current.pending, null));
  assert.deepEqual(readEthereumExpected(scope), [token().tokenId]);
});

for (const outcome of ['confirmed', 'reverted'] as const) {
  for (const newer of ['none', 'reservation', 'transaction'] as const) {
    test(`${outcome} cleanup waits for the submission lock and rechecks ${newer === 'none' ? 'the original transaction' : `a newer ${newer}`}`, async t => {
      const scope = ethereumInventoryScope(config, owner)!;
      const key = `mons.ethereum111k:${scope}:pending`;
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
      const competing = navigator.locks.request(`mons:ethereum111k-submission:${scope}`, { ifAvailable: true }, async lock => {
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
  const competing = navigator.locks.request(`mons:ethereum111k-submission:${scope}`, { ifAvailable: true }, async lock => {
    assert.ok(lock);
    await new Promise<void>(resolve => { release = resolve; });
  });
  let dismissed: Promise<void> | undefined;
  act(() => { dismissed = view.result.current.dismissPending(); });
  assert.equal(readEthereumPending(scope)?.hash, hash);
  const nextHash = `0x${'cd'.repeat(32)}`;
  window.localStorage.setItem(`mons.ethereum111k:${scope}:pending`, JSON.stringify({ scope, hash: nextHash, action: 'mint', submittedAt: 2 }));
  await act(async () => { release!(); await competing; await dismissed; });
  assert.equal(readEthereumPending(scope)?.hash, nextHash);
  assert.equal(view.result.current.notice, null);
});

test('late nonce enrichment rechecks the transaction under the submission lock', async t => {
  const connected = wallet();
  const request = connected.provider!.request;
  let finishLookup: ((value: unknown) => void) | undefined;
  let sentTransaction: Record<string, unknown> | undefined;
  connected.provider!.request = async args => {
    if (args.method === 'eth_getTransactionByHash') return new Promise(resolve => { finishLookup = resolve; });
    if (args.method === 'eth_sendTransaction') sentTransaction = (args.params as Record<string, unknown>[])[0];
    return request(args);
  };
  const view = harness(connected);
  await waitFor(() => assert.ok(view.result.current.stats.data));
  await act(async () => { assert.equal(await view.result.current.mint('crate', 1), true); });
  assert.ok(finishLookup && sentTransaction);
  const scope = ethereumInventoryScope(config, owner)!;
  let release: (() => void) | undefined;
  const competing = navigator.locks.request(`mons:ethereum111k-submission:${scope}`, { ifAvailable: true }, async lock => {
    assert.ok(lock);
    await new Promise<void>(resolve => { release = resolve; });
  });
  const requests = t.mock.method(navigator.locks, 'request');
  await act(async () => { finishLookup!({ hash, from: owner, to: contract, input: sentTransaction!.data,
    value: sentTransaction!.value, nonce: '0x7', chainId: '0xaa36a7' }); });
  assert.equal(requests.mock.callCount(), 1);
  assert.equal(readEthereumPending(scope)?.nonce, undefined);
  const nextHash = `0x${'cd'.repeat(32)}`;
  window.localStorage.setItem(`mons.ethereum111k:${scope}:pending`, JSON.stringify({ scope, hash: nextHash, action: 'mint', submittedAt: 2 }));
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
    const key = `mons.ethereum111k:${scope}:pending`;
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

test('revert cleanup preserves a new reservation before its storage event arrives', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  writeEthereumStorage(`${scope}:pending`, { scope, hash, action: 'mint', submittedAt: Date.now() });
  let rejectConfirmation: ((error: Error) => void) | undefined;
  t.mock.method(ethereumApi, 'confirm', () => new Promise<EthereumTransactionConfirmResponse>((_resolve, reject) => {
    rejectConfirmation = reject;
  }));
  harness();
  await waitFor(() => assert.ok(rejectConfirmation));
  const key = `mons.ethereum111k:${scope}:pending`;
  const reserved = JSON.stringify({ scope, hash: `0x${'0'.repeat(64)}`, awaitingHash: true,
    action: 'mint', nonce: '0x8', submittedAt: Date.now(), intent: { to: contract, data: '0x', value: '0x0' } });
  window.localStorage.setItem(key, reserved);
  await act(async () => { rejectConfirmation!(new EthereumApiError(409, 'Reverted', 'transaction-reverted')); });
  assert.equal(window.localStorage.getItem(key), reserved);
  assert.equal(readEthereumSubmission(scope)?.nonce, '0x8');
});

for (const action of ['delivery', 'claim'] as const) {
  test(`late ${action} finalization cannot clear a newer saved reservation hidden by its old fallback`, async t => {
    const scope = ethereumInventoryScope(config, owner)!;
    savedSession(owner);
    const key = `mons.ethereum111k:${scope}:pending`;
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
