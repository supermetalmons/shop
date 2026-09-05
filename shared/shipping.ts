import { normalizeCountryCode } from './countryNormalization.ts';
import type { DropFamily } from './deploymentCore.ts';

const INTL_DELIVERY_BASE_LAMPORTS = 250_000_000;
const INTL_DELIVERY_EXTRA_LAMPORTS = 50_000_000;
const LITTLE_SWAG_BOXES_US_BASE_LAMPORTS = 100_000_000;
const LITTLE_SWAG_BOXES_US_EXTRA_LAMPORTS = 25_000_000;
const CARD_NFT_2_BASE_DELIVERY_CARD_COUNT = 3;
const CARD_NFT_2_US_BASE_LAMPORTS = 200_000_000;
const CARD_NFT_2_INTL_BASE_LAMPORTS = 400_000_000;
const CARD_NFT_2_EXTRA_LAMPORTS = 60_000_000;
const DRIFELLA_SHIRT_US_FLAT_LAMPORTS = 100_000_000;
const DRIFELLA_SHIRT_INTL_FLAT_LAMPORTS = 250_000_000;
const PONCHO_DRIFELLA_US_FLAT_LAMPORTS = 50_000_000;
const LITTLE_SWAG_HOODIES_INTL_DELIVERY_BASE_LAMPORTS = 600_000_000;
const LITTLE_SWAG_HOODIES_INTL_DELIVERY_EXTRA_LAMPORTS = 500_000_000;

export type DeliveryItemKind = 'box' | 'dude' | 'certificate';
export type DeliveryItem = { kind: DeliveryItemKind };
export type InvalidDeliveryUnitsPolicy = 'fallback-one' | 'arithmetic';

type DeliveryPricing =
  | { kind: 'free' }
  | { kind: 'flat'; baseLamports: number }
  | { kind: 'per-unit'; baseLamports: number; includedUnits: number; extraUnitLamports: number };

function usesCardNft2DeliveryFees(dropFamily: DropFamily | undefined): boolean {
  return dropFamily === 'card_nft_2' || dropFamily === 'clear_cards';
}

export function canDeliverItemKind(
  dropFamily: DropFamily | undefined,
  kind: DeliveryItemKind,
): boolean {
  if (kind === 'certificate') return false;
  return dropFamily !== 'clear_cards' || kind !== 'box';
}

export function isDirectDeliveryItemsPerBox(itemsPerBox?: number): boolean {
  const parsed = Number(itemsPerBox);
  return Number.isFinite(parsed) && Math.floor(parsed) === 0;
}

export function normalizeDeliveryUnitsPerBox(
  itemsPerBox?: number,
  invalidPolicy: InvalidDeliveryUnitsPolicy = 'fallback-one',
): number {
  const parsed = Math.floor(Number(itemsPerBox));
  if (invalidPolicy === 'arithmetic') {
    return isDirectDeliveryItemsPerBox(itemsPerBox) ? 1 : Math.max(1, parsed);
  }
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

export function countDeliveryFigures(
  items: ReadonlyArray<DeliveryItem>,
  itemsPerBox?: number,
  invalidPolicy: InvalidDeliveryUnitsPolicy = 'fallback-one',
): number {
  const deliveryUnitsPerBox = normalizeDeliveryUnitsPerBox(itemsPerBox, invalidPolicy);
  return items.reduce(
    (total, item) => total + (item.kind === 'box' ? deliveryUnitsPerBox : 1),
    0,
  );
}

export function resolveDeliveryPricing(
  countryCode?: string,
  itemsPerBox?: number,
  dropFamily?: DropFamily,
  invalidPolicy: InvalidDeliveryUnitsPolicy = 'fallback-one',
): DeliveryPricing {
  const isUs = normalizeCountryCode(countryCode) === 'US';
  if (dropFamily === 'drifella_shirt') {
    return {
      kind: 'flat',
      baseLamports: isUs ? DRIFELLA_SHIRT_US_FLAT_LAMPORTS : DRIFELLA_SHIRT_INTL_FLAT_LAMPORTS,
    };
  }
  if (dropFamily === 'little_swag_hoodies') {
    if (isUs) return { kind: 'free' };
    return {
      kind: 'per-unit',
      baseLamports: LITTLE_SWAG_HOODIES_INTL_DELIVERY_BASE_LAMPORTS,
      includedUnits: 1,
      extraUnitLamports: LITTLE_SWAG_HOODIES_INTL_DELIVERY_EXTRA_LAMPORTS,
    };
  }
  const deliveryUnitsPerBox = normalizeDeliveryUnitsPerBox(itemsPerBox, invalidPolicy);
  if (isUs) {
    if (isDirectDeliveryItemsPerBox(itemsPerBox)) return { kind: 'free' };
    if (dropFamily === 'little_swag_boxes') {
      return {
        kind: 'per-unit',
        baseLamports: LITTLE_SWAG_BOXES_US_BASE_LAMPORTS,
        includedUnits: deliveryUnitsPerBox,
        extraUnitLamports: LITTLE_SWAG_BOXES_US_EXTRA_LAMPORTS,
      };
    }
    if (dropFamily === 'poncho_drifella') {
      return { kind: 'flat', baseLamports: PONCHO_DRIFELLA_US_FLAT_LAMPORTS };
    }
    if (!usesCardNft2DeliveryFees(dropFamily)) return { kind: 'free' };
  }
  if (usesCardNft2DeliveryFees(dropFamily)) {
    return {
      kind: 'per-unit',
      baseLamports: isUs ? CARD_NFT_2_US_BASE_LAMPORTS : CARD_NFT_2_INTL_BASE_LAMPORTS,
      includedUnits: CARD_NFT_2_BASE_DELIVERY_CARD_COUNT,
      extraUnitLamports: CARD_NFT_2_EXTRA_LAMPORTS,
    };
  }
  return {
    kind: 'per-unit',
    baseLamports: INTL_DELIVERY_BASE_LAMPORTS,
    includedUnits: deliveryUnitsPerBox,
    extraUnitLamports: INTL_DELIVERY_EXTRA_LAMPORTS,
  };
}

export function calculateDeliveryLamports(
  items: ReadonlyArray<DeliveryItem>,
  countryCode?: string,
  itemsPerBox?: number,
  dropFamily?: DropFamily,
  invalidPolicy: InvalidDeliveryUnitsPolicy = 'fallback-one',
): number {
  const figureCount = countDeliveryFigures(items, itemsPerBox, invalidPolicy);
  if (figureCount <= 0) return 0;
  const pricing = resolveDeliveryPricing(countryCode, itemsPerBox, dropFamily, invalidPolicy);
  if (pricing.kind === 'free') return 0;
  if (pricing.kind === 'flat') return pricing.baseLamports;
  const extraFigures = Math.max(0, figureCount - pricing.includedUnits);
  return pricing.baseLamports + extraFigures * pricing.extraUnitLamports;
}
