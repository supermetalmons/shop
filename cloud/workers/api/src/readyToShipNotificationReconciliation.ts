import {
  resolveDeliveryOrderDropId,
  resolveDeliveryOrderIdentity,
} from './deliveryOrderSummaries.js';
import { D1CommerceRepository } from './commerceRepository.js';
import type { ReadyNotificationCandidate } from './commerceDiscoveryCandidates.js';
import type { CommerceRepositoryContext } from './commerceTransactions.js';
import { drainReconciliationCandidates } from './reconciliationPass.js';
import {
  markPendingReadyToShipNotificationsFailed,
  notificationPersistenceContext,
  publishReadyToShipNotificationsDetailed,
} from './readyToShipNotificationOutbox.js';
import {
  reportReconciliationFailure, reconciliationLogger, type ReconciliationOptions, type ReconciliationResult,
} from './reconciliationResult.js';

export async function reconcilePendingReadyToShipNotifications(
  env: Pick<Env, 'COMMERCE_DB' | 'NOTIFICATION_EMAIL_QUEUE'>,
  signal: AbortSignal,
  overrides: {
    log?: (entry: Record<string, unknown>) => void;
    nowMs?: () => number;
    monotonicNowMs?: () => number;
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
  return drainReconciliationCandidates<ReadyNotificationCandidate>({
    signal,
    onResult: overrides.onResult,
    paging: {
      monotonicNowMs: overrides.monotonicNowMs,
      loadPage: (startAfter, limit) => repository.queryDueReadyNotifications({
        dueAtMs: context.nowMs, limit,
        ...(startAfter ? { startAfter: {
          nextAttemptAtMs: startAfter.nextAttemptAtMs, parentPath: startAfter.key.path, family: 'ready',
        } } : {}),
      }),
      candidateKey: (candidate) => candidate.key.path,
      probeBacklog: async () => {
        const [oldest] = await repository.queryDueReadyNotifications({ dueAtMs: context.nowMs, limit: 1 });
        return { hasMore: Boolean(oldest), oldestDueAgeMs: oldest ? Math.max(0, nowMs() - oldest.nextAttemptAtMs) : null };
      },
    },
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
