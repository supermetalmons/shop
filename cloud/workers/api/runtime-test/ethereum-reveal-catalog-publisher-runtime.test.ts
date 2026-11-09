import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const scope = { deploymentId: 'catalog-publisher-test', chainId: 11155111, contractAddress: `0x${'11'.repeat(20)}`,
  metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/catalog-publisher-test/' };
const oldJson = '{"category":"egg","name":"Egg #76642"}\n';
const targetJson = '{"category":"painting","name":"1","attributes":[]}\n';
const job = { tokenId: '1', metadataRevision: 3, metadataJson: targetJson, expectedJsons: [oldJson], allowMissing: false };
const headers = { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' };
type Outcome = { status?: string; error?: string; body: string | null; writes: number; reads: number;
  etag: string | null; putConditions: Array<{ etagMatches?: string; etagDoesNotMatch?: string }>; headers?: R2HTTPMetadata };

test('native online publisher authorizes token revisions and conditionally replaces only recorded predecessor bytes', { timeout: 30_000 }, async () => {
  const registration = {
    deployment_id: scope.deploymentId, drop_id: '111k_devnet', chain_id: scope.chainId, contract_address: scope.contractAddress,
    metadata_base_uri: scope.metadataBaseUri, deployment_block: 100, catalog_version: '111k-v5',
    template_json: '{"name":"artwork","description":"","image":"placeholder","attributes":[]}', template_sha256: 'a'.repeat(64),
    state: 'active', revision: 3, created_at_ms: 1, updated_at_ms: 3, activated_at_ms: 3, provisioned_at_ms: 2, last_error: null,
  };
  const key = '111k-sepolia/catalog-publisher-test/1.json';
  const source = `
    import { EthereumRevealPublisherObject } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealPublisherObject.ts'))};
    const scope = ${JSON.stringify(scope)};
    const registration = ${JSON.stringify(registration)};
    const key = ${JSON.stringify(key)};
    export class CatalogPublisher extends EthereumRevealPublisherObject {
      constructor(ctx, env) {
        const state = { row: { ...registration }, writes: 0, reads: 0, conditions: [], authorized: null, mode: '' };
        super(ctx, { ETHEREUM_REVEAL_PUBLISHER: env.PUBLISHER,
          ETHEREUM_REVEAL: { getByName: () => ({ validatePublication: async (request, job) => {
            const current = state.authorized && JSON.parse(state.authorized);
            return request.deploymentId === scope.deploymentId && current && current.tokenId === job.tokenId &&
              current.metadataRevision === job.metadataRevision && current.metadataJson === job.metadataJson &&
              current.allowMissing === job.allowMissing && JSON.stringify(current.expectedJsons) === JSON.stringify(job.expectedJsons);
          } }) },
          OPS_DB: { prepare: () => ({ bind: () => ({ first: async () => state.row }) }) },
          ETHEREUM_REVEAL_METADATA: {
            get: async key => {
              state.reads++;
              const result = await env.BUCKET.get(key);
              if (state.mode === 'supersede-after-get') state.authorized = null;
              return result;
            },
            put: async (key, body, options) => {
              state.writes++;
              state.conditions.push(options.onlyIf);
              if (state.mode === 'etag-race') await env.BUCKET.put(key, 'concurrent foreign metadata');
              const result = await env.BUCKET.put(key, body, options);
              if (state.mode === 'lost-ack') throw new Error('Lost R2 acknowledgment');
              return result;
            },
          },
        });
        this.state = state;
        this.bucket = env.BUCKET;
      }
      async run(input) {
        Object.assign(this.state, { row: { ...registration }, writes: 0, reads: 0, conditions: [],
          authorized: JSON.stringify(input.authorized ?? input.job), mode: input.mode ?? '' });
        if ('initial' in input) {
          if (input.initial === null) await this.bucket.delete(key);
          else await this.bucket.put(key, input.initial, { httpMetadata: input.headers });
        }
        let result;
        try {
          if (input.action === 'attributes') {
            result = await this.publishAttributes({ ...scope, ...input.scope }, { tokenId: '1', baseJson: input.job.expectedJsons[0],
              metadataJson: input.job.metadataJson, metadataRevision: input.job.metadataRevision }, Date.now() + 5000);
          } else {
            [result] = await this.publishBatch({ ...scope, ...input.scope }, [{ token_id: '1', placeholder_json: input.job.expectedJsons[0] ?? '{}',
              metadata_json: input.job.metadataJson, metadata_revision: input.job.metadataRevision,
              expected_jsons_json: JSON.stringify(input.job.expectedJsons), allow_missing: input.job.allowMissing,
              migration: input.action !== 'media', attempts: 0 }], Date.now() + 5000);
          }
        } catch (error) { result = { error: error.message }; }
        const stored = await this.bucket.get(key);
        return { ...result, body: stored ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(await stored.arrayBuffer()) : null, etag: stored?.etag ?? null,
          headers: stored?.httpMetadata, writes: this.state.writes, reads: this.state.reads, putConditions: this.state.conditions };
      }
    }
    export default { async fetch(request, env) {
      const input = await request.json();
      const name = (input.attributeObject ? 'attributes:' : '') + scope.chainId + ':' + scope.contractAddress;
      return Response.json(await env.PUBLISHER.getByName(name).run(input));
    } };
  `;
  const bundle = await build({ stdin: { contents: source, resolveDir: resolve('.'), loader: 'ts' }, bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'catalog-publisher-runtime', compatibilityDate: '2026-08-08',
    manifest: { mainModule: 'publisher.mjs', modulesRoot: resolve('.'), modules: {
      'publisher.mjs': { type: 'esm', contents: bundle.outputFiles[0].text },
    } },
    env: { BUCKET: { type: 'r2', name: 'catalog-publisher-bucket' },
      PUBLISHER: { type: 'durable-object', worker: 'catalog-publisher-runtime', exportName: 'CatalogPublisher' } },
    exports: { CatalogPublisher: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  const run = async (input: Record<string, unknown>): Promise<Outcome> => {
    const response = await runtime.dispatchFetch('https://catalog-publisher.test/run', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job, ...input }) });
    assert.equal(response.status, 200);
    return response.json() as Promise<Outcome>;
  };
  try {
    const exact = await run({ initial: oldJson, headers });
    assert.equal(exact.status, 'published');
    assert.equal(exact.body, targetJson);
    assert.equal(exact.writes, 1);
    assert.ok(exact.putConditions[0].etagMatches);
    assert.deepEqual(exact.headers, headers);

    const idempotent = await run({});
    assert.equal(idempotent.status, 'published');
    assert.equal(idempotent.writes, 0);
    const repair = await run({ initial: targetJson, headers: { contentType: 'application/octet-stream', cacheControl: 'max-age=3600' } });
    assert.equal(repair.status, 'published');
    assert.equal(repair.writes, 1);
    assert.deepEqual(repair.headers, headers);

    for (const initial of ['foreign', '\ufeff' + oldJson, null]) {
      const rejected = await run({ initial, headers });
      assert.equal(rejected.status, 'conflict');
      assert.equal(rejected.body, initial);
      assert.equal(rejected.writes, 0);
    }
    const absentJob = { ...job, expectedJsons: [], allowMissing: true };
    const absent = await run({ initial: null, job: absentJob });
    assert.equal(absent.status, 'published');
    assert.deepEqual(absent.putConditions, [{ etagDoesNotMatch: '*' }]);
    const notAbsent = await run({ initial: oldJson, job: absentJob });
    assert.equal(notAbsent.status, 'conflict');
    assert.equal(notAbsent.writes, 0);
    assert.equal(notAbsent.body, oldJson);

    const race = await run({ initial: oldJson, mode: 'etag-race' });
    assert.equal(race.status, 'retry');
    assert.equal(race.body, 'concurrent foreign metadata');
    const retryRace = await run({});
    assert.equal(retryRace.status, 'conflict');
    assert.equal(retryRace.writes, 0);

    const lostAck = await run({ initial: oldJson, mode: 'lost-ack' });
    assert.equal(lostAck.status, 'retry');
    assert.equal(lostAck.body, targetJson);
    assert.equal((await run({})).writes, 0);

    const stale = await run({ initial: oldJson, mode: 'supersede-after-get' });
    assert.equal(stale.status, 'superseded');
    assert.equal(stale.writes, 0);
    assert.equal(stale.body, oldJson);
    const staleBeforeRead = await run({ initial: oldJson, job: { ...job, metadataRevision: 1 }, authorized: job });
    assert.equal(staleBeforeRead.status, 'superseded');
    assert.equal(staleBeforeRead.reads, 0);

    const unauthorized = await run({ initial: oldJson, authorized: { ...job, metadataJson: 'different sealed bytes' } });
    assert.equal(unauthorized.status, 'superseded');
    assert.equal(unauthorized.reads, 0);
    assert.equal(unauthorized.writes, 0);
    for (const action of ['media', 'attributes']) {
      const ordinary = await run({ initial: oldJson, action, attributeObject: action === 'attributes' });
      assert.equal(ordinary.status, 'published');
      assert.equal(ordinary.body, targetJson);
      if (action === 'attributes') assert.equal(ordinary.writes, 0);
    }
  } finally { await runtime.dispose(); }
});
