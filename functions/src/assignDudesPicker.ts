import { randomInt as cryptoRandomInt } from 'crypto';
import { CARD_NFT_2_COMMON_CARD_ID_SET, CARD_NFT_2_SUPER_RARE_CARD_ID_SET } from './cardNft2RevealIds.js';

export type DudeAssignmentBucket = 'any' | 'common' | 'neither' | 'super_rare';

export type DudeAssignmentPickResult = {
  chosen: number[];
  candidatesChecked: number;
  staleAssigned: number;
};

export type DudeAssignmentPickerArgs = {
  dropFamily: string;
  itemsPerBox: number;
  maxDudeId: number;
  pool: number[];
  isAssigned: (dudeId: number) => boolean | Promise<boolean>;
  randomInt?: (maxExclusive: number) => number;
};

export class DudeAssignmentPoolExhaustedError extends Error {
  readonly bucket: DudeAssignmentBucket;
  readonly chosen: readonly number[];
  readonly candidatesChecked: number;
  readonly staleAssigned: number;
  readonly poolLen: number;

  constructor(args: {
    bucket: DudeAssignmentBucket;
    chosen: readonly number[];
    candidatesChecked: number;
    staleAssigned: number;
    poolLen: number;
  }) {
    super(
      args.bucket === 'any'
        ? 'No dudes remaining to assign'
        : args.bucket === 'neither'
          ? 'No neither dudes remaining to assign'
        : `No ${args.bucket === 'super_rare' ? 'super rare' : args.bucket} dudes remaining to assign`,
    );
    this.name = 'DudeAssignmentPoolExhaustedError';
    this.bucket = args.bucket;
    this.chosen = [...args.chosen];
    this.candidatesChecked = args.candidatesChecked;
    this.staleAssigned = args.staleAssigned;
    this.poolLen = args.poolLen;
  }
}

function defaultRandomInt(maxExclusive: number): number {
  return cryptoRandomInt(0, maxExclusive);
}

function boundedRandomIndex(randomInt: (maxExclusive: number) => number, maxExclusive: number): number {
  const index = Math.floor(Number(randomInt(maxExclusive)));
  if (!Number.isFinite(index) || index < 0) return 0;
  if (index >= maxExclusive) return maxExclusive - 1;
  return index;
}

function indexesForBucket(pool: readonly number[], bucket: DudeAssignmentBucket, maxDudeId: number): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < pool.length; i += 1) {
    const dudeId = pool[i];
    if (!Number.isFinite(dudeId) || dudeId < 1 || dudeId > maxDudeId) continue;
    if (bucket === 'super_rare' && !CARD_NFT_2_SUPER_RARE_CARD_ID_SET.has(dudeId)) continue;
    if (bucket === 'common' && !CARD_NFT_2_COMMON_CARD_ID_SET.has(dudeId)) continue;
    if (
      bucket === 'neither' &&
      (CARD_NFT_2_SUPER_RARE_CARD_ID_SET.has(dudeId) || CARD_NFT_2_COMMON_CARD_ID_SET.has(dudeId))
    ) {
      continue;
    }
    indexes.push(i);
  }
  return indexes;
}

async function takeRandomAvailableDude(args: {
  bucket: DudeAssignmentBucket;
  chosen: number[];
  maxDudeId: number;
  pool: number[];
  randomInt: (maxExclusive: number) => number;
  isAssigned: (dudeId: number) => boolean | Promise<boolean>;
  stats: { candidatesChecked: number; staleAssigned: number };
}): Promise<number> {
  while (true) {
    const candidateIndexes = indexesForBucket(args.pool, args.bucket, args.maxDudeId);
    if (!candidateIndexes.length) {
      throw new DudeAssignmentPoolExhaustedError({
        bucket: args.bucket,
        chosen: args.chosen,
        candidatesChecked: args.stats.candidatesChecked,
        staleAssigned: args.stats.staleAssigned,
        poolLen: args.pool.length,
      });
    }

    const candidatePoolIndex = candidateIndexes[boundedRandomIndex(args.randomInt, candidateIndexes.length)]!;
    const [candidate] = args.pool.splice(candidatePoolIndex, 1);
    args.stats.candidatesChecked += 1;

    if (!Number.isFinite(candidate) || candidate < 1 || candidate > args.maxDudeId) continue;
    if (await args.isAssigned(candidate)) {
      args.stats.staleAssigned += 1;
      continue;
    }

    return candidate;
  }
}

function shuffleInPlace(values: number[], randomInt: (maxExclusive: number) => number): void {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = boundedRandomIndex(randomInt, i + 1);
    if (i === j) continue;
    const value = values[i]!;
    values[i] = values[j]!;
    values[j] = value;
  }
}

function countBucketCandidates(pool: readonly number[], bucket: 'common' | 'super_rare', maxDudeId: number): number {
  return indexesForBucket(pool, bucket, maxDudeId).length;
}

function chooseCardNft2FlexibleFallbackBucket(args: {
  chosenCount: number;
  itemsPerBox: number;
  maxDudeId: number;
  pool: readonly number[];
}): 'common' | 'super_rare' | null {
  const slotsLeftInCurrentPack = Math.max(1, args.itemsPerBox - args.chosenCount);
  const futurePacks = Math.max(0, Math.floor((args.pool.length - slotsLeftInCurrentPack) / args.itemsPerBox));
  if (countBucketCandidates(args.pool, 'common', args.maxDudeId) > futurePacks) return 'common';
  if (countBucketCandidates(args.pool, 'super_rare', args.maxDudeId) > futurePacks) return 'super_rare';
  return null;
}

function throwCardNft2FlexibleExtraExhausted(args: {
  chosen: readonly number[];
  pool: readonly number[];
  stats: { candidatesChecked: number; staleAssigned: number };
}): never {
  throw new DudeAssignmentPoolExhaustedError({
    bucket: 'any',
    chosen: args.chosen,
    candidatesChecked: args.stats.candidatesChecked,
    staleAssigned: args.stats.staleAssigned,
    poolLen: args.pool.length,
  });
}

async function takeCardNft2SuperRareIfAvailable(args: {
  chosen: number[];
  maxDudeId: number;
  pool: number[];
  randomInt: (maxExclusive: number) => number;
  isAssigned: (dudeId: number) => boolean | Promise<boolean>;
  stats: { candidatesChecked: number; staleAssigned: number };
}): Promise<number | null> {
  try {
    return await takeRandomAvailableDude({
      bucket: 'super_rare',
      chosen: args.chosen,
      maxDudeId: args.maxDudeId,
      pool: args.pool,
      randomInt: args.randomInt,
      isAssigned: args.isAssigned,
      stats: args.stats,
    });
  } catch (err) {
    if (err instanceof DudeAssignmentPoolExhaustedError && err.bucket === 'super_rare') return null;
    throw err;
  }
}

async function takeCardNft2FlexibleExtraDude(args: {
  chosen: number[];
  itemsPerBox: number;
  maxDudeId: number;
  pool: number[];
  randomInt: (maxExclusive: number) => number;
  isAssigned: (dudeId: number) => boolean | Promise<boolean>;
  stats: { candidatesChecked: number; staleAssigned: number };
}): Promise<number> {
  try {
    return await takeRandomAvailableDude({
      bucket: 'neither',
      chosen: args.chosen,
      maxDudeId: args.maxDudeId,
      pool: args.pool,
      randomInt: args.randomInt,
      isAssigned: args.isAssigned,
      stats: args.stats,
    });
  } catch (err) {
    if (!(err instanceof DudeAssignmentPoolExhaustedError) || err.bucket !== 'neither') throw err;
  }

  while (true) {
    const bucket = chooseCardNft2FlexibleFallbackBucket({
      chosenCount: args.chosen.length,
      itemsPerBox: args.itemsPerBox,
      maxDudeId: args.maxDudeId,
      pool: args.pool,
    });
    if (!bucket) {
      throwCardNft2FlexibleExtraExhausted({
        chosen: args.chosen,
        pool: args.pool,
        stats: args.stats,
      });
    }

    try {
      return await takeRandomAvailableDude({
        bucket,
        chosen: args.chosen,
        maxDudeId: args.maxDudeId,
        pool: args.pool,
        randomInt: args.randomInt,
        isAssigned: args.isAssigned,
        stats: args.stats,
      });
    } catch (err) {
      if (!(err instanceof DudeAssignmentPoolExhaustedError) || err.bucket !== bucket) throw err;
    }
  }
}

export async function pickDudeIdsForAssignment(args: DudeAssignmentPickerArgs): Promise<DudeAssignmentPickResult> {
  const randomInt = args.randomInt || defaultRandomInt;
  const chosen: number[] = [];
  const stats = { candidatesChecked: 0, staleAssigned: 0 };
  const isCardNft2 = args.dropFamily === 'card_nft_2';

  if (isCardNft2) {
    if (args.itemsPerBox < 2) {
      throw new DudeAssignmentPoolExhaustedError({
        bucket: 'super_rare',
        chosen,
        candidatesChecked: stats.candidatesChecked,
        staleAssigned: stats.staleAssigned,
        poolLen: args.pool.length,
      });
    }

    const superRare = await takeCardNft2SuperRareIfAvailable({
      chosen,
      maxDudeId: args.maxDudeId,
      pool: args.pool,
      randomInt,
      isAssigned: args.isAssigned,
      stats,
    });
    if (superRare !== null) chosen.push(superRare);

    chosen.push(
      await takeRandomAvailableDude({
        bucket: 'common',
        chosen,
        maxDudeId: args.maxDudeId,
        pool: args.pool,
        randomInt,
        isAssigned: args.isAssigned,
        stats,
      }),
    );
  }

  while (chosen.length < args.itemsPerBox) {
    if (isCardNft2) {
      chosen.push(
        await takeCardNft2FlexibleExtraDude({
          chosen,
          itemsPerBox: args.itemsPerBox,
          maxDudeId: args.maxDudeId,
          pool: args.pool,
          randomInt,
          isAssigned: args.isAssigned,
          stats,
        }),
      );
    } else {
      chosen.push(
        await takeRandomAvailableDude({
          bucket: 'any',
          chosen,
          maxDudeId: args.maxDudeId,
          pool: args.pool,
          randomInt,
          isAssigned: args.isAssigned,
          stats,
        }),
      );
    }
  }

  if (isCardNft2) {
    shuffleInPlace(chosen, randomInt);
  }

  return {
    chosen,
    candidatesChecked: stats.candidatesChecked,
    staleAssigned: stats.staleAssigned,
  };
}
