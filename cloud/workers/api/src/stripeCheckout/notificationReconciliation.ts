import { D1CommerceRepository } from '../commerceRepository.js';
import { getApiDrop } from '../dropConfig.js';
import type { StripeCheckoutCommerceContext } from './commerce.js';
import { publishPendingStripeCheckoutTerminalNotifications } from './notificationOutbox.js';

export async function reconcilePendingStripeTerminalNotifications(
  env: Pick<Env, 'COMMERCE_DB' | 'NOTIFICATION_EMAIL_QUEUE'>,
  signal: AbortSignal,
  overrides: { nowMs?: () => number } = {},
): Promise<number> {
  const nowMs = overrides.nowMs || Date.now;
  signal.throwIfAborted();
  const repository = new D1CommerceRepository(env.COMMERCE_DB);
  const candidates = await repository.queryDueStripeTerminalNotifications(nowMs());
  const commerce: StripeCheckoutCommerceContext = { repository, signal, nowMs };
  const failures: unknown[] = [];
  let queued = 0;
  for (const candidate of candidates) {
    if (signal.aborted) {
      failures.push(signal.reason);
      break;
    }
    if (candidate.key.kind !== 'stripe_checkout' || !candidate.key.dropId) continue;
    try {
      const result = await publishPendingStripeCheckoutTerminalNotifications({
        dropId: candidate.key.dropId,
        sessionId: candidate.key.documentId,
        commerce,
        createCleanupCommerce: () => ({
          repository,
          signal: AbortSignal.timeout(5_000),
          nowMs,
        }),
        queue: env.NOTIFICATION_EMAIL_QUEUE,
        signal,
        nowMs,
        getDropName: (dropId) => {
          const drop = getApiDrop(dropId);
          return drop?.displayName || drop?.collectionName || dropId;
        },
      });
      queued += result.queuedJobs;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Stripe terminal notification reconciliation failed');
  return queued;
}
