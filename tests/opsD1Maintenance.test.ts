import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  assertOpsD1Integrity,
  parseReadyNotificationCursor,
  validateReadyNotificationCursorPath,
  type OpsD1IntegrityInput,
} from '../scripts/shared/opsD1Maintenance.ts';
import {
  parseRevealSubmissionsControl,
  parseRevealSubmissionsControlArgs,
  runRevealSubmissionsControl,
  type RevealSubmissionsControlDependencies,
} from '../scripts/ops/revealSubmissionsControl.ts';

const schemaSql = [
  '0001_current_schema.sql',
  '0002_reveal_submission_write_fence.sql',
  '0003_remove_ready_notification_pause.sql',
  '0004_repair_ready_notification_cursor.sql',
].map((name) => readFileSync(
  new URL(`../cloud/workers/api/ops-migrations/${name}`, import.meta.url),
  'utf8',
)).join('\n');

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  return db;
}

test('pause-removal migration preserves the ready-notification cursor exactly', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const name of ['0001_current_schema.sql', '0002_reveal_submission_write_fence.sql']) {
      db.exec(readFileSync(
        new URL(`../cloud/workers/api/ops-migrations/${name}`, import.meta.url),
        'utf8',
      ));
    }
    db.exec(`UPDATE worker_controls
      SET
        paused = 1,
        cursor_path = 'drops/card_nft_2/deliveryOrders/7',
        revision = 9,
        updated_at_ms = 2_000,
        cursor_updated_at_ms = 2_000`);
    db.exec(readFileSync(
      new URL('../cloud/workers/api/ops-migrations/0003_remove_ready_notification_pause.sql', import.meta.url),
      'utf8',
    ));
    assert.deepEqual(queryRows(db, 'SELECT * FROM worker_controls'), [{
      control_key: 'ready_notifications',
      cursor_path: 'drops/card_nft_2/deliveryOrders/7',
      revision: 9,
      created_at_ms: 0,
      updated_at_ms: 2_000,
      cursor_updated_at_ms: 2_000,
    }]);
    assert.equal(queryRows(db, `SELECT name FROM pragma_table_info('worker_controls')
      WHERE name = 'paused'`).length, 0);
  } finally {
    db.close();
  }
});

test('cursor repair migration recreates only a missing singleton', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schemaSql);
    const preserved = queryRows(db, 'SELECT * FROM worker_controls');
    db.exec('DELETE FROM worker_controls');
    db.exec(readFileSync(
      new URL('../cloud/workers/api/ops-migrations/0004_repair_ready_notification_cursor.sql', import.meta.url),
      'utf8',
    ));
    assert.deepEqual(queryRows(db, 'SELECT * FROM worker_controls'), [controlRow()]);
    db.exec(readFileSync(
      new URL('../cloud/workers/api/ops-migrations/0004_repair_ready_notification_cursor.sql', import.meta.url),
      'utf8',
    ));
    assert.deepEqual(queryRows(db, 'SELECT * FROM worker_controls'), [controlRow()]);
    assert.equal(preserved.length, 1);
  } finally {
    db.close();
  }
});

function queryRows(db: DatabaseSync, sql: string) {
  return db.prepare(sql).all().map((row) => ({ ...row }));
}

function controlRow(overrides: Record<string, unknown> = {}) {
  return {
    control_key: 'ready_notifications',
    cursor_path: null,
    revision: 1,
    created_at_ms: 0,
    updated_at_ms: 0,
    cursor_updated_at_ms: null,
    ...overrides,
  };
}

function integrityInput(
  overrides: Partial<OpsD1IntegrityInput> = {},
): OpsD1IntegrityInput {
  const db = database();
  try {
    return {
      anonymousAuthSessionColumns: queryRows(db, 'PRAGMA table_info(anonymous_auth_sessions)'),
      anonymousAuthSessionCounts: queryRows(db, 'SELECT COUNT(*) AS anonymous_auth_session_count FROM anonymous_auth_sessions'),
      anonymousAuthSessionExpiryIndexColumns: queryRows(db, 'PRAGMA index_info(anonymous_auth_sessions_expires_at_ms)'),
      anonymousAuthSessionSubjectIndexColumns: queryRows(db, 'PRAGMA index_info(anonymous_auth_sessions_auth_subject)'),
      controls: queryRows(db, 'SELECT * FROM worker_controls ORDER BY control_key'),
      expiryIndexColumns: queryRows(db, 'PRAGMA index_info(rate_limit_buckets_expires_at_ms)'),
      foreignKeyCheck: queryRows(db, 'PRAGMA foreign_key_check'),
      migrations: [
        { name: '0001_current_schema.sql' },
        { name: '0002_reveal_submission_write_fence.sql' },
        { name: '0003_remove_ready_notification_pause.sql' },
        { name: '0004_repair_ready_notification_cursor.sql' },
      ],
      profileAddressColumns: queryRows(db, 'PRAGMA table_info(profile_addresses)'),
      profileCounts: queryRows(db, `SELECT
        (SELECT COUNT(*) FROM profiles) AS profile_count,
        (SELECT COUNT(*) FROM profile_addresses) AS profile_address_count`),
      profileColumns: queryRows(db, 'PRAGMA table_info(profiles)'),
      quickCheck: queryRows(db, 'PRAGMA quick_check'),
      rateLimitBucketColumns: queryRows(db, 'PRAGMA table_info(rate_limit_buckets)'),
      revealSubmissionColumns: queryRows(db, 'PRAGMA table_info(reveal_submissions)'),
      revealSubmissionStatusIndexColumns: queryRows(
        db,
        'PRAGMA index_info(reveal_submissions_status_created_at_ms)',
      ),
      revealSubmissionCounts: queryRows(
        db,
        'SELECT COUNT(*) AS reveal_submission_count FROM reveal_submissions',
      ),
      revealSubmissionStorageControl: queryRows(db, 'SELECT * FROM reveal_submission_storage_control'),
      revealSubmissionStorageControlColumns: queryRows(db, 'PRAGMA table_info(reveal_submission_storage_control)'),
      schema: queryRows(db, `SELECT name, type, tbl_name, sql
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*'
        ORDER BY name`),
      tableList: queryRows(db, `SELECT name, type, strict
        FROM pragma_table_list
        WHERE schema = 'main' AND name IN (
          'anonymous_auth_sessions',
          'auth_wallet_bindings',
          'profile_addresses',
          'profiles',
          'rate_limit_buckets',
          'reveal_submission_storage_control',
          'reveal_submissions',
          'staff_auth_challenges',
          'staff_auth_sessions',
          'worker_controls'
        )
        ORDER BY name`),
      authWalletBindingColumns: queryRows(db, 'PRAGMA table_info(auth_wallet_bindings)'),
      authWalletBindingCounts: queryRows(db, 'SELECT COUNT(*) AS auth_wallet_binding_count FROM auth_wallet_bindings'),
      workerControlColumns: queryRows(db, 'PRAGMA table_info(worker_controls)'),
      ...overrides,
    };
  } finally {
    db.close();
  }
}

test('Ops baseline creates the exact current schema and active controls', () => {
  const db = database();
  try {
    assert.deepEqual(queryRows(db, 'SELECT * FROM worker_controls'), [controlRow()]);
    assert.deepEqual(queryRows(db, 'SELECT * FROM reveal_submission_storage_control'), [{
      singleton: 1,
      paused: 0,
      revision: 1,
      created_at_ms: 0,
      updated_at_ms: 0,
    }]);
    assert.doesNotThrow(() => assertOpsD1Integrity(integrityInput()));
  } finally {
    db.close();
  }
});

test('Ops baseline guards singleton controls and immutable records', () => {
  const db = database();
  try {
    assert.throws(() => db.exec('DELETE FROM reveal_submission_storage_control'));
    assert.throws(() => db.exec(`UPDATE reveal_submission_storage_control
      SET created_at_ms = 1, updated_at_ms = 1, revision = revision + 1`));
  } finally {
    db.close();
  }
});

test('Ops baseline enforces rate-limit, profile, and control invariants', () => {
  const db = database();
  const insertBucket = db.prepare(`INSERT INTO rate_limit_buckets (
    scope, subject_hash, schema_version, cluster, owner_wallet, receipt_asset_id,
    window_started_at_ms, expires_at_ms, request_count, updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  try {
    insertBucket.run('caller', 'a'.repeat(64), 2, null, null, null, 1_000, 601_000, 1, 1_000);
    insertBucket.run('asset', 'b'.repeat(64), 2, 'mainnet-beta', 'owner', 'asset', 2_000, 602_000, 1, 2_000);
    assert.throws(() =>
      insertBucket.run('caller', 'A'.repeat(64), 2, null, null, null, 3_000, 603_000, 1, 3_000));
    assert.throws(() =>
      insertBucket.run('asset', 'c'.repeat(64), 2, null, null, null, 3_000, 603_000, 1, 3_000));
    assert.throws(() =>
      insertBucket.run('caller', 'd'.repeat(64), 2, 'devnet', 'owner', 'asset', 3_000, 603_000, 1, 3_000));
    assert.throws(() =>
      insertBucket.run('caller', 'e'.repeat(64), 2, null, null, null, 3_000, 603_001, 1, 3_000));
    assert.throws(() => db.exec(`INSERT INTO worker_controls VALUES (
      'other', NULL, 1, 0, 0, NULL
    )`));
    assert.throws(() => db.exec(`UPDATE worker_controls SET paused = 'false'`));
    db.exec(`INSERT INTO profiles VALUES (
      '11111111111111111111111111111111', NULL, 1, 1
    )`);
    db.exec(`INSERT INTO profile_addresses VALUES (
      '11111111111111111111111111111111',
      'AbCdEfGhIjKlMnOpQrSt',
      'cipher', 'US', 'US', 'hint', NULL, NULL, 1, 1
    )`);
    assert.doesNotThrow(() => db.exec(`INSERT INTO profile_addresses VALUES (
      '11111111111111111111111111111111',
      'AbCdEfGhIjKlMnOpQrSt',
      'cipher', 'US', 'US', 'hint', NULL, NULL, 2, 2
    )`));
    assert.throws(() => db.exec(`INSERT INTO profile_addresses VALUES (
      '11111111111111111111111111111111',
      'AbCdEfGhIjKlMnOpQrSt',
      'changed', 'US', 'US', 'hint', NULL, NULL, 2, 2
    )`));
    assert.throws(() => db.exec(`UPDATE profile_addresses SET encrypted = 'changed'`));
    assert.throws(() => db.exec(`DELETE FROM profile_addresses`));
    assert.throws(() => db.exec(`DELETE FROM profiles`));
  } finally {
    db.close();
  }
});

test('Ops integrity rejects ledger, schema, and foreign-key drift', () => {
  const healthy = integrityInput();
  assert.throws(
    () => assertOpsD1Integrity(integrityInput({ migrations: [] })),
    /migrations/,
  );
  assert.throws(
    () => assertOpsD1Integrity(integrityInput({ schema: [] })),
    /schema/,
  );
  assert.throws(
    () => assertOpsD1Integrity(integrityInput({
      foreignKeyCheck: [{ table: 'profile_addresses' }],
    })),
    /foreign_key_check/,
  );
  assert.throws(() => assertOpsD1Integrity(integrityInput({
    schema: healthy.schema.map((row) => row.name === 'worker_controls'
      ? { ...row, sql: String(row.sql).replace('BETWEEN 1 AND 1500', 'BETWEEN 1 AND 1501') }
      : row),
  })), /schema/);
  assert.throws(() => assertOpsD1Integrity(integrityInput({
    schema: healthy.schema.map((row) => row.name === 'reveal_submission_insert_pause_guard'
      ? { ...row, sql: String(row.sql).replace('reveal submissions are paused', 'reveal  submissions are paused') }
      : row),
  })), /schema/);
  assert.throws(() => assertOpsD1Integrity(integrityInput({
    tableList: healthy.tableList.map((row) =>
      row.name === 'worker_controls' ? { ...row, strict: 0 } : row),
  })), /strict flag/);
  assert.throws(() => assertOpsD1Integrity(integrityInput({
    workerControlColumns: healthy.workerControlColumns.map((row) =>
      row.name === 'cursor_path' ? { ...row, type: 'INTEGER' } : row),
  })), /worker_controls columns/);
  assert.throws(() => assertOpsD1Integrity(integrityInput({
    rateLimitBucketColumns: healthy.rateLimitBucketColumns.map((row) =>
      row.name === 'subject_hash' ? { ...row, pk: 1 } : row),
  })), /primary-key position/);
  assert.throws(() => assertOpsD1Integrity(integrityInput({
    expiryIndexColumns: [{ seqno: 0, cid: 9, name: 'updated_at_ms' }],
  })), /expiry index columns/);
  assert.throws(() => assertOpsD1Integrity(integrityInput({ quickCheck: [] })), /quick_check/);
  assert.throws(() => assertOpsD1Integrity(integrityInput({ controls: [] })), /exactly one worker control/);
});

test('ready-notification cursor validation has no pause state', () => {
  assert.equal(
    validateReadyNotificationCursorPath('drops/little_swag_hoodies/deliveryOrders/7'),
    'drops/little_swag_hoodies/deliveryOrders/7',
  );
  assert.throws(
    () => validateReadyNotificationCursorPath('drops/Card_NFT_2/deliveryOrders/7'),
    /canonical delivery-order path/,
  );
  assert.deepEqual(parseReadyNotificationCursor(controlRow({
    cursor_path: 'drops/little_swag_hoodies/deliveryOrders/7',
    updated_at_ms: 1_000,
    cursor_updated_at_ms: 1_000,
  })), {
    controlKey: 'ready_notifications',
    cursorPath: 'drops/little_swag_hoodies/deliveryOrders/7',
    revision: 1,
    createdAtMs: 0,
    updatedAtMs: 1_000,
    cursorUpdatedAtMs: 1_000,
  });
});

test('reveal-submission controls expose status, pause, and resume only', async () => {
  assert.deepEqual(parseRevealSubmissionsControlArgs(['status']), {
    command: 'status',
    write: false,
  });
  assert.deepEqual(parseRevealSubmissionsControlArgs(['pause', '--write']), {
    command: 'pause',
    write: true,
  });
  assert.deepEqual(parseRevealSubmissionsControlArgs(['resume', '--write']), {
    command: 'resume',
    write: true,
  });
  assert.throws(() => parseRevealSubmissionsControlArgs(['replace', '--write']), /Expected status/);
  assert.throws(() => parseRevealSubmissionsControlArgs(['status', '--write']), /read-only/);

  const baseControl = parseRevealSubmissionsControl({
    singleton: 1,
    paused: 0,
    revision: 4,
    updated_at_ms: 1_000,
  });
  const calls: unknown[] = [];
  const dependencies: RevealSubmissionsControlDependencies = {
    nowMs: () => 2_000,
    readControl: () => baseControl,
    readSubmissionCount: () => 17,
    setPaused: (paused, revision, nowMs) => {
      calls.push([paused, revision, nowMs]);
      return {
        ...baseControl,
        paused,
        revision: revision + 1,
        updatedAtMs: nowMs,
      };
    },
  };
  assert.deepEqual(await runRevealSubmissionsControl(
    { command: 'status', write: false },
    dependencies,
  ), {
    control: baseControl,
    submissionCount: 17,
  });
  assert.equal((await runRevealSubmissionsControl(
    { command: 'pause', write: true },
    dependencies,
  )).control.paused, true);
  assert.equal((await runRevealSubmissionsControl(
    { command: 'resume', write: true },
    dependencies,
  )).control.paused, false);
  assert.deepEqual(calls, [
    [true, 4, 2_000],
    [false, 4, 2_000],
  ]);
});
