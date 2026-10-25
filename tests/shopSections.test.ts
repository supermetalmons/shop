import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { createElement, useRef, useState } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { getFrontendDrop } from '../src/config/deployment.ts';
import { resolveDropContent } from '../src/lib/dropContent.ts';
import { figureMetadataCacheKey, loadFigureMetadata, type FigureMetadataRecord } from '../src/lib/figureMetadata.ts';

const { dom } = setupFrontendDom();
const { cleanup, fireEvent, render } = await import('@testing-library/react');
const { ShopHeaderActions } = await import('../src/shop/ui/ShopHeaderActions.tsx');
const { ShopShipmentsSection } = await import('../src/shop/ui/ShopShipmentsSection.tsx');
const { ShopShipmentsEmptyState } = await import('../src/shop/ui/ShopShipmentsEmptyState.tsx');
const { ModalFocusScope } = await import('../src/components/ModalFocusScope.tsx');

afterEach(cleanup);
after(() => dom.window.close());

test('only the interactive header copy can sign in or expose the admin menu', () => {
  let signIns = 0;
  let walletCloses = 0;
  let menuOpen = true;
  const props: Parameters<typeof ShopHeaderActions>[0] = {
    interactive: false,
    walletControl: {
      address: undefined,
      open: false,
      buttonDisabled: false,
      disconnectDisabled: false,
      disconnecting: false,
      disconnectError: null,
      balanceLamports: undefined,
      balanceLoading: false,
      balanceError: false,
      activate: async () => { signIns += 1; },
      close: () => { walletCloses += 1; },
      disconnect: async () => undefined,
      retryBalance: () => undefined,
    },
    canUseAdminMenu: true,
    mainnetOnlyStaff: false,
    canUseAdminViewer: false,
    settingsRef: { current: null },
    settingsOpen: true,
    setSettingsOpen: (next) => { menuOpen = typeof next === 'function' ? next(menuOpen) : next; },
    ownerPickerOpened: false,
    setOwnerPickerOpened: () => undefined,
    authenticatedWallet: 'admin-wallet',
    adminViewedOwner: null,
    setAdminViewedOwner: () => undefined,
    deliveryOrderOwners: [],
    wipPickerOpened: false,
    setWipPickerOpened: () => undefined,
    devnetDropsPickerOpened: false,
    setDevnetDropsPickerOpened: () => undefined,
    deliveryOrderOwnersLoadingMore: false,
    fetchNextDeliveryOrderOwners: async () => ({} as Awaited<ReturnType<Parameters<typeof ShopHeaderActions>[0]['fetchNextDeliveryOrderOwners']>>),
    deliveryOrderOwnersHasNextPage: false,
    deliveryOrderOwnersError: null,
    owner: 'admin-wallet',
    adminMenuDevnetDrops: [],
  };
  const view = render(createElement(ShopHeaderActions, props));
  const passiveWallet = view.container.querySelector<HTMLButtonElement>('.top__wallet-button')!;
  fireEvent.click(passiveWallet);
  assert.equal(signIns, 0);
  assert.equal(passiveWallet.tabIndex, -1);
  assert.equal(view.queryByRole('menu'), null);
  assert.equal(view.getAllByRole('button').every((button) => button.tabIndex === -1), true);

  view.rerender(createElement(ShopHeaderActions, { ...props, interactive: true }));
  const activeWallet = view.getByRole('button', { name: 'Wallet' });
  fireEvent.click(activeWallet);
  assert.equal(signIns, 1);
  assert.equal(activeWallet.tabIndex, 0);
  assert.ok(view.getByRole('menu', { name: 'App menu' }));
  const dashboard = view.getByRole('button', { name: 'App menu' });
  assert.ok(dashboard.compareDocumentPosition(activeWallet) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  fireEvent.click(dashboard);
  assert.equal(walletCloses, 1);
  menuOpen = true;
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(menuOpen, false);
  assert.ok(document.activeElement === dashboard);

  const expandedProps = {
    ...props,
    interactive: true,
    canUseAdminViewer: true,
    wipPickerOpened: true,
    devnetDropsPickerOpened: true,
    adminMenuDevnetDrops: [getFrontendDrop('card_nft_binder_devnet')!],
  };
  view.rerender(createElement(ShopHeaderActions, expandedProps));
  assert.ok(view.getByRole('button', { name: '111K testnet' }));
  assert.ok(view.getByRole('button', { name: 'mi_note_cards_devnet/wip' }));
  assert.ok(view.getByRole('button', { name: 'card_nft_binder_devnet' }));

  view.rerender(createElement(ShopHeaderActions, {
    ...expandedProps,
    mainnetOnlyStaff: true,
    authenticatedWallet: 'ETaETZU82ZFnaz3j3TKAxRRzbQvt1Bn5tnF9EGMZe5zy',
  }));
  assert.equal(view.queryByRole('button', { name: '111K testnet' }), null);
  assert.equal(view.queryByRole('button', { name: 'mi_note_cards_devnet/wip' }), null);
  assert.equal(view.queryByRole('button', { name: 'card_nft_binder_devnet' }), null);
  assert.equal(view.queryByRole('button', { name: /devnet drops/ }), null);
  assert.ok(view.getByRole('button', { name: 'fulfillment' }));
  assert.ok(view.getByRole('button', { name: 'override address' }));
  assert.ok(view.getByRole('button', { name: 'mi_note_cards/wip' }));
});

test('an inert app menu leaves Escape and focus with the active WIP preview', () => {
  let previewEscapes = 0;
  function Harness({ previewOpen }: { previewOpen: boolean }) {
    const [settingsOpen, setSettingsOpen] = useState(true);
    const settingsRef = useRef<HTMLDivElement | null>(null);
    const props: Parameters<typeof ShopHeaderActions>[0] = {
      interactive: true,
      walletControl: {
        address: undefined, open: false, buttonDisabled: false, disconnectDisabled: false,
        disconnecting: false, disconnectError: null, balanceLamports: undefined,
        balanceLoading: false, balanceError: false,
        activate: async () => undefined, close: () => undefined,
        disconnect: async () => undefined, retryBalance: () => undefined,
      },
      canUseAdminMenu: true, mainnetOnlyStaff: false, canUseAdminViewer: false,
      settingsRef, settingsOpen, setSettingsOpen,
      ownerPickerOpened: false, setOwnerPickerOpened: () => undefined,
      authenticatedWallet: 'admin-wallet', adminViewedOwner: null,
      setAdminViewedOwner: () => undefined, deliveryOrderOwners: [],
      wipPickerOpened: true, setWipPickerOpened: () => undefined,
      devnetDropsPickerOpened: false, setDevnetDropsPickerOpened: () => undefined,
      deliveryOrderOwnersLoadingMore: false,
      fetchNextDeliveryOrderOwners: async () => ({} as Awaited<ReturnType<Parameters<typeof ShopHeaderActions>[0]['fetchNextDeliveryOrderOwners']>>),
      deliveryOrderOwnersHasNextPage: false, deliveryOrderOwnersError: null,
      owner: 'admin-wallet', adminMenuDevnetDrops: [],
    };
    return createElement('div', null,
      createElement('div', { inert: previewOpen || undefined }, createElement(ShopHeaderActions, props)),
      previewOpen ? createElement(ModalFocusScope, {
        ariaLabel: 'Card pack preview',
        onEscape: () => { previewEscapes += 1; },
        children: createElement('button', null, 'Close preview'),
      }) : null,
    );
  }
  const view = render(createElement(Harness, { previewOpen: false }));
  assert.ok(view.getByRole('menu', { name: 'App menu' }));
  view.rerender(createElement(Harness, { previewOpen: true }));
  const previewButton = view.getByRole('button', { name: 'Close preview' });
  assert.equal(document.activeElement, previewButton);
  fireEvent.keyDown(previewButton, { key: 'Escape' });
  assert.equal(previewEscapes, 1);
  assert.equal(document.activeElement, previewButton);
  assert.ok(view.getByRole('menu', { name: 'App menu' }));

  view.rerender(createElement(Harness, { previewOpen: false }));
  const dashboard = view.getByRole('button', { name: 'App menu' });
  dashboard.focus();
  fireEvent.keyDown(dashboard, { key: 'Escape' });
  assert.equal(view.queryByRole('menu'), null);
  assert.equal(document.activeElement, dashboard);
});

test('shipment rows preserve retained-data warnings and keyboard image viewing', () => {
  const drop = getFrontendDrop('little_swag_boxes')!;
  const opened: Array<Parameters<Parameters<typeof ShopShipmentsSection>[0]['openImageViewer']>> = [];
  const props: Parameters<typeof ShopShipmentsSection>[0] = {
    shipmentHistory: {
      orders: [], hasMore: false, loadingMore: false, fetching: false, error: null,
      fetchMore: async () => undefined, retry: async () => undefined,
    },
    openClearCardModelViewer: () => undefined,
    openImageViewer: (...args) => { opened.push(args); return true; },
    openInteractiveCardViewer: () => undefined,
    usesClearCard3dRevealForDropId: () => false,
    usesInteractiveCardPackRevealForDropId: () => false,
    shipmentsSectionReady: true,
    deliveryOrders: [{ dropId: drop.dropId, deliveryId: 7, status: 'processing', items: [{ kind: 'box', refId: 1 }] }],
    shipmentsRetainedError: 'Unable to refresh shipments. Showing previously loaded data.',
    dropById: new Map([[drop.dropId, drop]]),
    shipmentsEmptyStateVisibility: 'visible',
    shipmentsEmptyContent: 'No shipments yet.',
    figureMetadataByKey: {},
    getDropContent: (dropId) => resolveDropContent(getFrontendDrop(dropId || '')),
  };
  const view = render(createElement(ShopShipmentsSection, props));
  assert.match(view.getByRole('status').textContent || '', /Showing previously loaded data/);
  assert.match(view.container.textContent || '', /Date pending/);
  const tile = view.getByRole('button', { name: /^View / });
  fireEvent.keyDown(tile, { key: 'Enter' });
  fireEvent.click(tile);
  assert.equal(opened.length, 2);
  assert.equal(opened[0][0].id, `shipment:${drop.dropId}:7:box:1:0`);
  assert.equal(opened[0][0].dropId, drop.dropId);
  assert.equal(opened[0][2]?.size, 'shipment');
  assert.equal(opened[0][2]?.unavailableMessage, 'Shipment image unavailable');
  for (const args of opened) assert.equal(args[2]?.sourceElement, tile);

  view.rerender(createElement(ShopShipmentsSection, { ...props, shipmentsSectionReady: false, shipmentsEmptyContent: 'Loading shipments…' }));
  assert.equal(view.queryByRole('button', { name: /^View / }), null);
  const hiddenPlaceholder = view.container.querySelector('.empty-state--hidden');
  assert.equal(hiddenPlaceholder?.getAttribute('aria-hidden'), 'true');
  assert.equal(hiddenPlaceholder?.textContent, 'Loading shipments…');
});

for (const dropId of ['mi_note_cards', 'mi_note_cards_devnet']) {
  test(`${dropId} shipment cards open the interactive viewer while packs keep image previews`, async () => {
    const drop = getFrontendDrop(dropId)!;
    const record = await loadFigureMetadata(dropId, 1430);
    assert.ok(record);
    const figureMetadataByKey: Record<string, FigureMetadataRecord> = {
      [figureMetadataCacheKey(dropId, 1430)]: record,
    };
    const opened: Array<Parameters<Parameters<typeof ShopShipmentsSection>[0]['openImageViewer']>> = [];
    const cards: Array<Parameters<Parameters<typeof ShopShipmentsSection>[0]['openInteractiveCardViewer']>[0]> = [];
    const view = render(createElement(ShopShipmentsSection, {
      shipmentHistory: {
        orders: [], hasMore: false, loadingMore: false, fetching: false, error: null,
        fetchMore: async () => undefined, retry: async () => undefined,
      },
      openClearCardModelViewer: () => undefined,
      openImageViewer: (...args) => { opened.push(args); return true; },
      openInteractiveCardViewer: input => { cards.push(input); return true; },
      usesClearCard3dRevealForDropId: () => false,
      usesInteractiveCardPackRevealForDropId: () => false,
      shipmentsSectionReady: true,
      deliveryOrders: [{ dropId, deliveryId: 7, status: 'processing', items: [
        { kind: 'box', refId: 704 }, { kind: 'dude', refId: 1430 },
      ] }],
      shipmentsRetainedError: null,
      dropById: new Map([[dropId, drop]]),
      shipmentsEmptyStateVisibility: 'visible',
      shipmentsEmptyContent: 'No shipments yet.',
      figureMetadataByKey,
      getDropContent: id => resolveDropContent(id),
    }));
    const expectedImages = [
      'https://cdn.lil.org/nft/mi_note_cards/packs/clean/2.webp',
      'https://cdn.lil.org/nft/mi_note_cards/clean/1430.webp',
    ];
    assert.deepEqual(view.getAllByRole('img').map(image => image.getAttribute('src')), expectedImages);
    const tiles = view.getAllByRole('button', { name: /^View / });
    fireEvent.click(tiles[0]);
    fireEvent.click(tiles[1]);
    fireEvent.keyDown(tiles[1], { key: 'Enter' });
    fireEvent.keyDown(tiles[1], { key: ' ' });
    assert.deepEqual(opened.map(args => args[0].image), [expectedImages[0]]);
    assert.equal(opened[0][2]?.sourceElement, tiles[0]);
    assert.equal(cards.length, 3);
    for (const card of cards) {
      assert.equal(card.dropId, dropId);
      assert.equal(card.figureId, 1430);
      assert.equal(card.overlayId, `shipment:${dropId}:7:dude:1430:1`);
      assert.equal(card.image, expectedImages[1]);
      assert.equal(card.sourceElement, tiles[1]);
    }
  });
}

test('shipment sign-in stays disabled during authentication or any pending wallet action', () => {
  let signIns = 0;
  const props: Parameters<typeof ShopShipmentsEmptyState>[0] = {
    isOwnProfileView: false,
    ownShipmentsEmptyState: 'empty',
    isViewerMode: false,
    viewedProfileError: null,
    profileLoadingForView: false,
    anonymousStripeHistoryVisible: false,
    anonymousStripeHistoryInitialLoading: false,
    anonymousStripeHistoryError: null,
    anonymousStripeHistoryWaitingForFulfillment: false,
    authLoading: false,
    pendingShipmentsSignIn: false,
    handleSignInForShipments: async () => { signIns += 1; },
  };
  const view = render(createElement(ShopShipmentsEmptyState, props));
  for (const busy of [
    { authLoading: true, pendingShipmentsSignIn: false },
    { authLoading: false, pendingShipmentsSignIn: true },
    { authLoading: true, pendingShipmentsSignIn: true },
  ]) {
    view.rerender(createElement(ShopShipmentsEmptyState, { ...props, ...busy }));
    const button = view.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
    assert.equal(button.disabled, true);
    fireEvent.click(button);
    assert.equal(signIns, 0);
  }
  view.rerender(createElement(ShopShipmentsEmptyState, props));
  const button = view.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
  assert.equal(button.disabled, false);
  fireEvent.click(button);
  assert.equal(signIns, 1);
});
