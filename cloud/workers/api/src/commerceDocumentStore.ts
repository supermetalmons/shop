import {
  FIRESTORE_DATABASE_NAME,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  FirestoreWriteConflict,
  ProfileReadError,
  decodeFirestoreFields,
  isRecord,
} from './firestoreContract.js';

export type CommerceAuthorityState = 'firestore' | 'paused' | 'd1';

export type CommerceAuthorityControl = {
  state: CommerceAuthorityState;
  revision: number;
  documentsRevision: number;
};

export class CommerceMaintenanceError extends ProfileReadError {
  constructor() {
    super('unavailable', 503, 'Commerce is temporarily unavailable for maintenance.', {
      reason: 'commerce-maintenance',
    });
    this.name = 'CommerceMaintenanceError';
  }
}

type CommerceDocumentKind =
  | 'delivery_order'
  | 'stripe_checkout'
  | 'claim_code'
  | 'box_assignment'
  | 'dude_assignment'
  | 'dude_pool'
  | 'offchain_order'
  | 'admin_irl_redeem_request'
  | 'admin_irl_redeem_pack_marker'
  | 'admin_irl_redeem_receipt_marker';

type CommerceDocumentIdentity = {
  kind: CommerceDocumentKind;
  dropId: string | null;
  documentId: string;
};

type CommerceDocumentRow = {
  document_path: string;
  document_kind: CommerceDocumentKind;
  drop_id: string | null;
  document_id: string;
  fields_json: string;
  version: number;
  create_time: string;
  update_time: string;
};

type StoredDocument = {
  path: string;
  kind: CommerceDocumentKind;
  dropId: string | null;
  documentId: string;
  fields: Record<string, unknown>;
  version: number;
  createTime: string;
  updateTime: string;
};

type PendingDocument = StoredDocument | null;

export type CommerceDocumentStoreRequest = {
  body?: string;
  method: 'GET' | 'POST';
  nowMs: number;
  url: string;
};

interface CommerceDocumentStore {
  request(args: CommerceDocumentStoreRequest): Promise<unknown | null>;
}

const FIRESTORE_API_PREFIX = `/${FIRESTORE_DATABASE_NAME}/documents`;
const TRANSACTION_TTL_MS = 60_000;
const FIELD_COLUMN = new Map<string, string>([
  ['owner', 'owner'],
  ['status', 'status'],
  ['source', 'source'],
  ['fulfillmentStatus', 'fulfillment_status'],
  ['fulfillmentProcessor', 'fulfillment_processor'],
  ['manualRefundReviewRequired', 'manual_refund_review_required'],
  ['irlClaimCode', 'irl_claim_code'],
  ['packStatusProjectionState', 'pack_projection_state'],
  ['packStatusProjectionNextAttemptAtMs', 'pack_projection_next_attempt_ms'],
  ['buyerOrderReceivedEmailState', 'buyer_notification_state'],
  ['shipperReadyToShipEmailState', 'shipper_notification_state'],
]);

export async function loadCommerceAuthorityControl(db: D1Database): Promise<CommerceAuthorityControl> {
  const row = await db.prepare(`SELECT authority_state, revision, documents_revision
    FROM commerce_authority_control WHERE singleton = 1`).first<{
      authority_state: CommerceAuthorityState;
      revision: number;
      documents_revision: number;
    }>();
  if (
    !row ||
    !['firestore', 'paused', 'd1'].includes(row.authority_state) ||
    !Number.isSafeInteger(row.revision) ||
    !Number.isSafeInteger(row.documents_revision)
  ) throw new ProfileReadError('unavailable', 503, 'Commerce data is temporarily unavailable.');
  return {
    state: row.authority_state,
    revision: row.revision,
    documentsRevision: row.documents_revision,
  };
}

export function commerceDocumentIdentity(path: string): CommerceDocumentIdentity | null {
  const segments = path.split('/');
  if (segments.length === 2 && segments[0] === 'claimCodes' && segments[1]) {
    return { kind: 'claim_code', dropId: null, documentId: segments[1] };
  }
  if (segments.length !== 4 || segments[0] !== 'drops' || !segments[1] || !segments[3]) return null;
  const kind = new Map<string, CommerceDocumentKind>([
    ['deliveryOrders', 'delivery_order'],
    ['stripeCheckouts', 'stripe_checkout'],
    ['boxAssignments', 'box_assignment'],
    ['dudeAssignments', 'dude_assignment'],
    ['offchainOrders', 'offchain_order'],
    ['adminIrlRedeemRequests', 'admin_irl_redeem_request'],
    ['adminIrlRedeemPackMarkers', 'admin_irl_redeem_pack_marker'],
    ['adminIrlRedeemReceiptMarkers', 'admin_irl_redeem_receipt_marker'],
  ]).get(segments[2]);
  if (kind) return { kind, dropId: segments[1], documentId: segments[3] };
  if (segments[2] === 'meta' && segments[3] === 'dudePool') {
    return { kind: 'dude_pool', dropId: segments[1], documentId: segments[3] };
  }
  return null;
}

function kindForCollection(collectionId: string): CommerceDocumentKind | null {
  return new Map<string, CommerceDocumentKind>([
    ['deliveryOrders', 'delivery_order'],
    ['stripeCheckouts', 'stripe_checkout'],
    ['claimCodes', 'claim_code'],
    ['boxAssignments', 'box_assignment'],
    ['dudeAssignments', 'dude_assignment'],
    ['offchainOrders', 'offchain_order'],
    ['adminIrlRedeemRequests', 'admin_irl_redeem_request'],
    ['adminIrlRedeemPackMarkers', 'admin_irl_redeem_pack_marker'],
    ['adminIrlRedeemReceiptMarkers', 'admin_irl_redeem_receipt_marker'],
  ]).get(collectionId) ?? null;
}

function parseRow(row: CommerceDocumentRow): StoredDocument {
  let fields: unknown;
  try {
    fields = JSON.parse(row.fields_json);
  } catch {
    throw new ProfileReadError('unavailable', 503, 'Commerce data is temporarily unavailable.');
  }
  if (!isRecord(fields) || !commerceDocumentIdentity(row.document_path)) {
    throw new ProfileReadError('unavailable', 503, 'Commerce data is temporarily unavailable.');
  }
  return {
    path: row.document_path,
    kind: row.document_kind,
    dropId: row.drop_id,
    documentId: row.document_id,
    fields,
    version: row.version,
    createTime: row.create_time,
    updateTime: row.update_time,
  };
}

function firestoreDocument(document: StoredDocument, selectedFields?: readonly string[]): Record<string, unknown> {
  const fields = selectedFields
    ? Object.fromEntries(selectedFields.flatMap((fieldPath) => {
      const value = rawFieldValue(document.fields, fieldPath);
      return value === undefined ? [] : [[fieldPath, value]];
    }))
    : document.fields;
  return {
    name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${document.path}`,
    fields,
    createTime: document.createTime,
    updateTime: document.updateTime,
  };
}

function decodeDocumentPathFromName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.startsWith(FIRESTORE_DOCUMENT_NAME_PREFIX)) return null;
  const path = name.slice(FIRESTORE_DOCUMENT_NAME_PREFIX.length);
  return commerceDocumentIdentity(path) ? path : null;
}

function requestSuffix(url: URL): string | null {
  const index = url.pathname.indexOf(FIRESTORE_API_PREFIX);
  if (index < 0) return null;
  return url.pathname.slice(index + FIRESTORE_API_PREFIX.length);
}

function decodePath(value: string): string {
  return value.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment)).join('/');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rawFieldValue(fields: Record<string, unknown>, fieldPath: string): unknown {
  const parts = fieldPath.split('.');
  let current: unknown = fields[parts[0]];
  for (let index = 1; index < parts.length; index += 1) {
    if (!isRecord(current) || !isRecord(current.mapValue) || !isRecord(current.mapValue.fields)) return undefined;
    current = current.mapValue.fields[parts[index]];
  }
  return current;
}

function setRawFieldValue(fields: Record<string, unknown>, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split('.');
  if (parts.length === 1) {
    if (value === undefined) delete fields[fieldPath];
    else fields[fieldPath] = value;
    return;
  }
  let current = fields;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const existing = current[key];
    if (!isRecord(existing) || !isRecord(existing.mapValue) || !isRecord(existing.mapValue.fields)) {
      current[key] = { mapValue: { fields: {} } };
    }
    current = ((current[key] as Record<string, unknown>).mapValue as Record<string, unknown>).fields as Record<string, unknown>;
  }
  const last = parts.at(-1)!;
  if (value === undefined) delete current[last];
  else current[last] = value;
}

function decodedRawValue(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (Object.hasOwn(value, 'nullValue')) return null;
  if (typeof value.booleanValue === 'boolean') return value.booleanValue;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.timestampValue === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value.timestampValue);
    if (match) {
      const seconds = Date.parse(`${match[1]}Z`) / 1000;
      if (Number.isSafeInteger(seconds)) {
        return BigInt(seconds) * 1_000_000_000n + BigInt((match[2] || '').padEnd(9, '0'));
      }
    }
    const milliseconds = Date.parse(value.timestampValue);
    return Number.isFinite(milliseconds) ? BigInt(milliseconds) * 1_000_000n : undefined;
  }
  if (typeof value.integerValue === 'string' && /^-?\d+$/.test(value.integerValue)) return BigInt(value.integerValue);
  if (typeof value.doubleValue === 'number') return value.doubleValue;
  if (typeof value.referenceValue === 'string') return value.referenceValue;
  if (isRecord(value.arrayValue)) return Array.isArray(value.arrayValue.values) ? value.arrayValue.values : [];
  return canonicalJson(value);
}

function compareRawValues(left: unknown, right: unknown): number {
  const a = decodedRawValue(left);
  const b = decodedRawValue(right);
  if (typeof a === 'bigint' && typeof b === 'number') return Number(a) - b;
  if (typeof a === 'number' && typeof b === 'bigint') return a - Number(b);
  if ((typeof a === 'number' || typeof a === 'bigint') && (typeof b === 'number' || typeof b === 'bigint')) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const encodedA = canonicalJson(a);
  const encodedB = canonicalJson(b);
  return encodedA < encodedB ? -1 : encodedA > encodedB ? 1 : 0;
}

function rawValuesEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function matchesFilter(document: StoredDocument, filter: unknown): boolean {
  if (!isRecord(filter)) return true;
  if (isRecord(filter.compositeFilter)) {
    const filters = Array.isArray(filter.compositeFilter.filters) ? filter.compositeFilter.filters : [];
    return filter.compositeFilter.op === 'OR'
      ? filters.some((entry) => matchesFilter(document, entry))
      : filters.every((entry) => matchesFilter(document, entry));
  }
  if (!isRecord(filter.fieldFilter) || !isRecord(filter.fieldFilter.field)) return false;
  const fieldPath = filter.fieldFilter.field.fieldPath;
  if (typeof fieldPath !== 'string') return false;
  const current = fieldPath === '__name__'
    ? { referenceValue: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${document.path}` }
    : rawFieldValue(document.fields, fieldPath);
  if (filter.fieldFilter.op === 'EQUAL') return rawValuesEqual(current, filter.fieldFilter.value);
  if (filter.fieldFilter.op === 'IN') {
    const array = isRecord(filter.fieldFilter.value) && isRecord(filter.fieldFilter.value.arrayValue) &&
      Array.isArray(filter.fieldFilter.value.arrayValue.values)
      ? filter.fieldFilter.value.arrayValue.values
      : [];
    return array.some((value) => rawValuesEqual(current, value));
  }
  return false;
}

function queryParentDropId(parentPath: string): string | null {
  const segments = parentPath.split('/');
  return segments.length >= 2 && segments[0] === 'drops' ? segments[1] : null;
}

function orderValue(document: StoredDocument, fieldPath: string): unknown {
  return fieldPath === '__name__'
    ? { referenceValue: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${document.path}` }
    : rawFieldValue(document.fields, fieldPath);
}

function parseQueryBody(body: string | undefined): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body || '');
  } catch {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce query.');
  }
  if (!isRecord(value) || !isRecord(value.structuredQuery)) {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce query.');
  }
  return value;
}

function selectedFieldPaths(query: Record<string, unknown>): string[] | undefined {
  if (!isRecord(query.select) || !Array.isArray(query.select.fields)) return undefined;
  const paths = query.select.fields.flatMap((entry) =>
    isRecord(entry) && typeof entry.fieldPath === 'string' ? [entry.fieldPath] : []);
  return paths;
}

function timestamp(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function sqlColumnFilter(query: Record<string, unknown>): { column: string; value: string | number } | null {
  const candidate = isRecord(query.where) && isRecord(query.where.fieldFilter)
    ? query.where.fieldFilter
    : null;
  if (!candidate || candidate.op !== 'EQUAL' || !isRecord(candidate.field)) return null;
  const fieldPath = candidate.field.fieldPath;
  if (typeof fieldPath !== 'string') return null;
  const column = FIELD_COLUMN.get(fieldPath);
  if (!column) return null;
  const value = decodedRawValue(candidate.value);
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? { column, value: typeof value === 'boolean' ? Number(value) : value }
    : null;
}

export class D1CommerceDocumentStore implements CommerceDocumentStore {
  constructor(private readonly db: D1Database) {}

  async request(args: CommerceDocumentStoreRequest): Promise<unknown | null> {
    const url = new URL(args.url);
    const suffix = requestSuffix(url);
    if (suffix === null) throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce request.');
    if (args.method === 'POST' && suffix === ':beginTransaction') return this.beginTransaction(args.nowMs);
    if (args.method === 'POST' && suffix === ':rollback') return this.rollback(args.body);
    if (args.method === 'POST' && suffix === ':commit') return this.commit(args.body, args.nowMs);
    if (args.method === 'POST' && suffix.endsWith(':runQuery')) {
      const parent = decodePath(suffix.slice(0, -':runQuery'.length));
      return this.runQuery(parent, args.body, args.nowMs);
    }
    if (args.method === 'GET' && suffix.startsWith('/')) {
      return this.getDocument(decodePath(suffix), url, args.nowMs);
    }
    throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce request.');
  }

  private async beginTransaction(nowMs: number): Promise<Record<string, unknown>> {
    const control = await loadCommerceAuthorityControl(this.db);
    if (control.state !== 'd1') throw new CommerceMaintenanceError();
    const transaction = crypto.randomUUID();
    await this.db.batch([
      this.db.prepare('DELETE FROM commerce_transactions WHERE expires_at_ms <= ?').bind(nowMs),
      this.db.prepare(`INSERT INTO commerce_transactions (
        transaction_id, expected_documents_revision, created_at_ms, expires_at_ms
      ) VALUES (?, NULL, ?, ?)`).bind(transaction, nowMs, nowMs + TRANSACTION_TTL_MS),
    ]);
    return { transaction };
  }

  private async rollback(body: string | undefined): Promise<Record<string, never>> {
    const payload = body ? JSON.parse(body) as unknown : null;
    const transaction = isRecord(payload) && typeof payload.transaction === 'string' ? payload.transaction : '';
    if (transaction) await this.db.prepare('DELETE FROM commerce_transactions WHERE transaction_id = ?').bind(transaction).run();
    return {};
  }

  private async getDocument(path: string, url: URL, nowMs: number): Promise<unknown | null> {
    const identity = commerceDocumentIdentity(path);
    if (!identity) throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce document path.');
    const row = await this.db.prepare(`SELECT document_path, document_kind, drop_id, document_id,
      fields_json, version, create_time, update_time
      FROM commerce_documents WHERE document_path = ?`).bind(path).first<CommerceDocumentRow>();
    const transaction = url.searchParams.get('transaction');
    if (transaction) await this.recordTransactionReads(transaction, [[path, row?.version ?? -1]], null, nowMs);
    if (!row) return null;
    const masks = url.searchParams.getAll('mask.fieldPaths');
    return firestoreDocument(parseRow(row), masks.length ? masks : undefined);
  }

  private async runQuery(parentPath: string, body: string | undefined, nowMs: number): Promise<unknown[]> {
    const payload = parseQueryBody(body);
    const query = payload.structuredQuery as Record<string, unknown>;
    const transaction = typeof payload.transaction === 'string' ? payload.transaction : null;
    const transactionDocumentsRevision = transaction
      ? (await loadCommerceAuthorityControl(this.db)).documentsRevision
      : null;
    const from = Array.isArray(query.from) && isRecord(query.from[0]) ? query.from[0] : null;
    const collectionId = from && typeof from.collectionId === 'string' ? from.collectionId : '';
    const kind = kindForCollection(collectionId);
    if (!kind) throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce collection.');
    const parentDropId = queryParentDropId(parentPath);
    const directFilter = sqlColumnFilter(query);
    let sql = `SELECT document_path, document_kind, drop_id, document_id,
      fields_json, version, create_time, update_time
      FROM commerce_documents WHERE document_kind = ?`;
    const bindings: Array<string | number> = [kind];
    if (parentDropId) {
      sql += ' AND drop_id = ?';
      bindings.push(parentDropId);
    }
    if (directFilter) {
      sql += ` AND ${directFilter.column} = ?`;
      bindings.push(directFilter.value);
    }
    const result = await this.db.prepare(sql).bind(...bindings).all<CommerceDocumentRow>();
    let documents = result.results.map(parseRow).filter((document) => matchesFilter(document, query.where));
    const orderBy = Array.isArray(query.orderBy) ? query.orderBy.filter(isRecord) : [];
    if (orderBy.length) {
      documents.sort((left, right) => {
        for (const entry of orderBy) {
          if (!isRecord(entry.field) || typeof entry.field.fieldPath !== 'string') continue;
          const comparison = compareRawValues(
            orderValue(left, entry.field.fieldPath),
            orderValue(right, entry.field.fieldPath),
          );
          if (comparison) return entry.direction === 'DESCENDING' ? -comparison : comparison;
        }
        return left.path.localeCompare(right.path);
      });
    } else {
      documents.sort((left, right) => left.path.localeCompare(right.path));
    }
    if (isRecord(query.startAt) && Array.isArray(query.startAt.values)) {
      const cursorValues = query.startAt.values;
      const before = query.startAt.before === true;
      documents = documents.filter((document) => {
        let comparison = 0;
        for (let index = 0; index < cursorValues.length; index += 1) {
          const ordering = orderBy[index];
          if (!ordering || !isRecord(ordering.field) || typeof ordering.field.fieldPath !== 'string') break;
          comparison = compareRawValues(orderValue(document, ordering.field.fieldPath), cursorValues[index]);
          if (ordering.direction === 'DESCENDING') comparison = -comparison;
          if (comparison) break;
        }
        return before ? comparison >= 0 : comparison > 0;
      });
    }
    const offset = Number(query.offset ?? 0);
    if (Number.isSafeInteger(offset) && offset > 0) documents = documents.slice(offset);
    const limit = Number(query.limit);
    if (Number.isSafeInteger(limit) && limit >= 0) documents = documents.slice(0, limit);
    if (transaction) {
      await this.recordTransactionReads(
        transaction,
        documents.map((document) => [document.path, document.version]),
        transactionDocumentsRevision,
        nowMs,
      );
    }
    const select = selectedFieldPaths(query);
    const readTime = timestamp(nowMs);
    return documents.length
      ? documents.map((document) => ({ document: firestoreDocument(document, select), readTime }))
      : [{ readTime }];
  }

  private async recordTransactionReads(
    transaction: string,
    reads: Array<[string, number]>,
    documentsRevision: number | null,
    nowMs: number,
  ): Promise<void> {
    const active = await this.db.prepare(`SELECT transaction_id FROM commerce_transactions
      WHERE transaction_id = ? AND expires_at_ms > ?`).bind(transaction, nowMs).first();
    if (!active) throw new FirestoreWriteConflict();
    const statements: D1PreparedStatement[] = [];
    if (documentsRevision !== null) {
      statements.push(this.db.prepare(`UPDATE commerce_transactions
        SET expected_documents_revision = COALESCE(expected_documents_revision, ?)
        WHERE transaction_id = ?`).bind(documentsRevision, transaction));
    }
    for (const [path, version] of reads) {
      statements.push(this.db.prepare(`INSERT INTO commerce_transaction_reads (
        transaction_id, document_path, version
      ) VALUES (?, ?, ?) ON CONFLICT(transaction_id, document_path) DO UPDATE SET version = excluded.version
      WHERE commerce_transaction_reads.version = excluded.version`).bind(transaction, path, version));
    }
    if (statements.length) await this.db.batch(statements);
  }

  private async commit(body: string | undefined, nowMs: number): Promise<Record<string, unknown>> {
    let payload: unknown;
    try {
      payload = JSON.parse(body || '');
    } catch {
      throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce commit.');
    }
    if (!isRecord(payload) || !Array.isArray(payload.writes)) {
      throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce commit.');
    }
    const transaction = typeof payload.transaction === 'string' ? payload.transaction : null;
    const transactionRow = transaction
      ? await this.db.prepare(`SELECT expected_documents_revision, expires_at_ms
          FROM commerce_transactions WHERE transaction_id = ?`).bind(transaction).first<{
            expected_documents_revision: number | null;
            expires_at_ms: number;
          }>()
      : null;
    if (transaction && (!transactionRow || transactionRow.expires_at_ms <= nowMs)) throw new FirestoreWriteConflict();
    const transactionReads = transaction
      ? (await this.db.prepare(`SELECT document_path, version FROM commerce_transaction_reads
          WHERE transaction_id = ?`).bind(transaction).all<{ document_path: string; version: number }>()).results
      : [];
    const touchedPaths = new Set<string>();
    for (const write of payload.writes) {
      if (!isRecord(write)) throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce write.');
      const path = isRecord(write.update)
        ? decodeDocumentPathFromName(write.update.name)
        : isRecord(write.transform)
          ? decodeDocumentPathFromName(write.transform.document)
          : decodeDocumentPathFromName(write.delete);
      if (!path) throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce document path.');
      touchedPaths.add(path);
    }
    const current = new Map<string, PendingDocument>();
    for (const path of touchedPaths) {
      const row = await this.db.prepare(`SELECT document_path, document_kind, drop_id, document_id,
        fields_json, version, create_time, update_time FROM commerce_documents
        WHERE document_path = ?`).bind(path).first<CommerceDocumentRow>();
      current.set(path, row ? parseRow(row) : null);
    }
    const expectations = new Map(transactionReads.map((row) => [row.document_path, row.version]));
    for (const [path, document] of current) if (!expectations.has(path)) expectations.set(path, document?.version ?? -1);
    const commitTime = timestamp(nowMs);
    const writeResults: Array<Record<string, unknown>> = [];
    for (const write of payload.writes) {
      const result = applyWrite(write as Record<string, unknown>, current, commitTime);
      writeResults.push(result ? { updateTime: commitTime, transformResults: result } : {});
    }
    const guardId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [this.db.prepare(`INSERT INTO commerce_commit_guards (
      guard_id, expectations_json, expected_documents_revision, created_at_ms
    ) VALUES (?, ?, ?, ?)`).bind(
      guardId,
      JSON.stringify(Array.from(expectations, ([path, version]) => ({ path, version }))),
      transactionRow?.expected_documents_revision ?? null,
      nowMs,
    )];
    for (const path of touchedPaths) {
      const document = current.get(path) ?? null;
      if (!document) {
        statements.push(this.db.prepare('DELETE FROM commerce_documents WHERE document_path = ?').bind(path));
        continue;
      }
      const decodedDocument = decodeFirestoreFields(document.fields);
      if (!decodedDocument) throw new ProfileReadError('internal', 500, 'Commerce document encoding failed.');
      statements.push(this.db.prepare(`INSERT INTO commerce_documents (
        document_path, document_kind, drop_id, document_id, fields_json, document_json,
        version, create_time, update_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_path) DO UPDATE SET
        document_kind = excluded.document_kind,
        drop_id = excluded.drop_id,
        document_id = excluded.document_id,
        fields_json = excluded.fields_json,
        document_json = excluded.document_json,
        version = excluded.version,
        create_time = excluded.create_time,
        update_time = excluded.update_time`).bind(
        document.path,
        document.kind,
        document.dropId,
        document.documentId,
        JSON.stringify(document.fields),
        JSON.stringify(decodedDocument),
        document.version,
        document.createTime,
        document.updateTime,
      ));
    }
    if (touchedPaths.size) {
      statements.push(this.db.prepare(`UPDATE commerce_authority_control
        SET documents_revision = documents_revision + 1, updated_at_ms = ? WHERE singleton = 1`).bind(nowMs));
    }
    statements.push(this.db.prepare('DELETE FROM commerce_commit_guards WHERE guard_id = ?').bind(guardId));
    if (transaction) statements.push(this.db.prepare('DELETE FROM commerce_transactions WHERE transaction_id = ?').bind(transaction));
    try {
      await this.db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/commerce transaction conflict|UNIQUE constraint|authority is not d1/i.test(message)) {
        throw new FirestoreWriteConflict(/UNIQUE constraint/i.test(message) ? 'ALREADY_EXISTS' : 'ABORTED');
      }
      throw error;
    }
    return { writeResults, commitTime };
  }
}

function writePrecondition(write: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(write.currentDocument)) return write.currentDocument;
  if (isRecord(write.update) && isRecord(write.update.currentDocument)) return write.update.currentDocument;
  if (isRecord(write.transform) && isRecord(write.transform.currentDocument)) return write.transform.currentDocument;
  return null;
}

function assertPrecondition(document: PendingDocument, precondition: Record<string, unknown> | null): void {
  if (!precondition) return;
  if (typeof precondition.exists === 'boolean' && precondition.exists !== Boolean(document)) {
    throw new FirestoreWriteConflict(precondition.exists ? 'FAILED_PRECONDITION' : 'ALREADY_EXISTS');
  }
  if (typeof precondition.updateTime === 'string' && document?.updateTime !== precondition.updateTime) {
    throw new FirestoreWriteConflict('ABORTED');
  }
}

function transformIncrement(current: unknown, operand: unknown): unknown {
  if (!isRecord(operand)) throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce transform.');
  if (typeof operand.integerValue === 'string' && /^-?\d+$/.test(operand.integerValue)) {
    const existing = isRecord(current) && typeof current.integerValue === 'string' && /^-?\d+$/.test(current.integerValue)
      ? BigInt(current.integerValue)
      : 0n;
    return { integerValue: String(existing + BigInt(operand.integerValue)) };
  }
  const increment = Number(operand.doubleValue);
  const existing = isRecord(current)
    ? typeof current.doubleValue === 'number'
      ? current.doubleValue
      : typeof current.integerValue === 'string' ? Number(current.integerValue) : 0
    : 0;
  if (!Number.isFinite(increment) || !Number.isFinite(existing)) {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce transform.');
  }
  return { doubleValue: existing + increment };
}

function applyTransforms(
  fields: Record<string, unknown>,
  transforms: unknown,
  commitTime: string,
): unknown[] {
  if (!Array.isArray(transforms)) return [];
  const results: unknown[] = [];
  for (const transform of transforms) {
    if (!isRecord(transform) || typeof transform.fieldPath !== 'string') {
      throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce transform.');
    }
    let value: unknown;
    if (transform.setToServerValue === 'REQUEST_TIME') {
      value = { timestampValue: commitTime };
    } else if (transform.increment !== undefined) {
      value = transformIncrement(rawFieldValue(fields, transform.fieldPath), transform.increment);
    } else if (isRecord(transform.appendMissingElements)) {
      const existing = rawFieldValue(fields, transform.fieldPath);
      const values = Array.isArray(transform.appendMissingElements.values)
        ? transform.appendMissingElements.values
        : [];
      const currentValues = isRecord(existing) && isRecord(existing.arrayValue) && Array.isArray(existing.arrayValue.values)
        ? [...existing.arrayValue.values]
        : [];
      for (const entry of values) if (!currentValues.some((current) => rawValuesEqual(current, entry))) currentValues.push(entry);
      value = { arrayValue: { values: currentValues } };
    } else {
      throw new ProfileReadError('invalid-argument', 400, 'Unsupported commerce transform.');
    }
    setRawFieldValue(fields, transform.fieldPath, value);
    results.push(value);
  }
  return results;
}

function applyWrite(
  write: Record<string, unknown>,
  current: Map<string, PendingDocument>,
  commitTime: string,
): unknown[] | null {
  const updatePath = isRecord(write.update) ? decodeDocumentPathFromName(write.update.name) : null;
  const transformPath = isRecord(write.transform) ? decodeDocumentPathFromName(write.transform.document) : null;
  const deletePath = decodeDocumentPathFromName(write.delete);
  const path = updatePath || transformPath || deletePath;
  if (!path) throw new ProfileReadError('invalid-argument', 400, 'Invalid commerce write.');
  const existing = current.get(path) ?? null;
  assertPrecondition(existing, writePrecondition(write));
  if (deletePath) {
    current.set(path, null);
    return null;
  }
  const identity = commerceDocumentIdentity(path)!;
  let fields = existing ? structuredClone(existing.fields) : {};
  let transforms: unknown = null;
  if (isRecord(write.update)) {
    const updateFields = isRecord(write.update.fields) ? write.update.fields : {};
    if (isRecord(write.updateMask) && Array.isArray(write.updateMask.fieldPaths)) {
      for (const fieldPath of write.updateMask.fieldPaths) {
        if (typeof fieldPath !== 'string') throw new ProfileReadError('invalid-argument', 400, 'Invalid update mask.');
        setRawFieldValue(fields, fieldPath, rawFieldValue(updateFields, fieldPath));
      }
    } else {
      fields = structuredClone(updateFields);
    }
    transforms = write.updateTransforms;
  } else if (isRecord(write.transform)) {
    transforms = write.transform.fieldTransforms;
  }
  const transformResults = applyTransforms(fields, transforms, commitTime);
  const version = (existing?.version ?? 0) + 1;
  current.set(path, {
    path,
    kind: identity.kind,
    dropId: identity.dropId,
    documentId: identity.documentId,
    fields,
    version,
    createTime: existing?.createTime ?? commitTime,
    updateTime: versionedTimestamp(commitTime, version),
  });
  return transformResults;
}

function versionedTimestamp(commitTime: string, version: number): string {
  const milliseconds = Date.parse(commitTime);
  if (!Number.isFinite(milliseconds)) return commitTime;
  const seconds = Math.floor(milliseconds / 1000);
  const nanos = (milliseconds - seconds * 1000) * 1_000_000 + version % 1_000_000;
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${String(nanos).padStart(9, '0')}Z`;
}
