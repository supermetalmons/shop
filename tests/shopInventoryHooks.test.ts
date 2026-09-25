import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { createElement, type PropsWithChildren } from 'react';
import { PublicKey } from '@solana/web3.js';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { getFrontendDrop, isDropFamily } from '../src/config/deployment.ts';
import { figureMetadataCacheKey, getFigureMetadataSnapshot, loadFigureMetadata } from '../src/lib/figureMetadata.ts';
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

const { dom, setMediaQueryMatches } = setupFrontendDom();
const { act, cleanup, render, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { WalletContext } = await import('@solana/wallet-adapter-react');
const { useShopInventoryQueries } = await import('../src/shop/inventory/useShopInventoryQueries.ts');
const { useShopInventorySource, useShopInventoryMaintenance } = await import('../src/shop/inventory/useShopInventorySource.ts');
const { useShopInventoryView } = await import('../src/shop/inventory/useShopInventoryView.ts');
const { useShopInventorySelection, useShopInventorySelectionState } = await import('../src/shop/inventory/useShopInventorySelection.ts');
const { ShopSelectionBar } = await import('../src/shop/ui/ShopSelectionBar.tsx');
type SourceOptions = Parameters<typeof useShopInventorySource>[0];
type Views = Parameters<typeof useShopInventoryMaintenance>[1];
type ViewOptions = Parameters<typeof useShopInventoryView>[0];
type SelectionOptions = Parameters<typeof useShopInventorySelection>[0];
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  setMediaQueryMatches('(max-width: 720px)', false);
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
  stripeCheckoutInventoryRefreshPending: false,
  stripeCheckoutProfileRecoveryPending: false,
  walletIdleReady: true,
  authReady: true,
  cardNft2PackInventoryPreviewVideo: { sources: [] },
  figureReferenceForDropId: (_dropId, reference) => `Figure ${reference}`,
  boxReferenceForDropId: (_dropId, reference) => `Pack ${reference}`,
  boxLabelForDropId: () => 'pack',
  boxImageForDropId: () => 'https://images.example/pack.webp',
};

const selectionDefaults: Omit<SelectionOptions, 'state' | 'inventoryView' | 'inventoryIndex' | 'pendingRevealIds' | 'owner' | 'connectedWallet'> = {
  pendingDeliveryItemIds: new Set(),
  isSignedInWallet: true,
  deliveryCountryCode: 'US',
  dismissalBlocked: false,
  getDropConfig: (dropId) => getFrontendDrop(dropId || 'card_nft_2'),
  canOpenBoxesForDropId: () => true,
  usesClearCard3dRevealForDropId: (dropId) => isDropFamily(dropId, 'clear_cards'),
  usesInteractiveCardPackRevealForDropId: () => false,
};

type InventoryHarnessProps = {
  options: SourceOptions;
  views?: Views;
  viewOptions?: Partial<typeof viewDefaults>;
  selectionOptions?: Partial<typeof selectionDefaults>;
};

function useInventoryHarness({ options, views, viewOptions, selectionOptions }: InventoryHarnessProps) {
  const source = useShopInventorySource(options);
  const state = useShopInventorySelectionState(options);
  const presentation = views || {
    inventoryView: options.inventory,
    pendingOpenBoxesView: options.pendingOpenBoxes,
    revealOverlay: null,
  };
  useShopInventoryMaintenance(source, presentation);
  const view = useShopInventoryView({ ...viewDefaults, ...viewOptions, source, ...presentation });
  const selection = useShopInventorySelection({
    ...selectionDefaults,
    ...selectionOptions,
    state,
    inventoryView: presentation.inventoryView,
    inventoryIndex: view.inventoryIndex,
    pendingRevealIds: view.pendingRevealIds,
    owner: options.owner,
    connectedWallet: options.connectedWallet,
  });
  return { source, view, selection, state };
}

test('preorders remain selectable inventory with shipping, viewing, and unpacking disabled', () => {
  const preorder: InventoryItem = {
    id: 'preorder-1', dropId: 'mi_note_cards_devnet', name: 'Preorder #1', kind: 'preorder',
    preorderId: 1, image: 'https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1.webp',
  };
  const options = sourceOptions({ inventory: [preorder, box('regular')] });
  const { result } = renderHook(() => useInventoryHarness({ options }));
  assert.ok(result.current.view.inventoryItems.some((item) => item.id === preorder.id && item.image === preorder.image));
  act(() => result.current.selection.toggleSelected(preorder.id));
  assert.equal(result.current.selection.selectedCount, 1);
  assert.equal(result.current.selection.hasPreorderSelected, true);
  assert.equal(result.current.selection.canShipSelected, false);
  assert.equal(result.current.selection.canOpenSelected, false);
  assert.equal(result.current.selection.canViewSelected, false);
  assert.equal(result.current.selection.canShowAdminIrlRedeem, false);
  const bar = render(createElement(ShopSelectionBar, {
    ...result.current.selection,
    clearSelection: () => {}, handleViewSelectedItem: () => {}, handleOpenSelectedBox: () => {},
    handleOpenShip: () => { throw new Error('Preorder shipping must stay disabled'); },
    startOpenLoading: null, openActionProgressForDropId: () => 'Opening', openActionLabelForDropId: () => 'Open',
  }));
  assert.equal((bar.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, true);
  assert.ok(bar.getByText('Soon'));
  act(() => result.current.state.replaceSelection([preorder.id, 'regular']));
  assert.equal(result.current.selection.canShipSelected, false);
});

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

test('inventory observes shared metadata and keeps its public snapshot across wallet changes', async () => {
  const figureId = 2;
  const item: InventoryItem = { id: 'metadata-figure', dropId: 'card_nft_2', dudeId: figureId, kind: 'dude', name: 'Card' };
  const initial = { options: sourceOptions({ inventory: [item] }) };
  const { result, rerender } = renderHook(useInventoryHarness, { initialProps: initial });
  await act(async () => { await loadFigureMetadata(item.dropId, figureId); });
  const snapshot = result.current.source.figureMetadataByKey;
  const metadata = snapshot[figureMetadataCacheKey(item.dropId, figureId)];
  assert.equal(snapshot, getFigureMetadataSnapshot());
  assert.ok(metadata.image);
  assert.equal(result.current.view.inventoryItems[0].image, metadata.image);

  rerender({ options: sourceOptions({ owner: 'wallet-b', connectedWallet: 'wallet-b', localAccountWallet: 'wallet-b', inventory: [item] }) });
  assert.equal(result.current.source.figureMetadataByKey, snapshot);
  assert.equal(result.current.view.inventoryItems[0].image, metadata.image);
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
  const initial: InventoryHarnessProps = { options, selectionOptions: { pendingDeliveryItemIds: new Set(['other-pack-2']) } };
  const { result, rerender } = renderHook(useInventoryHarness, { initialProps: initial });
  act(() => result.current.selection.toggleSelected('other-pack-1'));
  act(() => result.current.selection.toggleSelected('other-pack-2'));
  assert.deepEqual(result.current.selection.selected, new Set(['other-pack-1']));
  act(() => result.current.selection.toggleSelected('clear-card-1'));
  act(() => result.current.selection.toggleSelected('clear-card-2'));
  assert.deepEqual(result.current.selection.selected, new Set(['clear-card-1', 'clear-card-2']));
  act(() => result.current.selection.toggleSelected('clear-pack-1'));
  assert.deepEqual(result.current.selection.selected, new Set(['clear-pack-1']));
  act(() => result.current.selection.toggleSelected('clear-pack-2'));
  assert.deepEqual(result.current.selection.selected, new Set(['clear-pack-2']));
  act(() => result.current.selection.toggleSelected('receipt'));
  assert.deepEqual(result.current.selection.selected, new Set(['clear-pack-2']));

  const pendingOpenBoxes: PendingOpenBox[] = [{
    dropId: 'clear_cards', pendingPda: 'pending', boxAssetId: 'clear-pack-2', dudeAssetIds: [],
  }];
  rerender({ ...initial, options: { ...options, pendingOpenBoxes } });
  assert.equal(result.current.view.pendingRevealIds.has('clear-pack-2'), true);
  assert.equal(result.current.selection.selected.size, 0);
  act(() => result.current.selection.toggleSelected('clear-pack-2'));
  assert.equal(result.current.selection.selected.size, 0);
  act(() => result.current.selection.toggleSelected('clear-card-1'));
  assert.deepEqual(result.current.selection.selected, new Set(['clear-card-1']));
  rerender({ ...initial, options: { ...options, pendingOpenBoxes, inventory: items.filter((item) => item.id !== 'clear-card-1') } });
  assert.equal(result.current.selection.selected.size, 0);
});

test('selection resets on owner or connected-wallet changes and targeted removal preserves other selections', () => {
  const options = sourceOptions({ inventory: [box('pack-a'), box('pack-b')] });
  const { result, rerender } = renderHook(useInventoryHarness, { initialProps: { options } });
  const clearSelection = result.current.state.clearSelection;
  act(() => result.current.state.replaceSelection(['pack-a', 'pack-b']));
  rerender({ options: { ...options, inventory: [...options.inventory] } });
  assert.equal(result.current.state.clearSelection, clearSelection);
  assert.deepEqual(result.current.selection.selected, new Set(['pack-a', 'pack-b']));
  act(() => result.current.state.removeSelected(['pack-a']));
  assert.deepEqual(result.current.selection.selected, new Set(['pack-b']));

  rerender({ options: { ...options, owner: 'wallet-b' } });
  assert.equal(result.current.selection.selected.size, 0);
  act(() => result.current.selection.toggleSelected('pack-a'));
  rerender({ options: { ...options, owner: 'wallet-b', connectedWallet: 'wallet-c' } });
  assert.equal(result.current.selection.selected.size, 0);
});

test('selection keeps the reveal inventory snapshot until it is released', () => {
  const snapshot = [box('snapshot-pack', 'card_nft_2', '1')];
  const options = sourceOptions({ inventory: snapshot });
  const views: Views = { inventoryView: snapshot, pendingOpenBoxesView: [], revealOverlay: openOverlay };
  const { result, rerender } = renderHook(useInventoryHarness, { initialProps: { options, views } });
  act(() => result.current.selection.toggleSelected('snapshot-pack'));
  rerender({ options: { ...options, inventory: [] }, views });
  assert.deepEqual(result.current.selection.selectedItems, snapshot);
  assert.equal(result.current.selection.canOpenSelected, true);
  rerender({ options: { ...options, inventory: [] }, views: { ...views, inventoryView: [], revealOverlay: null } });
  assert.equal(result.current.selection.selected.size, 0);
});

test('pending delivery disables actions and new toggles without clearing an existing selection', () => {
  const options = sourceOptions({ inventory: [box('pack-a'), box('pack-b')] });
  const initial: InventoryHarnessProps = { options };
  const { result, rerender } = renderHook(useInventoryHarness, { initialProps: initial });
  act(() => result.current.selection.toggleSelected('pack-a'));
  assert.equal(result.current.selection.canShipSelected, true);
  rerender({ ...initial, selectionOptions: { pendingDeliveryItemIds: new Set(['pack-a', 'pack-b']) } });
  act(() => result.current.selection.toggleSelected('pack-b'));
  assert.deepEqual(result.current.selection.selected, new Set(['pack-a']));
  assert.equal(result.current.selection.canShipSelected, false);
  assert.equal(result.current.selection.canOpenSelected, false);
});

test('selection Escape handling respects blocked and already-handled events and cleans up', () => {
  const options = sourceOptions({ inventory: [box('pack-a')] });
  const initial: InventoryHarnessProps = { options, selectionOptions: { dismissalBlocked: true } };
  const { result, rerender, unmount } = renderHook(useInventoryHarness, { initialProps: initial });
  act(() => result.current.selection.toggleSelected('pack-a'));
  const pressEscape = (prevented = false) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    if (prevented) event.preventDefault();
    act(() => dom.window.dispatchEvent(event));
    return event;
  };
  assert.equal(pressEscape().defaultPrevented, false);
  assert.equal(result.current.selection.selectedCount, 1);
  rerender({ ...initial, selectionOptions: { dismissalBlocked: false } });
  pressEscape(true);
  assert.equal(result.current.selection.selectedCount, 1);
  assert.equal(pressEscape().defaultPrevented, true);
  assert.equal(result.current.selection.selectedCount, 0);
  act(() => result.current.selection.toggleSelected('pack-a'));
  unmount();
  assert.equal(pressEscape().defaultPrevented, false);
});

test('selection preserves shipment limits and action eligibility with country-specific pricing', () => {
  const adminWallet = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
  const items: InventoryItem[] = [
    ...Array.from({ length: 25 }, (_, index) => box(`pack-${index}`, 'card_nft_2', `${index + 1}`)),
    box('clear-pack', 'clear_cards', '1'),
    { id: 'clear-card', dropId: 'clear_cards', name: 'Card', kind: 'dude', dudeId: 1 },
  ];
  const options = sourceOptions({ inventory: items, owner: adminWallet, connectedWallet: adminWallet });
  const initial: InventoryHarnessProps = { options };
  const { result, rerender } = renderHook(useInventoryHarness, { initialProps: initial });
  act(() => result.current.selection.toggleSelected('pack-0'));
  assert.equal(result.current.selection.canShipSelected, true);
  assert.equal(result.current.selection.canOpenSelected, true);
  assert.equal(result.current.selection.canViewSelected, false);
  assert.equal(result.current.selection.canShowAdminIrlRedeem, true);
  assert.equal(result.current.selection.selectionSummary, '1 pack');
  assert.equal(result.current.selection.deliveryCtaLabel, 'Send for 0.2 SOL');
  rerender({ ...initial, selectionOptions: { deliveryCountryCode: 'TR', isSignedInWallet: false } });
  assert.equal(result.current.selection.deliveryCtaLabel, 'Send for 0.4 SOL');
  assert.equal(result.current.selection.canShowAdminIrlRedeem, false);
  act(() => {
    for (let index = 1; index < 25; index += 1) result.current.selection.toggleSelected(`pack-${index}`);
  });
  assert.equal(result.current.selection.selectedCount, 24);
  assert.equal(result.current.selection.selected.has('pack-24'), false);
  assert.equal(result.current.selection.canOpenSelected, false);

  act(() => result.current.selection.toggleSelected('clear-pack'));
  assert.deepEqual(result.current.selection.selected, new Set(['clear-pack']));
  assert.equal(result.current.selection.canOpenSelected, true);
  assert.equal(result.current.selection.canViewSelected, true);
  assert.equal(result.current.selection.canShipSelected, false);
  act(() => result.current.selection.toggleSelected('clear-card'));
  assert.deepEqual(result.current.selection.selected, new Set(['clear-card']));
  assert.equal(result.current.selection.canOpenSelected, false);
  assert.equal(result.current.selection.canViewSelected, true);
  assert.equal(result.current.selection.canShipSelected, true);
});

test('selection previews retain distinct artwork and resize between five and three thumbnails', () => {
  const items: InventoryItem[] = Array.from({ length: 7 }, (_, index) => ({
    id: `card-${index}`, dropId: 'card_nft_2', name: `Card ${index}`, kind: 'dude',
    image: `https://images.example/${index < 5 ? 'shared' : index}.webp`,
  }));
  const { result } = renderHook(useInventoryHarness, { initialProps: { options: sourceOptions({ inventory: items }) } });
  act(() => result.current.state.replaceSelection(items.map((item) => item.id)));
  assert.equal(result.current.selection.selectedPreview.length, 5);
  assert.equal(result.current.selection.selectedOverflow, 2);
  assert.deepEqual(result.current.selection.selectedPreview.slice(-2).map(({ item }) => item.id), ['card-5', 'card-6']);
  act(() => setMediaQueryMatches('(max-width: 720px)', true));
  assert.equal(result.current.selection.selectedPreview.length, 3);
  assert.equal(result.current.selection.selectedOverflow, 4);
  assert.deepEqual(result.current.selection.selectedPreview.map(({ item }) => item.id), ['card-2', 'card-5', 'card-6']);
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
