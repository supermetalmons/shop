import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import { isNonZeroBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import { isSignalCancellationError } from './boundedRequest.js';
import {
  IRL_CLAIM_CODE_DIGITS,
  IRL_CLAIM_CODE_NAMESPACE,
  normalizeIrlClaimCode,
} from './claimCodes.js';
import {
  CommerceWriteConflict,
  commerceFieldValue,
  commerceKeys,
} from './commerceRepository.js';
import {
  commerceTimestamp,
  readCommerceRecord as readDocument,
  runCommerceTransaction,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';
import { isRecord } from './dataAccess.js';
import {
  readDeliveryRecovery,
  updateDeliveryOrder,
  type DeliveryOrderDocument,
  type DeliveryOrderKey,
  type RecoverySnapshot,
} from './deliveryOrderStore.js';
import { shouldEnqueueDeliveryPackStatusProjection } from './deliveryPackStatusOutbox.js';
import { DeliveryReceiptError, mapProviderError } from './deliveryReceiptErrors.js';
import type { DeliveryRuntime } from './deliveryReceiptOnchain.js';
import { createReadyToShipNotificationIntent } from './readyToShipNotifications.js';
import {
  patchDeliveryRecoveryRecord,
  requireDeliveryRecoveryLease,
  requireSameDeliveryRecoverySnapshot,
  ownsDeliveryRecoveryLease,
  type DeliveryRecoveryLease,
} from './deliveryRecoveryStore.js';
import type { DeliveryRecoveryRecord } from '../../../../shared/deliveryRecoveryState.js';
import type { TransactionSubmissionOutcome } from './transactionSubmissionRecovery.js';
import type {
  DeliveryCloseUpdate,
  DeliveryIrlClaim,
  DeliveryProcessingUpdate,
  DeliveryReadyFields,
  DeliveryReadyUpdate,
} from './deliveryReceiptTypes.js';
export type { DeliveryIrlClaim } from './deliveryReceiptTypes.js';

const DELIVERY_AMBIGUOUS_SUBMISSION_LEASE_MS = 4 * 60_000;

export type PendingReceiptSubmission = {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  assetIds: string[];
};

export type DeliveryReceiptCompletion = {
  signature: string | null;
  receiptsMinted: number;
  receiptTxs: string[];
  irlClaims: DeliveryIrlClaim[];
};

type ServerTimestamp = ReturnType<typeof commerceFieldValue.serverTimestamp>;

type IrlClaimCodeFields = {
  version: 2;
  namespace: typeof IRL_CLAIM_CODE_NAMESPACE;
  code: string;
  dropId: string;
  boxId: number;
  boxAssetId: string;
  owner: string;
  deliveryId: number;
  dudeIds: number[];
};

type IrlClaimCodeCreate = IrlClaimCodeFields & { createdAt: ServerTimestamp };
type IrlClaimCodeUpdate = IrlClaimCodeFields & { updatedAt: ServerTimestamp };

type AssignmentClaimFields = {
  irlClaimCode: string;
  irlClaim: {
    namespace: typeof IRL_CLAIM_CODE_NAMESPACE;
    code: string;
    dropId: string;
    boxId: number;
    deliveryId: number;
    owner: string;
    dudeIds: number[];
  };
};

type AssignmentClaimUpdate = AssignmentClaimFields & { 'irlClaim.createdAt': ServerTimestamp };

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeDropIdMaybe(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = normalizeDropId(value);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : null;
}

type ClaimCodeExpected = {
  code: string;
  dropId: string;
  boxAssetId: string;
  boxId: number;
  deliveryId: number;
  dudeIds: readonly number[];
};

function claimCodeCompatible(claim: Record<string, unknown>, expected: ClaimCodeExpected): boolean {
  const rawDudeIds = Array.isArray(claim.dudeIds) ? claim.dudeIds.map(Number) : [];
  const claimBoxId = Number(claim.boxId);
  const claimDeliveryId = Number(claim.deliveryId);
  return (
    (claim.namespace === undefined || claim.namespace === IRL_CLAIM_CODE_NAMESPACE) &&
    (claim.code === undefined || normalizeIrlClaimCode(claim.code) === expected.code) &&
    normalizeDropIdMaybe(claim.dropId) === expected.dropId &&
    claim.boxAssetId === expected.boxAssetId &&
    Number.isFinite(claimBoxId) && Math.floor(claimBoxId) === expected.boxId &&
    (claim.deliveryId === undefined || (Number.isFinite(claimDeliveryId) && Math.floor(claimDeliveryId) === expected.deliveryId)) &&
    sameNumbers(rawDudeIds, expected.dudeIds)
  );
}

export function assignmentClaimCompatible(
  claim: Record<string, unknown>,
  expected: ClaimCodeExpected,
  ownerWallet: string,
): boolean {
  const rawDudeIds = Array.isArray(claim.dudeIds) ? claim.dudeIds.map(Number) : [];
  return claim.namespace === IRL_CLAIM_CODE_NAMESPACE &&
    normalizeIrlClaimCode(claim.code) === expected.code &&
    normalizeDropIdMaybe(claim.dropId) === expected.dropId &&
    Number(claim.boxId) === expected.boxId &&
    Number(claim.deliveryId) === expected.deliveryId &&
    claim.owner === ownerWallet &&
    sameNumbers(rawDudeIds, expected.dudeIds);
}

function claimCodeConflictReason(claim: Record<string, unknown>, expected: ClaimCodeExpected): string | null {
  const claimBoxId = Number(claim.boxId);
  if (
    (claim.namespace !== undefined && claim.namespace !== IRL_CLAIM_CODE_NAMESPACE) ||
    (claim.code !== undefined && normalizeIrlClaimCode(claim.code) !== expected.code) ||
    normalizeDropIdMaybe(claim.dropId) !== expected.dropId ||
    claim.boxAssetId !== expected.boxAssetId ||
    !Number.isFinite(claimBoxId) || Math.floor(claimBoxId) !== expected.boxId
  ) return 'box identity';
  if (claim.deliveryId !== undefined && Math.floor(Number(claim.deliveryId)) !== expected.deliveryId) return 'deliveryId';
  const rawDudeIds = claim.dudeIds ?? claim.dude_ids ?? claim.dudes;
  if (rawDudeIds !== undefined) {
    if (!Array.isArray(rawDudeIds)) return 'dudeIds';
    if (rawDudeIds.length && !sameNumbers(rawDudeIds.map(Number), expected.dudeIds)) return 'dudeIds';
  }
  return null;
}

function claimCodeFields(expected: ClaimCodeExpected, ownerWallet: string): IrlClaimCodeFields {
  return {
    version: 2,
    namespace: IRL_CLAIM_CODE_NAMESPACE,
    code: expected.code,
    dropId: expected.dropId,
    boxId: expected.boxId,
    boxAssetId: expected.boxAssetId,
    owner: ownerWallet,
    deliveryId: expected.deliveryId,
    dudeIds: [...expected.dudeIds],
  };
}

function assignmentClaimFields(expected: ClaimCodeExpected, ownerWallet: string): AssignmentClaimFields {
  return {
    irlClaimCode: expected.code,
    irlClaim: {
      namespace: IRL_CLAIM_CODE_NAMESPACE,
      code: expected.code,
      dropId: expected.dropId,
      boxId: expected.boxId,
      deliveryId: expected.deliveryId,
      owner: ownerWallet,
      dudeIds: [...expected.dudeIds],
    },
  };
}

export async function ensureIrlClaimCodeForBox(
  context: CommerceRepositoryContext,
  runtime: DeliveryRuntime,
  args: {
    ownerWallet: string;
    deliveryId: number;
    boxAssetId: string;
    boxId: number;
    dudeIds: number[];
  },
  randomInt: (maxExclusive: number) => number,
): Promise<string> {
  const assignmentKey = commerceKeys.boxAssignment(runtime.dropId, args.boxAssetId);
  try {
    return await runCommerceTransaction(context, async (transaction) => {
      const assignment = await readDocument(context, assignmentKey, transaction);
      if (!assignment) {
        throw new DeliveryReceiptError('failed-precondition', 'Figure assignment is missing.', {
          boxAssetId: args.boxAssetId,
        });
      }
      const normalizedExisting = typeof assignment.data.irlClaimCode === 'string'
        ? normalizeIrlClaimCode(assignment.data.irlClaimCode)
        : '';
      const existingCode = normalizedExisting.length === IRL_CLAIM_CODE_DIGITS ? normalizedExisting : '';
      if (existingCode) {
        const expected: ClaimCodeExpected = { code: existingCode, dropId: runtime.dropId, ...args };
        const claimKey = commerceKeys.claimCode(existingCode);
        const claim = await readDocument(context, claimKey, transaction);
        let claimChanged = false;
        if (!claim) {
          await transaction.create(claimKey, {
            ...claimCodeFields(expected, args.ownerWallet),
            createdAt: commerceFieldValue.serverTimestamp(),
          } satisfies IrlClaimCodeCreate);
          claimChanged = true;
        } else if (!claimCodeCompatible(claim.data, expected)) {
          const reason = claimCodeConflictReason(claim.data, expected);
          if (reason) {
            throw new DeliveryReceiptError(
              'failed-precondition',
              'Existing IRL claim code conflicts with this box assignment; manual review required',
              { boxAssetId: args.boxAssetId, boxId: args.boxId, existingCode, conflictReason: reason },
            );
          }
          await transaction.update(claimKey, {
            ...claimCodeFields(expected, args.ownerWallet),
            updatedAt: commerceFieldValue.serverTimestamp(),
          } satisfies IrlClaimCodeUpdate);
          claimChanged = true;
        }
        const assignmentClaim = isRecord(assignment.data.irlClaim) ? assignment.data.irlClaim : {};
        if (claimChanged || !assignmentClaimCompatible(assignmentClaim, expected, args.ownerWallet)) {
          const assignmentFields = assignmentClaimFields(expected, args.ownerWallet);
          await transaction.update(assignmentKey, {
            ...assignmentFields,
            'irlClaim.createdAt': commerceFieldValue.serverTimestamp(),
          } satisfies AssignmentClaimUpdate);
        }
        return existingCode;
      }
      let expected: ClaimCodeExpected | undefined;
      for (let claimAttempt = 0; claimAttempt < 40; claimAttempt += 1) {
        const code = String(randomInt(10 ** IRL_CLAIM_CODE_DIGITS)).padStart(IRL_CLAIM_CODE_DIGITS, '0');
        if (await readDocument(context, commerceKeys.claimCode(code), transaction)) continue;
        expected = { code, dropId: runtime.dropId, ...args };
        break;
      }
      if (!expected) {
        throw new DeliveryReceiptError('unavailable', 'Failed to allocate unique IRL claim code (try again)');
      }
      const assignmentFields = assignmentClaimFields(expected, args.ownerWallet);
      await transaction.create(commerceKeys.claimCode(expected.code), {
        ...claimCodeFields(expected, args.ownerWallet),
        createdAt: commerceFieldValue.serverTimestamp(),
      } satisfies IrlClaimCodeCreate);
      await transaction.update(assignmentKey, {
        ...assignmentFields,
        'irlClaim.createdAt': commerceFieldValue.serverTimestamp(),
      } satisfies AssignmentClaimUpdate);
      return expected.code;
    });
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    if (error instanceof DeliveryReceiptError) throw error;
    throw mapProviderError(error, 'IRL claim code is temporarily unavailable.');
  }
}

export async function markDeliveryProcessing(
  context: CommerceRepositoryContext,
  verifiedSnapshot: RecoverySnapshot,
  runtime: DeliveryRuntime,
  signature: string | null,
  lease: DeliveryRecoveryLease,
): Promise<void> {
  await runCommerceTransaction({ repository: context.repository, nowMs: context.nowMs }, async (transaction) => {
    const current = await readDeliveryRecovery(context, verifiedSnapshot.order.key, transaction);
    if (!current) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
    requireDeliveryRecoveryLease(current, lease);
    requireSameDeliveryRecoverySnapshot(current, verifiedSnapshot);
    transaction.stageRecovery(patchDeliveryRecoveryRecord(current.state, {
      lastPreparedProbeAt: commerceFieldValue.delete(),
      preparedProbeCount: commerceFieldValue.delete(),
      nextPreparedProbeAt: commerceFieldValue.delete(),
      status: commerceFieldValue.delete(),
    }, context.nowMs));
    await updateDeliveryOrder(transaction, current.order.key, {
      dropId: runtime.dropId,
      status: 'processing',
      ...(signature ? { deliverySignature: signature } : {}),
      ...(current.order.data.processingAt === undefined ? { processingAt: commerceFieldValue.serverTimestamp() } : {}),
    } satisfies DeliveryProcessingUpdate);
  }, { shouldRetry: () => false }).catch((error: unknown) => {
    if (error instanceof CommerceWriteConflict) {
      throw new DeliveryReceiptError('aborted', 'Delivery order changed during verification. Retry later.');
    }
    throw error;
  });
}

export async function markDeliveryReady(
  context: CommerceRepositoryContext,
  document: DeliveryOrderDocument,
  runtime: DeliveryRuntime,
  result: DeliveryReceiptCompletion,
  lease: DeliveryRecoveryLease,
): Promise<DeliveryOrderDocument> {
  const fields: DeliveryReadyFields = {
    dropId: runtime.dropId,
    status: 'ready_to_ship',
    ...(result.signature ? { deliverySignature: result.signature } : {}),
    receiptsMinted: result.receiptsMinted,
    receiptTxs: result.receiptTxs,
    ...(result.irlClaims.length ? { irlClaims: result.irlClaims } : {}),
  };
  return runCommerceTransaction({ repository: context.repository, nowMs: context.nowMs }, async (transaction) => {
    const current = await readDeliveryRecovery(context, document.key, transaction);
    if (!current) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
    requireDeliveryRecoveryLease(current, lease);
    if (pendingReceiptSubmission(current.order.data)) {
      throw new DeliveryReceiptError('aborted', 'A receipt transaction is still being reconciled.');
    }
    const notificationOutbox = createReadyToShipNotificationIntent({
      before: current.order.data, after: { ...current.order.data, ...fields },
      parentPath: document.key.path, deliveryId: Number(document.key.documentId),
      dropId: runtime.dropId, nowMs: context.nowMs,
    });
    if (notificationOutbox) await transaction.enqueueNotificationOutbox(notificationOutbox);
    transaction.stageRecovery(patchDeliveryRecoveryRecord(current.state, {
      leaseExpiresAt: commerceFieldValue.delete(),
      lastErrorCode: commerceFieldValue.delete(),
      lastErrorMessage: commerceFieldValue.delete(),
      lastPreparedProbeAt: commerceFieldValue.delete(),
      preparedProbeCount: commerceFieldValue.delete(),
      nextPreparedProbeAt: commerceFieldValue.delete(),
      status: commerceFieldValue.delete(),
    }, context.nowMs, null));
    await updateDeliveryOrder(transaction, document.key, {
      ...fields,
      processedAt: commerceFieldValue.serverTimestamp(),
      ...(result.irlClaims.length ? { irlClaimsUpdatedAt: commerceFieldValue.serverTimestamp() } : {}),
    } satisfies DeliveryReadyUpdate);
    if (shouldEnqueueDeliveryPackStatusProjection(runtime, { ...current.order.data, ...fields })) {
      transaction.enqueuePackStatusProjection({ parentPath: document.key.path, dropId: runtime.dropId });
    }
    return { ...current.order, data: { ...current.order.data, ...fields } };
  }, { shouldRetry: () => false });
}

export async function recordDeliveryClose(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  dropId: string,
  closeDeliveryTx: string,
): Promise<void> {
  await runCommerceTransaction({ repository: context.repository, nowMs: context.nowMs }, async (transaction) => {
    await transaction.getMany([key]);
    await updateDeliveryOrder(transaction, key, {
      dropId,
      closeDeliveryTx,
      deliveryClosedAt: commerceFieldValue.serverTimestamp(),
    } satisfies DeliveryCloseUpdate);
  }, { shouldRetry: () => false });
}

export function confirmedReceiptTransactions(order: Record<string, unknown>): string[] {
  if (!Array.isArray(order.receiptTxs)) return [];
  return Array.from(new Set(order.receiptTxs.filter((value): value is string =>
    typeof value === 'string' && isNonZeroBase58Bytes(value, 64))));
}

export function pendingReceiptSubmission(order: Record<string, unknown>): PendingReceiptSubmission | undefined {
  const recovery = isRecord(order.receiptRecovery) ? order.receiptRecovery : {};
  const value = recovery.pendingSubmission;
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new DeliveryReceiptError('failed-precondition', 'Stored receipt submission recovery is invalid.');
  }
  const signature = typeof value.signature === 'string' ? value.signature.trim() : '';
  const blockhash = typeof value.blockhash === 'string' ? value.blockhash.trim() : '';
  const lastValidBlockHeight = Math.floor(Number(value.lastValidBlockHeight));
  const assetIds = Array.isArray(value.assetIds)
    ? value.assetIds.map((assetId) => typeof assetId === 'string' ? assetId.trim() : '')
    : [];
  if (
    !isNonZeroBase58Bytes(signature, 64) || !isNonZeroBase58Bytes(blockhash, 32) ||
    !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1 ||
    assetIds.length < 1 || assetIds.length > 3 || new Set(assetIds).size !== assetIds.length ||
    assetIds.some((assetId) => !isNonZeroBase58Bytes(assetId, 32))
  ) {
    throw new DeliveryReceiptError('failed-precondition', 'Stored receipt submission recovery is invalid.');
  }
  return { signature, blockhash, lastValidBlockHeight, assetIds };
}

function samePendingReceiptSubmission(left: PendingReceiptSubmission, right: PendingReceiptSubmission): boolean {
  return left.signature === right.signature &&
    left.blockhash === right.blockhash &&
    left.lastValidBlockHeight === right.lastValidBlockHeight &&
    left.assetIds.length === right.assetIds.length &&
    left.assetIds.every((assetId, index) => assetId === right.assetIds[index]);
}

function pendingReceiptSubmissionAlreadySettled(
  document: Record<string, unknown>,
  pending: PendingReceiptSubmission,
  outcome: Exclude<TransactionSubmissionOutcome, 'unresolved'>,
): boolean {
  return outcome === 'expired' || confirmedReceiptTransactions(document).includes(pending.signature);
}

async function mutateReceiptSubmissionJournal(args: {
  context: CommerceRepositoryContext;
  key: DeliveryOrderKey;
  lease: DeliveryRecoveryLease;
  phase: 'persist' | 'settle';
  createCleanupContext: () => CommerceRepositoryContext;
  plan: (snapshot: RecoverySnapshot) => { state: DeliveryRecoveryRecord; receiptTx?: string } | undefined;
  isApplied: (snapshot: RecoverySnapshot) => boolean;
}): Promise<void> {
  try {
    await runCommerceTransaction(args.context, async (transaction) => {
      const snapshot = await readDeliveryRecovery(args.context, args.key, transaction);
      if (!snapshot) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
      requireDeliveryRecoveryLease(snapshot, args.lease);
      const update = args.plan(snapshot);
      if (!update) return;
      transaction.stageRecovery(update.state);
      if (update.receiptTx) {
        await transaction.update(args.key, { receiptTxs: commerceFieldValue.arrayUnion(update.receiptTx) });
      }
    });
  } catch (error) {
    if (args.phase === 'persist' && error instanceof CommerceWriteConflict) throw error;
    try {
      const snapshot = await readDeliveryRecovery(args.createCleanupContext(), args.key);
      if (snapshot && snapshot.state.generation === args.lease.generation &&
        (args.phase === 'settle' || ownsDeliveryRecoveryLease(snapshot, args.lease)) && args.isApplied(snapshot)) return;
    } catch {}
    throw error;
  }
}

export async function persistPendingReceiptSubmission(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  pending: PendingReceiptSubmission,
  lease: DeliveryRecoveryLease,
  createCleanupContext: () => CommerceRepositoryContext,
): Promise<void> {
  await mutateReceiptSubmissionJournal({
    context, key, lease, phase: 'persist', createCleanupContext,
    plan: (snapshot) => {
      if (snapshot.order.data.status !== 'processing') {
        throw new DeliveryReceiptError('aborted', 'Delivery receipt recovery attempt changed. Retry later.');
      }
      const existing = pendingReceiptSubmission(snapshot.order.data);
      if (existing && !samePendingReceiptSubmission(existing, pending)) {
        throw new DeliveryReceiptError('aborted', 'A receipt transaction is still being reconciled.');
      }
      return { state: patchDeliveryRecoveryRecord(snapshot.state, {
        pendingSubmission: pending,
        leaseExpiresAt: commerceTimestamp(Math.max(snapshot.state.leaseExpiresAtMs ?? 0, context.nowMs + DELIVERY_AMBIGUOUS_SUBMISSION_LEASE_MS)),
      }, context.nowMs) };
    },
    isApplied: (snapshot) => {
      const stored = pendingReceiptSubmission(snapshot.order.data);
      return Boolean(stored && samePendingReceiptSubmission(stored, pending));
    },
  });
}

export async function settlePendingReceiptSubmission(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  pending: PendingReceiptSubmission,
  outcome: Exclude<TransactionSubmissionOutcome, 'unresolved'>,
  lease: DeliveryRecoveryLease,
  createCleanupContext: () => CommerceRepositoryContext,
): Promise<void> {
  await mutateReceiptSubmissionJournal({
    context, key, lease, phase: 'settle', createCleanupContext,
    plan: (snapshot) => {
      const existing = pendingReceiptSubmission(snapshot.order.data);
      if (!existing) {
        if (pendingReceiptSubmissionAlreadySettled(snapshot.order.data, pending, outcome)) return;
        throw new DeliveryReceiptError('aborted', 'Receipt submission recovery changed.');
      }
      if (!samePendingReceiptSubmission(existing, pending)) {
        throw new DeliveryReceiptError('aborted', 'Receipt submission recovery changed.');
      }
      return {
        state: patchDeliveryRecoveryRecord(snapshot.state, { pendingSubmission: commerceFieldValue.delete() }, context.nowMs),
        ...(outcome === 'confirmed' ? { receiptTx: pending.signature } : {}),
      };
    },
    isApplied: (snapshot) => !pendingReceiptSubmission(snapshot.order.data) &&
      pendingReceiptSubmissionAlreadySettled(snapshot.order.data, pending, outcome),
  });
}
