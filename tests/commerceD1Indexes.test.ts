import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const migrations = new URL('../cloud/workers/api/commerce-migrations/', import.meta.url);

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  return db;
}

function indexColumns(db: DatabaseSync, name: string): string[] {
  return db.prepare(`PRAGMA index_info(${name})`).all().map((row) => String(row.name));
}

test('the final Commerce D1 schema retains its reconciliation indexes', () => {
  const db = database();
  try {
    assert.deepEqual(indexColumns(db, 'commerce_documents_checkout_reconciliation'), [
      'document_kind',
      'status',
      'fulfillment_processor',
      'document_path',
    ]);
    assert.deepEqual(indexColumns(db, 'commerce_documents_pack_projection'), [
      'document_kind',
      'drop_id',
      'pack_projection_state',
      'pack_projection_next_attempt_ms',
      'document_path',
    ]);
    assert.deepEqual(indexColumns(db, 'commerce_documents_ready_notifications'), [
      'document_kind',
      'status',
      'buyer_notification_state',
      'shipper_notification_state',
      'document_path',
    ]);
  } finally {
    db.close();
  }
});
