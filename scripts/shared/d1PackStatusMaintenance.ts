import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACK_STATUS_SUPPORTED_DROP_IDS,
  type PackStatusCounters,
} from '../../shared/packStatus.ts';

type D1Row = Record<string, unknown>;

export type D1IntegrityInput = {
  eventCounts: D1Row[];
  foreignKeyCheck: D1Row[];
  invalidEvents: D1Row[];
  metadata: D1Row[];
  migrations: D1Row[];
  quickCheck: D1Row[];
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = 'cloud/workers/api/wrangler.jsonc';
const envFilePath = 'cloud/workers/api/release.env';
const databaseName = 'mons-shop-data';
const wranglerBinary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const PACK_STATUS_D1_MIGRATIONS = [
  '0001_current_schema.sql',
  '0002_pack_status_event_conflict_guard.sql',
] as const;
const expectedSchema = new Map<string, { fingerprint: string; tableName: string; type: string }>([
  ['pack_status', { fingerprint: '07ce5b3993d512fd6187ef3b166dc8999eb9d63be0784e3b274dcb8c6f41c670', tableName: 'pack_status', type: 'table' }],
  ['pack_status_events', { fingerprint: 'ec23d654f43dd5879550aca3dea7091cf173359a42c63bfa833e7b34e92a0055', tableName: 'pack_status_events', type: 'table' }],
  ['pack_status_metadata', { fingerprint: '12e69decbe56b47f9e776ec9cf1458343a81fdb67e9dca10c9e7d53db5682e64', tableName: 'pack_status_metadata', type: 'table' }],
  ['pack_status_event_apply', { fingerprint: 'fe74b0ff2c6530b0a7b351b4a5b8c0f8307b552d0cf6d7744efe131cea1fc482', tableName: 'pack_status_events', type: 'trigger' }],
  ['pack_status_event_conflict_guard', { fingerprint: '05fb483b2243983d69647aa643b251a8d0dab79406f5be6024b1abf99647b905', tableName: 'pack_status_events', type: 'trigger' }],
  ['pack_status_event_delete_guard', { fingerprint: '79a1f81ed7e9daaa311764ad15da4289545a31391c60c6e61acc2b2a36fb11d3', tableName: 'pack_status_events', type: 'trigger' }],
  ['pack_status_event_immutable', { fingerprint: '422a24523511b6a2b34d10d6b6807f25c7a6b88ea075e757c55b888a49b35b38', tableName: 'pack_status_events', type: 'trigger' }],
  ['pack_status_event_type_guard', { fingerprint: '69e2502196836b0c734bc7f25a37627a1eab8bd14d885852546992c830224451', tableName: 'pack_status_events', type: 'trigger' }],
]);

function fail(message: string): never {
  throw new Error(message);
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
      '--env-file', envFilePath,
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

function executeD1(sql: string): D1Row[][] {
  return parseD1Envelope(runWrangler([
    'd1', 'execute', databaseName, '--remote', '--command', sql,
  ], true)).map((entry) => entry.results);
}

function queryD1(sql: string): D1Row[] {
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

function schemaFingerprint(value: unknown): string {
  const normalized = requiredString(value, 'D1 schema SQL')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

function assertExactSchema(rows: D1Row[]): void {
  if (rows.length !== expectedSchema.size) fail('D1 pack-status application schema is not exact.');
  const seen = new Set<string>();
  for (const row of rows) {
    const name = requiredString(row.name, 'D1 schema name');
    const expected = expectedSchema.get(name);
    if (
      seen.has(name) ||
      !expected ||
      row.type !== expected.type ||
      row.tbl_name !== expected.tableName ||
      schemaFingerprint(row.sql) !== expected.fingerprint
    ) fail('D1 pack-status application schema is not exact.');
    seen.add(name);
  }
}

export function assertD1Integrity(input: D1IntegrityInput): D1IntegrityReport {
  if (
    input.metadata.length !== 1 ||
    Number(input.metadata[0].singleton) !== 1
  ) fail('Pack-status metadata is invalid.');
  const cacheGeneration = positiveInteger(input.metadata[0].cache_generation, 'd1.cache_generation');
  if (
    input.quickCheck.length !== 1 ||
    String(input.quickCheck[0].quick_check || '').toLowerCase() !== 'ok'
  ) fail('D1 quick_check failed.');
  if (input.foreignKeyCheck.length !== 0) fail('D1 foreign_key_check failed.');
  if (input.invalidEvents.length !== 0) fail('D1 contains invalid pack-status event payloads.');
  exactStringSet(
    input.migrations.map((row) => requiredString(row.name, 'D1 migration name')),
    PACK_STATUS_D1_MIGRATIONS,
    'D1 pack-status migrations',
  );
  assertExactSchema(input.schema);

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
    migrations: queryD1('SELECT name FROM d1_migrations ORDER BY id'),
    metadata: queryD1('SELECT singleton, cache_generation FROM pack_status_metadata ORDER BY singleton'),
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
    schema: queryD1(`SELECT name, type, tbl_name, sql FROM sqlite_schema
      WHERE
        name NOT LIKE 'sqlite_%' AND
        name NOT GLOB '_cf_*' AND
        name <> 'd1_migrations'
      ORDER BY name`),
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
  FROM pack_status_metadata
  WHERE singleton = 1 AND ${eventPrecondition}
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
  UPDATE pack_status_metadata
  SET cache_generation = cache_generation + 1, updated_at_ms = ${nowMs}
  WHERE singleton = 1 AND ${eventPrecondition};`;
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
