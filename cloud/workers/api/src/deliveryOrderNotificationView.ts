import { resolveFulfillmentTrackingHref } from '../../../../shared/fulfillmentTracking.js';
import { validateNotificationEmailRecipient } from '../../../../shared/notificationSubscription.js';
import { resolveNotificationDeliveryId, shouldNotifyBuyerForDeliveryShippedWrite } from './notifications.js';
import { parseDeliveryAddressSnapshot, parseDeliveryOrderOwnership, parseDeliveryOrderStatus } from './deliveryOrderReadModel.js';
import { buildBuyerVisibleOrderEmailItems, buildShipperVisibleOrderEmailItems } from './orderEmailItems.js';
import { summarizeShipperReadyOrderItems } from './notificationEmails.js';

export function parseDeliveryOrderNotificationView(order: Record<string, unknown>) {
  return {
    ...parseDeliveryOrderStatus(order),
    owner: parseDeliveryOrderOwnership(order).owner ?? '',
    resolveDeliveryId: (deliveryDocId: number | string) => resolveNotificationDeliveryId({
      deliveryDocId,
      storedDeliveryId: order.deliveryId,
    }),
    get buyerRecipient() {
      return validateNotificationEmailRecipient(parseDeliveryAddressSnapshot(order).email);
    },
    get trackingUrl() {
      return resolveFulfillmentTrackingHref(order.fulfillmentTrackingCode);
    },
    get shippedWithTracking() {
      return shouldNotifyBuyerForDeliveryShippedWrite({ after: order });
    },
    buyerItems: (dropId: string) => buildBuyerVisibleOrderEmailItems(order, { dropId }),
    shipperItems: (dropId: string) => buildShipperVisibleOrderEmailItems(order, { dropId }),
    get shipperSummary() {
      return summarizeShipperReadyOrderItems(order);
    },
  };
}

export type DeliveryOrderNotificationView = ReturnType<typeof parseDeliveryOrderNotificationView>;
