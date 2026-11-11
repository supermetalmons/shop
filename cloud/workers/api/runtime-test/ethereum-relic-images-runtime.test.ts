import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { prepareRelicImagePatch, type RelicImagePatch, type RelicImagesScope } from '../../../../shared/ethereum/relicImages.ts';

const headers = { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' };
const body = '{"name":"Relic #1","description":"","image":"https://cdn.lil.org/nft/111k/relics/1.webp","attributes":[{"trait_type":"number","value":12345678901234567890}]}\n';
type Outcome = { error?: string; action?: string; status?: string; objects?: RelicImagePatch[];
  body: string | null; etag: string | null; writes: number; conditions: R2Conditional[];
  customMetadata?: Record<string, string>; headers?: R2HTTPMetadata };

test('native relic publisher enforces registered identities and R2 conditional writes on both networks', { timeout: 30_000 }, async () => {
  const source = `
    import { EthereumRevealPublisherObject } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealPublisherObject.ts'))};
    const headers = ${JSON.stringify(headers)};
    const body = ${JSON.stringify(body)};
    export class RelicPublisher extends EthereumRevealPublisherObject {
      constructor(ctx, env) {
        const state = { row: null, writes: 0, conditions: [], mode: '' };
        super(ctx, { ETHEREUM_REVEAL_PUBLISHER: env.PUBLISHER,
          OPS_DB: { prepare: () => ({ bind: () => ({ first: async () => state.row }) }) },
          ETHEREUM_REVEAL_METADATA: {
            get: async key => {
              const result = await env.BUCKET.get(key);
              if (state.mode === 'revision-after-read') state.row.revision++;
              return result;
            },
            put: async (key, json, options) => {
              state.writes++;
              state.conditions.push(options.onlyIf);
              if (state.mode === 'etag-race') await env.BUCKET.put(key, 'foreign bytes');
              const result = await env.BUCKET.put(key, json, options);
              if (state.mode === 'lost-ack') throw new Error('Lost acknowledgment');
              return result;
            },
          },
        });
        this.state = state;
        this.bucket = env.BUCKET;
      }
      async run(input) {
        const scope = input.scope;
        Object.assign(this.state, { writes: 0, conditions: [], mode: input.mode || '', row: {
          deployment_id: scope.deploymentId, drop_id: scope.chainId === 1 ? '111k' : '111k_devnet', chain_id: scope.chainId,
          contract_address: scope.contractAddress, metadata_base_uri: scope.metadataBaseUri, deployment_block: 100,
          catalog_version: '111k-v8', template_json: '{"name":"artwork","description":"","image":"placeholder","attributes":[]}',
          template_sha256: 'a'.repeat(64), state: scope.chainId === 1 ? 'ready' : 'active', revision: 3,
          created_at_ms: 1, updated_at_ms: 3, activated_at_ms: 3, provisioned_at_ms: 2, last_error: null,
          ...input.row,
        } });
        const prefix = new URL(scope.metadataBaseUri).pathname.slice(1);
        if (input.initialize) for (let index = 0; index < 18; index++) {
          await this.bucket.put(prefix + (117172 + index) + '.json', body.replace('/1.webp', '/' + (index + 1) + '.webp'), {
            httpMetadata: headers, customMetadata: { retained: 'yes', sha256: 'old-checksum' },
          });
        }
        let result;
        try { result = await this.relicImages(input.request || { scope, action: 'inspect' }); }
        catch (error) { result = { error: error.message }; }
        const stored = await this.bucket.get(prefix + '117172.json');
        return { ...result, body: stored ? await stored.text() : null, etag: stored?.etag || null,
          headers: stored?.httpMetadata, customMetadata: stored?.customMetadata,
          writes: this.state.writes, conditions: this.state.conditions };
      }
    }
    export default { async fetch(request, env) {
      const input = await request.json();
      return Response.json(await env.PUBLISHER.getByName(input.scope.chainId + ':' + input.scope.contractAddress).run(input));
    } };
  `;
  const bundle = await build({ stdin: { contents: source, resolveDir: resolve('.'), loader: 'ts' }, bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'relic-publisher-runtime', compatibilityDate: '2026-08-08',
    manifest: { mainModule: 'publisher.mjs', modulesRoot: resolve('.'), modules: {
      'publisher.mjs': { type: 'esm', contents: bundle.outputFiles[0].text },
    } },
    env: { BUCKET: { type: 'r2', name: 'relic-publisher-bucket' },
      PUBLISHER: { type: 'durable-object', worker: 'relic-publisher-runtime', exportName: 'RelicPublisher' } },
    exports: { RelicPublisher: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  const run = async (scope: RelicImagesScope, input: Record<string, unknown>): Promise<Outcome> => {
    const response = await runtime.dispatchFetch('https://relic-publisher.test/run', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope, ...input }) });
    assert.equal(response.status, 200);
    return response.json() as Promise<Outcome>;
  };
  try {
    for (const chainId of [1, 11155111]) {
      const scope: RelicImagesScope = { deploymentId: chainId === 1 ? 'mainnet-v1' : 'relic-runtime-test', chainId,
        contractAddress: `0x${'11'.repeat(20)}`, metadataBaseUri: chainId === 1 ? 'https://cdn.mons.shop/111k/' :
          'https://cdn.mons.shop/111k-sepolia/relic-runtime-test/', expectedRevision: 3 };
      const inspection = await run(scope, { initialize: true });
      assert.equal(inspection.error, undefined);
      assert.equal(inspection.objects?.length, 18);
      assert.equal(inspection.writes, 0);
      const patch = inspection.objects![0];
      assert.deepEqual(patch, prepareRelicImagePatch('117172', body, inspection.etag!));
      const request = { scope, action: 'apply', patch };
      const written = await run(scope, { request });
      assert.equal(written.status, 'updated');
      assert.equal(written.body, body.replace('/1.webp', '/1.png'));
      assert.deepEqual(written.conditions, [{ etagMatches: patch.etag }]);
      assert.deepEqual(written.headers, headers);
      assert.deepEqual(written.customMetadata, { retained: 'yes', sha256: patch.afterSha256 });
      const retry = await run(scope, { request });
      assert.equal(retry.status, 'unchanged');
      assert.equal(retry.writes, 0);
      const raced = await run(scope, { initialize: true, request, mode: 'etag-race' });
      assert.match(raced.error!, /conditional write conflicted/);
      assert.equal(raced.body, 'foreign bytes');
      const changed = await run(scope, { initialize: true, request, mode: 'revision-after-read' });
      assert.match(changed.error!, /identity, revision, or maintenance state/);
      assert.equal(changed.writes, 0);
      const lost = await run(scope, { initialize: true, request, mode: 'lost-ack' });
      assert.match(lost.error!, /Lost acknowledgment/);
      assert.equal((await run(scope, { request })).status, 'unchanged');
      const wrong = await run(scope, { initialize: true, request: { ...request, scope: { ...scope, expectedRevision: 4 } } });
      assert.match(wrong.error!, /identity, revision, or maintenance state/);
      assert.equal(wrong.writes, 0);
    }
  } finally { await runtime.dispose(); }
});
