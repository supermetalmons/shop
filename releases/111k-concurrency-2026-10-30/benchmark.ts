import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import type { EthereumRevealTransactionResponse } from '../../shared/ethereum/reveal.ts';
import { initializeLocalEthereumReveal } from '../../scripts/shared/ethereum111kLocalReveal.ts';

type Profile = 'nominal' | 'slow' | 'throttle' | 'pending';
type Options = { source: string; output: string; isolation: 'coordinator' | 'transaction'; counts: number[]; repetitions: number; profiles: Profile[];
  wrapper?: string; disablePublication: boolean };
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT = `0x${'11'.repeat(20)}`;
const BASE_URI = 'https://cdn.mons.shop/111k-sepolia/';
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
const rounded = (value: number) => Math.round(value * 100) / 100;
const sleep = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));

function options(): Options {
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) values.set(process.argv[index], process.argv[index + 1]);
  const isolation = values.get('--isolation') ?? 'coordinator';
  assert.ok(isolation === 'coordinator' || isolation === 'transaction');
  const profiles = (values.get('--profiles') ?? 'nominal').split(',') as Profile[];
  assert.ok(profiles.every(profile => ['nominal', 'slow', 'throttle', 'pending'].includes(profile)));
  return { source: resolve(values.get('--source') ?? repository), output: resolve(values.get('--output') ?? '.cache/111k-concurrency.json'),
    isolation, counts: (values.get('--counts') ?? '1,100,200,500').split(',').map(Number),
    repetitions: Number(values.get('--repetitions') ?? 3), profiles,
    wrapper: values.get('--wrapper') ? resolve(values.get('--wrapper')!) : undefined, disablePublication: values.get('--disable-publication') === 'true' };
}

function distribution(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  return { p50Ms: rounded(ordered[Math.max(0, Math.ceil(ordered.length * 0.5) - 1)] ?? 0),
    p95Ms: rounded(ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0), maxMs: rounded(ordered.at(-1) ?? 0) };
}

async function snapshot(source: string, wrapper?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), '111k-concurrency-source-'));
  for (const relative of ['cloud/workers/api', 'shared', 'scripts', 'package.json', 'mi_note_cards.json']) {
    await cp(join(source, relative), join(directory, relative), { recursive: true,
      filter: path => !/(?:^|\/)(?:node_modules|\.cache|\.wrangler)(?:\/|$)|(?:^|\/)\.dev\.vars|\.env$/.test(path) });
  }
  await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const chain = join(directory, 'cloud/workers/api/src/ethereumRevealChain.ts');
  const original = await readFile(chain, 'utf8');
  const before = 'const hash = normalizedHash(transactionHash);\n  const rpc = createRpc(env, deployment, signal, providerFetch);';
  assert.equal(original.split(before).length, 2, 'Benchmark context instrumentation must match one transaction inspector.');
  const after = `const hash = normalizedHash(transactionHash);
  const rpc = createRpc(env, deployment, signal, (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Reveal-Benchmark-Context', hash);
    return providerFetch(input, { ...init, headers });
  });`;
  await writeFile(chain, original.replace(before, after));
  const coordinator = join(directory, 'cloud/workers/api/src/ethereumRevealObject.ts');
  const coordinatorSource = await readFile(coordinator, 'utf8');
  assert.ok(/\n}\s*$/.test(coordinatorSource));
  await writeFile(coordinator, coordinatorSource.replace(/\n}\s*$/, `
  async benchmarkReadiness(): Promise<string> {
    const transactions = this.ctx.storage.sql.exec<{ hash: string; status: string; created_at_ms: number }>("SELECT hash,status,created_at_ms FROM transactions").toArray();
    const revealed = transactions.filter(row => row.status === 'revealed').map(row => row.hash);
    const published = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publication WHERE status='published'").toArray()[0].count;
    return JSON.stringify({ revealed, published, admitted: transactions.map(row => [row.hash, row.created_at_ms]) });
  }
}
`));
  if (wrapper) await writeFile(join(directory, 'cloud/workers/api/src/benchmark-entry.ts'),
    (await readFile(wrapper, 'utf8')).replaceAll(repository, directory));
  const entry = wrapper ? 'benchmark-entry' : 'index';
  await writeFile(join(directory, 'cloud/workers/api/src/benchmark-route.ts'), `
import api from './${entry}.ts';
export * from './${entry}.ts';
export default {
  ...api,
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/__benchmark/readiness') {
      const object = env.ETHEREUM_REVEAL.getByName(env.ETHEREUM_111K_CHAIN_ID + ':' + env.ETHEREUM_111K_CONTRACT_ADDRESS);
      return new Response(await object.benchmarkReadiness(), { headers: { 'Content-Type': 'application/json' } });
    }
    return api.fetch(request, env, context);
  },
};
`);
  await cp(join(repository, 'releases/111k-concurrency-2026-10-30/benchmark-driver.ts'), join(directory, 'cloud/workers/api/src/benchmark-driver.ts'));
  return directory;
}

async function runScenario(source: string, option: Options, profile: Profile, count: number, repetition: number) {
  const receipts = new Set(Array.from({ length: count }, (_, index) => hash(index + 1)));
  const runtimeDirectory = await mkdtemp(join(tmpdir(), '111k-concurrency-state-'));
  const provider = new Worker(new URL('./benchmark-rpc.ts', import.meta.url), { workerData: { count, profile, isolation: option.isolation } });
  const [providerAddress] = await once(provider, 'message') as [{ port: number }];
  const providerCall = async <T>(message: object): Promise<T> => {
    const result = once(provider, 'message');
    provider.postMessage(message);
    return (await result)[0] as T;
  };
  let started = 0;
  const production = JSON.parse(await readFile(join(source, 'cloud/workers/api/wrangler.jsonc'), 'utf8'));
  const config = { ...production, main: join(source, 'cloud/workers/api/src/benchmark-route.ts'),
    r2_buckets: [{ binding: 'ETHEREUM_REVEAL_METADATA', bucket_name: 'local-ethereum-reveal-metadata', remote: false }],
    vars: { ...production.vars, ...Object.fromEntries((production.secrets?.required ?? []).map((name: string) => [name, ''])),
      ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT, ETHEREUM_111K_DEPLOYMENT_BLOCK: '100',
      ETHEREUM_111K_RPC_URL: `http://127.0.0.1:${providerAddress.port}`, ETHEREUM_111K_METADATA_BASE_URI: BASE_URI,
      ...(option.disablePublication ? { PROFILE_DISABLE_R2: 'true' } : {}) },
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({ ...database, remote: false,
      migrations_dir: join(source, 'cloud/workers/api', String(database.migrations_dir)) })),
  };
  for (const key of ['$schema', 'account_id', 'routes', 'secrets']) delete config[key];
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  const runtime = createTestHarness({ root: runtimeDirectory, workers: [{ config }, { config: {
    name: '111k-benchmark-driver', main: join(source, 'cloud/workers/api/src/benchmark-driver.ts'),
    compatibility_date: production.compatibility_date, services: [{ binding: 'API', service: production.name }],
  } }] });
  try {
    const apiUrl = (await runtime.listen()).url;
    const worker = runtime.getWorker<Env>('mons-shop-api');
    const driver = runtime.getWorker('111k-benchmark-driver');
    for (const binding of ['DATA_DB', 'OPS_DB', 'COMMERCE_DB'] as const) await worker.applyD1Migrations(binding);
    const env = await worker.getEnv();
    await initializeLocalEthereumReveal(env, { contractAddress: CONTRACT, metadataBaseUri: BASE_URI, deploymentBlock: 100 });
    const storage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name: `31337:${CONTRACT}` });
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM assignments'))[0].count, 0);
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM transactions'))[0].count, 0);
    const observe = async (): Promise<string> => {
      const response = await worker.fetch(new URL('/__benchmark/readiness', apiUrl));
      assert.equal(response.status, 200);
      return response.text();
    };
    const profiler = option.wrapper ? env.ETHEREUM_REVEAL.getByName(`31337:${CONTRACT}`) as unknown as { profileSnapshot(reset?: boolean): Promise<unknown> } : undefined;
    await profiler?.profileSnapshot(true);
    const readiness = new Map<string, number>();
    const admission = new Map<string, number>();
    const acknowledgment: number[] = [];
    let pendingCount = 0, prematureResponses = 0, publicationMs: number | null = null;
    let stopObserving = false;
    let observing: Promise<void> | undefined;
    started = performance.now();
    await providerCall({ operation: 'start', startedAtMs: Date.now() });
    try {
      observing = (async () => {
        while (!stopObserving && performance.now() - started < 300_000) {
          const rows = JSON.parse(await observe()) as { revealed: string[]; published: number; admitted: Array<[string, number]> };
          const now = performance.now() - started;
          for (const transactionHash of rows.revealed) if (receipts.has(transactionHash) && !readiness.has(transactionHash)) readiness.set(transactionHash, now);
          for (const [transactionHash, admittedAtMs] of rows.admitted) if (receipts.has(transactionHash)) admission.set(transactionHash, admittedAtMs);
          if (readiness.size === count) return;
          await sleep(25);
        }
        if (!stopObserving) throw new Error(`Disclosure timeout: ${readiness.size}/${count}`);
      })();
      void observing.catch(() => undefined);
      const response = await driver.fetch('https://benchmark.invalid/burst', { method: 'POST',
        body: JSON.stringify({ chainId: 31337, contractAddress: CONTRACT, transactionHashes: [...receipts] }) });
      assert.equal(response.status, 200);
      const burst = await response.json() as { startedAtMs: number; elapsedMs: number; outcomes: Array<{
        transactionHash: string; elapsedMs: number; startedOffsetMs: number; status: number; body: string;
      }> };
      const outcomes = burst.outcomes.map(outcome => {
        const value = JSON.parse(outcome.body) as EthereumRevealTransactionResponse;
        acknowledgment.push(outcome.elapsedMs);
        assert.equal(outcome.status, 200, JSON.stringify(value));
        if (value.status === 'pending') { pendingCount++; assert.deepEqual(value.artworks, []); }
        else { assert.equal(value.status, 'revealed'); assert.equal(value.artworks.length, 20); }
        if (profile === 'pending' && performance.now() - started < 3_000 && value.artworks.length) prematureResponses++;
        return value;
      });
      await observing;
      const drainMs = performance.now() - started;
      const profileAtReveal = profiler ? JSON.parse(JSON.stringify(await profiler.profileSnapshot())) : undefined;
      while (performance.now() - started < 300_000) {
        const { published } = JSON.parse(await observe()) as { published: number };
        if (published === count * 20) { publicationMs = performance.now() - started; break; }
        await sleep(50);
      }
      assert.notEqual(publicationMs, null, 'Publication backlog did not drain.');
      const frozen = (await storage.exec<{ frozen: number; uniqueAssets: number; uniqueTokens: number }>(`SELECT COUNT(*) AS frozen,
        COUNT(DISTINCT category || ':' || asset_id) AS uniqueAssets,COUNT(DISTINCT token_id) AS uniqueTokens FROM assignments WHERE token_id IS NOT NULL`))[0];
      assert.deepEqual(frozen, { frozen: count * 20, uniqueAssets: count * 20, uniqueTokens: count * 20 });
      assert.equal(prematureResponses, 0);
      if (profile === 'pending') assert.ok([...readiness.values()].every(time => time >= 3_000), 'Artwork became available before a receipt.');
      const { calls, rpcPeak, headerSlotPeak, headerQueuePeak, throttleCount, errors } = await providerCall<{
        calls: Array<{ method: string; elapsedMs: number; delayMs: number; queuedMs: number; status: number; context: string }>;
        rpcPeak: number; headerSlotPeak: number; headerQueuePeak: number; throttleCount: number; errors: string[];
      }>({ operation: 'snapshot' });
      assert.deepEqual(errors, []);
      const finished = performance.now() - started;
      const receiptCalls = calls.filter(call => call.method === 'eth_getTransactionReceipt');
      return { profile, count, repetition, rpcHeaderIsolation: option.isolation, acknowledgment: distribution(acknowledgment),
        admission: distribution([...admission.values()].map(time => time - burst.startedAtMs)),
        requestDispatchSpreadMs: rounded(Math.max(...burst.outcomes.map(outcome => outcome.startedOffsetMs))),
        nativeHttpBatchMs: rounded(burst.elapsedMs),
        artworkReadiness: distribution([...readiness.values()]), drainMs: rounded(drainMs), publicationMs: rounded(publicationMs!),
        wallMs: rounded(finished), initiallyPending: pendingCount, initialRevealed: outcomes.length - pendingCount,
        rpc: { count: calls.length, peak: rpcPeak, headerSlotPeak, headerQueuePeak,
          retries: Math.max(0, receiptCalls.length - count), throttleResponses: throttleCount, errors,
          headerDelay: distribution(calls.map(call => call.delayMs)), endToEnd: distribution(calls.map(call => call.elapsedMs)),
          queue: distribution(calls.map(call => call.queuedMs)), methods: Object.fromEntries([...new Set(calls.map(call => call.method))].map(method => [method, calls.filter(call => call.method === method).length])) },
        checks: { prematureResponses, frozen, allPublished: true },
        ...(profiler ? { diagnostics: { publicationDisabled: option.disablePublication, profileAtReveal,
          profileAtEnd: JSON.parse(JSON.stringify(await profiler.profileSnapshot())) } } : {}),
        ...(profile === 'pending' ? { receiptVisibleAfterMs: 3000, readinessAfterReceiptVisibility: distribution([...readiness.values()].map(value => value - 3000)) } : {}) };
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ scenarioFailure: String(error), logs: runtime.getLogs().filter(log => log.level === 'error').slice(-10) })}\n`);
      throw error;
    } finally { stopObserving = true; await observing?.catch(() => undefined); }
  } finally {
    await runtime.close();
    await provider.terminate();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}

const option = options();
const require = createRequire(import.meta.url);
assert.ok(option.counts.every(count => Number.isInteger(count) && count > 0 && count <= 500));
assert.ok(Number.isInteger(option.repetitions) && option.repetitions > 0);
const source = await snapshot(option.source, option.wrapper);
const sourceHashes: Record<string, string> = {};
for (const name of ['ethereumRevealObject.ts', 'ethereumRevealStore.ts', 'ethereumRevealRecoveryStore.ts', 'ethereumRevealChain.ts',
  'ethereumRevealVerifierObject.ts', 'ethereumRevealVerification.ts', 'ethereumRevealPublisherObject.ts', 'index.ts']) {
  try { sourceHashes[name] = createHash('sha256').update(await readFile(join(option.source, 'cloud/workers/api/src', name))).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
for (const relative of ['cloud/workers/api/wrangler.jsonc', 'cloud/workers/api/worker-configuration.d.ts', 'scripts/shared/ethereum111kLocalReveal.ts',
  'releases/111k-concurrency-2026-10-30/benchmark.ts', 'releases/111k-concurrency-2026-10-30/benchmark-rpc.ts',
  'releases/111k-concurrency-2026-10-30/benchmark-driver.ts']) {
  const root = relative.startsWith('releases/') ? repository : option.source;
  sourceHashes[relative] = createHash('sha256').update(await readFile(join(root, relative))).digest('hex');
}
const report: { fixture: object; scenarios: Awaited<ReturnType<typeof runScenario>>[] } = {
  fixture: { runtime: 'native-workerd', source: option.source, sourceHashes, recordedAt: new Date().toISOString(), isolation: option.isolation,
    sourceInstrumentation: 'Transaction inspector adds a hash HTTP header for RPC header-slot isolation; a fixture-only HTTP route invokes a read-only async coordinator benchmarkReadiness method returning a JSON string. Production verification, storage mutations, and publication logic are unchanged.',
    responseTiming: 'RPC fixture runs in an independent worker thread so synchronous runtime-storage inspection cannot delay network timers. All RPC delay precedes HTTP response headers. Receipt/block data and delay hash are identical across implementations.',
    readinessTiming: 'Read-only HTTP observations of complete frozen transaction responses every25ms through native async DO RPC; includes observer delay. No live Miniflare storage/proxy calls; observer does not drive recovery.',
    latency: { nominal: '90% 100 ms; 9% 300 ms; 1% 1000 ms, deterministic hash(method, params, transaction)',
      slow: '90% 250 ms; 9% 1000 ms; 1% 5000 ms', throttle: 'nominal plus first receipt attempt gets HTTP 429/Retry-After: 2 for deterministic 20% of hashes',
      pending: 'nominal with receipts becoming visible at 3000 ms' },
    clientTransport: 'One fixture Worker dispatches the entire burst concurrently via service-binding.fetch to the unchanged public API Worker routes. HTTP response timings are measured inside native workerd and exclude external ingress/network latency. No Node TCP pool or synchronous storage proxy participates in burst dispatch.',
    versions: { node: process.version, wrangler: require('wrangler/package.json').version, miniflare: require('miniflare/package.json').version },
    diagnostics: { wrapper: option.wrapper ?? null, publicationDisabled: option.disablePublication },
    r2: 'native local R2; no artificial remote latency', counts: option.counts, repetitions: option.repetitions, profiles: option.profiles },
  scenarios: [],
};
try {
  await mkdir(dirname(option.output), { recursive: true });
  try {
    const previous = JSON.parse(await readFile(option.output, 'utf8')) as typeof report;
    assert.equal((previous.fixture as { isolation: string }).isolation, option.isolation);
    assert.equal((previous.fixture as { source: string }).source, option.source);
    for (const key of ['sourceInstrumentation', 'readinessTiming', 'responseTiming', 'clientTransport', 'versions', 'diagnostics', 'sourceHashes']) {
      assert.deepEqual((previous.fixture as Record<string, unknown>)[key], (report.fixture as Record<string, unknown>)[key], `Cannot resume a report with different ${key}.`);
    }
    report.scenarios.push(...previous.scenarios);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const profile of option.profiles) for (const count of option.counts) for (let repetition = 1; repetition <= option.repetitions; repetition++) {
    if (report.scenarios.some(scenario => scenario.profile === profile && scenario.count === count && scenario.repetition === repetition)) continue;
    process.stdout.write(`Starting ${profile} ${count} run ${repetition}\n`);
    const result = await runScenario(source, option, profile, count, repetition);
    report.scenarios.push(result);
    await writeFile(option.output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} finally { await rm(source, { recursive: true, force: true }); }
