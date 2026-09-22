import { parseDeliveryOrderNotificationView, type DeliveryOrderNotificationView } from './deliveryOrderNotificationView.js';
import type { NotificationOutboxCreate, NotificationOutboxEntry } from '../../../../shared/notificationOutbox.js';
import {
  buildBuyerOrderReceivedEmailContent,
  buildShipperReadyToShipEmailContent,
  fulfillmentAppUrlForDrop,
} from './notificationEmails.js';
import {
  planReadyToShipOrderNotifications,
  shouldNotifyShippersForDeliveryReadyToShipWrite,
} from './notifications.js';
import {
  CARD_FULFILLMENT_DROP_IDS,
  CARD_NFT_BINDER_FULFILLMENT_DROP_IDS,
} from '../../../../shared/fulfillmentAccess.js';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.js';
import { DEPLOYMENT_DROPS } from '../../../../shared/deploymentRegistry.js';
import {
  createNotificationEmailJobV1,
  isNotificationEmailIdempotencyKey,
  isNotificationEmailJobId,
  type NotificationEmailJobV1,
} from '../../../../shared/notificationEmailJob.js';
import { NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS } from './notificationOutboxPublication.js';

export const BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD = 'buyerOrderReceivedEmailState';
export const SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD = 'shipperReadyToShipEmailState';
export type ReadyToShipNotificationStateField = typeof BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD |
  typeof SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD;
type ReadyToShipNotificationKind = 'buyer_order_received' | 'shipper_ready_to_ship';
export type PendingReadyToShipNotification = {
  kind: ReadyToShipNotificationKind;
  jobId: string;
  idempotencyKey: string;
};
type ReadyNotificationPlanOptions = {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  deliveryId: number;
  dropId: string;
  createJobId?: () => string;
  nowMs?: number;
};

const SHIPPER_READY_TO_SHIP_DROP_IDS = new Set([
  'little_swag_boxes',
  'poncho_drifella',
  'drifella_shirt',
  'little_swag_hoodies',
  ...CARD_FULFILLMENT_DROP_IDS,
  ...CARD_NFT_BINDER_FULFILLMENT_DROP_IDS,
]);
const SHIPPER_READY_TO_SHIP_RECIPIENTS = ['fulfillment@mons.shop'] as const;

function shipperReadyToShipRecipients(dropId: string): string[] {
  return SHIPPER_READY_TO_SHIP_DROP_IDS.has(dropId)
    ? [...SHIPPER_READY_TO_SHIP_RECIPIENTS]
    : [];
}

function readyToShipNotificationPlan(order: DeliveryOrderNotificationView, dropId: string) {
  return planReadyToShipOrderNotifications({
    buyerEmail: order.buyerRecipient,
    shipperRecipients: shipperReadyToShipRecipients(dropId),
  });
}

function notificationDeliveryId(order: DeliveryOrderNotificationView, deliveryId: number): number {
  const resolved = order.resolveDeliveryId(deliveryId);
  if (!resolved) throw new Error('Ready-to-ship notification delivery ID is invalid');
  return resolved;
}

export function planReadyToShipNotifications(args: ReadyNotificationPlanOptions): PendingReadyToShipNotification[] {
  const before = parseDeliveryOrderNotificationView(args.before);
  const after = parseDeliveryOrderNotificationView(args.after);
  if (!shouldNotifyShippersForDeliveryReadyToShipWrite({
    before, after, ignoredSources: [ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE],
  })) return [];
  const deliveryId = notificationDeliveryId(after, args.deliveryId);
  const plan = readyToShipNotificationPlan(after, args.dropId);
  const kinds: ReadyToShipNotificationKind[] = [
    ...(plan.buyerRecipient ? ['buyer_order_received' as const] : []),
    ...(plan.shipperRecipients.length ? ['shipper_ready_to_ship' as const] : []),
  ];
  return kinds.map((kind) => {
    const jobId = args.createJobId ? args.createJobId() : crypto.randomUUID();
    const idempotencyKey = `${args.dropId}:${deliveryId}:${kind === 'buyer_order_received' ? 'order_received' : 'ready_to_ship'}`;
    if (!isNotificationEmailJobId(jobId) || !isNotificationEmailIdempotencyKey(idempotencyKey)) {
      throw new Error('Ready-to-ship notification identity is invalid');
    }
    return { kind, jobId, idempotencyKey };
  });
}

export function readyToShipNotificationMarker(entry: NotificationOutboxEntry): PendingReadyToShipNotification {
  if (entry.kind !== 'buyer_order_received' && entry.kind !== 'shipper_ready_to_ship') {
    throw new Error('Invalid ready-to-ship notification kind');
  }
  return { kind: entry.kind, jobId: entry.jobId, idempotencyKey: entry.idempotencyKey };
}

export function createReadyToShipNotificationIntent(args: ReadyNotificationPlanOptions & {
  parentPath: string;
}): NotificationOutboxCreate | null {
  const pending = planReadyToShipNotifications(args);
  if (!pending.length) return null;
  return {
    parentPath: args.parentPath, family: 'ready', dropId: args.dropId, generation: crypto.randomUUID(),
    retryUntilMs: (args.nowMs ?? Date.now()) + NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS,
    entries: pending.map((entry) => ({ ...entry, state: 'pending' })),
  };
}

export async function createReadyToShipNotificationJobs(args: {
  order: Record<string, unknown>;
  deliveryId: number;
  dropId: string;
  pending: readonly PendingReadyToShipNotification[];
}): Promise<NotificationEmailJobV1[]> {
  const order = parseDeliveryOrderNotificationView(args.order);
  const deliveryId = notificationDeliveryId(order, args.deliveryId);
  const drop = DEPLOYMENT_DROPS[args.dropId];
  if (!drop) throw new Error('Ready-to-ship notification drop is unsupported');
  const plan = readyToShipNotificationPlan(order, args.dropId);
  const dropName = drop.displayName || drop.collectionName || args.dropId;
  const jobs: NotificationEmailJobV1[] = [];
  for (const marker of args.pending) {
    const expectedIdempotencyKey = `${args.dropId}:${deliveryId}:${(marker.kind === 'buyer_order_received' ? 'order_received' : 'ready_to_ship')}`;
    if (marker.idempotencyKey !== expectedIdempotencyKey) {
      throw new Error('Ready-to-ship notification idempotency key does not match the order');
    }
    if (marker.kind === 'buyer_order_received') {
      if (!plan.buyerRecipient) throw new Error('Buyer order received notification recipient is unavailable');
      const message = {
        idempotencyKey: marker.idempotencyKey,
        recipients: [plan.buyerRecipient],
        dropId: args.dropId,
        dropName,
        deliveryId,
        items: await order.buyerItems(args.dropId),
      };
      const email = buildBuyerOrderReceivedEmailContent(message);
      jobs.push(createNotificationEmailJobV1({
        jobId: marker.jobId,
        kind: marker.kind,
        idempotencyKey: marker.idempotencyKey,
        recipients: message.recipients,
        subject: email.subject,
        text: email.text,
        html: email.html,
        context: { dropId: args.dropId, deliveryId },
      }));
      continue;
    }
    if (!plan.shipperRecipients.length) throw new Error('Shipper ready-to-ship notification recipient is unavailable');
    const message = {
      idempotencyKey: marker.idempotencyKey,
      recipients: plan.shipperRecipients,
      dropId: args.dropId,
      dropName,
      deliveryId,
      owner: order.owner,
      items: order.shipperSummary,
      itemPreviews: await order.shipperItems(args.dropId),
      fulfillmentUrl: fulfillmentAppUrlForDrop(args.dropId),
    };
    const email = buildShipperReadyToShipEmailContent(message);
    jobs.push(createNotificationEmailJobV1({
      jobId: marker.jobId,
      kind: marker.kind,
      idempotencyKey: marker.idempotencyKey,
      recipients: message.recipients,
      subject: email.subject,
      text: email.text,
      html: email.html,
      context: { dropId: args.dropId, deliveryId },
    }));
  }
  return jobs;
}
