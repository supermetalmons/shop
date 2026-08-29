import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { sqlSchemaFingerprint } from '../scripts/shared/sqlSchemaFingerprint.ts';

const schemaSql = readFileSync(
  new URL('../cloud/workers/api/commerce-migrations/0001_current_schema.sql', import.meta.url),
  'utf8',
);
const leaseMigrationSql = readFileSync(
  new URL('../cloud/workers/api/commerce-migrations/0002_authority_control_lease.sql', import.meta.url),
  'utf8',
);
const wipeReadinessMigrationSql = readFileSync(
  new URL('../cloud/workers/api/commerce-migrations/0003_wipe_readiness_guard.sql', import.meta.url),
  'utf8',
);
const readyNotificationOwnerIndexesMigrationSql = readFileSync(
  new URL('../cloud/workers/api/commerce-migrations/0004_ready_notification_owner_indexes.sql', import.meta.url),
  'utf8',
);
const deliveryOwnerQueryRevisionsMigrationSql = readFileSync(
  new URL('../cloud/workers/api/commerce-migrations/0005_delivery_owner_query_revisions.sql', import.meta.url),
  'utf8',
);
const authorityLeaseToken = '123e4567-e89b-42d3-a456-426614174000';
const d1NowMsSql = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
const deliveryOwnerRevisionTriggers = [
  'commerce_delivery_owner_revision_arrival',
  'commerce_delivery_owner_revision_delete',
  'commerce_delivery_owner_revision_delete_guard',
  'commerce_delivery_owner_revision_departure',
  'commerce_delivery_owner_revision_insert',
  'commerce_delivery_owner_revision_insert_guard',
  'commerce_delivery_owner_revision_path',
  'commerce_delivery_owner_revision_update_guard',
] as const;

function databaseBeforeDeliveryOwnerRevisions(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  db.exec(leaseMigrationSql);
  db.exec(wipeReadinessMigrationSql);
  db.exec(readyNotificationOwnerIndexesMigrationSql);
  return db;
}

function database(): DatabaseSync {
  const db = databaseBeforeDeliveryOwnerRevisions();
  db.exec(deliveryOwnerQueryRevisionsMigrationSql);
  return db;
}

function insertTestDocument(db: DatabaseSync, args: {
  data?: Record<string, unknown>;
  documentId: string;
  dropId: string | null;
  kind: 'claim_code' | 'delivery_order' | 'stripe_checkout';
  path: string;
}): void {
  db.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json,
    version, create_time, update_time, processed_at_seconds, processed_at_nanos
  ) VALUES (?, ?, ?, ?, ?, 1, 'created', 'updated', NULL, NULL)`).run(
    args.path,
    args.kind,
    args.dropId,
    args.documentId,
    JSON.stringify(args.data || {}),
  );
}

function runDocumentEpoch(db: DatabaseSync, operation: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    operation();
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

function deliveryOwnerRevisions(db: DatabaseSync): Array<{ owner: string; revision: number }> {
  return db.prepare(`SELECT owner, revision FROM commerce_delivery_owner_revisions
    ORDER BY owner`).all().map((row) => ({
      owner: String(row.owner),
      revision: Number(row.revision),
    }));
}

function indexColumns(db: DatabaseSync, name: string): string[] {
  return db.prepare(`PRAGMA index_info(${name})`).all().map((row) => String(row.name));
}

function planDetails(db: DatabaseSync, sql: string, ...bindings: SQLInputValue[]): string {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map((row) => String(row.detail)).join('\n');
}

test('Commerce migrations create the exact current authority and guard schema', () => {
  const db = database();
  try {
    assert.deepEqual({ ...db.prepare('SELECT * FROM commerce_authority_control').get()! }, {
      singleton: 1,
      authority_state: 'd1',
      revision: 1,
      documents_revision: 0,
      paused_at_ms: null,
      updated_at_ms: 0,
    });
    assert.deepEqual(
      db.prepare(`SELECT name FROM pragma_table_list
        WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`).all().map((row) => String(row.name)),
      [
        'commerce_authority_control',
        'commerce_authority_control_lease',
        'commerce_commit_guards',
        'commerce_delivery_owner_revisions',
        'commerce_documents',
        'commerce_wipe_guards',
      ],
    );
    assert.deepEqual(
      db.prepare(`SELECT name FROM sqlite_schema
        WHERE type = 'trigger' AND name LIKE 'commerce_%'
        ORDER BY name`).all().map((row) => String(row.name)),
      [
        'commerce_authority_delete_guard',
        'commerce_authority_revision_guard',
        'commerce_authority_transition_guard',
        'commerce_authority_update_guard',
        'commerce_commit_guard_validate',
        ...deliveryOwnerRevisionTriggers,
        'commerce_documents_delete_authority_guard',
        'commerce_documents_identity_insert_guard',
        'commerce_documents_identity_update_guard',
        'commerce_documents_insert_authority_guard',
        'commerce_documents_update_authority_guard',
        'commerce_documents_version_update_guard',
        'commerce_wipe_guard_validate',
      ],
    );
    assert.deepEqual(
      db.prepare("SELECT name FROM pragma_table_info('commerce_commit_guards') ORDER BY cid")
        .all().map((row) => String(row.name)),
      [
        'guard_id',
        'expectations_json',
        'expected_documents_revision',
        'created_at_ms',
        'delivery_owner_expectations_json',
      ],
    );
    assert.deepEqual(
      db.prepare("SELECT name FROM pragma_table_info('commerce_delivery_owner_revisions') ORDER BY cid")
        .all().map((row) => String(row.name)),
      ['owner', 'revision'],
    );
    assert.equal(db.prepare(`SELECT strict FROM pragma_table_list
      WHERE schema = 'main' AND name = 'commerce_delivery_owner_revisions'`).get()!.strict, 1);
  } finally {
    db.close();
  }
});

test('Delivery-owner migration preserves legacy guards and starts existing owners at epoch zero', () => {
  const db = databaseBeforeDeliveryOwnerRevisions();
  try {
    const documentPath = 'drops/drop/deliveryOrders/1';
    const currentExpectations = JSON.stringify([{ path: documentPath, version: 1 }]);
    runDocumentEpoch(db, () => {
      insertTestDocument(db, {
        data: { owner: 'existing-owner', status: 'ready_to_ship' },
        documentId: '1',
        dropId: 'drop',
        kind: 'delivery_order',
        path: documentPath,
      });
    });
    db.prepare(`INSERT INTO commerce_commit_guards (
      guard_id, expectations_json, expected_documents_revision, created_at_ms
    ) VALUES ('before-migration', ?, 1, 1)`).run(currentExpectations);
    db.exec(deliveryOwnerQueryRevisionsMigrationSql);

    assert.deepEqual(deliveryOwnerRevisions(db), []);
    assert.equal(db.prepare(`SELECT delivery_owner_expectations_json
      FROM commerce_commit_guards WHERE guard_id = 'before-migration'`).get()!.delivery_owner_expectations_json, '[]');
    assert.doesNotThrow(() => db.prepare(`INSERT INTO commerce_commit_guards (
      guard_id, expectations_json, expected_documents_revision, created_at_ms
    ) VALUES ('after-migration', ?, 1, 2)`).run(currentExpectations));
    assert.equal(db.prepare(`SELECT delivery_owner_expectations_json
      FROM commerce_commit_guards WHERE guard_id = 'after-migration'`).get()!.delivery_owner_expectations_json, '[]');
    assert.throws(
      () => db.prepare(`INSERT INTO commerce_commit_guards (
        guard_id, expectations_json, expected_documents_revision, created_at_ms
      ) VALUES ('stale-path', ?, 1, 3)`).run(JSON.stringify([{ path: documentPath, version: 0 }])),
      /commerce transaction conflict/,
    );
    assert.throws(
      () => db.prepare(`INSERT INTO commerce_commit_guards (
        guard_id, expectations_json, expected_documents_revision, created_at_ms
      ) VALUES ('stale-global', ?, 0, 4)`).run(currentExpectations),
      /commerce transaction conflict/,
    );
  } finally {
    db.close();
  }
});

test('Delivery-owner revision triggers cover membership changes and coalesce each document epoch', () => {
  const db = database();
  try {
    runDocumentEpoch(db, () => {
      for (let index = 1; index <= 450; index += 1) {
        insertTestDocument(db, {
          data: { owner: 'alpha', status: index % 2 ? 'ready_to_ship' : 'prepared' },
          documentId: String(index),
          dropId: 'drop-a',
          kind: 'delivery_order',
          path: `drops/drop-a/deliveryOrders/${index}`,
        });
      }
      insertTestDocument(db, {
        data: { owner: 'alpha', status: 'open' },
        documentId: 'checkout',
        dropId: 'drop-a',
        kind: 'stripe_checkout',
        path: 'drops/drop-a/stripeCheckouts/checkout',
      });
      insertTestDocument(db, {
        documentId: '3',
        dropId: 'drop-c',
        kind: 'delivery_order',
        path: 'drops/drop-c/deliveryOrders/3',
      });
    });
    assert.deepEqual(deliveryOwnerRevisions(db), [{ owner: 'alpha', revision: 1 }]);

    runDocumentEpoch(db, () => {
      db.exec(`UPDATE commerce_documents SET
        document_json = json_set(document_json, '$.status', 'processing'),
        version = version + 1
        WHERE document_path = 'drops/drop-a/deliveryOrders/1'`);
    });
    assert.deepEqual(deliveryOwnerRevisions(db), [{ owner: 'alpha', revision: 1 }]);

    runDocumentEpoch(db, () => {
      db.exec(`UPDATE commerce_documents SET
        document_path = 'drops/drop-a/deliveryOrders/moved-2', document_id = 'moved-2',
        version = version + 1
        WHERE document_path = 'drops/drop-a/deliveryOrders/2'`);
    });
    assert.deepEqual(deliveryOwnerRevisions(db), [{ owner: 'alpha', revision: 3 }]);

    runDocumentEpoch(db, () => {
      db.exec(`UPDATE commerce_documents SET
        document_json = json_set(document_json, '$.owner', 'beta'),
        version = version + 1
        WHERE document_path = 'drops/drop-a/deliveryOrders/1'`);
      db.exec(`UPDATE commerce_documents SET
        document_json = json_set(document_json, '$.owner', 'gamma'),
        version = version + 1
        WHERE document_path = 'drops/drop-c/deliveryOrders/3'`);
      db.exec(`UPDATE commerce_documents SET
        document_kind = 'delivery_order', version = version + 1
        WHERE document_path = 'drops/drop-a/stripeCheckouts/checkout'`);
    });
    assert.deepEqual(deliveryOwnerRevisions(db), [
      { owner: 'alpha', revision: 4 },
      { owner: 'beta', revision: 4 },
      { owner: 'gamma', revision: 4 },
    ]);

    runDocumentEpoch(db, () => {
      db.exec("DELETE FROM commerce_documents WHERE document_path = 'drops/drop-a/deliveryOrders/moved-2'");
      db.exec(`UPDATE commerce_documents SET
        document_json = json_remove(document_json, '$.owner'),
        version = version + 1
        WHERE document_path = 'drops/drop-c/deliveryOrders/3'`);
      db.exec(`UPDATE commerce_documents SET
        document_kind = 'stripe_checkout', version = version + 1
        WHERE document_path = 'drops/drop-a/deliveryOrders/1'`);
    });
    assert.deepEqual(deliveryOwnerRevisions(db), [
      { owner: 'alpha', revision: 5 },
      { owner: 'beta', revision: 5 },
      { owner: 'gamma', revision: 5 },
    ]);
    assert.equal(db.prepare(`SELECT documents_revision FROM commerce_authority_control
      WHERE singleton = 1`).get()!.documents_revision, 5);
  } finally {
    db.close();
  }
});

test('Delivery-owner commit guards accept exact epochs and reject malformed, duplicate, or stale scopes', () => {
  const db = database();
  try {
    assert.doesNotThrow(() => db.prepare(`INSERT INTO commerce_commit_guards (
      guard_id, expectations_json, expected_documents_revision, delivery_owner_expectations_json, created_at_ms
    ) VALUES ('absent', '[]', NULL, ?, 1)`).run(JSON.stringify([{ owner: 'absent-owner', revision: 0 }])));

    runDocumentEpoch(db, () => insertTestDocument(db, {
      data: { owner: 'current-owner' },
      documentId: '1',
      dropId: 'drop',
      kind: 'delivery_order',
      path: 'drops/drop/deliveryOrders/1',
    }));
    assert.doesNotThrow(() => db.prepare(`INSERT INTO commerce_commit_guards (
      guard_id, expectations_json, expected_documents_revision, delivery_owner_expectations_json, created_at_ms
    ) VALUES ('current', '[]', NULL, ?, 2)`).run(JSON.stringify([{ owner: 'current-owner', revision: 1 }])));

    for (const [guardId, expectations] of [
      ['stale', [{ owner: 'current-owner', revision: 0 }]],
      ['duplicate', [{ owner: 'current-owner', revision: 1 }, { owner: 'current-owner', revision: 1 }]],
      ['empty-owner', [{ owner: '', revision: 0 }]],
      ['extra-field', [{ owner: 'current-owner', revision: 1, extra: true }]],
      ['string-revision', [{ owner: 'current-owner', revision: '1' }]],
      ['unsafe-revision', [{ owner: 'current-owner', revision: 9_007_199_254_740_992 }]],
    ] as const) {
      assert.throws(() => db.prepare(`INSERT INTO commerce_commit_guards (
        guard_id, expectations_json, expected_documents_revision, delivery_owner_expectations_json, created_at_ms
      ) VALUES (?, '[]', NULL, ?, 3)`).run(guardId, JSON.stringify(expectations)), /commerce transaction conflict/);
    }
    assert.throws(() => db.prepare(`INSERT INTO commerce_commit_guards (
      guard_id, expectations_json, expected_documents_revision, delivery_owner_expectations_json, created_at_ms
    ) VALUES ('not-array', '[]', NULL, '{}', 4)`).run());
  } finally {
    db.close();
  }
});

test('Delivery-owner revision tombstones reject deletion, rekeying, and non-increasing revisions', () => {
  const db = database();
  try {
    runDocumentEpoch(db, () => insertTestDocument(db, {
      data: { owner: 'current-owner' },
      documentId: '1',
      dropId: 'drop',
      kind: 'delivery_order',
      path: 'drops/drop/deliveryOrders/1',
    }));
    assert.throws(
      () => db.exec("DELETE FROM commerce_delivery_owner_revisions WHERE owner = 'current-owner'"),
      /tombstones cannot be deleted/,
    );
    assert.throws(() => db.exec(`UPDATE commerce_delivery_owner_revisions
      SET owner = 'replacement-owner', revision = revision + 1
      WHERE owner = 'current-owner'`), /must increase in place/);
    assert.throws(() => db.exec(`UPDATE commerce_delivery_owner_revisions
      SET revision = revision
      WHERE owner = 'current-owner'`), /must increase in place/);
    assert.throws(() => db.exec(`UPDATE commerce_delivery_owner_revisions
      SET revision = revision - 1
      WHERE owner = 'current-owner'`), /must increase in place/);
    runDocumentEpoch(db, () => insertTestDocument(db, {
      data: { owner: 'current-owner' },
      documentId: '2',
      dropId: 'drop',
      kind: 'delivery_order',
      path: 'drops/drop/deliveryOrders/2',
    }));
    assert.deepEqual(deliveryOwnerRevisions(db), [{ owner: 'current-owner', revision: 2 }]);
    assert.throws(() => db.exec(`INSERT OR REPLACE INTO commerce_delivery_owner_revisions (owner, revision)
      VALUES ('current-owner', 1)`), /cannot move backward/);
    assert.deepEqual(deliveryOwnerRevisions(db), [{ owner: 'current-owner', revision: 2 }]);
  } finally {
    db.close();
  }
});

test('Delivery-owner revision health detects nonpositive values even when CHECK constraints are ignored', () => {
  const db = database();
  try {
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.exec("INSERT INTO commerce_delivery_owner_revisions (owner, revision) VALUES ('invalid-owner', 0)");
    assert.deepEqual({ ...db.prepare(`SELECT
      COUNT(*) AS count,
      COALESCE(SUM(revision < 1), 0) AS invalid_count,
      COALESCE(SUM(revision > (
        SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1
      )), 0) AS future_count
      FROM commerce_delivery_owner_revisions`).get()! }, {
      count: 1,
      invalid_count: 1,
      future_count: 0,
    });
  } finally {
    db.close();
  }
});

test('Commerce document updates must advance their version', () => {
  const db = database();
  try {
    insertTestDocument(db, {
      data: { status: 'unused' },
      documentId: 'VERSIONED',
      dropId: null,
      kind: 'claim_code',
      path: 'claimCodes/VERSIONED',
    });
    assert.throws(() => db.prepare(`INSERT INTO commerce_documents (
      document_path, document_kind, drop_id, document_id, document_json,
      version, create_time, update_time, processed_at_seconds, processed_at_nanos
    ) VALUES ('claimCodes/VERSIONED', 'claim_code', NULL, 'VERSIONED', ?, 1,
      'created', 'replacement', NULL, NULL)
    ON CONFLICT(document_path) DO UPDATE SET
      document_json = excluded.document_json,
      version = excluded.version,
      update_time = excluded.update_time`).run(JSON.stringify({ status: 'replacement' })),
    /document version must increase/);
    assert.deepEqual({ ...db.prepare(`SELECT document_json, version, update_time
      FROM commerce_documents WHERE document_path = 'claimCodes/VERSIONED'`).get()! }, {
      document_json: JSON.stringify({ status: 'unused' }),
      version: 1,
      update_time: 'updated',
    });
    db.exec(`UPDATE commerce_documents
      SET document_json = json_set(document_json, '$.status', 'used'),
        version = version + 1
      WHERE document_path = 'claimCodes/VERSIONED'`);
    assert.throws(() => db.exec(`UPDATE commerce_documents SET version = version - 1
      WHERE document_path = 'claimCodes/VERSIONED'`), /document version must increase/);
  } finally {
    db.close();
  }
});

test('Commerce authority pause and resume remain revision guarded', () => {
  const db = database();
  try {
    db.prepare(`INSERT INTO commerce_authority_control_lease (
      singleton, lease_token, acquired_at_ms, expires_at_ms
    ) VALUES (1, ?, ${d1NowMsSql}, ${d1NowMsSql} + 60000)`).run(authorityLeaseToken);
    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', revision = 2, paused_at_ms = NULL,
      updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`);
    assert.throws(() => db.prepare(`INSERT INTO commerce_documents (
      document_path, document_kind, drop_id, document_id, document_json,
      version, create_time, update_time
    ) VALUES ('claimCodes/code', 'claim_code', NULL, 'code', '{}', 1, 'created', 'updated')`).run(),
    /commerce authority is not d1/);
    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'd1', revision = 3, paused_at_ms = NULL,
      updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`);
    assert.throws(() => db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', paused_at_ms = NULL, updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`), /revision conflict/);
    assert.throws(() => db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'other', revision = 4, updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`));
  } finally {
    db.close();
  }
});

test('Commerce readiness markers require a leased D1-time update', () => {
  const db = database();
  try {
    assert.throws(() => db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', revision = 2,
      paused_at_ms = ${d1NowMsSql}, updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`), /coordination lease is required/);

    db.prepare(`INSERT INTO commerce_authority_control_lease (
      singleton, lease_token, acquired_at_ms, expires_at_ms
    ) VALUES (1, ?, ${d1NowMsSql}, ${d1NowMsSql} + 60000)`).run(authorityLeaseToken);
    assert.throws(() => db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', revision = 2,
      paused_at_ms = ${d1NowMsSql}, updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`), /invalid commerce authority readiness mutation/);

    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', revision = 2, paused_at_ms = NULL,
      updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`);
    for (const offset of [-1000, 1000]) {
      assert.throws(() => db.exec(`UPDATE commerce_authority_control SET
        paused_at_ms = ${d1NowMsSql} + ${offset}, updated_at_ms = ${d1NowMsSql}
        WHERE singleton = 1`), /invalid commerce authority readiness mutation/);
    }
    db.exec(`UPDATE commerce_authority_control SET
      paused_at_ms = ${d1NowMsSql}, updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`);
    const ready = db.prepare(`SELECT paused_at_ms, updated_at_ms
      FROM commerce_authority_control WHERE singleton = 1`).get()!;
    assert.equal(ready.paused_at_ms, ready.updated_at_ms);

    db.exec('DELETE FROM commerce_authority_control_lease');
    assert.throws(() => db.exec(`UPDATE commerce_authority_control SET
      paused_at_ms = NULL, updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`), /coordination lease is required/);
    assert.throws(() => db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'd1', revision = 3, paused_at_ms = NULL,
      updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`), /coordination lease is required/);

    db.prepare(`INSERT INTO commerce_authority_control_lease (
      singleton, lease_token, acquired_at_ms, expires_at_ms
    ) VALUES (1, ?, ${d1NowMsSql} - 2000, ${d1NowMsSql} - 1000)`).run(authorityLeaseToken);
    assert.throws(() => db.exec(`UPDATE commerce_authority_control SET
      paused_at_ms = NULL, updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`), /coordination lease is required/);

    db.exec('DELETE FROM commerce_authority_control_lease');
    db.prepare(`INSERT INTO commerce_authority_control_lease (
      singleton, lease_token, acquired_at_ms, expires_at_ms
    ) VALUES (1, ?, ${d1NowMsSql}, ${d1NowMsSql} + 60000)`).run(authorityLeaseToken);
    db.exec(`UPDATE commerce_authority_control SET
      paused_at_ms = NULL, updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`);
    db.exec('DELETE FROM commerce_authority_control_lease');
    assert.throws(() => db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'd1', revision = 3, paused_at_ms = NULL,
      updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`), /coordination lease is required/);
  } finally {
    db.close();
  }
});

test('Commerce authority coordination lease migration is strict and singleton', () => {
  const db = database();
  try {
    assert.deepEqual(
      db.prepare("SELECT name FROM pragma_table_info('commerce_authority_control_lease') ORDER BY cid")
        .all().map((row) => String(row.name)),
      ['singleton', 'lease_token', 'acquired_at_ms', 'expires_at_ms'],
    );
    assert.equal(db.prepare(`SELECT strict FROM pragma_table_list
      WHERE schema = 'main' AND name = 'commerce_authority_control_lease'`).get()!.strict, 1);
    db.prepare(`INSERT INTO commerce_authority_control_lease
      (singleton, lease_token, acquired_at_ms, expires_at_ms) VALUES (1, ?, 10, 20)`)
      .run('123e4567-e89b-42d3-a456-426614174000');
    assert.throws(() => db.prepare(`INSERT INTO commerce_authority_control_lease
      (singleton, lease_token, acquired_at_ms, expires_at_ms) VALUES (1, ?, 20, 30)`)
      .run('223e4567-e89b-42d3-a456-426614174000'));
    assert.throws(() => db.prepare(`UPDATE commerce_authority_control_lease
      SET expires_at_ms = acquired_at_ms`).run());
  } finally {
    db.close();
  }
});

test('Commerce wipe guards require an authority revision and maintenance readiness', () => {
  const db = database();
  try {
    assert.deepEqual(
      db.prepare("SELECT name FROM pragma_table_info('commerce_wipe_guards') ORDER BY cid")
        .all().map((row) => String(row.name)),
      [
        'guard_id',
        'expectations_json',
        'expected_documents_revision',
        'created_at_ms',
        'expected_authority_revision',
      ],
    );
  } finally {
    db.close();
  }
});

test('Commerce wipe guard fingerprints preserve SQL literal contents', () => {
  const db = database();
  try {
    const sql = String(db.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'commerce_wipe_guard_validate'`).get()!.sql);
    assert.notEqual(
      sqlSchemaFingerprint(sql),
      sqlSchemaFingerprint(sql.replace('commerce wipe conflict', 'commerce  wipe conflict')),
    );
  } finally {
    db.close();
  }
});

test('Commerce wipe readiness migration clears legacy paused markers', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schemaSql);
    db.exec(leaseMigrationSql);
    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
      WHERE singleton = 1`);
    db.exec(wipeReadinessMigrationSql);
    assert.equal(
      db.prepare('SELECT paused_at_ms FROM commerce_authority_control WHERE singleton = 1').get()!.paused_at_ms,
      null,
    );
    assert.throws(() => db.prepare(`INSERT INTO commerce_wipe_guards (
      guard_id, expectations_json, expected_documents_revision,
      expected_authority_revision, created_at_ms
    ) VALUES ('legacy', '[]', 0, 2, 1)`).run(), /maintenance is not ready/);
  } finally {
    db.close();
  }
});

test('Commerce authority cannot resume while a wipe guard remains', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schemaSql);
    db.exec(leaseMigrationSql);
    db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
      WHERE singleton = 1`);
    db.exec(`INSERT INTO commerce_wipe_guards (
      guard_id, expectations_json, expected_documents_revision, created_at_ms
    ) VALUES ('wipe:target:pending:0', '[]', 0, 1)`);
    db.exec(wipeReadinessMigrationSql);
    db.prepare(`INSERT INTO commerce_authority_control_lease (
      singleton, lease_token, acquired_at_ms, expires_at_ms
    ) VALUES (1, ?, ${d1NowMsSql}, ${d1NowMsSql} + 60000)`).run(authorityLeaseToken);
    assert.throws(() => db.exec(`UPDATE commerce_authority_control SET
      authority_state = 'd1', revision = 3, paused_at_ms = NULL,
      updated_at_ms = ${d1NowMsSql}
      WHERE singleton = 1`), /invalid commerce authority readiness mutation/);
  } finally {
    db.close();
  }
});

test('Commerce baseline keeps required covering and partial indexes', () => {
  const db = database();
  try {
    const insert = db.prepare(`INSERT INTO commerce_documents (
      document_path, document_kind, drop_id, document_id, document_json,
      version, create_time, update_time, processed_at_seconds, processed_at_nanos
    ) VALUES (?, 'delivery_order', 'drop', ?, ?, 1, 'created', 'updated', NULL, NULL)`);
    runDocumentEpoch(db, () => {
      for (let index = 1; index <= 500; index += 1) {
        insert.run(
          `drops/drop/deliveryOrders/${index}`,
          String(index),
          JSON.stringify({
            owner: index % 2 ? 'owner' : 'other',
            status: 'ready_to_ship',
            buyerOrderReceivedEmailState: index === 100 ? 'pending' : 'queued',
            shipperReadyToShipEmailState: index === 200 ? 'pending' : 'queued',
          }),
        );
      }
    });
    assert.deepEqual(deliveryOwnerRevisions(db), [
      { owner: 'other', revision: 1 },
      { owner: 'owner', revision: 1 },
    ]);
    assert.equal(db.prepare(`SELECT documents_revision FROM commerce_authority_control
      WHERE singleton = 1`).get()!.documents_revision, 1);
    db.exec('ANALYZE');
    assert.deepEqual(indexColumns(db, 'commerce_documents_delivery_owner_path'), [
      'owner',
      'document_path',
    ]);
    assert.equal(
      String(db.prepare(`SELECT sql FROM sqlite_schema
        WHERE type = 'index' AND name = 'commerce_documents_delivery_owner_path'`).get()!.sql)
        .replace(/\s+/g, ' ')
        .trim(),
      `CREATE INDEX commerce_documents_delivery_owner_path ON commerce_documents (owner, document_path)
        WHERE document_kind = 'delivery_order'`.replace(/\s+/g, ' ').trim(),
    );
    assert.deepEqual(indexColumns(db, 'commerce_documents_pack_projection'), [
      'document_kind',
      'drop_id',
      'pack_projection_state',
      'pack_projection_next_attempt_ms',
      'document_path',
    ]);
    assert.deepEqual(indexColumns(db, 'commerce_delivery_orders_buyer_notifications_pending'), ['document_path']);
    assert.deepEqual(indexColumns(db, 'commerce_delivery_orders_shipper_notifications_pending'), ['document_path']);
    assert.deepEqual(indexColumns(db, 'commerce_delivery_orders_buyer_notifications_pending_owner_path'), [
      'owner',
      'document_path',
    ]);
    assert.deepEqual(indexColumns(db, 'commerce_delivery_orders_shipper_notifications_pending_owner_path'), [
      'owner',
      'document_path',
    ]);
    assert.equal(
      String(db.prepare(`SELECT sql FROM sqlite_schema
        WHERE type = 'index' AND name = 'commerce_delivery_orders_buyer_notifications_pending_owner_path'`)
        .get()!.sql).replace(/\s+/g, ' ').trim(),
      `CREATE INDEX commerce_delivery_orders_buyer_notifications_pending_owner_path
        ON commerce_documents (owner, document_path)
        WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship' AND
          buyer_notification_state = 'pending'`.replace(/\s+/g, ' ').trim(),
    );
    assert.equal(
      String(db.prepare(`SELECT sql FROM sqlite_schema
        WHERE type = 'index' AND name = 'commerce_delivery_orders_shipper_notifications_pending_owner_path'`)
        .get()!.sql).replace(/\s+/g, ' ').trim(),
      `CREATE INDEX commerce_delivery_orders_shipper_notifications_pending_owner_path
        ON commerce_documents (owner, document_path)
        WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship' AND
          shipper_notification_state = 'pending'`.replace(/\s+/g, ' ').trim(),
    );
    assert.deepEqual(indexColumns(db, 'commerce_stripe_checkouts_reconciliation_due'), ['null', 'document_path']);
    assert.match(planDetails(db, `SELECT document_path FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND owner = 'owner'
      ORDER BY document_path LIMIT 450`), /commerce_documents_delivery_owner_path/);
    const ownerNotificationPlan = planDetails(db, `WITH candidate_paths AS (
      SELECT document_path FROM commerce_documents
        INDEXED BY commerce_delivery_orders_buyer_notifications_pending_owner_path
      WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship'
        AND buyer_notification_state = 'pending' AND owner = ? AND document_path > ?
      UNION
      SELECT document_path FROM commerce_documents
        INDEXED BY commerce_delivery_orders_shipper_notifications_pending_owner_path
      WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship'
        AND shipper_notification_state = 'pending' AND owner = ? AND document_path > ?
    ) SELECT document_path FROM candidate_paths ORDER BY document_path LIMIT 8`,
    'owner', 'drops/a/deliveryOrders/1', 'owner', 'drops/a/deliveryOrders/1');
    assert.match(
      ownerNotificationPlan,
      /commerce_delivery_orders_buyer_notifications_pending_owner_path \(owner=\? AND document_path>\?\)/,
    );
    assert.match(
      ownerNotificationPlan,
      /commerce_delivery_orders_shipper_notifications_pending_owner_path \(owner=\? AND document_path>\?\)/,
    );
    const ownerlessNotificationPlan = planDetails(db, `WITH candidate_paths AS (
      SELECT document_path FROM commerce_documents
        INDEXED BY commerce_delivery_orders_buyer_notifications_pending
      WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship'
        AND buyer_notification_state = 'pending' AND document_path > ?
      UNION
      SELECT document_path FROM commerce_documents
        INDEXED BY commerce_delivery_orders_shipper_notifications_pending
      WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship'
        AND shipper_notification_state = 'pending' AND document_path > ?
    ) SELECT document_path FROM candidate_paths ORDER BY document_path LIMIT 8`,
    'drops/a/deliveryOrders/1', 'drops/a/deliveryOrders/1');
    assert.match(
      ownerlessNotificationPlan,
      /commerce_delivery_orders_buyer_notifications_pending \(document_path>\?\)/,
    );
    assert.match(
      ownerlessNotificationPlan,
      /commerce_delivery_orders_shipper_notifications_pending \(document_path>\?\)/,
    );
    assert.match(planDetails(db, `SELECT document_path FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND drop_id = 'drop'
        AND pack_projection_state = 'pending' AND pack_projection_next_attempt_ms <= 1
      ORDER BY pack_projection_next_attempt_ms, document_path LIMIT 4`), /commerce_documents_pack_projection/);
    assert.match(planDetails(db, `SELECT document_path FROM commerce_documents
      WHERE document_kind = 'stripe_checkout'
        AND fulfillment_processor = 'cloudflare_queue_v1'
        AND status IN ('fulfillment_pending', 'processing')
        AND json_type(document_json, '$.updatedAt') IN ('integer', 'real')
        AND json_type(document_json, '$.lastStripeWebhookEventId') = 'text'
        AND CAST(json_extract(document_json, '$.updatedAt') AS INTEGER) <= 1
      ORDER BY CAST(json_extract(document_json, '$.updatedAt') AS INTEGER), document_path LIMIT 100`),
    /commerce_stripe_checkouts_reconciliation_due/);
  } finally {
    db.close();
  }
});

test('Commerce baseline rejects root identity subjects and preserves nested snapshots', () => {
  const db = database();
  try {
    const document = {
      authSubject: 'anon:subject',
      owner: 'anonymous:anon:subject',
      ownerKind: 'anonymous',
      snapshot: { uid: 'historical-subject' },
      status: 'created',
    };
    db.prepare(`INSERT INTO commerce_documents (
      document_path, document_kind, drop_id, document_id, document_json,
      version, create_time, update_time
    ) VALUES (?, 'stripe_checkout', 'drop', 'session', ?, 1, 'created', 'updated')`)
      .run('drops/drop/stripeCheckouts/session', JSON.stringify(document));
    assert.equal(
      JSON.parse(String(db.prepare(`SELECT document_json FROM commerce_documents
        WHERE document_path = 'drops/drop/stripeCheckouts/session'`).get()!.document_json)).snapshot.uid,
      'historical-subject',
    );
    assert.throws(() => db.prepare(`UPDATE commerce_documents
      SET document_json = json_set(document_json, '$.uid', 'subject')
      WHERE document_path = 'drops/drop/stripeCheckouts/session'`).run(),
    /noncanonical identity data/);
  } finally {
    db.close();
  }
});
