import { pathToFileURL } from 'node:url';
import { commerceDocumentIdentity } from '../../cloud/workers/api/src/commerceDocumentStore.ts';
import {
  queryRemoteCommerceD1,
  safeInteger,
} from '../shared/commerceD1Maintenance.ts';

function fail(message: string): never {
  throw new Error(message);
}

function requireIndex(plan: Record<string, unknown>[], indexName: string): void {
  if (!plan.some((row) => String(row.detail || '').includes(indexName))) {
    fail(`Commerce D1 query plan does not use ${indexName}.`);
  }
}

export function checkCommerceD1(): Record<string, unknown> {
  const quick = queryRemoteCommerceD1('PRAGMA quick_check');
  if (quick.length !== 1 || quick[0].quick_check !== 'ok') fail('Commerce D1 quick check failed.');
  if (queryRemoteCommerceD1('PRAGMA foreign_key_check').length !== 0) fail('Commerce D1 foreign-key check failed.');

  const tables = queryRemoteCommerceD1(`SELECT name, strict
    FROM pragma_table_list
    WHERE schema = 'main' AND name IN (
      'commerce_read_model_control',
      'commerce_read_model_reconciliation',
      'delivery_order_read_models',
      'stripe_checkout_read_models'
    )
    ORDER BY name`);
  if (tables.length !== 4 || tables.some((row) => row.strict !== 1)) fail('Commerce D1 strict table inventory is invalid.');

  const migrations = queryRemoteCommerceD1(`SELECT name FROM d1_migrations ORDER BY id`);
  if (!migrations.some((row) => String(row.name).endsWith('0001_read_models.sql'))) {
    fail('Commerce D1 migration history is incomplete.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0002_per_kind_dual_cycles.sql'))) {
    fail('Commerce D1 per-kind cutover migration is missing.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0003_queue_health.sql'))) {
    fail('Commerce D1 queue-health migration is missing.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0004_authoritative_store.sql'))) {
    fail('Commerce D1 authoritative-store migration is missing.');
  }

  const authoritativeTables = queryRemoteCommerceD1(`SELECT name, strict
    FROM pragma_table_list
    WHERE schema = 'main' AND name IN (
      'commerce_authority_control',
      'commerce_documents',
      'commerce_commit_guards',
      'commerce_import_manifests',
      'commerce_transactions',
      'commerce_transaction_reads'
    ) ORDER BY name`);
  if (authoritativeTables.length !== 6 || authoritativeTables.some((row) => row.strict !== 1)) {
    fail('Commerce D1 authoritative strict table inventory is invalid.');
  }
  const authorityRows = queryRemoteCommerceD1('SELECT * FROM commerce_authority_control');
  if (authorityRows.length !== 1) fail('Commerce D1 authority singleton is invalid.');
  const authority = authorityRows[0];
  if (!['firestore', 'paused', 'd1'].includes(String(authority.authority_state))) {
    fail('Commerce D1 authority state is invalid.');
  }
  safeInteger(authority.revision, 'Commerce authority revision');
  safeInteger(authority.documents_revision, 'Commerce document revision');

  const authoritativeDocuments = queryRemoteCommerceD1(`SELECT
    document_path, document_kind, drop_id, document_id, fields_json, document_json
    FROM commerce_documents ORDER BY document_path`);
  for (const row of authoritativeDocuments) {
    const identity = commerceDocumentIdentity(String(row.document_path));
    if (
      !identity ||
      identity.kind !== row.document_kind ||
      identity.dropId !== row.drop_id ||
      identity.documentId !== row.document_id
    ) fail('Commerce D1 contains an invalid authoritative document identity.');
    try {
      const fields = JSON.parse(String(row.fields_json));
      const document = JSON.parse(String(row.document_json));
      if (
        !fields || typeof fields !== 'object' || Array.isArray(fields) ||
        !document || typeof document !== 'object' || Array.isArray(document)
      ) throw new Error('fields');
    } catch {
      fail('Commerce D1 contains invalid authoritative fields JSON.');
    }
  }

  const controls = queryRemoteCommerceD1('SELECT * FROM commerce_read_model_control');
  if (controls.length !== 1) fail('Commerce D1 control singleton is invalid.');
  const control = controls[0];
  if (control.read_source !== 'firestore' && control.read_source !== 'dual' && control.read_source !== 'd1') {
    fail('Commerce D1 read source is invalid.');
  }
  safeInteger(control.revision, 'Commerce control revision');
  safeInteger(control.mismatch_count, 'Commerce mismatch count');

  const reconciliation = queryRemoteCommerceD1(`SELECT *
    FROM commerce_read_model_reconciliation
    ORDER BY document_kind`);
  if (
    reconciliation.length !== 2 ||
    reconciliation[0].document_kind !== 'delivery_order' ||
    reconciliation[1].document_kind !== 'stripe_checkout'
  ) fail('Commerce D1 reconciliation state is invalid.');

  const invalidRows = queryRemoteCommerceD1(`SELECT document_path, fields_json
    FROM delivery_order_read_models
    UNION ALL
    SELECT document_path, fields_json
    FROM stripe_checkout_read_models`);
  for (const row of invalidRows) {
    if (typeof row.document_path !== 'string' || !commerceDocumentIdentity(row.document_path)) {
      fail('Commerce D1 contains an invalid document path.');
    }
    try {
      const fields = JSON.parse(String(row.fields_json));
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields');
    } catch {
      fail(`Commerce D1 contains invalid fields JSON for ${row.document_path}.`);
    }
  }

  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM delivery_order_read_models
      WHERE owner = 'owner' AND status IN ('processing', 'ready_to_ship')`),
    'delivery_order_read_models_owner_status_sort',
  );
  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM delivery_order_read_models
      WHERE drop_id = 'drop' AND status = 'ready_to_ship' AND processed_at_seconds IS NOT NULL
      ORDER BY processed_at_seconds DESC, processed_at_nanos DESC, document_path DESC
      LIMIT 10`),
    'delivery_order_read_models_fulfillment',
  );
  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM stripe_checkout_read_models
      WHERE drop_id = 'drop' AND manual_refund_review_required = 1`),
    'stripe_checkout_read_models_manual_review',
  );
  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND owner = 'owner' AND status = 'ready_to_ship'`),
    'commerce_documents_delivery_owner_status',
  );
  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND fulfillment_status = 'pending'`),
    'commerce_documents_fulfillment_status',
  );
  requireIndex(
    queryRemoteCommerceD1(`EXPLAIN QUERY PLAN SELECT document_path
      FROM commerce_documents
      WHERE document_kind = 'stripe_checkout' AND drop_id = 'drop'
        AND manual_refund_review_required = 1`),
    'commerce_documents_manual_review',
  );

  const counts = queryRemoteCommerceD1(`SELECT
    (SELECT COUNT(*) FROM delivery_order_read_models) AS delivery_orders,
    (SELECT COUNT(*) FROM stripe_checkout_read_models) AS stripe_checkouts`);
  if (counts.length !== 1) fail('Commerce D1 counts are invalid.');
  return {
    readSource: control.read_source,
    revision: safeInteger(control.revision, 'Commerce control revision'),
    deliveryOrders: safeInteger(counts[0].delivery_orders, 'Delivery-order count'),
    stripeCheckouts: safeInteger(counts[0].stripe_checkouts, 'Stripe-checkout count'),
    completedCycles: Object.fromEntries(reconciliation.map((row) => [
      String(row.document_kind),
      safeInteger(row.completed_cycles, 'Completed reconciliation cycles'),
    ])),
    authorityState: authority.authority_state,
    authorityRevision: safeInteger(authority.revision, 'Commerce authority revision'),
    authoritativeDocuments: authoritativeDocuments.length,
  };
}

async function main(): Promise<void> {
  console.log(JSON.stringify(checkCommerceD1(), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
