import assert from 'node:assert/strict';
import test, { after, afterEach, mock } from 'node:test';
import { getFrontendDrop } from '../src/config/deployment.ts';
import { resolveDropContent } from '../src/lib/dropContent.ts';
import type { ShopRevealOptions } from '../src/shop/reveal/contracts.ts';
import type { ShopRevealController } from '../src/shop/reveal/useShopReveal.ts';
import type { InventoryItem } from '../src/types.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'DOMRect', { configurable: true, value: dom.window.DOMRect });
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useShopReveal } = await import('../src/shop/reveal/useShopReveal.ts');
const { soundPlayer } = await import('../src/lib/SoundPlayer.ts');
mock.method(soundPlayer, 'initializeOnUserInteraction', async () => {});

afterEach(() => cleanup());
after(() => { mock.restoreAll(); dom.window.close(); });

function fixture() {
  const calls = { cleared: 0, toasts: [] as string[] };
  const forbidden = () => { throw new Error('Viewing must not invoke commerce actions'); };
  const options: ShopRevealOptions = {
    connectedWallet: undefined, publicKey: null, owner: undefined, localAccountWallet: undefined,
    isViewerMode: false, suspended: false, walletModalVisible: false, receiptTransferOpen: false,
    routeDrop: null, inventory: [], pendingOpenBoxes: [], figureMetadataByKey: {},
    getDropConfig: getFrontendDrop, getDropContent: resolveDropContent,
    requireKnownDropConfig: (dropId) => {
      const drop = getFrontendDrop(dropId);
      assert.ok(drop);
      return drop;
    },
    getDropConnection: forbidden,
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

const cardViewers = [
  { viewerMode: 'poncho-card', dropId: 'poncho_drifella' },
  { viewerMode: 'clear-card', dropId: 'clear_cards' },
  { viewerMode: 'clear-pack', dropId: 'clear_cards' },
] as const;

function openCardViewer(
  controller: ShopRevealController,
  viewer: { viewerMode: typeof cardViewers[number]['viewerMode']; dropId: string },
  figureId = 1,
  originRect?: DOMRect,
) {
  const input = {
    overlayId: 'asset-a', dropId: viewer.dropId, name: 'Asset A', image: 'https://example.com/card.webp',
    figureId, originRect, clearSelection: true,
  };
  return viewer.viewerMode === 'poncho-card'
    ? controller.openInteractiveCardViewer(input)
    : controller.openClearCardModelViewer({ ...input, viewerMode: viewer.viewerMode });
}

for (const viewer of cardViewers) {
  test(`${viewer.viewerMode} keeps its payload, default origin, and selection behavior`, () => {
    const { options, calls } = fixture();
    const { result } = renderHook(useShopReveal, { initialProps: options });
    act(() => assert.equal(openCardViewer(result.current, viewer), true));
    const overlay = result.current.revealOverlay!;
    assert.equal(overlay.viewerMode, viewer.viewerMode);
    assert.equal(overlay.viewerFigureId, viewer.viewerMode === 'clear-pack' ? undefined : 1);
    assert.deepEqual(overlay.revealedIds, viewer.viewerMode === 'clear-card' ? [1] : undefined);
    assert.deepEqual(overlay.originRect, overlay.targetRect);
    assert.ok(overlay.targetRect.width > 0 && overlay.targetRect.height > 0);
    assert.equal(overlay.phase, 'revealed');
    assert.equal(overlay.frame, 1);
    assert.equal(overlay.advanceClicks, 0);
    assert.equal(overlay.hasRevealAttempted, true);
    assert.equal(overlay.autoOpening, false);
    assert.equal(overlay.autoMode, undefined);
    assert.equal(overlay.packMediaId, undefined);
    assert.equal(overlay.interactiveRevealCardId, undefined);
    assert.equal(calls.cleared, 1);
    act(() => assert.equal(openCardViewer(result.current, viewer), false));
    assert.equal(result.current.revealOverlay, overlay);
    assert.equal(calls.cleared, 1);
    assert.deepEqual(calls.toasts, []);
  });

  test(`${viewer.viewerMode} retains selection while suspended and opens after resuming`, () => {
    const { options, calls } = fixture();
    const { result, rerender } = renderHook(useShopReveal, { initialProps: { ...options, suspended: true } });
    const origin = new DOMRect(10, 20, 120, 160);
    act(() => assert.equal(openCardViewer(result.current, viewer, 1, origin), false));
    assert.equal(result.current.revealOverlay, null);
    assert.equal(calls.cleared, 0);
    rerender(options);
    act(() => assert.equal(openCardViewer(result.current, viewer, 1, origin), true));
    const overlay = result.current.revealOverlay!;
    assert.ok(Math.abs(overlay.originRect.left + overlay.originRect.width / 2 - (origin.left + origin.width / 2)) < 0.000001);
    assert.ok(Math.abs(overlay.originRect.top + overlay.originRect.height / 2 - (origin.top + origin.height / 2)) < 0.000001);
    assert.equal(calls.cleared, 1);
    assert.deepEqual(calls.toasts, []);
  });
}

test('invalid card identities and mismatched renderers leave selection and presentation unchanged', () => {
  const { options, calls } = fixture();
  const { result } = renderHook(useShopReveal, { initialProps: options });
  act(() => {
    assert.equal(openCardViewer(result.current, cardViewers[0], 0), false);
    assert.equal(openCardViewer(result.current, cardViewers[1], 193), false);
    assert.equal(openCardViewer(result.current, { viewerMode: 'clear-card', dropId: 'poncho_drifella' }), false);
    assert.equal(openCardViewer(result.current, { viewerMode: 'poncho-card', dropId: 'clear_cards' }), false);
  });
  assert.equal(result.current.revealOverlay, null);
  assert.equal(calls.cleared, 0);
  assert.deepEqual(calls.toasts, []);
});

const receipt: InventoryItem = {
  id: 'receipt-a', dropId: 'clear_cards', kind: 'certificate', name: 'Receipt A', image: 'https://example.com/receipt.webp',
};

test('grouped receipts preserve placeholders, empty snapshots, and admin action eligibility', () => {
  const { options, calls } = fixture();
  options.inventory = [receipt];
  const { result } = renderHook(useShopReveal, { initialProps: options });
  const secondReceipt = { ...receipt, id: 'receipt-b', name: 'Receipt B', image: undefined };
  const origin = new DOMRect(10, 20, 120, 160);
  act(() => {
    assert.equal(result.current.openReceiptImageViewerGroup([receipt, secondReceipt], origin), false);
  });
  assert.equal(result.current.revealOverlay, null);
  assert.deepEqual(calls.toasts, ['Receipt image unavailable']);
  act(() => {
    assert.equal(result.current.openReceiptImageViewerGroup([receipt, secondReceipt], origin, {
      allowPlaceholders: true, inventorySnapshot: [], adminIrlRedeemReceipt: receipt,
    }), true);
  });
  const overlay = result.current.revealOverlay!;
  assert.equal(overlay.viewerMode, 'receipt-image');
  assert.equal(overlay.imageViewerSize, 'receipt');
  assert.deepEqual(overlay.receiptImages, [
    { key: receipt.id, name: receipt.name, image: receipt.image },
    { key: secondReceipt.id, name: secondReceipt.name, image: undefined },
  ]);
  assert.equal(overlay.adminIrlRedeemReceipt, undefined);
  assert.ok(Math.abs(overlay.targetRect.width / overlay.targetRect.height - 1.5) < 0.01);
  assert.deepEqual(result.current.inventoryView, []);
  assert.equal(calls.cleared, 0);
});

test('single receipt viewing keeps its admin action and default image size', () => {
  const { options, calls } = fixture();
  const { result } = renderHook(useShopReveal, { initialProps: options });
  act(() => assert.equal(result.current.openReceiptImageViewer(receipt), true));
  const overlay = result.current.revealOverlay!;
  assert.equal(overlay.id, receipt.id);
  assert.equal(overlay.imageViewerSize, 'receipt');
  assert.equal(overlay.adminIrlRedeemReceipt, receipt);
  assert.deepEqual(overlay.receiptImages, [{ key: receipt.id, name: receipt.name, image: receipt.image }]);
  assert.equal(calls.cleared, 0);
});
