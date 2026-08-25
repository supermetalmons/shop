import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  assertOpsD1Integrity,
  buildImportReadyNotificationsControlSql,
  buildSetReadyNotificationsPausedSql,
  parseReadyNotificationsControl,
  validateReadyNotificationCursorPath,
  type OpsD1IntegrityInput,
} from '../scripts/shared/opsD1Maintenance.ts';
import {
  parseLegacyReadyNotificationsControl,
  parseReadyNotificationsControlArgs,
  runReadyNotificationsControl,
  type ReadyNotificationsControlDependencies,
} from '../scripts/ops/readyNotificationsControl.ts';

const migrationSql = readFileSync(
  new URL(
    '../cloud/workers/api/ops-migrations/0001_ops_state.sql',
    import.meta.url,
  ),
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

function migratedApplicationSchema() {
  const db = database();
  try {
    return queryRows(db, applicationSchemaQuery);
  } finally {
    db.close();
  }
}

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

function columnRow(
  cid: number,
  name: string,
  type: 'INTEGER' | 'TEXT',
  notnull: 0 | 1,
  pk: number,
) {
  return { cid, name, type, notnull, dflt_value: null, pk };
}

const workerControlColumns = [
  columnRow(0, 'control_key', 'TEXT', 1, 1),
  columnRow(1, 'paused', 'INTEGER', 1, 0),
  columnRow(2, 'cursor_path', 'TEXT', 0, 0),
  columnRow(3, 'revision', 'INTEGER', 1, 0),
  columnRow(4, 'created_at_ms', 'INTEGER', 1, 0),
  columnRow(5, 'updated_at_ms', 'INTEGER', 1, 0),
  columnRow(6, 'cursor_updated_at_ms', 'INTEGER', 0, 0),
];

const rateLimitBucketColumns = [
  columnRow(0, 'scope', 'TEXT', 1, 1),
  columnRow(1, 'subject_hash', 'TEXT', 1, 2),
  columnRow(2, 'schema_version', 'INTEGER', 1, 0),
  columnRow(3, 'cluster', 'TEXT', 0, 0),
  columnRow(4, 'owner_wallet', 'TEXT', 0, 0),
  columnRow(5, 'receipt_asset_id', 'TEXT', 0, 0),
  columnRow(6, 'window_started_at_ms', 'INTEGER', 1, 0),
  columnRow(7, 'expires_at_ms', 'INTEGER', 1, 0),
  columnRow(8, 'request_count', 'INTEGER', 1, 0),
  columnRow(9, 'updated_at_ms', 'INTEGER', 1, 0),
];

function integrityInput(
  overrides: Partial<OpsD1IntegrityInput> = {},
): OpsD1IntegrityInput {
  return {
    controls: [controlRow()],
    expiryIndexColumns: [{ seqno: 0, cid: 7, name: 'expires_at_ms' }],
    migrations: [{ name: '0001_ops_state.sql' }],
    quickCheck: [{ quick_check: 'ok' }],
    rateLimitBucketColumns,
    schema: migratedApplicationSchema(),
    tableList: [
      { name: 'rate_limit_buckets', type: 'table', strict: 1 },
      { name: 'worker_controls', type: 'table', strict: 1 },
    ],
    workerControlColumns,
    ...overrides,
  };
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
      "SELECT name, strict FROM pragma_table_list WHERE name IN ('worker_controls', 'rate_limit_buckets') ORDER BY name",
    );
    assert.deepEqual(tables, [
      { name: 'rate_limit_buckets', strict: 1 },
      { name: 'worker_controls', strict: 1 },
    ]);
    assert.deepEqual(
      queryRows(
        db,
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'rate_limit_buckets_expires_at_ms'",
      ),
      [{ name: 'rate_limit_buckets_expires_at_ms' }],
    );
    assert.doesNotThrow(() =>
      assertOpsD1Integrity({
        controls,
        expiryIndexColumns: queryRows(
          db,
          'PRAGMA index_info(rate_limit_buckets_expires_at_ms)',
        ),
        migrations: [{ name: '0001_ops_state.sql' }],
        quickCheck: queryRows(db, 'PRAGMA quick_check'),
        rateLimitBucketColumns: queryRows(
          db,
          'PRAGMA table_info(rate_limit_buckets)',
        ),
        schema: queryRows(db, applicationSchemaQuery),
        tableList: queryRows(
          db,
          `SELECT name, type, strict
          FROM pragma_table_list
          WHERE
            schema = 'main' AND
            name IN ('rate_limit_buckets', 'worker_controls')
          ORDER BY name`,
        ),
        workerControlColumns: queryRows(
          db,
          'PRAGMA table_info(worker_controls)',
        ),
      }),
    );
  } finally {
    db.close();
  }
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
  } finally {
    db.close();
  }
});

test('ops D1 integrity requires exact migrations, schema, quick check, and singleton', () => {
  const healthy = integrityInput();
  assert.deepEqual(assertOpsD1Integrity(healthy), {
    readyNotifications: {
      controlKey: 'ready_notifications',
      paused: false,
      cursorPath: null,
      revision: 1,
      createdAtMs: 0,
      updatedAtMs: 0,
      cursorUpdatedAtMs: null,
    },
  });
  assert.throws(
    () => assertOpsD1Integrity(integrityInput({ migrations: [] })),
    /migrations/,
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

test('Firestore import copies a validated cursor exactly once into the seed', () => {
  const db = database();
  const cursorPath = 'drops/card_nft_2/deliveryOrders/7';
  try {
    const statement = db.prepare(
      buildImportReadyNotificationsControlSql(cursorPath, 5_000),
    );
    const imported = parseReadyNotificationsControl(statement.get()!);
    assert.equal(imported.paused, true);
    assert.equal(imported.cursorPath, cursorPath);
    assert.equal(imported.revision, 2);
    assert.equal(imported.cursorUpdatedAtMs, 5_000);
    assert.equal(statement.get(), undefined);
    assert.throws(
      () =>
        buildImportReadyNotificationsControlSql(
          "drops/card_nft_2/deliveryOrders/7' OR 1=1",
          5_000,
        ),
      /canonical delivery-order path/,
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
  assert.deepEqual(
    parseReadyNotificationsControlArgs(['import-firestore', '--write']),
    { command: 'import-firestore', write: true },
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

test('legacy control validation requires Firestore shape and canonical cursor', () => {
  assert.deepEqual(
    parseLegacyReadyNotificationsControl({
      path: 'workerControls/readyNotifications',
      id: 'readyNotifications',
      data: { paused: true },
    }),
    { paused: true, cursorPath: null },
  );
  assert.deepEqual(
    parseLegacyReadyNotificationsControl({
      path: 'workerControls/readyNotifications',
      id: 'readyNotifications',
      data: {
        paused: true,
        cursorPath: 'drops/card_nft_2/deliveryOrders/19',
      },
    }),
    {
      paused: true,
      cursorPath: 'drops/card_nft_2/deliveryOrders/19',
    },
  );
  assert.throws(
    () => parseLegacyReadyNotificationsControl(undefined),
    /missing/,
  );
  assert.throws(
    () =>
      parseLegacyReadyNotificationsControl({
        path: 'workerControls/readyNotifications',
        id: 'readyNotifications',
        data: { paused: true, cursorPath: null },
      }),
    /non-empty string/,
  );
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

test('operator imports only a paused legacy control and passes its cursor', async () => {
  const calls: unknown[] = [];
  const baseControl = parseReadyNotificationsControl(controlRow());
  const dependencies: ReadyNotificationsControlDependencies = {
    importControl: (cursorPath, nowMs) => {
      calls.push(['import', cursorPath, nowMs]);
      return { ...baseControl, paused: true, cursorPath, revision: 2 };
    },
    nowMs: () => 1_700_000_000_000,
    readControl: () => {
      calls.push(['read']);
      return baseControl;
    },
    readLegacyControl: async () => ({
      paused: true,
      cursorPath: 'drops/card_nft_2/deliveryOrders/8',
    }),
    setPaused: (paused, expectedRevision, nowMs) => {
      calls.push(['set', paused, expectedRevision, nowMs]);
      return { ...baseControl, paused, revision: 2 };
    },
  };
  await runReadyNotificationsControl(
    { command: 'pause', write: true },
    dependencies,
  );
  await runReadyNotificationsControl(
    { command: 'resume', write: true },
    dependencies,
  );
  await runReadyNotificationsControl(
    { command: 'import-firestore', write: true },
    dependencies,
  );
  assert.deepEqual(calls, [
    ['read'],
    ['set', true, 1, 1_700_000_000_000],
    ['read'],
    ['set', false, 1, 1_700_000_000_000],
    [
      'import',
      'drops/card_nft_2/deliveryOrders/8',
      1_700_000_000_000,
    ],
  ]);

  await assert.rejects(
    runReadyNotificationsControl(
      { command: 'import-firestore', write: true },
      {
        ...dependencies,
        readLegacyControl: async () => ({ paused: false, cursorPath: null }),
      },
    ),
    /must be paused/,
  );
});

test('operator validates D1 control before pause or resume mutation', async () => {
  let mutations = 0;
  const baseControl = parseReadyNotificationsControl(controlRow());
  await assert.rejects(
    runReadyNotificationsControl(
      { command: 'pause', write: true },
      {
        importControl: () => baseControl,
        nowMs: () => 1_700_000_000_000,
        readControl: () => parseReadyNotificationsControl(controlRow({
          cursor_path: 'drops/Card_NFT_2/deliveryOrders/7',
          cursor_updated_at_ms: 1,
          updated_at_ms: 1,
        })),
        readLegacyControl: async () => ({ paused: true, cursorPath: null }),
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
