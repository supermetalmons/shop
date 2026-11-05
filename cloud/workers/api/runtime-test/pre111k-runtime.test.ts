import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { PRE111K_API_PATHS, type Pre111kStatus } from '../../../../shared/ethereum/pre111k.ts';

test('pre111k access verification and preparation rejection run in the Worker runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pre111k-access-runtime-'));
  const production = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const main = join(directory, 'worker.ts');
  await writeFile(main, `
import { handlePre111kRequest } from ${JSON.stringify(resolve('cloud/workers/api/src/pre111k.ts'))};
export default {
  fetch(request, env) {
    return handlePre111kRequest(request, env, new URL(request.url).pathname, {
      fetch: async () => { throw new Error('Access checks must not request RPC'); },
    });
  },
};
`);
  const server = createTestHarness({ root: directory, workers: ['configured', 'missing'].map(name => ({ config: {
    name: `pre111k-access-${name}`, main, compatibility_date: production.compatibility_date,
    compatibility_flags: production.compatibility_flags, ratelimits: production.ratelimits,
    vars: { ...production.vars, ETHEREUM_PRE111K_MAINNET_CONTRACT_ADDRESS: '', ETHEREUM_PRE111K_SEPOLIA_CONTRACT_ADDRESS: '',
      ETHEREUM_PRE111K_SEPOLIA_PRICE_WEI: '1700000000000001',
      ETHEREUM_PRE111K_ACCESS_CODES: name === 'configured' ? '["RUNTIMEONE","RUNTIMETWO"]' : '' },
  } })) });
  try {
    await server.listen();
    const worker = server.getWorker('pre111k-access-configured');
    const headers = { Origin: 'https://mons.shop', 'CF-Connecting-IP': '192.0.2.1',
      'Content-Type': 'application/json', 'X-Mons-CSRF': '1' };
    const status = await worker.fetch(`https://api.mons.shop${PRE111K_API_PATHS.status}?network=devnet`, { headers });
    assert.equal(status.status, 200);
    const { config } = await status.json() as Pre111kStatus;
    assert.equal(config.priceWei, '1700000000000001');
    assert.equal(config.maxRelics, 17);
    const call = (path: string, body: unknown) => worker.fetch(`https://api.mons.shop${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    for (const code of [' runtimeone ', 'RUNTIMETWO']) {
      const access = await call(PRE111K_API_PATHS.access, { code });
      assert.equal(access.status, 200);
      assert.equal(access.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await access.json(), { ok: true });
    }
    for (const code of [undefined, 'INCORRECT']) {
      const denied = await call(PRE111K_API_PATHS.prepare, { network: 'mainnet', wallet: `0x${'22'.repeat(20)}`, code });
      assert.equal(denied.status, 401);
      assert.deepEqual(await denied.json(), { ok: false, error: { code: 'unauthenticated', message: 'Enter a valid secret code.' } });
    }
    const noConfig = await server.getWorker('pre111k-access-missing').fetch(`https://api.mons.shop${PRE111K_API_PATHS.access}`, {
      method: 'POST', headers, body: JSON.stringify({ code: 'RUNTIMEONE' }),
    });
    assert.equal(noConfig.status, 503);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
