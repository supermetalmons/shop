import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pickDudeIdsForAssignment, validateDudeIdsForAssignment } from '../functions/src/assignDudesPicker.ts';
import { CARD_NFT_2_COMMON_CARD_ID_VALUES } from '../functions/src/shared/cardNft2CommonIds.ts';
import {
  CARD_NFT_2_AD_HOC_CURATED_CARD_IDS,
  CARD_NFT_2_AD_HOC_CURATED_CARD_ID_SET,
  CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS,
  CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET,
  CARD_NFT_2_COMMON_CARD_IDS,
  CARD_NFT_2_COMMON_CARD_ID_SET,
  CARD_NFT_2_MAX_CARD_ID,
  CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS,
  CARD_NFT_2_PIXEL_MOSAIC_CARD_ID_SET,
  CARD_NFT_2_SUPER_RARE_CARD_IDS,
  CARD_NFT_2_SUPER_RARE_CARD_ID_SET,
} from '../functions/src/cardNft2RevealIds.ts';

type CardNft2AssignmentCategory = 'as_good_as_super_rare' | 'common' | 'neither';

const EXPECTED_CARD_NFT_2_AD_HOC_CURATED_CARD_IDS = [
  38, 51, 60, 62, 65, 69, 70, 75, 110, 111, 130, 131, 133, 200, 202, 218, 236, 239, 240,
  258, 296, 306, 307, 312, 325, 330, 341, 349, 350, 351, 358, 359, 360, 363, 364, 366, 368,
  376, 378, 380, 381, 382, 386, 387, 388, 398, 400, 402, 461, 537, 569, 584, 588, 607,
  635, 652, 657, 659, 660, 773, 818, 832, 833, 841, 844, 910, 1014, 1092, 1100, 1104,
  1117, 1183, 3300,
];
const EXPECTED_CARD_NFT_2_COMMON_CARD_IDS_SHA256 =
  'fb8354b3f0cf919a620bc7b8e086b825f80a1d213b63aa07ce433d10218c99df';

function sequenceRandomInt(values: number[]): (maxExclusive: number) => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

function firstNNonBucketIds(count: number): number[] {
  const ids: number[] = [];
  for (let id = 1; id <= CARD_NFT_2_MAX_CARD_ID && ids.length < count; id += 1) {
    if (
      !CARD_NFT_2_COMMON_CARD_ID_SET.has(id) &&
      !CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET.has(id)
    ) {
      ids.push(id);
    }
  }
  if (ids.length !== count) throw new Error(`Expected at least ${count} non-bucket card_nft_2 ids`);
  return ids;
}

function firstNonBucketId(): number {
  return firstNNonBucketIds(1)[0]!;
}

function cardNft2AssignmentCategory(id: number): CardNft2AssignmentCategory {
  if (CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET.has(id)) return 'as_good_as_super_rare';
  if (CARD_NFT_2_COMMON_CARD_ID_SET.has(id)) return 'common';
  return 'neither';
}

function countAssignmentCategories(ids: readonly number[]): Record<CardNft2AssignmentCategory, number> {
  const counts = { as_good_as_super_rare: 0, common: 0, neither: 0 };
  for (const id of ids) {
    counts[cardNft2AssignmentCategory(id)] += 1;
  }
  return counts;
}

function generatedPixelMosaicIds(): number[] {
  return Array.from({ length: 111 }, (_, index) => 11001 + index);
}

test('function-local card_nft_2 reveal ids match canonical sources and are valid', () => {
  const expectedAsGoodAsSuperRareIds = [
    ...new Set([
      ...CARD_NFT_2_SUPER_RARE_CARD_IDS,
      ...CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS,
      ...CARD_NFT_2_AD_HOC_CURATED_CARD_IDS,
    ]),
  ];

  assert.equal(CARD_NFT_2_COMMON_CARD_IDS, CARD_NFT_2_COMMON_CARD_ID_VALUES);
  assert.equal(Object.isFrozen(CARD_NFT_2_COMMON_CARD_IDS), true);
  assert.equal(CARD_NFT_2_COMMON_CARD_IDS.length, 4_983);
  assert.equal(
    createHash('sha256')
      .update(CARD_NFT_2_COMMON_CARD_IDS.join(','))
      .digest('hex'),
    EXPECTED_CARD_NFT_2_COMMON_CARD_IDS_SHA256,
  );
  assert.deepEqual([...CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS], generatedPixelMosaicIds());
  assert.deepEqual([...CARD_NFT_2_AD_HOC_CURATED_CARD_IDS], EXPECTED_CARD_NFT_2_AD_HOC_CURATED_CARD_IDS);
  assert.deepEqual([...CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS], expectedAsGoodAsSuperRareIds);
  assert.equal(CARD_NFT_2_AD_HOC_CURATED_CARD_IDS.length, 73);

  assert.equal(CARD_NFT_2_COMMON_CARD_ID_SET.size, CARD_NFT_2_COMMON_CARD_IDS.length);
  assert.equal(CARD_NFT_2_PIXEL_MOSAIC_CARD_ID_SET.size, CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS.length);
  assert.equal(CARD_NFT_2_SUPER_RARE_CARD_ID_SET.size, CARD_NFT_2_SUPER_RARE_CARD_IDS.length);
  assert.equal(CARD_NFT_2_AD_HOC_CURATED_CARD_ID_SET.size, CARD_NFT_2_AD_HOC_CURATED_CARD_IDS.length);
  assert.equal(CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET.size, CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS.length);
  assert.equal(
    CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS.length,
    CARD_NFT_2_SUPER_RARE_CARD_IDS.length +
      CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS.length +
      CARD_NFT_2_AD_HOC_CURATED_CARD_IDS.length,
  );
  for (const cardId of [
    ...CARD_NFT_2_COMMON_CARD_IDS,
    ...CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS,
    ...CARD_NFT_2_SUPER_RARE_CARD_IDS,
    ...CARD_NFT_2_AD_HOC_CURATED_CARD_IDS,
  ]) {
    assert.equal(Number.isInteger(cardId), true);
    assert.equal(cardId >= 1, true);
    assert.equal(cardId <= CARD_NFT_2_MAX_CARD_ID, true);
  }
  for (const cardId of CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS) {
    assert.equal(CARD_NFT_2_COMMON_CARD_ID_SET.has(cardId), false);
  }
  for (const cardId of CARD_NFT_2_SUPER_RARE_CARD_IDS) {
    assert.equal(CARD_NFT_2_COMMON_CARD_ID_SET.has(cardId), false);
  }
  for (const cardId of CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS) {
    assert.equal(CARD_NFT_2_COMMON_CARD_ID_SET.has(cardId), false);
    assert.equal(CARD_NFT_2_SUPER_RARE_CARD_ID_SET.has(cardId), false);
  }
});

test('card_nft_2 assignment can pick ad hoc curated ids for the as-good first slot', async () => {
  const curatedA = CARD_NFT_2_AD_HOC_CURATED_CARD_IDS[0]!;
  const curatedB = CARD_NFT_2_AD_HOC_CURATED_CARD_IDS[1]!;
  const curatedC = CARD_NFT_2_AD_HOC_CURATED_CARD_IDS[2]!;
  const commonId = CARD_NFT_2_COMMON_CARD_IDS[0]!;
  const superRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!;
  const neitherId = firstNonBucketId();
  const pool = [curatedA, superRareId, curatedB, commonId, neitherId, curatedC];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([0, 0, 0, 2, 1]),
  });

  assert.deepEqual(result.chosen, [curatedA, commonId, neitherId]);
  assert.equal(result.chosen.some((id) => CARD_NFT_2_AD_HOC_CURATED_CARD_ID_SET.has(id)), true);
  assert.equal(result.chosen.includes(superRareId), false);
  assert.equal(result.candidatesChecked, 3);
  assert.deepEqual(pool, [superRareId, curatedB, curatedC]);
});

test('card_nft_2 assignment picks as-good, common, and neither ids first, then shuffles', async () => {
  const commonId = CARD_NFT_2_COMMON_CARD_IDS[0]!;
  const superRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!;
  const extraSuperRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[1]!;
  const neitherId = firstNonBucketId();
  const pool = [commonId, superRareId, neitherId, extraSuperRareId];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([0, 0, 0, 2, 1]),
  });

  assert.deepEqual(result.chosen, [superRareId, commonId, neitherId]);
  assert.equal(result.chosen.some((id) => CARD_NFT_2_COMMON_CARD_ID_SET.has(id)), true);
  assert.equal(result.chosen.filter((id) => CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET.has(id)).length, 1);
  assert.equal(result.chosen.some((id) => cardNft2AssignmentCategory(id) === 'neither'), true);
  assert.deepEqual(pool, [extraSuperRareId]);
});

test('card_nft_2 assignment skips stale assigned ids and removes them from the pool', async () => {
  const staleSuperRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!;
  const liveSuperRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[1]!;
  const commonId = CARD_NFT_2_COMMON_CARD_IDS[0]!;
  const randomId = firstNonBucketId();
  const pool = [staleSuperRareId, liveSuperRareId, commonId, randomId];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: (id) => id === staleSuperRareId,
    randomInt: sequenceRandomInt([0, 0, 0, 0, 0, 0]),
  });

  assert.equal(result.staleAssigned, 1);
  assert.deepEqual(result.staleDudeIds, [staleSuperRareId]);
  assert.equal(result.candidatesChecked, 4);
  assert.equal(result.chosen.includes(staleSuperRareId), false);
  assert.equal(result.chosen.includes(liveSuperRareId), true);
  assert.equal(result.chosen.includes(commonId), true);
  assert.equal(result.chosen.includes(randomId), true);
  assert.deepEqual(pool, []);
});

test('card_nft_2 assignment uses common surplus before as-good surplus after neither is exhausted', async () => {
  const pool = [
    CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!,
    CARD_NFT_2_COMMON_CARD_IDS[0]!,
    CARD_NFT_2_COMMON_CARD_IDS[1]!,
    CARD_NFT_2_COMMON_CARD_IDS[2]!,
    CARD_NFT_2_SUPER_RARE_CARD_IDS[1]!,
    CARD_NFT_2_COMMON_CARD_IDS[3]!,
  ];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([0, 0, 0, 2, 1]),
  });

  assert.deepEqual(countAssignmentCategories(result.chosen), { as_good_as_super_rare: 1, common: 2, neither: 0 });
  assert.deepEqual(countAssignmentCategories(pool), { as_good_as_super_rare: 1, common: 2, neither: 0 });
});

test('card_nft_2 manifest validation accepts picker output across slot fallback shapes', async () => {
  const [neitherA, neitherB, staleNeither] = firstNNonBucketIds(3);
  const scenarios = [
    {
      name: 'all preferred buckets available',
      pool: [CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!, CARD_NFT_2_COMMON_CARD_IDS[0]!, neitherA!],
      assigned: () => false,
      random: [0, 0, 0, 2, 1],
    },
    {
      name: 'as-good slot unavailable',
      pool: [CARD_NFT_2_COMMON_CARD_IDS[0]!, neitherA!, neitherB!],
      assigned: () => false,
      random: [0, 0, 0, 2, 1],
    },
    {
      name: 'common slot falls back to any card',
      pool: [CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!, neitherA!, CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS[0]!],
      assigned: () => false,
      random: [0, 0, 0, 2, 1],
    },
    {
      name: 'stale preferred extra is skipped',
      pool: [
        CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!,
        CARD_NFT_2_COMMON_CARD_IDS[0]!,
        staleNeither!,
        CARD_NFT_2_COMMON_CARD_IDS[1]!,
        CARD_NFT_2_SUPER_RARE_CARD_IDS[1]!,
      ],
      assigned: (id: number) => id === staleNeither,
      random: [0, 0, 0, 0, 2, 1],
      staleDudeIds: [staleNeither],
    },
  ];

  for (const scenario of scenarios) {
    const pool = [...scenario.pool];
    const result = await pickDudeIdsForAssignment({
      dropFamily: 'card_nft_2',
      itemsPerBox: 3,
      maxDudeId: CARD_NFT_2_MAX_CARD_ID,
      pool,
      isAssigned: scenario.assigned,
      randomInt: sequenceRandomInt(scenario.random),
    });
    assert.deepEqual(result.staleDudeIds, scenario.staleDudeIds || [], scenario.name);

    await validateDudeIdsForAssignment({
      dropFamily: 'card_nft_2',
      itemsPerBox: 3,
      maxDudeId: CARD_NFT_2_MAX_CARD_ID,
      pool: [...scenario.pool],
      dudeIds: result.chosen,
      isAssigned: scenario.assigned,
    });
    assert.equal(result.chosen.length, 3, scenario.name);
  }
});

test('card_nft_2 manifest validation skips reads for verified stale ids', async () => {
  const staleNeitherId = firstNonBucketId();
  const superRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!;
  const commonId = CARD_NFT_2_COMMON_CARD_IDS[0]!;
  const commonExtraId = CARD_NFT_2_COMMON_CARD_IDS[1]!;
  const reads: number[] = [];

  await validateDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool: [superRareId, commonId, staleNeitherId, commonExtraId],
    dudeIds: [superRareId, commonId, commonExtraId],
    knownAssignedDudeIds: [staleNeitherId],
    isAssigned: (id) => {
      reads.push(id);
      return false;
    },
  });

  assert.equal(reads.includes(staleNeitherId), false);
});

test('card_nft_2 assignment uses common extras before rare-like extras', async () => {
  const extraSuperRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[1]!;
  const pixelMosaicId = CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS[0]!;
  const pool = [
    CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!,
    CARD_NFT_2_COMMON_CARD_IDS[0]!,
    CARD_NFT_2_COMMON_CARD_IDS[1]!,
    extraSuperRareId,
    pixelMosaicId,
  ];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([0, 0, 0, 0, 0]),
  });

  assert.deepEqual(countAssignmentCategories(result.chosen), { as_good_as_super_rare: 1, common: 2, neither: 0 });
  assert.deepEqual(pool, [extraSuperRareId, pixelMosaicId]);
});

test('card_nft_2 assignment uses as-good surplus when neither and common extras are exhausted', async () => {
  const pool = [
    CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!,
    CARD_NFT_2_COMMON_CARD_IDS[0]!,
    CARD_NFT_2_SUPER_RARE_CARD_IDS[1]!,
  ];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([0, 0, 0, 2, 1]),
  });

  assert.deepEqual(countAssignmentCategories(result.chosen), { as_good_as_super_rare: 2, common: 1, neither: 0 });
  assert.deepEqual(pool, []);
});

test('card_nft_2 assignment continues when no as-good ids remain', async () => {
  const [firstNeitherId, secondNeitherId] = firstNNonBucketIds(2);
  const pool = [CARD_NFT_2_COMMON_CARD_IDS[0]!, firstNeitherId!, secondNeitherId!];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([0, 0, 0, 2, 1]),
  });

  assert.deepEqual(countAssignmentCategories(result.chosen), { as_good_as_super_rare: 0, common: 1, neither: 2 });
  assert.deepEqual(pool, []);
});

test('card_nft_2 assignment can pick pixel mosaic for the as-good slot while super rares remain', async () => {
  const superRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!;
  const pixelMosaicId = CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS[0]!;
  const pool = [superRareId, CARD_NFT_2_COMMON_CARD_IDS[0]!, firstNonBucketId(), pixelMosaicId];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([1, 0, 0, 2, 1]),
  });

  assert.equal(result.chosen.includes(superRareId), false);
  assert.equal(result.chosen.includes(pixelMosaicId), true);
  assert.deepEqual(countAssignmentCategories(result.chosen), { as_good_as_super_rare: 1, common: 1, neither: 1 });
  assert.deepEqual(pool, [superRareId]);
});

test('card_nft_2 assignment uses pixel mosaic for the as-good slot when it is the only as-good id', async () => {
  const pixelMosaicId = CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS[0]!;
  const neitherId = firstNonBucketId();
  const pool = [pixelMosaicId, CARD_NFT_2_COMMON_CARD_IDS[0]!, neitherId];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([0, 0, 0, 1]),
  });

  assert.equal(result.chosen.includes(pixelMosaicId), true);
  assert.deepEqual(countAssignmentCategories(result.chosen), { as_good_as_super_rare: 1, common: 1, neither: 1 });
  assert.deepEqual(pool, []);
});

test('card_nft_2 assignment uses pixel mosaic extras only after other buckets are exhausted', async () => {
  const pool = [
    CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS[0]!,
    CARD_NFT_2_COMMON_CARD_IDS[0]!,
    CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS[1]!,
  ];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([0, 0, 0, 0, 0]),
  });

  assert.deepEqual(countAssignmentCategories(result.chosen), { as_good_as_super_rare: 2, common: 1, neither: 0 });
  assert.deepEqual(pool, []);
});

test('card_nft_2 assignment skips stale neither ids and falls back to surplus', async () => {
  const staleNeitherId = firstNonBucketId();
  const pool = [
    CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!,
    CARD_NFT_2_COMMON_CARD_IDS[0]!,
    staleNeitherId,
    CARD_NFT_2_COMMON_CARD_IDS[1]!,
    CARD_NFT_2_COMMON_CARD_IDS[2]!,
    CARD_NFT_2_SUPER_RARE_CARD_IDS[1]!,
    CARD_NFT_2_COMMON_CARD_IDS[3]!,
  ];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: (id) => id === staleNeitherId,
    randomInt: sequenceRandomInt([0, 0, 0, 0, 2, 1]),
  });

  assert.equal(result.staleAssigned, 1);
  assert.deepEqual(result.staleDudeIds, [staleNeitherId]);
  assert.equal(result.chosen.includes(staleNeitherId), false);
  assert.equal(pool.includes(staleNeitherId), false);
  assert.deepEqual(countAssignmentCategories(result.chosen), { as_good_as_super_rare: 1, common: 2, neither: 0 });
  assert.deepEqual(countAssignmentCategories(pool), { as_good_as_super_rare: 1, common: 2, neither: 0 });
});

test('card_nft_2 assignment only uses rare-like extras after stale normal extras are removed', async () => {
  const staleNeitherId = firstNonBucketId();
  const staleCommonId = CARD_NFT_2_COMMON_CARD_IDS[1]!;
  const pool = [
    CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!,
    CARD_NFT_2_COMMON_CARD_IDS[0]!,
    staleNeitherId,
    staleCommonId,
    CARD_NFT_2_SUPER_RARE_CARD_IDS[1]!,
  ];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: (id) => id === staleNeitherId || id === staleCommonId,
    randomInt: sequenceRandomInt([0, 0, 0, 0, 0, 0]),
  });

  assert.equal(result.staleAssigned, 2);
  assert.deepEqual(result.staleDudeIds, [staleNeitherId, staleCommonId]);
  assert.equal(result.chosen.includes(staleNeitherId), false);
  assert.equal(result.chosen.includes(staleCommonId), false);
  assert.deepEqual(countAssignmentCategories(result.chosen), { as_good_as_super_rare: 2, common: 1, neither: 0 });
  assert.deepEqual(pool, []);
});

test('card_nft_2 assignment can drain a live-shaped pool with curated as-good ids', async () => {
  const pool = [
    ...CARD_NFT_2_SUPER_RARE_CARD_IDS.slice(0, 2272),
    ...CARD_NFT_2_AD_HOC_CURATED_CARD_IDS,
    ...CARD_NFT_2_COMMON_CARD_IDS.slice(0, 3142),
    ...firstNNonBucketIds(1851),
  ];
  const packCount = Math.floor(pool.length / 3);
  const expectedAssignedCounts = countAssignmentCategories(pool);
  const assignedCounts = { as_good_as_super_rare: 0, common: 0, neither: 0 };

  assert.equal(packCount, 2446);
  assert.equal(pool.length % 3, 0);

  for (let packIndex = 0; packIndex < packCount; packIndex += 1) {
    const result = await pickDudeIdsForAssignment({
      dropFamily: 'card_nft_2',
      itemsPerBox: 3,
      maxDudeId: CARD_NFT_2_MAX_CARD_ID,
      pool,
      isAssigned: () => false,
      randomInt: () => 0,
    });

    const packCounts = countAssignmentCategories(result.chosen);
    assert.equal(
      packCounts.as_good_as_super_rare <= 1,
      true,
      `pack ${packIndex} used as-good outside the reserved slot`,
    );
    assert.equal(packCounts.common >= 1, true, `pack ${packIndex} missing common`);
    assignedCounts.as_good_as_super_rare += packCounts.as_good_as_super_rare;
    assignedCounts.common += packCounts.common;
    assignedCounts.neither += packCounts.neither;
  }

  assert.deepEqual(assignedCounts, expectedAssignedCounts);
  assert.deepEqual(pool, []);
});

test('non-card_nft_2 assignment keeps existing fully random pick order', async () => {
  const pool = [1, 2, 3, 4, 5];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'poncho_drifella',
    itemsPerBox: 3,
    maxDudeId: 5,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([4, 0, 1]),
  });

  assert.deepEqual(result.chosen, [5, 1, 3]);
  assert.deepEqual(pool, [2, 4]);
});

test('non-card_nft_2 assignment does not filter ad hoc curated card_nft_2 ids', async () => {
  const curatedId = CARD_NFT_2_AD_HOC_CURATED_CARD_IDS[0]!;
  const pool = [curatedId, 2, 3];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'poncho_drifella',
    itemsPerBox: 1,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([0]),
  });

  assert.deepEqual(result.chosen, [curatedId]);
  assert.deepEqual(pool, [2, 3]);
});

test('card_nft_2 assignment skips stale super rare ids and falls through to pixel mosaic', async () => {
  const staleSuperRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!;
  const pixelMosaicId = CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS[0]!;
  const neitherId = firstNonBucketId();
  const pool = [staleSuperRareId, pixelMosaicId, CARD_NFT_2_COMMON_CARD_IDS[0]!, neitherId];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: (id) => id === staleSuperRareId,
    randomInt: sequenceRandomInt([0, 0, 0, 1]),
  });

  assert.equal(result.staleAssigned, 1);
  assert.deepEqual(result.staleDudeIds, [staleSuperRareId]);
  assert.equal(result.chosen.includes(staleSuperRareId), false);
  assert.equal(result.chosen.includes(pixelMosaicId), true);
  assert.deepEqual(countAssignmentCategories(result.chosen), { as_good_as_super_rare: 1, common: 1, neither: 1 });
  assert.deepEqual(pool, []);
});

test('card_nft_2 assignment skips stale pixel mosaic ids left in an existing live pool', async () => {
  const stalePixelMosaicId = CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS[0]!;
  const livePixelMosaicId = CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS[1]!;
  const commonId = CARD_NFT_2_COMMON_CARD_IDS[0]!;
  const neitherId = firstNonBucketId();
  const pool = [stalePixelMosaicId, livePixelMosaicId, commonId, neitherId];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: (id) => id === stalePixelMosaicId,
    randomInt: sequenceRandomInt([0, 0, 0, 0, 0]),
  });

  assert.equal(result.staleAssigned, 1);
  assert.deepEqual(result.staleDudeIds, [stalePixelMosaicId]);
  assert.equal(result.chosen.includes(stalePixelMosaicId), false);
  assert.equal(result.chosen.includes(livePixelMosaicId), true);
  assert.deepEqual(countAssignmentCategories(result.chosen), { as_good_as_super_rare: 1, common: 1, neither: 1 });
  assert.deepEqual(pool, []);
});

test('card_nft_2 assignment falls back to any remaining card when common ids are exhausted', async () => {
  const pool = [CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!, firstNonBucketId(), CARD_NFT_2_PIXEL_MOSAIC_CARD_IDS[0]!];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([0, 0, 0, 2, 1]),
  });

  assert.deepEqual(countAssignmentCategories(result.chosen), { as_good_as_super_rare: 2, common: 0, neither: 1 });
  assert.deepEqual(pool, []);
});
