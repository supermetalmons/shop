import {
  NOTIFICATION_MANUAL_REVIEW_EMAIL,
  createNotificationEmailJobV1,
  type NotificationEmailJobV1,
} from '../../../../shared/notificationEmailJob.js';
import {
  parseReceiptClaimFailureOutboxRow,
  parseReceiptClaimFailureSnapshot,
  type ReceiptClaimFailureOutboxRecord,
} from '../../../../shared/receiptClaimFailureOutbox.js';
import { getApiDrop } from './dropConfig.js';
import { buildReceiptClaimManualReviewEmailContent } from './notificationEmails.js';
import {
  planNotificationPublicationClaim,
  publishClaimedNotificationBatch,
} from './notificationOutboxPublication.js';
import {
  emptyReconciliationResult,
  reconciliationLogger,
  reportReconciliationResult,
  type ReconciliationOptions,
  type ReconciliationOutcome,
  type ReconciliationResult,
} from './reconciliationResult.js';
import { drainReconciliationCandidates } from './reconciliationPass.js';
import {
  ReceiptClaimFailureOutboxStore,
  type ReceiptClaimFailureDiscoveryKind,
  type ReceiptClaimFailureOutboxCandidate,
} from './receiptClaimFailureOutboxStore.js';

type AlertEnv = {
  COMMERCE_DB: D1Database;
  NOTIFICATION_EMAIL_QUEUE: Pick<Queue<NotificationEmailJobV1>, 'sendBatch'>;
};
type Options = ReconciliationOptions & {
  nowMs?: () => number;
  monotonicNowMs?: () => number;
  log?: (entry: Record<string, unknown>) => void;
};
const DISCOVERY_PAGE_SIZE = 8;
const PASS_BUDGET_MS = 20_000;
const FAILURE_MESSAGE = 'Receipt claim failure notification reconciliation failed.';

async function discover(
  store: ReceiptClaimFailureOutboxStore, kind: ReceiptClaimFailureDiscoveryKind, nowMs: number, signal: AbortSignal,
  withinBudget: () => boolean, log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const candidates = await store.loadDiscovery(kind, nowMs, DISCOVERY_PAGE_SIZE);
  const failures: unknown[] = [];
  for (const candidate of candidates) {
    signal.throwIfAborted();
    if (!withinBudget()) break;
    try {
      const snapshot = parseReceiptClaimFailureSnapshot(JSON.parse(candidate.snapshot_json));
      await store.capture(candidate, snapshot, nowMs);
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

async function publish(
  store: ReceiptClaimFailureOutboxStore,
  queue: AlertEnv['NOTIFICATION_EMAIL_QUEUE'],
  record: ReceiptClaimFailureOutboxRecord,
  signal: AbortSignal,
  nowMs: () => number,
): Promise<ReconciliationOutcome> {
  if (await store.cancelStale(record, nowMs())) return 'skipped';
  const now = nowMs();
  const plan = planNotificationPublicationClaim({
    nowMs: now, attemptCount: record.attemptCount, retryUntilMs: record.retryUntilMs,
    activeUntilMs: record.claimExpiresAtMs ?? record.nextAttemptAtMs,
  });
  if (plan.outcome === 'busy') return 'deferred';
  if (plan.outcome === 'exhausted') return await store.failExhausted(record, now) ? 'failed' : 'skipped';
  signal.throwIfAborted();
  const leaseId = crypto.randomUUID();
  const claim = await store.claim(record, plan, leaseId, now);
  if (!claim) return 'skipped';
  let claimed = claim;
  return publishClaimedNotificationBatch<ReconciliationOutcome>({
    signal, nowMs, expiresAtMs: plan.expiresAtMs, retryUntilMs: plan.retryUntilMs,
    queue,
    prepareAndPersist: async () => {
      const persisted = await store.persistJob(claimed, emailJob(claimed), leaseId, nowMs());
      if (!persisted) {
        await store.cancelStale(claimed, nowMs());
        return [];
      }
      claimed = persisted;
      if (!claimed.job) throw new Error('Receipt claim notification payload was not persisted.');
      return [claimed.job];
    },
    finalize: async (jobs) => {
      if (!jobs.length) return 'skipped';
      if (!await store.markQueued(claimed, leaseId, nowMs())) {
        throw new Error('Receipt claim notification acknowledgement was not persisted.');
      }
      return 'completed';
    },
    releaseUnusedClaim: () => store.releaseClaim(claimed, leaseId, record.attemptCount, nowMs()),
    createExpiredClaimError: () => new Error('Receipt claim notification publication lease expired.'),
  });
}

export async function reconcileReceiptClaimFailureNotifications(
  env: AlertEnv,
  signal: AbortSignal,
  options: Options = {},
): Promise<ReconciliationResult> {
  const nowMs = options.nowMs || Date.now;
  const monotonicNowMs = options.monotonicNowMs || (() => performance.now());
  const startedAt = monotonicNowMs();
  const store = new ReceiptClaimFailureOutboxStore(env.COMMERCE_DB);
  let result: ReconciliationResult = emptyReconciliationResult();
  const failures: unknown[] = [];
  const log = reconciliationLogger(options.log || ((entry: Record<string, unknown>) => console.error(entry)));
  const withinBudget = () => monotonicNowMs() - startedAt < PASS_BUDGET_MS;
  try {
    signal.throwIfAborted();
    for (const kind of ['terminal', 'overdue', 'legacy'] as const) {
      if (!withinBudget()) break;
      try { await discover(store, kind, nowMs(), signal, withinBudget, log); }
      catch (error) {
        signal.throwIfAborted();
        failures.push(error);
        log({ event: 'receipt_claim_failure_notification_discovery_failed', incidentKind: kind });
      }
    }
    signal.throwIfAborted();
    const dueAtMs = nowMs();
    try {
      result = await drainReconciliationCandidates<ReceiptClaimFailureOutboxCandidate>({
        signal,
        cancellationMode: 'throw',
        failureMessage: FAILURE_MESSAGE,
        onResult: (value) => { result = value; },
        paging: {
          monotonicNowMs,
          budgetStartedAtMs: startedAt,
          budgetMs: PASS_BUDGET_MS,
          loadPage: (startAfter, limit) => store.queryDue({ dueAtMs, limit, startAfter }),
          candidateKey: (candidate) => candidate.eventId,
          probeBacklog: async () => {
            const [oldest] = await store.queryDue({ dueAtMs, limit: 1 });
            return { hasMore: Boolean(oldest), oldestDueAgeMs: oldest ? Math.max(0, nowMs() - oldest.nextAttemptAtMs) : null };
          },
        },
        processCandidate: async ({ row }) => {
          let record: ReceiptClaimFailureOutboxRecord;
          try { record = parseReceiptClaimFailureOutboxRow(row); }
          catch (error) {
            signal.throwIfAborted();
            const errors = [error];
            await store.quarantine(row, nowMs()).catch((failure: unknown) => { errors.push(failure); });
            log({ event: 'receipt_claim_failure_notification_invalid_outbox' });
            throw errors.length === 1 ? error : new AggregateError(errors, 'Receipt claim notification quarantine failed.');
          }
          try {
            const outcome = await publish(store, env.NOTIFICATION_EMAIL_QUEUE, record, signal, nowMs);
            if (outcome === 'failed') log({ event: 'receipt_claim_failure_notification_exhausted', incidentId: record.eventId });
            return outcome;
          } catch (error) {
            signal.throwIfAborted();
            log({ event: 'receipt_claim_failure_notification_publish_failed', incidentId: record.eventId });
            throw error;
          }
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, FAILURE_MESSAGE);
    return result;
  } catch (error) {
    result = { ...result, stopReason: signal.aborted ? 'cancelled' : 'failed' };
    throw error;
  } finally {
    reportReconciliationResult(result, options.onResult);
  }
}
