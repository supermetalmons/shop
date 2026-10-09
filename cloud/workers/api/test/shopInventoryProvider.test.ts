import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { defaultDependencies, type ProviderFetch } from '../src/publicRouteSupport.ts';
import { heliusRpc, ProviderFailure, ProviderReadGate, type ProviderContext } from '../src/shopInventoryProvider.ts';

function fixture(t: TestContext, providerFetch: ProviderFetch) {
  let now = 1000;
  const controller = new AbortController();
  const delays: number[] = [];
  t.mock.method(performance, 'now', () => now);
  const context: ProviderContext = {
    apiKey: 'test-key', signal: controller.signal,
    dependencies: { ...defaultDependencies, providerFetch, randomUint32: () => 17,
      sleep: async (delay, signal) => { signal.throwIfAborted(); delays.push(delay); now += delay; } },
    metrics: { upstreamCalls: 0, providerDurationMs: 0, expectedAssetIds: 0, expectedAssetRecoveryFailures: 0, expectedAssetResolved: 0 },
    providerResponseBodyBytes: 0, inventoryCandidates: 0, inventoryCursorPages: 0, inventoryProviderCalls: 0,
    providerReadGate: new ProviderReadGate(),
  };
  return { context, controller, delays, advance: (milliseconds: number) => { now += milliseconds; } };
}

test('an extended shared cooldown delays the request until the new deadline', async t => {
  let sentAt = 0;
  const f = fixture(t, async (_input, init) => {
    sentAt = performance.now();
    return Response.json({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, result: [] });
  });
  f.context.rateLimitUntil = 2000;
  f.context.dependencies.sleep = async (delay, signal) => {
    signal.throwIfAborted();
    f.delays.push(delay);
    f.advance(delay);
    if (f.delays.length === 1) f.context.rateLimitUntil = 3000;
  };
  await heliusRpc(f.context, 'mainnet-beta', 'searchAssets', {}, { inventoryCall: true });
  assert.deepEqual(f.delays, [1000, 1000]);
  assert.equal(sentAt, 3000);
  assert.equal(f.context.inventoryProviderCalls, 1);
});

test('inventory rate limiting retries the same cursor with exponential backoff and bounded calls', async t => {
  const requests: { id: string; params: unknown }[] = [];
  const f = fixture(t, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return requests.length < 4 ? new Response(null, { status: 429 })
      : Response.json({ jsonrpc: '2.0', id: body.id, result: { items: [] } });
  });
  const params = { ownerAddress: 'owner', cursor: 'previous-page', limit: 250 };
  assert.deepEqual(await heliusRpc(f.context, 'mainnet-beta', 'searchAssets', params, { inventoryCall: true }), { items: [] });
  assert.deepEqual(requests.map(r => r.params), Array(4).fill(params));
  assert.deepEqual(f.delays, [1017, 2017, 4017]);
  assert.equal(f.context.inventoryProviderCalls, 4);
  assert.equal(f.context.metrics.inventoryRateLimitRetries, 3);
});

test('HTTP and JSON-RPC rate limits stop after four attempts without relaxing the slot floor', async t => {
  for (const rpc of [false, true]) {
    let calls = 0;
    const f = fixture(t, async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.params[1].minContextSlot, 500);
      return rpc ? Response.json({ jsonrpc: '2.0', id: body.id, error: { code: 429, message: 'rate limited' } })
        : new Response(null, { status: 429 });
    });
    await assert.rejects(heliusRpc(f.context, 'mainnet-beta', 'getMultipleAccounts', [[], { minContextSlot: 500 }]),
      error => error instanceof ProviderFailure && error.kind === 'rate-limit');
    assert.equal(calls, 4);
    assert.equal(f.delays.length, 3);
  }
});

test('explicit recovery attempt limits are honored and their cooldown is shared with the next read', async t => {
  let calls = 0;
  const f = fixture(t, async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    return calls === 1 ? new Response(null, { status: 429, headers: { 'Retry-After': '2' } })
      : Response.json({ jsonrpc: '2.0', id: body.id, result: [] });
  });
  await assert.rejects(heliusRpc(f.context, 'mainnet-beta', 'getAssetBatch', {}, { maxAttempts: 1 }),
    error => error instanceof ProviderFailure && error.kind === 'rate-limit');
  assert.equal(calls, 1);
  assert.deepEqual(f.delays, []);
  await heliusRpc(f.context, 'mainnet-beta', 'searchAssets', {});
  assert.deepEqual(f.delays, [2000]);
  assert.equal(calls, 2);
});

test('rate-limit cooldown honors an HTTP date and cannot outlive cancellation', async t => {
  const wallTime = Date.parse('2026-10-10T00:00:00Z');
  t.mock.method(Date, 'now', () => wallTime);
  let calls = 0;
  const f = fixture(t, async () => {
    calls += 1;
    return new Response(null, { status: 429, headers: { 'Retry-After': new Date(wallTime + 3000).toUTCString() } });
  });
  const reason = new Error('request cancelled');
  f.context.dependencies.sleep = async (delay, signal) => {
    assert.equal(delay, 3000);
    f.controller.abort(reason);
    signal.throwIfAborted();
  };
  await assert.rejects(heliusRpc(f.context, 'mainnet-beta', 'searchAssets', {}), error => error === reason);
  assert.equal(calls, 1);
});

test('rate-limit retries remain inside the inventory provider-call budget', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls += 1; return new Response(null, { status: 429 }); });
  f.context.dependencies.inventoryMaxProviderCalls = 2;
  await assert.rejects(heliusRpc(f.context, 'mainnet-beta', 'searchAssets', {}, { inventoryCall: true }),
    error => error instanceof ProviderFailure && error.kind === 'limit');
  assert.equal(calls, 2);
});
