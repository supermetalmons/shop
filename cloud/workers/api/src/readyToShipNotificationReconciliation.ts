import {
  resolveDeliveryOrderDropId,
  resolveDeliveryOrderIdentity,
} from './deliveryOrderSummaries.js';
import { D1CommerceRepository } from './commerceRepository.js';
import type { CommerceRepositoryContext } from './commerceTransactions.js';
import { drainNotificationCandidates } from './notificationReconciliation.js';
import {
  markPendingReadyToShipNotificationsFailed,
  notificationPersistenceContext,
  publishReadyToShipNotificationsDetailed,
} from './readyToShipNotificationOutbox.js';
import {
  reportReconciliationFailure, reconciliationLogger, type ReconciliationOptions, type ReconciliationResult,
} from './reconciliationResult.js';

const READY_NOTIFICATION_RECONCILIATION_SCAN_SIZE = 8;
const READY_NOTIFICATION_RECONCILIATION_PUBLISH_LIMIT = 4;

export async function reconcilePendingReadyToShipNotifications(
  env: Pick<Env, 'COMMERCE_DB' | 'NOTIFICATION_EMAIL_QUEUE'>,
  signal: AbortSignal,
  overrides: {
    log?: (entry: Record<string, unknown>) => void;
    nowMs?: () => number;
  } & ReconciliationOptions = {},
): Promise<ReconciliationResult> {
  const nowMs = overrides.nowMs || Date.now;
  const repository = new D1CommerceRepository(env.COMMERCE_DB);
  const context: CommerceRepositoryContext = {
    repository,
    nowMs: nowMs(),
    signal,
  };
  const log = reconciliationLogger(overrides.log || ((entry) => console.log(entry)));
  let publicationAttempts = 0;
  return drainNotificationCandidates({
    signal,
    onResult: overrides.onResult,
    loadCandidates: () => repository.queryDueReadyNotifications({
      dueAtMs: context.nowMs,
      limit: READY_NOTIFICATION_RECONCILIATION_SCAN_SIZE,
    }),
    failureMessage: 'Ready-notification reconciliation failed',
    processCandidate: async (candidate) => {
      const resolution = resolveDeliveryOrderIdentity(candidate.key.documentId, candidate.identityFields, candidate.key.path);
      const dropId = resolveDeliveryOrderDropId(candidate.identityFields, candidate.key.path);
      if (!('identity' in resolution) || !dropId || dropId !== resolution.identity.dropId) {
        const changed = await markPendingReadyToShipNotificationsFailed(
          notificationPersistenceContext(context),
          candidate.key.path,
          'invalid-order-identity',
        );
        log({
          event: 'ready_to_ship_notifications_invalid_order',
          documentPath: candidate.key.path,
        });
        if (changed.length) reportReconciliationFailure('notifications', { parentPath: candidate.key.path },
          undefined, 'invalid-order-identity');
        return changed.length ? 'failed' : 'skipped';
      }
      if (publicationAttempts >= READY_NOTIFICATION_RECONCILIATION_PUBLISH_LIMIT) return 'stop';
      publicationAttempts += 1;
      const published = await publishReadyToShipNotificationsDetailed({
        context,
        deliveryId: resolution.identity.deliveryId,
        key: candidate.key,
        dropId,
        queue: env.NOTIFICATION_EMAIL_QUEUE,
        nowMs,
      });
      if (published.outcome === 'failed') reportReconciliationFailure('notifications', { parentPath: candidate.key.path },
        undefined, published.errorCode || 'notification-outbox-failed');
      return published.outcome;
    },
    onFailure: (candidate, error) => reportReconciliationFailure('notifications', { parentPath: candidate.key.path }, error),
  });
}
