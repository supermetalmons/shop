import {
  CommerceRepositoryError,
  CommerceWriteConflict,
  isCommerceArrayUnion,
  isCommerceDeleteField,
  isCommerceIncrement,
  isCommerceServerTimestamp,
  isCommerceTimestamp,
  type CommerceDocumentData,
  type CommerceDocumentKey,
  type CommerceDocumentKind,
  type CommerceDocumentRecord,
  type CommerceDocumentWriteData,
  type CommerceFilterValue,
  type CommerceIndexedField,
  type CommerceJsonValue,
  type CommerceQuery,
  type CommerceTimestamp,
  type CommerceUpdateValue,
} from './commerceRepositoryTypes.js';
import { isCommerceDocumentSegment } from '../../../../shared/commerceDocumentPath.js';
import { STRIPE_CHECKOUT_STATUS } from '../../../../shared/stripeCheckoutSession.js';
import { STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR } from '../../../../shared/stripeCheckoutFulfillmentJob.js';

export * from './commerceRepositoryTypes.js';

export type CommerceAuthorityControl = {
  state: 'paused' | 'd1';
  revision: number;
  documentsRevision: number;
};

type StoredDocument = {
  createTime: string;
  data: CommerceDocumentData;
  key: CommerceDocumentKey;
  processedAt: CommerceTimestamp | null;
  updateTime: string;
  version: number;
};

type PendingDocument = StoredDocument | null;

type DeliveryOwnerExpectation = Readonly<{
  owner: string;
  revision: number;
}>;

type DocumentExpectation = Readonly<{
  path: string;
  version: number;
  pathRevision?: number;
}>;

const DOCUMENT_COLUMN_NAMES = [
  'document_path',
  'document_kind',
  'drop_id',
  'document_id',
  'document_json',
  'version',
  'create_time',
  'update_time',
  'processed_at_seconds',
  'processed_at_nanos',
] as const;
const DOCUMENT_COLUMNS = DOCUMENT_COLUMN_NAMES.join(', ');
const COMMERCE_READ_BATCH_SIZE = 50;
const COMMERCE_AUTHORITY_SELECT = `SELECT authority_state, revision, documents_revision
  FROM commerce_authority_control WHERE singleton = 1`;
const PENDING_READY_NOTIFICATION_INDEXES = Object.freeze({
  buyer: Object.freeze({
    owner: 'commerce_delivery_orders_buyer_notifications_pending_owner_path',
    ownerless: 'commerce_delivery_orders_buyer_notifications_pending',
  }),
  shipper: Object.freeze({
    owner: 'commerce_delivery_orders_shipper_notifications_pending_owner_path',
    ownerless: 'commerce_delivery_orders_shipper_notifications_pending',
  }),
});

function qualifiedDocumentColumns(alias: string): string {
  return DOCUMENT_COLUMN_NAMES.map((name) => `${alias}.${name}`).join(', ');
}

const INDEXED_COLUMNS: Readonly<Record<CommerceIndexedField, string>> = Object.freeze({
  buyerOrderReceivedEmailState: 'buyer_notification_state',
  fulfillmentProcessor: 'fulfillment_processor',
  fulfillmentStatus: 'fulfillment_status',
  irlClaimCode: 'irl_claim_code',
  manualRefundReviewRequired: 'manual_refund_review_required',
  owner: 'owner',
  packStatusProjectionNextAttemptAtMs: 'pack_projection_next_attempt_ms',
  packStatusProjectionState: 'pack_projection_state',
  shipperReadyToShipEmailState: 'shipper_notification_state',
  source: 'source',
  status: 'status',
});

const COLLECTIONS: Readonly<Record<Exclude<CommerceDocumentKind, 'claim_code' | 'dude_pool'>, string>> = Object.freeze({
  admin_irl_redeem_pack_marker: 'adminIrlRedeemPackMarkers',
  admin_irl_redeem_receipt_marker: 'adminIrlRedeemReceiptMarkers',
  admin_irl_redeem_request: 'adminIrlRedeemRequests',
  box_assignment: 'boxAssignments',
  delivery_order: 'deliveryOrders',
  dude_assignment: 'dudeAssignments',
  offchain_order: 'offchainOrders',
  stripe_checkout: 'stripeCheckouts',
});

function documentKey<K extends CommerceDocumentKind>(
  kind: K,
  dropId: string | null,
  documentId: string,
): CommerceDocumentKey<K> {
  if (!isCommerceDocumentSegment(documentId) ||
    (kind !== 'claim_code' && !isCommerceDocumentSegment(dropId))) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce document key.');
  }
  const path = kind === 'claim_code'
    ? `claimCodes/${documentId}`
    : kind === 'dude_pool'
      ? `drops/${dropId}/meta/dudePool`
      : `drops/${dropId}/${COLLECTIONS[kind as keyof typeof COLLECTIONS]}/${documentId}`;
  return Object.freeze({ documentId, dropId, kind, path });
}

export function commerceKeyFromPath(path: string): CommerceDocumentKey | null {
  const claim = /^claimCodes\/([^/]+)$/.exec(path);
  if (claim) return documentKey('claim_code', null, claim[1]);
  const nested = /^drops\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (!nested) return null;
  const [, dropId, collection, documentId] = nested;
  if (collection === 'meta' && documentId === 'dudePool') return documentKey('dude_pool', dropId, documentId);
  const kind = new Map<string, Exclude<CommerceDocumentKind, 'claim_code' | 'dude_pool'>>([
    ['adminIrlRedeemPackMarkers', 'admin_irl_redeem_pack_marker'],
    ['adminIrlRedeemReceiptMarkers', 'admin_irl_redeem_receipt_marker'],
    ['adminIrlRedeemRequests', 'admin_irl_redeem_request'],
    ['boxAssignments', 'box_assignment'],
    ['deliveryOrders', 'delivery_order'],
    ['dudeAssignments', 'dude_assignment'],
    ['offchainOrders', 'offchain_order'],
    ['stripeCheckouts', 'stripe_checkout'],
  ]).get(collection);
  return kind ? documentKey(kind, dropId, documentId) : null;
}

export const commerceKeys = Object.freeze({
  adminIrlRedeemPackMarker: (dropId: string, documentId: string) =>
    documentKey('admin_irl_redeem_pack_marker', dropId, documentId),
  adminIrlRedeemReceiptMarker: (dropId: string, documentId: string) =>
    documentKey('admin_irl_redeem_receipt_marker', dropId, documentId),
  adminIrlRedeemRequest: (dropId: string, documentId: string) =>
    documentKey('admin_irl_redeem_request', dropId, documentId),
  boxAssignment: (dropId: string, documentId: string) => documentKey('box_assignment', dropId, documentId),
  claimCode: (documentId: string) => documentKey('claim_code', null, documentId),
  deliveryOrder: (dropId: string, documentId: string) => documentKey('delivery_order', dropId, documentId),
  dudeAssignment: (dropId: string, documentId: string) => documentKey('dude_assignment', dropId, documentId),
  dudePool: (dropId: string) => documentKey('dude_pool', dropId, 'dudePool'),
  offchainOrder: (dropId: string, documentId: string) => documentKey('offchain_order', dropId, documentId),
  stripeCheckout: (dropId: string, documentId: string) => documentKey('stripe_checkout', dropId, documentId),
});

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function cloneData<T>(value: T): T {
  return structuredClone(value);
}

function validatedJsonValue(value: unknown): CommerceJsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce document value.');
  }
  if (Array.isArray(value)) return value.map(validatedJsonValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, validatedJsonValue(entry)]));
  }
  throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce document value.');
}

function validTimestamp(value: CommerceTimestamp): boolean {
  return Number.isSafeInteger(value.seconds) && value.seconds >= 0 &&
    Number.isInteger(value.nanos) && value.nanos >= 0 && value.nanos <= 999_999_999;
}

function timestampFromMilliseconds(milliseconds: number): CommerceTimestamp {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce timestamp.');
  }
  const seconds = Math.floor(milliseconds / 1000);
  return { seconds, nanos: (milliseconds - seconds * 1000) * 1_000_000 };
}

function timestampString(value: CommerceTimestamp): string {
  if (!validTimestamp(value)) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce timestamp.');
  const base = new Date(value.seconds * 1000).toISOString().slice(0, 19);
  return `${base}.${String(value.nanos).padStart(9, '0')}Z`;
}

function timestampMilliseconds(value: CommerceTimestamp): number {
  return value.seconds * 1000 + Math.floor(value.nanos / 1_000_000);
}

function compareTimestamps(left: CommerceTimestamp, right: CommerceTimestamp): number {
  return left.seconds - right.seconds || left.nanos - right.nanos;
}

function nextTimestamp(value: CommerceTimestamp): CommerceTimestamp {
  return value.nanos < 999_000_000
    ? { seconds: value.seconds, nanos: (Math.floor(value.nanos / 1_000_000) + 1) * 1_000_000 }
    : { seconds: value.seconds + 1, nanos: 0 };
}

function dataField(data: CommerceDocumentData, fieldPath: string): unknown {
  let current: unknown = data;
  for (const part of fieldPath.split('.')) {
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setDataField(data: CommerceDocumentData, fieldPath: string, value: CommerceJsonValue | undefined): void {
  const parts = fieldPath.split('.');
  let current: Record<string, CommerceJsonValue> = data;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const existing = current[parts[index]];
    if (!isObject(existing)) current[parts[index]] = {};
    current = current[parts[index]] as Record<string, CommerceJsonValue>;
  }
  const last = parts.at(-1)!;
  if (value === undefined) delete current[last];
  else current[last] = value;
}

function materializeUpdate(
  current: CommerceJsonValue | undefined,
  update: CommerceUpdateValue,
  now: CommerceTimestamp,
): CommerceJsonValue | undefined {
  if (isCommerceDeleteField(update)) return undefined;
  if (isCommerceServerTimestamp(update)) {
    return timestampMilliseconds(now);
  }
  if (isCommerceTimestamp(update)) {
    if (!validTimestamp(update.value)) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce timestamp.');
    return timestampMilliseconds(update.value);
  }
  if (isCommerceIncrement(update)) {
    if (!Number.isFinite(update.amount)) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce increment.');
    const existing = typeof current === 'number' ? current : 0;
    const value = existing + update.amount;
    if (!Number.isFinite(value)) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce increment.');
    return value;
  }
  if (isCommerceArrayUnion(update)) {
    const values = Array.isArray(current) ? cloneData(current) : [];
    for (const entry of update.values) {
      const validated = validatedJsonValue(entry);
      if (!values.some((existing) => canonicalJson(existing) === canonicalJson(validated))) values.push(validated);
    }
    return values;
  }
  return validatedJsonValue(update);
}

function processedTimestampForUpdate(
  currentTimestamp: CommerceTimestamp | null,
  currentValue: CommerceJsonValue | undefined,
  update: CommerceUpdateValue,
  value: CommerceJsonValue | undefined,
  now: CommerceTimestamp,
): CommerceTimestamp | null {
  if (isCommerceDeleteField(update)) return null;
  if (isCommerceServerTimestamp(update)) return now;
  if (isCommerceTimestamp(update)) return update.value;
  if (typeof value !== 'number') return null;
  if (currentTimestamp && value === currentValue) return currentTimestamp;
  return timestampFromMilliseconds(value);
}

function parseTimestampString(value: string): CommerceTimestamp | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}Z`) / 1000;
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  return { seconds, nanos: Number((match[2] || '').padEnd(9, '0')) };
}

function unavailableCommerce(cause?: unknown): CommerceRepositoryError {
  const error = new CommerceRepositoryError('unavailable', 'Commerce is temporarily unavailable for maintenance.');
  if (cause !== undefined) error.cause = cause;
  return error;
}

function reportCommerceReadFailure(error: unknown): void {
  try {
    console.error({
      event: 'commerce_d1_read_failed',
      error: error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: 'UnknownError' },
    });
  } catch {}
}

function unavailableCommerceData(): CommerceRepositoryError {
  return new CommerceRepositoryError('unavailable', 'Commerce data is temporarily unavailable.');
}

function parseRow(value: unknown): StoredDocument {
  if (!isObject(value)) throw unavailableCommerceData();
  const row = value;
  const documentPath = row.document_path;
  const documentId = row.document_id;
  const dropId = row.drop_id;
  const version = row.version;
  const createTime = row.create_time;
  const updateTime = row.update_time;
  const processedAtSeconds = row.processed_at_seconds;
  const processedAtNanos = row.processed_at_nanos;
  if (
    typeof documentPath !== 'string' ||
    typeof documentId !== 'string' ||
    (dropId !== null && typeof dropId !== 'string') ||
    typeof row.document_json !== 'string' ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof createTime !== 'string' ||
    typeof updateTime !== 'string' ||
    (processedAtSeconds !== null && (
      typeof processedAtSeconds !== 'number' || !Number.isSafeInteger(processedAtSeconds)
    )) ||
    (processedAtNanos !== null && (
      typeof processedAtNanos !== 'number' || !Number.isInteger(processedAtNanos)
    ))
  ) throw unavailableCommerceData();
  let data: unknown;
  try {
    data = JSON.parse(row.document_json);
  } catch {
    throw unavailableCommerceData();
  }
  let key: CommerceDocumentKey | null;
  try {
    key = commerceKeyFromPath(documentPath);
  } catch {
    throw unavailableCommerceData();
  }
  if (!isObject(data) || !key || key.kind !== row.document_kind || key.dropId !== dropId || key.documentId !== documentId) {
    throw unavailableCommerceData();
  }
  const projectedProcessedAt = processedAtSeconds === null && processedAtNanos === null
    ? null
    : { seconds: processedAtSeconds, nanos: processedAtNanos };
  const processedAt = projectedProcessedAt;
  if (processedAt && !validTimestamp(processedAt as CommerceTimestamp)) {
    throw unavailableCommerceData();
  }
  return {
    createTime,
    data: data as CommerceDocumentData,
    key,
    processedAt: processedAt as CommerceTimestamp | null,
    updateTime,
    version,
  };
}

function publicRecord<T extends CommerceDocumentData>(document: StoredDocument): CommerceDocumentRecord<T> {
  return Object.freeze({
    createTime: document.createTime,
    data: cloneData(document.data) as T,
    key: document.key,
    processedAt: document.processedAt ? { ...document.processedAt } : null,
    updateTime: document.updateTime,
    version: document.version,
  });
}

function assertDocumentIdentity(key: CommerceDocumentKey, expected: CommerceDocumentKey): void {
  if (
    key.path !== expected.path || key.kind !== expected.kind ||
    key.dropId !== expected.dropId || key.documentId !== expected.documentId
  ) throw new CommerceRepositoryError('internal', 'Commerce document identity mismatch.');
}

function isTimestampLike(value: unknown): value is CommerceTimestamp {
  return isObject(value) && validTimestamp(value as CommerceTimestamp);
}

function sqlFilterValue(value: CommerceFilterValue): string | number {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce query filter.');
}

function ensureQuery(query: CommerceQuery): void {
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 0)) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce query limit.');
  }
  for (const filter of query.filters || []) {
    if (filter.op === 'in') {
      if (!Array.isArray(filter.value) || filter.value.length === 0) {
        throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce query filter.');
      }
      filter.value.forEach(sqlFilterValue);
    } else {
      if (Array.isArray(filter.value)) {
        throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce query filter.');
      }
      sqlFilterValue(filter.value as CommerceFilterValue);
    }
  }
  const orderBy = query.orderBy || [];
  if (!query.startAfter) return;
  if (
    orderBy.length === 1 &&
    orderBy[0].field === 'documentPath' &&
    query.startAfter.length === 1 &&
    typeof query.startAfter[0] === 'string'
  ) return;
  if (
    orderBy.length === 2 &&
    orderBy[0].field === 'processedAt' &&
    orderBy[0].direction === 'desc' &&
    orderBy[1].field === 'documentPath' &&
    orderBy[1].direction === 'desc' &&
    query.startAfter.length === 2 &&
    isTimestampLike(query.startAfter[0]) &&
    typeof query.startAfter[1] === 'string'
  ) return;
  throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce query cursor.');
}

type CompiledCommerceQuery = {
  bindings: Array<string | number>;
  sql: string;
};

function compileCommerceQuery(query: CommerceQuery, authoritative = false): CompiledCommerceQuery {
  ensureQuery(query);
  const bindings: Array<string | number> = [query.kind];
  const predicates = ['document_kind = ?'];
  if (query.dropId !== undefined) {
    if (query.dropId === null) predicates.push('drop_id IS NULL');
    else {
      predicates.push('drop_id = ?');
      bindings.push(query.dropId);
    }
  }
  for (const filter of query.filters || []) {
    const column = INDEXED_COLUMNS[filter.field];
    if (filter.op === 'equal') {
      predicates.push(`${column} = ?`);
      bindings.push(sqlFilterValue(filter.value as CommerceFilterValue));
    } else {
      const values = filter.value as readonly CommerceFilterValue[];
      predicates.push(`${column} IN (${values.map(() => '?').join(', ')})`);
      bindings.push(...values.map(sqlFilterValue));
    }
  }
  const orderBy = query.orderBy || [];
  if (query.startAfter && orderBy[0]?.field === 'documentPath') {
    predicates.push(`document_path ${orderBy[0].direction === 'asc' ? '>' : '<'} ?`);
    bindings.push(query.startAfter[0] as string);
  } else if (query.startAfter) {
    const processedAt = query.startAfter[0] as CommerceTimestamp;
    const documentPath = query.startAfter[1] as string;
    predicates.push(`(
      processed_at_seconds IS NULL OR
      processed_at_seconds < ? OR
      (processed_at_seconds = ? AND processed_at_nanos < ?) OR
      (processed_at_seconds = ? AND processed_at_nanos = ? AND document_path < ?)
    )`);
    bindings.push(
      processedAt.seconds,
      processedAt.seconds,
      processedAt.nanos,
      processedAt.seconds,
      processedAt.nanos,
      documentPath,
    );
  }
  const orderParts: string[] = [];
  for (const order of orderBy) {
    const direction = order.direction === 'asc' ? 'ASC' : 'DESC';
    if (order.field === 'documentPath') orderParts.push(`document_path ${direction}`);
    else if (order.field === 'processedAt') {
      orderParts.push(`processed_at_seconds ${direction}`, `processed_at_nanos ${direction}`);
    } else orderParts.push(`${INDEXED_COLUMNS[order.field]} ${direction}`);
  }
  if (!orderParts.length) orderParts.push('document_path ASC');
  else if (!orderBy.some((order) => order.field === 'documentPath')) orderParts.push('document_path ASC');
  const from = authoritative
    ? 'commerce_authority_control AS authority CROSS JOIN commerce_documents'
    : 'commerce_documents';
  if (authoritative) predicates.unshift("authority.singleton = 1 AND authority.authority_state = 'd1'");
  let sql = `SELECT ${DOCUMENT_COLUMNS} FROM ${from}
    WHERE ${predicates.join(' AND ')}
    ORDER BY ${orderParts.join(', ')}`;
  if (query.limit !== undefined) {
    sql += ' LIMIT ?';
    bindings.push(query.limit);
  }
  return { bindings, sql };
}

function reportInefficientQuery(
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

function positiveQueryLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce query limit.');
  }
  return value;
}

function deliveryOwner(value: string): string {
  if (typeof value !== 'string' || value.length < 1) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid delivery owner.');
  }
  return value;
}

function deliveryOwnerRevisionStatement(db: D1Database, owner: string): D1PreparedStatement {
  return db.prepare(`SELECT COALESCE((
    SELECT revision FROM commerce_delivery_owner_revisions WHERE owner = ?
  ), 0) AS revision`).bind(owner);
}

function documentPathRevisionStatement(db: D1Database, path: string): D1PreparedStatement {
  return db.prepare(`SELECT COALESCE((
    SELECT revision FROM commerce_document_path_revisions WHERE document_path = ?
  ), 0) AS revision`).bind(path);
}

function parseDeliveryOwnerRevision(result: D1Result<Record<string, unknown>>): number {
  const row = result.results[0];
  const revision = isObject(row) ? row.revision : undefined;
  if (
    result.success !== true ||
    result.results.length !== 1 ||
    !isObject(result.meta) ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) throw unavailableCommerceData();
  return revision;
}

function parseDocumentPathRevision(result: D1Result<Record<string, unknown>>): number {
  const row = result.results[0];
  const revision = isObject(row) ? row.revision : undefined;
  if (
    result.success !== true ||
    result.results.length !== 1 ||
    !isObject(result.meta) ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) throw unavailableCommerceData();
  return revision;
}

function parseConflictResult(result: D1Result<Record<string, unknown>>): boolean {
  const row = result.results[0];
  const conflict = isObject(row) ? row.conflict : undefined;
  if (
    result.success !== true ||
    result.results.length !== 1 ||
    !isObject(result.meta) ||
    (conflict !== 0 && conflict !== 1)
  ) throw unavailableCommerceData();
  return conflict === 1;
}

function authorityStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(COMMERCE_AUTHORITY_SELECT);
}

function parseAuthorityControl(row: unknown): CommerceAuthorityControl {
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

async function authority(db: D1Database): Promise<CommerceAuthorityControl> {
  const control = await loadCommerceAuthorityControl(db);
  if (control.state !== 'd1') throw unavailableCommerce();
  return control;
}

export class D1CommerceRepository {
  constructor(private readonly db: D1Database) {}

  async getAdminIrlRedeemRequestForWorkflowStatus<T extends CommerceDocumentData>(
    operationId: string,
  ): Promise<CommerceDocumentRecord<T> | null> {
    if (!/^airf-v1-[0-9a-f]{64}$/.test(operationId)) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid Admin IRL redeem Workflow operation id.');
    }
    const result = await this.readBatchWithAuthority(() => this.db.prepare(`SELECT ${DOCUMENT_COLUMNS}
      FROM commerce_authority_control AS authority CROSS JOIN commerce_documents
      WHERE
        authority.singleton = 1 AND
        document_kind = 'admin_irl_redeem_request' AND
        json_type(document_json, '$.workflowFinalizeV1.operationId') = 'text' AND
        json_extract(document_json, '$.workflowFinalizeV1.operationId') = ?
      ORDER BY document_path ASC
      LIMIT 2`).bind(operationId), true);
    if (result.results.length > 1) {
      throw new CommerceRepositoryError('internal', 'Duplicate Admin IRL redeem Workflow operation id.');
    }
    const document = result.results[0] ? parseRow(result.results[0]) : null;
    return document ? publicRecord<T>(document) : null;
  }

  async get<T extends CommerceDocumentData>(
    key: CommerceDocumentKey,
  ): Promise<CommerceDocumentRecord<T> | null> {
    const result = await this.readBatchWithAuthority(() => this.db.prepare(`SELECT ${DOCUMENT_COLUMNS}
      FROM commerce_authority_control AS authority CROSS JOIN commerce_documents
      WHERE authority.singleton = 1 AND authority.authority_state = 'd1' AND document_path = ?
      LIMIT 1`).bind(key.path));
    if (result.results.length > 1) throw unavailableCommerce();
    const document = result.results[0] ? parseRow(result.results[0]) : null;
    if (document && (
      document.key.kind !== key.kind ||
      document.key.dropId !== key.dropId ||
      document.key.documentId !== key.documentId
    )) throw new CommerceRepositoryError('internal', 'Commerce document identity mismatch.');
    return document ? publicRecord<T>(document) : null;
  }

  async query<T extends CommerceDocumentData>(query: CommerceQuery): Promise<CommerceDocumentRecord<T>[]> {
    const compiled = compileCommerceQuery(query, true);
    const result = await this.readBatchWithAuthority(
      () => this.db.prepare(compiled.sql).bind(...compiled.bindings),
    );
    const documents = result.results.map(parseRow);
    reportInefficientQuery('query', query.kind, result, documents.length);
    return documents.map((document) => publicRecord<T>(document));
  }

  async queryDeliveryOrderOwners(args: Readonly<{
    startAfterOwner?: string;
    limit: number;
  }>): Promise<string[]> {
    const limit = positiveQueryLimit(args.limit);
    const startAfterOwner = args.startAfterOwner === undefined
      ? undefined
      : deliveryOwner(args.startAfterOwner);
    const cursorPredicate = startAfterOwner === undefined ? '' : ' AND\n        document.owner > ?';
    const result = await this.readBatchWithAuthority(() => this.db.prepare(`SELECT DISTINCT document.owner AS owner
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents AS document INDEXED BY commerce_documents_delivery_owner_path
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document.document_kind = 'delivery_order' AND
        document.owner IS NOT NULL AND
        typeof(document.owner) = 'text' AND
        length(document.owner) BETWEEN 32 AND 44 AND
        document.owner NOT GLOB '*[^0-9A-Za-z]*' AND
        document.owner NOT GLOB '*[0OIl]*'${cursorPredicate}
      ORDER BY document.owner ASC
      LIMIT ?`).bind(...(startAfterOwner === undefined ? [limit] : [startAfterOwner, limit])));
    if (result.results.length > limit) throw unavailableCommerceData();
    const owners = result.results.map((row) => {
      if (!isObject(row) || typeof row.owner !== 'string') throw unavailableCommerceData();
      return row.owner;
    });
    reportInefficientQuery('delivery-order-owners', 'delivery_order', result, owners.length);
    return owners;
  }

  async queryDeliveryRecoveryOrders(owner: string): Promise<CommerceDocumentRecord[]> {
    const scopedOwner = deliveryOwner(owner);
    const result = await this.readBatchWithAuthority(() => this.db.prepare(`SELECT ${qualifiedDocumentColumns('document')}
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents AS document INDEXED BY commerce_documents_delivery_owner_status
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document.document_kind = 'delivery_order' AND
        document.owner = ? AND
        document.status IN ('processing', 'prepared')`).bind(scopedOwner));
    const documents = result.results.map(parseRow);
    reportInefficientQuery('delivery-recovery-orders', 'delivery_order', result, documents.length);
    return documents.map((document) => publicRecord(document));
  }

  async queryPendingReadyNotifications(args: {
    limit: number;
    owner?: string;
    startAfterPath?: string;
  }): Promise<CommerceDocumentRecord[]> {
    const limit = positiveQueryLimit(args.limit);
    const indexVariant = args.owner === undefined ? 'ownerless' : 'owner';
    const buyerIndex = PENDING_READY_NOTIFICATION_INDEXES.buyer[indexVariant];
    const shipperIndex = PENDING_READY_NOTIFICATION_INDEXES.shipper[indexVariant];
    const ownerPredicate = args.owner === undefined ? '' : ' AND document.owner = ?';
    const cursorPredicate = args.startAfterPath === undefined ? '' : ' AND document.document_path > ?';
    const armBindings = () => [
      ...(args.owner === undefined ? [] : [args.owner]),
      ...(args.startAfterPath === undefined ? [] : [args.startAfterPath]),
    ];
    const bindings = [...armBindings(), ...armBindings(), limit];
    const result = await this.readBatchWithAuthority(() => this.db.prepare(`WITH candidate_paths AS (
      SELECT document.document_path
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents AS document
        INDEXED BY ${buyerIndex}
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document.document_kind = 'delivery_order' AND
        document.status = 'ready_to_ship' AND
        document.buyer_notification_state = 'pending'${ownerPredicate}${cursorPredicate}
      UNION
      SELECT document.document_path
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents AS document
        INDEXED BY ${shipperIndex}
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document.document_kind = 'delivery_order' AND
        document.status = 'ready_to_ship' AND
        document.shipper_notification_state = 'pending'${ownerPredicate}${cursorPredicate}
    )
    SELECT ${qualifiedDocumentColumns('document')}
    FROM commerce_documents AS document
    JOIN candidate_paths USING (document_path)
    ORDER BY document.document_path ASC
    LIMIT ?`).bind(...bindings));
    reportInefficientQuery('pending-ready-notifications', 'delivery_order', result, result.results.length);
    return result.results.map(parseRow).map((document) => publicRecord(document));
  }

  async queryDuePackStatusProjections(args: {
    dropId: string;
    dueAtMs: number;
    limit: number;
  }): Promise<CommerceDocumentRecord[]> {
    const limit = positiveQueryLimit(args.limit);
    if (!Number.isSafeInteger(args.dueAtMs) || args.dueAtMs < 0) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce projection cutoff.');
    }
    const result = await this.readBatchWithAuthority(() => this.db.prepare(`SELECT ${DOCUMENT_COLUMNS}
      FROM commerce_authority_control AS authority CROSS JOIN commerce_documents
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document_kind = 'delivery_order' AND
        drop_id = ? AND
        pack_projection_state = 'pending' AND
        pack_projection_next_attempt_ms <= ?
      ORDER BY pack_projection_next_attempt_ms ASC, document_path ASC
      LIMIT ?`).bind(args.dropId, args.dueAtMs, limit));
    reportInefficientQuery('due-pack-status-projections', 'delivery_order', result, result.results.length);
    return result.results.map(parseRow).map((document) => publicRecord(document));
  }

  async queryStaleStripeFulfillments(cutoffMs: number): Promise<CommerceDocumentRecord[]> {
    if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe reconciliation cutoff.');
    }
    const result = await this.readBatchWithAuthority(() => this.db.prepare(`SELECT ${DOCUMENT_COLUMNS}
      FROM commerce_authority_control AS authority
      CROSS JOIN commerce_documents INDEXED BY commerce_stripe_checkouts_reconciliation_due
      WHERE
        authority.singleton = 1 AND
        authority.authority_state = 'd1' AND
        document_kind = 'stripe_checkout' AND
        fulfillment_processor = '${STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR}' AND
        status IN ('${STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING}', '${STRIPE_CHECKOUT_STATUS.PROCESSING}') AND
        json_type(document_json, '$.updatedAt') IN ('integer', 'real') AND
        json_type(document_json, '$.lastStripeWebhookEventId') = 'text' AND
        CAST(json_extract(document_json, '$.updatedAt') AS INTEGER) <= ?
      ORDER BY CAST(json_extract(document_json, '$.updatedAt') AS INTEGER) ASC, document_path ASC
      LIMIT 100`).bind(cutoffMs));
    reportInefficientQuery('stale-stripe-fulfillments', 'stripe_checkout', result, result.results.length);
    return result.results.map(parseRow).map((document) => publicRecord(document));
  }

  async begin(nowMs: number): Promise<CommerceUnitOfWork> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce operation timestamp.');
    }
    const control = await authority(this.db);
    return new CommerceUnitOfWork(this.db, nowMs, control);
  }

  async run<T>(nowMs: number, operation: (unit: CommerceUnitOfWork) => Promise<T>): Promise<T> {
    const unit = await this.begin(nowMs);
    try {
      const result = await operation(unit);
      await unit.commit();
      return result;
    } catch (error) {
      unit.rollback();
      throw error;
    }
  }

  private async readBatchWithAuthority(
    statement: () => D1PreparedStatement,
    allowPaused = false,
  ): Promise<D1Result<Record<string, unknown>>> {
    let results: D1Result<Record<string, unknown>>[];
    try {
      results = await this.db.batch<Record<string, unknown>>([
        authorityStatement(this.db),
        statement(),
      ]);
    } catch (error) {
      reportCommerceReadFailure(error);
      throw unavailableCommerce(error);
    }
    if (results.length !== 2) throw unavailableCommerce();
    const [authorityResult, dataResult] = results;
    if (
      authorityResult.success !== true ||
      dataResult.success !== true ||
      authorityResult.results.length !== 1 ||
      !Array.isArray(dataResult.results) ||
      !isObject(authorityResult.meta) ||
      !isObject(dataResult.meta)
    ) throw unavailableCommerce();
    const control = parseAuthorityControl(authorityResult.results[0]);
    if (control.state !== 'd1' && !(allowPaused && control.state === 'paused')) throw unavailableCommerce();
    return dataResult;
  }
}

export class CommerceUnitOfWork {
  private closed = false;
  private readonly deliveryOwnerExpectations = new Map<string, number>();
  private readonly expectations = new Map<string, DocumentExpectation>();
  private readonly original = new Map<string, StoredDocument | null>();
  private readonly pending = new Map<string, PendingDocument>();
  private readonly createPaths = new Set<string>();
  private readonly existingPaths = new Set<string>();
  private commitTimestamp: CommerceTimestamp;
  private writesStarted = false;

  constructor(
    private readonly db: D1Database,
    nowMs: number,
    _control: CommerceAuthorityControl,
  ) {
    this.commitTimestamp = timestampFromMilliseconds(nowMs);
  }

  async get<T extends CommerceDocumentData>(
    key: CommerceDocumentKey,
  ): Promise<CommerceDocumentRecord<T> | null> {
    this.assertOpen();
    if (this.writesStarted) throw new CommerceRepositoryError('invalid-argument', 'Commerce reads must precede writes.');
    const document = await this.load(key);
    return document ? publicRecord<T>(document) : null;
  }

  async getMany<T extends CommerceDocumentData>(
    keys: readonly CommerceDocumentKey[],
  ): Promise<Array<CommerceDocumentRecord<T> | null>> {
    this.assertOpen();
    if (this.writesStarted) throw new CommerceRepositoryError('invalid-argument', 'Commerce reads must precede writes.');
    const uniqueKeys = new Map<string, CommerceDocumentKey>();
    for (const key of keys) {
      const previous = uniqueKeys.get(key.path);
      if (previous) assertDocumentIdentity(key, previous);
      uniqueKeys.set(key.path, key);
    }
    const uncachedKeys = Array.from(uniqueKeys.values()).filter((key) =>
      !this.original.has(key.path) || this.expectations.get(key.path)?.pathRevision === undefined);
    for (let offset = 0; offset < uncachedKeys.length; offset += COMMERCE_READ_BATCH_SIZE) {
      await this.loadBatch(uncachedKeys.slice(offset, offset + COMMERCE_READ_BATCH_SIZE));
    }
    return keys.map((key) => {
      const document = this.original.get(key.path);
      if (!document) return null;
      assertDocumentIdentity(document.key, key);
      return publicRecord<T>(document);
    });
  }

  async queryDeliveryOrdersByOwner<T extends CommerceDocumentData>(
    args: Readonly<{ owner: string; limit: number }>,
  ): Promise<CommerceDocumentRecord<T>[]> {
    this.assertOpen();
    if (this.writesStarted) throw new CommerceRepositoryError('invalid-argument', 'Commerce reads must precede writes.');
    const scopedOwner = deliveryOwner(args.owner);
    const boundedLimit = positiveQueryLimit(args.limit);
    const results = await this.db.batch<Record<string, unknown>>([
      deliveryOwnerRevisionStatement(this.db, scopedOwner),
      this.db.prepare(`SELECT ${DOCUMENT_COLUMNS}
        FROM commerce_documents INDEXED BY commerce_documents_delivery_owner_path
        WHERE document_kind = 'delivery_order' AND owner = ?
        ORDER BY document_path ASC
        LIMIT ?`).bind(scopedOwner, boundedLimit),
    ]);
    if (results.length !== 2) throw unavailableCommerceData();
    const [revisionResult, dataResult] = results;
    const revision = parseDeliveryOwnerRevision(revisionResult);
    if (
      dataResult.success !== true ||
      !Array.isArray(dataResult.results) ||
      !isObject(dataResult.meta)
    ) throw unavailableCommerceData();
    const expectedRevision = this.deliveryOwnerExpectations.get(scopedOwner);
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new CommerceWriteConflict();
    this.deliveryOwnerExpectations.set(scopedOwner, revision);
    const documents = dataResult.results.map(parseRow);
    reportInefficientQuery('delivery-orders-by-owner', 'delivery_order', dataResult, documents.length);
    for (const document of documents) this.recordRead(document.key.path, document.version, document);
    return documents.map((document) => publicRecord<T>(document));
  }

  async create(
    key: CommerceDocumentKey,
    data: CommerceDocumentWriteData,
  ): Promise<CommerceDocumentRecord> {
    this.assertOpen();
    const current = await this.loadForMutation(key);
    if (current) throw new CommerceWriteConflict('already-exists');
    this.createPaths.add(key.path);
    const document = this.newDocument(key, data);
    this.pending.set(key.path, document);
    return publicRecord(document);
  }

  async set(
    key: CommerceDocumentKey,
    data: CommerceDocumentWriteData,
    options: Readonly<{ merge?: boolean }> = {},
  ): Promise<void> {
    this.assertOpen();
    const current = await this.loadForMutation(key);
    if (!options.merge) {
      this.pending.set(key.path, this.replaceDocument(key, current, data));
      return;
    }
    const updates = Object.fromEntries(Object.entries(data)) as Record<string, CommerceUpdateValue>;
    this.pending.set(key.path, this.patchDocument(key, current, updates, false));
  }

  async update(key: CommerceDocumentKey, updates: Readonly<Record<string, CommerceUpdateValue>>): Promise<void> {
    this.assertOpen();
    const current = await this.loadForMutation(key);
    if (!current) throw new CommerceWriteConflict('failed-precondition');
    if (!this.createPaths.has(key.path)) this.existingPaths.add(key.path);
    this.pending.set(key.path, this.patchDocument(key, current, updates, true));
  }

  async delete(key: CommerceDocumentKey, options: Readonly<{ mustExist?: boolean }> = {}): Promise<void> {
    this.assertOpen();
    const current = await this.loadForMutation(key);
    if (options.mustExist && !current) throw new CommerceWriteConflict('failed-precondition');
    if (options.mustExist && !this.createPaths.has(key.path)) this.existingPaths.add(key.path);
    this.pending.set(key.path, null);
  }

  async commit(): Promise<void> {
    this.assertOpen();
    this.closed = true;
    const documentExpectationsJson = JSON.stringify(this.serializedDocumentExpectations());
    const deliveryOwnerExpectationsJson = JSON.stringify(this.serializedDeliveryOwnerExpectations());
    if (!this.pending.size) {
      if (!this.deliveryOwnerExpectations.size && !this.expectations.size) {
        await authority(this.db);
        return;
      }
      await this.revalidateReadOnly(documentExpectationsJson, deliveryOwnerExpectationsJson);
      return;
    }
    const guardId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`INSERT INTO commerce_commit_guards (
        guard_id, expectations_json, delivery_owner_expectations_json,
        expected_documents_revision, created_at_ms
      ) VALUES (?, ?, ?, ?, ?)`).bind(
        guardId,
        documentExpectationsJson,
        deliveryOwnerExpectationsJson,
        null,
        timestampMilliseconds(this.commitTimestamp),
      ),
    ];
    for (const [path, document] of this.pending) {
      if (!document) {
        statements.push(this.db.prepare('DELETE FROM commerce_documents WHERE document_path = ?').bind(path));
        continue;
      }
      statements.push(this.db.prepare(`INSERT INTO commerce_documents (
        document_path, document_kind, drop_id, document_id, document_json,
        version, create_time, update_time, processed_at_seconds, processed_at_nanos
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_path) DO UPDATE SET
        document_kind = excluded.document_kind,
        drop_id = excluded.drop_id,
        document_id = excluded.document_id,
        document_json = excluded.document_json,
        version = excluded.version,
        create_time = excluded.create_time,
        update_time = excluded.update_time,
        processed_at_seconds = excluded.processed_at_seconds,
        processed_at_nanos = excluded.processed_at_nanos`).bind(
        document.key.path,
        document.key.kind,
        document.key.dropId,
        document.key.documentId,
        JSON.stringify(document.data),
        document.version,
        document.createTime,
        document.updateTime,
        document.processedAt?.seconds ?? null,
        document.processedAt?.nanos ?? null,
      ));
    }
    statements.push(this.db.prepare(`UPDATE commerce_authority_control
      SET documents_revision = documents_revision + 1, updated_at_ms = ? WHERE singleton = 1`)
      .bind(timestampMilliseconds(this.commitTimestamp)));
    statements.push(this.db.prepare('DELETE FROM commerce_commit_guards WHERE guard_id = ?').bind(guardId));
    try {
      await this.db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/authority is not d1/i.test(message)) {
        throw new CommerceRepositoryError('unavailable', 'Commerce is temporarily unavailable for maintenance.');
      }
      if (/transaction conflict|UNIQUE constraint|cannot start a transaction within a transaction/i.test(message)) {
        for (const path of this.createPaths) {
          if (await this.documentExists(path)) throw new CommerceWriteConflict('already-exists');
        }
        for (const path of this.existingPaths) {
          if (!(await this.documentExists(path))) throw new CommerceWriteConflict('failed-precondition');
        }
        throw new CommerceWriteConflict();
      }
      throw error;
    }
  }

  rollback(): void {
    this.closed = true;
    this.pending.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new CommerceRepositoryError('invalid-argument', 'Commerce unit of work is closed.');
  }

  private serializedDeliveryOwnerExpectations(): DeliveryOwnerExpectation[] {
    return Array.from(this.deliveryOwnerExpectations, ([owner, revision]) => ({ owner, revision }))
      .sort((left, right) => left.owner < right.owner ? -1 : left.owner > right.owner ? 1 : 0);
  }

  private serializedDocumentExpectations(): DocumentExpectation[] {
    return Array.from(this.expectations.values())
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }

  private async revalidateReadOnly(
    documentExpectationsJson: string,
    deliveryOwnerExpectationsJson: string,
  ): Promise<void> {
    let results: D1Result<Record<string, unknown>>[];
    try {
      results = await this.db.batch<Record<string, unknown>>([
        authorityStatement(this.db),
        this.db.prepare(`SELECT EXISTS (
          SELECT 1
          FROM json_each(?) AS expectation
          LEFT JOIN commerce_delivery_owner_revisions AS owner_revision
            ON owner_revision.owner = json_extract(expectation.value, '$.owner')
          WHERE COALESCE(owner_revision.revision, 0) <>
            CAST(json_extract(expectation.value, '$.revision') AS INTEGER)
        ) AS conflict`).bind(deliveryOwnerExpectationsJson),
        this.db.prepare(`SELECT EXISTS (
          SELECT 1
          FROM json_each(?) AS expectation
          LEFT JOIN commerce_documents AS document
            ON document.document_path = json_extract(expectation.value, '$.path')
          LEFT JOIN commerce_document_path_revisions AS path_revision
            ON path_revision.document_path = json_extract(expectation.value, '$.path')
          WHERE
            COALESCE(document.version, -1) <>
              CAST(json_extract(expectation.value, '$.version') AS INTEGER) OR
            (
              json_type(expectation.value, '$.pathRevision') IS NOT NULL AND
              COALESCE(path_revision.revision, 0) <>
                CAST(json_extract(expectation.value, '$.pathRevision') AS INTEGER)
            )
        ) AS conflict`).bind(documentExpectationsJson),
      ]);
    } catch (error) {
      throw unavailableCommerce(error);
    }
    if (results.length !== 3) throw unavailableCommerce();
    const [authorityResult, ownerResult, documentResult] = results;
    if (
      authorityResult.success !== true ||
      authorityResult.results.length !== 1 ||
      !isObject(authorityResult.meta)
    ) throw unavailableCommerce();
    const control = parseAuthorityControl(authorityResult.results[0]);
    if (control.state !== 'd1') throw unavailableCommerce();
    if (
      parseConflictResult(ownerResult) ||
      parseConflictResult(documentResult)
    ) {
      throw new CommerceWriteConflict();
    }
  }

  private async documentExists(path: string): Promise<boolean> {
    return Boolean(await this.db.prepare(`SELECT document_path FROM commerce_documents
      WHERE document_path = ?`).bind(path).first());
  }

  private async load(key: CommerceDocumentKey): Promise<StoredDocument | null> {
    const cached = this.original.has(key.path);
    if (cached && this.expectations.get(key.path)?.pathRevision !== undefined) {
      return this.original.get(key.path) || null;
    }
    const results = await this.db.batch<Record<string, unknown>>([
      documentPathRevisionStatement(this.db, key.path),
      this.db.prepare(`SELECT ${DOCUMENT_COLUMNS}
        FROM commerce_documents WHERE document_path = ?`).bind(key.path),
    ]);
    if (results.length !== 2) throw unavailableCommerceData();
    const [pathRevisionResult, documentResult] = results;
    const pathRevision = parseDocumentPathRevision(pathRevisionResult);
    if (
      documentResult.success !== true ||
      documentResult.results.length > 1 ||
      !Array.isArray(documentResult.results) ||
      !isObject(documentResult.meta)
    ) throw unavailableCommerceData();
    const row = documentResult.results[0];
    const document = row ? parseRow(row) : null;
    if (document) assertDocumentIdentity(document.key, key);
    this.recordRead(key.path, document?.version ?? -1, document, pathRevision);
    return this.original.get(key.path) || null;
  }

  private async loadBatch(keys: readonly CommerceDocumentKey[]): Promise<void> {
    const keysByPath = new Map(keys.map((key) => [key.path, key]));
    const paths = Array.from(keysByPath.keys());
    const placeholders = paths.map(() => '?').join(', ');
    const results = await this.db.batch<Record<string, unknown>>([
      this.db.prepare(`SELECT document_path, revision FROM commerce_document_path_revisions
        WHERE document_path IN (${placeholders})`).bind(...paths),
      this.db.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM commerce_documents
        WHERE document_path IN (${placeholders})`).bind(...paths),
    ]);
    if (!Array.isArray(results) || results.length !== 2) throw unavailableCommerceData();
    for (const result of results) {
      if (
        !isObject(result) || result.success !== true ||
        !Array.isArray(result.results) || !isObject(result.meta)
      ) throw unavailableCommerceData();
    }
    const [revisionResult, documentResult] = results;
    const revisions = new Map<string, number>();
    for (const row of revisionResult.results) {
      if (
        !isObject(row) || typeof row.document_path !== 'string' ||
        !keysByPath.has(row.document_path) || revisions.has(row.document_path) ||
        typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0
      ) throw unavailableCommerceData();
      revisions.set(row.document_path, row.revision);
    }
    const documents = new Map<string, StoredDocument>();
    for (const row of documentResult.results) {
      const document = parseRow(row);
      const key = keysByPath.get(document.key.path);
      if (!key || documents.has(document.key.path)) throw unavailableCommerceData();
      assertDocumentIdentity(document.key, key);
      documents.set(key.path, document);
    }
    for (const key of keys) {
      const document = documents.get(key.path) ?? null;
      this.recordRead(key.path, document?.version ?? -1, document, revisions.get(key.path) ?? 0);
    }
  }

  private recordRead(
    path: string,
    version: number,
    document: StoredDocument | null,
    pathRevision?: number,
  ): void {
    const expected = this.expectations.get(path);
    if (
      expected &&
      (
        expected.version !== version ||
        (expected.pathRevision !== undefined &&
          pathRevision !== undefined &&
          expected.pathRevision !== pathRevision)
      )
    ) throw new CommerceWriteConflict();
    const mergedPathRevision = pathRevision ?? expected?.pathRevision;
    this.expectations.set(
      path,
      mergedPathRevision === undefined
        ? { path, version }
        : { path, version, pathRevision: mergedPathRevision },
    );
    if (!this.original.has(path)) this.original.set(path, document);
    const storedTimestamp = document ? parseTimestampString(document.updateTime) : null;
    if (storedTimestamp && compareTimestamps(storedTimestamp, this.commitTimestamp) >= 0) {
      this.commitTimestamp = nextTimestamp(storedTimestamp);
    }
  }

  private async loadForMutation(key: CommerceDocumentKey): Promise<StoredDocument | null> {
    this.writesStarted = true;
    if (this.pending.has(key.path)) return this.pending.get(key.path) || null;
    return this.load(key);
  }

  private newDocument(key: CommerceDocumentKey, data: CommerceDocumentWriteData): StoredDocument {
    const now = this.commitTimestamp;
    const materialized = this.materializeDocument(data, now);
    const commitTime = timestampString(now);
    return {
      createTime: commitTime,
      data: materialized.data,
      key,
      processedAt: materialized.processedAt,
      updateTime: commitTime,
      version: this.nextDocumentVersion(key, null),
    };
  }

  private replaceDocument(
    key: CommerceDocumentKey,
    current: StoredDocument | null,
    data: CommerceDocumentWriteData,
  ): StoredDocument {
    const now = this.commitTimestamp;
    const materialized = this.materializeDocument(data, now);
    const version = this.nextDocumentVersion(key, current);
    const commitTime = timestampString(now);
    return {
      createTime: current?.createTime || commitTime,
      data: materialized.data,
      key,
      processedAt: materialized.processedAt,
      updateTime: commitTime,
      version,
    };
  }

  private patchDocument(
    key: CommerceDocumentKey,
    current: StoredDocument | null,
    updates: Readonly<Record<string, CommerceUpdateValue>>,
    requireExisting: boolean,
  ): StoredDocument {
    if (requireExisting && !current) throw new CommerceWriteConflict('failed-precondition');
    const now = this.commitTimestamp;
    const data = current ? cloneData(current.data) : {};
    let processedAt = current?.processedAt || null;
    for (const [fieldPath, update] of Object.entries(updates)) {
      if (!fieldPath || fieldPath.split('.').some((part) => !part)) {
        throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce field path.');
      }
      const currentValue = dataField(data, fieldPath) as CommerceJsonValue | undefined;
      const value = materializeUpdate(currentValue, update, now);
      setDataField(data, fieldPath, value);
      if (fieldPath === 'processedAt') {
        processedAt = processedTimestampForUpdate(processedAt, currentValue, update, value, now);
      }
    }
    const version = this.nextDocumentVersion(key, current);
    const commitTime = timestampString(now);
    return {
      createTime: current?.createTime || commitTime,
      data,
      key,
      processedAt,
      updateTime: commitTime,
      version,
    };
  }

  private nextDocumentVersion(key: CommerceDocumentKey, current: StoredDocument | null): number {
    const original = this.original.get(key.path);
    return Math.max(current?.version || 0, original?.version || 0) + 1;
  }

  private materializeDocument(
    data: CommerceDocumentWriteData,
    now: CommerceTimestamp,
  ): { data: CommerceDocumentData; processedAt: CommerceTimestamp | null } {
    const materialized: CommerceDocumentData = {};
    let processedAt: CommerceTimestamp | null = null;
    for (const [field, value] of Object.entries(data)) {
      const result = materializeUpdate(undefined, value, now);
      if (result === undefined) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce document value.');
      materialized[field] = result;
      if (field === 'processedAt') {
        processedAt = processedTimestampForUpdate(null, undefined, value, result, now);
      }
    }
    return { data: materialized, processedAt };
  }
}
