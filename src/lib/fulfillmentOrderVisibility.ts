import type { FulfillmentOrder } from '../types';
import {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE as ADMIN_IRL_REDEEM_FULFILLMENT_ORDER_SOURCE,
  isAdminIrlRedeemDeliveryOrderSource,
} from '../../functions/src/shared/fulfillmentSources';
import { normalizeFulfillmentStatus } from './fulfillmentStatus';

export { ADMIN_IRL_REDEEM_FULFILLMENT_ORDER_SOURCE };

export const FULFILLMENT_ORDER_VISIBILITY_OPTIONS = [
  { value: 'not_shipped', label: 'Not shipped' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'redeemed_for_irl', label: 'Redeemed for IRL' },
  { value: 'all', label: 'All' },
] as const;

export type FulfillmentOrderVisibilityFilter = (typeof FULFILLMENT_ORDER_VISIBILITY_OPTIONS)[number]['value'];

export const DEFAULT_FULFILLMENT_ORDER_VISIBILITY_FILTER: FulfillmentOrderVisibilityFilter = 'not_shipped';

type FulfillmentOrderVisibilityInput = Pick<FulfillmentOrder, 'source' | 'fulfillmentStatus'>;

export function isRedeemedForIrlFulfillmentOrder(order: Pick<FulfillmentOrder, 'source'>): boolean {
  return isAdminIrlRedeemDeliveryOrderSource(order.source);
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
