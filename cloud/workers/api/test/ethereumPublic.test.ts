import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ETHEREUM_API_PATHS as paths, type EthereumPublicCollectionConfig, type EthereumPublicCollectionScope, type EthereumStats } from '../../../../shared/ethereum/api.ts';
import descriptor from '../../../../shared/ethereum/revealCatalog.json';
import { parseEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { ethereumCatalogSnapshot, requireEthereumCatalogSnapshot, type EthereumRevealCatalogSnapshot } from '../src/ethereumCatalogRevision.ts';
import { ethereumPublicRequest } from '../src/ethereumPublic.ts';
import type { EthereumCollectionReadContext, EthereumEnvironment, EthereumRequestContext } from '../src/ethereumRuntime.ts';
import { d1Database } from './commerceD1Harness.ts';

const CONTRACT = `0x${'11'.repeat(20)}`;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const TRANSACTION_HASH = `0x${'cd'.repeat(32)}`;
const ZERO = `0x${'00'.repeat(20)}`;
type Rpc = { id: number; method: string; params: unknown[] };
type PublicStats = EthereumStats & EthereumPublicCollectionScope;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(chainId = 1, state: EthereumRevealDeployment['state'] = 'active') {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0009_ethereum_reveal_deployments', '0011_ethereum_reveal_retirement', '0012_ethereum_reveal_catalog_updates']) {
    database.exec(readFileSync(`cloud/workers/api/ops-migrations/${migration}.sql`, 'utf8'));
  }
  const deploymentId = chainId === 1 ? 'mainnet-v1' : 'test-sepolia';
  const metadataBaseUri = chainId === 1 ? 'https://cdn.mons.shop/111k/' : 'https://cdn.mons.shop/111k-sepolia/test-sepolia/';
  const dropId = chainId === 1 ? '111k' : '111k_devnet';
  const price = chainId === 1 ? 30_000_000_000_000_000n : 100_000_000_000_000n;
  database.prepare(`INSERT INTO ethereum_reveal_deployments
    (deployment_id,drop_id,chain_id,contract_address,metadata_base_uri,deployment_block,catalog_version,template_json,
      template_sha256,state,revision,created_at_ms,updated_at_ms,provisioned_at_ms,activated_at_ms)
    VALUES(?,?,?,?,?,100,?,?,?, ?,3,1,1,1,1)`)
    .run(deploymentId, dropId, chainId, CONTRACT, metadataBaseUri, descriptor.catalogVersion,
      JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] }),
      '0'.repeat(64), state);
  const controller = new AbortController();
  const counts = { registry: 0, snapshots: 0, stats: 0, rpc: 0 };
  let missing = false;
  let beforeRegistry: (read: number) => void | Promise<void> = () => {};
  let duringStats: () => void | Promise<void> = () => {};
  let snapshot: (tokenIds: string[]) => EthereumRevealCatalogSnapshot | Promise<EthereumRevealCatalogSnapshot> = () =>
    ({ deploymentId, catalogRevision: 0, artworks: [] });
  const original = d1Database(database);
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
      if (property === 'first') return async <T>(column?: string): Promise<T | null> => {
        await beforeRegistry(++counts.registry);
        if (missing) return null;
        return column === undefined ? target.first<T>() : target.first<T>(column);
      };
      return Reflect.get(target, property);
    },
  });
  const ops = new Proxy(original, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      return Reflect.get(target, property);
    },
  });
  const commerce = new Proxy({} as D1Database, { get: () => assert.fail('Public reads must not access Commerce') });
  const namespace = new Proxy({} as Env['ETHEREUM_REVEAL'], {
    get(_target, property) {
      assert.equal(property, 'getByName');
      return (name: string) => {
        assert.equal(name, `${chainId}:${CONTRACT}`);
        return { catalogSnapshot: async (_deployment: EthereumRevealDeployment, tokenIds: string[]) => {
          counts.snapshots++;
          return snapshot(tokenIds);
        } };
      };
    },
  });
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const env: EthereumEnvironment = {
    OPS_DB: ops, COMMERCE_DB: commerce, ALCHEMY_MI_NOTE_API_KEY: 'public-test-only',
    ETHEREUM_111K_CHAIN_ID: '11155111', ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT,
    ETHEREUM_111K_METADATA_BASE_URI: 'https://cdn.mons.shop/111k-sepolia/test-sepolia/',
    ETHEREUM_111K_DEPLOYMENT_BLOCK: '100', ETHEREUM_111K_RPC_URL: '',
    STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter, STAFF_AUTH_SESSION_RATE_LIMITER: limiter,
    PUBLIC_SHOP_RATE_LIMITER: limiter, ETHEREUM_REVEAL: namespace,
  };
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, chainId === 1 ? 'eth-mainnet.g.alchemy.com' : 'eth-sepolia.g.alchemy.com');
    if (url.pathname.includes('/nft/v3/')) return Response.json({ ownedNfts: [] });
    const payload = JSON.parse(String(init?.body)) as Rpc | Rpc[];
    const respond = async ({ id, method, params }: Rpc) => {
      counts.rpc++;
      let result: unknown;
      if (method === 'eth_chainId') result = `0x${chainId.toString(16)}`;
      else if (method === 'eth_getBlockByNumber') result = { number: '0x64', hash: BLOCK_HASH };
      else if (method === 'eth_getTransactionReceipt') result = null;
      else {
        assert.equal(method, 'eth_call');
        const call = params[0] as { to: string; data: string };
        assert.equal(call.to, CONTRACT);
        if (call.data === encodeCall('MAX_RELICS()', [], [])) result = encodeAbi(['uint256'], [18]);
        else if (call.data === encodeCall('getRelicClaimedMask()', [], [])) result = encodeAbi(['uint256'], [0]);
        else {
          assert.equal(call.data, encodeCall('stats(address)', ['address'], [ZERO]));
          counts.stats++;
          await duringStats();
          result = encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32',
            'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
          [0, 0, 0, price, price * 10n, false, `0x${'00'.repeat(32)}`, price / 2n, 1, 0, 0, 0, 500, 0, 0]);
        }
      }
      return { jsonrpc: '2.0', id, result };
    };
    return Response.json(Array.isArray(payload) ? await Promise.all(payload.map(respond)) : await respond(payload));
  };
  const context: EthereumRequestContext = { env, signal: controller.signal, nowMs: 1, fetch: providerFetch };
  const readContext: EthereumCollectionReadContext = { ...context,
    config: { chainId, contractAddress: CONTRACT, enabled: true, metadataBaseUri, deploymentBlock: 100 } };
  const request = (path: string, extra = '') => ethereumPublicRequest(new Request(
    `https://api.mons.shop${path}?chainId=${chainId}&contractAddress=${CONTRACT}${extra}`,
    { headers: { Origin: 'https://vvv.so' } }), context, path);
  const readDeployment = () => parseEthereumRevealDeployment(database.prepare('SELECT * FROM ethereum_reveal_deployments WHERE deployment_id=?')
    .get(deploymentId) as Record<string, unknown>);
  return { database, controller, counts, context, readContext, env, request, readDeployment,
    chainId, deploymentId, dropId, metadataBaseUri, price,
    beforeRegistry: (hook: typeof beforeRegistry) => { beforeRegistry = hook; },
    disappear: () => { missing = true; },
    duringStats: (hook: typeof duringStats) => { duringStats = hook; },
    snapshot: (hook: typeof snapshot) => { snapshot = hook; },
    beginUpdate: () => database.prepare('UPDATE ethereum_reveal_deployments SET catalog_update_id=?,catalog_update_started_at_ms=1,revision=revision+1 WHERE deployment_id=?')
      .run('test-update', deploymentId),
    setCatalogRevision: (revision: number) => database.prepare(`UPDATE ethereum_reveal_deployments
      SET effective_catalog_version=?,effective_catalog_sha256=?,catalog_revision=?,revision=revision+1 WHERE deployment_id=?`)
      .run(descriptor.catalogVersion, descriptor.manifestSha256, revision, deploymentId),
  };
}

for (const chainId of [1, 11155111]) for (const state of ['ready', 'active', 'paused'] as const) {
  test(`stable ${chainId} ${state} config and stats need two registry reads and no reveal object`, async t => {
    const f = fixture(chainId, state);
    t.after(() => f.database.close());
    const catalogRevision = state === 'ready' ? 0 : 1;
    if (catalogRevision) {
      f.beginUpdate();
      f.setCatalogRevision(catalogRevision);
      f.database.prepare('UPDATE ethereum_reveal_deployments SET catalog_update_id=NULL,catalog_update_started_at_ms=NULL,revision=revision+1 WHERE deployment_id=?').run(f.deploymentId);
    }
    f.snapshot(() => assert.fail('Stable config and stats must not depend on the reveal object'));
    const config = await f.request(paths.config) as EthereumPublicCollectionConfig;
    assert.deepEqual(config, {
      deploymentId: f.deploymentId, dropId: f.dropId, chainId, contractAddress: CONTRACT, catalogRevision,
      chainName: chainId === 1 ? 'Ethereum' : 'Sepolia', metadataBaseUri: f.metadataBaseUri, deploymentBlock: 100,
      explorerUrl: chainId === 1 ? 'https://etherscan.io' : 'https://sepolia.etherscan.io',
      walletRpcUrl: chainId === 1 ? 'https://ethereum-rpc.publicnode.com' : 'https://ethereum-sepolia-rpc.publicnode.com',
      testnet: chainId !== 1, enabled: true, revealEnabled: state === 'active', saleActive: false,
      cratePriceWei: String(f.price), warehousePriceWei: String(f.price * 10n), confirmationBlocks: 3, maxMintQuantity: 15, maxUnboxQuantity: 15,
    });
    assert.deepEqual(f.counts, { registry: 2, snapshots: 0, stats: 1, rpc: 4 });
    delete f.env.ETHEREUM_REVEAL;
    const stats = await f.request(paths.stats) as PublicStats;
    assert.equal(stats.chainId, chainId);
    assert.equal(stats.contractAddress, CONTRACT);
    assert.equal(stats.catalogRevision, catalogRevision);
    assert.equal(stats.cratePriceWei, String(f.price));
    assert.equal(stats.saleActive, false);
    assert.deepEqual(f.counts, { registry: 4, snapshots: 0, stats: 2, rpc: 8 });
  });
}

for (const path of [paths.config, paths.stats]) {
  test(`in-progress ${path} reads one authoritative catalog snapshot while the registry mirror lags`, async t => {
    const f = fixture();
    t.after(() => f.database.close());
    f.beginUpdate();
    f.snapshot(() => ({ deploymentId: f.deploymentId, catalogRevision: 1, artworks: [] }));
    const result = await f.request(path) as EthereumPublicCollectionScope;
    assert.equal(result.catalogRevision, 1);
    assert.equal(f.readDeployment().catalogRevision, 0);
    assert.equal(f.counts.snapshots, 1);
    assert.equal(f.counts.stats, 1);
  });
}

test('an in-progress update fails closed when the authoritative reveal object is unavailable', async t => {
  const f = fixture();
  t.after(() => f.database.close());
  f.beginUpdate();
  delete f.env.ETHEREUM_REVEAL;
  await assert.rejects(f.request(paths.stats), /temporarily unavailable/);
  assert.equal(f.counts.stats, 1);
});

test('an activation during the onchain read uses the advanced DO revision before its registry mirror arrives', async t => {
  const f = fixture();
  t.after(() => f.database.close());
  f.beginUpdate();
  let activeCatalogRevision = 0;
  f.duringStats(() => { activeCatalogRevision = 1; });
  f.snapshot(() => ({ deploymentId: f.deploymentId, catalogRevision: activeCatalogRevision, artworks: [] }));
  const result = await f.request(paths.stats) as PublicStats;
  assert.equal(result.catalogRevision, 1);
  assert.equal(f.readDeployment().catalogRevision, 0);
  assert.equal(f.counts.snapshots, 1);
  assert.equal(f.counts.stats, 1);
});

for (const transition of ['begin', 'finish', 'cancel', 'pause', 'catalog-revision'] as const) {
  test(`pure reads retry when ${transition} changes their registry snapshot`, async t => {
    const f = fixture();
    t.after(() => f.database.close());
    if (transition === 'finish' || transition === 'cancel' || transition === 'catalog-revision') f.beginUpdate();
    f.snapshot(() => ({ deploymentId: f.deploymentId, catalogRevision: transition === 'cancel' ? 0 : 1, artworks: [] }));
    f.duringStats(() => {
      if (f.counts.stats !== 1) return;
      if (transition === 'begin') f.beginUpdate();
      else if (transition === 'catalog-revision') f.setCatalogRevision(1);
      else if (transition === 'pause') f.database.prepare("UPDATE ethereum_reveal_deployments SET state='paused',revision=revision+1 WHERE deployment_id=?").run(f.deploymentId);
      else {
        if (transition === 'finish') f.setCatalogRevision(1);
        f.database.prepare('UPDATE ethereum_reveal_deployments SET catalog_update_id=NULL,catalog_update_started_at_ms=NULL,revision=revision+1 WHERE deployment_id=?').run(f.deploymentId);
      }
    });
    const result = await f.request(paths.config) as EthereumPublicCollectionConfig;
    assert.equal(f.counts.stats, 2);
    assert.equal(result.catalogRevision, transition === 'cancel' || transition === 'pause' ? 0 : 1);
    assert.equal(result.revealEnabled, transition !== 'pause');
    assert.equal(result.enabled, true);
  });
}

for (const change of ['disappear', 'retire'] as const) {
  test(`pure reads reject a collection that ${change}s during the onchain read`, async t => {
    const f = fixture(11155111, change === 'retire' ? 'paused' : 'active');
    t.after(() => f.database.close());
    if (change === 'retire') f.database.prepare(`INSERT INTO ethereum_reveal_deployments
      SELECT 'replacement',drop_id,chain_id,?, 'https://cdn.mons.shop/111k-sepolia/replacement/',deployment_block,
      catalog_version,template_json,template_sha256,'active',revision,created_at_ms,updated_at_ms,activated_at_ms,
      provisioned_at_ms,last_error,NULL,NULL,effective_catalog_version,effective_catalog_sha256,catalog_revision,
      catalog_update_id,catalog_update_started_at_ms FROM ethereum_reveal_deployments WHERE deployment_id=?`)
      .run(`0x${'22'.repeat(20)}`, f.deploymentId);
    f.duringStats(() => {
      if (change === 'disappear') f.disappear();
      else f.database.prepare("UPDATE ethereum_reveal_deployments SET retired_at_ms=1,replacement_deployment_id='replacement',revision=revision+1 WHERE deployment_id=?").run(f.deploymentId);
    });
    await assert.rejects(f.request(paths.stats), change === 'disappear' ? /not registered/ : /retired/);
  });
}

test('metadata-bearing reads keep authoritative snapshots around their result', async t => {
  const f = fixture();
  t.after(() => f.database.close());
  f.snapshot(tokenIds => ({ deploymentId: f.deploymentId, catalogRevision: 0, artworks: tokenIds.map(tokenId => ({
    tokenId, metadataRevision: 0, metadataJson: JSON.stringify({ name: 'Canonical artwork', image: 'https://cdn.lil.org/nft/111k/placeholder.png' }),
  })) }));
  const metadata = await f.request(paths.metadata, '&kind=artwork&displayId=1') as { name: string; catalogRevision: number };
  assert.equal(metadata.name, 'Canonical artwork');
  assert.equal(metadata.catalogRevision, 0);
  assert.equal(f.counts.snapshots, 3);
  const inventory = await f.request(paths.inventory, `&owner=${CONTRACT}`) as { items: unknown[] };
  assert.deepEqual(inventory.items, []);
  assert.equal(f.counts.snapshots, 6);
  const pending = await ethereumPublicRequest(new Request(`https://api.mons.shop${paths.transactionsConfirm}`, {
    method: 'POST', headers: { Origin: 'https://vvv.so', 'Content-Type': 'application/json', 'X-Mons-CSRF': '1' },
    body: JSON.stringify({ chainId: f.chainId, contractAddress: CONTRACT, transactionHash: TRANSACTION_HASH }),
  }), f.context, paths.transactionsConfirm) as { status: string };
  assert.equal(pending.status, 'pending');
  assert.equal(f.counts.snapshots, 8);
});

async function abortBlockedRead(start: () => Promise<unknown>, entered: Promise<void>, release: () => void, controller: AbortController) {
  const reason = new Error('request deadline reached');
  const operation = start();
  const rejected = assert.rejects(operation, error => error === reason);
  await entered;
  controller.abort(reason);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([rejected, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Registry read ignored the request deadline')), 1000);
    })]);
  } finally {
    clearTimeout(timeout);
    release();
    await rejected;
  }
}

for (const location of ['initial-public', 'final-public', 'catalog-snapshot', 'catalog-revalidation'] as const) {
  test(`${location} registry reads stop waiting when the request deadline aborts`, async t => {
    const f = fixture();
    t.after(() => f.database.close());
    const entered = deferred();
    const blocked = deferred();
    f.beforeRegistry(read => {
      if (read !== (location === 'final-public' ? 2 : 1)) return;
      entered.resolve();
      return blocked.promise;
    });
    const start = location === 'catalog-snapshot' ? () => ethereumCatalogSnapshot(f.readContext)
      : location === 'catalog-revalidation' ? () => requireEthereumCatalogSnapshot(f.readContext,
        { deploymentId: f.deploymentId, catalogRevision: 0, artworks: [] })
        : () => f.request(paths.stats);
    await abortBlockedRead(start, entered.promise, () => blocked.resolve(), f.controller);
    assert.equal(f.counts.stats, location === 'final-public' ? 1 : 0);
    assert.equal(f.counts.snapshots, 0);
  });
}
