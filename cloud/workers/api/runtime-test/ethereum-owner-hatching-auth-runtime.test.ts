import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';

test('owner hatching preserves safe authorization errors across native Durable Object RPC', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ethereum-owner-hatching-auth-'));
  const main = join(directory, 'worker.ts');
  await writeFile(main, `
    import { DurableObject } from 'cloudflare:workers';
    import { ownerHatchingRpcError } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumOwnerHatching.ts'))};
    import { EthereumApiError } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumError.ts'))};
    export class HatchAuthorization extends DurableObject {
      async fail(code) {
        throw ownerHatchingRpcError(code === 'unexpected' ? new Error('private details') : new EthereumApiError(code, 'Hatching request rejected.'));
      }
    }
    export default {
      async fetch(request, env) {
        try {
          await env.AUTHORIZATION.getByName('fixture').fail(new URL(request.url).searchParams.get('code'));
          return Response.json({ unexpected: true });
        } catch (error) {
          return Response.json({ name: error.name, message: error.message });
        }
      },
    };
  `);
  const runtime = createTestHarness({ root: directory, workers: [{ config: {
    name: 'ethereum-owner-hatching-auth-test', main, compatibility_date: '2026-08-08',
    compatibility_flags: ['nodejs_compat', 'enable_request_signal'],
    durable_objects: { bindings: [{ name: 'AUTHORIZATION', class_name: 'HatchAuthorization' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['HatchAuthorization'] }],
  } }] });
  try {
    await runtime.listen();
    const worker = runtime.getWorker('ethereum-owner-hatching-auth-test');
    for (const code of ['permission-denied', 'failed-precondition', 'resource-exhausted']) {
      const response = await worker.fetch(`https://auth.test/?code=${code}`);
      assert.deepEqual(await response.json(), { name: `EthereumOwnerHatching:${code}`, message: 'Hatching request rejected.' });
    }
    const response = await worker.fetch('https://auth.test/?code=unexpected');
    assert.deepEqual(await response.json(), { name: 'EthereumOwnerHatching:unavailable', message: 'Egg hatching is temporarily unavailable.' });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
