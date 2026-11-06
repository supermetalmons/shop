import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { createElement, type PropsWithChildren } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import type { EthereumInventoryItem, EthereumInventoryResponse } from '../shared/ethereum/api.ts';
import { ethereumAssetId } from '../shared/ethereum/protocol.ts';
import type { InventoryItem } from '../src/types.ts';
import { buildEthereumInventoryItems } from '../src/ethereum/inventory.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { ethereumApi } = await import('../src/ethereum/api.ts');
const { ethereumInventoryScope, readEthereumExpected, writeEthereumExpected } = await import('../src/ethereum/state.ts');
const { readEthereumConfirmedInventory, rememberEthereumConfirmedInventory } = await import('../src/ethereum/confirmedInventory.ts');
const { fetchEthereumInventory } = await import('../src/ethereum/inventoryQuery.ts');
const { useEthereumInventory } = await import('../src/ethereum/useEthereumInventory.ts');
dom.window.close();
const clients: InstanceType<typeof QueryClient>[] = [];
const owner = `0x${'11'.repeat(20)}`;
const config = resolveEthereum111kConfig({ contractAddress: `0x${'33'.repeat(20)}` });

beforeEach(() => { ({ dom } = setupFrontendDom()); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); dom.window.close(); });

function token(tokenId: string, kind: EthereumInventoryItem['kind'] = 'artwork'): EthereumInventoryItem {
  return { id: ethereumAssetId(config.chainId, config.contractAddress!, tokenId), tokenId, kind,
    displayId: Number(tokenId), name: `${kind} ${tokenId}`, owner, chainId: config.chainId,
    contractAddress: config.contractAddress!, image: `https://cdn.mons.shop/${tokenId}.webp` };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('one inventory orders pending mints and Ethereum container groups before the unchanged Solana sequence', () => {
  const solanaItems: InventoryItem[] = [
    { id: 'sol-art', kind: 'dude', name: 'Solana art', dropId: 'mi_note_cards' },
    { id: 'sol-box', kind: 'box', name: 'Solana box', dropId: 'mi_note_cards' },
  ];
  const inputs = [token('1'), token('2', 'crate'), token('3', 'warehouse'), token('4', 'relic'), token('5'), token('6', 'crate_receipt')];
  const inventory = buildEthereumInventoryItems({ items: [...inputs, inputs[0]], solanaItems, dropId: '111k', pendingMints: [
    { id: 'older', kind: 'crate', quantity: 2, submittedAt: 10 },
    { id: 'newer', kind: 'warehouse', quantity: 1, submittedAt: 20 },
  ] });
  assert.deepEqual(inventory.items.map(item => item.id), [
    'ethereum-pending:newer:0', 'ethereum-pending:older:0', 'ethereum-pending:older:1',
    inputs[2].id, inputs[3].id, inputs[1].id, inputs[0].id, inputs[4].id, 'sol-art', 'sol-box',
  ]);
  assert.deepEqual([...inventory.busyItemIds], inventory.items.slice(0, 3).map(item => item.id));
  assert.ok(inventory.items.slice(0, -2).every(item => item.dropId === '111k'));
  assert.equal(inventory.items.at(-2), solanaItems[0]);
  assert.equal(inventory.items.at(-1), solanaItems[1]);
  assert.equal(inventory.items[0].image, 'https://wip.lil.org/111k/warehouse_clean.webp');
  assert.equal(inventory.items[1].image, 'https://wip.lil.org/111k/crate_clean.webp');
  assert.deepEqual(inputs.map(item => item.tokenId), ['1', '2', '3', '4', '5', '6']);
});

test('settled mint placeholders disappear without marking confirmed tokens busy', () => {
  const inventory = buildEthereumInventoryItems({ items: [token('1', 'crate')], pendingMints: [], solanaItems: [], dropId: config.dropId });
  assert.deepEqual(inventory.items.map(item => item.id), [token('1').id]);
  assert.equal(inventory.busyItemIds.size, 0);
  assert.equal(inventory.items[0].status, undefined);
});

test('all inventory cursor pages load sequentially, deduplicate tokens and send expected IDs only on the first page', async t => {
  const calls: Array<{ cursor: string | null; expected: string[] }> = [];
  let active = 0;
  const pages: EthereumInventoryResponse[] = [
    { items: [token('1'), token('2')], nextCursor: 'second', observedBlock: 10 },
    { items: [], nextCursor: 'third', observedBlock: 11 },
    { items: [{ ...token('2'), name: 'Updated artwork' }, token('3')], nextCursor: null, observedBlock: 12 },
  ];
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, cursor, _signal, expected = []) => {
    assert.equal(active++, 0);
    calls.push({ cursor, expected });
    await Promise.resolve();
    active--;
    return pages[calls.length - 1];
  });
  const result = await fetchEthereumInventory(config, owner, new AbortController().signal, ['99']);
  assert.deepEqual(calls, [{ cursor: null, expected: ['99'] }, { cursor: 'second', expected: [] }, { cursor: 'third', expected: [] }]);
  assert.deepEqual(result.items.map(item => item.tokenId), ['1', '2', '3']);
  assert.equal(result.items[1].name, 'Updated artwork');
  assert.equal(result.nextCursor, null);
  assert.equal(result.observedBlock, 10);
});

test('repeated inventory cursor cycles fail instead of fetching indefinitely', async t => {
  let count = 0;
  t.mock.method(ethereumApi, 'inventory', async () => ({ items: [], observedBlock: 1, nextCursor: ++count === 2 ? 'other' : 'repeated' }));
  await assert.rejects(fetchEthereumInventory(config, owner, new AbortController().signal), /Couldn’t load your collection/);
  assert.equal(count, 3);
});

test('an aborted inventory read stops before requesting another cursor', async t => {
  const controller = new AbortController();
  const request = t.mock.method(ethereumApi, 'inventory', async () => {
    controller.abort();
    return { items: [token('1')], observedBlock: 1, nextCursor: 'more' };
  });
  await assert.rejects(fetchEthereumInventory(config, owner, controller.signal), { name: 'AbortError' });
  assert.equal(request.mock.callCount(), 1);
});

for (const change of ['owner', 'deployment'] as const) test(`inventory ${change} changes abort stale pages and isolate the new collection`, async t => {
  const stale = deferred<EthereumInventoryResponse>();
  let staleSignal!: AbortSignal;
  const nextOwner = change === 'owner' ? `0x${'22'.repeat(20)}` : owner;
  const nextConfig = change === 'deployment' ? resolveEthereum111kConfig({ contractAddress: `0x${'44'.repeat(20)}` }) : config;
  const nextToken = { ...token('3'), owner: nextOwner, contractAddress: nextConfig.contractAddress!,
    id: ethereumAssetId(nextConfig.chainId, nextConfig.contractAddress!, '3') };
  const expected: string[][] = [];
  t.mock.method(ethereumApi, 'inventory', async (requestedConfig, requestedOwner, cursor, signal, expectedIds = []) => {
    if (requestedConfig.contractAddress === config.contractAddress && requestedOwner === owner) {
      if (cursor === null) return { items: [token('1')], nextCursor: 'more', observedBlock: 1 };
      staleSignal = signal!;
      return stale.promise;
    }
    expected.push(expectedIds);
    return { items: [nextToken], nextCursor: null, observedBlock: 2 };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const nextScope = ethereumInventoryScope(nextConfig, nextOwner)!;
  writeEthereumExpected(nextScope, ['3']);
  const view = renderHook(({ currentConfig, currentOwner }) => useEthereumInventory(
    currentConfig, currentOwner, ethereumInventoryScope(currentConfig, currentOwner)), {
    wrapper, initialProps: { currentConfig: config, currentOwner: owner },
  });
  await waitFor(() => assert.ok(staleSignal));
  view.rerender({ currentConfig: nextConfig, currentOwner: nextOwner });
  await waitFor(() => assert.equal(view.result.current.data?.items[0]?.id, nextToken.id));
  assert.equal(staleSignal.aborted, true);
  assert.deepEqual(expected, [['3']]);
  await act(async () => { stale.resolve({ items: [token('2')], nextCursor: 'another', observedBlock: 1 }); });
  assert.deepEqual(view.result.current.data?.items, [nextToken]);
});

test('a failed later page preserves the last complete inventory snapshot', async t => {
  let fail = false;
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, cursor) => {
    if (!fail) return { items: [token('1')], nextCursor: null, observedBlock: 1 };
    if (cursor) throw new Error('Connection lost');
    return { items: [token('2')], nextCursor: 'more', observedBlock: 2 };
  });
  const client = new QueryClient();
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const view = renderHook(() => useEthereumInventory(config, owner, ethereumInventoryScope(config, owner)), { wrapper });
  await waitFor(() => assert.equal(view.result.current.isSuccess, true));
  fail = true;
  await act(async () => { await view.result.current.refetch(); });
  assert.deepEqual(view.result.current.data?.items.map(item => item.tokenId), ['1']);
  await waitFor(() => assert.equal(view.result.current.isError, true));
});

for (const count of [600, 611]) test(`${count} confirmed unpack outputs survive index lag without restoring transferred tokens`, async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  const ids = Array.from({ length: count }, (_, index) => String(index + 1));
  writeEthereumExpected(scope, ids);
  assert.equal(readEthereumExpected(scope).length, 500);
  rememberEthereumConfirmedInventory(scope, 'first-unpack', ids.slice(0, 300), ['111112'], Date.now());
  rememberEthereumConfirmedInventory(scope, 'second-unpack', ids.slice(300), ['111113'], Date.now());
  const otherScope = ethereumInventoryScope(config, `0x${'22'.repeat(20)}`)!;
  rememberEthereumConfirmedInventory(otherScope, 'another-owner', ['9001'], [], Date.now());
  const requested: string[][] = [];
  let transferred = false;
  let active = 0;
  let maximum = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(String(input));
    const expected = url.searchParams.get('expectedTokenIds')?.split(',') ?? [];
    requested.push(expected);
    maximum = Math.max(maximum, ++active);
    await Promise.resolve();
    active--;
    return Response.json({ items: expected.filter(id => !transferred || id !== '1').map(id => token(id)),
      nextCursor: null, observedBlock: 42 });
  });
  const client = new QueryClient();
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const view = renderHook(() => useEthereumInventory(config, owner, scope), { wrapper });
  await waitFor(() => assert.equal(view.result.current.data?.items.length, count));
  assert.equal(maximum, 2);
  assert.ok(requested.every(chunk => chunk.length <= 100));
  assert.deepEqual(new Set(requested.flat()), new Set(ids));
  assert.equal(requested.flat().length, count);
  transferred = true;
  await act(async () => { await view.result.current.refetch(); });
  await waitFor(() => assert.equal(view.result.current.data?.items.length, count - 1));
  assert.equal(view.result.current.data?.items.some(item => item.tokenId === '1'), false);
  assert.equal(readEthereumExpected(scope).length, 500);
});

test('confirmed hints over the API limit use capped batches without repeating hints on cursor pages', async t => {
  const ids = Array.from({ length: 1505 }, (_, index) => String(index + 1));
  const requests: Array<{ cursor: string | null; expected: string[] }> = [];
  let active = 0;
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, cursor, _signal, expected = []) => {
    assert.equal(active++, 0);
    requests.push({ cursor, expected });
    assert.ok(expected.length <= 1000);
    await Promise.resolve();
    active--;
    return { items: expected.map(id => token(id)), nextCursor: cursor === null ? 'last-page' : null, observedBlock: 42 };
  });
  const result = await fetchEthereumInventory(config, owner, new AbortController().signal, [...ids, '1']);
  assert.equal(result.items.length, 1505);
  assert.deepEqual(requests.map(request => [request.cursor, request.expected.length]), [[null, 1000], ['last-page', 0], [null, 505]]);
  assert.deepEqual(requests.flatMap(request => request.expected), ids);
});

test('confirmed source burns prune old hints while authoritative ownership can restore a source after reorg', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  const submittedAt = Date.now();
  rememberEthereumConfirmedInventory(scope, 'mint', ['111112', '111113'], [], submittedAt);
  rememberEthereumConfirmedInventory(scope, 'unpack', ['1', '2'], ['111112'], submittedAt);
  writeEthereumExpected(scope, ['111112']);
  const requested: string[][] = [];
  t.mock.method(ethereumApi, 'inventory', async (_config, _owner, _cursor, _signal, expected = []) => {
    requested.push(expected);
    return { items: [token('111112', 'crate')], nextCursor: null, observedBlock: 43 };
  });
  const client = new QueryClient();
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const view = renderHook(() => useEthereumInventory(config, owner, scope), { wrapper });
  await waitFor(() => assert.equal(view.result.current.isSuccess, true));
  assert.deepEqual(new Set(requested.flat()), new Set(['111113', '1', '2']));
  assert.deepEqual(view.result.current.data?.items.map(item => item.tokenId), ['111112']);
});

test('confirmed hints and burn tombstones keep their original expiry and remain scoped by deployment and owner', t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const scope = ethereumInventoryScope(config, owner)!;
  const otherOwner = ethereumInventoryScope(config, `0x${'22'.repeat(20)}`)!;
  const otherContract = ethereumInventoryScope({ ...config, contractAddress: `0x${'44'.repeat(20)}` }, owner)!;
  const submittedAt = now - 25 * 60_000;
  rememberEthereumConfirmedInventory(scope, 'unpack', ['1'], ['111112'], submittedAt);
  rememberEthereumConfirmedInventory(scope, 'unpack', ['2'], ['111113'], now);
  assert.deepEqual(readEthereumConfirmedInventory(scope), { tokenIds: ['1', '2'], burnedTokenIds: ['111112', '111113'] });
  assert.deepEqual(readEthereumConfirmedInventory(otherOwner), { tokenIds: [], burnedTokenIds: [] });
  assert.deepEqual(readEthereumConfirmedInventory(otherContract), { tokenIds: [], burnedTokenIds: [] });
  assert.deepEqual(readEthereumConfirmedInventory(scope, submittedAt + 30 * 60_000), { tokenIds: [], burnedTokenIds: [] });
  assert.equal(window.localStorage.length, 0);
});

test('confirmed outputs survive storage write failure within the active tab', t => {
  const scope = ethereumInventoryScope(config, owner)!;
  const saving = t.mock.method(window.Storage.prototype, 'setItem', () => { throw new Error('Storage full'); });
  rememberEthereumConfirmedInventory(scope, 'unpack', ['1', '2'], ['111112'], Date.now());
  assert.equal(saving.mock.callCount(), 1);
  assert.equal(window.localStorage.length, 0);
  assert.deepEqual(readEthereumConfirmedInventory(scope), { tokenIds: ['1', '2'], burnedTokenIds: ['111112'] });
});
