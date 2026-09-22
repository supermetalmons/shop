import { countDeliveryOrderBoxItems, countDeliveryOrderDudeItems } from '../../../../shared/packStatus.js';
import { isRecord } from './dataAccess.js';
import { parseDeliveryOrderStatus } from './deliveryOrderReadModel.js';

function nonnegativeSafeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

export function parseDeliveryOrderProjectionView(order: Record<string, unknown>) {
  const adminIrlRedeem = isRecord(order.adminIrlRedeem) ? order.adminIrlRedeem : {};
  return {
    ...parseDeliveryOrderStatus(order),
    adminTargetKind: typeof adminIrlRedeem.targetKind === 'string' ? adminIrlRedeem.targetKind : undefined,
    state: typeof order.packStatusProjectionState === 'string' ? order.packStatusProjectionState : undefined,
    nextAttemptAtMs: nonnegativeSafeInteger(order.packStatusProjectionNextAttemptAtMs),
    failureCount: nonnegativeSafeInteger(order.packStatusProjectionFailureCount),
    get packQuantity() { return countDeliveryOrderBoxItems(order.items); },
    get cardQuantity() { return countDeliveryOrderDudeItems(order.items); },
  };
}

export type DeliveryOrderProjectionView = ReturnType<typeof parseDeliveryOrderProjectionView>;
