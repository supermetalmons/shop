import type { StripeReceiptClaimResult } from '../../../../shared/contracts.js';
import { normalizeStripeReceiptClaimCode } from '../../../../shared/stripeReceiptClaims.js';
import { commerceFieldValue, commerceKeys, type CommerceDocumentData, type CommerceDocumentRecord } from './commerceRepository.js';
import { readCommerceRecord, runCommerceTransaction, type CommerceRepositoryContext } from './commerceTransactions.js';
import { StripeReceiptClaimError } from './stripeReceiptClaimErrors.js';
import { activeDirectCardReceiptClaimSignatures, type DirectCardReceiptClaimSubmission } from './adminIrlCardReceipt.js';
import type { ProviderContext } from './adminIrlRedeemOnchain.js';
import { responseForAlreadyClaimed } from './stripeReceiptClaim.js';
import { finalizeClaim, normalizeReceiptTxs, normalizeSubmissions, startClaim } from './stripeReceiptClaimStore.js';
import {
  RECEIPT_CLAIM_WORKFLOW_DISPATCH_LEASE_MS,
  RECEIPT_CLAIM_WORKFLOW_FIELD,
  RECEIPT_CLAIM_WORKFLOW_WINDOW_MS,
  isReceiptClaimWorkflowOperationId,
  parseReceiptClaimWorkflowState,
  parseReceiptClaimWorkflowSubmission,
  receiptClaimWorkflowAttemptId,
  type ReceiptClaimWorkflowError,
  type ReceiptClaimWorkflowSnapshot,
  type ReceiptClaimWorkflowState,
  type ReceiptClaimWorkflowSubmission,
} from './stripeReceiptClaimWorkflowState.js';

function data(value: unknown): CommerceDocumentData {
  return JSON.parse(JSON.stringify(value)) as CommerceDocumentData;
}

function snapshot(document: CommerceDocumentRecord): ReceiptClaimWorkflowSnapshot | null {
  const operation = parseReceiptClaimWorkflowState(document.data[RECEIPT_CLAIM_WORKFLOW_FIELD]);
  if (!operation) return null;
  if (document.key.kind !== 'claim_code' || document.data.namespace !== 'stripe_receipt_v1' ||
    document.data.recipient !== operation.recipient || document.data.dropId !== operation.claim.dropId ||
    document.data.deliveryId !== operation.claim.deliveryId || document.data.boxId !== operation.claim.boxId ||
    document.data.status !== (operation.phase === 'complete' ? 'claimed' : 'processing') ||
    (operation.phase === 'pending' && document.data.processingAttemptId !== receiptClaimWorkflowAttemptId(operation))) {
    throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim Workflow identity is inconsistent.');
  }
  return {
    code: document.key.documentId,
    operation,
    started: {
      ...operation.claim,
      attemptId: receiptClaimWorkflowAttemptId(operation),
      receiptTxs: normalizeReceiptTxs(document.data.receiptTxs),
      receiptTxSubmissions: normalizeSubmissions(document.data.receiptTxSubmissions),
    },
  };
}

export async function reserveReceiptClaimWorkflow(
  context: CommerceRepositoryContext,
  code: string,
  recipient: string,
  nowMs: number,
  options: { allowNew?: boolean; requestId?: string; provider?: ProviderContext } = {},
): Promise<{ status: 'pending'; snapshot: ReceiptClaimWorkflowSnapshot } | { status: 'complete'; result: StripeReceiptClaimResult }> {
  const normalizedCode = normalizeStripeReceiptClaimCode(code);
  const operationId = `src-v1-${crypto.randomUUID()}`;
  const claim = await startClaim(context, normalizedCode, recipient,
    receiptClaimWorkflowAttemptId({ operationId, generation: 1 }), nowMs, {
      operationId, requestId: options.requestId ?? crypto.randomUUID(), allowNew: options.allowNew,
    });
  if (claim.status === 'already_claimed') {
    return { status: 'complete', result: await responseForAlreadyClaimed(context, claim, recipient, options.provider) };
  }
  if (!claim.workflow) throw new StripeReceiptClaimError('internal', 'Receipt claim Workflow was not reserved.');
  if (claim.workflow.phase === 'complete' && claim.workflow.result) return { status: 'complete', result: claim.workflow.result };
  const { workflow, ...started } = claim;
  return { status: 'pending', snapshot: { code: normalizedCode, started, operation: workflow } };
}

export async function loadReceiptClaimWorkflow(context: CommerceRepositoryContext, operationId: string): Promise<ReceiptClaimWorkflowSnapshot | null> {
  if (!isReceiptClaimWorkflowOperationId(operationId)) return null;
  const document = await context.repository.getReceiptClaimWorkflowOperation(operationId);
  return document ? snapshot(document) : null;
}

export async function queryDueReceiptClaimWorkflows(db: D1Database, nowMs: number, limit = 20): Promise<string[]> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new StripeReceiptClaimError('invalid-argument', 'Invalid receipt claim recovery query.');
  }
  const rows = await db.prepare(`SELECT json_extract(document_json, '$.receiptClaimWorkflowV1.operationId') AS operation_id
    FROM commerce_documents INDEXED BY commerce_receipt_claim_workflow_due
    WHERE document_kind = 'claim_code' AND json_extract(document_json, '$.receiptClaimWorkflowV1.phase') = 'pending'
      AND json_extract(document_json, '$.receiptClaimWorkflowV1.nextAttemptAtMs') <= ?
      AND EXISTS (SELECT 1 FROM commerce_authority_control WHERE singleton = 1 AND authority_state = 'd1')
    ORDER BY json_extract(document_json, '$.receiptClaimWorkflowV1.nextAttemptAtMs'), document_path LIMIT ?`)
    .bind(nowMs, limit).all<{ operation_id: string }>();
  return rows.results.map((row) => row.operation_id).filter(isReceiptClaimWorkflowOperationId);
}

async function mutate(
  context: CommerceRepositoryContext,
  expected: ReceiptClaimWorkflowSnapshot,
  update: (current: ReceiptClaimWorkflowSnapshot) => ReceiptClaimWorkflowState | null,
): Promise<ReceiptClaimWorkflowSnapshot | null> {
  let applied: ReceiptClaimWorkflowState | null = null;
  try {
    return await runCommerceTransaction(context, async (transaction) => {
      applied = null;
      const key = commerceKeys.claimCode(expected.code);
      const document = await readCommerceRecord(context, key, transaction);
      const current = document ? snapshot(document) : null;
      if (!current || current.operation.operationId !== expected.operation.operationId ||
        current.operation.generation !== expected.operation.generation) return null;
      const next = update(current);
      if (!next) return null;
      if (JSON.stringify(next) === JSON.stringify(current.operation)) return current;
      applied = parseReceiptClaimWorkflowState(next);
      await transaction.update(key, {
        [RECEIPT_CLAIM_WORKFLOW_FIELD]: data(applied),
        ...(next.phase === 'pending' ? { processingAttemptId: receiptClaimWorkflowAttemptId(next) } : {}),
        updatedAt: commerceFieldValue.serverTimestamp(),
      });
      return { ...current, operation: next, started: { ...current.started, attemptId: receiptClaimWorkflowAttemptId(next) } };
    });
  } catch (error) {
    if (applied) {
      try {
        const cleanup = { ...context, signal: AbortSignal.timeout(5_000), nowMs: Date.now() };
        const document = await readCommerceRecord(cleanup, commerceKeys.claimCode(expected.code));
        const current = document ? snapshot(document) : null;
        if (current && JSON.stringify(current.operation) === JSON.stringify(applied)) return current;
      } catch {}
    }
    throw error;
  }
}

function requirePending(current: ReceiptClaimWorkflowSnapshot): void {
  if (current.operation.phase !== 'pending') throw new StripeReceiptClaimError('aborted', 'Receipt claim Workflow is no longer pending.');
}

function requireMutation(value: ReceiptClaimWorkflowSnapshot | null): ReceiptClaimWorkflowSnapshot {
  if (!value) throw new StripeReceiptClaimError('aborted', 'Receipt claim Workflow execution changed.');
  return value;
}

export async function claimReceiptClaimWorkflowDispatch(context: CommerceRepositoryContext, args: { operationId: string; generation: number; nowMs: number }): Promise<ReceiptClaimWorkflowSnapshot | null> {
  const current = await loadReceiptClaimWorkflow(context, args.operationId);
  if (!current || current.operation.generation !== args.generation) return null;
  return mutate(context, current, ({ operation }) => {
    if (operation.phase !== 'pending' || (operation.dispatchLeaseUntilMs ?? 0) > args.nowMs) return null;
    return { ...operation, dispatchLeaseUntilMs: args.nowMs + RECEIPT_CLAIM_WORKFLOW_DISPATCH_LEASE_MS,
      nextAttemptAtMs: args.nowMs + RECEIPT_CLAIM_WORKFLOW_DISPATCH_LEASE_MS };
  });
}

export async function markReceiptClaimWorkflowDispatched(context: CommerceRepositoryContext, expected: ReceiptClaimWorkflowSnapshot, nowMs: number): Promise<void> {
  await mutate(context, expected, ({ operation }) => operation.phase !== 'pending' || operation.dispatchLeaseUntilMs !== expected.operation.dispatchLeaseUntilMs ? null : {
    ...operation, dispatchLeaseUntilMs: null, nextAttemptAtMs: nowMs + 60_000,
  });
}

export async function advanceReceiptClaimWorkflowGeneration(context: CommerceRepositoryContext, expected: ReceiptClaimWorkflowSnapshot, nowMs: number, options: { resetRetryWindow?: boolean; requestId?: string } = {}): Promise<ReceiptClaimWorkflowSnapshot | null> {
  return mutate(context, expected, ({ operation }) => {
    if (operation.phase === 'complete' || (operation.dispatchLeaseUntilMs ?? 0) > nowMs) return null;
    if (!options.resetRetryWindow && (operation.phase !== 'pending' || operation.deadlineAtMs <= nowMs)) return null;
    if (options.resetRetryWindow && (!options.requestId || operation.requestIds.includes(options.requestId) || operation.error?.retryable !== true)) return null;
    if (options.resetRetryWindow && operation.requestIds.length >= 64) throw new StripeReceiptClaimError('resource-exhausted', 'Too many receipt claim attempts. Contact support.');
    return { ...operation, generation: operation.generation + 1, phase: 'pending', error: undefined,
      requestId: options.requestId ?? operation.requestId,
      requestIds: options.requestId && !operation.requestIds.includes(options.requestId) ? [...operation.requestIds, options.requestId] : operation.requestIds,
      deadlineAtMs: options.resetRetryWindow ? nowMs + RECEIPT_CLAIM_WORKFLOW_WINDOW_MS : operation.deadlineAtMs,
      nextAttemptAtMs: nowMs, dispatchLeaseUntilMs: null };
  });
}

export async function joinReceiptClaimWorkflowGeneration(context: CommerceRepositoryContext, expected: ReceiptClaimWorkflowSnapshot, requestId: string): Promise<ReceiptClaimWorkflowSnapshot> {
  try {
    return await runCommerceTransaction(context, async (transaction) => {
      const key = commerceKeys.claimCode(expected.code);
      const document = await readCommerceRecord(context, key, transaction);
      const current = document ? snapshot(document) : null;
      if (!current || current.operation.operationId !== expected.operation.operationId || current.operation.generation < expected.operation.generation) {
        throw new StripeReceiptClaimError('aborted', 'Receipt claim Workflow execution changed.');
      }
      if (current.operation.generation === expected.operation.generation || current.operation.phase === 'complete' || current.operation.requestIds.includes(requestId)) return current;
      if (current.operation.requestIds.length >= 64) throw new StripeReceiptClaimError('resource-exhausted', 'Too many receipt claim attempts. Contact support.');
      const operation = { ...current.operation, requestIds: [...current.operation.requestIds, requestId] };
      parseReceiptClaimWorkflowState(operation);
      await transaction.update(key, { [RECEIPT_CLAIM_WORKFLOW_FIELD]: data(operation), updatedAt: commerceFieldValue.serverTimestamp() });
      return { ...current, operation };
    });
  } catch (error) {
    const acknowledged = await loadReceiptClaimWorkflow({ ...context, signal: AbortSignal.timeout(5_000), nowMs: Date.now() }, expected.operation.operationId).catch(() => null);
    if (acknowledged && acknowledged.operation.generation >= expected.operation.generation &&
      (acknowledged.operation.phase === 'complete' || acknowledged.operation.requestIds.includes(requestId))) return acknowledged;
    throw error;
  }
}

export async function deferReceiptClaimWorkflow(context: CommerceRepositoryContext, expected: ReceiptClaimWorkflowSnapshot, nextAttemptAtMs: number): Promise<void> {
  requireMutation(await mutate(context, expected, (current) => {
    requirePending(current);
    return { ...current.operation, nextAttemptAtMs };
  }));
}

export async function failReceiptClaimWorkflow(context: CommerceRepositoryContext, expected: ReceiptClaimWorkflowSnapshot, error: ReceiptClaimWorkflowError, manualReview: boolean): Promise<void> {
  requireMutation(await mutate(context, expected, (current) => {
    if (current.operation.phase !== 'pending') return current.operation;
    const uncertain = current.operation.submission?.status === 'prepared' || current.started.receiptTxs.length > 0;
    return { ...current.operation, phase: manualReview || uncertain ? 'manual_review' : 'failed', error,
      nextAttemptAtMs: null, dispatchLeaseUntilMs: null };
  }));
}

export async function persistReceiptClaimWorkflowSubmission(context: CommerceRepositoryContext, expected: ReceiptClaimWorkflowSnapshot, submission: ReceiptClaimWorkflowSubmission): Promise<void> {
  const candidate = parseReceiptClaimWorkflowSubmission(submission);
  if (candidate.status !== 'prepared') throw new StripeReceiptClaimError('invalid-argument', 'New receipt claim submission must be prepared.');
  requireMutation(await mutate(context, expected, (current) => {
    requirePending(current);
    const previous = current.operation.submission;
    if (previous?.signature === candidate.signature) {
      if (JSON.stringify(previous) !== JSON.stringify(candidate)) throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim submission identity changed.');
      return current.operation;
    }
    if (previous && previous.status !== 'not_landed') throw new StripeReceiptClaimError('aborted', 'A receipt claim submission is still resolving.');
    if (previous && JSON.stringify(previous.target) !== JSON.stringify(candidate.target)) throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim submission target changed.');
    if (candidate.target.dropId !== current.started.dropId) {
      throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim submission is outside its operation.');
    }
    if (candidate.preparedAtMs >= current.operation.deadlineAtMs || context.nowMs >= current.operation.deadlineAtMs) {
      throw new StripeReceiptClaimError('deadline-exceeded', 'Receipt claim confirmation needs another retry.');
    }
    return { ...current.operation, submission: candidate,
      submissionHistory: previous ? [...current.operation.submissionHistory, previous] : current.operation.submissionHistory };
  }));
}

export async function settleReceiptClaimWorkflowSubmission(context: CommerceRepositoryContext, expected: ReceiptClaimWorkflowSnapshot, status: 'not_landed' | 'confirmed'): Promise<void> {
  requireMutation(await mutate(context, expected, (current) => {
    requirePending(current);
    const submission = current.operation.submission;
    if (!submission || submission.signature !== expected.operation.submission?.signature) throw new StripeReceiptClaimError('aborted', 'Receipt claim submission changed.');
    if (submission.status !== 'prepared' && submission.status !== status) throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim submission was already settled.');
    return { ...current.operation, submission: { ...submission, status } };
  }));
}

export async function settleReceiptClaimWorkflowLegacySubmissions(
  context: CommerceRepositoryContext,
  expected: ReceiptClaimWorkflowSnapshot,
  terminalSubmissions: readonly DirectCardReceiptClaimSubmission[],
): Promise<ReceiptClaimWorkflowSnapshot> {
  if (terminalSubmissions.some((entry) => entry.status !== 'not_landed')) {
    throw new StripeReceiptClaimError('invalid-argument', 'Legacy receipt claim settlement must be terminal.');
  }
  const rejected = new Map(terminalSubmissions.map((entry) => [entry.signature, entry]));
  const matches = (entry: DirectCardReceiptClaimSubmission, terminal: DirectCardReceiptClaimSubmission) =>
    entry.signature === terminal.signature && entry.lastValidBlockHeight === terminal.lastValidBlockHeight && entry.submittedAtMs === terminal.submittedAtMs;
  try {
    return await runCommerceTransaction(context, async (transaction) => {
      const key = commerceKeys.claimCode(expected.code);
      const document = await readCommerceRecord(context, key, transaction);
      const current = document ? snapshot(document) : null;
      if (!current || current.operation.operationId !== expected.operation.operationId || current.operation.generation !== expected.operation.generation) {
        throw new StripeReceiptClaimError('aborted', 'Receipt claim Workflow execution changed.');
      }
      requirePending(current);
      if (!current.started.directFigureReceipt || terminalSubmissions.some((terminal) =>
        !current.started.receiptTxSubmissions.some((entry) => matches(entry, terminal)))) {
        throw new StripeReceiptClaimError('aborted', 'Legacy receipt claim submission changed.');
      }
      const receiptTxSubmissions = current.started.receiptTxSubmissions.map((entry) => rejected.has(entry.signature)
        ? { ...entry, status: 'not_landed' as const } : entry);
      const receiptTxs = activeDirectCardReceiptClaimSignatures({ receiptTxs: current.started.receiptTxs, submissions: receiptTxSubmissions });
      if (JSON.stringify(receiptTxSubmissions) === JSON.stringify(current.started.receiptTxSubmissions) &&
        JSON.stringify(receiptTxs) === JSON.stringify(current.started.receiptTxs)) return current;
      await transaction.update(key, { receiptTxs, receiptTxSubmissions, updatedAt: commerceFieldValue.serverTimestamp() });
      return { ...current, started: { ...current.started, receiptTxs, receiptTxSubmissions } };
    });
  } catch (error) {
    const acknowledged = await loadReceiptClaimWorkflow({ ...context, signal: AbortSignal.timeout(5_000), nowMs: Date.now() }, expected.operation.operationId).catch(() => null);
    if (acknowledged?.operation.generation === expected.operation.generation &&
      (acknowledged.operation.phase === 'pending' || acknowledged.operation.phase === 'complete') &&
      terminalSubmissions.every((terminal) => !acknowledged.started.receiptTxs.includes(terminal.signature) &&
        acknowledged.started.receiptTxSubmissions.some((entry) => matches(entry, terminal) && entry.status === 'not_landed'))) return acknowledged;
    throw error;
  }
}

export async function completeReceiptClaimWorkflow(context: CommerceRepositoryContext, expected: ReceiptClaimWorkflowSnapshot, result: StripeReceiptClaimResult): Promise<void> {
  if (!result.processed || result.dropId !== expected.started.dropId || result.deliveryId !== expected.started.deliveryId ||
    !result.receiptKind || !result.receiptsTransferred) throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim result is invalid.');
  const current = await loadReceiptClaimWorkflow(context, expected.operation.operationId);
  if (!current || current.operation.generation !== expected.operation.generation) throw new StripeReceiptClaimError('aborted', 'Receipt claim Workflow execution changed.');
  if (current.operation.phase === 'complete') return;
  requirePending(current);
  const signature = result.receiptTxs?.at(-1) ?? null;
  try {
    await finalizeClaim(context, current.started, current.code, current.operation.recipient, signature,
      result.receiptKind, result.receiptsTransferred, result.figureIds,
      { operationId: current.operation.operationId, generation: current.operation.generation, result });
  } catch (error) {
    const acknowledged = await loadReceiptClaimWorkflow({ ...context, signal: AbortSignal.timeout(5_000), nowMs: Date.now() }, current.operation.operationId).catch(() => null);
    if (acknowledged?.operation.generation === current.operation.generation && acknowledged.operation.phase === 'complete') return;
    throw error;
  }
}
