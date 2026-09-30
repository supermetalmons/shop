import { createHash } from 'node:crypto';
import { requireApiDrop } from '../../cloud/workers/api/src/dropConfig.ts';
import { resolveDeliveryOrderIdentity } from '../../cloud/workers/api/src/deliveryOrderSummaries.ts';
import {
  parsePackStatusOutboxRecord,
  type PackStatusOutboxRecord,
} from '../../shared/packStatusOutbox.ts';
import {
  countDeliveryOrderBoxItems,
  countDeliveryOrderDudeItems,
  shouldTrackPackStatusForDrop,
} from '../../shared/packStatus.ts';
import { isAdminIrlRedeemDeliveryOrderSource, isStripeOffchainDeliveryOrderSource } from '../../shared/fulfillmentSources.ts';
import type { CommerceD1Document } from './commerceD1Maintenance.ts';
import type { CommerceSqlQuery } from '../../cloud/workers/api/src/commerceQueries.ts';

export const LEGACY_PACK_STATUS_PROJECTION_FIELDS = [
  'packStatusProjectionState', 'packStatusProjectionNextAttemptAtMs', 'packStatusProjectionFailureCount',
  'packStatusProjectionCompletedAt', 'packStatusProjectionFailedAt', 'packStatusProjectionLastErrorCode',
] as const;

export function legacyPackStatusProjectionsQuery(args: { dropId: string; dueAtMs: number; limit: number }): CommerceSqlQuery {
  return {
    sql: `SELECT document_path, document_kind, drop_id, document_id, document_json, version,
        create_time, update_time, processed_at_seconds, processed_at_nanos
      FROM commerce_authority_control AS authority CROSS JOIN commerce_documents
      WHERE authority.singleton = 1 AND authority.authority_state = 'd1'
        AND document_kind = 'delivery_order' AND drop_id = ? AND pack_projection_state = 'pending'
        AND pack_projection_next_attempt_ms <= ?
      ORDER BY pack_projection_next_attempt_ms ASC, document_path ASC LIMIT ?`,
    bindings: [args.dropId, args.dueAtMs, args.limit],
  };
}

function integer(value: unknown, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid legacy pack-status ${label}.`);
  return Number(value);
}

function optionalTime(value: unknown, label: string): number | null {
  return value === undefined ? null : integer(value, label);
}

function generation(parentPath: string): string {
  const digest = createHash('sha256').update(`${parentPath}\npack_status`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function requirePendingSource(document: CommerceD1Document): void {
  const data = document.data;
  const drop = requireApiDrop(document.dropId!);
  const admin = data.adminIrlRedeem && typeof data.adminIrlRedeem === 'object' && !Array.isArray(data.adminIrlRedeem)
    ? data.adminIrlRedeem as Record<string, unknown> : {};
  if (data.status !== 'ready_to_ship' || !shouldTrackPackStatusForDrop({
    dropId: drop.dropId, cluster: drop.solanaCluster, itemsPerBox: drop.itemsPerBox, maxSupply: drop.maxSupply,
  }) || isStripeOffchainDeliveryOrderSource(data.source) ||
    (isAdminIrlRedeemDeliveryOrderSource(data.source) && admin.targetKind === 'card_receipt') ||
    (countDeliveryOrderBoxItems(data.items) < 1 && countDeliveryOrderDudeItems(data.items) < 1)) {
    throw new Error('Invalid pending pack-status source.');
  }
}

export function planPackStatusOutboxBackfill(document: CommerceD1Document): PackStatusOutboxRecord | null {
  const data = document.data;
  if (!LEGACY_PACK_STATUS_PROJECTION_FIELDS.some((field) => Object.hasOwn(data, field))) return null;
  try {
    const identity = resolveDeliveryOrderIdentity(document.documentId, data, document.path);
    if (document.kind !== 'delivery_order' || !('identity' in identity) || identity.identity.dropId !== document.dropId ||
      (data.dropId !== undefined && data.dropId !== document.dropId)) throw new Error('Invalid pack-status parent identity.');
    const state = data.packStatusProjectionState;
    if (state !== 'pending' && state !== 'completed' && state !== 'failed') throw new Error('Invalid legacy pack-status state.');
    if (state === 'pending') requirePendingSource(document);
    const nextAttemptAtMs = state === 'pending'
      ? integer(data.packStatusProjectionNextAttemptAtMs, 'retry timestamp', 0)
      : optionalTime(data.packStatusProjectionNextAttemptAtMs, 'retry timestamp');
    const completedAtMs = optionalTime(data.packStatusProjectionCompletedAt, 'completion timestamp');
    const failedAtMs = optionalTime(data.packStatusProjectionFailedAt, 'failure timestamp');
    const lastErrorCode = data.packStatusProjectionLastErrorCode === undefined ? null : data.packStatusProjectionLastErrorCode;
    if (lastErrorCode !== null && (typeof lastErrorCode !== 'string' || !lastErrorCode.length || lastErrorCode.length > 256)) {
      throw new Error('Invalid legacy pack-status error code.');
    }
    return parsePackStatusOutboxRecord({
      parentPath: document.path, dropId: document.dropId, generation: generation(document.path),
      state, revision: 1,
      failureCount: integer(data.packStatusProjectionFailureCount, 'failure count', 0),
      nextAttemptAtMs, completedAtMs, failedAtMs, lastErrorCode,
      createdAtMs: integer(Date.parse(document.createTime), 'creation time'),
      updatedAtMs: integer(Date.parse(document.updateTime), 'update time'),
    });
  } catch (cause) {
    throw new Error(`Pack-status outbox validation failed for ${document.path}.`, { cause });
  }
}
