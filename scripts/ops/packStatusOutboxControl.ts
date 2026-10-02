import { pathToFileURL } from 'node:url';
import { parsePackStatusOutboxRow } from '../../shared/packStatusOutbox.ts';
import { queryRemoteCommerceD1, sqlString, type CommerceAuthorityQuery } from '../shared/commerceD1Maintenance.ts';
import { parseCommerceStatusArgs, readCommerceStorageState } from '../shared/commerceStateControl.ts';
import { LEGACY_PACK_STATUS_PROJECTION_FIELDS } from '../shared/packStatusProjectionFields.ts';

function legacyProjectionPredicate(column: string): string {
  return LEGACY_PACK_STATUS_PROJECTION_FIELDS.map((field) => `json_type(${column}, '$.${field}') IS NOT NULL`).join(' OR ');
}

type Dependencies = { query: CommerceAuthorityQuery };
const PAGE_SIZE = 25;
export function parsePackStatusOutboxControlArgs(argv: string[]) {
  return parseCommerceStatusArgs(argv, 'pack-status-outbox-control');
}
async function verifyState(query: CommerceAuthorityQuery): Promise<number> {
  let cursor = '';
  let count = 0;
  for (;;) {
    const rows = await query(`SELECT outbox.*, document.document_kind AS parent_kind, document.drop_id AS parent_drop_id
      FROM commerce_pack_status_outbox AS outbox LEFT JOIN commerce_documents AS document
        ON document.document_path = outbox.parent_path
      WHERE outbox.parent_path > ${sqlString(cursor)} ORDER BY outbox.parent_path LIMIT ${PAGE_SIZE}`);
    for (const row of rows) {
      const actual = parsePackStatusOutboxRow(row);
      if (row.parent_kind !== 'delivery_order' || actual.dropId !== row.parent_drop_id) {
        throw new Error(`Pack-status outbox parent is invalid: ${actual.parentPath}.`);
      }
    }
    count += rows.length;
    if (rows.length < PAGE_SIZE) {
      const missing = await query(`SELECT document.document_path FROM commerce_documents AS document
        LEFT JOIN commerce_pack_status_outbox AS outbox ON outbox.parent_path = document.document_path
        WHERE document.document_kind = 'delivery_order' AND outbox.parent_path IS NULL
          AND (${legacyProjectionPredicate('document.document_json')}) LIMIT 1`);
      if (missing.length) throw new Error(`Pack-status outbox is missing: ${String(missing[0].document_path)}.`);
      return count;
    }
    cursor = String(rows.at(-1)!.parent_path);
  }
}
async function summary(query: CommerceAuthorityQuery) {
  const current = await readCommerceStorageState(query, 'commerce_pack_status_outbox_control');
  let projectionCount = 0;
  let validationError: string | null = null;
  try {
    if (current.mode !== 'table') throw new Error('Storage is not initialized. See scripts/docs/commerce_operations.md.');
    projectionCount = await verifyState(query); } catch (error) {
    validationError = error instanceof Error ? error.message : 'Invalid current state.';
  }
  const groups = await query(`SELECT state, COUNT(*) AS count,
      MIN(CASE WHEN state = 'pending' THEN created_at_ms END) AS oldest_pending_at_ms,
      MIN(next_attempt_at_ms) AS oldest_due_at_ms
    FROM commerce_pack_status_outbox GROUP BY state ORDER BY state`);
  const failures = await query(`SELECT state, last_error_code, COUNT(*) AS count FROM commerce_pack_status_outbox
    WHERE last_error_code IS NOT NULL GROUP BY state, last_error_code ORDER BY state, last_error_code`);
  return { ...current, projectionCount, validationError, groups, failures };
}

export async function runPackStatusOutboxControl(argv: string[], overrides: Partial<Dependencies> = {}) {
  parsePackStatusOutboxControlArgs(argv);
  return summary(overrides.query ?? queryRemoteCommerceD1);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runPackStatusOutboxControl(process.argv.slice(2)), null, 2));
}
