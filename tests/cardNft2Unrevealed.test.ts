import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_NFT_2_COMMON_CARD_IDS,
  CARD_NFT_2_MAX_CARD_ID,
  CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS,
  CARD_NFT_2_PIXEL_MOSAIC_CARD_ID_SET,
  CARD_NFT_2_SUPER_RARE_CARD_IDS,
  CARD_NFT_2_SUPER_RARE_CARD_ID_SET,
} from '../functions/src/cardNft2RevealIds.ts';
import {
  CARD_NFT_2_UNREVEALED_DEFAULT_LIMIT,
  CARD_NFT_2_UNREVEALED_MAX_LIMIT,
  cardNft2UnrevealedCandidateIds,
  normalizeListCardNft2UnrevealedCardsRequest,
  paginateCardNft2UnrevealedCandidateIds,
} from '../functions/src/cardNft2Unrevealed.ts';

function firstNUnrevealedEligibleIds(count: number): number[] {
  const ids: number[] = [];
  for (let id = 1; id <= CARD_NFT_2_MAX_CARD_ID && ids.length < count; id += 1) {
    if (CARD_NFT_2_SUPER_RARE_CARD_ID_SET.has(id)) continue;
    if (CARD_NFT_2_PIXEL_MOSAIC_CARD_ID_SET.has(id)) continue;
    ids.push(id);
  }
  if (ids.length !== count) throw new Error(`Expected at least ${count} unrevealed-eligible ids`);
  return ids;
}

test('card_nft_2 unrevealed request normalization clamps limit and cursor', () => {
  assert.deepEqual(normalizeListCardNft2UnrevealedCardsRequest({}), {
    limit: CARD_NFT_2_UNREVEALED_DEFAULT_LIMIT,
    cursor: 0,
  });
  assert.deepEqual(normalizeListCardNft2UnrevealedCardsRequest({ limit: 9999, cursor: -20 }), {
    limit: CARD_NFT_2_UNREVEALED_MAX_LIMIT,
    cursor: 0,
  });
  assert.deepEqual(normalizeListCardNft2UnrevealedCardsRequest({ limit: 12.8, cursor: 42.9 }), {
    limit: 12,
    cursor: 42,
  });
});

test('card_nft_2 unrevealed candidates remove invalid ids, duplicates, super rare, and pixel mosaic', () => {
  const commonId = CARD_NFT_2_COMMON_CARD_IDS[0]!;
  const [eligibleA, eligibleB] = firstNUnrevealedEligibleIds(2);
  const superRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!;
  const pixelMosaicId = CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS[0]!;

  const result = cardNft2UnrevealedCandidateIds([
    eligibleB,
    commonId,
    eligibleA,
    eligibleB,
    superRareId,
    pixelMosaicId,
    0,
    CARD_NFT_2_MAX_CARD_ID + 1,
    'not-a-card',
  ]);

  assert.deepEqual(result, Array.from(new Set([eligibleA, eligibleB, commonId])).sort((a, b) => a - b));
  assert.equal(result.includes(superRareId), false);
  assert.equal(result.includes(pixelMosaicId), false);
});

test('card_nft_2 unrevealed pagination uses pool candidates and returns a cursor', () => {
  const [first, second, third, fourth] = firstNUnrevealedEligibleIds(4);

  const firstPage = paginateCardNft2UnrevealedCandidateIds({
    rawPool: [fourth, third, second, first],
    limit: 2,
  });

  assert.deepEqual(firstPage, {
    ids: [first, second],
    nextCursor: second,
    hasMore: true,
  });

  assert.deepEqual(
    paginateCardNft2UnrevealedCandidateIds({
      rawPool: [fourth, third, second, first],
      limit: 2,
      cursor: firstPage.nextCursor,
    }),
    {
      ids: [third, fourth],
      hasMore: false,
    },
  );
});

test('card_nft_2 unrevealed pagination scans sparse pools in id order after cursor', () => {
  const [first, second, third, fourth, fifth] = firstNUnrevealedEligibleIds(5);
  const superRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!;
  const pixelMosaicId = CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS[0]!;

  assert.deepEqual(
    paginateCardNft2UnrevealedCandidateIds({
      rawPool: [fifth, 0, fourth, fourth, superRareId, first, pixelMosaicId, second, 'not-a-card', third],
      limit: 2,
      cursor: second,
    }),
    {
      ids: [third, fourth],
      nextCursor: fourth,
      hasMore: true,
    },
  );
});

test('card_nft_2 unrevealed candidates fall back to the full id range when pool is missing', () => {
  const candidates = cardNft2UnrevealedCandidateIds(undefined, 24);

  assert.equal(candidates.length > 2, true);
  assert.deepEqual(
    paginateCardNft2UnrevealedCandidateIds({
      rawPool: undefined,
      maxCardId: 24,
      limit: 2,
    }),
    {
      ids: [candidates[0]!, candidates[1]!],
      nextCursor: candidates[1]!,
      hasMore: true,
    },
  );
});
