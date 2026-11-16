import { safeInteger, type CommerceAuthorityQuery } from './commerceD1Maintenance.ts';

export const COMMERCE_STORAGE_CONTROLS = [
  'commerce_notification_outbox_control',
  'commerce_stripe_checkout_state_control',
  'commerce_pack_status_outbox_control',
  'commerce_delivery_recovery_control',
] as const;
export type CommerceStorageControl = (typeof COMMERCE_STORAGE_CONTROLS)[number];

export type CommerceInspectionCommand = 'status' | 'summary' | 'validate';

export function parseCommerceStatusArgs(argv: string[], command: string): { command: CommerceInspectionCommand } {
  if (argv.length !== 1 || !['status', 'summary', 'validate'].includes(argv[0])) {
    throw new Error(`Usage: npm run ${command} -- <status|summary|validate>. Status is read-only; initialize an empty database with bootstrap:commerce.`);
  }
  return { command: argv[0] as CommerceInspectionCommand };
}

export function commerceInspectionValidation(command: CommerceInspectionCommand, error: string | null) {
  return command === 'status' ? {} : {
    validation: command === 'summary' ? 'not_run' as const : error ? 'failed' as const : 'passed' as const,
  };
}

export async function readCommerceInspectionCount(query: CommerceAuthorityQuery, sql: string): Promise<number> {
  const rows = await query(sql);
  if (rows.length !== 1) throw new Error('Invalid Commerce inspection count.');
  return safeInteger(rows[0].count, 'Commerce inspection count');
}

export async function readCommerceStorageState(query: CommerceAuthorityQuery, table: CommerceStorageControl) {
  const rows = await query(`SELECT authority.authority_state, authority.paused_at_ms, authority.revision,
      authority.documents_revision, state.storage_mode, state.preparation_state,
      state.source_documents_revision, state.prepared_at_ms
    FROM commerce_authority_control AS authority JOIN ${table} AS state ON state.singleton = authority.singleton
    WHERE authority.singleton = 1`);
  const row = rows[0];
  if (rows.length !== 1 || !['legacy', 'table'].includes(String(row.storage_mode)) ||
    !['idle', 'preparing', 'ready'].includes(String(row.preparation_state)) ||
    !['d1', 'paused'].includes(String(row.authority_state)) ||
    (row.storage_mode === 'table' && row.preparation_state !== 'ready') ||
    (row.preparation_state === 'ready' && (row.source_documents_revision === null || row.prepared_at_ms === null))) {
    throw new Error(`${table} control is invalid.`);
  }
  return {
    mode: row.storage_mode as 'legacy' | 'table', preparation: row.preparation_state as 'idle' | 'preparing' | 'ready',
    paused: row.authority_state === 'paused' && row.paused_at_ms !== null,
    revision: safeInteger(row.revision, 'Authority revision'), documentsRevision: safeInteger(row.documents_revision, 'Documents revision'),
    sourceDocumentsRevision: row.source_documents_revision === null ? null : safeInteger(row.source_documents_revision, 'State source revision'),
    preparedAtMs: row.prepared_at_ms === null ? null : safeInteger(row.prepared_at_ms, 'State preparation timestamp'),
  };
}
