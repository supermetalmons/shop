import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { decodeReturn, encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ethereumSignerAddress, personalMessageHash, signDigest } from '../../../../shared/ethereum/crypto.ts';
import { ETHEREUM_OWNER_HATCHING_MESSAGE, ETHEREUM_OWNER_HATCHING_PATHS as paths } from '../../../../shared/ethereum/ownerHatching.ts';
import { ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.ts';
import descriptor from '../../../../shared/ethereum/revealCatalog.json';
import { parseEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { EthereumApiError } from '../src/ethereumError.ts';
import { handleEthereumRequest } from '../src/ethereumHandler.ts';
import { authorizeOwnerHatch, ownerHatchingRpcError } from '../src/ethereumOwnerHatching.ts';
import { RpcProviderError } from '../src/ethereumProvider.ts';
import { applyEthereumPublicConfirmCors, applyEthereumPublicReadCors } from '../src/ethereumPublicCors.ts';
import { ethereumInventoryItems } from '../src/ethereumRead.ts';
import { ethereumRoutes } from '../src/ethereumRoutes.ts';
import type { EthereumCollectionReadContext, EthereumEnvironment } from '../src/ethereumRuntime.ts';
import { d1Database } from './commerceD1Harness.ts';

const CONTRACT = `0x${'11'.repeat(20)}`;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const KEY = `0x${'22'.repeat(32)}`;
const OTHER_KEY = `0x${'33'.repeat(32)}`;
const WALLET = ethereumSignerAddress(KEY);
const SIGNATURE = signDigest(KEY, personalMessageHash(ETHEREUM_OWNER_HATCHING_MESSAGE));
const SCOPE = { chainId: 11155111, contractAddress: CONTRACT };
const BODY = { ...SCOPE, tokenId: '1', signature: SIGNATURE };

function fixture(chainId = 11155111) {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0009_ethereum_reveal_deployments', '0011_ethereum_reveal_retirement', '0012_ethereum_reveal_catalog_updates']) {
    database.exec(readFileSync(`cloud/workers/api/ops-migrations/${migration}.sql`, 'utf8'));
  }
  database.prepare(`INSERT INTO ethereum_reveal_deployments
    (deployment_id,drop_id,chain_id,contract_address,metadata_base_uri,deployment_block,catalog_version,template_json,
      template_sha256,state,revision,created_at_ms,updated_at_ms,provisioned_at_ms,activated_at_ms)
    VALUES('hatch-test','111k_devnet',?,?,'https://cdn.mons.shop/111k-sepolia/hatch-test/',100,?,?,?,'active',3,1,1,1,1)`)
    .run(chainId, CONTRACT, descriptor.catalogVersion,
      JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] }),
      '0'.repeat(64));
  const readDeployment = () => parseEthereumRevealDeployment(database.prepare('SELECT * FROM ethereum_reveal_deployments').get() as Record<string, unknown>);
  const result = { deploymentId: 'hatch-test', dropId: '111k_devnet', chainId, contractAddress: CONTRACT, catalogRevision: 0 };
  const calls: Array<{ method: string; deployment: EthereumRevealDeployment; input?: unknown }> = [];
  const limits: string[] = [];
  let allowed = true;
  let failure: unknown;
  const limiter: RateLimit = { limit: async ({ key }) => { limits.push(key); return { success: allowed }; } };
  const namespace = new Proxy({} as Env['ETHEREUM_REVEAL'], {
    get(_target, property) {
      assert.equal(property, 'getByName');
      return (name: string) => {
        assert.equal(name, `${chainId}:${CONTRACT}`);
        return {
          ownerHatchingReady: async (deployment: EthereumRevealDeployment) => {
            calls.push({ method: 'ready', deployment });
            if (failure) throw failure;
            return { ...result, tokenIds: ['1', '2'] };
          },
          ownerHatch: async (deployment: EthereumRevealDeployment, input: unknown) => {
            calls.push({ method: 'hatch', deployment, input });
            if (failure) throw failure;
            return { ...result, artworks: [], unresolved: [], retryAfterMs: 0 };
          },
        };
      };
    },
  });
  const env: EthereumEnvironment = {
    OPS_DB: d1Database(database), COMMERCE_DB: d1Database(database), ALCHEMY_MI_NOTE_API_KEY: 'fixture',
    ETHEREUM_111K_CHAIN_ID: chainId === 31337 ? '31337' : 'invalid-storefront',
    ETHEREUM_111K_CONTRACT_ADDRESS: 'invalid-storefront', ETHEREUM_111K_DEPLOYMENT_BLOCK: 'invalid-storefront',
    ETHEREUM_111K_METADATA_BASE_URI: 'invalid-storefront', ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545',
    STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter, STAFF_AUTH_SESSION_RATE_LIMITER: limiter, PUBLIC_SHOP_RATE_LIMITER: limiter,
    ETHEREUM_REVEAL_READ_RATE_LIMITER: limiter, ETHEREUM_REVEAL_ADMISSION_RATE_LIMITER: limiter, ETHEREUM_REVEAL: namespace,
  };
  const request = (path: string, body?: unknown, options: { origin?: string; csrf?: string; method?: string } = {}) => {
    const method = options.method ?? (path.startsWith(paths.ready) ? 'GET' : 'POST');
    return handleEthereumRequest(new Request(`https://api.mons.shop${path}`, { method,
      headers: { Origin: options.origin ?? 'https://vvv.so', 'X-Mons-CSRF': options.csrf ?? '1',
        'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) }), env, path.split('?')[0],
    { fetch: async () => assert.fail('HTTP hatching handlers must leave ownership verification to the coordinator') });
  };
  return { database, env, readDeployment, calls, limits, result, request,
    deny: () => { allowed = false; }, fail: (value: unknown) => { failure = value; } };
}

test('owner hatching selects explicit collection without storefront configuration and returns uncached payloads', async t => {
  const f = fixture();
  t.after(() => f.database.close());
  const ready = await f.request(`${paths.ready}?chainId=11155111&contractAddress=${CONTRACT}`);
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await ready.json(), { ...f.result, tokenIds: ['1', '2'] });
  const hatch = await f.request(paths.hatch, BODY);
  assert.equal(hatch.status, 200);
  assert.equal(hatch.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await hatch.json(), { ...f.result, artworks: [], unresolved: [], retryAfterMs: 0 });
  assert.deepEqual(f.calls.map(call => call.method), ['ready', 'hatch']);
  assert.deepEqual(f.calls[1].input, { tokenId: '1', signature: SIGNATURE });
  assert.equal(new Set(f.limits).size, 2);
});

test('owner hatching rejects malformed scope, non-artwork IDs, extra fields, wrong methods and origins before coordination', async t => {
  const f = fixture();
  t.after(() => f.database.close());
  for (const query of ['', '?chainId=11155111', `?chainId=11155111&contractAddress=${CONTRACT}&chainId=1`,
    `?chainId=11155111&contractAddress=${CONTRACT}&tokenId=1`, `?chainId=31337&contractAddress=${CONTRACT}`]) {
    assert.equal((await f.request(paths.ready + query)).status, 400);
  }
  for (const body of [{ ...BODY, tokenId: '0' }, { ...BODY, tokenId: '111112' }, { ...BODY, signature: 'bad' },
    { ...BODY, chainId: 10 }, { ...BODY, address: WALLET }, { ...BODY, contractAddress: `0x${'0'.repeat(40)}` }]) {
    assert.equal((await f.request(paths.hatch, body)).status, 400);
  }
  assert.equal((await f.request(paths.hatch + '?tokenId=1', BODY)).status, 400);
  assert.equal((await f.request(paths.hatch, BODY, { method: 'GET' })).status, 405);
  assert.equal((await f.request(paths.hatch, BODY, { origin: 'https://vvv.so.evil.example' })).status, 403);
  assert.equal((await f.request(paths.hatch, BODY, { csrf: '0' })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('owner hatching translates safe RPC errors and rate limits without leaking unexpected errors', async t => {
  const f = fixture();
  t.after(() => f.database.close());
  for (const [code, status] of [['permission-denied', 403], ['failed-precondition', 409], ['resource-exhausted', 429]] as const) {
    f.fail(ownerHatchingRpcError(new EthereumApiError(code, 'Hatching request rejected.')));
    const response = await f.request(paths.hatch, BODY);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { ok: false, error: { code, message: 'Hatching request rejected.' } });
  }
  f.fail(ownerHatchingRpcError(new Error('private backend details')));
  const failure = await f.request(paths.hatch, BODY);
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /private backend/);
  const count = f.calls.length;
  f.deny();
  const limited = await f.request(paths.hatch, BODY);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
  assert.equal(f.calls.length, count);
});

test('owner hatching partner CORS exposes the correct methods and retry header', () => {
  for (const [path, method, apply] of [[paths.ready, 'GET', applyEthereumPublicReadCors],
    [paths.hatch, 'POST', applyEthereumPublicConfirmCors]] as const) {
    const route = ethereumRoutes.find(route => route.path === path)!;
    assert.equal(route.cors, method === 'GET' ? 'ethereum-public-read' : 'ethereum-public-confirm');
    assert.equal(route.commerceMutation, false);
    for (const origin of ['https://vvv.so', 'https://www.vvv.so']) {
      const response = apply(new Request(`https://api.mons.shop${path}`, { headers: { Origin: origin } }), new Response(null, { status: 204 }));
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(response.headers.get('Access-Control-Allow-Methods'), `${method}, OPTIONS`);
      assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
  }
});

test('public metadata preserves only the explicit ready-to-hatch flag', async t => {
  const f = fixture();
  t.after(() => f.database.close());
  for (const readyToHatch of [true, false, 'true', undefined]) {
    const context: EthereumCollectionReadContext = {
      env: { ...f.env, ETHEREUM_REVEAL: undefined }, nowMs: Date.now(), signal: AbortSignal.timeout(1000),
      config: { ...SCOPE, enabled: true, metadataBaseUri: f.readDeployment().metadataBaseUri, deploymentBlock: 100 },
      fetch: async () => Response.json({ name: 'Egg #1', image: 'https://cdn.lil.org/nft/111k/eggs/1.png', readyToHatch }),
    };
    const [item] = await ethereumInventoryItems(context, [{ tokenId: '1', kind: 'artwork', displayId: 1, owner: WALLET }]);
    assert.equal(item.readyToHatch, readyToHatch === true ? true : undefined);
  }
});

function ownershipFixture() {
  const f = fixture(31337);
  const state = { owner: WALLET, exists: true, contractOwner: false, validContractSignature: true, canonical: true, signatureUnavailable: false,
    calls: [] as Array<{ method: string; params: unknown[] }> };
  const providerFetch: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] } | Array<{ id: number; method: string; params: unknown[] }>;
    const respond = ({ id, method, params }: { id: number; method: string; params: unknown[] }) => {
      state.calls.push({ method, params });
      let result: unknown;
      if (method === 'eth_chainId') result = '0x7a69';
      else if (method === 'eth_getBlockByNumber') {
        result = { number: '0x64', hash: state.canonical || params[0] === 'latest' ? BLOCK_HASH : `0x${'cd'.repeat(32)}` };
      } else if (method === 'eth_getCode') {
        assert.deepEqual(params, [state.owner, { blockHash: BLOCK_HASH, requireCanonical: true }]);
        result = state.contractOwner ? '0x6000' : '0x';
      } else {
        assert.equal(method, 'eth_call');
        const call = params[0] as { to: string; data: string };
        assert.deepEqual(params[1], { blockHash: BLOCK_HASH, requireCanonical: true });
        if (call.to === CONTRACT) {
          assert.equal(call.data.slice(0, 10), encodeCall(ETHEREUM_FUNCTIONS.tokenInfos, [], []));
          const [ids] = decodeReturn(['uint256[]'], `0x${call.data.slice(10)}`);
          result = encodeAbi(['(uint8,uint256,address)[]'], [(ids as bigint[]).map(id => state.exists
            ? [1, id, state.owner] : [0, 0, `0x${'0'.repeat(40)}`])]);
        } else {
          if (state.signatureUnavailable) throw new Error('Signature provider unavailable.');
          assert.equal(call.to, state.owner);
          const [digest, signature] = decodeReturn(['bytes32', 'bytes'], `0x${call.data.slice(10)}`);
          assert.equal(digest, personalMessageHash(ETHEREUM_OWNER_HATCHING_MESSAGE));
          assert.equal(signature, SIGNATURE);
          result = encodeAbi(['bytes4'], [state.validContractSignature ? '0x1626ba7e' : '0xffffffff']);
        }
      }
      return { jsonrpc: '2.0', id, result };
    };
    return Response.json(Array.isArray(payload) ? payload.map(respond) : respond(payload));
  };
  return { ...f, state, authorize: (tokenId = '1', signature = SIGNATURE) =>
    authorizeOwnerHatch(f.env, f.readDeployment(), tokenId, signature, { fetch: providerFetch }) };
}

test('one personal signature authorizes multiple currently owned eggs with fresh pinned reads each time', async t => {
  const f = ownershipFixture();
  t.after(() => f.database.close());
  await f.authorize('1');
  await f.authorize('2');
  assert.equal(f.state.calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] === 'latest').length, 2);
  assert.equal(f.state.calls.filter(call => call.method === 'eth_call').length, 2);
  assert.equal(f.state.calls.filter(call => call.method === 'eth_getCode').length, 0);
});

test('authorization follows transfers and rejects missing tokens, wrong messages and noncanonical ownership', async t => {
  const f = ownershipFixture();
  t.after(() => f.database.close());
  f.state.owner = ethereumSignerAddress(OTHER_KEY);
  await assert.rejects(f.authorize(), (error: unknown) => error instanceof EthereumApiError && error.code === 'permission-denied');
  await f.authorize('1', signDigest(OTHER_KEY, personalMessageHash(ETHEREUM_OWNER_HATCHING_MESSAGE)));
  await assert.rejects(f.authorize('1', signDigest(OTHER_KEY, personalMessageHash('Some other message'))), /current token owner/);
  f.state.exists = false;
  await assert.rejects(f.authorize(), /does not currently exist/);
  f.state.exists = true;
  f.state.owner = WALLET;
  f.state.canonical = false;
  await assert.rejects(f.authorize(), /Ethereum changed/);
});

test('contract owner authorization uses ERC-1271 at the same ownership block', async t => {
  const f = ownershipFixture();
  t.after(() => f.database.close());
  f.state.owner = `0x${'44'.repeat(20)}`;
  f.state.contractOwner = true;
  await f.authorize();
  assert.equal(f.state.calls.filter(call => call.method === 'eth_getCode').length, 1);
  f.state.validContractSignature = false;
  await assert.rejects(f.authorize(), /current token owner/);
  f.state.signatureUnavailable = true;
  await assert.rejects(f.authorize(), (error: unknown) => error instanceof RpcProviderError && error.kind === 'transport');
});
