import type { DropFamily } from './deploymentCore.js';
import type { SharedMediaMapConfig } from './mediaMap.js';

export const CARD_NFT_2_CDN_BASE_URL = 'https://cdn.lil.org/nft/card_nft_2';
const CARD_NFT_2_PACK_URL = `${CARD_NFT_2_CDN_BASE_URL}/pack`;
export const CARD_NFT_2_PACK_BASE_URL = CARD_NFT_2_PACK_URL;
export const CARD_NFT_2_PACK_INITIAL_BASE_URL = CARD_NFT_2_PACK_URL;
export const CARD_NFT_2_PACK_INITIAL_COUNT = 4;

const CARD_NFT_2_PACK_MEDIA_VALUE = {
  strategy: 'cyclic' as const,
  count: CARD_NFT_2_PACK_INITIAL_COUNT,
};

export const CARD_NFT_2_PACK_MEDIA = CARD_NFT_2_PACK_MEDIA_VALUE;
export const CARD_NFT_2_PACK_RECEIPT_MEDIA = CARD_NFT_2_PACK_MEDIA_VALUE;
export const CARD_NFT_2_BOX_MEDIA = CARD_NFT_2_PACK_MEDIA_VALUE;

export const LITTLE_SWAG_BOXES_CDN_BASE_URL = 'https://cdn.lil.org/nft/little_swag_boxes';
export const LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL = `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/figures/clean`;
export const LITTLE_SWAG_BOXES_RECEIPT_BASE_URL = `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/receipts`;
export const LITTLE_SWAG_BOXES_BOX_RECEIPT_IMAGE_URL = `${LITTLE_SWAG_BOXES_RECEIPT_BASE_URL}/box.webp`;
export const LITTLE_SWAG_BOXES_BOX_PREVIEW_IMAGE_URL = `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/box/tight.webp`;
export const LITTLE_SWAG_BOXES_FIGURE_MEDIA = {
  strategy: 'cyclic' as const,
  count: 333,
  overrides: {
    344: 1,
    353: 90,
    360: 3,
    505: 163,
    650: 285,
    660: 13,
    661: 206,
    662: 82,
    663: 175,
    664: 19,
    665: 92,
    666: 86,
    677: 1,
    686: 90,
    693: 3,
    838: 163,
    983: 285,
    993: 49,
    994: 206,
    995: 21,
    996: 175,
    997: 19,
    998: 92,
    999: 86,
  },
};

export const PONCHO_DRIFELLA_CDN_BASE_URL = 'https://cdn.lil.org/nft/poncho_drifella';
export const PONCHO_DRIFELLA_RECEIPT_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/receipts`;
export const PONCHO_DRIFELLA_PACK_RECEIPT_IMAGE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/pack_receipt.webp`;
export const PONCHO_DRIFELLA_CLEAN_ITEMS_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/items/clean`;
export const PONCHO_DRIFELLA_PACK_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/pack`;
export const PONCHO_DRIFELLA_PACK_INITIAL_IMAGE_URL = `${PONCHO_DRIFELLA_PACK_BASE_URL}/initial.webp`;
export const PONCHO_DRIFELLA_PACK_TIGHT_IMAGE_URL = `${PONCHO_DRIFELLA_PACK_BASE_URL}/tight.webp`;

export const LITTLE_SWAG_HOODIE_CDN_BASE_URL = 'https://cdn.lil.org/nft/little_swag_hoodie';
const LITTLE_SWAG_HOODIE_IMAGES_URL = `${LITTLE_SWAG_HOODIE_CDN_BASE_URL}/images`;
export const LITTLE_SWAG_HOODIE_IMAGE_BASE_URL = LITTLE_SWAG_HOODIE_IMAGES_URL;
export const LITTLE_SWAG_HOODIE_COLLECTION_IMAGE_URL = `${LITTLE_SWAG_HOODIE_IMAGES_URL}/hoodie.webp`;
export const LITTLE_SWAG_HOODIE_CLEAN_IMAGE_URL = `${LITTLE_SWAG_HOODIE_IMAGES_URL}/hoodie_clean.webp`;
export const LITTLE_SWAG_HOODIE_RECEIPT_IMAGE_BASE_URL = LITTLE_SWAG_HOODIE_IMAGES_URL;
export const LITTLE_SWAG_HOODIE_RECEIPT_MEDIA = {
  strategy: 'cyclic' as const,
  count: 8,
};

function copyMediaMapConfig(
  config: SharedMediaMapConfig,
): SharedMediaMapConfig {
  return {
    ...config,
    ...(config.overrides
      ? { overrides: { ...config.overrides } }
      : {}),
  };
}

export function defaultFigureMediaConfigForDropFamily(
  dropFamily: DropFamily,
): SharedMediaMapConfig | undefined {
  return dropFamily === 'little_swag_boxes'
    ? copyMediaMapConfig(LITTLE_SWAG_BOXES_FIGURE_MEDIA)
    : undefined;
}

export function defaultBoxMediaConfigForDropFamily(
  dropFamily: DropFamily,
): SharedMediaMapConfig | undefined {
  return dropFamily === 'card_nft_2'
    ? copyMediaMapConfig(CARD_NFT_2_BOX_MEDIA)
    : undefined;
}
