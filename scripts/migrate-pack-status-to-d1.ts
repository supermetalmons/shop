import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FieldPath, Firestore, Timestamp, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import {
  PACK_STATUS_SUPPORTED_DROP_IDS,
  PACK_STATUS_SOURCE_HEADER,
  buildPackStatusStatsFields,
  type PackStatusCounters,
  type PackStatusEvent,
  type PackStatusEventIncrements,
  type PackStatusEventType,
  type PackStatusStatsFields,
} from '../shared/packStatus.ts';
import {
  firestoreReaderServiceAccountEmail,
  readCloudflareFirestoreKeychainCredential,
} from './cloudflare-firestore-keychain.ts';

type Command = 'backfill' | 'verify' | 'cutover' | 'rollback';

type Args = {
  command: Command;
  firestoreServiceAccountFile?: string;
};

type Credential = {
  client_email: string;
  private_key: string;
  project_id: string;
};

type D1Row = Record<string, unknown>;

export type SourceSnapshot = {
  summaries: PackStatusSourceSummary[];
  events: PackStatusEvent[];
};

export type PackStatusSourceSummary = PackStatusStatsFields & {
  rebuiltAtMs: number | null;
  updatedAtMs: number;
};

export type D1Snapshot = {
  summaries: PackStatusSourceSummary[];
  events: D1PackStatusEvent[];
};

export type D1PackStatusEvent = PackStatusEvent & {
  applyDelta: 0 | 1;
};

export type MigrationDependencies = {
  apply: (snapshot: SourceSnapshot) => void | Promise<void>;
  log: (message: string) => void;
  readSource: () => Promise<SourceSnapshot>;
  readTarget: () => D1Snapshot | Promise<D1Snapshot>;
  setReadSource: (source: 'firestore' | 'd1') => void | Promise<void>;
  smoke: (snapshot: SourceSnapshot, expectedSource: 'firestore' | 'd1') => Promise<void>;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = 'cloud/workers/api/wrangler.jsonc';
const databaseName = 'mons-shop-data';
const apiOrigin = 'https://api.mons.shop';
const projectId = 'mons-shop';
const D1_MAX_SQL_STATEMENT_BYTES = 100_000;
const EVENT_PAGE_SIZE = 250;
const wranglerBinary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');

function fail(message: string): never {
  throw new Error(message);
}

function usage(): string {
  return [
    'Usage:',
    '  npm run migrate:pack-status -- backfill [--firestore-service-account-file <path>]',
    '  npm run migrate:pack-status -- verify [--firestore-service-account-file <path>]',
    '  npm run migrate:pack-status -- cutover [--firestore-service-account-file <path>]',
    '  npm run migrate:pack-status -- rollback [--firestore-service-account-file <path>]',
  ].join('\n');
}

export function parseArgs(argv: string[]): Args {
  const command = argv[0];
  if (command !== 'backfill' && command !== 'verify' && command !== 'cutover' && command !== 'rollback') {
    fail(usage());
  }
  let firestoreServiceAccountFile: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--firestore-service-account-file') {
      const value = argv[index + 1];
      if (!value) fail(`Missing value for ${option}.\n${usage()}`);
      firestoreServiceAccountFile = value;
      index += 1;
      continue;
    }
    fail(`Unknown option: ${option}\n${usage()}`);
  }
  return { command, ...(firestoreServiceAccountFile ? { firestoreServiceAccountFile } : {}) };
}

function parseCredential(value: string): Credential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('Firestore reader credential is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('Firestore reader credential must contain one JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  const credential = {
    client_email: typeof record.client_email === 'string' ? record.client_email.trim() : '',
    private_key: typeof record.private_key === 'string' ? record.private_key : '',
    project_id: typeof record.project_id === 'string' ? record.project_id.trim() : '',
  };
  if (
    credential.client_email !== firestoreReaderServiceAccountEmail ||
    credential.project_id !== projectId ||
    !credential.private_key.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
    !credential.private_key.trimEnd().endsWith('-----END PRIVATE KEY-----')
  ) fail('Firestore reader credential does not match the reviewed service account.');
  return credential;
}

function readCredential(path: string | undefined): Credential {
  const value = path
    ? readFileSync(resolve(repoRoot, path), 'utf8')
    : readCloudflareFirestoreKeychainCredential(firestoreReaderServiceAccountEmail);
  return parseCredential(value);
}

function firestore(credential: Credential): Firestore {
  return new Firestore({
    projectId,
    credentials: {
      client_email: credential.client_email,
      private_key: credential.private_key,
    },
  });
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

function timestampMs(value: unknown, label: string, optional = false): number | null {
  if (optional && value == null) return null;
  if (!(value instanceof Timestamp)) fail(`${label} must be a Firestore timestamp.`);
  return value.toMillis();
}

function sourceSummary(dropId: string, data: Record<string, unknown>): PackStatusSourceSummary {
  const counters: PackStatusCounters = {
    dropId,
    totalInitialSupply: positiveInteger(data.totalInitialSupply, `${dropId}.totalInitialSupply`),
    totalCards: positiveInteger(data.totalCards, `${dropId}.totalCards`),
    cardsPerPack: positiveInteger(data.cardsPerPack, `${dropId}.cardsPerPack`),
    unsealedOnline: nonnegativeInteger(data.unsealedOnline, `${dropId}.unsealedOnline`),
    redeemedIrlNormal: nonnegativeInteger(data.redeemedIrlNormal, `${dropId}.redeemedIrlNormal`),
    redeemedIrlStripe: nonnegativeInteger(data.redeemedIrlStripe, `${dropId}.redeemedIrlStripe`),
    redeemedUnsealedCards: nonnegativeInteger(data.redeemedUnsealedCards, `${dropId}.redeemedUnsealedCards`),
  };
  if (data.dropId !== dropId || data.version !== 1) fail(`${dropId} pack-status identity is invalid.`);
  const fields = buildPackStatusStatsFields(counters);
  if (fields.totalCards !== fields.totalInitialSupply * fields.cardsPerPack) {
    fail(`${dropId} pack-status total is inconsistent.`);
  }
  return {
    ...fields,
    rebuiltAtMs: timestampMs(data.rebuiltAt, `${dropId}.rebuiltAt`, true),
    updatedAtMs: timestampMs(data.updatedAt, `${dropId}.updatedAt`)!,
  };
}

function eventType(value: unknown): PackStatusEventType {
  if (value === 'onlineReveal' || value === 'redeemedIrlNormal' || value === 'redeemedIrlStripe') return value;
  return fail('Pack-status event type is invalid.');
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !value) fail(`${label} must be a non-empty string.`);
  return value;
}

function typedPackStatusEvent(params: {
  dropId: string;
  type: PackStatusEventType;
  eventKey: string;
  quantity: number;
  increments: PackStatusEventIncrements;
  deliveryId?: number;
  checkoutSessionId?: string;
  boxAssetId?: string;
  signature?: string;
  createdAtMs: number;
}): PackStatusEvent {
  const common = {
    dropId: params.dropId,
    eventKey: params.eventKey,
    quantity: params.quantity,
    ...(params.deliveryId === undefined ? {} : { deliveryId: params.deliveryId }),
    ...(params.checkoutSessionId ? { checkoutSessionId: params.checkoutSessionId } : {}),
    ...(params.boxAssetId ? { boxAssetId: params.boxAssetId } : {}),
    ...(params.signature ? { signature: params.signature } : {}),
    createdAtMs: params.createdAtMs,
  };
  const unsealedOnline = params.increments.unsealedOnline || 0;
  const redeemedIrlNormal = params.increments.redeemedIrlNormal || 0;
  const redeemedIrlStripe = params.increments.redeemedIrlStripe || 0;
  const redeemedUnsealedCards = params.increments.redeemedUnsealedCards || 0;
  if (params.type === 'onlineReveal' && unsealedOnline > 0 && redeemedIrlNormal === 0 && redeemedIrlStripe === 0 && redeemedUnsealedCards === 0) {
    return { ...common, type: params.type, increments: { unsealedOnline } };
  }
  if (params.type === 'redeemedIrlNormal' && unsealedOnline === 0 && redeemedIrlStripe === 0 && redeemedIrlNormal + redeemedUnsealedCards > 0) {
    return {
      ...common,
      type: params.type,
      increments: {
        ...(redeemedIrlNormal ? { redeemedIrlNormal } : {}),
        ...(redeemedUnsealedCards ? { redeemedUnsealedCards } : {}),
      },
    };
  }
  if (params.type === 'redeemedIrlStripe' && unsealedOnline === 0 && redeemedIrlNormal === 0 && redeemedIrlStripe > 0 && redeemedUnsealedCards === 0) {
    return { ...common, type: params.type, increments: { redeemedIrlStripe } };
  }
  return fail('Pack-status event type and increments are inconsistent.');
}

function sourceEvent(dropId: string, id: string, data: Record<string, unknown>): PackStatusEvent {
  const type = eventType(data.type);
  const eventKey = optionalString(data.eventKey, `${id}.eventKey`);
  if (!eventKey || data.dropId !== dropId) fail(`${id} pack-status event identity is invalid.`);
  if (id !== `${type}_${encodeURIComponent(eventKey)}`) fail(`${id} pack-status event document ID is invalid.`);
  const rawIncrements = data.increments;
  if (rawIncrements == null && type === 'onlineReveal') {
    return {
      dropId,
      type,
      eventKey,
      quantity: positiveInteger(data.quantity, `${id}.quantity`),
      increments: { unsealedOnline: 1 },
      ...(optionalString(data.boxAssetId, `${id}.boxAssetId`) ? { boxAssetId: String(data.boxAssetId) } : {}),
      ...(optionalString(data.signature, `${id}.signature`) ? { signature: String(data.signature) } : {}),
      createdAtMs: timestampMs(data.createdAt, `${id}.createdAt`)!,
    };
  }
  if (!rawIncrements || typeof rawIncrements !== 'object' || Array.isArray(rawIncrements)) {
    fail(`${id}.increments must be an object.`);
  }
  const incrementsRecord = rawIncrements as Record<string, unknown>;
  const increments = {
    ...(incrementsRecord.unsealedOnline === undefined
      ? {}
      : { unsealedOnline: nonnegativeInteger(incrementsRecord.unsealedOnline, `${id}.increments.unsealedOnline`) }),
    ...(incrementsRecord.redeemedIrlNormal === undefined
      ? {}
      : { redeemedIrlNormal: nonnegativeInteger(incrementsRecord.redeemedIrlNormal, `${id}.increments.redeemedIrlNormal`) }),
    ...(incrementsRecord.redeemedIrlStripe === undefined
      ? {}
      : { redeemedIrlStripe: nonnegativeInteger(incrementsRecord.redeemedIrlStripe, `${id}.increments.redeemedIrlStripe`) }),
    ...(incrementsRecord.redeemedUnsealedCards === undefined
      ? {}
      : { redeemedUnsealedCards: nonnegativeInteger(incrementsRecord.redeemedUnsealedCards, `${id}.increments.redeemedUnsealedCards`) }),
  };
  if (Object.values(increments).reduce((sum, value) => sum + value, 0) <= 0) {
    fail(`${id} pack-status event increments are empty.`);
  }
  return typedPackStatusEvent({
    dropId,
    type,
    eventKey,
    quantity: positiveInteger(data.quantity, `${id}.quantity`),
    increments,
    ...(data.deliveryId == null ? {} : { deliveryId: positiveInteger(data.deliveryId, `${id}.deliveryId`) }),
    ...(optionalString(data.checkoutSessionId, `${id}.checkoutSessionId`) ? { checkoutSessionId: String(data.checkoutSessionId) } : {}),
    ...(optionalString(data.boxAssetId, `${id}.boxAssetId`) ? { boxAssetId: String(data.boxAssetId) } : {}),
    ...(optionalString(data.signature, `${id}.signature`) ? { signature: String(data.signature) } : {}),
    createdAtMs: timestampMs(data.createdAt, `${id}.createdAt`)!,
  });
}

async function readSourceSummaries(db: Firestore): Promise<PackStatusSourceSummary[]> {
  return Promise.all([...PACK_STATUS_SUPPORTED_DROP_IDS].sort().map(async (dropId) => {
    const summary = await db.doc(`drops/${dropId}/meta/packStatus`).get();
    if (!summary.exists || !summary.data()) fail(`Missing Firestore pack-status summary for ${dropId}.`);
    return sourceSummary(dropId, summary.data()!);
  }));
}

async function* readSourceEventPages(db: Firestore): AsyncGenerator<PackStatusEvent[]> {
  for (const dropId of [...PACK_STATUS_SUPPORTED_DROP_IDS].sort()) {
    let cursor: QueryDocumentSnapshot | undefined;
    while (true) {
      let query = db.collection(`drops/${dropId}/packStatusEvents`)
        .orderBy(FieldPath.documentId())
        .limit(EVENT_PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.get();
      if (snapshot.empty) break;
      yield snapshot.docs.map((document) => sourceEvent(dropId, document.id, document.data()));
      cursor = snapshot.docs.at(-1);
      if (snapshot.size < EVENT_PAGE_SIZE) break;
    }
  }
}

async function* readSourceEvents(db: Firestore): AsyncGenerator<PackStatusEvent> {
  for await (const page of readSourceEventPages(db)) {
    for (const event of page) yield event;
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNumber(value: number | null): string {
  if (value === null) return 'NULL';
  if (!Number.isSafeInteger(value)) fail('Refusing to serialize an unsafe SQL integer.');
  return String(value);
}

function eventDelta(event: PackStatusEvent, key: keyof PackStatusEventIncrements): number {
  return nonnegativeInteger((event.increments as PackStatusEventIncrements)[key] ?? 0, `${event.eventKey}.${key}`);
}

export function snapshotSql(
  snapshot: SourceSnapshot,
  options: { includeParent?: boolean; finalizeEventCount?: number | null } = {},
): string {
  if (snapshot.summaries.length === 0) fail('Pack-status backfill requires at least one summary.');
  const summaryRows = snapshot.summaries.map((summary, index) => `SELECT
    ${sqlString(summary.dropId)}${index === 0 ? ' AS drop_id' : ''},
    ${summary.version}${index === 0 ? ' AS version' : ''},
    ${summary.totalInitialSupply}${index === 0 ? ' AS total_initial_supply' : ''},
    ${summary.totalCards}${index === 0 ? ' AS total_cards' : ''},
    ${summary.cardsPerPack}${index === 0 ? ' AS cards_per_pack' : ''},
    ${summary.unsealedOnline}${index === 0 ? ' AS unsealed_online' : ''},
    ${summary.redeemedIrlNormal}${index === 0 ? ' AS redeemed_irl_normal' : ''},
    ${summary.redeemedIrlStripe}${index === 0 ? ' AS redeemed_irl_stripe' : ''},
    ${summary.redeemedUnsealedCards}${index === 0 ? ' AS redeemed_unsealed_cards' : ''},
    ${sqlNumber(summary.rebuiltAtMs)}${index === 0 ? ' AS rebuilt_at_ms' : ''},
    ${summary.updatedAtMs}${index === 0 ? ' AS updated_at_ms' : ''}`).join('\nUNION ALL\n');
  const summaryColumns = `drop_id, version, total_initial_supply, total_cards, cards_per_pack,
    unsealed_online, redeemed_irl_normal, redeemed_irl_stripe, redeemed_unsealed_cards,
    rebuilt_at_ms, updated_at_ms`;
  const summarySource = `SELECT source.* FROM (
    ${summaryRows}
  ) AS source`;
  const statements: string[] = [];
  if (options.includeParent !== false) {
    statements.push(`INSERT INTO pack_status (
      ${summaryColumns}
    )
    ${summarySource}
    WHERE 1
    ON CONFLICT(drop_id) DO NOTHING;`);
  }
  for (const event of snapshot.events) {
    statements.push(`INSERT OR IGNORE INTO pack_status_events (
      drop_id, event_type, event_key, quantity,
      unsealed_online_delta, redeemed_irl_normal_delta, redeemed_irl_stripe_delta, redeemed_unsealed_cards_delta,
      delivery_id, checkout_session_id, box_asset_id, signature, apply_delta, created_at_ms
    ) VALUES (
      ${sqlString(event.dropId)}, ${sqlString(event.type)}, ${sqlString(event.eventKey)}, ${event.quantity},
      ${eventDelta(event, 'unsealedOnline')}, ${eventDelta(event, 'redeemedIrlNormal')},
      ${eventDelta(event, 'redeemedIrlStripe')}, ${eventDelta(event, 'redeemedUnsealedCards')},
      ${sqlNumber(event.deliveryId ?? null)}, ${event.checkoutSessionId ? sqlString(event.checkoutSessionId) : 'NULL'},
      ${event.boxAssetId ? sqlString(event.boxAssetId) : 'NULL'}, ${event.signature ? sqlString(event.signature) : 'NULL'},
      0, ${event.createdAtMs}
    );`);
  }
  const finalizeEventCount = options.finalizeEventCount === undefined
    ? snapshot.events.length
    : options.finalizeEventCount;
  if (finalizeEventCount !== null) {
    nonnegativeInteger(finalizeEventCount, 'finalizeEventCount');
    statements.push(`INSERT INTO pack_status (
      ${summaryColumns}
    )
    ${summarySource}
    WHERE (SELECT COUNT(*) FROM pack_status_events) = ${finalizeEventCount}
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
      updated_at_ms = excluded.updated_at_ms;`);
  }
  if (statements.length === 0) fail('Pack-status backfill generated no D1 statements.');
  const encoder = new TextEncoder();
  if (statements.some((statement) => encoder.encode(statement).byteLength > D1_MAX_SQL_STATEMENT_BYTES)) {
    fail('Pack-status backfill generated an oversized D1 statement.');
  }
  return `${statements.join('\n')}\n`;
}

function runWrangler(args: string[], json = false): string {
  try {
    const output = execFileSync(wranglerBinary, [
      ...args,
      '--config', configPath,
      ...(json ? ['--json'] : []),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim();
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

function d1Rows(sql: string): D1Row[] {
  const parsed: unknown = JSON.parse(runWrangler([
    'd1', 'execute', databaseName, '--remote', '--command', sql,
  ], true));
  if (!Array.isArray(parsed) || parsed.length !== 1) fail('D1 returned an invalid query envelope.');
  const result = parsed[0] as { results?: unknown; success?: unknown };
  if (result.success !== true || !Array.isArray(result.results)) fail('D1 query failed.');
  return result.results as D1Row[];
}

function d1Summary(row: D1Row): PackStatusSourceSummary {
  return {
    version: positiveInteger(row.version, 'd1.version'),
    dropId: String(row.drop_id || ''),
    totalInitialSupply: positiveInteger(row.total_initial_supply, 'd1.total_initial_supply'),
    totalCards: positiveInteger(row.total_cards, 'd1.total_cards'),
    cardsPerPack: positiveInteger(row.cards_per_pack, 'd1.cards_per_pack'),
    unsealedOnline: nonnegativeInteger(row.unsealed_online, 'd1.unsealed_online'),
    redeemedIrlNormal: nonnegativeInteger(row.redeemed_irl_normal, 'd1.redeemed_irl_normal'),
    redeemedIrlStripe: nonnegativeInteger(row.redeemed_irl_stripe, 'd1.redeemed_irl_stripe'),
    redeemedUnsealedCards: nonnegativeInteger(row.redeemed_unsealed_cards, 'd1.redeemed_unsealed_cards'),
    rebuiltAtMs: row.rebuilt_at_ms == null ? null : nonnegativeInteger(row.rebuilt_at_ms, 'd1.rebuilt_at_ms'),
    updatedAtMs: nonnegativeInteger(row.updated_at_ms, 'd1.updated_at_ms'),
  };
}

function d1OptionalString(value: unknown, label: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !value) fail(`${label} must be null or a non-empty string.`);
  return value;
}

function d1Event(row: D1Row): D1PackStatusEvent {
  const eventKey = d1OptionalString(row.event_key, 'd1.event_key');
  const dropId = d1OptionalString(row.drop_id, 'd1.drop_id');
  if (!eventKey || !dropId) fail('D1 pack-status event identity is invalid.');
  const applyDelta = nonnegativeInteger(row.apply_delta, 'd1.apply_delta');
  if (applyDelta !== 0 && applyDelta !== 1) fail('d1.apply_delta must be zero or one.');
  const increments = {
    ...(nonnegativeInteger(row.unsealed_online_delta, 'd1.unsealed_online_delta')
      ? { unsealedOnline: Number(row.unsealed_online_delta) }
      : {}),
    ...(nonnegativeInteger(row.redeemed_irl_normal_delta, 'd1.redeemed_irl_normal_delta')
      ? { redeemedIrlNormal: Number(row.redeemed_irl_normal_delta) }
      : {}),
    ...(nonnegativeInteger(row.redeemed_irl_stripe_delta, 'd1.redeemed_irl_stripe_delta')
      ? { redeemedIrlStripe: Number(row.redeemed_irl_stripe_delta) }
      : {}),
    ...(nonnegativeInteger(row.redeemed_unsealed_cards_delta, 'd1.redeemed_unsealed_cards_delta')
      ? { redeemedUnsealedCards: Number(row.redeemed_unsealed_cards_delta) }
      : {}),
  };
  if (Object.keys(increments).length === 0) fail('D1 pack-status event increments are empty.');
  const event = typedPackStatusEvent({
    dropId,
    type: eventType(row.event_type),
    eventKey,
    quantity: positiveInteger(row.quantity, 'd1.quantity'),
    increments,
    ...(row.delivery_id == null ? {} : { deliveryId: positiveInteger(row.delivery_id, 'd1.delivery_id') }),
    ...(d1OptionalString(row.checkout_session_id, 'd1.checkout_session_id')
      ? { checkoutSessionId: String(row.checkout_session_id) }
      : {}),
    ...(d1OptionalString(row.box_asset_id, 'd1.box_asset_id') ? { boxAssetId: String(row.box_asset_id) } : {}),
    ...(d1OptionalString(row.signature, 'd1.signature') ? { signature: String(row.signature) } : {}),
    createdAtMs: nonnegativeInteger(row.created_at_ms, 'd1.created_at_ms'),
  });
  return { ...event, applyDelta };
}

function readD1Summaries(): PackStatusSourceSummary[] {
  return d1Rows(`SELECT
    drop_id, version, total_initial_supply, total_cards, cards_per_pack,
    unsealed_online, redeemed_irl_normal, redeemed_irl_stripe, redeemed_unsealed_cards,
    rebuilt_at_ms, updated_at_ms
    FROM pack_status ORDER BY drop_id`).map(d1Summary);
}

function readD1EventPage(cursor?: Pick<PackStatusEvent, 'dropId' | 'type' | 'eventKey'>): D1PackStatusEvent[] {
  const where = cursor ? `WHERE
    drop_id > ${sqlString(cursor.dropId)} OR
    (drop_id = ${sqlString(cursor.dropId)} AND event_type > ${sqlString(cursor.type)}) OR
    (drop_id = ${sqlString(cursor.dropId)} AND event_type = ${sqlString(cursor.type)} AND event_key > ${sqlString(cursor.eventKey)})` : '';
  return d1Rows(`SELECT
    drop_id, event_type, event_key, quantity,
    unsealed_online_delta, redeemed_irl_normal_delta, redeemed_irl_stripe_delta, redeemed_unsealed_cards_delta,
    delivery_id, checkout_session_id, box_asset_id, signature, apply_delta, created_at_ms
    FROM pack_status_events
    ${where}
    ORDER BY drop_id, event_type, event_key
    LIMIT ${EVENT_PAGE_SIZE}`).map(d1Event);
}

async function* readD1Events(): AsyncGenerator<D1PackStatusEvent> {
  let cursor: D1PackStatusEvent | undefined;
  while (true) {
    const page = readD1EventPage(cursor);
    for (const event of page) yield event;
    if (page.length < EVENT_PAGE_SIZE) break;
    cursor = page.at(-1);
  }
}

function canonicalSummary(value: PackStatusSourceSummary): string {
  const { updatedAtMs: _updatedAtMs, ...comparable } = value;
  return JSON.stringify(comparable);
}

function eventIdentity(value: Pick<PackStatusEvent, 'dropId' | 'type' | 'eventKey'>): string {
  return `${value.dropId}\0${value.type}\0${value.eventKey}`;
}

function canonicalEvent(value: PackStatusEvent): string {
  const increments = value.increments as PackStatusEventIncrements;
  return JSON.stringify({
    dropId: value.dropId,
    type: value.type,
    eventKey: value.eventKey,
    quantity: value.quantity,
    increments: {
      unsealedOnline: increments.unsealedOnline || 0,
      redeemedIrlNormal: increments.redeemedIrlNormal || 0,
      redeemedIrlStripe: increments.redeemedIrlStripe || 0,
      redeemedUnsealedCards: increments.redeemedUnsealedCards || 0,
    },
    deliveryId: value.deliveryId || null,
    checkoutSessionId: value.checkoutSessionId || null,
    boxAssetId: value.boxAssetId || null,
    signature: value.signature || null,
  });
}

function assertEventMatches(source: PackStatusEvent, target: D1PackStatusEvent): void {
  if (canonicalEvent(source) !== canonicalEvent(target)) {
    fail('D1 contains a pack-status event that differs from Firestore.');
  }
}

function compareEventIdentity(
  left: Pick<PackStatusEvent, 'dropId' | 'type' | 'eventKey'>,
  right: Pick<PackStatusEvent, 'dropId' | 'type' | 'eventKey'>,
): number {
  for (const key of ['dropId', 'type', 'eventKey'] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

async function verifyEventStreams(db: Firestore, exact: boolean): Promise<number> {
  const source = readSourceEvents(db)[Symbol.asyncIterator]();
  const target = readD1Events()[Symbol.asyncIterator]();
  let sourceResult = await source.next();
  let targetResult = await target.next();
  let matched = 0;
  while (!targetResult.done) {
    while (!sourceResult.done && compareEventIdentity(sourceResult.value, targetResult.value) < 0) {
      sourceResult = await source.next();
    }
    if (sourceResult.done || compareEventIdentity(sourceResult.value, targetResult.value) > 0) {
      fail('D1 contains a pack-status event that is missing from Firestore.');
    }
    assertEventMatches(sourceResult.value, targetResult.value);
    matched += 1;
    sourceResult = await source.next();
    targetResult = await target.next();
  }
  if (exact && !sourceResult.done) fail('D1 pack-status events do not exactly match Firestore.');
  return matched;
}

function verifySummaryArrays(source: PackStatusSourceSummary[], target: PackStatusSourceSummary[]): void {
  const sourceSummaries = [...source].sort((left, right) => left.dropId.localeCompare(right.dropId));
  const targetSummaries = [...target].sort((left, right) => left.dropId.localeCompare(right.dropId));
  if (
    sourceSummaries.length !== targetSummaries.length ||
    sourceSummaries.some((summary, index) => canonicalSummary(summary) !== canonicalSummary(targetSummaries[index]))
  ) fail('D1 pack-status summaries do not exactly match Firestore.');
}

export function assertTargetEventsCompatible(source: SourceSnapshot, target: D1Snapshot): void {
  const sourceEvents = new Map(source.events.map((event) => [eventIdentity(event), event]));
  if (sourceEvents.size !== source.events.length) fail('Firestore contains duplicate pack-status event identities.');
  for (const event of target.events) {
    const expected = sourceEvents.get(eventIdentity(event));
    if (!expected) fail('D1 contains a pack-status event that is missing from Firestore.');
    assertEventMatches(expected, event);
  }
}

export function verifySnapshots(source: SourceSnapshot, target: D1Snapshot): void {
  verifySummaryArrays(source.summaries, target.summaries);
  if (source.events.length !== target.events.length) fail('D1 pack-status events do not exactly match Firestore.');
  assertTargetEventsCompatible(source, target);
}

function applySql(sql: string): void {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-pack-status-d1-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'backfill.sql');
  try {
    writeFileSync(path, sql, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    runWrangler(['d1', 'execute', databaseName, '--remote', '--yes', '--file', path]);
  } finally {
    const resolved = resolve(directory);
    if (dirname(resolved) !== resolve(tmpdir())) fail('Refusing to remove an unexpected temporary directory.');
    rmSync(resolved, { recursive: true, force: true });
  }
}

function updateReadSource(source: 'firestore' | 'd1'): void {
  const nowMs = Date.now();
  const rows = d1Rows(`UPDATE pack_status_rollout
    SET read_source = ${sqlString(source)}, cache_generation = cache_generation + 1, updated_at_ms = ${nowMs}
    WHERE singleton = 1
    RETURNING read_source, cache_generation`);
  if (
    rows.length !== 1 ||
    rows[0].read_source !== source ||
    positiveInteger(rows[0].cache_generation, 'd1.cache_generation') < 1
  ) fail(`Failed to switch pack-status reads to ${source}.`);
}

async function smoke(source: SourceSnapshot, expectedSource: 'firestore' | 'd1'): Promise<void> {
  for (const summary of source.summaries) {
    const response = await fetch(`${apiOrigin}/pack-status/${encodeURIComponent(summary.dropId)}`, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) fail(`Pack-status smoke failed for ${summary.dropId} with ${response.status}.`);
    if (response.headers.get(PACK_STATUS_SOURCE_HEADER) !== expectedSource) {
      fail(`Pack-status smoke used an unexpected source for ${summary.dropId}.`);
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('Pack-status smoke returned invalid JSON.');
    const packStatus = (payload as Record<string, unknown>).packStatus;
    if (!packStatus || typeof packStatus !== 'object' || Array.isArray(packStatus)) {
      fail(`Pack-status smoke returned no data for ${summary.dropId}.`);
    }
    const record = packStatus as Record<string, unknown>;
    for (const key of [
      'dropId',
      'totalInitialSupply',
      'totalCards',
      'cardsPerPack',
      'unsealedOnline',
      'redeemedIrlNormal',
      'redeemedIrlStripe',
      'redeemedUnsealedCards',
    ] as const) {
      if (record[key] !== summary[key]) fail(`Pack-status smoke mismatch for ${summary.dropId}.${key}.`);
    }
  }
}

export async function runMigrationCommand(
  command: Command,
  dependencies: MigrationDependencies,
): Promise<void> {
  if (command === 'backfill') {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await dependencies.readSource();
      assertTargetEventsCompatible(current, await dependencies.readTarget());
      await dependencies.apply(current);
      try {
        const verified = await dependencies.readSource();
        verifySnapshots(verified, await dependencies.readTarget());
        dependencies.log(`[pack-status] Backfilled ${verified.summaries.length} summaries and ${verified.events.length} events.`);
        return;
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
    return;
  }
  const source = await dependencies.readSource();
  if (command === 'verify') {
    verifySnapshots(source, await dependencies.readTarget());
    dependencies.log(`[pack-status] Verified ${source.summaries.length} summaries and ${source.events.length} events.`);
    return;
  }
  if (command === 'rollback') {
    await dependencies.setReadSource('firestore');
    await dependencies.smoke(source, 'firestore');
    dependencies.log('[pack-status] Firestore reads restored and production smoke passed.');
    return;
  }
  verifySnapshots(source, await dependencies.readTarget());
  await dependencies.setReadSource('d1');
  try {
    await dependencies.smoke(source, 'd1');
  } catch (error) {
    await dependencies.setReadSource('firestore');
    throw new AggregateError([error], 'D1 cutover smoke failed; Firestore reads were restored.');
  }
  dependencies.log('[pack-status] D1 reads enabled and production smoke passed.');
}

async function applySourceEventPages(
  db: Firestore,
  summaries: PackStatusSourceSummary[],
): Promise<number> {
  applySql(snapshotSql({ summaries, events: [] }, { finalizeEventCount: null }));
  let eventCount = 0;
  for await (const events of readSourceEventPages(db)) {
    applySql(snapshotSql(
      { summaries, events },
      { includeParent: false, finalizeEventCount: null },
    ));
    eventCount += events.length;
  }
  applySql(snapshotSql(
    { summaries, events: [] },
    { includeParent: false, finalizeEventCount: eventCount },
  ));
  return eventCount;
}

async function runStreamingMigrationCommand(command: Command, db: Firestore): Promise<void> {
  if (command === 'backfill') {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const summaries = await readSourceSummaries(db);
      await verifyEventStreams(db, false);
      await applySourceEventPages(db, summaries);
      try {
        const verifiedSummaries = await readSourceSummaries(db);
        verifySummaryArrays(verifiedSummaries, readD1Summaries());
        const verifiedEvents = await verifyEventStreams(db, true);
        console.log(`[pack-status] Backfilled ${verifiedSummaries.length} summaries and ${verifiedEvents} events.`);
        return;
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
    return;
  }
  const summaries = await readSourceSummaries(db);
  const source = { summaries, events: [] };
  if (command === 'rollback') {
    updateReadSource('firestore');
    await smoke(source, 'firestore');
    console.log('[pack-status] Firestore reads restored and production smoke passed.');
    return;
  }
  verifySummaryArrays(summaries, readD1Summaries());
  const eventCount = await verifyEventStreams(db, true);
  if (command === 'verify') {
    console.log(`[pack-status] Verified ${summaries.length} summaries and ${eventCount} events.`);
    return;
  }
  updateReadSource('d1');
  try {
    await smoke(source, 'd1');
  } catch (error) {
    updateReadSource('firestore');
    throw new AggregateError([error], 'D1 cutover smoke failed; Firestore reads were restored.');
  }
  console.log('[pack-status] D1 reads enabled and production smoke passed.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourceDb = firestore(readCredential(args.firestoreServiceAccountFile));
  await runStreamingMigrationCommand(args.command, sourceDb);
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
