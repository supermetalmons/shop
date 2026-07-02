import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import {
  normalizeBoxDisplayImage,
  normalizeCertificateDisplayImage,
  normalizeFigureDisplayImage,
  resolveBoxMediaIdForDrop,
  resolveDropContent,
} from '../src/lib/dropContent.ts';
import { getMediaIdForTokenId } from '../src/lib/mediaMap.ts';
import {
  CARD_NFT_2_COMMON_CARD_IDS,
  CARD_NFT_2_MAX_CARD_ID,
  cardNft2AssetUrl,
  isCardNft2CommonCardId,
} from '../src/lib/cardNft2Assets.ts';
import {
  getInteractiveCardPackCardByFigureId,
  PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE,
  getInteractiveCardPackRevealSequenceForDropId,
  selectInteractiveCardPackRevealCardId,
} from '../src/lib/interactiveCardPackReveal.ts';
import {
  CARD_NFT_2_BOX_SOUND_CLICK_URLS,
  CARD_NFT_2_BOX_SOUND_REVEAL_URL,
  CARD_NFT_2_CARD_SOUND_SPREAD_URL,
  CARD_NFT_2_CARD_SOUND_SWIPE_URL,
  PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS,
  PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL,
  interactiveCardPackRevealSoundUrlsForDropId,
} from '../src/lib/interactiveCardPackRevealSounds.ts';
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
  assert.deepEqual(FRONTEND_DROPS.card_nft_2_devnet_final.boxMedia, CARD_NFT_2_BOX_MEDIA);
  assert.equal(resolveDropContent('card_nft_2_devnet_final').box.inventoryImageBaseUrl, CARD_NFT_2_PACK_INITIAL_BASE_URL);
  assert.equal(resolveDropContent('card_nft_2_devnet_final').box.inventoryImagePathMode, 'folder_initial');
  assert.equal(resolveBoxMediaIdForDrop('card_nft_2_devnet_final', 5), 1);
  assert.equal(
    normalizeBoxDisplayImage({
      dropId: 'card_nft_2_devnet_final',
      imageRaw: 'https://assets.example.com/metadata-pack.webp',
      boxId: 1,
    }),
    CARD_NFT_2_PACK_INITIAL_IMAGE_SRCS[0],
  );
  assert.equal(
    normalizeBoxDisplayImage({
      dropId: 'card_nft_2_devnet_final',
      imageRaw: 'https://assets.example.com/metadata-pack.webp',
      boxId: 5,
    }),
    CARD_NFT_2_PACK_INITIAL_IMAGE_SRCS[0],
  );
  assert.equal(
    normalizeBoxDisplayImage({
      dropId: 'card_nft_2_devnet_final',
      imageRaw: 'https://assets.example.com/metadata-pack.webp',
      boxId: 6,
    }),
    CARD_NFT_2_PACK_INITIAL_IMAGE_SRCS[1],
  );
  assert.equal(
    normalizeBoxDisplayImage({
      dropId: 'card_nft_2_devnet_final',
      imageRaw: 'https://assets.example.com/metadata-pack.webp',
    }),
    'https://assets.example.com/metadata-pack.webp',
  );
});

test('card_nft_2 asset helper pads ids and enforces range', () => {
  assert.equal(
    cardNft2AssetUrl('img', 1),
    'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeib7tmlzh7tcolyurmbm2p7vcv5pcqdcbiaqyx2c2handx3y2ilpaq/0001.webp',
  );
  assert.equal(
    cardNft2AssetUrl('foil', 2),
    'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeigzyk3qd7brxfd3uinftdywhwao65gdxuleqirv5zje3okftmxczy/0002.webp',
  );
  assert.equal(
    cardNft2AssetUrl('mask', 100),
    'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeiapwcv66aqu2wzh3f5mp4j4j6h7zej3no7paae4qcqxpu3mg436ia/0100.webp',
  );
  assert.equal(
    cardNft2AssetUrl('receipt', 9999),
    'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeif3ydbiydtyj6b3eonlzvmz3esojlfsvwcb3bynlwjg6vtbwvangq/9999.webp',
  );
  assert.equal(
    cardNft2AssetUrl('receipt', 10000),
    'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeif3ydbiydtyj6b3eonlzvmz3esojlfsvwcb3bynlwjg6vtbwvangq/10000.webp',
  );
  assert.equal(
    cardNft2AssetUrl('img', 11133),
    'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeib7tmlzh7tcolyurmbm2p7vcv5pcqdcbiaqyx2c2handx3y2ilpaq/11133.webp',
  );
  assert.equal(cardNft2AssetUrl('img', 11134), undefined);
  assert.equal(cardNft2AssetUrl('img', 1.5), undefined);
});

test('card_nft_2 bundled common ids are valid and unique', () => {
  const commonIds = JSON.parse(
    readFileSync(new URL('../src/lib/cardNft2CommonIds.json', import.meta.url), 'utf8'),
  ) as unknown[];
  assert.ok(Array.isArray(commonIds));
  assert.equal(commonIds.length, CARD_NFT_2_COMMON_CARD_IDS.size);
  commonIds.forEach((commonId) => {
    assert.equal(typeof commonId, 'string');
    const normalizedCommonId = Number(commonId);
    assert.equal(Number.isInteger(normalizedCommonId), true);
    assert.equal(normalizedCommonId >= 1, true);
    assert.equal(normalizedCommonId <= CARD_NFT_2_MAX_CARD_ID, true);
    assert.equal(isCardNft2CommonCardId(normalizedCommonId), true);
  });
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

  const cardPack1 = getInteractiveCardPackRevealSequenceForDropId('card_nft_2_devnet_final', 1);
  const cardPack4 = getInteractiveCardPackRevealSequenceForDropId('card_nft_2_devnet_final', 4);
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
  const cardNft2Content = resolveDropContent('card_nft_2_devnet_final');
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

test('interactive pack reveal sounds resolve by drop family', () => {
  assert.deepEqual(interactiveCardPackRevealSoundUrlsForDropId('card_nft_2_devnet_final'), {
    click: CARD_NFT_2_BOX_SOUND_CLICK_URLS,
    reveal: CARD_NFT_2_BOX_SOUND_REVEAL_URL,
    cardSwipe: CARD_NFT_2_CARD_SOUND_SWIPE_URL,
    cardSpread: CARD_NFT_2_CARD_SOUND_SPREAD_URL,
  });
  assert.deepEqual(CARD_NFT_2_BOX_SOUND_CLICK_URLS, [
    'https://cdn.lil.org/nft/card_nft_2/sounds/hit1.mp3',
    'https://cdn.lil.org/nft/card_nft_2/sounds/hit2.mp3',
    'https://cdn.lil.org/nft/card_nft_2/sounds/hit3.mp3',
  ]);
  assert.equal(CARD_NFT_2_BOX_SOUND_REVEAL_URL, 'https://cdn.lil.org/nft/card_nft_2/sounds/crash.mp3');
  assert.equal(CARD_NFT_2_CARD_SOUND_SWIPE_URL, 'https://cdn.lil.org/nft/card_nft_2/sounds/swipe.mp3');
  assert.equal(CARD_NFT_2_CARD_SOUND_SPREAD_URL, 'https://cdn.lil.org/nft/card_nft_2/sounds/spread.mp3');

  assert.deepEqual(interactiveCardPackRevealSoundUrlsForDropId('poncho_drifella_devnet_x10'), {
    click: PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS,
    reveal: PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL,
  });
  assert.deepEqual(PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS, [
    '/Poncho_Drifella/sounds/hit1.mp3',
    '/Poncho_Drifella/sounds/hit2.mp3',
    '/Poncho_Drifella/sounds/hit3.mp3',
  ]);
  assert.equal(PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL, '/Poncho_Drifella/sounds/crash.mp3');
});

function assertCardNft2HoloCard(cardId: number, effectId: string) {
  const card = getInteractiveCardPackCardByFigureId('card_nft_2_devnet_final', cardId);
  assert.ok(card);
  assert.equal(card.imageSrc, cardNft2AssetUrl('img', cardId));
  assert.equal(card.foilSrc, cardNft2AssetUrl('foil', cardId));
  assert.equal(card.textureSrc, cardNft2AssetUrl('mask', cardId));
  assert.equal(card.effect.id, effectId);
  assert.equal(card.effect.number, String(cardId));
}

test('card_nft_2 interactive cards use neutral effects for bundled common ids', () => {
  const card4 = getInteractiveCardPackCardByFigureId('card_nft_2_devnet_final', 4);
  assert.ok(card4);
  assert.equal(isCardNft2CommonCardId(4), true);
  assert.equal(card4.imageSrc, cardNft2AssetUrl('img', 4));
  assert.equal(card4.foilSrc, undefined);
  assert.equal(card4.textureSrc, undefined);
  assert.equal(card4.effect.id, 'card-nft-2-4');
  assert.equal(card4.effect.effectKey, DRIF_EFFECT_KEYS.lightingOnly);
  assert.equal(card4.effect.source, 'card_nft_2');
  assert.equal(card4.effect.number, '4');
  assert.doesNotMatch(JSON.stringify(card4), /back\.webp/);
});

test('card_nft_2 interactive cards assign deterministic modulo holo effects for non-common ids', () => {
  assert.equal(isCardNft2CommonCardId(8), false);
  assert.equal(isCardNft2CommonCardId(1), false);
  assert.equal(isCardNft2CommonCardId(2), false);
  assert.equal(isCardNft2CommonCardId(3), false);
  assertCardNft2HoloCard(8, 'swshp-SWSH179');
  assertCardNft2HoloCard(1, 'pgo-24');
  assertCardNft2HoloCard(2, 'swsh6-196');
  assertCardNft2HoloCard(3, 'swsh4-9');

  const card11133 = getInteractiveCardPackCardByFigureId('card_nft_2_devnet_final', 11133);
  assert.ok(card11133);
  assert.equal(card11133.imageSrc, cardNft2AssetUrl('img', 11133));
  assert.equal(card11133.effect.id, 'pgo-24');
  assert.equal(getInteractiveCardPackCardByFigureId('card_nft_2_devnet_final', 11134), undefined);
});

test('card_nft_2 figure and receipt display images prefer padded IPFS assets', () => {
  assert.equal(
    normalizeFigureDisplayImage('card_nft_2_devnet_final', 'https://assets.example.com/old-card.webp', 2),
    'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeib7tmlzh7tcolyurmbm2p7vcv5pcqdcbiaqyx2c2handx3y2ilpaq/0002.webp',
  );
  assert.equal(
    normalizeCertificateDisplayImage('card_nft_2_devnet_final', 'https://assets.example.com/old-receipt.webp', 2),
    'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeif3ydbiydtyj6b3eonlzvmz3esojlfsvwcb3bynlwjg6vtbwvangq/0002.webp',
  );
  assert.equal(
    normalizeCertificateDisplayImage('card_nft_2_devnet_final', 'https://assets.example.com/box-receipt.webp'),
    'https://assets.example.com/box-receipt.webp',
  );
});

test('poncho interactive card lookup still returns drif card configs', () => {
  assert.equal(
    getInteractiveCardPackCardByFigureId('poncho_drifella', 1),
    getDrifCardByFigureId(1),
  );
});
