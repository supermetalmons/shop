import type { NotificationEmailJobV1 } from '../../../../../shared/notificationEmailJob.js';
import { commerceFieldValue, commerceKeys } from '../commerceRepository.js';
import { runCommerceTransaction } from '../commerceTransactions.js';
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
  STRIPE_TERMINAL_NOTIFICATION_LEASE_MS,
  STRIPE_TERMINAL_NOTIFICATION_MAX_ATTEMPTS,
  STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD,
  STRIPE_TERMINAL_NOTIFICATION_RETRY_WINDOW_MS,
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

type NotificationClaim = {
  checkout: Record<string, unknown>;
  outbox: StripeTerminalNotificationOutbox;
  expiresAtMs: number;
};

type ClaimResult =
  | { claim: NotificationClaim }
  | { result: StripeCheckoutTerminalPublicationResult };

function skipped(
  outcome: StripeCheckoutTerminalPublicationResult['outcome'],
  publication: StripeCheckoutTerminalPublicationResult['publication'],
  reason?: string,
): ClaimResult {
  return { result: { outcome, publication, queuedJobs: 0, ...(reason ? { reason } : {}) } };
}

async function claimNotifications(args: PublicationOptions): Promise<ClaimResult> {
  const key = commerceKeys.stripeCheckout(args.dropId, args.sessionId);
  return runCommerceTransaction(args.commerce, async (transaction) => {
    args.signal.throwIfAborted();
    const checkout = (await transaction.get(key))?.data;
    if (!checkout) return skipped('invalid', 'none', 'missing_checkout');
    const outcome = stripeTerminalNotificationOutcome(checkout);
    if (!outcome) return skipped('not_terminal', 'none');
    const nowMs = (args.nowMs || Date.now)();
    const hasMarker = Object.hasOwn(checkout, STRIPE_TERMINAL_NOTIFICATION_FIELD) ||
      Object.hasOwn(checkout, STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD);
    if (!hasMarker) {
      if (!args.initializeMissing) return skipped(outcome, 'none', 'missing_outbox');
      Object.assign(checkout, createStripeTerminalNotificationOutboxFields(null, outcome, nowMs));
    }
    const state = checkout[STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD];
    const outbox = parseStripeTerminalNotificationOutbox(checkout[STRIPE_TERMINAL_NOTIFICATION_FIELD]);
    const dueAtMs = checkout[STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD];
    const fail = async (reason: string): Promise<ClaimResult> => {
      await transaction.update(key, {
        [STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD]: 'failed',
        [STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD]: commerceFieldValue.delete(),
        stripeTerminalNotificationLastError: reason,
      });
      return skipped(outcome, 'failed', reason);
    };
    if (!outbox || outbox.outcome !== outcome) return fail('invalid-notification-state');
    if (state === 'queued' || state === 'failed') return skipped(outcome, state);
    if (state !== 'pending' || !Number.isSafeInteger(dueAtMs) || Number(dueAtMs) < 0) {
      return fail('invalid-notification-state');
    }
    if (Number(dueAtMs) > nowMs) return skipped(outcome, 'busy');
    if (
      outbox.attemptCount >= STRIPE_TERMINAL_NOTIFICATION_MAX_ATTEMPTS ||
      (outbox.attemptCount > 0 && outbox.retryUntilMs <= nowMs)
    ) return fail('manual-review-required');
    const claimed: StripeTerminalNotificationOutbox = {
      ...outbox,
      attemptCount: outbox.attemptCount + 1,
      claimId: crypto.randomUUID(),
      retryUntilMs: outbox.attemptCount === 0
        ? nowMs + STRIPE_TERMINAL_NOTIFICATION_RETRY_WINDOW_MS
        : outbox.retryUntilMs,
    };
    await transaction.update(key, stripeCheckoutWriteData({
      [STRIPE_TERMINAL_NOTIFICATION_FIELD]: claimed,
      [STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD]: 'pending',
      [STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD]: nowMs + STRIPE_TERMINAL_NOTIFICATION_LEASE_MS,
    }));
    return { claim: { checkout, outbox: claimed, expiresAtMs: nowMs + STRIPE_TERMINAL_NOTIFICATION_LEASE_MS } };
  }, { shouldRetry: (error) => error.code === 'aborted' });
}

async function updateClaim(
  args: PublicationOptions,
  claim: NotificationClaim,
  update: (outbox: StripeTerminalNotificationOutbox) => Record<string, unknown>,
): Promise<boolean> {
  const key = commerceKeys.stripeCheckout(args.dropId, args.sessionId);
  return runCommerceTransaction(args.commerce, async (transaction) => {
    const checkout = (await transaction.get(key))?.data;
    const outbox = parseStripeTerminalNotificationOutbox(checkout?.[STRIPE_TERMINAL_NOTIFICATION_FIELD]);
    if (
      !checkout || !outbox || checkout[STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD] !== 'pending' ||
      outbox.claimId !== claim.outbox.claimId ||
      stripeTerminalNotificationOutcome(checkout) !== claim.outbox.outcome
    ) return false;
    await transaction.update(key, stripeCheckoutWriteData(update(outbox)));
    return true;
  }, { shouldRetry: (error) => error.code === 'aborted' });
}

function validJobIdentity(args: PublicationOptions, claim: NotificationClaim, job: NotificationEmailJobV1): boolean {
  if (job.context.dropId !== args.dropId || job.jobId !== claim.outbox.jobIds[job.kind as keyof typeof claim.outbox.jobIds]) {
    return false;
  }
  if (claim.outbox.outcome === 'manual_review') {
    return job.kind === 'stripe_checkout_manual_review' && job.context.sessionId === args.sessionId &&
      job.idempotencyKey === `${args.dropId}:${args.sessionId}:stripe_manual_review`;
  }
  const deliveryId = Number(claim.checkout.deliveryId);
  const suffix = job.kind === 'buyer_order_received' ? 'order_received'
    : job.kind === 'shipper_ready_to_ship' ? 'ready_to_ship' : null;
  return suffix !== null && Number.isSafeInteger(deliveryId) && deliveryId > 0 &&
    job.context.deliveryId === deliveryId && job.idempotencyKey === `${args.dropId}:${deliveryId}:${suffix}`;
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
  let sendStarted = false;
  try {
    args.signal.throwIfAborted();
    let jobs = claim.outbox.jobs;
    if (!jobs) {
      const prepared = await prepareStripeCheckoutTerminalNotifications({
        dropId: args.dropId,
        sessionId: args.sessionId,
        jobIds: claim.outbox.jobIds,
        dependencies: {
          loadCheckout: async () => ({
            path: `drops/${args.dropId}/stripeCheckouts/${args.sessionId}`,
            data: claim.checkout,
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
      if (prepared.outcome !== claim.outbox.outcome) {
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
    args.signal.throwIfAborted();
    const nowMs = (args.nowMs || Date.now)();
    if (nowMs >= claim.expiresAtMs || nowMs >= claim.outbox.retryUntilMs) {
      throw new Error('stripe_terminal_notification_claim_expired');
    }
    if (jobs.length) {
      sendStarted = true;
      await args.queue.sendBatch(jobs.map((body) => ({ body, contentType: 'json' })));
    }
    const finalized = await updateClaim(args, claim, (outbox) => {
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
    return { outcome: claim.outbox.outcome, publication: 'queued', queuedJobs: jobs.length };
  } catch (error) {
    if (args.signal.aborted && !sendStarted) {
      const cleanup = args.createCleanupCommerce ? { ...args, commerce: args.createCleanupCommerce() } : args;
      await updateClaim(cleanup, claim, (outbox) => {
        const { claimId: _claimId, ...released } = outbox;
        return {
          [STRIPE_TERMINAL_NOTIFICATION_FIELD]: { ...released, attemptCount: outbox.attemptCount - 1 },
          [STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD]: (args.nowMs || Date.now)(),
        };
      }).catch(() => undefined);
    }
    console.error({ event: 'stripe_terminal_notifications_publish_failed', dropId: args.dropId,
      sessionId: args.sessionId, error: error instanceof Error ? { name: error.name } : { name: 'UnknownError' } });
    throw error;
  }
}
