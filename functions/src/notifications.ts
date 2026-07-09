import { z } from 'zod';

export type DeliveryReadyToShipStatusSnapshot = {
  status?: unknown;
  source?: unknown;
} | null | undefined;

export type ResendNotificationEmailKind =
  | 'buyer_order_received'
  | 'shipper_ready_to_ship'
  | 'stripe_checkout_manual_review';

export const RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_ENABLED = true;
export const RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_DISABLED_REASON =
  'resend_non_checkout_error_notifications_disabled';

const NOTIFICATION_EMAIL_RECIPIENT_SCHEMA = z.string().email().max(254);

export type ReadyToShipOrderNotificationPlan = {
  buyerRecipient: string | null;
  shipperRecipients: string[];
  shouldBuildOrderEmailItems: boolean;
};

export function validateNotificationEmailRecipient(rawEmail: unknown): string | null {
  if (typeof rawEmail !== 'string') return null;
  const email = rawEmail.trim();
  if (!email || !NOTIFICATION_EMAIL_RECIPIENT_SCHEMA.safeParse(email).success) return null;
  return email;
}

export function normalizeNotificationEmailRecipient(rawEmail: unknown): string | null {
  return validateNotificationEmailRecipient(rawEmail)?.toLowerCase() || null;
}

export function planReadyToShipOrderNotifications(args: {
  buyerEmail: unknown;
  shipperRecipients: readonly unknown[];
}): ReadyToShipOrderNotificationPlan {
  const buyerRecipient = validateNotificationEmailRecipient(args.buyerEmail);
  const shipperRecipients = Array.from(
    new Set(
      args.shipperRecipients
        .map((rawRecipient) => normalizeNotificationEmailRecipient(rawRecipient))
        .filter((recipient): recipient is string => Boolean(recipient)),
    ),
  );
  return {
    buyerRecipient,
    shipperRecipients,
    shouldBuildOrderEmailItems: shipperRecipients.length > 0 || Boolean(buyerRecipient),
  };
}

export function firstRejectedReadyToShipNotificationError<T>(
  results: PromiseSettledResult<T>[],
  isRetryableError: (reason: unknown) => boolean,
): unknown | undefined {
  const retryable = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected' && isRetryableError(result.reason),
  );
  if (retryable) return retryable.reason;

  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  return rejected?.reason;
}

export function shouldSendResendNotificationEmail(kind: ResendNotificationEmailKind): boolean {
  if (kind === 'stripe_checkout_manual_review') return true;
  return RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_ENABLED;
}

export function shouldNotifyShippersForDeliveryReadyToShipWrite(args: {
  before?: DeliveryReadyToShipStatusSnapshot;
  after?: DeliveryReadyToShipStatusSnapshot;
  ignoredSources?: readonly string[];
}): boolean {
  const source = typeof args.after?.source === 'string' ? args.after.source : '';
  if (source && args.ignoredSources?.includes(source)) return false;
  return args.after?.status === 'ready_to_ship' && args.before?.status !== 'ready_to_ship';
}
