import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCanonicalReadyNotificationCursorPath } from '../../shared/readyToShipNotificationReconciliation.ts';

export const READY_NOTIFICATIONS_CONTROL_KEY = 'ready_notifications';
const OPS_D1_MIGRATIONS = [
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
] as const;

const PRODUCTION_MIN_PROFILE_COUNT = 690;
const PRODUCTION_MIN_PROFILE_ADDRESS_COUNT = 503;
const PRODUCTION_MIN_WALLET_SESSION_COUNT = 1197;
const PRODUCTION_MIN_REVEAL_SUBMISSION_CUTOVER_COUNT = 14;

export type OpsD1Row = Record<string, unknown>;

export type ReadyNotificationsControl = {
  controlKey: typeof READY_NOTIFICATIONS_CONTROL_KEY;
  paused: boolean;
  cursorPath: string | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  cursorUpdatedAtMs: number | null;
};

export type RevealSubmissionStorageControl = {
  paused: boolean;
  revision: number;
  updatedAtMs: number;
  cutoverAtMs: number | null;
};

export type AuthProviderRetirement = {
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  legacyProviderDisabledAtMs: number;
};

export type OpsD1IntegrityInput = {
  authProviderRetirement: OpsD1Row[];
  authProviderRetirementColumns: OpsD1Row[];
  anonymousAuthSessionColumns: OpsD1Row[];
  anonymousAuthSessionCounts: OpsD1Row[];
  anonymousAuthSessionExpiryIndexColumns: OpsD1Row[];
  anonymousAuthSessionSubjectIndexColumns: OpsD1Row[];
  controls: OpsD1Row[];
  expiryIndexColumns: OpsD1Row[];
  foreignKeyCheck: OpsD1Row[];
  migrations: OpsD1Row[];
  profileAddressColumns: OpsD1Row[];
  profileCounts: OpsD1Row[];
  profileColumns: OpsD1Row[];
  quickCheck: OpsD1Row[];
  rateLimitBucketColumns: OpsD1Row[];
  revealSubmissionColumns: OpsD1Row[];
  revealSubmissionBaselineIndexColumns: OpsD1Row[];
  revealSubmissionCounts: OpsD1Row[];
  revealSubmissionStorageControl: OpsD1Row[];
  revealSubmissionStorageControlColumns: OpsD1Row[];
  schema: OpsD1Row[];
  tableList: OpsD1Row[];
  walletSessionColumns: OpsD1Row[];
  walletSessionCounts: OpsD1Row[];
  workerControlColumns: OpsD1Row[];
};

export type OpsD1IntegrityReport = {
  authProviderRetirement: AuthProviderRetirement;
  anonymousAuthSessionCount: number;
  profileAddressCount: number;
  profileCount: number;
  readyNotifications: ReadyNotificationsControl;
  revealSubmissionCount: number;
  revealSubmissionStorage: RevealSubmissionStorageControl;
  walletSessionCount: number;
};

type OpsD1IntegrityMinimums = {
  profileAddressCount: number;
  profileCount: number;
  revealSubmissionCutoverCount: number;
  walletSessionCount: number;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = 'cloud/workers/api/wrangler.jsonc';
const envFilePath = 'cloud/workers/api/release.env';
const databaseName = 'mons-shop-ops';
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
  ['auth_provider_retirement', { fingerprint: '05a3cd026372bf98dbadbc764b028930f9f1fcf3294a542efd2c6b08fe5d39bc', type: 'table', tableName: 'auth_provider_retirement' }],
  ['auth_provider_retirement_delete_guard', { fingerprint: 'a8c936557fa24491dbc92b5f99324cb68633866b79426b226e78f045ba81969d', type: 'trigger', tableName: 'auth_provider_retirement' }],
  ['auth_provider_retirement_insert_guard', { fingerprint: '025c6efe39d94b9e03fe87a14f468de810ddc353f6b143a6a6114dc988c30edc', type: 'trigger', tableName: 'auth_provider_retirement' }],
  ['auth_provider_retirement_update_guard', { fingerprint: '85cb4a800c0d199e055d6c0b7ad0dffb3009003104027b69544d9c0723667903', type: 'trigger', tableName: 'auth_provider_retirement' }],
  ['reveal_submission_storage_control', { fingerprint: 'c56576538e111e7dcb61ca0159f55af0487e30d389c125fdf914e4075748f30e', type: 'table', tableName: 'reveal_submission_storage_control' }],
  ['reveal_submission_control_delete_guard', { fingerprint: '618977009b6bee7cf3d40c4cfcf2960308bffd65e5b60d9301143645813a3d1e', type: 'trigger', tableName: 'reveal_submission_storage_control' }],
  ['reveal_submission_control_insert_guard', { fingerprint: 'b6a050331e2963b75a17192d41e0a7232d6127f14cf8f3248a125590421d4e72', type: 'trigger', tableName: 'reveal_submission_storage_control' }],
  ['reveal_submission_control_update_guard', { fingerprint: 'd523fb91e74871a128fff75ec6687b8617309ad10b0287905ae35f2f0acc51cb', type: 'trigger', tableName: 'reveal_submission_storage_control' }],
  [
    'anonymous_auth_sessions',
    {
      fingerprint: 'b1985b6c05977420c7e68edcb7a501d8877808554064df78d8475d88741921a0',
      type: 'table',
      tableName: 'anonymous_auth_sessions',
    },
  ],
  [
    'anonymous_auth_sessions_auth_subject',
    {
      fingerprint: 'e56b0fe36d7e8768244454f81a9e908b0a4a1ba7512f8ea988827bcd44c14f9f',
      type: 'index',
      tableName: 'anonymous_auth_sessions',
    },
  ],
  [
    'anonymous_auth_sessions_expires_at_ms',
    {
      fingerprint: 'dabe2ee9d495cd9f7901a8b16145d6986efe885fe6bbd4356e0589669b4aed83',
      type: 'index',
      tableName: 'anonymous_auth_sessions',
    },
  ],
  [
    'staff_auth_challenges',
    {
      fingerprint: '86954545cba1f42dd9a778efc90615ca911eebcfe5e9727416e50176c680f67e',
      type: 'table',
      tableName: 'staff_auth_challenges',
    },
  ],
  [
    'staff_auth_challenges_expires_at_ms',
    {
      fingerprint: 'a5d6fff7130b51a8402033b0567044b34b1c93890d8c977e13dd4ba0309bb8a1',
      type: 'index',
      tableName: 'staff_auth_challenges',
    },
  ],
  [
    'staff_auth_sessions',
    {
      fingerprint: '402a5a3d60d61711a21037db9cf4dc959835983e6bf6c4c877a1d176f3d0deee',
      type: 'table',
      tableName: 'staff_auth_sessions',
    },
  ],
  [
    'staff_auth_sessions_expires_at_ms',
    {
      fingerprint: '8c2b017cdff5784d201488410419c15c601a983814ee654333aa4d5d48f5ff0d',
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
      fingerprint: 'c38f2cc6730267cd001cd0ff72fe77e5fd282d13fa7f26d010c03e08223cf09c',
      type: 'table',
      tableName: 'reveal_submissions',
    },
  ],
  [
    'profile_address_conflict_guard',
    {
      fingerprint: '6504ae117f42990c9b0559ff2c7e4b097df0ead3548c95369cd541c7850634c2',
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
      fingerprint: '84e281a297546ef97e1bea092fbb86158bd330721441c106f7ff374f2dc8112a',
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
      fingerprint: '4e4f30d79d313311d118f477d6fc4dbc552bf9fd007acd603771619748abd2c8',
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
      fingerprint: '44bd3280983418705513ff1a0003f8b1a83f849dbd74155f4322691d2ceb9135',
      type: 'table',
      tableName: 'profiles',
    },
  ],
  [
    'rate_limit_buckets',
    {
      fingerprint: 'da1e804caa6b13afc0d440ee31eb28f970bf726c1b9453c5f66c1729ecf09520',
      type: 'table',
      tableName: 'rate_limit_buckets',
    },
  ],
  [
    'rate_limit_buckets_expires_at_ms',
    {
      fingerprint: '0f23fc84abcf76475c691f58fee9c23737b7c9d304aeea0c7a2031e3055d2aa9',
      type: 'index',
      tableName: 'rate_limit_buckets',
    },
  ],
  [
    'wallet_sessions',
    {
      fingerprint: '7c76ffd0d0590a521cfd8c5ed53a69006210ecff6f1fd5dac759a8a52ac60a35',
      type: 'table',
      tableName: 'wallet_sessions',
    },
  ],
  [
    'worker_controls',
    {
      fingerprint: 'a3234f2e0eba2083f1cd408e728576c1edb6e0407cf2bdb0746296199ef4f980',
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
  ['paused', 'INTEGER', 1, 0],
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

const expectedAuthProviderRetirementColumns: readonly ExpectedColumn[] = [
  ['singleton', 'INTEGER', 1, 1],
  ['revision', 'INTEGER', 1, 0],
  ['created_at_ms', 'INTEGER', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
  ['legacy_provider_disabled_at_ms', 'INTEGER', 1, 0],
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

const expectedWalletSessionColumns: readonly ExpectedColumn[] = [
  ['auth_subject', 'TEXT', 1, 1],
  ['wallet', 'TEXT', 1, 0],
  ['expires_at_ms', 'INTEGER', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
  ['wallet_revision', 'INTEGER', 1, 0],
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
  ['cutover_at_ms', 'INTEGER', 1, 0],
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
  const normalized = requiredString(value, 'Ops D1 schema SQL')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
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

function assertExpiryIndexColumns(rows: OpsD1Row[]): void {
  if (rows.length !== 1 || rows[0].name !== 'expires_at_ms') {
    fail('Ops D1 expiry index columns are not exact.');
  }
  assertExactInteger(rows[0].seqno, 0, 'Ops D1 expiry index sequence');
  assertExactInteger(rows[0].cid, 7, 'Ops D1 expiry index column id');
}

function assertRevealSubmissionBaselineIndexColumns(rows: OpsD1Row[]): void {
  if (
    rows.length !== 2 ||
    rows[0].seqno !== 0 ||
    rows[0].name !== 'status' ||
    rows[1].seqno !== 1 ||
    rows[1].name !== 'created_at_ms'
  ) fail('Ops D1 reveal-submission baseline index columns are not exact.');
}

function assertSingleColumnIndex(rows: OpsD1Row[], name: string, cid: number, label: string): void {
  if (rows.length !== 1 || rows[0].name !== name) fail(`${label} columns are not exact.`);
  assertExactInteger(rows[0].seqno, 0, `${label} sequence`);
  assertExactInteger(rows[0].cid, cid, `${label} column id`);
}

export function validateReadyNotificationCursorPath(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    return fail('Ready-notification cursor must be a non-empty string.');
  }
  if (!isCanonicalReadyNotificationCursorPath(value)) {
    return fail('Ready-notification cursor is not a canonical delivery-order path.');
  }
  return value;
}

export function parseReadyNotificationsControl(
  row: OpsD1Row,
): ReadyNotificationsControl {
  if (row.control_key !== READY_NOTIFICATIONS_CONTROL_KEY) {
    return fail('Ready-notification control key is invalid.');
  }
  if (row.paused !== 0 && row.paused !== 1) {
    return fail('Ready-notification paused state is invalid.');
  }
  const cursorPath = row.cursor_path === null
    ? null
    : validateReadyNotificationCursorPath(row.cursor_path);
  const revision = safeInteger(row.revision, 'Ready-notification revision', 1);
  const createdAtMs = safeInteger(
    row.created_at_ms,
    'Ready-notification creation timestamp',
  );
  const updatedAtMs = safeInteger(
    row.updated_at_ms,
    'Ready-notification update timestamp',
  );
  if (updatedAtMs < createdAtMs) {
    return fail('Ready-notification update timestamp precedes creation.');
  }
  const cursorUpdatedAtMs = row.cursor_updated_at_ms === null
    ? null
    : safeInteger(
        row.cursor_updated_at_ms,
        'Ready-notification cursor update timestamp',
      );
  if (
    (cursorPath === null) !== (cursorUpdatedAtMs === null) ||
    (cursorUpdatedAtMs !== null &&
      (cursorUpdatedAtMs < createdAtMs || cursorUpdatedAtMs > updatedAtMs))
  ) {
    return fail('Ready-notification cursor timestamps are inconsistent.');
  }
  return {
    controlKey: READY_NOTIFICATIONS_CONTROL_KEY,
    paused: row.paused === 1,
    cursorPath,
    revision,
    createdAtMs,
    updatedAtMs,
    cursorUpdatedAtMs,
  };
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
  const cutoverAtMs = row.cutover_at_ms === null
    ? null
    : safeInteger(row.cutover_at_ms, 'Reveal-submission cutover timestamp');
  if (
    cutoverAtMs === null
  ) return fail('Reveal-submission cutover state is invalid.');
  return {
    paused: row.paused === 1,
    revision,
    updatedAtMs,
    cutoverAtMs,
  };
}

function parseAuthProviderRetirement(row: OpsD1Row): AuthProviderRetirement {
  if (row.singleton !== 1) return fail('Auth-provider retirement record is invalid.');
  const createdAtMs = safeInteger(row.created_at_ms, 'Auth-provider retirement creation timestamp');
  const updatedAtMs = safeInteger(row.updated_at_ms, 'Auth-provider retirement update timestamp');
  const legacyProviderDisabledAtMs = safeInteger(
    row.legacy_provider_disabled_at_ms,
    'Legacy-provider disable timestamp',
  );
  if (
    updatedAtMs < createdAtMs ||
    legacyProviderDisabledAtMs < createdAtMs ||
    legacyProviderDisabledAtMs > updatedAtMs
  ) return fail('Auth-provider retirement timestamps are invalid.');
  return {
    revision: safeInteger(row.revision, 'Auth-provider retirement revision', 1),
    createdAtMs,
    updatedAtMs,
    legacyProviderDisabledAtMs,
  };
}

export function assertOpsD1Integrity(
  input: OpsD1IntegrityInput,
  minimums: OpsD1IntegrityMinimums = {
    profileAddressCount: 0,
    profileCount: 0,
    revealSubmissionCutoverCount: 0,
    walletSessionCount: 0,
  },
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
    input.authProviderRetirementColumns,
    expectedAuthProviderRetirementColumns,
    'auth_provider_retirement',
  );
  assertExactColumns(
    input.workerControlColumns,
    expectedWorkerControlColumns,
    'worker_controls',
  );
  assertRevealSubmissionBaselineIndexColumns(input.revealSubmissionBaselineIndexColumns);
  assertSingleColumnIndex(
    input.anonymousAuthSessionExpiryIndexColumns,
    'expires_at_ms',
    6,
    'Ops D1 anonymous-auth expiry index',
  );
  assertSingleColumnIndex(
    input.anonymousAuthSessionSubjectIndexColumns,
    'auth_subject',
    2,
    'Ops D1 anonymous-auth subject index',
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
    input.walletSessionColumns,
    expectedWalletSessionColumns,
    'wallet_sessions',
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
  assertExpiryIndexColumns(input.expiryIndexColumns);
  if (input.controls.length !== 1) {
    return fail('Ops D1 must contain exactly one worker control.');
  }
  if (input.revealSubmissionStorageControl.length !== 1) {
    return fail('Ops D1 must contain exactly one reveal-submission storage control.');
  }
  if (input.authProviderRetirement.length !== 1) {
    return fail('Ops D1 must contain exactly one auth-provider retirement record.');
  }
  if (input.anonymousAuthSessionCounts.length !== 1) {
    return fail('Ops D1 anonymous-auth session count is invalid.');
  }
  const authProviderRetirement = parseAuthProviderRetirement(input.authProviderRetirement[0]);
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
  if (profileCount < minimums.profileCount || profileAddressCount < minimums.profileAddressCount) {
    return fail('Ops D1 profile counts are below the production cutover baseline.');
  }
  if (input.walletSessionCounts.length !== 1) {
    return fail('Ops D1 wallet-session count is invalid.');
  }
  const walletSessionCount = safeInteger(
    input.walletSessionCounts[0].wallet_session_count,
    'Ops D1 wallet-session count',
  );
  if (walletSessionCount < minimums.walletSessionCount) {
    return fail('Ops D1 wallet-session count is below the production cutover baseline.');
  }
  if (input.revealSubmissionCounts.length !== 1) {
    return fail('Ops D1 reveal-submission count is invalid.');
  }
  const revealSubmissionCount = safeInteger(
    input.revealSubmissionCounts[0].reveal_submission_count,
    'Ops D1 reveal-submission count',
  );
  const revealSubmissionCutoverCount = safeInteger(
    input.revealSubmissionCounts[0].reveal_submission_cutover_count,
    'Ops D1 cutover reveal-submission count',
  );
  if (revealSubmissionCutoverCount < minimums.revealSubmissionCutoverCount) {
    return fail('Ops D1 reveal-submission count is below the production cutover baseline.');
  }
  return {
    authProviderRetirement,
    anonymousAuthSessionCount,
    profileAddressCount,
    profileCount,
    readyNotifications: parseReadyNotificationsControl(input.controls[0]),
    revealSubmissionCount,
    revealSubmissionStorage,
    walletSessionCount,
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

const controlSelect = `SELECT
  control_key,
  paused,
  cursor_path,
  revision,
  created_at_ms,
  updated_at_ms,
  cursor_updated_at_ms
FROM worker_controls`;

export function readRemoteReadyNotificationsControl(): ReadyNotificationsControl {
  const rows = queryRemoteOpsD1(
    `${controlSelect} WHERE control_key = 'ready_notifications'`,
  );
  if (rows.length !== 1) {
    return fail('Ready-notification control is missing from Ops D1.');
  }
  return parseReadyNotificationsControl(rows[0]);
}

export function readRemoteOpsD1Integrity(): OpsD1IntegrityReport {
  return assertOpsD1Integrity({
    authProviderRetirement: queryRemoteOpsD1(`SELECT
      singleton,
      revision,
      created_at_ms,
      updated_at_ms,
      legacy_provider_disabled_at_ms
      FROM auth_provider_retirement`),
    authProviderRetirementColumns: queryRemoteOpsD1(
      'PRAGMA table_info(auth_provider_retirement)',
    ),
    anonymousAuthSessionColumns: queryRemoteOpsD1(
      'PRAGMA table_info(anonymous_auth_sessions)',
    ),
    anonymousAuthSessionCounts: queryRemoteOpsD1(
      'SELECT COUNT(*) AS anonymous_auth_session_count FROM anonymous_auth_sessions',
    ),
    anonymousAuthSessionExpiryIndexColumns: queryRemoteOpsD1(
      'PRAGMA index_info(anonymous_auth_sessions_expires_at_ms)',
    ),
    anonymousAuthSessionSubjectIndexColumns: queryRemoteOpsD1(
      'PRAGMA index_info(anonymous_auth_sessions_auth_subject)',
    ),
    controls: queryRemoteOpsD1(`${controlSelect} ORDER BY control_key`),
    expiryIndexColumns: queryRemoteOpsD1(
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
    revealSubmissionBaselineIndexColumns: queryRemoteOpsD1(
      'PRAGMA index_info(reveal_submissions_status_created_at_ms)',
    ),
    revealSubmissionCounts: queryRemoteOpsD1(
      `SELECT
        (SELECT COUNT(*) FROM reveal_submissions) AS reveal_submission_count,
        (SELECT COUNT(*)
          FROM reveal_submissions AS submission
          JOIN reveal_submission_storage_control AS control ON control.singleton = 1
          WHERE
            submission.status = 'confirmed' AND
            submission.created_at_ms <= control.cutover_at_ms
        ) AS reveal_submission_cutover_count`,
    ),
    revealSubmissionStorageControl: queryRemoteOpsD1(`SELECT
      singleton,
      paused,
      revision,
      updated_at_ms,
      cutover_at_ms
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
    tableList: queryRemoteOpsD1(`SELECT name, type, strict
      FROM pragma_table_list
      WHERE
        schema = 'main' AND
        name IN (
          'profile_addresses',
          'auth_provider_retirement',
          'anonymous_auth_sessions',
          'profiles',
          'rate_limit_buckets',
          'reveal_submission_storage_control',
          'reveal_submissions',
          'staff_auth_challenges',
          'staff_auth_sessions',
          'wallet_sessions',
          'worker_controls'
        )
      ORDER BY name`),
    walletSessionColumns: queryRemoteOpsD1(
      'PRAGMA table_info(wallet_sessions)',
    ),
    walletSessionCounts: queryRemoteOpsD1(
      'SELECT COUNT(*) AS wallet_session_count FROM wallet_sessions',
    ),
    workerControlColumns: queryRemoteOpsD1(
      'PRAGMA table_info(worker_controls)',
    ),
  }, {
    profileAddressCount: PRODUCTION_MIN_PROFILE_ADDRESS_COUNT,
    profileCount: PRODUCTION_MIN_PROFILE_COUNT,
    revealSubmissionCutoverCount: PRODUCTION_MIN_REVEAL_SUBMISSION_CUTOVER_COUNT,
    walletSessionCount: PRODUCTION_MIN_WALLET_SESSION_COUNT,
  });
}

function mutationTimestamp(value: number): number {
  return safeInteger(value, 'Ready-notification mutation timestamp');
}

export function buildSetReadyNotificationsPausedSql(
  paused: boolean,
  expectedRevision: number,
  nowMs: number,
): string {
  const revision = safeInteger(
    expectedRevision,
    'Ready-notification expected revision',
    1,
  );
  const timestamp = mutationTimestamp(nowMs);
  return `UPDATE worker_controls
SET
  paused = ${paused ? 1 : 0},
  revision = revision + 1,
  updated_at_ms = MAX(updated_at_ms, ${timestamp})
WHERE
  control_key = 'ready_notifications' AND
  revision = ${revision}
RETURNING
  control_key,
  paused,
  cursor_path,
  revision,
  created_at_ms,
  updated_at_ms,
  cursor_updated_at_ms`;
}

function runControlMutation(sql: string, failureMessage: string): ReadyNotificationsControl {
  const rows = queryRemoteOpsD1(sql);
  if (rows.length !== 1) {
    return fail(failureMessage);
  }
  return parseReadyNotificationsControl(rows[0]);
}

export function setRemoteReadyNotificationsPaused(
  paused: boolean,
  expectedRevision: number,
  nowMs = Date.now(),
): ReadyNotificationsControl {
  return runControlMutation(
    buildSetReadyNotificationsPausedSql(paused, expectedRevision, nowMs),
    'Ready-notification control changed concurrently; inspect its current state before retrying.',
  );
}
