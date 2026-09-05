import { cleanupExpiredAnonymousAuthSessions } from './anonymousAuth.js';
import { loadCommerceAuthorityControl } from './commerceRepository.js';
import { reconcilePendingDeliveryPackStatusProjections } from './deliveryPackStatusOutbox.js';
import { reconcilePendingReadyToShipNotifications } from './readyToShipNotificationReconciliation.js';
import { cleanupExpiredReceiptTransferRateLimitBuckets } from './receiptTransferRateLimit.js';
import { cleanupExpiredStaffAuthState } from './staffWalletAuth.js';
import { reconcileStaleStripeFulfillments } from './stripeCheckoutReconciliation.js';
import { reconcilePendingStripeTerminalNotifications } from './stripeCheckout/notificationReconciliation.js';

export const SCHEDULED_RECONCILIATION_TIMEOUT_MS = 60_000;

export type ScheduledReconcilers = {
  notifications: typeof reconcilePendingReadyToShipNotifications;
  ops: (env: Pick<Env, 'OPS_DB'>, signal: AbortSignal) => Promise<void>;
  packStatus: typeof reconcilePendingDeliveryPackStatusProjections;
  stripe: typeof reconcileStaleStripeFulfillments;
  stripeNotifications: typeof reconcilePendingStripeTerminalNotifications;
};

async function cleanupScheduledOpsState(
  env: Pick<Env, 'OPS_DB'>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const result = await cleanupExpiredReceiptTransferRateLimitBuckets(env.OPS_DB, Date.now());
  if (signal.aborted) throw signal.reason;
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
  const anonymousAuthCleanup = await cleanupExpiredAnonymousAuthSessions(env.OPS_DB, Date.now());
  if (anonymousAuthCleanup.deletedCount > 0) {
    console.log({ event: 'anonymous_auth_cleanup_completed', ...anonymousAuthCleanup });
  }
  if (anonymousAuthCleanup.limitReached && anonymousAuthCleanup.hasMore) {
    console.error({ event: 'anonymous_auth_cleanup_backlog', ...anonymousAuthCleanup });
  }
}

const defaultScheduledReconcilers: ScheduledReconcilers = {
  notifications: reconcilePendingReadyToShipNotifications,
  ops: cleanupScheduledOpsState,
  packStatus: reconcilePendingDeliveryPackStatusProjections,
  stripe: reconcileStaleStripeFulfillments,
  stripeNotifications: reconcilePendingStripeTerminalNotifications,
};

export async function runScheduledReconciliations(
  env: Env,
  signal: AbortSignal,
  overrides: Partial<ScheduledReconcilers> = {},
): Promise<void> {
  const reconcilers = { ...defaultScheduledReconcilers, ...overrides };
  if (env.COMMERCE_DB && (await loadCommerceAuthorityControl(env.COMMERCE_DB)).state === 'paused') {
    await reconcilers.ops(env, signal);
    return;
  }
  const results = await Promise.allSettled([
    reconcilers.stripe(env, signal),
    reconcilers.stripeNotifications(env, signal),
    reconcilers.packStatus(env, signal),
    reconcilers.notifications(env, signal),
    reconcilers.ops(env, signal),
  ]);
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, 'Scheduled reconciliation failed');
}
