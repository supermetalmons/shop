import cardNft2CommonIdsRaw from './cardNft2CommonIds.json' with { type: 'json' };
import { CARD_NFT_2_CDN_BASE_URL } from '../config/dropMediaDefaults.ts';

export type CardNft2AssetKind = 'foil' | 'mask' | 'receipt' | 'img';

export const CARD_NFT_2_MAX_CARD_ID = 11133;

export const CARD_NFT_2_ASSET_CDN_BASES: Record<CardNft2AssetKind, string> = {
  foil: `${CARD_NFT_2_CDN_BASE_URL}/foils`,
  mask: `${CARD_NFT_2_CDN_BASE_URL}/masks`,
  receipt: `${CARD_NFT_2_CDN_BASE_URL}/receipts`,
  img: `${CARD_NFT_2_CDN_BASE_URL}/fronts_1400`,
};

function buildCardNft2CommonCardIds(values: readonly unknown[]): ReadonlySet<number> {
  const cardIds = new Set<number>();
  values.forEach((value) => {
    const normalizedCardId = normalizeCardNft2CardId(value);
    if (normalizedCardId) cardIds.add(normalizedCardId);
  });
  return cardIds;
}

export const CARD_NFT_2_COMMON_CARD_IDS = buildCardNft2CommonCardIds(cardNft2CommonIdsRaw);

export function normalizeCardNft2CardId(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (trimmed === '') return undefined;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) return undefined;
  if (numeric < 1 || numeric > CARD_NFT_2_MAX_CARD_ID) return undefined;
  return numeric;
}

export function isCardNft2CommonCardId(cardId: unknown): boolean {
  const normalizedCardId = normalizeCardNft2CardId(cardId);
  return normalizedCardId ? CARD_NFT_2_COMMON_CARD_IDS.has(normalizedCardId) : false;
}

export function formatCardNft2AssetId(cardId: unknown): string | undefined {
  const normalizedCardId = normalizeCardNft2CardId(cardId);
  if (!normalizedCardId) return undefined;
  return String(normalizedCardId).padStart(4, '0');
}

export function cardNft2AssetUrl(kind: CardNft2AssetKind, cardId: unknown): string | undefined {
  const formattedCardId = formatCardNft2AssetId(cardId);
  if (!formattedCardId) return undefined;
  return `${CARD_NFT_2_ASSET_CDN_BASES[kind]}/${formattedCardId}.webp`;
}
