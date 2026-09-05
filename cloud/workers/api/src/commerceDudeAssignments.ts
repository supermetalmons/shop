import {
  DudeAssignmentPoolExhaustedError,
  pickDudeIdsForAssignment,
  type DudeAssignmentBucket,
} from '../../../../shared/assignDudesPicker.js';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
} from './commerceRepository.js';
import {
  runCommerceTransaction,
  type CommerceRetrySleep,
} from './commerceTransactions.js';

export type CommerceDudeAssignmentResult = {
  dudeIds: number[];
  outcome: 'created' | 'existing';
};

export class CommerceDudeAssignmentError extends Error {
  constructor(
    readonly code: 'invalid-stored-assignment' | 'pool-exhausted',
    message: string,
    readonly details: {
      boxAssetId: string;
      bucket?: DudeAssignmentBucket;
      candidatesChecked?: number;
      chosen?: readonly number[];
      poolLen?: number;
      required?: number;
      staleAssigned?: number;
    },
  ) {
    super(message);
    this.name = 'CommerceDudeAssignmentError';
  }
}

export function normalizeCommerceDudeIds(
  raw: unknown,
  itemsPerBox: number,
  maxDudeId: number,
  boxAssetId: string,
): number[] {
  const dudeIds = Array.isArray(raw)
    ? raw.map((value) => Math.floor(Number(value)))
    : [];
  if (
    dudeIds.length !== itemsPerBox ||
    dudeIds.some((id) => !Number.isSafeInteger(id) || id < 1 || id > maxDudeId) ||
    new Set(dudeIds).size !== dudeIds.length
  ) {
    throw new CommerceDudeAssignmentError(
      'invalid-stored-assignment',
      'Stored figure assignment is invalid.',
      { boxAssetId },
    );
  }
  return dudeIds;
}

function poolExhausted(
  boxAssetId: string,
  poolLen: number,
  required: number,
): CommerceDudeAssignmentError {
  return new CommerceDudeAssignmentError(
    'pool-exhausted',
    'No figures remaining to assign.',
    {
      boxAssetId,
      poolLen,
      required,
    },
  );
}

export function assignCommerceDudes(args: {
  boxAssetId: string;
  dropFamily: string;
  dropId: string;
  itemsPerBox: number;
  maxDudeId: number;
  nowMs: number;
  randomInt: (maxExclusive: number) => number;
  repository: D1CommerceRepository;
  signal: AbortSignal;
  sleep?: CommerceRetrySleep;
}): Promise<CommerceDudeAssignmentResult> {
  const assignmentKey = commerceKeys.boxAssignment(args.dropId, args.boxAssetId);
  return runCommerceTransaction({
    nowMs: args.nowMs,
    repository: args.repository,
    signal: args.signal,
  }, async (transaction) => {
    const existing = await transaction.get(assignmentKey);
    if (existing) {
      return {
        dudeIds: normalizeCommerceDudeIds(
          existing.data.dudeIds,
          args.itemsPerBox,
          args.maxDudeId,
          args.boxAssetId,
        ),
        outcome: 'existing' as const,
      };
    }
    const { generation, pool } = await args.repository.getDudeInventory(args);
    if (pool.length < args.itemsPerBox) {
      throw poolExhausted(args.boxAssetId, pool.length, args.itemsPerBox);
    }
    let picked;
    try {
      picked = await pickDudeIdsForAssignment({
        dropFamily: args.dropFamily,
        itemsPerBox: args.itemsPerBox,
        maxDudeId: args.maxDudeId,
        pool,
        randomInt: args.randomInt,
        isAssigned: () => false,
      });
    } catch (error) {
      if (!(error instanceof DudeAssignmentPoolExhaustedError)) throw error;
      throw new CommerceDudeAssignmentError('pool-exhausted', error.message, {
        boxAssetId: args.boxAssetId,
        bucket: error.bucket,
        candidatesChecked: error.candidatesChecked,
        chosen: error.chosen,
        poolLen: error.poolLen,
        staleAssigned: error.staleAssigned,
      });
    }
    const assignmentKeys = picked.chosen.map((dudeId) =>
      commerceKeys.dudeAssignment(args.dropId, String(dudeId)));
    if ((await transaction.getMany(assignmentKeys)).some(Boolean)) throw new CommerceWriteConflict();
    for (const [index, dudeId] of picked.chosen.entries()) {
      await transaction.create(assignmentKeys[index], {
        assignedAt: commerceFieldValue.serverTimestamp(),
        boxAssetId: args.boxAssetId,
        dudeId,
        inventoryGeneration: generation,
      });
    }
    await transaction.create(assignmentKey, {
      createdAt: commerceFieldValue.serverTimestamp(),
      dudeIds: picked.chosen,
    });
    return { dudeIds: picked.chosen, outcome: 'created' as const };
  }, { sleep: args.sleep });
}
