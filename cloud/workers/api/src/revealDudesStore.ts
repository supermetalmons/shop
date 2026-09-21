import { isBase58Bytes, isNonZeroBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import {
  packStatusCardsPerPack,
  shouldTrackPackStatusForDrop,
  type PackStatusEvent,
} from '../../../../shared/packStatus.js';
import { isSignalCancellationError } from './boundedRequest.js';
import { CommerceRepositoryError, D1CommerceRepository } from './commerceRepository.js';
import { CommerceDudeAssignmentError, assignCommerceDudes } from './commerceDudeAssignments.js';
import { ProfileReadError } from './dataAccess.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';
import { applyPackStatusProjection } from './packStatusProjection.js';
import {
  RevealSubmissionOwnerMismatchError,
  RevealSubmissionStoragePausedError,
  loadD1RevealSubmission,
  loadRevealSubmissionStorageControl,
  reserveD1RevealSubmission,
  setD1RevealSubmissionStatus,
  type RevealSubmissionStorageControl,
} from './revealSubmissionD1.js';
import {
  RESERVATION_ID_PATTERN,
  RevealDudesError,
  type RevealContext,
  type RevealRuntime,
  type RevealSubmission,
} from './revealDudesDomain.js';

type AssignmentResult = {
  dudeIds: number[];
  outcome: 'existing' | 'created';
};

type AssignmentDependencies = {
  randomInt: (maxExclusive: number) => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export async function loadBoundWallet(
  context: RevealContext,
  db: D1Database | undefined,
  uid: string,
): Promise<string> {
  try {
    if (!db) throw new RevealDudesError('unavailable', 'Reveal data is temporarily unavailable.');
    const resolution = await resolveD1AuthWalletBinding(db, uid, context.signal);
    if ('reason' in resolution) throw new RevealDudesError('unauthenticated', 'Sign in with your wallet first.');
    return resolution.wallet;
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    if (
      error instanceof RevealDudesError ||
      error instanceof ProfileReadError
    ) throw error;
    throw new RevealDudesError('unavailable', 'Reveal data is temporarily unavailable.');
  }
}

export async function requireRevealSubmissionStorageControl(
  db: D1Database | undefined,
  signal: AbortSignal,
): Promise<RevealSubmissionStorageControl> {
  if (!db) throw new RevealDudesError('unavailable', 'Reveal data is temporarily unavailable.');
  try {
    return await loadRevealSubmissionStorageControl(db, signal);
  } catch (error) {
    if (isSignalCancellationError(signal, error)) throw signal.reason;
    if (error instanceof RevealDudesError) throw error;
    throw new RevealDudesError('unavailable', 'Reveal data is temporarily unavailable.');
  }
}

const REVEAL_SUBMISSION_VERSION = 1;

function normalizeRevealSubmission(
  raw: Record<string, unknown>,
  runtime: RevealRuntime,
  boxAssetId: string,
): RevealSubmission {
  const allowedFields = new Set([
    'version',
    'owner',
    'signature',
    'recentBlockhash',
    'blockhashContextSlot',
    'dudeIds',
    'reservationId',
    'status',
    'createdAt',
    'updatedAt',
    'confirmedAt',
  ]);
  const owner = isBase58Bytes(raw.owner, 32) ? raw.owner : null;
  const signature = isNonZeroBase58Bytes(raw.signature, 64) ? raw.signature : null;
  const recentBlockhash = isNonZeroBase58Bytes(raw.recentBlockhash, 32) ? raw.recentBlockhash : null;
  const blockhashContextSlot = raw.blockhashContextSlot;
  const dudeIds = Array.isArray(raw.dudeIds) ? raw.dudeIds : [];
  const reservationId = typeof raw.reservationId === 'string' && RESERVATION_ID_PATTERN.test(raw.reservationId)
    ? raw.reservationId
    : '';
  const status = raw.status === 'pending' || raw.status === 'confirmed' || raw.status === 'failed'
    ? raw.status
    : '';
  if (
    Object.keys(raw).some((field) => !allowedFields.has(field)) ||
    raw.version !== REVEAL_SUBMISSION_VERSION ||
    !owner ||
    !signature ||
    !recentBlockhash ||
    !Number.isSafeInteger(blockhashContextSlot) ||
    Number(blockhashContextSlot) < 0 ||
    !reservationId ||
    !status ||
    dudeIds.length !== runtime.itemsPerBox ||
    dudeIds.some((id) => !Number.isSafeInteger(id) || id < 1 || id > runtime.maxDudeId) ||
    new Set(dudeIds).size !== dudeIds.length ||
    (raw.createdAt !== undefined && !Number.isFinite(raw.createdAt)) ||
    (raw.updatedAt !== undefined && !Number.isFinite(raw.updatedAt)) ||
    (raw.confirmedAt !== undefined && !Number.isFinite(raw.confirmedAt))
  ) {
    throw new RevealDudesError('failed-precondition', 'Stored reveal submission is invalid.', { boxAssetId });
  }
  return {
    owner,
    signature,
    recentBlockhash,
    blockhashContextSlot: Number(blockhashContextSlot),
    dudeIds: [...dudeIds],
    reservationId,
    status,
  };
}

async function runRevealSubmissionD1Operation<T>(
  context: RevealContext,
  operation: (db: D1Database) => Promise<T>,
): Promise<T> {
  if (!context.opsDb) throw new RevealDudesError('unavailable', 'Reveal data is temporarily unavailable.');
  try {
    return await operation(context.opsDb);
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    if (error instanceof RevealDudesError) throw error;
    if (error instanceof RevealSubmissionStoragePausedError) {
      throw new RevealDudesError('unavailable', 'Reveal migration is in progress. Try again.');
    }
    if (error instanceof RevealSubmissionOwnerMismatchError) {
      throw new RevealDudesError('permission-denied', 'Owners only.');
    }
    if (error instanceof Error && error.message === 'Stored reveal submission does not match its reservation') {
      throw new RevealDudesError('failed-precondition', 'Stored reveal submission is invalid.');
    }
    throw new RevealDudesError('unavailable', 'Reveal submission is temporarily unavailable.');
  }
}

export async function loadRevealSubmission(
  context: RevealContext,
  runtime: RevealRuntime,
  boxAssetId: string,
): Promise<RevealSubmission | null> {
  return runRevealSubmissionD1Operation(context, (db) => loadD1RevealSubmission(
    db,
    runtime.dropId,
    boxAssetId,
    (raw, storedBoxAssetId) => normalizeRevealSubmission(raw, runtime, storedBoxAssetId),
    context.signal,
  ));
}

export async function reserveRevealSubmission(
  context: RevealContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  candidate: RevealSubmission,
  replaceSubmission: RevealSubmission | undefined,
  _dependencies: Pick<AssignmentDependencies, 'sleep'>,
): Promise<{ submission: RevealSubmission; owned: boolean }> {
  return runRevealSubmissionD1Operation(context, (db) => reserveD1RevealSubmission({
    boxAssetId,
    candidate,
    db,
    dropId: runtime.dropId,
    normalize: (raw, storedBoxAssetId) => normalizeRevealSubmission(raw, runtime, storedBoxAssetId),
    nowMs: context.nowMs,
    replaceSubmission,
    signal: context.signal,
  }));
}

async function setRevealSubmissionStatus(
  context: RevealContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
  status: 'confirmed' | 'failed',
): Promise<'confirmed' | 'failed' | 'stale'> {
  return runRevealSubmissionD1Operation(context, (db) => setD1RevealSubmissionStatus({
    boxAssetId,
    db,
    dropId: runtime.dropId,
    normalize: (raw, storedBoxAssetId) => normalizeRevealSubmission(raw, runtime, storedBoxAssetId),
    nowMs: context.nowMs,
    signal: context.signal,
    status,
    submission,
  }));
}

export async function confirmRevealSubmission(
  context: RevealContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): Promise<void> {
  const status = await setRevealSubmissionStatus(context, runtime, boxAssetId, submission, 'confirmed');
  if (status !== 'confirmed') throw new RevealDudesError('aborted', 'Reveal submission changed. Try again.');
}

export async function failRevealSubmission(
  context: RevealContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): Promise<'confirmed' | 'failed' | 'stale'> {
  return setRevealSubmissionStatus(context, runtime, boxAssetId, submission, 'failed');
}

export async function assignDudes(
  context: RevealContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  dependencies: AssignmentDependencies,
): Promise<AssignmentResult> {
  const repository = new D1CommerceRepository(context.commerceDb);
  try {
    return await assignCommerceDudes({
      boxAssetId,
      dropFamily: runtime.config.dropFamily,
      dropId: runtime.dropId,
      itemsPerBox: runtime.itemsPerBox,
      maxDudeId: runtime.maxDudeId,
      nowMs: context.nowMs,
      randomInt: dependencies.randomInt,
      repository,
      signal: context.signal,
      sleep: (milliseconds) => dependencies.sleep(milliseconds, context.signal),
    });
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    if (error instanceof CommerceDudeAssignmentError) {
      throw new RevealDudesError(
        error.code === 'invalid-stored-assignment' ? 'failed-precondition' : 'resource-exhausted',
        error.message,
        error.details,
      );
    }
    if (error instanceof ProfileReadError || error instanceof CommerceRepositoryError) {
      const code = error instanceof ProfileReadError && error.code === 'deadline-exceeded'
        ? error.code
        : 'unavailable';
      throw new RevealDudesError(code, 'Figure assignment is temporarily unavailable.');
    }
    throw new RevealDudesError('unavailable', 'Figure assignment is temporarily unavailable.');
  }
}

export async function countOnlineRevealPackStatus(
  context: RevealContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  signature: string,
): Promise<void> {
  if (!shouldTrackPackStatusForDrop({
    dropId: runtime.dropId,
    cluster: runtime.cluster,
    itemsPerBox: runtime.itemsPerBox,
    maxSupply: runtime.config.maxSupply,
  })) return;
  const event: PackStatusEvent = {
    dropId: runtime.dropId,
    type: 'onlineReveal',
    eventKey: boxAssetId,
    quantity: packStatusCardsPerPack({ itemsPerBox: runtime.itemsPerBox }),
    increments: { unsealedOnline: 1 },
    boxAssetId,
    signature,
    createdAtMs: context.nowMs,
  };
  await applyPackStatusProjection({
    dataDb: context.dataDb,
    event,
    log: (entry) => console.warn(entry),
  });
}
