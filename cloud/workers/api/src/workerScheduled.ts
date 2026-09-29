import { reconcilePendingShippedNotifications } from './buyerOrderShippedOutbox.js';
import { cleanupExpiredAnonymousAuthSessions } from './anonymousAuth.js';
import { loadCommerceAuthorityControl } from './commerceRepository.js';
import { reconcilePendingDeliveryPackStatusProjections } from './deliveryPackStatusOutbox.js';
import { reconcilePendingReadyToShipNotifications } from './readyToShipNotificationReconciliation.js';
import { cleanupExpiredReceiptTransferRateLimitBuckets } from './receiptTransferRateLimit.js';
import { cleanupExpiredStaffAuthState } from './staffWalletAuth.js';
import { cleanupExpiredMiNoteAuthState } from './miNoteAuth.js';
import { reconcileStaleStripeFulfillments } from './stripeCheckoutReconciliation.js';
import { reconcilePendingStripeTerminalNotifications } from './stripeCheckout/notificationReconciliation.js';
import { reconcileReceiptClaimWorkflows } from './stripeReceiptClaimWorkflowDispatch.js';
import { reconcilePendingPreorders } from './preorders.js';

export const SCHEDULED_RECONCILIATION_TIMEOUT_MS = 60_000;

export type ScheduledReconcilers = {
  notifications: typeof reconcilePendingReadyToShipNotifications;
  ops: (env: Pick<Env, 'OPS_DB'>, signal: AbortSignal) => Promise<void>;
  packStatus: typeof reconcilePendingDeliveryPackStatusProjections;
  stripe: typeof reconcileStaleStripeFulfillments;
  stripeNotifications: typeof reconcilePendingStripeTerminalNotifications;
  shippedNotifications: typeof reconcilePendingShippedNotifications;
  receiptClaims: typeof reconcileReceiptClaimWorkflows;
  preorders: typeof reconcilePendingPreorders;
};

async function cleanupScheduledOpsState(
  env: Pick<Env, 'OPS_DB'>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const cleanups = [
    async function cleanupReceiptTransferRateLimits() {
      const result = await cleanupExpiredReceiptTransferRateLimitBuckets(env.OPS_DB, Date.now());
      if (result.deletedCount > 0) {
        console.log({
          event: 'receipt_transfer_rate_limit_cleanup_completed',
          deletedCount: result.deletedCount,
          limitReached: result.limitReached,
          hasMore: result.hasMore,
        });
      }
      if (result.limitReached && result.hasMore) {
        console.error({
          event: 'receipt_transfer_rate_limit_cleanup_backlog',
          deletedCount: result.deletedCount,
        });
      }
    },
    async function cleanupStaffAuth() {
      const staffAuthCleanup = await cleanupExpiredStaffAuthState(env.OPS_DB, Date.now());
      if (
        staffAuthCleanup.challengesDeleted > 0 ||
        staffAuthCleanup.sessionsDeleted > 0
      ) {
        console.log({
          event: 'staff_auth_cleanup_completed',
          ...staffAuthCleanup,
        });
      }
      if (staffAuthCleanup.limitReached && staffAuthCleanup.hasMore) {
        console.error({ event: 'staff_auth_cleanup_backlog', ...staffAuthCleanup });
      }
    },
    async function cleanupAnonymousAuth() {
      const anonymousAuthCleanup = await cleanupExpiredAnonymousAuthSessions(env.OPS_DB, Date.now());
      if (anonymousAuthCleanup.deletedCount > 0) {
        console.log({ event: 'anonymous_auth_cleanup_completed', ...anonymousAuthCleanup });
      }
      if (anonymousAuthCleanup.limitReached && anonymousAuthCleanup.hasMore) {
        console.error({ event: 'anonymous_auth_cleanup_backlog', ...anonymousAuthCleanup });
      }
    },
    async function cleanupMiNoteAuth() {
      const result = await cleanupExpiredMiNoteAuthState(env.OPS_DB, Date.now());
      if (result.challengesDeleted > 0 || result.sessionsDeleted > 0) {
        console.log({ event: 'mi_note_auth_cleanup_completed', ...result });
      }
      if (result.limitReached && result.hasMore) {
        console.error({ event: 'mi_note_auth_cleanup_backlog', ...result });
      }
    },
  ];
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
    if (signal.aborted) {
      if (!failures.includes(signal.reason)) failures.push(signal.reason);
      break;
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Scheduled OPS cleanup failed');
}

const defaultScheduledReconcilers: ScheduledReconcilers = {
  notifications: reconcilePendingReadyToShipNotifications,
  ops: cleanupScheduledOpsState,
  packStatus: reconcilePendingDeliveryPackStatusProjections,
  stripe: reconcileStaleStripeFulfillments,
  stripeNotifications: reconcilePendingStripeTerminalNotifications,
  shippedNotifications: reconcilePendingShippedNotifications,
  receiptClaims: reconcileReceiptClaimWorkflows,
  preorders: reconcilePendingPreorders,
};

type ScheduledJobResult = Awaited<ReturnType<ScheduledReconcilers[keyof ScheduledReconcilers]>>;
type ScheduledJobOutcome =
  | { outcome: 'succeeded'; result: ScheduledJobResult }
  | { outcome: 'failed'; error: unknown };

function reportScheduledJob(
  job: keyof ScheduledReconcilers,
  startedAt: number,
  outcome: ScheduledJobOutcome,
): void {
  try {
    const entry = {
      event: 'scheduled_reconciliation_job',
      job,
      outcome: outcome.outcome,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...(outcome.outcome === 'failed'
        ? { errorName: outcome.error instanceof Error ? outcome.error.name : 'UnknownError' }
        : typeof outcome.result === 'number'
          ? { processedCount: outcome.result }
          : outcome.result ? { enqueued: outcome.result.enqueued, failed: outcome.result.failed } : {}),
    };
    if (outcome.outcome === 'failed') console.error(entry);
    else console.log(entry);
  } catch {}
}

function runScheduledJob<T extends ScheduledJobResult>(
  job: keyof ScheduledReconcilers,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  let result: Promise<T>;
  try {
    result = action();
  } catch (error) {
    reportScheduledJob(job, startedAt, { outcome: 'failed', error });
    throw error;
  }
  return result.then((value) => {
    reportScheduledJob(job, startedAt, { outcome: 'succeeded', result: value });
    return value;
  }, (error: unknown) => {
    reportScheduledJob(job, startedAt, { outcome: 'failed', error });
    throw error;
  });
}

async function runScheduledCommerceReconciliations(
  env: Env,
  signal: AbortSignal,
  reconcilers: ScheduledReconcilers,
): Promise<unknown[]> {
  if (env.COMMERCE_DB && (await loadCommerceAuthorityControl(env.COMMERCE_DB)).state === 'paused') {
    return [];
  }
  const results = await Promise.allSettled([
    runScheduledJob('stripe', () => reconcilers.stripe(env, signal)),
    runScheduledJob('stripeNotifications', () => reconcilers.stripeNotifications(env, signal)),
    runScheduledJob('shippedNotifications', () => reconcilers.shippedNotifications(env, signal)),
    runScheduledJob('packStatus', () => reconcilers.packStatus(env, signal)),
    runScheduledJob('notifications', () => reconcilers.notifications(env, signal)),
    runScheduledJob('receiptClaims', () => reconcilers.receiptClaims(env, signal)),
    runScheduledJob('preorders', () => reconcilers.preorders(env, signal)),
  ]);
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
}

export async function runScheduledReconciliations(
  env: Env,
  signal: AbortSignal,
  overrides: Partial<ScheduledReconcilers> = {},
): Promise<void> {
  const reconcilers = { ...defaultScheduledReconcilers, ...overrides };
  const [commerce, ops] = await Promise.allSettled([
    runScheduledCommerceReconciliations(env, signal, reconcilers),
    runScheduledJob('ops', () => reconcilers.ops(env, signal)),
  ]);
  const failures = commerce.status === 'rejected' ? [commerce.reason] : commerce.value;
  if (ops.status === 'rejected') failures.push(ops.reason);
  if (failures.length) throw new AggregateError(failures, 'Scheduled reconciliation failed');
}
