import type { StripeReceiptClaimResult } from '../../../../shared/contracts.js';
import type { ApiErrorCode } from './dataAccess.js';
import type { StartedClaim } from './stripeReceiptClaimStore.js';
import { StripeReceiptClaimError } from './stripeReceiptClaimErrors.js';

export const RECEIPT_CLAIM_WORKFLOW_FIELD = 'receiptClaimWorkflowV1';
export const RECEIPT_CLAIM_WORKFLOW_WINDOW_MS = 15 * 60_000;
export const RECEIPT_CLAIM_WORKFLOW_DISPATCH_LEASE_MS = 30_000;

export type ReceiptClaimWorkflowError = { code: ApiErrorCode; message: string; retryable: boolean };
export type ReceiptClaimWorkflowSubmission = {
  signature: string;
  signedTransactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  preparedAtMs: number;
  target: {
    flow: 'direct_figure' | 'openable_pack' | 'legacy_pack';
    receiptAssetId: string;
    figureIds: number[];
    dropId: string;
    network: 'mainnet-beta' | 'devnet';
    programId: string;
    collectionMint: string;
    receiptsMerkleTree: string;
    adminWallet: string;
  };
  status: 'prepared' | 'confirmed' | 'not_landed';
};

export type ReceiptClaimWorkflowState = {
  version: 1;
  operationId: string;
  requestId: string;
  requestIds: string[];
  generation: number;
  recipient: string;
  phase: 'pending' | 'complete' | 'failed' | 'manual_review';
  createdAtMs: number;
  deadlineAtMs: number;
  nextAttemptAtMs: number | null;
  dispatchLeaseUntilMs: number | null;
  claim: StartedClaim;
  submission?: ReceiptClaimWorkflowSubmission;
  submissionHistory: ReceiptClaimWorkflowSubmission[];
  result?: StripeReceiptClaimResult;
  error?: ReceiptClaimWorkflowError;
};

export type ReceiptClaimWorkflowSnapshot = { code: string; started: StartedClaim; operation: ReceiptClaimWorkflowState };
export type ReceiptClaimWorkflowPayload = { version: 1; operationId: string; generation: number };

export function isReceiptClaimWorkflowOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^src-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function receiptClaimWorkflowInstanceId(operation: Pick<ReceiptClaimWorkflowState, 'operationId' | 'generation'>): string {
  return `${operation.operationId}-g${operation.generation}`;
}

export function receiptClaimWorkflowAttemptId(operation: Pick<ReceiptClaimWorkflowState, 'operationId' | 'generation'>): string {
  return receiptClaimWorkflowInstanceId(operation);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function positiveIntegers(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => time(item) && item > 0);
}

function validClaim(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.status !== 'started' || typeof value.dropId !== 'string' || !value.dropId ||
    !time(value.deliveryId) || !value.deliveryId || !time(value.boxId) || !value.boxId ||
    typeof value.orderPath !== 'string' || !value.orderPath || typeof value.attemptId !== 'string' || !value.attemptId ||
    !Array.isArray(value.orderIrlClaims) || !strings(value.receiptTxs) || !Array.isArray(value.receiptTxSubmissions) ||
    ['resumingPreviousProcessingClaim', 'hasPreviousClaimFailure', 'updatePluralOrderClaim', 'updateSingularOrderClaim']
      .some((key) => typeof value[key] !== 'boolean')) return false;
  if (value.directFigureReceipt !== undefined && (!record(value.directFigureReceipt) ||
    typeof value.directFigureReceipt.receiptAssetId !== 'string' || !value.directFigureReceipt.receiptAssetId ||
    !time(value.directFigureReceipt.figureId) || !value.directFigureReceipt.figureId)) return false;
  return value.receiptTxSubmissions.every((item) => record(item) && typeof item.signature === 'string' && Boolean(item.signature) &&
    time(item.lastValidBlockHeight) && item.lastValidBlockHeight > 0 && time(item.submittedAtMs) &&
    (item.status === 'submitted' || item.status === 'not_landed'));
}

function validError(value: unknown): boolean {
  return record(value) && typeof value.message === 'string' && value.message.length > 0 && value.message.length <= 2048 &&
    typeof value.retryable === 'boolean' && ['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found',
      'aborted', 'failed-precondition', 'resource-exhausted', 'deadline-exceeded', 'unavailable', 'internal'].includes(String(value.code));
}

function validResult(value: unknown): boolean {
  return record(value) && value.processed === true && typeof value.dropId === 'string' && Boolean(value.dropId) &&
    time(value.deliveryId) && value.deliveryId > 0 && time(value.receiptsTransferred) && value.receiptsTransferred > 0 &&
    (value.receiptKind === 'box' || value.receiptKind === 'figure') &&
    (value.receiptTxs === undefined || strings(value.receiptTxs)) &&
    (value.figureIds === undefined || positiveIntegers(value.figureIds)) &&
    (value.receiptAssetIds === undefined || strings(value.receiptAssetIds));
}

export function parseReceiptClaimWorkflowSubmission(value: unknown): ReceiptClaimWorkflowSubmission {
  if (!record(value) || typeof value.signature !== 'string' || !value.signature ||
    typeof value.signedTransactionBase64 !== 'string' || !value.signedTransactionBase64 || value.signedTransactionBase64.length > 4096 ||
    typeof value.blockhash !== 'string' || !value.blockhash || !time(value.lastValidBlockHeight) || !value.lastValidBlockHeight ||
    !time(value.preparedAtMs) || !['prepared', 'confirmed', 'not_landed'].includes(String(value.status)) ||
    !record(value.target) || !['direct_figure', 'openable_pack', 'legacy_pack'].includes(String(value.target.flow)) ||
    !['mainnet-beta', 'devnet'].includes(String(value.target.network)) ||
    ['receiptAssetId', 'dropId', 'programId', 'collectionMint', 'receiptsMerkleTree', 'adminWallet'].some((key) => !record(value.target) || typeof value.target[key] !== 'string' || !value.target[key]) ||
    !positiveIntegers(value.target.figureIds)) {
    throw new StripeReceiptClaimError('failed-precondition', 'Stored receipt claim submission is invalid.');
  }
  return structuredClone(value) as ReceiptClaimWorkflowSubmission;
}

export function parseReceiptClaimWorkflowState(value: unknown): ReceiptClaimWorkflowState | null {
  if (value === undefined) return null;
  if (!record(value) || value.version !== 1 || !isReceiptClaimWorkflowOperationId(value.operationId) ||
    typeof value.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.requestId) ||
    !strings(value.requestIds) || value.requestIds.length > 64 || !value.requestIds.includes(value.requestId) ||
    new Set(value.requestIds).size !== value.requestIds.length || value.requestIds.some((id) => !/^[0-9a-f-]{36}$/.test(id)) ||
    !time(value.generation) || value.generation < 1 || typeof value.recipient !== 'string' || !value.recipient ||
    !['pending', 'complete', 'failed', 'manual_review'].includes(String(value.phase)) ||
    !time(value.createdAtMs) || !time(value.deadlineAtMs) || value.deadlineAtMs < value.createdAtMs ||
    (value.nextAttemptAtMs !== null && !time(value.nextAttemptAtMs)) ||
    (value.dispatchLeaseUntilMs !== null && !time(value.dispatchLeaseUntilMs)) ||
    !validClaim(value.claim) || !Array.isArray(value.submissionHistory) ||
    (value.error !== undefined && !validError(value.error)) ||
    (value.phase === 'complete' && !validResult(value.result)) ||
    ((value.phase === 'failed' || value.phase === 'manual_review') && !validError(value.error))) {
    throw new StripeReceiptClaimError('failed-precondition', 'Stored receipt claim Workflow is invalid.');
  }
  const result = structuredClone(value) as ReceiptClaimWorkflowState;
  result.submissionHistory = value.submissionHistory.map(parseReceiptClaimWorkflowSubmission);
  if (value.submission !== undefined) result.submission = parseReceiptClaimWorkflowSubmission(value.submission);
  return result;
}
