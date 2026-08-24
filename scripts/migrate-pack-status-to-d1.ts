import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PACK_STATUS_SUPPORTED_DROP_IDS,
  type PackStatusCounters,
} from '../shared/packStatus.ts';

type Command = 'bookmark' | 'integrity' | 'probe';
type D1Row = Record<string, unknown>;

type Args = {
  command: Command;
};

export type D1IntegrityInput = {
  eventCounts: D1Row[];
  foreignKeyCheck: D1Row[];
  invalidEvents: D1Row[];
  migrations: D1Row[];
  quickCheck: D1Row[];
  rollout: D1Row[];
  schema: D1Row[];
  summaries: D1Row[];
};

export type D1IntegrityReport = {
  cacheGeneration: number;
  drops: Array<{
    dropId: string;
    eventCount: number;
    historicalEventCount: number;
    appliedEventCount: number;
    counters: PackStatusCounters;
  }>;
  eventCount: number;
};

export type D1EventCountExpectation = Pick<
  D1IntegrityReport['drops'][number],
  'appliedEventCount' | 'dropId' | 'eventCount' | 'historicalEventCount'
>;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = 'cloud/workers/api/wrangler.jsonc';
const databaseName = 'mons-shop-data';
const probeDropId = '__mons_pack_status_trigger_probe__';
const probeEventKey = 'retirement';
const wranglerBinary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const expectedSchema = new Map([
  ['pack_status', 'table'],
  ['pack_status_events', 'table'],
  ['pack_status_rollout', 'table'],
  ['pack_status_event_apply', 'trigger'],
  ['pack_status_event_delete_guard', 'trigger'],
  ['pack_status_event_immutable', 'trigger'],
  ['pack_status_event_type_guard', 'trigger'],
  ['pack_status_rollout_d1_only_insert_guard', 'trigger'],
  ['pack_status_rollout_d1_only_update_guard', 'trigger'],
]);
const expectedMigrations = [
  '0001_pack_status.sql',
  '0002_pack_status_event_type_guard.sql',
  '0003_pack_status_d1_only.sql',
];
const bookmarkPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{8}){2}-[0-9a-f]{32}$/i;

function fail(message: string): never {
  throw new Error(message);
}

function usage(): string {
  return [
    'Usage:',
    '  npm run migrate:pack-status -- integrity',
    '  npm run migrate:pack-status -- probe',
    '  npm run migrate:pack-status -- bookmark',
  ].join('\n');
}

export function parseArgs(argv: string[]): Args {
  const command = argv[0];
  if (
    argv.length !== 1 ||
    (command !== 'bookmark' && command !== 'integrity' && command !== 'probe')
  ) fail(usage());
  return { command };
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) fail(`${label} must be a positive safe integer.`);
  return normalized;
}

function nonnegativeInteger(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) fail(`${label} must be a non-negative safe integer.`);
  return normalized;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runWrangler(args: string[], json = false): string {
  try {
    return execFileSync(wranglerBinary, [
      ...args,
      '--config', configPath,
      ...(json ? ['--json'] : []),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const output = error && typeof error === 'object'
      ? [
          'stdout' in error ? (error as { stdout?: unknown }).stdout : '',
          'stderr' in error ? (error as { stderr?: unknown }).stderr : '',
        ].map((value) => String(value || '').replace(/\u001b\[[0-9;]*m/g, '').trim()).filter(Boolean).join('\n')
      : '';
    fail(output || 'Wrangler D1 command failed.');
  }
}

function parseD1Envelope(output: string): Array<{ results: D1Row[]; success: boolean }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return fail('D1 returned invalid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) fail('D1 returned an invalid query envelope.');
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('D1 returned an invalid query result.');
    const result = entry as { results?: unknown; success?: unknown };
    if (result.success !== true || !Array.isArray(result.results)) fail('D1 query failed.');
    return { results: result.results as D1Row[], success: true };
  });
}

export function executeD1(sql: string): D1Row[][] {
  return parseD1Envelope(runWrangler([
    'd1', 'execute', databaseName, '--remote', '--command', sql,
  ], true)).map((entry) => entry.results);
}

export function queryD1(sql: string): D1Row[] {
  const results = executeD1(sql);
  if (results.length !== 1) fail('Expected exactly one D1 statement result.');
  return results[0];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) fail(`${label} must be a non-empty string.`);
  return value;
}

function parseSummary(row: D1Row): PackStatusCounters {
  const dropId = requiredString(row.drop_id, 'd1.drop_id');
  const counters: PackStatusCounters = {
    dropId,
    totalInitialSupply: positiveInteger(row.total_initial_supply, `${dropId}.total_initial_supply`),
    totalCards: positiveInteger(row.total_cards, `${dropId}.total_cards`),
    cardsPerPack: positiveInteger(row.cards_per_pack, `${dropId}.cards_per_pack`),
    unsealedOnline: nonnegativeInteger(row.unsealed_online, `${dropId}.unsealed_online`),
    redeemedIrlNormal: nonnegativeInteger(row.redeemed_irl_normal, `${dropId}.redeemed_irl_normal`),
    redeemedIrlStripe: nonnegativeInteger(row.redeemed_irl_stripe, `${dropId}.redeemed_irl_stripe`),
    redeemedUnsealedCards: nonnegativeInteger(row.redeemed_unsealed_cards, `${dropId}.redeemed_unsealed_cards`),
  };
  if (positiveInteger(row.version, `${dropId}.version`) !== 1) fail(`${dropId}.version must be one.`);
  if (counters.totalCards !== counters.totalInitialSupply * counters.cardsPerPack) {
    fail(`${dropId} pack-status total is inconsistent.`);
  }
  if (row.rebuilt_at_ms !== null) nonnegativeInteger(row.rebuilt_at_ms, `${dropId}.rebuilt_at_ms`);
  nonnegativeInteger(row.updated_at_ms, `${dropId}.updated_at_ms`);
  return counters;
}

function exactStringSet(actual: string[], expected: readonly string[], label: string): void {
  const normalizedActual = [...actual].sort();
  const normalizedExpected = [...expected].sort();
  if (
    normalizedActual.length !== normalizedExpected.length ||
    normalizedActual.some((value, index) => value !== normalizedExpected[index])
  ) fail(`${label} are not exact.`);
}

export function assertD1Integrity(input: D1IntegrityInput): D1IntegrityReport {
  if (
    input.rollout.length !== 1 ||
    Number(input.rollout[0].singleton) !== 1 ||
    input.rollout[0].read_source !== 'd1'
  ) fail('Pack-status rollout is not locked to D1.');
  const cacheGeneration = positiveInteger(input.rollout[0].cache_generation, 'd1.cache_generation');
  if (
    input.quickCheck.length !== 1 ||
    String(input.quickCheck[0].quick_check || '').toLowerCase() !== 'ok'
  ) fail('D1 quick_check failed.');
  if (input.foreignKeyCheck.length !== 0) fail('D1 foreign_key_check failed.');
  if (input.invalidEvents.length !== 0) fail('D1 contains invalid pack-status event payloads.');

  const actualSchema = new Map(input.schema.map((row) => [
    requiredString(row.name, 'd1.schema.name'),
    requiredString(row.type, 'd1.schema.type'),
  ]));
  for (const [name, type] of expectedSchema) {
    if (actualSchema.get(name) !== type) fail(`Missing D1 ${type} ${name}.`);
  }
  exactStringSet(
    input.migrations.map((row) => requiredString(row.name, 'd1.migration.name')),
    expectedMigrations,
    'D1 pack-status migrations',
  );

  const summaries = input.summaries.map(parseSummary);
  exactStringSet(summaries.map((summary) => summary.dropId), PACK_STATUS_SUPPORTED_DROP_IDS, 'D1 pack-status summaries');
  const eventCounts = new Map<string, { eventCount: number; historicalEventCount: number; appliedEventCount: number }>();
  for (const row of input.eventCounts) {
    const dropId = requiredString(row.drop_id, 'd1.event_count.drop_id');
    if (eventCounts.has(dropId)) fail(`Duplicate D1 event count for ${dropId}.`);
    eventCounts.set(dropId, {
      eventCount: nonnegativeInteger(row.event_count, `${dropId}.event_count`),
      historicalEventCount: nonnegativeInteger(row.historical_event_count, `${dropId}.historical_event_count`),
      appliedEventCount: nonnegativeInteger(row.applied_event_count, `${dropId}.applied_event_count`),
    });
  }
  if ([...eventCounts.keys()].some((dropId) => !PACK_STATUS_SUPPORTED_DROP_IDS.includes(dropId as never))) {
    fail('D1 contains pack-status events for an unsupported drop.');
  }
  const drops = summaries
    .sort((left, right) => left.dropId.localeCompare(right.dropId))
    .map((counters) => {
      const counts = eventCounts.get(counters.dropId) || {
        eventCount: 0,
        historicalEventCount: 0,
        appliedEventCount: 0,
      };
      if (counts.historicalEventCount + counts.appliedEventCount !== counts.eventCount) {
        fail(`${counters.dropId} event counts are inconsistent.`);
      }
      return { dropId: counters.dropId, ...counts, counters };
    });
  return {
    cacheGeneration,
    drops,
    eventCount: drops.reduce((sum, drop) => sum + drop.eventCount, 0),
  };
}

export function readD1Integrity(): D1IntegrityReport {
  return assertD1Integrity({
    rollout: queryD1('SELECT singleton, read_source, cache_generation FROM pack_status_rollout ORDER BY singleton'),
    summaries: queryD1(`SELECT
      drop_id, version, total_initial_supply, total_cards, cards_per_pack,
      unsealed_online, redeemed_irl_normal, redeemed_irl_stripe, redeemed_unsealed_cards,
      rebuilt_at_ms, updated_at_ms
      FROM pack_status ORDER BY drop_id`),
    eventCounts: queryD1(`SELECT
      drop_id,
      COUNT(*) AS event_count,
      SUM(CASE WHEN apply_delta = 0 THEN 1 ELSE 0 END) AS historical_event_count,
      SUM(CASE WHEN apply_delta = 1 THEN 1 ELSE 0 END) AS applied_event_count
      FROM pack_status_events GROUP BY drop_id ORDER BY drop_id`),
    invalidEvents: queryD1(`SELECT drop_id, event_type, event_key
      FROM pack_status_events
      WHERE NOT (
        (
          event_type = 'onlineReveal' AND
          unsealed_online_delta > 0 AND
          redeemed_irl_normal_delta = 0 AND
          redeemed_irl_stripe_delta = 0 AND
          redeemed_unsealed_cards_delta = 0
        ) OR
        (
          event_type = 'redeemedIrlNormal' AND
          unsealed_online_delta = 0 AND
          redeemed_irl_stripe_delta = 0 AND
          redeemed_irl_normal_delta + redeemed_unsealed_cards_delta > 0
        ) OR
        (
          event_type = 'redeemedIrlStripe' AND
          unsealed_online_delta = 0 AND
          redeemed_irl_normal_delta = 0 AND
          redeemed_irl_stripe_delta > 0 AND
          redeemed_unsealed_cards_delta = 0
        )
      )
      ORDER BY drop_id, event_type, event_key`),
    schema: queryD1(`SELECT name, type FROM sqlite_schema
      WHERE name IN (${[...expectedSchema.keys()].map(sqlString).join(', ')})
      ORDER BY name`),
    migrations: queryD1(`SELECT name FROM d1_migrations
      WHERE name LIKE '%pack_status%' ORDER BY name`),
    quickCheck: queryD1('PRAGMA quick_check'),
    foreignKeyCheck: queryD1('PRAGMA foreign_key_check'),
  });
}

function normalizeRebuildCounters(
  input: PackStatusCounters | readonly PackStatusCounters[],
  nowMs: number,
): PackStatusCounters[] {
  nonnegativeInteger(nowMs, 'rebuild timestamp');
  const counters = Array.isArray(input) ? [...input] : [input];
  if (counters.length === 0) fail('At least one pack-status summary is required for rebuild.');
  const normalized = counters.map((entry) => {
    if (!PACK_STATUS_SUPPORTED_DROP_IDS.includes(entry.dropId as never)) {
      fail(`Unsupported pack-status drop: ${entry.dropId}.`);
    }
    return parseSummary({
      drop_id: entry.dropId,
      version: 1,
      total_initial_supply: entry.totalInitialSupply,
      total_cards: entry.totalCards,
      cards_per_pack: entry.cardsPerPack,
      unsealed_online: entry.unsealedOnline,
      redeemed_irl_normal: entry.redeemedIrlNormal,
      redeemed_irl_stripe: entry.redeemedIrlStripe,
      redeemed_unsealed_cards: entry.redeemedUnsealedCards,
      rebuilt_at_ms: nowMs,
      updated_at_ms: nowMs,
    });
  });
  if (new Set(normalized.map((entry) => entry.dropId)).size !== normalized.length) {
    fail('Pack-status rebuild contains a duplicate drop.');
  }
  return normalized;
}

function buildD1SummaryUpsertSql(
  counters: PackStatusCounters,
  nowMs: number,
  eventPrecondition: string,
): string {
  return `INSERT INTO pack_status (
    drop_id, version, total_initial_supply, total_cards, cards_per_pack,
    unsealed_online, redeemed_irl_normal, redeemed_irl_stripe, redeemed_unsealed_cards,
    rebuilt_at_ms, updated_at_ms
  )
  SELECT
    ${sqlString(counters.dropId)}, 1, ${counters.totalInitialSupply}, ${counters.totalCards},
    ${counters.cardsPerPack}, ${counters.unsealedOnline}, ${counters.redeemedIrlNormal},
    ${counters.redeemedIrlStripe}, ${counters.redeemedUnsealedCards}, ${nowMs}, ${nowMs}
  FROM pack_status_rollout
  WHERE singleton = 1 AND read_source = 'd1'
    AND ${eventPrecondition}
  ON CONFLICT(drop_id) DO UPDATE SET
    version = excluded.version,
    total_initial_supply = excluded.total_initial_supply,
    total_cards = excluded.total_cards,
    cards_per_pack = excluded.cards_per_pack,
    unsealed_online = excluded.unsealed_online,
    redeemed_irl_normal = excluded.redeemed_irl_normal,
    redeemed_irl_stripe = excluded.redeemed_irl_stripe,
    redeemed_unsealed_cards = excluded.redeemed_unsealed_cards,
    rebuilt_at_ms = excluded.rebuilt_at_ms,
    updated_at_ms = excluded.updated_at_ms;`;
}

function d1EventCountPrecondition(expected: readonly D1EventCountExpectation[]): string {
  exactStringSet(expected.map((entry) => entry.dropId), PACK_STATUS_SUPPORTED_DROP_IDS, 'D1 rebuild event-count drops');
  const normalized = expected.map((entry) => ({
    appliedEventCount: nonnegativeInteger(entry.appliedEventCount, `${entry.dropId}.applied_event_count`),
    dropId: entry.dropId,
    eventCount: nonnegativeInteger(entry.eventCount, `${entry.dropId}.event_count`),
    historicalEventCount: nonnegativeInteger(entry.historicalEventCount, `${entry.dropId}.historical_event_count`),
  }));
  for (const entry of normalized) {
    if (entry.appliedEventCount + entry.historicalEventCount !== entry.eventCount) {
      fail(`${entry.dropId} rebuild event counts are inconsistent.`);
    }
  }
  const total = normalized.reduce((sum, entry) => sum + entry.eventCount, 0);
  return [
    `(SELECT COUNT(*) FROM pack_status_events) = ${total}`,
    ...normalized.flatMap((entry) => [
      `(SELECT COUNT(*) FROM pack_status_events WHERE drop_id = ${sqlString(entry.dropId)}) = ${entry.eventCount}`,
      `(SELECT COUNT(*) FROM pack_status_events WHERE drop_id = ${sqlString(entry.dropId)} AND apply_delta = 0) = ${entry.historicalEventCount}`,
      `(SELECT COUNT(*) FROM pack_status_events WHERE drop_id = ${sqlString(entry.dropId)} AND apply_delta = 1) = ${entry.appliedEventCount}`,
    ]),
  ].join(' AND ');
}

export function buildD1SummaryRebuildSql(
  input: PackStatusCounters | readonly PackStatusCounters[],
  nowMs: number,
  expectedEvents?: readonly D1EventCountExpectation[],
): string {
  const counters = normalizeRebuildCounters(input, nowMs);
  const eventPrecondition = expectedEvents ? d1EventCountPrecondition(expectedEvents) : '1 = 1';
  const upserts = counters.map((entry) => buildD1SummaryUpsertSql(entry, nowMs, eventPrecondition));
  return `${upserts.join('\n')}
  UPDATE pack_status_rollout
  SET cache_generation = cache_generation + 1, updated_at_ms = ${nowMs}
  WHERE singleton = 1 AND read_source = 'd1'
    AND ${eventPrecondition};`;
}

export function writeD1RebuiltSummaries(
  input: readonly PackStatusCounters[],
  expectedEvents: readonly D1EventCountExpectation[],
  nowMs = Date.now(),
): void {
  const counters = normalizeRebuildCounters(input, nowMs);
  executeD1(buildD1SummaryRebuildSql(counters, nowMs, expectedEvents));
  const rows = queryD1(`SELECT
    drop_id, version, total_initial_supply, total_cards, cards_per_pack,
    unsealed_online, redeemed_irl_normal, redeemed_irl_stripe, redeemed_unsealed_cards,
    rebuilt_at_ms, updated_at_ms
    FROM pack_status
    WHERE drop_id IN (${counters.map((entry) => sqlString(entry.dropId)).join(', ')})
    ORDER BY drop_id`);
  if (rows.length !== counters.length) fail('D1 pack-status rebuild verification returned the wrong summaries.');
  const expectedByDrop = new Map(counters.map((entry) => [entry.dropId, entry]));
  for (const row of rows) {
    const rebuilt = parseSummary(row);
    const expected = expectedByDrop.get(rebuilt.dropId);
    if (
      !expected ||
      rebuilt.totalInitialSupply !== expected.totalInitialSupply ||
      rebuilt.totalCards !== expected.totalCards ||
      rebuilt.cardsPerPack !== expected.cardsPerPack ||
      rebuilt.unsealedOnline !== expected.unsealedOnline ||
      rebuilt.redeemedIrlNormal !== expected.redeemedIrlNormal ||
      rebuilt.redeemedIrlStripe !== expected.redeemedIrlStripe ||
      rebuilt.redeemedUnsealedCards !== expected.redeemedUnsealedCards ||
      Number(row.rebuilt_at_ms) !== nowMs ||
      Number(row.updated_at_ms) !== nowMs
    ) {
      fail(`D1 pack-status rebuild verification failed for ${rebuilt.dropId}.`);
    }
  }
}

function reportFingerprint(report: D1IntegrityReport): string {
  return JSON.stringify(report);
}

export function parseBookmarkOutput(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return fail('D1 Time Travel returned invalid JSON.');
  }
  const visit = (value: unknown): string | undefined => {
    if (typeof value === 'string' && bookmarkPattern.test(value)) return value;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const bookmark = visit(entry);
        if (bookmark) return bookmark;
      }
      return undefined;
    }
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.bookmark === 'string' && bookmarkPattern.test(record.bookmark)) return record.bookmark;
    for (const entry of Object.values(record)) {
      const bookmark = visit(entry);
      if (bookmark) return bookmark;
    }
    return undefined;
  };
  return visit(parsed) || fail('D1 Time Travel returned no bookmark.');
}

export function currentD1Bookmark(): string {
  return parseBookmarkOutput(runWrangler([
    'd1', 'time-travel', 'info', databaseName,
  ], true));
}

function cleanupD1TriggerProbe(): void {
  executeD1(`DELETE FROM pack_status_events
    WHERE drop_id = ${sqlString(probeDropId)}
      AND event_type = 'onlineReveal'
      AND event_key = ${sqlString(probeEventKey)};
    DELETE FROM pack_status WHERE drop_id = ${sqlString(probeDropId)};`);
}

export function runD1TriggerProbe(): D1IntegrityReport {
  cleanupD1TriggerProbe();
  const before = readD1Integrity();
  try {
    const nowMs = Date.now();
    executeD1(`INSERT INTO pack_status (
      drop_id, version, total_initial_supply, total_cards, cards_per_pack,
      unsealed_online, redeemed_irl_normal, redeemed_irl_stripe, redeemed_unsealed_cards,
      rebuilt_at_ms, updated_at_ms
    ) VALUES (${sqlString(probeDropId)}, 1, 1, 1, 1, 0, 0, 0, 0, ${nowMs}, ${nowMs});`);
    executeD1(`INSERT INTO pack_status_events (
      drop_id, event_type, event_key, quantity,
      unsealed_online_delta, redeemed_irl_normal_delta, redeemed_irl_stripe_delta,
      redeemed_unsealed_cards_delta, apply_delta, created_at_ms
    ) VALUES (${sqlString(probeDropId)}, 'onlineReveal', ${sqlString(probeEventKey)}, 1, 1, 0, 0, 0, 1, ${nowMs + 1});`);
    const rows = queryD1(`SELECT unsealed_online, updated_at_ms FROM pack_status WHERE drop_id = ${sqlString(probeDropId)}`);
    if (
      rows.length !== 1 ||
      Number(rows[0].unsealed_online) !== 1 ||
      Number(rows[0].updated_at_ms) !== nowMs + 1
    ) fail('D1 trigger probe did not apply the synthetic event.');
  } finally {
    cleanupD1TriggerProbe();
  }
  const after = readD1Integrity();
  if (reportFingerprint(after) !== reportFingerprint(before)) {
    fail('D1 trigger probe changed real pack-status data.');
  }
  return after;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'bookmark') {
    console.log(`[pack-status] D1 Time Travel bookmark: ${currentD1Bookmark()}`);
    return;
  }
  const report = args.command === 'probe' ? runD1TriggerProbe() : readD1Integrity();
  console.log(
    `[pack-status] D1 ${args.command} passed: ${report.drops.length} summaries, ${report.eventCount} events, cache generation ${report.cacheGeneration}.`,
  );
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href);
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`[pack-status] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
