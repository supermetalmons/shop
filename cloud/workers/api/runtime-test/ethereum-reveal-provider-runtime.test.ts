import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { encodeAbi, ETHEREUM_EVENT_TOPICS } from '../../../../shared/ethereum/abi.ts';
import { ethereumHexQuantity } from '../../../../shared/ethereum/protocol.ts';
import { ETHEREUM_REVEAL_CATALOG_VERSION, parseEthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import type { EthereumRevealTransactionResponse, EthereumRevealResult } from '../../../../shared/ethereum/reveal.ts';
import { buildEthereumRevealRegistration } from '../../../../scripts/ops/ethereumRevealControl.ts';
import { PROVIDER_BUDGETS } from '../src/ethereumProviderBudget.ts';

const CONTRACT = `0x${'11'.repeat(20)}`;
const OWNER = `0x${'22'.repeat(20)}`;
const ZERO = `0x${'00'.repeat(20)}`;
const BASE_URI = 'https://cdn.mons.shop/111k/';
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
const blockHash = (value: number) => hash(value + 1_000_000);
const word = (value: number) => encodeAbi(['uint256'], [value]);
const address = (value: string) => encodeAbi(['address'], [value]);

function receipt(index: number, block = 1000) {
  const transactionHash = hash(index + 1), crate = 111112 + index, first = index * 20 + 1;
  const log = (topics: string[], data: string, order: number) => ({ address: CONTRACT, topics, data,
    transactionHash, blockHash: blockHash(block), blockNumber: ethereumHexQuantity(block),
    logIndex: ethereumHexQuantity(order), removed: false });
  return { transactionHash, blockNumber: ethereumHexQuantity(block), blockHash: blockHash(block),
    status: '0x1', from: OWNER, to: CONTRACT, logs: [
      log([ETHEREUM_EVENT_TOPICS.Transfer, address(OWNER), address(ZERO), word(crate)], '0x', 0),
      ...Array.from({ length: 20 }, (_, offset) => log([
        ETHEREUM_EVENT_TOPICS.Transfer, address(ZERO), address(OWNER), word(first + offset),
      ], '0x', offset + 1)),
      log([ETHEREUM_EVENT_TOPICS.CrateUnboxed, word(crate), address(OWNER)], encodeAbi(['uint256', 'uint256'], [first, 20]), 21),
    ] };
}

test('native mainnet reveal shares expiring budget permits and preserves provider-sticky failover and hedging', { timeout: 90_000 }, async t => {
  type Mode = 'fast' | 'expiry' | 'failover' | 'hedge' | 'budget' | 'fallback';
  let mode: Mode = 'fast';
  const calls: Array<{ provider: string; method: string; params: unknown[]; mode: Mode }> = [];
  const errors: string[] = [];
  const releaseHedge = Promise.withResolvers<void>();
  let primaryHedgeCompleted = false;
  const rpc = createServer(async (request, response) => {
    const provider = request.url?.slice(1) ?? '';
    try {
      let text = '';
      for await (const chunk of request) text += String(chunk);
      const { id, method, params } = JSON.parse(text) as { id: number; method: string; params: unknown[] };
      calls.push({ provider, method, params, mode });
      let result: unknown;
      if (method === 'eth_chainId') result = '0x1';
      else if (method === 'eth_getTransactionReceipt') {
        const index = Number(BigInt(String(params[0]))) - 1;
        if (provider === 'alchemy' && mode === 'expiry') await new Promise(done => setTimeout(done, PROVIDER_BUDGETS.alchemy.leaseMs + 100));
        if (provider === 'alchemy' && mode === 'hedge') { await releaseHedge.promise; primaryHedgeCompleted = true; }
        result = receipt(index, provider === 'quicknode' ? 1001 : 1000);
      } else if (method === 'eth_blockNumber') {
        if (provider === 'alchemy' && mode === 'failover') {
          response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end('{"error":"fixture unavailable"}');
          return;
        }
        result = ethereumHexQuantity(1002);
      } else if (method === 'eth_getBlockByNumber') {
        const block = params[0] === 'latest' ? 1002 : Number(BigInt(String(params[0])));
        result = { number: ethereumHexQuantity(block), hash: blockHash(block) };
      } else throw new Error(`Unexpected ${provider} method ${method}`);
      if (response.destroyed) return;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      errors.push(String(error));
      if (!response.destroyed) { response.writeHead(500); response.end(); }
    }
  });
  await new Promise<void>(done => rpc.listen(0, '127.0.0.1', done));
  const server = rpc.address();
  assert.ok(server && typeof server === 'object');
  const directory = await mkdtemp(join(tmpdir(), 'ethereum-reveal-provider-runtime-'));
  const main = join(directory, 'worker.ts');
  await writeFile(main, `
    import { readEthereumRevealDeployment } from ${JSON.stringify(resolve('shared/ethereum/revealDeployment.ts'))};
    import { EthereumRevealObject as BaseCoordinator } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealObject.ts'))};
    import { EthereumRevealVerifierObject as BaseVerifier } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealVerifierObject.ts'))};
    export class EthereumRevealObject extends BaseCoordinator {
      constructor(ctx, env) { super(ctx, { ...env, ETHEREUM_PROVIDER_CONTROL_ENABLED:
        env.TEST_COORDINATOR_CONTROLS || env.ETHEREUM_PROVIDER_CONTROL_ENABLED }); }
    }
    export class EthereumRevealVerifierObject extends BaseVerifier {
      constructor(ctx, env) { super(ctx, { ...env, ETHEREUM_PROVIDER_CONTROL_ENABLED:
        env.TEST_VERIFIER_CONTROLS || env.ETHEREUM_PROVIDER_CONTROL_ENABLED }); }
    }
    export { EthereumRevealPublisherObject } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealPublisherObject.ts'))};
    export { EthereumProviderBudgetObject } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumProviderBudgetObject.ts'))};
    export { EthereumPublicReadCacheObject } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumPublicReadCacheObject.ts'))};
    export default { async fetch(request, env) {
      const body = await request.json();
      const deployment = await readEthereumRevealDeployment(env.OPS_DB, { chainId: 1, contractAddress: ${JSON.stringify(CONTRACT)} });
      const object = env.ETHEREUM_REVEAL.getByName('1:' + deployment.contractAddress);
      return Response.json(await object.revealTransaction(deployment, body.transactionHash, true));
    } };
  `);
  const production = JSON.parse(await readFile('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const classes = ['EthereumRevealObject', 'EthereumRevealVerifierObject', 'EthereumRevealPublisherObject', 'EthereumProviderBudgetObject', 'EthereumPublicReadCacheObject'];
  const bindings = ['ETHEREUM_REVEAL', 'ETHEREUM_REVEAL_VERIFIER', 'ETHEREUM_REVEAL_PUBLISHER', 'ETHEREUM_PROVIDER_BUDGET', 'ETHEREUM_PUBLIC_READ_CACHE'];
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  const config = {
    name: 'ethereum-reveal-provider-runtime', main,
    compatibility_date: production.compatibility_date, compatibility_flags: production.compatibility_flags,
    durable_objects: { bindings: classes.map((class_name, index) => ({ name: bindings[index], class_name })) },
    migrations: [{ tag: 'test-provider-reveal-v1', new_sqlite_classes: classes }],
    r2_buckets: [{ binding: 'ETHEREUM_REVEAL_METADATA', bucket_name: 'provider-test-metadata', remote: false }],
    d1_databases: production.d1_databases.filter((db: { binding: string }) => db.binding === 'OPS_DB')
      .map((db: { migrations_dir: string }) => ({ ...db, remote: false, migrations_dir: resolve('cloud/workers/api', db.migrations_dir) })),
    vars: { ETHEREUM_111K_CHAIN_ID: '1', ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT,
      ETHEREUM_111K_METADATA_BASE_URI: BASE_URI, ETHEREUM_111K_DEPLOYMENT_BLOCK: '100',
      ALCHEMY_MI_NOTE_API_KEY: 'native-reveal-test-only', ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true',
      QUICKNODE_ETHEREUM_MAINNET_ENABLED: 'true', ETHEREUM_PUBLIC_READ_CACHE_ENABLED: 'true',
      QUICKNODE_ETHEREUM_MAINNET_RPC_URL: 'https://native-reveal-test.quiknode.pro/test-only/' },
  };
  const runtime = createTestHarness({ root: directory, workers: [{ config }] });
  const nativeFetch = globalThis.fetch;
  try {
    await runtime.listen();
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (url.hostname === 'cdn.lil.org' && url.pathname.includes('/json/')) {
        return Response.json({ 'collection block': 'Native fixture', attributes: [] });
      }
      const provider = url.hostname === 'eth-mainnet.g.alchemy.com' ? 'alchemy'
        : url.hostname === 'native-reveal-test.quiknode.pro' ? 'quicknode' : null;
      assert.ok(provider, `Unexpected outbound URL ${url.origin}`);
      return nativeFetch(`http://127.0.0.1:${server.port}/${provider}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text(), signal: request.signal,
      });
    });
    const worker = runtime.getWorker<Env>('ethereum-reveal-provider-runtime');
    await worker.applyD1Migrations('OPS_DB');
    let env = await worker.getEnv();
    const templateJson = JSON.stringify(JSON.parse(await readFile('scripts/ethereum-metadata/templates/artwork.json', 'utf8')));
    await env.OPS_DB.prepare(buildEthereumRevealRegistration({ deploymentId: 'native-provider-mainnet', dropId: '111k',
      chainId: 1, contractAddress: CONTRACT, metadataBaseUri: BASE_URI, deploymentBlock: 100,
      catalogVersion: ETHEREUM_REVEAL_CATALOG_VERSION, templateJson,
      templateSha256: createHash('sha256').update(templateJson).digest('hex') })).run();
    const row = await env.OPS_DB.prepare("UPDATE ethereum_reveal_deployments SET state='active',revision=3,provisioned_at_ms=2,activated_at_ms=3 RETURNING *")
      .first<Record<string, unknown>>();
    assert.ok(row);
    const deployment = parseEthereumRevealDeployment(row);
    const name = `1:${CONTRACT}`;
    const object = env.ETHEREUM_REVEAL.getByName(name);
    for (let attempt = 0; attempt < 32; attempt++) if ((await object.initialize(deployment)).ready) break;
    let storage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name });
    const quiet = async () => {
      const later = Date.now() + 86_400_000;
      await storage.exec('UPDATE receipt_work SET next_check_ms=?', later);
      await storage.exec('UPDATE crate_candidates SET next_check_ms=?', later);
      await storage.exec('UPDATE crate_recovery_jobs SET receipt_due_ms=?,scan_due_ms=NULL', later);
    };
    const request = async (index: number) => {
      const response = await worker.fetch('https://reveal.test/', { method: 'POST', body: JSON.stringify({ transactionHash: hash(index + 1) }) });
      assert.equal(response.status, 200);
      const result = await response.json() as EthereumRevealResult<EthereumRevealTransactionResponse>;
      assert.equal(result.kind, 'ready');
      if (result.kind !== 'ready') assert.fail();
      return result.value;
    };
    const reveal = async (index: number) => {
      const deadline = performance.now() + 15_000;
      for (;;) {
        const value = await request(index);
        if (value.status === 'revealed') { await quiet(); return value; }
        assert.equal(value.status, 'pending');
        assert.ok(performance.now() < deadline, `Reveal ${index} did not finish`);
        await new Promise(done => setTimeout(done, 20));
      }
    };

    const fast = await reveal(0);
    assert.equal(fast.artworks.length, 20);
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.provider === 'alchemy'));
    let budgetStorage = await worker.getDurableObjectStorage('ETHEREUM_PROVIDER_BUDGET', { name: 'alchemy' });
    const grants = async () => (await budgetStorage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM provider_budget_grants'))[0].count;
    const beforeCached = await grants();
    assert.equal(beforeCached, 1);
    for (let index = 0; index < 5; index++) assert.deepEqual(await request(0), fast);
    assert.equal(calls.length, 4);
    assert.equal(await grants(), beforeCached);

    mode = 'expiry';
    await env.ETHEREUM_PROVIDER_BUDGET.getByName('quicknode').reportThrottle({ provider: 'quicknode', retryAfterMs: 5000 });
    const expired = await reveal(1);
    assert.equal(expired.artworks.length, 20);
    assert.equal(calls.filter(call => call.mode === 'expiry').length, 4);
    assert.ok(calls.filter(call => call.mode === 'expiry').every(call => call.provider === 'alchemy'));
    assert.ok(await grants() > beforeCached, 'Expired cross-DO permits must refill before further RPC');
    const quicknodeStorage = await worker.getDurableObjectStorage('ETHEREUM_PROVIDER_BUDGET', { name: 'quicknode' });
    await quicknodeStorage.exec('UPDATE provider_budget_control SET pause_until_ms=0');

    mode = 'failover';
    const fallback = await reveal(2);
    assert.ok(fallback.artworks.every(artwork => artwork.observation.blockNumber === 1001 && artwork.observation.blockHash === blockHash(1001)));
    assert.equal(calls.filter(call => call.mode === 'failover' && call.provider === 'quicknode').length, 4);
    assert.ok(calls.some(call => call.mode === 'failover' && call.provider === 'alchemy' && call.method === 'eth_getTransactionReceipt'));

    mode = 'hedge';
    const hedged = await reveal(3);
    assert.equal(primaryHedgeCompleted, false);
    assert.ok(hedged.artworks.every(artwork => artwork.observation.blockNumber === 1001));
    assert.equal(calls.filter(call => call.mode === 'hedge' && call.provider === 'quicknode').length, 4);
    releaseHedge.resolve();
    await new Promise(done => setTimeout(done, 50));
    assert.deepEqual(await request(3), hedged);

    mode = 'budget';
    await new Promise(done => setTimeout(done, PROVIDER_BUDGETS.alchemy.leaseMs + 100));
    await env.ETHEREUM_PROVIDER_BUDGET.getByName('alchemy').reportThrottle({ provider: 'alchemy', retryAfterMs: 1500 });
    const started = performance.now();
    const budgetFallback = await reveal(4);
    assert.ok(performance.now() - started < 1400, 'An active reveal must not wait for the primary permit cooldown');
    assert.ok(budgetFallback.artworks.every(artwork => artwork.observation.blockNumber === 1001));
    assert.equal(calls.filter(call => call.mode === 'budget').length, 4);
    assert.ok(calls.filter(call => call.mode === 'budget').every(call => call.provider === 'quicknode'));
    const afterCancellation = await grants();
    await new Promise(done => setTimeout(done, 1600));
    assert.equal(await grants(), afterCancellation, 'The losing provider must leave the coordinator permit queue');

    mode = 'fallback';
    for (const provider of ['alchemy', 'quicknode'] as const) {
      await env.ETHEREUM_PROVIDER_BUDGET.getByName(provider).reportThrottle({ provider, retryAfterMs: 60_000 });
    }
    const pendingCalls = calls.length;
    assert.equal((await request(5)).status, 'pending');
    assert.equal(calls.length, pendingCalls);
    const pendingWork = (await storage.exec<{ hash: string; requested_all: number; resolved: number }>(
      'SELECT hash,requested_all,resolved FROM receipt_work WHERE hash=?', hash(6)))[0];
    assert.deepEqual(pendingWork, { hash: hash(6), requested_all: 1, resolved: 0 });
    const beforeFallback = await grants();
    const reload = async (coordinator = 'false', verifier = 'false', controls = 'false') => {
      await runtime.update({ root: directory, workers: [{ config: { ...config, vars: { ...config.vars,
        ETHEREUM_PROVIDER_CONTROL_ENABLED: controls, ETHEREUM_PUBLIC_READ_CACHE_ENABLED: controls,
        QUICKNODE_ETHEREUM_MAINNET_ENABLED: 'false', TEST_COORDINATOR_CONTROLS: coordinator,
        TEST_VERIFIER_CONTROLS: verifier } } }] });
      await runtime.listen();
      env = await worker.getEnv();
      storage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name });
      budgetStorage = await worker.getDurableObjectStorage('ETHEREUM_PROVIDER_BUDGET', { name: 'alchemy' });
    };
    await reload();
    const completedCalls = calls.length;
    assert.deepEqual(await request(0), fast);
    assert.equal(calls.length, completedCalls, 'Completed reveals must remain provider-free after fallback');
    assert.equal(await grants(), beforeFallback, 'Fallback must preserve the existing quota ledger');
    assert.deepEqual((await storage.exec<{ hash: string; requested_all: number; resolved: number }>(
      'SELECT hash,requested_all,resolved FROM receipt_work WHERE hash=?', hash(6)))[0], pendingWork);
    await storage.exec('UPDATE receipt_work SET lease_until_ms=0,next_check_ms=0 WHERE hash=?', hash(6));
    const recovered = await reveal(5);
    assert.equal(recovered.artworks.length, 20);
    assert.ok(recovered.artworks.every(artwork => artwork.observation.blockNumber === 1000));
    assert.equal(await grants(), beforeFallback, 'Controls-off recovery must not acquire new provider permits');
    assert.ok(calls.slice(pendingCalls).every(call => call.provider === 'alchemy'));
    await budgetStorage.exec('UPDATE provider_budget_control SET pause_until_ms=0');

    for (const [offset, [coordinator, verifier]] of [['true', 'false'], ['false', 'true']].entries()) {
      await reload(coordinator, verifier);
      const before = await grants();
      const rpcBefore: number = calls.length;
      assert.deepEqual(await request(0), fast);
      assert.equal(calls.length, rpcBefore);
      const mixed = await reveal(6 + offset);
      assert.equal(mixed.artworks.length, 20);
      assert.ok(mixed.artworks.every(artwork => artwork.observation.blockNumber === 1000));
      assert.ok(calls.slice(rpcBefore).every(call => call.provider === 'alchemy'));
      assert.equal(await grants() > before, verifier === 'true');
    }
    await reload('true', 'true', 'true');
    const beforeReenable = await grants(), reenabledCalls = calls.length;
    assert.deepEqual(await request(0), fast);
    assert.deepEqual(await request(5), recovered);
    assert.equal(calls.length, reenabledCalls);
    assert.equal((await reveal(8)).artworks.length, 20);
    assert.ok(await grants() > beforeReenable);
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM assignments WHERE token_id IS NOT NULL'))[0].count, 180);
    assert.deepEqual(errors, []);
    t.diagnostic(JSON.stringify({ runtime: 'native-workerd', mainnet: true, fastRpcCalls: 4,
      budgetGrants: await grants(), failoverRpcCalls: 4, hedgeRpcCalls: 4, cachedRpcCalls: 0,
      fallbackPendingRecovered: true, mixedControlRecovery: true, reenabledControls: true, preservedArtworks: 180 }));
  } finally {
    releaseHedge.resolve();
    await runtime.close();
    rpc.closeAllConnections();
    await new Promise<void>(done => rpc.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
