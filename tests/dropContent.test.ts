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
import { normalizeBoxDisplayImage, resolveDropContent } from '../src/lib/dropContent.ts';
import { getMediaIdForTokenId } from '../src/lib/mediaMap.ts';

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
