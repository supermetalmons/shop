import {
  CommerceRepositoryError,
  type CommerceDocumentKind,
} from './commerceRepositoryTypes.js';

export type CommerceAuthorityControl = {
  state: 'paused' | 'd1';
  revision: number;
  documentsRevision: number;
};

const COMMERCE_AUTHORITY_SELECT = `SELECT authority_state, revision, documents_revision
  FROM commerce_authority_control WHERE singleton = 1`;

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function unavailableCommerce(cause?: unknown): CommerceRepositoryError {
  const error = new CommerceRepositoryError('unavailable', 'Commerce is temporarily unavailable for maintenance.');
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function reportCommerceReadFailure(error: unknown): void {
  try {
    console.error({
      event: 'commerce_d1_read_failed',
      error: error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: 'UnknownError' },
    });
  } catch {}
}

export function unavailableCommerceData(): CommerceRepositoryError {
  return new CommerceRepositoryError('unavailable', 'Commerce data is temporarily unavailable.');
}

export function reportInefficientQuery(
  operation: string,
  kind: CommerceDocumentKind,
  result: D1Result,
  rowsReturned: number,
): void {
  const rowsRead = Number(result.meta.rows_read);
  if (!Number.isSafeInteger(rowsRead) || rowsRead < 100 || rowsRead <= Math.max(rowsReturned, 1) * 10) return;
  const timings = result.meta.timings;
  const sqlDurationMs = timings && typeof timings === 'object' && !Array.isArray(timings)
    ? Number((timings as Record<string, unknown>).sql_duration_ms)
    : Number.NaN;
  console.warn({
    event: 'commerce_d1_query_inefficient',
    operation,
    kind,
    rowsRead,
    rowsReturned,
    sqlDurationMs: Number.isFinite(sqlDurationMs) ? sqlDurationMs : Number(result.meta.duration) || 0,
    retryCount: d1RetryCount(result.meta),
  });
}

export function d1RetryCount(meta: { total_attempts?: unknown }): number {
  const totalAttempts = Number(meta.total_attempts);
  return Number.isSafeInteger(totalAttempts) && totalAttempts > 1 ? totalAttempts - 1 : 0;
}

export function positiveQueryLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce query limit.');
  }
  return value;
}

export function deliveryOwner(value: string): string {
  if (typeof value !== 'string' || value.length < 1) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid delivery owner.');
  }
  return value;
}

export function authorityStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(COMMERCE_AUTHORITY_SELECT);
}

export function parseAuthorityControl(row: unknown): CommerceAuthorityControl {
  if (!isObject(row)) throw unavailableCommerce();
  const state = row.authority_state;
  const revision = row.revision;
  const documentsRevision = row.documents_revision;
  if (
    (state !== 'paused' && state !== 'd1') ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    typeof documentsRevision !== 'number' ||
    !Number.isSafeInteger(documentsRevision)
  ) throw unavailableCommerce();
  return { state, revision, documentsRevision };
}

export async function loadCommerceAuthorityControl(db: D1Database): Promise<CommerceAuthorityControl> {
  let row: Record<string, unknown> | null;
  try {
    row = await authorityStatement(db).first<Record<string, unknown>>();
  } catch {
    throw unavailableCommerce();
  }
  return parseAuthorityControl(row);
}

export async function authority(db: D1Database): Promise<CommerceAuthorityControl> {
  const control = await loadCommerceAuthorityControl(db);
  if (control.state !== 'd1') throw unavailableCommerce();
  return control;
}
