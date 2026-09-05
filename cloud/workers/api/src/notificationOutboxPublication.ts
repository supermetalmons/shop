import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.js';

const NOTIFICATION_PUBLICATION_LEASE_MS = 10 * 60_000;
const NOTIFICATION_PUBLICATION_MAX_ATTEMPTS = 4;
export const NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS = 6 * 60 * 60_000;

type NotificationPublicationClaimPlan =
  | { outcome: 'busy' }
  | { outcome: 'exhausted' }
  | { outcome: 'claimed'; attemptCount: number; retryUntilMs: number; expiresAtMs: number };

export function planNotificationPublicationClaim(args: {
  nowMs: number;
  attemptCount: number | null;
  retryUntilMs: number | null;
  activeUntilMs: number | null;
}): NotificationPublicationClaimPlan {
  if (args.activeUntilMs !== null && args.activeUntilMs > args.nowMs) return { outcome: 'busy' };
  if (
    args.attemptCount === null || args.retryUntilMs === null ||
    args.attemptCount >= NOTIFICATION_PUBLICATION_MAX_ATTEMPTS ||
    (args.attemptCount > 0 && args.retryUntilMs <= args.nowMs)
  ) return { outcome: 'exhausted' };
  return {
    outcome: 'claimed',
    attemptCount: args.attemptCount + 1,
    retryUntilMs: args.attemptCount === 0
      ? args.nowMs + NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS
      : args.retryUntilMs,
    expiresAtMs: args.nowMs + NOTIFICATION_PUBLICATION_LEASE_MS,
  };
}

export async function publishClaimedNotificationBatch<Result>(args: {
  signal: AbortSignal;
  nowMs: () => number;
  expiresAtMs: number;
  retryUntilMs: number;
  queue: Pick<Queue<NotificationEmailJobV1>, 'sendBatch'>;
  prepareAndPersist: () => Promise<readonly NotificationEmailJobV1[]>;
  finalize: (jobs: readonly NotificationEmailJobV1[]) => Promise<Result>;
  releaseUnusedClaim: () => Promise<void>;
  createExpiredClaimError: () => Error;
}): Promise<Result> {
  let sendStarted = false;
  try {
    args.signal.throwIfAborted();
    const jobs = await args.prepareAndPersist();
    args.signal.throwIfAborted();
    const nowMs = args.nowMs();
    if (nowMs >= args.expiresAtMs || nowMs >= args.retryUntilMs) throw args.createExpiredClaimError();
    if (jobs.length) {
      sendStarted = true;
      await args.queue.sendBatch(jobs.map((body) => ({ body, contentType: 'json' })));
    }
    return await args.finalize(jobs);
  } catch (error) {
    if (args.signal.aborted && !sendStarted) {
      await args.releaseUnusedClaim().catch(() => undefined);
    }
    throw error;
  }
}
