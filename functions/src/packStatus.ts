import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { dropBoxAssignmentPath, dropPackStatusPath, dropRootPath } from './dropPaths.js';
import { IRL_CLAIM_CODE_NAMESPACE } from './claimCodes.js';
import {
  PACK_STATUS_DEFAULT_DROP_ID,
  PACK_STATUS_SCHEMA_VERSION,
  PACK_STATUS_SUPPORTED_DROP_IDS,
  buildPackStatusBreakdown,
  buildPackStatusCountersFromRebuildInputs,
  buildPackStatusStatsFields,
  countDeliveryOrderBoxItems,
  countDeliveryOrderDudeItems,
  deliveryOrderBoxAssetIds,
  isPackStatusSupportedDropId,
  normalizePackStatusAmount,
  normalizePackStatusBreakdown,
  packStatusCardsPerPack,
  shouldTrackPackStatusForDrop,
} from './shared/packStatus.js';
import type {
  PackStatusCountResult,
  PackStatusCounters,
  PackStatusDeliveryOrderRecord,
  PackStatusDropRuntime,
} from './shared/packStatus.js';

export {
  PACK_STATUS_DEFAULT_DROP_ID,
  PACK_STATUS_SUPPORTED_DROP_IDS,
  buildPackStatusBreakdown,
  buildPackStatusCountersFromRebuildInputs,
  countDeliveryOrderBoxItems,
  countDeliveryOrderDudeItems,
  deliveryOrderBoxAssetIds,
  isPackStatusSupportedDropId,
  normalizePackStatusBreakdown,
  shouldTrackPackStatusForDrop,
};
export type {
  PackStatusCountResult,
  PackStatusCounters,
  PackStatusDeliveryOrderRecord,
  PackStatusDropRuntime,
};
export type { PackStatusBreakdown } from './shared/contracts.js';
export type { PackStatusRebuildInputs } from './shared/packStatus.js';

type PackStatusEventType = 'onlineReveal' | 'redeemedIrlNormal' | 'redeemedIrlStripe';
type PackStatusCounterIncrement = {
  field: 'unsealedOnline' | 'redeemedIrlNormal' | 'redeemedIrlStripe' | 'redeemedUnsealedCards';
  quantity: number;
};

function packStatusIncrementCardQuantity(increment: PackStatusCounterIncrement, cardsPerPack: number): number {
  const quantity = normalizePackStatusAmount(increment.quantity);
  return increment.field === 'redeemedUnsealedCards' ? quantity : quantity * cardsPerPack;
}

export function packStatusStatsRef(db: Pick<Firestore, 'doc'>, dropId: string): DocumentReference {
  return db.doc(dropPackStatusPath(dropId));
}

function packStatusEventRef(db: Pick<Firestore, 'doc'>, dropId: string, type: PackStatusEventType, eventKey: string): DocumentReference {
  return db.doc(`${dropRootPath(dropId)}/packStatusEvents/${type}_${encodeURIComponent(eventKey)}`);
}

export function buildPackStatusStatsDocument(counters: PackStatusCounters): Record<string, unknown> {
  return {
    ...buildPackStatusStatsFields(counters),
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
      quantity: normalizePackStatusAmount(increment.quantity),
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
