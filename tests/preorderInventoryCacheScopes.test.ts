import assert from 'node:assert/strict';
import { installBrowserLocks } from './helpers/browserLocks.ts';
import test, { after, afterEach, beforeEach } from 'node:test';

beforeEach(context => { if ('after' in context) installBrowserLocks(context); });
import { createElement, type PropsWithChildren } from 'react';
import { PublicKey } from '@solana/web3.js';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { getFrontendDrop } from '../src/config/deployment.ts';
import { getPreorderConfig } from '../shared/preorders.ts';
import { listPreorderRecoveries, resolvePreorderInventoryAssets, upsertPreorderRecovery } from '../src/lib/preorderRecovery.ts';
import type { PreorderCheckoutApi } from '../src/hooks/usePreorderReconciliation.ts';
import type { InventoryItem } from '../src/types.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { WalletContext } = await import('@solana/wallet-adapter-react');
const { useShopInventoryQueries } = await import('../src/shop/inventory/useShopInventoryQueries.ts');
const { usePreorderCheckout } = await import('../src/hooks/usePreorderCheckout.ts');
const { useShopInventorySelection, useShopInventorySelectionState } = await import('../src/shop/inventory/useShopInventorySelection.ts');
const clients: InstanceType<typeof QueryClient>[] = [];
const pendingResponses: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
const walletKey = new PublicKey(new Uint8Array(32).fill(31));
const owner = walletKey.toBase58();
const assetAddress = new PublicKey(new Uint8Array(32).fill(32)).toBase58();
const config = getPreorderConfig('mi_note_cards')!;
const order = {
  orderId: 'cache-scope-order', preorderId: config.preorderId, buyer: owner, ethereumAddress: null,
  cardIds: [1], assets: [{ id: 1, address: assetAddress }], status: 'succeeded' as const, expiresAtMs: 1,
  signature: '1111111111111111111111111111111111111111111111111111111111111111', confirmedSlot: 200,
};
const canonical: InventoryItem = { id: assetAddress, dropId: config.preorderId, kind: 'preorder', name: 'Preorder #1', preorderId: 1 };
const storageKey = `mons:preorder-recovery:v3:${config.cluster}:${config.collection}:${owner}:${order.orderId}`;
const wallet = {
  autoConnect: false, wallets: [], wallet: null, publicKey: walletKey,
  connecting: false, connected: true, disconnecting: false,
  select: () => undefined, connect: async () => undefined, disconnect: async () => undefined,
  sendTransaction: async () => '', signTransaction: undefined, signAllTransactions: undefined,
  signMessage: undefined, signIn: undefined,
};
const emptyIds = new Set<string>();

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  pendingResponses.splice(0).forEach(response => response.resolve(Response.json({ ok: true, items: [] })));
  window.localStorage.clear();
  window.sessionStorage.clear();
});
after(() => dom.window.close());

function clientWithEmptyInventory() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  clients.push(client);
  for (const includeDevnet of [false, true]) {
    client.setQueryData(['inventory', owner, includeDevnet], []);
    client.setQueryData(['pendingOpenBoxes', owner, includeDevnet], []);
  }
  return client;
}

function inventoryConsumer(client: InstanceType<typeof QueryClient>, includeDevnet: boolean) {
  const snapshots: { ids: string[]; selected: number }[] = [];
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client },
    createElement(WalletContext.Provider, { value: wallet }, children));
  const hook = renderHook(() => {
    const queries = useShopInventoryQueries(owner, includeDevnet, false);
    const state = useShopInventorySelectionState({ owner, connectedWallet: owner });
    const selection = useShopInventorySelection({
      state, owner, connectedWallet: owner, inventoryView: queries.inventory,
      inventoryIndex: new Map(queries.inventory.map(item => [item.id, item])),
      pendingRevealIds: emptyIds, pendingDeliveryItemIds: emptyIds, isSignedInWallet: true,
      deliveryCountryCode: 'US', dismissalBlocked: false, getDropConfig: getFrontendDrop,
      canOpenBoxesForDropId: () => false, usesClearCard3dRevealForDropId: () => false,
      usesInteractiveCardPackRevealForDropId: () => false,
    });
    snapshots.push({ ids: queries.inventory.map(item => item.id), selected: selection.selectedCount });
    return { queries, state, selection };
  }, { wrapper });
  return { ...hook, snapshots };
}

function assertSelectedInventory(consumer: ReturnType<typeof inventoryConsumer>, since: number) {
  assert.equal(consumer.result.current.selection.selectedViewableItem?.id, assetAddress);
  assert.ok(consumer.snapshots.slice(since).every(snapshot => snapshot.ids.includes(assetAddress) && snapshot.selected === 1));
}

for (const owned of [false, true]) test(`finalized ${owned ? 'ownership' : 'absence'} reaches a signed-out owner before local order finalization`, async t => {
  await upsertPreorderRecovery({ ...order, status: 'submitted' });
  const response = Promise.withResolvers<Response>();
  pendingResponses.push(response);
  let inventoryCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { inventoryCalls++; return response.promise; });
  let statusCalls = 0;
  let successCalls = 0;
  let settledCalls = 0;
  const unexpected = async (): Promise<never> => assert.fail('Inventory handoff must not prepare, sign, submit, or cancel a preorder');
  const api: PreorderCheckoutApi = {
    availability: unexpected, prepare: unexpected, submit: unexpected, cancel: unexpected,
    status: async (_preorderId, orderId) => {
      statusCalls++;
      assert.equal(orderId, order.orderId);
      return { order: { ...order, confirmedSlot: 240 } };
    },
  };
  const client = clientWithEmptyInventory();
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client },
    createElement(WalletContext.Provider, { value: wallet }, children));
  const { result, rerender } = renderHook((signedIn: boolean) => {
    usePreorderCheckout({ config, active: false, buyer: owner, signedIn,
      authenticatedBuyer: signedIn ? owner : undefined, ethereumSession: null, signTransaction: unexpected,
      ensureSignedIn: async () => false, onSucceeded: () => { successCalls++; }, onSettled: () => { settledCalls++; },
    }, api);
    return useShopInventoryQueries(owner, false, false);
  }, { initialProps: false, wrapper });
  assert.deepEqual(result.current.inventory.map(item => item.id), [assetAddress]);
  await waitFor(() => assert.equal(inventoryCalls, 1));
  await act(async () => { response.resolve(Response.json({ ok: true, items: owned ? [canonical] : [],
    resolvedPreorderAssetIds: [assetAddress], preorderAssetResolutions: [{ id: assetAddress, slot: 250, owned }] })); });
  await waitFor(() => assert.equal(result.current.inventoryFetching, false));
  const receipt = listPreorderRecoveries(owner)[0];
  assert.equal(receipt.order.status, 'submitted');
  assert.equal(receipt.inventoryResolutionSlots?.[assetAddress], 250);
  assert.deepEqual(receipt.resolvedAssetIds, [assetAddress]);
  assert.deepEqual(receipt.ownedResolvedAssetIds, owned ? [assetAddress] : []);
  assert.deepEqual(result.current.inventory.map(item => item.id), owned ? [assetAddress] : []);
  assert.deepEqual(client.getQueryData<InventoryItem[]>(['inventory', owner, false])?.map(item => item.id), owned ? [assetAddress] : []);
  assert.equal(statusCalls, 0);
  assert.equal(successCalls, 0);
  rerender(true);
  await waitFor(() => assert.equal(listPreorderRecoveries(owner)[0].order.status, 'succeeded'));
  assert.equal(statusCalls, 1);
  assert.equal(settledCalls, 1);
  assert.equal(successCalls, 0);
  assert.equal(listPreorderRecoveries(owner)[0].inventoryResolutionSlots?.[assetAddress], 250);
  assert.deepEqual(result.current.inventory.map(item => item.id), owned ? [assetAddress] : []);
});

test('one inventory receipt preserves the selected overlay in other clients and devnet cache variants', async t => {
  await upsertPreorderRecovery(order);
  const responses: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) => {
    const response = Promise.withResolvers<Response>();
    pendingResponses.push(response);
    init?.signal?.addEventListener('abort', () => response.reject(init.signal?.reason), { once: true });
    responses.push(response);
    return response.promise;
  });
  const firstClient = clientWithEmptyInventory();
  const secondClient = clientWithEmptyInventory();
  const first = inventoryConsumer(firstClient, false);
  const otherVariant = inventoryConsumer(firstClient, true);
  const otherClient = inventoryConsumer(secondClient, false);
  const consumers = [first, otherVariant, otherClient];
  await waitFor(() => assert.equal(responses.length, 3));
  act(() => { for (const consumer of consumers) consumer.result.current.state.replaceSelection([assetAddress]); });
  const selectedAt = consumers.map(consumer => consumer.snapshots.length);
  await act(async () => { responses[0].resolve(Response.json({ ok: true, items: [canonical], resolvedPreorderAssetIds: [assetAddress],
    preorderAssetResolutions: [{ id: assetAddress, slot: 250, owned: true }] })); });
  await waitFor(() => assert.equal(first.result.current.queries.inventoryFetching, false));
  assert.deepEqual(listPreorderRecoveries(owner)[0].ownedResolvedAssetIds, [assetAddress]);
  assert.deepEqual(firstClient.getQueryData(['inventory', owner, true]), []);
  assert.deepEqual(secondClient.getQueryData(['inventory', owner, false]), []);
  consumers.forEach((consumer, index) => assertSelectedInventory(consumer, selectedAt[index]));
  await act(async () => {
    responses[1].resolve(Response.json({ ok: true, items: [] }));
    responses[2].resolve(Response.json({ ok: true, items: [] }));
  });
  await waitFor(() => assert.ok(consumers.every(consumer => !consumer.result.current.queries.inventoryFetching)));
  consumers.forEach((consumer, index) => assertSelectedInventory(consumer, selectedAt[index]));
  let refresh!: ReturnType<typeof first.result.current.queries.refetchInventory>;
  act(() => { refresh = first.result.current.queries.refetchInventory(); });
  await waitFor(() => assert.equal(responses.length, 4));
  await act(async () => { responses[3].resolve(Response.json({ ok: true, items: [] })); await refresh; });
  assert.deepEqual(firstClient.getQueryData(['inventory', owner, false]), []);
  assertSelectedInventory(first, selectedAt[0]);
});

test('storage receipts preserve selection and cache acknowledgements do not survive cache recreation', async t => {
  await upsertPreorderRecovery(order);
  const unresolved = window.localStorage.getItem(storageKey)!;
  await resolvePreorderInventoryAssets(owner, [assetAddress], [assetAddress]);
  const receipt = window.localStorage.getItem(storageKey)!;
  window.localStorage.setItem(storageKey, unresolved);
  const responses: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
  const requestBodies: { expectedAssetIds?: { 'mainnet-beta'?: string[] } }[] = [];
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) => {
    const response = Promise.withResolvers<Response>();
    pendingResponses.push(response);
    init?.signal?.addEventListener('abort', () => response.reject(init.signal?.reason), { once: true });
    requestBodies.push(JSON.parse(String(init?.body)));
    responses.push(response);
    return response.promise;
  });
  const client = clientWithEmptyInventory();
  const first = inventoryConsumer(client, false);
  await waitFor(() => assert.equal(responses.length, 1));
  act(() => first.result.current.state.replaceSelection([assetAddress]));
  const selectedAt = first.snapshots.length;
  await act(async () => {
    window.localStorage.setItem(storageKey, receipt);
    window.dispatchEvent(new dom.window.StorageEvent('storage', { key: storageKey, oldValue: unresolved, newValue: receipt }));
  });
  assertSelectedInventory(first, selectedAt);
  await act(async () => { responses[0].resolve(Response.json({ ok: true, items: [canonical], resolvedPreorderAssetIds: [assetAddress],
    preorderAssetResolutions: [{ id: assetAddress, slot: 250, owned: true }] })); });
  await waitFor(() => assert.equal(first.result.current.queries.inventoryFetching, false));
  assertSelectedInventory(first, selectedAt);
  first.unmount();
  client.removeQueries({ queryKey: ['inventory', owner, false], exact: true });
  client.setQueryData(['inventory', owner, false], []);
  const recreated = inventoryConsumer(client, false);
  const freshClient = inventoryConsumer(clientWithEmptyInventory(), false);
  await waitFor(() => assert.equal(responses.length, 3));
  assert.deepEqual(requestBodies[1].expectedAssetIds?.['mainnet-beta'], [assetAddress]);
  assert.deepEqual(requestBodies[2].expectedAssetIds?.['mainnet-beta'], [assetAddress]);
  act(() => {
    recreated.result.current.state.replaceSelection([assetAddress]);
    freshClient.result.current.state.replaceSelection([assetAddress]);
  });
  const recreatedAt = recreated.snapshots.length;
  const freshAt = freshClient.snapshots.length;
  await act(async () => {
    responses[1].resolve(Response.json({ ok: true, items: [] }));
    responses[2].resolve(Response.json({ ok: true, items: [] }));
  });
  await waitFor(() => assert.ok(!recreated.result.current.queries.inventoryFetching && !freshClient.result.current.queries.inventoryFetching));
  assertSelectedInventory(recreated, recreatedAt);
  assertSelectedInventory(freshClient, freshAt);
});
