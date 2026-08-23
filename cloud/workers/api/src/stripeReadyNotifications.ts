import {
  buildBuyerOrderReceivedEmailContent,
  buildShipperReadyToShipEmailContent,
  fulfillmentAppUrlForOrder,
  summarizeShipperReadyOrderItems,
} from './notificationEmails.js';
import {
  buildBuyerVisibleOrderEmailItems,
  buildShipperVisibleOrderEmailItems,
} from './orderEmailItems.js';
import {
  planReadyToShipOrderNotifications,
  resolveNotificationDeliveryId,
} from './notifications.js';
import {
  CARD_FULFILLMENT_DROP_IDS,
  CARD_NFT_BINDER_FULFILLMENT_DROP_IDS,
} from '../../../../shared/fulfillmentAccess.js';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.js';
import { DEPLOYMENT_DROPS } from '../../../../shared/deploymentRegistry.js';
import {
  createNotificationEmailJobV1,
  type NotificationEmailJobV1,
} from '../../../../shared/notificationEmailJob.js';

const SHIPPER_DROP_IDS = new Set([
  'little_swag_boxes',
  'poncho_drifella',
  'drifella_shirt',
  'little_swag_hoodies',
  ...CARD_FULFILLMENT_DROP_IDS,
  ...CARD_NFT_BINDER_FULFILLMENT_DROP_IDS,
]);
const SHIPPER_RECIPIENTS = ['supermetalxbosch@gmail.com'] as const;

export async function createStripeReadyToShipNotificationJobs(args: {
  order: Record<string, unknown>;
  dropId: string;
  deliveryId: number;
  createJobId?: () => string;
}): Promise<NotificationEmailJobV1[]> {
  if (args.order.source !== STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE || args.order.status !== 'ready_to_ship') {
    return [];
  }
  const deliveryId = resolveNotificationDeliveryId({
    deliveryDocId: args.deliveryId,
    storedDeliveryId: args.order.deliveryId,
  });
  if (!deliveryId) throw new Error('Stripe ready-to-ship notification delivery ID is invalid');
  const drop = DEPLOYMENT_DROPS[args.dropId];
  if (!drop) throw new Error('Stripe ready-to-ship notification drop is unsupported');
  const address = args.order.addressSnapshot;
  const buyerEmail = address && typeof address === 'object' && !Array.isArray(address)
    ? (address as Record<string, unknown>).email
    : undefined;
  const plan = planReadyToShipOrderNotifications({
    buyerEmail,
    shipperRecipients: SHIPPER_DROP_IDS.has(args.dropId) ? SHIPPER_RECIPIENTS : [],
  });
  const createJobId = args.createJobId || (() => crypto.randomUUID());
  const dropName = drop.displayName || drop.collectionName || args.dropId;
  const jobs: NotificationEmailJobV1[] = [];
  if (plan.buyerRecipient) {
    const message = {
      idempotencyKey: `${args.dropId}:${deliveryId}:order_received`,
      recipients: [plan.buyerRecipient],
      dropId: args.dropId,
      dropName,
      deliveryId,
      items: await buildBuyerVisibleOrderEmailItems(args.order, { dropId: args.dropId }),
    };
    const email = buildBuyerOrderReceivedEmailContent(message);
    jobs.push(createNotificationEmailJobV1({
      jobId: createJobId(),
      kind: 'buyer_order_received',
      idempotencyKey: message.idempotencyKey,
      recipients: message.recipients,
      subject: email.subject,
      text: email.text,
      html: email.html,
      context: { dropId: args.dropId, deliveryId },
    }));
  }
  if (plan.shipperRecipients.length) {
    const message = {
      idempotencyKey: `${args.dropId}:${deliveryId}:ready_to_ship`,
      recipients: plan.shipperRecipients,
      dropId: args.dropId,
      dropName,
      deliveryId,
      owner: typeof args.order.owner === 'string' ? args.order.owner : '',
      items: summarizeShipperReadyOrderItems(args.order),
      itemPreviews: await buildShipperVisibleOrderEmailItems(args.order, { dropId: args.dropId }),
      fulfillmentUrl: fulfillmentAppUrlForOrder(args.dropId, deliveryId),
    };
    const email = buildShipperReadyToShipEmailContent(message);
    jobs.push(createNotificationEmailJobV1({
      jobId: createJobId(),
      kind: 'shipper_ready_to_ship',
      idempotencyKey: message.idempotencyKey,
      recipients: message.recipients,
      subject: email.subject,
      text: email.text,
      html: email.html,
      context: { dropId: args.dropId, deliveryId },
    }));
  }
  return jobs;
}
