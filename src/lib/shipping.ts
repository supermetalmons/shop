import { normalizeCountryCode } from './solana';
import { InventoryItem } from '../types';

const DELIVERY_BASE_LAMPORTS = 190_000_000;
const DELIVERY_EXTRA_LAMPORTS = 40_000_000;

function normalizeItemsPerBox(itemsPerBox?: number): number {
  const parsed = Number(itemsPerBox);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.floor(parsed);
}

export function countDeliveryFigures(items: Array<Pick<InventoryItem, 'kind'>>, itemsPerBox?: number): number {
  const figuresPerBox = normalizeItemsPerBox(itemsPerBox);
  return items.reduce((total, item) => total + (item.kind === 'box' ? figuresPerBox : 1), 0);
}

export function calculateDeliveryLamports(
  items: Array<Pick<InventoryItem, 'kind'>>,
  countryCode?: string,
  itemsPerBox?: number,
): number {
  const figuresPerBox = normalizeItemsPerBox(itemsPerBox);
  const normalized = normalizeCountryCode(countryCode);
  if (normalized === 'US') return 0;
  const figureCount = countDeliveryFigures(items, figuresPerBox);
  if (figureCount <= 0) return 0;
  const extraFigures = Math.max(0, figureCount - figuresPerBox);
  return DELIVERY_BASE_LAMPORTS + extraFigures * DELIVERY_EXTRA_LAMPORTS;
}
