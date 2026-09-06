import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { getFrontendDrop } from '../src/config/deployment.ts';
import { resolveDropContent } from '../src/lib/dropContent.ts';

const { dom } = setupFrontendDom();
const { cleanup, fireEvent, render } = await import('@testing-library/react');
const { ShopHeaderActions } = await import('../src/shop/ui/ShopHeaderActions.tsx');
const { ShopShipmentsSection } = await import('../src/shop/ui/ShopShipmentsSection.tsx');

afterEach(cleanup);
after(() => dom.window.close());

test('only the interactive header copy can sign in or expose the admin menu', () => {
  let signIns = 0;
  const props: Parameters<typeof ShopHeaderActions>[0] = {
    interactive: false,
    showHeaderWalletButton: true,
    connectedWallet: undefined,
    handleHeaderWalletSignIn: async () => { signIns += 1; },
    canUseAdminMenu: true,
    canUseAdminViewer: false,
    settingsRef: { current: null },
    settingsOpen: true,
    setSettingsOpen: () => undefined,
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
  const passiveWallet = view.getByRole('button', { name: 'Connect Wallet' });
  fireEvent.click(passiveWallet);
  assert.equal(signIns, 0);
  assert.equal(passiveWallet.tabIndex, -1);
  assert.equal(view.queryByRole('menu'), null);
  assert.equal(view.getAllByRole('button').every((button) => button.tabIndex === -1), true);

  view.rerender(createElement(ShopHeaderActions, { ...props, interactive: true }));
  const activeWallet = view.getByRole('button', { name: 'Connect wallet and sign in with Solana' });
  fireEvent.click(activeWallet);
  assert.equal(signIns, 1);
  assert.equal(activeWallet.tabIndex, 0);
  assert.ok(view.getByRole('menu', { name: 'App menu' }));
});

test('shipment rows preserve retained-data warnings and keyboard image viewing', () => {
  const drop = getFrontendDrop('little_swag_boxes')!;
  const opened: Array<Parameters<Parameters<typeof ShopShipmentsSection>[0]['openImageViewer']>> = [];
  const props: Parameters<typeof ShopShipmentsSection>[0] = {
    openClearCardModelViewer: () => undefined,
    openImageViewer: (...args) => { opened.push(args); },
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
    mergeLoadedFigureMetadata: () => undefined,
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

  view.rerender(createElement(ShopShipmentsSection, { ...props, shipmentsSectionReady: false, shipmentsEmptyContent: 'Loading shipments…' }));
  assert.equal(view.queryByRole('button', { name: /^View / }), null);
  const hiddenPlaceholder = view.container.querySelector('.empty-state--hidden');
  assert.equal(hiddenPlaceholder?.getAttribute('aria-hidden'), 'true');
  assert.equal(hiddenPlaceholder?.textContent, 'Loading shipments…');
});
