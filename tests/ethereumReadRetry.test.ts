import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryObserver, type QueryFunctionContext } from '@tanstack/react-query';
import { ethereumApi, EthereumApiError } from '../src/ethereum/api.ts';
import { pre111kApi } from '../src/ethereum/pre111kApi.ts';
import { EthereumNetworkError, requestEthereumJson } from '../src/ethereum/request.ts';
import { ethereumRetryAfterMs } from '../src/ethereum/retryAfter.ts';
import { ethereumReadCanRefetch, ethereumReadRefetchInterval, ethereumReadRetry,
  ethereumReadRetryDelay, ethereumReadRetryOptions, runEthereumRead } from '../src/ethereum/readRetry.ts';

const NOW = 1_800_000_000_000;
const unavailable = (hint: number | null = null) => new EthereumApiError(503, 'Temporarily unavailable.', 'unavailable', null, hint);
async function settled() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

test('read retry hints use the larger valid seconds, HTTP-date or body delay', () => {
  assert.equal(ethereumRetryAfterMs('2', 500, NOW), 2_000);
  assert.equal(ethereumRetryAfterMs('0.5', 2_500, NOW), 2_500);
  assert.equal(ethereumRetryAfterMs(new Date(NOW + 10_000).toUTCString(), 500, NOW), 10_000);
  assert.equal(ethereumRetryAfterMs(new Date(NOW - 10_000).toUTCString(), 500, NOW), 500);
  assert.equal(ethereumRetryAfterMs(' 1.25 ', undefined, NOW), 1_250);
  for (const invalid of ['', 'invalid', '-1', '1e999', String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(ethereumRetryAfterMs(invalid, -1, NOW), null);
  }
  assert.equal(ethereumRetryAfterMs(null, Infinity, NOW), null);
});

test('Ethereum and pre111k API errors preserve absolute retry deadlines without replaying', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: {
    code: 'unavailable', message: 'Busy', details: { retryAfterMs: 2_500 },
  } }, { status: 503, headers: { 'Retry-After': '1' } }));
  for (const read of [() => ethereumApi.config(), () => pre111kApi.status('mainnet', null)]) {
    await assert.rejects(read(), error => error instanceof EthereumApiError &&
      error.retryAfterMs === 2_500 && error.retryAtMs === NOW + 2_500);
  }
  assert.equal(request.mock.callCount(), 2);
});

test('public read retry eligibility excludes permanent, malformed and cancellation failures', () => {
  for (const status of [429, 502, 503, 504]) {
    assert.equal(ethereumReadRetry(0, new EthereumApiError(status, 'Temporary')), true);
    assert.equal(ethereumReadRetry(1, new EthereumApiError(status, 'Temporary')), true);
    assert.equal(ethereumReadRetry(2, new EthereumApiError(status, 'Temporary')), false);
  }
  assert.equal(ethereumReadRetry(0, new EthereumNetworkError(new TypeError('Failed to fetch'))), true);
  assert.equal(ethereumReadRetry(0, new DOMException('Timed out', 'TimeoutError')), true);
  for (const error of [new DOMException('Cancelled', 'AbortError'), new Error('Connection lost'),
    new SyntaxError('Invalid JSON'), new TypeError('Invalid response'),
    ...[400, 401, 403, 404, 409, 412, 500].map(status => new EthereumApiError(status, 'Permanent')),
    ...['transaction-reverted', 'invalid-argument', 'aborted', 'unauthenticated'].map(code => new EthereumApiError(503, 'Permanent', code))]) {
    assert.equal(ethereumReadRetry(0, error), false);
  }
});

test('retry delays use one and two seconds, positive jitter, and absolute hint precedence', async t => {
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  const random = t.mock.method(Math, 'random', () => 0);
  assert.equal(ethereumReadRetryDelay(0, unavailable()), 1_000);
  assert.equal(ethereumReadRetryDelay(1, unavailable()), 2_000);
  random.mock.mockImplementation(() => 0.999999);
  assert.equal(ethereumReadRetryDelay(0, unavailable()), 1_250);
  assert.equal(ethereumReadRetryDelay(1, unavailable()), 2_250);
  const error = unavailable(5_000);
  now += 1_000;
  assert.equal(ethereumReadRetryDelay(0, error), 4_250);
});

test('long hints defer polling and focus refresh without moving the cooldown deadline', t => {
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  const error = unavailable(60_000);
  const query = { state: { error } };
  assert.equal(ethereumReadRetry(0, error), false);
  assert.equal(ethereumReadCanRefetch(query), false);
  assert.equal(ethereumReadRetryOptions.retryOnMount(query), false);
  assert.equal(ethereumReadRetryOptions.refetchOnReconnect(query), false);
  assert.equal(ethereumReadRefetchInterval(query, 30_000), 60_000);
  assert.equal(ethereumReadRefetchInterval(query, false), 60_000);
  now += 45_000;
  assert.equal(error.retryAtMs, NOW + 60_000);
  assert.equal(ethereumReadCanRefetch(query), false);
  assert.equal(ethereumReadRefetchInterval(query, 30_000), 30_000);
  now += 15_000;
  assert.equal(ethereumReadCanRefetch(query), true);
  assert.equal(ethereumReadRefetchInterval(query, false), false);
  for (const healthy of [3_000, 4_000, 10_000, 30_000, 60_000, false] as const) {
    assert.equal(ethereumReadRefetchInterval({ state: { error: null } }, healthy), healthy);
  }
  assert.equal(ethereumReadRefetchInterval({ state: { error: new SyntaxError('Malformed') } }, 30_000), false);
});

test('read cooldowns survive local cache updates without renewing their deadline or crossing query scopes', async t => {
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  const otherClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  t.after(() => { client.clear(); otherClient.clear(); });
  const queryKey = ['read', 'wallet-a'];
  const error = unavailable(60_000);
  let requests = 0;
  const fetch = () => client.fetchQuery({ queryKey, queryFn: context => runEthereumRead(context, async () => {
    requests++;
    if (requests === 1) throw error;
    return 'fresh';
  }) });
  await assert.rejects(fetch(), value => value === error);
  client.setQueryData(queryKey, 'confirmed locally');
  const query = client.getQueryCache().find({ queryKey, exact: true })!;
  assert.equal(query.state.error, null);
  assert.equal(ethereumReadCanRefetch(query), false);
  assert.equal(ethereumReadRefetchInterval(query, false), 60_000);
  await assert.rejects(fetch(), value => value === error);
  now += 59_999;
  await assert.rejects(fetch(), value => value === error);
  assert.equal(requests, 1);
  assert.equal(client.getQueryData(queryKey), 'confirmed locally');
  assert.equal(error.retryAtMs, NOW + 60_000);
  assert.equal(await client.fetchQuery({ queryKey: ['read', 'wallet-b'],
    queryFn: context => runEthereumRead(context, async () => 'other wallet') }), 'other wallet');
  assert.equal(await otherClient.fetchQuery({ queryKey,
    queryFn: context => runEthereumRead(context, async () => 'other client') }), 'other client');
  now++;
  assert.equal(ethereumReadRefetchInterval(query, false), 1_000);
  for (const fetchStatus of ['fetching', 'paused'] as const) {
    query.setState({ fetchStatus });
    assert.equal(ethereumReadRefetchInterval(query, false), false);
  }
  query.setState({ fetchStatus: 'idle' });
  assert.equal(await fetch(), 'fresh');
  assert.equal(requests, 2);
  assert.equal(ethereumReadRefetchInterval(query, false), false);
});

test('invalidating a warm retry cannot bypass its in-progress failure hint', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  t.mock.method(Math, 'random', () => 0);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const queryKey = ['read', 'retrying'];
  client.setQueryData(queryKey, 'last good');
  const error = unavailable(5_000);
  let requests = 0;
  const options = { ...ethereumReadRetryOptions, queryKey,
    queryFn: (context: QueryFunctionContext) => runEthereumRead(context, async () => { if (++requests === 1) throw error; return 'fresh'; }) };
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  t.after(() => { unsubscribe(); client.clear(); });
  await settled();
  assert.equal(client.getQueryState(queryKey)?.error, null);
  assert.equal(client.getQueryState(queryKey)?.fetchFailureReason, error);
  const second = client.invalidateQueries({ queryKey });
  await settled();
  assert.equal(requests, 1);
  t.mock.timers.tick(4_999);
  await settled();
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  await second;
  assert.equal(client.getQueryData(queryKey), 'fresh');
  assert.equal(requests, 2);
});

test('a cancelled late failure cannot add a cooldown after a newer read succeeds', async t => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  t.after(() => client.clear());
  const queryKey = ['read', 'cancelled'];
  const old = Promise.withResolvers<string>();
  const first = client.fetchQuery({ queryKey, queryFn: context => runEthereumRead(context, () => old.promise) }).catch(error => error);
  await settled();
  await client.cancelQueries({ queryKey });
  await first;
  assert.equal(await client.fetchQuery({ queryKey, queryFn: context => runEthereumRead(context, async () => 'new') }), 'new');
  old.reject(unavailable(60_000));
  await settled();
  assert.equal(await client.fetchQuery({ queryKey, queryFn: context => runEthereumRead(context, async () => 'latest') }), 'latest');
});

test('a cancelled late success cannot erase a newer cooldown', async t => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  t.after(() => client.clear());
  const queryKey = ['read', 'cancelled-success'];
  const old = Promise.withResolvers<string>();
  const first = client.fetchQuery({ queryKey, queryFn: context => runEthereumRead(context, () => old.promise) }).catch(error => error);
  await settled();
  await client.cancelQueries({ queryKey });
  await first;
  const error = unavailable(60_000);
  await assert.rejects(client.fetchQuery({ queryKey,
    queryFn: context => runEthereumRead(context, async () => { throw error; }) }), value => value === error);
  old.resolve('late');
  await settled();
  await assert.rejects(client.fetchQuery({ queryKey,
    queryFn: context => runEthereumRead(context, async () => assert.fail('Must retain the newer cooldown')) }), value => value === error);
});

test('a query makes exactly three attempts and retains its last complete data after failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  t.mock.method(Math, 'random', () => 0);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  t.after(() => client.clear());
  const key = ['read-retry', 'last-good'];
  const lastGood = { items: ['retained'] };
  client.setQueryData(key, lastGood);
  let attempts = 0;
  const failed = client.fetchQuery({ ...ethereumReadRetryOptions, queryKey: key,
    queryFn: async () => { attempts++; throw unavailable(); } }).catch(error => error);
  await settled();
  assert.equal(attempts, 1);
  t.mock.timers.tick(999);
  await settled();
  assert.equal(attempts, 1);
  t.mock.timers.tick(1);
  await settled();
  assert.equal(attempts, 2);
  t.mock.timers.tick(2_000);
  await settled();
  assert.ok(await failed instanceof EthereumApiError);
  assert.equal(attempts, 3);
  assert.equal(client.getQueryData(key), lastGood);
  t.mock.timers.tick(30_000);
  await settled();
  assert.equal(attempts, 3);
});

test('query cancellation during retry backoff aborts its signal and prevents another attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  t.mock.method(Math, 'random', () => 0);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  t.after(() => client.clear());
  const key = ['read-retry', 'cancelled-wallet'];
  let attempts = 0;
  let signal: AbortSignal | undefined;
  const pending = client.fetchQuery({ ...ethereumReadRetryOptions, queryKey: key,
    queryFn: async context => { signal = context.signal; attempts++; throw unavailable(); } }).catch(error => error);
  await settled();
  await client.cancelQueries({ queryKey: key });
  await pending;
  assert.equal(signal?.aborted, true);
  t.mock.timers.tick(30_000);
  await settled();
  assert.equal(attempts, 1);
});

test('network fetch errors are marked while caller aborts and malformed successes remain unmodified', async t => {
  const network = new TypeError('Failed to fetch');
  const provider = t.mock.method(globalThis, 'fetch', async () => { throw network; });
  await assert.rejects(requestEthereumJson('/read', {}), error => error instanceof EthereumNetworkError && error.cause === network);
  const controller = new AbortController();
  const cancelled = new Error('Wallet changed');
  controller.abort(cancelled);
  await assert.rejects(requestEthereumJson('/read', { signal: controller.signal }), error => error === cancelled);
  provider.mock.mockImplementation(async () => new Response('{', { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(requestEthereumJson('/read', {}), error => error instanceof SyntaxError && !ethereumReadRetry(0, error));
  provider.mock.mockImplementation(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('Connection lost after headers')); },
  }), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(requestEthereumJson('/read', {}), error => error instanceof EthereumNetworkError && ethereumReadRetry(0, error));
  provider.mock.mockImplementation(async () => new Response('Bad gateway', { status: 502 }));
  await assert.rejects(ethereumApi.config(), error => error instanceof EthereumApiError && error.status === 502 && ethereumReadRetry(0, error));
});

test('preparation and transaction confirmation POSTs remain single-attempt on transient failures', async t => {
  const provider = t.mock.method(globalThis, 'fetch', async (_input, init) => {
    assert.equal(init?.method, 'POST');
    return Response.json({ error: { code: 'unavailable', message: 'Busy' } }, { status: 503, headers: { 'Retry-After': '1' } });
  });
  const wallet = `0x${'11'.repeat(20)}`;
  const hash = `0x${'22'.repeat(32)}`;
  await assert.rejects(pre111kApi.prepare('devnet', wallet, 'code'), EthereumApiError);
  await assert.rejects(pre111kApi.confirm('devnet', wallet, hash), EthereumApiError);
  assert.equal(provider.mock.callCount(), 2);
});
