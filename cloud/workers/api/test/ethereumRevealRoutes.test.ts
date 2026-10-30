import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ETHEREUM_REVEAL_PATHS, type EthereumRevealResult } from '../../../../shared/ethereum/reveal.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { applyEthereumRevealCors } from '../src/ethereumReveal.ts';
import { handleEthereumRequest } from '../src/ethereumHandler.ts';
import { ethereumRouteDefinition } from '../src/ethereumRouteDefinitions.ts';
import { ethereumRoutes } from '../src/ethereumRoutes.ts';
import type { EthereumEnvironment } from '../src/ethereumRuntime.ts';
import { d1Database } from './commerceD1Harness.ts';

const CONTRACT = `0x${'11'.repeat(20)}`;
const HASH = `0x${'aa'.repeat(32)}`;
const TRANSACTION = { chainId: 11155111, contractAddress: CONTRACT, transactionHash: HASH };
type RevealCall = { method: 'transaction' | 'tokens'; deployment: EthereumRevealDeployment; input: string | string[]; admit: boolean; deadlineMs?: number };

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync('cloud/workers/api/ops-migrations/0009_ethereum_reveal_deployments.sql', 'utf8'));
  let allowed = true;
  let admissionAllowed = true;
  const limits: string[] = [];
  const admissions: string[] = [];
  const calls: RevealCall[] = [];
  let backend: (call: RevealCall) => EthereumRevealResult<unknown> | Promise<EthereumRevealResult<unknown>> =
    () => assert.fail('Unexpected reveal object call');
  const invoke = async (call: RevealCall) => { calls.push(call); return backend(call); };
  const limiter: RateLimit = { limit: async ({ key }) => { limits.push(key); return { success: allowed }; } };
  const env: EthereumEnvironment = {
    OPS_DB: d1Database(database), COMMERCE_DB: d1Database(database), ALCHEMY_MI_NOTE_API_KEY: 'test',
    ETHEREUM_111K_CHAIN_ID: '11155111', ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT,
    ETHEREUM_111K_DEPLOYMENT_BLOCK: '100', ETHEREUM_111K_METADATA_BASE_URI: 'https://cdn.mons.shop/111k-sepolia/',
    ETHEREUM_111K_RPC_URL: '', STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter,
    STAFF_AUTH_SESSION_RATE_LIMITER: limiter, PUBLIC_SHOP_RATE_LIMITER: limiter,
    ETHEREUM_REVEAL_READ_RATE_LIMITER: limiter,
    ETHEREUM_REVEAL_ADMISSION_RATE_LIMITER: { limit: async ({ key }) => { admissions.push(key); return { success: admissionAllowed }; } },
    ETHEREUM_REVEAL: { getByName(name: string) {
      assert.equal(name, `11155111:${CONTRACT}`);
      return {
        revealTransaction: (deployment: EthereumRevealDeployment, input: string, admit = false, deadlineMs?: number) => invoke({ method: 'transaction', deployment, input, admit, deadlineMs }),
        revealTokens: (deployment: EthereumRevealDeployment, input: string[], admit = false, deadlineMs?: number) => invoke({ method: 'tokens', deployment, input, admit, deadlineMs }),
      };
    } } as unknown as Env['ETHEREUM_REVEAL'],
  };
  const request = (body: unknown, options: { path?: string; origin?: string; csrf?: string; method?: string } = {}) => {
    const path = options.path ?? ETHEREUM_REVEAL_PATHS.transaction;
    const method = options.method ?? 'POST';
    return handleEthereumRequest(new Request(`https://api.mons.shop${path}`, { method,
      headers: { Origin: options.origin ?? 'https://vvv.so', 'X-Mons-CSRF': options.csrf ?? '1',
        'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) }), env, path,
    { fetch: async () => assert.fail('Reveal routes must not call the chain provider') });
  };
  const register = (state: EthereumRevealDeployment['state'] = 'active') => database.prepare(`INSERT INTO ethereum_reveal_deployments
    (deployment_id,drop_id,chain_id,contract_address,metadata_base_uri,deployment_block,catalog_version,template_json,
      template_sha256,state,revision,created_at_ms,updated_at_ms,provisioned_at_ms,activated_at_ms)
    VALUES('test-sepolia','111k_devnet',11155111,?,'https://cdn.mons.shop/111k-sepolia/',100,'111k-v1',?,?,?,3,1,1,1,1)`)
    .run(CONTRACT, JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://wip.lil.org/111k/artwork_placeholder.png', attributes: [] }), '0'.repeat(64), state);
  return { database, request, limits, admissions, calls, register,
    respond: (value: typeof backend) => { backend = value; },
    deny: () => { allowed = false; }, denyAdmission: () => { admissionAllowed = false; } };
}

test('reveal endpoints have isolated partner origins and preserve normal route policies', () => {
  for (const path of Object.values(ETHEREUM_REVEAL_PATHS)) {
    const definition = ethereumRouteDefinition(path)!;
    assert.deepEqual(definition.methods, ['POST']);
    assert.equal(definition.originPolicy, 'reveal');
    const route = ethereumRoutes.find(route => route.path === path)!;
    assert.equal(route.cors, 'ethereum-reveal');
    assert.equal(route.profileOriginGate, false);
  }
  assert.equal(ethereumRouteDefinition('/ethereum/111k/inventory')!.originPolicy, 'profile');
});

test('reveal CORS allows only Mons and VVV and does not expose caching or credentials', () => {
  for (const origin of ['https://mons.shop', 'https://vvv.so', 'https://www.vvv.so']) {
    const result = applyEthereumRevealCors(new Request('https://api.mons.shop', { headers: { Origin: origin } }), new Response(null, { status: 204 }));
    assert.equal(result.status, 204);
    assert.equal(result.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(result.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
    assert.equal(result.headers.get('Access-Control-Allow-Headers'), 'Accept, Content-Type, X-Mons-CSRF');
    assert.equal(result.headers.get('Access-Control-Allow-Credentials'), null);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal(result.headers.get('Vary'), 'Origin');
  }
  const denied = applyEthereumRevealCors(new Request('https://api.mons.shop', { headers: { Origin: 'https://vvv.so.evil.example' } }), new Response(null));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
});

test('reveal HTTP validates chain-scoped bodies before admission and rejects unsupported methods or origins', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request(TRANSACTION)).status, 404);
    assert.equal((await f.request(TRANSACTION, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.request(TRANSACTION, { csrf: '0' })).status, 403);
    assert.equal((await f.request(TRANSACTION, { method: 'GET' })).status, 405);
    for (const body of [{ ...TRANSACTION, chainId: 10 }, { ...TRANSACTION, transactionHash: '0x123' },
      { ...TRANSACTION, contractAddress: `0x${'0'.repeat(40)}` }, { ...TRANSACTION, privateAssignment: 'no' }]) {
      assert.equal((await f.request(body)).status, 400);
    }
    for (const tokenIds of [[], ['0'], ['111112'], ['1.2'], Array.from({ length: 501 }, (_, index) => String(index + 1))]) {
      assert.equal((await f.request({ chainId: 11155111, contractAddress: CONTRACT, tokenIds }, { path: ETHEREUM_REVEAL_PATHS.tokens })).status, 400);
    }
  } finally { f.database.close(); }
});

test('reveal polling rate limits apply before registry or provider work', async () => {
  const f = fixture();
  try {
    f.deny();
    const response = await f.request(TRANSACTION);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.equal(f.limits.length, 1);
  } finally { f.database.close(); }
});

for (const method of ['transaction', 'tokens'] as const) {
  const path = ETHEREUM_REVEAL_PATHS[method];
  const body = method === 'transaction' ? { ...TRANSACTION, transactionHash: `0x${'AA'.repeat(32)}` }
    : { chainId: 11155111, contractAddress: CONTRACT, tokenIds: ['1', '2', '1'] };
  const responseScope = { deploymentId: 'test-sepolia', dropId: '111k_devnet', chainId: 11155111, contractAddress: CONTRACT };
  const artwork = { tokenId: '1', crateTokenId: '111112', category: 'painting', name: '1',
    image: 'https://wip.lil.org/111k/paintings/1.webp', aspectRatio: { width: 240, height: 259 },
    observation: { transactionHash: HASH, blockNumber: 101, blockHash: `0x${'bb'.repeat(32)}` } };
  const complete = method === 'transaction'
    ? { ...responseScope, status: 'revealed', artworks: [artwork], retryAfterMs: 0 }
    : { ...responseScope, artworks: [artwork], unresolved: [], retryAfterMs: 0 };
  const pending = method === 'transaction'
    ? { ...responseScope, status: 'pending', artworks: [], retryAfterMs: 2000 }
    : { ...responseScope, artworks: [], unresolved: [{ tokenId: '1', status: 'recovering' }], retryAfterMs: 2000 };

  test(`${method} cached results use one object snapshot without admission or provider work`, async t => {
    const f = fixture();
    t.after(() => f.database.close());
    f.register();
    f.denyAdmission();
    f.respond(() => ({ kind: 'ready', value: complete }));
    const response = await f.request(body, { path });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), complete);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, method);
    assert.equal(f.calls[0].admit, false);
    assert.equal(f.calls[0].deployment.deploymentId, 'test-sepolia');
    assert.deepEqual(f.calls[0].input, method === 'transaction' ? HASH : ['1', '2']);
    assert.equal(f.limits.length, 1);
    assert.equal(f.admissions.length, 0);
  });

  test(`${method} existing recovery returns its public pending response with one object call`, async t => {
    const f = fixture();
    t.after(() => f.database.close());
    f.register();
    f.denyAdmission();
    f.respond(() => ({ kind: 'ready', value: pending }));
    const response = await f.request(body, { path });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), pending);
    assert.deepEqual(f.calls.map(call => call.admit), [false]);
    assert.equal(f.admissions.length, 0);
  });

  test(`${method} new recovery requires admission before the second object call`, async t => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const f = fixture();
    t.after(() => f.database.close());
    f.register();
    f.respond(call => {
      assert.equal(f.admissions.length, call.admit ? 1 : 0);
      assert.equal(call.deadlineMs, 1_002_000);
      if (!call.admit) now += 1500;
      return call.admit ? { kind: 'ready', value: pending } : { kind: 'admission' };
    });
    const response = await f.request(body, { path });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), pending);
    assert.deepEqual(f.calls.map(call => call.admit), [false, true]);
    assert.equal(f.admissions.length, 1);
  });

  test(`${method} admission rate limits prevent new durable work`, async t => {
    const f = fixture();
    t.after(() => f.database.close());
    f.register();
    f.denyAdmission();
    f.respond(() => ({ kind: 'admission' }));
    const response = await f.request(body, { path });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.deepEqual(f.calls.map(call => call.admit), [false]);
    assert.equal(f.admissions.length, 1);
  });

  test(`${method} durable capacity exhaustion remains a retryable 429 across the RPC boundary`, async t => {
    const f = fixture();
    t.after(() => f.database.close());
    f.register();
    f.respond(call => call.admit ? { kind: 'capacity' } : { kind: 'admission' });
    const response = applyEthereumRevealCors(new Request(`https://api.mons.shop${path}`, { headers: { Origin: 'https://vvv.so' } }),
      await f.request(body, { path }));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const value = await response.json() as { error: { code: string }; kind?: unknown };
    assert.equal(value.error.code, 'resource-exhausted');
    assert.equal(value.kind, undefined);
    assert.deepEqual(f.calls.map(call => call.admit), [false, true]);
  });

  test(`${method} paused collections serve existing snapshots but refuse new recovery before admission`, async t => {
    const f = fixture();
    t.after(() => f.database.close());
    f.register('paused');
    f.respond(() => ({ kind: 'ready', value: complete }));
    assert.deepEqual(await (await f.request(body, { path })).json(), complete);
    f.respond(() => ({ kind: 'admission' }));
    const response = await f.request(body, { path });
    assert.equal(response.status, 409);
    assert.equal(f.admissions.length, 0);
    assert.deepEqual(f.calls.map(call => call.admit), [false, false]);
  });

  test(`${method} unexpected object failures remain unavailable without leaking internal details`, async t => {
    const f = fixture();
    t.after(() => f.database.close());
    f.register();
    f.respond(() => { throw new Error('private storage details'); });
    const response = await f.request(body, { path });
    assert.equal(response.status, 503);
    const value = await response.json() as { error: { code: string; message: string } };
    assert.equal(value.error.code, 'unavailable');
    assert.doesNotMatch(value.error.message, /private storage details/);
    assert.equal(f.admissions.length, 0);
  });
}
