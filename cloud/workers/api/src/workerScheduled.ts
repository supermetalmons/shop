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
import {
  emptyReconciliationResult, recordReconciliationOutcome, reportReconciliationFailure,
  reportReconciliationResult, reconciliationLogger, type ReconciliationOptions, type ReconciliationResult,
} from './reconciliationResult.js';

export const SCHEDULED_RECONCILIATION_TIMEOUT_MS = 60_000;

export type ScheduledReconcilers = {
  notifications: typeof reconcilePendingReadyToShipNotifications;
  ops: typeof cleanupScheduledOpsState;
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
  options: ReconciliationOptions = {},
): Promise<ReconciliationResult> {
  const summary = emptyReconciliationResult();
  const log = reconciliationLogger((entry) => console.log(entry));
  const errorLog = reconciliationLogger((entry) => console.error(entry));
  const cleanups = [
    async function cleanupReceiptTransferRateLimits() {
      const result = await cleanupExpiredReceiptTransferRateLimitBuckets(env.OPS_DB, Date.now());
      if (result.deletedCount > 0) {
        log({
          event: 'receipt_transfer_rate_limit_cleanup_completed',
          deletedCount: result.deletedCount,
          limitReached: result.limitReached,
          hasMore: result.hasMore,
        });
      }
      if (result.limitReached && result.hasMore) {
        errorLog({
          event: 'receipt_transfer_rate_limit_cleanup_backlog',
          deletedCount: result.deletedCount,
        });
      }
      return result.limitReached && result.hasMore;
    },
    async function cleanupStaffAuth() {
      const staffAuthCleanup = await cleanupExpiredStaffAuthState(env.OPS_DB, Date.now());
      if (
        staffAuthCleanup.challengesDeleted > 0 ||
        staffAuthCleanup.sessionsDeleted > 0
      ) {
        log({
          event: 'staff_auth_cleanup_completed',
          ...staffAuthCleanup,
        });
      }
      if (staffAuthCleanup.limitReached && staffAuthCleanup.hasMore) {
        errorLog({ event: 'staff_auth_cleanup_backlog', ...staffAuthCleanup });
      }
      return staffAuthCleanup.limitReached && staffAuthCleanup.hasMore;
    },
    async function cleanupAnonymousAuth() {
      const anonymousAuthCleanup = await cleanupExpiredAnonymousAuthSessions(env.OPS_DB, Date.now());
      if (anonymousAuthCleanup.deletedCount > 0) {
        log({ event: 'anonymous_auth_cleanup_completed', ...anonymousAuthCleanup });
      }
      if (anonymousAuthCleanup.limitReached && anonymousAuthCleanup.hasMore) {
        errorLog({ event: 'anonymous_auth_cleanup_backlog', ...anonymousAuthCleanup });
      }
      return anonymousAuthCleanup.limitReached && anonymousAuthCleanup.hasMore;
    },
    async function cleanupMiNoteAuth() {
      const result = await cleanupExpiredMiNoteAuthState(env.OPS_DB, Date.now());
      if (result.challengesDeleted > 0 || result.sessionsDeleted > 0) {
        log({ event: 'mi_note_auth_cleanup_completed', ...result });
      }
      if (result.limitReached && result.hasMore) {
        errorLog({ event: 'mi_note_auth_cleanup_backlog', ...result });
      }
      return result.limitReached && result.hasMore;
    },
  ];
  try {
    if (signal.aborted) throw signal.reason;
    const failures: unknown[] = [];
    for (const cleanup of cleanups) {
      try {
        const backlog = await cleanup();
        recordReconciliationOutcome(summary, backlog ? 'deferred' : 'completed');
      } catch (error) {
        recordReconciliationOutcome(summary, 'failed');
        reportReconciliationFailure('ops', { cleanup: cleanup.name }, error);
        failures.push(error);
      }
      if (signal.aborted) {
        if (!failures.includes(signal.reason)) failures.push(signal.reason);
        break;
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Scheduled OPS cleanup failed');
    return summary;
  } finally {
    reportReconciliationResult(summary, options.onResult);
  }
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

type ScheduledJobOutcome =
  | { outcome: 'succeeded'; result: ReconciliationResult }
  | { outcome: 'failed'; error: unknown; result: ReconciliationResult };

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
      ...outcome.result,
      ...(outcome.outcome === 'failed'
        ? { errorName: outcome.error instanceof Error ? outcome.error.name : 'UnknownError' }
        : {}),
    };
    if (outcome.outcome === 'failed') console.error(entry);
    else console.log(entry);
  } catch {}
}

function runScheduledJob(
  job: keyof ScheduledReconcilers,
  action: (onResult: NonNullable<ReconciliationOptions['onResult']>) => Promise<ReconciliationResult>,
): Promise<ReconciliationResult> {
  const startedAt = performance.now();
  let summary: ReconciliationResult = emptyReconciliationResult();
  let result: Promise<ReconciliationResult>;
  try {
    result = action((value) => { summary = { ...value }; });
  } catch (error) {
    reportScheduledJob(job, startedAt, { outcome: 'failed', error, result: summary });
    throw error;
  }
  return result.then((value) => {
    reportScheduledJob(job, startedAt, { outcome: 'succeeded', result: value });
    return value;
  }, (error: unknown) => {
    reportScheduledJob(job, startedAt, { outcome: 'failed', error, result: summary });
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
    runScheduledJob('stripe', (onResult) => reconcilers.stripe(env, signal, { onResult })),
    runScheduledJob('stripeNotifications', (onResult) => reconcilers.stripeNotifications(env, signal, { onResult })),
    runScheduledJob('shippedNotifications', (onResult) => reconcilers.shippedNotifications(env, signal, { onResult })),
    runScheduledJob('packStatus', (onResult) => reconcilers.packStatus(env, signal, { onResult })),
    runScheduledJob('notifications', (onResult) => reconcilers.notifications(env, signal, { onResult })),
    runScheduledJob('receiptClaims', (onResult) => reconcilers.receiptClaims(env, signal, { onResult })),
    runScheduledJob('preorders', (onResult) => reconcilers.preorders(env, signal, { onResult })),
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
    runScheduledJob('ops', (onResult) => reconcilers.ops(env, signal, { onResult })),
  ]);
  const failures = commerce.status === 'rejected' ? [commerce.reason] : commerce.value;
  if (ops.status === 'rejected') failures.push(ops.reason);
  if (failures.length) throw new AggregateError(failures, 'Scheduled reconciliation failed');
}
