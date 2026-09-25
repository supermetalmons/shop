import assert from 'node:assert/strict';
import test, { after, afterEach, mock } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveDropContent } from '../src/lib/dropContent.ts';
import type { InventoryItem } from '../src/types.ts';
import type { ShopRevealOptions } from '../src/shop/reveal/contracts.ts';

const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'DOMRect', { configurable: true, value: dom.window.DOMRect });
const { act, cleanup, fireEvent, render, renderHook, waitFor } = await import('@testing-library/react');
const { useShopReveal } = await import('../src/shop/reveal/useShopReveal.ts');
const { ReceiptImageViewerOverlay } = await import('../src/shop/reveal/ReceiptImageViewerOverlay.tsx');
const { soundPlayer } = await import('../src/lib/SoundPlayer.ts');
mock.method(soundPlayer, 'initializeOnUserInteraction', async () => {});

afterEach(() => { cleanup(); document.body.replaceChildren(); });
after(() => { mock.restoreAll(); dom.window.close(); });

const item: InventoryItem = {
  id: 'preorder-1', dropId: 'mi_note_cards_devnet', kind: 'preorder', preorderId: 1,
  name: 'Preorder #1', image: 'https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1.webp',
};

function fixture(inventoryItem = item) {
  const calls = { cleared: 0, toasts: [] as string[] };
  const forbidden = () => { throw new Error('Image viewing must not invoke commerce actions'); };
  const options: ShopRevealOptions = {
    connectedWallet: undefined, publicKey: null, owner: undefined, localAccountWallet: undefined,
    isViewerMode: false, suspended: false, walletModalVisible: false, receiptTransferOpen: false,
    routeDrop: null, inventory: [inventoryItem], pendingOpenBoxes: [], figureMetadataByKey: {},
    getDropConfig: () => undefined, getDropContent: resolveDropContent,
    requireKnownDropConfig: forbidden, getDropConnection: forbidden,
    boxLabelForDropId: () => 'pack', figureLabelForDropId: () => 'card',
    figureReferenceForDropId: () => 'card', openGerundForDropId: () => 'Opening', canOpenBoxesForDropId: () => false,
    addLocalPendingReveal: forbidden, removeLocalPendingReveal: forbidden, rememberRecentReveal: forbidden,
    addLocalRevealedDudes: forbidden, markAssetsHidden: forbidden, refetchInventory: forbidden,
    refetchPendingOpenBoxes: forbidden, ensureSignedIn: forbidden, openWalletModal: forbidden,
    blockViewerModeAction: forbidden, sendAndConfirmViaConnection: forbidden, retryAfterBlockhashExpiry: forbidden,
    clearSelection: () => { calls.cleared += 1; }, showToast: (message) => calls.toasts.push(message),
  };
  return { options, calls };
}

for (const [width, height] of [[1082, 1600], [1600, 900]]) {
  test(`preorder viewing fits ${width}×${height} artwork and clears selection only after opening`, async () => {
    const tile = document.createElement('article');
    tile.dataset.inventoryId = item.id;
    tile.innerHTML = `<div class="inventory__media"><img class="inventory__image" src="${item.image}" /></div>`;
    const image = tile.querySelector('img')!;
    Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
    image.getBoundingClientRect = () => new DOMRect(20, 30, 180, 180);
    document.body.append(tile);
    const { options, calls } = fixture();
    const { result } = renderHook(() => useShopReveal(options));
    act(() => result.current.viewItem(item));
    const overlay = result.current.revealOverlay!;
    assert.equal(overlay.viewerMode, 'receipt-image');
    assert.equal(overlay.imageViewerSize, 'preorder');
    assert.equal(overlay.image, item.image);
    assert.equal(overlay.adminIrlRedeemReceipt, undefined);
    assert.equal(overlay.receiptImages, undefined);
    assert.ok(Math.abs(overlay.targetRect.width / overlay.targetRect.height - width / height) < 0.01);
    assert.equal(calls.cleared, 1);
    act(() => result.current.viewItem(item));
    assert.equal(calls.cleared, 1);
    act(() => result.current.handleRevealOverlayDismiss());
    await waitFor(() => assert.equal(result.current.revealOverlay, null));
    assert.deepEqual(calls.toasts, []);
  });
}

test('preorder viewing without a loaded inventory image uses the existing fallback viewer sizing', () => {
  const { options, calls } = fixture();
  const { result } = renderHook(() => useShopReveal(options));
  act(() => result.current.viewItem(item));
  assert.equal(result.current.revealOverlay?.image, item.image);
  assert.equal(result.current.revealOverlay?.imageViewerSize, 'preorder');
  assert.equal(calls.cleared, 1);
});

test('a missing preorder image keeps the selection and shows the existing unavailable message', () => {
  const missing = { ...item, image: undefined };
  const { options, calls } = fixture(missing);
  const { result } = renderHook(() => useShopReveal(options));
  act(() => result.current.viewItem(missing));
  assert.equal(result.current.revealOverlay, null);
  assert.equal(calls.cleared, 0);
  assert.deepEqual(calls.toasts, ['Preorder image unavailable']);
});

test('the preorder image overlay retains failure fallback and click dismissal without receipt controls', () => {
  let dismissed = 0;
  const view = render(createElement(ReceiptImageViewerOverlay, {
    dropId: item.dropId, active: true, closing: false, imageSrc: item.image, alt: item.name,
    viewerSize: 'preorder', onDismiss: () => { dismissed += 1; },
  }));
  const image = view.getByRole('img', { name: item.name });
  assert.ok(view.getByRole('dialog').classList.contains('receipt-viewer-overlay--preorder'));
  fireEvent.error(image);
  assert.equal(image.hidden, true);
  assert.equal(view.container.querySelector<HTMLElement>('.receipt-viewer-overlay__image--placeholder')?.hidden, false);
  assert.equal(view.queryByRole('button'), null);
  assert.equal(view.queryByRole('link'), null);
  fireEvent.click(view.getByRole('dialog'));
  assert.equal(dismissed, 1);
});
