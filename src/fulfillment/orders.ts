import type { FulfillmentOrder } from '../types';

export type FulfillmentOrderGroup = {
  pageIndex: number;
  groupKey: string;
  orders: FulfillmentOrder[];
  collapseSharedContact: boolean;
};

export function fulfillmentOrderKey(order: Pick<FulfillmentOrder, 'dropId' | 'deliveryId'>): string {
  return `${order.dropId}:${order.deliveryId}`;
}

function fulfillmentOrderGroupKey(order: FulfillmentOrder): string {
  const owner = typeof order.owner === 'string' ? order.owner.trim() : '';
  return owner ? `owner:${owner}` : `delivery:${fulfillmentOrderKey(order)}`;
}

function fulfillmentOrderSortValue(order: FulfillmentOrder): number {
  return order.processedAt || order.createdAt || 0;
}

export function sortFulfillmentOrders(orders: readonly FulfillmentOrder[]): FulfillmentOrder[] {
  return [...orders].sort(
    (a, b) =>
      fulfillmentOrderSortValue(b) - fulfillmentOrderSortValue(a) ||
      a.dropId.localeCompare(b.dropId) ||
      b.deliveryId - a.deliveryId,
  );
}

export function dedupeOrdersByKey(
  orders: readonly FulfillmentOrder[],
  existingOrderKeys?: ReadonlySet<string>,
): FulfillmentOrder[] {
  const seen = existingOrderKeys ? new Set(existingOrderKeys) : new Set<string>();
  return orders.filter((order) => {
    const key = fulfillmentOrderKey(order);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeFulfillmentOrderMatchValue(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s\u200B\u200C\u200D\u2060\uFEFF]+/g, '')
    .toLowerCase();
}

function parseFulfillmentOrderFullAddress(full?: string | null): { name: string; deliveryAddress: string } | null {
  if (typeof full !== 'string') return null;
  const normalized = full.replace(/\r\n/g, '\n').trim();
  if (!normalized || normalized === '***') return null;
  const [name, ...addressLines] = normalized.split('\n');
  const deliveryAddress = addressLines.join('\n');
  if (!name || !deliveryAddress) return null;
  return { name, deliveryAddress };
}

export function canCollapseFulfillmentOrderGroupContact(orders: readonly FulfillmentOrder[]): boolean {
  if (orders.length < 2) return false;
  const [firstOrder, ...restOrders] = orders;
  const firstAddress = parseFulfillmentOrderFullAddress(firstOrder.address.full);
  if (!firstAddress) return false;
  const firstEmail = normalizeFulfillmentOrderMatchValue(
    typeof firstOrder.address.email === 'string' ? firstOrder.address.email : '',
  );
  const firstName = normalizeFulfillmentOrderMatchValue(firstAddress.name);
  const firstDeliveryAddress = normalizeFulfillmentOrderMatchValue(firstAddress.deliveryAddress);
  if (!firstName) return false;

  return restOrders.every((order) => {
    const currentAddress = parseFulfillmentOrderFullAddress(order.address.full);
    if (!currentAddress) return false;
    const currentEmail = normalizeFulfillmentOrderMatchValue(
      typeof order.address.email === 'string' ? order.address.email : '',
    );
    return (
      currentEmail === firstEmail &&
      normalizeFulfillmentOrderMatchValue(currentAddress.deliveryAddress) === firstDeliveryAddress &&
      normalizeFulfillmentOrderMatchValue(currentAddress.name) === firstName
    );
  });
}

export function groupFulfillmentOrders(args: {
  orders: readonly FulfillmentOrder[];
  pageOrderKeys: readonly (readonly string[])[];
  visibleOrderKeys: ReadonlySet<string>;
}): FulfillmentOrderGroup[] {
  const orderByKey = new Map(args.orders.map((order) => [fulfillmentOrderKey(order), order] as const));
  const groups: FulfillmentOrderGroup[] = [];
  args.pageOrderKeys.forEach((pageOrderKeys, pageIndex) => {
    const visibleGroups = new Map<string, FulfillmentOrder[]>();
    pageOrderKeys.forEach((orderKey) => {
      const order = orderByKey.get(orderKey);
      if (!order || !args.visibleOrderKeys.has(orderKey)) return;
      const groupKey = fulfillmentOrderGroupKey(order);
      const visibleGroupOrders = visibleGroups.get(groupKey);
      if (visibleGroupOrders) {
        visibleGroupOrders.push(order);
      } else {
        visibleGroups.set(groupKey, [order]);
      }
    });
    visibleGroups.forEach((visibleGroupOrders, groupKey) => {
      groups.push({
        pageIndex,
        groupKey,
        orders: visibleGroupOrders,
        collapseSharedContact: canCollapseFulfillmentOrderGroupContact(visibleGroupOrders),
      });
    });
  });
  return groups;
}
