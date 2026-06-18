import { randomInt } from 'crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { PublicKey } from '@solana/web3.js';
import {
  DudeAssignmentPoolExhaustedError,
  DudeAssignmentValidationError,
  pickDudeIdsForAssignment,
  validateDudeIdsForAssignment,
} from './assignDudesPicker.js';
import { IRL_CLAIM_CODE_DIGITS, IRL_CLAIM_CODE_NAMESPACE, normalizeIrlClaimCode } from './claimCodes.js';
import { dropBoxAssignmentPath, dropDudeAssignmentPath, dropDudePoolPath } from './dropPaths.js';
import type { DropFamily } from './config/deployment.js';

export type CardAssignmentDropRuntime = {
  dropId: string;
  config: {
    dropFamily: DropFamily | string;
  };
  itemsPerBox: number;
  maxDudeId: number;
};

export type AssignmentLogger = {
  info?: (message: string, meta?: unknown) => void;
  warn?: (message: string, meta?: unknown) => void;
};

export type AssignmentErrorSummary = (err: unknown) => unknown;

export type SpecificDudeAssignmentResult = {
  dudeIds: number[];
  created: boolean;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeErrorDefault(err: unknown) {
  if (err instanceof Error) return { kind: err.name, message: err.message };
  return { kind: typeof err, message: String(err) };
}

type AssignmentAttemptContext = {
  outerAttempt: number;
  internalAttempts: number;
};

const MAX_ASSIGNMENT_OUTER_ATTEMPTS = 6;
const RETRYABLE_FIRESTORE_ERROR_CODES = new Set<unknown>([
  6,
  '6',
  'ALREADY_EXISTS',
  10,
  '10',
  'ABORTED',
  4,
  '4',
  'DEADLINE_EXCEEDED',
  14,
  '14',
  'UNAVAILABLE',
  8,
  '8',
  'RESOURCE_EXHAUSTED',
]);

function isRetryableFirestoreError(err: unknown): boolean {
  return RETRYABLE_FIRESTORE_ERROR_CODES.has((err as any)?.code);
}

function assignmentRetryDelayMs(outerAttempt: number): number {
  return Math.min(150 * 2 ** Math.min(outerAttempt - 1, 4) + randomInt(0, 120), 2_500);
}

async function runAssignmentWithRetry<T>(params: {
  boxAssetId: string;
  logPrefix: string;
  logger?: AssignmentLogger;
  summarizeError: AssignmentErrorSummary;
  runAttempt: (attempt: AssignmentAttemptContext) => Promise<T>;
}): Promise<T> {
  for (let outerAttempt = 1; outerAttempt <= MAX_ASSIGNMENT_OUTER_ATTEMPTS; outerAttempt += 1) {
    const attempt: AssignmentAttemptContext = { outerAttempt, internalAttempts: 0 };
    try {
      return await params.runAttempt(attempt);
    } catch (err) {
      if (isRetryableFirestoreError(err) && outerAttempt < MAX_ASSIGNMENT_OUTER_ATTEMPTS) {
        const delayMs = assignmentRetryDelayMs(outerAttempt);
        params.logger?.warn?.(`${params.logPrefix}:transient_error_retrying`, {
          boxAssetId: params.boxAssetId,
          outerAttempt,
          internalAttempts: attempt.internalAttempts,
          delayMs,
          error: params.summarizeError(err),
        });
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
}

function assertOpenableDrop(dropRuntime: Pick<CardAssignmentDropRuntime, 'itemsPerBox'>, message: string): void {
  if (dropRuntime.itemsPerBox < 1) {
    throw new HttpsError('failed-precondition', message);
  }
}

function normalizeAssignmentDropId(dropId: string): string {
  const value = String(dropId || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new HttpsError('invalid-argument', 'Invalid dropId');
  }
  return value;
}

function normalizeWallet(wallet: string): string {
  try {
    return new PublicKey(wallet).toBase58();
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid wallet address');
  }
}

type DudeIdsForAssignmentParams = {
  raw: unknown;
  itemsPerBox: number;
  maxDudeId: number;
  boxAssetId: string;
};

function normalizeDudeIdsForAssignment(params: DudeIdsForAssignmentParams & {
  source: 'stored' | 'manifest' | 'IRL claim code';
}): number[] {
  const dudeIds = Array.isArray(params.raw) ? params.raw.map((n) => Math.floor(Number(n))) : [];
  const label = `${params.source} dudeIds`;
  if (dudeIds.length !== params.itemsPerBox) {
    throw new HttpsError('failed-precondition', `Invalid ${label} (expected ${params.itemsPerBox})`, {
      boxAssetId: params.boxAssetId,
      dudeIds,
    });
  }
  dudeIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > params.maxDudeId) {
      throw new HttpsError('failed-precondition', `Invalid ${params.source} dude id`, { boxAssetId: params.boxAssetId, dudeId: id });
    }
  });
  if (new Set(dudeIds).size !== dudeIds.length) {
    throw new HttpsError('failed-precondition', `Duplicate ${label} for box`, {
      boxAssetId: params.boxAssetId,
      dudeIds,
    });
  }
  return dudeIds;
}

function normalizeExistingDudeIds(params: DudeIdsForAssignmentParams): number[] {
  return normalizeDudeIdsForAssignment({ ...params, source: 'stored' });
}

function normalizeSpecificDudeIds(params: DudeIdsForAssignmentParams): number[] {
  return normalizeDudeIdsForAssignment({ ...params, source: 'manifest' });
}

function normalizeStaleDudeIds(params: {
  raw: unknown;
  maxDudeId: number;
  selectedDudeIds: ReadonlySet<number>;
  boxAssetId: string;
}): number[] {
  if (params.raw == null) return [];
  if (!Array.isArray(params.raw)) {
    throw new HttpsError('failed-precondition', 'Invalid stale dude ids for manifest assignment', {
      boxAssetId: params.boxAssetId,
    });
  }
  const staleDudeIds = params.raw.map((value) => Math.floor(Number(value)));
  staleDudeIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > params.maxDudeId) {
      throw new HttpsError('failed-precondition', 'Invalid stale dude id for manifest assignment', {
        boxAssetId: params.boxAssetId,
        dudeId: id,
      });
    }
    if (params.selectedDudeIds.has(id)) {
      throw new HttpsError('failed-precondition', 'Manifest stale dude ids overlap selected dude ids', {
        boxAssetId: params.boxAssetId,
        dudeId: id,
      });
    }
  });
  if (new Set(staleDudeIds).size !== staleDudeIds.length) {
    throw new HttpsError('failed-precondition', 'Duplicate stale dude ids for manifest assignment', {
      boxAssetId: params.boxAssetId,
    });
  }
  return staleDudeIds;
}

export function sanitizeDudeAssignmentPool(rawPool: unknown, maxDudeId: number): {
  pool: number[];
  usedDefaultPool: boolean;
  rawPoolLen: number | null;
  poolInitLen: number;
  invalidRemoved: number;
  dupRemoved: number;
} {
  const usedDefaultPool = !Array.isArray(rawPool);
  const rawPoolLen = Array.isArray(rawPool) ? rawPool.length : null;
  const initialPool = Array.isArray(rawPool)
    ? rawPool.map((n) => Math.floor(Number(n)))
    : Array.from({ length: maxDudeId }, (_, index) => index + 1);
  const poolInitLen = initialPool.length;
  const sanitized = initialPool.filter((id) => Number.isFinite(id) && id >= 1 && id <= maxDudeId);
  const invalidRemoved = poolInitLen - sanitized.length;
  const pool = Array.from(new Set(sanitized));
  const dupRemoved = sanitized.length - pool.length;
  return { pool, usedDefaultPool, rawPoolLen, poolInitLen, invalidRemoved, dupRemoved };
}

function sameDudeIds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function dudeAssignmentMatchesBox(data: any, dudeId: number, boxAssetId: string): boolean {
  const storedDudeId = Math.floor(Number(data?.dudeId));
  const storedBoxAssetId = typeof data?.boxAssetId === 'string' ? data.boxAssetId : '';
  return storedDudeId === dudeId && storedBoxAssetId === boxAssetId;
}

function generateIrlClaimCode(): string {
  const max = 10 ** IRL_CLAIM_CODE_DIGITS;
  return String(randomInt(0, max)).padStart(IRL_CLAIM_CODE_DIGITS, '0');
}

function normalizeDropIdMaybe(rawDropId: unknown): string | null {
  if (typeof rawDropId !== 'string' || !rawDropId.trim()) return null;
  try {
    return normalizeAssignmentDropId(rawDropId);
  } catch {
    return null;
  }
}

function claimCodeDocIsCompatibleWithAssignment(
  claim: any,
  expected: {
    code: string;
    dropId: string;
    boxAssetId: string;
    boxId: number;
    deliveryId: number;
    dudeIds: readonly number[];
  },
): boolean {
  const hasClaimCode = claim?.code != null;
  const hasDeliveryId = claim?.deliveryId != null;
  const hasNamespace = claim?.namespace != null;
  const claimCode = hasClaimCode ? normalizeIrlClaimCode(claim?.code) : '';
  const claimDropId = normalizeDropIdMaybe(claim?.dropId);
  const claimBoxAssetId = typeof claim?.boxAssetId === 'string' ? String(claim.boxAssetId) : '';
  const claimBoxId = Number(claim?.boxId);
  const claimDeliveryId = Number(claim?.deliveryId);
  const claimDudeIds = Array.isArray(claim?.dudeIds) ? claim.dudeIds.map((value: unknown) => Number(value)) : [];
  return (
    (!hasNamespace || claim?.namespace === IRL_CLAIM_CODE_NAMESPACE) &&
    (!hasClaimCode || claimCode === expected.code) &&
    claimDropId === expected.dropId &&
    claimBoxAssetId === expected.boxAssetId &&
    Number.isFinite(claimBoxId) &&
    Math.floor(claimBoxId) === Math.floor(expected.boxId) &&
    (!hasDeliveryId || (Number.isFinite(claimDeliveryId) && Math.floor(claimDeliveryId) === Math.floor(expected.deliveryId))) &&
    sameDudeIds(claimDudeIds, expected.dudeIds)
  );
}

function claimCodeDocMatchesBoxIdentity(
  claim: any,
  expected: {
    code: string;
    dropId: string;
    boxAssetId: string;
    boxId: number;
  },
): boolean {
  const hasClaimCode = claim?.code != null;
  const hasNamespace = claim?.namespace != null;
  const claimCode = hasClaimCode ? normalizeIrlClaimCode(claim?.code) : '';
  const claimDropId = normalizeDropIdMaybe(claim?.dropId);
  const claimBoxAssetId = typeof claim?.boxAssetId === 'string' ? String(claim.boxAssetId) : '';
  const claimBoxId = Number(claim?.boxId);
  return (
    (!hasNamespace || claim?.namespace === IRL_CLAIM_CODE_NAMESPACE) &&
    (!hasClaimCode || claimCode === expected.code) &&
    claimDropId === expected.dropId &&
    claimBoxAssetId === expected.boxAssetId &&
    Number.isFinite(claimBoxId) &&
    Math.floor(claimBoxId) === Math.floor(expected.boxId)
  );
}

function rawClaimDudeIds(claim: any): unknown {
  if (claim?.dudeIds != null) return claim.dudeIds;
  if (claim?.dude_ids != null) return claim.dude_ids;
  if (claim?.dudes != null) return claim.dudes;
  return undefined;
}

function existingClaimBackfillConflictReason(
  claim: any,
  expected: {
    code: string;
    dropId: string;
    boxAssetId: string;
    boxId: number;
    deliveryId: number;
    dudeIds: readonly number[];
  },
): string | null {
  if (!claimCodeDocMatchesBoxIdentity(claim, expected)) return 'box identity';

  if (claim?.deliveryId != null) {
    const claimDeliveryId = Number(claim.deliveryId);
    if (!Number.isFinite(claimDeliveryId) || Math.floor(claimDeliveryId) !== Math.floor(expected.deliveryId)) {
      return 'deliveryId';
    }
  }

  const rawDudeIds = rawClaimDudeIds(claim);
  if (rawDudeIds != null) {
    if (!Array.isArray(rawDudeIds)) return 'dudeIds';
    if (rawDudeIds.length > 0) {
      const claimDudeIds = rawDudeIds.map((value: unknown) => Number(value));
      if (!sameDudeIds(claimDudeIds, expected.dudeIds)) return 'dudeIds';
    }
  }

  return null;
}

type IrlClaimCodeDocParams = {
  code: string;
  dropId: string;
  boxId: number;
  boxAssetId: string;
  ownerWallet: string;
  deliveryId: number;
  dudeIds: number[];
};

function buildIrlClaimCodeFields(params: IrlClaimCodeDocParams) {
  return {
    version: 2,
    namespace: IRL_CLAIM_CODE_NAMESPACE,
    code: params.code,
    dropId: params.dropId,
    boxId: params.boxId,
    boxAssetId: params.boxAssetId,
    owner: params.ownerWallet,
    deliveryId: params.deliveryId,
    dudeIds: params.dudeIds,
  };
}

function buildIrlClaimCodeDoc(params: IrlClaimCodeDocParams) {
  return {
    ...buildIrlClaimCodeFields(params),
    createdAt: FieldValue.serverTimestamp(),
  };
}

function buildIrlClaimCodeBackfillDoc(params: IrlClaimCodeDocParams) {
  return {
    ...buildIrlClaimCodeFields(params),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function buildIrlClaimAssignment(
  code: string,
  params: { dropId: string; boxId: number; deliveryId: number; ownerWallet: string; dudeIds: number[] },
) {
  return {
    irlClaimCode: code,
    irlClaim: {
      namespace: IRL_CLAIM_CODE_NAMESPACE,
      code,
      dropId: params.dropId,
      boxId: params.boxId,
      deliveryId: params.deliveryId,
      owner: params.ownerWallet,
      dudeIds: params.dudeIds,
      createdAt: FieldValue.serverTimestamp(),
    },
  };
}

export async function assignDudesForBox(params: {
  db: Firestore;
  dropRuntime: CardAssignmentDropRuntime;
  boxAssetId: string;
  logger?: AssignmentLogger;
  summarizeError?: AssignmentErrorSummary;
}): Promise<number[]> {
  const { db, dropRuntime } = params;
  const dropId = normalizeAssignmentDropId(dropRuntime.dropId);
  const boxAssetId = String(params.boxAssetId || '');
  const itemsPerBox = dropRuntime.itemsPerBox;
  assertOpenableDrop(dropRuntime, 'This drop does not support figure assignment.');
  const maxDudeId = dropRuntime.maxDudeId;
  const ref = db.doc(dropBoxAssignmentPath(dropId, boxAssetId));
  const poolRef = db.doc(dropDudePoolPath(dropId));
  const summarizeError = params.summarizeError || summarizeErrorDefault;

  return runAssignmentWithRetry({
    boxAssetId,
    logPrefix: 'assignDudes',
    logger: params.logger,
    summarizeError,
    runAttempt: async (attempt) => {
      let lastAttemptMeta:
        | null
        | {
            boxAssetId: string;
            outerAttempt: number;
            internalAttempts: number;
            poolDocExists: boolean;
            usedDefaultPool: boolean;
            rawPoolLen: number | null;
            poolInitLen: number;
            invalidRemoved: number;
            dupRemoved: number;
            poolLenAfterSanitize: number;
            poolLenAfterWrite: number;
            candidatesChecked: number;
            staleAssigned: number;
            chosen: number[];
          } = null;

      const result = await db.runTransaction(async (tx) => {
        attempt.internalAttempts += 1;

        const existing = await tx.get(ref);
        if (existing.exists) {
          return normalizeExistingDudeIds({
            raw: (existing.data() as any)?.dudeIds,
            itemsPerBox,
            maxDudeId,
            boxAssetId,
          });
        }

        const poolSnap = await tx.get(poolRef);
        const poolInfo = sanitizeDudeAssignmentPool((poolSnap.data() as any)?.available, maxDudeId);
        let pool = poolInfo.pool;
        const poolLenAfterSanitize = pool.length;

        if (pool.length < itemsPerBox) {
          throw new HttpsError('resource-exhausted', 'No dudes remaining to assign', {
            boxAssetId,
            poolDocExists: poolSnap.exists,
            poolLen: pool.length,
            required: itemsPerBox,
          });
        }

        let chosen: number[];
        let candidatesChecked = 0;
        let staleAssigned = 0;
        try {
          const picked = await pickDudeIdsForAssignment({
            dropFamily: dropRuntime.config.dropFamily,
            itemsPerBox,
            maxDudeId,
            pool,
            isAssigned: async (candidate) => {
              const dudeRef = db.doc(dropDudeAssignmentPath(dropId, candidate));
              const dudeSnap = await tx.get(dudeRef);
              return dudeSnap.exists;
            },
          });
          chosen = picked.chosen;
          candidatesChecked = picked.candidatesChecked;
          staleAssigned = picked.staleAssigned;
        } catch (err) {
          if (err instanceof DudeAssignmentPoolExhaustedError) {
            throw new HttpsError('resource-exhausted', err.message, {
              boxAssetId,
              dropId,
              bucket: err.bucket,
              chosen: err.chosen,
              candidatesChecked: err.candidatesChecked,
              staleAssigned: err.staleAssigned,
              poolLen: err.poolLen,
              required: itemsPerBox,
            });
          }
          throw err;
        }

        for (const dudeId of chosen) {
          const dudeRef = db.doc(dropDudeAssignmentPath(dropId, dudeId));
          tx.create(dudeRef, {
            dudeId,
            boxAssetId,
            assignedAt: FieldValue.serverTimestamp(),
          });
        }

        tx.set(poolRef, { available: pool, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        tx.set(ref, { dudeIds: chosen, createdAt: FieldValue.serverTimestamp() });

        lastAttemptMeta = {
          boxAssetId,
          outerAttempt: attempt.outerAttempt,
          internalAttempts: attempt.internalAttempts,
          poolDocExists: poolSnap.exists,
          usedDefaultPool: poolInfo.usedDefaultPool,
          rawPoolLen: poolInfo.rawPoolLen,
          poolInitLen: poolInfo.poolInitLen,
          invalidRemoved: poolInfo.invalidRemoved,
          dupRemoved: poolInfo.dupRemoved,
          poolLenAfterSanitize,
          poolLenAfterWrite: pool.length,
          candidatesChecked,
          staleAssigned,
          chosen,
        };
        return chosen;
      });

      if (lastAttemptMeta) {
        const selfHealed =
          (lastAttemptMeta.poolDocExists && lastAttemptMeta.usedDefaultPool) ||
          lastAttemptMeta.invalidRemoved > 0 ||
          lastAttemptMeta.dupRemoved > 0 ||
          lastAttemptMeta.staleAssigned > 0;
        const retried = lastAttemptMeta.internalAttempts > 1 || lastAttemptMeta.outerAttempt > 1;
        if (selfHealed) {
          params.logger?.warn?.('assignDudes:pool_self_heal', lastAttemptMeta);
        } else if (retried) {
          params.logger?.info?.('assignDudes:retry', {
            boxAssetId,
            outerAttempt: lastAttemptMeta.outerAttempt,
            internalAttempts: lastAttemptMeta.internalAttempts,
          });
        }
      } else if (attempt.internalAttempts > 1 || attempt.outerAttempt > 1) {
        params.logger?.info?.('assignDudes:retry', {
          boxAssetId,
          outerAttempt: attempt.outerAttempt,
          internalAttempts: attempt.internalAttempts,
          path: 'existing_assignment',
        });
      }

      return result;
    },
  });
}

export async function assignSpecificDudesForBox(params: {
  db: Firestore;
  dropRuntime: CardAssignmentDropRuntime;
  boxAssetId: string;
  dudeIds: number[];
  staleDudeIds?: number[];
  logger?: AssignmentLogger;
  summarizeError?: AssignmentErrorSummary;
}): Promise<SpecificDudeAssignmentResult> {
  const { db, dropRuntime } = params;
  const dropId = normalizeAssignmentDropId(dropRuntime.dropId);
  const boxAssetId = String(params.boxAssetId || '');
  const itemsPerBox = dropRuntime.itemsPerBox;
  assertOpenableDrop(dropRuntime, 'This drop does not support figure assignment.');
  const maxDudeId = dropRuntime.maxDudeId;
  const dudeIds = normalizeSpecificDudeIds({ raw: params.dudeIds, itemsPerBox, maxDudeId, boxAssetId });
  const selectedDudeIds = new Set(dudeIds);
  const staleDudeIds = normalizeStaleDudeIds({
    raw: params.staleDudeIds,
    maxDudeId,
    selectedDudeIds,
    boxAssetId,
  });
  const ref = db.doc(dropBoxAssignmentPath(dropId, boxAssetId));
  const poolRef = db.doc(dropDudePoolPath(dropId));
  const summarizeError = params.summarizeError || summarizeErrorDefault;

  return runAssignmentWithRetry({
    boxAssetId,
    logPrefix: 'assignSpecificDudes',
    logger: params.logger,
    summarizeError,
    runAttempt: async (attempt) => {
      const result = await db.runTransaction(async (tx): Promise<SpecificDudeAssignmentResult> => {
        attempt.internalAttempts += 1;

        const existing = await tx.get(ref);
        if (existing.exists) {
          const existingDudeIds = normalizeExistingDudeIds({
            raw: (existing.data() as any)?.dudeIds,
            itemsPerBox,
            maxDudeId,
            boxAssetId,
          });
          if (!sameDudeIds(existingDudeIds, dudeIds)) {
            throw new HttpsError('failed-precondition', 'Stored dudeIds do not match the manifest', {
              boxAssetId,
              stored: existingDudeIds,
              manifest: dudeIds,
            });
          }
          for (const dudeId of existingDudeIds) {
            const dudeRef = db.doc(dropDudeAssignmentPath(dropId, dudeId));
            const dudeSnap = await tx.get(dudeRef);
            if (!dudeSnap.exists || !dudeAssignmentMatchesBox(dudeSnap.data(), dudeId, boxAssetId)) {
              throw new HttpsError('failed-precondition', 'Stored box assignment is missing a matching dude assignment', {
                boxAssetId,
                dudeId,
                dudeAssignmentPath: dudeRef.path,
                existing: dudeSnap.exists ? dudeSnap.data() : null,
              });
            }
          }
          const assignedStaleDudeIds = new Set<number>();
          for (const staleDudeId of staleDudeIds) {
            const staleRef = db.doc(dropDudeAssignmentPath(dropId, staleDudeId));
            const staleSnap = await tx.get(staleRef);
            if (staleSnap.exists) assignedStaleDudeIds.add(staleDudeId);
          }
          const poolSnap = await tx.get(poolRef);
          const rawPool = (poolSnap.data() as any)?.available;
          if (Array.isArray(rawPool)) {
            const poolInfo = sanitizeDudeAssignmentPool(rawPool, maxDudeId);
            const assignedDudeIds = new Set([...existingDudeIds, ...assignedStaleDudeIds]);
            const pool = poolInfo.pool.filter((dudeId) => !assignedDudeIds.has(dudeId));
            if (pool.length !== poolInfo.pool.length || poolInfo.invalidRemoved > 0 || poolInfo.dupRemoved > 0) {
              tx.set(poolRef, { available: pool, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
            }
          }
          return { dudeIds: existingDudeIds, created: false };
        }

        const poolSnap = await tx.get(poolRef);
        const poolInfo = sanitizeDudeAssignmentPool((poolSnap.data() as any)?.available, maxDudeId);
        let pool = poolInfo.pool;
        const poolSet = new Set(pool);
        const missingFromPool = dudeIds.filter((dudeId) => !poolSet.has(dudeId));
        if (missingFromPool.length) {
          throw new HttpsError('failed-precondition', 'Manifest dudeIds are no longer available in the pool', {
            boxAssetId,
            missingFromPool,
          });
        }

        try {
          const staleDudeIdsDiscovered = new Set<number>();
          const assignmentExistsCache = new Map<number, Promise<boolean>>();
          const isAssigned = (dudeId: number): Promise<boolean> => {
            let cached = assignmentExistsCache.get(dudeId);
            if (!cached) {
              cached = (async () => {
                const dudeRef = db.doc(dropDudeAssignmentPath(dropId, dudeId));
                const dudeSnap = await tx.get(dudeRef);
                if (dudeSnap.exists && !selectedDudeIds.has(dudeId)) staleDudeIdsDiscovered.add(dudeId);
                return dudeSnap.exists;
              })();
              assignmentExistsCache.set(dudeId, cached);
            }
            return cached;
          };

          for (const dudeId of staleDudeIds.filter((id) => poolSet.has(id))) {
            await isAssigned(dudeId);
          }

          await validateDudeIdsForAssignment({
            dropFamily: dropRuntime.config.dropFamily,
            itemsPerBox,
            maxDudeId,
            pool,
            dudeIds,
            knownAssignedDudeIds: [...staleDudeIdsDiscovered],
            isAssigned,
          });
          if (staleDudeIdsDiscovered.size) {
            pool = pool.filter((dudeId) => !staleDudeIdsDiscovered.has(dudeId));
          }
        } catch (err) {
          if (err instanceof DudeAssignmentValidationError) {
            throw new HttpsError('failed-precondition', err.message, { boxAssetId, dudeIds });
          }
          throw err;
        }

        const chosen = new Set(dudeIds);
        pool = pool.filter((dudeId) => !chosen.has(dudeId));
        for (const dudeId of dudeIds) {
          const dudeRef = db.doc(dropDudeAssignmentPath(dropId, dudeId));
          tx.create(dudeRef, {
            dudeId,
            boxAssetId,
            assignedAt: FieldValue.serverTimestamp(),
          });
        }

        tx.set(poolRef, { available: pool, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        tx.set(ref, { dudeIds, createdAt: FieldValue.serverTimestamp() });

        return { dudeIds, created: true };
      });

      if (attempt.internalAttempts > 1 || attempt.outerAttempt > 1) {
        params.logger?.info?.('assignSpecificDudes:retry', {
          boxAssetId,
          outerAttempt: attempt.outerAttempt,
          internalAttempts: attempt.internalAttempts,
        });
      }
      return result;
    },
  });
}

export async function ensureIrlClaimCodeForBox(params: {
  db: Firestore;
  dropRuntime: CardAssignmentDropRuntime;
  ownerWallet: string;
  deliveryId: number;
  boxAssetId: string;
  boxId: number;
  dudeIds: number[];
  logger?: AssignmentLogger;
}): Promise<string> {
  const { db, dropRuntime } = params;
  const dropId = normalizeAssignmentDropId(dropRuntime.dropId);
  const ownerWallet = normalizeWallet(params.ownerWallet);
  const deliveryId = Number(params.deliveryId);
  const boxAssetId = String(params.boxAssetId || '');
  const boxId = Number(params.boxId);

  assertOpenableDrop(dropRuntime, 'This drop does not use IRL claim codes.');
  if (!boxAssetId) throw new HttpsError('failed-precondition', 'Missing boxAssetId for IRL claim code');
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
    throw new HttpsError('failed-precondition', 'Invalid deliveryId for IRL claim code');
  }
  if (!Number.isFinite(boxId) || boxId <= 0 || boxId > 0xffff_ffff) {
    throw new HttpsError('failed-precondition', 'Invalid box id for IRL claim code');
  }
  const dudeIds = normalizeDudeIdsForAssignment({
    raw: params.dudeIds,
    itemsPerBox: dropRuntime.itemsPerBox,
    maxDudeId: dropRuntime.maxDudeId,
    boxAssetId,
    source: 'IRL claim code',
  });

  const assignmentRef = db.doc(dropBoxAssignmentPath(dropId, boxAssetId));

  return db.runTransaction(async (tx) => {
    const assignmentSnap = await tx.get(assignmentRef);
    const assignment = assignmentSnap.exists ? (assignmentSnap.data() as any) : {};

    const existingCodeRaw = assignment?.irlClaimCode;
    const existingCodeNormalized = typeof existingCodeRaw === 'string' ? normalizeIrlClaimCode(existingCodeRaw) : '';
    const existingCode = existingCodeNormalized.length === IRL_CLAIM_CODE_DIGITS ? existingCodeNormalized : '';
    if (existingCodeNormalized && !existingCode) {
      params.logger?.warn?.('ensureIrlClaimCodeForBox:invalid_existing_claim_code_format', {
        dropId,
        boxAssetId,
        boxId,
        existingCodeRaw: String(existingCodeRaw),
      });
    }
    if (existingCode) {
      const existingRef = db.doc(`claimCodes/${existingCode}`);
      const existingSnap = await tx.get(existingRef);
      if (!existingSnap.exists) {
        tx.set(existingRef, buildIrlClaimCodeDoc({ code: existingCode, dropId, boxId, boxAssetId, ownerWallet, deliveryId, dudeIds }));
        tx.set(assignmentRef, buildIrlClaimAssignment(existingCode, { dropId, boxId, deliveryId, ownerWallet, dudeIds }), { merge: true });
        return existingCode;
      }

      const existingClaim = existingSnap.data() as any;
      if (!claimCodeDocIsCompatibleWithAssignment(existingClaim, { code: existingCode, dropId, boxAssetId, boxId, deliveryId, dudeIds })) {
        const conflictReason = existingClaimBackfillConflictReason(existingClaim, {
          code: existingCode,
          dropId,
          boxAssetId,
          boxId,
          deliveryId,
          dudeIds,
        });
        if (conflictReason) {
          params.logger?.warn?.('ensureIrlClaimCodeForBox:conflicting_existing_claim_code', {
            dropId,
            boxAssetId,
            boxId,
            deliveryId,
            existingCode,
            conflictReason,
            claimNamespace: existingClaim?.namespace ?? null,
            claimCode: typeof existingClaim?.code === 'string' ? existingClaim.code : null,
            claimDropId: normalizeDropIdMaybe(existingClaim?.dropId),
            claimBoxAssetId: typeof existingClaim?.boxAssetId === 'string' ? existingClaim.boxAssetId : null,
            claimBoxId: existingClaim?.boxId ?? null,
            claimDeliveryId: existingClaim?.deliveryId ?? null,
          });
          throw new HttpsError('failed-precondition', 'Existing IRL claim code conflicts with this box assignment; manual review required', {
            boxAssetId,
            boxId,
            existingCode,
            conflictReason,
          });
        }
        params.logger?.warn?.('ensureIrlClaimCodeForBox:mismatched_existing_claim_code', {
          dropId,
          boxAssetId,
          boxId,
          deliveryId,
          existingCode,
          claimNamespace: existingClaim?.namespace ?? null,
          claimCode: typeof existingClaim?.code === 'string' ? existingClaim.code : null,
          claimDropId: normalizeDropIdMaybe(existingClaim?.dropId),
          claimBoxAssetId: typeof existingClaim?.boxAssetId === 'string' ? existingClaim.boxAssetId : null,
          claimBoxId: existingClaim?.boxId ?? null,
          claimDeliveryId: existingClaim?.deliveryId ?? null,
        });
        tx.set(
          existingRef,
          buildIrlClaimCodeBackfillDoc({ code: existingCode, dropId, boxId, boxAssetId, ownerWallet, deliveryId, dudeIds }),
          { merge: true },
        );
        tx.set(assignmentRef, buildIrlClaimAssignment(existingCode, { dropId, boxId, deliveryId, ownerWallet, dudeIds }), { merge: true });
      }
      return existingCode;
    }

    for (let claimAttempt = 0; claimAttempt < 40; claimAttempt += 1) {
      const code = generateIrlClaimCode();
      const claimRef = db.doc(`claimCodes/${code}`);
      const snap = await tx.get(claimRef);
      if (snap.exists) continue;

      tx.set(claimRef, buildIrlClaimCodeDoc({ code, dropId, boxId, boxAssetId, ownerWallet, deliveryId, dudeIds }));
      tx.set(assignmentRef, buildIrlClaimAssignment(code, { dropId, boxId, deliveryId, ownerWallet, dudeIds }), { merge: true });
      return code;
    }

    throw new HttpsError('unavailable', 'Failed to allocate unique IRL claim code (try again)');
  });
}
