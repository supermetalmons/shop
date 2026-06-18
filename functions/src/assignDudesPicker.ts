import { randomInt as cryptoRandomInt } from 'crypto';
import {
  CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET,
  CARD_NFT_2_COMMON_CARD_ID_SET,
} from './cardNft2RevealIds.js';

export type DudeAssignmentBucket = 'any' | 'as_good_as_super_rare' | 'common' | 'neither';

export type DudeAssignmentPickResult = {
  chosen: number[];
  candidatesChecked: number;
  staleAssigned: number;
  staleDudeIds: number[];
};

export type DudeAssignmentPickerArgs = {
  dropFamily: string;
  itemsPerBox: number;
  maxDudeId: number;
  pool: number[];
  isAssigned: (dudeId: number) => boolean | Promise<boolean>;
  randomInt?: (maxExclusive: number) => number;
};

export type DudeAssignmentValidationArgs = Omit<DudeAssignmentPickerArgs, 'randomInt'> & {
  dudeIds: readonly number[];
  knownAssignedDudeIds?: readonly number[];
};

export class DudeAssignmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DudeAssignmentValidationError';
  }
}

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
        : `No ${bucketDisplayName(args.bucket)} dudes remaining to assign`,
    );
    this.name = 'DudeAssignmentPoolExhaustedError';
    this.bucket = args.bucket;
    this.chosen = [...args.chosen];
    this.candidatesChecked = args.candidatesChecked;
    this.staleAssigned = args.staleAssigned;
    this.poolLen = args.poolLen;
  }
}

type DudeAssignmentStats = {
  candidatesChecked: number;
  staleDudeIds: number[];
};

function defaultRandomInt(maxExclusive: number): number {
  return cryptoRandomInt(0, maxExclusive);
}

function boundedRandomIndex(randomInt: (maxExclusive: number) => number, maxExclusive: number): number {
  const index = Math.floor(Number(randomInt(maxExclusive)));
  if (!Number.isFinite(index) || index < 0) return 0;
  if (index >= maxExclusive) return maxExclusive - 1;
  return index;
}

function bucketDisplayName(bucket: DudeAssignmentBucket): string {
  if (bucket === 'as_good_as_super_rare') return 'as good as super rare';
  return bucket;
}

function dudeMatchesBucket(dudeId: number, bucket: DudeAssignmentBucket, maxDudeId: number): boolean {
  if (!Number.isFinite(dudeId) || dudeId < 1 || dudeId > maxDudeId) return false;
  if (bucket === 'as_good_as_super_rare') return CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET.has(dudeId);
  if (bucket === 'common') return CARD_NFT_2_COMMON_CARD_ID_SET.has(dudeId);
  if (bucket === 'neither') {
    return !CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET.has(dudeId) && !CARD_NFT_2_COMMON_CARD_ID_SET.has(dudeId);
  }
  return true;
}

function indexesForBucket(
  pool: readonly number[],
  bucket: DudeAssignmentBucket,
  maxDudeId: number,
): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < pool.length; i += 1) {
    const dudeId = pool[i];
    if (dudeMatchesBucket(dudeId, bucket, maxDudeId)) indexes.push(i);
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
  stats: DudeAssignmentStats;
}): Promise<number> {
  while (true) {
    const candidateIndexes = indexesForBucket(args.pool, args.bucket, args.maxDudeId);
    if (!candidateIndexes.length) {
      throw new DudeAssignmentPoolExhaustedError({
        bucket: args.bucket,
        chosen: args.chosen,
        candidatesChecked: args.stats.candidatesChecked,
        staleAssigned: args.stats.staleDudeIds.length,
        poolLen: args.pool.length,
      });
    }

    const candidatePoolIndex = candidateIndexes[boundedRandomIndex(args.randomInt, candidateIndexes.length)]!;
    const [candidate] = args.pool.splice(candidatePoolIndex, 1);
    args.stats.candidatesChecked += 1;

    if (!Number.isFinite(candidate) || candidate < 1 || candidate > args.maxDudeId) continue;
    if (await args.isAssigned(candidate)) {
      args.stats.staleDudeIds.push(candidate);
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

type CardNft2AssignableBucket = Exclude<DudeAssignmentBucket, 'any'>;

const CARD_NFT_2_EXTRA_BUCKET_PRIORITY: readonly CardNft2AssignableBucket[] = [
  'neither',
  'common',
  'as_good_as_super_rare',
];

async function runCardNft2AssignmentRules(args: {
  itemsPerBox: number;
  remainingSlots: () => number;
  rejectTooFewSlots: () => never;
  consumeBucketIfAvailable: (bucket: CardNft2AssignableBucket) => Promise<boolean>;
  consumeAny: (slot: string) => Promise<void>;
  rejectExtraExhausted: () => never;
}): Promise<void> {
  if (args.itemsPerBox < 2) args.rejectTooFewSlots();

  await args.consumeBucketIfAvailable('as_good_as_super_rare');

  const consumedCommon = await args.consumeBucketIfAvailable('common');
  if (!consumedCommon) await args.consumeAny('common fallback');

  while (args.remainingSlots() > 0) {
    let consumedExtra = false;
    for (const bucket of CARD_NFT_2_EXTRA_BUCKET_PRIORITY) {
      consumedExtra = await args.consumeBucketIfAvailable(bucket);
      if (consumedExtra) break;
    }
    if (!consumedExtra) args.rejectExtraExhausted();
  }
}

function throwCardNft2FlexibleExtraExhausted(args: {
  chosen: readonly number[];
  pool: readonly number[];
  stats: DudeAssignmentStats;
}): never {
  throw new DudeAssignmentPoolExhaustedError({
    bucket: 'any',
    chosen: args.chosen,
    candidatesChecked: args.stats.candidatesChecked,
    staleAssigned: args.stats.staleDudeIds.length,
    poolLen: args.pool.length,
  });
}

async function takeCardNft2BucketIfAvailable(args: {
  bucket: CardNft2AssignableBucket;
  chosen: number[];
  maxDudeId: number;
  pool: number[];
  randomInt: (maxExclusive: number) => number;
  isAssigned: (dudeId: number) => boolean | Promise<boolean>;
  stats: DudeAssignmentStats;
}): Promise<number | null> {
  try {
    return await takeRandomAvailableDude({
      bucket: args.bucket,
      chosen: args.chosen,
      maxDudeId: args.maxDudeId,
      pool: args.pool,
      randomInt: args.randomInt,
      isAssigned: args.isAssigned,
      stats: args.stats,
    });
  } catch (err) {
    if (err instanceof DudeAssignmentPoolExhaustedError && err.bucket === args.bucket) return null;
    throw err;
  }
}

async function pruneAssignedAndCheckBucketAvailability(args: {
  bucket: DudeAssignmentBucket;
  maxDudeId: number;
  pool: number[];
  isAssigned: (dudeId: number) => boolean | Promise<boolean>;
}): Promise<boolean> {
  for (let index = 0; index < args.pool.length; index += 1) {
    const dudeId = args.pool[index];
    if (!dudeMatchesBucket(dudeId, args.bucket, args.maxDudeId)) continue;
    if (await args.isAssigned(dudeId)) {
      args.pool.splice(index, 1);
      index -= 1;
      continue;
    }
    return true;
  }
  return false;
}

async function takeManifestDudeByIndex(args: {
  slot: string;
  remaining: number[];
  remainingIndex: number;
  pool: number[];
  isAssigned: (dudeId: number) => boolean | Promise<boolean>;
}): Promise<void> {
  const dudeId = args.remaining[args.remainingIndex];
  const poolIndex = args.pool.indexOf(dudeId);
  if (poolIndex < 0) {
    throw new DudeAssignmentValidationError(`Manifest dude ${dudeId} is not available for the ${args.slot} slot`);
  }
  if (await args.isAssigned(dudeId)) {
    throw new DudeAssignmentValidationError(`Manifest dude ${dudeId} is already assigned`);
  }
  args.remaining.splice(args.remainingIndex, 1);
  args.pool.splice(poolIndex, 1);
}

async function takeManifestDudeForBucket(args: {
  bucket: DudeAssignmentBucket;
  maxDudeId: number;
  remaining: number[];
  pool: number[];
  isAssigned: (dudeId: number) => boolean | Promise<boolean>;
}): Promise<boolean> {
  const remainingIndex = args.remaining.findIndex((dudeId) => dudeMatchesBucket(dudeId, args.bucket, args.maxDudeId));
  if (remainingIndex >= 0) {
    await takeManifestDudeByIndex({
      slot: bucketDisplayName(args.bucket),
      remaining: args.remaining,
      remainingIndex,
      pool: args.pool,
      isAssigned: args.isAssigned,
    });
    return true;
  }

  if (
    await pruneAssignedAndCheckBucketAvailability({
      bucket: args.bucket,
      maxDudeId: args.maxDudeId,
      pool: args.pool,
      isAssigned: args.isAssigned,
    })
  ) {
    throw new DudeAssignmentValidationError(`Manifest dudeIds are missing an available ${bucketDisplayName(args.bucket)} dude`);
  }
  return false;
}

async function takeManifestAnyDude(args: {
  slot: string;
  remaining: number[];
  pool: number[];
  isAssigned: (dudeId: number) => boolean | Promise<boolean>;
}): Promise<void> {
  if (!args.remaining.length) {
    throw new DudeAssignmentValidationError(`Manifest dudeIds are missing a dude for the ${args.slot} slot`);
  }
  await takeManifestDudeByIndex({
    slot: args.slot,
    remaining: args.remaining,
    remainingIndex: 0,
    pool: args.pool,
    isAssigned: args.isAssigned,
  });
}

export async function pickDudeIdsForAssignment(args: DudeAssignmentPickerArgs): Promise<DudeAssignmentPickResult> {
  const randomInt = args.randomInt || defaultRandomInt;
  const chosen: number[] = [];
  const stats: DudeAssignmentStats = { candidatesChecked: 0, staleDudeIds: [] };
  const isCardNft2 = args.dropFamily === 'card_nft_2';

  if (isCardNft2) {
    await runCardNft2AssignmentRules({
      itemsPerBox: args.itemsPerBox,
      remainingSlots: () => args.itemsPerBox - chosen.length,
      rejectTooFewSlots: () => {
        throw new DudeAssignmentPoolExhaustedError({
          bucket: 'as_good_as_super_rare',
          chosen,
          candidatesChecked: stats.candidatesChecked,
          staleAssigned: stats.staleDudeIds.length,
          poolLen: args.pool.length,
        });
      },
      consumeBucketIfAvailable: async (bucket) => {
        const dude = await takeCardNft2BucketIfAvailable({
          bucket,
          chosen,
          maxDudeId: args.maxDudeId,
          pool: args.pool,
          randomInt,
          isAssigned: args.isAssigned,
          stats,
        });
        if (dude === null) return false;
        chosen.push(dude);
        return true;
      },
      consumeAny: async () => {
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
      },
      rejectExtraExhausted: () =>
        throwCardNft2FlexibleExtraExhausted({
          chosen,
          pool: args.pool,
          stats,
        }),
    });
  } else {
    while (chosen.length < args.itemsPerBox) {
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
    staleAssigned: stats.staleDudeIds.length,
    staleDudeIds: [...stats.staleDudeIds],
  };
}

export async function validateDudeIdsForAssignment(args: DudeAssignmentValidationArgs): Promise<void> {
  if (args.dudeIds.length !== args.itemsPerBox) {
    throw new DudeAssignmentValidationError(`Manifest dudeIds must contain exactly ${args.itemsPerBox} ids`);
  }

  const pool = [...args.pool];
  const remaining = [...args.dudeIds];
  const knownAssignedDudeIds = new Set(args.knownAssignedDudeIds || []);
  if (knownAssignedDudeIds.size) {
    for (let index = 0; index < pool.length; index += 1) {
      if (!knownAssignedDudeIds.has(pool[index]!)) continue;
      pool.splice(index, 1);
      index -= 1;
    }
  }
  const isCardNft2 = args.dropFamily === 'card_nft_2';

  if (!isCardNft2) {
    while (remaining.length) {
      await takeManifestAnyDude({ slot: 'assignment', remaining, pool, isAssigned: args.isAssigned });
    }
    return;
  }

  await runCardNft2AssignmentRules({
    itemsPerBox: args.itemsPerBox,
    remainingSlots: () => remaining.length,
    rejectTooFewSlots: () => {
      throw new DudeAssignmentValidationError('card_nft_2 assignments require at least two card ids');
    },
    consumeBucketIfAvailable: (bucket) =>
      takeManifestDudeForBucket({
        bucket,
        maxDudeId: args.maxDudeId,
        remaining,
        pool,
        isAssigned: args.isAssigned,
      }),
    consumeAny: (slot) => takeManifestAnyDude({ slot, remaining, pool, isAssigned: args.isAssigned }),
    rejectExtraExhausted: () => {
      throw new DudeAssignmentValidationError('Manifest dudeIds contain more card ids than the available assignment rules allow');
    },
  });
}
