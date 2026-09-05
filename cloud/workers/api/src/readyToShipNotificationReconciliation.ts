import {
  resolveDeliveryOrderDropId,
  resolveDeliveryOrderIdentity,
} from './deliveryOrderSummaries.js';
import { D1CommerceRepository } from './commerceRepository.js';
import type { CommerceRepositoryContext } from './commerceTransactions.js';
import {
  markPendingReadyToShipNotificationsFailed,
  notificationPersistenceContext,
  publishReadyToShipNotifications,
} from './readyToShipNotificationOutbox.js';

const READY_NOTIFICATION_RECONCILIATION_SCAN_SIZE = 8;
const READY_NOTIFICATION_RECONCILIATION_PUBLISH_LIMIT = 4;

export async function reconcilePendingReadyToShipNotifications(
  env: Pick<Env, 'COMMERCE_DB' | 'NOTIFICATION_EMAIL_QUEUE'>,
  signal: AbortSignal,
  overrides: {
    log?: (entry: Record<string, unknown>) => void;
    nowMs?: () => number;
  } = {},
): Promise<number> {
  const nowMs = overrides.nowMs || Date.now;
  const repository = new D1CommerceRepository(env.COMMERCE_DB);
  const context: CommerceRepositoryContext = {
    repository,
    nowMs: nowMs(),
    signal,
  };
  const log = overrides.log || ((entry: Record<string, unknown>) => console.log(entry));
  signal.throwIfAborted();
  const candidates = await repository.queryDueReadyNotifications({
    dueAtMs: context.nowMs,
    limit: READY_NOTIFICATION_RECONCILIATION_SCAN_SIZE,
  });
  const failures: unknown[] = [];
  let publicationAttempts = 0;
  let processed = 0;
  for (const document of candidates) {
    if (signal.aborted) {
      failures.push(signal.reason);
      break;
    }
    const resolution = resolveDeliveryOrderIdentity(document.key.documentId, document.data, document.key.path);
    const dropId = resolveDeliveryOrderDropId(document.data, document.key.path);
    if (!('identity' in resolution) || !dropId || dropId !== resolution.identity.dropId) {
      try {
        await markPendingReadyToShipNotificationsFailed(
          notificationPersistenceContext(context),
          document.key.path,
          'invalid-order-identity',
        );
        log({
          event: 'ready_to_ship_notifications_invalid_order',
          documentPath: document.key.path,
        });
      } catch (error) {
        failures.push(error);
      }
      continue;
    }
    if (publicationAttempts >= READY_NOTIFICATION_RECONCILIATION_PUBLISH_LIMIT) break;
    publicationAttempts += 1;
    try {
      const published = await publishReadyToShipNotifications({
        context,
        deliveryId: resolution.identity.deliveryId,
        document,
        dropId,
        queue: env.NOTIFICATION_EMAIL_QUEUE,
        nowMs,
      });
      if (published) processed += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Ready-notification reconciliation failed');
  return processed;
}
