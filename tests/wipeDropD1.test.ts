import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  buildCommerceD1PlanFromDocuments,
  buildCommerceD1WipeSql,
  COMMERCE_WIPE_MINIMUM_PAUSE_MS,
  requireExecutableCommerceD1Wipe,
  requireNoProtectedD1History,
} from '../scripts/ops/wipeDrop.ts';
import type {
  CommerceD1Authority,
  CommerceD1Document,
} from '../scripts/shared/commerceD1Maintenance.ts';

const authority: CommerceD1Authority = {
  state: 'paused',
  revision: 4,
  documentsRevision: 0,
  pausedAtMs: 1,
};

function document(
  kind: CommerceD1Document['kind'],
  dropId: string | null,
  documentId: string,
  data: Record<string, unknown>,
): CommerceD1Document {
  const collection = new Map<CommerceD1Document['kind'], string>([
    ['box_assignment', 'boxAssignments'],
    ['delivery_order', 'deliveryOrders'],
    ['claim_code', 'claimCodes'],
  ]).get(kind);
  if (!collection) throw new Error(`Unsupported test kind: ${kind}`);
  const path = kind === 'claim_code'
    ? `claimCodes/${documentId}`
    : `drops/${dropId}/${collection}/${documentId}`;
  return {
    data,
    documentId,
    dropId,
    kind,
    path,
    version: 1,
    createTime: '2026-08-25T10:00:00.000000000Z',
    updateTime: '2026-08-25T10:00:00.000000001Z',
  };
}

function plan() {
  const assignment = document('box_assignment', 'target', 'box-a', { irlClaimCode: '1111111111' });
  const delivery = document('delivery_order', 'target', '7', {
    irlClaims: [{ code: '2222222222' }, { code: '3333333333' }],
  });
  const firstClaim = document('claim_code', null, '1111111111', { dropId: 'target' });
  const secondClaim = document('claim_code', null, '2222222222', { dropId: 'target' });
  return buildCommerceD1PlanFromDocuments({
    authority,
    dropId: 'target',
    targetDocuments: [assignment, delivery],
    assignmentDocuments: [assignment],
    claimDocuments: [firstClaim, secondClaim],
  });
}

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync('cloud/workers/api/commerce-migrations').sort()) {
    db.exec(readFileSync(`cloud/workers/api/commerce-migrations/${file}`, 'utf8'));
  }
  const manifestHash = 'a'.repeat(64);
  db.exec(`UPDATE commerce_authority_control SET
    authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
    WHERE singleton = 1`);
  db.prepare(`INSERT INTO commerce_import_manifests (
    manifest_sha256, document_count, kind_counts_json, source_updated_at_ms, imported_at_ms, archive_object_prefix
  ) VALUES (?, 0, '{}', 1, 1, 'test')`).run(manifestHash);
  db.prepare(`UPDATE commerce_authority_control SET
    authority_state = 'd1', revision = 3, import_manifest_sha256 = ?, cutover_at_ms = 2, updated_at_ms = 2
    WHERE singleton = 1`).run(manifestHash);
  db.exec(`UPDATE commerce_authority_control SET
    authority_state = 'paused', revision = 4, paused_at_ms = 3, updated_at_ms = 3
    WHERE singleton = 1`);
  return db;
}

function insertDocument(db: DatabaseSync, value: CommerceD1Document): void {
  db.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, fields_json, document_json,
    version, create_time, update_time
  ) VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?)`).run(
    value.path,
    value.kind,
    value.dropId,
    value.documentId,
    JSON.stringify(value.data),
    value.version,
    value.createTime,
    value.updateTime,
  );
}

function executeTransaction(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(sql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

test('Commerce D1 wipe planning deletes target documents and uniquely owned claims', () => {
  const result = plan();
  assert.equal(result.targetDocumentCount, 2);
  assert.deepEqual(result.claimCodesToDelete, ['1111111111', '2222222222']);
  assert.deepEqual(result.missingClaimCodes, ['3333333333']);
  assert.deepEqual(result.documentsToDelete.map((entry) => entry.path), [
    'claimCodes/1111111111',
    'claimCodes/2222222222',
    'drops/target/boxAssignments/box-a',
    'drops/target/deliveryOrders/7',
  ]);
});

test('Commerce D1 wipe planning supports active dry-runs but execution requires a settled pause', () => {
  assert.doesNotThrow(() => buildCommerceD1PlanFromDocuments({
    authority: { ...authority, state: 'd1', pausedAtMs: null },
    dropId: 'target',
    targetDocuments: [],
    assignmentDocuments: [],
    claimDocuments: [],
  }));
  assert.throws(
    () => requireExecutableCommerceD1Wipe({ ...authority, pausedAtMs: null }, 100_000),
    /must be paused/,
  );
  assert.throws(
    () => requireExecutableCommerceD1Wipe(authority, COMMERCE_WIPE_MINIMUM_PAUSE_MS),
    /at least 65 seconds/,
  );
  assert.doesNotThrow(() =>
    requireExecutableCommerceD1Wipe(authority, COMMERCE_WIPE_MINIMUM_PAUSE_MS + 1),
  );
});

test('Commerce D1 wipe planning rejects cross-drop claim ownership', () => {
  const target = document('box_assignment', 'target', 'box-a', { irlClaimCode: '1111111111' });
  const foreign = document('box_assignment', 'other', 'box-b', { irlClaimCode: '1111111111' });
  const claim = document('claim_code', null, '1111111111', { dropId: 'target' });
  assert.throws(() => buildCommerceD1PlanFromDocuments({
    authority,
    dropId: 'target',
    targetDocuments: [target],
    assignmentDocuments: [target, foreign],
    claimDocuments: [claim],
  }), /referenced by drop\(s\): other/);
});

test('wipe-drop blocks immutable DATA_DB and OPS_DB history', () => {
  assert.throws(() => requireNoProtectedD1History({
    dropId: 'target',
    packStatusSummaryCount: 1,
    packStatusEventCount: 2,
    revealSubmissionCount: 0,
  }), /DATA_DB retains 1 pack-status summary row\(s\) and 2 event row\(s\)/);
  assert.throws(() => requireNoProtectedD1History({
    dropId: 'target',
    packStatusSummaryCount: 0,
    packStatusEventCount: 0,
    revealSubmissionCount: 3,
  }), /OPS_DB retains 3 reveal submission\(s\)/);
});

test('Commerce D1 wipe SQL deletes exact documents and advances revision once', (t) => {
  const wipePlan = plan();
  const db = database();
  t.after(() => db.close());
  for (const entry of wipePlan.documentsToDelete) {
    const [claim] = entry.path.startsWith('claimCodes/')
      ? [document('claim_code', null, entry.path.split('/').at(-1)!, { dropId: 'target' })]
      : [entry.path.includes('/boxAssignments/')
          ? document('box_assignment', 'target', 'box-a', { irlClaimCode: '1111111111' })
          : document('delivery_order', 'target', '7', { irlClaims: [{ code: '2222222222' }] })];
    insertDocument(db, claim);
  }
  insertDocument(db, document('delivery_order', 'other', '9', {}));
  executeTransaction(db, buildCommerceD1WipeSql(wipePlan, 'guard', 100_000));
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM commerce_documents WHERE drop_id = 'target'`).get()!.count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM commerce_documents WHERE drop_id = 'other'`).get()!.count, 1);
  assert.deepEqual({ ...db.prepare(`SELECT documents_revision, revision, authority_state
    FROM commerce_authority_control`).get() }, {
    documents_revision: 1,
    revision: 4,
    authority_state: 'paused',
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_wipe_guards').get()!.count, 0);
});

test('Commerce D1 wipe SQL rolls back on version drift and refuses non-D1 authority', (t) => {
  const wipePlan = plan();
  const db = database();
  t.after(() => db.close());
  const assignment = document('box_assignment', 'target', 'box-a', { irlClaimCode: '1111111111' });
  insertDocument(db, assignment);
  const stalePlan = {
    ...wipePlan,
    documentsToDelete: [{ path: assignment.path, version: 2 }],
  };
  assert.throws(
    () => executeTransaction(db, buildCommerceD1WipeSql(stalePlan, 'guard', 100_000)),
    /commerce wipe conflict/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_documents').get()!.count, 1);
  assert.equal(db.prepare('SELECT documents_revision FROM commerce_authority_control').get()!.documents_revision, 0);
  assert.throws(() => buildCommerceD1WipeSql({
    ...wipePlan,
    authority: { ...wipePlan.authority, state: 'd1' },
  }, 'guard', 100_000), /must be paused/);
});

test('Commerce D1 wipe SQL chunks guards and deletes below the statement limit', () => {
  const documentsToDelete = Array.from({ length: 250 }, (_, index) => ({
    path: `drops/target/deliveryOrders/${String(index).padStart(5, '0')}`,
    version: 1,
  }));
  const sql = buildCommerceD1WipeSql({
    ...plan(),
    documentsToDelete,
  }, 'guard', 100_000);
  assert.equal((sql.match(/INSERT INTO commerce_wipe_guards/g) || []).length, 5);
  assert.equal((sql.match(/DELETE FROM commerce_documents/g) || []).length, 5);
  assert.ok(Math.max(...sql.split(';').map((statement) => Buffer.byteLength(statement))) < 100_000);
});
