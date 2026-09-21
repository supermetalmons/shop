import type { FulfillmentStatus } from '../../../../shared/fulfillmentStatus.js';
import { sanitizeFulfillmentTrackingCode } from '../../../../shared/fulfillmentTracking.js';
import {
  BUYER_ORDER_SHIPPED_EMAIL_PENDING,
  BUYER_ORDER_SHIPPED_EMAIL_QUEUED,
  decideBuyerOrderShippedNotification,
  type BuyerOrderShippedDecision,
} from './buyerOrderShipped.js';
import {
  CommerceWriteConflict,
  commerceFieldValue,
  type CommerceDocumentData,
  type CommerceUnitOfWork,
  type D1CommerceRepository,
} from './commerceRepository.js';
import { runCommerceTransaction, type CommerceTransactionTarget } from './commerceTransactions.js';
import { ProfileReadError } from './dataAccess.js';
import {
  deliveryOrderFulfillmentDocument,
  loadDeliveryOrderDocument,
  updateDeliveryOrder,
  type DeliveryOrderFulfillmentDocument,
} from './deliveryOrderStore.js';
import type { DeliveryOrderFulfillmentUpdates } from './deliveryOrderUpdates.js';

type ShippedEmailState = typeof BUYER_ORDER_SHIPPED_EMAIL_PENDING | typeof BUYER_ORDER_SHIPPED_EMAIL_QUEUED;

export type DeliveryOrderFulfillmentResponse = {
  buyerOrderShippedEmailState?: ShippedEmailState;
  deliveryId: number;
  fulfillmentStatus: FulfillmentStatus | '';
  fulfillmentTrackingCode?: string;
};

type DeliveryOrderFulfillmentMutation = {
  decision: BuyerOrderShippedDecision;
  order: CommerceDocumentData;
  response: DeliveryOrderFulfillmentResponse;
};

async function loadDeliveryOrderFulfillment(
  reader: Pick<D1CommerceRepository, 'get'>,
  dropId: string,
  deliveryId: number,
): Promise<DeliveryOrderFulfillmentDocument> {
  const record = await loadDeliveryOrderDocument({ repository: reader }, dropId, deliveryId);
  return deliveryOrderFulfillmentDocument(record);
}

async function withDeliveryOrderFulfillment<T>(
  args: { common: CommerceTransactionTarget; deliveryId: number; dropId: string },
  operation: (unit: CommerceUnitOfWork, document: DeliveryOrderFulfillmentDocument) => Promise<T>,
): Promise<T> {
  try {
    return await runCommerceTransaction(args.common, async (unit) => {
      const document = await loadDeliveryOrderFulfillment(unit, args.dropId, args.deliveryId);
      return operation(unit, document);
    });
  } catch (error) {
    if (error instanceof CommerceWriteConflict) {
      throw new ProfileReadError('aborted', 409, 'The delivery order changed. Try again.');
    }
    throw error;
  }
}

export function markDeliveryOrderShippedEmailQueued(args: {
  common: CommerceTransactionTarget;
  deliveryId: number;
  dropId: string;
  jobId: string;
}): Promise<boolean> {
  return withDeliveryOrderFulfillment(args, async (unit, document) => {
    if (
      document.fulfillment.buyerOrderShippedEmailState !== BUYER_ORDER_SHIPPED_EMAIL_PENDING ||
      document.fulfillment.buyerOrderShippedEmailJobId !== args.jobId
    ) return false;
    const updates: DeliveryOrderFulfillmentUpdates = {
      buyerOrderShippedEmailState: BUYER_ORDER_SHIPPED_EMAIL_QUEUED,
      buyerOrderShippedEmailJobId: args.jobId,
      buyerOrderShippedEmailQueuedAt: commerceFieldValue.serverTimestamp(),
    };
    await updateDeliveryOrder(unit, document.key, updates);
    return true;
  });
}

export function setDeliveryOrderFulfillment(args: {
  common: CommerceTransactionTarget;
  createNotificationJobId: () => string;
  deliveryId: number;
  dropId: string;
  retryShippedEmail?: boolean;
  status: FulfillmentStatus | '' | null;
  trackingCode?: string;
  wallet: string;
}): Promise<DeliveryOrderFulfillmentMutation> {
  return withDeliveryOrderFulfillment(args, async (unit, document) => {
    const nextStatus = args.status || '';
    const nextTrackingCode = nextStatus === 'Shipped'
      ? sanitizeFulfillmentTrackingCode(args.trackingCode)
      : document.fulfillment.fulfillmentTrackingCode;
    const order: CommerceDocumentData = {
      ...document.data,
      dropId: args.dropId,
      fulfillmentUpdatedBy: args.wallet,
    };
    if (nextStatus) order.fulfillmentStatus = nextStatus;
    else delete order.fulfillmentStatus;
    if (nextStatus === 'Shipped') {
      if (nextTrackingCode) order.fulfillmentTrackingCode = nextTrackingCode;
      else delete order.fulfillmentTrackingCode;
    }
    const decision = decideBuyerOrderShippedNotification({
      before: document.fulfillment,
      after: order,
      deliveryDocId: args.deliveryId,
      dropId: args.dropId,
      emailState: document.fulfillment.buyerOrderShippedEmailState,
      forceRetry: args.retryShippedEmail === true,
      idempotencyKey: document.fulfillment.buyerOrderShippedEmailIdempotencyKey,
      jobId: document.fulfillment.buyerOrderShippedEmailJobId,
      createJobId: args.createNotificationJobId,
    });
    const updates: DeliveryOrderFulfillmentUpdates = {
      dropId: args.dropId,
      fulfillmentUpdatedBy: args.wallet,
      fulfillmentStatus: nextStatus || commerceFieldValue.delete(),
      fulfillmentUpdatedAt: commerceFieldValue.serverTimestamp(),
    };
    if (nextStatus === 'Shipped') {
      updates.fulfillmentTrackingCode = nextTrackingCode || commerceFieldValue.delete();
    }
    if (decision.kind === 'send') {
      updates.buyerOrderShippedEmailState = BUYER_ORDER_SHIPPED_EMAIL_PENDING;
      updates.buyerOrderShippedEmailJobId = decision.jobId;
      updates.buyerOrderShippedEmailIdempotencyKey = decision.idempotencyKey;
      updates.buyerOrderShippedEmailQueuedAt = commerceFieldValue.delete();
      order.buyerOrderShippedEmailState = BUYER_ORDER_SHIPPED_EMAIL_PENDING;
      order.buyerOrderShippedEmailJobId = decision.jobId;
      order.buyerOrderShippedEmailIdempotencyKey = decision.idempotencyKey;
      delete order.buyerOrderShippedEmailQueuedAt;
    } else if (decision.clearPending) {
      updates.buyerOrderShippedEmailState = commerceFieldValue.delete();
      updates.buyerOrderShippedEmailJobId = commerceFieldValue.delete();
      updates.buyerOrderShippedEmailIdempotencyKey = commerceFieldValue.delete();
      updates.buyerOrderShippedEmailQueuedAt = commerceFieldValue.delete();
      delete order.buyerOrderShippedEmailState;
      delete order.buyerOrderShippedEmailJobId;
      delete order.buyerOrderShippedEmailIdempotencyKey;
      delete order.buyerOrderShippedEmailQueuedAt;
    }
    await updateDeliveryOrder(unit, document.key, updates);
    return {
      decision,
      order,
      response: {
        ...(decision.kind === 'send'
          ? { buyerOrderShippedEmailState: BUYER_ORDER_SHIPPED_EMAIL_PENDING }
          : document.fulfillment.buyerOrderShippedEmailState === BUYER_ORDER_SHIPPED_EMAIL_QUEUED
            ? { buyerOrderShippedEmailState: BUYER_ORDER_SHIPPED_EMAIL_QUEUED }
            : {}),
        deliveryId: args.deliveryId,
        fulfillmentStatus: nextStatus,
        ...(nextTrackingCode ? { fulfillmentTrackingCode: nextTrackingCode } : {}),
      },
    };
  });
}
