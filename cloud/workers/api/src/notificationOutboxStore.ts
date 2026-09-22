import { isNotificationEmailJobV1, type NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.js';
import type { NotificationOutboxFamily, NotificationOutboxRecord, NotificationOutboxMutation } from '../../../../shared/notificationOutbox.js';
import type { D1CommerceRepository } from './commerceRepository.js';
import { planNotificationPublicationClaim } from './notificationOutboxPublication.js';

type OutboxRepository = Pick<D1CommerceRepository, 'notificationOutbox'>;
type ClaimedOutboxOptions = {
  repository: OutboxRepository;
  claim: NotificationOutboxRecord;
  nowMs: () => number;
  parentVersion?: number;
};

export async function claimNotificationOutbox(args: {
  repository: OutboxRepository;
  parentPath: string;
  family: NotificationOutboxFamily;
  nowMs: () => number;
  signal?: AbortSignal;
  parentVersion?: number;
}): Promise<
  | { outcome: 'claimed'; claim: NotificationOutboxRecord; previousAttemptCount: number }
  | { outcome: 'none' | 'busy' | 'failed'; record: NotificationOutboxRecord | null }
> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    args.signal?.throwIfAborted();
    const record = await args.repository.notificationOutbox.get(args.parentPath, args.family);
    if (!record || record.state !== 'pending') {
      return { outcome: record?.state === 'failed' ? 'failed' : 'none', record };
    }
    const nowMs = args.nowMs();
    const plan = planNotificationPublicationClaim({
      nowMs, attemptCount: record.attemptCount, retryUntilMs: record.retryUntilMs,
      activeUntilMs: record.claimExpiresAtMs ?? record.nextAttemptAtMs,
    });
    if (plan.outcome === 'busy') return { outcome: 'busy', record };
    const changes: NotificationOutboxMutation = plan.outcome === 'exhausted'
      ? {
          state: 'failed', nextAttemptAtMs: null, claimId: null, claimExpiresAtMs: null,
          lastErrorCode: 'manual-review-required',
          entries: record.entries.map((entry) => {
            if (entry.state !== 'pending') return entry;
            const { payload, ...identity } = entry;
            return { ...identity, state: 'failed' as const, errorCode: 'manual-review-required',
              ...(record.family === 'stripe_terminal' && payload ? { payload } : {}) };
          }),
        }
      : {
          claimId: crypto.randomUUID(), attemptCount: plan.attemptCount,
          retryUntilMs: plan.retryUntilMs, claimExpiresAtMs: plan.expiresAtMs,
          nextAttemptAtMs: plan.expiresAtMs,
        };
    args.signal?.throwIfAborted();
    const updated = await args.repository.notificationOutbox.compareAndSet({
      expected: record, changes, nowMs, parentVersion: args.parentVersion,
    });
    if (!updated) continue;
    return plan.outcome === 'exhausted'
      ? { outcome: 'failed', record: updated }
      : { outcome: 'claimed', claim: updated, previousAttemptCount: record.attemptCount };
  }
  return { outcome: 'busy', record: await args.repository.notificationOutbox.get(args.parentPath, args.family) };
}

export async function updateClaimedNotificationOutbox(args: ClaimedOutboxOptions & {
  update: (record: NotificationOutboxRecord) => NotificationOutboxMutation;
}): Promise<NotificationOutboxRecord | null> {
  if (!args.claim.claimId || args.claim.claimExpiresAtMs === null) return null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const record = await args.repository.notificationOutbox.get(args.claim.parentPath, args.claim.family);
    if (!record || record.state !== 'pending' || record.generation !== args.claim.generation ||
      record.claimId !== args.claim.claimId) return null;
    const updated = await args.repository.notificationOutbox.compareAndSet({
      expected: record, changes: args.update(record), nowMs: args.nowMs(), parentVersion: args.parentVersion,
    });
    if (updated) return updated;
  }
  return null;
}

export function persistClaimedNotificationJobs(args: ClaimedOutboxOptions & {
  jobs: readonly NotificationEmailJobV1[];
  completeMissing?: boolean;
}): Promise<NotificationOutboxRecord | null> {
  return updateClaimedNotificationOutbox({
    ...args,
    update: (record) => {
      const nowMs = args.nowMs();
      if (nowMs >= (record.claimExpiresAtMs ?? 0) || nowMs >= record.retryUntilMs) {
        throw new Error('notification_publication_claim_expired');
      }
      if (new Set(args.jobs.map((job) => job.jobId)).size !== args.jobs.length) throw new Error('notification_publication_duplicate_job');
      for (const job of args.jobs) {
        if (!isNotificationEmailJobV1(job) || !record.entries.some((entry) => entry.state === 'pending' &&
          entry.kind === job.kind && entry.jobId === job.jobId && entry.idempotencyKey === job.idempotencyKey)) {
          throw new Error('notification_publication_job_identity_invalid');
        }
        const saved = record.entries.find((entry) => entry.jobId === job.jobId)?.payload;
        if (saved && JSON.stringify(saved) !== JSON.stringify(job)) throw new Error('notification_publication_payload_changed');
      }
      const entries = record.entries.map((entry) => {
        if (entry.state !== 'pending') return entry;
        const job = args.jobs.find((candidate) => candidate.jobId === entry.jobId);
        if (job) return { ...entry, payload: entry.payload ?? job };
        if (!args.completeMissing) return entry;
        if (entry.payload) throw new Error('notification_publication_payload_omitted');
        return { ...entry, state: 'queued' as const, queuedAtMs: nowMs };
      });
      const pending = entries.some((entry) => entry.state === 'pending');
      return { entries, ...(!pending ? {
        state: entries.some((entry) => entry.state === 'failed') ? 'failed' as const : 'queued' as const,
        claimId: null, claimExpiresAtMs: null, nextAttemptAtMs: null,
      } : {}) };
    },
  });
}

export function markClaimedNotificationQueued(args: ClaimedOutboxOptions & {
  jobs: readonly NotificationEmailJobV1[];
}): Promise<NotificationOutboxRecord | null> {
  return updateClaimedNotificationOutbox({
    ...args,
    update: (record) => {
      if (new Set(args.jobs.map((job) => job.jobId)).size !== args.jobs.length) throw new Error('notification_publication_duplicate_job');
      for (const job of args.jobs) {
        const saved = record.entries.find((entry) => entry.state === 'pending' && entry.jobId === job.jobId && entry.idempotencyKey === job.idempotencyKey)?.payload;
        if (!saved || JSON.stringify(saved) !== JSON.stringify(job)) throw new Error('notification_publication_snapshot_missing');
      }
      const entries = record.entries.map((entry) => {
        if (entry.state !== 'pending' || !args.jobs.some((job) =>
          job.jobId === entry.jobId && job.idempotencyKey === entry.idempotencyKey)) return entry;
        const { payload: _payload, ...identity } = entry;
        return { ...identity, state: 'queued' as const, queuedAtMs: args.nowMs() };
      });
      const pending = entries.some((entry) => entry.state === 'pending');
      return {
        entries,
        state: pending ? 'pending' : entries.some((entry) => entry.state === 'failed') ? 'failed' : 'queued',
        ...(!pending ? { claimId: null, claimExpiresAtMs: null, nextAttemptAtMs: null } : {}),
      };
    },
  });
}

export function releaseNotificationOutboxClaim(args: ClaimedOutboxOptions): Promise<NotificationOutboxRecord | null> {
  return updateClaimedNotificationOutbox({
    ...args,
    update: (record) => ({
      attemptCount: Math.max(0, record.attemptCount - 1), claimId: null,
      claimExpiresAtMs: null, nextAttemptAtMs: args.nowMs(),
    }),
  });
}
