import type { DropFamily } from '../config/deployment';
import type { InventoryItem } from '../types';
import { calculateDeliveryLamports as calculateDeliveryLamportsShared } from '../../shared/shipping.ts';

export {
  canDeliverItemKind,
  isDirectDeliveryItemsPerBox,
  normalizeDeliveryUnitsPerBox,
  usesCardNft2DeliveryFees,
} from '../../shared/shipping.ts';

export function calculateDeliveryLamports(
  items: Array<Pick<InventoryItem, 'kind'>>,
  countryCode?: string,
  itemsPerBox?: number,
  dropFamily?: DropFamily,
): number {
  return calculateDeliveryLamportsShared(items, countryCode, itemsPerBox, dropFamily);
}
