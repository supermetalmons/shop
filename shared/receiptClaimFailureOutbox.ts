import { isNotificationEmailJobId, isNotificationEmailJobV1, type NotificationEmailJobV1 } from './notificationEmailJob.ts';
import { isStripeReceiptClaimOperationId } from './stripeReceiptClaimWorkflow.ts';

export type ReceiptClaimFailureSnapshot = {
  version: 1;
  dropId: string;
  deliveryId: number;
  boxId: number;
  recipient: string;
  operationId: string | null;
  generation: number | null;
  phase: 'failed' | 'manual_review' | 'overdue' | 'legacy_processing';
  errorCode: string | null;
  createdAtMs: number | null;
  deadlineAtMs: number | null;
  failedAtMs: number;
  processingStartedAtMs: number | null;
  signature: string | null;
};

export type ReceiptClaimFailureOutboxRecord = {
  eventId: string;
  claimPath: string;
  incidentKind: 'workflow' | 'legacy';
  operationId: string | null;
  workflowGeneration: number | null;
  snapshot: ReceiptClaimFailureSnapshot;
  state: 'pending' | 'queued' | 'failed' | 'cancelled';
  revision: number;
  attemptCount: number;
  nextAttemptAtMs: number | null;
  claimId: string | null;
  claimExpiresAtMs: number | null;
  retryUntilMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  job: NotificationEmailJobV1 | null;
  queuedAtMs: number | null;
  lastErrorCode: string | null;
};

const SNAPSHOT_KEYS = ['version', 'dropId', 'deliveryId', 'boxId', 'recipient', 'operationId', 'generation', 'phase',
  'errorCode', 'createdAtMs', 'deadlineAtMs', 'failedAtMs', 'processingStartedAtMs', 'signature'];
const ERROR_CODES = new Set(['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'aborted',
  'failed-precondition', 'resource-exhausted', 'deadline-exceeded', 'unavailable', 'internal', 'legacy-processing']);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const positive = (value: unknown): value is number => time(value) && value > 0;
const nullableTime = (value: unknown): value is number | null => value === null || time(value);
const base58 = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);

export function parseReceiptClaimFailureSnapshot(value: unknown): ReceiptClaimFailureSnapshot {
  if (!record(value) || Object.keys(value).length !== SNAPSHOT_KEYS.length ||
    !Object.keys(value).every((key) => SNAPSHOT_KEYS.includes(key)) || value.version !== 1 ||
    typeof value.dropId !== 'string' || !/^[a-z0-9][a-z0-9_]{0,63}$/.test(value.dropId) ||
    !positive(value.deliveryId) || !positive(value.boxId) || !base58(value.recipient, 32, 64) ||
    !(value.operationId === null || isStripeReceiptClaimOperationId(value.operationId)) ||
    !(value.generation === null || positive(value.generation)) ||
    !['failed', 'manual_review', 'overdue', 'legacy_processing'].includes(String(value.phase)) ||
    !(value.errorCode === null || typeof value.errorCode === 'string' && ERROR_CODES.has(value.errorCode)) ||
    !nullableTime(value.createdAtMs) || !nullableTime(value.deadlineAtMs) || !time(value.failedAtMs) ||
    !nullableTime(value.processingStartedAtMs) || !(value.signature === null || base58(value.signature, 64, 128)) ||
    (value.phase === 'legacy_processing'
      ? value.operationId !== null || value.generation !== null
      : value.operationId === null || value.generation === null)) {
    throw new Error('Invalid receipt claim failure snapshot.');
  }
  return structuredClone(value) as ReceiptClaimFailureSnapshot;
}

export function parseReceiptClaimFailureOutboxRecord(value: unknown): ReceiptClaimFailureOutboxRecord {
  if (!record(value)) throw new Error('Invalid receipt claim failure outbox.');
  const snapshot = parseReceiptClaimFailureSnapshot(value.snapshot);
  if (typeof value.claimPath !== 'string' || !/^claimCodes\/[^/]{1,255}$/.test(value.claimPath) ||
    !['workflow', 'legacy'].includes(String(value.incidentKind)) ||
    value.operationId !== snapshot.operationId || value.workflowGeneration !== snapshot.generation ||
    (value.incidentKind === 'workflow'
      ? snapshot.phase === 'legacy_processing' || value.eventId !== `${snapshot.operationId}:g${snapshot.generation}`
      : snapshot.phase !== 'legacy_processing' || typeof value.eventId !== 'string' || !/^legacy:[0-9a-f]{64}$/.test(value.eventId)) ||
    !['pending', 'queued', 'failed', 'cancelled'].includes(String(value.state)) ||
    !positive(value.revision) || !time(value.attemptCount) || !nullableTime(value.nextAttemptAtMs) ||
    !(value.claimId === null || isNotificationEmailJobId(value.claimId)) || !nullableTime(value.claimExpiresAtMs) ||
    !time(value.retryUntilMs) || !time(value.createdAtMs) || !time(value.updatedAtMs) || value.updatedAtMs < value.createdAtMs ||
    !nullableTime(value.queuedAtMs) || !(value.lastErrorCode === null || typeof value.lastErrorCode === 'string' &&
      /^[a-z][a-z0-9_-]{0,127}$/.test(value.lastErrorCode)) ||
    (value.state === 'pending') !== (value.nextAttemptAtMs !== null) ||
    (value.claimId === null) !== (value.claimExpiresAtMs === null) ||
    value.state !== 'pending' && value.claimId !== null ||
    value.state === 'pending' && value.claimExpiresAtMs !== null && value.nextAttemptAtMs !== value.claimExpiresAtMs ||
    (value.state === 'queued') !== (value.queuedAtMs !== null) ||
    value.state === 'queued' && value.job === null ||
    !(value.job === null || isNotificationEmailJobV1(value.job) && value.job.kind === 'receipt_claim_manual_review' &&
      value.job.context.dropId === snapshot.dropId && value.job.context.deliveryId === snapshot.deliveryId &&
      value.job.idempotencyKey === `receipt_claim_failure:${value.eventId}`)) {
    throw new Error('Invalid receipt claim failure outbox.');
  }
  return structuredClone({ ...value, snapshot }) as ReceiptClaimFailureOutboxRecord;
}

export function parseReceiptClaimFailureOutboxRow(row: Record<string, unknown>): ReceiptClaimFailureOutboxRecord {
  return parseReceiptClaimFailureOutboxRecord({
    eventId: row.event_id, claimPath: row.claim_path, incidentKind: row.incident_kind,
    operationId: row.operation_id, workflowGeneration: row.workflow_generation, snapshot: JSON.parse(String(row.snapshot_json)),
    state: row.state, revision: row.revision, attemptCount: row.attempt_count, nextAttemptAtMs: row.next_attempt_at_ms,
    claimId: row.claim_id, claimExpiresAtMs: row.claim_expires_at_ms, retryUntilMs: row.retry_until_ms,
    createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms,
    job: row.job_json === null ? null : JSON.parse(String(row.job_json)), queuedAtMs: row.queued_at_ms, lastErrorCode: row.last_error_code,
  });
}
