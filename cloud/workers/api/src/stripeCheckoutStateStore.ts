import {
  STRIPE_CHECKOUT_STATE_FIELD_COLUMNS,
  STRIPE_CHECKOUT_STATE_FIELDS,
  parseStripeCheckoutStateRow,
  stripeCheckoutStateFromDocument,
  stripeCheckoutStateMetadata,
  stripeCheckoutStateRow,
  type StripeCheckoutState,
} from '../../../../shared/stripeCheckoutState.js';
import { unavailableCommerceData } from './commerceRepositorySupport.js';
import { CommerceRepositoryError, type CommerceDocumentData, type CommerceUpdateValue } from './commerceRepositoryTypes.js';

const STATE_COLUMNS = ['document_path', 'document_version', ...Object.values(STRIPE_CHECKOUT_STATE_FIELD_COLUMNS)];

export function isStripeCheckoutStateOnlyUpdate(updates: Readonly<Record<string, CommerceUpdateValue>>): boolean {
  return Object.keys(updates).every((field) =>
    STRIPE_CHECKOUT_STATE_FIELDS.includes(field as typeof STRIPE_CHECKOUT_STATE_FIELDS[number]));
}

export function stripeCheckoutDocumentRawData(input: {
  documentPath: string;
  data: CommerceDocumentData;
  documentVersion: number;
  previousRawData?: CommerceDocumentData;
  reuseRawData?: 'unchanged' | 'if-equal';
}): CommerceDocumentData {
  try {
    stripeCheckoutStateFromDocument(input.documentPath, input.data, input.documentVersion);
  } catch {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe checkout state.');
  }
  if (input.reuseRawData === 'unchanged' && input.previousRawData) return input.previousRawData;
  const metadata = stripeCheckoutStateMetadata(input.data, input.previousRawData ?? {});
  if (input.reuseRawData === 'if-equal' && input.previousRawData &&
    JSON.stringify(metadata) === JSON.stringify(input.previousRawData)) return input.previousRawData;
  return metadata;
}

export function stripeCheckoutStateSelectColumns(documentAlias = 'commerce_documents'): string {
  return [
    `CASE WHEN ${documentAlias}.document_kind = 'stripe_checkout' THEN (
      SELECT json_object(${STATE_COLUMNS.map((column) => `'${column}', checkout_state.${column}`).join(', ')})
      FROM commerce_stripe_checkout_state AS checkout_state
      WHERE checkout_state.document_path = ${documentAlias}.document_path
    ) END AS checkout_state_json`,
    "(SELECT storage_mode FROM commerce_stripe_checkout_state_control WHERE singleton = 1) AS checkout_state_mode",
  ].join(', ');
}

export function stripeCheckoutStateFromJoinedRow(row: Record<string, unknown>, documentPath: string, version: number): StripeCheckoutState {
  if (row.checkout_state_mode !== 'table') throw unavailableCommerceData();
  let state: StripeCheckoutState;
  try {
    if (typeof row.checkout_state_json !== 'string') throw new Error('Missing checkout state.');
    state = parseStripeCheckoutStateRow(JSON.parse(row.checkout_state_json));
  } catch {
    throw unavailableCommerceData();
  }
  if (state.documentPath !== documentPath || state.documentVersion !== version) throw unavailableCommerceData();
  return state;
}

export function stripeCheckoutStateWriteStatement(db: D1Database, state: StripeCheckoutState): D1PreparedStatement {
  const row = stripeCheckoutStateRow(state);
  return db.prepare(`INSERT INTO commerce_stripe_checkout_state (${STATE_COLUMNS.join(', ')})
    VALUES (${STATE_COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT(document_path) DO UPDATE SET ${STATE_COLUMNS.filter((column) => column !== 'document_path')
      .map((column) => `${column} = excluded.${column}`).join(', ')}`)
    .bind(...STATE_COLUMNS.map((column) => row[column]));
}
