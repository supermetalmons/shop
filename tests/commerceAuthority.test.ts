import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
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

function authorityRow(state: 'paused' | 'd1', revision: number, updatedAtMs = 0) {
  return {
    authority_state: state,
    revision,
    documents_revision: 12,
    paused_at_ms: state === 'paused' ? updatedAtMs || 1 : null,
    updated_at_ms: updatedAtMs,
  };
}

function authorityHarness(
  initialState: 'paused' | 'd1',
  initialRevision: number,
  events: string[],
  failedTransitions: Set<'paused' | 'd1'> = new Set(),
) {
  let current = authorityRow(initialState, initialRevision);
  return {
    get current() {
      return current;
    },
    async query(sql: string): Promise<Record<string, unknown>[]> {
      if (/^\s*SELECT/.test(sql)) {
        events.push('d1:read');
        return [{ ...current }];
      }
      const target = sql.includes("SET authority_state = 'paused'") ? 'paused' : 'd1';
      events.push(`d1:${target}`);
      if (failedTransitions.has(target)) throw new Error('private D1 failure');
      const source = target === 'paused' ? 'd1' : 'paused';
      const expectedRevision = Number(sql.match(/AND revision = (\d+)/)?.[1]);
      if (current.authority_state !== source || current.revision !== expectedRevision) return [];
      const updatedAtMs = Number(sql.match(/updated_at_ms = (\d+)/)?.[1]);
      current = authorityRow(target, current.revision + 1, updatedAtMs);
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
  nowMs?: number;
  queueClient: CloudflareQueueMaintenanceClient;
}) {
  return {
    apiToken: 'private-api-token',
    nowMs: () => args.nowMs ?? 100,
    queryCommerceD1: args.authority.query,
    queueClient: args.queueClient,
    queueConfig: QUEUE_CONFIG,
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
  const sql = buildCommerceAuthorityMutationSql('d1', 7, 100);
  assert.match(sql, /authority_state = 'paused'/);
  assert.match(sql, /revision = 7/);
  assert.match(sql, /paused_at_ms = NULL/);
  assert.match(sql, /updated_at_ms = 100/);
  const pauseSql = buildCommerceAuthorityMutationSql('paused', 7, 100);
  assert.match(pauseSql, /authority_state = 'd1'/);
  assert.throws(() => parseCommerceAuthorityControlArgs(['replace', '--expected-revision', '7', '--write']));
});

test('Queue maintenance configuration preserves the producer/consumer intersection order', () => {
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
  }).queueNames, ['queue-c', 'queue-a', 'queue-b']);
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
});

test('pause changes every Queue before transitioning D1', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 7, events);
  const queueClient = queueHarness({ events });
  const state = await runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
    dependencies({ authority, queueClient }),
  );
  assert.deepEqual(events, [
    'd1:read',
    'queues:list',
    'queue:queue-a:true',
    'queue:queue-b:true',
    'queue:queue-c:true',
    'queues:list',
    'd1:paused',
    'queues:list',
    'd1:read',
  ]);
  assert.deepEqual(state, {
    authority: authorityRow('paused', 8, 100),
    queues: QUEUE_NAMES.map((name) => ({ name, deliveryPaused: true })),
    changed: { authorityChanged: true, queuesChanged: true },
  });
});

test('pause re-pauses Queues changed by a concurrent d1 repair after its pre-CAS readback', async () => {
  const events: string[] = [];
  const states = new Map(QUEUE_NAMES.map((name) => [name, queueState(name, false)]));
  let current = authorityRow('d1', 7);
  let releaseMutation = () => {};
  const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
  let releaseVerifiedPause = () => {};
  const verifiedPause = new Promise<void>((resolve) => { releaseVerifiedPause = resolve; });
  let listCount = 0;
  const queueClient: CloudflareQueueMaintenanceClient = {
    async listDeliveryStates() {
      listCount += 1;
      events.push(`queues:list:${listCount}`);
      if (listCount === 2) releaseVerifiedPause();
      return QUEUE_NAMES.map((name) => ({ ...states.get(name)! }));
    },
    async setDeliveryPaused(queue, deliveryPaused) {
      events.push(`queue:${queue.name}:${deliveryPaused}`);
      const updated = queueState(queue.name, deliveryPaused);
      states.set(queue.name, updated);
      return { ...updated };
    },
  };
  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    if (/^\s*SELECT/.test(sql)) {
      events.push(`d1:read:${current.authority_state}:${current.revision}`);
      return [{ ...current }];
    }
    events.push('d1:paused:waiting');
    await mutationGate;
    current = authorityRow('paused', 8, 100);
    events.push('d1:paused:committed');
    return [{ ...current }];
  };
  const shared = {
    apiToken: 'private-api-token',
    nowMs: () => 100,
    queryCommerceD1: query,
    queueClient,
    queueConfig: QUEUE_CONFIG,
  };
  const pause = runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(['paused', '--expected-revision', '7', '--write']),
    shared,
  );
  await verifiedPause;
  const repair = await runCommerceAuthorityControl(
    parseCommerceAuthorityControlArgs(['d1', '--expected-revision', '7', '--write']),
    shared,
  );
  events.push('d1:repair:completed');
  releaseMutation();
  const paused = await pause;
  assert.equal(repair.authority.authority_state, 'd1');
  assert.ok(repair.queues.every((queue) => !queue.deliveryPaused));
  assert.equal(paused.authority.authority_state, 'paused');
  assert.ok(paused.queues.every((queue) => queue.deliveryPaused));
  assert.ok([...states.values()].every((queue) => queue.deliveryPaused));
  assert.ok(events.indexOf('d1:repair:completed') < events.indexOf('d1:paused:committed'));
  assert.ok(events.lastIndexOf('queue:queue-c:true') > events.indexOf('d1:paused:committed'));
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
  assert.deepEqual(failure?.result.queues, QUEUE_NAMES.map((name) => ({
    name,
    deliveryPaused: false,
  })));
  assert.equal(failure?.message.includes('private-api-token'), false);
});

test('pause retains rollback errors while preserving the verified result state', async () => {
  const events: string[] = [];
  const authority = authorityHarness('d1', 7, events);
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
  assert.deepEqual(events, ['d1:read', 'queues:list', 'queue:queue-b:true', 'queues:list', 'd1:read']);
  assert.deepEqual(state.changed, { authorityChanged: false, queuesChanged: true });
  assert.ok(state.queues.every((queue) => queue.deliveryPaused));
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
  let authority = authorityRow('paused', 7);
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
      if (reads === 3) authority = authorityRow('paused', 9, 200);
      return [{ ...authority }];
    }
    authority = authorityRow('d1', 8, 100);
    return [{ ...authority }];
  };
  let failure: CommerceAuthorityCoordinationError | undefined;
  await assert.rejects(
    runCommerceAuthorityControl(
      parseCommerceAuthorityControlArgs(['d1', '--expected-revision', '7', '--write']),
      {
        apiToken: 'private-api-token',
        nowMs: () => 100,
        queryCommerceD1: query,
        queueClient,
        queueConfig: QUEUE_CONFIG,
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
