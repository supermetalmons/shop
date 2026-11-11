import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { decodeReturn, encodeAbi, encodeCall, ETHEREUM_EVENT_TOPICS } from '../../../../shared/ethereum/abi.ts';
import { ETHEREUM_API_PATHS as paths } from '../../../../shared/ethereum/api.ts';
import { ETHEREUM_CHECKOUT_PATHS as checkoutPaths } from '../../../../shared/ethereum/checkout.ts';
import { ethereumHexQuantity } from '../../../../shared/ethereum/protocol.ts';
import { ETHEREUM_REVEAL_PATHS as revealPaths } from '../../../../shared/ethereum/reveal.ts';
import { ETHEREUM_REVEAL_CATALOG_VERSION, parseEthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { buildEthereumRevealRegistration, buildEthereumRevealTransition } from '../../../../scripts/ops/ethereumRevealControl.ts';
import { localEthereumRevealBindings } from '../../../../scripts/shared/ethereum111kLocalReveal.ts';

const ORIGINS = ['https://vvv.so', 'https://www.vvv.so'];
const WALLET = `0x${'33'.repeat(20)}`;
const EMPTY_WALLET = `0x${'44'.repeat(20)}`;
const FOREIGN = `0x${'55'.repeat(20)}`;
const ZERO = `0x${'00'.repeat(20)}`;
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
const blockHash = (chainId: number, block: number) => hash(chainId * 1000 + block);
const SCOPES = [
  { chainId: 1, contractAddress: `0x${'11'.repeat(20)}`, deploymentId: 'mainnet-v1', dropId: '111k',
    metadataBaseUri: 'https://cdn.mons.shop/111k/', price: '30000000000000000' },
  { chainId: 11155111, contractAddress: `0x${'22'.repeat(20)}`, deploymentId: 'public-sepolia', dropId: '111k_devnet',
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/public-sepolia/', price: '100000000000000' },
];
type Scope = typeof SCOPES[number];
type Json = Record<string, any>;
const query = (scope: Scope) => new URLSearchParams({ chainId: String(scope.chainId), contractAddress: scope.contractAddress }).toString();
const bodyScope = (scope: Scope) => ({ chainId: scope.chainId, contractAddress: scope.contractAddress });

function receipt(scope: Scope, transactionHash: string) {
  if (![hash(1), hash(2), hash(3), hash(4), hash(5)].includes(transactionHash)) return null;
  const log = (address: string, id: number, index: number) => ({ address, data: '0x',
    topics: [ETHEREUM_EVENT_TOPICS.Transfer, encodeAbi(['address'], [ZERO]), encodeAbi(['address'], [WALLET]), encodeAbi(['uint256'], [id])],
    transactionHash, blockNumber: '0x65', blockHash: blockHash(scope.chainId, 101), logIndex: ethereumHexQuantity(index), removed: false });
  return { transactionHash, blockNumber: '0x65', blockHash: transactionHash === hash(5) ? hash(999) : blockHash(scope.chainId, 101),
    status: transactionHash === hash(3) ? '0x0' : '0x1', from: WALLET,
    to: transactionHash === hash(2) ? FOREIGN : scope.contractAddress,
    logs: transactionHash === hash(4) ? [log(FOREIGN, 111113, 0)] :
      [log(scope.contractAddress, 111112, 0), ...(transactionHash === hash(2) ? [log(FOREIGN, 111113, 1)] : [])] };
}

function assertScope(value: Json, scope: Scope) {
  for (const key of ['chainId', 'contractAddress', 'deploymentId', 'dropId'] as const) assert.equal(value[key], scope[key], key);
  assert.equal(value.catalogRevision, 0);
}

test('native public Ethereum APIs isolate mainnet and Sepolia without enabling Commerce', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ethereum-public-api-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const production = JSON.parse(await readFile('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const fixturePath = join(directory, 'worker.ts');
  await writeFile(fixturePath, `
import { handleRequest } from ${JSON.stringify(resolve('cloud/workers/api/src/index.ts'))};
export { EthereumRevealObject, EthereumRevealVerifierObject, EthereumRevealPublisherObject } from ${JSON.stringify(resolve('cloud/workers/api/src/index.ts'))};
export default {
  fetch(request, env, ctx) {
    const limiter = { limit: async () => ({ success: !request.headers.has('X-Test-Rate-Limited') }) };
    return handleRequest(request, { ...env, PUBLIC_SHOP_RATE_LIMITER: limiter,
      ETHEREUM_REVEAL_READ_RATE_LIMITER: limiter, ETHEREUM_REVEAL_ADMISSION_RATE_LIMITER: limiter,
    }, promise => ctx.waitUntil(promise), { log() {} });
  },
};
`);
  const runtime = createTestHarness({ root: directory, workers: [{ config: {
    name: 'ethereum-public-api-runtime', main: fixturePath,
    compatibility_date: production.compatibility_date, compatibility_flags: production.compatibility_flags,
    ...localEthereumRevealBindings(),
    d1_databases: production.d1_databases.filter((db: Json) => ['OPS_DB', 'COMMERCE_DB'].includes(db.binding)).map((db: Json) => ({
      ...db, remote: false, migrations_dir: resolve('cloud/workers/api', db.migrations_dir),
    })),
    vars: { ETHEREUM_111K_CHAIN_ID: '11155111', ETHEREUM_111K_CONTRACT_ADDRESS: SCOPES[1].contractAddress,
      ETHEREUM_111K_METADATA_BASE_URI: SCOPES[1].metadataBaseUri, ETHEREUM_111K_DEPLOYMENT_BLOCK: '100',
      ETHEREUM_111K_RPC_URL: '', ALCHEMY_MI_NOTE_API_KEY: 'public-runtime-only',
      ETHEREUM_111K_REDEMPTION_SIGNING_ENABLED: 'false', ETHEREUM_111K_SIGNER_SECRET: 'not-a-signing-key' },
  } }] });
  t.after(() => runtime.close());
  await runtime.listen();
  const calls: Array<{ chainId: number; url: string; method: string; params?: unknown[] }> = [];
  const outboundErrors: string[] = [];
  let failProvider = false;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    try {
      if (url.hostname === 'cdn.mons.shop') {
        const scope = SCOPES.find(value => request.url.startsWith(value.metadataBaseUri));
        assert.ok(scope, `Unexpected metadata request ${request.url}`);
        calls.push({ chainId: scope.chainId, url: request.url, method: 'metadata' });
        return Response.json({ name: `${scope.deploymentId} crate`, image: 'https://cdn.lil.org/nft/111k/crate.webp',
          aspectRatio: { width: 4, height: 3 } });
      }
      assert.ok(['eth-mainnet.g.alchemy.com', 'eth-sepolia.g.alchemy.com'].includes(url.hostname), `Unexpected outbound request ${url.origin}`);
      const scope = SCOPES[url.hostname === 'eth-mainnet.g.alchemy.com' ? 0 : 1];
      if (failProvider) return new Response(null, { status: 503 });
      if (url.pathname === '/nft/v3/public-runtime-only/getNFTsForOwner') {
        assert.equal(url.searchParams.get('contractAddresses[]'), scope.contractAddress);
        calls.push({ chainId: scope.chainId, url: request.url, method: 'inventory' });
        const empty = url.searchParams.get('owner') === EMPTY_WALLET;
        const nextPage = url.searchParams.get('pageKey') === 'next-public-page';
        return Response.json({ ownedNfts: empty ? [] :
          [{ tokenId: nextPage ? '111113' : '111112', contract: { address: scope.contractAddress } }],
        pageKey: empty || nextPage ? undefined : 'next-public-page' });
      }
      assert.equal(url.pathname, '/v2/public-runtime-only');
      const payload = await request.json() as Json | Json[];
      const respond = (rpc: Json) => {
        calls.push({ chainId: scope.chainId, url: request.url, method: rpc.method, params: rpc.params });
        let result: unknown;
        if (rpc.method === 'eth_chainId') result = ethereumHexQuantity(scope.chainId);
        else if (rpc.method === 'eth_blockNumber') result = '0x66';
        else if (rpc.method === 'eth_getBlockByNumber') {
          const number = rpc.params[0] === 'latest' ? 102 : Number(BigInt(rpc.params[0]));
          result = { number: ethereumHexQuantity(number), hash: blockHash(scope.chainId, number) };
        } else if (rpc.method === 'eth_getCode') {
          assert.equal(rpc.params[0], scope.contractAddress);
          result = rpc.params[1].blockHash === blockHash(scope.chainId, 99) ? '0x' : '0x60006000';
        } else if (rpc.method === 'eth_getTransactionReceipt') result = receipt(scope, rpc.params[0]);
        else if (rpc.method === 'eth_getTransactionByHash') result = null;
        else if (rpc.method === 'eth_getLogs') result = [];
        else if (rpc.method === 'eth_call') {
          const call = rpc.params[0];
          assert.equal(call.to, scope.contractAddress);
          if (call.data === encodeCall('baseURI()', [], [])) result = encodeAbi(['string'], [scope.metadataBaseUri]);
          else if (call.data === encodeCall('MAX_RELICS()', [], [])) result = encodeAbi(['uint256'], [18]);
          else if (call.data === encodeCall('getRelicClaimedMask()', [], [])) result = encodeAbi(['uint256'], [0]);
          else if (call.data.startsWith(encodeCall('stats(address)', [], []))) {
            result = encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32',
              'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
            [111, 0, 0, BigInt(scope.price), BigInt(scope.price) * 11n, false, hash(77), BigInt(scope.price) / 2n, 1, 0, 1, 0, 500, 0, 0]);
          } else if (call.data.startsWith(encodeCall('freeMintAllowances(address)', [], []))) {
            result = encodeAbi(['uint16', 'uint16', 'uint16', 'uint16', 'uint16', 'uint16'], [0, 0, 1, 0, 0, 0]);
          } else if (call.data.startsWith(encodeCall('publicRelicStats(address)', [], []))) {
            result = encodeAbi(['uint256', 'uint256', 'uint256', 'bool', 'uint256', 'uint16', 'uint16'], [0, 0, 0, false, 0, 0, 0]);
          } else if (call.data.startsWith(encodeCall('getTokenInfos(uint256[])', [], []))) {
            const [ids] = decodeReturn(['uint256[]'], `0x${call.data.slice(10)}`) as [bigint[]];
            result = encodeAbi(['(uint8,uint256,address)[]'], [ids.map(id => id === 111112n || id === 111113n ?
              [2, id - 111111n, WALLET] : [0, 0, ZERO])]);
          } else assert.fail(`Unexpected contract method ${call.data.slice(0, 10)}`);
        } else assert.fail(`Unexpected RPC method ${rpc.method}`);
        return { jsonrpc: '2.0', id: rpc.id, result };
      };
      return Response.json(Array.isArray(payload) ? payload.map(respond).reverse() : respond(payload));
    } catch (error) {
      outboundErrors.push(String(error));
      throw error;
    }
  });
  const worker = runtime.getWorker<Env>('ethereum-public-api-runtime');
  await worker.applyD1Migrations('OPS_DB');
  await worker.applyD1Migrations('COMMERCE_DB');
  const env = await worker.getEnv();
  const templateJson = JSON.stringify(JSON.parse(await readFile('scripts/ethereum-metadata/templates/artwork.json', 'utf8')));
  async function register(scope: Scope) {
    const row = await env.OPS_DB.prepare(buildEthereumRevealRegistration({ ...scope, deploymentBlock: 100,
      catalogVersion: ETHEREUM_REVEAL_CATALOG_VERSION, templateJson,
      templateSha256: createHash('sha256').update(templateJson).digest('hex') })).first<Json>();
    assert.ok(row);
    return parseEthereumRevealDeployment(row);
  }
  for (const scope of SCOPES) {
    let deployment = await register(scope);
    const object = env.ETHEREUM_REVEAL.getByName(`${scope.chainId}:${scope.contractAddress}`);
    for (let attempt = 0; deployment.state === 'provisioning' && attempt < 32; attempt++) {
      await object.initialize(deployment);
      deployment = parseEthereumRevealDeployment((await env.OPS_DB.prepare('SELECT * FROM ethereum_reveal_deployments WHERE deployment_id = ?')
        .bind(scope.deploymentId).first<Json>())!);
    }
    assert.equal(deployment.state, 'ready');
    assert.ok(await env.OPS_DB.prepare(buildEthereumRevealTransition('activate', deployment, deployment.revision)).first());
  }
  const pendingScope = { ...SCOPES[0], deploymentId: 'public-provisioning', contractAddress: `0x${'66'.repeat(20)}`,
    metadataBaseUri: 'https://cdn.mons.shop/111k/public-provisioning/' };
  await register(pendingScope);
  const retiredScope = { ...SCOPES[1], deploymentId: 'public-retired', contractAddress: `0x${'77'.repeat(20)}`,
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/public-retired/' };
  await register(retiredScope);
  await env.OPS_DB.prepare("UPDATE ethereum_reveal_deployments SET state = 'paused' WHERE deployment_id = ?")
    .bind(retiredScope.deploymentId).run();
  await env.OPS_DB.prepare('UPDATE ethereum_reveal_deployments SET retired_at_ms = ?, replacement_deployment_id = ?, revision = revision + 1 WHERE deployment_id = ?')
    .bind(Date.now(), SCOPES[1].deploymentId, retiredScope.deploymentId).run();
  const protectedTables = ['ethereum_111k_control', 'ethereum_delivery_quotes', 'ethereum_crate_claims', 'ethereum_reconciliation_cursor',
    'ethereum_delivery_checkouts', 'ethereum_delivery_checkout_attempts', 'ethereum_111k_retirements'];
  const commerceSnapshot = () => Promise.all(protectedTables.map(async table => ({ table,
    rows: (await env.COMMERCE_DB.prepare(`SELECT * FROM ${table}`).all()).results })));
  const before = await commerceSnapshot();
  const request = async (path: string, options: { origin?: string; body?: Json; headers?: Record<string, string>; method?: string } = {}) => {
    const response = await worker.fetch(`https://api.mons.shop${path}`, {
      method: options.method ?? (options.body ? 'POST' : 'GET'),
      headers: { Origin: options.origin ?? ORIGINS[0], 'CF-Connecting-IP': '192.0.2.240',
        ...(options.body ? { 'Content-Type': 'application/json', 'X-Mons-CSRF': '1' } : {}), ...options.headers },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { response, value: response.status === 204 ? {} : await response.json() as Json };
  };
  const publicGets = [paths.config, paths.stats, paths.inventory, paths.metadata, paths.relics];
  const publicPosts = [paths.transactionsConfirm, revealPaths.transaction, revealPaths.tokens];

  await t.test('both VVV origins read each explicit network while the sale and Commerce stay closed', async () => {
    for (const origin of ORIGINS) for (const scope of SCOPES) {
      for (const path of publicGets) {
        const extra = path === paths.inventory || path === paths.stats || path === paths.relics ? `&owner=${WALLET}` :
          path === paths.metadata ? '&kind=crate&displayId=1' : '';
        const { response, value } = await request(`${path}?${query(scope)}${extra}`, { origin });
        assert.equal(response.status, 200, `${path}: ${JSON.stringify(value)}`);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        if (path !== paths.relics) assertScope(value, scope);
        else {
          assert.equal(value.chainId, scope.chainId);
          assert.equal(value.contractAddress, scope.contractAddress);
        }
        assert.equal(JSON.stringify(value).includes('signature'), false);
        if (path === paths.config) {
          assert.equal(value.enabled, true);
          assert.equal(value.revealEnabled, true);
          assert.equal(value.saleActive, false);
          assert.equal(value.testnet, scope.chainId !== 1);
          assert.equal(value.metadataBaseUri, scope.metadataBaseUri);
          assert.equal(value.explorerUrl, scope.chainId === 1 ? 'https://etherscan.io' : 'https://sepolia.etherscan.io');
          assert.equal(value.cratePriceWei, scope.price);
          assert.equal('deliveryFeeWei' in value, false);
        } else if (path === paths.stats) {
          assert.equal(value.saleActive, false);
          assert.equal(value.cratePriceWei, scope.price);
          assert.equal(value.owner, WALLET);
        } else if (path === paths.inventory) {
          assert.equal(value.items.length, 1);
          assert.equal(value.items[0].id, `eip155:${scope.chainId}:${scope.contractAddress}:111112`);
          assert.equal(value.items[0].name, `${scope.deploymentId} crate`);
          assert.equal(value.nextCursor, 'next-public-page');
          const next = await request(`${paths.inventory}?${query(scope)}&owner=${WALLET}&cursor=${value.nextCursor}`, { origin });
          assert.equal(next.response.status, 200, JSON.stringify(next.value));
          assertScope(next.value, scope);
          assert.equal(next.value.items[0].id, `eip155:${scope.chainId}:${scope.contractAddress}:111113`);
          assert.equal(next.value.nextCursor, null);
        } else if (path === paths.metadata) assert.equal(value.name, `${scope.deploymentId} crate`);
      }
      const empty = await request(`${paths.inventory}?${query(scope)}&owner=${EMPTY_WALLET}`, { origin });
      assert.equal(empty.response.status, 200);
      assertScope(empty.value, scope);
      assert.deepEqual(empty.value.items, []);
      assert.equal(empty.value.nextCursor, null);
      for (const path of [revealPaths.transaction, revealPaths.tokens]) {
        const result = await request(path, { origin, body: { ...bodyScope(scope),
          ...(path === revealPaths.transaction ? { transactionHash: hash(90) } : { tokenIds: ['111111'] }) } });
        assert.equal(result.response.status, 200, JSON.stringify(result.value));
        assertScope(result.value, scope);
        assert.deepEqual(result.value.artworks, []);
      }
    }
    for (const scope of SCOPES) assert.ok(calls.some(call => call.chainId === scope.chainId && call.method === 'inventory'));
    await Promise.all(SCOPES.flatMap(scope => [paths.stats, paths.inventory].map(async path => {
      const result = await request(`${path}?${query(scope)}&owner=${WALLET}`);
      assert.equal(result.response.status, 200);
      assertScope(result.value, scope);
      if (path === paths.inventory) assert.equal(result.value.items[0].contractAddress, scope.contractAddress);
      else assert.equal(result.value.cratePriceWei, scope.price);
    })));
  });

  await t.test('canonical, wrapped, foreign, pending, reverted and orphaned receipts retain their precise semantics', async () => {
    for (const scope of SCOPES) for (const origin of ORIGINS) {
      for (const id of [1, 2, 4, 5, 99]) {
        const result = await request(paths.transactionsConfirm, { origin, body: { ...bodyScope(scope), transactionHash: hash(id) } });
        assert.equal(result.response.status, 200, JSON.stringify(result.value));
        assertScope(result.value, scope);
        const pending = id === 5 || id === 99;
        assert.equal(result.value.status, pending ? 'pending' : 'confirmed');
        assert.equal(result.value.confirmations, pending ? 0 : 2);
        assert.deepEqual(result.value.burnedTokenIds, []);
        assert.equal(result.value.items.length, id === 1 || id === 2 ? 1 : 0);
        if (id === 1 || id === 2) {
          assert.equal(result.value.items[0].contractAddress, scope.contractAddress);
          assert.equal(result.value.logs.length, 1);
          assert.equal(result.value.logs[0].address, scope.contractAddress);
        }
        if (id === 4) assert.deepEqual(result.value.logs, []);
      }
      const reverted = await request(paths.transactionsConfirm, { origin, body: { ...bodyScope(scope), transactionHash: hash(3) } });
      assert.equal(reverted.response.status, 409);
      assert.equal(reverted.value.error.details.kind, 'transaction-reverted');
      assert.equal(reverted.response.headers.get('Access-Control-Allow-Origin'), origin);
    }
  });

  await t.test('legacy Mons requests keep their configured Sepolia response and paused Commerce flag', async () => {
    const preflight = await request(paths.config, { origin: 'https://mons.shop', method: 'OPTIONS' });
    assert.equal(preflight.response.status, 204);
    assert.match(preflight.response.headers.get('Access-Control-Allow-Headers') ?? '', /X-Mons-Ethereum-Session/i);
    assert.match(preflight.response.headers.get('Access-Control-Allow-Headers') ?? '', /X-Mons-CSRF/i);
    const config = await request(paths.config, { origin: 'https://mons.shop' });
    assert.equal(config.response.status, 200, JSON.stringify(config.value));
    assert.equal(config.value.chainId, 11155111);
    assert.equal(config.value.contractAddress, SCOPES[1].contractAddress);
    assert.equal(config.value.enabled, false);
    assert.equal(config.value.testnet, true);
    assert.equal(typeof config.value.deliveryFeeWei, 'string');
    const stats = await request(`${paths.stats}?owner=${WALLET}`, { origin: 'https://mons.shop' });
    assert.equal(stats.response.status, 200);
    assert.equal(stats.value.cratePriceWei, SCOPES[1].price);
    const confirmed = await request(paths.transactionsConfirm, { origin: 'https://mons.shop', body: { transactionHash: hash(1) } });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.value.items[0].chainId, 11155111);
  });

  await t.test('scope validation rejects missing, ambiguous, unregistered and inactive collections', async () => {
    const invalidQueries = ['', 'chainId=1', `contractAddress=${SCOPES[0].contractAddress}`,
      `${query(SCOPES[0])}&chainId=1`, `${query(SCOPES[0])}&contractAddress=${SCOPES[0].contractAddress}`,
      `chainId=1e0&contractAddress=${SCOPES[0].contractAddress}`, `chainId=31337&contractAddress=${SCOPES[0].contractAddress}`,
      `chainId=10&contractAddress=${SCOPES[0].contractAddress}`, `chainId=1&contractAddress=${ZERO}`];
    for (const suffix of invalidQueries) {
      const result = await request(`${paths.stats}?${suffix}`);
      assert.equal(result.response.status, 400, `${suffix}: ${JSON.stringify(result.value)}`);
    }
    for (const body of [{ transactionHash: hash(1) }, { chainId: 1, transactionHash: hash(1) },
      { contractAddress: SCOPES[0].contractAddress, transactionHash: hash(1) },
      { ...bodyScope(SCOPES[0]), chainId: '1', transactionHash: hash(1) },
      { ...bodyScope(SCOPES[0]), deploymentId: SCOPES[0].deploymentId, transactionHash: hash(1) }]) {
      const result = await request(paths.transactionsConfirm, { body });
      assert.equal(result.response.status, 400, JSON.stringify(result.value));
    }
    const queryOnConfirmation = await request(`${paths.transactionsConfirm}?${query(SCOPES[0])}`, {
      body: { ...bodyScope(SCOPES[0]), transactionHash: hash(1) },
    });
    assert.equal(queryOnConfirmation.response.status, 400);
    assert.equal(queryOnConfirmation.value.error.code, 'invalid-argument');
    const unknown = await request(`${paths.stats}?chainId=1&contractAddress=${FOREIGN}`);
    assert.equal(unknown.response.status, 404);
    const retired = await request(`${paths.stats}?${query(retiredScope)}`);
    assert.equal(retired.response.status, 409);
    const provisioning = await request(`${paths.stats}?${query(pendingScope)}`);
    assert.equal(provisioning.response.status, 503);
  });

  await t.test('public preflights, errors and rate limits expose only the intended partner surface', async () => {
    for (const origin of ORIGINS) {
      for (const path of [...publicGets, ...publicPosts]) {
        const post = publicPosts.includes(path as typeof publicPosts[number]);
        const preflight = await request(path, { origin, method: 'OPTIONS' });
        assert.equal(preflight.response.status, 204, path);
        assert.equal(preflight.response.headers.get('Access-Control-Allow-Origin'), origin);
        assert.equal(preflight.response.headers.get('Access-Control-Allow-Methods'), post ? 'POST, OPTIONS' : 'GET, OPTIONS');
        assert.doesNotMatch(preflight.response.headers.get('Access-Control-Allow-Headers') ?? '', /Session|Authorization/i);
        if (post) assert.match(preflight.response.headers.get('Access-Control-Allow-Headers') ?? '', /X-Mons-CSRF/i);
        const limited = await request(`${path}${post ? '' : `?${query(SCOPES[0])}`}`, { origin,
          ...(post ? { body: { ...bodyScope(SCOPES[0]), ...(path === revealPaths.tokens ? { tokenIds: ['1'] } : { transactionHash: hash(99) }) } } : {}),
          headers: { 'X-Test-Rate-Limited': '1' } });
        assert.equal(limited.response.status, 429, `${path}: ${JSON.stringify(limited.value)}`);
        assert.equal(limited.response.headers.get('Access-Control-Allow-Origin'), origin);
        assert.equal(limited.response.headers.get('Retry-After'), '60');
        assert.match(limited.response.headers.get('Access-Control-Expose-Headers') ?? '', /Retry-After/i);
      }
      for (const path of [paths.authChallenge, paths.profile, paths.deliveryPrepare, paths.claimPrepare,
        checkoutPaths.create, checkoutPaths.prepare, checkoutPaths.submission, checkoutPaths.refresh]) {
        const denied = await request(path, { origin, method: 'OPTIONS' });
        assert.equal(denied.response.status, 403, path);
        assert.notEqual(denied.response.headers.get('Access-Control-Allow-Origin'), origin);
      }
      const missingCsrf = await request(paths.transactionsConfirm, { origin, body: { ...bodyScope(SCOPES[0]), transactionHash: hash(1) },
        headers: { 'X-Mons-CSRF': '' } });
      assert.equal(missingCsrf.response.status, 403);
      failProvider = true;
      try {
        const failure = await request(`${paths.stats}?${query(SCOPES[0])}`, { origin });
        assert.equal(failure.response.status, 503);
        assert.equal(failure.response.headers.get('Access-Control-Allow-Origin'), origin);
      } finally { failProvider = false; }
    }
    for (const origin of ['https://other.vvv.so', 'http://vvv.so', 'https://vvv.so.evil.example']) {
      const denied = await request(`${paths.config}?${query(SCOPES[0])}`, { origin });
      assert.equal(denied.response.status, 403);
      assert.notEqual(denied.response.headers.get('Access-Control-Allow-Origin'), origin);
    }
  });
  assert.deepEqual(await commerceSnapshot(), before);
  assert.equal((await env.OPS_DB.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_sessions').first<{ n: number }>())?.n, 0);
  assert.equal((await env.OPS_DB.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_challenges').first<{ n: number }>())?.n, 0);
  assert.deepEqual(outboundErrors, []);
});
