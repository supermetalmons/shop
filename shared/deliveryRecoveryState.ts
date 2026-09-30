import { isCommerceDocumentSegment } from './commerceDocumentPath.ts';
import {
  DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS,
  nextPreparedDeliveryRecoveryDelayMs,
} from './deliveryRecovery.ts';

export type DeliveryRecoveryRecord = {
  parentPath: string;
  generation: string;
  revision: number;
  leaseId: string | null;
  receiptRecoveryJson: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  preparedDelayMs: number | null;
  preparedExplicitAtMs: number | null;
  processingRetryAtMs: number | null;
  leaseExpiresAtMs: number | null;
};

export type DeliveryRecoveryProjections = Pick<DeliveryRecoveryRecord,
  'preparedDelayMs' | 'preparedExplicitAtMs' | 'processingRetryAtMs' | 'leaseExpiresAtMs'>;

export const DELIVERY_RECOVERY_FIELD_COLUMNS = {
  parentPath: 'parent_path', generation: 'generation', revision: 'revision', leaseId: 'lease_id',
  receiptRecoveryJson: 'receipt_recovery_json', createdAtMs: 'created_at_ms', updatedAtMs: 'updated_at_ms',
  preparedDelayMs: 'prepared_delay_ms', preparedExplicitAtMs: 'prepared_explicit_at_ms',
  processingRetryAtMs: 'processing_retry_at_ms', leaseExpiresAtMs: 'lease_expires_at_ms',
} as const satisfies Record<keyof DeliveryRecoveryRecord, string>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function recoveryValue(receiptRecoveryJson: string | null): Record<string, unknown> {
  if (receiptRecoveryJson === null) return {};
  if (typeof receiptRecoveryJson !== 'string') throw new Error('Invalid delivery recovery JSON.');
  let value: unknown;
  try {
    value = JSON.parse(receiptRecoveryJson);
  } catch {
    throw new Error('Invalid delivery recovery JSON.');
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function deliveryRecoveryProjections(receiptRecoveryJson: string | null): DeliveryRecoveryProjections {
  const recovery = recoveryValue(receiptRecoveryJson);
  const rawProbeCount = Number(recovery.preparedProbeCount || 0);
  const probeCount = Number.isFinite(rawProbeCount) && rawProbeCount > 0 ? Math.floor(rawProbeCount) : 0;
  const lastAttemptAtMs = finite(recovery.lastAttemptAt) && recovery.lastAttemptAt > 0 ? recovery.lastAttemptAt : null;
  return {
    preparedDelayMs: nextPreparedDeliveryRecoveryDelayMs(probeCount),
    preparedExplicitAtMs: finite(recovery.nextPreparedProbeAt) && recovery.nextPreparedProbeAt > 0
      ? recovery.nextPreparedProbeAt : null,
    processingRetryAtMs: lastAttemptAtMs === null ? null : lastAttemptAtMs + DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS,
    leaseExpiresAtMs: finite(recovery.leaseExpiresAt) ? recovery.leaseExpiresAt : null,
  };
}

export function parseDeliveryRecoveryRecord(value: unknown): DeliveryRecoveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid delivery recovery record.');
  const row = value as Record<string, unknown>;
  const path = typeof row.parentPath === 'string' ? /^drops\/([^/]+)\/deliveryOrders\/([^/]+)$/.exec(row.parentPath) : null;
  if (!path || !isCommerceDocumentSegment(path[1]) || !isCommerceDocumentSegment(path[2]) ||
    typeof row.generation !== 'string' || !UUID_PATTERN.test(row.generation) ||
    (row.leaseId !== null && (typeof row.leaseId !== 'string' || !UUID_PATTERN.test(row.leaseId))) ||
    !integer(row.revision, 1) || !integer(row.createdAtMs) || !integer(row.updatedAtMs) ||
    row.updatedAtMs < row.createdAtMs || (row.receiptRecoveryJson !== null && typeof row.receiptRecoveryJson !== 'string')) {
    throw new Error('Invalid delivery recovery record.');
  }
  const projections = deliveryRecoveryProjections(row.receiptRecoveryJson as string | null);
  if (Object.entries(projections).some(([field, expected]) => row[field] !== expected)) {
    throw new Error('Invalid delivery recovery projections.');
  }
  return Object.fromEntries(Object.keys(DELIVERY_RECOVERY_FIELD_COLUMNS).map((field) => [field, row[field]])) as DeliveryRecoveryRecord;
}

export function createDeliveryRecoveryRecord(input: {
  parentPath: string;
  receiptRecoveryJson: string | null;
  nowMs: number;
  generation: string;
}): DeliveryRecoveryRecord {
  return parseDeliveryRecoveryRecord({
    parentPath: input.parentPath, generation: input.generation, revision: 1, leaseId: null,
    receiptRecoveryJson: input.receiptRecoveryJson, createdAtMs: input.nowMs, updatedAtMs: input.nowMs,
    ...deliveryRecoveryProjections(input.receiptRecoveryJson),
  });
}

export function updateDeliveryRecoveryRecord(
  value: DeliveryRecoveryRecord,
  changes: Partial<Pick<DeliveryRecoveryRecord, 'receiptRecoveryJson' | 'leaseId'>>,
  nowMs: number,
): DeliveryRecoveryRecord {
  const record = parseDeliveryRecoveryRecord(value);
  if (!integer(nowMs)) throw new Error('Invalid delivery recovery timestamp.');
  const receiptRecoveryJson = changes.receiptRecoveryJson === undefined ? record.receiptRecoveryJson : changes.receiptRecoveryJson;
  return parseDeliveryRecoveryRecord({
    ...record, receiptRecoveryJson, leaseId: changes.leaseId === undefined ? record.leaseId : changes.leaseId,
    revision: record.revision + 1,
    updatedAtMs: Math.max(record.updatedAtMs, nowMs), ...deliveryRecoveryProjections(receiptRecoveryJson),
  });
}

export function parseDeliveryRecoveryRow(value: unknown): DeliveryRecoveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid delivery recovery row.');
  const row = value as Record<string, unknown>;
  return parseDeliveryRecoveryRecord(Object.fromEntries(Object.entries(DELIVERY_RECOVERY_FIELD_COLUMNS)
    .map(([field, column]) => [field, row[column]])));
}

export function deliveryRecoveryRow(value: DeliveryRecoveryRecord): Record<string, string | number | null> {
  const record = parseDeliveryRecoveryRecord(value);
  return Object.fromEntries(Object.entries(DELIVERY_RECOVERY_FIELD_COLUMNS)
    .map(([field, column]) => [column, record[field as keyof DeliveryRecoveryRecord]]));
}
