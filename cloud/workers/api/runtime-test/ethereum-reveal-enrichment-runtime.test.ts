import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, type MiniflareOptions } from 'miniflare';
import { MAX_REVEAL_METADATA_BYTES } from '../src/ethereumRevealAttributes.ts';

type Snapshot = {
  bootId: string;
  alarmCalls: number;
  alarmAt: number | null;
  now: number;
  sourceRequests: number;
  assignment: { category: string; asset_id: number; metadata_json: string; artwork_json: string; assignment_revision: number };
  enrichment: { status: string; attempts: number; next_check_ms: number; last_error: string | null; claim_id: string | null };
  metadata: { image: string; attributes: Array<{ trait_type: string; value: string }> };
  metadataBytes: number;
  stagedTargetMatchesBody: boolean;
  errors: Array<[{ event: string; reason: string }]>;
};

test('native mainnet enrichment retries across restart and preserves large trait collections through SQLite and R2',
  { timeout: 60_000 }, async () => {
    const contractAddress = `0x${'ab'.repeat(20)}`;
    const deployment = { deploymentId: 'mainnet-enrichment-runtime', dropId: '111k', chainId: 1, contractAddress,
      metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 100, catalogVersion: '111k-v9',
      templateJson: JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://cdn.lil.org/nft/111k/placeholder.png',
        attributes: [{ trait_type: 'type', value: 'painting' }] }),
      templateSha256: '', state: 'active', revision: 3, createdAtMs: 1, updatedAtMs: 3,
      activatedAtMs: 3, provisionedAtMs: 2, lastError: null };
    deployment.templateSha256 = createHash('sha256').update(deployment.templateJson).digest('hex');
    const observation = { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 };
    const path = (value: string) => JSON.stringify(resolve(value));
    const source = `
      import { EthereumRevealObject as Coordinator } from ${path('cloud/workers/api/src/ethereumRevealObject.ts')};
      import { EthereumRevealPublisherObject as Publisher } from ${path('cloud/workers/api/src/ethereumRevealPublisherObject.ts')};
      import { revealTraitFixtureBlock } from ${path('cloud/workers/api/runtime-test/revealTraitFixture.ts')};
      const deployment = ${JSON.stringify(deployment)};
      const objectName = deployment.chainId + ':' + deployment.contractAddress;
      let bootId;
      const errors = [];
      let sourceMode = 'forbidden', sourceRequests = 0, alarmCalls = 0;
      console.error = (...args) => errors.push(args);
      console.log = () => {};
      const registry = Object.fromEntries(Object.entries(deployment).map(([key, value]) =>
        [key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase()), value]));
      const ops = { prepare: () => ({ bind: () => ({ first: async () => registry, run: async () => ({ success: true }) }) }) };
      globalThis.fetch = async input => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname !== 'cdn.lil.org' || !url.pathname.includes('/json/v0/')) throw new Error('Unexpected external request');
        if (url.pathname.endsWith('/41171.json')) {
          sourceRequests++;
          if (sourceMode === 'forbidden') return new Response('private source response', { status: 403 });
          if (sourceMode === 'missing') return new Response('private source response', { status: 404 });
          if (sourceMode === 'malformed') return new Response('private source response', { headers: { 'Content-Type': 'application/json' } });
          return new Response(JSON.stringify({ 'collection block': revealTraitFixtureBlock(url),
            attributes: Array.from({ length: 5498 }, (_, index) => ({ trait_type: 'Trait ' + index, value: 'v'.repeat(26) })) }, null, 2),
            { headers: { 'Content-Type': 'application/json' } });
        }
        return Response.json({ 'collection block': revealTraitFixtureBlock(url),
          attributes: [{ trait_type: 'source trait', value: 'recovered' }] });
      };
      export class NativePublisher extends Publisher {
        constructor(ctx, env) { super(ctx, { ...env, OPS_DB: ops }); }
      }
      export class NativeCoordinator extends Coordinator {
        constructor(ctx, env) { super(ctx, { ...env, OPS_DB: ops }); bootId ??= crypto.randomUUID(); }
        async alarm() { alarmCalls++; await super.alarm(); }
        async seed() {
          this.configure(deployment);
          while (!this.store.initializeChunk()) {}
          while (!this.store.migrationReady()) this.store.migrateChunk(Date.now());
          const sql = this.ctx.storage.sql;
          this.ctx.storage.transactionSync(() => {
            sql.exec("INSERT INTO crates(crate_token_id) VALUES('111112')");
            for (let slot = 0; slot < 20; slot++) {
              const origin = this.store.catalogUpdate.takeFree('painting', slot === 0 ? 41170 : 0);
              sql.exec("INSERT INTO assignments(category,asset_id,crate_token_id,slot) VALUES(?,?,'111112',?)", origin.category, origin.assetId, slot);
            }
          });
          this.store.freeze(deployment, ${JSON.stringify(observation)},
            [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], Date.now());
          await this.runPublications(deployment);
          await this.arm();
          return this.snapshot();
        }
        async snapshot() {
          this.configure(deployment);
          const sql = this.ctx.storage.sql;
          const object = await this.env.ETHEREUM_REVEAL_METADATA.get('111k/1.json');
          const body = object ? await object.text() : null;
          const target = sql.exec("SELECT target_json FROM reveal_enrichment WHERE token_id='1'").toArray()[0]?.target_json;
          return { bootId, alarmCalls, alarmAt: await this.ctx.storage.getAlarm(), now: Date.now(), sourceRequests, errors,
            assignment: sql.exec("SELECT category,asset_id,metadata_json,artwork_json,assignment_revision FROM assignments WHERE token_id='1'").toArray()[0],
            enrichment: sql.exec("SELECT status,attempts,next_check_ms,last_error,claim_id FROM reveal_enrichment WHERE token_id='1'").toArray()[0],
            metadata: body ? JSON.parse(body) : null, metadataBytes: object?.size ?? 0,
            stagedTargetMatchesBody: target != null && target === body };
        }
      }
      export default { async fetch(request, env) {
        const endpoint = new URL(request.url).pathname;
        if (endpoint === '/source') { sourceMode = (await request.json()).mode; return Response.json({ ok: true }); }
        const object = env.ETHEREUM_REVEAL.getByName(objectName);
        return Response.json(endpoint === '/seed' ? await object.seed() : await object.snapshot());
      } };
    `;
    const bundle = await build({ stdin: { contents: source, resolveDir: resolve('.'), loader: 'ts' }, bundle: true,
      write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
    const worker = 'native-reveal-enrichment';
    const options = (restart = 0): MiniflareOptions => ({ workers: [{ config: {
      name: worker, compatibilityDate: '2026-08-08', compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'enrichment.mjs', modulesRoot: resolve('.'), modules: {
        'enrichment.mjs': { type: 'esm', contents: `${bundle.outputFiles[0].text}\nvoid ${restart};` },
      } },
      env: {
        ETHEREUM_REVEAL_METADATA: { type: 'r2', name: 'native-reveal-enrichment-metadata' },
        ETHEREUM_REVEAL: { type: 'durable-object', worker, exportName: 'NativeCoordinator' },
        ETHEREUM_REVEAL_PUBLISHER: { type: 'durable-object', worker, exportName: 'NativePublisher' },
      },
      exports: { NativeCoordinator: { type: 'durable-object', storage: 'sqlite' }, NativePublisher: { type: 'durable-object', storage: 'sqlite' } },
    } }] });
    const runtime = new Miniflare(options());
    const request = async (endpoint: string, body: object = {}): Promise<Snapshot> => {
      const response = await runtime.dispatchFetch(`https://native-enrichment.test${endpoint}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<Snapshot>;
    };
    const waitFor = async (predicate: (value: Snapshot) => boolean, timeoutMs = 12_000) => {
      const deadline = Date.now() + timeoutMs;
      let value = await request('/snapshot');
      while (!predicate(value) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        value = await request('/snapshot');
      }
      assert.ok(predicate(value), JSON.stringify(value));
      return value;
    };
    try {
      const initial = await request('/seed');
      assert.equal(initial.assignment.asset_id, 41171);
      assert.deepEqual(initial.metadata.attributes, [
        { trait_type: 'collection block', value: 'little swag' }, { trait_type: 'type', value: 'painting' },
      ]);
      let failed = await waitFor(value => value.enrichment.attempts === 1 && value.enrichment.claim_id === null && value.enrichment.last_error === 'source-unavailable');
      for (const [mode, attempts] of [['missing', 2], ['malformed', 3]] as const) {
        assert.equal(failed.enrichment.status, 'pending');
        assert.ok(failed.alarmAt !== null && failed.alarmAt > failed.now);
        assert.ok(failed.enrichment.next_check_ms > failed.now);
        assert.deepEqual(failed.assignment, initial.assignment);
        assert.deepEqual(failed.metadata, initial.metadata);
        await request('/source', { mode });
        failed = await waitFor(value => value.enrichment.attempts === attempts && value.enrichment.claim_id === null && value.enrichment.last_error === 'source-unavailable');
      }
      assert.equal(failed.sourceRequests, 3);
      assert.deepEqual(failed.errors.filter(([row]) => row.event === 'ethereum_reveal_attribute_preparation_error').map(([row]) => row.reason),
        ['http-403', 'http-404', 'invalid-json']);
      assert.doesNotMatch(JSON.stringify(failed.errors), /private source response|https?:|stack/);
      await runtime.setOptions(options(1));
      const restarted = await request('/snapshot');
      assert.notEqual(restarted.bootId, failed.bootId);
      assert.deepEqual(restarted.enrichment, failed.enrichment);
      assert.equal(restarted.alarmAt, failed.alarmAt);
      assert.deepEqual(restarted.assignment, initial.assignment);
      await request('/source', { mode: 'valid' });
      const recovered = await waitFor(value => value.enrichment.status === 'published');
      assert.equal(recovered.enrichment.attempts, 4);
      assert.equal(recovered.enrichment.last_error, null);
      assert.ok(recovered.alarmCalls >= 1);
      assert.deepEqual(recovered.assignment, initial.assignment);
      assert.equal(recovered.metadata.image, initial.metadata.image);
      assert.deepEqual(recovered.metadata.attributes, [
        ...initial.metadata.attributes,
        ...Array.from({ length: 5498 }, (_, index) => ({ trait_type: `Trait ${index}`, value: 'v'.repeat(26) })),
      ]);
      assert.ok(recovered.metadataBytes > 350_000 && recovered.metadataBytes < MAX_REVEAL_METADATA_BYTES);
      assert.equal(recovered.stagedTargetMatchesBody, true);
      assert.equal(recovered.metadata.attributes.filter(row => row.trait_type === 'collection block').length, 1);
    } finally { await runtime.dispose(); }
  });
