import type { NotificationEmailJobV1 } from '../../../../../shared/notificationEmailJob.js';
import { commerceFieldValue, commerceKeys } from '../commerceRepository.js';
import {
  claimNotificationOutbox,
  updateClaimedNotificationOutbox,
  type NotificationOutboxAdapter,
  type NotificationOutboxClaim,
  type NotificationOutboxTarget,
} from '../notificationOutboxStore.js';
import { stripeCheckoutWriteData, type StripeCheckoutCommerceContext } from './commerce.js';
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

export type StripeTerminalNotificationStoreOptions = {
  dropId: string;
  sessionId: string;
  commerce: StripeCheckoutCommerceContext;
  signal: AbortSignal;
  initializeMissing?: boolean;
  nowMs?: () => number;
};

type StripeTerminalNotificationUpdate = {
  stripeTerminalNotification?: StripeTerminalNotificationOutbox;
  stripeTerminalNotificationState?: 'pending' | 'queued' | 'failed';
  stripeTerminalNotificationNextAttemptAtMs?: number | ReturnType<typeof commerceFieldValue.delete>;
  stripeTerminalNotificationQueuedAt?: ReturnType<typeof commerceFieldValue.serverTimestamp>;
  stripeTerminalNotificationLastError?: string | ReturnType<typeof commerceFieldValue.delete>;
};

export type StripeCheckoutTerminalPublicationResult = {
  outcome: StripeTerminalNotificationOutcome | 'not_terminal' | 'invalid';
  publication: 'queued' | 'busy' | 'failed' | 'none';
  queuedJobs: number;
  reason?: string;
};

type NotificationState = {
  checkout: Record<string, unknown>;
  outbox: StripeTerminalNotificationOutbox;
};

export type NotificationClaim = NotificationOutboxClaim<NotificationState>;

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

function notificationOutboxTarget(args: StripeTerminalNotificationStoreOptions): NotificationOutboxTarget {
  return {
    context: args.commerce,
    key: commerceKeys.stripeCheckout(args.dropId, args.sessionId),
    retry: { shouldRetry: (error) => error.code === 'aborted' },
  };
}

export async function claimStripeTerminalNotifications(args: StripeTerminalNotificationStoreOptions): Promise<ClaimResult> {
  const target = notificationOutboxTarget(args);
  const fail = (outcome: StripeTerminalNotificationOutcome, reason: string): {
    result: StripeCheckoutTerminalPublicationResult;
    values: StripeTerminalNotificationUpdate;
  } => ({
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
        } satisfies StripeTerminalNotificationUpdate),
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
  args: StripeTerminalNotificationStoreOptions,
  claim: NotificationClaim,
  update: (outbox: StripeTerminalNotificationOutbox) => StripeTerminalNotificationUpdate,
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

export function persistStripeTerminalNotificationJobs(
  args: StripeTerminalNotificationStoreOptions,
  claim: NotificationClaim,
  jobs: NotificationEmailJobV1[],
): Promise<boolean> {
  return updateClaim(args, claim, (outbox) => ({
    [STRIPE_TERMINAL_NOTIFICATION_FIELD]: { ...outbox, jobs },
  }));
}

export function markStripeTerminalNotificationsQueued(
  args: StripeTerminalNotificationStoreOptions,
  claim: NotificationClaim,
): Promise<boolean> {
  return updateClaim(args, claim, (outbox) => {
    const { claimId: _claimId, jobs: _jobs, ...complete } = outbox;
    return {
      [STRIPE_TERMINAL_NOTIFICATION_FIELD]: complete,
      [STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD]: 'queued',
      [STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD]: commerceFieldValue.delete(),
      stripeTerminalNotificationQueuedAt: commerceFieldValue.serverTimestamp(),
      stripeTerminalNotificationLastError: commerceFieldValue.delete(),
    };
  });
}

export function releaseStripeTerminalNotificationClaim(
  args: StripeTerminalNotificationStoreOptions,
  claim: NotificationClaim,
): Promise<boolean> {
  return updateClaim(args, claim, (outbox) => {
    const { claimId: _claimId, ...released } = outbox;
    return {
      [STRIPE_TERMINAL_NOTIFICATION_FIELD]: { ...released, attemptCount: outbox.attemptCount - 1 },
      [STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD]: (args.nowMs || Date.now)(),
    };
  });
}
