import { createHash } from 'crypto';
import {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  buildStripeReceiptClaimsByBoxId,
  requireStripeReceiptClaimCode,
} from './stripeCheckout/contract.js';

export const ADMIN_IRL_REDEEM_ADDRESS_SNAPSHOT = {
  label: 'Admin IRL event',
  country: 'Admin IRL event',
};

export const ADMIN_IRL_REDEEM_MARKER_VERSION = 1;

export type AdminIrlRedeemBoxBaseInput = {
  boxId: number;
  originalAssetId: string;
  receiptAssetId: string;
  dudeIds: number[];
};

export type AdminIrlRedeemBoxInput = AdminIrlRedeemBoxBaseInput & {
  receiptClaimCode: string;
};

export type AdminIrlRedeemDeliveryOrderInput = {
  dropId: string;
  deliveryId: number;
  requestId: string;
  owner: string;
  receiptOwner: string;
  transferSignature: string;
  receiptTxs: string[];
  boxes: AdminIrlRedeemBoxInput[];
};

export type AdminIrlRedeemMarkerInput = {
  dropId: string;
  deliveryId: number;
  requestId: string;
  owner: string;
  transferSignature: string;
  selectionKey: string;
  box: AdminIrlRedeemBoxInput;
};

export type AdminIrlRedeemMarkerReuseBox = {
  boxId: number;
  originalAssetId: string;
  receiptAssetId: string;
  claimCode: string;
};

export type AdminIrlRedeemMarkerReuseResolution =
  | { status: 'none' }
  | { status: 'conflict'; reason: string }
  | {
      status: 'reuse';
      deliveryId: number;
      requestId: string;
      claimCodes: string[];
      boxes: AdminIrlRedeemMarkerReuseBox[];
    };

function normalizePositiveU32(value: unknown, label: string): number {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 0xffff_ffff) {
    throw new Error(`Invalid admin IRL redeem ${label}`);
  }
  return normalized;
}

function normalizePositiveBoxId(value: unknown): number {
  return normalizePositiveU32(value, 'box id');
}

function normalizePositiveDeliveryId(value: unknown): number {
  return normalizePositiveU32(value, 'delivery id');
}

function normalizeString(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`Missing ${label}`);
  return normalized;
}

function normalizeSelectionKey(value: unknown): string {
  const normalized = normalizeString(value, 'selection key');
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('Invalid admin IRL redeem selection key');
  return normalized;
}

function normalizeOriginalAssetIds(values: readonly unknown[]): string[] {
  if (!Array.isArray(values) || !values.length) throw new Error('Admin IRL redeem selection requires pack asset ids');
  const ids = values.map((value) => normalizeString(value, 'original pack asset id'));
  assertUnique(ids, 'original pack asset ids');
  return ids;
}

function normalizeDudeIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw new Error('Invalid admin IRL redeem dude ids');
  const dudeIds = raw.map((value) => Math.floor(Number(value)));
  if (!dudeIds.length || dudeIds.some((id) => !Number.isFinite(id) || id <= 0)) {
    throw new Error('Invalid admin IRL redeem dude ids');
  }
  assertUnique(dudeIds, 'dude ids');
  return dudeIds;
}

function normalizeBox(input: AdminIrlRedeemBoxInput): AdminIrlRedeemBoxInput {
  return {
    boxId: normalizePositiveBoxId(input.boxId),
    originalAssetId: normalizeString(input.originalAssetId, 'original pack asset id'),
    receiptAssetId: normalizeString(input.receiptAssetId, 'pack receipt asset id'),
    receiptClaimCode: requireStripeReceiptClaimCode(input.receiptClaimCode),
    dudeIds: normalizeDudeIds(input.dudeIds),
  };
}

function assertUnique(values: readonly unknown[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate admin IRL redeem ${label}`);
  }
}

export function buildAdminIrlRedeemSelectionKey(args: {
  dropId: string;
  originalAssetIds: readonly string[];
}): string {
  const dropId = normalizeString(args.dropId, 'dropId');
  const originalAssetIds = normalizeOriginalAssetIds(args.originalAssetIds).sort();
  const payload = JSON.stringify({ dropId, originalAssetIds });
  return createHash('sha256').update(payload).digest('hex');
}

export function buildAdminIrlRedeemDeliveryOrderDocument(
  input: AdminIrlRedeemDeliveryOrderInput,
): Record<string, unknown> {
  const boxes = input.boxes.map(normalizeBox).sort((a, b) => a.boxId - b.boxId);
  if (!boxes.length) throw new Error('Admin IRL redeem order requires at least one box');
  assertUnique(boxes.map((box) => box.boxId), 'box ids');
  assertUnique(boxes.map((box) => box.receiptAssetId), 'pack receipt asset ids');
  assertUnique(boxes.map((box) => box.originalAssetId), 'original pack asset ids');
  assertUnique(boxes.map((box) => box.receiptClaimCode), 'receipt claim codes');
  const metadataIds = boxes.map((box) => box.boxId);
  const receiptAssetIds = boxes.map((box) => box.receiptAssetId);
  const originalAssetIds = boxes.map((box) => box.originalAssetId);

  return {
    dropId: normalizeString(input.dropId, 'dropId'),
    source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
    status: 'ready_to_ship',
    owner: normalizeString(input.owner, 'owner'),
    receiptOwner: normalizeString(input.receiptOwner, 'receipt owner'),
    addressSnapshot: ADMIN_IRL_REDEEM_ADDRESS_SNAPSHOT,
    itemIds: receiptAssetIds,
    originalItemIds: originalAssetIds,
    items: boxes.map((box) => ({
      kind: 'box',
      refId: box.boxId,
      assetId: box.receiptAssetId,
      originalAssetId: box.originalAssetId,
    })),
    deliveryId: normalizePositiveDeliveryId(input.deliveryId),
    quantity: boxes.length,
    metadataIds,
    ...(metadataIds.length === 1 ? { metadataId: metadataIds[0] } : {}),
    receiptsMinted: boxes.length,
    receiptTxs: Array.from(new Set(input.receiptTxs.map((tx) => String(tx || '').trim()).filter(Boolean))),
    stripeReceiptClaimsByBoxId: buildStripeReceiptClaimsByBoxId(
      boxes.map((box) => ({
        namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
        code: box.receiptClaimCode,
        boxId: box.boxId,
        status: 'unclaimed',
      })),
    ),
    irlClaims: boxes.map((box) => ({
      boxId: box.boxId,
      boxAssetId: box.receiptAssetId,
      dudeIds: box.dudeIds,
    })),
    adminIrlRedeem: {
      requestId: normalizeString(input.requestId, 'requestId'),
      transferSignature: normalizeString(input.transferSignature, 'transfer signature'),
      originalItemIds: originalAssetIds,
    },
  };
}

export function buildAdminIrlRedeemClaimCodeDocument(args: {
  dropId: string;
  deliveryId: number;
  owner: string;
  receiptOwner: string;
  requestId: string;
  box: AdminIrlRedeemBoxInput;
}): Record<string, unknown> {
  const box = normalizeBox(args.box);
  return {
    version: 1,
    namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
    source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
    code: box.receiptClaimCode,
    dropId: normalizeString(args.dropId, 'dropId'),
    deliveryId: normalizePositiveDeliveryId(args.deliveryId),
    owner: normalizeString(args.owner, 'owner'),
    receiptOwner: normalizeString(args.receiptOwner, 'receipt owner'),
    requestId: normalizeString(args.requestId, 'requestId'),
    boxId: box.boxId,
    boxAssetId: box.receiptAssetId,
    originalBoxAssetId: box.originalAssetId,
    dudeIds: box.dudeIds,
    status: 'unclaimed',
  };
}

export function buildAdminIrlRedeemMarkerDocument(input: AdminIrlRedeemMarkerInput): Record<string, unknown> {
  const box = normalizeBox(input.box);
  return {
    version: ADMIN_IRL_REDEEM_MARKER_VERSION,
    source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
    dropId: normalizeString(input.dropId, 'dropId'),
    selectionKey: normalizeSelectionKey(input.selectionKey),
    requestId: normalizeString(input.requestId, 'requestId'),
    deliveryId: normalizePositiveDeliveryId(input.deliveryId),
    owner: normalizeString(input.owner, 'owner'),
    originalAssetId: box.originalAssetId,
    receiptAssetId: box.receiptAssetId,
    boxId: box.boxId,
    claimCode: box.receiptClaimCode,
    transferSignature: normalizeString(input.transferSignature, 'transfer signature'),
  };
}

function normalizeMarkerDocument(marker: any): AdminIrlRedeemMarkerReuseBox & {
  dropId: string;
  selectionKey: string;
  deliveryId: number;
  requestId: string;
} {
  if (!marker || typeof marker !== 'object') throw new Error('missing marker');
  if (marker.version !== ADMIN_IRL_REDEEM_MARKER_VERSION) throw new Error('invalid marker version');
  if (marker.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) throw new Error('invalid marker source');
  return {
    dropId: normalizeString(marker.dropId, 'dropId'),
    selectionKey: normalizeSelectionKey(marker.selectionKey),
    requestId: normalizeString(marker.requestId, 'requestId'),
    deliveryId: normalizePositiveDeliveryId(marker.deliveryId),
    originalAssetId: normalizeString(marker.originalAssetId, 'original pack asset id'),
    receiptAssetId: normalizeString(marker.receiptAssetId, 'pack receipt asset id'),
    boxId: normalizePositiveBoxId(marker.boxId),
    claimCode: requireStripeReceiptClaimCode(marker.claimCode),
  };
}

export function resolveAdminIrlRedeemMarkerReuse(args: {
  dropId: string;
  selectionKey: string;
  originalAssetIds: readonly string[];
  markers: readonly (Record<string, unknown> | null | undefined)[];
}): AdminIrlRedeemMarkerReuseResolution {
  const dropId = normalizeString(args.dropId, 'dropId');
  const selectionKey = normalizeSelectionKey(args.selectionKey);
  const originalAssetIds = normalizeOriginalAssetIds(args.originalAssetIds);
  const expectedOriginalAssetIds = new Set(originalAssetIds);
  const byOriginalAssetId = new Map<string, ReturnType<typeof normalizeMarkerDocument>>();

  for (const rawMarker of args.markers) {
    if (!rawMarker) continue;

    let marker: ReturnType<typeof normalizeMarkerDocument>;
    try {
      marker = normalizeMarkerDocument(rawMarker);
    } catch (err) {
      return { status: 'conflict', reason: err instanceof Error ? err.message : 'invalid marker' };
    }

    if (marker.dropId !== dropId) return { status: 'conflict', reason: 'drop mismatch' };
    if (marker.selectionKey !== selectionKey) return { status: 'conflict', reason: 'selection mismatch' };
    if (!expectedOriginalAssetIds.has(marker.originalAssetId)) {
      return { status: 'conflict', reason: 'unexpected original asset marker' };
    }

    const existing = byOriginalAssetId.get(marker.originalAssetId);
    if (existing) {
      const sameExistingOrder =
        existing.deliveryId === marker.deliveryId &&
        existing.requestId === marker.requestId &&
        existing.receiptAssetId === marker.receiptAssetId &&
        existing.boxId === marker.boxId &&
        existing.claimCode === marker.claimCode;
      if (!sameExistingOrder) return { status: 'conflict', reason: 'conflicting duplicate marker' };
      continue;
    }
    byOriginalAssetId.set(marker.originalAssetId, marker);
  }

  if (!byOriginalAssetId.size) return { status: 'none' };
  if (byOriginalAssetId.size !== expectedOriginalAssetIds.size) {
    return { status: 'conflict', reason: 'partial marker overlap' };
  }

  const boxes = originalAssetIds.map((originalAssetId) => byOriginalAssetId.get(originalAssetId)!);
  const deliveryIds = new Set(boxes.map((box) => box.deliveryId));
  const requestIds = new Set(boxes.map((box) => box.requestId));
  if (deliveryIds.size !== 1 || requestIds.size !== 1) {
    return { status: 'conflict', reason: 'marker delivery mismatch' };
  }

  return {
    status: 'reuse',
    deliveryId: boxes[0].deliveryId,
    requestId: boxes[0].requestId,
    claimCodes: boxes.map((box) => box.claimCode),
    boxes: boxes.map((box) => ({
      boxId: box.boxId,
      originalAssetId: box.originalAssetId,
      receiptAssetId: box.receiptAssetId,
      claimCode: box.claimCode,
    })),
  };
}
