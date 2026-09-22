import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import { isNonZeroBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import { isSignalCancellationError } from './boundedRequest.js';
import {
  IRL_CLAIM_CODE_DIGITS,
  IRL_CLAIM_CODE_NAMESPACE,
  normalizeIrlClaimCode,
} from './claimCodes.js';
import {
  commerceFieldValue,
  commerceKeys,
  isCommerceDeleteField,
} from './commerceRepository.js';
import {
  commerceTimestamp,
  readCommerceRecord as readDocument,
  runCommerceTransaction,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';
import { isRecord } from './dataAccess.js';
import {
  readDeliveryOrder,
  type DeliveryOrderDocument,
  type DeliveryOrderKey,
} from './deliveryOrderStore.js';
import { createDeliveryPackStatusProjectionOutbox } from './deliveryPackStatusOutbox.js';
import { DeliveryReceiptError, mapProviderError } from './deliveryReceiptErrors.js';
import type { DeliveryRuntime } from './deliveryReceiptOnchain.js';
import { createReadyToShipNotificationIntent } from './readyToShipNotifications.js';
import { mutateSubmissionJournal } from './submissionJournal.js';
import type { TransactionSubmissionOutcome } from './transactionSubmissionRecovery.js';

const DELIVERY_AMBIGUOUS_SUBMISSION_LEASE_MS = 4 * 60_000;
const RECEIPT_RECOVERY_PENDING_SUBMISSION_FIELD = 'receiptRecovery.pendingSubmission';

export type PendingReceiptSubmission = {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  assetIds: string[];
};

export type DeliveryIrlClaim = {
  code: string;
  boxId: number;
  boxAssetId: string;
  dudeIds: number[];
};

export type DeliveryReceiptCompletion = {
  signature: string | null;
  receiptsMinted: number;
  receiptTxs: string[];
  irlClaims: DeliveryIrlClaim[];
};

type ServerTimestamp = ReturnType<typeof commerceFieldValue.serverTimestamp>;
type DeletedField = ReturnType<typeof commerceFieldValue.delete>;

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

type DeliveryProcessingUpdate = {
  dropId: string;
  status: 'processing';
  deliverySignature?: string;
  'receiptRecovery.lastPreparedProbeAt': DeletedField;
  'receiptRecovery.preparedProbeCount': DeletedField;
  'receiptRecovery.nextPreparedProbeAt': DeletedField;
  'receiptRecovery.status': DeletedField;
  processingAt?: ServerTimestamp;
};

type DeliveryReadyFields = {
  dropId: string;
  status: 'ready_to_ship';
  deliverySignature?: string;
  receiptsMinted: number;
  receiptTxs: string[];
  irlClaims?: DeliveryIrlClaim[];
};

type DeliveryReadyUpdate = DeliveryReadyFields & {
  'receiptRecovery.leaseExpiresAt': DeletedField;
  'receiptRecovery.lastErrorCode': DeletedField;
  'receiptRecovery.lastErrorMessage': DeletedField;
  'receiptRecovery.lastPreparedProbeAt': DeletedField;
  'receiptRecovery.preparedProbeCount': DeletedField;
  'receiptRecovery.nextPreparedProbeAt': DeletedField;
  'receiptRecovery.status': DeletedField;
  processedAt: ServerTimestamp;
  irlClaimsUpdatedAt?: ServerTimestamp;
};

type DeliveryCloseUpdate = {
  dropId: string;
  closeDeliveryTx: string;
  deliveryClosedAt: ServerTimestamp;
};

type PendingReceiptSubmissionUpdate = {
  [RECEIPT_RECOVERY_PENDING_SUBMISSION_FIELD]: PendingReceiptSubmission;
  'receiptRecovery.leaseExpiresAt': ReturnType<typeof commerceTimestamp>;
};

type SettledReceiptSubmissionUpdate = {
  receiptTxs?: ReturnType<typeof commerceFieldValue.arrayUnion>;
  [RECEIPT_RECOVERY_PENDING_SUBMISSION_FIELD]: DeletedField;
};

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
  document: DeliveryOrderDocument,
  runtime: DeliveryRuntime,
  signature: string | null,
): Promise<void> {
  await runCommerceTransaction({ repository: context.repository, nowMs: context.nowMs }, async (transaction) => {
    await transaction.getMany([document.key]);
    await transaction.update(document.key, {
      dropId: runtime.dropId,
      status: 'processing',
      ...(signature ? { deliverySignature: signature } : {}),
      'receiptRecovery.lastPreparedProbeAt': commerceFieldValue.delete(),
      'receiptRecovery.preparedProbeCount': commerceFieldValue.delete(),
      'receiptRecovery.nextPreparedProbeAt': commerceFieldValue.delete(),
      'receiptRecovery.status': commerceFieldValue.delete(),
      ...(document.data.processingAt === undefined
        ? { processingAt: commerceFieldValue.serverTimestamp() }
        : {}),
    } satisfies DeliveryProcessingUpdate);
  }, { shouldRetry: () => false });
}

export async function markDeliveryReady(
  context: CommerceRepositoryContext,
  document: DeliveryOrderDocument,
  runtime: DeliveryRuntime,
  result: DeliveryReceiptCompletion,
): Promise<DeliveryOrderDocument> {
  const fields: DeliveryReadyFields = {
    dropId: runtime.dropId,
    status: 'ready_to_ship',
    ...(result.signature ? { deliverySignature: result.signature } : {}),
    receiptsMinted: result.receiptsMinted,
    receiptTxs: result.receiptTxs,
    ...(result.irlClaims.length ? { irlClaims: result.irlClaims } : {}),
  };
  const readyOrder = { ...document.data, ...fields };
  const packStatusOutbox = createDeliveryPackStatusProjectionOutbox(runtime, readyOrder, context.nowMs);
  Object.assign(readyOrder, Object.fromEntries(
    Object.entries(packStatusOutbox).filter(([, value]) => !isCommerceDeleteField(value)),
  ));
  await runCommerceTransaction({ repository: context.repository, nowMs: context.nowMs }, async (transaction) => {
    const current = await transaction.get(document.key);
    const notificationOutbox = createReadyToShipNotificationIntent({
      before: current?.data ?? {}, after: { ...current?.data, ...fields },
      parentPath: document.key.path, deliveryId: Number(document.key.documentId),
      dropId: runtime.dropId, nowMs: context.nowMs,
    });
    if (notificationOutbox) await transaction.enqueueNotificationOutbox(notificationOutbox);
    await transaction.update(document.key, {
      ...fields,
      ...packStatusOutbox,
      'receiptRecovery.leaseExpiresAt': commerceFieldValue.delete(),
      'receiptRecovery.lastErrorCode': commerceFieldValue.delete(),
      'receiptRecovery.lastErrorMessage': commerceFieldValue.delete(),
      'receiptRecovery.lastPreparedProbeAt': commerceFieldValue.delete(),
      'receiptRecovery.preparedProbeCount': commerceFieldValue.delete(),
      'receiptRecovery.nextPreparedProbeAt': commerceFieldValue.delete(),
      'receiptRecovery.status': commerceFieldValue.delete(),
      processedAt: commerceFieldValue.serverTimestamp(),
      ...(result.irlClaims.length
        ? { irlClaimsUpdatedAt: commerceFieldValue.serverTimestamp() }
        : {}),
    } satisfies DeliveryReadyUpdate);
  }, { shouldRetry: () => false });
  return { ...document, data: readyOrder };
}

export async function recordDeliveryClose(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  dropId: string,
  closeDeliveryTx: string,
): Promise<void> {
  await runCommerceTransaction({ repository: context.repository, nowMs: context.nowMs }, async (transaction) => {
    await transaction.getMany([key]);
    await transaction.update(key, {
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

export async function hasPendingReceiptSubmission(context: CommerceRepositoryContext, key: DeliveryOrderKey): Promise<boolean> {
  try {
    const document = await readDeliveryOrder(context, key);
    return Boolean(document && pendingReceiptSubmission(document.data));
  } catch {
    return true;
  }
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

export async function persistPendingReceiptSubmission(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  pending: PendingReceiptSubmission,
  createCleanupContext: () => CommerceRepositoryContext,
): Promise<void> {
  await mutateSubmissionJournal({
    context,
    key,
    phase: 'persist',
    createCleanupContext,
    plan: (document) => {
      if (!document) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
      const existing = pendingReceiptSubmission(document.data);
      if (existing && !samePendingReceiptSubmission(existing, pending)) {
        throw new DeliveryReceiptError('aborted', 'A receipt transaction is still being reconciled.');
      }
      return {
        [RECEIPT_RECOVERY_PENDING_SUBMISSION_FIELD]: pending,
        'receiptRecovery.leaseExpiresAt': commerceTimestamp(
          context.nowMs + DELIVERY_AMBIGUOUS_SUBMISSION_LEASE_MS,
        ),
      } satisfies PendingReceiptSubmissionUpdate;
    },
    isApplied: (document) => {
      const stored = document && pendingReceiptSubmission(document.data);
      return Boolean(stored && samePendingReceiptSubmission(stored, pending));
    },
  });
}

export async function settlePendingReceiptSubmission(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  pending: PendingReceiptSubmission,
  outcome: Exclude<TransactionSubmissionOutcome, 'unresolved'>,
  createCleanupContext: () => CommerceRepositoryContext,
): Promise<void> {
  await mutateSubmissionJournal({
    context,
    key,
    phase: 'settle',
    createCleanupContext,
    plan: (document) => {
      if (!document) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
      const existing = pendingReceiptSubmission(document.data);
      if (!existing) {
        if (pendingReceiptSubmissionAlreadySettled(document.data, pending, outcome)) return;
        throw new DeliveryReceiptError('aborted', 'Receipt submission recovery changed.');
      }
      if (!samePendingReceiptSubmission(existing, pending)) {
        throw new DeliveryReceiptError('aborted', 'Receipt submission recovery changed.');
      }
      return {
        ...(outcome === 'confirmed' ? { receiptTxs: commerceFieldValue.arrayUnion(pending.signature) } : {}),
        [RECEIPT_RECOVERY_PENDING_SUBMISSION_FIELD]: commerceFieldValue.delete(),
      } satisfies SettledReceiptSubmissionUpdate;
    },
    isApplied: (document) => {
      const stored = document && pendingReceiptSubmission(document.data);
      return Boolean(
        document && !stored &&
        pendingReceiptSubmissionAlreadySettled(document.data, pending, outcome)
      );
    },
  });
}
