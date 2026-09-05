import type { NotificationEmailJobV1 } from '../../../../../shared/notificationEmailJob.js';
import { commerceFieldValue, commerceKeys } from '../commerceRepository.js';
import { publishClaimedNotificationBatch } from '../notificationOutboxPublication.js';
import {
  claimNotificationOutbox,
  updateClaimedNotificationOutbox,
  type NotificationOutboxAdapter,
  type NotificationOutboxClaim,
  type NotificationOutboxTarget,
} from '../notificationOutboxStore.js';
import {
  stripeCheckoutWriteData,
  type StripeCheckoutCommerceContext,
} from './commerce.js';
import { prepareStripeCheckoutTerminalNotifications } from './terminalNotifications.js';
import {
  createStripeTerminalNotificationOutboxFields,
  parseStripeTerminalNotificationOutbox,
  stripeTerminalNotificationOutcome,
  STRIPE_TERMINAL_NOTIFICATION_FIELD,
  STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD,
  STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD,
  type StripeTerminalNotificationOutbox,
  type StripeTerminalNotificationOutcome,
} from './notificationOutboxState.js';

export type StripeCheckoutTerminalPublicationResult = {
  outcome: StripeTerminalNotificationOutcome | 'not_terminal' | 'invalid';
  publication: 'queued' | 'busy' | 'failed' | 'none';
  queuedJobs: number;
  reason?: string;
};

type PublicationOptions = {
  dropId: string;
  sessionId: string;
  commerce: StripeCheckoutCommerceContext;
  createCleanupCommerce?: () => StripeCheckoutCommerceContext;
  queue: Pick<Queue<NotificationEmailJobV1>, 'sendBatch'>;
  signal: AbortSignal;
  getDropName: (dropId: string) => string;
  initializeMissing?: boolean;
  nowMs?: () => number;
};

type NotificationState = {
  checkout: Record<string, unknown>;
  outbox: StripeTerminalNotificationOutbox;
};

type NotificationClaim = NotificationOutboxClaim<NotificationState>;

type ClaimResult =
  | { claim: NotificationClaim }
  | { result: StripeCheckoutTerminalPublicationResult };

function skipped(
  outcome: StripeCheckoutTerminalPublicationResult['outcome'],
  publication: StripeCheckoutTerminalPublicationResult['publication'],
  reason?: string,
): StripeCheckoutTerminalPublicationResult {
  return { outcome, publication, queuedJobs: 0, ...(reason ? { reason } : {}) };
}

function notificationOutboxTarget(args: PublicationOptions): NotificationOutboxTarget {
  return {
    context: args.commerce,
    key: commerceKeys.stripeCheckout(args.dropId, args.sessionId),
    retry: { shouldRetry: (error) => error.code === 'aborted' },
  };
}

async function claimNotifications(args: PublicationOptions): Promise<ClaimResult> {
  const target = notificationOutboxTarget(args);
  const fail = (outcome: StripeTerminalNotificationOutcome, reason: string) => ({
    result: skipped(outcome, 'failed', reason),
    values: {
      [STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD]: 'failed',
      [STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD]: commerceFieldValue.delete(),
      stripeTerminalNotificationLastError: reason,
    },
  });
  const adapter: NotificationOutboxAdapter<NotificationState, StripeCheckoutTerminalPublicationResult> = {
    missing: skipped('invalid', 'none', 'missing_checkout'),
    inspect: (document, nowMs) => {
      const checkout = document.data;
      const outcome = stripeTerminalNotificationOutcome(checkout);
      if (!outcome) return { result: skipped('not_terminal', 'none') };
      const hasMarker = Object.hasOwn(checkout, STRIPE_TERMINAL_NOTIFICATION_FIELD) ||
        Object.hasOwn(checkout, STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD);
      if (!hasMarker) {
        if (!args.initializeMissing) return { result: skipped(outcome, 'none', 'missing_outbox') };
        Object.assign(checkout, createStripeTerminalNotificationOutboxFields(null, outcome, nowMs));
      }
      const state = checkout[STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD];
      const outbox = parseStripeTerminalNotificationOutbox(checkout[STRIPE_TERMINAL_NOTIFICATION_FIELD]);
      const dueAtMs = checkout[STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD];
      if (!outbox || outbox.outcome !== outcome) return fail(outcome, 'invalid-notification-state');
      if (state === 'queued' || state === 'failed') return { result: skipped(outcome, state) };
      if (state !== 'pending' || !Number.isSafeInteger(dueAtMs) || Number(dueAtMs) < 0) {
        return fail(outcome, 'invalid-notification-state');
      }
      return {
        state: { checkout, outbox },
        activeUntilMs: Number(dueAtMs),
        attemptCount: outbox.attemptCount,
        retryUntilMs: outbox.retryUntilMs,
      };
    },
    busy: ({ outbox }) => skipped(outbox.outcome, 'busy'),
    exhausted: ({ outbox }) => fail(outbox.outcome, 'manual-review-required'),
    claim: ({ checkout, outbox }, lease) => {
      const claimed: StripeTerminalNotificationOutbox = {
        ...outbox,
        attemptCount: lease.attemptCount,
        claimId: lease.claimId,
        retryUntilMs: lease.retryUntilMs,
      };
      return {
        state: { checkout, outbox: claimed },
        values: stripeCheckoutWriteData({
          [STRIPE_TERMINAL_NOTIFICATION_FIELD]: claimed,
          [STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD]: 'pending',
          [STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD]: lease.expiresAtMs,
        }),
      };
    },
  };
  const result = await claimNotificationOutbox({
    target: {
      ...target,
      read: (transaction) => {
        args.signal.throwIfAborted();
        return transaction.get(target.key);
      },
    },
    adapter,
    nowMs: args.nowMs || Date.now,
  });
  return result.outcome === 'claimed' ? { claim: result.claim } : { result: result.result };
}

async function updateClaim(
  args: PublicationOptions,
  claim: NotificationClaim,
  update: (outbox: StripeTerminalNotificationOutbox) => Record<string, unknown>,
): Promise<boolean> {
  return updateClaimedNotificationOutbox({
    target: notificationOutboxTarget(args),
    claimId: claim.claimId,
    inspect: (document) => {
      const checkout = document.data;
      const outbox = parseStripeTerminalNotificationOutbox(checkout[STRIPE_TERMINAL_NOTIFICATION_FIELD]);
      if (
        !outbox || checkout[STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD] !== 'pending' ||
        stripeTerminalNotificationOutcome(checkout) !== claim.state.outbox.outcome
      ) return null;
      return { claimId: outbox.claimId, state: outbox };
    },
    lost: () => false,
    update: (outbox) => ({ values: stripeCheckoutWriteData(update(outbox)), result: true }),
  });
}

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
    if (!await updateClaim(args, claim, (outbox) => ({
      [STRIPE_TERMINAL_NOTIFICATION_FIELD]: { ...outbox, jobs },
    }))) throw new Error('stripe_terminal_notification_claim_lost');
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
  const claimed = await claimNotifications(args);
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
        const finalized = await updateClaim(cleanupPublication(args), claim, (outbox) => {
          const { claimId: _claimId, jobs: _jobs, ...complete } = outbox;
          return {
            [STRIPE_TERMINAL_NOTIFICATION_FIELD]: complete,
            [STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD]: 'queued',
            [STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD]: commerceFieldValue.delete(),
            stripeTerminalNotificationQueuedAt: commerceFieldValue.serverTimestamp(),
            stripeTerminalNotificationLastError: commerceFieldValue.delete(),
          };
        });
        if (!finalized) throw new Error('stripe_terminal_notification_finalization_lost');
        console.log({ event: 'stripe_terminal_notifications_queued', dropId: args.dropId,
          sessionId: args.sessionId, jobs: jobs.map((job) => ({ jobId: job.jobId, kind: job.kind })) });
        return { outcome: claim.state.outbox.outcome, publication: 'queued', queuedJobs: jobs.length };
      },
      releaseUnusedClaim: async () => {
        await updateClaim(cleanupPublication(args), claim, (outbox) => {
          const { claimId: _claimId, ...released } = outbox;
          return {
            [STRIPE_TERMINAL_NOTIFICATION_FIELD]: { ...released, attemptCount: outbox.attemptCount - 1 },
            [STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD]: (args.nowMs || Date.now)(),
          };
        });
      },
    });
  } catch (error) {
    console.error({ event: 'stripe_terminal_notifications_publish_failed', dropId: args.dropId,
      sessionId: args.sessionId, error: error instanceof Error ? { name: error.name } : { name: 'UnknownError' } });
    throw error;
  }
}
