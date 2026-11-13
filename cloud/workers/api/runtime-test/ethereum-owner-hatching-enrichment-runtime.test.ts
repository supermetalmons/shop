import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, type MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { ethereumSignerAddress, personalMessageHash, signDigest } from '../../../../shared/ethereum/crypto.ts';
import { ETHEREUM_OWNER_HATCHING_MESSAGE, ETHEREUM_OWNER_HATCHING_PATHS } from '../../../../shared/ethereum/ownerHatching.ts';
import type { EthereumRevealTokensResponse } from '../../../../shared/ethereum/reveal.ts';
import { buildEthereumRevealRegistration } from '../../../../scripts/ops/ethereumRevealControl.ts';

type EnrichmentSummary = { pending: number; failed: number; completed: number; errors: Record<string, number> };
type Snapshot = {
  bootId: string;
  owner: EnrichmentSummary;
  health: { ownerEnrichment: EnrichmentSummary };
  jobs: Array<{ token_id: string; status: string; attempts: number; last_error: string | null }>;
  canonical: { category: string; assetId: number; metadataRevision: number };
  publication: Array<{ token_id: string; status: string; metadata_revision: number }>;
  sourceRequests: number;
  alarmCalls: number;
  alarmAt: number | null;
  now: number;
  errors: Array<[{ event: string; deploymentId: string; tokenId: string; attempt: number; reason: string }]>;
};
type Metadata = { image: string; readyToHatch?: boolean; attributes: Array<{ trait_type: string; value: string }> };

test('native owner enrichment recovers failures and schedules work without blocking a hatch', { timeout: 300_000 }, async t => {
  const catalog = getRevealCatalog('111k-v9')!;
  const descriptor = getRevealCatalogDescriptor('111k-v9')!;
  const deploymentId = 'native-owner-enrichment';
  const contractAddress = `0x${'ab'.repeat(20)}`;
  const chainId = 31337;
  const objectName = `${chainId}:${contractAddress}`;
  const metadataPrefix = `111k-sepolia/${deploymentId}/`;
  const metadataBaseUri = `https://cdn.mons.shop/${metadataPrefix}`;
  const privateKey = `0x${'11'.repeat(32)}`;
  const wallet = ethereumSignerAddress(privateKey);
  const signature = signDigest(privateKey, personalMessageHash(ETHEREUM_OWNER_HATCHING_MESSAGE));
  const observation = { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 };
  const templateJson = JSON.stringify({ name: '{{tokenId}}', description: '111k', image: 'https://cdn.lil.org/nft/111k/placeholder.png',
    attributes: [{ trait_type: 'series', value: '111K' }] });
  const importPath = (path: string) => JSON.stringify(resolve(path));
  const source = `
    import { EthereumRevealObject as Coordinator } from ${importPath('cloud/workers/api/src/ethereumRevealObject.ts')};
    import { EthereumRevealPublisherObject as Publisher } from ${importPath('cloud/workers/api/src/ethereumRevealPublisherObject.ts')};
    import { EthereumRevealStore } from ${importPath('cloud/workers/api/src/ethereumRevealStore.ts')};
    import { parseEthereumRevealDeployment } from ${importPath('shared/ethereum/revealDeployment.ts')};
    import { handleEthereumRequest } from ${importPath('cloud/workers/api/src/ethereumHandler.ts')};
    import { decodeReturn, encodeAbi, encodeCall } from ${importPath('shared/ethereum/abi.ts')};
    import { ETHEREUM_FUNCTIONS } from ${importPath('shared/ethereum/protocol.ts')};
    const constants = { ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: ${JSON.stringify(contractAddress)},
      ETHEREUM_111K_METADATA_BASE_URI: ${JSON.stringify(metadataBaseUri)}, ETHEREUM_111K_DEPLOYMENT_BLOCK: '100',
      ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545', ALCHEMY_MI_NOTE_API_KEY: 'fixture' };
    const catalog = ${JSON.stringify(catalog)};
    const descriptor = ${JSON.stringify(descriptor)};
    const prefix = ${JSON.stringify(metadataPrefix)};
    const objectName = ${JSON.stringify(objectName)};
    let bootId;
    const errors = [];
    console.error = (...args) => errors.push(args);
    let bucket;
    let sourceMode = 'valid';
    let sourceRequests = 0;
    let holdSource = false;
    let releaseSources = [];
    let alarmCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === '127.0.0.1') {
        const payload = JSON.parse(init.body);
        const respond = row => {
          let result;
          if (row.method === 'eth_chainId') result = '0x7a69';
          else if (row.method === 'eth_getBlockByNumber') result = { number: '0x3e8', hash: '0x'+'a'.repeat(64) };
          else if (row.method === 'eth_getCode') result = '0x';
          else if (row.method === 'eth_call' && row.params[0].data.slice(0,10) === encodeCall(ETHEREUM_FUNCTIONS.tokenInfos, [], [])) {
            const [ids] = decodeReturn(['uint256[]'], '0x'+row.params[0].data.slice(10));
            result = encodeAbi(['(uint8,uint256,address)[]'], [ids.map(id => [1, id, ${JSON.stringify(wallet)}])]);
          } else throw new Error('Unexpected ownership RPC '+row.method);
          return { jsonrpc: '2.0', id: row.id, result };
        };
        return Response.json(Array.isArray(payload) ? payload.map(respond) : respond(payload));
      }
      if (url.hostname === 'cdn.mons.shop') {
        const object = await bucket.get(url.pathname.slice(1));
        if (!object) return new Response(null, { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        return new Response(object.body, { headers });
      }
      if (url.hostname === 'cdn.lil.org' && url.pathname.includes('/json/v0/')) {
        sourceRequests++;
        if (holdSource) await new Promise(resolve => { releaseSources.push(resolve); });
        if (sourceMode === 'missing') return new Response('private-source-body', { status: 404 });
        if (sourceMode === 'malformed') return new Response('{"private-source-body":', { headers: { 'Content-Type': 'application/json' } });
        if (sourceMode === 'unavailable') return new Response('private-source-body', { status: 503 });
        return Response.json({ 'collection block': 'fixture', attributes: [{ trait_type: 'fixture', value: 'recovered' }] });
      }
      throw new Error('Unexpected external fetch '+url);
    };
    async function current(env) {
      return parseEthereumRevealDeployment(await env.OPS_DB.prepare('SELECT * FROM ethereum_reveal_deployments WHERE deployment_id=?')
        .bind(${JSON.stringify(deploymentId)}).first());
    }
    export class NativePublisher extends Publisher {}
    export class NativeCoordinator extends Coordinator {
      constructor(ctx, env) { super(ctx, { ...env, ...constants }); bucket = env.ETHEREUM_REVEAL_METADATA; bootId ??= crypto.randomUUID(); }
      async alarm() { if (globalThis.realAlarms) { alarmCalls++; await super.alarm(); } }
      async openStore() {
        const store = new EthereumRevealStore(this.ctx.storage.sql, action => this.ctx.storage.transactionSync(action), () => 0);
        store.configure(await current(this.env));
        return store;
      }
      async seed(count = 1) {
        const store = await this.openStore();
        while (!store.initializeChunk()) {}
        const sql = this.ctx.storage.sql;
        this.ctx.storage.transactionSync(() => {
          sql.exec("INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,activated_at_ms,seeded,frozen_count) VALUES('native-base',?,?,?,?,0,1,0,?,'complete',1,2,111111,0)",
            'a'.repeat(64), JSON.stringify(descriptor), JSON.stringify(descriptor), JSON.stringify(catalog), 'b'.repeat(64));
          sql.exec("INSERT INTO reveal_catalog_pools(generation,category,total,seeded,available) SELECT 'native-base',category,total,seeded,available FROM pools");
          sql.exec("INSERT INTO reveal_catalog_free(generation,category,slot,origin_category,origin_asset_id,asset_id) SELECT 'native-base',category,slot,category,asset_id,asset_id FROM free_slots");
          sql.exec("UPDATE settings SET active_catalog_generation='native-base',allocation_base_generation='native-base',catalog_revision=1,effective_catalog_version=?,effective_catalog_sha256=? WHERE id=1", descriptor.catalogVersion, descriptor.manifestSha256);
          sql.exec("INSERT INTO crates(crate_token_id) VALUES('111112')");
          for (let slot=0;slot<20;slot++) {
            const origin=store.catalogUpdate.takeFree('egg',slot);
            sql.exec("INSERT INTO assignments(category,asset_id,crate_token_id,slot) VALUES(?,?,'111112',?)", origin.category, origin.assetId, slot);
          }
        });
        store.freeze(await current(this.env), ${JSON.stringify(observation)},
          [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, i) => String(i+1)) }], Date.now());
        for (const row of sql.exec('SELECT token_id,metadata_json FROM assignments').toArray()) {
          await bucket.put(prefix+row.token_id+'.json', row.metadata_json,
            { httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } });
          store.publicationComplete(row.token_id);
        }
        store.catalogUpdate.ownerHatching.prepare({ batchId: 'native-hatch', sourceSha256: 'c'.repeat(64),
          candidateTokenIds: Array.from({ length: count }, (_, i) => String(i+1)), readyCount: count,
          grails: [], freshEggIds: Array.from({ length: count }, (_, i) => 76700-i) });
        if (globalThis.realAlarms) while (store.catalogUpdate.pruneObsolete().remaining) {}
        await this.publish();
        return this.snapshot();
      }
      async publish() {
        const deployment = await current(this.env);
        this.configure(deployment);
        await this.runPublications(deployment);
      }
      async progress(retry) {
        const deployment = await current(this.env);
        this.configure(deployment);
        await this.ownerEnrichmentRun;
        if (retry) this.ctx.storage.sql.exec("UPDATE owner_hatching_enrichment SET next_check_ms=0 WHERE status='pending'");
        await this.startBackground(deployment);
        await this.ownerEnrichmentRun;
        await this.runPublications(deployment);
        return this.snapshot();
      }
      async hatchAll() {
        const deployment = await current(this.env);
        this.configure(deployment);
        for (const tokenId of this.store.catalogUpdate.ownerHatching.readyTokenIds()) {
          if (this.store.catalogUpdate.ownerHatching.hatch(tokenId, Date.now()).kind !== 'hatched') throw new Error('Hatch failed');
        }
        await this.arm();
        return this.snapshot();
      }
      async snapshot() {
        const store = await this.openStore();
        const sql = this.ctx.storage.sql;
        const canonical = store.catalogUpdate.ownerHatching.canonical('1');
        return { bootId, owner: store.catalogUpdate.ownerHatching.enrichmentSummary(), health: store.summary(),
          jobs: sql.exec('SELECT token_id,status,attempts,last_error FROM owner_hatching_enrichment').toArray(),
          canonical: { category: canonical.category, assetId: canonical.assetId, metadataRevision: canonical.metadataRevision },
          publication: sql.exec('SELECT token_id,status,metadata_revision FROM owner_hatching_publication').toArray(),
          sourceRequests, errors, alarmCalls, alarmAt: await this.ctx.storage.getAlarm(), now: Date.now() };
      }
    }
    export default { async fetch(request, bindings) {
      const limiter = { limit: async () => ({ success: true }) };
      const env = { ...bindings, ...constants, PUBLIC_SHOP_RATE_LIMITER: limiter,
        STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter, STAFF_AUTH_SESSION_RATE_LIMITER: limiter };
      bucket = env.ETHEREUM_REVEAL_METADATA;
      const path = new URL(request.url).pathname;
      const object = env.ETHEREUM_REVEAL.getByName(objectName);
      if (path.startsWith('/ethereum/')) return handleEthereumRequest(request, env, path);
      try {
        if (path === '/seed') return Response.json(await object.seed((await request.json()).count));
        if (path === '/hatch-all') return Response.json(await object.hatchAll());
        if (path === '/snapshot') return Response.json(await object.snapshot());
        if (path === '/progress') return Response.json(await object.progress((await request.json()).retry ?? false));
        if (path === '/publish') { await object.publish(); return Response.json({ ok: true }); }
        if (path === '/source') {
          const input = await request.json();
          sourceMode = input.mode;
          holdSource = Boolean(input.hold);
          for (const release of releaseSources) release();
          releaseSources = [];
          return Response.json({ ok: true });
        }
        if (path === '/metadata') {
          const value = await bucket.get(prefix+'1.json');
          return new Response(value.body, { headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(null, { status: 404 });
      } catch (error) { return Response.json({ error: error.message }, { status: 500 }); }
    } };
  `;
  const built = await build({ stdin: { contents: source, resolveDir: resolve('.'), loader: 'ts' }, bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
  const worker = 'native-owner-enrichment';
  const options = (restart = 0, realAlarms = false): MiniflareOptions => ({ workers: [{ config: {
    name: worker, compatibilityDate: '2026-08-08', compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
    manifest: { mainModule: 'owner-enrichment.mjs', modulesRoot: resolve('.'), modules: {
      'owner-enrichment.mjs': { type: 'esm', contents: `globalThis.realAlarms = ${realAlarms};\n${built.outputFiles[0].text}\nvoid ${restart};` },
    } },
    env: {
      OPS_DB: { type: 'd1', name: 'native-owner-enrichment-ops' },
      ETHEREUM_REVEAL_METADATA: { type: 'r2', name: 'native-owner-enrichment-metadata' },
      ETHEREUM_REVEAL: { type: 'durable-object', worker, exportName: 'NativeCoordinator' },
      ETHEREUM_REVEAL_PUBLISHER: { type: 'durable-object', worker, exportName: 'NativePublisher' },
    },
    exports: { NativeCoordinator: { type: 'durable-object', storage: 'sqlite' }, NativePublisher: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  const requestFor = (runtime: Miniflare) => async <T = Snapshot>(path: string, body: unknown = {},
    { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<T> => {
    const response = await runtime.dispatchFetch(`https://native-enrichment.test${path}`, { method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Origin: 'https://vvv.so', 'CF-Connecting-IP': '192.0.2.1', 'X-Mons-CSRF': '1' },
      body: JSON.stringify(body) });
    const value = await response.json() as T & { error?: unknown };
    assert.equal(response.status, 200, JSON.stringify(value.error ?? path));
    return value;
  };
  const initialize = async (runtime: Miniflare) => {
    const db = await runtime.getD1Database('OPS_DB');
    for (const migration of ['0009_ethereum_reveal_deployments', '0011_ethereum_reveal_retirement', '0012_ethereum_reveal_catalog_updates']) {
      const sql = await readFile(resolve(`cloud/workers/api/ops-migrations/${migration}.sql`), 'utf8');
      await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
    }
    await db.prepare(buildEthereumRevealRegistration({ deploymentId, dropId: '111k_devnet', chainId, contractAddress,
      metadataBaseUri, deploymentBlock: 100, catalogVersion: catalog.catalogVersion, templateJson,
      templateSha256: createHash('sha256').update(templateJson).digest('hex') })).run();
    await db.prepare("UPDATE ethereum_reveal_deployments SET state='active',revision=3,provisioned_at_ms=2,activated_at_ms=3,catalog_update_id='native-base',catalog_update_started_at_ms=1 WHERE deployment_id=?")
      .bind(deploymentId).run();
    await db.prepare("UPDATE ethereum_reveal_deployments SET catalog_revision=1,effective_catalog_version=?,effective_catalog_sha256=?,catalog_update_id=NULL,catalog_update_started_at_ms=NULL WHERE deployment_id=?")
      .bind(descriptor.catalogVersion, descriptor.manifestSha256, deploymentId).run();
  };
  for (const [mode, reason] of [['missing', 'invalid'], ['malformed', 'invalid'], ['unavailable', 'source-unavailable']] as const) {
    await t.test(mode, { timeout: 40_000 }, async () => {
      const runtime = new Miniflare(options());
      const request = requestFor(runtime);
      const hatch = () => request<EthereumRevealTokensResponse>(ETHEREUM_OWNER_HATCHING_PATHS.hatch,
        { chainId, contractAddress, tokenId: '1', signature });
      const failed = { pending: 1, failed: 1, completed: 0, errors: { [reason]: 1 } };
      try {
        await initialize(runtime);
        await request('/seed');
        await request('/source', { mode, hold: true });
        const hatched = await hatch();
        assert.equal(hatched.artworks.length, 1);
        assert.deepEqual(hatched.unresolved, []);
        assert.notEqual(hatched.artworks[0].category, 'egg');
        await request('/publish');
        const base = await request<Metadata>('/metadata');
        assert.equal(base.image, hatched.artworks[0].image);
        assert.equal(base.readyToHatch, undefined);
        assert.ok(!base.attributes.some(row => row.trait_type === 'fixture'));
        const blocked = await request('/snapshot');
        assert.equal(blocked.sourceRequests, 1);
        assert.equal(blocked.jobs[0].status, 'pending');
        assert.equal(blocked.publication[0].status, 'published');
        assert.deepEqual(blocked.errors, []);
        const chosen = { category: blocked.canonical.category, assetId: blocked.canonical.assetId };
        await request('/source', { mode });
        let failure = await request('/progress');
        assert.deepEqual(failure.owner, failed);
        assert.deepEqual(failure.health.ownerEnrichment, failed);
        assert.equal(failure.jobs[0].last_error, reason);
        assert.equal(failure.jobs[0].attempts, 1);
        assert.deepEqual(await hatch(), hatched);
        for (const attempt of [2, 3, 4]) {
          failure = await request('/progress', { retry: true });
          assert.equal(failure.jobs[0].attempts, attempt);
          assert.deepEqual(failure.owner, failed);
        }
        assert.deepEqual(failure.errors, [1, 2, 4].map(attempt => [{ event: 'ethereum_owner_hatching_enrichment_error',
          deploymentId, tokenId: '1', attempt, reason }]));
        assert.doesNotMatch(JSON.stringify(failure.errors), /private-source-body|https?:|metadata|signature|stack/);
        await runtime.setOptions(options(1));
        const restarted = await request('/snapshot');
        assert.notEqual(restarted.bootId, failure.bootId);
        assert.deepEqual(restarted.owner, failed);
        assert.deepEqual(restarted.health.ownerEnrichment, failed);
        assert.deepEqual(restarted.jobs, failure.jobs);
        assert.deepEqual(restarted.canonical, failure.canonical);
        await request('/source', { mode: 'valid' });
        const recovered = await request('/progress', { retry: true });
        assert.deepEqual(recovered.owner, { pending: 0, failed: 0, completed: 1, errors: {} });
        assert.deepEqual(recovered.health.ownerEnrichment, recovered.owner);
        assert.equal(recovered.jobs[0].status, 'complete');
        assert.equal(recovered.jobs[0].last_error, null);
        assert.equal(recovered.jobs[0].attempts, 5);
        assert.equal(recovered.publication[0].status, 'published');
        assert.deepEqual({ category: recovered.canonical.category, assetId: recovered.canonical.assetId }, chosen);
        assert.equal(recovered.canonical.metadataRevision, blocked.canonical.metadataRevision + 1);
        const enriched = await request<Metadata>('/metadata');
        assert.equal(enriched.image, base.image);
        assert.ok(enriched.attributes.some(row => row.trait_type === 'fixture' && row.value === 'recovered'));
        assert.deepEqual(recovered.errors, []);
      } finally {
        await request('/source', { mode: 'valid' }).catch(() => undefined);
        await runtime.dispose();
      }
    });
  }
  for (const restart of [false, true]) {
    await t.test(`real alarms drain a saturated enrichment batch after ${restart ? 'restart' : 'completion'}`, { timeout: 150_000 }, async () => {
      const runtime = new Miniflare(options(0, true));
      const request = requestFor(runtime);
      const waitFor = async (predicate: (value: Snapshot) => boolean, timeoutMs = 5_000) => {
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
        await initialize(runtime);
        await request('/seed', { count: 6 }, { timeoutMs: 60_000 });
        await request('/source', { mode: 'valid', hold: true });
        await request('/hatch-all');
        const started = await waitFor(value => value.sourceRequests === 4 && value.publication.every(row => row.status === 'published'));
        assert.equal(started.owner.pending, 6);
        assert.equal(started.jobs.filter(row => row.attempts === 0).length, 2);
        assert.ok(started.alarmCalls >= 1);
        const base = await request<Metadata>('/metadata');
        assert.equal(base.readyToHatch, undefined);
        assert.ok(!base.attributes.some(row => row.trait_type === 'fixture'));
        await new Promise(resolve => setTimeout(resolve, 3_500));
        const blocked = await request('/snapshot');
        assert.ok(blocked.alarmCalls - started.alarmCalls <= 1, `${blocked.alarmCalls - started.alarmCalls} idle alarms while enrichment was busy`);
        assert.equal(blocked.sourceRequests, 4);
        assert.equal(blocked.owner.completed, 0);
        assert.ok(blocked.alarmAt !== null && blocked.alarmAt > blocked.now + 1_000 && blocked.alarmAt <= blocked.now + 60_000,
          JSON.stringify({ startedAt: started.alarmAt, alarmAt: blocked.alarmAt, now: blocked.now, alarmCalls: blocked.alarmCalls }));
        if (restart) {
          await runtime.setOptions(options(1, true));
          const restored = await request('/snapshot');
          assert.notEqual(restored.bootId, blocked.bootId);
          assert.deepEqual(restored.jobs, blocked.jobs);
          assert.equal(restored.alarmAt, blocked.alarmAt);
        } else await request('/source', { mode: 'valid' });
        const completed = await waitFor(value => value.owner.completed === 6 && value.publication.every(row => row.status === 'published'),
          restart ? 70_000 : 5_000);
        assert.deepEqual(completed.owner, { pending: 0, failed: 0, completed: 6, errors: {} });
        assert.equal(completed.sourceRequests, 6);
        assert.equal(completed.jobs.filter(row => row.attempts === (restart ? 2 : 1)).length, restart ? 4 : 6);
        assert.deepEqual(completed.errors, []);
        assert.deepEqual({ category: completed.canonical.category, assetId: completed.canonical.assetId },
          { category: blocked.canonical.category, assetId: blocked.canonical.assetId });
        assert.equal(completed.canonical.metadataRevision, blocked.canonical.metadataRevision + 1);
        const enriched = await request<Metadata>('/metadata');
        assert.equal(enriched.image, base.image);
        assert.ok(enriched.attributes.some(row => row.trait_type === 'fixture' && row.value === 'recovered'));
      } finally {
        await request('/source', { mode: 'valid' }).catch(() => undefined);
        await runtime.dispose();
      }
    });
  }
});
