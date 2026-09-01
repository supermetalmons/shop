import type { FulfillmentOrder } from '../types';
import {
  isAdminIrlRedeemDeliveryOrderSource,
} from '../../shared/fulfillmentSources';
import { normalizeFulfillmentStatus } from './fulfillmentStatus';

export const FULFILLMENT_ORDER_VISIBILITY_OPTIONS = [
  { value: 'not_shipped', label: 'Not shipped' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'redeemed_for_irl', label: 'Redeemed for IRL' },
  { value: 'all', label: 'All' },
] as const;

export type FulfillmentOrderVisibilityFilter = (typeof FULFILLMENT_ORDER_VISIBILITY_OPTIONS)[number]['value'];

export const DEFAULT_FULFILLMENT_ORDER_VISIBILITY_FILTER: FulfillmentOrderVisibilityFilter = 'not_shipped';

export function normalizeFulfillmentOrderVisibilityFilter(
  value: unknown,
): FulfillmentOrderVisibilityFilter | undefined {
  return FULFILLMENT_ORDER_VISIBILITY_OPTIONS.some((option) => option.value === value)
    ? value as FulfillmentOrderVisibilityFilter
    : undefined;
}

type FulfillmentOrderVisibilityInput = Pick<FulfillmentOrder, 'source' | 'fulfillmentStatus'>;

export function isRedeemedForIrlFulfillmentOrder(order: Pick<FulfillmentOrder, 'source'>): boolean {
  return isAdminIrlRedeemDeliveryOrderSource(order.source);
}

export function canEditFulfillmentOrderAddress(
  order: Pick<
    FulfillmentOrder,
    'source' | 'shipstationShipmentId' | 'shipstationLabel' | 'shipstationPurchaseUnknown'
  >,
  options: { showFullAddress: boolean; hasAddressAccess: boolean },
): boolean {
  const labelStatus = order.shipstationLabel?.status;
  const hasActiveLabel = labelStatus === 'completed' || labelStatus === 'processing';
  return (
    options.showFullAddress &&
    options.hasAddressAccess &&
    !isRedeemedForIrlFulfillmentOrder(order) &&
    !order.shipstationShipmentId &&
    !hasActiveLabel &&
    !order.shipstationPurchaseUnknown
  );
}

export function filterFulfillmentOrdersByVisibility<T extends FulfillmentOrderVisibilityInput>(
  orders: readonly T[],
  filter: FulfillmentOrderVisibilityFilter,
): T[] {
  if (filter === 'redeemed_for_irl') {
    return orders.filter(isRedeemedForIrlFulfillmentOrder);
  }

  const nonIrlOrders = orders.filter((order) => !isRedeemedForIrlFulfillmentOrder(order));
  if (filter === 'all') return nonIrlOrders;
  if (filter === 'shipped') {
    return nonIrlOrders.filter((order) => normalizeFulfillmentStatus(order.fulfillmentStatus) === 'Shipped');
  }
  return nonIrlOrders.filter((order) => normalizeFulfillmentStatus(order.fulfillmentStatus) !== 'Shipped');
}
