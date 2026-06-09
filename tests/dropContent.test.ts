import test from 'node:test';
import assert from 'node:assert/strict';
import { FRONTEND_DROPS } from '../src/config/deployment.ts';
import {
  CARD_NFT_2_BOX_MEDIA,
  CARD_NFT_2_PACK_INITIAL_COUNT,
} from '../src/config/dropMediaDefaults.ts';
import {
  CARD_NFT_2_PACK_INITIAL_BASE_URL,
  CARD_NFT_2_PACK_IMAGE_SRCS,
  CARD_NFT_2_PACK_INITIAL_IMAGE_SRCS,
} from '../src/lib/cardNft2Packs.ts';
import { normalizeBoxDisplayImage, resolveBoxMediaIdForDrop, resolveDropContent } from '../src/lib/dropContent.ts';
import { getMediaIdForTokenId } from '../src/lib/mediaMap.ts';
import {
  getInteractiveCardPackCardByFigureId,
  PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE,
  getInteractiveCardPackRevealSequenceForDropId,
  selectInteractiveCardPackRevealCardId,
} from '../src/lib/interactiveCardPackReveal.ts';
import { DRIF_EFFECT_KEYS, getDrifCardByFigureId } from '../src/drifCards.ts';

test('media map helper cycles ids and honors overrides', () => {
  const cyclic = { strategy: 'cyclic' as const, count: 4 };

  assert.equal(getMediaIdForTokenId(1, cyclic), 1);
  assert.equal(getMediaIdForTokenId(5, cyclic), 1);
  assert.equal(getMediaIdForTokenId(9, cyclic), 1);
  assert.equal(getMediaIdForTokenId(2, cyclic), 2);
  assert.equal(getMediaIdForTokenId(6, cyclic), 2);
  assert.equal(getMediaIdForTokenId(5, { ...cyclic, overrides: { 5: 3 } }), 3);
  assert.equal(getMediaIdForTokenId(0, cyclic), null);
  assert.equal(getMediaIdForTokenId(-1, cyclic), null);
  assert.equal(getMediaIdForTokenId(undefined, cyclic), null);
});

test('card_nft_2 box inventory images resolve from token id', () => {
  assert.equal(CARD_NFT_2_PACK_INITIAL_IMAGE_SRCS.length, CARD_NFT_2_PACK_INITIAL_COUNT);
  assert.equal(CARD_NFT_2_PACK_IMAGE_SRCS[0], '/card_nft_2/pack/1/tight.webp');
  assert.equal(CARD_NFT_2_PACK_INITIAL_IMAGE_SRCS[0], '/card_nft_2/pack/1/initial.webp');
  assert.deepEqual(FRONTEND_DROPS.card_nft_2_devnet.boxMedia, CARD_NFT_2_BOX_MEDIA);
  assert.equal(resolveDropContent('card_nft_2_devnet').box.inventoryImageBaseUrl, CARD_NFT_2_PACK_INITIAL_BASE_URL);
  assert.equal(resolveDropContent('card_nft_2_devnet').box.inventoryImagePathMode, 'folder_initial');
  assert.equal(resolveBoxMediaIdForDrop('card_nft_2_devnet', 5), 1);
  assert.equal(
    normalizeBoxDisplayImage({
      dropId: 'card_nft_2_devnet',
      imageRaw: 'https://assets.example.com/metadata-pack.webp',
      boxId: 1,
    }),
    CARD_NFT_2_PACK_INITIAL_IMAGE_SRCS[0],
  );
  assert.equal(
    normalizeBoxDisplayImage({
      dropId: 'card_nft_2_devnet',
      imageRaw: 'https://assets.example.com/metadata-pack.webp',
      boxId: 5,
    }),
    CARD_NFT_2_PACK_INITIAL_IMAGE_SRCS[0],
  );
  assert.equal(
    normalizeBoxDisplayImage({
      dropId: 'card_nft_2_devnet',
      imageRaw: 'https://assets.example.com/metadata-pack.webp',
    }),
    'https://assets.example.com/metadata-pack.webp',
  );
});

test('interactive pack reveal sequences resolve poncho and card_nft_2 frame urls', () => {
  assert.equal(PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE.initialFrameUrl, '/Poncho_Drifella/pack/initial.webp');
  assert.equal(
    PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE.punchFrameUrlsByVariant[2]?.[2],
    '/Poncho_Drifella/pack/recoverable_punches/3/3.webp',
  );
  assert.equal(
    PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE.segmentAutoplayOvertopFrameUrls[9],
    '/Poncho_Drifella/pack/final_sequence/autoplay/overtop/10.webp',
  );

  const cardPack1 = getInteractiveCardPackRevealSequenceForDropId('card_nft_2_devnet', 1);
  const cardPack4 = getInteractiveCardPackRevealSequenceForDropId('card_nft_2_devnet', 4);
  assert.equal(cardPack1.initialFrameUrl, '/card_nft_2/pack/1/initial.webp');
  assert.equal(cardPack1.segment11FrameUrls[0], '/card_nft_2/pack/1/final_sequence/1/1.webp');
  assert.equal(cardPack4.initialFrameUrl, '/card_nft_2/pack/4/initial.webp');
  assert.equal(cardPack4.punchFrameUrlsByVariant[1]?.[2], '/card_nft_2/pack/4/recoverable_punches/2/3.webp');
  assert.equal(
    cardPack4.segmentAutoplayOvertopFrameUrls[9],
    '/card_nft_2/pack/4/final_sequence/autoplay/overtop/10.webp',
  );
});

test('interactive pack reveal content and selected card presentation are stable', () => {
  assert.equal(resolveDropContent('poncho_drifella_devnet_x10').reveal.renderer, 'interactive_card_pack');
  const cardNft2Content = resolveDropContent('card_nft_2_devnet');
  assert.equal(cardNft2Content.reveal.renderer, 'interactive_card_pack');
  assert.equal(cardNft2Content.reveal.frameTiming?.frameCount, PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE.revealFrameSequence.frameCount);
  assert.equal(cardNft2Content.reveal.frameSequence, undefined);
  assert.equal(cardNft2Content.box.inventoryImagePathMode, 'folder_initial');

  const revealedIds = [11, 12, 13];
  assert.equal(selectInteractiveCardPackRevealCardId(revealedIds, () => 0), 11);
  assert.equal(selectInteractiveCardPackRevealCardId(revealedIds, () => 0.5), 12);
  assert.equal(selectInteractiveCardPackRevealCardId(revealedIds, () => 0.99), 13);
  assert.deepEqual(revealedIds, [11, 12, 13]);
});

test('card_nft_2 interactive card assets use assigned holo effects for ids 1 through 100', () => {
  const card1 = getInteractiveCardPackCardByFigureId('card_nft_2_devnet', 1);
  assert.ok(card1);
  assert.equal(card1.imageSrc, 'https://assets.mons.link/drops/cardnft2/img/card_1.webp');
  assert.equal(card1.foilSrc, 'https://assets.mons.link/drops/cardnft2/holo/foil_1.webp');
  assert.equal(card1.textureSrc, 'https://assets.mons.link/drops/cardnft2/holo/mask_1.webp');
  assert.equal(card1.effect.id, 'swshp-SWSH179');
  assert.equal(card1.effect.number, '1');

  const card100 = getInteractiveCardPackCardByFigureId('card_nft_2_devnet', 100);
  assert.ok(card100);
  assert.equal(card100.foilSrc, 'https://assets.mons.link/drops/cardnft2/holo/foil_100.webp');
  assert.equal(card100.textureSrc, 'https://assets.mons.link/drops/cardnft2/holo/mask_100.webp');
  assert.equal(card100.effect.id, 'pgo-24');
  assert.equal(card100.effect.number, '100');
});

test('card_nft_2 interactive card assets remain plain outside assigned holo range', () => {
  const card101 = getInteractiveCardPackCardByFigureId('card_nft_2_devnet', 101);
  assert.ok(card101);
  assert.equal(card101.imageSrc, 'https://assets.mons.link/drops/cardnft2/img/card_101.webp');
  assert.equal(card101.foilSrc, undefined);
  assert.equal(card101.textureSrc, undefined);
  assert.equal(card101.effect.id, 'card-nft-2-101');
  assert.equal(card101.effect.effectKey, DRIF_EFFECT_KEYS.lightingOnly);
  assert.equal(card101.effect.source, 'card_nft_2');
  assert.equal(card101.effect.number, '101');
  assert.doesNotMatch(JSON.stringify(card101), /back\.webp/);
});

test('poncho interactive card lookup still returns drif card configs', () => {
  assert.equal(
    getInteractiveCardPackCardByFigureId('poncho_drifella', 1),
    getDrifCardByFigureId(1),
  );
});
