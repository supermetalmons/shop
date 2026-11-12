import assert from 'node:assert/strict';
import test from 'node:test';
import { createEthereumProviderAttempt, ethereumProviderApiError, ethereumProviderCost, fetchAlchemyNft,
  RpcProviderError, withEthereumProvider, type EthereumProviderEnvironment, type EthereumProviderMetrics } from '../src/ethereumProvider.ts';
import { ProviderBudgetClient, ProviderBudgetUnavailable, type ProviderBudgetNamespace } from '../src/ethereumProviderBudget.ts';
import { EthereumApiError, ethereumErrorResponse } from '../src/ethereumError.ts';

const env: EthereumProviderEnvironment = { ALCHEMY_MI_NOTE_API_KEY: 'fixture',
  QUICKNODE_ETHEREUM_MAINNET_ENABLED: 'true', QUICKNODE_ETHEREUM_MAINNET_RPC_URL: 'https://fixture.quiknode.pro/fixture/' };
const signal = () => AbortSignal.timeout(2_000);
const response = (result: unknown, id = 1) => Response.json({ jsonrpc: '2.0', id, result });

function budget(deny: (provider: string) => number | null = () => null) {
  const calls: Array<{ provider: string; minimum: number; lane: string }> = [];
  const throttles: Array<{ provider: string; retryAfterMs: number }> = [];
  const namespace: ProviderBudgetNamespace = { getByName: () => ({
    async grant(request) {
      calls.push(request);
      const now = Date.now(), retry = deny(request.provider);
      return { granted: retry === null ? request.minimum : 0, issuedAtMs: now,
        expiresAtMs: now + (request.provider === 'alchemy' ? 250 : 100), retryAfterMs: retry ?? 0 };
    },
    async reportThrottle(request) { throttles.push(request); },
  }) };
  return { calls, throttles, namespace };
}

test('Ethereum throughput weights count each operation and reject unknown methods', () => {
  assert.equal(ethereumProviderCost('eth_call', 'alchemy'), 26);
  assert.equal(ethereumProviderCost('eth_chainId', 'alchemy'), 5);
  assert.equal(ethereumProviderCost('eth_getLogs', 'quicknode'), 1);
  assert.throws(() => ethereumProviderCost('eth_sendRawTransaction', 'alchemy'), /not configured/);
});

test('fast complete provider operation does not invoke QuickNode', async () => {
  const urls: string[] = [];
  const result = await withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    lane: 'reveal', hedgeMs: 300, fetch: async input => { urls.push(String(input)); return response('0x1'); },
  });
  assert.equal(result, '0x1');
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('alchemy.com'));
});

test('provider failure restarts the entire operation on one secondary', async () => {
  const calls: string[] = [];
  const result = await withEthereumProvider(env, 1, signal(), async attempt => {
    assert.equal(await attempt.rpc('eth_chainId', []), '0x1');
    return attempt.rpc('eth_getTransactionReceipt', ['0xfixture']);
  }, { fetch: async (input, init) => {
    const { method } = JSON.parse(String(init?.body));
    const primary = String(input).includes('alchemy.com');
    calls.push(`${primary ? 'primary' : 'secondary'}:${method}`);
    if (method === 'eth_chainId') return response('0x1');
    return primary ? new Response('', { status: 503 }) : response({ blockNumber: '0x1' });
  } });
  assert.deepEqual(result, { blockNumber: '0x1' });
  assert.deepEqual(calls, ['primary:eth_chainId', 'primary:eth_getTransactionReceipt', 'secondary:eth_chainId', 'secondary:eth_getTransactionReceipt']);
});

for (const error of [
  { code: -32603, message: 'internal server error' },
  { code: -32000, message: 'Request timed out. Client should retry.' },
]) test(`HTTP 200 RPC failure restarts the whole operation on QuickNode: ${error.message}`, async () => {
  const b = budget();
  const calls: string[] = [];
  const metrics: EthereumProviderMetrics[] = [];
  const result = await withEthereumProvider(env, 1, signal(), async attempt => {
    assert.equal(await attempt.rpc('eth_chainId', []), '0x1');
    return attempt.rpc('eth_getTransactionReceipt', ['0xfixture']);
  }, { budgetClient: new ProviderBudgetClient(b.namespace), onMetrics: value => metrics.push(value), fetch: async (input, init) => {
    const { method } = JSON.parse(String(init?.body));
    const primary = String(input).includes('alchemy.com');
    calls.push(`${primary ? 'primary' : 'secondary'}:${method}`);
    if (method === 'eth_chainId') return response('0x1');
    return primary ? Response.json({ jsonrpc: '2.0', id: 1, error }) : response({ blockNumber: '0x1' });
  } });
  assert.deepEqual(result, { blockNumber: '0x1' });
  assert.deepEqual(calls, ['primary:eth_chainId', 'primary:eth_getTransactionReceipt', 'secondary:eth_chainId', 'secondary:eth_getTransactionReceipt']);
  assert.equal(metrics[0].secondaryReason, 'transport');
  assert.equal(metrics[0].winner, 'quicknode');
  assert.deepEqual(b.throttles, []);
});

for (const error of [
  { code: -32603, message: 'Internal error' },
  { code: -32603, message: 'Request timed out. Client should retry.' },
  { code: -32000, message: 'Unable to complete request at this time.' },
  { code: -32099, message: 'Unable to complete request at this time.' },
]) test(`documented RPC server failures are retryable without a throttle cooldown: ${error.code} ${error.message}`, async () => {
  const b = budget();
  const attempt = createEthereumProviderAttempt(env, 1, 'quicknode', signal(), {
    budgetClient: new ProviderBudgetClient(b.namespace),
    fetch: async () => Response.json({ jsonrpc: '2.0', id: 1, error }, { headers: { 'Retry-After': '3' } }),
  });
  await assert.rejects(attempt.rpc('eth_call', [{}, 'latest']), failure =>
    failure instanceof RpcProviderError && failure.kind === 'transport' && failure.retryable && failure.retryAfterMs === 3_000);
  assert.deepEqual(b.throttles, []);
});

for (const error of [
  { code: -32602, message: 'Invalid params' },
  { code: -32602, message: 'Request timed out. Client should retry.' },
  { code: -32603, message: 'Invalid payload' },
  { code: -32000, message: 'invalid argument 0: invalid hex string' },
  { code: '-32603', message: 'internal server error' },
]) test(`nontransient RPC errors do not invoke QuickNode: ${error.code} ${error.message}`, async () => {
  let calls = 0;
  await assert.rejects(withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_call', [{}, 'latest']), {
    fetch: async () => { calls++; return Response.json({ jsonrpc: '2.0', id: 1, error }); },
  }), failure => failure instanceof RpcProviderError && failure.kind === 'response' && !failure.retryable);
  assert.equal(calls, 1);
});

test('a response stream failure restarts the complete read on the secondary provider', async () => {
  const calls: string[] = [];
  const result = await withEthereumProvider(env, 1, signal(), async attempt => {
    assert.equal(await attempt.rpc('eth_chainId', []), '0x1');
    return attempt.rpc('eth_getTransactionReceipt', ['0xfixture']);
  }, { fetch: async (input, init) => {
    const { method } = JSON.parse(String(init?.body));
    const primary = String(input).includes('alchemy.com');
    calls.push(`${primary ? 'primary' : 'secondary'}:${method}`);
    if (method === 'eth_chainId') return response('0x1');
    if (!primary) return response({ blockNumber: '0x1' });
    return new Response(new ReadableStream({ start(controller) {
      controller.error(new TypeError('Connection lost after response headers'));
    } }), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.deepEqual(result, { blockNumber: '0x1' });
  assert.deepEqual(calls, ['primary:eth_chainId', 'primary:eth_getTransactionReceipt', 'secondary:eth_chainId', 'secondary:eth_getTransactionReceipt']);
});

test('malformed JSON remains nonretryable rather than triggering provider failover', async () => {
  let calls = 0;
  await assert.rejects(withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    fetch: async () => { calls++; return new Response('{', { headers: { 'Content-Type': 'application/json' } }); },
  }), error => error instanceof RpcProviderError && error.kind === 'response');
  assert.equal(calls, 1);
});

test('foreground hedge cancels the slow attempt and starts only two attempts', async () => {
  let calls = 0, cancelled = 0;
  const result = await withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    lane: 'reveal', hedgeMs: 5, fetch: async (input, init) => {
      calls++;
      if (String(input).includes('quiknode.pro')) return response('0x1');
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        cancelled++; reject(init.signal?.reason);
      }, { once: true }));
    },
  });
  assert.equal(result, '0x1');
  assert.equal(calls, 2);
  assert.equal(cancelled, 1);
});

test('foreground hedge can use QuickNode while the Alchemy permit request is stalled', async () => {
  const providers: string[] = [];
  let primaryCancelled = false;
  const started = performance.now();
  const result = await withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    lane: 'reveal', hedgeMs: 10,
    budgetClient: {
      async take(provider, _lane, _cost, signal) {
        if (provider !== 'alchemy') return;
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
          primaryCancelled = true;
          reject(signal.reason);
        }, { once: true }));
      },
      async reportThrottle() {},
    },
    fetch: async input => { providers.push(new URL(String(input)).hostname); return response('0x1'); },
  });
  assert.equal(result, '0x1');
  assert.deepEqual(providers, ['fixture.quiknode.pro']);
  assert.equal(primaryCancelled, true);
  assert.ok(performance.now() - started < 500, 'Fallback waited for the one-second Alchemy permit timeout');
});

test('background work falls back from a stalled permit without hedging a running RPC', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const permitStarted = Promise.withResolvers<void>();
  const providers: string[] = [];
  const pending = withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    lane: 'background', budgetClient: {
      async take(provider, _lane, _cost, signal) {
        if (provider !== 'alchemy') return;
        permitStarted.resolve();
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
      async reportThrottle() {},
    },
    fetch: async input => { providers.push(new URL(String(input)).hostname); return response('0x1'); },
  });
  await permitStarted.promise;
  t.mock.timers.tick(1_000);
  assert.equal(await pending, '0x1');
  assert.deepEqual(providers, ['fixture.quiknode.pro']);

  providers.length = 0;
  const rpcStarted = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Response>();
  const running = withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    lane: 'background', fetch: async input => { providers.push(new URL(String(input)).hostname); rpcStarted.resolve(); return reply.promise; },
  });
  await rpcStarted.promise;
  t.mock.timers.tick(1_000);
  await Promise.resolve();
  assert.deepEqual(providers, ['eth-mainnet.g.alchemy.com']);
  reply.resolve(response('0x1'));
  assert.equal(await running, '0x1');
});

test('null receipt is a valid result and does not trigger fallback', async () => {
  let calls = 0;
  assert.equal(await withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_getTransactionReceipt', ['0xfixture']), {
    lane: 'reveal', hedgeMs: 5, fetch: async () => { calls++; return response(null); },
  }), null);
  assert.equal(calls, 1);
});

test('wrong chain and malformed RPC results do not seek a different provider', async () => {
  let calls = 0;
  await assert.rejects(withEthereumProvider(env, 1, signal(), async attempt => {
    if (await attempt.rpc('eth_chainId', []) !== '0x1') throw new EthereumApiError('unavailable', 'Wrong chain');
  }, { fetch: async () => { calls++; return response('0x2'); } }), /Wrong chain/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    fetch: async () => { calls++; return Response.json({ jsonrpc: '2.0', id: 2, result: '0x1' }); },
  }), error => error instanceof RpcProviderError && error.kind === 'response');
  assert.equal(calls, 1);
});

test('local quota denial uses secondary without dispatching primary RPC', async () => {
  const b = budget(provider => provider === 'alchemy' ? 20 : null);
  const urls: string[] = [];
  const result = await withEthereumProvider({ ...env, ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true', ETHEREUM_PROVIDER_BUDGET: b.namespace },
    1, signal(), attempt => attempt.rpc('eth_chainId', []), {
      lane: 'reveal', fetch: async input => { urls.push(String(input)); return response('0x1'); },
    });
  assert.equal(result, '0x1');
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('quiknode.pro'));
  assert.equal(b.throttles.length, 0);
});

test('reveal quota denials preserve the earliest retry with no upstream calls', async t => {
  t.mock.method(Date, 'now', () => 1000);
  t.mock.method(performance, 'now', () => 1000);
  const b = budget(provider => provider === 'alchemy' ? 30 : 10);
  await assert.rejects(withEthereumProvider({ ...env, ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true', ETHEREUM_PROVIDER_BUDGET: b.namespace },
    1, signal(), attempt => attempt.rpc('eth_chainId', []), { lane: 'reveal', fetch: async () => { throw new Error('Unexpected fetch'); } }),
  error => error instanceof ProviderBudgetUnavailable && error.retryAfterMs === 10);
});

test('provider throttles expose the earliest retry while retaining each provider cooldown', async t => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  const b = budget();
  const client = new ProviderBudgetClient(b.namespace);
  const calls: string[] = [];
  let throttled = true;
  const options = { budgetClient: client, fetch: async (input: RequestInfo | URL) => {
    const primary = String(input).includes('alchemy.com');
    calls.push(`${primary ? 'alchemy' : 'quicknode'}:${now}`);
    return throttled ? new Response('', { status: 429, headers: { 'Retry-After': primary ? '60' : '1' } }) : response('0x1');
  } };
  await assert.rejects(withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), options), error => {
    assert.ok(error instanceof RpcProviderError);
    assert.equal(error.provider, 'quicknode');
    assert.equal(error.retryAfterMs, 1_000);
    assert.equal(ethereumErrorResponse(ethereumProviderApiError(error)).headers.get('Retry-After'), '1');
    return true;
  });
  assert.deepEqual(b.throttles, [{ provider: 'alchemy', retryAfterMs: 60_000 }, { provider: 'quicknode', retryAfterMs: 1_000 }]);
  now += 1_000;
  throttled = false;
  assert.equal(await withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), options), '0x1');
  assert.deepEqual(calls, ['alchemy:1000', 'quicknode:1000', 'quicknode:2000']);
  await assert.rejects(client.take('alchemy', 'public', 5, signal()), error =>
    error instanceof ProviderBudgetUnavailable && error.retryAfterMs === 59_000);
});

test('mixed throttle and local capacity failures retain the shorter budget wait', async t => {
  t.mock.method(Date, 'now', () => 1_000);
  t.mock.method(performance, 'now', () => 1_000);
  const b = budget(provider => provider === 'quicknode' ? 1_000 : null);
  await assert.rejects(withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    lane: 'reveal', budgetClient: new ProviderBudgetClient(b.namespace), fetch: async input => {
      assert.ok(String(input).includes('alchemy.com'));
      return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
    },
  }), error => error instanceof ProviderBudgetUnavailable && error.retryAfterMs === 1_000);
});

test('a shorter hedge cooldown does not replace the first hard validation failure', async () => {
  const secondaryStarted = Promise.withResolvers<void>();
  const invalid = new RpcProviderError('alchemy', 'response', 60_000);
  await assert.rejects(withEthereumProvider(env, 1, signal(), async attempt => {
    if (attempt.provider === 'alchemy') { await secondaryStarted.promise; throw invalid; }
    secondaryStarted.resolve();
    await new Promise(resolve => setImmediate(resolve));
    throw new RpcProviderError('quicknode', 'throttle', 1_000);
  }, { lane: 'reveal', hedgeMs: 0 }), error => error === invalid);
});

test('provider 429 shares cooldown and falls back, without conflating local budget denial', async () => {
  const b = budget();
  const result = await withEthereumProvider({ ...env, ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true', ETHEREUM_PROVIDER_BUDGET: b.namespace },
    1, signal(), attempt => attempt.rpc('eth_chainId', []), {
      fetch: async input => String(input).includes('alchemy.com')
        ? new Response('', { status: 429, headers: { 'Retry-After': '2' } }) : response('0x1'),
    });
  assert.equal(result, '0x1');
  assert.deepEqual(b.throttles, [{ provider: 'alchemy', retryAfterMs: 2_000 }]);
});

for (const error of [
  { code: 3, message: 'insufficient credits' },
  { code: 3, message: 'quota exhausted' },
  { code: 3, message: 'internal server error' },
  { code: 3, message: 'Request timed out. Client should retry.' },
  { code: -32000, message: 'execution reverted: quota exceeded' },
  { code: -32015, message: 'VM Exception while processing transaction: revert insufficient credits' },
  { code: -32603, message: 'Reverted with reason string: rate limit exceeded' },
  { code: -32603, message: 'execution reverted: internal server error' },
]) test(`contract revert does not throttle the provider or trigger fallback: ${error.message}`, async () => {
  const b = budget();
  const client = new ProviderBudgetClient(b.namespace);
  let calls = 0;
  await assert.rejects(withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_call', [{}, 'latest']), {
    budgetClient: client, fetch: async () => {
      calls++;
      return Response.json({ jsonrpc: '2.0', id: 1, error });
    },
  }), failure => failure instanceof RpcProviderError && failure.kind === 'response');
  assert.equal(calls, 1);
  assert.deepEqual(b.throttles, []);
  const next = createEthereumProviderAttempt(env, 1, 'alchemy', signal(), {
    budgetClient: client, fetch: async () => response('0x1'),
  });
  assert.equal(await next.rpc('eth_chainId', []), '0x1');
});

for (const error of [
  { code: 429, message: 'Provider is busy' },
  { code: -32005, message: 'Rate limit exceeded' },
  { code: -32000, message: 'Account quota exhausted' },
]) test(`genuine RPC throttles still share cooldown: ${error.code}`, async () => {
  const b = budget();
  const attempt = createEthereumProviderAttempt(env, 1, 'alchemy', signal(), {
    budgetClient: new ProviderBudgetClient(b.namespace),
    fetch: async () => Response.json({ jsonrpc: '2.0', id: 1, error }),
  });
  await assert.rejects(attempt.rpc('eth_call', [{}, 'latest']), failure =>
    failure instanceof RpcProviderError && failure.kind === 'throttle');
  assert.deepEqual(b.throttles, [{ provider: 'alchemy', retryAfterMs: 2_000 }]);
});

test('a reverted batch item does not hide a genuine throttle on another item', async () => {
  const b = budget();
  const attempt = createEthereumProviderAttempt(env, 1, 'alchemy', signal(), {
    budgetClient: new ProviderBudgetClient(b.namespace), fetch: async () => Response.json([
      { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted: insufficient credits' } },
      { jsonrpc: '2.0', id: 2, error: { code: 429, message: 'Rate limit exceeded' } },
    ]),
  });
  await assert.rejects(attempt.request([
    { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{}, 'latest'] },
    { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{}, 'latest'] },
  ]), failure => failure instanceof RpcProviderError && failure.kind === 'throttle');
  assert.deepEqual(b.throttles, [{ provider: 'alchemy', retryAfterMs: 2_000 }]);
});

for (const [provider, method, kind] of [
  ['quicknode', 'eth_getLogs', 'range'],
  ['quicknode', 'eth_call', 'response'],
  ['alchemy', 'eth_getLogs', 'response'],
] as const) test(`${provider} ${method} classifies plain HTTP 413 as ${kind} and cancels its body`, async () => {
  let cancelled = false;
  const b = budget();
  const attempt = createEthereumProviderAttempt(env, 1, provider, signal(), {
    budgetClient: new ProviderBudgetClient(b.namespace), fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('Request Entity Too Large')); },
      cancel() { cancelled = true; },
    }), { status: 413, headers: { 'Content-Type': 'text/plain' } }),
  });
  await assert.rejects(attempt.rpc(method, []), error => error instanceof RpcProviderError && error.kind === kind);
  assert.equal(cancelled, true);
  assert.deepEqual(b.throttles, []);
});

for (const [error, kind] of [
  [{ code: -32602, message: 'eth_getLogs and eth_newFilter are limited to a 10,000 blocks range' }, 'range'],
  [{ code: -32602, message: 'Invalid params' }, 'response'],
  [{ code: 3, message: 'execution reverted: blocks range limit exceeded' }, 'response'],
  [{ code: -32000, message: 'execution reverted: blocks range limit exceeded' }, 'response'],
  [{ code: 429, message: 'Rate limit exceeded for blocks range queries' }, 'throttle'],
] as const) test(`QuickNode log error remains ${kind}: ${error.message}`, async () => {
  const b = budget();
  const attempt = createEthereumProviderAttempt(env, 1, 'quicknode', signal(), {
    budgetClient: new ProviderBudgetClient(b.namespace), fetch: async () => Response.json({ jsonrpc: '2.0', id: 1, error }),
  });
  await assert.rejects(attempt.rpc('eth_getLogs', [{}]), failure => failure instanceof RpcProviderError && failure.kind === kind);
  assert.equal(b.throttles.length, kind === 'throttle' ? 1 : 0);
});

test('QuickNode batches budget every member and preserve response IDs', async () => {
  const b = budget();
  const attempt = createEthereumProviderAttempt({ ...env, ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true', ETHEREUM_PROVIDER_BUDGET: b.namespace },
    1, 'quicknode', signal(), { fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return response('0x1', request.id);
    } });
  const result = await attempt.request([1, 2, 3, 4].map(id => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [] })));
  assert.deepEqual(result, [1, 2, 3, 4].map(id => ({ jsonrpc: '2.0', id, result: '0x1' })));
  assert.equal(b.calls.reduce((sum, call) => sum + call.minimum, 0), 4);
});

test('Alchemy NFT calls consume the shared budget without QuickNode fallback', async () => {
  const b = budget();
  const result = await fetchAlchemyNft({ ...env, ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true', ETHEREUM_PROVIDER_BUDGET: b.namespace },
    new URL('https://eth-mainnet.g.alchemy.com/nft/v3/fixture/getNFTsForOwner'), {}, {
      signal: signal(), fetch: async () => Response.json({ ownedNfts: [] }),
    });
  assert.equal(result.status, 200);
  assert.equal(b.calls.length, 1);
  assert.deepEqual(b.calls.map(({ provider, lane, minimum }) => ({ provider, lane, minimum })), [{ provider: 'alchemy', lane: 'public', minimum: 100 }]);
});

test('enabled remote provider controls fail closed if the budget binding is missing', async () => {
  await assert.rejects(withEthereumProvider({ ...env, ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true' },
    1, signal(), attempt => attempt.rpc('eth_chainId', [])), ProviderBudgetUnavailable);
});

test('local chain bypasses external budgets and never falls back', async () => {
  let calls = 0;
  const result = await withEthereumProvider({ ...env, ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true', ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545' },
    31337, signal(), attempt => attempt.rpc('eth_chainId', []), { fetch: async input => {
      calls++; assert.equal(String(input), 'http://127.0.0.1:8545/'); return response('0x7a69');
    } });
  assert.equal(result, '0x7a69');
  assert.equal(calls, 1);
});

test('capacity errors expose a short retry without credential details', async () => {
  const result = ethereumErrorResponse(ethereumProviderApiError(new ProviderBudgetUnavailable(20)));
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('Retry-After'), '1');
  assert.ok(!(await result.text()).includes('fixture'));
});

test('single-provider operation failure cancels and drains concurrent sibling RPCs', async () => {
  let cancelled = false;
  const oneProvider = { ...env, QUICKNODE_ETHEREUM_MAINNET_ENABLED: 'false' };
  await assert.rejects(withEthereumProvider(oneProvider, 1, signal(), attempt => Promise.all([
    attempt.rpc('eth_chainId', []), attempt.rpc('eth_getTransactionReceipt', ['fixture']),
  ]), { fetch: async (_input, init) => {
    const { method } = JSON.parse(String(init?.body));
    if (method === 'eth_getTransactionReceipt') return new Response('', { status: 503 });
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
      cancelled = true;
      reject(init.signal?.reason);
    }, { once: true }));
  } }), error => error instanceof RpcProviderError && error.kind === 'transport');
  assert.equal(cancelled, true);
});

test('a request-specific cancellation aborts only that batch and preserves its exact reason', async () => {
  const controller = new AbortController();
  const reason = new Error('Sibling request failed');
  const started = Promise.withResolvers<void>();
  let cancelled: unknown;
  const attempt = createEthereumProviderAttempt(env, 1, 'alchemy', signal(), { fetch: async (_input, init) => {
    const { method } = JSON.parse(String(init?.body));
    if (method === 'eth_chainId') return response('0x1');
    return new Promise((_resolve, reject) => {
      started.resolve();
      init?.signal?.addEventListener('abort', () => { cancelled = init.signal?.reason; reject(cancelled); }, { once: true });
    });
  } });
  const pending = attempt.request({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, controller.signal);
  await started.promise;
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(cancelled, reason);
  assert.equal(await attempt.rpc('eth_chainId', []), '0x1');
  await attempt.drain();
});

test('QuickNode validates the whole batch before any member dispatches', async () => {
  let calls = 0;
  const attempt = createEthereumProviderAttempt(env, 1, 'quicknode', signal(), { fetch: async () => { calls++; return response('0x1'); } });
  const inputs = [[], Array.from({ length: 5 }, (_, index) => ({ jsonrpc: '2.0' as const, id: index, method: 'eth_call', params: [] })),
    [{ jsonrpc: '2.0' as const, id: 1, method: 'eth_call', params: [] }, { jsonrpc: '2.0' as const, id: 2, method: 'eth_sendRawTransaction', params: [] }]];
  for (const input of inputs) await assert.rejects(attempt.request(input));
  assert.equal(calls, 0);
});

test('QuickNode batch failure cancels and drains sibling members without closing the whole attempt', async () => {
  let cancelled = false;
  const attempt = createEthereumProviderAttempt(env, 1, 'quicknode', signal(), { fetch: async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === 'eth_chainId') return response('0x1');
    if (request.id === 2) return new Response('', { status: 503 });
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
      cancelled = true;
      reject(init.signal?.reason);
    }, { once: true }));
  } });
  await assert.rejects(attempt.request([1, 2].map(id => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [] }))), RpcProviderError);
  assert.equal(cancelled, true);
  assert.equal(await attempt.rpc('eth_chainId', []), '0x1');
});

test('raw RPC response envelopes reject mismatched IDs and duplicate batch replies', async () => {
  for (const body of [{ jsonrpc: '2.0', id: 2, result: '0x1' }, { id: 1, result: '0x1' },
    { jsonrpc: '2.0', id: 1, result: '0x1', error: {} }]) {
    const attempt = createEthereumProviderAttempt(env, 1, 'alchemy', signal(), { fetch: async () => Response.json(body) });
    await assert.rejects(attempt.request({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), RpcProviderError);
  }
  const attempt = createEthereumProviderAttempt(env, 1, 'alchemy', signal(), { fetch: async () => Response.json([
    { jsonrpc: '2.0', id: 1, result: '0x1' }, { jsonrpc: '2.0', id: 1, result: '0x1' },
  ]) });
  await assert.rejects(attempt.request([1, 2].map(id => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [] }))), RpcProviderError);
});

test('a failed secondary validation cannot cancel an already-running valid primary', async () => {
  const metrics: EthereumProviderMetrics[] = [];
  let primaryFinished = false;
  const result = await withEthereumProvider(env, 1, signal(), async attempt => {
    const chain = await attempt.rpc('eth_chainId', []);
    if (chain !== '0x1') throw new EthereumApiError('unavailable', 'Wrong chain');
    return chain;
  }, { lane: 'reveal', hedgeMs: 1, onMetrics: value => { metrics.push(value); }, fetch: async input => {
    if (String(input).includes('quiknode.pro')) return response('0x2');
    await new Promise(resolve => setTimeout(resolve, 15));
    primaryFinished = true;
    return response('0x1');
  } });
  assert.equal(result, '0x1');
  assert.equal(primaryFinished, true);
  assert.equal(metrics[0].winner, 'alchemy');
  assert.deepEqual(metrics[0].attempts.map(value => value.outcome), ['success', 'error']);
});

test('synchronous secondary URL failure is contained during a hedge', async () => {
  let calls = 0;
  const result = await withEthereumProvider({ ...env, QUICKNODE_ETHEREUM_MAINNET_RPC_URL: 'invalid-secret-url' }, 1, signal(),
    attempt => attempt.rpc('eth_chainId', []), { lane: 'reveal', hedgeMs: 1, fetch: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 15));
      return response('0x1');
    } });
  assert.equal(result, '0x1');
  assert.equal(calls, 1);
});

test('operation deadline terminates an uncooperative operation without hanging cleanup', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const pending = withEthereumProvider(env, 1, controller.signal, async () => {
    started.resolve();
    return new Promise(() => {});
  });
  await started.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

for (const kind of ['rpc', 'nft'] as const) test(`${kind} cancels late response bodies after an uncooperative fetch outlives cancellation`, async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<Response>();
  const cancelled = Promise.withResolvers<void>();
  const providerFetch: typeof fetch = async () => { started.resolve(); return delayed.promise; };
  const pending = kind === 'rpc'
    ? withEthereumProvider(env, 1, controller.signal, attempt => attempt.rpc('eth_chainId', []), { fetch: providerFetch })
    : fetchAlchemyNft(env, new URL('https://eth-mainnet.g.alchemy.com/nft/v3/fixture/getNFTsForOwner'), {},
      { signal: controller.signal, fetch: providerFetch });
  await started.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  delayed.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); } })));
  await cancelled.promise;
});

test('provider metrics aggregate methods and attempts without URLs, hashes, params, or provider error text', async () => {
  let observed: EthereumProviderMetrics | undefined;
  const result = await withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_getTransactionReceipt', ['private-transaction-hash']), {
    onMetrics: value => { observed = value; }, fetch: async input => {
      if (String(input).includes('alchemy.com')) throw new Error('private provider failure');
      return response({ status: '0x1' });
    },
  });
  assert.deepEqual(result, { status: '0x1' });
  assert.equal(observed!.secondaryReason, 'transport');
  assert.equal(observed!.winner, 'quicknode');
  assert.deepEqual(observed!.attempts.map(value => [value.provider, value.calls, value.budgetUnits]), [['alchemy', 1, 20], ['quicknode', 1, 1]]);
  const serialized = JSON.stringify(observed);
  for (const secret of ['private', 'fixture', 'https:', 'params']) assert.equal(serialized.includes(secret), false);
});

test('throwing telemetry cannot change a successful provider result', async () => {
  assert.equal(await withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    onMetrics: () => { throw new Error('Telemetry failure'); }, fetch: async () => response('0x1'),
  }), '0x1');
});

for (const kind of ['rpc', 'nft'] as const) test(`${kind} cancellation bounds a stalled shared-cooldown report`, async () => {
  const reporting = Promise.withResolvers<void>();
  const controller = new AbortController();
  const b = budget();
  const namespace: ProviderBudgetNamespace = { getByName: name => ({
    grant: value => b.namespace.getByName(name).grant(value),
    reportThrottle: async () => { reporting.resolve(); await new Promise(() => {}); },
  }) };
  const configuration = { ...env, QUICKNODE_ETHEREUM_MAINNET_ENABLED: 'false',
    ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true', ETHEREUM_PROVIDER_BUDGET: namespace };
  const providerFetch: typeof fetch = async () => new Response('', { status: 429 });
  const pending = kind === 'rpc'
    ? withEthereumProvider(configuration, 1, controller.signal, attempt => attempt.rpc('eth_chainId', []), { fetch: providerFetch })
    : fetchAlchemyNft(configuration, new URL('https://eth-mainnet.g.alchemy.com/nft/v3/fixture/getNFTsForOwner'), {},
      { signal: controller.signal, fetch: providerFetch });
  await reporting.promise;
  controller.abort();
  await assert.rejects(pending);
});

test('short public capacity waits use one queued acquisition before dispatch', async () => {
  let admitted = false, grants = 0, acquisitions = 0, fetches = 0;
  const result = await withEthereumProvider({ ...env, QUICKNODE_ETHEREUM_MAINNET_ENABLED: 'false' }, 1, signal(),
    attempt => attempt.rpc('eth_chainId', []), { budgetClient: {
      async take() { grants++; if (!admitted) throw new ProviderBudgetUnavailable(10); },
      async acquirePublic(_provider, cost, deadline, signal) {
        acquisitions++;
        assert.equal(cost, 5);
        assert.ok(deadline > Date.now() && deadline <= Date.now() + 1_000);
        await new Promise(resolve => setTimeout(resolve, 10));
        signal.throwIfAborted();
        admitted = true;
      },
      async reportThrottle() {},
    }, fetch: async () => { fetches++; return response('0x1'); } });
  assert.equal(result, '0x1');
  assert.equal(grants, 2);
  assert.equal(acquisitions, 1);
  assert.equal(fetches, 1);
});

test('public budget waiting starts QuickNode immediately and cancels the Alchemy queue', async () => {
  const requests: string[] = [], cancelled: string[] = [], urls: string[] = [];
  let admittedPrimary = 0;
  const namespace: ProviderBudgetNamespace = { getByName: provider => ({
    async grant(request) {
      const now = Date.now();
      return { granted: provider === 'alchemy' ? 0 : request.minimum, issuedAtMs: now, expiresAtMs: now + 1_000, retryAfterMs: 20 };
    },
    async acquirePublic(request) { requests.push(request.requestId); admittedPrimary++; return new Promise(() => {}); },
    async cancelPublic(request) { cancelled.push(request.requestId); },
    async reportThrottle() {},
  }) };
  const start = performance.now();
  const value = await withEthereumProvider({ ...env, ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true', ETHEREUM_PROVIDER_BUDGET: namespace },
    1, signal(), attempt => attempt.rpc('eth_chainId', []), {
      fetch: async input => { urls.push(String(input)); return response('0x1'); }, onMetrics() {},
    });
  assert.equal(value, '0x1');
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('quiknode.pro'));
  assert.equal(admittedPrimary, 1);
  assert.deepEqual(cancelled, requests);
  assert.ok(performance.now() - start < 300);
});

test('both public provider queues share a fixed cutoff and return typed capacity errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const queued = Promise.withResolvers<void>();
  const deadlines: number[] = [];
  const pending = withEthereumProvider(env, 1, new AbortController().signal, attempt => attempt.rpc('eth_chainId', []), {
    budgetClient: {
      async take() { throw new ProviderBudgetUnavailable(10); },
      async acquirePublic(_provider, _cost, deadline) {
        deadlines.push(deadline);
        if (deadlines.length === 2) queued.resolve();
        return new Promise(() => {});
      }, async reportThrottle() {},
    }, fetch: async () => assert.fail('No capacity was granted'),
  });
  const rejected = assert.rejects(pending, error => error instanceof ProviderBudgetUnavailable && error.retryAfterMs >= 1000);
  await queued.promise;
  assert.deepEqual(deadlines, [101_000, 101_000]);
  t.mock.timers.tick(1_000);
  await rejected;
});

test('public stalled admission falls back at 500ms and does not hedge an active RPC', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers<void>();
  const providers: string[] = [];
  const pending = withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    budgetClient: { async take(provider) { if (provider === 'alchemy') { started.resolve(); return new Promise(() => {}); } },
      async reportThrottle() {} },
    fetch: async input => { providers.push(new URL(String(input)).hostname); return response('0x1'); },
  });
  await started.promise;
  t.mock.timers.tick(499);
  await Promise.resolve();
  assert.equal(providers.length, 0);
  t.mock.timers.tick(1);
  assert.equal(await pending, '0x1');
  assert.deepEqual(providers, ['fixture.quiknode.pro']);

  providers.length = 0;
  const rpc = Promise.withResolvers<void>(), reply = Promise.withResolvers<Response>();
  const running = withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    fetch: async input => { providers.push(new URL(String(input)).hostname); rpc.resolve(); return reply.promise; },
  });
  await rpc.promise;
  t.mock.timers.tick(1_000);
  await Promise.resolve();
  assert.deepEqual(providers, ['eth-mainnet.g.alchemy.com']);
  reply.resolve(response('0x1'));
  assert.equal(await running, '0x1');
});

test('ephemeral public RPC and NFT clients cap reservations while supplied clients retain their lease policy', async () => {
  const wanted: number[] = [];
  const namespace: ProviderBudgetNamespace = { getByName: () => ({
    async grant(request) {
      wanted.push(request.wanted);
      const now = Date.now();
      return { granted: request.wanted, issuedAtMs: now, expiresAtMs: now + 1_000, retryAfterMs: 0 };
    }, async reportThrottle() {},
  }) };
  const config = { ...env, QUICKNODE_ETHEREUM_MAINNET_ENABLED: 'false', ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true', ETHEREUM_PROVIDER_BUDGET: namespace };
  await withEthereumProvider(config, 1, signal(), attempt => attempt.rpc('eth_chainId', []), { fetch: async () => response('0x1'), onMetrics() {} });
  const url = new URL('https://eth-mainnet.g.alchemy.com/nft/v3/fixture/getNFTsForOwner');
  await fetchAlchemyNft(config, url, {}, { signal: signal(), fetch: async () => Response.json({ ownedNfts: [] }) });
  await fetchAlchemyNft(config, url, {}, { signal: signal(), budgetClient: new ProviderBudgetClient(namespace), fetch: async () => Response.json({ ownedNfts: [] }) });
  assert.deepEqual(wanted, [100, 100, 250]);
});

test('public subsequent RPCs retain their overall deadline after the initial admission cutoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  let takes = 0;
  const deadlines: number[] = [];
  const result = await withEthereumProvider({ ...env, QUICKNODE_ETHEREUM_MAINNET_ENABLED: 'false' }, 1, signal(), async attempt => {
    assert.equal(await attempt.rpc('eth_chainId', []), '0x1');
    t.mock.timers.tick(1_500);
    return attempt.rpc('eth_blockNumber', []);
  }, { budgetClient: {
    async take() { if (++takes === 2) throw new ProviderBudgetUnavailable(10); },
    async acquirePublic(_provider, _cost, deadline) { deadlines.push(deadline); }, async reportThrottle() {},
  }, fetch: async () => response(takes === 1 ? '0x1' : '0x20') });
  assert.equal(result, '0x20');
  assert.deepEqual(deadlines, [102_500]);
});

test('a public transport failure after initial admission still reaches a healthy fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const dispatched = Promise.withResolvers<void>();
  const urls: string[] = [];
  const pending = withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    fetch: async input => {
      urls.push(new URL(String(input)).hostname);
      if (String(input).includes('quiknode.pro')) return response('0x1');
      dispatched.resolve();
      await new Promise(resolve => setTimeout(resolve, 1_100));
      return new Response('', { status: 503 });
    },
  });
  await dispatched.promise;
  t.mock.timers.tick(1_100);
  assert.equal(await pending, '0x1');
  assert.deepEqual(urls, ['eth-mainnet.g.alchemy.com', 'fixture.quiknode.pro']);
});

for (const [name, envelope] of [
  ['wrong ID', { jsonrpc: '2.0', id: 99, error: { code: 429, message: 'Rate limit exceeded' } }],
  ['provider-wide null ID', { jsonrpc: '2.0', id: null, error: { code: 429, message: 'Rate limit exceeded' } }],
  ['wrong version', { jsonrpc: '1.0', id: 1, error: { code: 429, message: 'Rate limit exceeded' } }],
  ['result and error', { jsonrpc: '2.0', id: 1, result: '0x1', error: { code: 429, message: 'Rate limit exceeded' } }],
  ['string error code', { jsonrpc: '2.0', id: 1, error: { code: '429', message: 'Rate limit exceeded' } }],
  ['fractional error code', { jsonrpc: '2.0', id: 1, error: { code: 429.5, message: 'Rate limit exceeded' } }],
  ['missing message', { jsonrpc: '2.0', id: 1, error: { code: 429 } }],
  ['uncorrelated server error', { jsonrpc: '2.0', id: 99, error: { code: -32603, message: 'internal server error' } }],
] as const) test(`invalid RPC error envelope cannot throttle or trigger fallback: ${name}`, async () => {
  const b = budget();
  const client = new ProviderBudgetClient(b.namespace);
  let calls = 0;
  await assert.rejects(withEthereumProvider(env, 1, signal(), attempt => attempt.rpc('eth_chainId', []), {
    budgetClient: client, fetch: async () => { calls++; return Response.json(envelope); },
  }), failure => failure instanceof RpcProviderError && failure.kind === 'response' && !failure.retryable);
  assert.equal(calls, 1);
  assert.deepEqual(b.throttles, []);
  assert.equal(await createEthereumProviderAttempt(env, 1, 'alchemy', signal(), {
    budgetClient: client, fetch: async () => response('0x1'),
  }).rpc('eth_chainId', []), '0x1');
});

test('an invalid batch member prevents throttle side effects from the entire response', async () => {
  const b = budget();
  const attempt = createEthereumProviderAttempt(env, 1, 'alchemy', signal(), {
    budgetClient: new ProviderBudgetClient(b.namespace), fetch: async () => Response.json([
      { jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Rate limit exceeded' } },
      { jsonrpc: '2.0', id: 1, result: '0x1' },
    ]),
  });
  await assert.rejects(attempt.request([
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
  ]), failure => failure instanceof RpcProviderError && failure.kind === 'response');
  assert.deepEqual(b.throttles, []);
});
