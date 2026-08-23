import { normalizeFulfillmentStatus } from '../../../../shared/fulfillmentStatus.js';
import { resolveFulfillmentTrackingHref } from '../../../../shared/fulfillmentTracking.js';
import {
  normalizeNotificationEmailRecipient,
  validateNotificationEmailRecipient,
} from '../../../../shared/notificationSubscription.js';
import type { NotificationEmailKind } from '../../../../shared/notificationEmailJob.js';

export {
  normalizeNotificationEmailRecipient,
  validateNotificationEmailRecipient,
} from '../../../../shared/notificationSubscription.js';

export type DeliveryReadyToShipStatusSnapshot = {
  status?: unknown;
  source?: unknown;
} | null | undefined;

export type ResendNotificationEmailKind = NotificationEmailKind;

export const RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_ENABLED = true;

export type ReadyToShipOrderNotificationPlan = {
  buyerRecipient: string | null;
  shipperRecipients: string[];
  shouldBuildOrderEmailItems: boolean;
};

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
    Boolean(resolveFulfillmentTrackingHref(args.after?.fulfillmentTrackingCode));
  if (!afterIsShippedWithTracking) return false;

  const beforeWasShippedWithTracking =
    normalizeFulfillmentStatus(args.before?.fulfillmentStatus) === 'Shipped' &&
    Boolean(resolveFulfillmentTrackingHref(args.before?.fulfillmentTrackingCode));
  return !beforeWasShippedWithTracking;
}
