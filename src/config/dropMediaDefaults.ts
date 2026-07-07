export const CARD_NFT_2_CDN_BASE_URL = 'https://cdn.lil.org/nft/card_nft_2';
export const CARD_NFT_2_PACK_BASE_URL = `${CARD_NFT_2_CDN_BASE_URL}/pack`;
export const CARD_NFT_2_PACK_INITIAL_BASE_URL = CARD_NFT_2_PACK_BASE_URL;
export const CARD_NFT_2_PACK_INITIAL_COUNT = 4;

export const CARD_NFT_2_PACK_MEDIA = {
  strategy: 'cyclic' as const,
  count: CARD_NFT_2_PACK_INITIAL_COUNT,
};

export const CARD_NFT_2_PACK_RECEIPT_MEDIA = CARD_NFT_2_PACK_MEDIA;
export const CARD_NFT_2_BOX_MEDIA = CARD_NFT_2_PACK_MEDIA;

export const LITTLE_SWAG_BOXES_CDN_BASE_URL = 'https://cdn.lil.org/nft/little_swag_boxes';
export const LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL = `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/figures/clean`;
export const LITTLE_SWAG_BOXES_RECEIPT_BASE_URL = `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/receipts`;
export const LITTLE_SWAG_BOXES_BOX_RECEIPT_IMAGE_URL = `${LITTLE_SWAG_BOXES_RECEIPT_BASE_URL}/box.webp`;

export const PONCHO_DRIFELLA_CDN_BASE_URL = 'https://cdn.lil.org/nft/poncho_drifella';
export const PONCHO_DRIFELLA_RECEIPT_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/receipts`;
export const PONCHO_DRIFELLA_PACK_RECEIPT_IMAGE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/pack_receipt.webp`;

export const LITTLE_SWAG_HOODIE_CDN_BASE_URL = 'https://cdn.lil.org/nft/little_swag_hoodie';
export const LITTLE_SWAG_HOODIE_IMAGE_BASE_URL = `${LITTLE_SWAG_HOODIE_CDN_BASE_URL}/images`;
export const LITTLE_SWAG_HOODIE_COLLECTION_IMAGE_URL = `${LITTLE_SWAG_HOODIE_IMAGE_BASE_URL}/hoodie.webp`;
export const LITTLE_SWAG_HOODIE_RECEIPT_IMAGE_BASE_URL = LITTLE_SWAG_HOODIE_IMAGE_BASE_URL;
export const LITTLE_SWAG_HOODIE_RECEIPT_MEDIA = {
  strategy: 'cyclic' as const,
  count: 8,
};
