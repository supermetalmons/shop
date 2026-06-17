import {
  CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET,
  CARD_NFT_2_MAX_CARD_ID,
} from './cardNft2RevealIds.js';

export const CARD_NFT_2_UNREVEALED_DEFAULT_LIMIT = 240;
export const CARD_NFT_2_UNREVEALED_MAX_LIMIT = 500;

export type ListCardNft2UnrevealedCardsRequest = {
  limit?: number;
  cursor?: number;
};

export type ListCardNft2UnrevealedCardsResponse = {
  ids: number[];
  nextCursor?: number;
  hasMore: boolean;
};

export type CardNft2UnrevealedCandidatePageArgs = {
  rawPool: unknown;
  limit?: number;
  cursor?: number;
  maxCardId?: number;
};

export function normalizeListCardNft2UnrevealedCardsRequest(
  raw: unknown,
): Required<ListCardNft2UnrevealedCardsRequest> {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const parsedLimit = Math.floor(Number(input.limit));
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, CARD_NFT_2_UNREVEALED_MAX_LIMIT)
      : CARD_NFT_2_UNREVEALED_DEFAULT_LIMIT;
  const parsedCursor = Math.floor(Number(input.cursor));
  const cursor = Number.isFinite(parsedCursor) && parsedCursor > 0 ? parsedCursor : 0;
  return { limit, cursor };
}

function normalizeCardNft2CardId(value: unknown, maxCardId: number): number | null {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized < 1 || normalized > maxCardId) return null;
  return normalized;
}

function isCardNft2UnrevealedCandidateId(id: number): boolean {
  return !CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET.has(id);
}

function cardNft2UnrevealedCandidatePresence(rawPool: unknown, maxCardId: number): Set<number> | null {
  if (!Array.isArray(rawPool)) return null;

  const ids = new Set<number>();
  rawPool.forEach((value) => {
    const id = normalizeCardNft2CardId(value, maxCardId);
    if (!id) return;
    if (!isCardNft2UnrevealedCandidateId(id)) return;
    ids.add(id);
  });
  return ids;
}

function collectCardNft2UnrevealedCandidateIds({
  presence,
  cursor,
  limit,
  maxCardId,
}: {
  presence: ReadonlySet<number> | null;
  cursor: number;
  limit: number;
  maxCardId: number;
}): number[] {
  const ids: number[] = [];
  if (limit <= 0) return ids;

  for (let id = Math.max(1, cursor + 1); id <= maxCardId && ids.length < limit; id += 1) {
    if (presence && !presence.has(id)) continue;
    if (!isCardNft2UnrevealedCandidateId(id)) continue;
    ids.push(id);
  }
  return ids;
}

export function cardNft2UnrevealedCandidateIds(
  rawPool: unknown,
  maxCardId = CARD_NFT_2_MAX_CARD_ID,
): number[] {
  return collectCardNft2UnrevealedCandidateIds({
    presence: cardNft2UnrevealedCandidatePresence(rawPool, maxCardId),
    cursor: 0,
    limit: maxCardId,
    maxCardId,
  });
}

export function paginateCardNft2UnrevealedCandidateIds({
  rawPool,
  limit,
  cursor,
  maxCardId = CARD_NFT_2_MAX_CARD_ID,
}: CardNft2UnrevealedCandidatePageArgs): ListCardNft2UnrevealedCardsResponse {
  const request = normalizeListCardNft2UnrevealedCardsRequest({ limit, cursor });
  const pagePlusOne = collectCardNft2UnrevealedCandidateIds({
    presence: cardNft2UnrevealedCandidatePresence(rawPool, maxCardId),
    cursor: request.cursor,
    limit: request.limit + 1,
    maxCardId,
  });
  const ids = pagePlusOne.slice(0, request.limit);
  const hasMore = pagePlusOne.length > request.limit;
  return {
    ids,
    ...(hasMore && ids.length ? { nextCursor: ids[ids.length - 1] } : {}),
    hasMore,
  };
}
