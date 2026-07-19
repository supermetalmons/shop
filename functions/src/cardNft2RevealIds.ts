import { readFileSync } from 'fs';
import { CARD_NFT_2_MAX_CARD_ID } from './shared/cardNft2AssetCore.js';
import { CARD_NFT_2_COMMON_CARD_ID_VALUES } from './shared/cardNft2CommonIds.js';

export { CARD_NFT_2_MAX_CARD_ID };

function validateCardNft2IdList(label: string, raw: unknown): readonly number[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be a JSON array`);
  }

  const ids = raw.map((value) => {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > CARD_NFT_2_MAX_CARD_ID) {
      throw new Error(`${label} contains invalid card id: ${String(value)}`);
    }
    return numeric;
  });

  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicate card ids`);
  }

  return Object.freeze(ids);
}

function readCardNft2IdList(label: string, relativePath: string): readonly number[] {
  return validateCardNft2IdList(
    label,
    JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as unknown,
  );
}

export const CARD_NFT_2_COMMON_CARD_IDS = CARD_NFT_2_COMMON_CARD_ID_VALUES;
export const CARD_NFT_2_SUPER_RARE_CARD_IDS = readCardNft2IdList(
  'card_nft_2 super rare ids',
  '../src/cardNft2SuperRareIds.json',
);
export const CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS = readCardNft2IdList(
  'card_nft_2 pixel mosaic ids',
  '../src/cardNft2PixelMosaicIds.json',
);
export const CARD_NFT_2_AD_HOC_CURATED_CARD_IDS = readCardNft2IdList(
  'card_nft_2 ad hoc curated ids',
  '../src/cardNft2AdHocCuratedIds.json',
);
export const CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS = Object.freeze([
  ...new Set([
    ...CARD_NFT_2_SUPER_RARE_CARD_IDS,
    ...CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS,
    ...CARD_NFT_2_AD_HOC_CURATED_CARD_IDS,
  ]),
]);

export const CARD_NFT_2_COMMON_CARD_ID_SET = new Set(CARD_NFT_2_COMMON_CARD_IDS);
export const CARD_NFT_2_SUPER_RARE_CARD_ID_SET = new Set(CARD_NFT_2_SUPER_RARE_CARD_IDS);
export const CARD_NFT_2_PIXEL_MOSAIC_CARD_ID_SET = new Set(CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS);
export const CARD_NFT_2_AD_HOC_CURATED_CARD_ID_SET = new Set(CARD_NFT_2_AD_HOC_CURATED_CARD_IDS);
export const CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET = new Set(CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS);

for (const cardId of CARD_NFT_2_SUPER_RARE_CARD_IDS) {
  if (CARD_NFT_2_COMMON_CARD_ID_SET.has(cardId)) {
    throw new Error(`card_nft_2 common and super rare ids overlap at ${cardId}`);
  }
}

for (const cardId of CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS) {
  if (CARD_NFT_2_COMMON_CARD_ID_SET.has(cardId)) {
    throw new Error(`card_nft_2 common and pixel mosaic ids overlap at ${cardId}`);
  }
  if (CARD_NFT_2_SUPER_RARE_CARD_ID_SET.has(cardId)) {
    throw new Error(`card_nft_2 super rare and pixel mosaic ids overlap at ${cardId}`);
  }
}

for (const cardId of CARD_NFT_2_AD_HOC_CURATED_CARD_IDS) {
  if (CARD_NFT_2_COMMON_CARD_ID_SET.has(cardId)) {
    throw new Error(`card_nft_2 common and ad hoc curated ids overlap at ${cardId}`);
  }
}
