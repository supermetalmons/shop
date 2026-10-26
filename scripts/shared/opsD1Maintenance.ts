import { createD1MaintenanceRunner, type D1MaintenanceQueryBatch } from './d1MaintenanceRunner.ts';
import { OPS_EXPIRY_CLEANUP_STATEMENTS } from '../../shared/opsExpiryCleanupSql.ts';
import { sqlSchemaFingerprint } from './sqlSchemaFingerprint.ts';
import { readDatabaseSchemaManifest } from './databaseSchemaManifest.ts';

const schemaManifest = readDatabaseSchemaManifest('ops');
const OPS_D1_MIGRATIONS = schemaManifest.migrations.map((migration) => migration.name);

export type OpsD1Row = Record<string, unknown>;

function expiryCleanupExplainSql(
  statement: (typeof OPS_EXPIRY_CLEANUP_STATEMENTS)[keyof typeof OPS_EXPIRY_CLEANUP_STATEMENTS],
): string {
  const parameters = [0, statement.limit];
  let parameterIndex = 0;
  const sql = statement.sql.replace(/\?/g, () => {
    const value = parameters[parameterIndex];
    parameterIndex += 1;
    if (value === undefined) {
      throw new Error('Ops expiry cleanup SQL has unexpected parameters.');
    }
    return String(value);
  });
  if (parameterIndex !== parameters.length) {
    throw new Error('Ops expiry cleanup SQL has unexpected parameters.');
  }
  return `EXPLAIN QUERY PLAN ${sql}`;
}

function expiryCleanupQueryPlanSpec(
  statement: (typeof OPS_EXPIRY_CLEANUP_STATEMENTS)[keyof typeof OPS_EXPIRY_CLEANUP_STATEMENTS],
  label: string,
) {
  return {
    indexName: statement.indexName,
    label,
    sql: expiryCleanupExplainSql(statement),
  };
}

export const OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS = {
  miNoteAuthSessions: expiryCleanupQueryPlanSpec(OPS_EXPIRY_CLEANUP_STATEMENTS.miNoteAuthSessions, 'Mi Note session cleanup'),
  miNoteAuthChallenges: expiryCleanupQueryPlanSpec(OPS_EXPIRY_CLEANUP_STATEMENTS.miNoteAuthChallenges, 'Mi Note challenge cleanup'),
  anonymousAuthSessions: expiryCleanupQueryPlanSpec(
    OPS_EXPIRY_CLEANUP_STATEMENTS.anonymousAuthSessions,
    'anonymous-auth session cleanup',
  ),
  staffAuthSessions: expiryCleanupQueryPlanSpec(
    OPS_EXPIRY_CLEANUP_STATEMENTS.staffAuthSessions,
    'staff-auth session cleanup',
  ),
  staffAuthChallenges: expiryCleanupQueryPlanSpec(
    OPS_EXPIRY_CLEANUP_STATEMENTS.staffAuthChallenges,
    'staff-auth challenge cleanup',
  ),
  rateLimitBuckets: expiryCleanupQueryPlanSpec(
    OPS_EXPIRY_CLEANUP_STATEMENTS.rateLimitBuckets,
    'rate-limit bucket cleanup',
  ),
} as const;

type OpsD1ExpiryCleanupQueryPlans = {
  [Key in keyof typeof OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS]: OpsD1Row[];
};

export type RevealSubmissionStorageControl = {
  paused: boolean;
  revision: number;
  updatedAtMs: number;
};

export type OpsD1IntegrityInput = {
  anonymousAuthSessionColumns: OpsD1Row[];
  anonymousAuthSessionCounts: OpsD1Row[];
  anonymousAuthSessionExpiryIndexColumns: OpsD1Row[];
  expiryCleanupQueryPlans: OpsD1ExpiryCleanupQueryPlans;
  foreignKeyCheck: OpsD1Row[];
  migrations: OpsD1Row[];
  miNoteAuthChallengeExpiryIndexColumns: OpsD1Row[];
  miNoteAuthSessionExpiryIndexColumns: OpsD1Row[];
  profileAddressColumns: OpsD1Row[];
  profileCounts: OpsD1Row[];
  profileColumns: OpsD1Row[];
  quickCheck: OpsD1Row[];
  rateLimitBucketColumns: OpsD1Row[];
  rateLimitBucketExpiryIndexColumns: OpsD1Row[];
  revealSubmissionColumns: OpsD1Row[];
  revealSubmissionStatusIndexColumns: OpsD1Row[];
  revealSubmissionCounts: OpsD1Row[];
  revealSubmissionStorageControl: OpsD1Row[];
  revealSubmissionStorageControlColumns: OpsD1Row[];
  schema: OpsD1Row[];
  staffAuthChallengeExpiryIndexColumns: OpsD1Row[];
  staffAuthSessionExpiryIndexColumns: OpsD1Row[];
  tableList: OpsD1Row[];
  authWalletBindingColumns: OpsD1Row[];
  authWalletBindingCounts: OpsD1Row[];
  workerControlColumns: OpsD1Row[];
};

export type OpsD1IntegrityReport = {
  anonymousAuthSessionCount: number;
  profileAddressCount: number;
  profileCount: number;
  revealSubmissionCount: number;
  revealSubmissionStorage: RevealSubmissionStorageControl;
  authWalletBindingCount: number;
};

const opsD1 = createD1MaintenanceRunner('ops');
const expectedSchema = new Map(
  schemaManifest.checkpoints[schemaManifest.migrations.at(-1)!.name].objects
    .map((object) => [object.name, object] as const),
);
const expectedTableNames = [...expectedSchema]
  .filter(([, value]) => value.type === 'table')
  .map(([name]) => name)
  .sort();

type ExpectedColumn = readonly [
  name: string,
  type: 'INTEGER' | 'TEXT',
  notNull: 0 | 1,
  primaryKeyPosition: number,
];

const expectedWorkerControlColumns: readonly ExpectedColumn[] = [
  ['control_key', 'TEXT', 1, 1],
  ['cursor_path', 'TEXT', 0, 0],
  ['revision', 'INTEGER', 1, 0],
  ['created_at_ms', 'INTEGER', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
  ['cursor_updated_at_ms', 'INTEGER', 0, 0],
];

const expectedAnonymousAuthSessionColumns: readonly ExpectedColumn[] = [
  ['session_id', 'TEXT', 1, 1],
  ['secret_hash', 'TEXT', 1, 0],
  ['auth_subject', 'TEXT', 1, 0],
  ['origin_hostname', 'TEXT', 1, 0],
  ['created_at_ms', 'INTEGER', 1, 0],
  ['refreshed_at_ms', 'INTEGER', 1, 0],
  ['expires_at_ms', 'INTEGER', 1, 0],
];

const expectedRateLimitBucketColumns: readonly ExpectedColumn[] = [
  ['scope', 'TEXT', 1, 1],
  ['subject_hash', 'TEXT', 1, 2],
  ['schema_version', 'INTEGER', 1, 0],
  ['cluster', 'TEXT', 0, 0],
  ['owner_wallet', 'TEXT', 0, 0],
  ['receipt_asset_id', 'TEXT', 0, 0],
  ['window_started_at_ms', 'INTEGER', 1, 0],
  ['expires_at_ms', 'INTEGER', 1, 0],
  ['request_count', 'INTEGER', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
];

const expectedProfileColumns: readonly ExpectedColumn[] = [
  ['wallet', 'TEXT', 1, 1],
  ['email', 'TEXT', 0, 0],
  ['created_at_ms', 'INTEGER', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
];

const expectedProfileAddressColumns: readonly ExpectedColumn[] = [
  ['wallet', 'TEXT', 1, 1],
  ['address_id', 'TEXT', 1, 2],
  ['encrypted', 'TEXT', 1, 0],
  ['country', 'TEXT', 1, 0],
  ['country_code', 'TEXT', 0, 0],
  ['hint', 'TEXT', 1, 0],
  ['email', 'TEXT', 0, 0],
  ['label', 'TEXT', 0, 0],
  ['created_at_ms', 'INTEGER', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
];

const expectedAuthWalletBindingColumns: readonly ExpectedColumn[] = [
  ['auth_subject', 'TEXT', 1, 1],
  ['wallet', 'TEXT', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
  ['revision', 'INTEGER', 1, 0],
  ['reconcile_lease_id', 'TEXT', 0, 0],
  ['reconcile_lease_expires_at_ms', 'INTEGER', 0, 0],
];

const expectedRevealSubmissionColumns: readonly ExpectedColumn[] = [
  ['drop_id', 'TEXT', 1, 1],
  ['box_asset_id', 'TEXT', 1, 2],
  ['schema_version', 'INTEGER', 1, 0],
  ['owner_wallet', 'TEXT', 1, 0],
  ['signature', 'TEXT', 1, 0],
  ['recent_blockhash', 'TEXT', 1, 0],
  ['blockhash_context_slot', 'INTEGER', 1, 0],
  ['dude_ids_json', 'TEXT', 1, 0],
  ['reservation_id', 'TEXT', 1, 0],
  ['status', 'TEXT', 1, 0],
  ['revision', 'INTEGER', 1, 0],
  ['created_at_ms', 'INTEGER', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
  ['confirmed_at_ms', 'INTEGER', 0, 0],
];

const expectedRevealSubmissionStorageControlColumns: readonly ExpectedColumn[] = [
  ['singleton', 'INTEGER', 1, 1],
  ['paused', 'INTEGER', 1, 0],
  ['revision', 'INTEGER', 1, 0],
  ['created_at_ms', 'INTEGER', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
];

function fail(message: string): never {
  throw new Error(message);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    fail(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return normalized;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    fail(`${label} must be a non-empty string.`);
  }
  return value;
}

function exactStringSet(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const normalizedActual = [...actual].sort();
  const normalizedExpected = [...expected].sort();
  if (
    normalizedActual.length !== normalizedExpected.length ||
    normalizedActual.some(
      (value, index) => value !== normalizedExpected[index],
    )
  ) {
    fail(`${label} are not exact.`);
  }
}

function assertExactInteger(
  value: unknown,
  expected: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value !== expected) {
    fail(`${label} must equal ${expected}.`);
  }
}

function schemaFingerprint(value: unknown): string {
  return sqlSchemaFingerprint(requiredString(value, 'Ops D1 schema SQL'));
}

function assertExactSchema(rows: OpsD1Row[]): void {
  if (rows.length !== expectedSchema.size) {
    fail('Ops D1 application schema is not exact.');
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const name = requiredString(row.name, 'Ops D1 schema name');
    const expected = expectedSchema.get(name);
    if (
      seen.has(name) ||
      !expected ||
      row.type !== expected.type ||
      row.tbl_name !== expected.tableName ||
      schemaFingerprint(row.sql) !== expected.fingerprint
    ) {
      fail('Ops D1 application schema is not exact.');
    }
    seen.add(name);
  }
}

function assertStrictTables(rows: OpsD1Row[]): void {
  const tableNames = expectedTableNames;
  if (rows.length !== tableNames.length) {
    fail('Ops D1 strict tables are not exact.');
  }
  rows.forEach((row, index) => {
    if (row.name !== tableNames[index] || row.type !== 'table') {
      fail('Ops D1 strict tables are not exact.');
    }
    assertExactInteger(row.strict, 1, `${tableNames[index]} strict flag`);
  });
}

function assertExactColumns(
  rows: OpsD1Row[],
  expected: readonly ExpectedColumn[],
  tableName: string,
): void {
  if (rows.length !== expected.length) {
    fail(`${tableName} columns are not exact.`);
  }
  rows.forEach((row, cid) => {
    const [name, type, notNull, primaryKeyPosition] = expected[cid];
    if (
      row.name !== name ||
      row.type !== type ||
      row.dflt_value !== null
    ) {
      fail(`${tableName} columns are not exact.`);
    }
    assertExactInteger(row.cid, cid, `${tableName}.${name} cid`);
    assertExactInteger(
      row.notnull,
      notNull,
      `${tableName}.${name} not-null flag`,
    );
    assertExactInteger(
      row.pk,
      primaryKeyPosition,
      `${tableName}.${name} primary-key position`,
    );
  });
}

function assertRevealSubmissionStatusIndexColumns(rows: OpsD1Row[]): void {
  if (
    rows.length !== 2 ||
    rows[0].seqno !== 0 ||
    rows[0].name !== 'status' ||
    rows[1].seqno !== 1 ||
    rows[1].name !== 'created_at_ms'
  ) fail('Ops D1 reveal-submission status index columns are not exact.');
}

function assertExactIndexColumns(
  rows: OpsD1Row[],
  expected: ReadonlyArray<readonly [name: string, cid: number]>,
  label: string,
): void {
  if (rows.length !== expected.length) fail(`${label} columns are not exact.`);
  rows.forEach((row, seqno) => {
    const [name, cid] = expected[seqno];
    if (row.name !== name) fail(`${label} columns are not exact.`);
    assertExactInteger(row.seqno, seqno, `${label} sequence`);
    assertExactInteger(row.cid, cid, `${label} column id`);
  });
}

function assertExpiryCleanupQueryPlans(
  plans: OpsD1ExpiryCleanupQueryPlans,
): void {
  for (const key of Object.keys(OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS) as Array<
    keyof typeof OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS
  >) {
    const { indexName, label } = OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS[key];
    const details = plans[key].map((row) =>
      requiredString(row.detail, `Ops D1 ${label} query-plan detail`));
    if (details.some((detail) => detail.includes('USE TEMP B-TREE'))) {
      fail(`Ops D1 ${label} query plan uses a temporary B-tree.`);
    }
    if (!details.some((detail) =>
      detail.includes(`USING COVERING INDEX ${indexName}`))) {
      fail(`Ops D1 ${label} query plan does not use ${indexName}.`);
    }
  }
}

function parseRevealSubmissionStorageControl(
  row: OpsD1Row,
): RevealSubmissionStorageControl {
  if (
    row.singleton !== 1 ||
    (row.paused !== 0 && row.paused !== 1)
  ) return fail('Reveal-submission storage control is invalid.');
  const revision = safeInteger(row.revision, 'Reveal-submission storage revision', 1);
  const updatedAtMs = safeInteger(row.updated_at_ms, 'Reveal-submission storage update timestamp');
  return {
    paused: row.paused === 1,
    revision,
    updatedAtMs,
  };
}

export function assertOpsD1Integrity(
  input: OpsD1IntegrityInput,
): OpsD1IntegrityReport {
  if (
    input.quickCheck.length !== 1 ||
    String(input.quickCheck[0].quick_check || '').toLowerCase() !== 'ok'
  ) {
    return fail('Ops D1 quick_check failed.');
  }
  if (input.foreignKeyCheck.length !== 0) {
    return fail('Ops D1 foreign_key_check failed.');
  }
  exactStringSet(
    input.migrations.map((row) => requiredString(row.name, 'Ops D1 migration name')),
    OPS_D1_MIGRATIONS,
    'Ops D1 migrations',
  );
  assertExactSchema(input.schema);
  assertStrictTables(input.tableList);
  assertExactColumns(
    input.anonymousAuthSessionColumns,
    expectedAnonymousAuthSessionColumns,
    'anonymous_auth_sessions',
  );
  assertExactIndexColumns(input.miNoteAuthSessionExpiryIndexColumns,
    [['expires_at_ms', 7], ['session_id', 0]], 'Ops D1 Mi Note session expiry index');
  assertExactIndexColumns(input.miNoteAuthChallengeExpiryIndexColumns,
    [['expires_at_ms', 6], ['challenge_id', 0]], 'Ops D1 Mi Note challenge expiry index');
  assertExactColumns(
    input.workerControlColumns,
    expectedWorkerControlColumns,
    'worker_controls',
  );
  assertRevealSubmissionStatusIndexColumns(input.revealSubmissionStatusIndexColumns);
  assertExactIndexColumns(
    input.anonymousAuthSessionExpiryIndexColumns,
    [['expires_at_ms', 6], ['session_id', 0]],
    'Ops D1 anonymous-auth expiry index',
  );
  assertExactIndexColumns(
    input.staffAuthSessionExpiryIndexColumns,
    [['expires_at_ms', 6], ['session_id', 0]],
    'Ops D1 staff-auth session expiry index',
  );
  assertExactIndexColumns(
    input.staffAuthChallengeExpiryIndexColumns,
    [['expires_at_ms', 4], ['challenge_id', 0]],
    'Ops D1 staff-auth challenge expiry index',
  );
  assertExactColumns(
    input.profileColumns,
    expectedProfileColumns,
    'profiles',
  );
  assertExactColumns(
    input.profileAddressColumns,
    expectedProfileAddressColumns,
    'profile_addresses',
  );
  assertExactColumns(
    input.rateLimitBucketColumns,
    expectedRateLimitBucketColumns,
    'rate_limit_buckets',
  );
  assertExactColumns(
    input.authWalletBindingColumns,
    expectedAuthWalletBindingColumns,
    'auth_wallet_bindings',
  );
  assertExactColumns(
    input.revealSubmissionColumns,
    expectedRevealSubmissionColumns,
    'reveal_submissions',
  );
  assertExactColumns(
    input.revealSubmissionStorageControlColumns,
    expectedRevealSubmissionStorageControlColumns,
    'reveal_submission_storage_control',
  );
  assertExactIndexColumns(
    input.rateLimitBucketExpiryIndexColumns,
    [['expires_at_ms', 7], ['scope', 0], ['subject_hash', 1]],
    'Ops D1 rate-limit bucket expiry index',
  );
  assertExpiryCleanupQueryPlans(input.expiryCleanupQueryPlans);
  if (input.revealSubmissionStorageControl.length !== 1) {
    return fail('Ops D1 must contain exactly one reveal-submission storage control.');
  }
  if (input.anonymousAuthSessionCounts.length !== 1) {
    return fail('Ops D1 anonymous-auth session count is invalid.');
  }
  const anonymousAuthSessionCount = safeInteger(
    input.anonymousAuthSessionCounts[0].anonymous_auth_session_count,
    'Ops D1 anonymous-auth session count',
  );
  const revealSubmissionStorage = parseRevealSubmissionStorageControl(
    input.revealSubmissionStorageControl[0],
  );
  if (input.profileCounts.length !== 1) {
    return fail('Ops D1 profile counts are invalid.');
  }
  const profileCount = safeInteger(input.profileCounts[0].profile_count, 'Ops D1 profile count');
  const profileAddressCount = safeInteger(input.profileCounts[0].profile_address_count, 'Ops D1 profile address count');
  if (input.authWalletBindingCounts.length !== 1) {
    return fail('Ops D1 auth-wallet binding count is invalid.');
  }
  const authWalletBindingCount = safeInteger(
    input.authWalletBindingCounts[0].auth_wallet_binding_count,
    'Ops D1 auth-wallet binding count',
  );
  if (input.revealSubmissionCounts.length !== 1) {
    return fail('Ops D1 reveal-submission count is invalid.');
  }
  const revealSubmissionCount = safeInteger(
    input.revealSubmissionCounts[0].reveal_submission_count,
    'Ops D1 reveal-submission count',
  );
  return {
    anonymousAuthSessionCount,
    profileAddressCount,
    profileCount,
    revealSubmissionCount,
    revealSubmissionStorage,
    authWalletBindingCount,
  };
}

export function queryRemoteOpsD1(sql: string): OpsD1Row[] {
  return opsD1.query(sql);
}

export function readRemoteOpsD1Integrity(
  queryBatch: D1MaintenanceQueryBatch = opsD1.queryBatch,
): OpsD1IntegrityReport {
  const {
    anonymousAuthSessionsQueryPlan,
    miNoteAuthSessionsQueryPlan,
    miNoteAuthChallengesQueryPlan,
    staffAuthSessionsQueryPlan,
    staffAuthChallengesQueryPlan,
    rateLimitBucketsQueryPlan,
    ...rows
  } = queryBatch({
    miNoteAuthSessionExpiryIndexColumns: 'PRAGMA index_info(mi_note_auth_sessions_expires_at_ms)',
    miNoteAuthChallengeExpiryIndexColumns: 'PRAGMA index_info(mi_note_auth_challenges_expires_at_ms)',
    miNoteAuthSessionsQueryPlan: OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS.miNoteAuthSessions.sql,
    miNoteAuthChallengesQueryPlan: OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS.miNoteAuthChallenges.sql,
    anonymousAuthSessionColumns: 'PRAGMA table_info(anonymous_auth_sessions)',
    anonymousAuthSessionCounts: 'SELECT COUNT(*) AS anonymous_auth_session_count FROM anonymous_auth_sessions',
    anonymousAuthSessionExpiryIndexColumns: 'PRAGMA index_info(anonymous_auth_sessions_expires_at_ms)',
    anonymousAuthSessionsQueryPlan: OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS.anonymousAuthSessions.sql,
    staffAuthSessionsQueryPlan: OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS.staffAuthSessions.sql,
    staffAuthChallengesQueryPlan: OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS.staffAuthChallenges.sql,
    rateLimitBucketsQueryPlan: OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS.rateLimitBuckets.sql,
    rateLimitBucketExpiryIndexColumns: 'PRAGMA index_info(rate_limit_buckets_expires_at_ms)',
    foreignKeyCheck: 'PRAGMA foreign_key_check',
    migrations: 'SELECT name FROM d1_migrations ORDER BY id',
    profileAddressColumns: 'PRAGMA table_info(profile_addresses)',
    profileCounts: `SELECT
      (SELECT COUNT(*) FROM profiles) AS profile_count,
      (SELECT COUNT(*) FROM profile_addresses) AS profile_address_count`,
    profileColumns: 'PRAGMA table_info(profiles)',
    quickCheck: 'PRAGMA quick_check',
    rateLimitBucketColumns: 'PRAGMA table_info(rate_limit_buckets)',
    revealSubmissionColumns: 'PRAGMA table_info(reveal_submissions)',
    revealSubmissionStatusIndexColumns: 'PRAGMA index_info(reveal_submissions_status_created_at_ms)',
    revealSubmissionCounts: 'SELECT COUNT(*) AS reveal_submission_count FROM reveal_submissions',
    revealSubmissionStorageControl: `SELECT
      singleton,
      paused,
      revision,
      updated_at_ms
      FROM reveal_submission_storage_control`,
    revealSubmissionStorageControlColumns: 'PRAGMA table_info(reveal_submission_storage_control)',
    schema: `SELECT name, type, tbl_name, sql
      FROM sqlite_schema
      WHERE
        name NOT LIKE 'sqlite_%' AND
        name NOT GLOB '_cf_*' AND
        name <> 'd1_migrations'
      ORDER BY name`,
    staffAuthChallengeExpiryIndexColumns: 'PRAGMA index_info(staff_auth_challenges_expires_at_ms)',
    staffAuthSessionExpiryIndexColumns: 'PRAGMA index_info(staff_auth_sessions_expires_at_ms)',
    tableList: `SELECT name, type, strict
      FROM pragma_table_list
      WHERE
        schema = 'main' AND
        name IN (${expectedTableNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(', ')})
      ORDER BY name`,
    authWalletBindingColumns: 'PRAGMA table_info(auth_wallet_bindings)',
    authWalletBindingCounts: 'SELECT COUNT(*) AS auth_wallet_binding_count FROM auth_wallet_bindings',
    workerControlColumns: 'PRAGMA table_info(worker_controls)',
  });
  return assertOpsD1Integrity({
    ...rows,
    expiryCleanupQueryPlans: {
      anonymousAuthSessions: anonymousAuthSessionsQueryPlan,
      miNoteAuthSessions: miNoteAuthSessionsQueryPlan,
      miNoteAuthChallenges: miNoteAuthChallengesQueryPlan,
      staffAuthSessions: staffAuthSessionsQueryPlan,
      staffAuthChallenges: staffAuthChallengesQueryPlan,
      rateLimitBuckets: rateLimitBucketsQueryPlan,
    },
  });
}
