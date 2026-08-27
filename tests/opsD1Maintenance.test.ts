import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  assertOpsD1Integrity,
  buildSetReadyNotificationsPausedSql,
  parseReadyNotificationsControl,
  validateReadyNotificationCursorPath,
  type OpsD1IntegrityInput,
} from '../scripts/shared/opsD1Maintenance.ts';
import {
  parseReadyNotificationsControlArgs,
  runReadyNotificationsControl,
} from '../scripts/ops/readyNotificationsControl.ts';
import {
  parseRevealSubmissionsControl,
  parseRevealSubmissionsControlArgs,
  runRevealSubmissionsControl,
  type RevealSubmissionsControlDependencies,
} from '../scripts/ops/revealSubmissionsControl.ts';

const migrationSql = [
  '0001_ops_state.sql',
  '0002_profiles.sql',
  '0003_profiles_d1_final.sql',
  '0004_profile_integrity.sql',
  '0005_profile_write_safety.sql',
  '0006_wallet_sessions.sql',
  '0007_wallet_sessions_d1_only.sql',
  '0008_reveal_submissions.sql',
  '0009_reveal_submissions_d1_only.sql',
  '0010_reveal_submissions_baseline_index.sql',
  '0011_staff_wallet_auth.sql',
  '0012_anonymous_auth.sql',
  '0013_remove_firebase_auth_fallback.sql',
  '0014_auth_subject_bridge.sql',
  '0015_auth_subject_cutover.sql',
  '0016_remove_migration_controls.sql',
  '0017_auth_wallet_bindings.sql',
]
  .map((name) => readFileSync(
    new URL(`../cloud/workers/api/ops-migrations/${name}`, import.meta.url),
    'utf8',
  ))
  .join('\n');

const removeMigrationControlsSql = readFileSync(
  new URL('../cloud/workers/api/ops-migrations/0016_remove_migration_controls.sql', import.meta.url),
  'utf8',
);

const authWalletBindingsSql = readFileSync(
  new URL('../cloud/workers/api/ops-migrations/0017_auth_wallet_bindings.sql', import.meta.url),
  'utf8',
);

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql);
  return db;
}

function queryRows(db: DatabaseSync, sql: string) {
  return db.prepare(sql).all().map((row) => ({ ...row }));
}

const applicationSchemaQuery = `SELECT name, type, tbl_name, sql
FROM sqlite_schema
WHERE
  name NOT LIKE 'sqlite_%' AND
  name NOT GLOB '_cf_*' AND
  name <> 'd1_migrations'
ORDER BY name`;

function controlRow(overrides: Record<string, unknown> = {}) {
  return {
    control_key: 'ready_notifications',
    paused: 0,
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
      authProviderRetirement: queryRows(db, 'SELECT * FROM auth_provider_retirement'),
      authProviderRetirementColumns: queryRows(db, 'PRAGMA table_info(auth_provider_retirement)'),
      anonymousAuthSessionColumns: queryRows(db, 'PRAGMA table_info(anonymous_auth_sessions)'),
      anonymousAuthSessionCounts: queryRows(db, 'SELECT COUNT(*) AS anonymous_auth_session_count FROM anonymous_auth_sessions'),
      anonymousAuthSessionExpiryIndexColumns: queryRows(db, 'PRAGMA index_info(anonymous_auth_sessions_expires_at_ms)'),
      anonymousAuthSessionSubjectIndexColumns: queryRows(db, 'PRAGMA index_info(anonymous_auth_sessions_auth_subject)'),
      controls: queryRows(db, 'SELECT * FROM worker_controls ORDER BY control_key'),
      expiryIndexColumns: queryRows(db, 'PRAGMA index_info(rate_limit_buckets_expires_at_ms)'),
      foreignKeyCheck: queryRows(db, 'PRAGMA foreign_key_check'),
      migrations: [
        { name: '0001_ops_state.sql' },
        { name: '0002_profiles.sql' },
        { name: '0003_profiles_d1_final.sql' },
        { name: '0004_profile_integrity.sql' },
        { name: '0005_profile_write_safety.sql' },
        { name: '0006_wallet_sessions.sql' },
        { name: '0007_wallet_sessions_d1_only.sql' },
        { name: '0008_reveal_submissions.sql' },
        { name: '0009_reveal_submissions_d1_only.sql' },
        { name: '0010_reveal_submissions_baseline_index.sql' },
        { name: '0011_staff_wallet_auth.sql' },
        { name: '0012_anonymous_auth.sql' },
        { name: '0013_remove_firebase_auth_fallback.sql' },
        { name: '0014_auth_subject_bridge.sql' },
        { name: '0015_auth_subject_cutover.sql' },
        { name: '0016_remove_migration_controls.sql' },
        { name: '0017_auth_wallet_bindings.sql' },
      ],
      profileAddressColumns: queryRows(db, 'PRAGMA table_info(profile_addresses)'),
      profileCounts: queryRows(db, `SELECT
        (SELECT COUNT(*) FROM profiles) AS profile_count,
        (SELECT COUNT(*) FROM profile_addresses) AS profile_address_count`),
      profileColumns: queryRows(db, 'PRAGMA table_info(profiles)'),
      quickCheck: queryRows(db, 'PRAGMA quick_check'),
      rateLimitBucketColumns: queryRows(db, 'PRAGMA table_info(rate_limit_buckets)'),
      revealSubmissionColumns: queryRows(db, 'PRAGMA table_info(reveal_submissions)'),
      revealSubmissionBaselineIndexColumns: queryRows(
        db,
        'PRAGMA index_info(reveal_submissions_status_created_at_ms)',
      ),
      revealSubmissionCounts: queryRows(db, `SELECT
        (SELECT COUNT(*) FROM reveal_submissions) AS reveal_submission_count,
        (SELECT COUNT(*)
          FROM reveal_submissions AS submission
          JOIN reveal_submission_storage_control AS control ON control.singleton = 1
          WHERE
            submission.status = 'confirmed' AND
            submission.created_at_ms <= control.cutover_at_ms
        ) AS reveal_submission_cutover_count`),
      revealSubmissionStorageControl: queryRows(db, 'SELECT * FROM reveal_submission_storage_control'),
      revealSubmissionStorageControlColumns: queryRows(db, 'PRAGMA table_info(reveal_submission_storage_control)'),
      schema: queryRows(db, applicationSchemaQuery),
      tableList: queryRows(db, `SELECT name, type, strict
        FROM pragma_table_list
        WHERE
          schema = 'main' AND
          name IN ('auth_provider_retirement', 'anonymous_auth_sessions', 'auth_wallet_bindings', 'profile_addresses', 'profiles', 'rate_limit_buckets', 'reveal_submission_storage_control', 'reveal_submissions', 'staff_auth_challenges', 'staff_auth_sessions', 'worker_controls')
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

test('ops migration creates strict state tables, seed, and expiry index', () => {
  const db = database();
  try {
    const controls = queryRows(
      db,
      'SELECT * FROM worker_controls ORDER BY control_key',
    );
    assert.deepEqual(controls, [controlRow()]);
    const tables = queryRows(
      db,
      "SELECT name, strict FROM pragma_table_list WHERE name IN ('auth_provider_retirement', 'anonymous_auth_sessions', 'auth_wallet_bindings', 'profile_addresses', 'profiles', 'worker_controls', 'rate_limit_buckets', 'reveal_submission_storage_control', 'reveal_submissions', 'staff_auth_challenges', 'staff_auth_sessions') ORDER BY name",
    );
    assert.deepEqual(tables, [
      { name: 'anonymous_auth_sessions', strict: 1 },
      { name: 'auth_provider_retirement', strict: 1 },
      { name: 'auth_wallet_bindings', strict: 1 },
      { name: 'profile_addresses', strict: 1 },
      { name: 'profiles', strict: 1 },
      { name: 'rate_limit_buckets', strict: 1 },
      { name: 'reveal_submission_storage_control', strict: 1 },
      { name: 'reveal_submissions', strict: 1 },
      { name: 'staff_auth_challenges', strict: 1 },
      { name: 'staff_auth_sessions', strict: 1 },
      { name: 'worker_controls', strict: 1 },
    ]);
    assert.deepEqual(
      queryRows(
        db,
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'rate_limit_buckets_expires_at_ms'",
      ),
      [{ name: 'rate_limit_buckets_expires_at_ms' }],
    );
    assert.doesNotThrow(() => assertOpsD1Integrity(integrityInput()));
  } finally {
    db.close();
  }
});

test('final Ops cutover preserves sessions, reveals, and retirement timestamps exactly', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql
    .replace(removeMigrationControlsSql, '')
    .replace(authWalletBindingsSql, ''));
  const insertWallet = db.prepare(`INSERT INTO wallet_sessions (
    auth_subject, wallet, expires_at_ms, updated_at_ms, wallet_revision,
    reconcile_lease_id, reconcile_lease_expires_at_ms
  ) VALUES (?, '11111111111111111111111111111111', 253402300799999, ?, ?, ?, ?)`);
  for (let index = 0; index < 1_205; index += 1) {
    const leased = index === 1_204;
    insertWallet.run(
      `subject-${index}`,
      1_700_000_000_000 + index,
      index + 1,
      leased ? '00000000-0000-4000-8000-000000000001' : null,
      leased ? 1_700_000_120_000 : null,
    );
  }
  const insertAuth = db.prepare(`INSERT INTO anonymous_auth_sessions (
    session_id, secret_hash, auth_subject, origin_hostname,
    created_at_ms, refreshed_at_ms, expires_at_ms
  ) VALUES (?, ?, ?, 'mons.shop', 1, 1, 1000)`);
  for (let index = 0; index < 55; index += 1) {
    const suffix = String(index).padStart(12, '0');
    insertAuth.run(
      `10000000-0000-4000-8000-${suffix}`,
      index.toString(16).padStart(64, '0'),
      `anon:10000000-0000-4000-8000-${suffix}`,
    );
  }
  const insertReveal = db.prepare(`INSERT INTO reveal_submissions (
    drop_id, box_asset_id, schema_version, owner_wallet, signature,
    recent_blockhash, blockhash_context_slot, dude_ids_json,
    reservation_id, status, revision, created_at_ms, updated_at_ms, confirmed_at_ms
  ) VALUES ('baseline', ?, 1, ?, ?, ?, 1, '[1]', ?, 'confirmed', 1, 1, 1, 1)`);
  for (let index = 0; index < 14; index += 1) {
    insertReveal.run(
      String(index).padStart(32, '0'),
      '11111111111111111111111111111111',
      '2'.repeat(64),
      '3'.repeat(32),
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
  }
  const walletBefore = queryRows(db, `SELECT
    auth_subject,
    wallet,
    updated_at_ms,
    wallet_revision AS revision,
    reconcile_lease_id,
    reconcile_lease_expires_at_ms
    FROM wallet_sessions
    ORDER BY auth_subject`);
  const authBefore = queryRows(db, 'SELECT * FROM anonymous_auth_sessions ORDER BY session_id');
  const revealBefore = queryRows(db, 'SELECT * FROM reveal_submissions ORDER BY box_asset_id');
  const controlBefore = queryRows(db, `SELECT singleton, paused, revision, created_at_ms, updated_at_ms, cutover_at_ms
    FROM reveal_submission_storage_control`);
  const retirementBefore = queryRows(db, `SELECT revision, created_at_ms, updated_at_ms,
    firebase_disabled_at_ms FROM anonymous_auth_control`)[0];
  db.exec(removeMigrationControlsSql);
  db.exec(authWalletBindingsSql);
  assert.deepEqual(queryRows(db, 'SELECT * FROM auth_wallet_bindings ORDER BY auth_subject'), walletBefore);
  assert.equal(queryRows(db, "SELECT name FROM sqlite_schema WHERE name = 'wallet_sessions'").length, 0);
  assert.deepEqual(queryRows(db, 'SELECT * FROM anonymous_auth_sessions ORDER BY session_id'), authBefore);
  assert.deepEqual(queryRows(db, 'SELECT * FROM reveal_submissions ORDER BY box_asset_id'), revealBefore);
  assert.deepEqual(queryRows(db, 'SELECT * FROM reveal_submission_storage_control'), controlBefore);
  assert.deepEqual(queryRows(db, 'SELECT * FROM auth_provider_retirement'), [{
    singleton: 1,
    revision: retirementBefore.revision,
    created_at_ms: retirementBefore.created_at_ms,
    updated_at_ms: retirementBefore.updated_at_ms,
    legacy_provider_disabled_at_ms: retirementBefore.firebase_disabled_at_ms,
  }]);
  assert.equal(queryRows(db, `SELECT name FROM sqlite_schema
    WHERE name IN ('profile_storage_control', 'wallet_session_storage_control', 'anonymous_auth_control')`).length, 0);
  db.close();
});

test('ops migration enforces control and rate-limit invariants', () => {
  const db = database();
  const insertBucket = db.prepare(`INSERT INTO rate_limit_buckets (
    scope, subject_hash, schema_version, cluster, owner_wallet, receipt_asset_id,
    window_started_at_ms, expires_at_ms, request_count, updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  try {
    insertBucket.run(
      'caller',
      'a'.repeat(64),
      2,
      null,
      null,
      null,
      1_000,
      601_000,
      60,
      2_000,
    );
    insertBucket.run(
      'asset',
      'b'.repeat(64),
      2,
      'mainnet-beta',
      'owner-wallet',
      'receipt-asset',
      2_000,
      602_000,
      20,
      2_000,
    );
    assert.throws(() =>
      insertBucket.run(
        'caller',
        'A'.repeat(64),
        2,
        null,
        null,
        null,
        3_000,
        603_000,
        1,
        3_000,
      ),
    );
    assert.throws(() =>
      insertBucket.run(
        'asset',
        'c'.repeat(64),
        2,
        null,
        null,
        null,
        3_000,
        603_000,
        1,
        3_000,
      ),
    );
    assert.throws(() =>
      insertBucket.run(
        'caller',
        'd'.repeat(64),
        2,
        'devnet',
        'owner',
        'asset',
        3_000,
        603_000,
        1,
        3_000,
      ),
    );
    assert.throws(() =>
      insertBucket.run(
        'caller',
        'e'.repeat(64),
        2,
        null,
        null,
        null,
        3_000,
        603_001,
        1,
        3_000,
      ),
    );
    assert.throws(() =>
      db.exec(`INSERT INTO worker_controls VALUES (
        'other', 0, NULL, 1, 0, 0, NULL
      )`),
    );
    assert.throws(() =>
      db.exec(`UPDATE worker_controls SET paused = 'false'`),
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'profile_storage_control'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'wallet_session_storage_control'").get().count, 0);
    db.exec(`INSERT INTO profiles VALUES (
      '11111111111111111111111111111111', NULL, 1, 1
    )`);
    db.exec(`INSERT INTO profile_addresses VALUES (
      '11111111111111111111111111111111',
      'AbCdEfGhIjKlMnOpQrSt',
      'cipher', 'US', 'US', 'hint', NULL, NULL, 1, 1
    )`);
    assert.doesNotThrow(() =>
      db.exec(`INSERT INTO profile_addresses VALUES (
        '11111111111111111111111111111111',
        'AbCdEfGhIjKlMnOpQrSt',
        'cipher', 'US', 'US', 'hint', NULL, NULL, 2, 2
      )`),
    );
    assert.throws(() =>
      db.exec(`INSERT INTO profile_addresses VALUES (
        '11111111111111111111111111111111',
        'AbCdEfGhIjKlMnOpQrSt',
        'changed', 'US', 'US', 'hint', NULL, NULL, 2, 2
      )`),
    );
    assert.throws(() => db.exec(`UPDATE profile_addresses SET encrypted = 'changed'`));
    assert.throws(() => db.exec(`DELETE FROM profile_addresses`));
    assert.throws(() => db.exec(`DELETE FROM profiles`));
    assert.throws(() => db.exec('UPDATE auth_provider_retirement SET revision = revision + 1'));
    assert.throws(() => db.exec('DELETE FROM auth_provider_retirement'));
  } finally {
    db.close();
  }
});

test('ops D1 integrity requires exact migrations, schema, quick check, and singleton', () => {
  const healthy = integrityInput();
  const report = assertOpsD1Integrity(healthy);
  assert.deepEqual(report, {
    authProviderRetirement: {
      revision: 2,
      createdAtMs: 0,
      updatedAtMs: report.authProviderRetirement.updatedAtMs,
      legacyProviderDisabledAtMs: report.authProviderRetirement.legacyProviderDisabledAtMs,
    },
    anonymousAuthSessionCount: 0,
    profileAddressCount: 0,
    profileCount: 0,
    readyNotifications: {
      controlKey: 'ready_notifications',
      paused: false,
      cursorPath: null,
      revision: 1,
      createdAtMs: 0,
      updatedAtMs: 0,
      cursorUpdatedAtMs: null,
    },
    revealSubmissionCount: 0,
    revealSubmissionStorage: {
      paused: false,
      revision: 3,
      updatedAtMs: report.revealSubmissionStorage.updatedAtMs,
      cutoverAtMs: report.revealSubmissionStorage.cutoverAtMs,
    },
    authWalletBindingCount: 0,
  });
  assert.ok(report.revealSubmissionStorage.updatedAtMs > 0);
  assert.ok(report.authProviderRetirement.updatedAtMs > 0);
  assert.equal(
    report.authProviderRetirement.legacyProviderDisabledAtMs,
    report.authProviderRetirement.updatedAtMs,
  );
  assert.equal(
    report.revealSubmissionStorage.cutoverAtMs,
    report.revealSubmissionStorage.updatedAtMs,
  );
  assert.throws(
    () => assertOpsD1Integrity(healthy, {
      profileAddressCount: 1,
      profileCount: 1,
      revealSubmissionCutoverCount: 1,
      authWalletBindingCount: 1,
    }),
    /cutover baseline/,
  );
  assert.throws(
    () => assertOpsD1Integrity(healthy, {
      profileAddressCount: 0,
      profileCount: 0,
      revealSubmissionCutoverCount: 1,
      authWalletBindingCount: 0,
    }),
    /reveal-submission count is below/,
  );
  assert.throws(
    () => assertOpsD1Integrity(integrityInput({
      revealSubmissionCounts: [{
        reveal_submission_count: 14,
        reveal_submission_cutover_count: 0,
      }],
    }), {
      profileAddressCount: 0,
      profileCount: 0,
      revealSubmissionCutoverCount: 1,
      authWalletBindingCount: 0,
    }),
    /reveal-submission count is below/,
  );
  assert.throws(
    () => assertOpsD1Integrity(integrityInput({ migrations: [] })),
    /migrations/,
  );
  assert.throws(
    () => assertOpsD1Integrity(integrityInput({
      authProviderRetirement: [{
        singleton: 1,
        revision: 1,
        created_at_ms: 0,
        updated_at_ms: 0,
        legacy_provider_disabled_at_ms: 1,
      }],
    })),
    /timestamps are invalid/,
  );
  assert.throws(
    () => assertOpsD1Integrity(integrityInput({ foreignKeyCheck: [{ table: 'profile_addresses' }] })),
    /foreign_key_check/,
  );
  assert.throws(
    () => assertOpsD1Integrity(integrityInput({ schema: [] })),
    /schema/,
  );
  assert.throws(
    () =>
      assertOpsD1Integrity(
        integrityInput({
          schema: [
            ...healthy.schema,
            { name: 'unexpected_view', type: 'view', tbl_name: 'unexpected_view' },
          ],
        }),
      ),
    /schema/,
  );
  assert.throws(
    () =>
      assertOpsD1Integrity(
        integrityInput({
          schema: healthy.schema.map((row) =>
            row.name === 'worker_controls'
              ? {
                  ...row,
                  sql: String(row.sql).replace(
                    'paused IN (0, 1)',
                    'paused IN (0, 1, 2)',
                  ),
                }
              : row
          ),
        }),
      ),
    /schema/,
  );
  assert.throws(
    () =>
      assertOpsD1Integrity(
        integrityInput({
          schema: healthy.schema.map((row) =>
            row.name === 'rate_limit_buckets_expires_at_ms'
              ? { ...row, tbl_name: 'worker_controls' }
              : row
          ),
        }),
      ),
    /schema/,
  );
  assert.throws(
    () =>
      assertOpsD1Integrity(
        integrityInput({
          tableList: healthy.tableList.map((row) =>
            row.name === 'worker_controls' ? { ...row, strict: 0 } : row
          ),
        }),
      ),
    /strict flag/,
  );
  assert.throws(
    () =>
      assertOpsD1Integrity(
        integrityInput({
          workerControlColumns: healthy.workerControlColumns.map((row) =>
            row.name === 'paused' ? { ...row, type: 'TEXT' } : row
          ),
        }),
      ),
    /worker_controls columns/,
  );
  assert.throws(
    () =>
      assertOpsD1Integrity(
        integrityInput({
          rateLimitBucketColumns: healthy.rateLimitBucketColumns.map((row) =>
            row.name === 'subject_hash' ? { ...row, pk: 1 } : row
          ),
        }),
      ),
    /primary-key position/,
  );
  assert.throws(
    () =>
      assertOpsD1Integrity(
        integrityInput({
          expiryIndexColumns: [
            { seqno: 0, cid: 9, name: 'updated_at_ms' },
          ],
        }),
      ),
    /expiry index columns/,
  );
  assert.throws(
    () => assertOpsD1Integrity(integrityInput({ quickCheck: [] })),
    /quick_check/,
  );
  assert.throws(
    () => assertOpsD1Integrity(integrityInput({ controls: [] })),
    /exactly one worker control/,
  );
  assert.throws(
    () =>
      parseReadyNotificationsControl(
        controlRow({ paused: 2 }),
      ),
    /paused state/,
  );
});

test('pause and resume always advance the D1 control revision', () => {
  const db = database();
  try {
    const firstPause = parseReadyNotificationsControl(
      db.prepare(buildSetReadyNotificationsPausedSql(true, 1, 1_000)).get()!,
    );
    assert.equal(
      db.prepare(buildSetReadyNotificationsPausedSql(false, 1, 1_500)).get(),
      undefined,
    );
    const secondPause = parseReadyNotificationsControl(
      db.prepare(buildSetReadyNotificationsPausedSql(true, 2, 2_000)).get()!,
    );
    const resume = parseReadyNotificationsControl(
      db.prepare(buildSetReadyNotificationsPausedSql(false, 3, 3_000)).get()!,
    );
    assert.deepEqual(
      [firstPause.revision, secondPause.revision, resume.revision],
      [2, 3, 4],
    );
    assert.deepEqual(
      [firstPause.paused, secondPause.paused, resume.paused],
      [true, true, false],
    );
  } finally {
    db.close();
  }
});

test('ready-notification operator arguments guard every mutation', () => {
  assert.deepEqual(parseReadyNotificationsControlArgs(['status']), {
    command: 'status',
    write: false,
  });
  assert.deepEqual(
    parseReadyNotificationsControlArgs(['pause', '--write']),
    { command: 'pause', write: true },
  );
  assert.deepEqual(
    parseReadyNotificationsControlArgs(['resume', '--write']),
    { command: 'resume', write: true },
  );
  assert.throws(
    () => parseReadyNotificationsControlArgs(['import-firestore', '--write']),
    /Expected status, pause, or resume/,
  );
  assert.throws(
    () => parseReadyNotificationsControlArgs(['pause']),
    /requires --write/,
  );
  assert.throws(
    () => parseReadyNotificationsControlArgs(['status', '--write']),
    /read-only/,
  );
  assert.throws(
    () => parseReadyNotificationsControlArgs(['pause', '--write', '--write']),
    /only be provided once/,
  );
});

test('ready-notification cursor validation remains strict', () => {
  assert.equal(
    validateReadyNotificationCursorPath(
      'drops/little_swag_hoodies/deliveryOrders/9007199254740991',
    ),
    'drops/little_swag_hoodies/deliveryOrders/9007199254740991',
  );
  assert.throws(
    () => validateReadyNotificationCursorPath('drops/Card_NFT_2/deliveryOrders/19'),
    /canonical delivery-order path/,
  );
});

test('operator validates D1 control before pause or resume mutation', async () => {
  let mutations = 0;
  const baseControl = parseReadyNotificationsControl(controlRow());
  await assert.rejects(
    runReadyNotificationsControl(
      { command: 'pause', write: true },
      {
        nowMs: () => 1_700_000_000_000,
        readControl: () => parseReadyNotificationsControl(controlRow({
          cursor_path: 'drops/Card_NFT_2/deliveryOrders/7',
          cursor_updated_at_ms: 1,
          updated_at_ms: 1,
        })),
        setPaused: () => {
          mutations += 1;
          return baseControl;
        },
      },
    ),
    /canonical delivery-order path/,
  );
  assert.equal(mutations, 0);
});

test('reveal-submission operator exposes only forward D1 controls', async () => {
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
  assert.throws(
    () => parseRevealSubmissionsControlArgs(['import-firestore', '--write']),
    /Expected status, pause, or resume/,
  );
  assert.throws(
    () => parseRevealSubmissionsControlArgs(['cutover', '--write']),
    /Expected status, pause, or resume/,
  );
  assert.throws(
    () => parseRevealSubmissionsControlArgs(['status', '--write']),
    /read-only/,
  );
  const baseControl = parseRevealSubmissionsControl({
    singleton: 1,
    paused: 0,
    revision: 4,
    updated_at_ms: 1_000,
    cutover_at_ms: 500,
  });
  assert.throws(
    () => parseRevealSubmissionsControl({
      singleton: 1,
      paused: 2,
      revision: 1,
      updated_at_ms: 0,
      cutover_at_ms: null,
    }),
    /invalid/,
  );
  const calls: unknown[] = [];
  const dependencies: RevealSubmissionsControlDependencies = {
    nowMs: () => 2_000,
    readControl: () => baseControl,
    readSubmissionCount: () => 14,
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
    submissionCount: 14,
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
