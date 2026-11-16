import { pathToFileURL } from 'node:url';
import { parseDeliveryRecoveryRow } from '../../shared/deliveryRecoveryState.ts';
import { COMMERCE_D1_NOW_MS_SQL, parseCommerceD1DocumentRow, queryRemoteCommerceD1, safeInteger,
  type CommerceAuthorityQuery } from '../shared/commerceD1Maintenance.ts';
import { commerceD1AuditRowsAsync } from '../shared/commerceD1Audit.ts';
import { commerceInspectionValidation, parseCommerceStatusArgs, readCommerceInspectionCount, readCommerceStorageState, type CommerceInspectionCommand } from '../shared/commerceStateControl.ts';

type Dependencies = { query: CommerceAuthorityQuery };
export function parseDeliveryRecoveryStateControlArgs(argv: string[]) {
  return parseCommerceStatusArgs(argv, 'delivery-recovery-state-control');
}
async function verifyState(query: CommerceAuthorityQuery): Promise<number> {
  let count = 0;
  for await (const row of commerceD1AuditRowsAsync(query, {
    table: 'commerce_documents', alias: 'document', keys: ['document_path'], pageSize: 5,
    columns: `document.document_path, document.document_kind, document.drop_id,
        document.document_id, json_remove(document.document_json, '$.receiptRecovery') AS document_json,
        document.version, document.create_time, document.update_time,
        recovery.*`,
    joins: 'LEFT JOIN commerce_delivery_recovery AS recovery ON recovery.parent_path = document.document_path',
    where: "document.document_kind = 'delivery_order'",
  })) {
    const document = parseCommerceD1DocumentRow(row);
    const state = row.parent_path === null ? null : parseDeliveryRecoveryRow(row);
    if (state && state.parentPath !== document.path) throw new Error(`Delivery recovery state parent is invalid: ${document.path}.`);
    if (!state) throw new Error(`Delivery recovery state is missing: ${document.path}.`);
    count += 1;
  }
  const invalid = await query(`SELECT COUNT(*) AS count FROM commerce_delivery_recovery AS recovery
    LEFT JOIN commerce_documents AS document ON document.document_path = recovery.parent_path
    WHERE document.document_kind IS NOT 'delivery_order'`);
  if (invalid.length !== 1 || safeInteger(invalid[0].count, 'Invalid delivery recovery count') !== 0) {
    throw new Error('Delivery recovery state has unexpected records; keep Commerce paused.');
  }
  return count;
}

async function summary(query: CommerceAuthorityQuery, command: CommerceInspectionCommand) {
  const current = await readCommerceStorageState(query, 'commerce_delivery_recovery_control');
  let deliveryCount = 0;
  let validationError: string | null = null;
  try {
    if (current.mode !== 'table') throw new Error('Storage is not initialized. See scripts/docs/commerce_operations.md.');
    deliveryCount = command === 'summary'
      ? await readCommerceInspectionCount(query, "SELECT COUNT(*) AS count FROM commerce_documents WHERE document_kind = 'delivery_order'")
      : await verifyState(query);
  } catch (error) {
    validationError = error instanceof Error ? error.message : 'Invalid delivery recovery state.';
  }
  const groups = await query(`SELECT document.status, COUNT(*) AS count,
      MIN(recovery.processing_retry_at_ms) AS oldest_retry_at_ms,
      SUM(CASE WHEN recovery.lease_expires_at_ms <= ${COMMERCE_D1_NOW_MS_SQL} THEN 1 ELSE 0 END) AS expired_leases,
      SUM(CASE WHEN recovery.lease_expires_at_ms > ${COMMERCE_D1_NOW_MS_SQL} THEN 1 ELSE 0 END) AS active_leases
    FROM commerce_delivery_recovery AS recovery
    JOIN commerce_documents AS document ON document.document_path = recovery.parent_path
    GROUP BY document.status ORDER BY document.status`);
  const legacyMetadata = await query(`SELECT COUNT(*) AS count FROM commerce_documents
    WHERE document_kind = 'delivery_order' AND json_type(document_json, '$.receiptRecovery') IS NOT NULL`);
  if (legacyMetadata.length !== 1) throw new Error('Invalid legacy delivery recovery metadata count.');
  const legacyMetadataCount = safeInteger(legacyMetadata[0].count, 'Legacy delivery recovery metadata count');
  return { ...current, ...commerceInspectionValidation(command, validationError), deliveryCount, legacyMetadataCount, validationError, groups };
}

export async function runDeliveryRecoveryStateControl(argv: string[], overrides: Partial<Dependencies> = {}) {
  const { command } = parseDeliveryRecoveryStateControlArgs(argv);
  return summary(overrides.query ?? queryRemoteCommerceD1, command);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runDeliveryRecoveryStateControl(process.argv.slice(2)), null, 2));
}
