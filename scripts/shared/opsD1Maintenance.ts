import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPS_EXPIRY_CLEANUP_STATEMENTS } from '../../shared/opsExpiryCleanupSql.ts';
import { sqlSchemaFingerprint } from './sqlSchemaFingerprint.ts';

const OPS_D1_MIGRATIONS = [
  '0001_current_schema.sql',
  '0002_reveal_submission_write_fence.sql',
  '0003_remove_ready_notification_pause.sql',
  '0004_repair_ready_notification_cursor.sql',
  '0005_remove_redundant_anonymous_auth_subject_index.sql',
  '0006_cover_expiry_cleanup_indexes.sql',
] as const;

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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = 'cloud/workers/api/wrangler.jsonc';
const envFilePath = 'cloud/workers/api/release.env';
const databaseName = 'mons-shop-ops';
const WRANGLER_COMMAND_TIMEOUT_MS = 10 * 60_000;
const wranglerBinary = resolve(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
);
const expectedSchema = new Map<
  string,
  { fingerprint: string; type: string; tableName: string }
>([
  ['reveal_submission_storage_control', { fingerprint: '44ec185eabc12b3992ee96e826b39ae182b32222d3eba3dc71b1fb9063dffb7a', type: 'table', tableName: 'reveal_submission_storage_control' }],
  ['reveal_submission_control_delete_guard', { fingerprint: '618977009b6bee7cf3d40c4cfcf2960308bffd65e5b60d9301143645813a3d1e', type: 'trigger', tableName: 'reveal_submission_storage_control' }],
  ['reveal_submission_control_insert_guard', { fingerprint: 'b6a050331e2963b75a17192d41e0a7232d6127f14cf8f3248a125590421d4e72', type: 'trigger', tableName: 'reveal_submission_storage_control' }],
  ['reveal_submission_control_update_guard', { fingerprint: '957b34444242934db86c074d42114b05f8759d26394761385f2a5d67373068ed', type: 'trigger', tableName: 'reveal_submission_storage_control' }],
  ['reveal_submission_insert_pause_guard', { fingerprint: '9f89b1dcab58b8d0a393f2f7635b333ef1f639b39a6266b87a6ed8fbd0fb191e', type: 'trigger', tableName: 'reveal_submissions' }],
  ['reveal_submission_update_pause_guard', { fingerprint: '5a362dc398826eb64ff82b68270d905cc901f16d8a3e0078b5746187447f9109', type: 'trigger', tableName: 'reveal_submissions' }],
  [
    'anonymous_auth_sessions',
    {
      fingerprint: 'c120faba7aa7aae86de7de4413d91d79278b51f4289495d0d2b7b14042a12304',
      type: 'table',
      tableName: 'anonymous_auth_sessions',
    },
  ],
  [
    'anonymous_auth_sessions_expires_at_ms',
    {
      fingerprint: 'b589d1100d64743d309a45b3fd45c2bc64153190b0437fa84889f417ceb0b559',
      type: 'index',
      tableName: 'anonymous_auth_sessions',
    },
  ],
  [
    'staff_auth_challenges',
    {
      fingerprint: 'be5e9df3a253cc9d96aeccda32a1a721c5c5eb7ac2e675141b04e65363716c3d',
      type: 'table',
      tableName: 'staff_auth_challenges',
    },
  ],
  [
    'staff_auth_challenges_expires_at_ms',
    {
      fingerprint: '403b76ba6880533513b8fcb3c10f441b72dd6de92b64b345106de51689a38864',
      type: 'index',
      tableName: 'staff_auth_challenges',
    },
  ],
  [
    'staff_auth_sessions',
    {
      fingerprint: 'a6ebff862853658e5b87850acb93aec844dfa0b8085a2cbdb60b2e367054f83e',
      type: 'table',
      tableName: 'staff_auth_sessions',
    },
  ],
  [
    'staff_auth_sessions_expires_at_ms',
    {
      fingerprint: '37f48b6cd0e70162cd0134a7463ceb82dfae877a02cc195ec9371a703c76aa4e',
      type: 'index',
      tableName: 'staff_auth_sessions',
    },
  ],
  [
    'staff_auth_sessions_wallet',
    {
      fingerprint: 'b875009c658d267620488b533c013a508059f9a72a8ddb92943ab4f5bd2b3d7e',
      type: 'index',
      tableName: 'staff_auth_sessions',
    },
  ],
  [
    'reveal_submissions_status_created_at_ms',
    {
      fingerprint: 'c19d631a0f0ffab085cc48fab19ae012694d49036c349047dc7d7187d066d6b5',
      type: 'index',
      tableName: 'reveal_submissions',
    },
  ],
  [
    'reveal_submissions',
    {
      fingerprint: '2969c31b94fccd46624b138514ba3f530efe5a9029e70380f371061ba98776bd',
      type: 'table',
      tableName: 'reveal_submissions',
    },
  ],
  [
    'profile_address_conflict_guard',
    {
      fingerprint: '0a6293e7bfb45c4d3ef6adb0ebb84ae783302e74c63bd6e7836b9ed220f9ba37',
      type: 'trigger',
      tableName: 'profile_addresses',
    },
  ],
  [
    'profile_address_delete_guard',
    {
      fingerprint: '76113564b7c95a0b5482afad506b95403f1d1e954f98ddaf26e7f063069b515f',
      type: 'trigger',
      tableName: 'profile_addresses',
    },
  ],
  [
    'profile_address_idempotent_insert',
    {
      fingerprint: 'cb6d829aa40baebe78460238d63d2ea3ac314ccdce7de15c13dbdfc9bc38cb43',
      type: 'trigger',
      tableName: 'profile_addresses',
    },
  ],
  [
    'profile_address_update_guard',
    {
      fingerprint: '6c838bec11592eeca61bb8db969751f67b586039aecceb78594e1f7ca6126423',
      type: 'trigger',
      tableName: 'profile_addresses',
    },
  ],
  [
    'profile_addresses',
    {
      fingerprint: 'e274ccc9b59b452a97582a0d6f9900011b2d4f6624ed0b03359e1e66c5f847e0',
      type: 'table',
      tableName: 'profile_addresses',
    },
  ],
  [
    'profile_delete_guard',
    {
      fingerprint: '9f05b1d6afa5acae25c0df24040b85247000a5b225451586786286d8fb5b55d0',
      type: 'trigger',
      tableName: 'profiles',
    },
  ],
  [
    'profiles',
    {
      fingerprint: '3262625a85ab2d17847b5f0208d2257b050bbcdcc0b0b46dc244a010b7fbaa94',
      type: 'table',
      tableName: 'profiles',
    },
  ],
  [
    'rate_limit_buckets',
    {
      fingerprint: 'db8c0bd0339313fcf1149032e5357b5097e9721ecc194e371474dd683ff9dd4e',
      type: 'table',
      tableName: 'rate_limit_buckets',
    },
  ],
  [
    'rate_limit_buckets_expires_at_ms',
    {
      fingerprint: '7b860409cb1ec4ed77f9c39fd352de9d0f904a70cf327d27f8b0275393337cf2',
      type: 'index',
      tableName: 'rate_limit_buckets',
    },
  ],
  [
    'auth_wallet_bindings',
    {
      fingerprint: 'b412176e9f183c875e87bb91b77690f5c9e9d377747ca507b021908257cd9331',
      type: 'table',
      tableName: 'auth_wallet_bindings',
    },
  ],
  [
    'worker_controls',
    {
      fingerprint: '345e3d3708aaf05c53d253386e7c95c04d1fb40f2ea4d8c3bb8c3b2d22724e5c',
      type: 'table',
      tableName: 'worker_controls',
    },
  ],
]);

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
  const tableNames = [...expectedSchema]
    .filter(([, value]) => value.type === 'table')
    .map(([name]) => name)
    .sort();
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

function runWrangler(args: string[], json = false): string {
  try {
    return execFileSync(
      wranglerBinary,
      [
        ...args,
        '--config',
        configPath,
        '--env-file',
        envFilePath,
        ...(json ? ['--json'] : []),
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: WRANGLER_COMMAND_TIMEOUT_MS,
      },
    ).trim();
  } catch (error) {
    const output = error && typeof error === 'object'
      ? [
          'stdout' in error ? (error as { stdout?: unknown }).stdout : '',
          'stderr' in error ? (error as { stderr?: unknown }).stderr : '',
        ]
          .map((value) =>
            String(value || '')
              .replace(/\u001b\[[0-9;]*m/g, '')
              .trim(),
          )
          .filter(Boolean)
          .join('\n')
      : '';
    return fail(output || 'Wrangler Ops D1 command failed.');
  }
}

function parseD1Envelope(
  output: string,
): Array<{ results: OpsD1Row[]; success: true }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return fail('Ops D1 returned invalid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return fail('Ops D1 returned an invalid query envelope.');
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail('Ops D1 returned an invalid query result.');
    }
    const result = entry as { results?: unknown; success?: unknown };
    if (result.success !== true || !Array.isArray(result.results)) {
      return fail('Ops D1 query failed.');
    }
    return { results: result.results as OpsD1Row[], success: true };
  });
}

function executeRemoteOpsD1(sql: string): OpsD1Row[][] {
  return parseD1Envelope(
    runWrangler(
      [
        'd1',
        'execute',
        databaseName,
        '--remote',
        '--command',
        sql,
      ],
      true,
    ),
  ).map((entry) => entry.results);
}

export function queryRemoteOpsD1(sql: string): OpsD1Row[] {
  const results = executeRemoteOpsD1(sql);
  if (results.length !== 1) {
    return fail('Expected exactly one Ops D1 statement result.');
  }
  return results[0];
}

export function readRemoteOpsD1Integrity(): OpsD1IntegrityReport {
  return assertOpsD1Integrity({
    anonymousAuthSessionColumns: queryRemoteOpsD1(
      'PRAGMA table_info(anonymous_auth_sessions)',
    ),
    anonymousAuthSessionCounts: queryRemoteOpsD1(
      'SELECT COUNT(*) AS anonymous_auth_session_count FROM anonymous_auth_sessions',
    ),
    anonymousAuthSessionExpiryIndexColumns: queryRemoteOpsD1(
      'PRAGMA index_info(anonymous_auth_sessions_expires_at_ms)',
    ),
    expiryCleanupQueryPlans: {
      anonymousAuthSessions: queryRemoteOpsD1(
        OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS.anonymousAuthSessions.sql,
      ),
      staffAuthSessions: queryRemoteOpsD1(
        OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS.staffAuthSessions.sql,
      ),
      staffAuthChallenges: queryRemoteOpsD1(
        OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS.staffAuthChallenges.sql,
      ),
      rateLimitBuckets: queryRemoteOpsD1(
        OPS_D1_EXPIRY_CLEANUP_QUERY_PLAN_SPECS.rateLimitBuckets.sql,
      ),
    },
    rateLimitBucketExpiryIndexColumns: queryRemoteOpsD1(
      'PRAGMA index_info(rate_limit_buckets_expires_at_ms)',
    ),
    foreignKeyCheck: queryRemoteOpsD1('PRAGMA foreign_key_check'),
    migrations: queryRemoteOpsD1(
      'SELECT name FROM d1_migrations ORDER BY id',
    ),
    profileAddressColumns: queryRemoteOpsD1(
      'PRAGMA table_info(profile_addresses)',
    ),
    profileCounts: queryRemoteOpsD1(`SELECT
      (SELECT COUNT(*) FROM profiles) AS profile_count,
      (SELECT COUNT(*) FROM profile_addresses) AS profile_address_count`),
    profileColumns: queryRemoteOpsD1(
      'PRAGMA table_info(profiles)',
    ),
    quickCheck: queryRemoteOpsD1('PRAGMA quick_check'),
    rateLimitBucketColumns: queryRemoteOpsD1(
      'PRAGMA table_info(rate_limit_buckets)',
    ),
    revealSubmissionColumns: queryRemoteOpsD1(
      'PRAGMA table_info(reveal_submissions)',
    ),
    revealSubmissionStatusIndexColumns: queryRemoteOpsD1(
      'PRAGMA index_info(reveal_submissions_status_created_at_ms)',
    ),
    revealSubmissionCounts: queryRemoteOpsD1(
      'SELECT COUNT(*) AS reveal_submission_count FROM reveal_submissions',
    ),
    revealSubmissionStorageControl: queryRemoteOpsD1(`SELECT
      singleton,
      paused,
      revision,
      updated_at_ms
      FROM reveal_submission_storage_control`),
    revealSubmissionStorageControlColumns: queryRemoteOpsD1(
      'PRAGMA table_info(reveal_submission_storage_control)',
    ),
    schema: queryRemoteOpsD1(`SELECT name, type, tbl_name, sql
      FROM sqlite_schema
      WHERE
        name NOT LIKE 'sqlite_%' AND
        name NOT GLOB '_cf_*' AND
        name <> 'd1_migrations'
      ORDER BY name`),
    staffAuthChallengeExpiryIndexColumns: queryRemoteOpsD1(
      'PRAGMA index_info(staff_auth_challenges_expires_at_ms)',
    ),
    staffAuthSessionExpiryIndexColumns: queryRemoteOpsD1(
      'PRAGMA index_info(staff_auth_sessions_expires_at_ms)',
    ),
    tableList: queryRemoteOpsD1(`SELECT name, type, strict
      FROM pragma_table_list
      WHERE
        schema = 'main' AND
        name IN (
          'profile_addresses',
          'anonymous_auth_sessions',
          'profiles',
          'rate_limit_buckets',
          'reveal_submission_storage_control',
          'reveal_submissions',
          'staff_auth_challenges',
          'staff_auth_sessions',
          'auth_wallet_bindings',
          'worker_controls'
        )
      ORDER BY name`),
    authWalletBindingColumns: queryRemoteOpsD1(
      'PRAGMA table_info(auth_wallet_bindings)',
    ),
    authWalletBindingCounts: queryRemoteOpsD1(
      'SELECT COUNT(*) AS auth_wallet_binding_count FROM auth_wallet_bindings',
    ),
    workerControlColumns: queryRemoteOpsD1(
      'PRAGMA table_info(worker_controls)',
    ),
  });
}
