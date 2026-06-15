import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import type { SolanaCluster } from './config/deployment.js';
import { dropBoxAssignmentPath, dropPackStatusPath, dropRootPath } from './dropPaths.js';
import { IRL_CLAIM_CODE_NAMESPACE } from './claimCodes.js';

export const PACK_STATUS_SCHEMA_VERSION = 1;
export const PACK_STATUS_SUPPORTED_DROP_ID = 'card_nft_2';

export type PackStatusDropRuntime = {
  dropId: string;
  cluster: SolanaCluster;
  maxSupply?: number;
};

export type PackStatusBreakdownItem = {
  key: 'unsealed_online' | 'redeemed_irl' | 'sealed' | 'total';
  label: string;
  amount: number;
  percentage: number;
};

export type PackStatusBreakdown = {
  dropId: string;
  total: number;
  unsealedOnline: number;
  redeemedIrl: number;
  redeemedIrlNormal: number;
  redeemedIrlStripe: number;
  sealed: number;
  items: PackStatusBreakdownItem[];
};

export type PackStatusCounters = {
  dropId: string;
  totalInitialSupply: number;
  unsealedOnline: number;
  redeemedIrlNormal: number;
  redeemedIrlStripe: number;
};

export type PackStatusCountResult = {
  counted: boolean;
  quantity: number;
};

export type PackStatusDeliveryOrderRecord = {
  status?: unknown;
  source?: unknown;
  items?: unknown;
  metadataId?: unknown;
  metadataIds?: unknown;
  quantity?: unknown;
};

export type PackStatusRebuildInputs = {
  dropRuntime: PackStatusDropRuntime;
  assignmentCount: unknown;
  irlClaimAssignmentCount: unknown;
  inFlightNormalAssignments: unknown;
  deliveryOrders: PackStatusDeliveryOrderRecord[];
};

type PackStatusEventType = 'onlineReveal' | 'redeemedIrlNormal' | 'redeemedIrlStripe';
type PackStatusCounterField = 'unsealedOnline' | 'redeemedIrlNormal' | 'redeemedIrlStripe';

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

export function shouldTrackPackStatusForDrop(dropRuntime: PackStatusDropRuntime | undefined): boolean {
  return (
    dropRuntime?.dropId === PACK_STATUS_SUPPORTED_DROP_ID &&
    dropRuntime?.cluster === 'mainnet-beta' &&
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
  return order?.source === 'stripe_offchain';
}

export function buildPackStatusBreakdown(counters: PackStatusCounters): PackStatusBreakdown {
  const total = safeNonNegativeInteger(counters.totalInitialSupply);
  const unsealedOnline = safeNonNegativeInteger(counters.unsealedOnline);
  const redeemedIrlNormal = safeNonNegativeInteger(counters.redeemedIrlNormal);
  const redeemedIrlStripe = safeNonNegativeInteger(counters.redeemedIrlStripe);
  const redeemedIrl = redeemedIrlNormal + redeemedIrlStripe;
  const sealed = Math.max(0, total - unsealedOnline - redeemedIrl);
  const items: PackStatusBreakdownItem[] = [
    {
      key: 'unsealed_online',
      label: 'Unsealed online',
      amount: unsealedOnline,
      percentage: percentage(unsealedOnline, total),
    },
    {
      key: 'redeemed_irl',
      label: 'Redeemed IRL',
      amount: redeemedIrl,
      percentage: percentage(redeemedIrl, total),
    },
    {
      key: 'sealed',
      label: 'Sealed',
      amount: sealed,
      percentage: percentage(sealed, total),
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
    unsealedOnline,
    redeemedIrl,
    redeemedIrlNormal,
    redeemedIrlStripe,
    sealed,
    items,
  };
}

export function buildPackStatusCountersFromRebuildInputs(params: PackStatusRebuildInputs): PackStatusCounters {
  let redeemedIrlNormal = 0;
  let redeemedIrlStripe = 0;
  for (const order of params.deliveryOrders) {
    if (order?.status !== 'ready_to_ship') continue;
    if (isStripeOffchainOrder(order)) {
      redeemedIrlStripe += stripeIrlPackQuantityFromOrder(order);
    } else {
      redeemedIrlNormal += countDeliveryOrderBoxItems(order?.items);
    }
  }

  return {
    dropId: params.dropRuntime.dropId,
    totalInitialSupply: safeNonNegativeInteger(params.dropRuntime.maxSupply),
    unsealedOnline: Math.max(
      0,
      safeNonNegativeInteger(params.assignmentCount) -
        safeNonNegativeInteger(params.irlClaimAssignmentCount) -
        safeNonNegativeInteger(params.inFlightNormalAssignments),
    ),
    redeemedIrlNormal,
    redeemedIrlStripe,
  };
}

export function buildPackStatusStatsDocument(counters: PackStatusCounters): Record<string, unknown> {
  return {
    version: PACK_STATUS_SCHEMA_VERSION,
    dropId: counters.dropId,
    totalInitialSupply: safeNonNegativeInteger(counters.totalInitialSupply),
    unsealedOnline: safeNonNegativeInteger(counters.unsealedOnline),
    redeemedIrlNormal: safeNonNegativeInteger(counters.redeemedIrlNormal),
    redeemedIrlStripe: safeNonNegativeInteger(counters.redeemedIrlStripe),
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
  counterField: PackStatusCounterField;
  quantity: number;
  extraEventData?: Record<string, unknown>;
}): Promise<PackStatusCountResult> {
  const { db, dropRuntime } = params;
  if (!shouldTrackPackStatusForDrop(dropRuntime)) return { counted: false, quantity: 0 };
  const quantity = safeNonNegativeInteger(params.quantity);
  const eventKey = String(params.eventKey || '').trim();
  if (!eventKey || quantity <= 0) return { counted: false, quantity: 0 };

  const statsRef = packStatusStatsRef(db, dropRuntime.dropId);
  const eventRef = packStatusEventRef(db, dropRuntime.dropId, params.type, eventKey);
  return db.runTransaction(async (tx) => {
    const eventSnap = await tx.get(eventRef);
    if (eventSnap.exists) return { counted: false, quantity: 0 };

    tx.update(statsRef, {
      [params.counterField]: FieldValue.increment(quantity),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(eventRef, {
      version: PACK_STATUS_SCHEMA_VERSION,
      dropId: dropRuntime.dropId,
      type: params.type,
      eventKey,
      quantity,
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
    counterField: 'unsealedOnline',
    quantity: 1,
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
  quantity: number;
}): Promise<PackStatusCountResult> {
  const deliveryId = Math.floor(Number(params.deliveryId));
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) return Promise.resolve({ counted: false, quantity: 0 });
  return countPackStatusEvent({
    db: params.db,
    dropRuntime: params.dropRuntime,
    type: 'redeemedIrlNormal',
    eventKey: String(deliveryId),
    counterField: 'redeemedIrlNormal',
    quantity: params.quantity,
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
    counterField: 'redeemedIrlStripe',
    quantity: params.quantity,
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
