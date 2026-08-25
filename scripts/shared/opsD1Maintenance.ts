import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCanonicalReadyNotificationCursorPath } from '../../shared/readyToShipNotificationReconciliation.ts';

export const READY_NOTIFICATIONS_CONTROL_KEY = 'ready_notifications';
const OPS_D1_MIGRATIONS = ['0001_ops_state.sql'] as const;

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

export type OpsD1IntegrityInput = {
  controls: OpsD1Row[];
  expiryIndexColumns: OpsD1Row[];
  migrations: OpsD1Row[];
  quickCheck: OpsD1Row[];
  rateLimitBucketColumns: OpsD1Row[];
  schema: OpsD1Row[];
  tableList: OpsD1Row[];
  workerControlColumns: OpsD1Row[];
};

export type OpsD1IntegrityReport = {
  readyNotifications: ReadyNotificationsControl;
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

export function assertOpsD1Integrity(
  input: OpsD1IntegrityInput,
): OpsD1IntegrityReport {
  if (
    input.quickCheck.length !== 1 ||
    String(input.quickCheck[0].quick_check || '').toLowerCase() !== 'ok'
  ) {
    return fail('Ops D1 quick_check failed.');
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
  assertExactColumns(
    input.rateLimitBucketColumns,
    expectedRateLimitBucketColumns,
    'rate_limit_buckets',
  );
  assertExpiryIndexColumns(input.expiryIndexColumns);
  if (input.controls.length !== 1) {
    return fail('Ops D1 must contain exactly one worker control.');
  }
  return {
    readyNotifications: parseReadyNotificationsControl(input.controls[0]),
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

function queryRemoteOpsD1(sql: string): OpsD1Row[] {
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
    migrations: queryRemoteOpsD1(
      'SELECT name FROM d1_migrations ORDER BY id',
    ),
    quickCheck: queryRemoteOpsD1('PRAGMA quick_check'),
    rateLimitBucketColumns: queryRemoteOpsD1(
      'PRAGMA table_info(rate_limit_buckets)',
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
        name IN ('rate_limit_buckets', 'worker_controls')
      ORDER BY name`),
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
