import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CARD_NFT_2_COMMON_CARD_ID_VALUES } from '../functions/src/shared/cardNft2CommonIds.ts';
import { DROP_METADATA_IPFS_GATEWAY, FRONTEND_DROPS } from '../src/config/deployment.ts';
import {
  CARD_NFT_2_BOX_MEDIA,
  CARD_NFT_2_CDN_BASE_URL,
  CARD_NFT_2_PACK_BASE_URL,
  CARD_NFT_2_PACK_INITIAL_COUNT,
  CARD_NFT_2_PACK_RECEIPT_MEDIA,
  DRIFELLA_SHIRT_CDN_BASE_URL,
  DRIFELLA_SHIRT_CLEAN_IMAGE_URL,
  DRIFELLA_SHIRT_IMAGE_BASE_URL,
  DRIFELLA_SHIRT_RECEIPT_IMAGE_BASE_URL,
  LITTLE_SWAG_BOXES_BOX_RECEIPT_IMAGE_URL,
  LITTLE_SWAG_BOXES_CDN_BASE_URL,
  LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL,
  LITTLE_SWAG_BOXES_RECEIPT_BASE_URL,
  LITTLE_SWAG_HOODIE_IMAGE_BASE_URL,
  LITTLE_SWAG_HOODIE_RECEIPT_IMAGE_BASE_URL,
  PONCHO_DRIFELLA_CDN_BASE_URL,
  PONCHO_DRIFELLA_PACK_RECEIPT_IMAGE_URL,
  PONCHO_DRIFELLA_RECEIPT_BASE_URL,
} from '../src/config/dropMediaDefaults.ts';
import { DROPS_EXTRA_CONTENT, getDropExtraContentOverride } from '../src/config/dropsExtraContent.ts';
import {
  CARD_NFT_2_PACK_INITIAL_BASE_URL,
  CARD_NFT_2_PACK_IMAGE_SRCS,
  CARD_NFT_2_PACK_INITIAL_IMAGE_SRCS,
} from '../src/lib/cardNft2Packs.ts';
import {
  mintPanelPreviewAspectRatio,
  mintPanelPreviewImage,
  normalizeBoxDisplayImage,
  normalizeCertificateDisplayImage,
  normalizeFigureDisplayImage,
  resolveDisplayMediaUrl,
  resolveBoxMediaIdForDrop,
  resolveDropContent,
} from '../src/lib/dropContent.ts';
import { getMediaIdForTokenId } from '../src/lib/mediaMap.ts';
import {
  dropAssetCount,
  dropAssetLabel,
  dropAssetReference,
  dropMintSelectionLabel,
  dropOpenActionLabel,
  dropOpenActionProgress,
  dropOpenGerund,
} from '../src/lib/dropLabels.ts';
import {
  CARD_NFT_2_ASSET_CDN_BASES,
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

const CARD_NFT_2_FRONTS_1400_CDN_BASE_URL = CARD_NFT_2_ASSET_CDN_BASES.img;
const CARD_NFT_2_FOILS_CDN_BASE_URL = CARD_NFT_2_ASSET_CDN_BASES.foil;
const CARD_NFT_2_MASKS_CDN_BASE_URL = CARD_NFT_2_ASSET_CDN_BASES.mask;
const CARD_NFT_2_RECEIPTS_CDN_BASE_URL = CARD_NFT_2_ASSET_CDN_BASES.receipt;
const CARD_NFT_2_LEGACY_FRONT_IPFS_CID = 'bafybeied2ho6ufy7piamk5vb722shwn7xdghnrjwfg5skd2wjuakyt2qee';
const CARD_NFT_2_LEGACY_VIDEO_IPFS_CID = 'bafybeibyekgydzallz3fy4mdmpi72mht2kxaglvdu5cfdc54lzhqbdcnqi';
const PONCHO_DRIFELLA_FRONT_CDN_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/fronts`;
const PONCHO_DRIFELLA_PACK_CDN_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/pack`;
const PONCHO_DRIFELLA_SOUND_CDN_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/sounds`;
const PONCHO_DRIFELLA_RECEIPTS_VIDEO_CDN_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/receipts_videos`;
const PONCHO_DRIFELLA_VIDEO_CDN_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/videos`;
const LITTLE_SWAG_HOODIE_RECEIPT_CDN_BASE_URL = LITTLE_SWAG_HOODIE_RECEIPT_IMAGE_BASE_URL;

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

test('shared drop labels preserve pluralization, actions, and mint selection ranges', () => {
  const labels = { namePrefix: 'box', figureNamePrefix: 'party' };
  assert.equal(dropAssetLabel(labels, 'box', 2), 'boxes');
  assert.equal(dropAssetLabel(labels, 'figure', 2), 'parties');
  assert.equal(dropAssetCount(labels, 'figure', 2, { capitalize: true }), '2 Parties');
  assert.equal(dropAssetReference(labels, 'box', 12), 'Box 12');
  assert.equal(dropOpenActionLabel(labels), 'Unbox');
  assert.equal(dropOpenActionProgress(labels), 'Unboxing…');
  assert.equal(dropOpenGerund({ namePrefix: 'pack' }), 'opening');
  assert.equal(
    dropMintSelectionLabel(
      {
        mintSelection: {
          kind: 'size',
          options: [{ label: 'XL', startId: 11, endId: 20 }],
        },
      },
      16,
    ),
    'XL',
  );
  assert.equal(dropMintSelectionLabel(undefined, 16), undefined);
});

test('card_nft_2 box inventory images resolve from token id', () => {
  assert.equal(CARD_NFT_2_PACK_INITIAL_IMAGE_SRCS.length, CARD_NFT_2_PACK_INITIAL_COUNT);
  assert.equal(CARD_NFT_2_PACK_IMAGE_SRCS[0], `${CARD_NFT_2_PACK_BASE_URL}/1/tight.webp`);
  assert.equal(CARD_NFT_2_PACK_INITIAL_IMAGE_SRCS[0], `${CARD_NFT_2_PACK_BASE_URL}/1/initial.webp`);
  assert.deepEqual(FRONTEND_DROPS.card_nft_2_devnet_final.boxMedia, CARD_NFT_2_BOX_MEDIA);
  assert.equal(CARD_NFT_2_PACK_RECEIPT_MEDIA, CARD_NFT_2_BOX_MEDIA);
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
    `${CARD_NFT_2_FRONTS_1400_CDN_BASE_URL}/0001.webp`,
  );
  assert.equal(
    cardNft2AssetUrl('foil', 2),
    `${CARD_NFT_2_FOILS_CDN_BASE_URL}/0002.webp`,
  );
  assert.equal(
    cardNft2AssetUrl('mask', 100),
    `${CARD_NFT_2_MASKS_CDN_BASE_URL}/0100.webp`,
  );
  assert.equal(
    cardNft2AssetUrl('receipt', 9999),
    `${CARD_NFT_2_RECEIPTS_CDN_BASE_URL}/9999.webp`,
  );
  assert.equal(
    cardNft2AssetUrl('receipt', 10000),
    `${CARD_NFT_2_RECEIPTS_CDN_BASE_URL}/10000.webp`,
  );
  assert.equal(
    cardNft2AssetUrl('img', 11133),
    `${CARD_NFT_2_FRONTS_1400_CDN_BASE_URL}/11133.webp`,
  );
  assert.equal(cardNft2AssetUrl('img', 11134), undefined);
  assert.equal(cardNft2AssetUrl('img', 1.5), undefined);
});

test('drifella shirt display media uses the clean item and direct receipt ids', () => {
  assert.equal(DRIFELLA_SHIRT_CDN_BASE_URL, 'https://cdn.lil.org/nft/drifella_shirt');
  assert.equal(DRIFELLA_SHIRT_IMAGE_BASE_URL, `${DRIFELLA_SHIRT_CDN_BASE_URL}/images`);
  assert.equal(DRIFELLA_SHIRT_CLEAN_IMAGE_URL, `${DRIFELLA_SHIRT_IMAGE_BASE_URL}/clean.webp`);
  assert.equal(DRIFELLA_SHIRT_RECEIPT_IMAGE_BASE_URL, DRIFELLA_SHIRT_IMAGE_BASE_URL);

  const content = resolveDropContent('drifella_shirt_devnet');
  assert.equal(content.box.previewImageUrl, DRIFELLA_SHIRT_CLEAN_IMAGE_URL);
  assert.equal(content.box.aspectRatio, 1585 / 1242);
  assert.equal(content.mintPanel.previewImageUrl, DRIFELLA_SHIRT_CLEAN_IMAGE_URL);
  assert.equal(content.mintPanel.aspectRatio, 1585 / 1242);
  assert.equal(content.certificates.boxInventoryImageBaseUrl, DRIFELLA_SHIRT_RECEIPT_IMAGE_BASE_URL);
  assert.deepEqual(content.certificates.boxInventoryMedia, { strategy: 'direct' });
  assert.equal(mintPanelPreviewImage('drifella_shirt_devnet'), DRIFELLA_SHIRT_CLEAN_IMAGE_URL);
  assert.equal(mintPanelPreviewAspectRatio('drifella_shirt_devnet'), 1585 / 1242);

  assert.equal(
    normalizeBoxDisplayImage({
      dropId: 'drifella_shirt_devnet',
      imageRaw: 'https://metadata.example.com/shirt.webp',
      boxId: 16,
    }),
    DRIFELLA_SHIRT_CLEAN_IMAGE_URL,
  );
  assert.equal(
    normalizeCertificateDisplayImage({ dropId: 'drifella_shirt_devnet', boxId: 1 }),
    `${DRIFELLA_SHIRT_RECEIPT_IMAGE_BASE_URL}/1.webp`,
  );
  assert.equal(
    normalizeCertificateDisplayImage({ dropId: 'drifella_shirt_devnet', boxId: 26 }),
    `${DRIFELLA_SHIRT_RECEIPT_IMAGE_BASE_URL}/26.webp`,
  );
  assert.equal(
    normalizeCertificateDisplayImage({
      dropId: 'drifella_shirt_devnet',
      imageRaw: 'https://metadata.example.com/shirt-receipt.webp',
    }),
    'https://metadata.example.com/shirt-receipt.webp',
  );
});

test('legacy display media urls rewrite to CDN paths with metadata fallback preserved', () => {
  const cases = [
    {
      input: 'https://assets.mons.link/drops/cardnft2/img/receipt_pack_1.webp',
      expected: `${CARD_NFT_2_PACK_BASE_URL}/receipt_pack_1.webp`,
    },
    {
      input: 'https://assets.mons.link/drops/lsb/figures/1.mp4',
      expected: `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/figures/1.mp4`,
    },
    {
      input: 'https://assets.mons.link/drops/lsb/json/figures/1.json',
      expected: 'https://assets.mons.link/drops/lsb/json/figures/1.json',
    },
    {
      input: 'https://assets.mons.link/drops/poncho/pack_receipt.webp',
      expected: PONCHO_DRIFELLA_PACK_RECEIPT_IMAGE_URL,
    },
    {
      input:
        'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeib7tmlzh7tcolyurmbm2p7vcv5pcqdcbiaqyx2c2handx3y2ilpaq/0001.webp',
      expected: `${CARD_NFT_2_FRONTS_1400_CDN_BASE_URL}/0001.webp`,
    },
    {
      input:
        'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeiapwcv66aqu2wzh3f5mp4j4j6h7zej3no7paae4qcqxpu3mg436ia/0001.webp',
      expected: `${CARD_NFT_2_MASKS_CDN_BASE_URL}/0001.webp`,
    },
    {
      input:
        'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeigzyk3qd7brxfd3uinftdywhwao65gdxuleqirv5zje3okftmxczy/0001.webp',
      expected: `${CARD_NFT_2_FOILS_CDN_BASE_URL}/0001.webp`,
    },
    {
      input:
        'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeif3ydbiydtyj6b3eonlzvmz3esojlfsvwcb3bynlwjg6vtbwvangq/0001.webp',
      expected: `${CARD_NFT_2_RECEIPTS_CDN_BASE_URL}/0001.webp`,
    },
    {
      input:
        'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeiaka2o45fhcmufpvthgp53xslhnblmqzeg4dri2rqozd7yqndjck4/hoodie_back.webp',
      expected: `${LITTLE_SWAG_HOODIE_IMAGE_BASE_URL}/hoodie_back.webp`,
    },
    {
      input:
        'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeiaka2o45fhcmufpvthgp53xslhnblmqzeg4dri2rqozd7yqndjck4/receipt_1.webp',
      expected: `${LITTLE_SWAG_HOODIE_IMAGE_BASE_URL}/receipt_1.webp`,
    },
    {
      input: 'https://ipfs.io/ipfs/bafybeiamzyimzf77yvlmz5qevbk2looxjmmswyjxzvxqdnooihuderjvkq/1.mp4',
      expected: `${PONCHO_DRIFELLA_RECEIPTS_VIDEO_CDN_BASE_URL}/1.mp4`,
    },
    {
      input: 'https://ipfs.io/ipfs/bafybeihhtllco3nhn2vau3ezqu7zpzfjij4x7n7tcxz63k6fkq55jljram/1.mp4',
      expected: `${PONCHO_DRIFELLA_VIDEO_CDN_BASE_URL}/1.mp4`,
    },
    {
      input: 'https://legacy.example.com/metadata-pack.webp',
      expected: 'https://legacy.example.com/metadata-pack.webp',
    },
  ];

  for (const { input, expected } of cases) {
    assert.equal(resolveDisplayMediaUrl(input), expected);
  }

  const legacyCardNft2VideoUrl = `https://ipfs.io/ipfs/${CARD_NFT_2_LEGACY_VIDEO_IPFS_CID}/1.mp4`;
  assert.equal(
    resolveDisplayMediaUrl(legacyCardNft2VideoUrl),
    `${DROP_METADATA_IPFS_GATEWAY}${CARD_NFT_2_LEGACY_VIDEO_IPFS_CID}/1.mp4`,
  );
});

test('certificate box media overrides merge with family media defaults', () => {
  const previousOverride = DROPS_EXTRA_CONTENT.little_swag_hoodies_devnet;
  try {
    DROPS_EXTRA_CONTENT.little_swag_hoodies_devnet = {
      certificates: {
        boxInventoryMedia: {
          overrides: {
            5: 2,
          },
        },
      },
    };

    const override = getDropExtraContentOverride('little_swag_hoodies_devnet');
    assert.deepEqual(override?.certificates?.boxInventoryMedia, {
      strategy: 'cyclic',
      count: 8,
      overrides: {
        5: 2,
      },
    });
    assert.equal(getMediaIdForTokenId(5, override?.certificates?.boxInventoryMedia), 2);
    assert.equal(getMediaIdForTokenId(9, override?.certificates?.boxInventoryMedia), 1);
    assert.equal(
      normalizeCertificateDisplayImage({ dropId: 'little_swag_hoodies_devnet', boxId: 5 }),
      `${LITTLE_SWAG_HOODIE_RECEIPT_CDN_BASE_URL}/receipt_2.webp`,
    );
  } finally {
    if (previousOverride) {
      DROPS_EXTRA_CONTENT.little_swag_hoodies_devnet = previousOverride;
    } else {
      delete DROPS_EXTRA_CONTENT.little_swag_hoodies_devnet;
    }
  }
});

test('little_swag_boxes display media resolves from CDN overrides', () => {
  const content = resolveDropContent('little_swag_boxes');

  assert.equal(content.box.previewImageUrl, `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/box/tight.webp`);
  assert.equal(content.box.inventoryImageBaseUrl, undefined);
  assert.equal(content.mintPanel.previewImageUrl, `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/box/tight.webp`);
  assert.equal(content.reveal.frameSequence?.baseUrl, `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/box/`);
  assert.equal(content.reveal.frameSequence?.ext, 'webp');
  assert.equal(content.figures.inventoryImageBaseUrl, LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL);
  assert.equal(content.figures.revealVideoBaseUrl, `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/figures/small-rotating/`);
  assert.equal(content.figures.fulfillmentMediaBaseUrl, LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL);
  assert.equal(content.certificates.inventoryImageBaseUrl, LITTLE_SWAG_BOXES_RECEIPT_BASE_URL);
  assert.equal(content.certificates.boxInventoryImageUrl, LITTLE_SWAG_BOXES_BOX_RECEIPT_IMAGE_URL);

  assert.equal(
    normalizeBoxDisplayImage({ dropId: 'little_swag_boxes', boxId: 184 }),
    `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/box/tight.webp`,
  );
  assert.equal(
    normalizeFigureDisplayImage('little_swag_boxes', 'https://legacy.example.com/metadata-figure.webp', 344),
    `${LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL}/1.webp`,
  );
  assert.equal(
    normalizeCertificateDisplayImage({
      dropId: 'little_swag_boxes',
      imageRaw: 'https://legacy.example.com/metadata-receipt.webp',
      figureId: 344,
    }),
    `${LITTLE_SWAG_BOXES_RECEIPT_BASE_URL}/1.webp`,
  );
  assert.equal(
    normalizeCertificateDisplayImage({ dropId: 'little_swag_boxes', boxId: 12 }),
    LITTLE_SWAG_BOXES_BOX_RECEIPT_IMAGE_URL,
  );
});

test('drop-specific extra content overrides preserve family CDN defaults', () => {
  const previousOverride = DROPS_EXTRA_CONTENT.little_swag_boxes_devnet;
  try {
    DROPS_EXTRA_CONTENT.little_swag_boxes_devnet = {
      box: {
        aspectRatio: 2,
      },
      certificates: {
        boxInventoryImageUrl: 'https://cdn.example.com/custom-box-receipt.webp',
      },
    };

    const override = getDropExtraContentOverride('little_swag_boxes_devnet');
    assert.equal(override?.mediaBaseUrl, LITTLE_SWAG_BOXES_CDN_BASE_URL);
    assert.equal(override?.box?.aspectRatio, 2);
    assert.equal(override?.figures?.inventoryImageBaseUrl, LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL);
    assert.equal(override?.certificates?.inventoryImageBaseUrl, LITTLE_SWAG_BOXES_RECEIPT_BASE_URL);
    assert.equal(override?.certificates?.boxInventoryImageUrl, 'https://cdn.example.com/custom-box-receipt.webp');
  } finally {
    if (previousOverride) {
      DROPS_EXTRA_CONTENT.little_swag_boxes_devnet = previousOverride;
    } else {
      delete DROPS_EXTRA_CONTENT.little_swag_boxes_devnet;
    }
  }
});

test('poncho and hoodie receipt display images resolve from CDN overrides', () => {
  const ponchoContent = resolveDropContent('poncho_drifella');
  assert.equal(ponchoContent.certificates.inventoryImageBaseUrl, PONCHO_DRIFELLA_RECEIPT_BASE_URL);
  assert.equal(ponchoContent.certificates.boxInventoryImageUrl, PONCHO_DRIFELLA_PACK_RECEIPT_IMAGE_URL);
  assert.equal(
    normalizeCertificateDisplayImage({
      dropId: 'poncho_drifella',
      imageRaw: 'https://assets.example.com/old-receipt.webp',
      figureId: 1,
    }),
    `${PONCHO_DRIFELLA_RECEIPT_BASE_URL}/1.webp`,
  );
  assert.equal(
    normalizeCertificateDisplayImage({
      dropId: 'poncho_drifella',
      imageRaw: 'https://assets.example.com/old-pack-receipt.webp',
    }),
    PONCHO_DRIFELLA_PACK_RECEIPT_IMAGE_URL,
  );

  const hoodieContent = resolveDropContent('little_swag_hoodies');
  assert.equal(hoodieContent.certificates.inventoryImageUrl, undefined);
  assert.equal(hoodieContent.certificates.boxInventoryImageBaseUrl, LITTLE_SWAG_HOODIE_RECEIPT_CDN_BASE_URL);
  assert.deepEqual(hoodieContent.certificates.boxInventoryMedia, { strategy: 'cyclic', count: 8 });
  assert.equal(
    normalizeCertificateDisplayImage({
      dropId: 'little_swag_hoodies',
      imageRaw: 'https://legacy.example.com/receipt.webp',
      boxId: 1,
    }),
    `${LITTLE_SWAG_HOODIE_RECEIPT_CDN_BASE_URL}/receipt_1.webp`,
  );
  assert.equal(
    normalizeCertificateDisplayImage({
      dropId: 'little_swag_hoodies',
      imageRaw: 'https://legacy.example.com/receipt.webp',
      boxId: 8,
    }),
    `${LITTLE_SWAG_HOODIE_RECEIPT_CDN_BASE_URL}/receipt_8.webp`,
  );
  assert.equal(
    normalizeCertificateDisplayImage({
      dropId: 'little_swag_hoodies',
      imageRaw: 'https://legacy.example.com/receipt.webp',
      boxId: 9,
    }),
    `${LITTLE_SWAG_HOODIE_RECEIPT_CDN_BASE_URL}/receipt_1.webp`,
  );
  assert.equal(
    normalizeCertificateDisplayImage({ dropId: 'little_swag_hoodies', imageRaw: 'https://legacy.example.com/receipt.webp' }),
    'https://legacy.example.com/receipt.webp',
  );
});

test('card_nft_2 bundled common ids are valid and unique', () => {
  const commonIds = CARD_NFT_2_COMMON_CARD_ID_VALUES;
  assert.ok(Array.isArray(commonIds));
  assert.equal(Object.isFrozen(commonIds), true);
  assert.equal(commonIds.length, 4_983);
  assert.equal(commonIds.length, CARD_NFT_2_COMMON_CARD_IDS.size);
  commonIds.forEach((commonId) => {
    assert.equal(typeof commonId, 'number');
    assert.equal(Number.isInteger(commonId), true);
    assert.equal(commonId >= 1, true);
    assert.equal(commonId <= CARD_NFT_2_MAX_CARD_ID, true);
    assert.equal(isCardNft2CommonCardId(commonId), true);
  });
});

test('interactive pack reveal sequences resolve poncho and card_nft_2 frame urls', () => {
  assert.equal(PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE.initialFrameUrl, `${PONCHO_DRIFELLA_PACK_CDN_BASE_URL}/initial.webp`);
  assert.equal(
    PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE.punchFrameUrlsByVariant[2]?.[2],
    `${PONCHO_DRIFELLA_PACK_CDN_BASE_URL}/recoverable_punches/3/3.webp`,
  );
  assert.equal(
    PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE.segmentAutoplayOvertopFrameUrls[9],
    `${PONCHO_DRIFELLA_PACK_CDN_BASE_URL}/final_sequence/autoplay/overtop/10.webp`,
  );

  const cardPack1 = getInteractiveCardPackRevealSequenceForDropId('card_nft_2_devnet_final', 1);
  const cardPack4 = getInteractiveCardPackRevealSequenceForDropId('card_nft_2_devnet_final', 4);
  assert.equal(cardPack1.initialFrameUrl, `${CARD_NFT_2_PACK_BASE_URL}/1/initial.webp`);
  assert.equal(cardPack1.segment11FrameUrls[0], `${CARD_NFT_2_PACK_BASE_URL}/1/final_sequence/1/1.webp`);
  assert.equal(cardPack4.initialFrameUrl, `${CARD_NFT_2_PACK_BASE_URL}/4/initial.webp`);
  assert.equal(
    cardPack4.punchFrameUrlsByVariant[1]?.[2],
    `${CARD_NFT_2_PACK_BASE_URL}/4/recoverable_punches/2/3.webp`,
  );
  assert.equal(
    cardPack4.segmentAutoplayOvertopFrameUrls[9],
    `${CARD_NFT_2_PACK_BASE_URL}/4/final_sequence/autoplay/overtop/10.webp`,
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
    `${CARD_NFT_2_CDN_BASE_URL}/sounds/hit1.mp3`,
    `${CARD_NFT_2_CDN_BASE_URL}/sounds/hit2.mp3`,
    `${CARD_NFT_2_CDN_BASE_URL}/sounds/hit3.mp3`,
  ]);
  assert.equal(CARD_NFT_2_BOX_SOUND_REVEAL_URL, `${CARD_NFT_2_CDN_BASE_URL}/sounds/crash.mp3`);
  assert.equal(CARD_NFT_2_CARD_SOUND_SWIPE_URL, `${CARD_NFT_2_CDN_BASE_URL}/sounds/swipe.mp3`);
  assert.equal(CARD_NFT_2_CARD_SOUND_SPREAD_URL, `${CARD_NFT_2_CDN_BASE_URL}/sounds/spread.mp3`);

  assert.deepEqual(interactiveCardPackRevealSoundUrlsForDropId('poncho_drifella_devnet_x10'), {
    click: PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS,
    reveal: PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL,
  });
  assert.deepEqual(PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS, [
    `${PONCHO_DRIFELLA_SOUND_CDN_BASE_URL}/hit1.mp3`,
    `${PONCHO_DRIFELLA_SOUND_CDN_BASE_URL}/hit2.mp3`,
    `${PONCHO_DRIFELLA_SOUND_CDN_BASE_URL}/hit3.mp3`,
  ]);
  assert.equal(PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL, `${PONCHO_DRIFELLA_SOUND_CDN_BASE_URL}/crash.mp3`);
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

test('card_nft_2 figure and receipt display images prefer padded CDN assets', () => {
  assert.equal(
    normalizeFigureDisplayImage('card_nft_2_devnet_final', 'https://assets.example.com/old-card.webp', 2),
    `${CARD_NFT_2_FRONTS_1400_CDN_BASE_URL}/0002.webp`,
  );
  assert.equal(
    normalizeFigureDisplayImage(
      'card_nft_2_devnet_final',
      `https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/${CARD_NFT_2_LEGACY_FRONT_IPFS_CID}/0101.webp`,
    ),
    `${CARD_NFT_2_FRONTS_1400_CDN_BASE_URL}/0101.webp`,
  );
  assert.equal(
    normalizeFigureDisplayImage(
      'card_nft_2_devnet_final',
      `https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/${CARD_NFT_2_LEGACY_FRONT_IPFS_CID}/0101.webp/?cache=1`,
    ),
    `${CARD_NFT_2_FRONTS_1400_CDN_BASE_URL}/0101.webp`,
  );
  assert.equal(
    normalizeFigureDisplayImage('card_nft_2_devnet_final', 'https://legacy.example.com/view?asset=/0101.webp'),
    undefined,
  );
  assert.equal(
    normalizeFigureDisplayImage(
      'card_nft_2_devnet_final',
      `https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/${CARD_NFT_2_LEGACY_FRONT_IPFS_CID}/0101.webp`,
      2,
    ),
    `${CARD_NFT_2_FRONTS_1400_CDN_BASE_URL}/0002.webp`,
  );
  assert.equal(
    normalizeFigureDisplayImage(
      'card_nft_2_devnet_final',
      `https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/${CARD_NFT_2_LEGACY_VIDEO_IPFS_CID}/1.mp4`,
    ),
    undefined,
  );
  assert.equal(
    normalizeCertificateDisplayImage({
      dropId: 'card_nft_2_devnet_final',
      imageRaw: 'https://assets.example.com/old-receipt.webp',
      figureId: 2,
    }),
    `${CARD_NFT_2_RECEIPTS_CDN_BASE_URL}/0002.webp`,
  );
  assert.equal(
    normalizeCertificateDisplayImage({
      dropId: 'card_nft_2_devnet_final',
      imageRaw: 'https://assets.example.com/box-receipt.webp',
    }),
    'https://assets.example.com/box-receipt.webp',
  );
  assert.equal(
    normalizeCertificateDisplayImage({
      dropId: 'card_nft_2_devnet_final',
      imageRaw: 'https://assets.example.com/box-receipt.webp',
      boxId: 5,
    }),
    `${CARD_NFT_2_PACK_BASE_URL}/receipt_pack_1.webp`,
  );
  assert.equal(
    normalizeCertificateDisplayImage({
      dropId: 'card_nft_2_devnet_final',
      imageRaw: 'https://assets.example.com/box-receipt.webp',
      boxId: 184,
    }),
    `${CARD_NFT_2_PACK_BASE_URL}/receipt_pack_4.webp`,
  );
  assert.equal(
    normalizeCertificateDisplayImage({
      dropId: 'card_nft_2_devnet_final',
      imageRaw: 'https://assets.example.com/box-receipt.webp',
      boxId: 823,
    }),
    `${CARD_NFT_2_PACK_BASE_URL}/receipt_pack_3.webp`,
  );
});

test('poncho interactive cards preserve all media, effect, and glow assignments', () => {
  const cards = Array.from({ length: 207 }, (_, index) => {
    const assetId = index + 1;
    const card = getDrifCardByFigureId(assetId);
    assert.ok(card);
    assert.equal(card.imageSrc, `${PONCHO_DRIFELLA_FRONT_CDN_BASE_URL}/${assetId}.webp`);
    assert.equal(card.foilSrc, `${PONCHO_DRIFELLA_CDN_BASE_URL}/foils/${assetId}.webp`);
    assert.equal(card.textureSrc, `${PONCHO_DRIFELLA_CDN_BASE_URL}/textures/${assetId}.webp`);
    return card;
  });

  assert.equal(getDrifCardByFigureId(208), undefined);
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(cards.map((card) => [card.effect.id, card.glowType])))
      .digest('hex'),
    '24e1cde649d14dd3855f819cda719672b387687b9257349f02a2ea48c532729d',
  );
  assert.equal(
    getInteractiveCardPackCardByFigureId('poncho_drifella', 1),
    cards[0],
  );
});
