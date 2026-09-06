import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { createElement, type PropsWithChildren } from 'react';
import { PublicKey } from '@solana/web3.js';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { getFrontendDrop, isDropFamily } from '../src/config/deployment.ts';
import type { InventoryItem, PendingOpenBox } from '../src/types.ts';
import {
  hiddenInventoryKey,
  loadHiddenAssets,
  loadPendingReveals,
  loadRecentReveals,
  persistHiddenAssets,
  persistPendingReveals,
  persistRecentReveals,
} from '../src/shop/persistedState.ts';
import type { RevealOverlayState } from '../src/shop/reveal/types.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { WalletContext } = await import('@solana/wallet-adapter-react');
const { useShopInventoryQueries } = await import('../src/shop/inventory/useShopInventoryQueries.ts');
const { useShopInventorySource, useShopInventoryMaintenance } = await import('../src/shop/inventory/useShopInventorySource.ts');
const { useShopInventoryView } = await import('../src/shop/inventory/useShopInventoryView.ts');
type SourceOptions = Parameters<typeof useShopInventorySource>[0];
type Views = Parameters<typeof useShopInventoryMaintenance>[1];
type ViewOptions = Parameters<typeof useShopInventoryView>[0];
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
});
after(() => dom.window.close());

function box(id: string, dropId = 'card_nft_2', boxId?: string): InventoryItem {
  return { id, dropId, name: id, kind: 'box', image: `https://images.example/${id}.webp`, ...(boxId ? { boxId } : {}) };
}

function sourceOptions(overrides: Partial<SourceOptions> = {}): SourceOptions {
  const inventory: InventoryItem[] = [];
  const pendingOpenBoxes: PendingOpenBox[] = [];
  return {
    owner: 'wallet-a',
    connectedWallet: 'wallet-a',
    localAccountWallet: 'wallet-a',
    isViewerMode: false,
    requireKnownDropConfig: (dropId) => {
      const drop = getFrontendDrop(dropId || '');
      if (!drop) throw new Error(`Unknown test drop: ${dropId}`);
      return drop;
    },
    inventory,
    pendingOpenBoxes,
    inventoryFetched: true,
    inventoryFetching: false,
    inventoryDataUpdatedAt: 1,
    pendingOpenBoxesSuccess: true,
    refetchInventory: async () => ({ data: inventory } as Awaited<ReturnType<SourceOptions['refetchInventory']>>),
    refetchPendingOpenBoxes: async () => ({ data: pendingOpenBoxes } as Awaited<ReturnType<SourceOptions['refetchPendingOpenBoxes']>>),
    refreshInventoryAfterMint: async () => ({ data: inventory } as Awaited<ReturnType<SourceOptions['refreshInventoryAfterMint']>>),
    ...overrides,
  };
}

const viewDefaults: Omit<ViewOptions, 'source' | keyof Views> = {
  routeDrop: getFrontendDrop('card_nft_2')!,
  receiptOperationHiddenAssets: new Set(),
  pendingDeliveryItemIds: new Set(),
  connectedWallet: 'wallet-a',
  isSignedInWallet: true,
  stripeCheckoutInventoryRefreshPending: false,
  stripeCheckoutProfileRecoveryPending: false,
  walletIdleReady: true,
  authReady: true,
  deliveryCountryCode: 'US',
  cardNft2PackInventoryPreviewVideo: { sources: [] },
  getDropConfig: (dropId) => getFrontendDrop(dropId || 'card_nft_2'),
  figureReferenceForDropId: (_dropId, reference) => `Figure ${reference}`,
  boxReferenceForDropId: (_dropId, reference) => `Pack ${reference}`,
  boxLabelForDropId: () => 'pack',
  boxImageForDropId: () => 'https://images.example/pack.webp',
  canOpenBoxesForDropId: () => true,
  usesClearCard3dRevealForDropId: (dropId) => isDropFamily(dropId, 'clear_cards'),
  usesInteractiveCardPackRevealForDropId: () => false,
};

type InventoryHarnessProps = {
  options: SourceOptions;
  views?: Views;
  viewOptions?: Partial<typeof viewDefaults>;
};

function useInventoryHarness({ options, views, viewOptions }: InventoryHarnessProps) {
  const source = useShopInventorySource(options);
  const presentation = views || {
    inventoryView: options.inventory,
    pendingOpenBoxesView: options.pendingOpenBoxes,
    revealOverlay: null,
  };
  useShopInventoryMaintenance(source, presentation);
  const view = useShopInventoryView({ ...viewDefaults, ...viewOptions, source, ...presentation });
  return { source, view };
}

test('wallet hydration preserves each account and late hidden-asset updates stay with the captured wallet', () => {
  const now = Date.now();
  persistHiddenAssets('wallet-a', new Set(['hidden-a']));
  persistHiddenAssets('wallet-b', new Set(['hidden-b']));
  persistPendingReveals('wallet-a', [{ id: 'pending-a', createdAt: now, dropId: 'card_nft_2' }]);
  persistPendingReveals('wallet-b', [{ id: 'pending-b', createdAt: now, dropId: 'card_nft_2' }]);
  persistRecentReveals('wallet-a', ['revealed-a']);
  persistRecentReveals('wallet-b', ['revealed-b']);
  const initial = sourceOptions();
  const { result, rerender } = renderHook(useShopInventorySource, { initialProps: initial });
  assert.deepEqual(result.current.localPendingReveals.map((entry) => entry.id), ['pending-a']);
  assert.deepEqual(result.current.recentRevealedBoxes, ['revealed-a']);
  assert.deepEqual(result.current.hiddenAssets, new Set(['hidden-a']));
  const lateHide = result.current.actions.hideAssetsForWallet;

  rerender({ ...initial, owner: 'wallet-b', connectedWallet: 'wallet-b', localAccountWallet: 'wallet-b' });
  assert.deepEqual(result.current.localPendingReveals.map((entry) => entry.id), ['pending-b']);
  assert.deepEqual(result.current.recentRevealedBoxes, ['revealed-b']);
  assert.deepEqual(loadPendingReveals('wallet-b').map((entry) => entry.id), ['pending-b']);
  assert.deepEqual(loadPendingReveals('wallet-a').map((entry) => entry.id), ['pending-a']);
  act(() => lateHide('wallet-a', ['late-a']));
  assert.deepEqual(loadHiddenAssets('wallet-a'), new Set(['hidden-a', 'late-a']));
  assert.deepEqual(result.current.hiddenAssets, new Set(['hidden-b']));

  persistHiddenAssets('wallet-b', new Set(['external-b']));
  act(() => dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: hiddenInventoryKey('wallet-b') })));
  assert.deepEqual(result.current.hiddenAssets, new Set(['external-b']));
});

test('viewer mode neither persists reveal state nor shows private optimistic or hidden assets', (t) => {
  const item = box('private-hidden', 'card_nft_2', '1');
  persistHiddenAssets('wallet-a', new Set([item.id]));
  persistPendingReveals('wallet-a', [{ id: 'private-pending', createdAt: Date.now(), dropId: 'card_nft_2' }]);
  persistRecentReveals('wallet-a', ['private-revealed']);
  const writes: string[] = [];
  const setItem = dom.window.Storage.prototype.setItem;
  t.mock.method(dom.window.Storage.prototype, 'setItem', function (this: Storage, key: string, value: string) {
    writes.push(key);
    return setItem.call(this, key, value);
  });
  const initial: InventoryHarnessProps = {
    options: sourceOptions({ owner: 'viewed-owner', isViewerMode: true, inventory: [item] }),
    viewOptions: { receiptOperationHiddenAssets: new Set([item.id]) },
  };
  const { result } = renderHook(useInventoryHarness, { initialProps: initial });
  act(() => {
    result.current.source.actions.addLocalPendingReveal(box('new-pending'));
    result.current.source.actions.addLocalMintedBoxes(1, 'card_nft_2', ['new-mint']);
    result.current.source.actions.rememberRecentReveal('new-reveal');
    result.current.source.actions.markAssetsHidden(['new-hidden']);
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(result.current.view.inventoryItems.map((entry) => entry.id), [item.id]);
  assert.equal(result.current.view.pendingRevealIds.size, 0);
  assert.deepEqual(loadPendingReveals('wallet-a').map((entry) => entry.id), ['private-pending']);
  assert.deepEqual(loadRecentReveals('wallet-a'), ['private-revealed']);
  assert.deepEqual(loadHiddenAssets('wallet-a'), new Set([item.id]));
  t.mock.restoreAll();
});

const openOverlay: RevealOverlayState = {
  id: 'opened-box', dropId: 'card_nft_2', name: 'Opened pack',
  originRect: { left: 0, top: 0, width: 20, height: 20 },
  targetRect: { left: 0, top: 0, width: 200, height: 200 },
  phase: 'preparing', frame: 1, advanceClicks: 0,
};

test('an open reveal defers pending and minted reconciliation until its frozen snapshot is released', () => {
  const baseline = [box('opened-box', 'card_nft_2', '1')];
  let refetches = 0;
  const options = sourceOptions({
    inventory: baseline,
    refetchInventory: async () => {
      refetches += 1;
      return { data: baseline } as Awaited<ReturnType<SourceOptions['refetchInventory']>>;
    },
  });
  const frozenViews: Views = { inventoryView: baseline, pendingOpenBoxesView: [], revealOverlay: openOverlay };
  const { result, rerender } = renderHook(useInventoryHarness, { initialProps: { options, views: frozenViews } });
  act(() => {
    result.current.source.actions.addLocalPendingReveal(baseline[0]);
    result.current.source.actions.rememberRecentReveal(baseline[0].id);
    result.current.source.actions.addLocalMintedBoxes(1, 'card_nft_2', ['new-box'], frozenViews.inventoryView);
  });
  const optimisticId = result.current.source.localMintedBoxes[0].id;
  const latest = [...baseline, box('new-box', 'card_nft_2', '2')];
  rerender({ options: { ...options, inventory: latest }, views: frozenViews });
  assert.equal(result.current.source.localMintedBoxes[0].id, optimisticId);
  assert.deepEqual(result.current.source.localPendingReveals.map((entry) => entry.id), ['opened-box']);
  assert.equal(refetches, 0);
  assert.equal(result.current.view.inventoryItems.some((item) => item.id === 'new-box'), false);

  rerender({
    options: { ...options, inventory: latest },
    views: { inventoryView: latest, pendingOpenBoxesView: [], revealOverlay: null },
  });
  assert.deepEqual(result.current.source.localMintedBoxes, []);
  assert.deepEqual(result.current.source.localPendingReveals, []);
  assert.equal(result.current.view.inventoryItems.some((item) => item.id === 'new-box'), true);
  assert.equal(result.current.view.inventoryItems.some((item) => item.id === optimisticId), false);
});

test('an unresolved minted pack stays represented once until its authoritative box ID arrives', () => {
  const baseline = [box('existing', 'card_nft_2', '1')];
  const options = sourceOptions({ inventory: baseline });
  const { result, rerender } = renderHook(useInventoryHarness, { initialProps: { options } });
  act(() => result.current.source.actions.addLocalMintedBoxes(1, 'card_nft_2', ['minted']));
  const optimisticId = result.current.source.localMintedBoxes[0].id;
  assert.deepEqual(result.current.view.inventoryItems.map((item) => item.id), [optimisticId, 'existing']);
  rerender({ options: { ...options, inventory: [...baseline, box('minted')] } });
  assert.equal(result.current.source.localMintedBoxes.length, 1);
  assert.equal(typeof result.current.source.localMintedBoxes[0].unresolvedMatchedAt, 'number');
  assert.deepEqual(result.current.view.inventoryItems.map((item) => item.id), [optimisticId, 'existing']);

  rerender({ options: { ...options, inventory: [...baseline, box('minted', 'card_nft_2', '2')] } });
  assert.deepEqual(result.current.source.localMintedBoxes, []);
  assert.deepEqual(result.current.view.inventoryItems.map((item) => item.id), ['existing', 'minted']);
});

test('selection excludes pending delivery/reveal items, follows drop rules and prunes vanished assets', () => {
  const items: InventoryItem[] = [
    box('other-pack-1', 'card_nft_2', '1'), box('other-pack-2', 'card_nft_2', '2'),
    box('clear-pack-1', 'clear_cards', '1'), box('clear-pack-2', 'clear_cards', '2'),
    { id: 'clear-card-1', dropId: 'clear_cards', name: 'Card 1', kind: 'dude' },
    { id: 'clear-card-2', dropId: 'clear_cards', name: 'Card 2', kind: 'dude' },
    { id: 'receipt', dropId: 'clear_cards', name: 'Receipt', kind: 'certificate' },
  ];
  const options = sourceOptions({ inventory: items });
  const initial: InventoryHarnessProps = { options, viewOptions: { pendingDeliveryItemIds: new Set(['other-pack-2']) } };
  const { result, rerender } = renderHook(useInventoryHarness, { initialProps: initial });
  act(() => result.current.view.toggleSelected('other-pack-1'));
  act(() => result.current.view.toggleSelected('other-pack-2'));
  assert.deepEqual(result.current.view.selected, new Set(['other-pack-1']));
  act(() => result.current.view.toggleSelected('clear-card-1'));
  act(() => result.current.view.toggleSelected('clear-card-2'));
  assert.deepEqual(result.current.view.selected, new Set(['clear-card-1', 'clear-card-2']));
  act(() => result.current.view.toggleSelected('clear-pack-1'));
  assert.deepEqual(result.current.view.selected, new Set(['clear-pack-1']));
  act(() => result.current.view.toggleSelected('clear-pack-2'));
  assert.deepEqual(result.current.view.selected, new Set(['clear-pack-2']));
  act(() => result.current.view.toggleSelected('receipt'));
  assert.deepEqual(result.current.view.selected, new Set(['clear-pack-2']));

  const pendingOpenBoxes: PendingOpenBox[] = [{
    dropId: 'clear_cards', pendingPda: 'pending', boxAssetId: 'clear-pack-2', dudeAssetIds: [],
  }];
  rerender({ ...initial, options: { ...options, pendingOpenBoxes } });
  assert.equal(result.current.view.pendingRevealIds.has('clear-pack-2'), true);
  assert.equal(result.current.view.selected.size, 0);
  act(() => result.current.view.toggleSelected('clear-pack-2'));
  assert.equal(result.current.view.selected.size, 0);
  act(() => result.current.view.toggleSelected('clear-card-1'));
  assert.deepEqual(result.current.view.selected, new Set(['clear-card-1']));
  rerender({ ...initial, options: { ...options, pendingOpenBoxes, inventory: items.filter((item) => item.id !== 'clear-card-1') } });
  assert.equal(result.current.view.selected.size, 0);
});

test('inventory empty states wait for fetch and checkout recovery readiness', () => {
  const options = sourceOptions({ inventoryFetched: false });
  const initial: InventoryHarnessProps = { options };
  const { result, rerender } = renderHook(useInventoryHarness, { initialProps: initial });
  assert.equal(result.current.view.inventoryInitialResponseReady, false);
  assert.equal(result.current.view.inventoryEmptyStateVisibility, 'hidden');
  rerender({ options: { ...options, inventoryFetched: true }, viewOptions: { stripeCheckoutInventoryRefreshPending: true } });
  assert.equal(result.current.view.inventoryInitialResponseReady, true);
  assert.equal(result.current.view.inventoryEmptyStateVisibility, 'hidden');
  rerender({ options: { ...options, inventoryFetched: true } });
  assert.equal(result.current.view.inventoryEmptyStateVisibility, 'visible');
  const anonymousOptions = { ...options, owner: undefined, connectedWallet: undefined, localAccountWallet: undefined };
  rerender({ options: anonymousOptions, viewOptions: { stripeCheckoutProfileRecoveryPending: true } });
  assert.equal(result.current.view.inventoryEmptyStateVisibility, 'hidden');
  rerender({ options: anonymousOptions });
  assert.equal(result.current.view.inventoryEmptyStateVisibility, 'visible');
});

test('inventory query composition keeps owner and devnet caches separate without duplicate loading', async (t) => {
  const walletKey = new PublicKey(new Uint8Array(32).fill(9));
  const owner = walletKey.toBase58();
  const mainnet = [box('mainnet-box', 'card_nft_2', '1')];
  const devnet = [...mainnet, box('devnet-box', 'clear_cards_devnet_v2', '2')];
  const viewed = [box('viewed-box', 'card_nft_2', '3')];
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  clients.push(client);
  for (const [keyOwner, includeDevnet, inventory] of [[owner, false, mainnet], [owner, true, devnet], ['viewed-owner', false, viewed]] as const) {
    client.setQueryData(['inventory', keyOwner, includeDevnet], inventory);
    client.setQueryData(['pendingOpenBoxes', keyOwner, includeDevnet], []);
  }
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inventory network request'); });
  const wallet = {
    autoConnect: false, wallets: [], wallet: null, publicKey: walletKey,
    connecting: false, connected: true, disconnecting: false,
    select: () => undefined, connect: async () => undefined, disconnect: async () => undefined,
    sendTransaction: async () => '', signTransaction: undefined, signAllTransactions: undefined,
    signMessage: undefined, signIn: undefined,
  };
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client },
    createElement(WalletContext.Provider, { value: wallet }, children));
  const initial = { owner, includeDevnet: false, isViewerMode: false };
  const { result, rerender } = renderHook(({ owner, includeDevnet, isViewerMode }: typeof initial) => (
    useShopInventoryQueries(owner, includeDevnet, isViewerMode)
  ), { initialProps: initial, wrapper });
  assert.equal(result.current.inventory, mainnet);
  assert.equal(result.current.inventoryFetched, true);
  rerender({ ...initial, includeDevnet: true });
  assert.equal(result.current.inventory, devnet);
  rerender({ owner: 'viewed-owner', includeDevnet: false, isViewerMode: true });
  assert.equal(result.current.inventory, viewed);
  rerender(initial);
  assert.equal(result.current.inventory, mainnet);
  await waitFor(() => assert.equal(result.current.inventoryFetching, false));
  assert.equal(network.mock.callCount(), 0);
});
