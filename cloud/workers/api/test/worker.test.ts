import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  listShopCollectionQueryRuntimes,
  listShopPendingOpenProgramScopes,
} from '../../../../shared/shopDomain.ts';
import { PENDING_OPEN_BOX_DISCRIMINATOR } from '../../../../shared/pendingOpenCodec.ts';
import { SHOP_EXPECTED_ASSET_IDS_MAX } from '../../../../shared/shopApi.ts';
import { isExactShopRpcRequest } from '../../../../shared/solanaRpcProxy.ts';
import { createNotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import {
  NOTIFICATION_ENQUEUE_PATH,
  NOTIFICATION_ENQUEUE_SIGNATURE_HEADER,
  NOTIFICATION_ENQUEUE_TIMESTAMP_HEADER,
  notificationEnqueueTimestamp,
  signNotificationEnqueueRequest,
} from '../../../../shared/notificationEnqueueAuth.ts';
import {
  handleRequest as rawHandleRequest,
  runScheduledReconciliations,
  sleepWithAbort,
  type ProviderFetch,
} from '../src/index.ts';
import { isStaffOnlyApiPath } from '../src/requestIdentity.ts';
import { createDeferredWorkCollector } from './deferredWork.ts';

type RequestDependencies = Parameters<typeof rawHandleRequest>[3];

async function handleRequest(
  request: Request,
  requestEnv: Env,
  dependencies: RequestDependencies = {},
): Promise<Response> {
  const deferred = createDeferredWorkCollector();
  const response = await rawHandleRequest(request, requestEnv, deferred.defer, dependencies);
  await deferred.drain();
  return response;
}

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const CARD_COLLECTION = 'EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu';
const SIGNATURE = bs58.encode(new Uint8Array(64).fill(1));
const TRANSACTION = Buffer.from([1, 2, 3]).toString('base64');
const allowRateLimit = { limit: async () => ({ success: true }) } satisfies RateLimit;

function rateLimiter(limit: RateLimit['limit']): RateLimit {
  return { limit };
}

function d1Database(prepare: D1Database['prepare']): D1Database {
  const database = {} as D1Database;
  database.prepare = prepare;
  return database;
}

function env(options: {
  apiKey?: string;
  commerceDb?: D1Database;
  commerceState?: 'paused' | 'd1';
  dataDb?: D1Database;
  opsDb?: D1Database;
  resendContactsApiKey?: string;
  notificationEnqueueSecret?: string;
  notificationQueue?: Queue;
  publicNotificationRateLimiter?: RateLimit;
  publicRpcReadRateLimiter?: RateLimit;
  publicRpcWriteRateLimiter?: RateLimit;
  publicShopRateLimiter?: RateLimit;
} = {}): Env {
  const notificationQueue: Queue = options.notificationQueue || {
    send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
  return {
    DATA_DB: options.dataDb || {} as D1Database,
    OPS_DB: options.opsDb || {} as D1Database,
    COMMERCE_DB: options.commerceDb || d1Database(function prepare() {
      return {
        first: async () => ({
          authority_state: options.commerceState || 'd1',
          revision: 1,
          documents_revision: 0,
        }),
      } as D1PreparedStatement;
    }),
    STAFF_AUTH_CHALLENGE_RATE_LIMITER: allowRateLimit,
    STAFF_AUTH_SESSION_RATE_LIMITER: allowRateLimit,
    ANONYMOUS_AUTH_SESSION_RATE_LIMITER: allowRateLimit,
    PUBLIC_RPC_READ_RATE_LIMITER: options.publicRpcReadRateLimiter || allowRateLimit,
    PUBLIC_RPC_WRITE_RATE_LIMITER: options.publicRpcWriteRateLimiter || allowRateLimit,
    PUBLIC_SHOP_RATE_LIMITER: options.publicShopRateLimiter || allowRateLimit,
    PUBLIC_NOTIFICATION_RATE_LIMITER: options.publicNotificationRateLimiter || allowRateLimit,
    NOTIFICATION_EMAIL_QUEUE: notificationQueue,
    REVEAL_BACKGROUND_QUEUE: notificationQueue,
    STRIPE_FULFILLMENT_QUEUE: notificationQueue,
    HELIUS_API_KEY: options.apiKey === undefined ? 'test-key' : options.apiKey,
    RESEND_API_KEY: '',
    RESEND_CONTACTS_API_KEY: options.resendContactsApiKey === undefined
      ? 'resend-test-key'
      : options.resendContactsApiKey,
    NOTIFICATION_ENQUEUE_SECRET: options.notificationEnqueueSecret === undefined
      ? 'notification-enqueue-test-secret'
      : options.notificationEnqueueSecret,
    ADDRESS_DECRYPTION_SECRET: '',
    COSIGNER_SECRET: '',
    SHIPSTATION_API_KEY: '',
    SHIPSTATION_SHIP_FROM: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_RESTRICTED_KEY: '',
    STRIPE_SECRET_KEY_LIVE: '',
    STRIPE_RESTRICTED_KEY_LIVE: '',
    STRIPE_WEBHOOK_SECRET_DEVNET: 'whsec_test_devnet',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_mainnet',
  };
}

function packStatusD1(options: {
  failure?: Error;
  metadataRow?: Record<string, unknown> | null;
  row?: Record<string, unknown> | null;
} = {}): D1Database {
  return {
    prepare(query: string) {
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async first() {
          if (options.failure) throw options.failure;
          if (query.includes('pack_status_metadata')) {
            if (Object.hasOwn(options, 'metadataRow')) return options.metadataRow;
            return { cache_generation: 7 };
          }
          if (query.includes('FROM pack_status')) {
            const dropId = String(bindings[0] || 'card_nft_2');
            return options.row === null ? null : options.row || {
              drop_id: dropId,
              version: 1,
              total_initial_supply: 10,
              total_cards: 30,
              cards_per_pack: 3,
              unsealed_online: 2,
              redeemed_irl_normal: 1,
              redeemed_irl_stripe: 2,
              redeemed_unsealed_cards: 1,
              rebuilt_at_ms: 100,
              updated_at_ms: 200,
            };
          }
          return null;
        },
      } as D1PreparedStatement;
    },
  } as D1Database;
}

function memoryPackStatusCache(): Pick<Cache, 'match' | 'put'> {
  const values = new Map<string, Response>();
  return {
    async match(request) {
      return values.get(String(request))?.clone();
    },
    async put(request, response) {
      values.set(String(request), response.clone());
    },
  };
}

test('scheduled reconciliation isolates all four subsystems and reports failures after settlement', async () => {
  const calls: string[] = [];
  const failure = new Error('ops cleanup failed');
  await assert.rejects(
    runScheduledReconciliations(env(), new AbortController().signal, {
      notifications: async () => {
        calls.push('notifications');
        return 0;
      },
      ops: async () => {
        calls.push('ops');
        throw failure;
      },
      packStatus: async () => {
        calls.push('packStatus');
        return 0;
      },
      stripe: async () => {
        calls.push('stripe');
        return { enqueued: 0, failed: 0 };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      return true;
    },
  );
  assert.deepEqual(calls.sort(), ['notifications', 'ops', 'packStatus', 'stripe']);
});

test('commerce maintenance blocks HTTP mutations and skips commerce cron work', async () => {
  const requestLogs: Record<string, unknown>[] = [];
  const response = await handleRequest(
    new Request('https://api.mons.shop/checkout/session', { method: 'POST' }),
    env({ commerceState: 'paused' }),
    { ...quietDependencies(fetch), log: (entry) => requestLogs.push(entry) },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.match(response.headers.get('Server-Timing') || '', /total;dur=/);
  assert.deepEqual(await response.json(), { ok: false, error: 'commerce-maintenance' });
  assert.equal(requestLogs.filter((entry) => entry.event === 'shop_api_request').length, 1);

  const calls: string[] = [];
  await runScheduledReconciliations(env({ commerceState: 'paused' }), new AbortController().signal, {
    notifications: async () => { calls.push('notifications'); return 0; },
    ops: async () => { calls.push('ops'); },
    packStatus: async () => { calls.push('packStatus'); return 0; },
    stripe: async () => { calls.push('stripe'); return { enqueued: 0, failed: 0 }; },
  });
  assert.deepEqual(calls, ['ops']);
});

test('request boundary distinguishes staff rejection from authentication infrastructure failure', async () => {
  const token = `mons_staff_v1.123e4567-e89b-42d3-a456-426614174000.${'A'.repeat(43)}`;
  const requestFor = () => request('/admin/profile', { wallet: OWNER }, {
    Authorization: `Bearer ${token}`,
    Origin: 'https://mons.shop',
  });
  const rejectedLogs: Record<string, unknown>[] = [];
  const rejected = await handleRequest(requestFor(), env({
    opsDb: d1Database(function prepare() {
      return { bind() { return this; }, first: async () => null } as D1PreparedStatement;
    }),
  }), { ...quietDependencies(fetch), log: (entry) => rejectedLogs.push(entry) });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json() as { error: { code: string } }).error.code, 'unauthenticated');
  assert.match(rejected.headers.get('Server-Timing') || '', /total;dur=/);
  assert.equal(rejectedLogs.filter((entry) => entry.event === 'shop_api_request').length, 1);

  const unavailableLogs: Record<string, unknown>[] = [];
  const unavailable = await handleRequest(requestFor(), env({
    opsDb: d1Database(function prepare() {
      throw new Error('D1 unavailable');
    }),
  }), { ...quietDependencies(fetch), log: (entry) => unavailableLogs.push(entry) });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    ok: false,
    error: {
      code: 'unavailable',
      message: 'Staff authentication is temporarily unavailable.',
    },
  });
  assert.equal(unavailable.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.match(unavailable.headers.get('Server-Timing') || '', /total;dur=/);
  assert.equal(unavailableLogs.filter((entry) => entry.event === 'shop_api_request').length, 1);
});

test('request boundary sanitizes unexpected failures and survives terminal log failures', async () => {
  let logAttempts = 0;
  const response = await handleRequest(request('/checkout/session', {
    dropId: 'card_nft_binder_devnet',
  }, { Origin: 'https://mons.shop' }), env({
    commerceDb: d1Database(function prepare() {
      throw new Error('sensitive database failure');
    }),
  }), {
    ...quietDependencies(fetch),
    log: () => {
      logAttempts += 1;
      throw new Error('logger failed');
    },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'unavailable', message: 'Service is temporarily unavailable.' },
  });
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.match(response.headers.get('Server-Timing') || '', /total;dur=/);
  assert.equal(logAttempts, 1);
});

test('request boundary preserves the Stripe webhook failure envelope', async () => {
  const response = await handleRequest(new Request('https://api.mons.shop/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }), env({
    commerceDb: d1Database(function prepare() {
      throw new Error('D1 unavailable');
    }),
  }), quietDependencies(fetch));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    received: true,
    error: 'Stripe webhook processing failed',
  });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.match(response.headers.get('Server-Timing') || '', /total;dur=/);
});

test('request boundary classifies abort-first dependency results as cancellation', async (context) => {
  const consoleErrors: Record<string, unknown>[] = [];
  context.mock.method(console, 'error', (entry: unknown) => {
    consoleErrors.push(entry as Record<string, unknown>);
  });

  for (const outcome of ['normalized', 'thrown'] as const) {
    const controller = new AbortController();
    const logs: Record<string, unknown>[] = [];
    let releaseDependency: (() => void) | undefined;
    let markDependencyStarted: (() => void) | undefined;
    const dependencyStarted = new Promise<void>((resolve) => {
      markDependencyStarted = resolve;
    });
    const dependencyGate = new Promise<void>((resolve) => {
      releaseDependency = resolve;
    });
    const commerceDb = d1Database(function prepare() {
      return {
        async first() {
          markDependencyStarted?.();
          await dependencyGate;
          if (outcome === 'thrown') throw new Error('dependency failed after disconnect');
          return { authority_state: 'paused', revision: 1, documents_revision: 0 };
        },
      } as D1PreparedStatement;
    });
    const incoming = new Request('https://api.mons.shop/checkout/session', {
      method: 'POST',
      signal: controller.signal,
    });
    const responsePromise = handleRequest(
      incoming,
      env({ commerceDb }),
      { ...quietDependencies(fetch), log: (entry) => logs.push(entry) },
    );
    await dependencyStarted;
    controller.abort(new Error('client disconnected'));
    releaseDependency?.();
    const response = await responsePromise;

    assert.equal(response.status, 499);
    assert.equal(await response.text(), '');
    assert.match(response.headers.get('server-timing') || '', /total;dur=/);
    const requestLog = logs.find((entry) => entry.event === 'shop_api_request');
    assert.equal(requestLog?.status, 499);
    assert.equal(requestLog?.requestCancelled, true);
  }

  assert.equal(
    consoleErrors.filter((entry) => entry.event === 'shop_api_unhandled_error').length,
    0,
  );
});

test('request boundary races the complete route and preserves its winner', async (context) => {
  const consoleErrors: Record<string, unknown>[] = [];
  context.mock.method(console, 'error', (entry: unknown) => {
    consoleErrors.push(entry as Record<string, unknown>);
  });

  const abortFirst = new AbortController();
  const abortReason = new Error('client disconnected before route completion');
  let markProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
  let releaseProvider!: () => void;
  const abortedResponse = handleRequest(
    new Request(request('/notifications/subscribe', { email: 'buyer@example.com' }), {
      signal: abortFirst.signal,
    }),
    env(),
    {
      ...quietDependencies(fetch),
      resendFetch: async () => new Promise<Response>((resolve) => {
        releaseProvider = () => resolve(Response.json({ error: 'late provider failure' }, { status: 422 }));
        markProviderStarted();
      }),
    },
  );
  await providerStarted;
  abortFirst.abort(abortReason);
  releaseProvider();
  const cancelled = await abortedResponse;
  assert.equal(cancelled.status, 499);
  assert.equal(await cancelled.text(), '');
  assert.equal(
    consoleErrors.some((entry) => entry.event === 'shop_api_unhandled_error'),
    false,
  );

  const dispatchFirst = new AbortController();
  const preserved = await handleRequest(
    new Request(request('/notifications/subscribe', { email: 'buyer@example.com' }), {
      signal: dispatchFirst.signal,
    }),
    env(),
    {
      ...quietDependencies(fetch),
      resendFetch: async () => {
        setTimeout(() => dispatchFirst.abort(new Error('late client disconnect')), 0);
        return Response.json({ error: 'provider failure' }, { status: 422 });
      },
    },
  );
  assert.equal(preserved.status, 502);
  assert.deepEqual(await preserved.json(), { ok: false, error: 'provider-unavailable' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dispatchFirst.signal.aborted, true);
});

test('request boundary keeps an aborted route alive for its cleanup', async () => {
  const controller = new AbortController();
  const deferred = createDeferredWorkCollector();
  let markProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
  let releaseProvider!: () => void;
  const responsePromise = rawHandleRequest(
    new Request(request('/notifications/subscribe', { email: 'buyer@example.com' }), {
      signal: controller.signal,
    }),
    env(),
    deferred.defer,
    {
      ...quietDependencies(fetch),
      resendFetch: async () => new Promise<Response>((resolve) => {
        releaseProvider = () => resolve(Response.json({ id: 'contact-1' }));
        markProviderStarted();
      }),
    },
  );

  await providerStarted;
  controller.abort(new Error('client disconnected'));
  const response = await responsePromise;
  assert.equal(response.status, 499);
  assert.equal(deferred.promises.length, 1);

  releaseProvider();
  await deferred.drain();
});

test('request boundary converts a successful resolved result after disconnect to 499', async () => {
  const controller = new AbortController();
  const reason = new Error('client disconnected');
  const logs: Record<string, unknown>[] = [];
  controller.abort(reason);
  const response = await handleRequest(
    new Request('https://api.mons.shop/health', { signal: controller.signal }),
    env(),
    { ...quietDependencies(fetch), log: (entry) => logs.push(entry) },
  );

  assert.equal(response.status, 499);
  assert.equal(await response.text(), '');
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  const requestLog = logs.find((entry) => entry.event === 'shop_api_request');
  assert.equal(requestLog?.status, 499);
  assert.equal(requestLog?.requestCancelled, true);
});

test('client cancellation aborts stalled inventory providers and returns 499', async (context) => {
  const controller = new AbortController();
  const reason = new Error('client disconnected');
  const logs: Record<string, unknown>[] = [];
  const consoleErrors: Record<string, unknown>[] = [];
  const providerSignals: AbortSignal[] = [];
  let markProviderStarted: (() => void) | undefined;
  const providerStarted = new Promise<void>((resolve) => {
    markProviderStarted = resolve;
  });
  context.mock.method(console, 'error', (entry: unknown) => {
    consoleErrors.push(entry as Record<string, unknown>);
  });
  const stalledProvider: ProviderFetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    providerSignals.push(signal);
    markProviderStarted?.();
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  };
  const incoming = new Request(request('/inventory'), { signal: controller.signal });
  const responsePromise = handleRequest(incoming, env(), {
    ...quietDependencies(stalledProvider),
    log: (entry) => logs.push(entry),
    providerAttemptTimeoutMs: 250,
    providerTimeoutMs: 250,
  });

  await providerStarted;
  controller.abort(reason);
  const response = await responsePromise;

  assert.ok(providerSignals.length > 0);
  assert.equal(providerSignals.every((signal) => signal.aborted), true);
  assert.equal(providerSignals.every((signal) => signal.reason === reason), true);
  assert.equal(response.status, 499);
  assert.equal(await response.text(), '');
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  const requestLog = logs.find((entry) => entry.event === 'shop_api_request');
  assert.equal(requestLog?.status, 499);
  assert.equal(requestLog?.requestCancelled, true);
  assert.equal(
    consoleErrors.some((entry) => entry.event === 'shop_api_unhandled_error'),
    false,
  );
});

test('client abort wins when it precedes an RPC transport failure', async () => {
  const controller = new AbortController();
  const reason = new Error('client disconnected');
  const providerFailure = new Error('provider failed first');
  const provider: ProviderFetch = async () => {
    controller.abort(reason);
    throw providerFailure;
  };
  const response = await handleRequest(
    new Request(rpcRequest(
      '/rpc/mainnet-beta',
      rpcBody('sendTransaction', [TRANSACTION, {
        encoding: 'base64',
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      }], 'race'),
    ), { signal: controller.signal }),
    env(),
    quietDependencies(provider),
  );

  assert.equal(response.status, 499);
  assert.equal(await response.text(), '');
});

test('a settled Helius HTTP failure remains definitive after a later client abort', async () => {
  const controller = new AbortController();
  const reason = new Error('late client disconnect');
  let cancelledBodies = 0;
  const provider: ProviderFetch = async () => new Response(new ReadableStream<Uint8Array>({
    cancel() {
      cancelledBodies += 1;
    },
  }), { status: 400 });
  const response = await handleRequest(
    new Request(request('/inventory'), { signal: controller.signal }),
    env(),
    quietDependencies(provider),
  );

  assert.ok(cancelledBodies > 0);
  controller.abort(reason);
  assert.equal(controller.signal.reason, reason);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: 'provider-unavailable' });
});

test('a server deadline that wins before a client abort remains 504', async () => {
  const controller = new AbortController();
  const provider: ProviderFetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => {
        const reason = signal.reason;
        reject(reason);
        setTimeout(() => controller.abort(new Error('late client disconnect')), 0);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  };
  const response = await handleRequest(
    new Request(request('/inventory'), { signal: controller.signal }),
    env(),
    {
      ...quietDependencies(provider),
      providerAttemptTimeoutMs: 250,
      providerTimeoutMs: 5,
    },
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { ok: false, error: 'provider-timeout' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controller.signal.aborted, true);
});

const NOTIFICATION_JOB = createNotificationEmailJobV1({
  jobId: '123e4567-e89b-42d3-a456-426614174000',
  kind: 'buyer_order_received',
  idempotencyKey: 'card_nft_2:123:order_received',
  recipients: ['buyer@example.com'],
  subject: 'Subject',
  text: 'Text',
  html: '<p>HTML</p>',
  context: { dropId: 'card_nft_2', deliveryId: 123 },
});

async function notificationEnqueueRequest(
  body: unknown = NOTIFICATION_JOB,
  secret = 'notification-enqueue-test-secret',
  timestamp = notificationEnqueueTimestamp(),
): Promise<Request> {
  const requestBody = JSON.stringify(body);
  return new Request(`https://api.mons.shop${NOTIFICATION_ENQUEUE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [NOTIFICATION_ENQUEUE_TIMESTAMP_HEADER]: timestamp,
      [NOTIFICATION_ENQUEUE_SIGNATURE_HEADER]: await signNotificationEnqueueRequest({
        secret,
        timestamp,
        body: requestBody,
      }),
    },
    body: requestBody,
  });
}

function request(pathname: string, body: unknown = { owner: OWNER }, headers: Record<string, string> = {}): Request {
  const publicOrigin: Record<string, string> = pathname === '/inventory' ||
    pathname === '/pending-open-boxes' ||
    pathname === '/notifications/subscribe'
    ? { Origin: 'https://mons.shop' }
    : {};
  return new Request(`https://api.mons.shop${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.8',
      ...publicOrigin,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function rpcRequest(
  pathname: '/rpc/mainnet-beta' | '/rpc/devnet',
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return request(pathname, body, { Origin: 'https://mons.shop', ...headers });
}

function rpcBody(method: string, params: unknown[], id: string | number = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

function rpcResult(id: string | number, result: unknown, init?: ResponseInit): Response {
  return Response.json({ jsonrpc: '2.0', id, result }, init);
}

function rpcError(id: string | number, code: number, message: string, init?: ResponseInit): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, init);
}

function rpcCursorSearchResult(
  body: any,
  items: unknown[],
  pagination: { cursor?: string; limit?: number; total?: number; grandTotal?: number } = {},
): Response {
  const requestedCursor = body.params?.cursor;
  const pageItems = requestedCursor ? [] : items;
  const cursor = pageItems.length
    ? pagination.cursor ?? `cursor-${body.params?.grouping?.[1] || 'wallet'}`
    : undefined;
  return rpcResult(body.id, {
    limit: pagination.limit ?? body.params?.limit ?? 250,
    total: pagination.total ?? items.length,
    ...(pagination.grandTotal === undefined ? {} : { grand_total: pagination.grandTotal }),
    ...(cursor ? { cursor } : {}),
    items: pageItems,
  });
}

function quietDependencies(providerFetch: ProviderFetch) {
  return {
    providerFetch,
    randomUint32: () => 0,
    sleep: async () => undefined,
    log: () => undefined,
  };
}

function cardAsset(id: string, packId: number) {
  return {
    id: assetId(id),
    interface: 'MplCoreAsset',
    burnt: false,
    grouping: [{ group_key: 'collection', group_value: CARD_COLLECTION }],
    content: {
      json_uri: `https://cdn.lil.org/nft/card_nft_2/json/b${packId}.json`,
      metadata: {
        name: `pack ${packId}`,
        attributes: [{ trait_type: 'serial', value: packId }],
      },
      links: { image: `https://cdn.lil.org/nft/card_nft_2/images/b${packId}.webp` },
    },
  };
}

function unknownAsset(id: string, collection: string) {
  return {
    id: assetId(id),
    interface: 'MplCoreAsset',
    burnt: false,
    grouping: [{ group_key: 'collection', group_value: collection }],
    content: { metadata: { name: id } },
  };
}

function assetId(label: string): string {
  try {
    if (bs58.decode(label).length === 32) return label;
  } catch {}
  const bytes = new Uint8Array(32);
  for (let index = 0; index < label.length; index += 1) {
    bytes[index % bytes.length] = (bytes[index % bytes.length] + label.charCodeAt(index) + index) & 0xff;
  }
  bytes[31] ||= 1;
  return bs58.encode(bytes);
}

test('health, routing, methods, CORS, and no-store headers are stable', async () => {
  const health = await handleRequest(new Request('https://api.mons.shop/health'), env(), quietDependencies(fetch));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.match(health.headers.get('cache-control') || '', /no-store/);
  assert.match(health.headers.get('server-timing') || '', /total;dur=/);

  const cors = await handleRequest(new Request('https://api.mons.shop/inventory', {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(cors.status, 204);
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(cors.headers.get('vary'), 'Origin');
  assert.match(cors.headers.get('cache-control') || '', /no-store/);

  const notificationCors = await handleRequest(new Request('https://api.mons.shop/notifications/subscribe', {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(notificationCors.status, 204);
  assert.equal(notificationCors.headers.get('access-control-allow-origin'), 'https://mons.shop');

  const notificationMethod = await handleRequest(new Request('https://api.mons.shop/notifications/subscribe', {
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(notificationMethod.status, 405);
  assert.equal(notificationMethod.headers.get('allow'), 'POST, OPTIONS');

  const method = await handleRequest(new Request('https://api.mons.shop/inventory', {
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(method.status, 405);
  assert.deepEqual(await method.json(), { ok: false, error: 'method-not-allowed' });

  const missing = await handleRequest(new Request('https://api.mons.shop/missing'), env(), quietDependencies(fetch));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { ok: false, error: 'not-found' });

  const logs: Record<string, unknown>[] = [];
  await handleRequest(new Request(`https://api.mons.shop/${OWNER}`), env(), {
    ...quietDependencies(fetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(logs[0]?.route, 'not-found');
  assert.equal(JSON.stringify(logs).includes(OWNER), false);
});

test('profile routes enforce restricted CORS, bearer authentication, and stable route logs', async () => {
  const allowedPreflight = await handleRequest(new Request('https://api.mons.shop/profile/state', {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(allowedPreflight.status, 204);
  assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(allowedPreflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');
  assert.equal(allowedPreflight.headers.get('access-control-expose-headers'), 'X-Mons-Checkout-Retry');
  assert.equal(allowedPreflight.headers.get('vary'), 'Origin');

  const deniedPreflight = await handleRequest(new Request('https://api.mons.shop/admin/profile', {
    method: 'OPTIONS',
    headers: { Origin: 'https://untrusted.example' },
  }), env(), quietDependencies(fetch));
  assert.equal(deniedPreflight.status, 403);
  assert.equal((await deniedPreflight.json() as { error: { code: string } }).error.code, 'permission-denied');

  for (const pathname of ['/admin/profile', '/fulfillment/orders']) {
    const staffPreflight = await handleRequest(new Request(`https://api.mons.shop${pathname}`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://mons.shop' },
    }), env(), quietDependencies(fetch));
    assert.equal(staffPreflight.status, 204);
    assert.equal(staffPreflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
  }

  const logs: Record<string, unknown>[] = [];
  const unauthenticated = await handleRequest(request('/profile/state', {}, {
    Origin: 'https://mons.shop',
  }), env(), { ...quietDependencies(fetch), log: (entry) => logs.push(entry) });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json() as { error: { code: string } }).error.code, 'unauthenticated');
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(logs[0]?.route, '/profile/state');
  assert.equal(logs[0]?.profileAuthOutcome, 'rejected');
  assert.equal(JSON.stringify(logs).includes('anonymous'), false);

  const authPreflight = await handleRequest(new Request('https://api.mons.shop/auth/solana', {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(authPreflight.status, 204);
  assert.equal(authPreflight.headers.get('access-control-allow-origin'), 'https://mons.shop');

  const missingAuthOrigin = await handleRequest(request('/auth/solana', {
    wallet: OWNER,
    message: 'message',
    signature: Array(64).fill(0),
  }), env(), quietDependencies(fetch));
  assert.equal(missingAuthOrigin.status, 403);

  const lifecycleLogs: Record<string, unknown>[] = [];
  const unauthenticatedReconcile = await handleRequest(request('/profile/reconcile', {}, {
    Origin: 'https://mons.shop',
  }), env(), { ...quietDependencies(fetch), log: (entry) => lifecycleLogs.push(entry) });
  assert.equal(unauthenticatedReconcile.status, 401);
  assert.equal((await unauthenticatedReconcile.json() as { error: { code: string } }).error.code, 'unauthenticated');
  assert.equal(lifecycleLogs[0]?.route, '/profile/reconcile');
  assert.equal(lifecycleLogs[0]?.profileAuthOutcome, 'rejected');

  let upstreamCalls = 0;
  const deniedOrigin = await handleRequest(request('/profile/shipments', { ownerWallet: OWNER }, {
    Authorization: 'Bearer private-token',
    Origin: 'https://untrusted.example',
  }), env(), {
    ...quietDependencies(async () => {
      upstreamCalls += 1;
      return Response.json({});
    }),
  });
  assert.equal(deniedOrigin.status, 403);
  assert.equal(upstreamCalls, 0);
  assert.equal(JSON.stringify(await deniedOrigin.json()).includes('private-token'), false);
});

test('staff-only path policy covers current and future admin and fulfillment routes', async () => {
  for (const pathname of [
    '/admin/profile',
    '/admin/irl-redeem/prepare',
    '/admin/future',
    '/fulfillment/orders',
    '/fulfillment/order-status',
    '/fulfillment/future',
  ]) assert.equal(isStaffOnlyApiPath(pathname), true, pathname);
  for (const pathname of ['/admin', '/fulfillment', '/profile/state', '/staff/auth/session']) {
    assert.equal(isStaffOnlyApiPath(pathname), false, pathname);
  }
  const future = await handleRequest(request('/admin/future', {}, {
    Authorization: 'Bearer auth-token',
    Origin: 'https://mons.shop',
  }), env(), quietDependencies(fetch));
  assert.equal(future.status, 401);
  assert.equal((await future.json() as { error: { code: string } }).error.code, 'unauthenticated');
});

test('staff auth preflight accepts only dedicated staff origins', async () => {
  const denied = await handleRequest(new Request('https://api.mons.shop/staff/auth/challenge', {
    method: 'OPTIONS',
    headers: { Origin: 'https://deadbeef-mons-shop.lil-org.workers.dev' },
  }), env(), quietDependencies(fetch));
  assert.equal(denied.status, 403);

  const candidateOrigin = 'https://candidate-mons-shop.lil-org.workers.dev';
  const allowed = await handleRequest(new Request('https://api.mons.shop/staff/auth/challenge', {
    method: 'OPTIONS',
    headers: { Origin: candidateOrigin },
  }), env(), quietDependencies(fetch));
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), candidateOrigin);
});

test('checkout route enforces restricted CORS, bearer authentication, methods, and stable logging', async () => {
  const logs: Record<string, unknown>[] = [];
  const allowedPreflight = await handleRequest(new Request('https://api.mons.shop/checkout/session', {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), {
    ...quietDependencies(fetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(allowedPreflight.status, 204);
  assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(allowedPreflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');
  assert.equal(allowedPreflight.headers.get('access-control-expose-headers'), 'X-Mons-Checkout-Retry');

  const deniedPreflight = await handleRequest(new Request('https://api.mons.shop/checkout/session', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example' },
  }), env(), quietDependencies(fetch));
  assert.equal(deniedPreflight.status, 403);

  const unauthenticated = await handleRequest(request('/checkout/session', {
    dropId: 'card_nft_binder_devnet',
  }, { Origin: 'https://mons.shop' }), env(), {
    ...quietDependencies(fetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), {
    ok: false,
    error: { code: 'unauthenticated', message: 'Authentication is required.' },
  });
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), 'https://mons.shop');

  const wrongMethod = await handleRequest(new Request('https://api.mons.shop/checkout/session', {
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST, OPTIONS');
  assert.ok(logs.some((entry) =>
    entry.event === 'shop_api_request' &&
    entry.route === '/checkout/session' &&
    entry.profileAuthOutcome === 'rejected'));
});

test('IRL claim route enforces restricted CORS, bearer authentication, methods, and stable logging', async () => {
  const preflight = await handleRequest(new Request('https://api.mons.shop/claims/irl/prepare', {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');

  const logs: Record<string, unknown>[] = [];
  const unauthenticated = await handleRequest(request('/claims/irl/prepare', {
    owner: OWNER,
    code: '0000000000',
  }, { Origin: 'https://mons.shop' }), env(), {
    ...quietDependencies(fetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json() as { error: { code: string } }).error.code, 'unauthenticated');
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(logs[0]?.route, '/claims/irl/prepare');
  assert.equal(logs[0]?.profileAuthOutcome, 'rejected');
  assert.equal(JSON.stringify(logs).includes('0000000000'), false);

  const denied = await handleRequest(request('/claims/irl/prepare', {
    owner: OWNER,
    code: '0000000000',
  }, { Origin: 'https://evil.example' }), env(), quietDependencies(fetch));
  assert.equal(denied.status, 403);

  const wrongMethod = await handleRequest(new Request('https://api.mons.shop/claims/irl/prepare', {
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST, OPTIONS');
});

test('Stripe receipt claim route enforces restricted CORS, bearer authentication, methods, and safe logging', async () => {
  const pathname = '/receipts/stripe/claim';
  const code = 'ABCDEF-1234567890';
  const preflight = await handleRequest(new Request(`https://api.mons.shop${pathname}`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');

  const logs: Record<string, unknown>[] = [];
  const unauthenticated = await handleRequest(request(pathname, {
    code,
    recipient: OWNER,
  }, { Origin: 'https://mons.shop' }), env(), {
    ...quietDependencies(fetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json() as { error: { code: string } }).error.code, 'unauthenticated');
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(logs[0]?.route, pathname);
  assert.equal(logs[0]?.profileAuthOutcome, 'rejected');
  assert.equal(logs[0]?.stripeReceiptClaimOutcome, 'unauthenticated');
  assert.equal(JSON.stringify(logs).includes(code), false);
  assert.equal(JSON.stringify(logs).includes(OWNER), false);

  const denied = await handleRequest(request(pathname, {
    code,
    recipient: OWNER,
  }, { Origin: 'https://evil.example' }), env(), quietDependencies(fetch));
  assert.equal(denied.status, 403);

  const wrongMethod = await handleRequest(new Request(`https://api.mons.shop${pathname}`, {
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST, OPTIONS');
});

test('receipt transfer route enforces restricted CORS, bearer authentication, methods, and stable logging', async () => {
  const preflight = await handleRequest(new Request('https://api.mons.shop/receipts/transfer/prepare', {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');

  const logs: Record<string, unknown>[] = [];
  const unauthenticated = await handleRequest(request('/receipts/transfer/prepare', {
    owner: OWNER,
    dropId: 'card_nft_2',
    receiptAssetId: OWNER,
    destination: '11111111111111111111111111111112',
  }, { Origin: 'https://mons.shop' }), env(), {
    ...quietDependencies(fetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json() as { error: { code: string } }).error.code, 'unauthenticated');
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(logs[0]?.route, '/receipts/transfer/prepare');
  assert.equal(logs[0]?.profileAuthOutcome, 'rejected');
  assert.equal(JSON.stringify(logs).includes(OWNER), false);

  const denied = await handleRequest(request('/receipts/transfer/prepare', {
    owner: OWNER,
    dropId: 'card_nft_2',
    receiptAssetId: OWNER,
    destination: '11111111111111111111111111111112',
  }, { Origin: 'https://evil.example' }), env(), quietDependencies(fetch));
  assert.equal(denied.status, 403);

  const wrongMethod = await handleRequest(new Request('https://api.mons.shop/receipts/transfer/prepare', {
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST, OPTIONS');
});

test('delivery preparation route enforces restricted CORS, bearer authentication, methods, and stable logging', async () => {
  const pathname = '/delivery/prepare';
  const body = {
    owner: OWNER,
    dropId: 'card_nft_2',
    itemIds: [CARD_COLLECTION],
    addressId: 'AbCdEfGhIjKlMnOpQrSt',
  };
  const preflight = await handleRequest(new Request(`https://api.mons.shop${pathname}`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');

  const logs: Record<string, unknown>[] = [];
  const unauthenticated = await handleRequest(request(pathname, body, {
    Origin: 'https://mons.shop',
  }), env(), {
    ...quietDependencies(fetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json() as { error: { code: string } }).error.code, 'unauthenticated');
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(logs[0]?.route, pathname);
  assert.equal(logs[0]?.profileAuthOutcome, 'rejected');
  assert.equal(JSON.stringify(logs).includes(OWNER), false);
  assert.equal(JSON.stringify(logs).includes(CARD_COLLECTION), false);

  const denied = await handleRequest(request(pathname, body, {
    Origin: 'https://evil.example',
  }), env(), quietDependencies(fetch));
  assert.equal(denied.status, 403);

  const wrongMethod = await handleRequest(new Request(`https://api.mons.shop${pathname}`, {
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST, OPTIONS');
});

test('Admin IRL preparation route enforces restricted CORS, bearer authentication, methods, and stable logging', async () => {
  const pathname = '/admin/irl-redeem/prepare';
  const body = {
    owner: OWNER,
    dropId: 'card_nft_2',
    itemIds: [CARD_COLLECTION],
  };
  const preflight = await handleRequest(new Request(`https://api.mons.shop${pathname}`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');

  const logs: Record<string, unknown>[] = [];
  const unauthenticated = await handleRequest(request(pathname, body, {
    Origin: 'https://mons.shop',
  }), env(), {
    ...quietDependencies(fetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json() as { error: { code: string } }).error.code, 'unauthenticated');
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(logs[0]?.route, pathname);
  assert.equal(logs[0]?.profileAuthOutcome, 'rejected');
  assert.equal(logs[0]?.adminIrlRedeemPrepareDropId, undefined);
  assert.equal(logs[0]?.adminIrlRedeemPrepareItemCount, undefined);
  assert.equal(JSON.stringify(logs).includes(OWNER), false);
  assert.equal(JSON.stringify(logs).includes(CARD_COLLECTION), false);

  const denied = await handleRequest(request(pathname, body, {
    Origin: 'https://evil.example',
  }), env(), quietDependencies(fetch));
  assert.equal(denied.status, 403);

  const wrongMethod = await handleRequest(new Request(`https://api.mons.shop${pathname}`, {
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(wrongMethod.status, 401);
  assert.equal(wrongMethod.headers.get('allow'), null);
});

test('Admin IRL finalization route enforces restricted CORS, bearer authentication, methods, and safe logging', async () => {
  const pathname = '/admin/irl-redeem/finalize';
  const body = {
    requestId: 'AbCdEfGhIjKlMnOpQrSt',
    dropId: 'card_nft_2',
    transferSignature: '1'.repeat(64),
  };
  const preflight = await handleRequest(new Request(`https://api.mons.shop${pathname}`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');

  const logs: Record<string, unknown>[] = [];
  const unauthenticated = await handleRequest(request(pathname, body, {
    Origin: 'https://mons.shop',
  }), env(), {
    ...quietDependencies(fetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json() as { error: { code: string } }).error.code, 'unauthenticated');
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(logs[0]?.route, pathname);
  assert.equal(logs[0]?.profileAuthOutcome, 'rejected');
  assert.equal(logs[0]?.adminIrlRedeemFinalizeDropId, undefined);
  assert.equal(logs[0]?.adminIrlRedeemFinalizeOutcome, undefined);
  assert.equal(JSON.stringify(logs).includes(body.requestId), false);
  assert.equal(JSON.stringify(logs).includes(body.transferSignature), false);

  const denied = await handleRequest(request(pathname, body, {
    Origin: 'https://evil.example',
  }), env(), quietDependencies(fetch));
  assert.equal(denied.status, 403);

  const wrongMethod = await handleRequest(new Request(`https://api.mons.shop${pathname}`, {
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(wrongMethod.status, 401);
  assert.equal(wrongMethod.headers.get('allow'), null);
});

test('reveal route enforces restricted CORS, bearer authentication, methods, and stable logging', async () => {
  const pathname = '/boxes/reveal';
  const body = {
    owner: OWNER,
    boxAssetId: CARD_COLLECTION,
    dropId: 'clear_cards_devnet_v2',
  };
  const preflight = await handleRequest(new Request(`https://api.mons.shop${pathname}`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');

  const logs: Record<string, unknown>[] = [];
  const unauthenticated = await handleRequest(request(pathname, body, {
    Origin: 'https://mons.shop',
  }), env(), {
    ...quietDependencies(fetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json() as { error: { code: string } }).error.code, 'unauthenticated');
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(logs[0]?.route, pathname);
  assert.equal(logs[0]?.profileAuthOutcome, 'rejected');
  assert.equal(logs[0]?.revealDropId, 'clear_cards_devnet_v2');
  assert.equal(logs[0]?.revealBoxAssetId, CARD_COLLECTION);
  assert.equal(JSON.stringify(logs).includes('auth-token'), false);

  const denied = await handleRequest(request(pathname, body, {
    Origin: 'https://evil.example',
  }), env(), quietDependencies(fetch));
  assert.equal(denied.status, 403);

  const wrongMethod = await handleRequest(new Request(`https://api.mons.shop${pathname}`, {
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST, OPTIONS');
});

test('profile write routes use restricted CORS, bearer authentication, and stable route logs', async () => {
  const preflight = await handleRequest(new Request('https://api.mons.shop/profile/addresses', {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(fetch));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');

  const logs: Record<string, unknown>[] = [];
  const unauthenticated = await handleRequest(request('/profile/addresses', {
    encrypted: 'cipher',
    country: 'US',
    hint: 'hint',
  }, { Origin: 'https://mons.shop' }), env(), {
    ...quietDependencies(fetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json() as { error: { code: string } }).error.code, 'unauthenticated');
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal(logs[0]?.route, '/profile/addresses');
  assert.equal(logs[0]?.profileAuthOutcome, 'rejected');

  for (const [pathname, body] of [
    ['/fulfillment/order-address', { dropId: 'card_nft_2', deliveryId: 7, full: 'address' }],
    ['/fulfillment/shipstation-label', { dropId: 'card_nft_2', deliveryId: 7 }],
    ['/fulfillment/shipstation-label-purchase', {
      dropId: 'card_nft_2',
      deliveryId: 7,
      rateId: 'rate-1',
      expectedTotal: { currency: 'usd', amount: 12 },
      requestId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    }],
    ['/fulfillment/shipstation-label-void', {
      dropId: 'card_nft_2',
      deliveryId: 7,
      labelId: 'se-label',
    }],
    ['/fulfillment/shipstation-rates', { dropId: 'card_nft_2', deliveryId: 7 }],
    ['/fulfillment/shipstation-shipment', { dropId: 'card_nft_2', deliveryId: 7 }],
  ] as const) {
    const routeLogs: Record<string, unknown>[] = [];
    const response = await handleRequest(request(pathname, body, { Origin: 'https://mons.shop' }), env(), {
      ...quietDependencies(fetch),
      log: (entry) => routeLogs.push(entry),
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://mons.shop');
    assert.equal(routeLogs[0]?.route, pathname);
    assert.equal(routeLogs[0]?.profileAuthOutcome, 'rejected');
  }

  const method = await handleRequest(new Request('https://api.mons.shop/fulfillment/order-status'), env(), quietDependencies(fetch));
  assert.equal(method.status, 401);
  assert.equal(method.headers.get('allow'), null);
  assert.equal((await method.json() as { error: { code: string } }).error.code, 'unauthenticated');
});

test('pack-status route reads every supported drop from D1 only', async () => {
  for (const [dropId, cardsPerPack] of [
    ['card_nft_2', 3],
    ['poncho_drifella', 1],
    ['little_swag_boxes', 3],
  ] as const) {
    const logs: Record<string, unknown>[] = [];
    let providerCalls = 0;
    const response = await handleRequest(
      new Request(`https://api.mons.shop/pack-status/${dropId}`),
      env({ dataDb: packStatusD1({
        row: {
          drop_id: dropId,
          version: 1,
          total_initial_supply: 10,
          total_cards: 10 * cardsPerPack,
          cards_per_pack: cardsPerPack,
          unsealed_online: 2,
          redeemed_irl_normal: 1,
          redeemed_irl_stripe: 2,
          redeemed_unsealed_cards: 1,
          rebuilt_at_ms: 100,
          updated_at_ms: 200,
        },
      }) }),
      {
        ...quietDependencies(async () => {
          providerCalls += 1;
          throw new Error('pack-status must not call a provider');
        }),
        log: (entry) => logs.push(entry),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-mons-pack-status-source'), null);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    assert.match(response.headers.get('server-timing') || '', /provider;dur=/);
    const payload = await response.json() as { ok: boolean; packStatus: { dropId: string; cardsPerPack: number } };
    assert.equal(payload.ok, true);
    assert.equal(payload.packStatus.dropId, dropId);
    assert.equal(payload.packStatus.cardsPerPack, cardsPerPack);
    assert.equal(providerCalls, 0);
    assert.equal(logs[0]?.route, '/pack-status/:dropId');
    assert.equal(logs[0]?.dropId, dropId);
    assert.equal(logs[0]?.providerCacheStatus, 'D1-MISS');
    assert.equal(logs[0]?.upstreamCalls, 0);
  }
});

test('pack-status route reads and internally caches D1 while preserving the response contract', async () => {
  const dataDb = packStatusD1();
  const cache = memoryPackStatusCache();
  const logs: Record<string, unknown>[] = [];
  const dependencies = {
    ...quietDependencies(fetch),
    cache,
    log: (entry: Record<string, unknown>) => logs.push(entry),
  };
  const first = await handleRequest(
    new Request('https://api.mons.shop/pack-status/card_nft_2'),
    env({ dataDb }),
    dependencies,
  );
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-mons-pack-status-source'), null);
  assert.deepEqual(await first.json(), {
    ok: true,
    packStatus: {
      dropId: 'card_nft_2',
      total: 30,
      totalInitialSupply: 10,
      totalCards: 30,
      cardsPerPack: 3,
      unsealedOnline: 2,
      unsealedCards: 6,
      redeemedIrl: 3,
      redeemedIrlNormal: 1,
      redeemedIrlStripe: 2,
      redeemedUnsealedCards: 1,
      redeemedCards: 10,
      items: [
        { key: 'unsealed', label: 'Unpacked', amount: 6, percentage: 20 },
        { key: 'redeemed', label: 'Redeemed', amount: 10, percentage: 33.33 },
        { key: 'total', label: 'Total', amount: 30, percentage: 100 },
      ],
    },
  });
  assert.equal(Object.hasOwn(logs.at(-1) || {}, 'packStatusSource'), false);
  assert.equal(logs.at(-1)?.providerCacheStatus, 'D1-MISS');
  assert.equal(logs.at(-1)?.upstreamCalls, 0);
  const second = await handleRequest(
    new Request('https://api.mons.shop/pack-status/card_nft_2'),
    env({ dataDb }),
    dependencies,
  );
  assert.equal(second.status, 200);
  assert.equal(logs.at(-1)?.providerCacheStatus, 'D1-HIT');
});

test('request boundary defers a pack-status cache write without delaying the response', async () => {
  let resolveCacheWrite!: () => void;
  const cacheWrite = new Promise<void>((resolve) => {
    resolveCacheWrite = resolve;
  });
  let guardedCacheWrite: Promise<unknown> | undefined;
  const catchCacheWrite = cacheWrite.catch.bind(cacheWrite);
  Object.defineProperty(cacheWrite, 'catch', {
    value: (onRejected: (reason: unknown) => unknown) => {
      guardedCacheWrite = catchCacheWrite(onRejected);
      return guardedCacheWrite;
    },
  });
  const deferred = createDeferredWorkCollector();
  const responsePromise = rawHandleRequest(
    new Request('https://api.mons.shop/pack-status/card_nft_2'),
    env({ dataDb: packStatusD1() }),
    deferred.defer,
    {
      ...quietDependencies(fetch),
      cache: {
        match: async () => undefined,
        put: () => cacheWrite,
      },
    },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      responsePromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Response waited for deferred cache work')), 1_000);
      }),
    ]);
    assert.equal(response.status, 200);
    assert.equal(deferred.promises.length, 1);
    const deferredPromise = deferred.promises[0];
    assert.equal(deferredPromise, guardedCacheWrite);
    let settled = false;
    void deferredPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    resolveCacheWrite();
    await deferred.drain();
    assert.equal(settled, true);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    resolveCacheWrite();
  }
});

test('request boundary maps pack-status deferral registration failures to the route envelope', async (context) => {
  const cause = new Error('waitUntil rejected pack-status work');
  const errors: Record<string, unknown>[] = [];
  context.mock.method(console, 'error', (entry: unknown) => {
    errors.push(entry as Record<string, unknown>);
  });
  const response = await rawHandleRequest(
    new Request('https://api.mons.shop/pack-status/card_nft_2'),
    env({ dataDb: packStatusD1() }),
    () => { throw cause; },
    {
      ...quietDependencies(fetch),
      cache: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'provider-unavailable' });
  assert.deepEqual(errors.find((entry) => entry.event === 'shop_api_unhandled_error')?.error, {
    name: 'DeferredWorkRegistrationError',
    cause: { name: 'Error', message: cause.message },
  });
});

test('early route exits retain matched-route log fields', async () => {
  for (const request of [
    new Request('https://api.mons.shop/inventory', {
      method: 'OPTIONS',
      headers: { Origin: 'https://mons.shop' },
    }),
    new Request('https://api.mons.shop/inventory', {
      headers: { Origin: 'https://mons.shop' },
    }),
  ]) {
    const logs: Record<string, unknown>[] = [];
    await handleRequest(request, env(), {
      ...quietDependencies(fetch),
      log: (entry) => logs.push(entry),
    });
    assert.deepEqual({
      expectedAssetIds: logs[0]?.expectedAssetIds,
      expectedAssetRecoveryFailures: logs[0]?.expectedAssetRecoveryFailures,
      expectedAssetResolved: logs[0]?.expectedAssetResolved,
    }, {
      expectedAssetIds: 0,
      expectedAssetRecoveryFailures: 0,
      expectedAssetResolved: 0,
    });
  }

  for (const request of [
    new Request('https://api.mons.shop/pack-status/card_nft_2', { method: 'OPTIONS' }),
    new Request('https://api.mons.shop/pack-status/card_nft_2', { method: 'POST' }),
  ]) {
    const logs: Record<string, unknown>[] = [];
    await handleRequest(request, env(), {
      ...quietDependencies(fetch),
      log: (entry) => logs.push(entry),
    });
    assert.equal(logs[0]?.dropId, 'card_nft_2');
  }
});

test('pack-status route rejects malformed cache entries and refreshes them from D1', async () => {
  for (const [label, cachedResponse] of [
    ['invalid JSON', () => new Response('{')],
    ['invalid data', () => Response.json({ dropId: 'card_nft_2', total: 999 })],
  ] as const) {
    let cacheWrites = 0;
    let providerCalls = 0;
    const logs: Record<string, unknown>[] = [];
    const response = await handleRequest(
      new Request('https://api.mons.shop/pack-status/card_nft_2'),
      env({ dataDb: packStatusD1() }),
      {
        ...quietDependencies(async () => {
          providerCalls += 1;
          throw new Error('pack-status must not call Commerce or another provider');
        }),
        cache: {
          match: async () => cachedResponse(),
          put: async () => { cacheWrites += 1; },
        },
        log: (entry) => logs.push(entry),
      },
    );
    assert.equal(response.status, 200, label);
    assert.equal(response.headers.get('x-mons-pack-status-source'), null, label);
    const payload = await response.json() as { packStatus: { dropId: string; total: number } };
    assert.deepEqual(payload.packStatus, {
      dropId: 'card_nft_2',
      total: 30,
      totalInitialSupply: 10,
      totalCards: 30,
      cardsPerPack: 3,
      unsealedOnline: 2,
      unsealedCards: 6,
      redeemedIrl: 3,
      redeemedIrlNormal: 1,
      redeemedIrlStripe: 2,
      redeemedUnsealedCards: 1,
      redeemedCards: 10,
      items: [
        { key: 'unsealed', label: 'Unpacked', amount: 6, percentage: 20 },
        { key: 'redeemed', label: 'Redeemed', amount: 10, percentage: 33.33 },
        { key: 'total', label: 'Total', amount: 30, percentage: 100 },
      ],
    }, label);
    assert.equal(cacheWrites, 1, label);
    assert.equal(providerCalls, 0, label);
    assert.equal(logs.some((entry) => entry.event === 'pack_status_d1_cache_invalid'), true, label);
    assert.equal(logs.at(-1)?.providerCacheStatus, 'D1-MISS', label);
  }

  const failClosed = await handleRequest(
    new Request('https://api.mons.shop/pack-status/card_nft_2'),
    env({ dataDb: packStatusD1({ row: null }) }),
    {
      ...quietDependencies(async () => assert.fail('pack-status must not call Commerce or another provider')),
      cache: {
        match: async () => Response.json({ dropId: 'card_nft_2', total: 999 }),
        put: async () => assert.fail('missing D1 data must not be cached'),
      },
      log: () => undefined,
    },
  );
  assert.equal(failClosed.status, 502);
  assert.equal(failClosed.headers.get('x-mons-pack-status-source'), null);
  assert.deepEqual(await failClosed.json(), { ok: false, error: 'provider-unavailable' });
});

test('pack-status route fails closed on missing or invalid D1 state', async () => {
  const cases: Array<{ label: string; dataDb: D1Database }> = [
    { label: 'missing binding', dataDb: {} as D1Database },
    { label: 'missing metadata', dataDb: packStatusD1({ metadataRow: null }) },
    { label: 'zero metadata generation', dataDb: packStatusD1({ metadataRow: { cache_generation: 0 } }) },
    { label: 'malformed metadata', dataDb: packStatusD1({ metadataRow: { cache_generation: 'invalid' } }) },
    { label: 'missing summary', dataDb: packStatusD1({ row: null }) },
    { label: 'malformed summary', dataDb: packStatusD1({ row: { drop_id: 'card_nft_2', version: 1 } }) },
    { label: 'query failure', dataDb: packStatusD1({ failure: new Error('d1 unavailable') }) },
  ];
  for (const { label, dataDb } of cases) {
    const logs: Record<string, unknown>[] = [];
    const response = await handleRequest(
      new Request('https://api.mons.shop/pack-status/card_nft_2'),
      env({ dataDb }),
      { ...quietDependencies(fetch), log: (entry) => logs.push(entry) },
    );
    assert.equal(response.status, 502, label);
    assert.equal(response.headers.get('x-mons-pack-status-source'), null, label);
    assert.deepEqual(await response.json(), { ok: false, error: 'provider-unavailable' }, label);
    assert.equal(logs.some((entry) => entry.event === 'pack_status_d1_unavailable'), true, label);
    assert.equal(Object.hasOwn(logs.at(-1) || {}, 'packStatusSource'), false, label);
    assert.equal(logs.at(-1)?.upstreamCalls, 0, label);
  }
});

test('pack-status route enforces allowlisted paths, methods, and CORS', async () => {
  const dependencies = quietDependencies(fetch);
  for (const pathname of [
    '/pack-status',
    '/pack-status/unknown',
    '/pack-status/card_nft_2/extra',
    '/pack-status/%63ard_nft_2',
  ]) {
    const response = await handleRequest(new Request(`https://api.mons.shop${pathname}`), env(), dependencies);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'invalid-request' });
  }
  const method = await handleRequest(new Request('https://api.mons.shop/pack-status/card_nft_2', {
    method: 'POST',
  }), env(), dependencies);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET, OPTIONS');
  const cors = await handleRequest(new Request('https://api.mons.shop/pack-status/card_nft_2', {
    method: 'OPTIONS',
  }), env(), dependencies);
  assert.equal(cors.status, 204);
  assert.equal(cors.headers.get('access-control-allow-origin'), '*');
  assert.match(cors.headers.get('cache-control') || '', /no-store/);
});

test('notification subscription normalizes email and calls Resend without exposing credentials', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const logs: Record<string, unknown>[] = [];
  const response = await handleRequest(
    request('/notifications/subscribe', { email: ' Buyer@Example.COM ' }),
    env({ resendContactsApiKey: 'resend-secret-value' }),
    {
      ...quietDependencies(fetch),
      log: (entry) => logs.push(entry),
      resendFetch: async (input, init) => {
        calls.push({ input: String(input), init });
        return Response.json({ object: 'contact', id: 'contact-1' });
      },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { subscribed: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, 'https://api.resend.com/contacts');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Bearer resend-secret-value');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    email: 'buyer@example.com',
    unsubscribed: false,
  });
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes('buyer@example.com'), false);
  assert.equal(serializedLogs.includes('resend-secret-value'), false);
  assert.equal(logs[0]?.route, '/notifications/subscribe');
  assert.equal(logs[0]?.upstreamCalls, 1);
});

test('notification subscription validates exact bounded JSON before calling Resend', async () => {
  let calls = 0;
  const dependencies = {
    ...quietDependencies(fetch),
    resendFetch: async () => {
      calls += 1;
      return Response.json({ id: 'unexpected' });
    },
  };
  for (const invalidRequest of [
    new Request('https://api.mons.shop/notifications/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'CF-Connecting-IP': '203.0.113.8',
        Origin: 'https://mons.shop',
      },
      body: JSON.stringify({ email: 'buyer@example.com' }),
    }),
    request('/notifications/subscribe', { email: 'buyer@example.com', extra: true }),
    request('/notifications/subscribe', { email: 42 }),
    new Request('https://api.mons.shop/notifications/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.8',
        Origin: 'https://mons.shop',
      },
      body: '{',
    }),
    new Request('https://api.mons.shop/notifications/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.8',
        Origin: 'https://mons.shop',
      },
      body: JSON.stringify({ email: `${'a'.repeat(1024)}@example.com` }),
    }),
  ]) {
    const response = await handleRequest(invalidRequest, env(), dependencies);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'invalid-request' });
  }
  const invalidEmail = await handleRequest(
    request('/notifications/subscribe', { email: 'not an email' }),
    env(),
    dependencies,
  );
  assert.equal(invalidEmail.status, 400);
  assert.deepEqual(await invalidEmail.json(), { ok: false, error: 'invalid-email' });
  assert.equal(calls, 0);
});

test('notification subscription treats Resend conflicts as idempotent success', async () => {
  for (const providerResponse of [
    Response.json({ name: 'contact_already_exists' }, { status: 409 }),
    Response.json({ name: 'duplicate_contact' }, { status: 400 }),
  ]) {
    const response = await handleRequest(
      request('/notifications/subscribe', { email: 'buyer@example.com' }),
      env(),
      {
        ...quietDependencies(fetch),
        resendFetch: async () => providerResponse,
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { subscribed: true });
  }
});

test('notification subscription hides missing configuration and provider failures', async () => {
  const missing = await handleRequest(
    request('/notifications/subscribe', { email: 'buyer@example.com' }),
    env({ resendContactsApiKey: '' }),
    quietDependencies(fetch),
  );
  assert.equal(missing.status, 502);
  assert.deepEqual(await missing.json(), { ok: false, error: 'provider-unavailable' });

  const logs: Record<string, unknown>[] = [];
  const failed = await handleRequest(
    request('/notifications/subscribe', { email: 'private@example.com' }),
    env({ resendContactsApiKey: 'private-secret' }),
    {
      ...quietDependencies(fetch),
      log: (entry) => logs.push(entry),
      resendFetch: async () => Response.json({ message: 'provider-private-detail' }, { status: 422 }),
    },
  );
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { ok: false, error: 'provider-unavailable' });
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('private@example.com'), false);
  assert.equal(serialized.includes('private-secret'), false);
  assert.equal(serialized.includes('provider-private-detail'), false);

  const malformed = await handleRequest(
    request('/notifications/subscribe', { email: 'buyer@example.com' }),
    env(),
    {
      ...quietDependencies(fetch),
      resendFetch: async () => Response.json({ object: 'contact' }),
    },
  );
  assert.equal(malformed.status, 502);
  assert.deepEqual(await malformed.json(), { ok: false, error: 'provider-unavailable' });

  const oversized = await handleRequest(
    request('/notifications/subscribe', { email: 'buyer@example.com' }),
    env(),
    {
      ...quietDependencies(fetch),
      resendFetch: async () => new Response(JSON.stringify({
        id: 'contact-1',
        padding: 'x'.repeat(8 * 1024),
      })),
    },
  );
  assert.equal(oversized.status, 502);
  assert.deepEqual(await oversized.json(), { ok: false, error: 'provider-unavailable' });

  const transportFailure = await handleRequest(
    request('/notifications/subscribe', { email: 'buyer@example.com' }),
    env(),
    {
      ...quietDependencies(fetch),
      resendFetch: async () => {
        throw new Error('provider transport detail');
      },
    },
  );
  assert.equal(transportFailure.status, 502);
  assert.deepEqual(await transportFailure.json(), { ok: false, error: 'provider-unavailable' });
});

test('a settled Resend failure remains definitive after a later client abort', async () => {
  const controller = new AbortController();
  const reason = new Error('late client disconnect');
  const response = await handleRequest(
    new Request(request('/notifications/subscribe', { email: 'buyer@example.com' }), {
      signal: controller.signal,
    }),
    env(),
    {
      ...quietDependencies(fetch),
      resendFetch: async () => Response.json({ error: 'provider failure' }, { status: 500 }),
    },
  );

  controller.abort(reason);
  assert.equal(controller.signal.reason, reason);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: 'provider-unavailable' });
});

test('notification subscription converts a bounded provider deadline into a generic timeout', async () => {
  for (const resendFetch of [
    async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error('missing signal'));
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    async () => new Response(new ReadableStream<Uint8Array>({ start() {} })),
  ]) {
    const response = await handleRequest(
      request('/notifications/subscribe', { email: 'buyer@example.com' }),
      env(),
      {
        ...quietDependencies(fetch),
        resendTimeoutMs: 1,
        resendFetch,
      },
    );
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { ok: false, error: 'provider-timeout' });
  }
});

test('internal notification enqueue requires a valid signature and exposes no CORS', async () => {
  let sends = 0;
  const notificationQueue: Queue = {
    send: async () => {
      sends += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
  const unsigned = await handleRequest(new Request(`https://api.mons.shop${NOTIFICATION_ENQUEUE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(NOTIFICATION_JOB),
  }), env({ notificationQueue }), quietDependencies(fetch));
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.headers.get('access-control-allow-origin'), null);
  assert.equal(sends, 0);

  const preflight = await handleRequest(new Request(`https://api.mons.shop${NOTIFICATION_ENQUEUE_PATH}`, {
    method: 'OPTIONS',
  }), env({ notificationQueue }), quietDependencies(fetch));
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  assert.equal(sends, 0);
});

test('internal notification enqueue sends the exact validated JSON job once', async () => {
  const sent: Array<{ body: unknown; options?: QueueSendOptions }> = [];
  const notificationQueue: Queue = {
    send: async (body, options) => {
      sent.push({ body, options });
      return { metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } } };
    },
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
  const response = await handleRequest(
    await notificationEnqueueRequest(),
    env({ notificationQueue }),
    quietDependencies(fetch),
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { queued: true });
  assert.deepEqual(sent, [{ body: NOTIFICATION_JOB, options: { contentType: 'json' } }]);
});

test('route logging failures do not alter internal enqueue responses', async (context) => {
  context.mock.method(console, 'error', () => {
    throw new Error('fallback logger unavailable');
  });
  let sends = 0;
  let logAttempts = 0;
  const notificationQueue: Queue = {
    send: async () => {
      sends += 1;
      return { metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } } };
    },
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
  const response = await handleRequest(
    await notificationEnqueueRequest(),
    env({ notificationQueue }),
    {
      ...quietDependencies(fetch),
      log: () => {
        logAttempts += 1;
        throw new Error('logger unavailable');
      },
    },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { queued: true });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(sends, 1);
  assert.equal(logAttempts, 2);
});

test('internal notification enqueue rejects signed invalid jobs and surfaces queue failures', async () => {
  const invalid = await handleRequest(
    await notificationEnqueueRequest({ ...NOTIFICATION_JOB, recipients: ['not an email'] }),
    env(),
    quietDependencies(fetch),
  );
  assert.equal(invalid.status, 400);

  const notificationQueue: Queue = {
    send: async () => {
      throw new Error('queue unavailable');
    },
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
  const unavailable = await handleRequest(
    await notificationEnqueueRequest(),
    env({ notificationQueue }),
    quietDependencies(fetch),
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { ok: false, error: 'enqueue-unavailable' });
});

test('production config has exact authentication rate limits', () => {
  const config = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  assert.deepEqual(config.ratelimits, [
    {
      name: 'STAFF_AUTH_CHALLENGE_RATE_LIMITER',
      namespace_id: '1142143110',
      simple: { limit: 10, period: 60 },
    },
    {
      name: 'STAFF_AUTH_SESSION_RATE_LIMITER',
      namespace_id: '1361289553',
      simple: { limit: 30, period: 60 },
    },
    {
      name: 'ANONYMOUS_AUTH_SESSION_RATE_LIMITER',
      namespace_id: '1874210346',
      simple: { limit: 20, period: 60 },
    },
    {
      name: 'PUBLIC_RPC_READ_RATE_LIMITER',
      namespace_id: '798946091',
      simple: { limit: 5000, period: 60 },
    },
    {
      name: 'PUBLIC_RPC_WRITE_RATE_LIMITER',
      namespace_id: '2126420685',
      simple: { limit: 500, period: 60 },
    },
    {
      name: 'PUBLIC_SHOP_RATE_LIMITER',
      namespace_id: '1950264148',
      simple: { limit: 600, period: 60 },
    },
    {
      name: 'PUBLIC_NOTIFICATION_RATE_LIMITER',
      namespace_id: '1844980764',
      simple: { limit: 60, period: 60 },
    },
  ]);
});

test('public routes accept only mons.shop and local browser origins', async () => {
  for (const origin of [
    'https://mons.shop',
    'https://www.mons.shop',
    'http://localhost:5173',
    'https://127.0.0.1:8787',
  ]) {
    const response = await handleRequest(new Request('https://api.mons.shop/inventory', {
      method: 'OPTIONS',
      headers: { Origin: origin },
    }), env(), quietDependencies(fetch));
    assert.equal(response.status, 204, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('vary'), 'Origin');
  }
  let opsReads = 0;
  const opsDb = d1Database(function prepare() {
    opsReads += 1;
    throw new Error('OPS D1 must not run before public origin validation');
  });
  const staffAuthorization = `Bearer mons_staff_v1.123e4567-e89b-42d3-a456-426614174000.${'A'.repeat(43)}`;
  for (const origin of [undefined, 'https://candidate-mons-shop.lil-org.workers.dev', 'https://evil.example']) {
    let upstreamCalls = 0;
    const response = await handleRequest(new Request('https://api.mons.shop/inventory', {
      method: 'POST',
      headers: {
        Authorization: staffAuthorization,
        'Content-Type': 'application/json',
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify({ owner: OWNER }),
    }), env({ opsDb }), quietDependencies(async () => {
      upstreamCalls += 1;
      return Response.json({});
    }));
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(upstreamCalls, 0);
  }
  const rpc = await handleRequest(new Request('https://api.mons.shop/rpc/mainnet-beta', {
    method: 'POST',
    headers: {
      Authorization: staffAuthorization,
      'Content-Type': 'application/json',
      Origin: 'https://candidate-mons-shop.lil-org.workers.dev',
    },
    body: JSON.stringify(rpcBody('getLatestBlockhash', [{ commitment: 'confirmed' }])),
  }), env({ opsDb }), quietDependencies(fetch));
  assert.equal(rpc.status, 403);
  assert.equal(rpc.headers.get('access-control-allow-origin'), null);
  assert.equal(opsReads, 0);
});

test('public rate limits are observe-only and select the route-specific binding', async () => {
  const calls: string[] = [];
  const keys: Array<[string, string]> = [];
  const logs: Record<string, unknown>[] = [];
  const denied = (name: string) => rateLimiter(async ({ key }) => {
    calls.push(name);
    keys.push([name, key]);
    return { success: false };
  });
  const providerFetch: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return rpcResult(body.id, null);
  };
  const read = await handleRequest(
    rpcRequest('/rpc/mainnet-beta', rpcBody('getLatestBlockhash', [{ commitment: 'confirmed' }])),
    env({ publicRpcReadRateLimiter: denied('rpc-read') }),
    { ...quietDependencies(providerFetch), log: (entry) => logs.push(entry) },
  );
  assert.equal(read.status, 200);

  const write = await handleRequest(
    rpcRequest('/rpc/mainnet-beta', rpcBody('sendTransaction', [
      TRANSACTION,
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ])),
    env({ publicRpcWriteRateLimiter: denied('rpc-write') }),
    { ...quietDependencies(providerFetch), log: (entry) => logs.push(entry) },
  );
  assert.equal(write.status, 200);

  const shop = await handleRequest(
    request('/inventory'),
    env({ apiKey: '', publicShopRateLimiter: denied('shop') }),
    { ...quietDependencies(providerFetch), log: (entry) => logs.push(entry) },
  );
  assert.equal(shop.status, 502);

  let resendCalls = 0;
  const notification = await handleRequest(
    request('/notifications/subscribe', { email: 'buyer@example.com' }),
    env({ publicNotificationRateLimiter: rateLimiter(async () => {
      calls.push('notification');
      throw new Error('limiter unavailable');
    }) }),
    {
      ...quietDependencies(fetch),
      log: (entry) => logs.push(entry),
      resendFetch: async () => {
        resendCalls += 1;
        return Response.json({ id: 'contact-1' });
      },
    },
  );
  assert.equal(notification.status, 200);
  assert.equal(resendCalls, 1);
  assert.deepEqual(calls, ['rpc-read', 'rpc-write', 'shop', 'notification']);
  assert.deepEqual(keys, [
    ['rpc-read', '203.0.113.8'],
    ['rpc-write', '203.0.113.8'],
    ['shop', '/inventory:203.0.113.8'],
  ]);
  assert.equal(logs.filter((entry) => entry.event === 'public_rate_limit_would_block').length, 3);
  assert.equal(logs.some((entry) => entry.event === 'public_rate_limit_check_failed'), true);
  assert.equal(JSON.stringify(logs).includes('203.0.113.8'), false);
});

test('RPC routing applies its restricted CORS policy and HTTP-only contract', async () => {
  const providerFetch: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return rpcResult(body.id, { blockhash: OWNER, lastValidBlockHeight: 1 });
  };
  const allowed = await handleRequest(new Request('https://api.mons.shop/rpc/mainnet-beta', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://www.mons.shop',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,solana-client',
    },
  }), env(), quietDependencies(providerFetch));
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://www.mons.shop');
  assert.equal(allowed.headers.get('access-control-allow-headers'), 'Content-Type, Solana-Client');
  assert.equal(allowed.headers.get('vary'), 'Origin');

  const local = await handleRequest(new Request('https://api.mons.shop/rpc/devnet', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173' },
  }), env(), quietDependencies(providerFetch));
  assert.equal(local.status, 204);

  const versionPreview = await handleRequest(new Request('https://api.mons.shop/rpc/devnet', {
    method: 'OPTIONS',
    headers: { Origin: 'https://deadbeef-mons-shop.lil-org.workers.dev' },
  }), env(), quietDependencies(providerFetch));
  assert.equal(versionPreview.status, 403);

  const denied = await handleRequest(new Request('https://api.mons.shop/rpc/mainnet-beta', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example' },
  }), env(), quietDependencies(providerFetch));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal((await denied.json() as any).error.code, -32096);

  const wrongMethod = await handleRequest(new Request('https://api.mons.shop/rpc/mainnet-beta', {
    headers: { Origin: 'https://mons.shop' },
  }), env(), quietDependencies(providerFetch));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('access-control-allow-origin'), 'https://mons.shop');
  assert.equal((await wrongMethod.json() as any).error.code, -32600);
});

test('RPC proxy accepts only the exact browser method surface and selects the requested cluster', async () => {
  const bodies = [
    rpcBody('getAccountInfo', [OWNER, { commitment: 'confirmed', encoding: 'base64' }], 'account'),
    rpcBody('getMultipleAccounts', [[OWNER], { commitment: 'confirmed', encoding: 'base64' }], 'multiple'),
    rpcBody('getLatestBlockhash', [{ commitment: 'confirmed' }], 'blockhash'),
    rpcBody('getSignatureStatuses', [[SIGNATURE], { searchTransactionHistory: true }], 'status'),
    rpcBody('isBlockhashValid', [OWNER, { commitment: 'confirmed' }], 'validity'),
    rpcBody('simulateTransaction', [TRANSACTION, { commitment: 'confirmed', encoding: 'base64', sigVerify: false }], 'simulate'),
    rpcBody('sendTransaction', [TRANSACTION, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 }], 'send'),
  ];
  const calls: Array<{ host: string; body: any }> = [];
  const providerFetch: ProviderFetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ host: new URL(String(input)).hostname, body });
    return rpcResult(body.id, null);
  };
  for (const body of bodies) {
    const response = await handleRequest(rpcRequest('/rpc/mainnet-beta', body), env(), quietDependencies(providerFetch));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: body.id, result: null });
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://mons.shop');
    assert.match(response.headers.get('cache-control') || '', /no-store/);
  }
  const devnet = rpcBody('getLatestBlockhash', [{ commitment: 'confirmed' }], 'devnet');
  assert.equal((await handleRequest(rpcRequest('/rpc/devnet', devnet), env(), quietDependencies(providerFetch))).status, 200);
  assert.equal(calls.slice(0, -1).every((call) => call.host === 'mainnet.helius-rpc.com'), true);
  assert.equal(calls.at(-1)?.host, 'devnet.helius-rpc.com');
  assert.deepEqual(calls.slice(0, bodies.length).map((call) => call.body), bodies);

  const noOrigin = new Request('https://api.mons.shop/rpc/mainnet-beta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.8' },
    body: JSON.stringify(rpcBody('getLatestBlockhash', [{ commitment: 'confirmed' }], 'cli')),
  });
  assert.equal((await handleRequest(noOrigin, env(), quietDependencies(providerFetch))).status, 403);
});

test('@solana/web3.js emits request shapes accepted by the exact RPC contract', async () => {
  const bodies: any[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    let result: unknown;
    if (body.method === 'getAccountInfo') result = { context: { slot: 1 }, value: null };
    if (body.method === 'getMultipleAccounts') result = { context: { slot: 1 }, value: [null] };
    if (body.method === 'getLatestBlockhash') result = { context: { slot: 1 }, value: { blockhash: OWNER, lastValidBlockHeight: 1 } };
    if (body.method === 'getSignatureStatuses') result = { context: { slot: 1 }, value: [null] };
    if (body.method === 'isBlockhashValid') result = { context: { slot: 1 }, value: true };
    if (body.method === 'simulateTransaction') result = { context: { slot: 1 }, value: { err: null, logs: [] } };
    if (body.method === 'sendTransaction') result = SIGNATURE;
    return rpcResult(body.id, result);
  };
  const connection = new Connection('https://api.mons.shop/rpc/mainnet-beta', {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: fetchImpl,
  });
  const owner = new PublicKey(OWNER);
  await connection.getAccountInfo(owner, 'confirmed');
  await connection.getMultipleAccountsInfo([owner], { commitment: 'confirmed' });
  await connection.getLatestBlockhash('confirmed');
  await connection.getSignatureStatus(SIGNATURE, { searchTransactionHistory: true });
  await connection.isBlockhashValid(OWNER, { commitment: 'confirmed' });
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: owner,
    recentBlockhash: OWNER,
    instructions: [],
  }).compileToV0Message());
  await connection.simulateTransaction(transaction, { commitment: 'confirmed', sigVerify: false });
  await connection.sendRawTransaction(new Uint8Array([1, 2, 3]), {
    maxRetries: 3,
    preflightCommitment: 'confirmed',
    skipPreflight: false,
  });
  assert.deepEqual(bodies.map((body) => body.method), [
    'getAccountInfo',
    'getMultipleAccounts',
    'getLatestBlockhash',
    'getSignatureStatuses',
    'isBlockhashValid',
    'simulateTransaction',
    'sendTransaction',
  ]);
  assert.equal(bodies.every(isExactShopRpcRequest), true);
});

test('RPC proxy rejects batches, unlisted methods, malformed params, and oversized bodies before Helius', async () => {
  let calls = 0;
  const providerFetch: ProviderFetch = async () => {
    calls += 1;
    return rpcResult(1, null);
  };
  const invalidRequests: Array<{ body: unknown; code: number }> = [
    { body: [rpcBody('getLatestBlockhash', [{ commitment: 'confirmed' }])], code: -32600 },
    { body: rpcBody('getBalance', [OWNER]), code: -32601 },
    { body: rpcBody('getAccountInfo', ['invalid', { commitment: 'confirmed', encoding: 'base64' }]), code: -32600 },
    { body: rpcBody('getMultipleAccounts', [Array.from({ length: 33 }, () => OWNER), { commitment: 'confirmed', encoding: 'base64' }]), code: -32600 },
    { body: rpcBody('getSignatureStatuses', [['invalid']]), code: -32600 },
    { body: rpcBody('simulateTransaction', [Buffer.alloc(1233).toString('base64'), { commitment: 'confirmed', encoding: 'base64', sigVerify: false }]), code: -32600 },
    { body: rpcBody('simulateTransaction', ['not-base64%', { commitment: 'confirmed', encoding: 'base64', sigVerify: false }]), code: -32600 },
    { body: rpcBody('sendTransaction', [TRANSACTION, { encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: true }]), code: -32600 },
    { body: rpcBody('getLatestBlockhash', [{ commitment: 'confirmed', unexpected: true }]), code: -32600 },
  ];
  for (const entry of invalidRequests) {
    const response = await handleRequest(rpcRequest('/rpc/mainnet-beta', entry.body), env(), quietDependencies(providerFetch));
    assert.equal(response.status, 400);
    assert.equal((await response.json() as any).error.code, entry.code);
  }
  const oversized = new Request('https://api.mons.shop/rpc/mainnet-beta', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(33 * 1024),
      'CF-Connecting-IP': '203.0.113.8',
      Origin: 'https://mons.shop',
    },
    body: JSON.stringify(rpcBody('getLatestBlockhash', [{ commitment: 'confirmed' }])),
  });
  assert.equal((await handleRequest(oversized, env(), quietDependencies(providerFetch))).status, 400);
  const streamedOversized = rpcRequest('/rpc/mainnet-beta', {
    ...rpcBody('getLatestBlockhash', [{ commitment: 'confirmed' }]),
    padding: 'x'.repeat(33 * 1024),
  });
  assert.equal((await handleRequest(streamedOversized, env(), quietDependencies(providerFetch))).status, 400);
  const wrongContentType = new Request('https://api.mons.shop/rpc/mainnet-beta', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/jsonp',
      'CF-Connecting-IP': '203.0.113.8',
      Origin: 'https://mons.shop',
    },
    body: JSON.stringify(rpcBody('getLatestBlockhash', [{ commitment: 'confirmed' }])),
  });
  assert.equal((await handleRequest(wrongContentType, env(), quietDependencies(providerFetch))).status, 400);
  assert.equal(calls, 0);
});

test('RPC permits one 2 MiB account slice but rejects aggregate slices above 2.9 MB', async () => {
  let calls = 0;
  const encodedAccount = Buffer.alloc(2 * 1024 * 1024).toString('base64');
  const providerFetch: ProviderFetch = async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    return rpcResult(body.id, { context: { slot: 1 }, value: { data: [encodedAccount, 'base64'] } });
  };
  const single = rpcBody('getAccountInfo', [
    OWNER,
    {
      commitment: 'confirmed',
      encoding: 'base64',
      dataSlice: { offset: 0, length: 2 * 1024 * 1024 },
    },
  ]);
  const singleResponse = await handleRequest(
    rpcRequest('/rpc/mainnet-beta', single),
    env(),
    quietDependencies(providerFetch),
  );
  assert.equal(singleResponse.status, 200);
  assert.equal((await singleResponse.json() as any).result.value.data[0].length, encodedAccount.length);

  const aggregate = rpcBody('getMultipleAccounts', [
    [OWNER, OWNER],
    {
      commitment: 'confirmed',
      encoding: 'base64',
      dataSlice: { offset: 0, length: 2 * 1024 * 1024 },
    },
  ]);
  const aggregateResponse = await handleRequest(
    rpcRequest('/rpc/mainnet-beta', aggregate),
    env(),
    quietDependencies(providerFetch),
  );
  assert.equal(aggregateResponse.status, 400);
  assert.equal((await aggregateResponse.json() as any).error.code, -32600);
  assert.equal(calls, 1);
});

test('RPC requests do not depend on Cloudflare connecting IP metadata', async () => {
  const body = rpcBody('simulateTransaction', [TRANSACTION, { commitment: 'confirmed', encoding: 'base64', sigVerify: false }]);
  const providerFetch: ProviderFetch = async (_input, init) => rpcResult(JSON.parse(String(init?.body)).id, null);
  const noIp = new Request('https://api.mons.shop/rpc/mainnet-beta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
    body: JSON.stringify(body),
  });
  const noIpLogs: Record<string, unknown>[] = [];
  assert.equal((await handleRequest(noIp, env(), {
    ...quietDependencies(providerFetch),
    log: (entry) => noIpLogs.push(entry),
  })).status, 200);
  assert.equal(noIpLogs.some((entry) => entry.event === 'public_rate_limit_key_missing'), true);

  let called = false;
  const missingSecret = await handleRequest(
    rpcRequest('/rpc/mainnet-beta', body),
    env({ apiKey: '' }),
    quietDependencies(async () => {
      called = true;
      return rpcResult(1, null);
    }),
  );
  assert.equal(missingSecret.status, 502);
  assert.equal(called, false);
  assert.equal((await missingSecret.json() as any).error.code, -32099);
});

test('RPC reads retry once, submissions never retry, and deterministic JSON-RPC errors pass through', async () => {
  let reads = 0;
  const readRetryDelays: number[] = [];
  const readBody = rpcBody('getLatestBlockhash', [{ commitment: 'confirmed' }], 'read');
  const readResponse = await handleRequest(rpcRequest('/rpc/mainnet-beta', readBody), env(), {
    ...quietDependencies(async (_input, init) => {
      reads += 1;
      if (reads === 1) return new Response('unavailable', { status: 503 });
      return rpcResult(JSON.parse(String(init?.body)).id, { blockhash: OWNER, lastValidBlockHeight: 1 });
    }),
    randomUint32: () => 17,
    sleep: async (milliseconds) => {
      readRetryDelays.push(milliseconds);
    },
  });
  assert.equal(readResponse.status, 200);
  assert.equal(reads, 2);
  assert.deepEqual(readRetryDelays, [117]);

  let rpcErrors = 0;
  const transientRpcResponse = await handleRequest(rpcRequest('/rpc/mainnet-beta', readBody), env(), quietDependencies(async (_input, init) => {
    rpcErrors += 1;
    const id = JSON.parse(String(init?.body)).id;
    if (rpcErrors === 1) return rpcError(id, -32603, 'temporary internal error', { status: 503 });
    return rpcResult(id, { blockhash: OWNER, lastValidBlockHeight: 1 });
  }));
  assert.equal(transientRpcResponse.status, 200);
  assert.equal(rpcErrors, 2);

  let deterministicReadCalls = 0;
  const deterministicRead = await handleRequest(rpcRequest('/rpc/mainnet-beta', readBody), env(), quietDependencies(async (_input, init) => {
    deterministicReadCalls += 1;
    return rpcError(JSON.parse(String(init?.body)).id, -32002, 'Deterministic provider rejection', { status: 503 });
  }));
  assert.equal(deterministicRead.status, 200);
  assert.equal(deterministicReadCalls, 2);
  assert.deepEqual(await deterministicRead.json(), {
    jsonrpc: '2.0',
    id: 'read',
    error: { code: -32002, message: 'Deterministic provider rejection' },
  });

  let simulations = 0;
  const simulationBody = rpcBody('simulateTransaction', [TRANSACTION, { commitment: 'confirmed', encoding: 'base64', sigVerify: false }], 'simulate-retry');
  const simulationResponse = await handleRequest(rpcRequest('/rpc/mainnet-beta', simulationBody), env(), quietDependencies(async (_input, init) => {
    simulations += 1;
    if (simulations === 1) return new Response('gateway timeout', { status: 504 });
    return rpcResult(JSON.parse(String(init?.body)).id, { value: { err: null } });
  }));
  assert.equal(simulationResponse.status, 200);
  assert.equal(simulations, 2);

  let sends = 0;
  const sendBody = rpcBody('sendTransaction', [TRANSACTION, { encoding: 'base64', preflightCommitment: 'confirmed' }], 'send-once');
  const sendResponse = await handleRequest(rpcRequest('/rpc/mainnet-beta', sendBody), env(), quietDependencies(async () => {
    sends += 1;
    return new Response('unavailable', { status: 503 });
  }));
  assert.equal(sendResponse.status, 502);
  assert.equal(sends, 1);

  for (const status of [408, 504]) {
    let timeoutSends = 0;
    const timeoutSend = await handleRequest(rpcRequest('/rpc/mainnet-beta', sendBody), env(), quietDependencies(async () => {
      timeoutSends += 1;
      return new Response('provider timeout', { status });
    }));
    assert.equal(timeoutSend.status, 504);
    assert.equal((await timeoutSend.json() as any).error.code, -32098);
    assert.equal(timeoutSends, 1);
  }

  let deterministicCalls = 0;
  const deterministic = await handleRequest(rpcRequest('/rpc/mainnet-beta', sendBody), env(), quietDependencies(async () => {
    deterministicCalls += 1;
    return rpcError('send-once', -32002, 'Transaction simulation failed', { status: 503 });
  }));
  assert.equal(deterministic.status, 200);
  assert.equal(deterministicCalls, 1);
  assert.deepEqual(await deterministic.json(), {
    jsonrpc: '2.0',
    id: 'send-once',
    error: { code: -32002, message: 'Transaction simulation failed' },
  });
});

test('retry sleep rejects both already-aborted and subsequently aborted signals', async () => {
  const alreadyAborted = new AbortController();
  const earlyReason = new Error('early abort');
  alreadyAborted.abort(earlyReason);
  await assert.rejects(
    sleepWithAbort(10_000, alreadyAborted.signal),
    (error: unknown) => error === earlyReason,
  );

  const laterAborted = new AbortController();
  const laterReason = new Error('later abort');
  const sleeping = sleepWithAbort(10_000, laterAborted.signal);
  laterAborted.abort(laterReason);
  await assert.rejects(sleeping, (error: unknown) => error === laterReason);
});

test('RPC deadlines, response bounds, and response IDs fail with stable provider errors', async () => {
  const body = rpcBody('getLatestBlockhash', [{ commitment: 'confirmed' }], 'bounded');
  const hanging: ProviderFetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const deadline = await handleRequest(rpcRequest('/rpc/mainnet-beta', body), env(), {
    ...quietDependencies(hanging),
    providerTimeoutMs: 5,
  });
  assert.equal(deadline.status, 504);
  assert.equal((await deadline.json() as any).error.code, -32098);

  const hangingBody: ProviderFetch = async (_input, init) => new Response(new ReadableStream({
    start(controller) {
      init?.signal?.addEventListener(
        'abort',
        () => controller.error(new DOMException('aborted', 'AbortError')),
        { once: true },
      );
    },
  }));
  const bodyDeadline = await handleRequest(rpcRequest('/rpc/mainnet-beta', body), env(), {
    ...quietDependencies(hangingBody),
    providerTimeoutMs: 5,
  });
  assert.equal(bodyDeadline.status, 504);
  assert.equal((await bodyDeadline.json() as any).error.code, -32098);

  const mismatched = await handleRequest(rpcRequest('/rpc/mainnet-beta', body), env(), quietDependencies(async () => rpcResult('other-id', null)));
  assert.equal(mismatched.status, 502);

  const oversized = await handleRequest(rpcRequest('/rpc/mainnet-beta', body), env(), quietDependencies(async () =>
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(4 * 1024 * 1024 + 1) } })));
  assert.equal(oversized.status, 502);

  const streamedOversized = await handleRequest(rpcRequest('/rpc/mainnet-beta', body), env(), quietDependencies(async () =>
    new Response('x'.repeat(4 * 1024 * 1024 + 1), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  assert.equal(streamedOversized.status, 502);

  for (const status of [408, 504]) {
    let providerTimeouts = 0;
    const providerTimeout = await handleRequest(rpcRequest('/rpc/mainnet-beta', body), env(), quietDependencies(async () => {
      providerTimeouts += 1;
      return new Response('timeout', { status });
    }));
    assert.equal(providerTimeout.status, 504);
    assert.equal((await providerTimeout.json() as any).error.code, -32098);
    assert.equal(providerTimeouts, 2);
  }

  const nonSuccessMismatch = await handleRequest(
    rpcRequest('/rpc/mainnet-beta', body),
    env(),
    quietDependencies(async () => rpcError('other-id', -32002, 'Transaction simulation failed', { status: 400 })),
  );
  assert.equal(nonSuccessMismatch.status, 502);
  assert.equal((await nonSuccessMismatch.json() as any).error.code, -32099);

  const echoedCredential = await handleRequest(
    rpcRequest('/rpc/mainnet-beta', body),
    env({ apiKey: 'credential-that-must-not-escape' }),
    quietDependencies(async () => Response.json({
      jsonrpc: '2.0',
      id: 'bounded',
      error: {
        code: -32000,
        message: 'Provider rejected the request',
        data: 'credential-that-must-not-escape',
      },
    })),
  );
  assert.equal(echoedCredential.status, 502);
  assert.equal((await echoedCredential.text()).includes('credential-that-must-not-escape'), false);
});

test('RPC preserves a received non-OK status when its body stalls until cancellation', async () => {
  const sendBody = rpcBody('sendTransaction', [TRANSACTION, {
    encoding: 'base64',
    preflightCommitment: 'confirmed',
  }], 'stalled-error-body');
  let bodyCancelled = false;
  const response = await handleRequest(
    rpcRequest('/rpc/mainnet-beta', sendBody),
    env(),
    {
      ...quietDependencies(async () => new Response(new ReadableStream<Uint8Array>({
        start() {},
        cancel() {
          bodyCancelled = true;
        },
      }), { status: 400 })),
      providerAttemptTimeoutMs: 5,
      providerTimeoutMs: 100,
    },
  );

  assert.equal(bodyCancelled, true);
  assert.equal(response.status, 502);
  assert.equal((await response.json() as any).error.code, -32099);
});

test('fresh provider attempt deadlines retry idempotent RPCs but never submissions', async () => {
  const readBody = rpcBody('getLatestBlockhash', [{ commitment: 'confirmed' }], 'attempt-timeout');
  let recoveringCalls = 0;
  const recovering = await handleRequest(rpcRequest('/rpc/mainnet-beta', readBody), env(), {
    ...quietDependencies(async (_input, init) => {
      recoveringCalls += 1;
      if (recoveringCalls === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      return rpcResult('attempt-timeout', { blockhash: OWNER, lastValidBlockHeight: 1 });
    }),
    providerTimeoutMs: 100,
    providerAttemptTimeoutMs: 5,
  });
  assert.equal(recovering.status, 200);
  assert.equal(recoveringCalls, 2);

  let exhaustedCalls = 0;
  const alwaysHanging: ProviderFetch = async (_input, init) => {
    exhaustedCalls += 1;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  };
  const exhausted = await handleRequest(rpcRequest('/rpc/mainnet-beta', readBody), env(), {
    ...quietDependencies(alwaysHanging),
    providerTimeoutMs: 100,
    providerAttemptTimeoutMs: 5,
  });
  assert.equal(exhausted.status, 504);
  assert.equal(exhaustedCalls, 2);

  const sendBody = rpcBody('sendTransaction', [TRANSACTION, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  exhaustedCalls = 0;
  const send = await handleRequest(rpcRequest('/rpc/mainnet-beta', sendBody), env(), {
    ...quietDependencies(alwaysHanging),
    providerTimeoutMs: 100,
    providerAttemptTimeoutMs: 5,
  });
  assert.equal(send.status, 504);
  assert.equal(exhaustedCalls, 1);

  const lateClient = new AbortController();
  const timeoutThenDisconnect: ProviderFetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const attemptReason = init?.signal?.reason;
      reject(attemptReason);
      setTimeout(() => lateClient.abort(new Error('late client disconnect')), 0);
    }, { once: true });
  });
  const timeoutFirst = await handleRequest(
    new Request(rpcRequest('/rpc/mainnet-beta', sendBody), { signal: lateClient.signal }),
    env(),
    {
      ...quietDependencies(timeoutThenDisconnect),
      providerTimeoutMs: 100,
      providerAttemptTimeoutMs: 5,
    },
  );
  assert.equal(timeoutFirst.status, 504);
  assert.equal((await timeoutFirst.json() as any).error.code, -32098);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lateClient.signal.aborted, true);
});

test('requests reject extra keys, invalid addresses, and bodies over 1 KiB', async () => {
  const providerFetch: ProviderFetch = async () => {
    throw new Error('provider should not run');
  };
  for (const body of [
    { owner: OWNER, extra: true },
    { owner: 'not-an-address' },
    { owner: OWNER, includeDevnet: 'yes' },
  ]) {
    const response = await handleRequest(request('/inventory', body), env(), quietDependencies(providerFetch));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'invalid-request' });
  }
  const oversized = new Request('https://api.mons.shop/inventory', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '2048',
      'CF-Connecting-IP': '203.0.113.8',
      Origin: 'https://mons.shop',
    },
    body: JSON.stringify({ owner: OWNER }),
  });
  const response = await handleRequest(oversized, env(), quietDependencies(providerFetch));
  assert.equal(response.status, 400);
  const wrongType = new Request('https://api.mons.shop/inventory', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'CF-Connecting-IP': '203.0.113.8',
      Origin: 'https://mons.shop',
    },
    body: JSON.stringify({ owner: OWNER }),
  });
  assert.equal((await handleRequest(wrongType, env(), quietDependencies(providerFetch))).status, 400);
});

test('inventory expected asset IDs use an exact bounded cluster contract', async () => {
  const expectedIds = Array.from(
    { length: SHOP_EXPECTED_ASSET_IDS_MAX },
    (_, index) => assetId(`expected-contract-${index}`),
  );
  const batchCalls: Array<{ hostname: string; ids: string[] }> = [];
  const providerFetch: ProviderFetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'searchAssets') return rpcCursorSearchResult(body, []);
    assert.equal(body.method, 'getAssetBatch');
    batchCalls.push({ hostname: new URL(String(input)).hostname, ids: body.params.ids });
    return rpcResult(body.id, []);
  };
  const valid = await handleRequest(request('/inventory', {
    owner: OWNER,
    includeDevnet: true,
    expectedAssetIds: {
      'mainnet-beta': expectedIds.slice(0, 8),
      devnet: expectedIds.slice(8),
    },
  }), env(), quietDependencies(providerFetch));
  assert.equal(valid.status, 200);
  assert.deepEqual(batchCalls, [
    { hostname: 'mainnet.helius-rpc.com', ids: expectedIds.slice(0, 8) },
    { hostname: 'devnet.helius-rpc.com', ids: expectedIds.slice(8) },
  ]);

  const invalidBodies = [
    { owner: OWNER, expectedAssetIds: {} },
    { owner: OWNER, expectedAssetIds: { 'mainnet-beta': [] } },
    { owner: OWNER, expectedAssetIds: { testnet: [expectedIds[0]] } },
    { owner: OWNER, expectedAssetIds: { 'mainnet-beta': ['not-an-address'] } },
    { owner: OWNER, expectedAssetIds: { 'mainnet-beta': [expectedIds[0], expectedIds[0]] } },
    {
      owner: OWNER,
      includeDevnet: true,
      expectedAssetIds: { 'mainnet-beta': [expectedIds[0]], devnet: [expectedIds[0]] },
    },
    {
      owner: OWNER,
      expectedAssetIds: { 'mainnet-beta': [...expectedIds, assetId('expected-contract-over-limit')] },
    },
    { owner: OWNER, expectedAssetIds: { devnet: [expectedIds[0]] } },
  ];
  for (const body of invalidBodies) {
    const response = await handleRequest(request('/inventory', body), env(), quietDependencies(providerFetch));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'invalid-request' });
  }
  const pending = await handleRequest(request('/pending-open-boxes', {
    owner: OWNER,
    expectedAssetIds: { 'mainnet-beta': [expectedIds[0]] },
  }), env(), quietDependencies(providerFetch));
  assert.equal(pending.status, 400);
});

test('missing provider secrets fail before an upstream request', async () => {
  let called = false;
  const providerFetch: ProviderFetch = async () => {
    called = true;
    return rpcResult('unused', []);
  };
  const response = await handleRequest(request('/inventory'), env({ apiKey: '' }), quietDependencies(providerFetch));
  assert.equal(response.status, 502);
  assert.equal(called, false);
  assert.deepEqual(await response.json(), { ok: false, error: 'provider-unavailable' });
});

test('inventory paginates sequentially, compacts pages, and never exceeds three concurrent requests', async () => {
  const mainnetScopes = listShopCollectionQueryRuntimes(false);
  let concurrent = 0;
  let maxConcurrent = 0;
  const calls: Array<{ cluster: string; params: any }> = [];
  const providerFetch: ProviderFetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body));
    calls.push({ cluster: url.hostname, params: body.params });
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 2));
    concurrent -= 1;
    const collection = body.params?.grouping?.[1];
    const cursor = body.params?.cursor;
    if (collection === CARD_COLLECTION && cursor === undefined) {
      return rpcResult(body.id, {
        cursor: 'card-page-2',
        limit: 250,
        total: 500,
        items: [cardAsset('pack-one', 184), ...Array.from({ length: 249 }, (_, index) => unknownAsset(`unknown-${index}`, CARD_COLLECTION))],
      });
    }
    if (collection === CARD_COLLECTION && cursor === 'card-page-2') {
      return rpcResult(body.id, {
        cursor: 'card-page-3',
        limit: 250,
        total: 1,
        items: [
          { ...cardAsset('burned-pack', 185), burnt: true },
        ],
      });
    }
    if (collection === CARD_COLLECTION) return rpcResult(body.id, { items: [] });
    return rpcCursorSearchResult(body, [unknownAsset(`sentinel-${collection}`, collection)]);
  };
  const response = await handleRequest(request('/inventory'), env(), quietDependencies(providerFetch));
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.deepEqual(payload.items.map((item: any) => item.id), [assetId('pack-one')]);
  assert.equal(payload.items[0].rawImage, 'https://cdn.lil.org/nft/card_nft_2/images/b184.webp');
  assert.equal(Object.hasOwn(payload.items[0], 'attributes'), false);
  assert.equal(calls.filter((call) => call.params?.grouping).length, mainnetScopes.length * 2 + 1);
  assert.equal(calls.every((call) => call.params?.options?.showGrandTotal === undefined), true);
  assert.equal(calls.every((call) => call.params?.page === undefined), true);
  assert.equal(calls.every((call) => call.params?.sortBy?.sortBy === 'id'), true);
  assert.equal(calls.every((call) => call.cluster !== 'devnet.helius-rpc.com'), true);
  assert.ok(maxConcurrent > 1);
  assert.ok(maxConcurrent <= 3);
});

test('serialized provider body reads do not consume queued attempt time', async () => {
  let calls = 0;
  const providerFetch: ProviderFetch = async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    const text = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { items: [] } });
    let pulled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          if (timeout !== undefined) clearTimeout(timeout);
          controller.error(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      },
      pull(controller) {
        if (pulled) return;
        pulled = true;
        timeout = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        }, 10);
      },
      cancel() {
        if (timeout !== undefined) clearTimeout(timeout);
      },
    }, { highWaterMark: 0 }));
  };
  const response = await handleRequest(request('/inventory', { owner: OWNER, includeDevnet: true }), env(), {
    ...quietDependencies(providerFetch),
    providerAttemptTimeoutMs: 15,
    providerTimeoutMs: 250,
  });
  assert.equal(response.status, 200);
  assert.equal(calls, listShopCollectionQueryRuntimes(true).length);
});

test('inventory downsizes oversized cursor pages and keeps the smaller limit', async (context) => {
  await context.test('250 to 125 to 64 succeeds on the same cursor', async () => {
    const cardCalls: Array<{ cursor?: string; limit: number }> = [];
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const collection = body.params?.grouping?.[1];
      if (collection !== CARD_COLLECTION) return rpcCursorSearchResult(body, []);
      cardCalls.push({ cursor: body.params.cursor, limit: body.params.limit });
      if (body.params.limit > 64) {
        return new Response('{}', { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } });
      }
      if (!body.params.cursor) {
        return rpcResult(body.id, {
          cursor: 'downsized-next',
          limit: 64,
          items: [cardAsset('downsized-pack', 184)],
        });
      }
      return rpcResult(body.id, { limit: 64, items: [] });
    };
    const response = await handleRequest(request('/inventory'), env(), quietDependencies(providerFetch));
    assert.equal(response.status, 200);
    assert.deepEqual(cardCalls, [
      { cursor: undefined, limit: 250 },
      { cursor: undefined, limit: 125 },
      { cursor: undefined, limit: 64 },
      { cursor: 'downsized-next', limit: 64 },
    ]);
  });

  await context.test('a page still oversized at 64 fails after fallback downsizing', async () => {
    const groupedLimits: number[] = [];
    const fallbackLimits: number[] = [];
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const collection = body.params?.grouping?.[1];
      if (body.params?.grouping && collection !== CARD_COLLECTION) return rpcCursorSearchResult(body, []);
      (body.params?.grouping ? groupedLimits : fallbackLimits).push(body.params.limit);
      return new Response('{}', { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } });
    };
    const response = await handleRequest(request('/inventory'), env(), quietDependencies(providerFetch));
    assert.equal(response.status, 502);
    assert.deepEqual(groupedLimits, [250, 125, 64]);
    assert.deepEqual(fallbackLimits, [250, 125, 64]);
  });
});

test('inventory enforces provider-call and serialized output budgets', async (context) => {
  await context.test('provider-call cap', async () => {
    let calls = 0;
    const response = await handleRequest(request('/inventory'), env(), {
      ...quietDependencies(async (_input, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body));
        return rpcCursorSearchResult(body, []);
      }),
      inventoryMaxProviderCalls: 3,
    });
    assert.equal(response.status, 502);
    assert.equal(calls, 3);
  });

  await context.test('per-item compaction preserves name before dropping it', async () => {
    const asset = cardAsset('compact-pack', 184);
    asset.content.metadata.name = '"'.repeat(200);
    asset.content.links.image = '"'.repeat(500);
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      return body.params?.grouping?.[1] === CARD_COLLECTION
        ? rpcCursorSearchResult(body, [asset])
        : rpcCursorSearchResult(body, []);
    };
    const response = await handleRequest(request('/inventory'), env(), quietDependencies(providerFetch));
    assert.equal(response.status, 200);
    const [item] = (await response.json() as any).items;
    assert.equal(item.name, asset.content.metadata.name);
    assert.equal(Object.hasOwn(item, 'rawImage'), false);
  });

  await context.test('final response cap', async () => {
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      return body.params?.grouping?.[1] === CARD_COLLECTION
        ? rpcCursorSearchResult(body, [cardAsset('response-cap-pack', 184)])
        : rpcCursorSearchResult(body, []);
    };
    const response = await handleRequest(request('/inventory'), env(), {
      ...quietDependencies(providerFetch),
      inventoryMaxResponseBodyBytes: 64,
    });
    assert.equal(response.status, 502);
  });
});

test('inventory enforces cumulative provider bytes and candidate limits', async (context) => {
  await context.test('cumulative response bytes', async () => {
    let calls = 0;
    const providerFetch: ProviderFetch = async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { page: 1, limit: 1000, total: 0, items: [] },
        padding: 'x'.repeat(400),
      });
    };
    const response = await handleRequest(request('/inventory'), env(), {
      ...quietDependencies(providerFetch),
      providerMaxResponseBodyBytes: 1024,
      providerMaxTotalResponseBodyBytes: 600,
    });
    assert.equal(response.status, 502);
    assert.ok(calls > 1);
  });

  await context.test('candidate cap rejects the first page beyond the bound', async () => {
    const requestedCursors: Array<string | undefined> = [];
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const collection = body.params?.grouping?.[1];
      if (collection !== CARD_COLLECTION) return rpcCursorSearchResult(body, []);
      requestedCursors.push(body.params.cursor);
      if (body.params.cursor) {
        return rpcResult(body.id, {
          cursor: 'candidate-terminal',
          limit: body.params.limit,
          items: [unknownAsset('candidate-three', CARD_COLLECTION)],
        });
      }
      return rpcResult(body.id, {
        cursor: 'candidate-page-2',
        limit: body.params.limit,
        total: 100,
        items: [
          unknownAsset('candidate-one', CARD_COLLECTION),
          unknownAsset('candidate-two', CARD_COLLECTION),
        ],
      });
    };
    const response = await handleRequest(request('/inventory'), env(), {
      ...quietDependencies(providerFetch),
      inventoryMaxCandidates: 2,
    });
    assert.equal(response.status, 502);
    assert.deepEqual(requestedCursors, [undefined, 'candidate-page-2']);
  });
});

test('inventory stops cursor pagination at the configured logical-page bound', async () => {
  const requestedCursors: Array<string | undefined> = [];
  let calls = 0;
  const providerFetch: ProviderFetch = async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    const collection = body.params?.grouping?.[1];
    if (collection !== CARD_COLLECTION) return rpcCursorSearchResult(body, []);
    const cursor = body.params.cursor as string | undefined;
    requestedCursors.push(cursor);
    const page = cursor ? Number(cursor.slice('cursor-'.length)) : 0;
    return rpcResult(body.id, {
      cursor: `cursor-${page + 1}`,
      limit: body.params.limit,
      total: page % 2 === 0 ? 1 : 10_000,
      items: [unknownAsset(`candidate-${page}`, CARD_COLLECTION)],
    });
  };
  const response = await handleRequest(request('/inventory'), env(), {
    ...quietDependencies(providerFetch),
    inventoryMaxCursorPages: 6,
  });
  assert.equal(response.status, 502);
  assert.equal(calls, 6);
  assert.ok(requestedCursors.length > 0);
  assert.ok(requestedCursors.length <= 6);
  assert.deepEqual(requestedCursors.slice(0, 2), [undefined, 'cursor-1']);
});

test('successful empty inventory scopes never scan the whole wallet', async () => {
  const ungroupedClusters: string[] = [];
  const groupedClusters: string[] = [];
  const providerFetch: ProviderFetch = async (input, init) => {
    const hostname = new URL(String(input)).hostname;
    const body = JSON.parse(String(init?.body));
    if (body.params?.grouping) {
      groupedClusters.push(hostname);
      return rpcCursorSearchResult(body, []);
    }
    ungroupedClusters.push(hostname);
    return rpcCursorSearchResult(
      body,
      Array.from({ length: 1000 }, (_, index) => unknownAsset(`unrelated-${index}`, OWNER)),
    );
  };
  const response = await handleRequest(
    request('/inventory', { owner: OWNER, includeDevnet: true }),
    env(),
    quietDependencies(providerFetch),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, items: [] });
  assert.ok(groupedClusters.includes('mainnet.helius-rpc.com'));
  assert.ok(groupedClusters.includes('devnet.helius-rpc.com'));
  assert.deepEqual(ungroupedClusters, []);
});

test('3,001 grouped raw assets are not recounted through empty-scope wallet fallback', async () => {
  const assets = Array.from(
    { length: 3_001 },
    (_, index) => unknownAsset(`large-grouped-${index}`, CARD_COLLECTION),
  );
  let ungroupedCalls = 0;
  const providerFetch: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const collection = body.params?.grouping?.[1];
    if (body.params?.grouping && collection !== CARD_COLLECTION) return rpcCursorSearchResult(body, []);
    if (!body.params?.grouping) ungroupedCalls += 1;
    const cursor = typeof body.params.cursor === 'string' ? body.params.cursor : '';
    const page = cursor ? Number(cursor.slice(cursor.lastIndexOf('-') + 1)) : 0;
    const items = assets.slice(page * body.params.limit, (page + 1) * body.params.limit);
    return rpcResult(body.id, {
      limit: body.params.limit,
      total: assets.length,
      ...(items.length ? { cursor: `large-grouped-${page + 1}` } : {}),
      items,
    });
  };
  const response = await handleRequest(request('/inventory'), env(), quietDependencies(providerFetch));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, items: [] });
  assert.equal(ungroupedCalls, 0);
});

test('expected asset IDs recover partial index lag without scanning the whole wallet', async () => {
  const indexedId = assetId('expected-indexed-pack');
  const recoveredId = assetId('expected-recovered-pack');
  const logs: Record<string, unknown>[] = [];
  let batchCalls = 0;
  let ungroupedCalls = 0;
  const providerFetch: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'getAssetBatch') {
      batchCalls += 1;
      assert.deepEqual(body.params, {
        ids: [indexedId, recoveredId],
      });
      return rpcResult(body.id, [
        { ...cardAsset(indexedId, 184), ownership: { owner: OWNER } },
        { ...cardAsset(recoveredId, 185), ownership: { owner: OWNER } },
      ]);
    }
    if (!body.params?.grouping) {
      ungroupedCalls += 1;
      return rpcCursorSearchResult(body, []);
    }
    return body.params.grouping[1] === CARD_COLLECTION
      ? rpcCursorSearchResult(body, [cardAsset(indexedId, 184)])
      : rpcCursorSearchResult(body, []);
  };
  const response = await handleRequest(request('/inventory', {
    owner: OWNER,
    expectedAssetIds: { 'mainnet-beta': [indexedId, recoveredId] },
  }), env(), {
    ...quietDependencies(providerFetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json() as any).items.map((item: any) => item.id),
    [indexedId, recoveredId],
  );
  assert.equal(batchCalls, 1);
  assert.equal(ungroupedCalls, 0);
  assert.equal(logs[0]?.expectedAssetIds, 2);
  assert.equal(logs[0]?.expectedAssetResolved, 1);
  assert.equal(logs[0]?.expectedAssetRecoveryFailures, 0);
});

test('one missing expected asset does not discard a valid batch sibling', async () => {
  const missingId = assetId('expected-missing-sibling');
  const recoveredId = assetId('expected-valid-sibling');
  const batchCalls: string[][] = [];
  const logs: Record<string, unknown>[] = [];
  const providerFetch: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'searchAssets') return rpcCursorSearchResult(body, []);
    batchCalls.push(body.params.ids);
    if (body.params.ids.includes(missingId)) {
      return rpcError(body.id, -32004, 'Asset not found');
    }
    return rpcResult(body.id, [
      { ...cardAsset(recoveredId, 184), ownership: { owner: OWNER } },
    ]);
  };
  const response = await handleRequest(request('/inventory', {
    owner: OWNER,
    expectedAssetIds: { 'mainnet-beta': [missingId, recoveredId] },
  }), env(), {
    ...quietDependencies(providerFetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as any).items.map((item: any) => item.id), [recoveredId]);
  assert.deepEqual(batchCalls, [[missingId, recoveredId], [missingId], [recoveredId]]);
  assert.equal(logs[0]?.expectedAssetResolved, 1);
  assert.equal(logs[0]?.expectedAssetRecoveryFailures, 1);
});

test('expected asset recovery validates ownership, burn state, drop, and cluster', async () => {
  const recoveredId = assetId('expected-valid-pack');
  const wrongOwnerId = assetId('expected-wrong-owner-pack');
  const missingOwnerId = assetId('expected-missing-owner-pack');
  const burnedId = assetId('expected-burned-pack');
  const missingBurnStateId = assetId('expected-missing-burn-state-pack');
  const wrongInterfaceId = assetId('expected-wrong-interface-pack');
  const wrongDropId = assetId('expected-wrong-drop-pack');
  const wrongClusterId = assetId('expected-wrong-cluster-pack');
  const otherOwner = assetId('expected-other-owner');
  const logs: Record<string, unknown>[] = [];
  const providerFetch: ProviderFetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'searchAssets') return rpcCursorSearchResult(body, []);
    assert.equal(Object.hasOwn(body.params, 'options'), false);
    const hostname = new URL(String(input)).hostname;
    if (hostname === 'devnet.helius-rpc.com') {
      return rpcResult(body.id, [
        { ...cardAsset(wrongClusterId, 184), ownership: { owner: OWNER } },
      ]);
    }
    return rpcResult(body.id, [
      { ...cardAsset(recoveredId, 184), ownership: { owner: OWNER } },
      { ...cardAsset(wrongOwnerId, 185), ownership: { owner: otherOwner } },
      cardAsset(missingOwnerId, 186),
      { ...cardAsset(burnedId, 187), burnt: true, ownership: { owner: OWNER } },
      {
        id: missingBurnStateId,
        interface: 'MplCoreAsset',
        grouping: [{ group_key: 'collection', group_value: CARD_COLLECTION }],
        ownership: { owner: OWNER },
        content: { metadata: { name: 'blind box' } },
      },
      { ...cardAsset(wrongInterfaceId, 188), interface: 'V1_NFT', ownership: { owner: OWNER } },
      { ...unknownAsset(wrongDropId, OWNER), ownership: { owner: OWNER } },
    ]);
  };
  const response = await handleRequest(request('/inventory', {
    owner: OWNER,
    includeDevnet: true,
    expectedAssetIds: {
      'mainnet-beta': [
        recoveredId,
        wrongOwnerId,
        missingOwnerId,
        burnedId,
        missingBurnStateId,
        wrongInterfaceId,
        wrongDropId,
      ],
      devnet: [wrongClusterId],
    },
  }), env(), {
    ...quietDependencies(providerFetch),
    log: (entry) => logs.push(entry),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as any).items.map((item: any) => item.id), [recoveredId]);
  assert.equal(logs[0]?.expectedAssetIds, 8);
  assert.equal(logs[0]?.expectedAssetResolved, 1);
  assert.equal(logs[0]?.expectedAssetRecoveryFailures, 0);
});

test('expected asset recovery is single-attempt, optional, and budget bounded', async (context) => {
  const expectedId = assetId('expected-soft-recovery');

  await context.test('provider failure is soft and never retried', async () => {
    let batchCalls = 0;
    const logs: Record<string, unknown>[] = [];
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'searchAssets') return rpcCursorSearchResult(body, []);
      batchCalls += 1;
      return new Response('unavailable', { status: 503 });
    };
    const response = await handleRequest(request('/inventory', {
      owner: OWNER,
      expectedAssetIds: { 'mainnet-beta': [expectedId] },
    }), env(), {
      ...quietDependencies(providerFetch),
      log: (entry) => logs.push(entry),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, items: [] });
    assert.equal(batchCalls, 1);
    assert.equal(logs[0]?.expectedAssetRecoveryFailures, 1);
  });

  await context.test('malformed batch output skips the whole cluster result', async () => {
    const logs: Record<string, unknown>[] = [];
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'searchAssets') return rpcCursorSearchResult(body, []);
      return rpcResult(body.id, [
        { ...cardAsset(expectedId, 184), ownership: { owner: OWNER } },
        { ...cardAsset('expected-unrequested-result', 185), ownership: { owner: OWNER } },
      ]);
    };
    const response = await handleRequest(request('/inventory', {
      owner: OWNER,
      expectedAssetIds: { 'mainnet-beta': [expectedId] },
    }), env(), {
      ...quietDependencies(providerFetch),
      log: (entry) => logs.push(entry),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, items: [] });
    assert.equal(logs[0]?.expectedAssetRecoveryFailures, 1);
    assert.equal(logs[0]?.expectedAssetResolved, 0);
  });

  await context.test('extra null batch entries skip the whole cluster result', async () => {
    const logs: Record<string, unknown>[] = [];
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'searchAssets') return rpcCursorSearchResult(body, []);
      return rpcResult(body.id, [
        { ...cardAsset(expectedId, 184), ownership: { owner: OWNER } },
        null,
      ]);
    };
    const response = await handleRequest(request('/inventory', {
      owner: OWNER,
      expectedAssetIds: { 'mainnet-beta': [expectedId] },
    }), env(), {
      ...quietDependencies(providerFetch),
      log: (entry) => logs.push(entry),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, items: [] });
    assert.equal(logs[0]?.expectedAssetRecoveryFailures, 1);
    assert.equal(logs[0]?.expectedAssetResolved, 0);
  });

  await context.test('attempt timeout is soft and uses one call', async () => {
    let batchCalls = 0;
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'searchAssets') return rpcCursorSearchResult(body, []);
      batchCalls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    };
    const response = await handleRequest(request('/inventory', {
      owner: OWNER,
      expectedAssetIds: { 'mainnet-beta': [expectedId] },
    }), env(), {
      ...quietDependencies(providerFetch),
      expectedAssetRecoveryTimeoutMs: 5,
      providerTimeoutMs: 100,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, items: [] });
    assert.equal(batchCalls, 1);
  });

  await context.test('overall deadline remains fatal during optional recovery', async () => {
    let batchCalls = 0;
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'searchAssets') return rpcCursorSearchResult(body, []);
      batchCalls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    };
    const response = await handleRequest(request('/inventory', {
      owner: OWNER,
      expectedAssetIds: { 'mainnet-beta': [expectedId] },
    }), env(), {
      ...quietDependencies(providerFetch),
      expectedAssetRecoveryTimeoutMs: 100,
      providerTimeoutMs: 10,
    });
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { ok: false, error: 'provider-timeout' });
    assert.equal(batchCalls, 1);
  });

  await context.test('candidate capacity skips the whole cluster result', async () => {
    const logs: Record<string, unknown>[] = [];
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'searchAssets') return rpcCursorSearchResult(body, []);
      return rpcResult(body.id, [
        { ...cardAsset(expectedId, 184), ownership: { owner: OWNER } },
      ]);
    };
    const response = await handleRequest(request('/inventory', {
      owner: OWNER,
      expectedAssetIds: { 'mainnet-beta': [expectedId] },
    }), env(), {
      ...quietDependencies(providerFetch),
      inventoryMaxCandidates: 0,
      log: (entry) => logs.push(entry),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, items: [] });
    assert.equal(logs[0]?.expectedAssetRecoveryFailures, 1);
    assert.equal(logs[0]?.expectedAssetResolved, 0);
  });

  await context.test('response capacity preserves the authoritative grouped result', async () => {
    const indexedId = assetId('expected-budget-indexed');
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'getAssetBatch') {
        return rpcResult(body.id, [
          { ...cardAsset(expectedId, 185), ownership: { owner: OWNER } },
        ]);
      }
      return body.params.grouping[1] === CARD_COLLECTION
        ? rpcCursorSearchResult(body, [cardAsset(indexedId, 184)])
        : rpcCursorSearchResult(body, []);
    };
    const baseline = await handleRequest(request('/inventory'), env(), quietDependencies(providerFetch));
    assert.equal(baseline.status, 200);
    const baselineText = await baseline.text();
    const logs: Record<string, unknown>[] = [];
    const response = await handleRequest(request('/inventory', {
      owner: OWNER,
      expectedAssetIds: { 'mainnet-beta': [expectedId] },
    }), env(), {
      ...quietDependencies(providerFetch),
      inventoryMaxResponseBodyBytes: new TextEncoder().encode(baselineText).byteLength,
      log: (entry) => logs.push(entry),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), baselineText);
    assert.equal(logs[0]?.expectedAssetRecoveryFailures, 1);
    assert.equal(logs[0]?.expectedAssetResolved, 0);
  });
});

test('failed fallbacks and incomplete grouped pagination fail the whole refresh', async () => {
  const failedFallback: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.params?.grouping) return new Response('unavailable', { status: 503 });
    if (body.params.grouping[1] === CARD_COLLECTION) return new Response('unavailable', { status: 503 });
    return rpcCursorSearchResult(body, []);
  };
  const fallbackResponse = await handleRequest(request('/inventory'), env(), quietDependencies(failedFallback));
  assert.equal(fallbackResponse.status, 502);

  let malformedFallbackCalls = 0;
  const malformedFirstResult: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.params?.grouping) {
      malformedFallbackCalls += 1;
      return rpcCursorSearchResult(body, []);
    }
    if (body.params.grouping[1] === CARD_COLLECTION) return rpcResult(body.id, { items: 'invalid' });
    return rpcCursorSearchResult(body, []);
  };
  const malformedResponse = await handleRequest(request('/inventory'), env(), quietDependencies(malformedFirstResult));
  assert.equal(malformedResponse.status, 502);
  assert.equal(malformedFallbackCalls, 0);

  const laterPageFailure: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const collection = body.params?.grouping?.[1];
    if (collection !== CARD_COLLECTION) return rpcCursorSearchResult(body, [unknownAsset(`sentinel-${collection}`, collection)]);
    if (!body.params.cursor) {
      return rpcResult(body.id, {
        cursor: 'later-page',
        limit: body.params.limit,
        total: 1001,
        items: [unknownAsset('unknown-first', CARD_COLLECTION)],
      });
    }
    return rpcError(body.id, -32603, 'permanent provider error');
  };
  const paginationResponse = await handleRequest(request('/inventory'), env(), quietDependencies(laterPageFailure));
  assert.equal(paginationResponse.status, 502);
});

test('inventory follows cursors while treating totals as advisory', async (context) => {
  await context.test('short first page continues via its cursor', async () => {
    const requestedCursors: Array<string | undefined> = [];
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const collection = body.params?.grouping?.[1];
      if (collection !== CARD_COLLECTION) return rpcCursorSearchResult(body, [unknownAsset(`sentinel-${collection}`, collection)]);
      requestedCursors.push(body.params.cursor);
      if (!body.params.cursor) {
        return rpcResult(body.id, {
          cursor: 'short-page-2',
          limit: body.params.limit,
          total: 2,
          items: [unknownAsset('short-page-unknown', CARD_COLLECTION)],
        });
      }
      if (body.params.cursor === 'short-page-2') {
        return rpcResult(body.id, {
          cursor: 'short-page-3',
          limit: body.params.limit,
          total: 1,
          grand_total: 9_999,
          items: [cardAsset('short-page-pack', 184)],
        });
      }
      return rpcResult(body.id, { items: [], total: 0 });
    };
    const response = await handleRequest(request('/inventory'), env(), quietDependencies(providerFetch));
    assert.equal(response.status, 200);
    assert.deepEqual(requestedCursors, [undefined, 'short-page-2', 'short-page-3']);
    assert.deepEqual((await response.json() as any).items.map((item: any) => item.id), [assetId('short-page-pack')]);
  });

  await context.test('rejects a nonempty page without a cursor', async () => {
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const collection = body.params?.grouping?.[1];
      if (collection !== CARD_COLLECTION) return rpcCursorSearchResult(body, [unknownAsset(`sentinel-${collection}`, collection)]);
      return rpcResult(body.id, {
        limit: body.params.limit,
        items: [cardAsset('missing-total-pack', 184)],
      });
    };
    const response = await handleRequest(request('/inventory'), env(), quietDependencies(providerFetch));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, error: 'provider-unavailable' });
  });

  for (const scenario of ['empty', 'duplicate', 'changing-total'] as const) {
    await context.test(`${scenario} second page`, async () => {
      const providerFetch: ProviderFetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        const collection = body.params?.grouping?.[1];
        if (collection !== CARD_COLLECTION) return rpcCursorSearchResult(body, [unknownAsset(`sentinel-${collection}`, collection)]);
        if (!body.params.cursor) {
          return rpcResult(body.id, {
            cursor: 'scenario-page-2',
            limit: body.params.limit,
            total: 2,
            items: [unknownAsset('page-one', CARD_COLLECTION)],
          });
        }
        if (scenario === 'empty') return rpcResult(body.id, { items: [], total: 2 });
        if (scenario === 'duplicate') return rpcResult(body.id, { cursor: 'scenario-page-3', items: [unknownAsset('page-one', CARD_COLLECTION)] });
        if (body.params.cursor === 'scenario-page-2') {
          return rpcResult(body.id, { cursor: 'scenario-page-3', total: 3, items: [unknownAsset('page-two', CARD_COLLECTION)] });
        }
        return rpcResult(body.id, { total: 1, items: [] });
      };
      const response = await handleRequest(request('/inventory'), env(), quietDependencies(providerFetch));
      assert.equal(response.status, scenario === 'duplicate' ? 502 : 200);
    });
  }
});

test('whole-wallet fallback cursor-paginates through more than 1,000 unrelated assets', async () => {
  const fallbackCursors: Array<string | undefined> = [];
  const providerFetch: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.params?.grouping) {
      return body.params.grouping[1] === CARD_COLLECTION
        ? new Response('unavailable', { status: 503 })
        : rpcCursorSearchResult(body, []);
    }
    fallbackCursors.push(body.params.cursor);
    const page = body.params.cursor ? Number(String(body.params.cursor).slice('wallet-'.length)) : 0;
    if (page === 5) return rpcResult(body.id, { items: [] });
    const items = Array.from(
      { length: 250 },
      (_, index) => unknownAsset(`fallback-unrelated-${page}-${index}`, OWNER),
    );
    if (page === 4) items[249] = cardAsset('fallback-whale-pack', 184);
    return rpcResult(body.id, {
      cursor: `wallet-${page + 1}`,
      limit: 250,
      total: page % 2 === 0 ? 1_000 : 1,
      items,
    });
  };
  const response = await handleRequest(request('/inventory'), env(), quietDependencies(providerFetch));
  assert.equal(response.status, 200);
  assert.deepEqual(fallbackCursors, [undefined, 'wallet-1', 'wallet-2', 'wallet-3', 'wallet-4', 'wallet-5']);
  assert.deepEqual((await response.json() as any).items.map((item: any) => item.id), [assetId('fallback-whale-pack')]);
});

test('initial 408 and 504 failures use one required cluster fallback, but an overall deadline does not', async (context) => {
  for (const status of [408, 504]) {
    await context.test(`HTTP ${status}`, async () => {
      let groupedAttempts = 0;
      let fallbackCalls = 0;
      const providerFetch: ProviderFetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        const collection = body.params?.grouping?.[1];
        if (collection === CARD_COLLECTION) {
          groupedAttempts += 1;
          return new Response('provider timeout', { status });
        }
        if (!body.params?.grouping) {
          fallbackCalls += 1;
          return rpcCursorSearchResult(body, [cardAsset(`fallback-${status}`, 184)]);
        }
        return rpcCursorSearchResult(body, [unknownAsset(`sentinel-${collection}`, collection)]);
      };
      const response = await handleRequest(request('/inventory'), env(), quietDependencies(providerFetch));
      assert.equal(response.status, 200);
      assert.equal(groupedAttempts, 2);
      assert.equal(fallbackCalls, 2);
      assert.deepEqual((await response.json() as any).items.map((item: any) => item.id), [assetId(`fallback-${status}`)]);
    });
  }

  await context.test('overall provider deadline', async () => {
    let fallbackCalls = 0;
    const providerFetch: ProviderFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const collection = body.params?.grouping?.[1];
      if (!body.params?.grouping) {
        fallbackCalls += 1;
        return rpcCursorSearchResult(body, []);
      }
      if (collection === CARD_COLLECTION) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      return rpcCursorSearchResult(body, [unknownAsset(`sentinel-${collection}`, collection)]);
    };
    const response = await handleRequest(request('/inventory'), env(), {
      ...quietDependencies(providerFetch),
      providerTimeoutMs: 5,
    });
    assert.equal(response.status, 504);
    assert.equal(fallbackCalls, 0);
  });
});

test('constructed success bodies are rejected when exact Worker-side validation fails', async () => {
  const providerFetch: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const collection = body.params?.grouping?.[1];
    return rpcCursorSearchResult(body, [unknownAsset(`sentinel-${collection}`, collection)]);
  };
  const response = await handleRequest(request('/inventory'), env(), {
    ...quietDependencies(providerFetch),
    validateInventoryResponse: (_value: unknown): _value is never => false,
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: 'provider-unavailable' });
});

test('transient provider errors retry once and provider deadlines return 504', async () => {
  let attempts = 0;
  const retryDelays: number[] = [];
  const retrying: ProviderFetch = async (_input, init) => {
    attempts += 1;
    const body = JSON.parse(String(init?.body));
    if (attempts === 1) return new Response('rate limited', { status: 429 });
    const collection = body.params?.grouping?.[1];
    return rpcCursorSearchResult(body, [unknownAsset(`sentinel-${collection}`, collection)]);
  };
  const retried = await handleRequest(request('/inventory'), env(), {
    ...quietDependencies(retrying),
    randomUint32: () => 17,
    sleep: async (milliseconds) => {
      retryDelays.push(milliseconds);
    },
  });
  assert.equal(retried.status, 200);
  assert.ok(attempts > listShopCollectionQueryRuntimes(false).length);
  assert.deepEqual(retryDelays, [117]);

  const hanging: ProviderFetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const timedOut = await handleRequest(request('/inventory'), env(), {
    ...quietDependencies(hanging),
    providerTimeoutMs: 5,
  });
  assert.equal(timedOut.status, 504);
  assert.deepEqual(await timedOut.json(), { ok: false, error: 'provider-timeout' });
});

test('fresh attempt budgets allow multi-wave inventory work beyond one attempt window', async () => {
  const startedAt = performance.now();
  const providerFetch: ProviderFetch = async (_input, init) => {
    await new Promise((resolve) => setTimeout(resolve, 4));
    const body = JSON.parse(String(init?.body));
    const collection = body.params?.grouping?.[1];
    return rpcCursorSearchResult(body, [unknownAsset(`fresh-${collection}`, collection)]);
  };
  const response = await handleRequest(request('/inventory'), env(), {
    ...quietDependencies(providerFetch),
    providerAttemptTimeoutMs: 10,
    providerTimeoutMs: 100,
  });
  assert.equal(response.status, 200);
  assert.ok(performance.now() - startedAt > 10);
});

test('provider deadlines while reading streamed inventory and pending bodies return 504', async () => {
  for (const pathname of ['/inventory', '/pending-open-boxes'] as const) {
    const hangingBody: ProviderFetch = async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener(
          'abort',
          () => controller.error(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      },
    }));
    const response = await handleRequest(request(pathname), env(), {
      ...quietDependencies(hangingBody),
      providerTimeoutMs: 5,
    });
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { ok: false, error: 'provider-timeout' });
  }
});

function u32Le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64Le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function buildPendingRecord(
  owner: PublicKey,
  boxAsset: PublicKey,
  dudeAssets: readonly PublicKey[],
  config?: PublicKey,
): string {
  const bytes = new Uint8Array([
    ...PENDING_OPEN_BOX_DISCRIMINATOR,
    ...owner.toBytes(),
    ...boxAsset.toBytes(),
    ...u32Le(dudeAssets.length),
    ...dudeAssets.flatMap((asset) => Array.from(asset.toBytes())),
    ...u64Le(123n),
    9,
    ...(config ? config.toBytes() : []),
  ]);
  return Buffer.from(bytes).toString('base64');
}

test('pending opens keep valid legacy rows while omitting count-mismatched and non-openable records', async () => {
  const owner = new PublicKey(OWNER);
  const boxAsset = PublicKey.findProgramAddressSync([Buffer.from('shop-api-box')], PublicKey.default)[0];
  const mismatchedBoxAsset = PublicKey.findProgramAddressSync([Buffer.from('shop-api-mismatched-box')], PublicKey.default)[0];
  const nonOpenableBoxAsset = PublicKey.findProgramAddressSync([Buffer.from('shop-api-non-openable-box')], PublicKey.default)[0];
  const dudeAssets = Array.from({ length: 3 }, (_, index) =>
    PublicKey.findProgramAddressSync([Buffer.from(`shop-api-dude-${index}`)], PublicKey.default)[0]);
  const mismatchedDudeAssets = Array.from({ length: 2 }, (_, index) =>
    PublicKey.findProgramAddressSync([Buffer.from(`shop-api-mismatched-dude-${index}`)], PublicKey.default)[0]);
  const sharedScope = listShopPendingOpenProgramScopes(false).find((scope) => scope.drops.length > 1);
  assert.ok(sharedScope);
  const nonOpenableDrop = sharedScope.drops.find((drop) => drop.dropId === 'drifella_shirt');
  assert.ok(nonOpenableDrop?.boxMinterConfigPda);
  const nonOpenableConfig = new PublicKey(nonOpenableDrop.boxMinterConfigPda);
  let batchCalls = 0;
  const providerFetch: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'getProgramAccounts') {
      assert.equal(body.params[1].commitment, 'confirmed');
      return rpcResult(body.id, body.params[0] === sharedScope.boxMinterProgramId ? [
        {
          pubkey: PublicKey.findProgramAddressSync([Buffer.from('shop-api-pending')], PublicKey.default)[0].toBase58(),
          account: { data: [buildPendingRecord(owner, boxAsset, dudeAssets), 'base64'] },
        },
        {
          pubkey: PublicKey.findProgramAddressSync([Buffer.from('shop-api-mismatched-pending')], PublicKey.default)[0].toBase58(),
          account: { data: [buildPendingRecord(owner, mismatchedBoxAsset, mismatchedDudeAssets), 'base64'] },
        },
        {
          pubkey: PublicKey.findProgramAddressSync([Buffer.from('shop-api-non-openable-pending')], PublicKey.default)[0].toBase58(),
          account: { data: [buildPendingRecord(owner, nonOpenableBoxAsset, [], nonOpenableConfig), 'base64'] },
        },
      ] : []);
    }
    if (body.method === 'getAssetBatch') {
      batchCalls += 1;
      assert.deepEqual(body.params.ids, [mismatchedBoxAsset.toBase58()]);
      assert.deepEqual(body.params.options, { showUnverifiedCollections: true });
      assert.equal(Object.hasOwn(body.params.options, 'showGrandTotal'), false);
      const mismatchedTarget = sharedScope.drops.find((drop) => drop.dropId === 'drifella_shirt');
      assert.ok(mismatchedTarget);
      return rpcResult(body.id, [
        {
          id: mismatchedBoxAsset.toBase58(),
          grouping: [{ group_key: 'collection', group_value: mismatchedTarget.collectionMint }],
          content: { json_uri: `${mismatchedTarget.metadataBase}/b1.json`, metadata: { name: 'shirt 1' } },
        },
      ]);
    }
    return rpcResult(body.id, null);
  };
  const response = await handleRequest(request('/pending-open-boxes'), env(), quietDependencies(providerFetch));
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(batchCalls, 1);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].dropId, 'card_nft_2');
  assert.equal(payload.items[0].createdSlot, 123);
});

test('pending opens fail closed on malformed required program records and candidate identifiers', async (context) => {
  const owner = new PublicKey(OWNER);
  const otherOwner = PublicKey.findProgramAddressSync([Buffer.from('shop-api-other-owner')], PublicKey.default)[0];
  const boxAsset = PublicKey.findProgramAddressSync([Buffer.from('shop-api-malformed-box')], PublicKey.default)[0];
  const dudeAsset = PublicKey.findProgramAddressSync([Buffer.from('shop-api-malformed-dude')], PublicKey.default)[0];
  const pendingPda = PublicKey.findProgramAddressSync([Buffer.from('shop-api-malformed-pending')], PublicKey.default)[0].toBase58();
  const sharedScope = listShopPendingOpenProgramScopes(false).find((scope) => scope.drops.length > 1);
  assert.ok(sharedScope);
  const validData = buildPendingRecord(owner, boxAsset, [dudeAsset]);
  const scenarios: Array<{ name: string; entry: unknown }> = [
    {
      name: 'undecodable account data',
      entry: {
        pubkey: pendingPda,
        account: {
          data: [Buffer.from([...PENDING_OPEN_BOX_DISCRIMINATOR, ...owner.toBytes()]).toString('base64'), 'base64'],
        },
      },
    },
    {
      name: 'missing pending PDA',
      entry: { account: { data: [validData, 'base64'] } },
    },
    {
      name: 'invalid pending PDA',
      entry: { pubkey: 'not-a-solana-address', account: { data: [validData, 'base64'] } },
    },
    {
      name: 'owner inconsistent with the filtered query',
      entry: {
        pubkey: pendingPda,
        account: { data: [buildPendingRecord(otherOwner, boxAsset, [dudeAsset]), 'base64'] },
      },
    },
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const providerFetch: ProviderFetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method !== 'getProgramAccounts') throw new Error('unexpected provider method');
        return rpcResult(body.id, body.params[0] === sharedScope.boxMinterProgramId ? [scenario.entry] : []);
      };
      const response = await handleRequest(request('/pending-open-boxes'), env(), quietDependencies(providerFetch));
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { ok: false, error: 'provider-unavailable' });
    });
  }
});

test('pending opens intentionally filter structurally valid records for unknown shared-program configs', async () => {
  const owner = new PublicKey(OWNER);
  const boxAsset = PublicKey.findProgramAddressSync([Buffer.from('shop-api-unknown-config-box')], PublicKey.default)[0];
  const dudeAsset = PublicKey.findProgramAddressSync([Buffer.from('shop-api-unknown-config-dude')], PublicKey.default)[0];
  const pendingPda = PublicKey.findProgramAddressSync([Buffer.from('shop-api-unknown-config-pending')], PublicKey.default)[0].toBase58();
  const unknownConfig = PublicKey.findProgramAddressSync([Buffer.from('shop-api-unknown-config')], PublicKey.default)[0];
  const sharedScope = listShopPendingOpenProgramScopes(false).find((scope) => scope.drops.length > 1);
  assert.ok(sharedScope);
  assert.equal(sharedScope.drops.some((drop) => drop.boxMinterConfigPda === unknownConfig.toBase58()), false);
  let batchCalls = 0;
  const providerFetch: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'getProgramAccounts') {
      return rpcResult(body.id, body.params[0] === sharedScope.boxMinterProgramId ? [{
        pubkey: pendingPda,
        account: { data: [buildPendingRecord(owner, boxAsset, [dudeAsset], unknownConfig), 'base64'] },
      }] : []);
    }
    if (body.method === 'getAssetBatch') batchCalls += 1;
    return rpcResult(body.id, []);
  };
  const response = await handleRequest(request('/pending-open-boxes'), env(), quietDependencies(providerFetch));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, items: [] });
  assert.equal(batchCalls, 0);
});

test('pending opens omit missing or unresolved assets but reject unexpected and duplicate identifiers', async (context) => {
  const owner = new PublicKey(OWNER);
  const boxAsset = PublicKey.findProgramAddressSync([Buffer.from('shop-api-ambiguous-box')], PublicKey.default)[0];
  const dudeAssets = Array.from({ length: 2 }, (_, index) =>
    PublicKey.findProgramAddressSync([Buffer.from(`shop-api-ambiguous-dude-${index}`)], PublicKey.default)[0]);
  const otherAsset = PublicKey.findProgramAddressSync([Buffer.from('shop-api-other-asset')], PublicKey.default)[0];
  const pendingPda = PublicKey.findProgramAddressSync([Buffer.from('shop-api-ambiguous-pending')], PublicKey.default)[0].toBase58();
  const sharedScope = listShopPendingOpenProgramScopes(false).find((scope) => scope.drops.length > 1);
  assert.ok(sharedScope);
  const scenarios: Array<{ name: string; assets: unknown[]; status: 200 | 502 }> = [
    { name: 'missing requested asset', assets: [], status: 200 },
    { name: 'unresolved requested asset', assets: [unknownAsset(boxAsset.toBase58(), OWNER)], status: 200 },
    { name: 'mismatched asset identifier', assets: [unknownAsset(otherAsset.toBase58(), OWNER)], status: 502 },
    {
      name: 'duplicate requested asset identifier',
      assets: [
        unknownAsset(boxAsset.toBase58(), OWNER),
        unknownAsset(boxAsset.toBase58(), OWNER),
      ],
      status: 502,
    },
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      let batchCalls = 0;
      const providerFetch: ProviderFetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === 'getProgramAccounts') {
          return rpcResult(body.id, body.params[0] === sharedScope.boxMinterProgramId ? [{
            pubkey: pendingPda,
            account: { data: [buildPendingRecord(owner, boxAsset, dudeAssets), 'base64'] },
          }] : []);
        }
        if (body.method === 'getAssetBatch') {
          batchCalls += 1;
          assert.deepEqual(body.params.ids, [boxAsset.toBase58()]);
          return rpcResult(body.id, scenario.assets);
        }
        throw new Error('unexpected provider method');
      };
      const response = await handleRequest(request('/pending-open-boxes'), env(), quietDependencies(providerFetch));
      assert.equal(response.status, scenario.status);
      assert.deepEqual(
        await response.json(),
        scenario.status === 200
          ? { ok: true, items: [] }
          : { ok: false, error: 'provider-unavailable' },
      );
      assert.equal(batchCalls, 1);
    });
  }
});
