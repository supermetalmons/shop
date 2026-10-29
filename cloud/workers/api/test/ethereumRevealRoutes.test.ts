import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ETHEREUM_REVEAL_PATHS } from '../../../../shared/ethereum/reveal.ts';
import { applyEthereumRevealCors } from '../src/ethereumReveal.ts';
import { handleEthereumRequest } from '../src/ethereumHandler.ts';
import { ethereumRouteDefinition } from '../src/ethereumRouteDefinitions.ts';
import { ethereumRoutes } from '../src/ethereumRoutes.ts';
import type { EthereumEnvironment } from '../src/ethereumRuntime.ts';
import { d1Database } from './commerceD1Harness.ts';

const CONTRACT = `0x${'11'.repeat(20)}`;
const HASH = `0x${'aa'.repeat(32)}`;
const TRANSACTION = { chainId: 11155111, contractAddress: CONTRACT, transactionHash: HASH };

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync('cloud/workers/api/ops-migrations/0009_ethereum_reveal_deployments.sql', 'utf8'));
  let allowed = true;
  const limits: string[] = [];
  const limiter: RateLimit = { limit: async ({ key }) => { limits.push(key); return { success: allowed }; } };
  const env: EthereumEnvironment = {
    OPS_DB: d1Database(database), COMMERCE_DB: d1Database(database), ALCHEMY_MI_NOTE_API_KEY: 'test',
    ETHEREUM_111K_CHAIN_ID: '11155111', ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT,
    ETHEREUM_111K_DEPLOYMENT_BLOCK: '100', ETHEREUM_111K_METADATA_BASE_URI: 'https://cdn.mons.shop/111k-sepolia/',
    ETHEREUM_111K_RPC_URL: '', STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter,
    STAFF_AUTH_SESSION_RATE_LIMITER: limiter, PUBLIC_SHOP_RATE_LIMITER: limiter,
    ETHEREUM_REVEAL_READ_RATE_LIMITER: limiter,
  };
  const request = (body: unknown, options: { path?: string; origin?: string; csrf?: string; method?: string } = {}) => {
    const path = options.path ?? ETHEREUM_REVEAL_PATHS.transaction;
    const method = options.method ?? 'POST';
    return handleEthereumRequest(new Request(`https://api.mons.shop${path}`, { method,
      headers: { Origin: options.origin ?? 'https://vvv.so', 'X-Mons-CSRF': options.csrf ?? '1',
        'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) }), env, path);
  };
  return { database, request, limits, deny: () => { allowed = false; } };
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
