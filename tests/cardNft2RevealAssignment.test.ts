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

function firstNonBucketId(): number {
  for (let id = 1; id <= CARD_NFT_2_MAX_CARD_ID; id += 1) {
    if (!CARD_NFT_2_COMMON_CARD_ID_SET.has(id) && !CARD_NFT_2_SUPER_RARE_CARD_ID_SET.has(id)) {
      return id;
    }
  }
  throw new Error('Expected at least one non-bucket card_nft_2 id');
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

test('card_nft_2 assignment picks common, super rare, and full-pool random ids, then shuffles', async () => {
  const commonId = CARD_NFT_2_COMMON_CARD_IDS[0]!;
  const superRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[0]!;
  const extraSuperRareId = CARD_NFT_2_SUPER_RARE_CARD_IDS[1]!;
  const pool = [commonId, superRareId, extraSuperRareId];

  const result = await pickDudeIdsForAssignment({
    dropFamily: 'card_nft_2',
    itemsPerBox: 3,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    pool,
    isAssigned: () => false,
    randomInt: sequenceRandomInt([0, 0, 0, 0, 1]),
  });

  assert.deepEqual(result.chosen, [extraSuperRareId, commonId, superRareId]);
  assert.equal(result.chosen.some((id) => CARD_NFT_2_COMMON_CARD_ID_SET.has(id)), true);
  assert.equal(result.chosen.filter((id) => CARD_NFT_2_SUPER_RARE_CARD_ID_SET.has(id)).length, 2);
  assert.deepEqual(pool, []);
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

test('card_nft_2 assignment reports bucket context when a required bucket is exhausted', async () => {
  const pool = [CARD_NFT_2_COMMON_CARD_IDS[0]!, firstNonBucketId()];

  await assert.rejects(
    () =>
      pickDudeIdsForAssignment({
        dropFamily: 'card_nft_2',
        itemsPerBox: 3,
        maxDudeId: CARD_NFT_2_MAX_CARD_ID,
        pool,
        isAssigned: () => false,
      }),
    (err) => err instanceof DudeAssignmentPoolExhaustedError && err.bucket === 'super_rare',
  );
});
