import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('retired cutoff and owner-batch writes are rejected by the private service and directly by the coordinator', async t => {
  const source = `
    export { EthereumRevealObject } from './cloud/workers/api/src/ethereumRevealObject.ts';
    export { EthereumRevealMaintenance } from './cloud/workers/api/src/ethereumRevealMaintenance.ts';
    export default { async fetch(request, env) {
      const { direct, owner, payload } = await request.json();
      try {
        if (direct) {
          const object = env.LEDGER.getByName('fixture');
          if (owner) await object.ownerHatchingOperation({}, payload);
          else await object.catalogUpdate({}, payload);
        } else if (owner) await env.HISTORY.ownerHatching(payload);
        else await env.HISTORY.catalogUpdate(payload);
        return new Response('accepted');
      } catch (error) { return new Response(error.message, {status:409}); }
    } };
  `;
  const built = await build({ stdin: { contents: source, resolveDir: resolve('.'), loader: 'ts' }, bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
  const worker = 'historical-hatch';
  const runtime = new Miniflare({ workers: [{ config: {
    name: worker, compatibilityDate: '2026-08-08', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'history.mjs', modulesRoot: resolve('.'), modules: {
      'history.mjs': { type: 'esm', contents: built.outputFiles[0].text },
    } },
    env: { LEDGER: { type: 'durable-object', worker, exportName: 'EthereumRevealObject' },
      HISTORY: { type: 'worker', worker, exportName: 'EthereumRevealMaintenance' } },
    exports: { EthereumRevealObject: { type: 'durable-object', storage: 'sqlite' }, EthereumRevealMaintenance: { type: 'worker' } },
  } }] });
  t.after(() => runtime.dispose());
  for (const direct of [true, false]) {
    for (const [owner, actions] of [[false, ['begin', 'advance', 'cancel']], [true, ['scan', 'activate', 'complete']]] as const) {
      for (const action of actions) {
        const payload = { deploymentId: 'fixture', batchId: owner ? 'old-owner' : 'catalog-' + '1'.repeat(32), action, expectedRevision: 1 };
        const result = await runtime.dispatchFetch('https://fixture.test', { method: 'POST', body: JSON.stringify({ direct, owner, payload }) });
        assert.equal(result.status, 409);
        assert.match(await result.text(), owner ? /Use mixed allocation/ : /inspection and verification only/);
      }
    }
  }
});
