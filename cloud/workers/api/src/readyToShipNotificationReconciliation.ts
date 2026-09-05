import {
  resolveDeliveryOrderDropId,
  resolveDeliveryOrderIdentity,
} from './deliveryOrderSummaries.js';
import { D1CommerceRepository } from './commerceRepository.js';
import { commerceDocument, type CommerceDocumentContext } from './commerceTransactions.js';
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
  const repository = new D1CommerceRepository(env.COMMERCE_DB);
  const context: CommerceDocumentContext = {
    commerceDb: env.COMMERCE_DB,
    repository,
    nowMs: (overrides.nowMs || Date.now)(),
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
  for (const candidate of candidates) {
    if (signal.aborted) {
      failures.push(signal.reason);
      break;
    }
    const document = commerceDocument(candidate);
    if (!document) continue;
    const resolution = resolveDeliveryOrderIdentity(document.id, document.fields, document.path);
    const dropId = resolveDeliveryOrderDropId(document.fields, document.path);
    if (!('identity' in resolution) || !dropId || dropId !== resolution.identity.dropId) {
      try {
        await markPendingReadyToShipNotificationsFailed(
          notificationPersistenceContext(context),
          document.path,
          'invalid-order-identity',
        );
        log({
          event: 'ready_to_ship_notifications_invalid_order',
          documentPath: document.path,
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
      });
      if (published) processed += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Ready-notification reconciliation failed');
  return processed;
}
