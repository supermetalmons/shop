import {
  NOTIFICATION_MANUAL_REVIEW_EMAIL,
  createNotificationEmailJobV1,
  type NotificationEmailJobV1,
} from '../../../../shared/notificationEmailJob.js';
import {
  parseReceiptClaimFailureOutboxRow,
  parseReceiptClaimFailureSnapshot,
  type ReceiptClaimFailureOutboxRecord,
  type ReceiptClaimFailureSnapshot,
} from '../../../../shared/receiptClaimFailureOutbox.js';
import { getApiDrop } from './dropConfig.js';
import { buildReceiptClaimManualReviewEmailContent } from './notificationEmails.js';
import {
  NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS,
  planNotificationPublicationClaim,
  publishClaimedNotificationBatch,
} from './notificationOutboxPublication.js';
import {
  emptyReconciliationResult,
  recordReconciliationOutcome,
  reconciliationLogger,
  reportReconciliationResult,
  type ReconciliationOptions,
  type ReconciliationOutcome,
  type ReconciliationResult,
} from './reconciliationResult.js';
import { RECEIPT_CLAIM_WORKFLOW_WINDOW_MS } from './stripeReceiptClaimWorkflowState.js';

type AlertEnv = {
  COMMERCE_DB: D1Database;
  NOTIFICATION_EMAIL_QUEUE: Pick<Queue<NotificationEmailJobV1>, 'sendBatch'>;
};
type Options = ReconciliationOptions & {
  nowMs?: () => number;
  log?: (entry: Record<string, unknown>) => void;
};
type DiscoveryKind = 'legacy' | 'terminal' | 'overdue';
type Candidate = {
  claim_path: string;
  claim_version: number;
  snapshot_json: string;
};

const PAGE_SIZE = 8;
const PASS_BUDGET_MS = 20_000;
const AUTHORITY = "EXISTS (SELECT 1 FROM commerce_authority_control WHERE singleton = 1 AND authority_state = 'd1')";
const WORKFLOW = "json_extract(document.document_json, '$.receiptClaimWorkflowV1')";
const FLOW = (field: string) => `json_extract(document.document_json, '$.receiptClaimWorkflowV1.${field}')`;
const FIELD = (field: string) => `json_extract(document.document_json, '$.${field}')`;
const BASE = `document.document_kind = 'claim_code' AND ${FIELD('namespace')} = 'stripe_receipt_v1' AND document.status = 'processing'`;
const LEGACY = `${BASE} AND json_type(document.document_json, '$.receiptClaimWorkflowV1') IS NULL`;
const TERMINAL = `${BASE} AND ${FLOW('phase')} IN ('failed', 'manual_review')`;
const OVERDUE = `${BASE} AND ${FLOW('phase')} = 'pending'`;
const ERROR_CODES = ['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'aborted',
  'failed-precondition', 'resource-exhausted', 'deadline-exceeded', 'unavailable', 'internal'];

function timestampSql(path: string): string {
  const value = FIELD(path);
  return `CASE WHEN json_type(document.document_json, '$.${path}') = 'integer'
    AND ${value} BETWEEN 0 AND 9007199254740991 THEN ${value} ELSE NULL END`;
}

function snapshotSql(kind: DiscoveryKind): string {
  const legacy = kind === 'legacy';
  return `json_object('version', 1, 'dropId', ${FIELD('dropId')}, 'deliveryId', ${FIELD('deliveryId')},
    'boxId', ${FIELD('boxId')}, 'recipient', ${FIELD('recipient')},
    'operationId', ${legacy ? 'NULL' : FLOW('operationId')}, 'generation', ${legacy ? 'NULL' : FLOW('generation')},
    'phase', ${legacy ? "'legacy_processing'" : kind === 'overdue' ? "'overdue'" : FLOW('phase')},
    'errorCode', ${kind === 'terminal'
      ? `CASE WHEN ${FLOW('error.code')} IN (${ERROR_CODES.map((code) => `'${code}'`).join(',')}) THEN ${FLOW('error.code')} ELSE 'internal' END`
      : kind === 'legacy' ? "'legacy-processing'" : "'deadline-exceeded'"},
    'createdAtMs', ${legacy ? 'NULL' : timestampSql('receiptClaimWorkflowV1.createdAtMs')},
    'deadlineAtMs', ${legacy ? 'NULL' : timestampSql('receiptClaimWorkflowV1.deadlineAtMs')}, 'failedAtMs', ?1,
    'processingStartedAtMs', ${timestampSql('processingStartedAt')},
    'signature', ${legacy ? 'NULL' : `CASE WHEN json_type(document.document_json, '$.receiptClaimWorkflowV1.submission.signature') = 'text'
      AND length(${FLOW('submission.signature')}) BETWEEN 64 AND 128
      AND ${FLOW('submission.signature')} NOT GLOB '*[^1-9A-HJ-NP-Za-km-z]*'
      THEN ${FLOW('submission.signature')} ELSE NULL END`})`;
}

function validSourceIdentitySql(kind: DiscoveryKind): string {
  const positive = (field: string) => `json_type(document.document_json, '$.${field}') = 'integer'
    AND ${FIELD(field)} BETWEEN 1 AND 9007199254740991`;
  const operation = FLOW('operationId');
  return `json_type(document.document_json, '$.dropId') = 'text'
    AND length(${FIELD('dropId')}) BETWEEN 1 AND 64 AND ${FIELD('dropId')} GLOB '[a-z0-9]*'
    AND ${FIELD('dropId')} NOT GLOB '*[^a-z0-9_]*'
    AND ${positive('deliveryId')} AND ${positive('boxId')}
    AND json_type(document.document_json, '$.recipient') = 'text'
    AND length(${FIELD('recipient')}) BETWEEN 32 AND 64
    AND ${FIELD('recipient')} NOT GLOB '*[^1-9A-HJ-NP-Za-km-z]*'
    AND ${kind === 'legacy' ? `${FIELD('processingStartedAt')} >= 0` : `
      json_type(document.document_json, '$.receiptClaimWorkflowV1.operationId') = 'text'
      AND ${operation} GLOB 'src-v1-????????-????-4???-[89ab]???-????????????'
      AND substr(${operation}, 8) NOT GLOB '*[^0-9a-f-]*'
      AND length(replace(substr(${operation}, 8), '-', '')) = 32
      AND ${positive('receiptClaimWorkflowV1.generation')}`}`;
}

export function receiptClaimFailureDiscoveryQuery(kind: DiscoveryKind): string {
  const index = `commerce_receipt_claim_failure_${kind}_scan`;
  const predicate = kind === 'legacy' ? LEGACY : kind === 'terminal' ? TERMINAL : OVERDUE;
  const due = kind === 'legacy'
    ? `${FIELD('processingStartedAt')} <= ?2 AND json_type(document.document_json, '$.processingStartedAt') = 'integer'
      AND COALESCE(${FIELD('processingLeaseExpiresAt')}, 0) <= ?1`
    : kind === 'overdue' ? `${FLOW('deadlineAtMs')} <= ?1 AND ${FLOW('deadlineAtMs')} >= 0
      AND json_type(document.document_json, '$.receiptClaimWorkflowV1.deadlineAtMs') = 'integer'` : '1 = 1';
  const excluded = kind === 'legacy'
    ? `outbox.claim_path = document.document_path AND outbox.incident_kind = 'legacy'
        AND json_extract(outbox.snapshot_json, '$.processingStartedAtMs') IS ${FIELD('processingStartedAt')}`
    : `outbox.event_id = ${FLOW('operationId')} || ':g' || ${FLOW('generation')}`;
  const order = kind === 'legacy' ? FIELD('processingStartedAt')
    : kind === 'overdue' ? FLOW('deadlineAtMs') : `${FLOW('operationId')}, ${FLOW('generation')}`;
  return `SELECT document.document_path AS claim_path, document.version AS claim_version,
      ${snapshotSql(kind)} AS snapshot_json
    FROM commerce_documents AS document INDEXED BY ${index}
    WHERE ${predicate} AND ${due} AND ${validSourceIdentitySql(kind)} AND ${AUTHORITY}
      AND NOT EXISTS (SELECT 1 FROM commerce_receipt_claim_failure_outbox AS outbox WHERE ${excluded})
    ORDER BY ${order}, document.document_path LIMIT ?3`;
}

function currentSourceSql(): string {
  return `EXISTS (SELECT 1 FROM commerce_documents AS document WHERE document.document_path = outbox.claim_path
    AND ${BASE} AND ${FIELD('dropId')} = json_extract(outbox.snapshot_json, '$.dropId')
    AND ${FIELD('deliveryId')} = json_extract(outbox.snapshot_json, '$.deliveryId')
    AND ${FIELD('boxId')} = json_extract(outbox.snapshot_json, '$.boxId')
    AND ${FIELD('recipient')} = json_extract(outbox.snapshot_json, '$.recipient')
    AND ((outbox.incident_kind = 'legacy' AND ${WORKFLOW} IS NULL
      AND ${FIELD('processingStartedAt')} IS json_extract(outbox.snapshot_json, '$.processingStartedAtMs'))
      OR (outbox.incident_kind = 'workflow' AND ${FLOW('operationId')} = outbox.operation_id
        AND ${FLOW('generation')} = outbox.workflow_generation
        AND ${FLOW('phase')} IN ('pending', 'failed', 'manual_review'))))`;
}

async function rows<T>(db: D1Database, sql: string, values: unknown[] = []): Promise<T[]> {
  const result = await db.prepare(sql).bind(...values).all<T>();
  if (!result.success || !Array.isArray(result.results)) throw new Error('Receipt claim notification storage is unavailable.');
  return result.results;
}

async function eventId(candidate: Candidate, snapshot: ReceiptClaimFailureSnapshot): Promise<string> {
  if (snapshot.operationId !== null) return `${snapshot.operationId}:g${snapshot.generation}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    candidate.claim_path, snapshot.processingStartedAtMs,
  ])));
  return `legacy:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

async function discover(
  db: D1Database, kind: DiscoveryKind, nowMs: number, signal: AbortSignal,
  withinBudget: () => boolean, log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const candidates = await rows<Candidate>(db, receiptClaimFailureDiscoveryQuery(kind), [
    nowMs, nowMs - RECEIPT_CLAIM_WORKFLOW_WINDOW_MS, PAGE_SIZE,
  ]);
  const failures: unknown[] = [];
  for (const candidate of candidates) {
    signal.throwIfAborted();
    if (!withinBudget()) break;
    try {
      const snapshot = parseReceiptClaimFailureSnapshot(JSON.parse(candidate.snapshot_json));
      const id = await eventId(candidate, snapshot);
      await rows(db, `INSERT INTO commerce_receipt_claim_failure_outbox (
      event_id, claim_path, incident_kind, operation_id, workflow_generation, snapshot_json,
      state, revision, attempt_count, next_attempt_at_ms, claim_id, claim_expires_at_ms,
      retry_until_ms, created_at_ms, updated_at_ms, job_json, queued_at_ms, last_error_code
    ) SELECT ?, document.document_path, ?, ?, ?, ?, 'pending', 1, 0, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL
      FROM commerce_documents AS document
      WHERE document.document_path = ? AND document.version = ? AND ${AUTHORITY}
      ON CONFLICT(event_id) DO NOTHING`, [
      id, kind === 'legacy' ? 'legacy' : 'workflow', snapshot.operationId, snapshot.generation,
      JSON.stringify(snapshot), nowMs, nowMs + NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS, nowMs, nowMs,
      candidate.claim_path, candidate.claim_version,
      ]);
    } catch (error) {
      signal.throwIfAborted();
      failures.push(error);
      log({ event: 'receipt_claim_failure_notification_candidate_failed', incidentKind: kind });
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Receipt claim notification candidates could not all be captured.');
}

function emailJob(record: ReceiptClaimFailureOutboxRecord): NotificationEmailJobV1 {
  if (record.job) return record.job;
  const snapshot = record.snapshot;
  const drop = getApiDrop(snapshot.dropId);
  const email = buildReceiptClaimManualReviewEmailContent({
    incidentId: record.eventId,
    incidentKind: record.incidentKind === 'legacy' ? 'legacy' : snapshot.phase === 'overdue' ? 'overdue' : 'terminal',
    dropId: snapshot.dropId,
    dropName: drop?.displayName || drop?.collectionName || snapshot.dropId,
    cluster: drop?.solanaCluster || 'unknown',
    deliveryId: snapshot.deliveryId,
    boxId: snapshot.boxId,
    recipient: snapshot.recipient,
    ...(snapshot.operationId ? { operationId: snapshot.operationId } : {}),
    ...(snapshot.generation ? { generation: snapshot.generation } : {}),
    ...(snapshot.processingStartedAtMs !== null || snapshot.createdAtMs !== null
      ? { startedAtMs: snapshot.processingStartedAtMs ?? snapshot.createdAtMs! } : {}),
    failedAtMs: snapshot.failedAtMs,
    errorCode: snapshot.errorCode || 'internal',
    ...(snapshot.signature ? { transactionSignature: snapshot.signature, transactionStatus: 'Verify confirmation before retrying.' } : {}),
  });
  return createNotificationEmailJobV1({
    kind: 'receipt_claim_manual_review',
    idempotencyKey: `receipt_claim_failure:${record.eventId}`,
    recipients: [NOTIFICATION_MANUAL_REVIEW_EMAIL],
    ...email,
    context: { dropId: snapshot.dropId, deliveryId: snapshot.deliveryId },
  });
}

async function cancelStale(db: D1Database, record: ReceiptClaimFailureOutboxRecord, nowMs: number): Promise<boolean> {
  const cancelled = await rows(db, `UPDATE commerce_receipt_claim_failure_outbox AS outbox
    SET state = 'cancelled', revision = revision + 1, next_attempt_at_ms = NULL, claim_id = NULL,
      claim_expires_at_ms = NULL, updated_at_ms = MAX(updated_at_ms, ?), last_error_code = 'source-superseded'
    WHERE event_id = ? AND revision = ? AND state = 'pending' AND NOT ${currentSourceSql()} AND ${AUTHORITY}
    RETURNING event_id`, [nowMs, record.eventId, record.revision]);
  return cancelled.length > 0;
}

async function quarantineInvalidOutbox(db: D1Database, row: Record<string, unknown>, nowMs: number): Promise<void> {
  if (typeof row.event_id !== 'string' || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) return;
  await rows(db, `UPDATE commerce_receipt_claim_failure_outbox
    SET state = 'failed', revision = revision + 1, next_attempt_at_ms = NULL, claim_id = NULL,
      claim_expires_at_ms = NULL, updated_at_ms = MAX(updated_at_ms, ?), last_error_code = 'invalid-notification-data'
    WHERE event_id = ? AND revision = ? AND state = 'pending' AND ${AUTHORITY}`,
  [nowMs, row.event_id, row.revision]);
}

async function publish(
  env: AlertEnv,
  record: ReceiptClaimFailureOutboxRecord,
  signal: AbortSignal,
  nowMs: () => number,
): Promise<ReconciliationOutcome> {
  const db = env.COMMERCE_DB;
  if (await cancelStale(db, record, nowMs())) return 'skipped';
  const now = nowMs();
  const plan = planNotificationPublicationClaim({
    nowMs: now, attemptCount: record.attemptCount, retryUntilMs: record.retryUntilMs,
    activeUntilMs: record.claimExpiresAtMs ?? record.nextAttemptAtMs,
  });
  if (plan.outcome === 'busy') return 'deferred';
  if (plan.outcome === 'exhausted') {
    const failed = await rows(db, `UPDATE commerce_receipt_claim_failure_outbox
      SET state = 'failed', revision = revision + 1, next_attempt_at_ms = NULL, claim_id = NULL,
        claim_expires_at_ms = NULL, updated_at_ms = MAX(updated_at_ms, ?), last_error_code = 'publication-exhausted'
      WHERE event_id = ? AND revision = ? AND state = 'pending' AND ${AUTHORITY} RETURNING event_id`,
    [now, record.eventId, record.revision]);
    return failed.length ? 'failed' : 'skipped';
  }
  signal.throwIfAborted();
  const leaseId = crypto.randomUUID();
  const claimedRows = await rows<Record<string, unknown>>(db, `UPDATE commerce_receipt_claim_failure_outbox AS outbox
    SET revision = revision + 1, attempt_count = ?, retry_until_ms = ?, claim_id = ?,
      claim_expires_at_ms = ?, next_attempt_at_ms = ?, updated_at_ms = MAX(updated_at_ms, ?)
    WHERE event_id = ? AND revision = ? AND state = 'pending' AND ${currentSourceSql()} AND ${AUTHORITY}
    RETURNING *`, [plan.attemptCount, plan.retryUntilMs, leaseId, plan.expiresAtMs, plan.expiresAtMs,
    now, record.eventId, record.revision]);
  if (!claimedRows.length) return 'skipped';
  let claimed = parseReceiptClaimFailureOutboxRow(claimedRows[0]);
  return publishClaimedNotificationBatch<ReconciliationOutcome>({
    signal, nowMs, expiresAtMs: plan.expiresAtMs, retryUntilMs: plan.retryUntilMs,
    queue: env.NOTIFICATION_EMAIL_QUEUE,
    prepareAndPersist: async () => {
      const job = emailJob(claimed);
      const persistedRows = await rows<Record<string, unknown>>(db, `UPDATE commerce_receipt_claim_failure_outbox AS outbox
        SET job_json = COALESCE(job_json, ?), revision = revision + 1, updated_at_ms = MAX(updated_at_ms, ?)
        WHERE event_id = ? AND revision = ? AND claim_id = ? AND state = 'pending'
          AND ${currentSourceSql()} AND ${AUTHORITY} RETURNING *`,
      [JSON.stringify(job), nowMs(), claimed.eventId, claimed.revision, leaseId]);
      if (!persistedRows.length) {
        await cancelStale(db, claimed, nowMs());
        return [];
      }
      claimed = parseReceiptClaimFailureOutboxRow(persistedRows[0]);
      if (!claimed.job) throw new Error('Receipt claim notification payload was not persisted.');
      return [claimed.job];
    },
    finalize: async (jobs) => {
      if (!jobs.length) return 'skipped';
      const queued = await rows(db, `UPDATE commerce_receipt_claim_failure_outbox
        SET state = 'queued', revision = revision + 1, next_attempt_at_ms = NULL, claim_id = NULL,
          claim_expires_at_ms = NULL, queued_at_ms = ?, updated_at_ms = MAX(updated_at_ms, ?)
        WHERE event_id = ? AND revision = ? AND claim_id = ? AND state = 'pending' AND ${AUTHORITY}
        RETURNING event_id`, [nowMs(), nowMs(), claimed.eventId, claimed.revision, leaseId]);
      if (!queued.length) throw new Error('Receipt claim notification acknowledgement was not persisted.');
      return 'completed';
    },
    releaseUnusedClaim: async () => {
      await rows(db, `UPDATE commerce_receipt_claim_failure_outbox
        SET revision = revision + 1, attempt_count = ?, next_attempt_at_ms = ?, claim_id = NULL,
          claim_expires_at_ms = NULL, updated_at_ms = MAX(updated_at_ms, ?)
        WHERE event_id = ? AND revision = ? AND claim_id = ? AND state = 'pending' AND ${AUTHORITY}`,
      [record.attemptCount, nowMs(), nowMs(), claimed.eventId, claimed.revision, leaseId]);
    },
    createExpiredClaimError: () => new Error('Receipt claim notification publication lease expired.'),
  });
}

export async function reconcileReceiptClaimFailureNotifications(
  env: AlertEnv,
  signal: AbortSignal,
  options: Options = {},
): Promise<ReconciliationResult> {
  const nowMs = options.nowMs || Date.now;
  const startedAt = performance.now();
  const result = emptyReconciliationResult();
  const failures: unknown[] = [];
  const log = reconciliationLogger(options.log || ((entry: Record<string, unknown>) => console.error(entry)));
  const withinBudget = () => performance.now() - startedAt < PASS_BUDGET_MS;
  try {
    signal.throwIfAborted();
    for (const kind of ['terminal', 'overdue', 'legacy'] as const) {
      if (!withinBudget()) break;
      try { await discover(env.COMMERCE_DB, kind, nowMs(), signal, withinBudget, log); }
      catch (error) {
        signal.throwIfAborted();
        failures.push(error);
        log({ event: 'receipt_claim_failure_notification_discovery_failed', incidentKind: kind });
      }
    }
    signal.throwIfAborted();
    const due = await rows<Record<string, unknown>>(env.COMMERCE_DB, `SELECT *
      FROM commerce_receipt_claim_failure_outbox INDEXED BY commerce_receipt_claim_failure_outbox_due
      WHERE state = 'pending' AND next_attempt_at_ms <= ? AND ${AUTHORITY}
      ORDER BY next_attempt_at_ms, event_id LIMIT ?`, [nowMs(), PAGE_SIZE]);
    for (const row of due) {
      signal.throwIfAborted();
      if (!withinBudget()) break;
      let record: ReceiptClaimFailureOutboxRecord;
      try { record = parseReceiptClaimFailureOutboxRow(row); }
      catch (error) {
        signal.throwIfAborted();
        recordReconciliationOutcome(result, 'failed');
        failures.push(error);
        await quarantineInvalidOutbox(env.COMMERCE_DB, row, nowMs()).catch((failure: unknown) => { failures.push(failure); });
        log({ event: 'receipt_claim_failure_notification_invalid_outbox' });
        continue;
      }
      try {
        const outcome = await publish(env, record, signal, nowMs);
        recordReconciliationOutcome(result, outcome);
        if (outcome === 'failed') log({ event: 'receipt_claim_failure_notification_exhausted', incidentId: record.eventId });
      }
      catch (error) {
        signal.throwIfAborted();
        recordReconciliationOutcome(result, 'failed');
        failures.push(error);
        log({ event: 'receipt_claim_failure_notification_publish_failed', incidentId: record.eventId });
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Receipt claim failure notification reconciliation failed.');
    return result;
  } finally {
    reportReconciliationResult(result, options.onResult);
  }
}
