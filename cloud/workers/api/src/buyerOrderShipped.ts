import { buildBuyerVisibleOrderEmailItems } from './orderEmailItems.js';
import { buildBuyerOrderShippedEmailContent } from './notificationEmails.js';
import {
  resolveNotificationDeliveryId,
  shouldNotifyBuyerForDeliveryShippedWrite,
} from './notifications.js';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.js';
import { resolveFulfillmentTrackingHref } from '../../../../shared/fulfillmentTracking.js';
import {
  createNotificationEmailJobV1,
  isNotificationEmailIdempotencyKey,
  isNotificationEmailJobId,
  type NotificationEmailJobV1,
} from '../../../../shared/notificationEmailJob.js';
import { validateNotificationEmailRecipient } from '../../../../shared/notificationSubscription.js';
import { DEPLOYMENT_DROPS } from '../../../../shared/deploymentRegistry.js';

export const BUYER_ORDER_SHIPPED_EMAIL_PENDING = 'pending' as const;
export const BUYER_ORDER_SHIPPED_EMAIL_QUEUED = 'queued' as const;

export type BuyerOrderShippedDecision =
  | {
      kind: 'send';
      deliveryId: number;
      idempotencyKey: string;
      jobId: string;
    }
  | {
      kind: 'skip';
      clearPending: boolean;
      reason:
        | 'already-queued'
        | 'ignored-source'
        | 'invalid-delivery-id'
        | 'missing-or-invalid-recipient'
        | 'not-first-shipped-with-tracking'
        | 'pending-no-longer-shipped'
        | 'retry-not-shipped';
    };

type DeliveryOrder = Record<string, unknown>;

function isIgnoredSource(order: DeliveryOrder): boolean {
  return order.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE;
}

function shippedWithTracking(order: DeliveryOrder): boolean {
  return shouldNotifyBuyerForDeliveryShippedWrite({
    before: null,
    after: order,
    ignoredSources: [ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE],
  });
}

export function decideBuyerOrderShippedNotification(args: {
  before: DeliveryOrder;
  after: DeliveryOrder;
  deliveryDocId: number;
  dropId: string;
  emailState?: unknown;
  forceRetry?: boolean;
  idempotencyKey?: unknown;
  jobId?: unknown;
  createJobId?: () => string;
}): BuyerOrderShippedDecision {
  const pending = args.emailState === BUYER_ORDER_SHIPPED_EMAIL_PENDING;
  if (args.emailState === BUYER_ORDER_SHIPPED_EMAIL_QUEUED && !args.forceRetry) {
    return { kind: 'skip', clearPending: false, reason: 'already-queued' };
  }
  if (isIgnoredSource(args.after)) {
    return { kind: 'skip', clearPending: pending, reason: 'ignored-source' };
  }

  const firstShippedWithTracking = shouldNotifyBuyerForDeliveryShippedWrite({
    before: args.before,
    after: args.after,
    ignoredSources: [ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE],
  });
  if (args.forceRetry && !shippedWithTracking(args.after)) {
    return { kind: 'skip', clearPending: pending, reason: 'retry-not-shipped' };
  }
  if (!args.forceRetry && !firstShippedWithTracking && !(pending && shippedWithTracking(args.after))) {
    return {
      kind: 'skip',
      clearPending: pending,
      reason: pending ? 'pending-no-longer-shipped' : 'not-first-shipped-with-tracking',
    };
  }

  const deliveryId = resolveNotificationDeliveryId({
    deliveryDocId: String(args.deliveryDocId),
    storedDeliveryId: args.after.deliveryId,
  });
  if (!deliveryId) return { kind: 'skip', clearPending: pending, reason: 'invalid-delivery-id' };
  if (!validateNotificationEmailRecipient(args.after.addressSnapshot &&
    typeof args.after.addressSnapshot === 'object' &&
    !Array.isArray(args.after.addressSnapshot)
    ? (args.after.addressSnapshot as Record<string, unknown>).email
    : undefined)) {
    return { kind: 'skip', clearPending: pending, reason: 'missing-or-invalid-recipient' };
  }

  const createJobId = args.createJobId || (() => crypto.randomUUID());
  const jobId = !args.forceRetry && isNotificationEmailJobId(args.jobId)
    ? args.jobId
    : createJobId();
  if (!isNotificationEmailJobId(jobId)) throw new Error('Invalid buyer order shipped notification job ID');
  const defaultIdempotencyKey = `${args.dropId}:${deliveryId}:order_shipped`;
  const idempotencyKey = args.forceRetry
    ? `${defaultIdempotencyKey}:retry:${jobId}`
    : pending && isNotificationEmailIdempotencyKey(args.idempotencyKey)
      ? args.idempotencyKey
      : defaultIdempotencyKey;
  if (!isNotificationEmailIdempotencyKey(idempotencyKey)) {
    throw new Error('Invalid buyer order shipped notification idempotency key');
  }
  return { kind: 'send', deliveryId, idempotencyKey, jobId };
}

export async function createBuyerOrderShippedNotificationJob(args: {
  deliveryId: number;
  dropId: string;
  idempotencyKey: string;
  jobId: string;
  order: DeliveryOrder;
}): Promise<NotificationEmailJobV1> {
  const trackingUrl = resolveFulfillmentTrackingHref(args.order.fulfillmentTrackingCode);
  if (!trackingUrl) throw new Error('Buyer order shipped notification requires a valid tracking URL');
  const address = args.order.addressSnapshot;
  const recipient = validateNotificationEmailRecipient(
    address && typeof address === 'object' && !Array.isArray(address)
      ? (address as Record<string, unknown>).email
      : undefined,
  );
  if (!recipient) throw new Error('Buyer order shipped notification requires a valid recipient');
  const drop = DEPLOYMENT_DROPS[args.dropId];
  if (!drop) throw new Error('Buyer order shipped notification requires a supported drop');
  const message = {
    idempotencyKey: args.idempotencyKey,
    recipients: [recipient],
    dropId: args.dropId,
    dropName: drop.displayName || drop.collectionName || args.dropId,
    deliveryId: args.deliveryId,
    items: await buildBuyerVisibleOrderEmailItems(args.order, { dropId: args.dropId }),
    trackingUrl,
  };
  const email = buildBuyerOrderShippedEmailContent(message);
  return createNotificationEmailJobV1({
    jobId: args.jobId,
    kind: 'buyer_order_shipped',
    idempotencyKey: message.idempotencyKey,
    recipients: message.recipients,
    subject: email.subject,
    text: email.text,
    html: email.html,
    context: { dropId: args.dropId, deliveryId: args.deliveryId },
  });
}
