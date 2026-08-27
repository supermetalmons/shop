import { CARD_NFT_2_COMMON_CARD_ID_VALUES } from './cardNft2CommonIds.ts';
import { normalizeCardNft2CardId } from './cardNft2AssetCore.ts';

export {
  CARD_NFT_2_ASSET_CDN_BASES,
  CARD_NFT_2_MAX_CARD_ID,
  cardNft2AssetUrl,
  normalizeCardNft2CardId,
} from './cardNft2AssetCore.ts';

const CARD_NFT_2_COMMON_CARD_IDS: ReadonlySet<number> =
  new Set(CARD_NFT_2_COMMON_CARD_ID_VALUES);

export function isCardNft2CommonCardId(cardId: unknown): boolean {
  const normalizedCardId = normalizeCardNft2CardId(cardId);
  return normalizedCardId ? CARD_NFT_2_COMMON_CARD_IDS.has(normalizedCardId) : false;
}
