import type { DeliveryRecoveryRecord } from '../../../../shared/deliveryRecoveryState.js';
import { executeCommerceD1Batch } from './commerceD1Batch.js';
import { deliveryRecoveryWriteStatement, parseRecoveryState, recoverySnapshot, recoverySnapshotColumns, type RecoverySnapshot } from './deliveryRecoveryPersistence.js';
import {
  CommerceRepositoryError,
  CommerceWriteConflict,
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
} from './commerceRepositorySupport.js';
import type {
  NotificationOutboxCreate,
  NotificationOutboxFamily,
  NotificationOutboxRecord,
} from '../../../../shared/notificationOutbox.js';
import { NotificationOutboxRepository, notificationOutboxWriteStatement } from './notificationOutboxRepository.js';
import { stripeCheckoutStateFromDocument } from '../../../../shared/stripeCheckoutState.js';
import {
  isStripeCheckoutStateOnlyUpdate,
  stripeCheckoutDocumentRawData,
  stripeCheckoutStateWriteStatement,
} from './stripeCheckoutStateStore.js';
import { packStatusOutboxInsertStatement } from './packStatusOutboxRepository.js';
import { commerceDocumentWriteStatement } from './commerceDocumentPersistence.js';
import { CommerceRecoveryStaging, rejectDeliveryRecoveryUpdates } from './commerceRecoveryStaging.js';
import { CommerceOutboxStaging, requireStagedReadyDelivery } from './commerceOutboxStaging.js';
import {
  serializeCommerceCommitExpectations,
  type DocumentExpectation,
  type SerializedCommerceCommitExpectations,
} from './commerceCommitExpectations.js';

type PendingDocument = StoredDocument | null;

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
  private authorityChecked = false;
  private checkoutStateChecked = false;
  private readonly recovery = new CommerceRecoveryStaging();
  private closed = false;
  private readonly deliveryOwnerExpectations = new Map<string, number>();
  private readonly expectations = new Map<string, DocumentExpectation>();
  private readonly original = new Map<string, StoredDocument | null>();
  private readonly pending = new Map<string, PendingDocument>();
  private readonly outboxes = new CommerceOutboxStaging();
  private readonly createPaths = new Set<string>();
  private readonly existingPaths = new Set<string>();
  private commitTimestamp: CommerceTimestamp;
  private writesStarted = false;

  constructor(
    private readonly db: D1Database,
    private readonly nowMs: number,
  ) {
    this.commitTimestamp = timestampFromMilliseconds(nowMs);
  }

  async get(
    key: CommerceDocumentKey,
  ): Promise<CommerceDocumentRecord | null> {
    this.assertOpen();
    if (this.writesStarted) throw new CommerceRepositoryError('invalid-argument', 'Commerce reads must precede writes.');
    const document = await this.load(key);
    return document ? publicRecord(document) : null;
  }

  async getRecoverySnapshot(key: CommerceDocumentKey<'delivery_order'>): Promise<RecoverySnapshot | null> {
    this.assertOpen();
    if (this.writesStarted && !this.recovery.pending.has(key.path) && !this.recovery.original.has(key.path)) {
      throw new CommerceRepositoryError('invalid-argument', 'Commerce reads must precede writes.');
    }
    return this.loadRecoverySnapshot(key);
  }

  stageRecovery(input: DeliveryRecoveryRecord): void {
    this.assertOpen();
    this.recovery.stage(input);
    this.writesStarted = true;
  }

  private async loadRecoverySnapshot(key: CommerceDocumentKey<'delivery_order'>): Promise<RecoverySnapshot | null> {
    if (!this.recovery.original.has(key.path)) {
      await this.readBatch([
        this.db.prepare('SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1'),
        this.db.prepare(`SELECT ${DOCUMENT_COLUMNS}, ${recoverySnapshotColumns('commerce_documents')}
          FROM commerce_documents WHERE document_path = ?`).bind(key.path),
        this.db.prepare('SELECT revision FROM commerce_document_path_revisions WHERE document_path = ?').bind(key.path),
      ], ([control, documents, revisions]) => {
        if (control.results.length !== 1 || control.results[0].storage_mode !== 'table' || documents.results.length > 1 || revisions.results.length > 1) throw unavailableCommerce();
        const pathRevision = revisions.results[0]?.revision ?? 0;
        if (typeof pathRevision !== 'number' || !Number.isSafeInteger(pathRevision) || pathRevision < 0) throw unavailableCommerceData();
        const row = documents.results[0];
        const document = row ? parseRow(row) : null;
        if (document) assertDocumentIdentity(document.key, key);
        this.recordRead(key.path, document?.version ?? -1, document, pathRevision);
        let state: DeliveryRecoveryRecord | null = null;
        if (document) {
          state = parseRecoveryState(row);
          if (state.parentPath !== key.path) throw unavailableCommerceData();
        }
        this.recovery.recordRead(key.path, state);
      });
    }
    const document = this.pending.has(key.path) ? this.pending.get(key.path) : this.original.get(key.path);
    if (!document) return null;
    const state = this.recovery.current(key.path);
    if (!state) throw unavailableCommerceData();
    return recoverySnapshot(document, state, this.expectations.get(key.path)?.pathRevision ?? 0);
  }

  async getNotificationOutbox(parentPath: string, family: NotificationOutboxFamily): Promise<NotificationOutboxRecord | null> {
    this.assertOpen();
    if (!this.outboxes.hasRead(parentPath, family)) {
      this.outboxes.recordRead(parentPath, family, await new NotificationOutboxRepository(this.db).get(parentPath, family));
    }
    return this.outboxes.current(parentPath, family);
  }

  enqueuePackStatusProjection(input: { parentPath: string; dropId: string }): void {
    this.assertOpen();
    this.outboxes.stagePackStatus(input, this.pending.get(input.parentPath), this.nowMs);
  }

  async enqueueNotificationOutbox(input: NotificationOutboxCreate): Promise<NotificationOutboxRecord> {
    const current = await this.getNotificationOutbox(input.parentPath, input.family);
    if (current) return current;
    return this.stageNotificationOutbox(input, null);
  }

  async replaceNotificationOutbox(input: NotificationOutboxCreate): Promise<NotificationOutboxRecord> {
    const current = await this.getNotificationOutbox(input.parentPath, input.family);
    return this.stageNotificationOutbox(input, current, true);
  }

  async cancelNotificationOutbox(
    parentPath: string,
    family: NotificationOutboxFamily,
    reason = 'source-ineligible',
  ): Promise<NotificationOutboxRecord | null> {
    const current = await this.getNotificationOutbox(parentPath, family);
    return this.outboxes.cancelNotification(current, reason, timestampMilliseconds(this.commitTimestamp));
  }

  private async stageNotificationOutbox(
    input: NotificationOutboxCreate,
    current: NotificationOutboxRecord | null,
    replace = false,
  ): Promise<NotificationOutboxRecord> {
    const parentKey = this.outboxes.notificationParentKey(input, current, replace);
    const parent = this.pending.has(input.parentPath) ? this.pending.get(input.parentPath) : await this.load(parentKey);
    return this.outboxes.stageNotification(input, current, parent, timestampMilliseconds(this.commitTimestamp));
  }

  async getMany(
    keys: readonly CommerceDocumentKey[],
  ): Promise<Array<CommerceDocumentRecord | null>> {
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
      return publicRecord(document);
    });
  }

  async queryDeliveryOrdersByOwner(
    args: Readonly<{ owner: string; limit: number }>,
  ): Promise<CommerceDocumentRecord[]> {
    this.assertOpen();
    if (this.writesStarted) throw new CommerceRepositoryError('invalid-argument', 'Commerce reads must precede writes.');
    const scopedOwner = deliveryOwner(args.owner);
    const boundedLimit = positiveQueryLimit(args.limit);
    const query = deliveryOrdersByOwnerQuery({ owner: scopedOwner, limit: boundedLimit });
    return this.readBatch([
      deliveryOwnerRevisionStatement(this.db, scopedOwner),
      this.db.prepare(query.sql).bind(...query.bindings),
    ], ([revisionResult, dataResult]) => {
      const revision = parseDeliveryOwnerRevision(revisionResult);
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
      return documents.map(({ document }) => publicRecord(document));
    });
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
    if (key.kind === 'delivery_order') {
      const receiptRecoveryJson = Object.hasOwn(document.data, 'receiptRecovery') ? JSON.stringify(document.data.receiptRecovery) : null;
      this.recovery.create(key.path, receiptRecoveryJson, this.nowMs);
      delete document.data.receiptRecovery;
      document.rawData = document.data;
    }
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
    if (key.kind === 'delivery_order' && !current) {
      await this.create({ ...key, kind: 'delivery_order' }, data);
      return;
    }
    rejectDeliveryRecoveryUpdates(key, data);
    if (!options.merge) {
      this.pending.set(key.path, this.replaceDocument(key, current, data));
      return;
    }
    const updates = Object.fromEntries(Object.entries(data)) as Record<string, CommerceUpdateValue>;
    this.pending.set(key.path, this.patchDocument(key, current, updates, false));
  }

  async update(key: CommerceDocumentKey, updates: Readonly<Record<string, CommerceUpdateValue>>): Promise<void> {
    this.assertOpen();
    rejectDeliveryRecoveryUpdates(key, updates);
    const current = await this.loadForMutation(key);
    if (!current) throw new CommerceWriteConflict('failed-precondition');
    if (!this.createPaths.has(key.path)) this.existingPaths.add(key.path);
    this.pending.set(key.path, this.patchDocument(key, current, updates, true));
  }

  async delete(key: CommerceDocumentKey, options: Readonly<{ mustExist?: boolean }> = {}): Promise<void> {
    this.assertOpen();
    if (key.kind === 'delivery_order') await this.loadRecoverySnapshot({ ...key, kind: 'delivery_order' });
    const current = await this.loadForMutation(key);
    if (options.mustExist && !current) throw new CommerceWriteConflict('failed-precondition');
    if (options.mustExist && !this.createPaths.has(key.path)) this.existingPaths.add(key.path);
    this.pending.set(key.path, null);
    this.recovery.deletePending(key.path);
  }

  async commit(): Promise<void> {
    this.assertOpen();
    this.closed = true;
    const expectations = serializeCommerceCommitExpectations({
      documents: this.expectations,
      deliveryOwners: this.deliveryOwnerExpectations,
      recovery: this.recovery.original,
      notifications: this.outboxes.original,
    });
    if (!this.pending.size && !this.outboxes.pending.size && !this.recovery.pending.size) {
      if (!this.deliveryOwnerExpectations.size && !this.expectations.size && !this.outboxes.original.size && !this.recovery.original.size) {
        await authority(this.db);
        return;
      }
      await this.revalidateReadOnly(expectations);
      return;
    }
    const guardId = crypto.randomUUID();
    const deliveryPaths = Array.from(this.pending, ([path, document]) =>
      (document ?? this.original.get(path))?.key.kind === 'delivery_order' ? path : null).filter((path): path is string => path !== null);
    const usesRecovery = this.recovery.original.size > 0 || deliveryPaths.length > 0;
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`INSERT INTO commerce_commit_guards (
        guard_id, expectations_json, delivery_owner_expectations_json,
        expected_documents_revision, created_at_ms, notification_outbox_expectations_json, stripe_checkout_paths_json
        ${usesRecovery ? ', delivery_recovery_expectations_json, delivery_recovery_paths_json' : ''}
      ) VALUES (?, ?, ?, ?, ?, ?, ?${usesRecovery ? ', ?, ?' : ''})`).bind(
        guardId,
        expectations.documents,
        expectations.deliveryOwners,
        null,
        timestampMilliseconds(this.commitTimestamp),
        expectations.notifications,
        JSON.stringify(Array.from(this.pending, ([path, document]) =>
          (document ?? this.original.get(path))?.key.kind === 'stripe_checkout' ? path : null).filter(Boolean)),
        ...(usesRecovery ? [expectations.recovery, JSON.stringify(deliveryPaths)] : []),
      ),
    ];
    for (const [path, document] of this.pending) {
      statements.push(commerceDocumentWriteStatement(this.db, path, document, this.original.get(path)));
      if (document?.key.kind === 'stripe_checkout') {
        statements.push(stripeCheckoutStateWriteStatement(this.db,
          stripeCheckoutStateFromDocument(path, document.data, document.version)));
      }
    }
    for (const state of this.recovery.pending.values()) {
      statements.push(deliveryRecoveryWriteStatement(this.db, state, this.recovery.original.get(state.parentPath) === null));
    }
    for (const outbox of this.outboxes.pending.values()) {
      statements.push(notificationOutboxWriteStatement(this.db, outbox));
    }
    for (const outbox of this.outboxes.pendingPackStatus.values()) {
      requireStagedReadyDelivery(outbox, this.pending.get(outbox.parentPath));
      statements.push(packStatusOutboxInsertStatement(this.db, outbox));
    }
    if (this.pending.size) statements.push(this.db.prepare(`UPDATE commerce_authority_control
      SET documents_revision = documents_revision + 1, updated_at_ms = ? WHERE singleton = 1`)
      .bind(timestampMilliseconds(this.commitTimestamp)));
    statements.push(this.db.prepare('DELETE FROM commerce_commit_guards WHERE guard_id = ?').bind(guardId));
    try {
      await this.db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/authority is not d1|notification outbox is unavailable|stripe checkout state is unavailable|pack-status outbox is unavailable|delivery recovery is unavailable/i.test(message)) {
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
    this.outboxes.clearPending();
    this.recovery.clearPending();
  }

  private assertOpen(): void {
    if (this.closed) throw new CommerceRepositoryError('invalid-argument', 'Commerce unit of work is closed.');
  }

  private async revalidateReadOnly(
    expectations: SerializedCommerceCommitExpectations,
  ): Promise<void> {
    const results = await executeCommerceD1Batch(this.db, () => [
      authorityStatement(this.db),
      this.db.prepare(`SELECT EXISTS (
        SELECT 1
        FROM json_each(?) AS expectation
        LEFT JOIN commerce_delivery_owner_revisions AS owner_revision
          ON owner_revision.owner = json_extract(expectation.value, '$.owner')
        WHERE COALESCE(owner_revision.revision, 0) <>
          CAST(json_extract(expectation.value, '$.revision') AS INTEGER)
      ) AS conflict`).bind(expectations.deliveryOwners),
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
      ) AS conflict`).bind(expectations.documents),
      ...(this.recovery.original.size ? [this.db.prepare(`SELECT
        NOT EXISTS (SELECT 1 FROM commerce_delivery_recovery_control WHERE singleton = 1 AND storage_mode = 'table') OR EXISTS (
          SELECT 1 FROM json_each(?) AS expected LEFT JOIN commerce_delivery_recovery AS state
            ON state.parent_path = json_extract(expected.value, '$.parentPath')
          WHERE COALESCE(state.revision, -1) <> json_extract(expected.value, '$.revision')
            OR state.generation IS NOT json_extract(expected.value, '$.generation')
        ) AS conflict`).bind(expectations.recovery)] : []),
      ...(this.outboxes.original.size ? [this.db.prepare(`SELECT CASE WHEN ? = 0 THEN 0 ELSE
        NOT EXISTS (SELECT 1 FROM commerce_notification_outbox_control WHERE storage_mode = 'table') OR EXISTS (
          SELECT 1 FROM json_each(?) AS expectation
          LEFT JOIN commerce_notification_outbox AS outbox
            ON outbox.parent_path = json_extract(expectation.value, '$.parentPath')
            AND outbox.family = json_extract(expectation.value, '$.family')
          WHERE COALESCE(outbox.revision, -1) <> json_extract(expectation.value, '$.revision')
            OR outbox.generation IS NOT json_extract(expectation.value, '$.generation')
        ) END AS conflict`).bind(this.outboxes.original.size, expectations.notifications)] : []),
    ], { invalidResult: unavailableCommerce, requireMeta: true, mapBatchError: unavailableCommerce });
    const [authorityResult, ...conflicts] = results;
    if (
      authorityResult.success !== true ||
      authorityResult.results.length !== 1 ||
      !isObject(authorityResult.meta)
    ) throw unavailableCommerce();
    const control = parseAuthorityControl(authorityResult.results[0]);
    if (control.state !== 'd1') throw unavailableCommerce();
    if (
      conflicts.some(parseConflictResult)
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

  private async readBatch<T>(
    statements: D1PreparedStatement[],
    read: (results: D1Result<Record<string, unknown>>[]) => T,
  ): Promise<T> {
    const needsAuthority = !this.authorityChecked;
    const results = await executeCommerceD1Batch(this.db,
      () => needsAuthority ? [authorityStatement(this.db), ...statements] : statements,
      {
        invalidResult: unavailableCommerceData,
        requireMeta: true,
        mapBatchError: (error) => needsAuthority ? unavailableCommerce(error) : error,
      });
    if (needsAuthority) {
      const authorityResult = results[0];
      if (authorityResult.results.length !== 1) throw unavailableCommerceData();
      if (parseAuthorityControl(authorityResult.results[0]).state !== 'd1') throw unavailableCommerce();
    }
    const value = read(needsAuthority ? results.slice(1) : results);
    this.authorityChecked = true;
    return value;
  }

  private async loadBatch(keys: readonly CommerceDocumentKey[]): Promise<void> {
    const keysByPath = new Map(keys.map((key) => [key.path, key]));
    const paths = Array.from(keysByPath.keys());
    const placeholders = paths.map(() => '?').join(', ');
    const checkCheckoutState = !this.checkoutStateChecked && keys.some((key) => key.kind === 'stripe_checkout');
    await this.readBatch([
      this.db.prepare(`SELECT document_path, revision FROM commerce_document_path_revisions
        WHERE document_path IN (${placeholders})`).bind(...paths),
      this.db.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM commerce_documents
        WHERE document_path IN (${placeholders})`).bind(...paths),
      ...(checkCheckoutState ? [this.db.prepare('SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1')] : []),
    ], (results) => {
      const [revisionResult, documentResult, checkoutStateResult] = results;
      if (checkCheckoutState) {
        if (checkoutStateResult.results.length !== 1 || checkoutStateResult.results[0].storage_mode !== 'table') {
          throw unavailableCommerce();
        }
        this.checkoutStateChecked = true;
      }
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
    });
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
    const version = this.nextDocumentVersion(key, null);
    return {
      createTime: commitTime,
      data: materialized.data,
      rawData: key.kind === 'stripe_checkout'
        ? stripeCheckoutDocumentRawData({ documentPath: key.path, data: materialized.data, documentVersion: version,
          previousRawData: this.original.get(key.path)?.rawData })
        : materialized.data,
      key,
      processedAt: materialized.processedAt,
      updateTime: commitTime,
      version,
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
      rawData: key.kind === 'stripe_checkout'
        ? stripeCheckoutDocumentRawData({ documentPath: key.path, data: materialized.data, documentVersion: version,
          previousRawData: current?.rawData ?? this.original.get(key.path)?.rawData })
        : materialized.data,
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
    const stateOnly = key.kind === 'stripe_checkout' && isStripeCheckoutStateOnlyUpdate(updates);
    const data = current ? stateOnly ? { ...current.data } : cloneData(current.data) : {};
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
    const rawData = key.kind === 'stripe_checkout'
      ? stripeCheckoutDocumentRawData({ documentPath: key.path, data, documentVersion: version,
        previousRawData: current?.rawData ?? this.original.get(key.path)?.rawData,
        reuseRawData: current ? stateOnly ? 'unchanged' : 'if-equal' : undefined })
      : data;
    return {
      createTime: current?.createTime || commitTime,
      data,
      rawData,
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
