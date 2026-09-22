import { shippedNotificationState } from '../../../../shared/notificationOutbox.js';
import { NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS } from './notificationOutboxPublication.js';
import type { FulfillmentStatus } from '../../../../shared/fulfillmentStatus.js';
import { sanitizeFulfillmentTrackingCode } from '../../../../shared/fulfillmentTracking.js';
import {
  BUYER_ORDER_SHIPPED_EMAIL_PENDING,
  BUYER_ORDER_SHIPPED_EMAIL_QUEUED,
  decideBuyerOrderShippedNotification,
  isBuyerOrderShippedNotificationEligible,
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
    const existingOutbox = await unit.getNotificationOutbox(document.key.path, 'shipped');
    let outbox = existingOutbox;
    const existingEntry = existingOutbox?.entries[0];
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
      emailState: existingOutbox?.state,
      forceRetry: args.retryShippedEmail === true,
      idempotencyKey: existingEntry?.idempotencyKey,
      jobId: existingEntry?.jobId,
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
    await updateDeliveryOrder(unit, document.key, updates);
    if (decision.kind === 'send') {
      const nowMs = typeof args.common.nowMs === 'function' ? args.common.nowMs() : args.common.nowMs;
      const intent = {
        parentPath: document.key.path,
        family: 'shipped' as const,
        dropId: args.dropId,
        generation: decision.jobId,
        entries: [{
          kind: 'buyer_order_shipped' as const,
          jobId: decision.jobId,
          idempotencyKey: decision.idempotencyKey,
          state: 'pending' as const,
        }],
        retryUntilMs: nowMs + NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS,
      };
      outbox = args.retryShippedEmail
        ? await unit.replaceNotificationOutbox(intent)
        : await unit.enqueueNotificationOutbox(intent);
    } else if (decision.clearPending || (existingOutbox?.state === 'failed' && !isBuyerOrderShippedNotificationEligible(order))) {
      outbox = await unit.cancelNotificationOutbox(document.key.path, 'shipped', decision.reason);
    }
    const publicState = shippedNotificationState(outbox);
    return {
      decision,
      order,
      response: {
        ...(publicState ? { buyerOrderShippedEmailState: publicState } : {}),
        deliveryId: args.deliveryId,
        fulfillmentStatus: nextStatus,
        ...(nextTrackingCode ? { fulfillmentTrackingCode: nextTrackingCode } : {}),
      },
    };
  });
}
