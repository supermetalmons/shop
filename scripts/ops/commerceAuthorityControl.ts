import { pathToFileURL } from 'node:url';
import {
  queryRemoteCommerceD1,
  safeInteger,
} from '../shared/commerceD1Maintenance.ts';
import {
  createCloudflareQueueMaintenanceClient,
  readCloudflareQueueMaintenanceConfig,
  type CloudflareQueueDeliveryState,
  type CloudflareQueueMaintenanceClient,
  type CloudflareQueueMaintenanceConfig,
} from '../shared/cloudflareQueueMaintenance.ts';

type Command = 'status' | 'paused' | 'd1';

type Args = {
  command: Command;
  expectedRevision?: number;
  write: boolean;
};

type CommerceAuthority = {
  authority_state: 'paused' | 'd1';
  revision: number;
  documents_revision: number;
  paused_at_ms: number | null;
  updated_at_ms: number;
};

type QueueDeliveryResult = {
  name: string;
  deliveryPaused: boolean;
};

export type CommerceAuthorityControlResult = {
  authority: CommerceAuthority;
  queues: QueueDeliveryResult[];
  changed: {
    authorityChanged: boolean;
    queuesChanged: boolean;
  };
};

type CommerceAuthorityQuery = (
  sql: string,
) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>;

type CommerceAuthorityControlDependencies = {
  apiToken: string;
  nowMs: () => number;
  providerFetch: typeof fetch;
  queryCommerceD1: CommerceAuthorityQuery;
  queueClient?: CloudflareQueueMaintenanceClient;
  queueConfig: CloudflareQueueMaintenanceConfig;
};

class AuthorityTransitionError extends Error {
  constructor(message: string, readonly confirmedUnchanged: boolean) {
    super(message);
    this.name = 'AuthorityTransitionError';
  }
}

class QueuePausePreparationError extends Error {
  constructor(
    readonly queues: CloudflareQueueDeliveryState[],
    readonly rollbackFailures: string[],
    readonly rollbackVerified: boolean,
  ) {
    super('Cloudflare Queue pause failed.');
    this.name = 'QueuePausePreparationError';
  }
}

export class CommerceAuthorityCoordinationError extends Error {
  constructor(
    message: string,
    readonly result: CommerceAuthorityControlResult,
  ) {
    super(message);
    this.name = 'CommerceAuthorityCoordinationError';
  }
}

function fail(message: string): never {
  throw new Error(message);
}

export function parseCommerceAuthorityControlArgs(argv: string[]): Args {
  const command = argv[0];
  if (command !== 'status' && command !== 'paused' && command !== 'd1') {
    fail('Usage: npm run commerce-authority-control -- <status|paused|d1> [--expected-revision <n>] [--write]');
  }
  let expectedRevision: number | undefined;
  let write = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') {
      write = true;
      continue;
    }
    if (arg === '--expected-revision') {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1) fail('Expected revision must be a positive integer.');
      expectedRevision = value;
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }
  if (command === 'status' && (write || expectedRevision !== undefined)) fail('Status does not accept mutation options.');
  if (command !== 'status' && (!write || expectedRevision === undefined)) {
    fail(`${command} requires --write and --expected-revision.`);
  }
  return { command, expectedRevision, write };
}

const statusSql = `SELECT
  authority_state,
  revision,
  documents_revision,
  paused_at_ms,
  updated_at_ms
FROM commerce_authority_control
WHERE singleton = 1`;

export function buildCommerceAuthorityMutationSql(
  command: Exclude<Command, 'status'>,
  expectedRevision: number,
  nowMs: number,
): string {
  if (command === 'paused') {
    return `UPDATE commerce_authority_control
      SET authority_state = 'paused', revision = revision + 1,
        paused_at_ms = ${nowMs}, updated_at_ms = ${nowMs}
      WHERE singleton = 1 AND authority_state = 'd1' AND revision = ${expectedRevision}
      RETURNING *`;
  }
  return `UPDATE commerce_authority_control
    SET authority_state = 'd1', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = ${nowMs}
    WHERE singleton = 1 AND authority_state = 'paused' AND revision = ${expectedRevision}
      RETURNING *`;
}

function parseAuthorityRow(value: unknown): CommerceAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('Commerce authority control is invalid.');
  }
  const row = value as Record<string, unknown>;
  const authorityState = row.authority_state;
  if (authorityState !== 'paused' && authorityState !== 'd1') {
    return fail('Commerce authority control has an invalid state.');
  }
  return {
    authority_state: authorityState,
    revision: safeInteger(row.revision, 'Commerce authority revision'),
    documents_revision: safeInteger(row.documents_revision, 'Commerce documents revision'),
    paused_at_ms: row.paused_at_ms === null
      ? null
      : safeInteger(row.paused_at_ms, 'Commerce authority pause timestamp'),
    updated_at_ms: safeInteger(row.updated_at_ms, 'Commerce authority update timestamp'),
  };
}

async function readAuthority(queryCommerceD1: CommerceAuthorityQuery): Promise<CommerceAuthority> {
  const rows = await queryCommerceD1(statusSql);
  if (rows.length !== 1) fail('Commerce authority control is missing or duplicated.');
  return parseAuthorityRow(rows[0]);
}

function sameAuthority(left: CommerceAuthority, right: CommerceAuthority): boolean {
  return left.authority_state === right.authority_state && left.revision === right.revision;
}

function transitionMode(
  authority: CommerceAuthority,
  command: Exclude<Command, 'status'>,
  expectedRevision: number,
): 'transition' | 'repair' {
  const sourceState = command === 'paused' ? 'd1' : 'paused';
  if (authority.authority_state === sourceState && authority.revision === expectedRevision) {
    return 'transition';
  }
  if (
    authority.authority_state === command &&
    (authority.revision === expectedRevision || authority.revision === expectedRevision + 1)
  ) return 'repair';
  return fail('Commerce authority transition was rejected or changed concurrently.');
}

async function transitionAuthority(args: {
  authority: CommerceAuthority;
  command: Exclude<Command, 'status'>;
  expectedRevision: number;
  nowMs: number;
  queryCommerceD1: CommerceAuthorityQuery;
}): Promise<{ authority: CommerceAuthority; changed: boolean }> {
  try {
    const rows = await args.queryCommerceD1(buildCommerceAuthorityMutationSql(
      args.command,
      args.expectedRevision,
      args.nowMs,
    ));
    if (rows.length !== 1) throw new Error('transition rejected');
    const authority = parseAuthorityRow(rows[0]);
    if (
      authority.authority_state !== args.command ||
      authority.revision !== args.expectedRevision + 1
    ) throw new Error('transition response invalid');
    return { authority, changed: true };
  } catch {
    let observed: CommerceAuthority;
    try {
      observed = await readAuthority(args.queryCommerceD1);
    } catch {
      throw new AuthorityTransitionError(
        'Commerce authority transition outcome could not be confirmed.',
        false,
      );
    }
    if (
      observed.authority_state === args.command &&
      (observed.revision === args.expectedRevision || observed.revision === args.expectedRevision + 1)
    ) return { authority: observed, changed: false };
    const sourceState = args.command === 'paused' ? 'd1' : 'paused';
    throw new AuthorityTransitionError(
      'Commerce authority transition was rejected or changed concurrently.',
      observed.authority_state === sourceState && observed.revision === args.expectedRevision,
    );
  }
}

function publicQueues(queues: readonly CloudflareQueueDeliveryState[]): QueueDeliveryResult[] {
  return queues.map((queue) => ({
    name: queue.name,
    deliveryPaused: queue.deliveryPaused,
  }));
}

function replaceQueueState(
  queues: CloudflareQueueDeliveryState[],
  updated: CloudflareQueueDeliveryState,
): void {
  const index = queues.findIndex((queue) => queue.name === updated.name);
  if (index < 0) fail(`Cloudflare Queue state is missing: ${updated.name}.`);
  queues[index] = updated;
}

function queueStatesChanged(
  initial: readonly CloudflareQueueDeliveryState[],
  current: readonly CloudflareQueueDeliveryState[],
): boolean {
  return initial.some((queue) => (
    current.find((entry) => entry.name === queue.name)?.deliveryPaused !== queue.deliveryPaused
  ));
}

function result(args: {
  authority: CommerceAuthority;
  authorityChanged: boolean;
  initialQueues: readonly CloudflareQueueDeliveryState[];
  queues: readonly CloudflareQueueDeliveryState[];
}): CommerceAuthorityControlResult {
  return {
    authority: args.authority,
    queues: publicQueues(args.queues),
    changed: {
      authorityChanged: args.authorityChanged,
      queuesChanged: queueStatesChanged(args.initialQueues, args.queues),
    },
  };
}

async function refreshQueues(
  client: CloudflareQueueMaintenanceClient,
  fallback: CloudflareQueueDeliveryState[],
): Promise<{ queues: CloudflareQueueDeliveryState[]; verified: boolean }> {
  try {
    return { queues: await client.listDeliveryStates(), verified: true };
  } catch {
    return { queues: fallback, verified: false };
  }
}

async function rollbackPausedQueues(args: {
  attemptedNames: readonly string[];
  client: CloudflareQueueMaintenanceClient;
  queues: CloudflareQueueDeliveryState[];
}): Promise<string[]> {
  const failures: string[] = [];
  for (const name of [...args.attemptedNames].reverse()) {
    const queue = args.queues.find((entry) => entry.name === name);
    if (!queue) continue;
    try {
      replaceQueueState(args.queues, await args.client.setDeliveryPaused(queue, false));
    } catch {
      failures.push(name);
    }
  }
  return args.attemptedNames.filter((name) => failures.includes(name));
}

async function prepareQueuesPaused(args: {
  client: CloudflareQueueMaintenanceClient;
  initialQueues: CloudflareQueueDeliveryState[];
}): Promise<{
  attemptedNames: string[];
  queues: CloudflareQueueDeliveryState[];
}> {
  let queues = args.initialQueues.map((queue) => ({ ...queue }));
  const attemptedNames: string[] = [];
  try {
    for (const queue of queues) {
      if (queue.deliveryPaused) continue;
      attemptedNames.push(queue.name);
      replaceQueueState(queues, await args.client.setDeliveryPaused(queue, true));
    }
    queues = await args.client.listDeliveryStates();
    if (queues.some((queue) => !queue.deliveryPaused)) {
      throw new Error('Cloudflare Queue pause verification failed.');
    }
    return { attemptedNames, queues };
  } catch {
    const rollbackFailures = await rollbackPausedQueues({
      attemptedNames,
      client: args.client,
      queues,
    });
    const refreshed = await refreshQueues(args.client, queues);
    queues = refreshed.queues;
    throw new QueuePausePreparationError(queues, rollbackFailures, refreshed.verified);
  }
}

async function pauseForMaintenance(args: {
  authority: CommerceAuthority;
  client: CloudflareQueueMaintenanceClient;
  expectedRevision: number;
  initialQueues: CloudflareQueueDeliveryState[];
  mode: 'transition' | 'repair';
  nowMs: number;
  queryCommerceD1: CommerceAuthorityQuery;
}): Promise<CommerceAuthorityControlResult> {
  let queues: CloudflareQueueDeliveryState[];
  let attemptedNames: string[];
  try {
    ({ attemptedNames, queues } = await prepareQueuesPaused({
      client: args.client,
      initialQueues: args.initialQueues,
    }));
  } catch (error) {
    if (!(error instanceof QueuePausePreparationError)) throw error;
    queues = error.queues;
    const state = result({
      authority: args.authority,
      authorityChanged: false,
      initialQueues: args.initialQueues,
      queues,
    });
    const paused = state.queues.filter((queue) => queue.deliveryPaused).map((queue) => queue.name);
    const priorStateRestored = !queueStatesChanged(args.initialQueues, queues);
    const suffix = !error.rollbackVerified
      ? ' Prior Queue delivery state could not be verified.'
      : error.rollbackFailures.length || !priorStateRestored
      ? ` Queue delivery remains paused for: ${paused.join(', ') || error.rollbackFailures.join(', ')}.`
      : ' Prior Queue delivery state was restored.';
    throw new CommerceAuthorityCoordinationError(`Cloudflare Queue pause failed.${suffix}`, state);
  }

  let authority = args.authority;
  let authorityChanged = false;
  if (args.mode === 'transition') {
    try {
      const transition = await transitionAuthority({
        authority,
        command: 'paused',
        expectedRevision: args.expectedRevision,
        nowMs: args.nowMs,
        queryCommerceD1: args.queryCommerceD1,
      });
      authority = transition.authority;
      authorityChanged = transition.changed;
    } catch (error) {
      if (error instanceof AuthorityTransitionError && error.confirmedUnchanged) {
        const rollbackFailures = await rollbackPausedQueues({
          attemptedNames,
          client: args.client,
          queues,
        });
        const refreshed = await refreshQueues(args.client, queues);
        queues = refreshed.queues;
        const state = result({
          authority: args.authority,
          authorityChanged: false,
          initialQueues: args.initialQueues,
          queues,
        });
        const suffix = !refreshed.verified
          ? ' Queue rollback could not be verified.'
          : rollbackFailures.length
          ? ` Queue rollback failed for: ${rollbackFailures.join(', ')}.`
          : ' Prior Queue delivery state was restored.';
        throw new CommerceAuthorityCoordinationError(`${error.message}${suffix}`, state);
      }
      const state = result({
        authority,
        authorityChanged: false,
        initialQueues: args.initialQueues,
        queues,
      });
      throw new CommerceAuthorityCoordinationError(
        'Commerce authority transition could not be confirmed; Queue delivery remains paused.',
        state,
      );
    }
  }

  const verifiedAuthority = await readAuthority(args.queryCommerceD1);
  if (!sameAuthority(authority, verifiedAuthority)) {
    const state = result({
      authority: verifiedAuthority,
      authorityChanged,
      initialQueues: args.initialQueues,
      queues,
    });
    throw new CommerceAuthorityCoordinationError(
      'Commerce authority changed during Queue coordination; Queue delivery remains paused.',
      state,
    );
  }
  return result({
    authority: verifiedAuthority,
    authorityChanged,
    initialQueues: args.initialQueues,
    queues,
  });
}

async function resumeAfterMaintenance(args: {
  authority: CommerceAuthority;
  client: CloudflareQueueMaintenanceClient;
  expectedRevision: number;
  initialQueues: CloudflareQueueDeliveryState[];
  mode: 'transition' | 'repair';
  nowMs: number;
  queryCommerceD1: CommerceAuthorityQuery;
}): Promise<CommerceAuthorityControlResult> {
  let authority = args.authority;
  let authorityChanged = false;
  let queues = args.initialQueues.map((queue) => ({ ...queue }));
  if (args.mode === 'transition') {
    try {
      const preparation = await prepareQueuesPaused({
        client: args.client,
        initialQueues: args.initialQueues,
      });
      queues = preparation.queues;
    } catch (error) {
      if (!(error instanceof QueuePausePreparationError)) throw error;
      const state = result({
        authority,
        authorityChanged: false,
        initialQueues: args.initialQueues,
        queues: error.queues,
      });
      throw new CommerceAuthorityCoordinationError(
        'Cloudflare Queue pause failed; Commerce authority remains paused.',
        state,
      );
    }
    try {
      const transition = await transitionAuthority({
        authority,
        command: 'd1',
        expectedRevision: args.expectedRevision,
        nowMs: args.nowMs,
        queryCommerceD1: args.queryCommerceD1,
      });
      authority = transition.authority;
      authorityChanged = transition.changed;
    } catch (error) {
      const state = result({
        authority,
        authorityChanged: false,
        initialQueues: args.initialQueues,
        queues,
      });
      throw new CommerceAuthorityCoordinationError(
        error instanceof Error ? error.message : 'Commerce authority transition failed.',
        state,
      );
    }
  }

  const verifiedBeforeResume = await readAuthority(args.queryCommerceD1);
  if (!sameAuthority(authority, verifiedBeforeResume) || verifiedBeforeResume.authority_state !== 'd1') {
    const state = result({
      authority: verifiedBeforeResume,
      authorityChanged,
      initialQueues: args.initialQueues,
      queues,
    });
    throw new CommerceAuthorityCoordinationError(
      'Commerce authority changed before Queue delivery could resume; Queue delivery remains paused.',
      state,
    );
  }
  authority = verifiedBeforeResume;

  for (const queue of queues) {
    if (!queue.deliveryPaused) continue;
    try {
      replaceQueueState(queues, await args.client.setDeliveryPaused(queue, false));
    } catch {}
  }
  try {
    queues = await args.client.listDeliveryStates();
  } catch {
    const state = result({
      authority,
      authorityChanged,
      initialQueues: args.initialQueues,
      queues,
    });
    throw new CommerceAuthorityCoordinationError(
      'Commerce authority is active, but Queue delivery state could not be verified.',
      state,
    );
  }
  const state = result({
    authority,
    authorityChanged,
    initialQueues: args.initialQueues,
    queues,
  });
  const paused = state.queues.filter((queue) => queue.deliveryPaused).map((queue) => queue.name);
  if (paused.length) {
    throw new CommerceAuthorityCoordinationError(
      `Commerce authority is active, but Queue delivery remains paused for: ${paused.join(', ')}.`,
      state,
    );
  }
  const verifiedAfterResume = await readAuthority(args.queryCommerceD1);
  if (!sameAuthority(authority, verifiedAfterResume) || verifiedAfterResume.authority_state !== 'd1') {
    let restoredQueues = queues;
    try {
      restoredQueues = (await prepareQueuesPaused({
        client: args.client,
        initialQueues: queues,
      })).queues;
    } catch (error) {
      if (error instanceof QueuePausePreparationError) restoredQueues = error.queues;
    }
    const coordinationResult = result({
        authority: verifiedAfterResume,
        authorityChanged,
        initialQueues: args.initialQueues,
        queues: restoredQueues,
      });
    const allPaused = coordinationResult.queues.every((queue) => queue.deliveryPaused);
    throw new CommerceAuthorityCoordinationError(
      allPaused
        ? 'Commerce authority changed while Queue delivery resumed; Queue delivery was paused again.'
        : 'Commerce authority changed while Queue delivery resumed; Queue delivery could not be fully paused.',
      coordinationResult,
    );
  }
  return state;
}

export async function runCommerceAuthorityControl(
  args: Args,
  overrides: Partial<CommerceAuthorityControlDependencies> = {},
): Promise<CommerceAuthorityControlResult> {
  const apiToken = String(overrides.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? '').trim();
  if (!apiToken) fail('CLOUDFLARE_API_TOKEN is required.');
  const queueConfig = overrides.queueConfig || readCloudflareQueueMaintenanceConfig();
  const queryCommerceD1 = overrides.queryCommerceD1 || queryRemoteCommerceD1;
  const client = overrides.queueClient || createCloudflareQueueMaintenanceClient({
    config: queueConfig,
    token: apiToken,
    fetch: overrides.providerFetch,
  });
  const authority = await readAuthority(queryCommerceD1);
  const initialQueues = await client.listDeliveryStates();
  if (args.command === 'status') {
    return result({
      authority,
      authorityChanged: false,
      initialQueues,
      queues: initialQueues,
    });
  }
  const expectedRevision = safeInteger(args.expectedRevision, 'Expected revision');
  const mode = transitionMode(authority, args.command, expectedRevision);
  const common = {
    authority,
    client,
    expectedRevision,
    initialQueues,
    mode,
    nowMs: (overrides.nowMs || Date.now)(),
    queryCommerceD1,
  };
  return args.command === 'paused'
    ? pauseForMaintenance(common)
    : resumeAfterMaintenance(common);
}

async function main(): Promise<void> {
  console.log(JSON.stringify(await runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(process.argv.slice(2)),
  ), null, 2));
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Commerce authority control failed.';
  const token = String(process.env.CLOUDFLARE_API_TOKEN || '');
  return token ? message.replaceAll(token, '[redacted]') : message;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await main();
  } catch (error) {
    if (error instanceof CommerceAuthorityCoordinationError) {
      console.error(JSON.stringify({ error: publicErrorMessage(error), ...error.result }, null, 2));
    } else {
      console.error(publicErrorMessage(error));
    }
    process.exitCode = 1;
  }
}
