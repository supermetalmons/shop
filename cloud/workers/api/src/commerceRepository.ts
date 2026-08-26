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
  type CommerceIndexedField,
  type CommerceJsonValue,
  type CommerceQuery,
  type CommerceTimestamp,
  type CommerceUpdateValue,
} from './commerceRepositoryTypes.js';

export * from './commerceRepositoryTypes.js';

type AuthorityRow = {
  authority_state: string;
  documents_revision: number;
};

type DocumentRow = {
  create_time: string;
  document_id: string;
  document_json: string;
  document_kind: CommerceDocumentKind;
  document_path: string;
  drop_id: string | null;
  fields_json: string;
  processed_at_nanos: number | null;
  processed_at_seconds: number | null;
  update_time: string;
  version: number;
};

type StoredDocument = {
  compatibilityFields: Record<string, unknown>;
  createTime: string;
  data: CommerceDocumentData;
  key: CommerceDocumentKey;
  processedAt: CommerceTimestamp | null;
  updateTime: string;
  version: number;
};

type PendingDocument = StoredDocument | null;

const DOCUMENT_COLUMNS = `document_path, document_kind, drop_id, document_id, document_json,
  fields_json, version, create_time, update_time, processed_at_seconds, processed_at_nanos`;

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
  if (!documentId || documentId.includes('/') || (kind !== 'claim_code' && !dropId) || dropId?.includes('/')) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce document key.');
  }
  const path = kind === 'claim_code'
    ? `claimCodes/${documentId}`
    : kind === 'dude_pool'
      ? `drops/${dropId}/meta/dudePool`
      : `drops/${dropId}/${COLLECTIONS[kind as keyof typeof COLLECTIONS]}/${documentId}`;
  return Object.freeze({ documentId, dropId, kind, path });
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

function timestampField(fieldPath: string): boolean {
  const name = fieldPath.split('.').at(-1) || '';
  return name.endsWith('At') && !name.endsWith('AtMs');
}

function encodeCompatibility(value: CommerceJsonValue, fieldPath: string): unknown {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce document value.');
    if (timestampField(fieldPath)) return { timestampValue: timestampString(timestampFromMilliseconds(value)) };
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((entry) => encodeCompatibility(entry, fieldPath)) } };
  }
  return { mapValue: { fields: encodeCompatibilityFields(value, fieldPath) } };
}

function encodeCompatibilityFields(
  value: CommerceDocumentData,
  parentPath = '',
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const path = parentPath ? `${parentPath}.${key}` : key;
    return [key, encodeCompatibility(entry, path)];
  }));
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

function compatibilityField(fields: Record<string, unknown>, fieldPath: string): unknown {
  const parts = fieldPath.split('.');
  let current: unknown = fields[parts[0]];
  for (let index = 1; index < parts.length; index += 1) {
    if (!isObject(current) || !isObject(current.mapValue) || !isObject(current.mapValue.fields)) return undefined;
    current = current.mapValue.fields[parts[index]];
  }
  return current;
}

function setCompatibilityField(fields: Record<string, unknown>, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split('.');
  if (parts.length === 1) {
    if (value === undefined) delete fields[fieldPath];
    else fields[fieldPath] = value;
    return;
  }
  let current = fields;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const existing = current[parts[index]];
    if (!isObject(existing) || !isObject(existing.mapValue) || !isObject(existing.mapValue.fields)) {
      current[parts[index]] = { mapValue: { fields: {} } };
    }
    current = (current[parts[index]] as { mapValue: { fields: Record<string, unknown> } }).mapValue.fields;
  }
  const last = parts.at(-1)!;
  if (value === undefined) delete current[last];
  else current[last] = value;
}

function materializeUpdate(
  current: CommerceJsonValue | undefined,
  currentCompatibility: unknown,
  fieldPath: string,
  update: CommerceUpdateValue,
  now: CommerceTimestamp,
): { compatibility: unknown; value: CommerceJsonValue | undefined } {
  if (isCommerceDeleteField(update)) return { compatibility: undefined, value: undefined };
  if (isCommerceServerTimestamp(update)) {
    return { compatibility: { timestampValue: timestampString(now) }, value: timestampMilliseconds(now) };
  }
  if (isCommerceTimestamp(update)) {
    if (!validTimestamp(update.value)) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce timestamp.');
    return {
      compatibility: { timestampValue: timestampString(update.value) },
      value: timestampMilliseconds(update.value),
    };
  }
  if (isCommerceIncrement(update)) {
    if (!Number.isFinite(update.amount)) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce increment.');
    const existing = typeof current === 'number' ? current : 0;
    const value = existing + update.amount;
    if (!Number.isFinite(value)) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce increment.');
    const compatibility = Number.isSafeInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
    return { compatibility, value };
  }
  if (isCommerceArrayUnion(update)) {
    const values = Array.isArray(current) ? cloneData(current) : [];
    for (const entry of update.values) {
      if (!values.some((existing) => canonicalJson(existing) === canonicalJson(entry))) values.push(cloneData(entry));
    }
    return { compatibility: encodeCompatibility(values, fieldPath), value: values };
  }
  const value = cloneData(update);
  const compatibility = timestampField(fieldPath) && isObject(currentCompatibility) &&
    typeof currentCompatibility.timestampValue === 'string' && typeof value === 'number' &&
    timestampMilliseconds(parseTimestampString(currentCompatibility.timestampValue) || timestampFromMilliseconds(value)) === value
    ? currentCompatibility
    : encodeCompatibility(value, fieldPath);
  return { compatibility, value };
}

function parseTimestampString(value: string): CommerceTimestamp | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}Z`) / 1000;
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  return { seconds, nanos: Number((match[2] || '').padEnd(9, '0')) };
}

function parseRow(row: DocumentRow): StoredDocument {
  let data: unknown;
  let compatibilityFields: unknown;
  try {
    data = JSON.parse(row.document_json);
    compatibilityFields = JSON.parse(row.fields_json);
  } catch {
    throw new CommerceRepositoryError('unavailable', 'Commerce data is temporarily unavailable.');
  }
  const key = parseDocumentKey(row.document_kind, row.drop_id, row.document_id, row.document_path);
  if (
    !isObject(data) || !isObject(compatibilityFields) || !key ||
    !Number.isSafeInteger(row.version) || row.version < 1
  ) throw new CommerceRepositoryError('unavailable', 'Commerce data is temporarily unavailable.');
  const projectedProcessedAt = row.processed_at_seconds === null && row.processed_at_nanos === null
    ? null
    : { seconds: row.processed_at_seconds, nanos: row.processed_at_nanos };
  const compatibilityProcessedAt = isObject(compatibilityFields.processedAt) &&
    typeof compatibilityFields.processedAt.timestampValue === 'string'
    ? parseTimestampString(compatibilityFields.processedAt.timestampValue)
    : null;
  const processedAt = projectedProcessedAt || compatibilityProcessedAt;
  if (processedAt && !validTimestamp(processedAt as CommerceTimestamp)) {
    throw new CommerceRepositoryError('unavailable', 'Commerce data is temporarily unavailable.');
  }
  return {
    compatibilityFields,
    createTime: row.create_time,
    data: data as CommerceDocumentData,
    key,
    processedAt: processedAt as CommerceTimestamp | null,
    updateTime: row.update_time,
    version: row.version,
  };
}

function parseDocumentKey(
  kind: CommerceDocumentKind,
  dropId: string | null,
  documentId: string,
  path: string,
): CommerceDocumentKey | null {
  try {
    const key = documentKey(kind, dropId, documentId);
    return key.path === path ? key : null;
  } catch {
    return null;
  }
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

function compare(left: unknown, right: unknown): number {
  if (isTimestampLike(left) && isTimestampLike(right)) {
    return left.seconds - right.seconds || left.nanos - right.nanos;
  }
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right);
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  const encodedLeft = canonicalJson(left);
  const encodedRight = canonicalJson(right);
  return encodedLeft < encodedRight ? -1 : encodedLeft > encodedRight ? 1 : 0;
}

function isTimestampLike(value: unknown): value is CommerceTimestamp {
  return isObject(value) && validTimestamp(value as CommerceTimestamp);
}

function orderValue(document: StoredDocument, field: CommerceQuery['orderBy'] extends readonly (infer T)[] | undefined
  ? T extends { field: infer F } ? F : never
  : never): unknown {
  if (field === 'documentPath') return document.key.path;
  if (field === 'processedAt') return document.processedAt;
  return dataField(document.data, field);
}

function queryMatches(document: StoredDocument, query: CommerceQuery): boolean {
  return (query.filters || []).every((filter) => {
    const value = dataField(document.data, filter.field);
    if (filter.op === 'equal') return canonicalJson(value) === canonicalJson(filter.value);
    return Array.isArray(filter.value) && filter.value.some((entry) => canonicalJson(value) === canonicalJson(entry));
  });
}

function ensureQuery(query: CommerceQuery): void {
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 0)) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce query limit.');
  }
  if (query.filters?.some((filter) => filter.op === 'in' && (!Array.isArray(filter.value) || filter.value.length === 0))) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce query filter.');
  }
  if (query.startAfter && query.startAfter.length > (query.orderBy?.length || 0)) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce query cursor.');
  }
}

async function authority(db: D1Database): Promise<AuthorityRow> {
  let row: AuthorityRow | null;
  try {
    row = await db.prepare(`SELECT authority_state, documents_revision
      FROM commerce_authority_control WHERE singleton = 1`).first<AuthorityRow>();
  } catch {
    throw new CommerceRepositoryError('unavailable', 'Commerce is temporarily unavailable for maintenance.');
  }
  if (!row || row.authority_state !== 'd1' || !Number.isSafeInteger(row.documents_revision)) {
    throw new CommerceRepositoryError('unavailable', 'Commerce is temporarily unavailable for maintenance.');
  }
  return row;
}

export class D1CommerceRepository {
  constructor(private readonly db: D1Database) {}

  async get<T extends CommerceDocumentData>(
    key: CommerceDocumentKey,
  ): Promise<CommerceDocumentRecord<T> | null> {
    const unit = await this.begin(Date.now());
    return unit.get<T>(key);
  }

  async query<T extends CommerceDocumentData>(query: CommerceQuery): Promise<CommerceDocumentRecord<T>[]> {
    const unit = await this.begin(Date.now());
    return unit.query<T>(query);
  }

  async begin(nowMs: number): Promise<CommerceUnitOfWork> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce operation timestamp.');
    }
    await authority(this.db);
    return new CommerceUnitOfWork(this.db, nowMs);
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
}

export class CommerceUnitOfWork {
  private closed = false;
  private expectedDocumentsRevision: number | null = null;
  private readonly expectations = new Map<string, number>();
  private readonly original = new Map<string, StoredDocument | null>();
  private readonly pending = new Map<string, PendingDocument>();
  private readonly createPaths = new Set<string>();
  private readonly existingPaths = new Set<string>();
  private writesStarted = false;

  constructor(
    private readonly db: D1Database,
    private readonly nowMs: number,
  ) {}

  async get<T extends CommerceDocumentData>(
    key: CommerceDocumentKey,
  ): Promise<CommerceDocumentRecord<T> | null> {
    this.assertOpen();
    if (this.writesStarted) throw new CommerceRepositoryError('invalid-argument', 'Commerce reads must precede writes.');
    await authority(this.db);
    const document = await this.load(key);
    return document ? publicRecord<T>(document) : null;
  }

  async query<T extends CommerceDocumentData>(query: CommerceQuery): Promise<CommerceDocumentRecord<T>[]> {
    this.assertOpen();
    if (this.writesStarted) throw new CommerceRepositoryError('invalid-argument', 'Commerce reads must precede writes.');
    ensureQuery(query);
    const control = await authority(this.db);
    if (this.expectedDocumentsRevision !== null && this.expectedDocumentsRevision !== control.documents_revision) {
      throw new CommerceWriteConflict();
    }
    this.expectedDocumentsRevision = control.documents_revision;
    let sql = `SELECT ${DOCUMENT_COLUMNS} FROM commerce_documents WHERE document_kind = ?`;
    const bindings: Array<string | number | null> = [query.kind];
    if (query.dropId !== undefined) {
      sql += query.dropId === null ? ' AND drop_id IS NULL' : ' AND drop_id = ?';
      if (query.dropId !== null) bindings.push(query.dropId);
    }
    const direct = query.filters?.find((filter) => {
      const value = filter.value;
      return filter.op === 'equal' && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
    });
    if (direct) {
      sql += ` AND ${INDEXED_COLUMNS[direct.field]} = ?`;
      bindings.push(typeof direct.value === 'boolean' ? Number(direct.value) : direct.value as string | number);
    }
    const result = await this.db.prepare(sql).bind(...bindings).all<DocumentRow>();
    let documents = result.results.map(parseRow).filter((document) => queryMatches(document, query));
    const orderBy = query.orderBy || [];
    documents.sort((left, right) => {
      for (const order of orderBy) {
        const result = compare(orderValue(left, order.field), orderValue(right, order.field));
        if (result) return order.direction === 'desc' ? -result : result;
      }
      return left.key.path.localeCompare(right.key.path);
    });
    if (query.startAfter) {
      documents = documents.filter((document) => {
        let result = 0;
        for (let index = 0; index < query.startAfter!.length; index += 1) {
          const order = orderBy[index];
          if (!order) break;
          result = compare(orderValue(document, order.field), query.startAfter![index]);
          if (order.direction === 'desc') result = -result;
          if (result) break;
        }
        return result > 0;
      });
    }
    if (query.limit !== undefined) documents = documents.slice(0, query.limit);
    for (const document of documents) this.recordRead(document.key.path, document.version, document);
    return documents.map((document) => publicRecord<T>(document));
  }

  async create(key: CommerceDocumentKey, data: CommerceDocumentWriteData): Promise<void> {
    this.assertOpen();
    const current = await this.loadForMutation(key);
    if (current) throw new CommerceWriteConflict('already-exists');
    this.createPaths.add(key.path);
    this.pending.set(key.path, this.newDocument(key, data));
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
      await authority(this.db);
      return;
    }
    const guardId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`INSERT INTO commerce_native_precondition_guards (
        guard_id, create_paths_json, existing_paths_json, created_at_ms
      ) VALUES (?, ?, ?, ?)`).bind(
        guardId,
        JSON.stringify([...this.createPaths]),
        JSON.stringify([...this.existingPaths]),
        this.nowMs,
      ),
      this.db.prepare(`INSERT INTO commerce_commit_guards (
        guard_id, expectations_json, expected_documents_revision, created_at_ms
      ) VALUES (?, ?, ?, ?)`).bind(
        guardId,
        JSON.stringify(Array.from(this.expectations, ([path, version]) => ({ path, version }))),
        this.expectedDocumentsRevision,
        this.nowMs,
      ),
    ];
    for (const [path, document] of this.pending) {
      if (!document) {
        statements.push(this.db.prepare('DELETE FROM commerce_documents WHERE document_path = ?').bind(path));
        continue;
      }
      statements.push(this.db.prepare(`INSERT INTO commerce_documents (
        document_path, document_kind, drop_id, document_id, fields_json, document_json,
        version, create_time, update_time, processed_at_seconds, processed_at_nanos
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_path) DO UPDATE SET
        document_kind = excluded.document_kind,
        drop_id = excluded.drop_id,
        document_id = excluded.document_id,
        fields_json = excluded.fields_json,
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
        JSON.stringify(document.compatibilityFields),
        JSON.stringify(document.data),
        document.version,
        document.createTime,
        document.updateTime,
        document.processedAt?.seconds ?? null,
        document.processedAt?.nanos ?? null,
      ));
    }
    statements.push(this.db.prepare(`UPDATE commerce_authority_control
      SET documents_revision = documents_revision + 1, updated_at_ms = ? WHERE singleton = 1`).bind(this.nowMs));
    statements.push(this.db.prepare('DELETE FROM commerce_commit_guards WHERE guard_id = ?').bind(guardId));
    statements.push(this.db.prepare('DELETE FROM commerce_native_precondition_guards WHERE guard_id = ?').bind(guardId));
    try {
      await this.db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/authority is not d1/i.test(message)) {
        throw new CommerceRepositoryError('unavailable', 'Commerce is temporarily unavailable for maintenance.');
      }
      if (/document already exists/i.test(message)) throw new CommerceWriteConflict('already-exists');
      if (/document failed precondition/i.test(message)) throw new CommerceWriteConflict('failed-precondition');
      if (/transaction conflict|UNIQUE constraint/i.test(message)) throw new CommerceWriteConflict();
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

  private async load(key: CommerceDocumentKey): Promise<StoredDocument | null> {
    if (this.original.has(key.path)) return this.original.get(key.path) || null;
    const row = await this.db.prepare(`SELECT ${DOCUMENT_COLUMNS}
      FROM commerce_documents WHERE document_path = ?`).bind(key.path).first<DocumentRow>();
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
  }

  private async loadForMutation(key: CommerceDocumentKey): Promise<StoredDocument | null> {
    this.writesStarted = true;
    if (this.pending.has(key.path)) return this.pending.get(key.path) || null;
    await authority(this.db);
    return this.load(key);
  }

  private newDocument(key: CommerceDocumentKey, data: CommerceDocumentWriteData): StoredDocument {
    const now = timestampFromMilliseconds(this.nowMs);
    const materialized = this.materializeDocument(data, now);
    const commitTime = timestampString(now);
    return {
      compatibilityFields: materialized.compatibility,
      createTime: commitTime,
      data: materialized.data,
      key,
      processedAt: this.processedTimestamp(materialized.compatibility),
      updateTime: versionedTimestamp(commitTime, 1),
      version: 1,
    };
  }

  private replaceDocument(
    key: CommerceDocumentKey,
    current: StoredDocument | null,
    data: CommerceDocumentWriteData,
  ): StoredDocument {
    const now = timestampFromMilliseconds(this.nowMs);
    const materialized = this.materializeDocument(data, now);
    const version = (current?.version || 0) + 1;
    const commitTime = timestampString(now);
    return {
      compatibilityFields: materialized.compatibility,
      createTime: current?.createTime || commitTime,
      data: materialized.data,
      key,
      processedAt: this.processedTimestamp(materialized.compatibility),
      updateTime: versionedTimestamp(commitTime, version),
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
    const now = timestampFromMilliseconds(this.nowMs);
    const data = current ? cloneData(current.data) : {};
    const compatibilityFields = current ? cloneData(current.compatibilityFields) : {};
    for (const [fieldPath, update] of Object.entries(updates)) {
      if (!fieldPath || fieldPath.split('.').some((part) => !part)) {
        throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce field path.');
      }
      const result = materializeUpdate(
        dataField(data, fieldPath) as CommerceJsonValue | undefined,
        compatibilityField(compatibilityFields, fieldPath),
        fieldPath,
        update,
        now,
      );
      setDataField(data, fieldPath, result.value);
      setCompatibilityField(compatibilityFields, fieldPath, result.compatibility);
    }
    const version = (current?.version || 0) + 1;
    const commitTime = timestampString(now);
    return {
      compatibilityFields,
      createTime: current?.createTime || commitTime,
      data,
      key,
      processedAt: this.processedTimestamp(compatibilityFields),
      updateTime: versionedTimestamp(commitTime, version),
      version,
    };
  }

  private materializeDocument(
    data: CommerceDocumentWriteData,
    now: CommerceTimestamp,
  ): { compatibility: Record<string, unknown>; data: CommerceDocumentData } {
    const materialized: CommerceDocumentData = {};
    const compatibility: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(data)) {
      const result = materializeUpdate(undefined, undefined, field, value, now);
      if (result.value === undefined) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce document value.');
      materialized[field] = result.value;
      compatibility[field] = result.compatibility;
    }
    return { compatibility, data: materialized };
  }

  private processedTimestamp(fields: Record<string, unknown>): CommerceTimestamp | null {
    const value = fields.processedAt;
    return isObject(value) && typeof value.timestampValue === 'string'
      ? parseTimestampString(value.timestampValue)
      : null;
  }
}

function versionedTimestamp(commitTime: string, version: number): string {
  const parsed = parseTimestampString(commitTime);
  if (!parsed) return commitTime;
  return timestampString({ seconds: parsed.seconds, nanos: Math.min(999_999_999, parsed.nanos + version % 1_000_000) });
}
