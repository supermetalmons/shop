import { pathToFileURL } from 'node:url';
import { parseDeliveryRecoveryRow, type DeliveryRecoveryRecord } from '../../shared/deliveryRecoveryState.ts';
import { COMMERCE_D1_NOW_MS_SQL, parseCommerceD1DocumentRow, queryRemoteCommerceD1, safeInteger, sqlString,
  type CommerceAuthorityQuery, type CommerceD1Document } from '../shared/commerceD1Maintenance.ts';
import { parseCommerceStatusArgs, readCommerceStorageState } from '../shared/commerceStateControl.ts';

type Dependencies = { query: CommerceAuthorityQuery };
const PAGE_SIZE = 5;
type SourceDocument = { document: CommerceD1Document; state: DeliveryRecoveryRecord | null };
export function parseDeliveryRecoveryStateControlArgs(argv: string[]) {
  return parseCommerceStatusArgs(argv, 'delivery-recovery-state-control');
}
async function eachPage(query: CommerceAuthorityQuery, visit: (sources: SourceDocument[]) => Promise<void>): Promise<void> {
  let cursor = '';
  for (;;) {
    const rows = await query(`SELECT document.document_path, document.document_kind, document.drop_id,
        document.document_id, json_remove(document.document_json, '$.receiptRecovery') AS document_json,
        document.version, document.create_time, document.update_time,
        recovery.*
      FROM commerce_documents AS document
      LEFT JOIN commerce_delivery_recovery AS recovery ON recovery.parent_path = document.document_path
      WHERE document.document_kind = 'delivery_order' AND document.document_path > ${sqlString(cursor)}
      ORDER BY document.document_path LIMIT ${PAGE_SIZE}`);
    const sources = rows.map((row) => {
      const document = parseCommerceD1DocumentRow(row);
      const state = row.parent_path === null ? null : parseDeliveryRecoveryRow(row);
      if (state && state.parentPath !== document.path) throw new Error(`Delivery recovery state parent is invalid: ${document.path}.`);
      return { document, state };
    });
    await visit(sources);
    if (rows.length < PAGE_SIZE) return;
    cursor = String(rows.at(-1)!.document_path);
  }
}

async function verifyState(query: CommerceAuthorityQuery): Promise<number> {
  let count = 0;
  await eachPage(query, async (sources) => {
    for (const { document, state: actual } of sources) {
      if (!actual) throw new Error(`Delivery recovery state is missing: ${document.path}.`);

    }
    count += sources.length;
  });
  const invalid = await query(`SELECT COUNT(*) AS count FROM commerce_delivery_recovery AS recovery
    LEFT JOIN commerce_documents AS document ON document.document_path = recovery.parent_path
    WHERE document.document_kind IS NOT 'delivery_order'`);
  if (invalid.length !== 1 || safeInteger(invalid[0].count, 'Invalid delivery recovery count') !== 0) {
    throw new Error('Delivery recovery state has unexpected records; keep Commerce paused.');
  }
  return count;
}

async function summary(query: CommerceAuthorityQuery) {
  const current = await readCommerceStorageState(query, 'commerce_delivery_recovery_control');
  let deliveryCount = 0;
  let validationError: string | null = null;
  try {
    if (current.mode !== 'table') throw new Error('Storage is not initialized. See scripts/docs/commerce_operations.md.');
    deliveryCount = await verifyState(query); } catch (error) {
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
  return { ...current, deliveryCount, legacyMetadataCount, validationError, groups };
}

export async function runDeliveryRecoveryStateControl(argv: string[], overrides: Partial<Dependencies> = {}) {
  parseDeliveryRecoveryStateControlArgs(argv);
  return summary(overrides.query ?? queryRemoteCommerceD1);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runDeliveryRecoveryStateControl(process.argv.slice(2)), null, 2));
}
