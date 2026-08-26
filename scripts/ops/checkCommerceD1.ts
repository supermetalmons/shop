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
  if (!migrations.some((row) => String(row.name).endsWith('0005_remove_read_model.sql'))) {
    fail('Commerce D1 read-model cleanup migration is missing.');
  }
  if (!migrations.some((row) => String(row.name).endsWith('0006_paused_wipe.sql'))) {
    fail('Commerce D1 paused-wipe migration is missing.');
  }

  const authoritativeTables = queryRemoteCommerceD1(`SELECT name, strict
    FROM pragma_table_list
    WHERE schema = 'main' AND name IN (
      'commerce_authority_control',
      'commerce_documents',
      'commerce_commit_guards',
      'commerce_wipe_guards',
      'commerce_import_manifests',
      'commerce_transactions',
      'commerce_transaction_reads'
    ) ORDER BY name`);
  if (authoritativeTables.length !== 7 || authoritativeTables.some((row) => row.strict !== 1)) {
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

  const kindCounts = Object.fromEntries(queryRemoteCommerceD1(`SELECT document_kind, COUNT(*) AS count
    FROM commerce_documents GROUP BY document_kind ORDER BY document_kind`).map((row) => [
      String(row.document_kind),
      safeInteger(row.count, 'Commerce document-kind count'),
    ]));
  return {
    authorityState: authority.authority_state,
    authorityRevision: safeInteger(authority.revision, 'Commerce authority revision'),
    authoritativeDocuments: authoritativeDocuments.length,
    kindCounts,
  };
}

async function main(): Promise<void> {
  console.log(JSON.stringify(checkCommerceD1(), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
