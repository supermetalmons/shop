import { countDeliveryOrderBoxItems, countDeliveryOrderDudeItems } from '../../../../shared/packStatus.js';
import { isRecord } from './dataAccess.js';
import { parseDeliveryOrderStatus } from './deliveryOrderReadModel.js';

export function parseDeliveryOrderProjectionView(order: Record<string, unknown>) {
  const adminIrlRedeem = isRecord(order.adminIrlRedeem) ? order.adminIrlRedeem : {};
  return {
    ...parseDeliveryOrderStatus(order),
    adminTargetKind: typeof adminIrlRedeem.targetKind === 'string' ? adminIrlRedeem.targetKind : undefined,
    get packQuantity() { return countDeliveryOrderBoxItems(order.items); },
    get cardQuantity() { return countDeliveryOrderDudeItems(order.items); },
  };
}

export type DeliveryOrderProjectionView = ReturnType<typeof parseDeliveryOrderProjectionView>;
