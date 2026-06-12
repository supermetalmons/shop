import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DudeAssignmentPoolExhaustedError,
  pickDudeIdsForAssignment,
} from '../functions/src/assignDudesPicker.ts';
import {
  CARD_NFT_2_COMMON_CARD_IDS,
  CARD_NFT_2_COMMON_CARD_ID_SET,
  CARD_NFT_2_MAX_CARD_ID,
  CARD_NFT_2_SUPER_RARE_CARD_IDS,
  CARD_NFT_2_SUPER_RARE_CARD_ID_SET,
} from '../functions/src/cardNft2RevealIds.ts';

function sequenceRandomInt(values: number[]): (maxExclusive: number) => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

function firstNNonBucketIds(count: number): number[] {
  const ids: number[] = [];
  for (let id = 1; id <= CARD_NFT_2_MAX_CARD_ID && ids.length < count; id += 1) {
    if (!CARD_NFT_2_COMMON_CARD_ID_SET.has(id) && !CARD_NFT_2_SUPER_RARE_CARD_ID_SET.has(id)) {
      ids.push(id);
    }
  }
  if (ids.length !== count) throw new Error(`Expected at least ${count} non-bucket card_nft_2 ids`);
  return ids;
}

function firstNonBucketId(): number {
  return firstNNonBucketIds(1)[0]!;
}

function cardNft2Category(id: number): 'common' | 'neither' | 'super_rare' {
  if (CARD_NFT_2_SUPER_RARE_CARD_ID_SET.has(id)) return 'super_rare';
  if (CARD_NFT_2_COMMON_CARD_ID_SET.has(id)) return 'common';
  return 'neither';
}

function countCategories(ids: readonly number[]): Record<'common' | 'neither' | 'super_rare', number> {
  const counts = { common: 0, neither: 0, super_rare: 0 };
  for (const id of ids) {
    counts[cardNft2Category(id)] += 1;
  }
  return counts;
}

function readCanonicalIdList(path: string): number[] {
  const raw = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as unknown[];
  return raw.map((value) => Number(value));
}

test('function-local card_nft_2 reveal ids match canonical sources and are valid', () => {
  assert.deepEqual(
    [...CARD_NFT_2_COMMON_CARD_IDS],
    readCanonicalIdList('../src/lib/cardNft2CommonIds.json'),
  );
  assert.deepEqual(
    [...CARD_NFT_2_SUPER_RARE_CARD_IDS],
    readCanonicalIdList('../public/super_rare.json'),
  );

  assert.equal(CARD_NFT_2_COMMON_CARD_ID_SET.size, CARD_NFT_2_COMMON_CARD_IDS.length);
  assert.equal(CARD_NFT_2_SUPER_RARE_CARD_ID_SET.size, CARD_NFT_2_SUPER_RARE_CARD_IDS.length);
  for (const cardId of [...CARD_NFT_2_COMMON_CARD_IDS, ...CARD_NFT_2_SUPER_RARE_CARD_IDS]) {
    assert.equal(Number.isInteger(cardId), true);
    assert.equal(cardId >= 1, true);
    assert.equal(cardId <= CARD_NFT_2_MAX_CARD_ID, true);
  }
  for (const cardId of CARD_NFT_2_SUPER_RARE_CARD_IDS) {
    assert.equal(CARD_NFT_2_COMMON_CARD_ID_SET.has(cardId), false);
  }
});

test('card_nft_2 assignment picks common, super rare, and neither ids first, then shuffles', async () => {
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
  assert.equal(result.chosen.filter((id) => CARD_NFT_2_SUPER_RARE_CARD_ID_SET.has(id)).length, 1);
  assert.equal(result.chosen.some((id) => cardNft2Category(id) === 'neither'), true);
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
  assert.equal(result.candidatesChecked, 4);
  assert.equal(result.chosen.includes(staleSuperRareId), false);
  assert.equal(result.chosen.includes(liveSuperRareId), true);
  assert.equal(result.chosen.includes(commonId), true);
  assert.equal(result.chosen.includes(randomId), true);
  assert.deepEqual(pool, []);
});

test('card_nft_2 assignment uses common surplus before super rare surplus after neither is exhausted', async () => {
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

  assert.deepEqual(countCategories(result.chosen), { common: 2, neither: 0, super_rare: 1 });
  assert.deepEqual(countCategories(pool), { common: 2, neither: 0, super_rare: 1 });
});

test('card_nft_2 assignment uses super rare surplus when neither and common extras are exhausted', async () => {
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

  assert.deepEqual(countCategories(result.chosen), { common: 1, neither: 0, super_rare: 2 });
  assert.deepEqual(pool, []);
});

test('card_nft_2 assignment continues when no super rare ids remain', async () => {
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

  assert.deepEqual(countCategories(result.chosen), { common: 1, neither: 2, super_rare: 0 });
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
  assert.equal(result.chosen.includes(staleNeitherId), false);
  assert.equal(pool.includes(staleNeitherId), false);
  assert.deepEqual(countCategories(result.chosen), { common: 2, neither: 0, super_rare: 1 });
  assert.deepEqual(countCategories(pool), { common: 2, neither: 0, super_rare: 1 });
});

test('card_nft_2 assignment can drain the current live-shaped pool without requiring extra super rares', async () => {
  const packCount = 2422;
  const pool = [
    ...CARD_NFT_2_SUPER_RARE_CARD_IDS.slice(0, 2272),
    ...CARD_NFT_2_COMMON_CARD_IDS.slice(0, 3142),
    ...firstNNonBucketIds(1852),
  ];
  const assignedCounts = { common: 0, neither: 0, super_rare: 0 };

  for (let packIndex = 0; packIndex < packCount; packIndex += 1) {
    const result = await pickDudeIdsForAssignment({
      dropFamily: 'card_nft_2',
      itemsPerBox: 3,
      maxDudeId: CARD_NFT_2_MAX_CARD_ID,
      pool,
      isAssigned: () => false,
      randomInt: () => 0,
    });

    const packCounts = countCategories(result.chosen);
    assert.equal(packCounts.super_rare <= 1, true, `pack ${packIndex} used super rare outside the reserved slot`);
    assert.equal(packCounts.common >= 1, true, `pack ${packIndex} missing common`);
    assignedCounts.common += packCounts.common;
    assignedCounts.neither += packCounts.neither;
    assignedCounts.super_rare += packCounts.super_rare;
  }

  assert.deepEqual(assignedCounts, {
    common: 3142,
    neither: 1852,
    super_rare: 2272,
  });
  assert.deepEqual(pool, []);
});

test('card_nft_2 assignment can drain a pristine full pool by using final super rare surplus', async () => {
  const packCount = 3711;
  const pool = Array.from({ length: CARD_NFT_2_MAX_CARD_ID }, (_, index) => index + 1);
  const assignedCounts = { common: 0, neither: 0, super_rare: 0 };

  for (let packIndex = 0; packIndex < packCount; packIndex += 1) {
    const result = await pickDudeIdsForAssignment({
      dropFamily: 'card_nft_2',
      itemsPerBox: 3,
      maxDudeId: CARD_NFT_2_MAX_CARD_ID,
      pool,
      isAssigned: () => false,
      randomInt: () => 0,
    });

    const packCounts = countCategories(result.chosen);
    assert.equal(packCounts.super_rare >= 1, true, `pack ${packIndex} missing super rare`);
    assert.equal(packCounts.common >= 1, true, `pack ${packIndex} missing common`);
    assignedCounts.common += packCounts.common;
    assignedCounts.neither += packCounts.neither;
    assignedCounts.super_rare += packCounts.super_rare;
  }

  assert.deepEqual(assignedCounts, {
    common: CARD_NFT_2_COMMON_CARD_IDS.length,
    neither: 2136,
    super_rare: CARD_NFT_2_SUPER_RARE_CARD_IDS.length,
  });
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

test('card_nft_2 assignment skips stale super rare ids and continues without them', async () => {
  const staleSuperRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!;
  const [firstNeitherId, secondNeitherId] = firstNNonBucketIds(2);
  const pool = [staleSuperRareId, CARD_NFT_2_COMMON_CARD_IDS[0]!, firstNeitherId!, secondNeitherId!];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: (id) => id === staleSuperRareId,
    randomInt: sequenceRandomInt([0, 0, 0, 0, 2, 1]),
  });

  assert.equal(result.staleAssigned, 1);
  assert.equal(result.chosen.includes(staleSuperRareId), false);
  assert.deepEqual(countCategories(result.chosen), { common: 1, neither: 2, super_rare: 0 });
  assert.deepEqual(pool, []);
});

test('card_nft_2 assignment reports common bucket context when common ids are exhausted', async () => {
  const pool = [CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!, firstNonBucketId()];

  await assert.rejects(
    () =>
      pickDudeIdsForAssignment({
        dropFamily: 'card_nft_2',
        itemsPerBox: 3,
        maxDudeId: CARD_NFT_2_MAX_CARD_ID,
        pool,
        isAssigned: () => false,
      }),
    (err) => err instanceof DudeAssignmentPoolExhaustedError && err.bucket === 'common',
  );
});
