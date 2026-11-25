import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TAROT_API_PATHS } from '../../../../shared/ethereum/tarot.ts';
import { loadApiWorkerIndex } from './cloudflareWorkersTestLoader.ts';
import { failOnDeferredWork } from './deferredWork.ts';
import { d1Database } from './commerceD1Harness.ts';

const { handleRequest } = await loadApiWorkerIndex();

test('Tarot routes enforce storefront CORS and retain POST-only behavior', async () => {
  for (const path of Object.values(TAROT_API_PATHS)) {
    const request = (method: string, origin = 'https://mons.shop') => new Request(`https://api.mons.shop${path}`, {
      method, headers: { Origin: origin },
    });
    const preflight = await handleRequest(request('OPTIONS'), {} as Env, failOnDeferredWork, { log: () => undefined });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://mons.shop');
    assert.match(preflight.headers.get('Access-Control-Allow-Headers') || '', /X-Mons-CSRF/);
    const denied = await handleRequest(request('OPTIONS', 'https://vvv.so'), {} as Env, failOnDeferredWork, { log: () => undefined });
    assert.equal(denied.status, 403);
    if (path === TAROT_API_PATHS.prepare) continue;
    const get = await handleRequest(request('GET'), {} as Env, failOnDeferredWork, { log: () => undefined });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('Allow'), 'POST, OPTIONS');
    assert.equal(get.headers.get('Cache-Control'), 'no-store');
  }
});

test('full Worker Tarot quotas follow the trusted IP across allowed Origin changes', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync('cloud/workers/api/ops-migrations/0014_tarot_claim_codes.sql', 'utf8'));
  db.exec(readFileSync('cloud/workers/api/ops-migrations/0017_dmx_sepolia_retirement.sql', 'utf8'));
  const counts = { access: new Map<string, number>(), confirm: new Map<string, number>() };
  const limiter = (operation: keyof typeof counts, maximum: number): RateLimit => ({ limit: async ({ key }) => {
    const count = (counts[operation].get(key) ?? 0) + 1;
    counts[operation].set(key, count);
    return { success: count <= maximum };
  } });
  const env = {
    OPS_DB: d1Database(db), ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS: `0x${'11'.repeat(20)}`,
    ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK: '1', ETHEREUM_TAROT_SEPOLIA_ENABLED: 'false',
    TAROT_ACCESS_IP_RATE_LIMITER: limiter('access', 30), TAROT_CONFIRM_IP_RATE_LIMITER: limiter('confirm', 60),
  } as Env;
  const call = (path: string, origin: string, ip: string | null = '192.0.2.1') => handleRequest(
    new Request(`https://api.mons.shop${path}`, { method: 'POST',
      headers: { Origin: origin, 'X-Mons-CSRF': '1', 'Content-Type': 'application/json',
        ...(ip === null ? {} : { 'CF-Connecting-IP': ip }) },
      body: JSON.stringify({ tokenId: 1, testnet: true, code: '11111111-1111-4111-8111-111111111111',
        ...(path === TAROT_API_PATHS.confirm ? { wallet: `0x${'22'.repeat(20)}`, transactionHash: `0x${'aa'.repeat(32)}` } : {}) }),
    }), env, failOnDeferredWork, { log: () => undefined, providerFetch: async () => { assert.fail('Invalid codes cannot request RPC'); } });
  for (let index = 0; index < 30; index++) {
    assert.equal((await call(TAROT_API_PATHS.status, `http://localhost:${3000 + index}`)).status, 401);
  }
  for (const origin of ['https://mons.shop', 'https://www.mons.shop', 'http://127.0.0.1:9999',
    'https://candidate-mons-shop.lil-org.workers.dev', 'https://deadbeef-mons-shop.lil-org.workers.dev']) {
    const rejected = await call(TAROT_API_PATHS.status, origin);
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers.get('Retry-After'), '60');
    assert.equal(rejected.headers.get('Access-Control-Allow-Origin'), origin);
  }
  assert.equal(counts.access.size, 1);
  assert.equal((await call(TAROT_API_PATHS.status, 'https://mons.shop', '192.0.2.2')).status, 401);
  assert.equal(counts.access.size, 2);
  for (let index = 0; index < 60; index++) {
    assert.equal((await call(TAROT_API_PATHS.confirm, `http://localhost:${6000 + index}`)).status, 401);
  }
  assert.equal((await call(TAROT_API_PATHS.confirm, 'https://deadbeef-mons-shop.lil-org.workers.dev')).status, 429);
  assert.equal(counts.confirm.size, 1);
  assert.equal((await call(TAROT_API_PATHS.confirm, 'https://mons.shop', '192.0.2.2')).status, 401);
  for (const ip of [null, '', 'invalid-ip', '192.0.2.1, 192.0.2.2', '2001:db8:::1']) {
    assert.equal((await call(TAROT_API_PATHS.status, 'http://localhost:3000', ip)).status, 503);
  }
});
