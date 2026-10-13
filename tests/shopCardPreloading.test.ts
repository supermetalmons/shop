import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { getFrontendDrop } from '../src/config/deployment.ts';
import { DRIF_GLITTER_URL, DRIF_GRAIN_URL } from '../src/drifCards.ts';
import { drifCardVisualAssetsCache } from '../src/lib/drifCardVisualAssets.ts';
import { resolveDropContent } from '../src/lib/dropContent.ts';
import { getInteractiveCardPackCardByFigureId } from '../src/lib/interactiveCardPackReveal.ts';
import type { ShopRevealOptions } from '../src/shop/reveal/contracts.ts';
import type { InventoryItem } from '../src/types.ts';
import { mockCardAssetImages } from './helpers/cardAssets.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useShopReveal } = await import('../src/shop/reveal/useShopReveal.ts');
const { useShopRevealPreloading } = await import('../src/shop/reveal/useShopRevealPreloading.ts');

afterEach(() => {
  cleanup();
  drifCardVisualAssetsCache.clear();
});
after(() => dom.window.close());

function fixture(): ShopRevealOptions {
  const forbidden = () => { throw new Error('Preparing a selected card must not invoke commerce actions'); };
  return {
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
    clearSelection: forbidden, showToast: forbidden,
  };
}

type PreloadingInput = { selected?: InventoryItem | null; suspended?: boolean };

function mountPreloading(input: PreloadingInput) {
  const options = fixture();
  return renderHook(({ selected, suspended = false }: PreloadingInput) => {
    const reveal = useShopReveal({ ...options, suspended });
    useShopRevealPreloading(reveal, false, selected);
    return reveal;
  }, { initialProps: input });
}

for (const dropId of ['poncho_drifella', 'mi_note_cards', 'mi_note_cards_devnet', 'card_nft_2']) {
  test(`${dropId} selection prepares only the required visual assets before opening`, async (t) => {
    const images = mockCardAssetImages(t);
    const figureId = dropId === 'card_nft_2' ? 3 : 1;
    const card = getInteractiveCardPackCardByFigureId(dropId, figureId)!;
    const selected: InventoryItem = { id: 'selected-card', kind: 'dude', dropId, dudeId: figureId, name: 'Selected card' };
    const { result, rerender } = mountPreloading({ selected: null });
    assert.equal(images.length, 0);
    rerender({ selected });
    const expected = dropId === 'card_nft_2'
      ? [card.imageSrc, card.textureSrc, card.foilSrc, DRIF_GLITTER_URL]
      : [card.imageSrc, card.textureSrc, DRIF_GRAIN_URL];
    assert.deepEqual(images.map(image => image.src), expected);
    assert.equal(result.current.revealOverlay, null);
    rerender({ selected: { ...selected } });
    assert.deepEqual(images.map(image => image.src), expected);
    await act(async () => {
      images.forEach(image => { image.load(); image.resolveDecode(); });
    });
    rerender({ selected: null });
    rerender({ selected });
    assert.deepEqual(images.map(image => image.src), expected);
    assert.ok(images.every(image => image.decodeCalls === 1));
    assert.equal(result.current.revealOverlay, null);
  });
}

test('non-card, invalid, and multiple selections do not prepare CSS card assets', (t) => {
  const images = mockCardAssetImages(t);
  const base: InventoryItem = { id: 'selection', kind: 'dude', dropId: 'mi_note_cards', dudeId: 1, name: 'Selection' };
  const { rerender } = mountPreloading({});
  for (const selected of [
    null,
    { ...base, kind: 'box' as const },
    { ...base, kind: 'preorder' as const },
    { ...base, dropId: 'clear_cards' },
    { ...base, dropId: 'little_swag_boxes' },
    { ...base, dudeId: undefined },
    { ...base, dudeId: 0 },
    { ...base, dudeId: 1431 },
  ]) {
    rerender({ selected });
    assert.equal(images.length, 0);
  }
});

test('suspended selection prepares its card after resuming', (t) => {
  const images = mockCardAssetImages(t);
  const selected: InventoryItem = { id: 'selected-card', kind: 'dude', dropId: 'mi_note_cards', dudeId: 2, name: 'Selected card' };
  const { rerender } = mountPreloading({ selected, suspended: true });
  assert.equal(images.length, 0);
  rerender({ selected, suspended: false });
  assert.equal(images.length, 3);
});
