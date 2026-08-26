import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import {
  D1CommerceDocumentStore,
  commerceDocumentIdentity,
} from '../src/commerceDocumentStore.ts';
import {
  FIRESTORE_DATABASE_NAME,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  FirestoreWriteConflict,
} from '../src/firestoreContract.ts';

class PreparedStatement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    const statement = new PreparedStatement(this.database, this.sql);
    statement.values = values as SQLInputValue[];
    return statement as unknown as D1PreparedStatement;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement().get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.statement().all(...this.values) as T[],
      meta: {} as D1Meta & Record<string, unknown>,
    };
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.statement().run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } as D1Meta & Record<string, unknown>,
    };
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new PreparedStatement(database, sql) as unknown as D1PreparedStatement,
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run<T>());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync('cloud/workers/api/commerce-migrations').sort()) {
    database.exec(readFileSync(`cloud/workers/api/commerce-migrations/${file}`, 'utf8'));
  }
  database.exec(`UPDATE commerce_authority_control SET
    authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
    WHERE singleton = 1`);
  database.prepare(`INSERT INTO commerce_import_manifests (
    manifest_sha256, document_count, kind_counts_json, source_updated_at_ms, imported_at_ms, archive_object_prefix
  ) VALUES (?, 0, '{}', 1, 1, 'test')`).run('a'.repeat(64));
  database.prepare(`UPDATE commerce_authority_control SET
    authority_state = 'd1', revision = 3, cutover_at_ms = 2,
    import_manifest_sha256 = ?, updated_at_ms = 2 WHERE singleton = 1`).run('a'.repeat(64));
  return database;
}

const COMMIT_URL = `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`;
const BEGIN_URL = `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:beginTransaction`;

function createWrite(path: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    update: { name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}`, fields },
    currentDocument: { exists: false },
  };
}

test('commerce paths recognize every authoritative document kind', () => {
  assert.equal(commerceDocumentIdentity('claimCodes/ABC')?.kind, 'claim_code');
  assert.equal(commerceDocumentIdentity('drops/poncho/deliveryOrders/7')?.kind, 'delivery_order');
  assert.equal(commerceDocumentIdentity('drops/poncho/stripeCheckouts/cs_1')?.kind, 'stripe_checkout');
  assert.equal(commerceDocumentIdentity('drops/poncho/boxAssignments/asset')?.kind, 'box_assignment');
  assert.equal(commerceDocumentIdentity('drops/poncho/dudeAssignments/1')?.kind, 'dude_assignment');
  assert.equal(commerceDocumentIdentity('drops/poncho/meta/dudePool')?.kind, 'dude_pool');
  assert.equal(commerceDocumentIdentity('drops/poncho/offchainOrders/hash')?.kind, 'offchain_order');
  assert.equal(commerceDocumentIdentity('drops/poncho/adminIrlRedeemRequests/id')?.kind, 'admin_irl_redeem_request');
  assert.equal(commerceDocumentIdentity('drops/poncho/adminIrlRedeemPackMarkers/id')?.kind, 'admin_irl_redeem_pack_marker');
  assert.equal(commerceDocumentIdentity('drops/poncho/adminIrlRedeemReceiptMarkers/id')?.kind, 'admin_irl_redeem_receipt_marker');
  assert.equal(commerceDocumentIdentity('drops/poncho/unknown/id'), null);
});

test('commerce authority requires a verified import and cannot leave D1', () => {
  const database = new DatabaseSync(':memory:');
  for (const file of readdirSync('cloud/workers/api/commerce-migrations').sort()) {
    database.exec(readFileSync(`cloud/workers/api/commerce-migrations/${file}`, 'utf8'));
  }
  database.exec(`UPDATE commerce_authority_control SET
    authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
    WHERE singleton = 1`);
  assert.throws(() => database.exec(`UPDATE commerce_authority_control SET
    authority_state = 'd1', revision = 3, updated_at_ms = 2 WHERE singleton = 1`));
  database.prepare(`INSERT INTO commerce_import_manifests (
    manifest_sha256, document_count, kind_counts_json, source_updated_at_ms, imported_at_ms, archive_object_prefix
  ) VALUES (?, 0, '{}', 1, 1, 'test')`).run('b'.repeat(64));
  database.prepare(`UPDATE commerce_authority_control SET authority_state = 'd1', revision = 3,
    import_manifest_sha256 = ?, updated_at_ms = 2 WHERE singleton = 1`).run('b'.repeat(64));
  assert.throws(() => database.exec(`UPDATE commerce_authority_control SET
    authority_state = 'firestore', revision = 4, updated_at_ms = 3 WHERE singleton = 1`));
});

test('D1 commerce commits, queries, transforms, and deletes Firestore-shaped documents', async () => {
  const database = migratedDatabase();
  const store = new D1CommerceDocumentStore(d1(database));
  const path = 'drops/poncho/deliveryOrders/7';
  await store.request({
    method: 'POST',
    nowMs: 10,
    url: COMMIT_URL,
    body: JSON.stringify({ writes: [createWrite(path, {
      owner: { stringValue: 'wallet' },
      status: { stringValue: 'processing' },
      attempts: { integerValue: '1' },
    })] }),
  });
  const document = await store.request({
    method: 'GET',
    nowMs: 11,
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents/${path}`,
  }) as Record<string, unknown>;
  assert.equal((document.fields as Record<string, { stringValue?: string }>).owner.stringValue, 'wallet');

  await store.request({
    method: 'POST',
    nowMs: 12,
    url: COMMIT_URL,
    body: JSON.stringify({ writes: [{
      transform: {
        document: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}`,
        fieldTransforms: [
          { fieldPath: 'attempts', increment: { integerValue: '2' } },
          { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
        ],
      },
      currentDocument: { exists: true },
    }] }),
  });
  const query = await store.request({
    method: 'POST',
    nowMs: 13,
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:runQuery`,
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'deliveryOrders', allDescendants: true }],
      where: { fieldFilter: {
        field: { fieldPath: 'owner' },
        op: 'EQUAL',
        value: { stringValue: 'wallet' },
      } },
    } }),
  }) as Array<{ document?: { fields: Record<string, { integerValue?: string }> } }>;
  assert.equal(query.length, 1);
  assert.equal(query[0].document?.fields.attempts.integerValue, '3');

  await store.request({
    method: 'POST',
    nowMs: 14,
    url: COMMIT_URL,
    body: JSON.stringify({ writes: [{ delete: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}` }] }),
  });
  assert.equal(await store.request({
    method: 'GET',
    nowMs: 15,
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents/${path}`,
  }), null);
});

test('D1 transactions reject stale reads and multi-write failures roll back fully', async () => {
  const database = migratedDatabase();
  const store = new D1CommerceDocumentStore(d1(database));
  const path = 'drops/poncho/stripeCheckouts/cs_1';
  await store.request({
    method: 'POST', nowMs: 10, url: COMMIT_URL,
    body: JSON.stringify({ writes: [createWrite(path, { status: { stringValue: 'open' } })] }),
  });
  const begin = await store.request({ method: 'POST', nowMs: 11, url: BEGIN_URL, body: '{}' }) as { transaction: string };
  await store.request({
    method: 'GET',
    nowMs: 12,
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents/${path}?transaction=${begin.transaction}`,
  });
  await store.request({
    method: 'POST', nowMs: 13, url: COMMIT_URL,
    body: JSON.stringify({ writes: [{
      update: { name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}`, fields: { status: { stringValue: 'paid' } } },
      updateMask: { fieldPaths: ['status'] },
    }] }),
  });
  await assert.rejects(
    store.request({
      method: 'POST', nowMs: 14, url: COMMIT_URL,
      body: JSON.stringify({ transaction: begin.transaction, writes: [{
        update: { name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}`, fields: { status: { stringValue: 'complete' } } },
        updateMask: { fieldPaths: ['status'] },
      }] }),
    }),
    FirestoreWriteConflict,
  );

  const newPath = 'claimCodes/NEW';
  await assert.rejects(store.request({
    method: 'POST', nowMs: 15, url: COMMIT_URL,
    body: JSON.stringify({ writes: [
      createWrite(newPath, { dropId: { stringValue: 'poncho' } }),
      createWrite(path, { status: { stringValue: 'duplicate' } }),
    ] }),
  }), FirestoreWriteConflict);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM commerce_documents WHERE document_path = ?').get(newPath)?.count, 0);
});

test('D1 query cursors preserve Firestore nanosecond and document-name ordering', async () => {
  const database = migratedDatabase();
  const store = new D1CommerceDocumentStore(d1(database));
  const writes = [
    ['1', '2026-08-18T12:00:00.123000001Z'],
    ['2', '2026-08-18T12:00:00.123000002Z'],
    ['3', '2026-08-18T12:00:00.123000002Z'],
  ].map(([id, processedAt]) => createWrite(`drops/poncho/deliveryOrders/${id}`, {
    status: { stringValue: 'ready_to_ship' },
    processedAt: { timestampValue: processedAt },
  }));
  await store.request({ method: 'POST', nowMs: 10, url: COMMIT_URL, body: JSON.stringify({ writes }) });
  const response = await store.request({
    method: 'POST',
    nowMs: 11,
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents/drops/poncho:runQuery`,
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'deliveryOrders' }],
      where: { fieldFilter: {
        field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'ready_to_ship' },
      } },
      orderBy: [
        { field: { fieldPath: 'processedAt' }, direction: 'DESCENDING' },
        { field: { fieldPath: '__name__' }, direction: 'DESCENDING' },
      ],
      startAt: {
        before: false,
        values: [
          { timestampValue: '2026-08-18T12:00:00.123000002Z' },
          { referenceValue: `${FIRESTORE_DOCUMENT_NAME_PREFIX}drops/poncho/deliveryOrders/3` },
        ],
      },
    } }),
  }) as Array<{ document?: { name?: string } }>;
  assert.deepEqual(response.flatMap((entry) => entry.document?.name?.split('/').at(-1) || []), ['2', '1']);
});
