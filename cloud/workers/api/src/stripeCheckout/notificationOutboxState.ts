import {
  READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS,
  READY_TO_SHIP_NOTIFICATION_MAX_PUBLISH_ATTEMPTS,
  READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS,
} from '../readyToShipNotifications.js';
import { isRecord } from '../dataAccess.js';
import {
  isNotificationEmailJobId,
  isNotificationEmailJobV1,
  type NotificationEmailJobV1,
} from '../../../../../shared/notificationEmailJob.js';
import { STRIPE_CHECKOUT_STATUS } from './contract.js';

export const STRIPE_TERMINAL_NOTIFICATION_FIELD = 'stripeTerminalNotification';
export const STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD = 'stripeTerminalNotificationState';
export const STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD = 'stripeTerminalNotificationNextAttemptAtMs';
export const STRIPE_TERMINAL_NOTIFICATION_LEASE_MS = READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS;
export const STRIPE_TERMINAL_NOTIFICATION_MAX_ATTEMPTS = READY_TO_SHIP_NOTIFICATION_MAX_PUBLISH_ATTEMPTS;
export const STRIPE_TERMINAL_NOTIFICATION_RETRY_WINDOW_MS = READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS;

export type StripeTerminalNotificationOutcome = 'fulfilled' | 'manual_review';
type StripeTerminalNotificationKind = 'buyer_order_received' | 'shipper_ready_to_ship' | 'stripe_checkout_manual_review';

export type StripeTerminalNotificationOutbox = {
  version: 1;
  outcome: StripeTerminalNotificationOutcome;
  jobIds: Partial<Record<StripeTerminalNotificationKind, string>>;
  attemptCount: number;
  retryUntilMs: number;
  claimId?: string;
  jobs?: NotificationEmailJobV1[];
};

export function stripeTerminalNotificationOutcome(
  checkout: Record<string, unknown> | null,
): StripeTerminalNotificationOutcome | null {
  if (checkout?.status === STRIPE_CHECKOUT_STATUS.FULFILLED) return 'fulfilled';
  if (
    checkout?.status === STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED &&
    checkout.manualRefundReviewRequired === true
  ) return 'manual_review';
  return null;
}

export function createStripeTerminalNotificationOutboxFields(
  before: Record<string, unknown> | null,
  outcome: StripeTerminalNotificationOutcome,
  nowMs = Date.now(),
): Record<string, unknown> {
  if (stripeTerminalNotificationOutcome(before) === outcome) return {};
  const existing = before?.[STRIPE_TERMINAL_NOTIFICATION_FIELD];
  if (isRecord(existing) && existing.outcome === outcome) return {};
  const kinds: StripeTerminalNotificationKind[] = outcome === 'fulfilled'
    ? ['buyer_order_received', 'shipper_ready_to_ship']
    : ['stripe_checkout_manual_review'];
  const outbox: StripeTerminalNotificationOutbox = {
    version: 1,
    outcome,
    jobIds: Object.fromEntries(kinds.map((kind) => [kind, crypto.randomUUID()])),
    attemptCount: 0,
    retryUntilMs: nowMs + STRIPE_TERMINAL_NOTIFICATION_RETRY_WINDOW_MS,
  };
  return {
    [STRIPE_TERMINAL_NOTIFICATION_FIELD]: outbox,
    [STRIPE_TERMINAL_NOTIFICATION_STATE_FIELD]: 'pending',
    [STRIPE_TERMINAL_NOTIFICATION_NEXT_ATTEMPT_FIELD]: nowMs,
  };
}

export function parseStripeTerminalNotificationOutbox(value: unknown): StripeTerminalNotificationOutbox | null {
  if (
    !isRecord(value) || value.version !== 1 ||
    (value.outcome !== 'fulfilled' && value.outcome !== 'manual_review') ||
    !isRecord(value.jobIds) ||
    !Number.isSafeInteger(value.attemptCount) || Number(value.attemptCount) < 0 ||
    !Number.isSafeInteger(value.retryUntilMs) || Number(value.retryUntilMs) < 0 ||
    (value.claimId !== undefined && !isNotificationEmailJobId(value.claimId))
  ) return null;
  const kinds: StripeTerminalNotificationKind[] = value.outcome === 'fulfilled'
    ? ['buyer_order_received', 'shipper_ready_to_ship']
    : ['stripe_checkout_manual_review'];
  const jobIds = value.jobIds;
  if (kinds.some((kind) => !isNotificationEmailJobId(jobIds[kind]))) return null;
  if (value.jobs !== undefined) {
    if (!Array.isArray(value.jobs) || value.jobs.length > kinds.length) return null;
    const seen = new Set<string>();
    for (const job of value.jobs) {
      if (
        !isNotificationEmailJobV1(job) || !kinds.includes(job.kind as StripeTerminalNotificationKind) ||
        job.jobId !== jobIds[job.kind] || seen.has(job.kind)
      ) return null;
      seen.add(job.kind);
    }
  }
  return value as StripeTerminalNotificationOutbox;
}
