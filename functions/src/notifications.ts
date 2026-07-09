import { z } from 'zod';
import { normalizeFulfillmentStatus } from './fulfillmentStatus.js';
import { resolveFulfillmentTrackingHref } from './fulfillmentTracking.js';

export type DeliveryReadyToShipStatusSnapshot = {
  status?: unknown;
  source?: unknown;
} | null | undefined;

export type ResendNotificationEmailKind =
  | 'buyer_order_received'
  | 'buyer_order_shipped'
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

function parseCanonicalPositiveSafeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;

  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function resolveNotificationDeliveryId(args: {
  deliveryDocId: unknown;
  storedDeliveryId?: unknown;
}): number | null {
  const deliveryId = parseCanonicalPositiveSafeInteger(args.deliveryDocId);
  if (!deliveryId) return null;
  if (args.storedDeliveryId == null) return deliveryId;

  const storedDeliveryId = parseCanonicalPositiveSafeInteger(args.storedDeliveryId);
  return storedDeliveryId === deliveryId ? deliveryId : null;
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

export function shouldNotifyBuyerForDeliveryShippedWrite(args: {
  before?: {
    fulfillmentStatus?: unknown;
    fulfillmentTrackingCode?: unknown;
  } | null;
  after?: {
    fulfillmentStatus?: unknown;
    fulfillmentTrackingCode?: unknown;
    source?: unknown;
  } | null;
  ignoredSources?: readonly string[];
}): boolean {
  const source = typeof args.after?.source === 'string' ? args.after.source : '';
  if (source && args.ignoredSources?.includes(source)) return false;

  const afterIsShippedWithTracking =
    normalizeFulfillmentStatus(args.after?.fulfillmentStatus) === 'Shipped' &&
    Boolean(resolveFulfillmentTrackingHref(args.after.fulfillmentTrackingCode));
  if (!afterIsShippedWithTracking) return false;

  const beforeWasShippedWithTracking =
    normalizeFulfillmentStatus(args.before?.fulfillmentStatus) === 'Shipped' &&
    Boolean(resolveFulfillmentTrackingHref(args.before.fulfillmentTrackingCode));
  return !beforeWasShippedWithTracking;
}
