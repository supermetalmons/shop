import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.js';
import {
  parseReceiptClaimFailureOutboxRow,
  type ReceiptClaimFailureOutboxRecord,
  type ReceiptClaimFailureSnapshot,
} from '../../../../shared/receiptClaimFailureOutbox.js';
import { NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS } from './notificationOutboxPublication.js';
import { RECEIPT_CLAIM_WORKFLOW_WINDOW_MS } from './stripeReceiptClaimWorkflowState.js';

export type ReceiptClaimFailureDiscoveryKind = 'legacy' | 'terminal' | 'overdue';
type DiscoveryCandidate = {
  claim_path: string;
  claim_version: number;
  snapshot_json: string;
};

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

function snapshotSql(kind: ReceiptClaimFailureDiscoveryKind): string {
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

function validSourceIdentitySql(kind: ReceiptClaimFailureDiscoveryKind): string {
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

export function receiptClaimFailureDiscoveryQuery(kind: ReceiptClaimFailureDiscoveryKind): string {
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

async function eventId(candidate: DiscoveryCandidate, snapshot: ReceiptClaimFailureSnapshot): Promise<string> {
  if (snapshot.operationId !== null) return `${snapshot.operationId}:g${snapshot.generation}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    candidate.claim_path, snapshot.processingStartedAtMs,
  ])));
  return `legacy:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export type ReceiptClaimFailureOutboxCandidate = {
  eventId: string;
  nextAttemptAtMs: number;
  row: Record<string, unknown>;
};

export class ReceiptClaimFailureOutboxStore {
  constructor(private readonly db: D1Database) {}

  loadDiscovery(kind: ReceiptClaimFailureDiscoveryKind, nowMs: number, limit: number): Promise<DiscoveryCandidate[]> {
    return rows<DiscoveryCandidate>(this.db, receiptClaimFailureDiscoveryQuery(kind), [
      nowMs, nowMs - RECEIPT_CLAIM_WORKFLOW_WINDOW_MS, limit,
    ]);
  }

  async capture(candidate: DiscoveryCandidate, snapshot: ReceiptClaimFailureSnapshot, nowMs: number): Promise<void> {
    const id = await eventId(candidate, snapshot);
    await rows(this.db, `INSERT INTO commerce_receipt_claim_failure_outbox (
      event_id, claim_path, incident_kind, operation_id, workflow_generation, snapshot_json,
      state, revision, attempt_count, next_attempt_at_ms, claim_id, claim_expires_at_ms,
      retry_until_ms, created_at_ms, updated_at_ms, job_json, queued_at_ms, last_error_code
    ) SELECT ?, document.document_path, ?, ?, ?, ?, 'pending', 1, 0, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL
      FROM commerce_documents AS document
      WHERE document.document_path = ? AND document.version = ? AND ${AUTHORITY}
      ON CONFLICT(event_id) DO NOTHING`, [
      id, snapshot.phase === 'legacy_processing' ? 'legacy' : 'workflow', snapshot.operationId, snapshot.generation,
      JSON.stringify(snapshot), nowMs, nowMs + NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS, nowMs, nowMs,
      candidate.claim_path, candidate.claim_version,
    ]);
  }

  async queryDue(args: {
    dueAtMs: number;
    limit: number;
    startAfter?: Pick<ReceiptClaimFailureOutboxCandidate, 'eventId' | 'nextAttemptAtMs'>;
  }): Promise<ReceiptClaimFailureOutboxCandidate[]> {
    const found = await rows<Record<string, unknown>>(this.db, `SELECT *
      FROM commerce_receipt_claim_failure_outbox INDEXED BY commerce_receipt_claim_failure_outbox_due
      WHERE state = 'pending' AND next_attempt_at_ms <= ? AND ${AUTHORITY}
        ${args.startAfter ? 'AND (next_attempt_at_ms, event_id) > (?, ?)' : ''}
      ORDER BY next_attempt_at_ms, event_id LIMIT ?`, [args.dueAtMs,
      ...(args.startAfter ? [args.startAfter.nextAttemptAtMs, args.startAfter.eventId] : []), args.limit]);
    return found.map((row) => {
      if (typeof row.event_id !== 'string' || typeof row.next_attempt_at_ms !== 'number' ||
        !Number.isSafeInteger(row.next_attempt_at_ms) || row.next_attempt_at_ms < 0) {
        throw new Error('Receipt claim notification cursor is invalid.');
      }
      return { eventId: row.event_id, nextAttemptAtMs: row.next_attempt_at_ms, row };
    });
  }

  async cancelStale(record: ReceiptClaimFailureOutboxRecord, nowMs: number): Promise<boolean> {
    const cancelled = await rows(this.db, `UPDATE commerce_receipt_claim_failure_outbox AS outbox
      SET state = 'cancelled', revision = revision + 1, next_attempt_at_ms = NULL, claim_id = NULL,
        claim_expires_at_ms = NULL, updated_at_ms = MAX(updated_at_ms, ?), last_error_code = 'source-superseded'
      WHERE event_id = ? AND revision = ? AND state = 'pending' AND NOT ${currentSourceSql()} AND ${AUTHORITY}
      RETURNING event_id`, [nowMs, record.eventId, record.revision]);
    return cancelled.length > 0;
  }

  async quarantine(row: Record<string, unknown>, nowMs: number): Promise<void> {
    if (typeof row.event_id !== 'string' || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) return;
    await rows(this.db, `UPDATE commerce_receipt_claim_failure_outbox
      SET state = 'failed', revision = revision + 1, next_attempt_at_ms = NULL, claim_id = NULL,
        claim_expires_at_ms = NULL, updated_at_ms = MAX(updated_at_ms, ?), last_error_code = 'invalid-notification-data'
      WHERE event_id = ? AND revision = ? AND state = 'pending' AND ${AUTHORITY}`,
    [nowMs, row.event_id, row.revision]);
  }

  async failExhausted(record: ReceiptClaimFailureOutboxRecord, nowMs: number): Promise<boolean> {
    const failed = await rows(this.db, `UPDATE commerce_receipt_claim_failure_outbox
      SET state = 'failed', revision = revision + 1, next_attempt_at_ms = NULL, claim_id = NULL,
        claim_expires_at_ms = NULL, updated_at_ms = MAX(updated_at_ms, ?), last_error_code = 'publication-exhausted'
      WHERE event_id = ? AND revision = ? AND state = 'pending' AND ${AUTHORITY} RETURNING event_id`,
    [nowMs, record.eventId, record.revision]);
    return failed.length > 0;
  }

  async claim(record: ReceiptClaimFailureOutboxRecord, plan: {
    attemptCount: number; retryUntilMs: number; expiresAtMs: number;
  }, leaseId: string, nowMs: number): Promise<ReceiptClaimFailureOutboxRecord | null> {
    const claimed = await rows<Record<string, unknown>>(this.db, `UPDATE commerce_receipt_claim_failure_outbox AS outbox
      SET revision = revision + 1, attempt_count = ?, retry_until_ms = ?, claim_id = ?,
        claim_expires_at_ms = ?, next_attempt_at_ms = ?, updated_at_ms = MAX(updated_at_ms, ?)
      WHERE event_id = ? AND revision = ? AND state = 'pending' AND ${currentSourceSql()} AND ${AUTHORITY}
      RETURNING *`, [plan.attemptCount, plan.retryUntilMs, leaseId, plan.expiresAtMs, plan.expiresAtMs,
      nowMs, record.eventId, record.revision]);
    return claimed.length ? parseReceiptClaimFailureOutboxRow(claimed[0]) : null;
  }

  async persistJob(record: ReceiptClaimFailureOutboxRecord, job: NotificationEmailJobV1,
    leaseId: string, nowMs: number): Promise<ReceiptClaimFailureOutboxRecord | null> {
    const persisted = await rows<Record<string, unknown>>(this.db, `UPDATE commerce_receipt_claim_failure_outbox AS outbox
      SET job_json = COALESCE(job_json, ?), revision = revision + 1, updated_at_ms = MAX(updated_at_ms, ?)
      WHERE event_id = ? AND revision = ? AND claim_id = ? AND state = 'pending'
        AND ${currentSourceSql()} AND ${AUTHORITY} RETURNING *`,
    [JSON.stringify(job), nowMs, record.eventId, record.revision, leaseId]);
    return persisted.length ? parseReceiptClaimFailureOutboxRow(persisted[0]) : null;
  }

  async markQueued(record: ReceiptClaimFailureOutboxRecord, leaseId: string, nowMs: number): Promise<boolean> {
    const queued = await rows(this.db, `UPDATE commerce_receipt_claim_failure_outbox
      SET state = 'queued', revision = revision + 1, next_attempt_at_ms = NULL, claim_id = NULL,
        claim_expires_at_ms = NULL, queued_at_ms = ?, updated_at_ms = MAX(updated_at_ms, ?)
      WHERE event_id = ? AND revision = ? AND claim_id = ? AND state = 'pending' AND ${AUTHORITY}
      RETURNING event_id`, [nowMs, nowMs, record.eventId, record.revision, leaseId]);
    return queued.length > 0;
  }

  async releaseClaim(record: ReceiptClaimFailureOutboxRecord, leaseId: string,
    previousAttemptCount: number, nowMs: number): Promise<void> {
    await rows(this.db, `UPDATE commerce_receipt_claim_failure_outbox
      SET revision = revision + 1, attempt_count = ?, next_attempt_at_ms = ?, claim_id = NULL,
        claim_expires_at_ms = NULL, updated_at_ms = MAX(updated_at_ms, ?)
      WHERE event_id = ? AND revision = ? AND claim_id = ? AND state = 'pending' AND ${AUTHORITY}`,
    [previousAttemptCount, nowMs, nowMs, record.eventId, record.revision, leaseId]);
  }
}
