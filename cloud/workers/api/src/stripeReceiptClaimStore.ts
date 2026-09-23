import {
  activeDirectCardReceiptClaimSignatures,
  directCardReceiptClaimHasRecipientLock,
  type DirectCardReceiptClaimSubmission,
} from './adminIrlCardReceipt.js';
import { isSignalCancellationError } from './boundedRequest.js';
import { getApiDrop } from './dropConfig.js';
import { isRecord } from './dataAccess.js';
import {
  commerceFieldValue,
  commerceKeys,
} from './commerceRepository.js';
import { deliveryOrderKey, readDeliveryOrder, updateDeliveryOrder } from './deliveryOrderStore.js';
import type {
  DeliveryReceiptClaimFields,
  DeliveryReceiptClaimUpdates,
  DeliveryReceiptClaimValues,
} from './deliveryOrderUpdates.js';
import {
  commerceTimestamp,
  readCommerceRecord,
  runCommerceTransaction,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';
import {
  StripeReceiptClaimError,
  summarizeStripeReceiptClaimError as summarizeError,
} from './stripeReceiptClaimErrors.js';
import {
  parseReceiptClaimWorkflowState,
  RECEIPT_CLAIM_WORKFLOW_FIELD,
  RECEIPT_CLAIM_WORKFLOW_WINDOW_MS,
  receiptClaimWorkflowAttemptId,
  type ReceiptClaimWorkflowState,
} from './stripeReceiptClaimWorkflowState.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import { isBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import { isReceiptClaimDeliveryOrderSource } from '../../../../shared/fulfillmentSources.js';
import {
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  hasPluralStripeReceiptClaims,
  normalizeStripeReceiptClaimCode,
  orderStripeReceiptClaimByBoxId,
  stripeAssignedIrlClaimForBox,
  stripeReceiptClaimBoxMapKey,
  stripeReceiptClaimCodeMaybe,
  type StripeAssignedIrlClaim,
} from '../../../../shared/stripeReceiptClaims.js';

const CLEANUP_TIMEOUT_MS = 5_000;
const PROCESSING_LEASE_MS = 90_000;
const DIRECT_SUBMISSION_PROCESSING_LEASE_MS = 4 * 60_000;

export type ReceiptKind = 'box' | 'figure';
type StoredResult = {
  receiptKind?: ReceiptKind;
  receiptsTransferred?: number;
  figureIds?: number[];
  receiptAssetIds?: string[];
};
export type StartedClaim = {
  status: 'started';
  dropId: string;
  deliveryId: number;
  boxId: number;
  attemptId: string;
  orderPath: string;
  orderIrlClaims: unknown[];
  resumingPreviousProcessingClaim: boolean;
  hasPreviousClaimFailure: boolean;
  updatePluralOrderClaim: boolean;
  updateSingularOrderClaim: boolean;
  directFigureReceipt?: { receiptAssetId: string; figureId: number };
  receiptTxs: string[];
  receiptTxSubmissions: DirectCardReceiptClaimSubmission[];
};
type ClaimStart = (StartedClaim & { workflow?: ReceiptClaimWorkflowState }) | ({ status: 'already_claimed'; dropId: string; deliveryId: number; boxId: number; receiptTxs: string[] } & StoredResult);

function positiveInteger(value: unknown, label: string): number {
  const normalized = Math.floor(Number(value));
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 0xffff_ffff) {
    throw new StripeReceiptClaimError('failed-precondition', `Claim code is missing a valid ${label}.`);
  }
  return normalized;
}

export function normalizeReceiptTxs(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim())))
    : [];
}

function directReceiptAssetId(value: Record<string, unknown>): string {
  return value.receiptKind === 'figure' && typeof value.receiptAssetId === 'string'
    ? value.receiptAssetId.trim()
    : '';
}

export function normalizeSubmissions(value: unknown): DirectCardReceiptClaimSubmission[] {
  if (!Array.isArray(value)) return [];
  const bySignature = new Map<string, DirectCardReceiptClaimSubmission>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const signature = typeof entry.signature === 'string' ? entry.signature.trim() : '';
    const lastValidBlockHeight = Math.floor(Number(entry.lastValidBlockHeight));
    const submittedAtMs = Number(entry.submittedAtMs);
    const status = entry.status === 'not_landed' ? 'not_landed' : 'submitted';
    if (!signature || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1 || !Number.isFinite(submittedAtMs) || submittedAtMs <= 0) continue;
    bySignature.set(signature, { signature, lastValidBlockHeight, submittedAtMs, status });
  }
  return [...bySignature.values()];
}

function normalizePositiveIntegerArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter((entry) => Number.isSafeInteger(entry) && entry > 0 && entry <= 0xffff_ffff)
    : [];
}

function normalizeStoredResult(value: Record<string, unknown>): StoredResult {
  const receiptKind = value.receiptKind === 'box' || value.receiptKind === 'figure' ? value.receiptKind : undefined;
  const receiptsTransferred = positiveStoredInteger(value.receiptsTransferred);
  const figureIds = normalizePositiveIntegerArray(value.figureIds);
  const receiptAssetId = receiptKind === 'figure' && typeof value.receiptAssetId === 'string' ? value.receiptAssetId.trim() : '';
  return {
    ...(receiptKind ? { receiptKind } : {}),
    ...(receiptsTransferred ? { receiptsTransferred } : {}),
    ...(figureIds.length ? { figureIds } : {}),
    ...(receiptAssetId ? { receiptAssetIds: [receiptAssetId] } : {}),
  };
}

function positiveStoredInteger(value: unknown): number | undefined {
  const normalized = Math.floor(Number(value));
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : undefined;
}

function orderTarget(order: Record<string, unknown>, code: string, boxId: number): {
  updatePluralOrderClaim: boolean;
  updateSingularOrderClaim: boolean;
} {
  const pluralClaim = orderStripeReceiptClaimByBoxId(order, boxId);
  if (pluralClaim) {
    const pluralCode = stripeReceiptClaimCodeMaybe(pluralClaim);
    if (pluralCode && pluralCode !== code) {
      throw new StripeReceiptClaimError('failed-precondition', 'Receipt order claim code mismatch.');
    }
    const singularClaim = isRecord(order.stripeReceiptClaim) ? order.stripeReceiptClaim : {};
    const singularCode = stripeReceiptClaimCodeMaybe(singularClaim);
    const singularBoxId = Math.floor(Number(singularClaim.boxId));
    return {
      updatePluralOrderClaim: true,
      updateSingularOrderClaim: singularCode === code || (!singularCode && Number.isSafeInteger(singularBoxId) && singularBoxId === boxId),
    };
  }
  if (hasPluralStripeReceiptClaims(order)) {
    throw new StripeReceiptClaimError('failed-precondition', 'Receipt order claim code mismatch.');
  }
  const singularClaim = isRecord(order.stripeReceiptClaim) ? order.stripeReceiptClaim : {};
  const singularCode = stripeReceiptClaimCodeMaybe(singularClaim);
  if (singularCode && singularCode !== code) {
    throw new StripeReceiptClaimError('failed-precondition', 'Receipt order claim code mismatch.');
  }
  const items = Array.isArray(order.items) ? order.items : [];
  const firstItem = isRecord(items[0]) ? items[0] : {};
  const orderBoxId = Math.floor(Number(singularClaim.boxId ?? firstItem.refId));
  if (Number.isSafeInteger(orderBoxId) && orderBoxId > 0 && orderBoxId !== boxId) {
    throw new StripeReceiptClaimError('failed-precondition', 'Receipt order box id mismatch.');
  }
  return { updatePluralOrderClaim: false, updateSingularOrderClaim: true };
}

function orderClaimValues(args: {
  code: string;
  boxId: number;
  status: 'processing' | 'unclaimed' | 'claimed';
  values: DeliveryReceiptClaimValues;
  updatePluralOrderClaim: boolean;
  updateSingularOrderClaim: boolean;
}): DeliveryReceiptClaimUpdates {
  const entries: Array<[string, DeliveryReceiptClaimFields[keyof DeliveryReceiptClaimFields]]> = [];
  const claim = {
    namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
    code: args.code,
    boxId: args.boxId,
    status: args.status,
    ...args.values,
  } satisfies DeliveryReceiptClaimFields;
  const assign = (prefix: 'stripeReceiptClaim' | `stripeReceiptClaimsByBoxId.box_${number}`) => {
    for (const [key, value] of Object.entries(claim)) entries.push([`${prefix}.${key}`, value]);
  };
  if (args.updatePluralOrderClaim) assign(`stripeReceiptClaimsByBoxId.${stripeReceiptClaimBoxMapKey(args.boxId) as `box_${number}`}`);
  if (args.updateSingularOrderClaim) assign('stripeReceiptClaim');
  return Object.fromEntries(entries) as DeliveryReceiptClaimUpdates;
}

function timestamp(value: number) {
  return commerceTimestamp(value);
}

export async function startClaim(
  context: CommerceRepositoryContext,
  code: string,
  recipientWallet: string,
  attemptId: string,
  nowMs: number,
  workflow?: { operationId: string; requestId: string; allowNew?: boolean },
): Promise<ClaimStart> {
  const claimKey = commerceKeys.claimCode(code);
  let attemptedStart: StartedClaim | undefined;
  try {
    return await runCommerceTransaction<ClaimStart>(context, async (transaction) => {
      const claimDocument = await readCommerceRecord(context, claimKey, transaction);
      if (!claimDocument) throw new StripeReceiptClaimError('not-found', 'Invalid receipt claim code.');
      const claim = claimDocument.data;
      if (claim.namespace !== STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE) {
        throw new StripeReceiptClaimError('not-found', 'Invalid receipt claim code.');
      }
      if (typeof claim.code === 'string' && normalizeStripeReceiptClaimCode(claim.code) !== code) {
        throw new StripeReceiptClaimError('failed-precondition', 'Claim code record is inconsistent.');
      }
      const rawDropId = typeof claim.dropId === 'string' ? claim.dropId : '';
      const dropId = normalizeDropId(rawDropId);
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dropId) || !getApiDrop(dropId)) {
        throw new StripeReceiptClaimError('failed-precondition', 'Claim code has an invalid drop id.');
      }
      const deliveryId = positiveInteger(claim.deliveryId, 'delivery id');
      const boxId = positiveInteger(claim.boxId, 'box id');
      const directAssetId = directReceiptAssetId(claim);
      const directFigureId = Math.floor(Number(claim.figureId));
      const directFigureReceipt = directAssetId ? { receiptAssetId: directAssetId, figureId: directFigureId } : undefined;
      if (directFigureReceipt && (!Number.isSafeInteger(directFigureId) || directFigureId < 1 || directFigureId !== boxId)) {
        throw new StripeReceiptClaimError('failed-precondition', 'Direct card receipt claim target is invalid.');
      }
      const status = typeof claim.status === 'string' ? claim.status : 'unclaimed';
      const claimedRecipient = typeof claim.recipient === 'string' ? claim.recipient : '';
      if (workflow && status === 'processing' && !isBase58Bytes(claimedRecipient, 32)) {
        throw new StripeReceiptClaimError('failed-precondition', 'Previous receipt claim receiver is invalid. Contact support.');
      }
      let existingWorkflow = parseReceiptClaimWorkflowState(claim[RECEIPT_CLAIM_WORKFLOW_FIELD]);
      if (existingWorkflow) {
        if (!workflow) throw new StripeReceiptClaimError('aborted', 'This receipt claim is managed by a Workflow.');
        if (existingWorkflow.recipient !== recipientWallet) {
          throw new StripeReceiptClaimError('failed-precondition', 'This receipt claim is locked to its original receiver.');
        }
        if (existingWorkflow.phase === 'pending' && !existingWorkflow.requestIds.includes(workflow.requestId)) {
          if (existingWorkflow.requestIds.length >= 64) throw new StripeReceiptClaimError('resource-exhausted', 'Too many receipt claim attempts. Contact support.');
          existingWorkflow = { ...existingWorkflow, requestIds: [...existingWorkflow.requestIds, workflow.requestId] };
          parseReceiptClaimWorkflowState(existingWorkflow);
          await transaction.update(claimKey, { [RECEIPT_CLAIM_WORKFLOW_FIELD]: JSON.parse(JSON.stringify(existingWorkflow)),
            updatedAt: commerceFieldValue.serverTimestamp() });
        }
        return { ...existingWorkflow.claim, attemptId: receiptClaimWorkflowAttemptId(existingWorkflow),
          receiptTxs: normalizeReceiptTxs(claim.receiptTxs), receiptTxSubmissions: normalizeSubmissions(claim.receiptTxSubmissions),
          workflow: existingWorkflow };
      }
      const receiptTxSubmissions = normalizeSubmissions(claim.receiptTxSubmissions);
      const storedReceiptTxs = normalizeReceiptTxs(claim.receiptTxs);
      const receiptTxs = directFigureReceipt
        ? activeDirectCardReceiptClaimSignatures({ receiptTxs: storedReceiptTxs, submissions: receiptTxSubmissions })
        : storedReceiptTxs;
      const storedResult = normalizeStoredResult(claim);
      const directRecipientLock = Boolean(directFigureReceipt && directCardReceiptClaimHasRecipientLock({
        hasRecipient: Boolean(claimedRecipient),
        receiptTxCount: receiptTxs.length,
      }));
      const recipientLock = workflow && status === 'processing' ? true : directFigureReceipt ? directRecipientLock : status === 'processing';
      if (status === 'claimed') {
        if (claimedRecipient === recipientWallet) {
          return { status: 'already_claimed' as const, dropId, deliveryId, boxId, receiptTxs, ...storedResult };
        }
        throw new StripeReceiptClaimError('failed-precondition', 'This receipt claim code has already been used.');
      }
      if (workflow?.allowNew === false) {
        throw new StripeReceiptClaimError('unavailable', 'New receipt claims are temporarily paused.');
      }
      const leaseExpiresAt = Number(claim.processingLeaseExpiresAt || 0);
      if (workflow && status === 'processing' && Math.max(leaseExpiresAt, Number(claim.processingStartedAt || 0) + 180_000) > nowMs) {
        throw new StripeReceiptClaimError('aborted', 'The previous receipt claim request is still finishing. Retry shortly.');
      }
      if (status === 'processing' && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowMs) {
        throw new StripeReceiptClaimError('aborted', 'This receipt claim code is already being processed.');
      }
      if (recipientLock && claimedRecipient && claimedRecipient !== recipientWallet) {
        throw new StripeReceiptClaimError(
          'failed-precondition',
          'This receipt claim code is locked to the receiver address from the previous attempt. Retry with that same address.',
        );
      }
      const orderKey = commerceKeys.deliveryOrder(dropId, String(deliveryId));
      const orderDocument = await readDeliveryOrder(context, orderKey, transaction);
      if (!orderDocument) throw new StripeReceiptClaimError('not-found', 'Receipt claim order not found.');
      const order = orderDocument.data;
      if (!isReceiptClaimDeliveryOrderSource(order.source)) {
        throw new StripeReceiptClaimError('failed-precondition', 'Claim code is not for a receipt claim order.');
      }
      if (directFigureReceipt) {
        const storedOrderClaim = isRecord(order.stripeReceiptClaim) ? order.stripeReceiptClaim : {};
        if (
          storedOrderClaim.receiptKind !== 'figure' ||
          storedOrderClaim.receiptAssetId !== directFigureReceipt.receiptAssetId ||
          Math.floor(Number(storedOrderClaim.figureId)) !== directFigureReceipt.figureId
        ) {
          throw new StripeReceiptClaimError('failed-precondition', 'Direct card receipt order target mismatch.');
        }
      }
      const target = orderTarget(order, code, boxId);
      const orderValues = {
        dropId,
        ...orderClaimValues({
          code,
          boxId,
          status: 'processing',
          values: {
            recipient: recipientWallet,
            processingLeaseExpiresAt: workflow ? commerceFieldValue.delete() : timestamp(nowMs + PROCESSING_LEASE_MS),
            processingStartedAt: commerceFieldValue.serverTimestamp(),
          },
          ...target,
        }),
      };
      attemptedStart = {
        status: 'started',
        dropId,
        deliveryId,
        boxId,
        attemptId,
        orderPath: orderKey.path,
        orderIrlClaims: Array.isArray(order.irlClaims) ? order.irlClaims : [],
        receiptTxs,
        receiptTxSubmissions,
        resumingPreviousProcessingClaim: recipientLock && claimedRecipient === recipientWallet,
        hasPreviousClaimFailure: Boolean(claim.lastClaimError || claim.lastClaimErrorAt),
        ...(directFigureReceipt ? { directFigureReceipt } : {}),
        ...target,
      };
      const reservedWorkflow: ReceiptClaimWorkflowState | undefined = workflow ? {
        version: 1, operationId: workflow.operationId, requestId: workflow.requestId, requestIds: [workflow.requestId], generation: 1, recipient: recipientWallet,
        phase: 'pending', createdAtMs: nowMs, deadlineAtMs: nowMs + RECEIPT_CLAIM_WORKFLOW_WINDOW_MS,
        nextAttemptAtMs: nowMs, dispatchLeaseUntilMs: null, claim: attemptedStart, submissionHistory: [],
      } : undefined;
      if (reservedWorkflow) parseReceiptClaimWorkflowState(reservedWorkflow);
      await transaction.getMany([claimKey, orderKey]);
      await transaction.update(claimKey, {
        status: 'processing',
        recipient: recipientWallet,
        processingAttemptId: attemptId,
        processingLeaseExpiresAt: workflow ? commerceFieldValue.delete() : timestamp(nowMs + PROCESSING_LEASE_MS),
        processingStartedAt: commerceFieldValue.serverTimestamp(),
        updatedAt: commerceFieldValue.serverTimestamp(),
        ...(reservedWorkflow ? { [RECEIPT_CLAIM_WORKFLOW_FIELD]: JSON.parse(JSON.stringify(reservedWorkflow)) } : {}),
      });
      await updateDeliveryOrder(transaction, orderKey, orderValues);
      return reservedWorkflow ? { ...attemptedStart, workflow: reservedWorkflow } : attemptedStart;
    });
  } catch (error) {
    const cancellation = isSignalCancellationError(context.signal, error);
    if (!attemptedStart || (error instanceof StripeReceiptClaimError && !cancellation)) {
      if (cancellation) throw context.signal.reason;
      throw error;
    }
    try {
      const cleanup = cleanupContext(context);
      const claim = await readCommerceRecord(cleanup, claimKey);
      if (
        claim?.data.status === 'processing' &&
        claim.data.processingAttemptId === attemptId &&
        claim.data.recipient === recipientWallet
      ) {
        const order = await readDeliveryOrder(cleanup, deliveryOrderKey(attemptedStart.orderPath));
        const orderClaims = order ? [
          ...(attemptedStart.updatePluralOrderClaim
            ? [orderStripeReceiptClaimByBoxId(order.data, attemptedStart.boxId)]
            : []),
          ...(attemptedStart.updateSingularOrderClaim
            ? [isRecord(order.data.stripeReceiptClaim) ? order.data.stripeReceiptClaim : null]
            : []),
        ] : [];
        if (
          orderClaims.length > 0 &&
          orderClaims.every((stored) => (
            stored?.status === 'processing' &&
            stored.recipient === recipientWallet &&
            stripeReceiptClaimCodeMaybe(stored) === code
          ))
        ) {
          if (cancellation && !workflow) {
            await clearProcessing(context, attemptedStart, code, context.signal.reason);
          } else {
            const reservedWorkflow = parseReceiptClaimWorkflowState(claim.data[RECEIPT_CLAIM_WORKFLOW_FIELD]);
            return reservedWorkflow ? { ...attemptedStart, workflow: reservedWorkflow } : attemptedStart;
          }
        }
      }
    } catch {}
    if (cancellation) throw context.signal.reason;
    throw error;
  }
}

function cleanupContext(context: CommerceRepositoryContext): CommerceRepositoryContext {
  return {
    ...context,
    nowMs: Date.now(),
    signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
  };
}

export async function clearProcessing(
  context: CommerceRepositoryContext,
  started: StartedClaim,
  code: string,
  error: unknown,
): Promise<void> {
  const safeContext = cleanupContext(context);
  try {
    await runCommerceTransaction(safeContext, async (transaction) => {
      const claimKey = commerceKeys.claimCode(code);
      const claim = await readCommerceRecord(safeContext, claimKey, transaction);
      if (claim?.data[RECEIPT_CLAIM_WORKFLOW_FIELD]) return;
      if (!claim || claim.data.status !== 'processing' || claim.data.processingAttemptId !== started.attemptId) {
        return;
      }
      const lastError = summarizeError(error);
      const orderValues = orderClaimValues({
        code,
        boxId: started.boxId,
        status: 'unclaimed',
        values: {
          lastClaimError: lastError,
          recipient: commerceFieldValue.delete(),
          processingStartedAt: commerceFieldValue.delete(),
          processingLeaseExpiresAt: commerceFieldValue.delete(),
        },
        updatePluralOrderClaim: started.updatePluralOrderClaim,
        updateSingularOrderClaim: started.updateSingularOrderClaim,
      });
      const orderKey = deliveryOrderKey(started.orderPath);
      await transaction.getMany([claimKey, orderKey]);
      await transaction.update(claimKey, {
        status: 'unclaimed',
        lastClaimError: lastError,
        processingAttemptId: commerceFieldValue.delete(),
        processingStartedAt: commerceFieldValue.delete(),
        processingLeaseExpiresAt: commerceFieldValue.delete(),
        lastClaimErrorAt: commerceFieldValue.serverTimestamp(),
        updatedAt: commerceFieldValue.serverTimestamp(),
      });
      await updateDeliveryOrder(transaction, orderKey, orderValues);
    });
  } catch (cleanupError) {
    console.warn({
      event: 'stripe_receipt_claim_cleanup_failed',
      dropId: started.dropId,
      deliveryId: started.deliveryId,
      error: summarizeError(cleanupError),
    });
  }
}

export async function rememberSubmittedTransaction(
  context: CommerceRepositoryContext,
  code: string,
  attemptId: string,
  receiptTx: string,
  submission?: Omit<DirectCardReceiptClaimSubmission, 'signature'> | null,
): Promise<void> {
  const safeContext = context.signal.aborted ? cleanupContext(context) : context;
  await runCommerceTransaction(safeContext, async (transaction) => {
    const key = commerceKeys.claimCode(code);
    const claim = await readCommerceRecord(safeContext, key, transaction);
    if (!claim) throw new StripeReceiptClaimError('not-found', 'Receipt claim code not found.');
    if (claim.data[RECEIPT_CLAIM_WORKFLOW_FIELD]) throw new StripeReceiptClaimError('aborted', 'This receipt claim is managed by a Workflow.');
    if (claim.data.status !== 'processing' || claim.data.processingAttemptId !== attemptId) {
      throw new StripeReceiptClaimError('aborted', 'Receipt claim processing lease changed.');
    }
    const isDirect = Boolean(directReceiptAssetId(claim.data));
    const normalizedSubmission = isDirect && submission
      ? normalizeSubmissions([{ signature: receiptTx, ...submission }])[0]
      : undefined;
    const submissions = isDirect ? normalizeSubmissions(claim.data.receiptTxSubmissions) : [];
    if (normalizedSubmission) {
      const existing = submissions.findIndex((entry) => entry.signature === normalizedSubmission.signature);
      if (existing >= 0) submissions[existing] = normalizedSubmission;
      else submissions.push(normalizedSubmission);
    }
    const merged = Array.from(new Set([...normalizeReceiptTxs(claim.data.receiptTxs), receiptTx]));
    const receiptTxs = isDirect && submissions.length
      ? activeDirectCardReceiptClaimSignatures({ receiptTxs: merged, submissions })
      : merged;
    const values = {
      receiptTxs,
      ...(normalizedSubmission ? { receiptTxSubmissions: submissions } : {}),
      ...(normalizedSubmission
        ? { processingLeaseExpiresAt: timestamp(Date.now() + DIRECT_SUBMISSION_PROCESSING_LEASE_MS) }
        : {}),
      updatedAt: commerceFieldValue.serverTimestamp(),
    };
    await transaction.getMany([key]);
    await transaction.update(key, values);
  });
}

export async function finalizeClaim(
  context: CommerceRepositoryContext,
  started: StartedClaim,
  code: string,
  recipientWallet: string,
  receiptTx: string | null,
  receiptKind: ReceiptKind,
  receiptsTransferred: number,
  figureIds?: number[],
  workflow?: { operationId: string; generation: number; result: import('../../../../shared/contracts.js').StripeReceiptClaimResult },
): Promise<string[]> {
  const safeContext = context.signal.aborted ? cleanupContext(context) : context;
  return runCommerceTransaction(safeContext, async (transaction) => {
    const claimKey = commerceKeys.claimCode(code);
    const claim = await readCommerceRecord(safeContext, claimKey, transaction);
    if (!claim) throw new StripeReceiptClaimError('not-found', 'Receipt claim code not found.');
    const operation = parseReceiptClaimWorkflowState(claim.data[RECEIPT_CLAIM_WORKFLOW_FIELD]);
    if (operation && (!workflow || operation.operationId !== workflow.operationId || operation.generation !== workflow.generation || operation.recipient !== recipientWallet)) {
      throw new StripeReceiptClaimError('aborted', 'Receipt claim Workflow execution changed.');
    }
    if (operation && operation.phase !== 'pending' && operation.phase !== 'complete') throw new StripeReceiptClaimError('aborted', 'Receipt claim Workflow is no longer pending.');
    const storedReceiptTxs = normalizeReceiptTxs(claim.data.receiptTxs);
    const isDirect = Boolean(directReceiptAssetId(claim.data));
    const submissions = isDirect ? normalizeSubmissions(claim.data.receiptTxSubmissions) : [];
    const existingTxs = isDirect && submissions.length
      ? activeDirectCardReceiptClaimSignatures({ receiptTxs: storedReceiptTxs, submissions })
      : storedReceiptTxs;
    if (claim.data.status === 'claimed') {
      if (claim.data.recipient !== recipientWallet) {
        throw new StripeReceiptClaimError('failed-precondition', 'This receipt claim code has already been used.');
      }
      return existingTxs;
    }
    if (claim.data.processingAttemptId !== started.attemptId) {
      throw new StripeReceiptClaimError('aborted', 'Receipt claim processing lease changed.');
    }
    const receiptTxs = receiptTx ? Array.from(new Set([...existingTxs, receiptTx])) : existingTxs;
    const orderValues = {
      dropId: started.dropId,
      ...orderClaimValues({
        code,
        boxId: started.boxId,
        status: 'claimed',
        values: {
          recipient: recipientWallet,
          receiptTxs,
          receiptKind,
          receiptsTransferred,
          figureIds: figureIds?.length ? figureIds : commerceFieldValue.delete(),
          processingStartedAt: commerceFieldValue.delete(),
          processingLeaseExpiresAt: commerceFieldValue.delete(),
          claimedAt: commerceFieldValue.serverTimestamp(),
        },
        updatePluralOrderClaim: started.updatePluralOrderClaim,
        updateSingularOrderClaim: started.updateSingularOrderClaim,
      }),
    };
    const orderKey = deliveryOrderKey(started.orderPath);
    await transaction.getMany([claimKey, orderKey]);
    await transaction.update(claimKey, {
      status: 'claimed',
      recipient: recipientWallet,
      receiptTxs,
      receiptKind,
      receiptsTransferred,
      figureIds: figureIds?.length ? figureIds : commerceFieldValue.delete(),
      processingAttemptId: commerceFieldValue.delete(),
      processingStartedAt: commerceFieldValue.delete(),
      processingLeaseExpiresAt: commerceFieldValue.delete(),
      claimedAt: commerceFieldValue.serverTimestamp(),
      updatedAt: commerceFieldValue.serverTimestamp(),
      ...(operation && workflow ? { [RECEIPT_CLAIM_WORKFLOW_FIELD]: JSON.parse(JSON.stringify({
        ...operation, phase: 'complete', result: workflow.result, error: undefined,
        nextAttemptAtMs: null, dispatchLeaseUntilMs: null,
      })) } : {}),
    });
    await updateDeliveryOrder(transaction, orderKey, orderValues);
    return receiptTxs;
  });
}

export async function loadClaimAssignment(
  context: CommerceRepositoryContext,
  args: {
    dropId: string;
    deliveryId: number;
    boxId: number;
    itemsPerBox: number;
    maxDudeId: number;
  },
): Promise<StripeAssignedIrlClaim | null> {
  const order = await readCommerceRecord(context, commerceKeys.deliveryOrder(args.dropId, String(args.deliveryId)));
  return order
    ? stripeAssignedIrlClaimForBox(order.data, args.boxId, {
        itemsPerBox: args.itemsPerBox,
        maxDudeId: args.maxDudeId,
      })
    : null;
}
