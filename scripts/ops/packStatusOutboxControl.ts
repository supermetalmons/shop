import { pathToFileURL } from 'node:url';
import { parsePackStatusOutboxRow } from '../../shared/packStatusOutbox.ts';
import { queryRemoteCommerceD1, type CommerceAuthorityQuery } from '../shared/commerceD1Maintenance.ts';
import { commerceD1AuditRowsAsync } from '../shared/commerceD1Audit.ts';
import { commerceInspectionValidation, parseCommerceStatusArgs, readCommerceInspectionCount, readCommerceStorageState, type CommerceInspectionCommand } from '../shared/commerceStateControl.ts';
import { LEGACY_PACK_STATUS_PROJECTION_FIELDS } from '../shared/packStatusProjectionFields.ts';

function legacyProjectionPredicate(column: string): string {
  return LEGACY_PACK_STATUS_PROJECTION_FIELDS.map((field) => `json_type(${column}, '$.${field}') IS NOT NULL`).join(' OR ');
}

type Dependencies = { query: CommerceAuthorityQuery };
export function parsePackStatusOutboxControlArgs(argv: string[]) {
  return parseCommerceStatusArgs(argv, 'pack-status-outbox-control');
}
async function verifyState(query: CommerceAuthorityQuery): Promise<number> {
  let count = 0;
  for await (const row of commerceD1AuditRowsAsync(query, {
    table: 'commerce_pack_status_outbox', alias: 'outbox', keys: ['parent_path'], pageSize: 25,
    columns: 'outbox.*, document.document_kind AS parent_kind, document.drop_id AS parent_drop_id',
    joins: 'LEFT JOIN commerce_documents AS document ON document.document_path = outbox.parent_path',
  })) {
    const actual = parsePackStatusOutboxRow(row);
    if (row.parent_kind !== 'delivery_order' || actual.dropId !== row.parent_drop_id) {
      throw new Error(`Pack-status outbox parent is invalid: ${actual.parentPath}.`);
    }
    count += 1;
  }
  const legacy = await query(`SELECT document_path FROM commerce_documents
    WHERE ${legacyProjectionPredicate('document_json')} LIMIT 1`);
  if (legacy.length) throw new Error(`Frozen pack-status metadata remains: ${String(legacy[0].document_path)}.`);
  return count;
}
async function summary(query: CommerceAuthorityQuery, command: CommerceInspectionCommand) {
  const current = await readCommerceStorageState(query, 'commerce_pack_status_outbox_control');
  let projectionCount = 0;
  let validationError: string | null = null;
  try {
    if (current.mode !== 'table') throw new Error('Storage is not initialized. See scripts/docs/commerce_operations.md.');
    projectionCount = command === 'summary'
      ? await readCommerceInspectionCount(query, 'SELECT COUNT(*) AS count FROM commerce_pack_status_outbox')
      : await verifyState(query);
  } catch (error) {
    validationError = error instanceof Error ? error.message : 'Invalid current state.';
  }
  const groups = await query(`SELECT state, COUNT(*) AS count,
      MIN(CASE WHEN state = 'pending' THEN created_at_ms END) AS oldest_pending_at_ms,
      MIN(next_attempt_at_ms) AS oldest_due_at_ms
    FROM commerce_pack_status_outbox GROUP BY state ORDER BY state`);
  const failures = await query(`SELECT state, last_error_code, COUNT(*) AS count FROM commerce_pack_status_outbox
    WHERE last_error_code IS NOT NULL GROUP BY state, last_error_code ORDER BY state, last_error_code`);
  return { ...current, ...commerceInspectionValidation(command, validationError), projectionCount, validationError, groups, failures };
}

export async function runPackStatusOutboxControl(argv: string[], overrides: Partial<Dependencies> = {}) {
  const { command } = parsePackStatusOutboxControlArgs(argv);
  return summary(overrides.query ?? queryRemoteCommerceD1, command);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runPackStatusOutboxControl(process.argv.slice(2)), null, 2));
}
