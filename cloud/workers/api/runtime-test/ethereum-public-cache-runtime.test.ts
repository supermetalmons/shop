import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import type { EthereumStats } from '../../../../shared/ethereum/api.ts';
import type { EthereumOwnerIds, EthereumPublicReadCacheScope } from '../src/ethereumPublicReadCache.ts';

const CONTRACT = `0x${'11'.repeat(20)}`;
const OWNER = `0x${'22'.repeat(20)}`;
const OTHER_OWNER = `0x${'33'.repeat(20)}`;
const SCOPE: EthereumPublicReadCacheScope = { chainId: 1, contractAddress: CONTRACT, deploymentId: 'mainnet-v1',
  revision: 3, catalogRevision: 0, catalogUpdateId: null, metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 100 };

test('native public cache coalesces requests without coupling caller cancellation or collection identities', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ethereum-public-cache-runtime-'));
  const main = join(directory, 'worker.ts');
  await writeFile(main, `
    import { EthereumPublicReadCacheObject as Base } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumPublicReadCacheObject.ts'))};
    import { cachedEthereumCollectionStats, cachedAlchemyOwnerIds, ethereumPublicReadCacheName } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumPublicReadCache.ts'))};
    const actualNow = Date.now;
    let clockOffset = 0;
    Date.now = () => actualNow() + clockOffset;
    export class EthereumPublicReadCacheObject extends Base {
      advanceClock(milliseconds) { clockOffset += milliseconds; }
    }
    export default {
      async fetch(request, env) {
        const url = new URL(request.url);
        const controller = new AbortController();
        const scope = { ...${JSON.stringify(SCOPE)}, revision: Number(url.searchParams.get('revision') || 3),
          chainId: Number(url.searchParams.get('chainId') || 1) };
        if (url.pathname === '/clock') {
          await env.ETHEREUM_PUBLIC_READ_CACHE.getByName(ethereumPublicReadCacheName(scope, null)).advanceClock(Number(url.searchParams.get('milliseconds')));
          return Response.json({ ok: true });
        }
        const context = { env, nowMs: Date.now(), signal: controller.signal, fetch,
          config: { ...scope, enabled: true }, publicReadCacheScope: scope };
        const owner = url.searchParams.get('owner');
        const timeout = url.searchParams.has('cancel') ? setTimeout(() => controller.abort(new Error('caller cancelled')), 200) : undefined;
        try {
          const value = url.pathname === '/owner'
            ? await cachedAlchemyOwnerIds(context, owner, url.searchParams.get('cursor'))
            : await cachedEthereumCollectionStats(context, owner);
          return Response.json(value, { headers: {
            'X-Test-Stats-Expires-At': String(context.publicReadCacheExpiresAtMs ?? ''),
          } });
        } catch (error) {
          return Response.json({ error: error.message }, { status: controller.signal.aborted ? 499 : 503 });
        } finally { if (timeout !== undefined) clearTimeout(timeout); }
      }
    };
  `);
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  const runtime = createTestHarness({ root: directory, workers: [{ config: {
    name: 'ethereum-public-cache-test', main, compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'],
    vars: { ALCHEMY_MI_NOTE_API_KEY: 'public-cache-test-only', ETHEREUM_PROVIDER_CONTROL_ENABLED: 'false',
      QUICKNODE_ETHEREUM_MAINNET_ENABLED: 'true', QUICKNODE_ETHEREUM_MAINNET_RPC_URL: 'https://cache-test.quiknode.pro/test-only' },
    durable_objects: { bindings: [{ name: 'ETHEREUM_PUBLIC_READ_CACHE', class_name: 'EthereumPublicReadCacheObject' }] },
    migrations: [{ tag: 'public-cache-v1', new_sqlite_classes: ['EthereumPublicReadCacheObject'] }],
  } }] });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let holdStats = true;
  let failOwner = false;
  let failAlchemyStats = false;
  let statsCalls = 0;
  let ownerCalls = 0;
  let maximumCalls = 0;
  let maskCalls = 0;
  const observedOwners: string[] = [];
  const errors: string[] = [];
  try {
    await runtime.listen();
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const request = new Request(input, init);
        const url = new URL(request.url);
        assert.ok(['eth-mainnet.g.alchemy.com', 'eth-sepolia.g.alchemy.com', 'cache-test.quiknode.pro'].includes(url.hostname));
        if (url.pathname.includes('/nft/')) {
          ownerCalls++;
          if (failOwner) return Response.json({ error: 'temporary' }, { status: 503 });
          return Response.json({ ownedNfts: [{ tokenId: url.searchParams.has('pageKey') ? '2' : '1', contractAddress: CONTRACT }],
            ...(url.searchParams.has('pageKey') ? {} : { pageKey: 'next' }) });
        }
        type Rpc = { id: number; method: string; params: unknown[] };
        const payload = await request.json() as Rpc | Rpc[];
        if (failAlchemyStats && url.hostname === 'eth-mainnet.g.alchemy.com' && !Array.isArray(payload) &&
          payload.method === 'eth_call' && (payload.params[0] as { data: string }).data.startsWith(encodeCall('stats(address)', [], []))) {
          return Response.json({ error: 'temporary' }, { status: 503 });
        }
        const respond = async ({ id, method, params }: Rpc) => {
          let result: unknown;
          if (method === 'eth_chainId') result = url.hostname === 'eth-sepolia.g.alchemy.com' ? '0xaa36a7' : '0x1';
          else {
            assert.equal(method, 'eth_call');
            const { data, to } = params[0] as { data: string; to: string };
            assert.equal(to, CONTRACT);
            if (data === encodeCall('MAX_RELICS()', [], [])) { maximumCalls++; result = encodeAbi(['uint256'], [18]); }
            else if (data === encodeCall('getRelicClaimedMask()', [], [])) { maskCalls++; result = encodeAbi(['uint256'], [0]); }
            else {
              assert.equal(data.slice(0, 10), encodeCall('stats(address)', [], []));
              statsCalls++;
              observedOwners.push(`0x${data.slice(-40)}`);
              if (holdStats) { entered.resolve(); await release.promise; }
              result = encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32',
                'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
              [0, 0, 0, 30_000_000_000_000_000n, 300_000_000_000_000_000n, false, `0x${'00'.repeat(32)}`,
                15_000_000_000_000_000n, 1, 0, 0, 0, 500, 0, 0]);
            }
          }
          return { jsonrpc: '2.0', id, result };
        };
        return Response.json(Array.isArray(payload) ? await Promise.all(payload.map(respond)) : await respond(payload));
      } catch (error) { errors.push(String(error)); throw error; }
    });
    const worker = runtime.getWorker('ethereum-public-cache-test');
    const first = worker.fetch('https://cache.test/stats?cancel=1');
    await entered.promise;
    const second = worker.fetch('https://cache.test/stats');
    assert.equal((await first).status, 499);
    holdStats = false;
    release.resolve();
    const result = await second;
    assert.equal(result.status, 200);
    const stats = await result.json() as EthereumStats;
    assert.equal(stats.chainId, 1);
    assert.equal(Object.hasOwn(stats, 'expiresAtMs'), false);
    const freshExpiry = Number(result.headers.get('X-Test-Stats-Expires-At'));
    assert.ok(freshExpiry > Date.now());
    assert.equal(statsCalls, 1);
    const cached = await worker.fetch('https://cache.test/stats');
    assert.equal(cached.status, 200);
    const retainedExpiry = Number(cached.headers.get('X-Test-Stats-Expires-At'));
    assert.ok(retainedExpiry > Date.now() && retainedExpiry <= freshExpiry);
    assert.equal(statsCalls, 1);
    const changed = await worker.fetch('https://cache.test/stats?revision=4');
    assert.equal(changed.status, 200);
    assert.equal(statsCalls, 2);
    assert.equal(maskCalls, 2);
    assert.equal(maximumCalls, 1);
    const owners = await Promise.all([OWNER, OTHER_OWNER].map(async owner => {
      const response = await worker.fetch(`https://cache.test/stats?owner=${owner}`);
      assert.equal(response.status, 200);
      return response.json() as Promise<EthereumStats>;
    }));
    assert.deepEqual(owners.map(value => value.owner), [OWNER, OTHER_OWNER]);
    assert.ok(observedOwners.includes(OWNER) && observedOwners.includes(OTHER_OWNER));
    const sepolia = await worker.fetch('https://cache.test/stats?chainId=11155111');
    assert.equal((await sepolia.json() as EthereumStats).chainId, 11155111);
    const ownerUrl = `https://cache.test/owner?owner=${OWNER}`;
    const pages = await Promise.all([worker.fetch(ownerUrl), worker.fetch(ownerUrl)]);
    assert.ok(pages.every(value => value.status === 200));
    assert.equal(ownerCalls, 1);
    assert.deepEqual(await pages[0].json(), { ids: ['1'], nextCursor: 'next' });
    const next = await worker.fetch(`${ownerUrl}&cursor=next`);
    assert.equal(next.status, 200);
    assert.equal((await next.json() as EthereumOwnerIds).ids[0], '2');
    assert.equal(ownerCalls, 2);
    failOwner = true;
    assert.equal((await worker.fetch(`${ownerUrl}&revision=5`)).status, 503);
    failOwner = false;
    assert.equal((await worker.fetch(`${ownerUrl}&revision=5`)).status, 200);
    assert.equal(ownerCalls, 4);
    const maximumBeforeFailover = maximumCalls;
    failAlchemyStats = true;
    assert.equal((await worker.fetch('https://cache.test/stats?revision=8')).status, 200);
    assert.equal(maximumCalls, maximumBeforeFailover + 1);
    failAlchemyStats = false;
    await worker.fetch('https://cache.test/clock?milliseconds=600001');
    assert.equal((await worker.fetch('https://cache.test/stats?revision=9')).status, 200);
    assert.equal(maximumCalls, maximumBeforeFailover + 2);
    assert.deepEqual(errors, []);
  } finally {
    release.resolve();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native public cache shares permits and fallback reads bypass cache and budget bindings', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ethereum-cache-budget-runtime-'));
  const main = join(directory, 'worker.ts');
  const secondOwner = `0x${'33'.repeat(19)}32`;
  await writeFile(main, `
    export { EthereumPublicReadCacheObject } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumPublicReadCacheObject.ts'))};
    import { EthereumProviderBudgetObject as Base } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumProviderBudgetObject.ts'))};
    import { cachedAlchemyOwnerIds } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumPublicReadCache.ts'))};
    import { ethereumCollectionStats, readAlchemyOwnerIds } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRead.ts'))};
    export class EthereumProviderBudgetObject extends Base {
      grants = 0;
      async grant(request) { this.grants++; return super.grant(request); }
      grantCount() { return this.grants; }
    }
    export default {
      async fetch(request, env) {
        if (new URL(request.url).pathname === '/count') {
          return Response.json(await env.ETHEREUM_PROVIDER_BUDGET.getByName('alchemy').grantCount());
        }
        const scope = ${JSON.stringify(SCOPE)};
        const selectedEnv = new URL(request.url).pathname === '/fallback' ? { ...env,
          ETHEREUM_PUBLIC_READ_CACHE_ENABLED: 'false', ETHEREUM_PROVIDER_CONTROL_ENABLED: 'false',
          QUICKNODE_ETHEREUM_MAINNET_ENABLED: 'false',
          ETHEREUM_PUBLIC_READ_CACHE: { getByName() { throw new Error('Unexpected fallback cache call'); } },
          ETHEREUM_PROVIDER_BUDGET: { getByName() { throw new Error('Unexpected fallback budget call'); } },
        } : env;
        const context = { env: selectedEnv, nowMs: Date.now(), signal: AbortSignal.timeout(10000), fetch,
          config: { ...scope, enabled: true }, publicReadCacheScope: scope };
        const results = await Promise.all([
          ethereumCollectionStats(context, ${JSON.stringify(OWNER)}),
          cachedAlchemyOwnerIds(context, ${JSON.stringify(secondOwner)}, null) ?? readAlchemyOwnerIds(context, ${JSON.stringify(secondOwner)}, null),
        ]);
        return Response.json(results);
      }
    };
  `);
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  const runtime = createTestHarness({ root: directory, workers: [{ config: {
    name: 'ethereum-cache-budget-test', main, compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'],
    vars: { ALCHEMY_MI_NOTE_API_KEY: 'cache-budget-test-only', ETHEREUM_PROVIDER_CONTROL_ENABLED: 'true',
      ETHEREUM_PUBLIC_READ_CACHE_ENABLED: 'true' },
    durable_objects: { bindings: [
      { name: 'ETHEREUM_PUBLIC_READ_CACHE', class_name: 'EthereumPublicReadCacheObject' },
      { name: 'ETHEREUM_PROVIDER_BUDGET', class_name: 'EthereumProviderBudgetObject' },
    ] },
    migrations: [{ tag: 'cache-budget-v1', new_sqlite_classes: ['EthereumPublicReadCacheObject', 'EthereumProviderBudgetObject'] }],
  } }] });
  let statsCalls = 0;
  let nftCalls = 0;
  const errors: string[] = [];
  try {
    await runtime.listen();
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const request = new Request(input, init);
        const url = new URL(request.url);
        assert.equal(url.hostname, 'eth-mainnet.g.alchemy.com');
        if (url.pathname.includes('/nft/')) {
          nftCalls++;
          assert.equal(url.searchParams.get('owner'), secondOwner);
          return Response.json({ ownedNfts: [{ tokenId: '1', contractAddress: CONTRACT }] });
        }
        type Rpc = { id: number; method: string; params: unknown[] };
        const payload = await request.json() as Rpc | Rpc[];
        const respond = ({ id, method, params }: Rpc) => {
          let result: unknown;
          if (method === 'eth_chainId') result = '0x1';
          else {
            assert.equal(method, 'eth_call');
            const { data } = params[0] as { data: string };
            if (data === encodeCall('MAX_RELICS()', [], [])) result = encodeAbi(['uint256'], [18]);
            else if (data === encodeCall('getRelicClaimedMask()', [], [])) result = encodeAbi(['uint256'], [0]);
            else {
              assert.equal(data, encodeCall('stats(address)', ['address'], [OWNER]));
              statsCalls++;
              result = encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32',
                'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
              [0, 0, 0, 30_000_000_000_000_000n, 300_000_000_000_000_000n, false, `0x${'00'.repeat(32)}`,
                15_000_000_000_000_000n, 1, 0, 0, 0, 500, 0, 0]);
            }
          }
          return { jsonrpc: '2.0', id, result };
        };
        return Response.json(Array.isArray(payload) ? payload.map(respond) : respond(payload));
      } catch (error) { errors.push(String(error)); throw error; }
    });
    const worker = runtime.getWorker('ethereum-cache-budget-test');
    const response = await worker.fetch('https://cache-budget.test/fill');
    assert.equal(response.status, 200);
    const [stats, ids] = await response.json() as [EthereumStats, EthereumOwnerIds];
    assert.equal(stats.owner, OWNER);
    assert.deepEqual(ids, { ids: ['1'], nextCursor: null });
    assert.equal(statsCalls, 1);
    assert.equal(nftCalls, 1);
    assert.equal(await (await worker.fetch('https://cache-budget.test/count')).json(), 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const fallback = await worker.fetch('https://cache-budget.test/fallback');
      assert.equal(fallback.status, 200);
      assert.deepEqual(await fallback.json(), [stats, ids]);
    }
    assert.equal(statsCalls, 3);
    assert.equal(nftCalls, 3);
    assert.equal(await (await worker.fetch('https://cache-budget.test/count')).json(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
