import type { NotificationEmailJobV1 } from '../../../../../shared/notificationEmailJob.js';
import { D1CommerceRepository } from '../commerceRepository.js';
import { getApiDrop } from '../dropConfig.js';
import { drainNotificationCandidates } from '../notificationReconciliation.js';
import type { StripeCheckoutCommerceContext } from './commerce.js';
import { publishPendingStripeCheckoutTerminalNotifications } from './notificationOutbox.js';

export async function reconcilePendingStripeTerminalNotifications(
  env: Pick<Env, 'COMMERCE_DB'> & { NOTIFICATION_EMAIL_QUEUE: Pick<Queue<NotificationEmailJobV1>, 'sendBatch'> },
  signal: AbortSignal,
  overrides: { nowMs?: () => number } = {},
): Promise<number> {
  const nowMs = overrides.nowMs || Date.now;
  const repository = new D1CommerceRepository(env.COMMERCE_DB);
  const commerce: StripeCheckoutCommerceContext = { repository, signal, nowMs };
  return drainNotificationCandidates({
    signal,
    loadCandidates: () => repository.queryDueStripeTerminalNotifications(nowMs()),
    failureMessage: 'Stripe terminal notification reconciliation failed',
    processCandidate: async (candidate) => {
      if (candidate.key.kind !== 'stripe_checkout' || !candidate.key.dropId) return 0;
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
      return result.queuedJobs;
    },
  });
}
