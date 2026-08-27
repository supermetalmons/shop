import { pathToFileURL } from 'node:url';
import {
  queryRemoteCommerceD1,
  safeInteger,
  sqlString,
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
  leaseToken: () => string;
  nowMs: () => number;
  providerFetch: typeof fetch;
  queryCommerceD1: CommerceAuthorityQuery;
  queueClient?: CloudflareQueueMaintenanceClient;
  queueConfig: CloudflareQueueMaintenanceConfig;
};

type CommerceAuthorityLease = {
  acquiredAtMs: number;
  expiresAtMs: number;
  token: string;
};

const COMMERCE_AUTHORITY_LEASE_TTL_MS = 30 * 60_000;
const D1_NOW_MS_SQL = "(CAST(strftime('%s', 'now') AS INTEGER) * 1000)";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AuthorityTransitionError extends Error {
  constructor(message: string, readonly confirmedUnchanged: boolean) {
    super(message);
    this.name = 'AuthorityTransitionError';
  }
}

class QueueOperationError extends Error {
  constructor(
    message: string,
    readonly queueName: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'QueueOperationError';
  }
}

class QueuePausePreparationError extends AggregateError {
  constructor(
    readonly queues: CloudflareQueueDeliveryState[],
    readonly rollbackErrors: QueueOperationError[],
    readonly rollbackVerified: boolean,
    preparationError: unknown,
  ) {
    super([preparationError, ...rollbackErrors], 'Cloudflare Queue pause failed.');
    this.name = 'QueuePausePreparationError';
  }
}

export class CommerceAuthorityCoordinationError extends AggregateError {
  constructor(
    message: string,
    readonly result: CommerceAuthorityControlResult,
    errors: Iterable<unknown> = [],
  ) {
    super(errors, message);
    this.name = 'CommerceAuthorityCoordinationError';
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function leaseToken(value: unknown): string {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!UUID_V4_PATTERN.test(token)) return fail('Commerce authority coordination lease token is invalid.');
  return token.toLowerCase();
}

function parseLeaseRow(value: unknown, expectedToken: string): CommerceAuthorityLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('Commerce authority coordination lease response is invalid.');
  }
  const row = value as Record<string, unknown>;
  const token = leaseToken(row.lease_token);
  const acquiredAtMs = safeInteger(row.acquired_at_ms, 'Commerce authority coordination lease acquisition');
  const expiresAtMs = safeInteger(row.expires_at_ms, 'Commerce authority coordination lease expiry');
  if (token !== expectedToken || expiresAtMs <= acquiredAtMs) {
    return fail('Commerce authority coordination lease response is invalid.');
  }
  return { acquiredAtMs, expiresAtMs, token };
}

async function acquireCommerceAuthorityLease(
  queryCommerceD1: CommerceAuthorityQuery,
  token: string,
): Promise<CommerceAuthorityLease> {
  let rows: Record<string, unknown>[];
  try {
    rows = await queryCommerceD1(`INSERT INTO commerce_authority_control_lease (
        singleton, lease_token, acquired_at_ms, expires_at_ms
      ) VALUES (
        1,
        ${sqlString(token)},
        ${D1_NOW_MS_SQL},
        ${D1_NOW_MS_SQL} + ${COMMERCE_AUTHORITY_LEASE_TTL_MS}
      )
      ON CONFLICT(singleton) DO UPDATE SET
        lease_token = excluded.lease_token,
        acquired_at_ms = excluded.acquired_at_ms,
        expires_at_ms = excluded.expires_at_ms
      WHERE commerce_authority_control_lease.expires_at_ms <= ${D1_NOW_MS_SQL}
      RETURNING lease_token, acquired_at_ms, expires_at_ms`);
  } catch {
    return fail('Commerce authority coordination lease could not be acquired.');
  }
  if (rows.length === 0) return fail('Another commerce authority control operation is already running.');
  if (rows.length !== 1) return fail('Commerce authority coordination lease response is invalid.');
  return parseLeaseRow(rows[0], token);
}

async function renewCommerceAuthorityLease(
  queryCommerceD1: CommerceAuthorityQuery,
  lease: CommerceAuthorityLease,
): Promise<CommerceAuthorityLease> {
  let rows: Record<string, unknown>[];
  try {
    rows = await queryCommerceD1(`UPDATE commerce_authority_control_lease
      SET expires_at_ms = ${D1_NOW_MS_SQL} + ${COMMERCE_AUTHORITY_LEASE_TTL_MS}
      WHERE singleton = 1 AND lease_token = ${sqlString(lease.token)}
        AND expires_at_ms > ${D1_NOW_MS_SQL}
      RETURNING lease_token, acquired_at_ms, expires_at_ms`);
  } catch {
    return fail('Commerce authority coordination lease could not be renewed.');
  }
  if (rows.length !== 1) return fail('Commerce authority coordination lease ownership was lost.');
  return parseLeaseRow(rows[0], lease.token);
}

async function releaseCommerceAuthorityLease(
  queryCommerceD1: CommerceAuthorityQuery,
  lease: CommerceAuthorityLease,
): Promise<void> {
  let rows: Record<string, unknown>[];
  try {
    rows = await queryCommerceD1(`DELETE FROM commerce_authority_control_lease
      WHERE singleton = 1 AND lease_token = ${sqlString(lease.token)}
      RETURNING lease_token`);
  } catch {
    return fail('Commerce authority coordination lease could not be released.');
  }
  if (rows.length !== 1 || leaseToken(rows[0].lease_token) !== lease.token) {
    return fail('Commerce authority coordination lease ownership was lost before release.');
  }
}

async function withCommerceAuthorityLease(args: {
  leaseToken: string;
  queryCommerceD1: CommerceAuthorityQuery;
  run: (renew: () => Promise<void>) => Promise<CommerceAuthorityControlResult>;
}): Promise<CommerceAuthorityControlResult> {
  let lease = await acquireCommerceAuthorityLease(
    args.queryCommerceD1,
    args.leaseToken,
  );
  const renew = async () => {
    lease = await renewCommerceAuthorityLease(args.queryCommerceD1, lease);
  };
  let operationResult: CommerceAuthorityControlResult | undefined;
  let operationError: unknown;
  try {
    operationResult = await args.run(renew);
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    await releaseCommerceAuthorityLease(args.queryCommerceD1, lease);
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined) {
    if (releaseError === undefined) throw operationError;
    if (operationError instanceof CommerceAuthorityCoordinationError) {
      throw new CommerceAuthorityCoordinationError(
        `${operationError.message} Coordination lease release could not be confirmed.`,
        operationError.result,
        [...operationError.errors, releaseError],
      );
    }
    throw new AggregateError(
      [operationError, releaseError],
      'Commerce authority control failed and its coordination lease release could not be confirmed.',
    );
  }
  if (!operationResult) return fail('Commerce authority control returned no result.');
  if (releaseError !== undefined) {
    throw new CommerceAuthorityCoordinationError(
      'Commerce authority coordination completed, but its lease release could not be confirmed.',
      operationResult,
      [releaseError],
    );
  }
  return operationResult;
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
  coordinationLeaseToken: string,
): string {
  const leaseGuard = `AND EXISTS (
        SELECT 1 FROM commerce_authority_control_lease
        WHERE singleton = 1 AND lease_token = ${sqlString(leaseToken(coordinationLeaseToken))}
          AND expires_at_ms > ${D1_NOW_MS_SQL}
      )`;
  if (command === 'paused') {
    return `UPDATE commerce_authority_control
      SET authority_state = 'paused', revision = revision + 1,
        paused_at_ms = ${nowMs}, updated_at_ms = ${nowMs}
      WHERE singleton = 1 AND authority_state = 'd1' AND revision = ${expectedRevision}
        ${leaseGuard}
      RETURNING *`;
  }
  return `UPDATE commerce_authority_control
    SET authority_state = 'd1', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = ${nowMs}
    WHERE singleton = 1 AND authority_state = 'paused' AND revision = ${expectedRevision}
      ${leaseGuard}
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
  leaseToken: string;
  nowMs: number;
  queryCommerceD1: CommerceAuthorityQuery;
}): Promise<{ authority: CommerceAuthority; changed: boolean }> {
  try {
    const rows = await args.queryCommerceD1(buildCommerceAuthorityMutationSql(
      args.command,
      args.expectedRevision,
      args.nowMs,
      args.leaseToken,
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

type QueueMutationGuard = (queues: readonly CloudflareQueueDeliveryState[]) => Promise<void>;

async function renewLeaseWithState(args: {
  authority: CommerceAuthority;
  authorityChanged: boolean;
  initialQueues: readonly CloudflareQueueDeliveryState[];
  queues: readonly CloudflareQueueDeliveryState[];
  renewLease: () => Promise<void>;
}): Promise<void> {
  try {
    await args.renewLease();
  } catch (error) {
    throw new CommerceAuthorityCoordinationError(
      'Commerce authority coordination lease ownership was lost; no further Queue changes were attempted.',
      result(args),
      [error],
    );
  }
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
  beforeMutation: QueueMutationGuard;
  client: CloudflareQueueMaintenanceClient;
  queues: CloudflareQueueDeliveryState[];
}): Promise<QueueOperationError[]> {
  const errors: QueueOperationError[] = [];
  for (const name of [...args.attemptedNames].reverse()) {
    const queue = args.queues.find((entry) => entry.name === name);
    if (!queue) continue;
    await args.beforeMutation(args.queues);
    try {
      replaceQueueState(args.queues, await args.client.setDeliveryPaused(queue, false));
    } catch (error) {
      errors.push(new QueueOperationError(
        `Cloudflare Queue rollback failed for ${name}.`,
        name,
        error,
      ));
    }
  }
  const failures = new Set(errors.map((error) => error.queueName));
  return args.attemptedNames.flatMap((name) => {
    if (!failures.has(name)) return [];
    return errors.filter((error) => error.queueName === name);
  });
}

async function prepareQueuesPaused(args: {
  beforeMutation: QueueMutationGuard;
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
      await args.beforeMutation(queues);
      replaceQueueState(queues, await args.client.setDeliveryPaused(queue, true));
    }
    queues = await args.client.listDeliveryStates();
    if (queues.some((queue) => !queue.deliveryPaused)) {
      throw new Error('Cloudflare Queue pause verification failed.');
    }
    return { attemptedNames, queues };
  } catch (error) {
    if (error instanceof CommerceAuthorityCoordinationError) throw error;
    const rollbackErrors = await rollbackPausedQueues({
      attemptedNames,
      beforeMutation: args.beforeMutation,
      client: args.client,
      queues,
    });
    const refreshed = await refreshQueues(args.client, queues);
    queues = refreshed.queues;
    throw new QueuePausePreparationError(queues, rollbackErrors, refreshed.verified, error);
  }
}

async function ensureQueuesPaused(args: {
  beforeMutation: QueueMutationGuard;
  client: CloudflareQueueMaintenanceClient;
  queues: CloudflareQueueDeliveryState[];
}): Promise<{
  errors: Error[];
  queues: CloudflareQueueDeliveryState[];
  verified: boolean;
}> {
  let queues = args.queues.map((queue) => ({ ...queue }));
  const patchErrors = new Map<string, unknown[]>();
  for (let pass = 0; pass < 2; pass += 1) {
    for (const queue of queues) {
      if (queue.deliveryPaused) continue;
      await args.beforeMutation(queues);
      try {
        replaceQueueState(queues, await args.client.setDeliveryPaused(queue, true));
      } catch (error) {
        patchErrors.set(queue.name, [...(patchErrors.get(queue.name) || []), error]);
      }
    }
    try {
      queues = await args.client.listDeliveryStates();
    } catch (error) {
      return {
        errors: [
          ...Array.from(patchErrors, ([name, causes]) => new QueueOperationError(
            `Cloudflare Queue pause failed for ${name}.`,
            name,
            causes.length === 1 ? causes[0] : new AggregateError(causes),
          )),
          new Error('Cloudflare Queue pause verification failed.', { cause: error }),
        ],
        queues,
        verified: false,
      };
    }
    if (queues.every((queue) => queue.deliveryPaused)) {
      return { errors: [], queues, verified: true };
    }
  }
  return {
    errors: queues.flatMap((queue) => queue.deliveryPaused ? [] : [new QueueOperationError(
      `Cloudflare Queue delivery remains active for ${queue.name}.`,
      queue.name,
      patchErrors.has(queue.name) ? new AggregateError(patchErrors.get(queue.name) || []) : undefined,
    )]),
    queues,
    verified: true,
  };
}

async function pauseForMaintenance(args: {
  authority: CommerceAuthority;
  client: CloudflareQueueMaintenanceClient;
  expectedRevision: number;
  initialQueues: CloudflareQueueDeliveryState[];
  mode: 'transition' | 'repair';
  leaseToken: string;
  nowMs: number;
  queryCommerceD1: CommerceAuthorityQuery;
  renewLease: () => Promise<void>;
}): Promise<CommerceAuthorityControlResult> {
  let authority = args.authority;
  let authorityChanged = false;
  let queues = args.initialQueues.map((queue) => ({ ...queue }));
  const renewLease = (currentQueues: readonly CloudflareQueueDeliveryState[] = queues) => renewLeaseWithState({
    authority,
    authorityChanged,
    initialQueues: args.initialQueues,
    queues: currentQueues,
    renewLease: args.renewLease,
  });
  let attemptedNames: string[] = [];
  if (args.mode === 'transition') {
    try {
      ({ attemptedNames, queues } = await prepareQueuesPaused({
        beforeMutation: renewLease,
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
      const rollbackNames = error.rollbackErrors.map((failure) => failure.queueName);
      const suffix = !error.rollbackVerified
        ? ' Prior Queue delivery state could not be verified.'
        : !priorStateRestored
        ? ` Prior Queue delivery state was not restored${paused.length ? `; delivery remains paused for: ${paused.join(', ')}` : ''}.`
        : rollbackNames.length
        ? ` Prior Queue delivery state was restored after rollback failures for: ${rollbackNames.join(', ')}.`
        : ' Prior Queue delivery state was restored.';
      throw new CommerceAuthorityCoordinationError(
        `Cloudflare Queue pause failed.${suffix}`,
        state,
        error.errors,
      );
    }
    await renewLease();
  }

  if (args.mode === 'transition') {
    try {
      const transition = await transitionAuthority({
        authority,
        command: 'paused',
        expectedRevision: args.expectedRevision,
        leaseToken: args.leaseToken,
        nowMs: args.nowMs,
        queryCommerceD1: args.queryCommerceD1,
      });
      authority = transition.authority;
      authorityChanged = transition.changed;
    } catch (error) {
      if (error instanceof AuthorityTransitionError && error.confirmedUnchanged) {
        await renewLease();
        const rollbackErrors = await rollbackPausedQueues({
          attemptedNames,
          beforeMutation: renewLease,
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
        const rollbackNames = rollbackErrors.map((failure) => failure.queueName);
        const suffix = !refreshed.verified
          ? ' Queue rollback could not be verified.'
          : rollbackNames.length
          ? ` Queue rollback failed for: ${rollbackNames.join(', ')}.`
          : ' Prior Queue delivery state was restored.';
        throw new CommerceAuthorityCoordinationError(
          `${error.message}${suffix}`,
          state,
          [error, ...rollbackErrors],
        );
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
        [error],
      );
    }
    await renewLease();
  }

  const ensured = await ensureQueuesPaused({ beforeMutation: renewLease, client: args.client, queues });
  queues = ensured.queues;
  await renewLease();
  let verifiedAuthority: CommerceAuthority;
  try {
    verifiedAuthority = await readAuthority(args.queryCommerceD1);
  } catch (error) {
    throw new CommerceAuthorityCoordinationError(
      'Commerce authority could not be verified after Queue delivery was paused.',
      result({
        authority,
        authorityChanged,
        initialQueues: args.initialQueues,
        queues,
      }),
      [...ensured.errors, error],
    );
  }
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
      ensured.errors,
    );
  }
  const state = result({
    authority: verifiedAuthority,
    authorityChanged,
    initialQueues: args.initialQueues,
    queues,
  });
  const active = state.queues.filter((queue) => !queue.deliveryPaused).map((queue) => queue.name);
  if (!ensured.verified || active.length) {
    throw new CommerceAuthorityCoordinationError(
      ensured.verified
        ? `Commerce authority is paused, but Queue delivery remains active for: ${active.join(', ')}.`
        : 'Commerce authority is paused, but Queue delivery state could not be verified.',
      state,
      ensured.errors,
    );
  }
  return state;
}

async function resumeAfterMaintenance(args: {
  authority: CommerceAuthority;
  client: CloudflareQueueMaintenanceClient;
  expectedRevision: number;
  initialQueues: CloudflareQueueDeliveryState[];
  mode: 'transition' | 'repair';
  leaseToken: string;
  nowMs: number;
  queryCommerceD1: CommerceAuthorityQuery;
  renewLease: () => Promise<void>;
}): Promise<CommerceAuthorityControlResult> {
  let authority = args.authority;
  let authorityChanged = false;
  let queues = args.initialQueues.map((queue) => ({ ...queue }));
  const renewLease = (currentQueues: readonly CloudflareQueueDeliveryState[] = queues) => renewLeaseWithState({
    authority,
    authorityChanged,
    initialQueues: args.initialQueues,
    queues: currentQueues,
    renewLease: args.renewLease,
  });
  if (args.mode === 'transition') {
    const ensured = await ensureQueuesPaused({ beforeMutation: renewLease, client: args.client, queues });
    queues = ensured.queues;
    const active = queues.filter((queue) => !queue.deliveryPaused).map((queue) => queue.name);
    if (!ensured.verified || active.length) {
      throw new CommerceAuthorityCoordinationError(
        ensured.verified
          ? `Cloudflare Queue pause failed for: ${active.join(', ')}; Commerce authority remains paused.`
          : 'Cloudflare Queue pause could not be verified; Commerce authority remains paused.',
        result({
          authority,
          authorityChanged: false,
          initialQueues: args.initialQueues,
          queues,
        }),
        ensured.errors,
      );
    }
    await renewLease();
    try {
      const transition = await transitionAuthority({
        authority,
        command: 'd1',
        expectedRevision: args.expectedRevision,
        leaseToken: args.leaseToken,
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
        [error],
      );
    }
    await renewLease();
  }

  let verifiedBeforeResume: CommerceAuthority;
  try {
    verifiedBeforeResume = await readAuthority(args.queryCommerceD1);
  } catch (error) {
    throw new CommerceAuthorityCoordinationError(
      'Commerce authority could not be verified before Queue delivery resumed.',
      result({
        authority,
        authorityChanged,
        initialQueues: args.initialQueues,
        queues,
      }),
      [error],
    );
  }
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
  await renewLease();

  const resumePatchErrors = new Map<string, unknown>();
  for (const queue of queues) {
    if (!queue.deliveryPaused) continue;
    await renewLease(queues);
    try {
      replaceQueueState(queues, await args.client.setDeliveryPaused(queue, false));
    } catch (error) {
      resumePatchErrors.set(queue.name, error);
    }
  }
  let queueVerificationError: unknown;
  try {
    queues = await args.client.listDeliveryStates();
  } catch (error) {
    queueVerificationError = error;
  }
  await renewLease();
  const state = result({
    authority,
    authorityChanged,
    initialQueues: args.initialQueues,
    queues,
  });
  const paused = state.queues.filter((queue) => queue.deliveryPaused).map((queue) => queue.name);
  let verifiedAfterResume: CommerceAuthority;
  let verificationError: unknown;
  try {
    verifiedAfterResume = await readAuthority(args.queryCommerceD1);
  } catch (error) {
    verifiedAfterResume = authority;
    verificationError = error;
  }
  if (verificationError !== undefined ||
    !sameAuthority(authority, verifiedAfterResume) || verifiedAfterResume.authority_state !== 'd1') {
    await renewLease();
    const restored = await ensureQueuesPaused({ beforeMutation: renewLease, client: args.client, queues });
    const coordinationResult = result({
      authority: verifiedAfterResume,
      authorityChanged,
      initialQueues: args.initialQueues,
      queues: restored.queues,
    });
    const allPaused = restored.verified && coordinationResult.queues.every((queue) => queue.deliveryPaused);
    const errors = [
      ...(queueVerificationError === undefined ? [] : [queueVerificationError]),
      ...(verificationError === undefined ? [] : [verificationError]),
      ...restored.errors,
    ];
    throw new CommerceAuthorityCoordinationError(
      verificationError !== undefined
        ? allPaused
          ? 'Commerce authority could not be verified after Queue delivery resumed; Queue delivery was paused again.'
          : 'Commerce authority could not be verified after Queue delivery resumed; Queue delivery could not be fully paused.'
        : allPaused
        ? 'Commerce authority changed while Queue delivery resumed; Queue delivery was paused again.'
        : 'Commerce authority changed while Queue delivery resumed; Queue delivery could not be fully paused.',
      coordinationResult,
      errors,
    );
  }
  if (queueVerificationError !== undefined) {
    throw new CommerceAuthorityCoordinationError(
      'Commerce authority is active, but Queue delivery state could not be verified.',
      state,
      [
        ...Array.from(resumePatchErrors, ([name, cause]) => new QueueOperationError(
          `Cloudflare Queue resume failed for ${name}.`,
          name,
          cause,
        )),
        queueVerificationError,
      ],
    );
  }
  if (paused.length) {
    throw new CommerceAuthorityCoordinationError(
      `Commerce authority is active, but Queue delivery remains paused for: ${paused.join(', ')}.`,
      state,
      paused.map((name) => new QueueOperationError(
        `Cloudflare Queue delivery remains paused for ${name}.`,
        name,
        resumePatchErrors.get(name),
      )),
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
  if (args.command === 'status') {
    const authority = await readAuthority(queryCommerceD1);
    const initialQueues = await client.listDeliveryStates();
    return result({
      authority,
      authorityChanged: false,
      initialQueues,
      queues: initialQueues,
    });
  }
  const command = args.command;
  const expectedRevision = safeInteger(args.expectedRevision, 'Expected revision');
  const nowMs = overrides.nowMs || Date.now;
  const token = leaseToken(overrides.leaseToken ? overrides.leaseToken() : crypto.randomUUID());
  return withCommerceAuthorityLease({
    leaseToken: token,
    queryCommerceD1,
    run: async (renewLease) => {
      const authority = await readAuthority(queryCommerceD1);
      const initialQueues = await client.listDeliveryStates();
      await renewLease();
      const common = {
        authority,
        client,
        expectedRevision,
        initialQueues,
        leaseToken: token,
        mode: transitionMode(authority, command, expectedRevision),
        nowMs: nowMs(),
        queryCommerceD1,
        renewLease,
      };
      return command === 'paused'
        ? pauseForMaintenance(common)
        : resumeAfterMaintenance(common);
    },
  });
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
