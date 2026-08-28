import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  COMMERCE_IN_FLIGHT_DRAIN_WAIT_MS,
  CommerceAuthorityCoordinationError,
  buildCommerceAuthorityMutationSql,
  parseCommerceAuthorityControlArgs,
  runCommerceAuthorityControl,
} from '../scripts/ops/commerceAuthorityControl.ts';
import {
  createCloudflareQueueMaintenanceClient,
  parseCloudflareQueueMaintenanceConfig,
  readCloudflareQueueMaintenanceConfig,
  type CloudflareQueueDeliveryState,
  type CloudflareQueueMaintenanceClient,
} from '../scripts/shared/cloudflareQueueMaintenance.ts';

const ACCOUNT_ID = 'a'.repeat(32);
const QUEUE_NAMES = ['queue-a', 'queue-b', 'queue-c'];
const QUEUE_CONFIG = { accountId: ACCOUNT_ID, queueNames: QUEUE_NAMES };
const LEASE_TOKEN = '123e4567-e89b-42d3-a456-426614174000';

function authorityRow(
  state: 'paused' | 'd1',
  revision: number,
  updatedAtMs = 0,
  pausedAtMs: number | null = state === 'paused' ? updatedAtMs || 1 : null,
) {
  return {
    authority_state: state,
    revision,
    documents_revision: 12,
    paused_at_ms: state === 'paused' ? pausedAtMs : null,
    updated_at_ms: updatedAtMs,
  };
}

function authorityHarness(
  initialState: 'paused' | 'd1',
  initialRevision: number,
  events: string[],
  failedTransitions: Set<'paused' | 'd1'> = new Set(),
  options: {
    d1NowMs?: number;
    failedReadiness?: Set<'clear' | 'ready'>;
    leaseNowMs?: number;
    failLeaseRelease?: boolean;
    initialLease?: { acquired_at_ms: number; expires_at_ms: number; lease_token: string };
  } = {},
) {
  let current = authorityRow(initialState, initialRevision);
  let lease = options.initialLease ? { ...options.initialLease } : null;
  const d1NowMs = options.d1NowMs ?? 100;
  const leaseNowMs = options.leaseNowMs ?? 100;
  return {
    get current() {
      return current;
    },
    get lease() {
      return lease && { ...lease };
    },
    replaceLease(next: { acquired_at_ms: number; expires_at_ms: number; lease_token: string }) {
      lease = { ...next };
    },
    async query(sql: string): Promise<Record<string, unknown>[]> {
      if (/^\s*INSERT INTO commerce_authority_control_lease/.test(sql)) {
        const token = /VALUES \(\s*1,\s*'([^']+)'/s.exec(sql)?.[1];
        assert.ok(token);
        if (lease && lease.expires_at_ms > leaseNowMs) return [];
        lease = {
          lease_token: token,
          acquired_at_ms: leaseNowMs,
          expires_at_ms: leaseNowMs + 30 * 60_000,
        };
        return [{ ...lease }];
      }
      if (/^\s*UPDATE commerce_authority_control_lease/.test(sql)) {
        const token = /lease_token = '([^']+)'/.exec(sql)?.[1];
        if (!lease || lease.lease_token !== token || lease.expires_at_ms <= leaseNowMs) return [];
        lease = { ...lease, expires_at_ms: leaseNowMs + 30 * 60_000 };
        return [{ ...lease }];
      }
      if (/^\s*DELETE FROM commerce_authority_control_lease/.test(sql)) {
        if (options.failLeaseRelease) throw new Error('private lease release failure');
        const token = /lease_token = '([^']+)'/.exec(sql)?.[1];
        if (!lease || lease.lease_token !== token) return [];
        const released = lease;
        lease = null;
        return [{ lease_token: released.lease_token }];
      }
      if (/^\s*SELECT/.test(sql)) {
        events.push('d1:read');
        return [{ ...current }];
      }
      if (/^\s*UPDATE commerce_authority_control\s+SET paused_at_ms/.test(sql)) {
        const readiness = /SET paused_at_ms = NULL/.test(sql) ? 'clear' : 'ready';
        events.push(`d1:${readiness}`);
        if (options.failedReadiness?.has(readiness)) throw new Error('private D1 failure');
        const guardToken = /AND lease_token = '([^']+)'/.exec(sql)?.[1];
        const expectedRevision = Number(sql.match(/AND revision = (\d+)/)?.[1]);
        if (
          !lease ||
          lease.lease_token !== guardToken ||
          lease.expires_at_ms <= leaseNowMs ||
          current.authority_state !== 'paused' ||
          current.revision !== expectedRevision ||
          (readiness === 'ready' && current.paused_at_ms !== null)
        ) return [];
        current = {
          ...current,
          paused_at_ms: readiness === 'ready' ? d1NowMs : null,
          updated_at_ms: d1NowMs,
        };
        return [{ ...current }];
      }
      const target = sql.includes("SET authority_state = 'paused'") ? 'paused' : 'd1';
      events.push(`d1:${target}`);
      if (failedTransitions.has(target)) throw new Error('private D1 failure');
      const guardToken = /AND lease_token = '([^']+)'/.exec(sql)?.[1];
      if (!lease || lease.lease_token !== guardToken || lease.expires_at_ms <= leaseNowMs) return [];
      const source = target === 'paused' ? 'd1' : 'paused';
      const expectedRevision = Number(sql.match(/AND revision = (\d+)/)?.[1]);
      if (current.authority_state !== source || current.revision !== expectedRevision) return [];
      current = authorityRow(target, current.revision + 1, d1NowMs, null);
      return [{ ...current }];
    },
  };
}

function queueState(name: string, deliveryPaused: boolean): CloudflareQueueDeliveryState {
  return { id: `id-${name}`, name, deliveryPaused };
}

function queueHarness(args: {
  initial?: Partial<Record<string, boolean>>;
  events: string[];
  failures?: Set<string>;
}): CloudflareQueueMaintenanceClient {
  const states = new Map(QUEUE_NAMES.map((name) => [
    name,
    queueState(name, args.initial?.[name] === true),
  ]));
  return {
    async listDeliveryStates() {
      args.events.push('queues:list');
      return QUEUE_NAMES.map((name) => ({ ...states.get(name)! }));
    },
    async setDeliveryPaused(queue, deliveryPaused) {
      const operation = `${queue.name}:${deliveryPaused}`;
      args.events.push(`queue:${operation}`);
      if (args.failures?.has(operation)) throw new Error('private Cloudflare failure');
      const updated = queueState(queue.name, deliveryPaused);
      states.set(queue.name, updated);
      return { ...updated };
    },
  };
}

function dependencies(args: {
  authority: ReturnType<typeof authorityHarness>;
  leaseToken?: string;
  queueClient: CloudflareQueueMaintenanceClient;
  wait?: (durationMs: number) => Promise<void>;
}) {
  return {
    apiToken: 'private-api-token',
    leaseToken: () => args.leaseToken || LEASE_TOKEN,
    queryCommerceD1: args.authority.query,
    queueClient: args.queueClient,
    queueConfig: QUEUE_CONFIG,
    wait: args.wait || (async () => {}),
  };
}

test('commerce authority mutations require explicit write and revision guards', () => {
  assert.deepEqual(parseCommerceAuthorityControlArgs(['status']), {
    command: 'status',
    expectedRevision: undefined,
    write: false,
  });
  assert.throws(() => parseCommerceAuthorityControlArgs(['paused']));
  assert.deepEqual(parseCommerceAuthorityControlArgs([
    'paused', '--expected-revision', '7', '--write',
  ]), {
    command: 'paused',
    expectedRevision: 7,
    write: true,
  });
  const sql = buildCommerceAuthorityMutationSql('d1', 7, LEASE_TOKEN);
  assert.match(sql, /authority_state = 'paused'/);
  assert.match(sql, /revision = 7/);
  assert.match(sql, /paused_at_ms = NULL/);
  assert.match(sql, /updated_at_ms = \(CAST\(strftime\('%s', 'now'\) AS INTEGER\) \* 1000\)/);
  assert.doesNotMatch(sql, /updated_at_ms = 100/);
  assert.match(sql, /commerce_authority_control_lease/);
  assert.match(sql, new RegExp(LEASE_TOKEN));
  assert.match(sql, /strftime\('%s', 'now'\)/);
  const pauseSql = buildCommerceAuthorityMutationSql('paused', 7, LEASE_TOKEN);
  assert.match(pauseSql, /authority_state = 'd1'/);
  assert.match(pauseSql, /paused_at_ms = NULL/);
  assert.throws(() => parseCommerceAuthorityControlArgs(['replace', '--expected-revision', '7', '--write']));
});

test('commerce authority lease and guarded transition execute against the current schema', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(readFileSync('cloud/workers/api/commerce-migrations/0001_current_schema.sql', 'utf8'));
    database.exec(readFileSync('cloud/workers/api/commerce-migrations/0002_authority_control_lease.sql', 'utf8'));
    database.exec(readFileSync('cloud/workers/api/commerce-migrations/0003_wipe_readiness_guard.sql', 'utf8'));
    const events: string[] = [];
    const result = await runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '1', '--write']),
      {
        apiToken: 'private-api-token',
        leaseToken: () => LEASE_TOKEN,
        queryCommerceD1: async (sql) => database.prepare(sql).all().map((row) => ({ ...row })),
        queueClient: queueHarness({ events }),
        queueConfig: QUEUE_CONFIG,
        wait: async () => {},
      },
    );
    assert.equal(result.authority.authority_state, 'paused');
    assert.equal(result.authority.revision, 2);
    assert.notEqual(result.authority.paused_at_ms, null);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM commerce_authority_control_lease').get()!.count, 0);
  } finally {
    database.close();
  }
});

test('Queue maintenance configuration covers every consumer in configuration order', () => {
  const config = readCloudflareQueueMaintenanceConfig();
  assert.equal(config.accountId, 'e25f90fc073ea309b54b8b5144bf28e0');
  assert.deepEqual(config.queueNames, [
    'mons-shop-notification-emails',
    'mons-shop-reveal-reconciliation',
    'mons-shop-stripe-fulfillment',
  ]);
  assert.deepEqual(parseCloudflareQueueMaintenanceConfig({
    account_id: ACCOUNT_ID,
    queues: {
      consumers: [
        { queue: 'queue-c' },
        { queue: 'queue-a' },
        { queue: 'queue-dlq' },
        { queue: 'queue-b' },
      ],
      producers: [
        { binding: 'B', queue: 'queue-b' },
        { binding: 'A', queue: 'queue-a' },
        { binding: 'C', queue: 'queue-c' },
      ],
    },
  }).queueNames, ['queue-c', 'queue-a', 'queue-dlq', 'queue-b']);
  assert.deepEqual(parseCloudflareQueueMaintenanceConfig({
    account_id: ACCOUNT_ID,
    queues: { consumers: [{ queue: 'consumer-only' }] },
  }).queueNames, ['consumer-only']);
  const excessiveQueues = Array.from({ length: 17 }, (_, index) => ({ queue: `queue-${index}` }));
  assert.throws(() => parseCloudflareQueueMaintenanceConfig({
    account_id: ACCOUNT_ID,
    queues: { consumers: excessiveQueues, producers: excessiveQueues },
  }), /too many/);
});

test('Queue maintenance configuration accepts JSONC comments and trailing commas', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-queue-config-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const configPath = join(directory, 'wrangler.jsonc');
  writeFileSync(configPath, `{
    // production account
    "account_id": "${ACCOUNT_ID}",
    "queues": {
      "consumers": [{ "queue": "queue-a" },],
      "producers": [{ "binding": "QUEUE", "queue": "queue-a" },],
    },
  }`);
  assert.deepEqual(readCloudflareQueueMaintenanceConfig(configPath), {
    accountId: ACCOUNT_ID,
    queueNames: ['queue-a'],
  });
});

test('Cloudflare Queue client lists and patches delivery state without exposing its token', async () => {
  const token = 'private-cloudflare-api-token';
  const states = new Map([
    ['queue-a', queueState('queue-a', false)],
    ['queue-b', queueState('queue-b', true)],
  ]);
  const calls: Array<{ method: string; pathname: string; body?: unknown }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method || 'GET';
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
    if (method === 'GET') {
      calls.push({ method, pathname: url.pathname });
      return Response.json({
        success: true,
        result: [...states.values()].reverse().map((queue) => ({
          queue_id: queue.id,
          queue_name: queue.name,
          settings: { delivery_paused: queue.deliveryPaused },
        })),
        result_info: { page: 1, total_pages: 1 },
      });
    }
    const body = JSON.parse(String(init?.body)) as { settings: { delivery_paused: boolean } };
    calls.push({ method, pathname: url.pathname, body });
    const queue = [...states.values()].find((value) => url.pathname.endsWith(`/${value.id}`));
    assert.ok(queue);
    const updated = queueState(queue.name, body.settings.delivery_paused);
    states.set(queue.name, updated);
    return Response.json({
      success: true,
      result: {
        queue_id: updated.id,
        queue_name: updated.name,
        settings: { delivery_paused: updated.deliveryPaused },
      },
    });
  };
  const client = createCloudflareQueueMaintenanceClient({
    config: { accountId: ACCOUNT_ID, queueNames: ['queue-a', 'queue-b'] },
    token,
    fetch: providerFetch,
  });
  const listed = await client.listDeliveryStates();
  assert.deepEqual(listed.map(({ name, deliveryPaused }) => ({ name, deliveryPaused })), [
    { name: 'queue-a', deliveryPaused: false },
    { name: 'queue-b', deliveryPaused: true },
  ]);
  await client.setDeliveryPaused(listed[0], true);
  assert.deepEqual(calls, [
    {
      method: 'GET',
      pathname: `/client/v4/accounts/${ACCOUNT_ID}/queues`,
    },
    {
      method: 'PATCH',
      pathname: `/client/v4/accounts/${ACCOUNT_ID}/queues/id-queue-a`,
      body: { settings: { delivery_paused: true } },
    },
  ]);

  const failing = createCloudflareQueueMaintenanceClient({
    config: { accountId: ACCOUNT_ID, queueNames: ['queue-a'] },
    token,
    fetch: async () => Response.json({ success: false, errors: [{ message: token }] }, { status: 403 }),
  });
  await assert.rejects(failing.listDeliveryStates(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(token), false);
    return true;
  });
});

test('Cloudflare Queue client bounds stalled control-plane requests', async () => {
  const client = createCloudflareQueueMaintenanceClient({
    config: { accountId: ACCOUNT_ID, queueNames: ['queue-a'] },
    token: 'private-cloudflare-api-token',
    timeoutMs: 5,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error('missing abort signal'));
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await assert.rejects(client.listDeliveryStates(), /inventory request failed/);
  const excessiveInventory = createCloudflareQueueMaintenanceClient({
    config: { accountId: ACCOUNT_ID, queueNames: ['queue-a'] },
    token: 'private-cloudflare-api-token',
    fetch: async () => Response.json({
      success: true,
      result: [],
      result_info: { page: 1, total_pages: 11 },
    }),
  });
  await assert.rejects(excessiveInventory.listDeliveryStates(), /pagination is invalid/);
});

test('status requires Cloudflare credentials and reports Queue and D1 state without mutations', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 7, events);
  const queueClient = queueHarness({ events, initial: { 'queue-b': true } });
  await assert.rejects(
    runCommerceAuthorityControl(parseCommerceAuthorityControlArgs(['status']), {
      apiToken: '',
      queryCommerceD1: authority.query,
      queueClient,
      queueConfig: QUEUE_CONFIG,
    }),
    /CLOUDFLARE_API_TOKEN is required/,
  );
  const result = await runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(['status']),
    dependencies({ authority, queueClient }),
  );
  assert.deepEqual(result, {
    authority: authorityRow('d1', 7),
    queues: [
      { name: 'queue-a', deliveryPaused: false },
      { name: 'queue-b', deliveryPaused: true },
      { name: 'queue-c', deliveryPaused: false },
    ],
    changed: { authorityChanged: false, queuesChanged: false },
  });
  assert.deepEqual(events, ['d1:read', 'queues:list']);
  assert.equal(authority.lease, null);
});

test('status does not acquire or replace an active coordination lease', async () => {
  const events: string[] = [];
  const activeLease = {
    acquired_at_ms: 50,
    expires_at_ms: 200,
    lease_token: '223e4567-e89b-42d3-a456-426614174000',
  };
  const authority = authorityHarness('d1', 7, events, new Set(), { initialLease: activeLease });
  const state = await runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(['status']),
    dependencies({ authority, queueClient: queueHarness({ events }) }),
  );
  assert.equal(state.authority.authority_state, 'd1');
  assert.deepEqual(authority.lease, activeLease);
});

test('expired coordination lease is atomically replaced for idempotent repair', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 8, events, new Set(), {
    initialLease: {
      acquired_at_ms: 1,
      expires_at_ms: 99,
      lease_token: '223e4567-e89b-42d3-a456-426614174000',
    },
  });
  const state = await runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(['d1', '--expected-revision', '7', '--write']),
    dependencies({
      authority,
      leaseToken: '323e4567-e89b-42d3-a456-426614174000',
      queueClient: queueHarness({ events, initial: { 'queue-c': true } }),
    }),
  );
  assert.equal(state.changed.authorityChanged, false);
  assert.ok(state.queues.every((queue) => !queue.deliveryPaused));
  assert.equal(authority.lease, null);
});

test('pause changes every Queue before transitioning D1', async () => {
  const events: string[] = [];
  const waits: number[] = [];
  const authority = authorityHarness('d1', 7, events);
  const queueClient = queueHarness({ events });
  const state = await runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
    dependencies({
      authority,
      queueClient,
      wait: async (durationMs) => {
        waits.push(durationMs);
        events.push(`drain:${waits.length}`);
      },
    }),
  );
  assert.deepEqual(events, [
    'd1:read',
    'queues:list',
    'queue:queue-a:true',
    'queue:queue-b:true',
    'queue:queue-c:true',
    'queues:list',
    'drain:1',
    'queues:list',
    'd1:paused',
    'drain:2',
    'queues:list',
    'd1:read',
    'd1:ready',
  ]);
  assert.deepEqual(waits, [COMMERCE_IN_FLIGHT_DRAIN_WAIT_MS, COMMERCE_IN_FLIGHT_DRAIN_WAIT_MS]);
  assert.ok(COMMERCE_IN_FLIGHT_DRAIN_WAIT_MS > 15 * 60_000);
  assert.deepEqual(state, {
    authority: authorityRow('paused', 8, 100),
    queues: QUEUE_NAMES.map((name) => ({ name, deliveryPaused: true })),
    changed: { authorityChanged: true, queuesChanged: true },
  });
  assert.equal(authority.lease, null);
});

test('successful result is preserved when conditional lease release fails', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 7, events, new Set(), { failLeaseRelease: true });
  let failure: CommerceAuthorityCoordinationError | undefined;
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
      dependencies({ authority, queueClient: queueHarness({ events }) }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommerceAuthorityCoordinationError);
      failure = error;
      return true;
    },
  );
  assert.equal(failure?.result.authority.authority_state, 'paused');
  assert.ok(failure?.result.queues.every((queue) => queue.deliveryPaused));
  assert.match(failure?.message || '', /release could not be confirmed/);
  assert.equal((failure?.message || '').includes(LEASE_TOKEN), false);
  assert.equal(authority.lease?.lease_token, LEASE_TOKEN);
});

test('active pause lease rejects concurrent mutations and repairs before authority or Queue reads', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 7, events);
  const states = new Map(QUEUE_NAMES.map((name) => [name, queueState(name, false)]));
  let releasePause = () => {};
  const pauseGate = new Promise<void>((resolve) => { releasePause = resolve; });
  let signalPause = () => {};
  const pauseStarted = new Promise<void>((resolve) => { signalPause = resolve; });
  const queueClient: CloudflareQueueMaintenanceClient = {
    async listDeliveryStates() {
      return QUEUE_NAMES.map((name) => ({ ...states.get(name)! }));
    },
    async setDeliveryPaused(queue, deliveryPaused) {
      if (queue.name === 'queue-a' && deliveryPaused) {
        signalPause();
        await pauseGate;
      }
      const updated = queueState(queue.name, deliveryPaused);
      states.set(queue.name, updated);
      return { ...updated };
    },
  };
  const pause = runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
    dependencies({ authority, leaseToken: LEASE_TOKEN, queueClient }),
  );
  await pauseStarted;
  const authorityReadsBefore = events.filter((event) => event === 'd1:read').length;
  let repairQueueReads = 0;
  for (const [command, token] of [
    ['paused', '223e4567-e89b-42d3-a456-426614174000'],
    ['d1', '323e4567-e89b-42d3-a456-426614174000'],
  ] as const) {
    await assert.rejects(
      runCommerceAuthorityControl(
        parseCommerceAuthorityControlArgs([command, '--expected-revision', '7', '--write']),
        dependencies({
          authority,
          leaseToken: token,
          queueClient: {
            async listDeliveryStates() {
              repairQueueReads += 1;
              return [];
            },
            async setDeliveryPaused() {
              throw new Error('unexpected concurrent Queue mutation');
            },
          },
        }),
      ),
      /already running/,
    );
  }
  assert.equal(repairQueueReads, 0);
  assert.equal(events.filter((event) => event === 'd1:read').length, authorityReadsBefore);
  releasePause();
  const paused = await pause;
  assert.equal(paused.authority.authority_state, 'paused');
  assert.ok(paused.queues.every((queue) => queue.deliveryPaused));
  assert.ok([...states.values()].every((queue) => queue.deliveryPaused));
  assert.equal(authority.lease, null);
});

test('lease takeover stops later Queue mutations without rolling back successor state', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 7, events);
  let patches = 0;
  const queueClient = queueHarness({ events });
  const guardedClient: CloudflareQueueMaintenanceClient = {
    listDeliveryStates: queueClient.listDeliveryStates,
    async setDeliveryPaused(queue, deliveryPaused) {
      const updated = await queueClient.setDeliveryPaused(queue, deliveryPaused);
      patches += 1;
      if (patches === 1) {
        authority.replaceLease({
          acquired_at_ms: 100,
          expires_at_ms: 30 * 60_000,
          lease_token: '223e4567-e89b-42d3-a456-426614174000',
        });
      }
      return updated;
    },
  };
  let failure: CommerceAuthorityCoordinationError | undefined;
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
      dependencies({ authority, queueClient: guardedClient }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommerceAuthorityCoordinationError);
      failure = error;
      return true;
    },
  );
  assert.equal(authority.current.authority_state, 'd1');
  assert.deepEqual(events.filter((event) => event.startsWith('queue:')), ['queue:queue-a:true']);
  assert.deepEqual(failure?.result.queues, [
    { name: 'queue-a', deliveryPaused: true },
    { name: 'queue-b', deliveryPaused: false },
    { name: 'queue-c', deliveryPaused: false },
  ]);
  assert.match(failure?.message || '', /lease ownership was lost/);
  assert.equal((failure?.message || '').includes(LEASE_TOKEN), false);
});

test('pause rolls back every attempted Queue when one pause fails and leaves D1 active', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 7, events);
  const queueClient = queueHarness({
    events,
    failures: new Set(['queue-b:true']),
  });
  let failure: CommerceAuthorityCoordinationError | undefined;
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
      dependencies({ authority, queueClient }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommerceAuthorityCoordinationError);
      failure = error;
      return true;
    },
  );
  assert.deepEqual(events, [
    'd1:read',
    'queues:list',
    'queue:queue-a:true',
    'queue:queue-b:true',
    'queue:queue-b:false',
    'queue:queue-a:false',
    'queues:list',
  ]);
  assert.equal(events.includes('d1:paused'), false);
  assert.equal(authority.current.authority_state, 'd1');
  assert.equal(authority.lease, null);
  assert.deepEqual(failure?.result.queues, QUEUE_NAMES.map((name) => ({
    name,
    deliveryPaused: false,
  })));
  assert.equal(failure?.message.includes('private-api-token'), false);
});

test('pause retains rollback errors while preserving the verified result state', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 7, events, new Set(), { failLeaseRelease: true });
  const queueClient = queueHarness({
    events,
    failures: new Set(['queue-b:true', 'queue-a:false']),
  });
  let failure: CommerceAuthorityCoordinationError | undefined;
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
      dependencies({ authority, queueClient }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommerceAuthorityCoordinationError);
      assert.ok(error instanceof AggregateError);
      failure = error;
      return true;
    },
  );
  assert.equal(authority.current.authority_state, 'd1');
  assert.deepEqual(failure?.result.queues, [
    { name: 'queue-a', deliveryPaused: true },
    { name: 'queue-b', deliveryPaused: false },
    { name: 'queue-c', deliveryPaused: false },
  ]);
  const rollbackError = failure?.errors.find((error) =>
    error instanceof Error && error.message === 'Cloudflare Queue rollback failed for queue-a.');
  assert.ok(rollbackError instanceof Error);
  assert.ok(rollbackError.cause instanceof Error);
  assert.match(failure?.message || '', /queue-a/);
  assert.match(failure?.message || '', /lease release/);
  assert.equal(authority.lease?.lease_token, LEASE_TOKEN);
});

test('pause verifies read-back state before transitioning D1', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 7, events);
  const queueClient: CloudflareQueueMaintenanceClient = {
    async listDeliveryStates() {
      events.push('queues:list');
      return QUEUE_NAMES.map((name) => queueState(name, false));
    },
    async setDeliveryPaused(queue, deliveryPaused) {
      events.push(`queue:${queue.name}:${deliveryPaused}`);
      return queueState(queue.name, deliveryPaused);
    },
  };
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
      dependencies({ authority, queueClient }),
    ),
    CommerceAuthorityCoordinationError,
  );
  assert.equal(authority.current.authority_state, 'd1');
  assert.equal(events.includes('d1:paused'), false);
  assert.deepEqual(events, [
    'd1:read',
    'queues:list',
    'queue:queue-a:true',
    'queue:queue-b:true',
    'queue:queue-c:true',
    'queues:list',
    'queue:queue-c:false',
    'queue:queue-b:false',
    'queue:queue-a:false',
    'queues:list',
  ]);
});

test('pause restores Queue delivery when the D1 transition is confirmed unchanged', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 7, events, new Set(['paused']));
  const queueClient = queueHarness({ events });
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
      dependencies({ authority, queueClient }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommerceAuthorityCoordinationError);
      assert.ok(error.result.queues.every((queue) => !queue.deliveryPaused));
      return true;
    },
  );
  assert.equal(authority.current.authority_state, 'd1');
  assert.deepEqual(events, [
    'd1:read',
    'queues:list',
    'queue:queue-a:true',
    'queue:queue-b:true',
    'queue:queue-c:true',
    'queues:list',
    'queues:list',
    'd1:paused',
    'd1:read',
    'queue:queue-c:false',
    'queue:queue-b:false',
    'queue:queue-a:false',
    'queues:list',
  ]);
});

test('pause repairs Queue state idempotently when the same authority transition already completed', async () => {
  const events: string[] = [];
  const authority = authorityHarness('paused', 8, events);
  const queueClient = queueHarness({
    events,
    initial: { 'queue-a': true, 'queue-c': true },
  });
  const state = await runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
    dependencies({ authority, queueClient }),
  );
  assert.deepEqual(events, [
    'd1:read',
    'queues:list',
    'd1:clear',
    'queue:queue-b:true',
    'queues:list',
    'queues:list',
    'd1:read',
    'd1:ready',
  ]);
  assert.deepEqual(state.changed, { authorityChanged: false, queuesChanged: true });
  assert.ok(state.queues.every((queue) => queue.deliveryPaused));
});

test('pause repair clears readiness before draining and leaves it cleared on failure', async () => {
  const events: string[] = [];
  const authority = authorityHarness('paused', 8, events);
  const queueClient = queueHarness({
    events,
    initial: Object.fromEntries(QUEUE_NAMES.map((name) => [name, true])),
  });
  let failure: CommerceAuthorityCoordinationError | undefined;
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
      dependencies({
        authority,
        queueClient,
        wait: async () => { throw new Error('private wait failure'); },
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommerceAuthorityCoordinationError);
      failure = error;
      return true;
    },
  );
  assert.equal(authority.current.paused_at_ms, null);
  assert.equal(failure?.result.authority.paused_at_ms, null);
  assert.deepEqual(events, ['d1:read', 'queues:list', 'd1:clear', 'queues:list']);
});

test('new pause leaves readiness cleared when the post-transition drain fails', async () => {
  const events: string[] = [];
  const waits: number[] = [];
  const authority = authorityHarness('d1', 7, events);
  const queueClient = queueHarness({ events });
  let failure: CommerceAuthorityCoordinationError | undefined;
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
      dependencies({
        authority,
        queueClient,
        wait: async (durationMs) => {
          waits.push(durationMs);
          if (waits.length === 2) throw new Error('private request drain failure');
        },
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommerceAuthorityCoordinationError);
      failure = error;
      return true;
    },
  );
  assert.deepEqual(waits, [COMMERCE_IN_FLIGHT_DRAIN_WAIT_MS, COMMERCE_IN_FLIGHT_DRAIN_WAIT_MS]);
  assert.equal(authority.current.authority_state, 'paused');
  assert.equal(authority.current.paused_at_ms, null);
  assert.equal(failure?.result.authority.paused_at_ms, null);
  assert.equal(events.includes('d1:ready'), false);
});

test('resume transitions D1 before resuming Queues', async () => {
  const events: string[] = [];
  const authority = authorityHarness('paused', 7, events);
  const queueClient = queueHarness({
    events,
    initial: Object.fromEntries(QUEUE_NAMES.map((name) => [name, true])),
  });
  const state = await runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(['d1', '--expected-revision', '7', '--write']),
    dependencies({ authority, queueClient }),
  );
  assert.deepEqual(events, [
    'd1:read',
    'queues:list',
    'queues:list',
    'd1:d1',
    'd1:read',
    'queue:queue-a:false',
    'queue:queue-b:false',
    'queue:queue-c:false',
    'queues:list',
    'd1:read',
  ]);
  assert.deepEqual(state, {
    authority: authorityRow('d1', 8, 100),
    queues: QUEUE_NAMES.map((name) => ({ name, deliveryPaused: false })),
    changed: { authorityChanged: true, queuesChanged: true },
  });
});

test('resume normalizes a mixed Queue state before transitioning D1', async () => {
  const events: string[] = [];
  const authority = authorityHarness('paused', 7, events);
  const queueClient = queueHarness({ events, initial: { 'queue-b': true } });
  const state = await runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(['d1', '--expected-revision', '7', '--write']),
    dependencies({ authority, queueClient }),
  );
  assert.deepEqual(events, [
    'd1:read',
    'queues:list',
    'queue:queue-a:true',
    'queue:queue-c:true',
    'queues:list',
    'd1:d1',
    'd1:read',
    'queue:queue-a:false',
    'queue:queue-b:false',
    'queue:queue-c:false',
    'queues:list',
    'd1:read',
  ]);
  assert.equal(state.authority.authority_state, 'd1');
  assert.ok(state.queues.every((queue) => !queue.deliveryPaused));
});

test('resume normalization retains successful Queue pauses when another pause fails', async () => {
  const events: string[] = [];
  const authority = authorityHarness('paused', 7, events);
  const queueClient = queueHarness({
    events,
    failures: new Set(['queue-b:true']),
  });
  let failure: CommerceAuthorityCoordinationError | undefined;
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['d1', '--expected-revision', '7', '--write']),
      dependencies({ authority, queueClient }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommerceAuthorityCoordinationError);
      failure = error;
      return true;
    },
  );
  assert.deepEqual(failure?.result.authority, authorityRow('paused', 7));
  assert.deepEqual(failure?.result.queues, [
    { name: 'queue-a', deliveryPaused: true },
    { name: 'queue-b', deliveryPaused: false },
    { name: 'queue-c', deliveryPaused: true },
  ]);
  assert.equal(events.some((event) => event.endsWith(':false')), false);
  assert.equal(events.includes('d1:d1'), false);
});

test('resume keeps normalized Queues paused when the D1 transition is rejected', async () => {
  const events: string[] = [];
  const authority = authorityHarness('paused', 7, events, new Set(['d1']));
  const queueClient = queueHarness({ events, initial: { 'queue-b': true } });
  let failure: CommerceAuthorityCoordinationError | undefined;
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['d1', '--expected-revision', '7', '--write']),
      dependencies({ authority, queueClient }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommerceAuthorityCoordinationError);
      failure = error;
      return true;
    },
  );
  assert.equal(authority.current.authority_state, 'paused');
  assert.ok(failure?.result.queues.every((queue) => queue.deliveryPaused));
  assert.equal(events.some((event) => event.endsWith(':false')), false);
});

test('stale resume repair refuses to unpause after an opposite authority transition', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 8, events);
  let reads = 0;
  const queueClient = queueHarness({
    events,
    initial: Object.fromEntries(QUEUE_NAMES.map((name) => [name, true])),
  });
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['d1', '--expected-revision', '7', '--write']),
      {
        ...dependencies({ authority, queueClient }),
        queryCommerceD1: async (sql) => {
          if (/^\s*SELECT/.test(sql)) {
            reads += 1;
            if (reads === 2) {
              events.push('d1:read');
              return [authorityRow('paused', 9, 200)];
            }
          }
          return authority.query(sql);
        },
      },
    ),
    CommerceAuthorityCoordinationError,
  );
  assert.equal(events.some((event) => event.endsWith(':false')), false);
});

test('partial Queue resume keeps D1 active and reports every Queue still paused', async () => {
  const events: string[] = [];
  const authority = authorityHarness('paused', 7, events);
  const queueClient = queueHarness({
    events,
    initial: Object.fromEntries(QUEUE_NAMES.map((name) => [name, true])),
    failures: new Set(['queue-b:false']),
  });
  let failure: CommerceAuthorityCoordinationError | undefined;
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['d1', '--expected-revision', '7', '--write']),
      dependencies({ authority, queueClient }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommerceAuthorityCoordinationError);
      failure = error;
      return true;
    },
  );
  assert.equal(authority.current.authority_state, 'd1');
  assert.deepEqual(failure?.result.authority, authorityRow('d1', 8, 100));
  assert.deepEqual(failure?.result.queues, [
    { name: 'queue-a', deliveryPaused: false },
    { name: 'queue-b', deliveryPaused: true },
    { name: 'queue-c', deliveryPaused: false },
  ]);
  assert.deepEqual(failure?.result.changed, { authorityChanged: true, queuesChanged: true });
  assert.match(failure?.message || '', /queue-b/);
  assert.equal(events.filter((event) => event === 'd1:d1').length, 1);
});

test('partial Queue resume rechecks authority and restores pauses before reporting', async () => {
  const authority = authorityHarness('paused', 7, []);
  let reads = 0;
  const states = new Map(QUEUE_NAMES.map((name) => [name, queueState(name, true)]));
  const queueClient: CloudflareQueueMaintenanceClient = {
    async listDeliveryStates() {
      return QUEUE_NAMES.map((name) => ({ ...states.get(name)! }));
    },
    async setDeliveryPaused(queue, deliveryPaused) {
      if (queue.name === 'queue-b' && !deliveryPaused) throw new Error('resume failed');
      const updated = queueState(queue.name, deliveryPaused);
      states.set(queue.name, updated);
      return { ...updated };
    },
  };
  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    if (/^\s*SELECT/.test(sql)) {
      reads += 1;
      if (reads === 3) return [authorityRow('paused', 9, 200)];
    }
    return authority.query(sql);
  };
  let failure: CommerceAuthorityCoordinationError | undefined;
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['d1', '--expected-revision', '7', '--write']),
      {
        apiToken: 'private-api-token',
        leaseToken: () => LEASE_TOKEN,
        queryCommerceD1: query,
        queueClient,
        queueConfig: QUEUE_CONFIG,
        wait: async () => {},
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommerceAuthorityCoordinationError);
      failure = error;
      return true;
    },
  );
  assert.deepEqual(failure?.result.authority, authorityRow('paused', 9, 200));
  assert.ok(failure?.result.queues.every((queue) => queue.deliveryPaused));
  assert.ok([...states.values()].every((queue) => queue.deliveryPaused));
});

test('resume verifies read-back state even when every PATCH reports success', async () => {
  const events: string[] = [];
  const authority = authorityHarness('paused', 7, events);
  let listCount = 0;
  const queueClient: CloudflareQueueMaintenanceClient = {
    async listDeliveryStates() {
      events.push('queues:list');
      listCount += 1;
      return QUEUE_NAMES.map((name) => queueState(
        name,
        listCount < 3 || name === 'queue-b',
      ));
    },
    async setDeliveryPaused(queue, deliveryPaused) {
      events.push(`queue:${queue.name}:${deliveryPaused}`);
      return queueState(queue.name, deliveryPaused);
    },
  };
  let failure: CommerceAuthorityCoordinationError | undefined;
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['d1', '--expected-revision', '7', '--write']),
      dependencies({ authority, queueClient }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CommerceAuthorityCoordinationError);
      failure = error;
      return true;
    },
  );
  assert.equal(authority.current.authority_state, 'd1');
  assert.deepEqual(failure?.result.queues, [
    { name: 'queue-a', deliveryPaused: false },
    { name: 'queue-b', deliveryPaused: true },
    { name: 'queue-c', deliveryPaused: false },
  ]);
  assert.match(failure?.message || '', /queue-b/);
});

test('resume repairs Queue state idempotently after the authority transition completed', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 8, events);
  const queueClient = queueHarness({ events, initial: { 'queue-c': true } });
  const state = await runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(['d1', '--expected-revision', '7', '--write']),
    dependencies({ authority, queueClient }),
  );
  assert.deepEqual(events, [
    'd1:read',
    'queues:list',
    'd1:read',
    'queue:queue-c:false',
    'queues:list',
    'd1:read',
  ]);
  assert.deepEqual(state.changed, { authorityChanged: false, queuesChanged: true });
  assert.ok(state.queues.every((queue) => !queue.deliveryPaused));
});
