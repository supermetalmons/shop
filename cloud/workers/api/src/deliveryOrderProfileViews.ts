import type { FulfillmentOrder } from '../../../../shared/contracts.js';
import { fulfillmentOrderFromRecord } from '../../../../shared/fulfillmentReadModel.js';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.js';
import { LEGACY_NOTIFICATION_FIELDS, shippedNotificationState, type NotificationOutboxRecord } from '../../../../shared/notificationOutbox.js';
import { isStripeChargebackSessionId } from '../../../../shared/stripeChargebacks.js';
import type { CommerceDocumentRecord } from './commerceRepositoryTypes.js';

const FULFILLMENT_ORDER_FIELDS = [
  'deliveryId', 'owner', 'source', 'status', 'createdAt', 'processedAt', 'fulfillmentStatus',
  'fulfillmentTrackingCode', 'fulfillmentUpdatedAt', 'fulfillmentInternalStatus', 'shipstation',
  'addressSnapshot', 'items', 'irlClaims', 'stripeReceiptClaimsByBoxId', 'stripeReceiptClaims',
  'stripeReceiptClaim', 'adminIrlRedeem',
] as const;

export function fulfillmentStripeSessionId(document: CommerceDocumentRecord, dropId: string): string | null {
  if (
    document.key.kind !== 'delivery_order' || document.key.dropId !== dropId ||
    document.data.source !== STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE ||
    (document.data.dropId !== undefined && document.data.dropId !== dropId)
  ) return null;
  const sessionId = document.data.stripeCheckoutSessionId;
  return isStripeChargebackSessionId(sessionId) ? sessionId : null;
}

export function fulfillmentOrderSummaryFromDocument(
  document: CommerceDocumentRecord,
  options: {
    dropId: string;
    canViewSensitiveAddress: boolean;
    decryptAddress: (payload: string) => string | null;
    chargebackSessionIds: ReadonlySet<string>;
    shippedOutbox: NotificationOutboxRecord | undefined;
  },
): FulfillmentOrder | null {
  if (document.key.kind !== 'delivery_order' || document.key.dropId !== options.dropId) return null;
  const fields: Record<string, unknown> = Object.fromEntries(FULFILLMENT_ORDER_FIELDS.flatMap((field) =>
    Object.hasOwn(document.data, field) ? [[field, document.data[field]]] : []));
  for (const field of LEGACY_NOTIFICATION_FIELDS) delete fields[field];
  const shippedState = shippedNotificationState(options.shippedOutbox);
  if (shippedState) fields.buyerOrderShippedEmailState = shippedState;
  const sessionId = fulfillmentStripeSessionId(document, options.dropId);
  return fulfillmentOrderFromRecord(document.key.documentId, fields, {
    canViewSensitiveAddress: options.canViewSensitiveAddress,
    decryptAddress: options.decryptAddress,
    dropId: options.dropId,
    stripeChargeback: sessionId !== null && options.chargebackSessionIds.has(sessionId),
  });
}
