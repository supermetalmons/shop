import { normalizeCountryCode } from './solana';
import { InventoryItem } from '../types';

const DELIVERY_BASE_LAMPORTS = 190_000_000;
const DELIVERY_EXTRA_LAMPORTS = 40_000_000;
const DELIVERY_FIGURES_PER_BOX = 3;

export function countDeliveryFigures(items: Array<Pick<InventoryItem, 'kind'>>): number {
  return items.reduce((total, item) => total + (item.kind === 'box' ? DELIVERY_FIGURES_PER_BOX : 1), 0);
}

export function calculateDeliveryLamports(
  items: Array<Pick<InventoryItem, 'kind'>>,
  countryCode?: string,
): number {
  const normalized = normalizeCountryCode(countryCode);
  if (normalized === 'US') return 0;
  const figureCount = countDeliveryFigures(items);
  if (figureCount <= 0) return 0;
  const extraFigures = Math.max(0, figureCount - DELIVERY_FIGURES_PER_BOX);
  return DELIVERY_BASE_LAMPORTS + extraFigures * DELIVERY_EXTRA_LAMPORTS;
}
