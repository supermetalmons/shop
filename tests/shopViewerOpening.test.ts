import assert from 'node:assert/strict';
import test, { after, afterEach, mock, type TestContext } from 'node:test';
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
  { viewerMode: 'poncho-card', dropId: 'card_nft_2' },
  { viewerMode: 'poncho-card', dropId: 'mi_note_cards' },
  { viewerMode: 'poncho-card', dropId: 'mi_note_cards_devnet' },
  { viewerMode: 'clear-card', dropId: 'clear_cards' },
  { viewerMode: 'clear-pack', dropId: 'clear_cards' },
] as const;

function openCardViewer(
  controller: ShopRevealController,
  viewer: { viewerMode: typeof cardViewers[number]['viewerMode']; dropId: string },
  figureId = 1,
  originRect?: DOMRect,
  sourceElement?: HTMLElement,
) {
  const input = {
    overlayId: 'asset-a', dropId: viewer.dropId, name: 'Asset A', image: 'https://example.com/card.webp',
    figureId, originRect, sourceElement, clearSelection: true,
  };
  return viewer.viewerMode === 'poncho-card'
    ? controller.openInteractiveCardViewer(input)
    : controller.openClearCardModelViewer({ ...input, viewerMode: viewer.viewerMode });
}

function checkViewerDismissal(
  t: TestContext,
  open: (controller: ShopRevealController, origin: DOMRect, sourceElement: HTMLElement) => void,
  changeBeforeDismiss?: 'resize' | 'source-removed',
) {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const requestFrame = (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  const cancelFrame = (id: number) => { frames.delete(id); };
  t.mock.method(globalThis, 'requestAnimationFrame', requestFrame);
  t.mock.method(globalThis, 'cancelAnimationFrame', cancelFrame);
  t.mock.method(window, 'requestAnimationFrame', requestFrame);
  t.mock.method(window, 'cancelAnimationFrame', cancelFrame);
  const flushFrame = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  const { options } = fixture();
  const inventory: InventoryItem[] = [{ id: 'source', dropId: 'clear_cards', kind: 'dude', name: 'Source card', dudeId: 1 }];
  options.inventory = inventory;
  const { result, rerender } = renderHook(useShopReveal, { initialProps: options });
  const origin = new DOMRect(10, 20, 120, 160);
  const sourceElement = document.createElement('article');
  sourceElement.dataset.inventoryId = 'asset-a';
  sourceElement.getBoundingClientRect = () => origin;
  document.body.append(sourceElement);
  t.after(() => sourceElement.remove());
  act(() => open(result.current, origin, sourceElement));
  assert.equal(sourceElement.style.visibility, 'hidden');
  act(flushFrame);
  act(flushFrame);
  assert.equal(result.current.revealOverlayActive, true);
  const overlay = result.current.revealOverlay!;
  const style = result.current.presentation.revealOverlayStyle;
  assert.notDeepEqual(overlay.originRect, overlay.targetRect);
  assert.ok(Math.abs(overlay.originRect.left + overlay.originRect.width / 2 - (origin.left + origin.width / 2)) < 0.000001);
  assert.ok(Math.abs(overlay.originRect.top + overlay.originRect.height / 2 - (origin.top + origin.height / 2)) < 0.000001);
  rerender({ ...options, inventory: [] });

  const frame = document.createElement('div');
  const child = document.createElement('div');
  frame.append(child);
  const endTransition = (target: HTMLElement, propertyName: string) => act(() => {
    result.current.handleRevealOverlayTransitionEnd({
      target,
      currentTarget: frame,
      propertyName,
    } as Parameters<ShopRevealController['handleRevealOverlayTransitionEnd']>[0]);
  });
  endTransition(frame, 'opacity');
  assert.equal(result.current.revealOverlay, overlay);
  const initialWidth = window.innerWidth;
  t.after(() => { window.innerWidth = initialWidth; });
  act(() => {
    if (changeBeforeDismiss === 'resize') {
      window.innerWidth += 120;
      window.dispatchEvent(new window.Event('resize'));
    }
    if (changeBeforeDismiss === 'source-removed') sourceElement.remove();
    result.current.handleRevealOverlayDismiss();
  });
  const closingStyle = changeBeforeDismiss ? {
    ...style,
    '--reveal-close-transform': 'none',
    '--reveal-close-opacity': '0',
    '--reveal-close-transition': 'transform 220ms ease, opacity 220ms ease',
  } : style;
  const closingVisibility = changeBeforeDismiss ? '' : 'hidden';
  const completionProperty = changeBeforeDismiss ? 'opacity' : 'transform';
  const ignoredProperty = changeBeforeDismiss ? 'transform' : 'opacity';
  assert.equal(result.current.revealOverlayClosing, true);
  assert.equal(sourceElement.style.visibility, closingVisibility);
  assert.equal(result.current.revealOverlay, overlay);
  assert.deepEqual(result.current.presentation.revealOverlayStyle, closingStyle);
  assert.equal(result.current.inventoryView, inventory);

  if (changeBeforeDismiss) {
    window.innerWidth = initialWidth;
    if (!sourceElement.isConnected) document.body.append(sourceElement);
    rerender({ ...options, inventory: [] });
    assert.equal(sourceElement.style.visibility, closingVisibility);
    assert.deepEqual(result.current.presentation.revealOverlayStyle, closingStyle);
  }

  for (const [target, propertyName] of [[child, completionProperty], [frame, ignoredProperty]] as const) {
    endTransition(target, propertyName);
    assert.equal(result.current.revealOverlay, overlay);
    assert.equal(result.current.revealOverlayClosing, true);
    assert.deepEqual(result.current.presentation.revealOverlayStyle, closingStyle);
    assert.equal(result.current.inventoryView, inventory);
    assert.equal(sourceElement.style.visibility, closingVisibility);
  }
  endTransition(frame, completionProperty);
  assert.equal(result.current.revealOverlay, null);
  assert.equal(result.current.revealOverlayClosing, false);
  assert.equal(result.current.revealOverlayActive, false);
  assert.deepEqual(result.current.inventoryView, []);
  assert.equal(sourceElement.style.visibility, '');
}

test('a card fades in place when resized immediately before dismissal', (t) => {
  checkViewerDismissal(t, (controller, origin, sourceElement) => {
    assert.equal(openCardViewer(controller, cardViewers[0], 1, origin, sourceElement), true);
  }, 'resize');
});

for (const viewer of cardViewers) {
  test(`${viewer.dropId} ${viewer.viewerMode} keeps its source geometry until the frame finishes closing`, (t) => {
    checkViewerDismissal(t, (controller) => {
      controller.viewItem({
        id: 'asset-a', dropId: viewer.dropId, name: 'Asset A',
        kind: viewer.viewerMode === 'clear-pack' ? 'box' : 'dude', dudeId: 1,
      });
      assert.equal(controller.getCurrentOverlay()?.viewerMode, viewer.viewerMode);
    });
  });

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
    assert.equal(openCardViewer(result.current, { viewerMode: 'clear-card', dropId: 'clear_cards' }, 193), false);
    assert.equal(openCardViewer(result.current, { viewerMode: 'poncho-card', dropId: 'mi_note_cards' }, 1431), false);
    assert.equal(openCardViewer(result.current, { viewerMode: 'clear-card', dropId: 'poncho_drifella' }), false);
    assert.equal(openCardViewer(result.current, { viewerMode: 'poncho-card', dropId: 'clear_cards' }), false);
  });
  assert.equal(result.current.revealOverlay, null);
  assert.equal(calls.cleared, 0);
  assert.deepEqual(calls.toasts, []);
});

for (const dropId of ['mi_note_cards', 'mi_note_cards_devnet']) {
  test(`${dropId} pack preview keeps its source geometry until the frame finishes closing`, (t) => {
    checkViewerDismissal(t, (controller) => {
      controller.viewItem({ id: 'asset-a', dropId, name: 'Pack 704', kind: 'box', boxId: '704' });
    });
  });

  test(`${dropId} updates an unresolved pack preview when inventory learns its ID`, () => {
    const { options } = fixture();
    const pack: InventoryItem = { id: 'pack', dropId, name: 'Pack', kind: 'box' };
    const { result, rerender } = renderHook(useShopReveal, { initialProps: { ...options, inventory: [pack] } });
    act(() => result.current.viewItem(pack));
    assert.equal(result.current.revealOverlay?.packMediaId, undefined);
    assert.equal(result.current.revealOverlay?.image, 'https://cdn.lil.org/nft/mi_note_cards/packs/clean/placeholder.webp');
    rerender({ ...options, inventory: [{ ...pack, boxId: '9', name: 'Pack 9' }] });
    assert.equal(result.current.revealOverlay?.packMediaId, 9);
    assert.equal(result.current.revealOverlay?.image, 'https://cdn.lil.org/nft/mi_note_cards/packs/clean/9.webp');
    assert.equal(result.current.revealOverlay?.name, 'Pack 9');
  });

  test(`${dropId} inventory View opens the assigned CSS card and the matching sealed pack without commerce actions`, () => {
    const { options, calls } = fixture();
    const card: InventoryItem = { id: 'card', dropId, name: 'Card 1430', kind: 'dude', dudeId: 1430 };
    const pack: InventoryItem = { id: 'pack', dropId, name: 'Pack 704', kind: 'box', boxId: '704' };
    const { result } = renderHook(useShopReveal, { initialProps: options });
    act(() => result.current.viewItem(card));
    assert.equal(result.current.revealOverlay?.viewerMode, 'poncho-card');
    assert.equal(result.current.presentation.interactiveViewerCard?.imageSrc, 'https://cdn.lil.org/nft/mi_note_cards/fronts/1430.webp');
    assert.equal(result.current.presentation.interactiveViewerCard?.effect.source, 'mi_note_cards');
    act(() => result.current.discardRevealOverlay());
    act(() => result.current.viewItem(pack));
    assert.equal(result.current.revealOverlay?.viewerMode, 'mi-note-pack');
    assert.equal(result.current.revealOverlay?.packMediaId, 2);
    assert.equal(result.current.revealOverlay?.revealedIds, undefined);
    assert.equal(result.current.presentation.revealOverlayCanRenderMiNotePack3d, true);
    assert.equal(result.current.presentation.revealOverlayCanRenderClearCard3d, false);
    assert.equal(result.current.revealOverlay?.image, 'https://cdn.lil.org/nft/mi_note_cards/packs/clean/2.webp');
    assert.equal(calls.cleared, 2);
  });
}

const receipt: InventoryItem = {
  id: 'receipt-a', dropId: 'clear_cards', kind: 'certificate', name: 'Receipt A', image: 'https://example.com/receipt.webp',
};

test('an image fades in place when resized immediately before dismissal', (t) => {
  checkViewerDismissal(t, (controller, origin, sourceElement) => {
    assert.equal(controller.openImageViewer(receipt, origin, { sourceElement }), true);
  }, 'resize');
});

for (const size of ['receipt', 'shipment', 'shipment-figure', 'preorder'] as const) {
  test(`${size} image preview keeps its source geometry until the frame finishes closing`, (t) => {
    checkViewerDismissal(t, (controller, origin, sourceElement) => {
      assert.equal(controller.openImageViewer(receipt, origin, { size, sourceElement }), true);
    });
  });
}

test('receipt viewing keeps its grid source hidden until dismissal finishes', (t) => {
  checkViewerDismissal(t, (controller, origin, sourceElement) => {
    sourceElement.dataset.inventoryId = receipt.id;
    assert.equal(controller.openReceiptImageViewer(receipt, origin), true);
  });
});

test('a receipt fades in place when its source is removed before dismissal', (t) => {
  checkViewerDismissal(t, (controller, origin, sourceElement) => {
    sourceElement.dataset.inventoryId = receipt.id;
    assert.equal(controller.openReceiptImageViewer(receipt, origin), true);
  }, 'source-removed');
});

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
