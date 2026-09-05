import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  buildCommerceD1PlanFromDocuments,
  buildCommerceD1WipeSql,
  CommerceD1WipeOutcomeUnknownError,
  COMMERCE_WIPE_MINIMUM_PAUSE_MS,
  applySynchronousWipePhases,
  requireExecutableCommerceD1Wipe,
  requireNoProtectedD1History,
  sameCommerceD1Plan,
  verifyCommerceD1Wipe,
  withCommerceWipeAuthorityLease,
} from '../scripts/ops/wipeDrop.ts';
import { acquireCommerceAuthorityLease } from '../scripts/shared/commerceD1Maintenance.ts';
import type {
  CommerceD1Authority,
  CommerceD1Document,
} from '../scripts/shared/commerceD1Maintenance.ts';

const authority: CommerceD1Authority = {
  state: 'paused',
  revision: 4,
  documentsRevision: 0,
  pausedAtMs: 1_000,
  databaseNowMs: 67_000,
};
const authorityLeaseToken = '123e4567-e89b-42d3-a456-426614174000';
const emptyInventory = { mode: 'legacy' as const, metadata: null, availableCount: 0 };
const inventoryMetadata = {
  generation: '00000000-0000-4000-8000-000000000409',
  ready: true,
  dropFamily: 'test-family',
  itemsPerBox: 1,
  maxDudeId: 3,
  initializedAtMs: 67_000,
};
const databaseClocks = new WeakMap<DatabaseSync, { seconds: number }>();

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
    ['dude_assignment', 'dudeAssignments'],
    ['dude_pool', 'meta'],
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
    inventory: emptyInventory,
    targetDocuments: [assignment, delivery],
    assignmentDocuments: [assignment],
    claimDocuments: [firstClaim, secondClaim],
  });
}

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const clock = { seconds: 1 };
  databaseClocks.set(db, clock);
  db.function('strftime', { varargs: true }, () => String(clock.seconds));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync('cloud/workers/api/commerce-migrations/0001_current_schema.sql', 'utf8'));
  db.exec(readFileSync('cloud/workers/api/commerce-migrations/0002_authority_control_lease.sql', 'utf8'));
  db.exec(readFileSync('cloud/workers/api/commerce-migrations/0003_wipe_readiness_guard.sql', 'utf8'));
  db.exec(readFileSync('cloud/workers/api/commerce-migrations/0004_ready_notification_owner_indexes.sql', 'utf8'));
  db.exec(readFileSync('cloud/workers/api/commerce-migrations/0005_delivery_owner_query_revisions.sql', 'utf8'));
  db.exec(readFileSync('cloud/workers/api/commerce-migrations/0006_document_path_revisions.sql', 'utf8'));
  db.exec(readFileSync('cloud/workers/api/commerce-migrations/0007_stripe_terminal_notifications.sql', 'utf8'));
  db.exec(readFileSync('cloud/workers/api/commerce-migrations/0008_admin_irl_redeem_workflow_operation.sql', 'utf8'));
  db.exec(readFileSync('cloud/workers/api/commerce-migrations/0009_ready_notification_due_index.sql', 'utf8'));
  db.exec(readFileSync('cloud/workers/api/commerce-migrations/0010_dude_inventory.sql', 'utf8'));
  insertAuthorityLease(db);
  db.exec(`UPDATE commerce_authority_control SET
    paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1`);
  db.exec(`UPDATE commerce_authority_control SET
    authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1`);
  db.exec('DELETE FROM commerce_authority_control_lease');
  return db;
}

function setDatabaseNow(db: DatabaseSync, seconds: number): void {
  const clock = databaseClocks.get(db);
  if (!clock) throw new Error('Missing test database clock');
  clock.seconds = seconds;
}

function insertAuthorityLease(db: DatabaseSync): void {
  db.prepare(`INSERT INTO commerce_authority_control_lease (
    singleton, lease_token, acquired_at_ms, expires_at_ms
  ) VALUES (
    1, ?, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
  )`).run(authorityLeaseToken);
}

function pauseCommerce(db: DatabaseSync): void {
  setDatabaseNow(db, 1);
  insertAuthorityLease(db);
  db.exec(`UPDATE commerce_authority_control SET
    authority_state = 'paused', revision = revision + 1, paused_at_ms = NULL,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1`);
  db.exec(`UPDATE commerce_authority_control SET
    paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1`);
  db.exec('DELETE FROM commerce_authority_control_lease');
  setDatabaseNow(db, 67);
}

function clearCommerceReadiness(db: DatabaseSync): void {
  insertAuthorityLease(db);
  db.exec(`UPDATE commerce_authority_control SET
    paused_at_ms = NULL,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1`);
  db.exec('DELETE FROM commerce_authority_control_lease');
}

function markCommerceReady(db: DatabaseSync): void {
  const clock = databaseClocks.get(db);
  if (!clock) throw new Error('Missing test database clock');
  insertAuthorityLease(db);
  db.exec(`UPDATE commerce_authority_control SET
    paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1`);
  db.exec('DELETE FROM commerce_authority_control_lease');
  clock.seconds += 66;
}

function insertDocument(db: DatabaseSync, value: CommerceD1Document): void {
  db.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json,
    version, create_time, update_time
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
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

function insertDocumentEpoch(db: DatabaseSync, values: readonly CommerceD1Document[]): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const value of values) insertDocument(db, value);
    db.exec(`UPDATE commerce_authority_control SET
      documents_revision = documents_revision + 1,
      updated_at_ms = updated_at_ms + 1
      WHERE singleton = 1`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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

function insertInventory(db: DatabaseSync, dropId = 'target', generation = inventoryMetadata.generation): void {
  db.prepare(`INSERT INTO commerce_inventory_drops (
    drop_id, generation, ready, drop_family, items_per_box, max_dude_id, initialized_at_ms
  ) VALUES (?, ?, 0, ?, ?, ?, ?)`).run(
    dropId,
    generation,
    inventoryMetadata.dropFamily,
    inventoryMetadata.itemsPerBox,
    inventoryMetadata.maxDudeId,
    inventoryMetadata.initializedAtMs,
  );
  db.prepare(`INSERT INTO commerce_available_dudes (drop_id, dude_id, pool_position)
    VALUES (?, 2, 0), (?, 3, 1)`).run(dropId, dropId);
  db.prepare('UPDATE commerce_inventory_drops SET ready = 1 WHERE drop_id = ?').run(dropId);
}

function nativeInventoryPlan(targetDocuments: CommerceD1Document[] = []) {
  return buildCommerceD1PlanFromDocuments({
    authority: { ...authority, documentsRevision: targetDocuments.length ? 1 : 0 },
    dropId: 'target',
    inventory: { mode: 'rows', metadata: inventoryMetadata, availableCount: 2 },
    targetDocuments,
    assignmentDocuments: targetDocuments.filter((entry) => entry.kind === 'box_assignment'),
    claimDocuments: [],
  });
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
    inventory: emptyInventory,
    targetDocuments: [],
    assignmentDocuments: [],
    claimDocuments: [],
  }));
  assert.throws(
    () => requireExecutableCommerceD1Wipe({ ...authority, pausedAtMs: null }),
    /must be paused/,
  );
  assert.throws(
    () => requireExecutableCommerceD1Wipe({
      ...authority,
      databaseNowMs: COMMERCE_WIPE_MINIMUM_PAUSE_MS,
    }),
    /at least 65 seconds/,
  );
  assert.doesNotThrow(() => requireExecutableCommerceD1Wipe(authority));
});

test('Commerce D1 plan comparison ignores only observation time', () => {
  const first = plan();
  assert.equal(sameCommerceD1Plan(first, {
    ...first,
    authority: { ...first.authority, databaseNowMs: first.authority.databaseNowMs + 1_000 },
  }), true);
  assert.equal(sameCommerceD1Plan(first, {
    ...first,
    authority: { ...first.authority, revision: first.authority.revision + 1 },
  }), false);
  assert.equal(sameCommerceD1Plan(first, {
    ...first,
    authority: { ...first.authority, pausedAtMs: null },
  }), false);
  const native = nativeInventoryPlan();
  for (const inventory of [
    { ...native.inventory, availableCount: 1 },
    { ...native.inventory, mode: 'legacy' as const },
    { ...native.inventory, metadata: { ...inventoryMetadata, generation: '00000000-0000-4000-8000-000000000410' } },
  ]) {
    assert.equal(sameCommerceD1Plan(native, { ...native, inventory }), false);
  }
});

test('Commerce wipe holds and releases the shared authority lease', async (t) => {
  const db = database();
  t.after(() => db.close());
  const query = async (sql: string) => db.prepare(sql).all().map((row) => ({ ...row }));
  const result = await withCommerceWipeAuthorityLease({
    queryCommerceD1: query,
    token: authorityLeaseToken,
    run: async (renew) => {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_authority_control_lease').get()!.count, 1);
      await assert.rejects(
        acquireCommerceAuthorityLease(query, '223e4567-e89b-42d3-a456-426614174000'),
        /already running/,
      );
      await renew();
      return 'completed';
    },
  });
  assert.equal(result, 'completed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_authority_control_lease').get()!.count, 0);
});

test('Commerce and repository commits run synchronously with pre-commit cleanup', () => {
  const events: string[] = [];
  applySynchronousWipePhases({
    prepareRepo: () => {
      events.push('prepare');
      return 'prepared';
    },
    commitData: () => events.push('data'),
    applyPreparedRepo: (prepared) => events.push(`repo:${prepared}`),
    abortPreparedRepo: () => events.push('abort'),
  });
  assert.deepEqual(events, ['prepare', 'data', 'repo:prepared']);

  events.length = 0;
  assert.throws(() => applySynchronousWipePhases({
    prepareRepo: () => 'prepared',
    commitData: () => { throw new Error('data failed'); },
    applyPreparedRepo: () => events.push('repo'),
    abortPreparedRepo: () => events.push('abort'),
  }), /data failed/);
  assert.deepEqual(events, ['abort']);

  events.length = 0;
  assert.throws(() => applySynchronousWipePhases({
    prepareRepo: () => 'prepared',
    commitData: () => { throw new CommerceD1WipeOutcomeUnknownError(new Error('network')); },
    applyPreparedRepo: () => events.push('repo'),
    abortPreparedRepo: () => events.push('abort'),
  }), CommerceD1WipeOutcomeUnknownError);
  assert.deepEqual(events, []);
});

test('Commerce D1 wipe planning rejects cross-drop claim ownership', () => {
  const target = document('box_assignment', 'target', 'box-a', { irlClaimCode: '1111111111' });
  const foreign = document('box_assignment', 'other', 'box-b', { irlClaimCode: '1111111111' });
  const claim = document('claim_code', null, '1111111111', { dropId: 'target' });
  assert.throws(() => buildCommerceD1PlanFromDocuments({
    authority,
    dropId: 'target',
    inventory: emptyInventory,
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
  const initialPlan = plan();
  const wipePlan = {
    ...initialPlan,
    authority: { ...initialPlan.authority, documentsRevision: 1 },
  };
  const db = database();
  t.after(() => db.close());
  const documents = wipePlan.documentsToDelete.map((entry) => {
    const [claim] = entry.path.startsWith('claimCodes/')
      ? [document('claim_code', null, entry.path.split('/').at(-1)!, { dropId: 'target' })]
      : [entry.path.includes('/boxAssignments/')
          ? document('box_assignment', 'target', 'box-a', { irlClaimCode: '1111111111' })
          : document('delivery_order', 'target', '7', {
              irlClaims: [{ code: '2222222222' }],
              owner: 'target-owner',
            })];
    return claim;
  });
  insertDocumentEpoch(db, [...documents, document('delivery_order', 'other', '9', {})]);
  pauseCommerce(db);
  insertAuthorityLease(db);
  executeTransaction(db, buildCommerceD1WipeSql(wipePlan, 'guard', 100_000));
  const deletedPaths = wipePlan.documentsToDelete.map((entry) => entry.path).sort();
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM commerce_documents WHERE drop_id = 'target'`).get()!.count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM commerce_documents WHERE drop_id = 'other'`).get()!.count, 1);
  assert.deepEqual(
    db.prepare(`SELECT document_path, revision FROM commerce_document_path_revisions
      WHERE document_path IN (${deletedPaths.map(() => '?').join(', ')})
      ORDER BY document_path`).all(...deletedPaths).map((row) => ({ ...row })),
    deletedPaths.map((documentPath) => ({ document_path: documentPath, revision: 2 })),
  );
  assert.deepEqual({ ...db.prepare(`SELECT document_path, revision
    FROM commerce_document_path_revisions WHERE document_path = ?`)
    .get('drops/other/deliveryOrders/9') }, {
    document_path: 'drops/other/deliveryOrders/9',
    revision: 1,
  });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM commerce_document_path_revisions').get()!.count,
    documents.length + 1,
  );
  assert.deepEqual({ ...db.prepare(`SELECT documents_revision, revision, authority_state
    FROM commerce_authority_control`).get() }, {
    documents_revision: 2,
    revision: 4,
    authority_state: 'paused',
  });
  assert.equal(
    db.prepare(`SELECT revision FROM commerce_delivery_owner_revisions
      WHERE owner = 'target-owner'`).get()!.revision,
    db.prepare(`SELECT documents_revision FROM commerce_authority_control
      WHERE singleton = 1`).get()!.documents_revision,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_wipe_guards').get()!.count, 1);
  assert.equal(db.prepare('SELECT expectations_json FROM commerce_wipe_guards').get()!.expectations_json, '[]');
  assert.throws(
    () => executeTransaction(db, buildCommerceD1WipeSql({
      ...wipePlan,
      documentsToDelete: [],
    }, 'stale-global', 100_000)),
    /commerce wipe conflict/,
  );
});

test('Commerce D1 wipe SQL rolls back on version drift and refuses non-D1 authority', (t) => {
  const wipePlan = plan();
  const db = database();
  t.after(() => db.close());
  const assignment = document('box_assignment', 'target', 'box-a', { irlClaimCode: '1111111111' });
  insertDocument(db, assignment);
  pauseCommerce(db);
  insertAuthorityLease(db);
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

test('Commerce D1 wipe SQL atomically requires maintenance readiness and authority revision', (t) => {
  const wipePlan = plan();
  const db = database();
  t.after(() => db.close());
  const assignment = document('box_assignment', 'target', 'box-a', { irlClaimCode: '1111111111' });
  insertDocument(db, assignment);
  pauseCommerce(db);
  clearCommerceReadiness(db);
  assert.throws(
    () => executeTransaction(db, buildCommerceD1WipeSql({
      ...wipePlan,
      documentsToDelete: [{ path: assignment.path, version: 1 }],
    }, 'not-ready', 100_000)),
    /maintenance is not ready/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_documents').get()!.count, 1);
  db.exec('UPDATE commerce_authority_control SET revision = 3 WHERE singleton = 1');
  markCommerceReady(db);
  insertAuthorityLease(db);
  assert.throws(
    () => executeTransaction(db, buildCommerceD1WipeSql({
      ...wipePlan,
      documentsToDelete: [{ path: assignment.path, version: 1 }],
    }, 'stale-authority', 100_000)),
    /commerce wipe conflict/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_documents').get()!.count, 1);
});

test('Commerce D1 empty wipes still execute the authority guard', (t) => {
  const db = database();
  t.after(() => db.close());
  pauseCommerce(db);
  insertAuthorityLease(db);
  const emptyPlan = { ...plan(), documentsToDelete: [] };
  const sql = buildCommerceD1WipeSql(emptyPlan, 'empty', 100_000);
  assert.equal((sql.match(/INSERT INTO commerce_wipe_guards/g) || []).length, 1);
  assert.equal((sql.match(/DELETE FROM commerce_documents/g) || []).length, 0);
  executeTransaction(db, sql);
  assert.equal(db.prepare('SELECT documents_revision FROM commerce_authority_control').get()!.documents_revision, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_wipe_guards').get()!.count, 1);

  db.exec('DELETE FROM commerce_authority_control_lease');
  clearCommerceReadiness(db);
  assert.throws(
    () => executeTransaction(db, buildCommerceD1WipeSql(emptyPlan, 'not-ready-empty', 100_000)),
    /maintenance is not ready/,
  );
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

test('Commerce D1 wipe deletes native inventory and ownership while keeping the legacy pool fence', (t) => {
  const db = database();
  t.after(() => db.close());
  const documents = [
    document('box_assignment', 'target', 'box-a', { dudeIds: [1] }),
    document('dude_assignment', 'target', '1', { dudeId: 1, boxAssetId: 'box-a' }),
    document('dude_pool', 'target', 'dudePool', { available: [2, 3] }),
  ];
  insertDocumentEpoch(db, documents);
  pauseCommerce(db);
  insertAuthorityLease(db);
  insertInventory(db);
  insertInventory(db, 'other');
  db.exec("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1");
  const wipePlan = nativeInventoryPlan(documents);
  const guardId = 'wipe:target:native';
  executeTransaction(db, buildCommerceD1WipeSql(wipePlan, guardId, 67_000));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM commerce_documents WHERE drop_id = 'target'").get()!.count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM commerce_available_dudes WHERE drop_id = 'target'").get()!.count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM commerce_inventory_drops WHERE drop_id = 'target'").get()!.count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM commerce_available_dudes WHERE drop_id = 'other'").get()!.count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM commerce_inventory_drops WHERE drop_id = 'other'").get()!.count, 1);
  assert.equal(db.prepare('SELECT dude_inventory_mode FROM commerce_authority_control').get()!.dude_inventory_mode, 'rows');
  verifyCommerceD1Wipe('target', wipePlan, `${guardId}:`, (sql) => db.prepare(sql).all().map((row) => ({ ...row })));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_wipe_guards').get()!.count, 0);
  db.exec(`UPDATE commerce_authority_control
    SET authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
      updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton = 1`);
  assert.throws(
    () => insertDocument(db, document('dude_pool', 'target', 'dudePool', { available: [1, 2, 3] })),
    /legacy commerce inventory writes are disabled/,
  );
});

test('Commerce D1 wipe rejects changed inventory generation or availability before deleting anything', (t) => {
  for (const change of ['generation', 'availability'] as const) {
    const db = database();
    t.after(() => db.close());
    pauseCommerce(db);
    insertAuthorityLease(db);
    insertInventory(db);
    db.exec("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1");
    const wipePlan = nativeInventoryPlan();
    if (change === 'generation') {
      db.exec("DELETE FROM commerce_inventory_drops WHERE drop_id = 'target'");
      insertInventory(db, 'target', '00000000-0000-4000-8000-000000000410');
    } else {
      db.exec("DELETE FROM commerce_available_dudes WHERE drop_id = 'target' AND dude_id = 2");
    }
    assert.throws(() => executeTransaction(db, buildCommerceD1WipeSql(wipePlan, `stale-${change}`, 67_000)), /commerce wipe conflict/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_inventory_drops').get()!.count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_available_dudes').get()!.count, change === 'generation' ? 2 : 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_wipe_guards').get()!.count, 0);
    assert.equal(db.prepare('SELECT documents_revision FROM commerce_authority_control').get()!.documents_revision, 0);
  }
});

test('Commerce D1 native inventory wipe requires a live lease and settled maintenance readiness', (t) => {
  for (const condition of ['missing-lease', 'expired-lease', 'not-ready'] as const) {
    const db = database();
    t.after(() => db.close());
    pauseCommerce(db);
    insertAuthorityLease(db);
    insertInventory(db);
    db.exec("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1");
    if (condition === 'expired-lease') {
      setDatabaseNow(db, 128);
    } else {
      db.exec('DELETE FROM commerce_authority_control_lease');
      if (condition === 'not-ready') clearCommerceReadiness(db);
    }
    assert.throws(
      () => executeTransaction(db, buildCommerceD1WipeSql(nativeInventoryPlan(), condition, 67_000)),
      condition === 'not-ready' ? /maintenance is not ready/ : /commerce wipe conflict/,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_inventory_drops').get()!.count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_available_dudes').get()!.count, 2);
  }
});

test('Commerce D1 wipe verification requires native inventory to remain absent', (t) => {
  const db = database();
  t.after(() => db.close());
  pauseCommerce(db);
  insertAuthorityLease(db);
  insertInventory(db);
  db.exec("UPDATE commerce_authority_control SET dude_inventory_mode = 'rows' WHERE singleton = 1");
  const wipePlan = nativeInventoryPlan();
  const guardId = 'wipe:target:verification';
  executeTransaction(db, buildCommerceD1WipeSql(wipePlan, guardId, 67_000));
  assert.equal(db.prepare('SELECT documents_revision FROM commerce_authority_control').get()!.documents_revision, 1);
  insertInventory(db, 'target', '00000000-0000-4000-8000-000000000410');
  assert.throws(
    () => verifyCommerceD1Wipe('target', wipePlan, `${guardId}:`, (sql) => db.prepare(sql).all().map((row) => ({ ...row }))),
    /wipe verification failed/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_wipe_guards').get()!.count, 1);
});
