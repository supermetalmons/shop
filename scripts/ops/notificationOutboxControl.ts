import { pathToFileURL } from 'node:url';
import { parseNotificationOutboxRow } from '../../shared/notificationOutbox.ts';
import { COMMERCE_D1_NOW_MS_SQL, queryRemoteCommerceD1, type CommerceAuthorityQuery } from '../shared/commerceD1Maintenance.ts';
import { commerceD1AuditRowsAsync } from '../shared/commerceD1Audit.ts';
import { commerceInspectionValidation, parseCommerceStatusArgs, readCommerceStorageState, type CommerceInspectionCommand } from '../shared/commerceStateControl.ts';

type Dependencies = { query: CommerceAuthorityQuery };
export function parseNotificationOutboxControlArgs(argv: string[]) {
  return parseCommerceStatusArgs(argv, 'notification-outbox-control');
}
async function summary(query: CommerceAuthorityQuery, command: CommerceInspectionCommand) {
  const current = await readCommerceStorageState(query, 'commerce_notification_outbox_control');
  let validationError: string | null = null;
  try {
    if (current.mode !== 'table') throw new Error('Storage is not initialized. See scripts/docs/commerce_operations.md.');
    if (command !== 'summary') {
      for await (const row of commerceD1AuditRowsAsync(query, {
        table: 'commerce_notification_outbox', alias: 'outbox', keys: ['parent_path', 'family'], pageSize: 25,
        columns: 'outbox.*, document.document_kind AS parent_kind, document.drop_id AS parent_drop_id',
        joins: 'LEFT JOIN commerce_documents AS document ON document.document_path = outbox.parent_path',
      })) {
        const record = parseNotificationOutboxRow(row);
        if (row.parent_drop_id !== record.dropId || row.parent_kind !==
          (record.family === 'stripe_terminal' ? 'stripe_checkout' : 'delivery_order')) {
          throw new Error(`Notification outbox parent identity is invalid: ${record.parentPath}.`);
        }
      }
    }
  } catch (error) { validationError = error instanceof Error ? error.message : 'Invalid notification outbox.'; }
  const groups = await query(`SELECT family, state, COUNT(*) AS count,
      MIN(CASE WHEN state = 'pending' THEN created_at_ms END) AS oldest_pending_at_ms,
      MAX(CASE WHEN state = 'pending' THEN MAX(0, ${COMMERCE_D1_NOW_MS_SQL} - created_at_ms) END) AS oldest_pending_age_ms,
      SUM(CASE WHEN state = 'pending' AND claim_id IS NOT NULL AND claim_expires_at_ms <= ${COMMERCE_D1_NOW_MS_SQL} THEN 1 ELSE 0 END) AS expired_claims
    FROM commerce_notification_outbox GROUP BY family, state ORDER BY family, state`);
  const failures = await query(`SELECT family, last_error_code, COUNT(*) AS count FROM commerce_notification_outbox
    WHERE state = 'failed' OR last_error_code IS NOT NULL GROUP BY family, last_error_code ORDER BY family, last_error_code`);
  return { ...current, ...commerceInspectionValidation(command, validationError), validationError, groups, failures };
}

export async function runNotificationOutboxControl(argv: string[], overrides: Partial<Dependencies> = {}) {
  const { command } = parseNotificationOutboxControlArgs(argv);
  return summary(overrides.query ?? queryRemoteCommerceD1, command);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runNotificationOutboxControl(process.argv.slice(2)), null, 2));
}
