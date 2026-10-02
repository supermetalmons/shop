import { safeInteger, type CommerceAuthorityQuery } from './commerceD1Maintenance.ts';

export const COMMERCE_STORAGE_CONTROLS = [
  'commerce_notification_outbox_control',
  'commerce_stripe_checkout_state_control',
  'commerce_pack_status_outbox_control',
  'commerce_delivery_recovery_control',
] as const;
export type CommerceStorageControl = (typeof COMMERCE_STORAGE_CONTROLS)[number];

export function parseCommerceStatusArgs(argv: string[], command: string): { command: 'status' } {
  if (argv.length !== 1 || argv[0] !== 'status') {
    throw new Error(`Usage: npm run ${command} -- status. Status is read-only; initialize an empty database with bootstrap:commerce.`);
  }
  return { command: 'status' };
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
