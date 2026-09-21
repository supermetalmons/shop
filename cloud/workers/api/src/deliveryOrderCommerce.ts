import {
  normalizeFulfillmentStatus,
  type FulfillmentStatus,
} from '../../../../shared/fulfillmentStatus.js';
import {
  normalizeOptionalFulfillmentTrackingCode,
  sanitizeFulfillmentTrackingCode,
} from '../../../../shared/fulfillmentTracking.js';
import {
  isNotificationEmailIdempotencyKey,
  isNotificationEmailJobId,
} from '../../../../shared/notificationEmailJob.js';
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
import { loadDeliveryOrderDocument, type DeliveryOrderDocument } from './deliveryOrderStore.js';

type ShippedEmailState = typeof BUYER_ORDER_SHIPPED_EMAIL_PENDING | typeof BUYER_ORDER_SHIPPED_EMAIL_QUEUED;

type DeliveryOrderFulfillment = {
  fulfillmentStatus: FulfillmentStatus | undefined;
  fulfillmentTrackingCode: string | undefined;
  buyerOrderShippedEmailState: ShippedEmailState | undefined;
  buyerOrderShippedEmailJobId: string | undefined;
  buyerOrderShippedEmailIdempotencyKey: string | undefined;
};

type DeliveryOrderFulfillmentDocument = DeliveryOrderDocument & {
  fulfillment: DeliveryOrderFulfillment;
};

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

type DeliveryOrderFulfillmentUpdates = {
  dropId?: string;
  fulfillmentUpdatedBy?: string;
  fulfillmentStatus?: FulfillmentStatus | ReturnType<typeof commerceFieldValue.delete>;
  fulfillmentUpdatedAt?: ReturnType<typeof commerceFieldValue.serverTimestamp>;
  fulfillmentTrackingCode?: string | ReturnType<typeof commerceFieldValue.delete>;
  buyerOrderShippedEmailState?: ShippedEmailState | ReturnType<typeof commerceFieldValue.delete>;
  buyerOrderShippedEmailJobId?: string | ReturnType<typeof commerceFieldValue.delete>;
  buyerOrderShippedEmailIdempotencyKey?: string | ReturnType<typeof commerceFieldValue.delete>;
  buyerOrderShippedEmailQueuedAt?: ReturnType<typeof commerceFieldValue.delete> | ReturnType<typeof commerceFieldValue.serverTimestamp>;
};

async function loadDeliveryOrderFulfillment(
  reader: Pick<D1CommerceRepository, 'get'>,
  dropId: string,
  deliveryId: number,
): Promise<DeliveryOrderFulfillmentDocument> {
  const record = await loadDeliveryOrderDocument({ repository: reader }, dropId, deliveryId);
  const fields = record.data;
  const emailState = fields.buyerOrderShippedEmailState;
  return {
    ...record,
    fulfillment: {
      fulfillmentStatus: normalizeFulfillmentStatus(fields.fulfillmentStatus),
      fulfillmentTrackingCode: normalizeOptionalFulfillmentTrackingCode(fields.fulfillmentTrackingCode),
      buyerOrderShippedEmailState: emailState === BUYER_ORDER_SHIPPED_EMAIL_PENDING || emailState === BUYER_ORDER_SHIPPED_EMAIL_QUEUED
        ? emailState
        : undefined,
      buyerOrderShippedEmailJobId: isNotificationEmailJobId(fields.buyerOrderShippedEmailJobId)
        ? fields.buyerOrderShippedEmailJobId
        : undefined,
      buyerOrderShippedEmailIdempotencyKey: isNotificationEmailIdempotencyKey(fields.buyerOrderShippedEmailIdempotencyKey)
        ? fields.buyerOrderShippedEmailIdempotencyKey
        : undefined,
    },
  };
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
    await unit.update(document.key, updates);
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
    await unit.update(document.key, updates);
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
