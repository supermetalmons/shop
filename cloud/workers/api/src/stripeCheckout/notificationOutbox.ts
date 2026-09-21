import type { NotificationEmailJobV1 } from '../../../../../shared/notificationEmailJob.js';
import { commerceKeys } from '../commerceRepository.js';
import { publishClaimedNotificationBatch } from '../notificationOutboxPublication.js';
import type { StripeCheckoutCommerceContext } from './commerce.js';
import { prepareStripeCheckoutTerminalNotifications } from './terminalNotifications.js';
import {
  claimStripeTerminalNotifications,
  markStripeTerminalNotificationsQueued,
  persistStripeTerminalNotificationJobs,
  releaseStripeTerminalNotificationClaim,
  type NotificationClaim,
  type StripeCheckoutTerminalPublicationResult,
  type StripeTerminalNotificationStoreOptions,
} from './notificationStore.js';
export type { StripeCheckoutTerminalPublicationResult } from './notificationStore.js';

type PublicationOptions = StripeTerminalNotificationStoreOptions & {
  createCleanupCommerce?: () => StripeCheckoutCommerceContext;
  queue: Pick<Queue<NotificationEmailJobV1>, 'sendBatch'>;
  getDropName: (dropId: string) => string;
};

function validJobIdentity(args: PublicationOptions, claim: NotificationClaim, job: NotificationEmailJobV1): boolean {
  const { checkout, outbox } = claim.state;
  if (job.context.dropId !== args.dropId || job.jobId !== outbox.jobIds[job.kind as keyof typeof outbox.jobIds]) {
    return false;
  }
  if (outbox.outcome === 'manual_review') {
    return job.kind === 'stripe_checkout_manual_review' && job.context.sessionId === args.sessionId &&
      job.idempotencyKey === `${args.dropId}:${args.sessionId}:stripe_manual_review`;
  }
  const deliveryId = Number(checkout.deliveryId);
  const suffix = job.kind === 'buyer_order_received' ? 'order_received'
    : job.kind === 'shipper_ready_to_ship' ? 'ready_to_ship' : null;
  return suffix !== null && Number.isSafeInteger(deliveryId) && deliveryId > 0 &&
    job.context.deliveryId === deliveryId && job.idempotencyKey === `${args.dropId}:${deliveryId}:${suffix}`;
}

async function prepareNotificationJobs(
  args: PublicationOptions,
  claim: NotificationClaim,
): Promise<NotificationEmailJobV1[]> {
  const { checkout, outbox } = claim.state;
  let jobs = outbox.jobs;
  if (!jobs) {
    const prepared = await prepareStripeCheckoutTerminalNotifications({
      dropId: args.dropId,
      sessionId: args.sessionId,
      jobIds: outbox.jobIds,
      dependencies: {
        loadCheckout: async () => ({
          path: `drops/${args.dropId}/stripeCheckouts/${args.sessionId}`,
          data: checkout,
        }),
        loadDeliveryOrder: async (dropId, deliveryId) => {
          args.commerce.signal?.throwIfAborted();
          const order = await args.commerce.repository.get(commerceKeys.deliveryOrder(dropId, String(deliveryId)));
          args.commerce.signal?.throwIfAborted();
          return order?.data || null;
        },
        getDropName: args.getDropName,
      },
    });
    if (prepared.outcome !== outbox.outcome) {
      throw new Error(`stripe_terminal_notification_${prepared.reason || 'invalid-outcome'}`);
    }
    jobs = prepared.jobs;
    if (!await persistStripeTerminalNotificationJobs(args, claim, jobs)) throw new Error('stripe_terminal_notification_claim_lost');
  }
  if (jobs.some((job) => !validJobIdentity(args, claim, job))) {
    throw new Error('stripe_terminal_notification_job_identity_invalid');
  }
  return jobs;
}

function cleanupPublication(args: PublicationOptions): PublicationOptions {
  return {
    ...args,
    commerce: args.createCleanupCommerce?.() || {
      ...args.commerce,
      signal: AbortSignal.timeout(5_000),
    },
  };
}

export async function publishPendingStripeCheckoutTerminalNotifications(
  args: PublicationOptions,
): Promise<StripeCheckoutTerminalPublicationResult> {
  const claimed = await claimStripeTerminalNotifications(args);
  if ('result' in claimed) {
    if (claimed.result.publication === 'failed') {
      console.error({ event: 'stripe_terminal_notifications_failed', dropId: args.dropId, sessionId: args.sessionId,
        reason: claimed.result.reason || 'manual-review-required' });
    }
    return claimed.result;
  }
  const { claim } = claimed;
  try {
    return await publishClaimedNotificationBatch<StripeCheckoutTerminalPublicationResult>({
      signal: args.signal,
      nowMs: args.nowMs || Date.now,
      expiresAtMs: claim.expiresAtMs,
      retryUntilMs: claim.retryUntilMs,
      queue: args.queue,
      prepareAndPersist: () => prepareNotificationJobs(args, claim),
      createExpiredClaimError: () => new Error('stripe_terminal_notification_claim_expired'),
      finalize: async (jobs) => {
        const finalized = await markStripeTerminalNotificationsQueued(cleanupPublication(args), claim);
        if (!finalized) throw new Error('stripe_terminal_notification_finalization_lost');
        console.log({ event: 'stripe_terminal_notifications_queued', dropId: args.dropId,
          sessionId: args.sessionId, jobs: jobs.map((job) => ({ jobId: job.jobId, kind: job.kind })) });
        return { outcome: claim.state.outbox.outcome, publication: 'queued', queuedJobs: jobs.length };
      },
      releaseUnusedClaim: async () => {
        await releaseStripeTerminalNotificationClaim(cleanupPublication(args), claim);
      },
    });
  } catch (error) {
    console.error({ event: 'stripe_terminal_notifications_publish_failed', dropId: args.dropId,
      sessionId: args.sessionId, error: error instanceof Error ? { name: error.name } : { name: 'UnknownError' } });
    throw error;
  }
}
