import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.js';
import type { NotificationOutboxRecord } from '../../../../shared/notificationOutbox.js';
import {
  createBuyerOrderShippedNotificationJob,
  isBuyerOrderShippedNotificationEligible,
} from './buyerOrderShipped.js';
import { D1CommerceRepository, commerceKeyFromPath } from './commerceRepository.js';
import type { NotificationOutboxCandidate } from './commerceDiscoveryCandidates.js';
import {
  claimNotificationOutbox,
  markClaimedNotificationQueued,
  persistClaimedNotificationJobs,
  releaseNotificationOutboxClaim,
  updateClaimedNotificationOutbox,
} from './notificationOutboxStore.js';
import { publishClaimedNotificationBatch } from './notificationOutboxPublication.js';
import { drainReconciliationCandidates } from './reconciliationPass.js';
import {
  reportReconciliationFailure, type ReconciliationOptions, type ReconciliationOutcome, type ReconciliationResult,
} from './reconciliationResult.js';

type ShippedRepository = Pick<D1CommerceRepository, 'get' | 'notificationOutbox'>;

function cancelledNotification(record: NotificationOutboxRecord) {
  return {
    state: 'cancelled' as const,
    entries: record.entries.map(({ payload: _payload, ...entry }) => entry),
    nextAttemptAtMs: null,
    claimId: null,
    claimExpiresAtMs: null,
    lastErrorCode: 'order-no-longer-eligible',
  };
}

export async function publishBuyerOrderShippedNotificationDetailed(args: {
  repository: ShippedRepository;
  parentPath: string;
  queue: Pick<Queue<NotificationEmailJobV1>, 'sendBatch'>;
  signal: AbortSignal;
  nowMs?: () => number;
}): Promise<{ outcome: ReconciliationOutcome; published: boolean; errorCode?: string }> {
  const nowMs = args.nowMs || Date.now;
  const key = commerceKeyFromPath(args.parentPath);
  if (!key || key.kind !== 'delivery_order' || !key.dropId) throw new Error('Invalid shipped notification parent.');
  args.signal.throwIfAborted();
  const document = await args.repository.get(key);
  if (!document) return { outcome: 'skipped', published: false };
  if (!isBuyerOrderShippedNotificationEligible(document.data)) {
    const record = await args.repository.notificationOutbox.get(key.path, 'shipped');
    if (record?.state === 'queued') return { outcome: 'completed', published: true };
    if (record?.state === 'pending') {
      const cancelled = await args.repository.notificationOutbox.compareAndSet({
        expected: record,
        changes: cancelledNotification(record),
        nowMs: nowMs(),
        parentVersion: document.version,
      });
      if (!cancelled) return { outcome: 'deferred', published: false };
    }
    return { outcome: 'skipped', published: false };
  }
  const claimed = await claimNotificationOutbox({
    repository: args.repository,
    parentPath: key.path,
    family: 'shipped',
    nowMs,
    signal: args.signal,
    parentVersion: document.version,
  });
  if (claimed.outcome !== 'claimed') {
    return {
      outcome: claimed.record?.state === 'queued' ? 'completed' : claimed.record?.state === 'failed' ? 'failed'
        : claimed.record?.state === 'pending' ? 'deferred' : 'skipped',
      published: claimed.record?.state === 'queued',
      ...(claimed.record?.lastErrorCode ? { errorCode: claimed.record.lastErrorCode } : {}),
    };
  }
  const claim = claimed.claim;
  const claimArgs = { repository: args.repository, claim, nowMs };
  return publishClaimedNotificationBatch({
    signal: args.signal,
    nowMs,
    expiresAtMs: claim.claimExpiresAtMs!,
    retryUntilMs: claim.retryUntilMs,
    queue: args.queue,
    prepareAndPersist: async () => {
      const latest = await args.repository.get(key);
      if (!latest || !isBuyerOrderShippedNotificationEligible(latest.data)) {
        if (latest) {
          const cancelled = await updateClaimedNotificationOutbox({
            ...claimArgs,
            parentVersion: latest.version,
            update: cancelledNotification,
          });
          if (cancelled) claimArgs.claim = cancelled;
        }
        throw new Error('Shipped notification order is no longer eligible.');
      }
      const entry = claim.entries[0];
      const job = entry.payload || await createBuyerOrderShippedNotificationJob({
        deliveryId: Number(key.documentId),
        dropId: key.dropId!,
        jobId: entry.jobId,
        idempotencyKey: entry.idempotencyKey,
        order: latest.data,
      });
      const stored = await persistClaimedNotificationJobs({ ...claimArgs, jobs: [job], parentVersion: latest.version });
      if (!stored) {
        throw new Error('Shipped notification claim changed.');
      }
      claimArgs.claim = stored;
      const beforeSend = await args.repository.get(key);
      if (!beforeSend || !isBuyerOrderShippedNotificationEligible(beforeSend.data)) {
        if (beforeSend) {
          const cancelled = await updateClaimedNotificationOutbox({
            ...claimArgs, parentVersion: beforeSend.version, update: cancelledNotification,
          });
          if (cancelled) claimArgs.claim = cancelled;
        }
        throw new Error('Shipped notification order changed before publication.');
      }
      const checked = await updateClaimedNotificationOutbox({ ...claimArgs, parentVersion: beforeSend.version, update: () => ({}) });
      if (!checked) {
        throw new Error('Shipped notification claim changed before publication.');
      }
      claimArgs.claim = checked;
      return [job];
    },
    finalize: async (jobs) => {
      const updated = await markClaimedNotificationQueued({ ...claimArgs, jobs: [...jobs] });
      if (!updated) {
        throw new Error('Shipped notification finalization lost its claim.');
      }
      claimArgs.claim = updated;
      return { outcome: 'completed' as const, published: true };
    },
    releaseUnusedClaim: async () => {
      const released = await releaseNotificationOutboxClaim(claimArgs);
      if (released) claimArgs.claim = released;
    },
    createExpiredClaimError: () => new Error('Shipped notification publication lease expired.'),
  });
}

export async function publishBuyerOrderShippedNotification(
  args: Parameters<typeof publishBuyerOrderShippedNotificationDetailed>[0],
): Promise<boolean> {
  return (await publishBuyerOrderShippedNotificationDetailed(args)).published;
}

export async function reconcilePendingShippedNotifications(
  env: Pick<Env, 'COMMERCE_DB' | 'NOTIFICATION_EMAIL_QUEUE'>,
  signal: AbortSignal,
  overrides: { nowMs?: () => number; monotonicNowMs?: () => number } & ReconciliationOptions = {},
): Promise<ReconciliationResult> {
  const nowMs = overrides.nowMs || Date.now;
  const dueAtMs = nowMs();
  const repository = new D1CommerceRepository(env.COMMERCE_DB);
  return drainReconciliationCandidates<NotificationOutboxCandidate>({
    signal,
    onResult: overrides.onResult,
    paging: {
      monotonicNowMs: overrides.monotonicNowMs,
      loadPage: (startAfter, limit) => repository.notificationOutbox.queryDue({
        family: 'shipped', dueAtMs, limit, ...(startAfter ? { startAfter } : {}),
      }),
      candidateKey: (candidate) => `${candidate.family}:${candidate.parentPath}`,
      probeBacklog: async () => {
        const [oldest] = await repository.notificationOutbox.queryDue({ family: 'shipped', dueAtMs, limit: 1 });
        return { hasMore: Boolean(oldest), oldestDueAgeMs: oldest ? Math.max(0, nowMs() - oldest.nextAttemptAtMs) : null };
      },
    },
    failureMessage: 'Shipped notification reconciliation failed',
    processCandidate: async (candidate) => {
      const published = await publishBuyerOrderShippedNotificationDetailed({
        repository, parentPath: candidate.parentPath, queue: env.NOTIFICATION_EMAIL_QUEUE, signal, nowMs,
      });
      if (published.outcome === 'failed') reportReconciliationFailure('shippedNotifications', { parentPath: candidate.parentPath },
        undefined, published.errorCode || 'notification-outbox-failed');
      return published.outcome;
    },
    onFailure: (candidate, error) => {
      reportReconciliationFailure('shippedNotifications', { parentPath: candidate.parentPath }, error);
      console.error({ event: 'buyer_order_shipped_notification_enqueue_failed', parentPath: candidate.parentPath,
        error: error instanceof Error ? { name: error.name } : { name: 'UnknownError' } });
    },
  });
}
