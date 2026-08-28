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
const COMMERCE_AUTHORITY_SELECT = `SELECT authority_state, revision, documents_revision
  FROM commerce_authority_control WHERE singleton = 1`;

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

  async queryPendingReadyNotifications(args: {
    limit: number;
    owner?: string;
    startAfterPath?: string;
  }): Promise<CommerceDocumentRecord[]> {
    const limit = positiveQueryLimit(args.limit);
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
        INDEXED BY commerce_delivery_orders_buyer_notifications_pending
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
        INDEXED BY commerce_delivery_orders_shipper_notifications_pending
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
    if (control.state !== 'd1') throw unavailableCommerce();
    return dataResult;
  }
}

export class CommerceUnitOfWork {
  private closed = false;
  private expectedDocumentsRevision: number | null = null;
  private readonly expectations = new Map<string, number>();
  private readonly original = new Map<string, StoredDocument | null>();
  private readonly pending = new Map<string, PendingDocument>();
  private readonly createPaths = new Set<string>();
  private readonly existingPaths = new Set<string>();
  private commitTimestamp: CommerceTimestamp;
  private writesStarted = false;

  constructor(
    private readonly db: D1Database,
    nowMs: number,
    private readonly control: CommerceAuthorityControl,
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

  async query<T extends CommerceDocumentData>(query: CommerceQuery): Promise<CommerceDocumentRecord<T>[]> {
    this.assertOpen();
    if (this.writesStarted) throw new CommerceRepositoryError('invalid-argument', 'Commerce reads must precede writes.');
    this.expectedDocumentsRevision ??= this.control.documentsRevision;
    const compiled = compileCommerceQuery(query);
    const result = await this.db.prepare(compiled.sql).bind(...compiled.bindings).all<Record<string, unknown>>();
    const documents = result.results.map(parseRow);
    reportInefficientQuery('query', query.kind, result, documents.length);
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
    if (!this.pending.size) {
      const control = await authority(this.db);
      if (
        this.expectedDocumentsRevision !== null &&
        this.expectedDocumentsRevision !== control.documentsRevision
      ) throw new CommerceWriteConflict();
      return;
    }
    const guardId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`INSERT INTO commerce_commit_guards (
        guard_id, expectations_json, expected_documents_revision, created_at_ms
      ) VALUES (?, ?, ?, ?)`).bind(
        guardId,
        JSON.stringify(Array.from(this.expectations, ([path, version]) => ({ path, version }))),
        this.expectedDocumentsRevision,
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
      if (/transaction conflict|UNIQUE constraint/i.test(message)) {
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

  private async documentExists(path: string): Promise<boolean> {
    return Boolean(await this.db.prepare(`SELECT document_path FROM commerce_documents
      WHERE document_path = ?`).bind(path).first());
  }

  private async load(key: CommerceDocumentKey): Promise<StoredDocument | null> {
    if (this.original.has(key.path)) return this.original.get(key.path) || null;
    const row = await this.db.prepare(`SELECT ${DOCUMENT_COLUMNS}
      FROM commerce_documents WHERE document_path = ?`).bind(key.path).first<Record<string, unknown>>();
    const document = row ? parseRow(row) : null;
    if (document && (document.key.kind !== key.kind || document.key.dropId !== key.dropId || document.key.documentId !== key.documentId)) {
      throw new CommerceRepositoryError('internal', 'Commerce document identity mismatch.');
    }
    this.recordRead(key.path, document?.version ?? -1, document);
    return document;
  }

  private recordRead(path: string, version: number, document: StoredDocument | null): void {
    const expected = this.expectations.get(path);
    if (expected !== undefined && expected !== version) throw new CommerceWriteConflict();
    this.expectations.set(path, version);
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
      version: 1,
    };
  }

  private replaceDocument(
    key: CommerceDocumentKey,
    current: StoredDocument | null,
    data: CommerceDocumentWriteData,
  ): StoredDocument {
    const now = this.commitTimestamp;
    const materialized = this.materializeDocument(data, now);
    const version = (current?.version || 0) + 1;
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
    const version = (current?.version || 0) + 1;
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
