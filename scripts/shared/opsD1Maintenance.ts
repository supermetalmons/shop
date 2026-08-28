import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCanonicalReadyNotificationCursorPath } from '../../shared/readyToShipNotificationReconciliation.ts';
import { sqlSchemaFingerprint } from './sqlSchemaFingerprint.ts';

export const READY_NOTIFICATIONS_CONTROL_KEY = 'ready_notifications';
const OPS_D1_MIGRATIONS = [
  '0001_current_schema.sql',
  '0002_reveal_submission_write_fence.sql',
] as const;

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
};

export type OpsD1IntegrityInput = {
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
  revealSubmissionStatusIndexColumns: OpsD1Row[];
  revealSubmissionCounts: OpsD1Row[];
  revealSubmissionStorageControl: OpsD1Row[];
  revealSubmissionStorageControlColumns: OpsD1Row[];
  schema: OpsD1Row[];
  tableList: OpsD1Row[];
  authWalletBindingColumns: OpsD1Row[];
  authWalletBindingCounts: OpsD1Row[];
  workerControlColumns: OpsD1Row[];
};

export type OpsD1IntegrityReport = {
  anonymousAuthSessionCount: number;
  profileAddressCount: number;
  profileCount: number;
  readyNotifications: ReadyNotificationsControl;
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
  ['reveal_submission_storage_control', { fingerprint: '0853bb4e152ba2684f234566a2a99b5ab120b00784d3c37f3729eb43ce8bee15', type: 'table', tableName: 'reveal_submission_storage_control' }],
  ['reveal_submission_control_delete_guard', { fingerprint: '618977009b6bee7cf3d40c4cfcf2960308bffd65e5b60d9301143645813a3d1e', type: 'trigger', tableName: 'reveal_submission_storage_control' }],
  ['reveal_submission_control_insert_guard', { fingerprint: 'b6a050331e2963b75a17192d41e0a7232d6127f14cf8f3248a125590421d4e72', type: 'trigger', tableName: 'reveal_submission_storage_control' }],
  ['reveal_submission_control_update_guard', { fingerprint: '957b34444242934db86c074d42114b05f8759d26394761385f2a5d67373068ed', type: 'trigger', tableName: 'reveal_submission_storage_control' }],
  ['reveal_submission_insert_pause_guard', { fingerprint: '3b8dadcac0fccb8f2e509e4abc8623394ec2e6f44a60c06ec39f454c10038a2c', type: 'trigger', tableName: 'reveal_submissions' }],
  ['reveal_submission_update_pause_guard', { fingerprint: 'c394783d4dd4dd368662a543a07eac104e5018fb1d87df4fe4b8314fbf1570c1', type: 'trigger', tableName: 'reveal_submissions' }],
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
    'auth_wallet_bindings',
    {
      fingerprint: '3345a6bd59f40909c4b1c6518e94b7562b820d62339703ff3260105b3a75029d',
      type: 'table',
      tableName: 'auth_wallet_bindings',
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

function assertExpiryIndexColumns(rows: OpsD1Row[]): void {
  if (rows.length !== 1 || rows[0].name !== 'expires_at_ms') {
    fail('Ops D1 expiry index columns are not exact.');
  }
  assertExactInteger(rows[0].seqno, 0, 'Ops D1 expiry index sequence');
  assertExactInteger(rows[0].cid, 7, 'Ops D1 expiry index column id');
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
  assertExpiryIndexColumns(input.expiryIndexColumns);
  if (input.controls.length !== 1) {
    return fail('Ops D1 must contain exactly one worker control.');
  }
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
    readyNotifications: parseReadyNotificationsControl(input.controls[0]),
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
