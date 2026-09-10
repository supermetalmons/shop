import { randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync, fchmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STRIPE_DISPUTE_EVENT_TYPES, isStripeDisputeId, type StripeChargebackMode, type StripeChargebackBackfillResult, type StripeChargebackWebhookConfigurationResult } from '../../shared/stripeChargebacks.ts';
import {
  StripeChargebackMaintenanceConnectionError,
  isRetryableStripeChargebackFailureCode,
  stripeChargebackMaintenanceFailureCode,
  withStripeChargebackMaintenance,
  type StripeChargebackMaintenanceTransport,
} from '../shared/stripeChargebackMaintenance.ts';

const ENDPOINT = 'https://api.mons.shop/admin/stripe-chargebacks/backfill';
const MODES = ['live', 'test'] as const;
const COUNT_KEYS = ['scanned', 'matchedOrders', 'inserted', 'existing', 'unrelated'] as const;
const MAX_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 30_000;


type Mode = StripeChargebackMode;
type Counts = Record<(typeof COUNT_KEYS)[number], number>;
type Batch = StripeChargebackBackfillResult;
type Failure = Batch['failures'][number];
type Checkpoint = {
  version: 1;
  mode: Mode;
  write: boolean;
  cursor: string | null;
  complete: boolean;
  totals: Counts;
  failedBatch?: Batch;
};

type CheckpointStore = {
  load: (mode: Mode, write: boolean) => Checkpoint | undefined;
  save: (checkpoint: Checkpoint) => void;
};

type Dependencies = {
  fetch: typeof fetch;
  maintenance?: StripeChargebackMaintenanceTransport;
  sleep: (delayMs: number) => Promise<void>;
  nowMs: () => number;
  log: (message: string) => void;
  store: CheckpointStore;
};

type Args = { modes: Mode[]; write: boolean; restart: boolean; cloudflare: boolean; configureWebhooks: boolean };

class BackfillError extends Error {}

function fail(message: string): never {
  throw new BackfillError(message);
}

function usage(): string {
  return [
    'Backfill informational Stripe chargeback labels using deployed Stripe credentials.',
    'Use --cloudflare with existing Wrangler authentication, or MONS_STAFF_SESSION_TOKEN.',
    '',
    '  npm run backfill:stripe-chargebacks -- --cloudflare',
    '  npm run backfill:stripe-chargebacks -- --cloudflare --write',
    '  npm run backfill:stripe-chargebacks -- --cloudflare --configure-webhooks --write',
    '  npm run backfill:stripe-chargebacks -- --mode live --restart',
    '',
    'Defaults: both live and test modes, dry run, resume interrupted progress.',
    '--mode live|test|both   Select Stripe modes.',
    '--write                 Apply missing labels or webhook subscriptions.',
    '--cloudflare            Use private RPC with existing Wrangler authentication.',
    '--configure-webhooks    Inspect or add dispute events; requires --cloudflare.',
    '--restart               Start a fresh full scan, ignoring saved progress.',
    'Completed scans automatically start fresh on the next invocation.',
  ].join('\n');
}

export function parseStripeChargebackBackfillArgs(argv: string[]): Args {
  let modes: Mode[] = [...MODES];
  let write = false;
  let restart = false;
  let cloudflare = false;
  let configureWebhooks = false;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i];
    if (!['--mode', '--write', '--restart', '--cloudflare', '--configure-webhooks'].includes(option)) {
      return fail('Unknown option. Use --help for usage.');
    }
    if (seen.has(option)) return fail('Options may only be provided once.');
    seen.add(option);
    if (option === '--write') write = true;
    if (option === '--restart') restart = true;
    if (option === '--cloudflare') cloudflare = true;
    if (option === '--configure-webhooks') configureWebhooks = true;
    if (option === '--mode') {
      const mode = argv[++i];
      if (mode !== 'live' && mode !== 'test' && mode !== 'both') {
        return fail('--mode must be live, test, or both.');
      }
      modes = mode === 'both' ? [...MODES] : [mode];
    }
  }
  if (configureWebhooks && !cloudflare) return fail('--configure-webhooks requires --cloudflare.');
  if (configureWebhooks && restart) return fail('--restart only applies to dispute backfills.');
  return { modes, write, restart, cloudflare, configureWebhooks };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('Invalid backfill response or checkpoint.');
  }
  return value as Record<string, unknown>;
}

function counts(value: unknown): Counts {
  const source = record(value);
  const result = {} as Counts;
  for (const key of COUNT_KEYS) {
    if (!Number.isSafeInteger(source[key]) || (source[key] as number) < 0) {
      return fail('Invalid backfill counts.');
    }
    result[key] = source[key] as number;
  }
  return result;
}

function cursor(value: unknown): string | null {
  if (value === null) return null;
  if (!isStripeDisputeId(value)) {
    return fail('Invalid backfill cursor.');
  }
  return value;
}

function parseBatch(value: unknown, mode: Mode, write: boolean): Batch {
  const source = record(value);
  if (source.mode !== mode || source.write !== write || !Array.isArray(source.failures)) {
    return fail('Backfill response does not match the requested mode and write setting.');
  }
  const totals = counts(source);
  if (totals.scanned > 10 || source.failures.length > 10) {
    return fail('Invalid backfill batch size.');
  }
  const failures = source.failures.map((value): Failure => {
    const failure = record(value);
    if (
      (!isStripeDisputeId(failure.disputeId) && failure.disputeId !== 'unknown') ||
      typeof failure.code !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(failure.code)
    ) return fail('Invalid backfill failure details.');
    return { disputeId: failure.disputeId, code: failure.code };
  });
  const nextCursor = cursor(source.nextCursor);
  if (nextCursor && totals.scanned === 0) return fail('Backfill pagination did not advance.');
  return { ...totals, mode, write, nextCursor, failures };
}

function parseCheckpoint(value: unknown, mode: Mode, write: boolean): Checkpoint {
  const source = record(value);
  if (
    source.version !== 1 || source.mode !== mode || source.write !== write ||
    typeof source.complete !== 'boolean'
  ) return fail('Backfill checkpoint does not match this run.');
  const nextCursor = cursor(source.cursor);
  if (source.complete && nextCursor !== null) return fail('Invalid completed backfill checkpoint.');
  const failedBatch = source.failedBatch === undefined ? undefined : parseBatch(source.failedBatch, mode, write);
  if (failedBatch && (source.complete || failedBatch.failures.length === 0)) {
    return fail('Invalid failed backfill checkpoint.');
  }
  return {
    version: 1, mode, write, cursor: nextCursor, complete: source.complete,
    totals: counts(source.totals), ...(failedBatch ? { failedBatch } : {}),
  };
}

export function createStripeChargebackCheckpointStore(directory: string): CheckpointStore {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink()) return fail('Unsafe backfill checkpoint directory.');
  const dirFd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fchmodSync(dirFd, 0o700);
  } finally {
    closeSync(dirFd);
  }
  const pathFor = (mode: Mode, write: boolean) => join(directory, `${mode}-${write ? 'write' : 'dry-run'}.json`);
  return {
    load(mode, write) {
      let fd: number;
      try {
        fd = openSync(pathFor(mode, write), constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        return fail('Unable to read backfill checkpoint safely.');
      }
      try {
        return parseCheckpoint(JSON.parse(readFileSync(fd, 'utf8')), mode, write);
      } catch {
        return fail('Invalid backfill checkpoint. Inspect it before using --restart.');
      } finally {
        closeSync(fd);
      }
    },
    save(checkpoint) {
      const path = pathFor(checkpoint.mode, checkpoint.write);
      const temp = `${path}.${randomUUID()}.tmp`;
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(temp, path);
      } finally {
        try { unlinkSync(temp); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    },
  };
}

function retryDelay(response: Response | undefined, attempt: number, nowMs: number): number {
  const header = response?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - nowMs;
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      return Math.min(MAX_RETRY_DELAY_MS, milliseconds);
    }
  }
  return Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** attempt);
}

async function requestBatch(
  mode: Mode, write: boolean, nextCursor: string | null, token: string | undefined, dependencies: Dependencies,
): Promise<Batch> {
  const request = { mode, write, ...(nextCursor ? { cursor: nextCursor } : {}) };
  const body = JSON.stringify(request);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response: Response | undefined;
    try {
      response = dependencies.maintenance
        ? await dependencies.maintenance.backfill(request)
        : await dependencies.fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      if (attempt + 1 === MAX_ATTEMPTS) return fail('Backfill request failed after five attempts; progress was preserved.');
    }
    if (response?.ok) {
      let payload: unknown;
      try { payload = await response.json(); } catch { return fail('Backfill API returned invalid JSON.'); }
      const source = record(payload);
      if (source.ok !== true) return fail('Backfill API did not confirm success.');
      const batch = parseBatch(source, mode, write);
      if (
        batch.failures.length === 0 ||
        batch.failures.some((failure) => !isRetryableStripeChargebackFailureCode(failure.code)) ||
        attempt + 1 === MAX_ATTEMPTS
      ) return batch;
      dependencies.log(`${mode} ${write ? 'write' : 'dry-run'}: transient dispute failure; retry ${attempt + 2}/${MAX_ATTEMPTS}.`);
      await dependencies.sleep(retryDelay(response, attempt, dependencies.nowMs()));
      continue;
    }
    if (response) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) {
        return fail('Backfill authorization failed. Supply an active fulfillment-admin MONS_STAFF_SESSION_TOKEN.');
      }
      if (![408, 429].includes(response.status) && response.status < 500) {
        return fail(`Backfill request failed with ${failureStatus(response)}; progress was preserved.`);
      }
      if (attempt + 1 === MAX_ATTEMPTS) {
        return fail(`Backfill request failed with ${failureStatus(response)} after five attempts; progress was preserved.`);
      }
    }
    dependencies.log(`${mode} ${write ? 'write' : 'dry-run'}: transient request failure; retry ${attempt + 2}/${MAX_ATTEMPTS}.`);
    await dependencies.sleep(retryDelay(response, attempt, dependencies.nowMs()));
  }
  return fail('Backfill request did not complete.');
}

function failureStatus(response: Response): string {
  const code = stripeChargebackMaintenanceFailureCode(response);
  return `HTTP ${response.status}${code ? ` (${code})` : ''}`;
}

function formatCounts(value: Counts): string {
  return COUNT_KEYS.map((key) => `${key}=${value[key]}`).join(' ');
}

export async function runStripeChargebackBackfill(
  args: Args, token: string | undefined, dependencies: Dependencies,
): Promise<Checkpoint[]> {
  if (args.cloudflare && !dependencies.maintenance) return fail('Cloudflare maintenance transport is not connected.');
  if (!args.cloudflare && dependencies.maintenance) return fail('Cloudflare maintenance requires --cloudflare.');
  if (args.configureWebhooks) return fail('Webhook configuration does not run the dispute backfill.');
  if (!args.cloudflare && (!token || token !== token.trim() || /\s/.test(token))) {
    return fail('Set MONS_STAFF_SESSION_TOKEN to an active fulfillment-admin session token.');
  }
  const results: Checkpoint[] = [];
  for (const mode of args.modes) {
    const saved = args.restart ? undefined : dependencies.store.load(mode, args.write);
    let checkpoint: Checkpoint = saved && !saved.complete ? saved : {
      version: 1, mode, write: args.write, cursor: null, complete: false,
      totals: { scanned: 0, matchedOrders: 0, inserted: 0, existing: 0, unrelated: 0 },
    };
    const seenCursors = new Set<string>();
    if (checkpoint.cursor) seenCursors.add(checkpoint.cursor);
    dependencies.store.save(checkpoint);
    dependencies.log(`${mode} ${args.write ? 'write' : 'dry-run'}: ${saved && !saved.complete ? 'resuming' : 'starting'} full dispute history.`);
    while (!checkpoint.complete) {
      const batch = await requestBatch(mode, args.write, checkpoint.cursor, token, dependencies);
      if (batch.failures.length) {
        dependencies.store.save({ ...checkpoint, failedBatch: batch });
        for (const failure of batch.failures) {
          dependencies.log(`${mode}: dispute=${failure.disputeId} failure=${failure.code}`);
        }
        return fail(`${mode} backfill incomplete: ${batch.failures.length} dispute failures. Saved the current batch for retry.`);
      }
      if (batch.nextCursor && seenCursors.has(batch.nextCursor)) {
        return fail('Backfill pagination repeated a cursor; progress was preserved.');
      }
      const totals = { ...checkpoint.totals };
      for (const key of COUNT_KEYS) totals[key] += batch[key];
      checkpoint = { version: 1, mode, write: args.write, cursor: batch.nextCursor, complete: batch.nextCursor === null, totals };
      dependencies.store.save(checkpoint);
      if (batch.nextCursor) seenCursors.add(batch.nextCursor);
      dependencies.log(`${mode} ${args.write ? 'write' : 'dry-run'}: ${formatCounts(checkpoint.totals)}`);
    }
    results.push(checkpoint);
    dependencies.log(`${mode} ${args.write ? 'write' : 'dry-run'}: full history complete.`);
  }
  return results;
}

function parseWebhookConfiguration(value: unknown, mode: Mode, write: boolean): StripeChargebackWebhookConfigurationResult {
  const source = record(value);
  if (source.ok !== true || source.mode !== mode || source.write !== write || typeof source.complete !== 'boolean' || !Array.isArray(source.endpoints)) {
    return fail('Invalid webhook configuration response.');
  }
  const endpoints = source.endpoints.map((value) => {
    const endpoint = record(value);
    const eventNames = (value: unknown): string[] => {
      if (!Array.isArray(value) || !value.every((event) => typeof event === 'string' && (event === '*' || /^[a-z][a-z0-9_.]{0,150}$/.test(event)))) {
        return fail('Invalid webhook event list.');
      }
      return value;
    };
    if (
      typeof endpoint.id !== 'string' || endpoint.id.length > 256 || !/^we_[A-Za-z0-9_]+$/.test(endpoint.id) ||
      endpoint.url !== 'https://api.mons.shop/webhooks/stripe' ||
      typeof endpoint.updated !== 'boolean'
    ) return fail('Invalid webhook endpoint response.');
    const enabledEvents = eventNames(endpoint.enabledEvents);
    const missingEvents = eventNames(endpoint.missingEvents);
    const expectedMissing = enabledEvents.includes('*') ? [] : STRIPE_DISPUTE_EVENT_TYPES.filter((event) => !enabledEvents.includes(event));
    if ((!write && endpoint.updated) || missingEvents.length !== expectedMissing.length || missingEvents.some((event) => !expectedMissing.includes(event as typeof expectedMissing[number]))) {
      return fail('Inconsistent webhook configuration response.');
    }
    return { id: endpoint.id, url: endpoint.url, updated: endpoint.updated, enabledEvents, missingEvents };
  });
  if (endpoints.length === 0) return fail('No matching Stripe webhook endpoint was found.');
  if (source.complete !== endpoints.every((endpoint) => endpoint.missingEvents.length === 0)) return fail('Inconsistent webhook completion status.');
  return { mode, write, endpoints, complete: source.complete };
}

export async function runStripeChargebackWebhookConfiguration(
  args: Args, dependencies: Pick<Dependencies, 'maintenance' | 'sleep' | 'log' | 'nowMs'>,
): Promise<StripeChargebackWebhookConfigurationResult[]> {
  if (!args.cloudflare || !args.configureWebhooks || !dependencies.maintenance) {
    return fail('Webhook configuration requires a connected Cloudflare maintenance transport.');
  }
  const results: StripeChargebackWebhookConfigurationResult[] = [];
  for (const mode of args.modes) {
    let result: StripeChargebackWebhookConfigurationResult | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await dependencies.maintenance.configureWebhooks({ mode, write: args.write });
      } catch {
        if (attempt + 1 === MAX_ATTEMPTS) return fail('Webhook configuration connection failed after five attempts.');
      }
      if (response?.ok) {
        let payload: unknown;
        try { payload = await response.json(); } catch { return fail('Invalid webhook configuration JSON.'); }
        result = parseWebhookConfiguration(payload, mode, args.write);
        break;
      }
      if (response) {
        await response.body?.cancel().catch(() => undefined);
        if (![408, 429].includes(response.status) && response.status < 500) {
          return fail(`Webhook configuration failed with ${failureStatus(response)}.`);
        }
        if (attempt + 1 === MAX_ATTEMPTS) return fail(`Webhook configuration failed with ${failureStatus(response)} after five attempts.`);
      }
      dependencies.log(`${mode}: transient webhook configuration failure; retry ${attempt + 2}/${MAX_ATTEMPTS}.`);
      await dependencies.sleep(retryDelay(response, attempt, dependencies.nowMs()));
    }
    if (!result) return fail('Webhook configuration did not complete.');
    for (const endpoint of result.endpoints) {
      dependencies.log(`${mode}: endpoint=${endpoint.id} missingEvents=${endpoint.missingEvents.length} updated=${endpoint.updated}`);
    }
    if (args.write && !result.complete) return fail(`${mode}: webhook configuration is incomplete.`);
    results.push(result);
  }
  return results;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log(usage());
    return;
  }
  const args = parseStripeChargebackBackfillArgs(argv);
  const dependencies: Dependencies = {
    fetch,
    sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    nowMs: Date.now,
    log: console.log,
    store: createStripeChargebackCheckpointStore(resolve(dirname(fileURLToPath(import.meta.url)), '../../.cache/stripe-chargebacks')),
  };
  const run = async (maintenance?: StripeChargebackMaintenanceTransport) => {
    if (args.configureWebhooks) {
      return runStripeChargebackWebhookConfiguration(args, { ...dependencies, maintenance });
    }
    return runStripeChargebackBackfill(args, process.env.MONS_STAFF_SESSION_TOKEN, { ...dependencies, maintenance });
  };
  if (args.cloudflare) await withStripeChargebackMaintenance(run);
  else await run();
  if (args.configureWebhooks) {
    console.log(`${args.write ? 'Webhook subscriptions verified' : 'Webhook inspection complete'} for ${args.modes.join(' and ')} mode.`);
  } else {
    console.log(`${args.write ? 'Write' : 'Dry run'} complete for ${args.modes.join(' and ')} mode. ${args.write ? 'Matched orders have informational chargeback labels.' : 'No chargeback labels were written.'}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof BackfillError || error instanceof StripeChargebackMaintenanceConnectionError
      ? error.message
      : 'Backfill did not complete. Progress is retained; check local checkpoint access and retry.');
    process.exitCode = 1;
  });
}
