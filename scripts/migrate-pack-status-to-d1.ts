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
import { FieldPath, Firestore, Timestamp } from '@google-cloud/firestore';
import {
  PACK_STATUS_SUPPORTED_DROP_IDS,
  buildPackStatusStatsFields,
  type PackStatusCounters,
  type PackStatusEvent,
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
  events: Array<{ dropId: string; type: PackStatusEventType; eventKey: string }>;
};

export type MigrationDependencies = {
  apply: (snapshot: SourceSnapshot) => void | Promise<void>;
  log: (message: string) => void;
  readSource: () => Promise<SourceSnapshot>;
  readTarget: () => D1Snapshot | Promise<D1Snapshot>;
  setReadSource: (source: 'firestore' | 'd1') => void | Promise<void>;
  smoke: (snapshot: SourceSnapshot) => Promise<void>;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = 'cloud/workers/api/wrangler.jsonc';
const databaseName = 'mons-shop-data';
const apiOrigin = 'https://api.mons.shop';
const projectId = 'mons-shop';
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

function sourceEvent(dropId: string, id: string, data: Record<string, unknown>): PackStatusEvent {
  const type = eventType(data.type);
  const eventKey = optionalString(data.eventKey, `${id}.eventKey`);
  if (!eventKey || data.dropId !== dropId) fail(`${id} pack-status event identity is invalid.`);
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
  return {
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
  };
}

export async function readSourceSnapshot(db: Firestore): Promise<SourceSnapshot> {
  const summaries: PackStatusSourceSummary[] = [];
  const events: PackStatusEvent[] = [];
  for (const dropId of PACK_STATUS_SUPPORTED_DROP_IDS) {
    const [summary, eventSnapshot] = await Promise.all([
      db.doc(`drops/${dropId}/meta/packStatus`).get(),
      db.collection(`drops/${dropId}/packStatusEvents`).orderBy(FieldPath.documentId()).get(),
    ]);
    if (!summary.exists || !summary.data()) fail(`Missing Firestore pack-status summary for ${dropId}.`);
    summaries.push(sourceSummary(dropId, summary.data()!));
    for (const document of eventSnapshot.docs) {
      events.push(sourceEvent(dropId, document.id, document.data()));
    }
  }
  return { summaries, events };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNumber(value: number | null): string {
  if (value === null) return 'NULL';
  if (!Number.isSafeInteger(value)) fail('Refusing to serialize an unsafe SQL integer.');
  return String(value);
}

function eventDelta(event: PackStatusEvent, key: keyof PackStatusEvent['increments']): number {
  return nonnegativeInteger(event.increments[key] ?? 0, `${event.eventKey}.${key}`);
}

export function snapshotSql(snapshot: SourceSnapshot): string {
  const statements = snapshot.summaries.map((summary) => `INSERT INTO pack_status (
    drop_id, version, total_initial_supply, total_cards, cards_per_pack,
    unsealed_online, redeemed_irl_normal, redeemed_irl_stripe, redeemed_unsealed_cards,
    rebuilt_at_ms, updated_at_ms
  ) VALUES (
    ${sqlString(summary.dropId)}, ${summary.version}, ${summary.totalInitialSupply}, ${summary.totalCards}, ${summary.cardsPerPack},
    ${summary.unsealedOnline}, ${summary.redeemedIrlNormal}, ${summary.redeemedIrlStripe}, ${summary.redeemedUnsealedCards},
    ${sqlNumber(summary.rebuiltAtMs)}, ${summary.updatedAtMs}
  ) ON CONFLICT(drop_id) DO UPDATE SET
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

export function readD1Snapshot(): D1Snapshot {
  const summaries = d1Rows(`SELECT
    drop_id, version, total_initial_supply, total_cards, cards_per_pack,
    unsealed_online, redeemed_irl_normal, redeemed_irl_stripe, redeemed_unsealed_cards,
    rebuilt_at_ms, updated_at_ms
    FROM pack_status ORDER BY drop_id`).map(d1Summary);
  const events = d1Rows(
    'SELECT drop_id, event_type, event_key FROM pack_status_events ORDER BY drop_id, event_type, event_key',
  ).map((row) => ({
    dropId: String(row.drop_id || ''),
    type: eventType(row.event_type),
    eventKey: String(row.event_key || ''),
  }));
  return { summaries, events };
}

function canonicalSummary(value: PackStatusSourceSummary): string {
  return JSON.stringify(value);
}

function canonicalEvent(value: { dropId: string; type: PackStatusEventType; eventKey: string }): string {
  return `${value.dropId}\0${value.type}\0${value.eventKey}`;
}

export function verifySnapshots(source: SourceSnapshot, target: D1Snapshot): void {
  const sourceSummaries = [...source.summaries].sort((left, right) => left.dropId.localeCompare(right.dropId));
  const targetSummaries = [...target.summaries].sort((left, right) => left.dropId.localeCompare(right.dropId));
  if (
    sourceSummaries.length !== targetSummaries.length ||
    sourceSummaries.some((summary, index) => canonicalSummary(summary) !== canonicalSummary(targetSummaries[index]))
  ) fail('D1 pack-status summaries do not exactly match Firestore.');
  const sourceEvents = source.events.map(canonicalEvent).sort();
  const targetEvents = target.events.map(canonicalEvent).sort();
  if (
    sourceEvents.length !== targetEvents.length ||
    sourceEvents.some((event, index) => event !== targetEvents[index])
  ) fail('D1 pack-status event identities do not exactly match Firestore.');
}

function applySnapshot(snapshot: SourceSnapshot): void {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-pack-status-d1-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'backfill.sql');
  try {
    writeFileSync(path, snapshotSql(snapshot), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    runWrangler(['d1', 'execute', databaseName, '--remote', '--yes', '--file', path]);
  } finally {
    const resolved = resolve(directory);
    if (dirname(resolved) !== resolve(tmpdir())) fail('Refusing to remove an unexpected temporary directory.');
    rmSync(resolved, { recursive: true, force: true });
  }
}

function updateReadSource(source: 'firestore' | 'd1'): void {
  const nowMs = Date.now();
  d1Rows(`UPDATE pack_status_rollout
    SET read_source = ${sqlString(source)}, cache_generation = cache_generation + 1, updated_at_ms = ${nowMs}
    WHERE singleton = 1
    RETURNING read_source, cache_generation`);
}

async function smoke(source: SourceSnapshot): Promise<void> {
  for (const summary of source.summaries) {
    const response = await fetch(`${apiOrigin}/pack-status/${encodeURIComponent(summary.dropId)}`, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) fail(`Pack-status smoke failed for ${summary.dropId} with ${response.status}.`);
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
    await dependencies.smoke(source);
    dependencies.log('[pack-status] Firestore reads restored and production smoke passed.');
    return;
  }
  verifySnapshots(source, await dependencies.readTarget());
  await dependencies.setReadSource('d1');
  try {
    await dependencies.smoke(source);
  } catch (error) {
    await dependencies.setReadSource('firestore');
    throw new AggregateError([error], 'D1 cutover smoke failed; Firestore reads were restored.');
  }
  dependencies.log('[pack-status] D1 reads enabled and production smoke passed.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourceDb = firestore(readCredential(args.firestoreServiceAccountFile));
  await runMigrationCommand(args.command, {
    apply: applySnapshot,
    log: (message) => console.log(message),
    readSource: () => readSourceSnapshot(sourceDb),
    readTarget: readD1Snapshot,
    setReadSource: updateReadSource,
    smoke,
  });
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
