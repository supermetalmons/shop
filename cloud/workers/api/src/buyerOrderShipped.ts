import { parseDeliveryOrderNotificationView, type DeliveryOrderNotificationView } from './deliveryOrderNotificationView.js';
import { buildBuyerOrderShippedEmailContent } from './notificationEmails.js';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.js';
import {
  createNotificationEmailJobV1,
  isNotificationEmailIdempotencyKey,
  isNotificationEmailJobId,
  type NotificationEmailJobV1,
} from '../../../../shared/notificationEmailJob.js';
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
        | 'publication-failed'
        | 'cancelled'
        | 'ignored-source'
        | 'invalid-delivery-id'
        | 'missing-or-invalid-recipient'
        | 'not-first-shipped-with-tracking'
        | 'pending-no-longer-shipped'
        | 'retry-not-shipped';
    };

type DeliveryOrder = Record<string, unknown>;

function isIgnoredSource(order: DeliveryOrderNotificationView): boolean {
  return order.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE;
}

function shippedWithTracking(order: DeliveryOrderNotificationView): boolean {
  return !isIgnoredSource(order) && order.shippedWithTracking;
}

export function isBuyerOrderShippedNotificationEligible(order: DeliveryOrder): boolean {
  const notification = parseDeliveryOrderNotificationView(order);
  return shippedWithTracking(notification) && Boolean(notification.buyerRecipient);
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
  const before = parseDeliveryOrderNotificationView(args.before);
  const after = parseDeliveryOrderNotificationView(args.after);
  const pending = args.emailState === BUYER_ORDER_SHIPPED_EMAIL_PENDING;
  if (!args.forceRetry && (args.emailState === 'failed' || args.emailState === 'cancelled')) {
    return { kind: 'skip', clearPending: false, reason: args.emailState === 'failed' ? 'publication-failed' : 'cancelled' };
  }
  if (args.emailState === BUYER_ORDER_SHIPPED_EMAIL_QUEUED && !args.forceRetry) {
    return { kind: 'skip', clearPending: false, reason: 'already-queued' };
  }
  if (isIgnoredSource(after)) {
    return { kind: 'skip', clearPending: pending, reason: 'ignored-source' };
  }

  const firstShippedWithTracking = after.shippedWithTracking && !before.shippedWithTracking;
  if (args.forceRetry && !shippedWithTracking(after)) {
    return { kind: 'skip', clearPending: pending, reason: 'retry-not-shipped' };
  }
  if (!args.forceRetry && !firstShippedWithTracking && !(pending && shippedWithTracking(after))) {
    return {
      kind: 'skip',
      clearPending: pending,
      reason: pending ? 'pending-no-longer-shipped' : 'not-first-shipped-with-tracking',
    };
  }

  const deliveryId = after.resolveDeliveryId(String(args.deliveryDocId));
  if (!deliveryId) return { kind: 'skip', clearPending: pending, reason: 'invalid-delivery-id' };
  if (!after.buyerRecipient) {
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
  const order = parseDeliveryOrderNotificationView(args.order);
  const trackingUrl = order.trackingUrl;
  if (!trackingUrl) throw new Error('Buyer order shipped notification requires a valid tracking URL');
  const recipient = order.buyerRecipient;
  if (!recipient) throw new Error('Buyer order shipped notification requires a valid recipient');
  const drop = DEPLOYMENT_DROPS[args.dropId];
  if (!drop) throw new Error('Buyer order shipped notification requires a supported drop');
  const message = {
    idempotencyKey: args.idempotencyKey,
    recipients: [recipient],
    dropId: args.dropId,
    dropName: drop.displayName || drop.collectionName || args.dropId,
    deliveryId: args.deliveryId,
    items: await order.buyerItems(args.dropId),
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
