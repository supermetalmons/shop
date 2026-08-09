import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PublicKey } from '@solana/web3.js';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { normalizeOptionalFulfillmentTrackingCode } from './fulfillmentTracking.js';
import { normalizeFulfillmentStatus } from './fulfillmentStatus.js';
import {
  parseDropDeliveryOrderPath,
  type DropDeliveryOrderPathIdentity,
} from './dropPaths.js';
import {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
  STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
} from './shared/fulfillmentSources.js';
import { normalizeDropId } from './shared/deploymentCore.js';
import type {
  DeliveryOrderItemSummary,
  DeliveryOrderSummary,
  ProfileShipment,
} from './shared/contracts.js';
import { parsePositiveSafeInteger } from './shared/positiveInteger.js';
import { toMillisMaybe } from './time.js';

export const DELIVERY_ORDER_SUMMARY_FIELDS = [
  'dropId',
  'deliveryId',
  'source',
  'status',
  'stripeCheckoutSessionId',
  'createdAt',
  'processingAt',
  'processedAt',
  'items',
  'fulfillmentStatus',
  'fulfillmentTrackingCode',
  'fulfillmentUpdatedAt',
] as const;

const PROFILE_SHIPMENT_STATUSES = new Set(['processing', 'ready_to_ship']);

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeDropIdMaybe(rawDropId: unknown): string | null {
  if (typeof rawDropId !== 'string' || !rawDropId.trim()) return null;
  const dropId = normalizeDropId(rawDropId);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(dropId) ? dropId : null;
}

function finiteMillisMaybe(value: unknown): number | undefined {
  const millis = toMillisMaybe(value);
  return typeof millis === 'number' && Number.isFinite(millis) ? millis : undefined;
}

export type DeliveryOrderIdentityResolution =
  | { identity: DropDeliveryOrderPathIdentity }
  | { reason: 'invalid_path' | 'invalid_delivery_id' | 'delivery_id_mismatch' };

export function resolveDeliveryOrderIdentity(
  docId: string,
  order: unknown,
  path: string,
): DeliveryOrderIdentityResolution {
  const parts = String(path || '').split('/');
  if (
    parts.length !== 4 ||
    parts[0] !== 'drops' ||
    !parts[1] ||
    parts[2] !== 'deliveryOrders'
  ) {
    return { reason: 'invalid_path' };
  }
  const pathIdentity = parseDropDeliveryOrderPath(path);
  if (!pathIdentity) return { reason: 'invalid_delivery_id' };
  const dropId = normalizeDropIdMaybe(pathIdentity.dropId);
  if (!dropId) return { reason: 'invalid_path' };
  if (docId !== pathIdentity.documentId) return { reason: 'delivery_id_mismatch' };

  const storedDeliveryId = (order as any)?.deliveryId;
  if (storedDeliveryId !== undefined) {
    const parsedStoredDeliveryId = parsePositiveSafeInteger(storedDeliveryId);
    if (parsedStoredDeliveryId === null) return { reason: 'invalid_delivery_id' };
    if (parsedStoredDeliveryId !== pathIdentity.deliveryId) return { reason: 'delivery_id_mismatch' };
  }
  return {
    identity: {
      dropId,
      documentId: pathIdentity.documentId,
      deliveryId: pathIdentity.deliveryId,
    },
  };
}

export function dropIdFromDeliveryOrderPath(path: string): string | null {
  const identity = parseDropDeliveryOrderPath(path);
  return identity ? normalizeDropIdMaybe(identity.dropId) : null;
}

export function resolveDeliveryOrderDropId(order: unknown, docPath: string): string | null {
  return normalizeDropIdMaybe((order as any)?.dropId) || dropIdFromDeliveryOrderPath(docPath);
}

export function toDeliveryOrderSummary(docId: string, order: any, docPath: string): DeliveryOrderSummary | null {
  if (order?.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) return null;

  const resolution = resolveDeliveryOrderIdentity(docId, order, docPath);
  if (!('identity' in resolution)) return null;
  const { deliveryId, dropId } = resolution.identity;
  if (order?.dropId !== undefined && normalizeDropIdMaybe(order.dropId) !== dropId) return null;

  const itemsRaw = Array.isArray(order?.items) ? order.items : [];
  const items = itemsRaw
    .filter((item: any) => item && (item.kind === 'box' || item.kind === 'dude'))
    .map((item: any) => ({
      kind: item.kind as 'box' | 'dude',
      refId: Math.floor(Number(item.refId)),
    }))
    .filter((item: DeliveryOrderItemSummary) => Number.isSafeInteger(item.refId) && item.refId > 0);

  return {
    dropId,
    deliveryId,
    status: typeof order?.status === 'string' ? order.status : 'unknown',
    stripeCheckoutSessionId: optionalTrimmedString(order?.stripeCheckoutSessionId),
    createdAt: finiteMillisMaybe(order?.createdAt),
    processingAt: finiteMillisMaybe(order?.processingAt),
    processedAt: finiteMillisMaybe(order?.processedAt),
    items,
    fulfillmentStatus: normalizeFulfillmentStatus(order?.fulfillmentStatus),
    fulfillmentTrackingCode: normalizeOptionalFulfillmentTrackingCode(order?.fulfillmentTrackingCode),
    fulfillmentUpdatedAt: finiteMillisMaybe(order?.fulfillmentUpdatedAt),
  };
}

export function toDeliveryOrderSummaries(
  docs: Array<{ id: string; data(): any; ref: { path: string } }>,
): DeliveryOrderSummary[] {
  return docs
    .map((doc) => toDeliveryOrderSummary(doc.id, doc.data(), doc.ref.path))
    .filter((entry): entry is DeliveryOrderSummary => Boolean(entry));
}

export function profileShipmentDocumentId(sourceOrderPath: string): string {
  const path = String(sourceOrderPath || '').trim();
  if (!path) throw new Error('Delivery order path is required');
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

function normalizeProfileShipmentOwner(owner: unknown): string | null {
  if (typeof owner !== 'string' || !owner.trim()) return null;
  try {
    return new PublicKey(owner.trim()).toBase58();
  } catch {
    return null;
  }
}

function definedSummaryFields(summary: DeliveryOrderSummary): DeliveryOrderSummary {
  return {
    dropId: summary.dropId,
    deliveryId: summary.deliveryId,
    status: summary.status,
    ...(summary.stripeCheckoutSessionId ? { stripeCheckoutSessionId: summary.stripeCheckoutSessionId } : {}),
    ...(summary.createdAt != null ? { createdAt: summary.createdAt } : {}),
    ...(summary.processingAt != null ? { processingAt: summary.processingAt } : {}),
    ...(summary.processedAt != null ? { processedAt: summary.processedAt } : {}),
    items: summary.items,
    ...(summary.fulfillmentStatus ? { fulfillmentStatus: summary.fulfillmentStatus } : {}),
    ...(summary.fulfillmentTrackingCode ? { fulfillmentTrackingCode: summary.fulfillmentTrackingCode } : {}),
    ...(summary.fulfillmentUpdatedAt != null ? { fulfillmentUpdatedAt: summary.fulfillmentUpdatedAt } : {}),
  };
}

export type ProfileShipmentTarget = {
  ownerWallet: string;
  documentId: string;
  data: ProfileShipment;
};

type ProfileShipmentInvalidSourceReason =
  | 'invalid_path'
  | 'invalid_owner'
  | 'invalid_summary'
  | 'drop_id_mismatch'
  | 'invalid_delivery_id'
  | 'delivery_id_mismatch';

export type ProfileShipmentSourceClassification =
  | { kind: 'projected'; projection: ProfileShipmentTarget }
  | { kind: 'excluded' }
  | {
      kind: 'invalid';
      reason: ProfileShipmentInvalidSourceReason;
    };

export function classifyProfileShipmentSource(
  docId: string,
  order: any,
  docPath: string,
): ProfileShipmentSourceClassification {
  const identity = resolveDeliveryOrderIdentity(docId, order, docPath);
  if (!('identity' in identity)) return { kind: 'invalid', reason: identity.reason };
  const physicalDropId = identity.identity.dropId;
  if (order?.dropId !== undefined) {
    const storedDropId = normalizeDropIdMaybe(order.dropId);
    if (!storedDropId) return { kind: 'invalid', reason: 'invalid_summary' };
    if (storedDropId !== physicalDropId) {
      return { kind: 'invalid', reason: 'drop_id_mismatch' };
    }
  }
  if (!PROFILE_SHIPMENT_STATUSES.has(order?.status)) return { kind: 'excluded' };
  if (order?.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) return { kind: 'excluded' };
  const ownerWallet = normalizeProfileShipmentOwner(order?.owner);
  if (!ownerWallet) {
    const owner = optionalTrimmedString(order?.owner);
    if (
      order?.source === STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE &&
      owner?.startsWith('firebase:') &&
      owner.length > 'firebase:'.length
    ) {
      return { kind: 'excluded' };
    }
    return { kind: 'invalid', reason: 'invalid_owner' };
  }
  const summary = toDeliveryOrderSummary(docId, order, docPath);
  if (!summary) return { kind: 'invalid', reason: 'invalid_summary' };
  const data = definedSummaryFields(summary);
  return {
    kind: 'projected',
    projection: {
      ownerWallet,
      documentId: profileShipmentDocumentId(docPath),
      data: {
        ...data,
        sortAt: data.processedAt ?? data.processingAt ?? data.createdAt ?? 0,
      },
    },
  };
}

export function buildProfileShipment(
  docId: string,
  order: any,
  docPath: string,
): ProfileShipmentTarget | null {
  const classification = classifyProfileShipmentSource(docId, order, docPath);
  return classification.kind === 'projected' ? classification.projection : null;
}

export type ProfileShipmentSyncPlan = {
  deletes: Array<Pick<ProfileShipmentTarget, 'ownerWallet' | 'documentId'>>;
  upsert: ProfileShipmentTarget | null;
};

export function profileShipmentMatchesProjection(stored: unknown, expected: ProfileShipment): boolean {
  return isDeepStrictEqual(stored, expected);
}

function profileShipmentTargetKey(target: Pick<ProfileShipmentTarget, 'ownerWallet' | 'documentId'>): string {
  return `${target.ownerWallet}/${target.documentId}`;
}

export function planConvergentProfileShipmentSync(params: {
  docId: string;
  docPath: string;
  beforeOrder: any | null;
  afterOrder: any | null;
  currentOrder: any | null;
}): ProfileShipmentSyncPlan {
  const eventTargets = [params.beforeOrder, params.afterOrder]
    .filter((order) => order != null)
    .map((order) => buildProfileShipment(params.docId, order, params.docPath))
    .filter((target): target is ProfileShipmentTarget => Boolean(target));
  const upsert = params.currentOrder
    ? buildProfileShipment(params.docId, params.currentOrder, params.docPath)
    : null;
  const deletesByKey = new Map<string, Pick<ProfileShipmentTarget, 'ownerWallet' | 'documentId'>>();
  for (const target of eventTargets) {
    deletesByKey.set(profileShipmentTargetKey(target), {
      ownerWallet: target.ownerWallet,
      documentId: target.documentId,
    });
  }
  if (upsert) deletesByKey.delete(profileShipmentTargetKey(upsert));
  return {
    deletes: [...deletesByKey.values()],
    upsert,
  };
}

export async function applyProfileShipmentSyncPlan(
  db: Pick<Firestore, 'doc'>,
  tx: Pick<Transaction, 'getAll' | 'delete' | 'set'>,
  plan: ProfileShipmentSyncPlan,
): Promise<void> {
  const destinationRefsByPath = new Map<string, ReturnType<Firestore['doc']>>();
  for (const target of plan.deletes) {
    const ref = db.doc(`profiles/${target.ownerWallet}/shipments/${target.documentId}`);
    destinationRefsByPath.set(ref.path, ref);
  }
  if (plan.upsert) {
    const ref = db.doc(`profiles/${plan.upsert.ownerWallet}/shipments/${plan.upsert.documentId}`);
    destinationRefsByPath.set(ref.path, ref);
  }

  const destinationRefs = [...destinationRefsByPath.values()];
  const destinationSnapshots = destinationRefs.length > 0
    ? await tx.getAll(...destinationRefs)
    : [];
  const snapshotsByPath = new Map(
    destinationSnapshots.map((snapshot) => [snapshot.ref.path, snapshot]),
  );

  for (const target of plan.deletes) {
    const path = `profiles/${target.ownerWallet}/shipments/${target.documentId}`;
    if (snapshotsByPath.get(path)?.exists) {
      tx.delete(db.doc(path));
    }
  }
  if (plan.upsert) {
    const path = `profiles/${plan.upsert.ownerWallet}/shipments/${plan.upsert.documentId}`;
    const existing = snapshotsByPath.get(path);
    if (!existing?.exists || !profileShipmentMatchesProjection(existing.data(), plan.upsert.data)) {
      tx.set(db.doc(path), plan.upsert.data);
    }
  }
}

export function deliveryOrderSummaryFromProfileShipment(value: unknown): DeliveryOrderSummary | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  return toDeliveryOrderSummary(
    String(raw.deliveryId ?? ''),
    raw,
    `drops/${String(raw.dropId || '')}/deliveryOrders/${String(raw.deliveryId ?? '')}`,
  );
}
