import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { registerHooks } from 'node:module';
import { EthereumProviderBudgetController, EthereumProviderBudgetStore, ProviderBudgetClient, ProviderBudgetUnavailable, PROVIDER_BUDGETS,
  type ProviderBudgetNamespace, type ProviderBudgetSql } from '../cloud/workers/api/src/ethereumProviderBudget.ts';
import { ethereumProviderCost, fetchAlchemyNft, waitForProvider, withEthereumProvider, type EthereumProviderAttempt,
  type EthereumProviderEnvironment, type EthereumProviderMetrics } from '../cloud/workers/api/src/ethereumProvider.ts';

const { EthereumRevealObject, EthereumRevealVerifierObject } = await (async () => {
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === 'cloudflare:workers' ? { shortCircuit: true,
      url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' }
      : nextResolve(specifier, context);
  } });
  try {
    const objectUrl = new URL('../cloud/workers/api/src/ethereumRevealObject.ts', import.meta.url).href;
    const verifierUrl = new URL('../cloud/workers/api/src/ethereumRevealVerifierObject.ts', import.meta.url).href;
    const [object, verifier] = await Promise.all([import(objectUrl), import(verifierUrl)]);
    return {
      EthereumRevealObject: object.EthereumRevealObject as new (context: unknown, environment: unknown) => {
        validateReceiptWork(): Promise<boolean>; recordReceiptPresence(): Promise<boolean>;
      },
      EthereumRevealVerifierObject: verifier.EthereumRevealVerifierObject as new (context: unknown, environment: unknown) => {
        inspect(scope: unknown, work: unknown, deadlineMs: number): Promise<{ kind: string }>;
      },
    };
  } finally { hooks.deregister(); }
})();

const env: EthereumProviderEnvironment = { ALCHEMY_MI_NOTE_API_KEY: 'synthetic-local-only', ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true' };
const emptyMetrics = (_value: EthereumProviderMetrics) => {};
const rounded = (value: number) => Math.round(value * 100) / 100;
const percentile = (values: number[], fraction: number) => rounded([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]);
const summary = (values: number[]) => ({ p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99) });

function broker(latencyMs: number) {
  const database = new DatabaseSync(':memory:');
  const sql: ProviderBudgetSql = { exec<T extends Record<string, string | number | null>>(query: string, ...bindings: Array<string | number | null>) {
    const statement = database.prepare(query);
    const values = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => values as T[] };
  } };
  const store = new EthereumProviderBudgetStore(sql, action => {
    database.exec('BEGIN');
    try { const result = action(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  });
  const controller = new EthereumProviderBudgetController(store);
  let grants = 0, denials = 0;
  let acquisitions = 0, acquiredGrants = 0, acquiredDenials = 0, cancellations = 0, maximumPublicWanted = 0;
  const namespace: ProviderBudgetNamespace = { getByName: () => ({
    async grant(request) {
      if (request.lane === 'public') maximumPublicWanted = Math.max(maximumPublicWanted, request.wanted);
      const result = controller.grant(request);
      if (latencyMs) await new Promise(resolve => setTimeout(resolve, latencyMs));
      if (result.granted) grants++; else denials++;
      return result;
    },
    async acquirePublic(request) {
      acquisitions++;
      const result = await controller.acquirePublic(request);
      if (latencyMs) await new Promise(resolve => setTimeout(resolve, latencyMs));
      if (result.granted) {
        acquiredGrants++;
        assert.equal(result.granted, request.minimum, 'Queued public grants must reserve only their call cost');
      } else acquiredDenials++;
      return result;
    },
    async cancelPublic(request) { cancellations++; controller.cancelPublic(request); },
    async reportThrottle(request) { controller.reportThrottle(request.provider, request.retryAfterMs); },
  }) };
  return { namespace, close: () => database.close(), counts: () => ({ grants, denials }),
    publicCounts: () => ({ acquisitions, acquiredGrants, acquiredDenials, cancellations, maximumPublicWanted }) };
}

function provider(latencyMs: number) {
  const calls: Array<{ method: string; atMs: number; cost: number }> = [];
  let running = 0, peak = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ method, atMs: Date.now(), cost: ethereumProviderCost(method, 'alchemy') });
    running++; peak = Math.max(peak, running);
    try {
      await waitForProvider(latencyMs, init!.signal!);
      const canonical = `0x${'aa'.repeat(32)}`;
      const result = method === 'eth_chainId' ? '0x1' : method === 'eth_blockNumber' ? '0x64'
        : method === 'eth_getBlockByNumber' ? { number: '0x64', hash: canonical }
        : { transactionHash: params[0], blockNumber: '0x64', blockHash: canonical, status: '0x0', logs: [] };
      return Response.json({ jsonrpc: '2.0', id, result });
    } finally { running--; }
  };
  return { fetch, calls, peak: () => peak };
}

async function inspect(rpc: Pick<EthereumProviderAttempt, 'rpc'>): Promise<void> {
  const [chain, receipt] = await Promise.all([rpc.rpc('eth_chainId', []), rpc.rpc('eth_getTransactionReceipt', ['synthetic'])]);
  assert.equal(chain, '0x1');
  const [head, block] = await Promise.all([rpc.rpc('eth_blockNumber', []), rpc.rpc('eth_getBlockByNumber', ['0x64', false])]);
  assert.equal(head, '0x64');
  assert.equal((receipt as { blockHash: string }).blockHash, (block as { hash: string }).hash);
}

async function latencyBenchmark() {
  const providerLatencyMs = 10, brokerLatencyMs = 5, samples = 24;
  const upstream = provider(providerLatencyMs), quota = broker(brokerLatencyMs);
  const coordinator = new ProviderBudgetClient(quota.namespace);
  const direct: number[] = [], seeded: number[] = [], cold: number[] = [];
  const signal = AbortSignal.timeout(30_000);
  try {
    for (let index = -3; index < samples; index++) {
      const baselineStart = performance.now();
      await inspect({ rpc: async (method, params) => {
        const response = await upstream.fetch('https://synthetic.invalid/', { signal, method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        return (await response.json() as { result: unknown }).result;
      } });
      if (index >= 0) direct.push(performance.now() - baselineStart);

      let permit;
      for (;;) {
        try { permit = await coordinator.grant('alchemy', 'reveal', 55, 55, signal); break; }
        catch (error) {
          if (!(error instanceof ProviderBudgetUnavailable)) throw error;
          await error.wait(signal);
        }
      }
      const child = new ProviderBudgetClient(quota.namespace, 64);
      child.seed('alchemy', 'reveal', permit);
      const seededStart = performance.now();
      await withEthereumProvider({ ...env, ETHEREUM_PROVIDER_BUDGET: quota.namespace }, 1, signal, inspect,
        { lane: 'reveal', budgetClient: child, fetch: upstream.fetch, onMetrics: emptyMetrics });
      if (index >= 0) seeded.push(performance.now() - seededStart);

      const coldStart = performance.now();
      await withEthereumProvider({ ...env, ETHEREUM_PROVIDER_BUDGET: quota.namespace }, 1, signal, inspect,
        { lane: 'reveal', budgetClient: new ProviderBudgetClient(quota.namespace, 55), fetch: upstream.fetch, onMetrics: emptyMetrics });
      if (index >= 0) cold.push(performance.now() - coldStart);
    }
    assert.equal(upstream.calls.length, (samples + 3) * 3 * 4);
    const baseline = summary(direct), seededResult = summary(seeded), coldResult = summary(cold);
    const regression = (actual: ReturnType<typeof summary>) => ({
      p95DeltaMs: rounded(actual.p95Ms - baseline.p95Ms), p99DeltaMs: rounded(actual.p99Ms - baseline.p99Ms),
      p95LimitMs: rounded(Math.max(10, baseline.p95Ms * 0.05)), p99LimitMs: rounded(Math.max(10, baseline.p99Ms * 0.05)),
      passed: actual.p95Ms - baseline.p95Ms <= Math.max(10, baseline.p95Ms * 0.05) &&
        actual.p99Ms - baseline.p99Ms <= Math.max(10, baseline.p99Ms * 0.05),
    });
    return { samples, providerLatencyMs, brokerLatencyMs, baseline, seeded: seededResult, cold: coldResult,
      seededP50DeltaMs: rounded(percentile(seeded, 0.5) - percentile(direct, 0.5)),
      coldP50DeltaMs: rounded(percentile(cold, 0.5) - percentile(direct, 0.5)), rpcCallsPerInspection: 4,
      regression: { seeded: regression(seededResult), cold: regression(coldResult) } };
  } finally { quota.close(); }
}

async function burstBenchmark(count: number) {
  const quota = broker(0), upstream = provider(1);
  const started = performance.now();
  const latencies: number[] = [], execution: number[] = [];
  const scope = { chainId: 1, contractAddress: `0x${'11'.repeat(20)}`, deploymentBlock: 1 };
  const context = { id: { equals: () => true }, waitUntil() {} };
  const environment = { ...env, ETHEREUM_PROVIDER_BUDGET: quota.namespace,
    ETHEREUM_REVEAL: { getByName: () => coordinator, idFromName: () => context.id } };
  const coordinator = new EthereumRevealObject(context, environment);
  coordinator.validateReceiptWork = async () => true;
  coordinator.recordReceiptPresence = async () => true;
  Object.defineProperties(coordinator, {
    store: { value: { validReceiptClaim: () => true } },
    rebuildFence: { value: { status: () => null } },
  });
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  globalThis.fetch = upstream.fetch;
  console.log = () => {};
  let cursor = 0;
  try {
    await Promise.all(Array.from({ length: 64 }, async () => {
      while (cursor < count) {
        const index = ++cursor;
        const verifier = new EthereumRevealVerifierObject(context, environment);
        const now = Date.now();
        const executionStart = performance.now();
        const result = await verifier.inspect(scope, { kind: 'receipt', providerBudgetProtocol: 1, claim: {
          hash: `0x${index.toString(16).padStart(64, '0')}`, claimId: crypto.randomUUID(),
          startedAtMs: now, leaseUntilMs: now + 30_000, active: true,
        } }, now + 20_000);
        assert.equal(result.kind, 'inspected');
        execution.push(performance.now() - executionStart);
        latencies.push(performance.now() - started);
      }
    }));
    const durationMs = performance.now() - started;
    assert.equal(latencies.length, count);
    assert.equal(upstream.calls.length, count * 4);
    let left = 0, units = 0, peakWindow = 0;
    for (let right = 0; right < upstream.calls.length; right++) {
      units += upstream.calls[right].cost;
      while (upstream.calls[right].atMs - upstream.calls[left].atMs > 1000) units -= upstream.calls[left++].cost;
      peakWindow = Math.max(peakWindow, units);
    }
    const config = PROVIDER_BUDGETS.alchemy;
    const rate = Object.values(config.rates).reduce((sum, value) => sum + value, 0);
    const burst = Object.values(config.bursts).reduce((sum, value) => sum + value, 0);
    const envelope = rate * (1 + config.leaseMs / 1000) + burst;
    assert.ok(peakWindow <= envelope, `${peakWindow} exceeds the ${envelope}-CU one-second dispatch envelope`);
    const counts = quota.counts();
    assert.ok(counts.grants + counts.denials < count * 2.5, 'Real verifier topology amplified broker requests');
    return { count, topology: 'EthereumRevealObject + per-transaction EthereumRevealVerifierObject',
      scopeValidation: 'in-memory fixture', concurrency: 64, providerLatencyMs: 1, durationMs: rounded(durationMs),
      queuedCompletion: summary(latencies), activeInspection: summary(execution), rpcCalls: upstream.calls.length,
      peakConcurrentRpc: upstream.peak(), peakOneSecondCu: peakWindow, oneSecondCuEnvelope: envelope, ...counts };
  } finally { globalThis.fetch = previousFetch; console.log = previousLog; quota.close(); }
}

async function publicBurstBenchmark(kind: 'rpc' | 'nft', count: number) {
  const quota = broker(0), upstream = provider(1);
  const environment = { ...env, ETHEREUM_PROVIDER_BUDGET: quota.namespace };
  const signal = AbortSignal.timeout(2000);
  const latencies: number[] = [];
  let nftCalls = 0;
  const nftFetch: typeof globalThis.fetch = async (_input, init) => {
    nftCalls++;
    await waitForProvider(1, init!.signal!);
    return Response.json({ ownedNfts: [], pageKey: null });
  };
  const started = performance.now();
  try {
    const results = await Promise.allSettled(Array.from({ length: count }, async () => {
      const requestStarted = performance.now();
      if (kind === 'rpc') {
        const head = await withEthereumProvider(environment, 1, signal, attempt => attempt.rpc('eth_blockNumber', []),
          { lane: 'public', fetch: upstream.fetch, onMetrics: emptyMetrics });
        assert.equal(head, '0x64');
      } else {
        const response = await fetchAlchemyNft(environment,
          new URL('https://eth-mainnet.g.alchemy.com/nft/v3/synthetic-local-only/getNFTsForOwner'), {}, { signal, fetch: nftFetch });
        assert.deepEqual(await response.json(), { ownedNfts: [], pageKey: null });
      }
      latencies.push(performance.now() - requestStarted);
    }));
    const durationMs = performance.now() - started;
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(failures.length, 0, `${kind} public burst failed: ${failures.map(result => String(result.reason)).join(', ')}`);
    assert.equal(latencies.length, count);
    assert.ok(durationMs < 1000 && latencies.every(value => value < 1000), `${kind} public burst exceeded one second`);
    const providerCalls = kind === 'rpc' ? upstream.calls.length : nftCalls;
    assert.equal(providerCalls, count);
    const initial = quota.counts(), queued = quota.publicCounts();
    const brokerRequests = initial.grants + initial.denials + queued.acquisitions + queued.cancellations;
    assert.ok(queued.acquisitions > 0, `${kind} public burst did not exercise the controller FIFO`);
    assert.equal(queued.acquiredGrants, queued.acquisitions);
    assert.equal(queued.acquiredDenials, 0);
    assert.equal(queued.cancellations, 0);
    assert.ok(queued.maximumPublicWanted <= 100, `${kind} ephemeral client requested more than 100 CU`);
    assert.ok(brokerRequests <= count * 2, `${kind} public burst amplified broker traffic: ${brokerRequests} requests for ${count} reads`);
    return { kind, count, topology: 'request-local ProviderBudgetClient + SQLite EthereumProviderBudgetController',
      concurrency: count, providerLatencyMs: 1, admissionLimitMs: 1000, durationMs: rounded(durationMs),
      latency: summary(latencies), successes: latencies.length, providerCalls, brokerRequests, initial, queued };
  } finally { quota.close(); }
}

const result = { kind: 'synthetic-local-only', measuredAt: new Date().toISOString(),
  latency: await latencyBenchmark(), publicBursts: [await publicBurstBenchmark('rpc', 20), await publicBurstBenchmark('nft', 10)],
  bursts: [await burstBenchmark(100), await burstBenchmark(1000)] };
const outputPath = resolve('.cache/111k-provider-local/benchmark.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
assert.ok(result.latency.regression.seeded.passed, 'Seeded p95/p99 overhead exceeds max(10ms, 5% of baseline)');
assert.ok(result.latency.regression.cold.passed, 'Cold p95/p99 overhead exceeds max(10ms, 5% of baseline)');
