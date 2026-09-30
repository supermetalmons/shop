import { isCommerceDocumentSegment } from './commerceDocumentPath.js';

export type PackStatusOutboxRecord = {
  parentPath: string;
  dropId: string;
  generation: string;
  state: 'pending' | 'completed' | 'failed' | 'cancelled';
  revision: number;
  failureCount: number;
  nextAttemptAtMs: number | null;
  completedAtMs: number | null;
  failedAtMs: number | null;
  lastErrorCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type PackStatusOutboxMutation = Pick<PackStatusOutboxRecord,
  'state' | 'failureCount' | 'nextAttemptAtMs' | 'completedAtMs' | 'failedAtMs' | 'lastErrorCode'>;

export const PACK_STATUS_OUTBOX_FIELD_COLUMNS = {
  parentPath: 'parent_path', dropId: 'drop_id', generation: 'generation', state: 'state',
  revision: 'revision', failureCount: 'failure_count', nextAttemptAtMs: 'next_attempt_at_ms',
  completedAtMs: 'completed_at_ms', failedAtMs: 'failed_at_ms', lastErrorCode: 'last_error_code',
  createdAtMs: 'created_at_ms', updatedAtMs: 'updated_at_ms',
} as const satisfies Record<keyof PackStatusOutboxRecord, string>;

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

export function parsePackStatusOutboxRecord(value: unknown): PackStatusOutboxRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pack-status outbox.');
  const row = value as Record<string, unknown>;
  const path = typeof row.parentPath === 'string' ? /^drops\/([^/]+)\/deliveryOrders\/([^/]+)$/.exec(row.parentPath) : null;
  if (!path || !isCommerceDocumentSegment(path[1]) || !isCommerceDocumentSegment(path[2]) ||
    row.dropId !== path[1] || typeof row.dropId !== 'string' || row.dropId.length > 64 ||
    typeof row.generation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.generation) ||
    typeof row.state !== 'string' || !['pending', 'completed', 'failed', 'cancelled'].includes(row.state) ||
    !integer(row.revision, 1) || !integer(row.failureCount) ||
    !integer(row.createdAtMs) || !integer(row.updatedAtMs) || row.updatedAtMs < row.createdAtMs ||
    ![row.nextAttemptAtMs, row.completedAtMs, row.failedAtMs].every((time) => time === null || integer(time)) ||
    ((row.state === 'pending') !== (row.nextAttemptAtMs !== null)) ||
    (row.state !== 'completed' && row.completedAtMs !== null) || (row.state !== 'failed' && row.failedAtMs !== null) ||
    (row.lastErrorCode !== null && (typeof row.lastErrorCode !== 'string' || row.lastErrorCode.length < 1 || row.lastErrorCode.length > 256))) {
    throw new Error('Invalid pack-status outbox.');
  }
  return Object.fromEntries(Object.keys(PACK_STATUS_OUTBOX_FIELD_COLUMNS).map((key) => [key, row[key]])) as PackStatusOutboxRecord;
}

export function parsePackStatusOutboxRow(value: unknown): PackStatusOutboxRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pack-status outbox row.');
  const row = value as Record<string, unknown>;
  return parsePackStatusOutboxRecord(Object.fromEntries(Object.entries(PACK_STATUS_OUTBOX_FIELD_COLUMNS)
    .map(([field, column]) => [field, row[column]])));
}

export function packStatusOutboxRow(value: PackStatusOutboxRecord): Record<string, string | number | null> {
  const record = parsePackStatusOutboxRecord(value);
  return Object.fromEntries(Object.entries(PACK_STATUS_OUTBOX_FIELD_COLUMNS)
    .map(([field, column]) => [column, record[field as keyof PackStatusOutboxRecord]]));
}
