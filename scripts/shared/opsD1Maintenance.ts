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

export type WalletSessionStorageControl = {
  source: 'd1';
  revision: number;
  updatedAtMs: number;
};

export type RevealSubmissionStorageControl = {
  paused: boolean;
  source: 'd1';
  revision: number;
  updatedAtMs: number;
  cutoverAtMs: number | null;
};

export type OpsD1IntegrityInput = {
  controls: OpsD1Row[];
  expiryIndexColumns: OpsD1Row[];
  foreignKeyCheck: OpsD1Row[];
  migrations: OpsD1Row[];
  profileAddressColumns: OpsD1Row[];
  profileCounts: OpsD1Row[];
  profileColumns: OpsD1Row[];
  profileStorageControl: OpsD1Row[];
  profileStorageControlColumns: OpsD1Row[];
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
  walletSessionStorageControl: OpsD1Row[];
  walletSessionStorageControlColumns: OpsD1Row[];
  workerControlColumns: OpsD1Row[];
};

export type OpsD1IntegrityReport = {
  profileAddressCount: number;
  profileCount: number;
  profileStorageSource: 'd1';
  readyNotifications: ReadyNotificationsControl;
  revealSubmissionCount: number;
  revealSubmissionStorage: RevealSubmissionStorageControl;
  walletSessionCount: number;
  walletSessionStorage: WalletSessionStorageControl;
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
  [
    'reveal_submissions_status_created_at_ms',
    {
      fingerprint: 'c19d631a0f0ffab085cc48fab19ae012694d49036c349047dc7d7187d066d6b5',
      type: 'index',
      tableName: 'reveal_submissions',
    },
  ],
  [
    'reveal_submission_storage_control',
    {
      fingerprint: 'a96ae38f775189e18221ec8ddf2e7c20de8857f588eaa0019f1c0369dbd42505',
      type: 'table',
      tableName: 'reveal_submission_storage_control',
    },
  ],
  [
    'reveal_submission_storage_d1_immutable_guard',
    {
      fingerprint: '1a229715b81eeeaec5911d8c21aaa296fe858e513700109a0e30be5538babb78',
      type: 'trigger',
      tableName: 'reveal_submission_storage_control',
    },
  ],
  [
    'reveal_submission_storage_delete_guard',
    {
      fingerprint: '71aaffadef67b9c0fe2394c6601b4b97c47925df014ad534d79b7eae41120178',
      type: 'trigger',
      tableName: 'reveal_submission_storage_control',
    },
  ],
  [
    'reveal_submission_storage_insert_guard',
    {
      fingerprint: 'f2c687e87e40f40582ef0b182d38ad0b5c8650ac5bbaa85cc86f5fae8081b13e',
      type: 'trigger',
      tableName: 'reveal_submission_storage_control',
    },
  ],
  [
    'reveal_submission_storage_update_guard',
    {
      fingerprint: '70a75dc47b5348215428860c8daf1c33010947f2de67484d54983c7edd68fa6c',
      type: 'trigger',
      tableName: 'reveal_submission_storage_control',
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
    'profile_storage_control',
    {
      fingerprint: '0278093932cf6724c1b08cd05ae33b800d96a2eb32951dcd1c5569fc88be8972',
      type: 'table',
      tableName: 'profile_storage_control',
    },
  ],
  [
    'profile_storage_delete_guard',
    {
      fingerprint: 'c3382b13d0c57b4304d56cb883f7e71f3da47c180fe8a595d76ee52f2cefd9cb',
      type: 'trigger',
      tableName: 'profile_storage_control',
    },
  ],
  [
    'profile_storage_insert_guard',
    {
      fingerprint: '95a0fa6fa01ef5114a3222a5033dc0f6785fa5e97243b2a16bddb3f75c86a2d9',
      type: 'trigger',
      tableName: 'profile_storage_control',
    },
  ],
  [
    'profile_storage_source_immutable',
    {
      fingerprint: '04043c620da863760a2ee64bba4422bd54ed52a0a277ae14f24b04e2a3502165',
      type: 'trigger',
      tableName: 'profile_storage_control',
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
    'wallet_session_storage_control',
    {
      fingerprint: '00c90a3be80876d638deda8ba490605bf9a950bf5e6e3781e061e323d777f4d7',
      type: 'table',
      tableName: 'wallet_session_storage_control',
    },
  ],
  [
    'wallet_session_storage_delete_guard',
    {
      fingerprint: '6a139510dbde42ed8087610ea4911aa7d32f7d5fb5ff268c19bfb8bc0e011c13',
      type: 'trigger',
      tableName: 'wallet_session_storage_control',
    },
  ],
  [
    'wallet_session_storage_d1_immutable_guard',
    {
      fingerprint: 'c2d243dfc580c0cf2012daa570b506d44c0c3c90b054eaf8e013ee91661d6d11',
      type: 'trigger',
      tableName: 'wallet_session_storage_control',
    },
  ],
  [
    'wallet_session_storage_insert_guard',
    {
      fingerprint: '0c7cc2320652eedabc0e3badf2775243f8e0acbdf83c3072454426aace43ab2e',
      type: 'trigger',
      tableName: 'wallet_session_storage_control',
    },
  ],
  [
    'wallet_session_storage_transition_guard',
    {
      fingerprint: '14b179d795a5bee9ba9138dc727961289cf88196c6278c26098222756b4a7ae1',
      type: 'trigger',
      tableName: 'wallet_session_storage_control',
    },
  ],
  [
    'wallet_session_storage_update_guard',
    {
      fingerprint: 'afe499cf6b9eb54bc4af718d00d450a206b3fa6e45f6d424a94b0d1030d15684',
      type: 'trigger',
      tableName: 'wallet_session_storage_control',
    },
  ],
  [
    'wallet_sessions',
    {
      fingerprint: 'c116ba37f7da13ffc3f004c2860a10d36918904d769ef4fe8a6f511e836b50a5',
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

const expectedProfileStorageControlColumns: readonly ExpectedColumn[] = [
  ['singleton', 'INTEGER', 1, 1],
  ['read_source', 'TEXT', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
];

const expectedWalletSessionColumns: readonly ExpectedColumn[] = [
  ['firebase_uid', 'TEXT', 1, 1],
  ['wallet', 'TEXT', 1, 0],
  ['expires_at_ms', 'INTEGER', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
  ['wallet_revision', 'INTEGER', 1, 0],
  ['reconcile_lease_id', 'TEXT', 0, 0],
  ['reconcile_lease_expires_at_ms', 'INTEGER', 0, 0],
];

const expectedWalletSessionStorageControlColumns: readonly ExpectedColumn[] = [
  ['singleton', 'INTEGER', 1, 1],
  ['storage_source', 'TEXT', 1, 0],
  ['revision', 'INTEGER', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
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
  ['storage_source', 'TEXT', 1, 0],
  ['revision', 'INTEGER', 1, 0],
  ['created_at_ms', 'INTEGER', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
  ['cutover_at_ms', 'INTEGER', 0, 0],
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

function parseWalletSessionStorageControl(
  row: OpsD1Row,
): WalletSessionStorageControl {
  const source = row.storage_source;
  if (source !== 'd1') {
    return fail('Wallet-session storage source must be d1.');
  }
  if (row.singleton !== 1) {
    return fail('Wallet-session storage singleton is invalid.');
  }
  return {
    source,
    revision: safeInteger(row.revision, 'Wallet-session storage revision', 1),
    updatedAtMs: safeInteger(row.updated_at_ms, 'Wallet-session storage update timestamp'),
  };
}

function parseRevealSubmissionStorageControl(
  row: OpsD1Row,
): RevealSubmissionStorageControl {
  if (
    row.singleton !== 1 ||
    (row.paused !== 0 && row.paused !== 1) ||
    row.storage_source !== 'd1'
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
    source: row.storage_source,
    revision,
    updatedAtMs,
    cutoverAtMs,
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
    input.workerControlColumns,
    expectedWorkerControlColumns,
    'worker_controls',
  );
  assertRevealSubmissionBaselineIndexColumns(input.revealSubmissionBaselineIndexColumns);
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
    input.profileStorageControlColumns,
    expectedProfileStorageControlColumns,
    'profile_storage_control',
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
    input.walletSessionStorageControlColumns,
    expectedWalletSessionStorageControlColumns,
    'wallet_session_storage_control',
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
  if (input.profileStorageControl.length !== 1) {
    return fail('Ops D1 must contain exactly one profile storage control.');
  }
  if (input.walletSessionStorageControl.length !== 1) {
    return fail('Ops D1 must contain exactly one wallet-session storage control.');
  }
  if (input.revealSubmissionStorageControl.length !== 1) {
    return fail('Ops D1 must contain exactly one reveal-submission storage control.');
  }
  const walletSessionStorage = parseWalletSessionStorageControl(
    input.walletSessionStorageControl[0],
  );
  const revealSubmissionStorage = parseRevealSubmissionStorageControl(
    input.revealSubmissionStorageControl[0],
  );
  const source = input.profileStorageControl[0].read_source;
  if (source !== 'd1') return fail('Ops D1 profile storage source must be d1.');
  if (input.profileStorageControl[0].singleton !== 1) {
    return fail('Ops D1 profile storage singleton is invalid.');
  }
  safeInteger(input.profileStorageControl[0].updated_at_ms, 'Ops D1 profile storage update timestamp');
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
  if (
    walletSessionStorage.source === 'd1' &&
    walletSessionCount < minimums.walletSessionCount
  ) {
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
  if (
    revealSubmissionStorage.source === 'd1' &&
    revealSubmissionCutoverCount < minimums.revealSubmissionCutoverCount
  ) {
    return fail('Ops D1 reveal-submission count is below the production cutover baseline.');
  }
  return {
    profileAddressCount,
    profileCount,
    profileStorageSource: source,
    readyNotifications: parseReadyNotificationsControl(input.controls[0]),
    revealSubmissionCount,
    revealSubmissionStorage,
    walletSessionCount,
    walletSessionStorage,
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
    profileStorageControl: queryRemoteOpsD1(`SELECT singleton, read_source, updated_at_ms
      FROM profile_storage_control`),
    profileStorageControlColumns: queryRemoteOpsD1(
      'PRAGMA table_info(profile_storage_control)',
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
      storage_source,
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
          'profile_storage_control',
          'profiles',
          'rate_limit_buckets',
          'reveal_submission_storage_control',
          'reveal_submissions',
          'wallet_sessions',
          'wallet_session_storage_control',
          'worker_controls'
        )
      ORDER BY name`),
    walletSessionColumns: queryRemoteOpsD1(
      'PRAGMA table_info(wallet_sessions)',
    ),
    walletSessionCounts: queryRemoteOpsD1(
      'SELECT COUNT(*) AS wallet_session_count FROM wallet_sessions',
    ),
    walletSessionStorageControl: queryRemoteOpsD1(`SELECT
      singleton,
      storage_source,
      revision,
      updated_at_ms
      FROM wallet_session_storage_control`),
    walletSessionStorageControlColumns: queryRemoteOpsD1(
      'PRAGMA table_info(wallet_session_storage_control)',
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

function sqlNullableString(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

export function buildImportReadyNotificationsControlSql(
  cursorPath: string | null,
  nowMs: number,
): string {
  const timestamp = mutationTimestamp(nowMs);
  const normalizedCursor = cursorPath === null
    ? null
    : validateReadyNotificationCursorPath(cursorPath);
  return `UPDATE worker_controls
SET
  paused = 1,
  cursor_path = ${sqlNullableString(normalizedCursor)},
  revision = revision + 1,
  updated_at_ms = ${timestamp},
  cursor_updated_at_ms = ${normalizedCursor === null ? 'NULL' : timestamp}
WHERE
  control_key = 'ready_notifications' AND
  paused = 0 AND
  cursor_path IS NULL AND
  revision = 1 AND
  created_at_ms = 0 AND
  updated_at_ms = 0 AND
  cursor_updated_at_ms IS NULL
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

export function importRemoteReadyNotificationsControl(
  cursorPath: string | null,
  nowMs = Date.now(),
): ReadyNotificationsControl {
  return runControlMutation(
    buildImportReadyNotificationsControlSql(cursorPath, nowMs),
    'Ready-notification control import requires the untouched seeded Ops D1 control.',
  );
}
