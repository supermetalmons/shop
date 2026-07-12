import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import type { SolanaCluster } from './config/deployment.js';
import { dropBoxAssignmentPath, dropPackStatusPath, dropRootPath } from './dropPaths.js';
import { IRL_CLAIM_CODE_NAMESPACE } from './claimCodes.js';
import {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
  STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
} from './stripeCheckout/contract.js';

export const PACK_STATUS_SCHEMA_VERSION = 1;
export const PACK_STATUS_DEFAULT_DROP_ID = 'card_nft_2';
export const PACK_STATUS_SUPPORTED_DROP_IDS = ['card_nft_2', 'poncho_drifella', 'little_swag_boxes'] as const;
export const PACK_STATUS_DEFAULT_CARDS_PER_PACK = 3;

export type PackStatusDropRuntime = {
  dropId: string;
  cluster: SolanaCluster;
  itemsPerBox: number;
  maxSupply?: number;
};

export type PackStatusBreakdownItem = {
  key: 'redeemed' | 'unsealed' | 'total';
  label: string;
  amount: number;
  percentage: number;
};

export type PackStatusBreakdown = {
  dropId: string;
  total: number;
  totalInitialSupply: number;
  totalCards: number;
  cardsPerPack: number;
  unsealedOnline: number;
  unsealedCards: number;
  redeemedIrl: number;
  redeemedIrlNormal: number;
  redeemedIrlStripe: number;
  redeemedUnsealedCards: number;
  redeemedCards: number;
  items: PackStatusBreakdownItem[];
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

type PackStatusEventType = 'onlineReveal' | 'redeemedIrlNormal' | 'redeemedIrlStripe';
type PackStatusCounterIncrement = {
  field: 'unsealedOnline' | 'redeemedIrlNormal' | 'redeemedIrlStripe' | 'redeemedUnsealedCards';
  quantity: number;
};

const PACK_STATUS_SUPPORTED_DROP_ID_SET = new Set<string>(PACK_STATUS_SUPPORTED_DROP_IDS);

function packStatusIncrementCardQuantity(increment: PackStatusCounterIncrement, cardsPerPack: number): number {
  const quantity = safeNonNegativeInteger(increment.quantity);
  return increment.field === 'redeemedUnsealedCards' ? quantity : quantity * cardsPerPack;
}

function safeInteger(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeNonNegativeInteger(value: unknown): number {
  return Math.max(0, safeInteger(value));
}

function percentage(amount: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((amount / total) * 10_000) / 100;
}

function packStatusUnsealedLabel(dropId: string): string {
  return dropId === 'little_swag_boxes' ? 'Unboxed' : 'Unpacked';
}

export function packStatusCardsPerPack(dropRuntime: Pick<PackStatusDropRuntime, 'itemsPerBox'> | undefined): number {
  return safeNonNegativeInteger(dropRuntime?.itemsPerBox) || PACK_STATUS_DEFAULT_CARDS_PER_PACK;
}

export function isPackStatusSupportedDropId(dropId: string | undefined): boolean {
  return PACK_STATUS_SUPPORTED_DROP_ID_SET.has(String(dropId || '').trim());
}

export function shouldTrackPackStatusForDrop(dropRuntime: PackStatusDropRuntime | undefined): boolean {
  return (
    isPackStatusSupportedDropId(dropRuntime?.dropId) &&
    dropRuntime?.cluster === 'mainnet-beta' &&
    safeNonNegativeInteger(dropRuntime?.itemsPerBox) > 0 &&
    safeNonNegativeInteger(dropRuntime?.maxSupply) > 0
  );
}

export function packStatusStatsRef(db: Pick<Firestore, 'doc'>, dropId: string): DocumentReference {
  return db.doc(dropPackStatusPath(dropId));
}

function packStatusEventRef(db: Pick<Firestore, 'doc'>, dropId: string, type: PackStatusEventType, eventKey: string): DocumentReference {
  return db.doc(`${dropRootPath(dropId)}/packStatusEvents/${type}_${encodeURIComponent(eventKey)}`);
}

function isDeliveryOrderBoxItem(item: unknown): item is { assetId?: unknown; kind: 'box' } {
  return Boolean(item && typeof item === 'object' && (item as any).kind === 'box');
}

function deliveryOrderBoxItems(items: unknown): Array<{ assetId?: unknown; kind: 'box' }> {
  return Array.isArray(items) ? items.filter(isDeliveryOrderBoxItem) : [];
}

export function countDeliveryOrderBoxItems(items: unknown): number {
  return deliveryOrderBoxItems(items).length;
}

export function countDeliveryOrderDudeItems(items: unknown): number {
  return Array.isArray(items) ? items.filter((item) => item && typeof item === 'object' && (item as any).kind === 'dude').length : 0;
}

export function deliveryOrderBoxAssetIds(items: unknown): string[] {
  return deliveryOrderBoxItems(items)
    .map((item) => (typeof item.assetId === 'string' ? item.assetId.trim() : ''))
    .filter(Boolean);
}

export function stripeIrlPackQuantityFromOrder(order: any): number {
  const metadataIds = Array.isArray(order?.metadataIds)
    ? order.metadataIds.map((id: unknown) => safeInteger(id)).filter((id: number) => id > 0)
    : [];
  if (metadataIds.length) return metadataIds.length;
  if (safeNonNegativeInteger(order?.metadataId) > 0) return 1;
  return safeNonNegativeInteger(order?.quantity);
}

function isStripeOffchainOrder(order: any): boolean {
  return order?.source === STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE;
}

function isAdminIrlDirectCardReceiptOrder(order: any): boolean {
  return (
    order?.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE &&
    order?.adminIrlRedeem?.targetKind === 'card_receipt'
  );
}

export function buildPackStatusBreakdown(counters: PackStatusCounters): PackStatusBreakdown {
  const totalInitialSupply = safeNonNegativeInteger(counters.totalInitialSupply);
  const cardsPerPack = safeNonNegativeInteger(counters.cardsPerPack) || PACK_STATUS_DEFAULT_CARDS_PER_PACK;
  const totalCards = safeNonNegativeInteger(counters.totalCards) || totalInitialSupply * cardsPerPack;
  const total = totalCards;
  const unsealedOnline = safeNonNegativeInteger(counters.unsealedOnline);
  const redeemedIrlNormal = safeNonNegativeInteger(counters.redeemedIrlNormal);
  const redeemedIrlStripe = safeNonNegativeInteger(counters.redeemedIrlStripe);
  const redeemedUnsealedCards = safeNonNegativeInteger(counters.redeemedUnsealedCards);
  const redeemedIrl = redeemedIrlNormal + redeemedIrlStripe;
  const unsealedCards = unsealedOnline * cardsPerPack;
  const redeemedCards = redeemedIrl * cardsPerPack + redeemedUnsealedCards;
  const items: PackStatusBreakdownItem[] = [
    {
      key: 'unsealed',
      label: packStatusUnsealedLabel(counters.dropId),
      amount: unsealedCards,
      percentage: percentage(unsealedCards, total),
    },
    {
      key: 'redeemed',
      label: 'Redeemed',
      amount: redeemedCards,
      percentage: percentage(redeemedCards, total),
    },
    {
      key: 'total',
      label: 'Total',
      amount: total,
      percentage: total > 0 ? 100 : 0,
    },
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

export function buildPackStatusCountersFromRebuildInputs(params: PackStatusRebuildInputs): PackStatusCounters {
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
  const totalInitialSupply = safeNonNegativeInteger(params.dropRuntime.maxSupply);

  return {
    dropId: params.dropRuntime.dropId,
    totalInitialSupply,
    totalCards: totalInitialSupply * cardsPerPack,
    cardsPerPack,
    unsealedOnline: Math.max(
      0,
      safeNonNegativeInteger(params.assignmentCount) -
        safeNonNegativeInteger(params.irlClaimAssignmentCount) -
        safeNonNegativeInteger(params.adminIrlAssignmentCount) -
        safeNonNegativeInteger(params.inFlightNormalAssignments),
    ),
    redeemedIrlNormal,
    redeemedIrlStripe,
    redeemedUnsealedCards,
  };
}

export function buildPackStatusStatsDocument(counters: PackStatusCounters): Record<string, unknown> {
  const totalInitialSupply = safeNonNegativeInteger(counters.totalInitialSupply);
  const cardsPerPack = safeNonNegativeInteger(counters.cardsPerPack) || PACK_STATUS_DEFAULT_CARDS_PER_PACK;
  const totalCards = safeNonNegativeInteger(counters.totalCards) || totalInitialSupply * cardsPerPack;
  return {
    version: PACK_STATUS_SCHEMA_VERSION,
    dropId: counters.dropId,
    totalInitialSupply,
    totalCards,
    cardsPerPack,
    unsealedOnline: safeNonNegativeInteger(counters.unsealedOnline),
    redeemedIrlNormal: safeNonNegativeInteger(counters.redeemedIrlNormal),
    redeemedIrlStripe: safeNonNegativeInteger(counters.redeemedIrlStripe),
    redeemedUnsealedCards: safeNonNegativeInteger(counters.redeemedUnsealedCards),
    rebuiltAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export function assignmentHasNormalInFlightPackStatusClaim(assignment: any): boolean {
  return assignment?.irlClaim?.namespace !== IRL_CLAIM_CODE_NAMESPACE;
}

async function countPackStatusEvent(params: {
  db: Firestore;
  dropRuntime: PackStatusDropRuntime;
  type: PackStatusEventType;
  eventKey: string;
  increments: PackStatusCounterIncrement[];
  extraEventData?: Record<string, unknown>;
}): Promise<PackStatusCountResult> {
  const { db, dropRuntime } = params;
  if (!shouldTrackPackStatusForDrop(dropRuntime)) return { counted: false, quantity: 0 };
  const increments = params.increments
    .map((increment) => ({
      field: increment.field,
      quantity: safeNonNegativeInteger(increment.quantity),
    }))
    .filter((increment) => increment.quantity > 0);
  const eventKey = String(params.eventKey || '').trim();
  if (!eventKey || !increments.length) return { counted: false, quantity: 0 };
  const cardsPerPack = packStatusCardsPerPack(dropRuntime);
  const quantity = increments.reduce((total, increment) => total + packStatusIncrementCardQuantity(increment, cardsPerPack), 0);

  const statsRef = packStatusStatsRef(db, dropRuntime.dropId);
  const eventRef = packStatusEventRef(db, dropRuntime.dropId, params.type, eventKey);
  return db.runTransaction(async (tx) => {
    const eventSnap = await tx.get(eventRef);
    if (eventSnap.exists) return { counted: false, quantity: 0 };

    tx.update(statsRef, {
      ...Object.fromEntries(increments.map((increment) => [increment.field, FieldValue.increment(increment.quantity)])),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(eventRef, {
      version: PACK_STATUS_SCHEMA_VERSION,
      dropId: dropRuntime.dropId,
      type: params.type,
      eventKey,
      quantity,
      increments: Object.fromEntries(increments.map((increment) => [increment.field, increment.quantity])),
      ...(params.extraEventData ?? {}),
      createdAt: FieldValue.serverTimestamp(),
    });
    return { counted: true, quantity };
  });
}

export function countOnlineRevealPackStatus(params: {
  db: Firestore;
  dropRuntime: PackStatusDropRuntime;
  boxAssetId: string;
  signature?: string;
}): Promise<PackStatusCountResult> {
  const boxAssetId = String(params.boxAssetId || '').trim();
  return countPackStatusEvent({
    db: params.db,
    dropRuntime: params.dropRuntime,
    type: 'onlineReveal',
    eventKey: boxAssetId,
    increments: [{ field: 'unsealedOnline', quantity: 1 }],
    extraEventData: {
      boxAssetId,
      ...(params.signature ? { signature: params.signature } : {}),
    },
  });
}

export function countNormalIrlPackStatus(params: {
  db: Firestore;
  dropRuntime: PackStatusDropRuntime;
  deliveryId: number;
  packQuantity: number;
  unsealedCardQuantity: number;
}): Promise<PackStatusCountResult> {
  const deliveryId = Math.floor(Number(params.deliveryId));
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) return Promise.resolve({ counted: false, quantity: 0 });
  return countPackStatusEvent({
    db: params.db,
    dropRuntime: params.dropRuntime,
    type: 'redeemedIrlNormal',
    eventKey: String(deliveryId),
    increments: [
      { field: 'redeemedIrlNormal', quantity: params.packQuantity },
      { field: 'redeemedUnsealedCards', quantity: params.unsealedCardQuantity },
    ],
    extraEventData: {
      deliveryId,
    },
  });
}

export function countStripeIrlPackStatus(params: {
  db: Firestore;
  dropRuntime: PackStatusDropRuntime;
  orderHashHex: string;
  quantity: number;
  deliveryId?: number;
  checkoutSessionId?: string;
}): Promise<PackStatusCountResult> {
  const orderHashHex = String(params.orderHashHex || '').trim();
  return countPackStatusEvent({
    db: params.db,
    dropRuntime: params.dropRuntime,
    type: 'redeemedIrlStripe',
    eventKey: orderHashHex,
    increments: [{ field: 'redeemedIrlStripe', quantity: params.quantity }],
    extraEventData: {
      orderHashHex,
      ...(params.deliveryId ? { deliveryId: params.deliveryId } : {}),
      ...(params.checkoutSessionId ? { checkoutSessionId: params.checkoutSessionId } : {}),
    },
  });
}

export function packStatusAssignmentRef(db: Pick<Firestore, 'doc'>, dropId: string, boxAssetId: string): DocumentReference {
  return db.doc(dropBoxAssignmentPath(dropId, boxAssetId));
}
