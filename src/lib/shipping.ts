import { type DropFamily } from '../config/deployment';
import { normalizeCountryCode } from './solana';
import { InventoryItem } from '../types';

const INTL_DELIVERY_BASE_LAMPORTS = 250_000_000;
const INTL_DELIVERY_EXTRA_LAMPORTS = 50_000_000;
const LITTLE_SWAG_BOXES_US_BASE_LAMPORTS = 100_000_000;
const LITTLE_SWAG_BOXES_US_EXTRA_LAMPORTS = 25_000_000;
const PONCHO_DRIFELLA_US_FLAT_LAMPORTS = 50_000_000;

function normalizeItemsPerBox(itemsPerBox?: number): number {
  const parsed = Number(itemsPerBox);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.floor(parsed);
}

export function countDeliveryFigures(items: Array<Pick<InventoryItem, 'kind'>>, itemsPerBox?: number): number {
  const figuresPerBox = normalizeItemsPerBox(itemsPerBox);
  return items.reduce((total, item) => total + (item.kind === 'box' ? figuresPerBox : 1), 0);
}

function calculateUsDeliveryLamports(
  figureCount: number,
  figuresPerBox: number,
  dropFamily?: DropFamily,
): number {
  if (figureCount <= 0) return 0;
  if (dropFamily === 'little_swag_boxes') {
    const extraFigures = Math.max(0, figureCount - figuresPerBox);
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
  const figuresPerBox = normalizeItemsPerBox(itemsPerBox);
  const normalized = normalizeCountryCode(countryCode);
  const figureCount = countDeliveryFigures(items, figuresPerBox);
  if (figureCount <= 0) return 0;
  if (normalized === 'US') return calculateUsDeliveryLamports(figureCount, figuresPerBox, dropFamily);
  const extraFigures = Math.max(0, figureCount - figuresPerBox);
  return INTL_DELIVERY_BASE_LAMPORTS + extraFigures * INTL_DELIVERY_EXTRA_LAMPORTS;
}
