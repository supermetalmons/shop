import { pathToFileURL } from 'node:url';
import { parseStripeCheckoutStateRow } from '../../shared/stripeCheckoutState.ts';
import { COMMERCE_D1_NOW_MS_SQL, queryRemoteCommerceD1, safeInteger, type CommerceAuthorityQuery } from '../shared/commerceD1Maintenance.ts';
import { commerceD1AuditRowsAsync } from '../shared/commerceD1Audit.ts';
import { commerceInspectionValidation, parseCommerceStatusArgs, readCommerceInspectionCount, readCommerceStorageState, type CommerceInspectionCommand } from '../shared/commerceStateControl.ts';

type Dependencies = { query: CommerceAuthorityQuery };
export function parseStripeCheckoutStateControlArgs(argv: string[]) {
  return parseCommerceStatusArgs(argv, 'stripe-checkout-state-control');
}
async function verifyState(query: CommerceAuthorityQuery): Promise<number> {
  let count = 0;
  for await (const row of commerceD1AuditRowsAsync(query, {
    table: 'commerce_documents', alias: 'document', keys: ['document_path'], rowKeys: ['parent_path'], pageSize: 25,
    columns: 'checkout.*, document.document_path AS parent_path, document.version AS parent_version',
    joins: 'LEFT JOIN commerce_stripe_checkout_state AS checkout ON checkout.document_path = document.document_path',
    where: "document.document_kind = 'stripe_checkout'",
  })) {
    const actual = parseStripeCheckoutStateRow(row);
    if (actual.documentPath !== row.parent_path || actual.documentVersion !== row.parent_version) {
      throw new Error(`Stripe checkout state differs from source: ${String(row.parent_path)}.`);
    }
    count += 1;
  }
  const invalid = await query(`SELECT COUNT(*) AS count FROM commerce_stripe_checkout_state AS checkout
    LEFT JOIN commerce_documents AS document ON document.document_path = checkout.document_path
    WHERE document.document_kind IS NOT 'stripe_checkout'`);
  if (invalid.length !== 1 || safeInteger(invalid[0].count, 'Invalid checkout state count') !== 0) throw new Error('Stripe checkout state has unexpected records.');
  return count;
}
async function summary(query: CommerceAuthorityQuery, command: CommerceInspectionCommand) {
  const current = await readCommerceStorageState(query, 'commerce_stripe_checkout_state_control');
  let checkoutCount = 0;
  let validationError: string | null = null;
  try {
    if (current.mode !== 'table') throw new Error('Storage is not initialized. See scripts/docs/commerce_operations.md.');
    checkoutCount = command === 'summary'
      ? await readCommerceInspectionCount(query, "SELECT COUNT(*) AS count FROM commerce_documents WHERE document_kind = 'stripe_checkout'")
      : await verifyState(query);
  } catch (error) {
    validationError = error instanceof Error ? error.message : 'Invalid current state.';
  }
  const groups = await query(`SELECT status, COUNT(*) AS count,
      MIN(CASE WHEN status IN ('fulfillment_pending', 'processing') THEN updated_at_ms END) AS oldest_pending_at_ms,
      SUM(CASE WHEN status = 'processing' AND processing_lease_expires_at_ms <= ${COMMERCE_D1_NOW_MS_SQL} THEN 1 ELSE 0 END) AS expired_claims
    FROM commerce_stripe_checkout_state GROUP BY status ORDER BY status`);
  return { ...current, ...commerceInspectionValidation(command, validationError), checkoutCount, validationError, groups };
}

export async function runStripeCheckoutStateControl(argv: string[], overrides: Partial<Dependencies> = {}) {
  const { command } = parseStripeCheckoutStateControlArgs(argv);
  return summary(overrides.query ?? queryRemoteCommerceD1, command);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runStripeCheckoutStateControl(process.argv.slice(2)), null, 2));
}
