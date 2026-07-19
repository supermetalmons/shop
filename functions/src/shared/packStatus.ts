import type {
  PackStatusBreakdown,
  PackStatusBreakdownItem,
} from './contracts.js';
import type { SolanaCluster } from './deploymentCore.js';
import {
  isAdminIrlRedeemDeliveryOrderSource,
  isStripeOffchainDeliveryOrderSource,
} from './fulfillmentSources.js';

export const PACK_STATUS_SCHEMA_VERSION = 1;
export const PACK_STATUS_DEFAULT_DROP_ID = 'card_nft_2';
export const PACK_STATUS_SUPPORTED_DROP_IDS = [
  'card_nft_2',
  'poncho_drifella',
  'little_swag_boxes',
] as const;
export const PACK_STATUS_DEFAULT_CARDS_PER_PACK = 3;

export type PackStatusDropRuntime = {
  dropId: string;
  cluster: SolanaCluster;
  itemsPerBox: number;
  maxSupply?: number;
};

export type PackStatusCounters = {
  dropId: string;
  totalInitialSupply: number;
  totalCards: number;
  cardsPerPack: number;
  unsealedOnline: number;
  redeemedIrlNormal: number;
  redeemedIrlStripe: number;
  redeemedUnsealedCards: number;
};

export type PackStatusCountResult = {
  counted: boolean;
  quantity: number;
};

export type PackStatusDeliveryOrderRecord = {
  status?: unknown;
  source?: unknown;
  items?: unknown;
  adminIrlRedeem?: unknown;
  metadataId?: unknown;
  metadataIds?: unknown;
  quantity?: unknown;
};

export type PackStatusRebuildInputs = {
  dropRuntime: PackStatusDropRuntime;
  assignmentCount: unknown;
  irlClaimAssignmentCount: unknown;
  adminIrlAssignmentCount?: unknown;
  inFlightNormalAssignments: unknown;
  deliveryOrders: PackStatusDeliveryOrderRecord[];
};

export type PackStatusStatsFields = {
  version: number;
  dropId: string;
  totalInitialSupply: number;
  totalCards: number;
  cardsPerPack: number;
  unsealedOnline: number;
  redeemedIrlNormal: number;
  redeemedIrlStripe: number;
  redeemedUnsealedCards: number;
};

const PACK_STATUS_SUPPORTED_DROP_ID_SET = new Set<string>(
  PACK_STATUS_SUPPORTED_DROP_IDS,
);

function safePackStatusInteger(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizePackStatusAmount(value: unknown): number {
  return Math.max(0, safePackStatusInteger(value));
}

function packStatusPercentage(amount: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((amount / total) * 10_000) / 100;
}

function packStatusUnsealedLabel(dropId: string): string {
  return dropId === 'little_swag_boxes' ? 'Unboxed' : 'Unpacked';
}

export function packStatusCardsPerPack(
  dropRuntime: Pick<PackStatusDropRuntime, 'itemsPerBox'> | undefined,
): number {
  return (
    normalizePackStatusAmount(dropRuntime?.itemsPerBox) ||
    PACK_STATUS_DEFAULT_CARDS_PER_PACK
  );
}

export function isPackStatusSupportedDropId(
  dropId: string | undefined,
): boolean {
  return PACK_STATUS_SUPPORTED_DROP_ID_SET.has(String(dropId || '').trim());
}

export function shouldTrackPackStatusForDrop(
  dropRuntime: PackStatusDropRuntime | undefined,
): boolean {
  return (
    isPackStatusSupportedDropId(dropRuntime?.dropId) &&
    dropRuntime?.cluster === 'mainnet-beta' &&
    normalizePackStatusAmount(dropRuntime?.itemsPerBox) > 0 &&
    normalizePackStatusAmount(dropRuntime?.maxSupply) > 0
  );
}

function packStatusItem(
  key: PackStatusBreakdownItem['key'],
  label: string,
  amount: number,
  total: number,
): PackStatusBreakdownItem {
  return {
    key,
    label,
    amount,
    percentage:
      key === 'total' && total > 0
        ? 100
        : packStatusPercentage(amount, total),
  };
}

export function buildPackStatusBreakdown(
  counters: PackStatusCounters,
): PackStatusBreakdown {
  const totalInitialSupply = normalizePackStatusAmount(
    counters.totalInitialSupply,
  );
  const cardsPerPack =
    normalizePackStatusAmount(counters.cardsPerPack) ||
    PACK_STATUS_DEFAULT_CARDS_PER_PACK;
  const totalCards =
    normalizePackStatusAmount(counters.totalCards) ||
    totalInitialSupply * cardsPerPack;
  const total = totalCards;
  const unsealedOnline = normalizePackStatusAmount(counters.unsealedOnline);
  const redeemedIrlNormal = normalizePackStatusAmount(
    counters.redeemedIrlNormal,
  );
  const redeemedIrlStripe = normalizePackStatusAmount(
    counters.redeemedIrlStripe,
  );
  const redeemedUnsealedCards = normalizePackStatusAmount(
    counters.redeemedUnsealedCards,
  );
  const redeemedIrl = redeemedIrlNormal + redeemedIrlStripe;
  const unsealedCards = unsealedOnline * cardsPerPack;
  const redeemedCards =
    redeemedIrl * cardsPerPack + redeemedUnsealedCards;
  const items = [
    packStatusItem(
      'unsealed',
      packStatusUnsealedLabel(counters.dropId),
      unsealedCards,
      total,
    ),
    packStatusItem('redeemed', 'Redeemed', redeemedCards, total),
    packStatusItem('total', 'Total', total, total),
  ];

  return {
    dropId: counters.dropId,
    total,
    totalInitialSupply,
    totalCards,
    cardsPerPack,
    unsealedOnline,
    unsealedCards,
    redeemedIrl,
    redeemedIrlNormal,
    redeemedIrlStripe,
    redeemedUnsealedCards,
    redeemedCards,
    items,
  };
}

/**
 * Validates a raw Firestore pack-status document and derives the same display
 * model used by Functions rebuilds.
 */
export function normalizePackStatusBreakdown(
  raw: unknown,
  dropId: string,
  fallbackCardsPerPack?: unknown,
): PackStatusBreakdown | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (normalizePackStatusAmount(record.version) !== PACK_STATUS_SCHEMA_VERSION) {
    return null;
  }
  if (
    typeof record.dropId === 'string' &&
    record.dropId &&
    record.dropId !== dropId
  ) {
    return null;
  }
  const totalInitialSupply = normalizePackStatusAmount(
    record.totalInitialSupply,
  );
  if (totalInitialSupply <= 0) return null;
  const cardsPerPack =
    normalizePackStatusAmount(record.cardsPerPack) ||
    normalizePackStatusAmount(fallbackCardsPerPack) ||
    PACK_STATUS_DEFAULT_CARDS_PER_PACK;

  return buildPackStatusBreakdown({
    dropId,
    totalInitialSupply,
    totalCards:
      normalizePackStatusAmount(record.totalCards) ||
      totalInitialSupply * cardsPerPack,
    cardsPerPack,
    unsealedOnline: normalizePackStatusAmount(record.unsealedOnline),
    redeemedIrlNormal: normalizePackStatusAmount(record.redeemedIrlNormal),
    redeemedIrlStripe: normalizePackStatusAmount(record.redeemedIrlStripe),
    redeemedUnsealedCards: normalizePackStatusAmount(
      record.redeemedUnsealedCards,
    ),
  });
}

function isDeliveryOrderBoxItem(
  item: unknown,
): item is { assetId?: unknown; kind: 'box' } {
  return Boolean(
    item &&
      typeof item === 'object' &&
      (item as Record<string, unknown>).kind === 'box',
  );
}

function deliveryOrderBoxItems(
  items: unknown,
): Array<{ assetId?: unknown; kind: 'box' }> {
  return Array.isArray(items) ? items.filter(isDeliveryOrderBoxItem) : [];
}

export function countDeliveryOrderBoxItems(items: unknown): number {
  return deliveryOrderBoxItems(items).length;
}

export function countDeliveryOrderDudeItems(items: unknown): number {
  return Array.isArray(items)
    ? items.filter(
        (item) =>
          item &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).kind === 'dude',
      ).length
    : 0;
}

export function deliveryOrderBoxAssetIds(items: unknown): string[] {
  return deliveryOrderBoxItems(items)
    .map((item) =>
      typeof item.assetId === 'string' ? item.assetId.trim() : '',
    )
    .filter(Boolean);
}

function stripeIrlPackQuantityFromOrder(
  order: PackStatusDeliveryOrderRecord,
): number {
  const metadataIds = Array.isArray(order?.metadataIds)
    ? order.metadataIds
        .map((id) => safePackStatusInteger(id))
        .filter((id) => id > 0)
    : [];
  if (metadataIds.length) return metadataIds.length;
  if (normalizePackStatusAmount(order?.metadataId) > 0) return 1;
  return normalizePackStatusAmount(order?.quantity);
}

function isStripeOffchainOrder(
  order: PackStatusDeliveryOrderRecord,
): boolean {
  return isStripeOffchainDeliveryOrderSource(order?.source);
}

function isAdminIrlDirectCardReceiptOrder(
  order: PackStatusDeliveryOrderRecord,
): boolean {
  return (
    isAdminIrlRedeemDeliveryOrderSource(order?.source) &&
    (order.adminIrlRedeem as { targetKind?: unknown } | undefined)
      ?.targetKind === 'card_receipt'
  );
}

export function buildPackStatusCountersFromRebuildInputs(
  params: PackStatusRebuildInputs,
): PackStatusCounters {
  let redeemedIrlNormal = 0;
  let redeemedIrlStripe = 0;
  let redeemedUnsealedCards = 0;
  for (const order of params.deliveryOrders) {
    if (order?.status !== 'ready_to_ship') continue;
    // This order moves an existing receipt NFT; its underlying card was counted
    // when that receipt was originally issued.
    if (isAdminIrlDirectCardReceiptOrder(order)) continue;
    if (isStripeOffchainOrder(order)) {
      redeemedIrlStripe += stripeIrlPackQuantityFromOrder(order);
    } else {
      redeemedIrlNormal += countDeliveryOrderBoxItems(order?.items);
      redeemedUnsealedCards += countDeliveryOrderDudeItems(order?.items);
    }
  }
  const cardsPerPack = packStatusCardsPerPack(params.dropRuntime);
  const totalInitialSupply = normalizePackStatusAmount(
    params.dropRuntime.maxSupply,
  );

  return {
    dropId: params.dropRuntime.dropId,
    totalInitialSupply,
    totalCards: totalInitialSupply * cardsPerPack,
    cardsPerPack,
    unsealedOnline: Math.max(
      0,
      normalizePackStatusAmount(params.assignmentCount) -
        normalizePackStatusAmount(params.irlClaimAssignmentCount) -
        normalizePackStatusAmount(params.adminIrlAssignmentCount) -
        normalizePackStatusAmount(params.inFlightNormalAssignments),
    ),
    redeemedIrlNormal,
    redeemedIrlStripe,
    redeemedUnsealedCards,
  };
}

export function buildPackStatusStatsFields(
  counters: PackStatusCounters,
): PackStatusStatsFields {
  const totalInitialSupply = normalizePackStatusAmount(
    counters.totalInitialSupply,
  );
  const cardsPerPack =
    normalizePackStatusAmount(counters.cardsPerPack) ||
    PACK_STATUS_DEFAULT_CARDS_PER_PACK;
  const totalCards =
    normalizePackStatusAmount(counters.totalCards) ||
    totalInitialSupply * cardsPerPack;

  return {
    version: PACK_STATUS_SCHEMA_VERSION,
    dropId: counters.dropId,
    totalInitialSupply,
    totalCards,
    cardsPerPack,
    unsealedOnline: normalizePackStatusAmount(counters.unsealedOnline),
    redeemedIrlNormal: normalizePackStatusAmount(
      counters.redeemedIrlNormal,
    ),
    redeemedIrlStripe: normalizePackStatusAmount(
      counters.redeemedIrlStripe,
    ),
    redeemedUnsealedCards: normalizePackStatusAmount(
      counters.redeemedUnsealedCards,
    ),
  };
}
