import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeliveryRecoveryRecord, deliveryRecoveryRow, parseDeliveryRecoveryRow } from '../../shared/deliveryRecoveryState.ts';
import { isBase58Bytes } from '../../shared/solanaRpcProxy.ts';
import { buildStripeReceiptClaimsByBoxId, requireStripeReceiptClaimCode, STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE } from '../../shared/stripeReceiptClaims.ts';
import { materializeDocument, parseRow, timestampFromMilliseconds, timestampString } from '../../cloud/workers/api/src/commerceDocumentCodec.ts';
import { commerceFieldValue, type CommerceDocumentData } from '../../cloud/workers/api/src/commerceRepositoryTypes.ts';
import type { AdminReceiptIssuanceDeliveryOrderCreate } from '../../cloud/workers/api/src/deliveryOrderCreate.ts';
import { createD1MaintenanceRunner } from './d1MaintenanceRunner.ts';
import { queryRemoteCommerceD1, sqlString, type CommerceAuthorityQuery } from './commerceD1Maintenance.ts';

export const BINDER_RECEIPT_ISSUANCE_ID = 'card-nft-binder-packing-2026-10-20';
export const BINDER_RECEIPT_ISSUANCE_OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const BINDER_RECEIPT_ISSUANCE_DROP = 'card_nft_binder';
const SOURCE = 'admin_receipt_issuance';
const REASON = 'Packing replacements';

export type BinderReceiptIssuanceReservation = {
  issuanceId: string;
  deliveryId: number;
  receiptOwner: string;
  createdAtMs: number;
  receipts: Array<{ receiptId: number; code: string; assetId?: string; signature?: string }>;
};

export type BinderReceiptIssuancePlan = Omit<BinderReceiptIssuanceReservation, 'receipts'> & {
  receipts: Array<{ receiptId: number; code: string; assetId: string; signature: string }>;
};

type PublicationDocument = {
  path: string;
  kind: 'delivery_order' | 'claim_code';
  dropId: string | null;
  documentId: string;
  data: CommerceDocumentData;
  processedAt: { seconds: number; nanos: number } | null;
};

type Dependencies = {
  query: CommerceAuthorityQuery;
  executeFile: (filePath: string) => unknown | Promise<unknown>;
};

export type BinderReceiptIssuancePreflight = {
  status: 'available' | 'published';
  documentsRevision: number;
};

function fail(message: string): never {
  throw new Error(`Binder receipt issuance: ${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validateReservation<T extends BinderReceiptIssuanceReservation>(input: T, requireMint: boolean): T {
  if (!record(input) || input.issuanceId !== BINDER_RECEIPT_ISSUANCE_ID ||
    !positiveInteger(input.deliveryId) || input.deliveryId > 0x7fff_ffff ||
    input.receiptOwner !== BINDER_RECEIPT_ISSUANCE_OWNER || !positiveInteger(input.createdAtMs) ||
    !Array.isArray(input.receipts) || input.receipts.length !== 2) fail('invalid operation identity.');
  const receipts = [...input.receipts].sort((a, b) => a.receiptId - b.receiptId);
  if (receipts[0].receiptId !== 21 || receipts[1].receiptId !== 22) fail('only receipts 21 and 22 are authorized.');
  for (const receipt of receipts) {
    if (requireStripeReceiptClaimCode(receipt.code) !== receipt.code) fail('claim codes must be canonical.');
    if ((requireMint || receipt.assetId !== undefined) && !isBase58Bytes(receipt.assetId, 32)) fail('invalid receipt asset.');
    if ((requireMint || receipt.signature !== undefined) && !isBase58Bytes(receipt.signature, 64)) fail('invalid mint signature.');
  }
  if (new Set(receipts.map((receipt) => receipt.code)).size !== 2 ||
    (receipts.every((receipt) => receipt.assetId) && new Set(receipts.map((receipt) => receipt.assetId)).size !== 2)) {
    fail('duplicate claim code or receipt asset.');
  }
  timestampFromMilliseconds(input.createdAtMs);
  return { ...input, receipts };
}

function orderPath(input: BinderReceiptIssuanceReservation): string {
  return `drops/${BINDER_RECEIPT_ISSUANCE_DROP}/deliveryOrders/${input.deliveryId}`;
}

function documentPaths(input: BinderReceiptIssuanceReservation): string[] {
  return [orderPath(input), ...input.receipts.map((receipt) => `claimCodes/${receipt.code}`)];
}

export function buildBinderReceiptIssuanceDocuments(rawInput: BinderReceiptIssuancePlan): PublicationDocument[] {
  const input = validateReservation(rawInput, true);
  const claims = input.receipts.map((receipt) => ({
    namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
    code: receipt.code,
    boxId: receipt.receiptId,
    status: 'unclaimed',
  }));
  const order: AdminReceiptIssuanceDeliveryOrderCreate = {
    dropId: BINDER_RECEIPT_ISSUANCE_DROP,
    source: SOURCE,
    status: 'ready_to_ship',
    owner: input.receiptOwner,
    receiptOwner: input.receiptOwner,
    addressSnapshot: { label: REASON, country: REASON },
    itemIds: input.receipts.map((receipt) => receipt.assetId),
    items: input.receipts.map((receipt) => ({ kind: 'box', refId: receipt.receiptId, assetId: receipt.assetId })),
    deliveryId: input.deliveryId,
    quantity: 2,
    metadataIds: input.receipts.map((receipt) => receipt.receiptId),
    receiptsMinted: 2,
    receiptTxs: [...new Set(input.receipts.map((receipt) => receipt.signature))],
    stripeReceiptClaimsByBoxId: buildStripeReceiptClaimsByBoxId(claims),
    adminReceiptIssuance: { issuanceId: input.issuanceId, reason: REASON },
    createdAt: commerceFieldValue.serverTimestamp(),
    processedAt: commerceFieldValue.serverTimestamp(),
  };
  const now = timestampFromMilliseconds(input.createdAtMs);
  const materialized = materializeDocument(order, now);
  return [
    { path: orderPath(input), kind: 'delivery_order', dropId: BINDER_RECEIPT_ISSUANCE_DROP,
      documentId: String(input.deliveryId), data: materialized.data, processedAt: materialized.processedAt },
    ...input.receipts.map((receipt): PublicationDocument => ({
      path: `claimCodes/${receipt.code}`, kind: 'claim_code', dropId: null, documentId: receipt.code, processedAt: null,
      data: {
        version: 1, namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE, source: SOURCE, code: receipt.code,
        dropId: BINDER_RECEIPT_ISSUANCE_DROP, deliveryId: input.deliveryId, owner: input.receiptOwner,
        receiptOwner: input.receiptOwner, boxId: receipt.receiptId, boxAssetId: receipt.assetId,
        status: 'unclaimed', issuanceId: input.issuanceId,
        createdAt: input.createdAtMs, updatedAt: input.createdAtMs,
      },
    })),
  ];
}

function parseJsonArray(value: unknown, label: string): unknown[] {
  if (typeof value !== 'string') return fail(`invalid ${label} response.`);
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { return fail(`invalid ${label} response.`); }
  if (!Array.isArray(decoded)) return fail(`invalid ${label} response.`);
  return decoded;
}

function immutablePublicationMatches(input: BinderReceiptIssuanceReservation, documents: Map<string, Record<string, unknown>>): void {
  const order = documents.get(orderPath(input));
  const issuance = order?.adminReceiptIssuance;
  if (!order || order.dropId !== BINDER_RECEIPT_ISSUANCE_DROP || order.source !== SOURCE ||
    order.deliveryId !== input.deliveryId || order.owner !== input.receiptOwner || order.receiptOwner !== input.receiptOwner ||
    !record(issuance) || issuance.issuanceId !== input.issuanceId || order.quantity !== 2 ||
    order.receiptsMinted !== 2 || order.createdAt !== input.createdAtMs || !Array.isArray(order.items) || order.items.length !== 2 ||
    !record(order.stripeReceiptClaimsByBoxId) || Object.keys(order.stripeReceiptClaimsByBoxId).length !== 2) {
    fail('existing delivery order does not match this operation.');
  }
  for (const receipt of input.receipts) {
    const claim = documents.get(`claimCodes/${receipt.code}`);
    const mapping = order.stripeReceiptClaimsByBoxId[`box_${receipt.receiptId}`];
    const item = order.items.find((value) => record(value) && value.kind === 'box' && value.refId === receipt.receiptId);
    if (!claim || claim.namespace !== STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE || claim.source !== SOURCE ||
      claim.code !== receipt.code || claim.boxId !== receipt.receiptId || claim.dropId !== BINDER_RECEIPT_ISSUANCE_DROP ||
      claim.deliveryId !== input.deliveryId || claim.owner !== input.receiptOwner || claim.receiptOwner !== input.receiptOwner ||
      claim.issuanceId !== input.issuanceId || claim.createdAt !== input.createdAtMs || !isBase58Bytes(claim.boxAssetId, 32) ||
      (receipt.assetId !== undefined && claim.boxAssetId !== receipt.assetId) ||
      !record(mapping) || mapping.namespace !== STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE || mapping.code !== receipt.code ||
      mapping.boxId !== receipt.receiptId || !record(item) || item.assetId !== claim.boxAssetId ||
      (receipt.signature !== undefined && (!Array.isArray(order.receiptTxs) || !order.receiptTxs.includes(receipt.signature)))) {
      fail('existing receipt claim does not match this operation.');
    }
  }
}

export async function preflightBinderReceiptIssuance(
  rawInput: BinderReceiptIssuanceReservation,
  dependencies: Partial<Pick<Dependencies, 'query'>> = {},
): Promise<BinderReceiptIssuancePreflight> {
  const input = validateReservation(rawInput, false);
  const paths = documentPaths(input);
  const pathsSql = paths.map(sqlString).join(', ');
  const query = dependencies.query ?? queryRemoteCommerceD1;
  let rows: Record<string, unknown>[];
  try {
    rows = await query(`SELECT authority.authority_state, authority.documents_revision,
      (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) AS recovery_mode,
      (SELECT COUNT(*) FROM commerce_commit_guards) AS active_guards,
      (SELECT COUNT(*) FROM commerce_authority_control_lease) AS maintenance_leases,
      (SELECT json_group_array(json_object('document_path', document_path, 'document_kind', document_kind,
        'drop_id', drop_id, 'document_id', document_id, 'document_json', document_json, 'version', version,
        'create_time', create_time, 'update_time', update_time,
        'processed_at_seconds', processed_at_seconds, 'processed_at_nanos', processed_at_nanos))
        FROM commerce_documents WHERE (document_kind = 'delivery_order' AND drop_id = ${sqlString(BINDER_RECEIPT_ISSUANCE_DROP)})
          OR (document_kind = 'claim_code' AND json_extract(document_json, '$.dropId') = ${sqlString(BINDER_RECEIPT_ISSUANCE_DROP)})
          OR document_path IN (${pathsSql})) AS documents_json,
      (SELECT json_group_array(document_path) FROM commerce_document_path_revisions
        WHERE document_path IN (${pathsSql})) AS prior_paths_json,
      (SELECT json_group_array(json_object('parent_path', parent_path, 'generation', generation, 'revision', revision,
        'lease_id', lease_id, 'receipt_recovery_json', receipt_recovery_json, 'created_at_ms', created_at_ms,
        'updated_at_ms', updated_at_ms, 'prepared_delay_ms', prepared_delay_ms, 'prepared_explicit_at_ms', prepared_explicit_at_ms,
        'processing_retry_at_ms', processing_retry_at_ms, 'lease_expires_at_ms', lease_expires_at_ms))
        FROM commerce_delivery_recovery WHERE parent_path = ${sqlString(orderPath(input))}) AS recovery_json
      FROM commerce_authority_control AS authority WHERE authority.singleton = 1`);
  } catch { return fail('database preflight failed; no records were changed.'); }
  const state = rows[0];
  if (rows.length !== 1 || state.authority_state !== 'd1' || state.recovery_mode !== 'table' ||
    !Number.isSafeInteger(state.documents_revision) || Number(state.documents_revision) < 0 ||
    state.active_guards !== 0 || state.maintenance_leases !== 0) fail('commerce is not ready for publication.');
  const documents = new Map<string, Record<string, unknown>>();
  for (const candidate of parseJsonArray(state.documents_json, 'document')) {
    let document: ReturnType<typeof parseRow>;
    try { document = parseRow(candidate); } catch { return fail('invalid database document.'); }
    const documentPath = document.key.path;
    if (documents.has(documentPath)) fail('duplicate database document.');
    const data = document.data;
    if (!paths.includes(documentPath)) {
      const issuance = data.adminReceiptIssuance;
      const items = Array.isArray(data.items) ? data.items : [];
      const metadataIds = Array.isArray(data.metadataIds) ? data.metadataIds : [];
      if (data.issuanceId === input.issuanceId || (record(issuance) && issuance.issuanceId === input.issuanceId) ||
        input.receipts.some((receipt) => data.boxId === receipt.receiptId || data.metadataId === receipt.receiptId ||
          metadataIds.includes(receipt.receiptId) || items.some((item) => record(item) && item.kind === 'box' && item.refId === receipt.receiptId))) {
        fail('the new receipt IDs are already referenced by another order or claim.');
      }
    } else {
      const expectedKind = documentPath === orderPath(input) ? 'delivery_order' : 'claim_code';
      if (document.key.kind !== expectedKind) fail('reserved document path has an incompatible record.');
      documents.set(documentPath, data);
    }
  }
  const priorPaths = parseJsonArray(state.prior_paths_json, 'path revision');
  const recovery = parseJsonArray(state.recovery_json, 'recovery');
  if (documents.size === 0) {
    if (priorPaths.length || recovery.length) fail('reserved paths have previous database history.');
    return { status: 'available', documentsRevision: Number(state.documents_revision) };
  }
  if (documents.size !== 3) fail('publication is incomplete; refusing to change existing records.');
  immutablePublicationMatches(input, documents);
  if (priorPaths.length !== 3 || recovery.length !== 1) fail('published order is missing its recovery state.');
  try {
    if (parseDeliveryRecoveryRow(recovery[0]).parentPath !== orderPath(input)) fail('invalid published recovery identity.');
  } catch { return fail('published order has invalid recovery state.'); }
  return { status: 'published', documentsRevision: Number(state.documents_revision) };
}

function sqlValue(value: string | number | null): string {
  return value === null ? 'NULL' : typeof value === 'number' ? String(value) : sqlString(value);
}

function buildBinderReceiptIssuanceSql(input: BinderReceiptIssuancePlan, documentsRevision: number): string {
  if (!Number.isSafeInteger(documentsRevision) || documentsRevision < 0) fail('invalid database revision.');
  const documents = buildBinderReceiptIssuanceDocuments(input);
  const guardId = randomUUID();
  const timestamp = timestampString(timestampFromMilliseconds(input.createdAtMs));
  const recovery = deliveryRecoveryRow(createDeliveryRecoveryRecord({
    parentPath: orderPath(input), receiptRecoveryJson: null, nowMs: input.createdAtMs, generation: randomUUID(),
  }));
  const recoveryColumns = Object.keys(recovery);
  return [
    `INSERT INTO commerce_commit_guards (guard_id, expectations_json, delivery_owner_expectations_json,
      expected_documents_revision, created_at_ms, notification_outbox_expectations_json, stripe_checkout_paths_json,
      delivery_recovery_expectations_json, delivery_recovery_paths_json)
      VALUES (${sqlString(guardId)}, ${sqlString(JSON.stringify(documents.map((document) => ({ path: document.path, version: -1, pathRevision: 0 }))))},
      '[]', ${documentsRevision}, ${input.createdAtMs}, '[]', '[]',
      ${sqlString(JSON.stringify([{ parentPath: orderPath(input), generation: null, revision: -1 }]))},
      ${sqlString(JSON.stringify([orderPath(input)]))})`,
    `INSERT INTO commerce_documents (document_path, document_kind, drop_id, document_id, document_json,
      version, create_time, update_time, processed_at_seconds, processed_at_nanos) VALUES
      ${documents.map((document) => `(${[
        document.path, document.kind, document.dropId, document.documentId, JSON.stringify(document.data),
        1, timestamp, timestamp, document.processedAt?.seconds ?? null, document.processedAt?.nanos ?? null,
      ].map(sqlValue).join(', ')})`).join(',\n')}`,
    `INSERT INTO commerce_delivery_recovery (${recoveryColumns.join(', ')})
      VALUES (${recoveryColumns.map((column) => sqlValue(recovery[column])).join(', ')})`,
    `UPDATE commerce_authority_control SET documents_revision = documents_revision + 1,
      updated_at_ms = MAX(updated_at_ms, ${input.createdAtMs}) WHERE singleton = 1`,
    `DELETE FROM commerce_commit_guards WHERE guard_id = ${sqlString(guardId)}`,
  ].join(';\n') + ';\n';
}

export async function publishBinderReceiptIssuance(
  input: BinderReceiptIssuancePlan,
  dependencies: Partial<Dependencies> = {},
): Promise<{ status: 'published' | 'already_published'; deliveryId: number }> {
  validateReservation(input, true);
  const query = dependencies.query ?? queryRemoteCommerceD1;
  const current = await preflightBinderReceiptIssuance(input, { query });
  if (current.status === 'published') return { status: 'already_published', deliveryId: input.deliveryId };
  const sql = buildBinderReceiptIssuanceSql(input, current.documentsRevision);
  const directory = mkdtempSync(path.join(tmpdir(), 'binder-receipt-issuance-'));
  chmodSync(directory, 0o700);
  const filePath = path.join(directory, 'publication.sql');
  try {
    writeFileSync(filePath, sql, { mode: 0o600, flag: 'wx' });
    const executeFile = dependencies.executeFile ?? createD1MaintenanceRunner('commerce').executeFile;
    try {
      await executeFile(filePath);
    } catch {
      const recovered = await preflightBinderReceiptIssuance(input, { query });
      if (recovered.status === 'published') return { status: 'published', deliveryId: input.deliveryId };
      return fail('database publication did not complete. Retry with the same issuance journal.');
    }
    const verified = await preflightBinderReceiptIssuance(input, { query });
    if (verified.status !== 'published') fail('database publication could not be verified. Retry with the same issuance journal.');
    return { status: 'published', deliveryId: input.deliveryId };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
