import { DELIVERY_RECOVERY_FIELD_COLUMNS, parseDeliveryRecoveryRow } from '../../shared/deliveryRecoveryState.ts';
import { createD1MaintenanceRunner, type D1MaintenanceQueryBatch } from './d1MaintenanceRunner.ts';
import { isCommerceDocumentSegment } from '../../shared/commerceDocumentPath.ts';
import { hydrateStripeCheckoutState, parseStripeCheckoutStateRow, STRIPE_CHECKOUT_STATE_FIELD_COLUMNS } from '../../shared/stripeCheckoutState.ts';

export type CommerceD1Row = Record<string, unknown>;

export type CommerceD1DocumentKind =
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

export type CommerceD1Document = {
  data: Record<string, unknown>;
  documentId: string;
  dropId: string | null;
  kind: CommerceD1DocumentKind;
  path: string;
  version: number;
  createTime: string;
  updateTime: string;
};

export type CommerceD1Authority = {
  state: 'paused' | 'd1';
  revision: number;
  documentsRevision: number;
  pausedAtMs: number | null;
  databaseNowMs: number;
};

export type CommerceAuthorityQuery = (
  sql: string,
) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>;

export type CommerceAuthorityLease = {
  acquiredAtMs: number;
  expiresAtMs: number;
  token: string;
};

const commerceD1 = createD1MaintenanceRunner('commerce');
const COMMERCE_AUTHORITY_LEASE_TTL_MS = 30 * 60_000;
export const COMMERCE_D1_NOW_MS_SQL = "(CAST(strftime('%s', 'now') AS INTEGER) * 1000)";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  throw new Error(message);
}

export function queryRemoteCommerceD1(sql: string): CommerceD1Row[] {
  return commerceD1.query(sql);
}

export const queryRemoteCommerceD1Batch: D1MaintenanceQueryBatch = commerceD1.queryBatch;

export function commerceAuthorityLeaseToken(value: unknown): string {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!UUID_V4_PATTERN.test(token)) return fail('Commerce authority coordination lease token is invalid.');
  return token.toLowerCase();
}

function parseCommerceAuthorityLeaseRow(
  value: unknown,
  expectedToken: string,
): CommerceAuthorityLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('Commerce authority coordination lease response is invalid.');
  }
  const row = value as Record<string, unknown>;
  const token = commerceAuthorityLeaseToken(row.lease_token);
  const acquiredAtMs = safeInteger(row.acquired_at_ms, 'Commerce authority coordination lease acquisition');
  const expiresAtMs = safeInteger(row.expires_at_ms, 'Commerce authority coordination lease expiry');
  if (token !== expectedToken || expiresAtMs <= acquiredAtMs) {
    return fail('Commerce authority coordination lease response is invalid.');
  }
  return { acquiredAtMs, expiresAtMs, token };
}

export async function acquireCommerceAuthorityLease(
  queryCommerceD1: CommerceAuthorityQuery,
  rawToken: string,
): Promise<CommerceAuthorityLease> {
  const token = commerceAuthorityLeaseToken(rawToken);
  let rows: Record<string, unknown>[];
  try {
    rows = await queryCommerceD1(`INSERT INTO commerce_authority_control_lease (
        singleton, lease_token, acquired_at_ms, expires_at_ms
      ) VALUES (
        1,
        ${sqlString(token)},
        ${COMMERCE_D1_NOW_MS_SQL},
        ${COMMERCE_D1_NOW_MS_SQL} + ${COMMERCE_AUTHORITY_LEASE_TTL_MS}
      )
      ON CONFLICT(singleton) DO UPDATE SET
        lease_token = excluded.lease_token,
        acquired_at_ms = excluded.acquired_at_ms,
        expires_at_ms = excluded.expires_at_ms
      WHERE commerce_authority_control_lease.expires_at_ms <= ${COMMERCE_D1_NOW_MS_SQL}
      RETURNING lease_token, acquired_at_ms, expires_at_ms`);
  } catch {
    return fail('Commerce authority coordination lease could not be acquired.');
  }
  if (rows.length === 0) return fail('Another commerce authority control operation is already running.');
  if (rows.length !== 1) return fail('Commerce authority coordination lease response is invalid.');
  return parseCommerceAuthorityLeaseRow(rows[0], token);
}

export async function renewCommerceAuthorityLease(
  queryCommerceD1: CommerceAuthorityQuery,
  lease: CommerceAuthorityLease,
): Promise<CommerceAuthorityLease> {
  let rows: Record<string, unknown>[];
  try {
    rows = await queryCommerceD1(`UPDATE commerce_authority_control_lease
      SET expires_at_ms = ${COMMERCE_D1_NOW_MS_SQL} + ${COMMERCE_AUTHORITY_LEASE_TTL_MS}
      WHERE singleton = 1 AND lease_token = ${sqlString(lease.token)}
        AND expires_at_ms > ${COMMERCE_D1_NOW_MS_SQL}
      RETURNING lease_token, acquired_at_ms, expires_at_ms`);
  } catch {
    return fail('Commerce authority coordination lease could not be renewed.');
  }
  if (rows.length !== 1) return fail('Commerce authority coordination lease ownership was lost.');
  return parseCommerceAuthorityLeaseRow(rows[0], lease.token);
}

export async function releaseCommerceAuthorityLease(
  queryCommerceD1: CommerceAuthorityQuery,
  lease: CommerceAuthorityLease,
): Promise<void> {
  let rows: Record<string, unknown>[];
  try {
    rows = await queryCommerceD1(`DELETE FROM commerce_authority_control_lease
      WHERE singleton = 1 AND lease_token = ${sqlString(lease.token)}
      RETURNING lease_token`);
  } catch {
    return fail('Commerce authority coordination lease could not be released.');
  }
  if (
    rows.length !== 1 ||
    commerceAuthorityLeaseToken(rows[0].lease_token) !== lease.token
  ) return fail('Commerce authority coordination lease ownership was lost before release.');
}

export async function withCommerceMaintenanceLease<T>(
  options: {
    query: CommerceAuthorityQuery;
    token: string;
    releaseFailureMessage: string;
    now?: () => number;
  },
  operation: (context: { token: string; renew: () => Promise<void> }) => Promise<T>,
): Promise<T> {
  let lease = await acquireCommerceAuthorityLease(options.query, options.token);
  const now = options.now ?? Date.now;
  let renewedAt = now();
  const renew = async () => {
    if (now() - renewedAt < 60_000) return;
    lease = await renewCommerceAuthorityLease(options.query, lease);
    renewedAt = now();
  };
  let operationError: unknown;
  let operationFailed = false;
  try {
    return await operation({ token: lease.token, renew });
  } catch (error) {
    operationError = error;
    operationFailed = true;
    throw error;
  } finally {
    try {
      await releaseCommerceAuthorityLease(options.query, lease);
    } catch (error) {
      if (operationFailed) throw new AggregateError([operationError, error], options.releaseFailureMessage);
      throw error;
    }
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) return fail(`${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function commerceD1DocumentIdentity(path: string): {
  documentId: string;
  dropId: string | null;
  kind: CommerceD1DocumentKind;
} | null {
  const segments = path.split('/');
  if (segments.length === 2 && segments[0] === 'claimCodes' && isCommerceDocumentSegment(segments[1])) {
    return { kind: 'claim_code', dropId: null, documentId: segments[1] };
  }
  if (segments.length !== 4 || segments[0] !== 'drops' ||
    !isCommerceDocumentSegment(segments[1]) || !isCommerceDocumentSegment(segments[3])) return null;
  const kind = new Map<string, CommerceD1DocumentKind>([
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

export function parseCommerceD1DocumentRow(row: CommerceD1Row): CommerceD1Document {
  const path = requiredString(row.document_path, 'Commerce D1 document path');
  const identity = commerceD1DocumentIdentity(path);
  if (!identity) return fail(`Commerce D1 document path is unsupported: ${path}.`);
  const kind = requiredString(row.document_kind, `${path} document kind`);
  const documentId = requiredString(row.document_id, `${path} document id`);
  const dropId = row.drop_id === null ? null : requiredString(row.drop_id, `${path} drop id`);
  const version = safeInteger(row.version, `${path} version`);
  if (version < 1) return fail(`${path} version is invalid.`);
  const createTime = requiredString(row.create_time, `${path} creation time`);
  const updateTime = requiredString(row.update_time, `${path} update time`);
  if (
    kind !== identity.kind ||
    documentId !== identity.documentId ||
    dropId !== identity.dropId ||
    !Number.isFinite(Date.parse(createTime)) ||
    !Number.isFinite(Date.parse(updateTime))
  ) return fail(`Commerce D1 document identity is inconsistent: ${path}.`);
  let data: unknown;
  try {
    data = JSON.parse(requiredString(row.document_json, `${path} document JSON`));
  } catch {
    return fail(`Commerce D1 document JSON is invalid: ${path}.`);
  }
  if (!isRecord(data)) return fail(`Commerce D1 document JSON is invalid: ${path}.`);
  return {
    data,
    documentId,
    dropId,
    kind: identity.kind,
    path,
    version,
    createTime,
    updateTime,
  };
}

export function queryRemoteCommerceDocuments(
  sql: string,
  query: typeof queryRemoteCommerceD1 = queryRemoteCommerceD1,
): CommerceD1Document[] {
  const controls = query(`SELECT
    (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) AS checkout_state_mode,
    (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) AS recovery_state_mode`);
  if (controls.length !== 1 || controls[0].checkout_state_mode !== 'table' || controls[0].recovery_state_mode !== 'table') {
    return fail('Commerce maintenance requires active checkout and delivery recovery table storage.');
  }
  const checkoutColumns = ['document_path', 'document_version', ...Object.values(STRIPE_CHECKOUT_STATE_FIELD_COLUMNS)];
  const recoveryColumns = Object.values(DELIVERY_RECOVERY_FIELD_COLUMNS).filter((column) => column !== 'receipt_recovery_json');
  const snapshot = query(`SELECT snapshot.document_path, snapshot.document_kind, snapshot.drop_id, snapshot.document_id,
      snapshot.version, snapshot.create_time, snapshot.update_time, snapshot.document_json,
      (SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) AS checkout_state_mode,
      (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) AS recovery_state_mode,
      CASE WHEN snapshot.document_kind = 'stripe_checkout' THEN (
        SELECT json_object(${checkoutColumns.map((column) => `'${column}', checkout.${column}`).join(', ')})
        FROM commerce_stripe_checkout_state AS checkout WHERE checkout.document_path = snapshot.document_path
      ) END AS checkout_state_json,
      CASE WHEN snapshot.document_kind = 'delivery_order' THEN (
        SELECT json_object(${recoveryColumns.map((column) => `'${column}', recovery.${column}`).join(', ')})
        FROM commerce_delivery_recovery AS recovery WHERE recovery.parent_path = snapshot.document_path
      ) END AS recovery_state_json,
      CASE WHEN snapshot.document_kind = 'delivery_order' THEN (
        SELECT recovery.receipt_recovery_json FROM commerce_delivery_recovery AS recovery WHERE recovery.parent_path = snapshot.document_path
      ) END AS recovery_payload_json
    FROM (${sql.trim().replace(/;$/, '')}) AS snapshot`);
  return snapshot.map((row) => {
    const document = parseCommerceD1DocumentRow(row);
    if (document.kind === 'delivery_order') {
      if (row.recovery_state_mode !== 'table') return fail('Delivery recovery state control is invalid.');
      if (typeof row.recovery_state_json !== 'string') return fail(`Delivery recovery state is missing: ${document.path}.`);
      const state = parseDeliveryRecoveryRow({
        ...JSON.parse(row.recovery_state_json), receipt_recovery_json: row.recovery_payload_json,
      });
      if (state.parentPath !== document.path) return fail(`Delivery recovery state parent is invalid: ${document.path}.`);
      const data = { ...document.data };
      delete data.receiptRecovery;
      if (state.receiptRecoveryJson !== null) data.receiptRecovery = JSON.parse(state.receiptRecoveryJson);
      return { ...document, data };
    }
    if (document.kind !== 'stripe_checkout') return document;
    if (row.checkout_state_mode !== 'table') return fail('Stripe checkout state control is invalid.');
    if (typeof row.checkout_state_json !== 'string') return fail(`Stripe checkout state is missing or stale: ${document.path}.`);
    const state = parseStripeCheckoutStateRow(JSON.parse(row.checkout_state_json));
    if (state.documentPath !== document.path || state.documentVersion !== document.version) {
      return fail(`Stripe checkout state is missing or stale: ${document.path}.`);
    }
    return { ...document, data: hydrateStripeCheckoutState(document.data, state) };
  });
}

export function readRemoteCommerceAuthority(): CommerceD1Authority {
  const rows = queryRemoteCommerceD1(`SELECT authority_state, revision, documents_revision, paused_at_ms,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS database_now_ms
    FROM commerce_authority_control WHERE singleton = 1`);
  if (rows.length !== 1) return fail('Commerce D1 authority control is invalid.');
  const state = rows[0].authority_state;
  if (state !== 'paused' && state !== 'd1') {
    return fail('Commerce D1 authority state is invalid.');
  }
  return {
    state,
    revision: safeInteger(rows[0].revision, 'Commerce D1 authority revision'),
    documentsRevision: safeInteger(rows[0].documents_revision, 'Commerce D1 documents revision'),
    pausedAtMs: rows[0].paused_at_ms === null
      ? null
      : safeInteger(rows[0].paused_at_ms, 'Commerce D1 pause timestamp'),
    databaseNowMs: safeInteger(rows[0].database_now_ms, 'Commerce D1 current timestamp'),
  };
}

export function executeRemoteCommerceD1File(filePath: string): CommerceD1Row[][] {
  return commerceD1.executeFile(filePath);
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function safeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return fail(`${label} is invalid.`);
  return number;
}
