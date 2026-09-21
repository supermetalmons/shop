import {
  CommerceRepositoryError,
  CommerceWriteConflict,
  type CommerceDocumentData,
  type CommerceDocumentKey,
  type CommerceDocumentRecord,
  type CommerceDocumentWriteData,
  type CommerceJsonValue,
  type CommerceTimestamp,
  type CommerceUpdateValue,
} from './commerceRepositoryTypes.js';
import {
  COMMERCE_DOCUMENT_COLUMNS as DOCUMENT_COLUMNS,
  deliveryOrdersByOwnerQuery,
} from './commerceQueries.js';
import {
  assertDocumentIdentity,
  cloneData,
  compareTimestamps,
  dataField,
  materializeDocument,
  materializeUpdate,
  nextTimestamp,
  parseRow,
  parseTimestampString,
  processedTimestampForUpdate,
  publicRecord,
  setDataField,
  timestampFromMilliseconds,
  timestampMilliseconds,
  timestampString,
  type StoredDocument,
} from './commerceDocumentCodec.js';
import {
  authority,
  authorityStatement,
  deliveryOwner,
  isObject,
  parseAuthorityControl,
  positiveQueryLimit,
  reportInefficientQuery,
  unavailableCommerce,
  unavailableCommerceData,
  type CommerceAuthorityControl,
} from './commerceRepositorySupport.js';

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

const COMMERCE_READ_BATCH_SIZE = 50;

function deliveryOwnerRevisionStatement(db: D1Database, owner: string): D1PreparedStatement {
  return db.prepare(`SELECT COALESCE((
    SELECT revision FROM commerce_delivery_owner_revisions WHERE owner = ?
  ), 0) AS revision`).bind(owner);
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
    const query = deliveryOrdersByOwnerQuery({ owner: scopedOwner, limit: boundedLimit });
    const results = await this.db.batch<Record<string, unknown>>([
      deliveryOwnerRevisionStatement(this.db, scopedOwner),
      this.db.prepare(query.sql).bind(...query.bindings),
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
    const documents = dataResult.results.map((row) => {
      const document = parseRow(row);
      const pathRevision = row.path_revision;
      if (
        typeof pathRevision !== 'number' ||
        !Number.isSafeInteger(pathRevision) ||
        pathRevision < 0
      ) throw unavailableCommerceData();
      return { document, pathRevision };
    });
    reportInefficientQuery('delivery-orders-by-owner', 'delivery_order', dataResult, documents.length);
    for (const { document, pathRevision } of documents) {
      this.recordRead(document.key.path, document.version, document, pathRevision);
    }
    return documents.map(({ document }) => publicRecord<T>(document));
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
    await this.loadBatch([key]);
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
    const materialized = materializeDocument(data, now);
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
    const materialized = materializeDocument(data, now);
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
}
