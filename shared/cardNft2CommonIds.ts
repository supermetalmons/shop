import commonCardIds from './cardNft2CommonIds.json' with { type: 'json' };
import { CARD_NFT_2_MAX_CARD_ID } from './cardNft2AssetCore.ts';

const CARD_NFT_2_COMMON_CARD_ID_COUNT = 4_983;

function validateCardNft2CommonCardIds(raw: unknown): readonly number[] {
  if (!Array.isArray(raw) || raw.length !== CARD_NFT_2_COMMON_CARD_ID_COUNT) {
    throw new Error(
      `card_nft_2 common ids must contain exactly ${CARD_NFT_2_COMMON_CARD_ID_COUNT} card ids`,
    );
  }

  const ids = raw.slice();
  const seen = new Set<number>();
  for (const cardId of ids) {
    if (
      typeof cardId !== 'number' ||
      !Number.isInteger(cardId) ||
      cardId < 1 ||
      cardId > CARD_NFT_2_MAX_CARD_ID
    ) {
      throw new Error(
        `card_nft_2 common ids contains invalid card id: ${String(cardId)}`,
      );
    }
    if (seen.has(cardId)) {
      throw new Error('card_nft_2 common ids contains duplicate card ids');
    }
    seen.add(cardId);
  }

  return Object.freeze(ids);
}

export const CARD_NFT_2_COMMON_CARD_ID_VALUES =
  validateCardNft2CommonCardIds(commonCardIds);
