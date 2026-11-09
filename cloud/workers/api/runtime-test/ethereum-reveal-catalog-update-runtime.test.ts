import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { buildRevealCatalogUpdateBatch } from '../../../../scripts/ethereum-metadata/catalogUpdate.ts';
import { buildEthereumRevealRegistration } from '../../../../scripts/ops/ethereumRevealControl.ts';
import type { EthereumRevealCatalogUpdateResult } from '../../../../shared/ethereum/revealMaintenance.ts';

test('native online catalog update preserves live reads and allocations through staging, activation and publication', { timeout: 120_000 }, async () => {
  const predecessor = getRevealCatalog('111k-v5')!;
  const target = structuredClone(predecessor);
  target.catalogVersion = '111k-v6';
  target.categories.eggs.count -= 2;
  target.categories.videos.count += 2;
  target.categories.videos.aspectRatioIndexById = [...target.categories.videos.aspectRatioIndexById!, 0, 0];
  const batch = buildRevealCatalogUpdateBatch(predecessor, target, () => 0);
  const frozenMapping = batch.mappings.find(row => row.eggId === predecessor.categories.eggs.count)!;
  const freeMapping = batch.mappings.find(row => row.eggId !== frozenMapping.eggId)!;
  const deploymentId = 'native-catalog-update';
  const contractAddress = `0x${'ab'.repeat(20)}`;
  const name = `11155111:${contractAddress}`;
  const metadataBaseUri = `https://cdn.mons.shop/111k-sepolia/${deploymentId}/`;
  const templateJson = JSON.stringify({ name: '{{tokenId}}', description: '111k', image: 'https://cdn.lil.org/nft/111k/placeholder.png',
    attributes: [{ trait_type: 'series', value: '111K' }] });
  const importPath = (path: string) => JSON.stringify(resolve(path));
  const source = `
    import { EthereumRevealObject as Coordinator } from ${importPath('cloud/workers/api/src/ethereumRevealObject.ts')};
    export { EthereumRevealPublisherObject } from ${importPath('cloud/workers/api/src/ethereumRevealPublisherObject.ts')};
    export { EthereumRevealVerifierObject } from ${importPath('cloud/workers/api/src/ethereumRevealVerifierObject.ts')};
    export { EthereumRevealMaintenance } from ${importPath('cloud/workers/api/src/ethereumRevealMaintenance.ts')};
    import { EthereumRevealStore } from ${importPath('cloud/workers/api/src/ethereumRevealStore.ts')};
    import { parseEthereumRevealDeployment } from ${importPath('shared/ethereum/revealDeployment.ts')};
    import { ethereumReveal } from ${importPath('cloud/workers/api/src/ethereumReveal.ts')};
    import { ethereumInventoryItems } from ${importPath('cloud/workers/api/src/ethereumRead.ts')};
    import { ethereumConfig } from ${importPath('cloud/workers/api/src/ethereumRuntime.ts')};
    const constants = { ETHEREUM_111K_CHAIN_ID: '11155111', ETHEREUM_111K_CONTRACT_ADDRESS: ${JSON.stringify(contractAddress)},
      ETHEREUM_111K_METADATA_BASE_URI: ${JSON.stringify(metadataBaseUri)}, ETHEREUM_111K_DEPLOYMENT_BLOCK: '100', ALCHEMY_MI_NOTE_API_KEY: 'local-test' };
    const originalNow = Date.now;
    let offset = 0;
    Date.now = () => originalNow() + offset;
    let bucket;
    let failMirror = false;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'cdn.mons.shop') {
        const object = await bucket.get(url.pathname.slice(1));
        if (!object) return new Response(null, { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        return new Response(object.body, { headers });
      }
      if (url.hostname === 'cdn.lil.org' && url.pathname.includes('/json/v0/')) {
        const id = Number(url.pathname.split('/').at(-1).split('.')[0]);
        return new Response('{"collection block":"native addition","attributes":[{"trait_type":"source ID","value":'+id+
          '},{"trait_type":"big","value":9007199254740993},{"trait_type":"exact","value":1.00}]}',
          { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname.includes('alchemy.com')) {
        const request = JSON.parse(init.body);
        const reply = row => ({ jsonrpc: '2.0', id: row.id, result: row.method === 'eth_chainId' ? '0xaa36a7' :
          row.method === 'eth_getLogs' ? [] : row.method === 'eth_getBlockByNumber' ? { number: '0x3e8', hash: '0x'+'3'.repeat(64) } : null });
        return Response.json(Array.isArray(request) ? request.map(reply) : reply(request));
      }
      throw new Error('Unexpected external fetch in native catalog test: ' + url);
    };
    async function current(env) {
      return parseEthereumRevealDeployment(await env.OPS_DB.prepare('SELECT * FROM ethereum_reveal_deployments WHERE deployment_id=?')
        .bind(${JSON.stringify(deploymentId)}).first());
    }
    export class NativeCoordinator extends Coordinator {
      constructor(ctx, env) {
        const ops = { prepare(sql) {
          const statement = env.OPS_DB.prepare(sql);
          if (!sql.includes('SET effective_catalog_version=')) return statement;
          return { bind(...values) { const bound = statement.bind(...values); return { first: async () => {
            if (failMirror) { failMirror = false; throw new Error('injected registry mirror failure'); }
            return bound.first();
          } }; } };
        } };
        super(ctx, { ...env, ...constants, OPS_DB: ops });
        bucket = env.ETHEREUM_REVEAL_METADATA;
      }
      async alarm() {}
      async clock(ms) { offset += ms; }
      async failNextMirror() { failMirror = true; }
      async seed() {
        const deployment = await current(this.env);
        const sql = this.ctx.storage.sql;
        const store = new EthereumRevealStore(sql, action => this.ctx.storage.transactionSync(action), () => 0);
        store.configure(deployment);
        while (!store.initializeChunk()) {}
        sql.exec("INSERT INTO crates(crate_token_id) VALUES('111112')");
        sql.exec("DELETE FROM free_slots WHERE category='egg' AND slot=?", ${predecessor.categories.eggs.count - 1});
        sql.exec("UPDATE pools SET available=available-1 WHERE category='egg'");
        sql.exec("INSERT INTO assignments(category,asset_id,crate_token_id,slot) VALUES('egg',?,'111112',0)", ${predecessor.categories.eggs.count});
        store.freeze(deployment, { transactionHash: '0x'+'1'.repeat(64), blockHash: '0x'+'2'.repeat(64), blockNumber: 101 },
          [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], Date.now());
        for (const row of sql.exec('SELECT token_id,metadata_json FROM assignments WHERE token_id IS NOT NULL').toArray()) {
          await this.env.ETHEREUM_REVEAL_METADATA.put(${JSON.stringify(`111k-sepolia/${deploymentId}/`)} + row.token_id + '.json', row.metadata_json,
            { httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } });
          store.publicationComplete(row.token_id);
        }
        sql.exec('UPDATE transactions SET next_check_ms=?', Date.now() + 3600000);
        return this.snapshot();
      }
      async snapshot() {
        const sql = this.ctx.storage.sql;
        const store = new EthereumRevealStore(sql, action => this.ctx.storage.transactionSync(action));
        store.configure(await current(this.env));
        const pools = store.catalogUpdate.pools();
        const effective = store.catalogUpdate.effectiveCatalog();
        const assignments = sql.exec('SELECT category,asset_id,token_id,metadata_json FROM assignments ORDER BY CAST(token_id AS INTEGER)').toArray();
        const canonical = store.catalogUpdate.canonicalMetadata(assignments.filter(row => row.token_id).map(row => row.token_id))
          .map(({ tokenId, category, assetId, metadataRevision }) => ({ tokenId, category, assetId, metadataRevision }));
        return { pools, assignments, canonical, effective,
          settings: sql.exec('SELECT * FROM settings WHERE id=1').toArray()[0],
          generationSeeded: store.catalogUpdate.status(${JSON.stringify(batch.batchId)})?.generationSeeded ?? 0,
          free: pools.reduce((total, row) => total + row.available, 0),
          legacyFree: sql.exec('SELECT COUNT(*) AS count FROM free_slots').toArray()[0].count,
          cutoff: effective.generation
            ? sql.exec("SELECT COUNT(*) AS count FROM reveal_catalog_free WHERE generation=? AND category='egg' AND asset_id>?",
                effective.generation, ${target.categories.eggs.count}).toArray()[0].count
            : sql.exec("SELECT COUNT(*) AS count FROM free_slots WHERE category='egg' AND asset_id>?", ${target.categories.eggs.count}).toArray()[0].count,
          deployment: await current(this.env) };
      }
      async ordinaryReveal(firstTokenId, crateTokenId, preferVideo = false, preferEgg = false) {
        const deployment = await current(this.env);
        let draws = 0;
        const store = new EthereumRevealStore(this.ctx.storage.sql, action => this.ctx.storage.transactionSync(action),
          maximum => { const draw = draws++; return draw % 2 === 0
            ? preferVideo ? maximum - 1 : preferEgg ? Math.min(3421, maximum - 1) : 0
            : preferEgg ? Math.min(Math.floor(draw / 2) + 1, maximum - 1) : 0; });
        store.configure(deployment);
        store.freeze(deployment, { transactionHash: '0x'+String(firstTokenId).padStart(64, '0'), blockHash: '0x'+'5'.repeat(64), blockNumber: 102 },
          [{ crateTokenId, tokenIds: Array.from({ length: 20 }, (_, index) => String(index + firstTokenId)) }], Date.now());
        this.ctx.storage.sql.exec('UPDATE transactions SET next_check_ms=?', Date.now() + 3600000);
        return this.snapshot();
      }
      async scheduler() { await super.alarm(); return this.snapshot(); }
    }
    export default { async fetch(request, bindings) {
      const env = { ...bindings, ...constants, PUBLIC_SHOP_RATE_LIMITER: { limit: async () => ({ success: true }) } };
      bucket = env.ETHEREUM_REVEAL_METADATA;
      const path = new URL(request.url).pathname;
      const object = env.ETHEREUM_REVEAL.getByName(${JSON.stringify(name)});
      try {
        if (path === '/seed') return Response.json(await object.seed());
        if (path === '/clock') { await object.clock((await request.json()).ms); return Response.json({ ok: true }); }
        if (path === '/snapshot') return Response.json(await object.snapshot());
        if (path === '/ordinary') { const input = await request.json(); return Response.json(await object.ordinaryReveal(input.firstTokenId, input.crateTokenId, input.preferVideo, input.preferEgg)); }
        if (path === '/fail-mirror') { await object.failNextMirror(); return Response.json({ ok: true }); }
        if (path === '/scheduler') return Response.json(await object.scheduler());
        if (path === '/metadata') { const value = await bucket.get(${JSON.stringify(`111k-sepolia/${deploymentId}/1.json`)});
          return new Response(value.body, { headers: { 'Content-Type': 'application/json' } }); }
        if (path === '/inventory') return Response.json(await ethereumInventoryItems({ env, config: ethereumConfig(env),
          nowMs: Date.now(), signal: AbortSignal.timeout(10000), fetch: globalThis.fetch },
          [{ tokenId: '1', kind: 'artwork', displayId: 1, owner: '0x'+'1'.repeat(40) }]));
        if (path === '/maintenance') return Response.json(await env.MAINTENANCE.catalogUpdate(await request.json()));
        if (path === '/tokens') return Response.json(await ethereumReveal(request, { env, config: ethereumConfig(env),
          nowMs: Date.now(), signal: AbortSignal.timeout(10000), fetch: globalThis.fetch }, '/ethereum/111k/reveal/tokens'));
        return new Response(null, { status: 404 });
      } catch (error) { return Response.json({ error: error.message }, { status: 409 }); }
    } };
  `;
  const catalogs = [batch.predecessor, batch.target];
  const registrySource = `const entries = ${JSON.stringify(catalogs)};
    export function getRevealCatalog(version, hash) { const entry = entries.find(row => row.descriptor.catalogVersion === version);
      return entry && (hash === undefined || hash === entry.descriptor.manifestSha256) ? entry.manifest : undefined; }
    export function getRevealCatalogDescriptor(version) { return entries.find(row => row.descriptor.catalogVersion === version)?.descriptor; }
    export function getSupportedRevealCatalogVersions() { return entries.map(row => row.descriptor.catalogVersion); }`;
  const built = await build({ stdin: { contents: source, resolveDir: resolve('.'), loader: 'ts' }, bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers', 'node:*'],
    plugins: [{ name: 'native-test-catalogs', setup(plugin) {
      plugin.onResolve({ filter: /revealCatalogRegistry\.(?:js|ts)$/ }, () => ({ path: 'catalog-registry', namespace: 'native-test' }));
      plugin.onLoad({ filter: /.*/, namespace: 'native-test' }, () => ({ contents: registrySource, loader: 'js' }));
    } }] });
  const worker = 'native-catalog-update';
  const runtime = new Miniflare({ workers: [{ config: {
    name: worker, compatibilityDate: '2026-08-08', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'catalog-update.mjs', modulesRoot: resolve('.'), modules: {
      'catalog-update.mjs': { type: 'esm', contents: built.outputFiles[0].text },
    } },
    env: {
      OPS_DB: { type: 'd1', name: 'native-catalog-ops' },
      ETHEREUM_REVEAL_METADATA: { type: 'r2', name: 'native-catalog-metadata' },
      ETHEREUM_REVEAL: { type: 'durable-object', worker, exportName: 'NativeCoordinator' },
      ETHEREUM_REVEAL_PUBLISHER: { type: 'durable-object', worker, exportName: 'EthereumRevealPublisherObject' },
      ETHEREUM_REVEAL_VERIFIER: { type: 'durable-object', worker, exportName: 'EthereumRevealVerifierObject' },
      MAINTENANCE: { type: 'worker', worker, exportName: 'EthereumRevealMaintenance' },
    },
    exports: { NativeCoordinator: { type: 'durable-object', storage: 'sqlite' },
      EthereumRevealPublisherObject: { type: 'durable-object', storage: 'sqlite' },
      EthereumRevealVerifierObject: { type: 'durable-object', storage: 'sqlite' }, EthereumRevealMaintenance: { type: 'worker' } },
  } }] });
  const request = async <T>(path: string, body: unknown = {}, expectedStatus = 200): Promise<T> => {
    const response = await runtime.dispatchFetch(`https://native-catalog.test${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://mons.shop', 'CF-Connecting-IP': '127.0.0.1' }, body: JSON.stringify(body) });
    const value = await response.json() as T & { error?: string };
    assert.equal(response.status, expectedStatus, value.error ?? path);
    return value;
  };
  const requestText = async (path: string, body: unknown = {}): Promise<string> => {
    const response = await runtime.dispatchFetch(`https://native-catalog.test${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://mons.shop', 'CF-Connecting-IP': '127.0.0.1' }, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return text;
  };
  type Snapshot = { pools: Array<{ category: string; total: number; available: number }>;
    assignments: Array<{ category: string; asset_id: number; token_id: string; metadata_json: string }>;
    canonical: Array<{ tokenId: string; category: string; assetId: number; metadataRevision: number }>;
    settings: { catalog_revision: number; active_catalog_generation: string | null; candidate_catalog_generation: string | null };
    effective: { catalogRevision: number; catalogVersion: string; generation: string | null };
    generationSeeded: number; free: number; legacyFree: number; cutoff: number;
    deployment: { state: string; catalogRevision: number; catalogVersion: string; effectiveCatalogVersion: string | null; catalogUpdateId: string | null } };
  const operation = { deploymentId, expectedRevision: 3, batchId: batch.batchId };
  const run = (action: string) => request<EthereumRevealCatalogUpdateResult>('/maintenance', { ...operation, action,
    ...(action === 'begin' ? { batch } : {}) });
  try {
    const db = await runtime.getD1Database('OPS_DB');
    for (const name of ['0009_ethereum_reveal_deployments', '0011_ethereum_reveal_retirement', '0012_ethereum_reveal_catalog_updates']) {
      const sql = await readFile(resolve(`cloud/workers/api/ops-migrations/${name}.sql`), 'utf8');
      await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
    }
    await db.prepare(buildEthereumRevealRegistration({ deploymentId, dropId: '111k_devnet', chainId: 11155111,
      contractAddress, metadataBaseUri, deploymentBlock: 100, catalogVersion: '111k-v5', templateJson,
      templateSha256: createHash('sha256').update(templateJson).digest('hex') })).run();
    await db.prepare("UPDATE ethereum_reveal_deployments SET state='active',revision=3,provisioned_at_ms=2,activated_at_ms=3 WHERE deployment_id=?")
      .bind(deploymentId).run();
    const initial = await request<Snapshot>('/seed');
    assert.equal(initial.assignments.find(row => row.token_id === '1')!.asset_id, frozenMapping.eggId);
    const tokenBody = { chainId: 11155111, contractAddress, tokenIds: ['1'] };
    const oldTokens = await request<{ catalogRevision: number; artworks: Array<{ category: string }> }>('/tokens', tokenBody);
    assert.equal(oldTokens.catalogRevision, 0);
    assert.equal(oldTokens.artworks[0].category, 'egg');
    assert.equal((await run('begin')).phase, 'staging');
    assert.equal((await request<Snapshot>('/snapshot')).deployment.state, 'active');
    await run('advance');
    const firstLiveReveal = await request<Snapshot>('/ordinary', { firstTokenId: 21, crateTokenId: '111113' });
    assert.equal(firstLiveReveal.assignments.length, 40);
    assert.equal(firstLiveReveal.free + firstLiveReveal.assignments.length, 111111);
    assert.equal((await request<{ artworks: unknown[] }>('/tokens', { ...tokenBody, tokenIds: ['21'] })).artworks.length, 1);
    await runtime.unsafeEvictDurableObject(worker, 'NativeCoordinator', { name });
    let result: EthereumRevealCatalogUpdateResult | undefined;
    for (let attempts = 0; attempts < 500; attempts++) {
      result = await run('advance');
      if (attempts === 100) await request('/ordinary', { firstTokenId: 41, crateTokenId: '111114', preferEgg: true });
      if (attempts % 40 === 0) {
        const live = await request<Snapshot>('/snapshot');
        assert.equal(live.deployment.state, 'active');
        assert.equal(live.free + live.assignments.length, 111111);
        const reading = await request<{ catalogRevision: number; artworks: Array<{ category: string }> }>('/tokens', tokenBody);
        assert.equal(reading.catalogRevision, 0);
        assert.equal(reading.artworks[0].category, 'egg');
      }
      if (result.phase === 'activating') break;
    }
    assert.equal(result?.phase, 'activating');
    const beforeActivation = await request<Snapshot>('/snapshot');
    assert.equal(beforeActivation.generationSeeded, 111111);
    assert.equal(beforeActivation.assignments.length, 60);
    await request('/fail-mirror');
    const failed = await request<{ error: string }>('/maintenance', { ...operation, action: 'advance' }, 409);
    assert.match(failed.error, /mirror failure/);
    const activated = await request<Snapshot>('/snapshot');
    assert.equal(activated.deployment.state, 'active');
    assert.equal(activated.deployment.catalogRevision, 0);
    assert.equal(activated.effective.catalogRevision, 1);
    assert.equal(activated.effective.catalogVersion, '111k-v6');
    assert.deepEqual(activated.assignments, beforeActivation.assignments);
    assert.equal(activated.cutoff, 0);
    assert.equal(activated.free + activated.assignments.length, 111111);
    assert.equal(activated.pools.reduce((sum, row) => sum + row.total, 0), 111111);
    const tokens = await request<{ catalogRevision: number; artworks: Array<{ category: string; image: string; metadataRevision: number }> }>('/tokens', tokenBody);
    assert.equal(tokens.catalogRevision, 1);
    assert.equal(tokens.artworks[0].category, 'video');
    assert.equal(tokens.artworks[0].image, `https://cdn.lil.org/nft/111k/videos/${frozenMapping.assetId}.webp`);
    assert.equal(tokens.artworks[0].metadataRevision, 2);
    const inventoryText = await requestText('/inventory');
    assert.match(inventoryText, /"trait_type":"big","value":9007199254740993/);
    assert.match(inventoryText, /"trait_type":"exact","value":1\.00/);
    assert.equal((await request<{ category: string }>('/metadata')).category, 'egg');
    for (let attempts = 0; attempts < 20; attempts++) {
      result = await run('advance');
      if (result.phase === 'observing') break;
    }
    assert.equal(result?.phase, 'observing');
    assert.equal(result?.frozen, 1);
    assert.equal(result?.published, 1);
    const migrated = await request<Snapshot>('/snapshot');
    assert.equal(migrated.deployment.catalogVersion, '111k-v5');
    assert.equal(migrated.deployment.effectiveCatalogVersion, '111k-v6');
    assert.equal(migrated.deployment.catalogRevision, 1);
    assert.equal(migrated.deployment.state, 'active');
    assert.deepEqual(migrated.assignments, beforeActivation.assignments);
    const metadata = await request<{ category: string; attributes: Array<{ trait_type: string; value: unknown }> }>('/metadata');
    assert.equal(metadata.category, 'video');
    assert.ok(metadata.attributes.some(row => row.trait_type === 'collection block' && row.value === 'native addition'));
    assert.ok(metadata.attributes.some(row => row.trait_type === 'source ID' && row.value === frozenMapping.assetId));
    const publishedText = await requestText('/metadata');
    assert.match(publishedText, /"trait_type":"big","value":9007199254740993/);
    assert.match(publishedText, /"trait_type":"exact","value":1\.00/);
    assert.equal((await run('advance')).complete, false);
    await request('/clock', { ms: 300_001 });
    for (let attempts = 0; attempts < 500; attempts++) {
      result = await run('advance');
      if (result.complete) break;
    }
    assert.equal(result?.complete, true);
    assert.equal((await run('verify')).nextVerificationEggId, null);
    const cleaned = await request<Snapshot>('/snapshot');
    assert.equal(cleaned.legacyFree, 0);
    assert.equal(cleaned.deployment.catalogUpdateId, null);
    const ordinary = await request<Snapshot>('/ordinary', { firstTokenId: 61, crateTokenId: '111115', preferVideo: true });
    assert.equal(ordinary.canonical.find(row => row.tokenId === '61')!.category, 'video');
    assert.equal(ordinary.canonical.find(row => row.tokenId === '61')!.assetId, freeMapping.assetId);
    assert.equal(ordinary.assignments.find(row => row.token_id === '61')!.category, 'egg');
    assert.equal(ordinary.assignments.find(row => row.token_id === '61')!.asset_id, freeMapping.eggId);
    assert.equal(ordinary.cutoff, 0);
    assert.ok(ordinary.canonical.filter(row => row.category === 'egg').every(row => row.assetId <= target.categories.eggs.count));
    assert.equal(ordinary.free + ordinary.assignments.length, 111111);
    const newlyRevealed = await request<{ catalogRevision: number; artworks: Array<{ image: string }> }>('/tokens', { ...tokenBody, tokenIds: ['61'] });
    assert.equal(newlyRevealed.catalogRevision, 1);
    assert.equal(newlyRevealed.artworks[0].image, `https://cdn.lil.org/nft/111k/videos/${freeMapping.assetId}.webp`);
    assert.equal(getRevealCatalog('111k-v6'), undefined);
  } finally { await runtime.dispose(); }
});
