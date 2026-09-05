import {
  buildBuyerVisibleOrderEmailItems,
  buildShipperVisibleOrderEmailItems,
} from './orderEmailItems.js';
import {
  buildBuyerOrderReceivedEmailContent,
  buildShipperReadyToShipEmailContent,
  fulfillmentAppUrlForDrop,
  summarizeShipperReadyOrderItems,
} from './notificationEmails.js';
import {
  planReadyToShipOrderNotifications,
  resolveNotificationDeliveryId,
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
import {
  READY_NOTIFICATION_BUYER_STATE_FIELD,
  READY_NOTIFICATION_PENDING_STATE,
  READY_NOTIFICATION_SHIPPER_STATE_FIELD,
} from '../../../../shared/readyToShipNotificationReconciliation.js';
import { commerceFieldValue, type CommerceDocumentWriteData } from './commerceRepository.js';

export const READY_TO_SHIP_NOTIFICATION_PENDING = READY_NOTIFICATION_PENDING_STATE;
export const READY_TO_SHIP_NOTIFICATION_QUEUED = 'queued' as const;
export const READY_TO_SHIP_NOTIFICATION_FAILED = 'failed' as const;
export const READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS = 6 * 60 * 60_000;
export const READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS = 10 * 60_000;
export const READY_TO_SHIP_NOTIFICATION_MAX_PUBLISH_ATTEMPTS = 4;
export const READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD = 'readyToShipNotificationRetryUntilMs';
export const READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD = 'readyToShipNotificationPublishClaimId';
export const READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD =
  'readyToShipNotificationPublishClaimExpiresAtMs';
export const READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD =
  'readyToShipNotificationPublishAttemptCount';

export const BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD = READY_NOTIFICATION_BUYER_STATE_FIELD;
export const BUYER_ORDER_RECEIVED_EMAIL_JOB_ID_FIELD = 'buyerOrderReceivedEmailJobId';
export const BUYER_ORDER_RECEIVED_EMAIL_IDEMPOTENCY_KEY_FIELD = 'buyerOrderReceivedEmailIdempotencyKey';
export const BUYER_ORDER_RECEIVED_EMAIL_QUEUED_AT_FIELD = 'buyerOrderReceivedEmailQueuedAt';
export const SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD = READY_NOTIFICATION_SHIPPER_STATE_FIELD;
export const SHIPPER_READY_TO_SHIP_EMAIL_JOB_ID_FIELD = 'shipperReadyToShipEmailJobId';
export const SHIPPER_READY_TO_SHIP_EMAIL_IDEMPOTENCY_KEY_FIELD = 'shipperReadyToShipEmailIdempotencyKey';
export const SHIPPER_READY_TO_SHIP_EMAIL_QUEUED_AT_FIELD = 'shipperReadyToShipEmailQueuedAt';

type ReadyToShipNotificationKind = 'buyer_order_received' | 'shipper_ready_to_ship';

type ReadyToShipNotificationMarkerDefinition = {
  kind: ReadyToShipNotificationKind;
  stateField: string;
  jobIdField: string;
  idempotencyKeyField: string;
  queuedAtField: string;
  idempotencySuffix: 'order_received' | 'ready_to_ship';
};

export type PendingReadyToShipNotification = ReadyToShipNotificationMarkerDefinition & {
  jobId: string;
  idempotencyKey: string;
};

export type ReadyToShipNotificationOutbox = {
  values: CommerceDocumentWriteData;
  pending: PendingReadyToShipNotification[];
};

export type PendingReadyToShipNotificationInspection = {
  invalidStateFields: string[];
  pending: PendingReadyToShipNotification[];
};

const MARKERS: readonly ReadyToShipNotificationMarkerDefinition[] = [
  {
    kind: 'buyer_order_received',
    stateField: BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD,
    jobIdField: BUYER_ORDER_RECEIVED_EMAIL_JOB_ID_FIELD,
    idempotencyKeyField: BUYER_ORDER_RECEIVED_EMAIL_IDEMPOTENCY_KEY_FIELD,
    queuedAtField: BUYER_ORDER_RECEIVED_EMAIL_QUEUED_AT_FIELD,
    idempotencySuffix: 'order_received',
  },
  {
    kind: 'shipper_ready_to_ship',
    stateField: SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD,
    jobIdField: SHIPPER_READY_TO_SHIP_EMAIL_JOB_ID_FIELD,
    idempotencyKeyField: SHIPPER_READY_TO_SHIP_EMAIL_IDEMPOTENCY_KEY_FIELD,
    queuedAtField: SHIPPER_READY_TO_SHIP_EMAIL_QUEUED_AT_FIELD,
    idempotencySuffix: 'ready_to_ship',
  },
];

const SHIPPER_READY_TO_SHIP_DROP_IDS = new Set([
  'little_swag_boxes',
  'poncho_drifella',
  'drifella_shirt',
  'little_swag_hoodies',
  ...CARD_FULFILLMENT_DROP_IDS,
  ...CARD_NFT_BINDER_FULFILLMENT_DROP_IDS,
]);
const SHIPPER_READY_TO_SHIP_RECIPIENTS = ['fulfillment@mons.shop'] as const;

function markerForKind(kind: ReadyToShipNotificationKind): ReadyToShipNotificationMarkerDefinition {
  const marker = MARKERS.find((candidate) => candidate.kind === kind);
  if (!marker) throw new Error(`Ready-to-ship notification marker is missing for ${kind}`);
  return marker;
}

export function shipperReadyToShipRecipients(dropId: string): string[] {
  return SHIPPER_READY_TO_SHIP_DROP_IDS.has(dropId)
    ? [...SHIPPER_READY_TO_SHIP_RECIPIENTS]
    : [];
}

function readyToShipNotificationPlan(order: Record<string, unknown>, dropId: string) {
  const address = order.addressSnapshot;
  const buyerEmail = address && typeof address === 'object' && !Array.isArray(address)
    ? (address as Record<string, unknown>).email
    : undefined;
  return planReadyToShipOrderNotifications({
    buyerEmail,
    shipperRecipients: shipperReadyToShipRecipients(dropId),
  });
}

function notificationDeliveryId(order: Record<string, unknown>, deliveryId: number): number {
  const resolved = resolveNotificationDeliveryId({
    deliveryDocId: deliveryId,
    storedDeliveryId: order.deliveryId,
  });
  if (!resolved) throw new Error('Ready-to-ship notification delivery ID is invalid');
  return resolved;
}

function pendingMarker(
  marker: ReadyToShipNotificationMarkerDefinition,
  dropId: string,
  deliveryId: number,
  createJobId: () => string,
): PendingReadyToShipNotification {
  const jobId = createJobId();
  const idempotencyKey = `${dropId}:${deliveryId}:${marker.idempotencySuffix}`;
  if (!isNotificationEmailJobId(jobId)) throw new Error('Ready-to-ship notification job ID is invalid');
  if (!isNotificationEmailIdempotencyKey(idempotencyKey)) {
    throw new Error('Ready-to-ship notification idempotency key is invalid');
  }
  return { ...marker, jobId, idempotencyKey };
}

export function createReadyToShipNotificationOutbox(args: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  deliveryId: number;
  dropId: string;
  createJobId?: () => string;
  nowMs?: number;
}): ReadyToShipNotificationOutbox {
  if (!shouldNotifyShippersForDeliveryReadyToShipWrite({
    before: args.before,
    after: args.after,
    ignoredSources: [ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE],
  })) {
    return { values: {}, pending: [] };
  }
  const deliveryId = notificationDeliveryId(args.after, args.deliveryId);
  const plan = readyToShipNotificationPlan(args.after, args.dropId);
  const createJobId = args.createJobId || (() => crypto.randomUUID());
  const pending = [
    ...(plan.buyerRecipient
      ? [pendingMarker(markerForKind('buyer_order_received'), args.dropId, deliveryId, createJobId)]
      : []),
    ...(plan.shipperRecipients.length
      ? [pendingMarker(markerForKind('shipper_ready_to_ship'), args.dropId, deliveryId, createJobId)]
      : []),
  ];
  const values: CommerceDocumentWriteData = {};
  for (const marker of pending) {
    values[marker.stateField] = READY_TO_SHIP_NOTIFICATION_PENDING;
    values[marker.jobIdField] = marker.jobId;
    values[marker.idempotencyKeyField] = marker.idempotencyKey;
    values[marker.queuedAtField] = commerceFieldValue.delete();
  }
  if (pending.length) {
    const nowMs = Number.isSafeInteger(args.nowMs) && Number(args.nowMs) >= 0
      ? Number(args.nowMs)
      : Date.now();
    values[READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD] = nowMs + READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS;
    values[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD] = 0;
    values[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD] = commerceFieldValue.delete();
    values[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD] = commerceFieldValue.delete();
  }
  return { values, pending };
}

export function inspectPendingReadyToShipNotifications(
  order: Record<string, unknown>,
  expected?: { deliveryId: number; dropId: string },
): PendingReadyToShipNotificationInspection {
  if (order.status !== 'ready_to_ship') return { invalidStateFields: [], pending: [] };
  const invalidStateFields: string[] = [];
  const pending: PendingReadyToShipNotification[] = [];
  for (const marker of MARKERS) {
    if (order[marker.stateField] !== READY_TO_SHIP_NOTIFICATION_PENDING) continue;
    const jobId = order[marker.jobIdField];
    const idempotencyKey = order[marker.idempotencyKeyField];
    const expectedIdempotencyKey = expected
      ? `${expected.dropId}:${expected.deliveryId}:${marker.idempotencySuffix}`
      : undefined;
    if (
      !isNotificationEmailJobId(jobId) ||
      !isNotificationEmailIdempotencyKey(idempotencyKey) ||
      (expectedIdempotencyKey !== undefined && idempotencyKey !== expectedIdempotencyKey)
    ) {
      invalidStateFields.push(marker.stateField);
      continue;
    }
    pending.push({ ...marker, jobId, idempotencyKey });
  }
  return { invalidStateFields, pending };
}

export function pendingReadyToShipNotifications(
  order: Record<string, unknown>,
  expected?: { deliveryId: number; dropId: string },
): PendingReadyToShipNotification[] {
  const inspection = inspectPendingReadyToShipNotifications(order, expected);
  if (inspection.invalidStateFields.length) throw new Error('Pending ready-to-ship notification marker is invalid');
  return inspection.pending;
}

export async function createReadyToShipNotificationJobs(args: {
  order: Record<string, unknown>;
  deliveryId: number;
  dropId: string;
  pending: readonly PendingReadyToShipNotification[];
}): Promise<NotificationEmailJobV1[]> {
  const deliveryId = notificationDeliveryId(args.order, args.deliveryId);
  const drop = DEPLOYMENT_DROPS[args.dropId];
  if (!drop) throw new Error('Ready-to-ship notification drop is unsupported');
  const plan = readyToShipNotificationPlan(args.order, args.dropId);
  const dropName = drop.displayName || drop.collectionName || args.dropId;
  const jobs: NotificationEmailJobV1[] = [];
  for (const marker of args.pending) {
    const expectedIdempotencyKey = `${args.dropId}:${deliveryId}:${marker.idempotencySuffix}`;
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
        items: await buildBuyerVisibleOrderEmailItems(args.order, { dropId: args.dropId }),
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
      owner: typeof args.order.owner === 'string' ? args.order.owner : '',
      items: summarizeShipperReadyOrderItems(args.order),
      itemPreviews: await buildShipperVisibleOrderEmailItems(args.order, { dropId: args.dropId }),
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
