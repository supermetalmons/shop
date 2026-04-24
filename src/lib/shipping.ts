import { type DropFamily } from '../config/deployment';
import { normalizeCountryCode } from './solana';
import { InventoryItem } from '../types';

const INTL_DELIVERY_BASE_LAMPORTS = 250_000_000;
const INTL_DELIVERY_EXTRA_LAMPORTS = 50_000_000;
const LITTLE_SWAG_BOXES_US_BASE_LAMPORTS = 100_000_000;
const LITTLE_SWAG_BOXES_US_EXTRA_LAMPORTS = 25_000_000;
const PONCHO_DRIFELLA_US_FLAT_LAMPORTS = 50_000_000;
const LITTLE_SWAG_HOODIES_INTL_DELIVERY_BASE_LAMPORTS = 600_000_000;
const LITTLE_SWAG_HOODIES_INTL_DELIVERY_EXTRA_LAMPORTS = 500_000_000;

export function isDirectDeliveryItemsPerBox(itemsPerBox?: number): boolean {
  const parsed = Number(itemsPerBox);
  return Number.isFinite(parsed) && Math.floor(parsed) === 0;
}

export function normalizeDeliveryUnitsPerBox(itemsPerBox?: number): number {
  const parsed = Math.floor(Number(itemsPerBox));
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

export function countDeliveryFigures(items: Array<Pick<InventoryItem, 'kind'>>, itemsPerBox?: number): number {
  const deliveryUnitsPerBox = normalizeDeliveryUnitsPerBox(itemsPerBox);
  return items.reduce((total, item) => total + (item.kind === 'box' ? deliveryUnitsPerBox : 1), 0);
}

function calculateUsDeliveryLamports(
  figureCount: number,
  itemsPerBox?: number,
  dropFamily?: DropFamily,
): number {
  if (figureCount <= 0) return 0;
  if (isDirectDeliveryItemsPerBox(itemsPerBox)) return 0;
  const deliveryUnitsPerBox = normalizeDeliveryUnitsPerBox(itemsPerBox);
  if (dropFamily === 'little_swag_boxes') {
    const extraFigures = Math.max(0, figureCount - deliveryUnitsPerBox);
    return LITTLE_SWAG_BOXES_US_BASE_LAMPORTS + extraFigures * LITTLE_SWAG_BOXES_US_EXTRA_LAMPORTS;
  }
  if (dropFamily === 'poncho_drifella') {
    return PONCHO_DRIFELLA_US_FLAT_LAMPORTS;
  }
  return 0;
}

export function calculateDeliveryLamports(
  items: Array<Pick<InventoryItem, 'kind'>>,
  countryCode?: string,
  itemsPerBox?: number,
  dropFamily?: DropFamily,
): number {
  const deliveryUnitsPerBox = normalizeDeliveryUnitsPerBox(itemsPerBox);
  const normalized = normalizeCountryCode(countryCode);
  const figureCount = countDeliveryFigures(items, itemsPerBox);
  if (figureCount <= 0) return 0;
  if (dropFamily === 'little_swag_hoodies') {
    if (normalized === 'US') return 0;
    const extraFigures = Math.max(0, figureCount - 1);
    return LITTLE_SWAG_HOODIES_INTL_DELIVERY_BASE_LAMPORTS + extraFigures * LITTLE_SWAG_HOODIES_INTL_DELIVERY_EXTRA_LAMPORTS;
  }
  if (normalized === 'US') return calculateUsDeliveryLamports(figureCount, itemsPerBox, dropFamily);
  const extraFigures = Math.max(0, figureCount - deliveryUnitsPerBox);
  return INTL_DELIVERY_BASE_LAMPORTS + extraFigures * INTL_DELIVERY_EXTRA_LAMPORTS;
}
