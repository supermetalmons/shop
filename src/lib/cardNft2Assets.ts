import cardNft2CommonIdsRaw from './cardNft2CommonIds.json';

export type CardNft2AssetKind = 'foil' | 'mask' | 'receipt' | 'img';

export const CARD_NFT_2_MAX_CARD_ID = 11133;

const CARD_NFT_2_IPFS_GATEWAY = 'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs';

const CARD_NFT_2_ASSET_CIDS: Record<CardNft2AssetKind, string> = {
  foil: 'bafybeigzyk3qd7brxfd3uinftdywhwao65gdxuleqirv5zje3okftmxczy',
  mask: 'bafybeiapwcv66aqu2wzh3f5mp4j4j6h7zej3no7paae4qcqxpu3mg436ia',
  receipt: 'bafybeif3ydbiydtyj6b3eonlzvmz3esojlfsvwcb3bynlwjg6vtbwvangq',
  img: 'bafybeib7tmlzh7tcolyurmbm2p7vcv5pcqdcbiaqyx2c2handx3y2ilpaq',
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
  return `${CARD_NFT_2_IPFS_GATEWAY}/${CARD_NFT_2_ASSET_CIDS[kind]}/${formattedCardId}.webp`;
}
