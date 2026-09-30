import {
  DELIVERY_RECOVERY_FIELD_COLUMNS,
  deliveryRecoveryRow,
  parseDeliveryRecoveryRow,
  type DeliveryRecoveryRecord,
} from '../../../../shared/deliveryRecoveryState.js';
import { parseRow, publicRecord, type StoredDocument } from './commerceDocumentCodec.js';
import type { CommerceDocumentData, CommerceDocumentRecord } from './commerceRepositoryTypes.js';
import { unavailableCommerce, unavailableCommerceData } from './commerceRepositorySupport.js';

export type RecoverySnapshot = Readonly<{
  order: CommerceDocumentRecord<CommerceDocumentData, 'delivery_order'>;
  state: DeliveryRecoveryRecord;
  pathRevision: number;
}>;

const RECOVERY_METADATA_COLUMNS = Object.values(DELIVERY_RECOVERY_FIELD_COLUMNS)
  .filter((column) => column !== 'receipt_recovery_json');

export function recoverySnapshotColumns(alias: string): string {
  return `(SELECT json_object(${RECOVERY_METADATA_COLUMNS.map((name) => `'${name}', recovery.${name}`).join(', ')})
    FROM commerce_delivery_recovery AS recovery WHERE recovery.parent_path = ${alias}.document_path) AS recovery_state_json,
    (SELECT receipt_recovery_json FROM commerce_delivery_recovery WHERE parent_path = ${alias}.document_path) AS recovery_payload_json,
    COALESCE((SELECT revision FROM commerce_document_path_revisions
      WHERE document_path = ${alias}.document_path), 0) AS recovery_path_revision`;
}

export function deliveryRecoveryAuthorityStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT authority_state, revision, documents_revision,
    (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) AS recovery_mode
    FROM commerce_authority_control WHERE singleton = 1`);
}

export function requireDeliveryRecoveryAuthority(result: D1Result<Record<string, unknown>>): void {
  if (!result.success || result.results.length !== 1 || result.results[0].authority_state !== 'd1' ||
    result.results[0].recovery_mode !== 'table') throw unavailableCommerce();
}

export function recoverySnapshot(document: StoredDocument, state: DeliveryRecoveryRecord, pathRevision: number): RecoverySnapshot {
  if (document.key.kind !== 'delivery_order' || state.parentPath !== document.key.path ||
    !Number.isSafeInteger(pathRevision) || pathRevision < 0) throw unavailableCommerceData();
  const record = publicRecord(document);
  const data = { ...record.data };
  delete data.receiptRecovery;
  if (state.receiptRecoveryJson !== null) data.receiptRecovery = JSON.parse(state.receiptRecoveryJson);
  return {
    order: { ...record, key: { ...record.key, kind: 'delivery_order' }, data },
    state: { ...state },
    pathRevision,
  };
}

export function parseRecoverySnapshot(row: Record<string, unknown>): RecoverySnapshot {
  try {
    if (typeof row.recovery_state_json !== 'string' || typeof row.recovery_path_revision !== 'number') {
      throw unavailableCommerceData();
    }
    return recoverySnapshot(parseRow(row), parseRecoveryState(row), row.recovery_path_revision);
  } catch {
    throw unavailableCommerceData();
  }
}

export function parseRecoveryState(row: Record<string, unknown>): DeliveryRecoveryRecord {
  try {
    if (typeof row.recovery_state_json !== 'string') throw unavailableCommerceData();
    return parseDeliveryRecoveryRow({
      ...JSON.parse(row.recovery_state_json),
      receipt_recovery_json: row.recovery_payload_json,
    });
  } catch {
    throw unavailableCommerceData();
  }
}

export function deliveryRecoveryWriteStatement(db: D1Database, record: DeliveryRecoveryRecord, create: boolean): D1PreparedStatement {
  const row = deliveryRecoveryRow(record);
  const columns = Object.keys(row);
  if (create) return db.prepare(`INSERT INTO commerce_delivery_recovery (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})`).bind(...columns.map((column) => row[column]));
  const updates = columns.filter((column) => column !== 'parent_path' && column !== 'generation' && column !== 'created_at_ms');
  return db.prepare(`UPDATE commerce_delivery_recovery SET ${updates.map((column) => `${column} = ?`).join(', ')}
    WHERE parent_path = ? AND generation = ? AND revision = ?`)
    .bind(...updates.map((column) => row[column]), record.parentPath, record.generation, record.revision - 1);
}
