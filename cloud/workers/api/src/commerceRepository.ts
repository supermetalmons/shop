import {
  CommerceRepositoryError,
  type CommerceDocumentData,
  type CommerceDocumentKey,
  type CommerceDocumentKind,
  type CommerceDocumentRecord,
} from './commerceRepositoryTypes.js';
import {
  COMMERCE_DOCUMENT_COLUMNS as DOCUMENT_COLUMNS,
  adminIrlRedeemWorkflowStatusQuery,
  deliveryHistoryQuery,
  deliveryOrderOwnersQuery,
  deliveryRecoveryOrdersQuery,
  duePackStatusProjectionsQuery,
  dueReadyNotificationsQuery,
  dueStripeTerminalNotificationsQuery,
  fulfillmentOrdersQuery,
  legacyClaimAssignmentsQuery,
  manualReviewCheckoutsQuery,
  pendingReadyNotificationsQuery,
  staleStripeFulfillmentsQuery,
  type CommerceSqlQuery,
  type FulfillmentOrdersQueryArgs,
} from './commerceQueries.js';
import { isTimestampLike, parseRow, publicRecord } from './commerceDocumentCodec.js';
import {
  authority,
  authorityStatement,
  deliveryOwner,
  isObject,
  parseAuthorityControl,
  positiveQueryLimit,
  reportCommerceReadFailure,
  reportInefficientQuery,
  unavailableCommerce,
  unavailableCommerceData,
  type CommerceAuthorityControl as AuthorityControl,
} from './commerceRepositorySupport.js';
import { CommerceUnitOfWork } from './commerceUnitOfWork.js';

export * from './commerceRepositoryTypes.js';
export { commerceKeyFromPath, commerceKeys } from './commerceDocumentCodec.js';
export {
  d1RetryCount,
  loadCommerceAuthorityControl,
} from './commerceRepositorySupport.js';
export type CommerceAuthorityControl = AuthorityControl;
export { CommerceUnitOfWork } from './commerceUnitOfWork.js';

export class D1CommerceRepository {
  constructor(private readonly db: D1Database) {}

  async getDudeInventory(args: Readonly<{
    dropFamily: string;
    dropId: string;
    itemsPerBox: number;
    maxDudeId: number;
  }>): Promise<{ generation: string; pool: number[] }> {
    let results: D1Result<Record<string, unknown>>[];
    try {
      results = await this.db.batch<Record<string, unknown>>([
        this.db.prepare(`SELECT authority_state, dude_inventory_mode
          FROM commerce_authority_control WHERE singleton = 1`),
        this.db.prepare(`SELECT generation, ready, drop_family, items_per_box, max_dude_id
          FROM commerce_inventory_drops WHERE drop_id = ?`).bind(args.dropId),
        this.db.prepare(`SELECT available.dude_id, available.pool_position
          FROM commerce_authority_control AS authority
          CROSS JOIN commerce_inventory_drops AS inventory
          JOIN commerce_available_dudes AS available ON available.drop_id = inventory.drop_id
          WHERE authority.singleton = 1 AND authority.authority_state = 'd1'
            AND authority.dude_inventory_mode = 'rows'
            AND inventory.drop_id = ? AND inventory.ready = 1
          ORDER BY available.pool_position`).bind(args.dropId),
      ]);
    } catch (error) {
      reportCommerceReadFailure(error);
      throw unavailableCommerce(error);
    }
    if (results.length !== 3 || results.some((result) =>
      result.success !== true || !Array.isArray(result.results) || !isObject(result.meta))) {
      throw unavailableCommerceData();
    }
    const [authorityResult, inventoryResult, availableResult] = results;
    const control = authorityResult.results[0];
    if (authorityResult.results.length !== 1 || !isObject(control) ||
      control.authority_state !== 'd1' || control.dude_inventory_mode !== 'rows') {
      throw unavailableCommerce();
    }
    const inventory = inventoryResult.results[0];
    if (inventoryResult.results.length !== 1 || !isObject(inventory) || inventory.ready !== 1 ||
      inventory.drop_family !== args.dropFamily || inventory.items_per_box !== args.itemsPerBox ||
      inventory.max_dude_id !== args.maxDudeId ||
      typeof inventory.generation !== 'string' || inventory.generation.length !== 36) {
      throw new CommerceRepositoryError('unavailable', 'Figure inventory is not initialized for this drop.');
    }
    let previousPosition = -1;
    const pool = availableResult.results.map((row) => {
      const id = row.dude_id;
      const position = row.pool_position;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > args.maxDudeId ||
        typeof position !== 'number' || !Number.isSafeInteger(position) || position <= previousPosition) {
        throw unavailableCommerceData();
      }
      previousPosition = position;
      return id;
    });
    return { generation: inventory.generation, pool };
  }

  async getAdminIrlRedeemRequestForWorkflowStatus<T extends CommerceDocumentData>(
    operationId: string,
  ): Promise<CommerceDocumentRecord<T> | null> {
    if (!/^airf-v1-[0-9a-f]{64}$/.test(operationId)) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid Admin IRL redeem Workflow operation id.');
    }
    const query = adminIrlRedeemWorkflowStatusQuery(operationId);
    const result = await this.readBatchWithAuthority(
      () => this.db.prepare(query.sql).bind(...query.bindings),
      true,
    );
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

  async queryDeliveryHistory(args: Readonly<{ owners: readonly string[] }>): Promise<CommerceDocumentRecord[]> {
    if (!Array.isArray(args.owners) || args.owners.length === 0 ||
      args.owners.some((owner) => typeof owner !== 'string')) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid delivery history owners.');
    }
    return this.readDocuments(deliveryHistoryQuery(args), 'delivery-history', 'delivery_order');
  }

  async queryFulfillmentOrders(args: FulfillmentOrdersQueryArgs): Promise<CommerceDocumentRecord[]> {
    const limit = positiveQueryLimit(args.limit);
    if (args.startAfter !== undefined && (
      !isObject(args.startAfter) || !isTimestampLike(args.startAfter.processedAt) ||
      typeof args.startAfter.documentPath !== 'string'
    )) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce query cursor.');
    return this.readDocuments(fulfillmentOrdersQuery({ ...args, limit }), 'fulfillment-orders', 'delivery_order');
  }

  async queryManualReviewCheckouts(args: Readonly<{ dropId: string }>): Promise<CommerceDocumentRecord[]> {
    return this.readDocuments(manualReviewCheckoutsQuery(args), 'manual-review-checkouts', 'stripe_checkout');
  }

  async queryLegacyClaimAssignments(args: Readonly<{ code: string }>): Promise<CommerceDocumentRecord[]> {
    return this.readDocuments(legacyClaimAssignmentsQuery(args), 'legacy-claim-assignments', 'box_assignment');
  }

  async queryDeliveryOrderOwners(args: Readonly<{
    startAfterOwner?: string;
    limit: number;
  }>): Promise<string[]> {
    const limit = positiveQueryLimit(args.limit);
    const startAfterOwner = args.startAfterOwner === undefined
      ? undefined
      : deliveryOwner(args.startAfterOwner);
    const query = deliveryOrderOwnersQuery({ limit, startAfterOwner });
    const result = await this.readBatchWithAuthority(
      () => this.db.prepare(query.sql).bind(...query.bindings),
    );
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
    const query = deliveryRecoveryOrdersQuery(scopedOwner);
    const result = await this.readBatchWithAuthority(
      () => this.db.prepare(query.sql).bind(...query.bindings),
    );
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
    const query = pendingReadyNotificationsQuery({ ...args, limit });
    const result = await this.readBatchWithAuthority(
      () => this.db.prepare(query.sql).bind(...query.bindings),
    );
    reportInefficientQuery('pending-ready-notifications', 'delivery_order', result, result.results.length);
    return result.results.map(parseRow).map((document) => publicRecord(document));
  }

  async queryDueReadyNotifications(args: {
    dueAtMs: number;
    limit: number;
  }): Promise<CommerceDocumentRecord[]> {
    const limit = positiveQueryLimit(args.limit);
    if (!Number.isSafeInteger(args.dueAtMs) || args.dueAtMs < 0) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid ready-notification cutoff.');
    }
    const query = dueReadyNotificationsQuery({ ...args, limit });
    const result = await this.readBatchWithAuthority(
      () => this.db.prepare(query.sql).bind(...query.bindings),
    );
    reportInefficientQuery('due-ready-notifications', 'delivery_order', result, result.results.length);
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
    const query = duePackStatusProjectionsQuery({ ...args, limit });
    const result = await this.readBatchWithAuthority(
      () => this.db.prepare(query.sql).bind(...query.bindings),
    );
    reportInefficientQuery('due-pack-status-projections', 'delivery_order', result, result.results.length);
    return result.results.map(parseRow).map((document) => publicRecord(document));
  }

  async queryStaleStripeFulfillments(cutoffMs: number): Promise<CommerceDocumentRecord[]> {
    if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe reconciliation cutoff.');
    }
    const query = staleStripeFulfillmentsQuery(cutoffMs);
    const result = await this.readBatchWithAuthority(
      () => this.db.prepare(query.sql).bind(...query.bindings),
    );
    reportInefficientQuery('stale-stripe-fulfillments', 'stripe_checkout', result, result.results.length);
    return result.results.map(parseRow).map((document) => publicRecord(document));
  }

  async queryDueStripeTerminalNotifications(dueAtMs: number, limit = 20): Promise<CommerceDocumentRecord[]> {
    positiveQueryLimit(limit);
    if (!Number.isSafeInteger(dueAtMs) || dueAtMs < 0) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe notification cutoff.');
    }
    const query = dueStripeTerminalNotificationsQuery({ dueAtMs, limit });
    const result = await this.readBatchWithAuthority(
      () => this.db.prepare(query.sql).bind(...query.bindings),
    );
    reportInefficientQuery('due-stripe-terminal-notifications', 'stripe_checkout', result, result.results.length);
    return result.results.map(parseRow).map((document) => publicRecord(document));
  }

  async begin(nowMs: number): Promise<CommerceUnitOfWork> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce operation timestamp.');
    }
    const control: CommerceAuthorityControl = await authority(this.db);
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

  private async readDocuments(
    query: CommerceSqlQuery,
    operation: string,
    kind: CommerceDocumentKind,
  ): Promise<CommerceDocumentRecord[]> {
    const result = await this.readBatchWithAuthority(
      () => this.db.prepare(query.sql).bind(...query.bindings),
    );
    const documents = result.results.map(parseRow);
    reportInefficientQuery(operation, kind, result, documents.length);
    return documents.map((document) => publicRecord(document));
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
