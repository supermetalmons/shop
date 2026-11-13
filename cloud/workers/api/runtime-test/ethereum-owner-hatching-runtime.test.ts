import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { ethereumSignerAddress, personalMessageHash, signDigest } from '../../../../shared/ethereum/crypto.ts';
import { ETHEREUM_OWNER_HATCHING_MESSAGE, ETHEREUM_OWNER_HATCHING_PATHS, type EthereumOwnerHatchingReadyResponse } from '../../../../shared/ethereum/ownerHatching.ts';
import { ETHEREUM_REVEAL_PATHS, type EthereumRevealTokensResponse } from '../../../../shared/ethereum/reveal.ts';
import { buildEthereumRevealRegistration } from '../../../../scripts/ops/ethereumRevealControl.ts';

test('native owner hatching shares crate inventory, preserves provenance, and publishes resumable metadata without leaking assignments', { timeout: 60_000 }, async () => {
  const catalog = getRevealCatalog('111k-v9')!;
  const descriptor = getRevealCatalogDescriptor('111k-v9')!;
  const deploymentId = 'native-owner-hatching';
  const contractAddress = `0x${'ab'.repeat(20)}`;
  const chainId = 31337;
  const name = `${chainId}:${contractAddress}`;
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
    import { EthereumRevealCatalogUpdateStore } from ${importPath('cloud/workers/api/src/ethereumRevealCatalogUpdateStore.ts')};
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
    const objectName = ${JSON.stringify(name)};
    let bucket;
    let publicationFailure = false;
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
        return Response.json({ attributes: [{ trait_type: 'fixture', value: 'native owner hatch' }] });
      }
      throw new Error('Unexpected external fetch '+url);
    };
    async function current(env) {
      return parseEthereumRevealDeployment(await env.OPS_DB.prepare('SELECT * FROM ethereum_reveal_deployments WHERE deployment_id=?')
        .bind(${JSON.stringify(deploymentId)}).first());
    }
    export class NativePublisher extends Publisher {
      constructor(ctx, env) {
        const metadata = {
          get: (...args) => env.ETHEREUM_REVEAL_METADATA.get(...args),
          put: (...args) => { if (publicationFailure) throw new Error('Injected metadata write failure'); return env.ETHEREUM_REVEAL_METADATA.put(...args); },
        };
        super(ctx, { ...env, ETHEREUM_REVEAL_METADATA: metadata });
      }
      async failWrites(value) { publicationFailure = value; }
    }
    export class NativeCoordinator extends Coordinator {
      savedReadyJobs = [];
      constructor(ctx, env) { super(ctx, { ...env, ...constants }); bucket = env.ETHEREUM_REVEAL_METADATA; }
      async alarm() {}
      async startBackground() {}
      async openStore(random = () => 0) {
        const store = new EthereumRevealStore(this.ctx.storage.sql, action => this.ctx.storage.transactionSync(action), random);
        store.configure(await current(this.env));
        return store;
      }
      async seed() {
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
          for (let slot=0;slot<2;slot++) {
            const origin=store.catalogUpdate.takeFree('egg',slot);
            sql.exec("INSERT INTO assignments(category,asset_id,crate_token_id,slot) VALUES(?,?,'111112',?)", origin.category, origin.assetId, slot);
          }
        });
        const deployment = await current(this.env);
        store.freeze(deployment, ${JSON.stringify(observation)},
          [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, i) => String(i+1)) }], Date.now());
        for (const row of sql.exec('SELECT token_id,metadata_json FROM assignments').toArray()) {
          await bucket.put(prefix+row.token_id+'.json', row.metadata_json, { httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } });
          store.publicationComplete(row.token_id);
        }
        return this.snapshot();
      }
      async prepare() {
        const store = await this.openStore();
        const result = store.catalogUpdate.ownerHatching.prepare({ batchId: 'native-hatch', sourceSha256: 'c'.repeat(64),
          candidateTokenIds: ['1','2'], readyCount: 2, grails: [{ category: 'animated', assetId: 422,
            attributesJson: '[{"trait_type":"collection block","value":"DROWEE"}]' }], freshEggIds: [76700] });
        return { result, fixtureTokens: this.ctx.storage.sql.exec('SELECT token_id,grail_asset_id FROM owner_hatching_tokens ORDER BY token_id').toArray() };
      }
      async oldPublicationFailure() {
        const store=await this.openStore();
        store.publicationFailed('1',Date.now(),1);
      }
      async snapshot() {
        const store = await this.openStore();
        const sql=this.ctx.storage.sql;
        const ids=sql.exec('SELECT token_id FROM assignments WHERE token_id IS NOT NULL ORDER BY CAST(token_id AS INTEGER)').toArray().map(row=>row.token_id);
        return { pools: store.catalogUpdate.pools(), health:store.publicationError(),
          canonical: store.catalogUpdate.canonicalMetadata(ids).map(({tokenId,category,assetId,artwork,metadataRevision})=>({tokenId,category,assetId,artwork,metadataRevision})),
          free: sql.exec("SELECT COUNT(*) AS n FROM reveal_catalog_free WHERE generation='native-base'").toArray()[0].n,
          claimsFree: sql.exec("SELECT COUNT(*) AS n FROM reveal_catalog_free f JOIN owner_hatching_artwork_claims c ON c.category=f.category AND c.asset_id=f.asset_id WHERE f.generation='native-base'").toArray()[0].n,
          fresh: sql.exec("SELECT category,asset_id,origin_category,origin_asset_id FROM reveal_catalog_free WHERE generation='native-base' AND category='egg' AND asset_id=76700").toArray(),
          status: store.catalogUpdate.ownerHatching.batchStatus(),
          immutable: sql.exec("SELECT token_id,category,asset_id,artwork_json FROM assignments WHERE token_id IN ('1','2') ORDER BY token_id").toArray() };
      }
      async readOnlySnapshot() {
        const sql=this.ctx.storage.sql;
        const changes=sql.exec('SELECT total_changes() AS n').toArray()[0].n;
        const store=new EthereumRevealCatalogUpdateStore(sql,()=>{throw new Error('Read-only inspection must not mutate');});
        const canonical=store.canonicalMetadata(['1','2','41']).map(({tokenId,category,assetId})=>({tokenId,category,assetId}));
        return {canonical,changes:sql.exec('SELECT total_changes() AS n').toArray()[0].n-changes};
      }
      async freeze(firstTokenId, fresh = false) {
        const sql=this.ctx.storage.sql;
        const base=await this.openStore();
        const pools=base.catalogUpdate.pools();
        const eggOffset=pools.slice(0,pools.findIndex(pool=>pool.category==='egg')).reduce((sum,pool)=>sum+pool.total,0);
        const freshSlot=fresh ? sql.exec("SELECT slot FROM reveal_catalog_free WHERE generation='native-base' AND category='egg' AND asset_id=76700").toArray()[0].slot : 0;
        let draws=0;
        const store=await this.openStore(maximum=>{ const n=draws++; return fresh && n===0 ? eggOffset : fresh && n===1 ? freshSlot : 0; });
        store.freeze(await current(this.env), { transactionHash:'0x'+String(firstTokenId).padStart(64,'0'),blockHash:'0x'+'e'.repeat(64),blockNumber:102 },
          [{crateTokenId:String(111112+(firstTokenId-1)/20),tokenIds:Array.from({length:20},(_,i)=>String(firstTokenId+i))}],Date.now());
        return this.snapshot();
      }
      async saveReadyJobs() {
        const store=await this.openStore();
        this.savedReadyJobs=store.claimPublications(Date.now(),2);
        return this.savedReadyJobs.length;
      }
      async publish(saved = false) {
        const store=await this.openStore();
        const jobs=saved ? this.savedReadyJobs : store.claimPublications(Date.now()+120000,2);
        const deployment=await current(this.env);
        const outcomes=await this.env.ETHEREUM_REVEAL_PUBLISHER.getByName(objectName).publishBatch(deployment,jobs,Date.now()+10000);
        store.completePublications(jobs.map(job=>({job,status:outcomes.find(row=>row.tokenId===job.token_id).status})),Date.now());
        return outcomes;
      }
    }
    export default { async fetch(request, bindings) {
      const limiter={limit:async()=>({success:true})};
      const env={...bindings,...constants,PUBLIC_SHOP_RATE_LIMITER:limiter,STAFF_AUTH_CHALLENGE_RATE_LIMITER:limiter,STAFF_AUTH_SESSION_RATE_LIMITER:limiter};
      bucket=env.ETHEREUM_REVEAL_METADATA;
      const path=new URL(request.url).pathname;
      const object=env.ETHEREUM_REVEAL.getByName(objectName);
      if(path.startsWith('/ethereum/')) return handleEthereumRequest(request,env,path);
      try {
        if(path==='/seed') return Response.json(await object.seed());
        if(path==='/prepare') return Response.json(await object.prepare());
        if(path==='/old-failure') { await object.oldPublicationFailure(); return Response.json({ok:true}); }
        if(path==='/snapshot') return Response.json(await object.snapshot());
        if(path==='/read-only') return Response.json(await object.readOnlySnapshot());
        if(path==='/save-ready') return Response.json(await object.saveReadyJobs());
        if(path==='/publish') return Response.json(await object.publish((await request.json()).saved??false));
        if(path==='/failure') { await env.ETHEREUM_REVEAL_PUBLISHER.getByName(objectName).failWrites((await request.json()).enabled); return Response.json({ok:true}); }
        if(path==='/freeze') { const input=await request.json(); return Response.json(await object.freeze(input.firstTokenId,input.fresh)); }
        if(path==='/metadata') { const input=await request.json(); const value=await bucket.get(prefix+input.tokenId+'.json'); return new Response(value.body,{headers:{'Content-Type':'application/json'}}); }
        return new Response(null,{status:404});
      } catch(error) { return Response.json({error:error.message},{status:500}); }
    } };
  `;
  const built = await build({ stdin: { contents: source, resolveDir: resolve('.'), loader: 'ts' }, bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
  const worker = 'native-owner-hatching';
  const runtime = new Miniflare({ workers: [{ config: {
    name: worker, compatibilityDate: '2026-08-08', compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
    manifest: { mainModule: 'owner-hatching.mjs', modulesRoot: resolve('.'), modules: {
      'owner-hatching.mjs': { type: 'esm', contents: built.outputFiles[0].text },
    } },
    env: {
      OPS_DB: { type: 'd1', name: 'native-owner-hatching-ops' },
      ETHEREUM_REVEAL_METADATA: { type: 'r2', name: 'native-owner-hatching-metadata' },
      ETHEREUM_REVEAL: { type: 'durable-object', worker, exportName: 'NativeCoordinator' },
      ETHEREUM_REVEAL_PUBLISHER: { type: 'durable-object', worker, exportName: 'NativePublisher' },
    },
    exports: { NativeCoordinator: { type: 'durable-object', storage: 'sqlite' }, NativePublisher: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  type Snapshot = { pools: Array<{ category: string; total: number; seeded: number; available: number }>; free: number; claimsFree: number;
    canonical: Array<{ tokenId: string; category: string; assetId: number; metadataRevision: number; artwork: EthereumRevealTokensResponse['artworks'][number] }>;
    fresh: Array<{ asset_id: number }>; status: { ready: number; hatched: number; pendingPublication: number; published: number } | null;
    immutable: unknown[]; health: string | null };
  const request = async <T>(path: string, body: unknown = {}, expectedStatus = 200): Promise<T> => {
    const method = path.startsWith(ETHEREUM_OWNER_HATCHING_PATHS.ready) ? 'GET' : 'POST';
    const response = await runtime.dispatchFetch(`https://native-hatching.test${path}`, { method,
      headers: { 'Content-Type': 'application/json', Origin: 'https://vvv.so', 'CF-Connecting-IP': '192.0.2.1', 'X-Mons-CSRF': '1' },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json() as T & { error?: unknown };
    assert.equal(response.status, expectedStatus, JSON.stringify(value.error ?? path));
    return value;
  };
  const ready = () => request<EthereumOwnerHatchingReadyResponse>(`${ETHEREUM_OWNER_HATCHING_PATHS.ready}?chainId=${chainId}&contractAddress=${contractAddress}`);
  const hatch = (tokenId: string) => request<EthereumRevealTokensResponse>(ETHEREUM_OWNER_HATCHING_PATHS.hatch,
    { chainId, contractAddress, tokenId, signature });
  const checkConservation = (snapshot: Snapshot, assigned: number) => {
    assert.equal(snapshot.pools.reduce((sum, row) => sum + row.total, 0), 111111);
    assert.equal(snapshot.pools.reduce((sum, row) => sum + row.available, 0), 111111 - assigned);
    assert.equal(snapshot.free, 111111 - assigned);
    assert.equal(snapshot.claimsFree, 0);
    const identities = snapshot.canonical.map(row => `${row.category}:${row.assetId}`);
    assert.equal(new Set(identities).size, assigned);
  };
  try {
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
    const initial = await request<Snapshot>('/seed');
    checkConservation(initial, 20);
    assert.deepEqual(initial.canonical.slice(0, 2).map(row => row.category), ['egg', 'egg']);
    await request('/old-failure');
    const prepared = await request<{ result: { ready: number }; fixtureTokens: Array<{ token_id: string; grail_asset_id: number | null }> }>('/prepare');
    assert.equal(prepared.result.ready, 2);
    assert.deepEqual(await request('/prepare'), prepared);
    assert.deepEqual((await ready()).tokenIds, ['1', '2']);
    const readyArtwork = await request<EthereumRevealTokensResponse>(ETHEREUM_REVEAL_PATHS.tokens, { chainId, contractAddress, tokenIds: ['1', '2'] });
    assert.ok(readyArtwork.artworks.every(artwork => artwork.category === 'egg' && artwork.readyToHatch === true));
    assert.doesNotMatch(JSON.stringify(readyArtwork), /grail|sourceSha256|native-hatch|animated\/422/);
    assert.equal(await request('/save-ready'), 2);
    const readyPublished = await request<Array<{ status: string }>>('/publish', { saved: true });
    assert.ok(readyPublished.every(row => row.status === 'published'));
    assert.equal((await request<Snapshot>('/snapshot')).health, null);
    for (const tokenId of ['1', '2']) assert.equal((await request<{ readyToHatch: boolean }>('/metadata', { tokenId })).readyToHatch, true);
    const grailId = prepared.fixtureTokens.find(row => row.grail_asset_id !== null)!.token_id;
    const ordinaryId = prepared.fixtureTokens.find(row => row.grail_asset_id === null)!.token_id;
    const [grail, ordinary, duplicate] = await Promise.all([hatch(grailId), hatch(ordinaryId), hatch(ordinaryId), request('/freeze', { firstTokenId: 21 })]);
    assert.deepEqual(duplicate, ordinary);
    assert.equal(grail.artworks[0].animation_url, 'https://cdn.lil.org/nft/111k/animated/422.gif');
    assert.equal(grail.artworks[0].collectionBlock, 'DROWEE');
    assert.notEqual(ordinary.artworks[0].category, 'egg');
    for (const result of [grail, ordinary]) {
      assert.equal(result.artworks.length, 1);
      assert.equal(result.artworks[0].crateTokenId, '111112');
      assert.deepEqual(result.artworks[0].observation, observation);
      assert.equal(result.artworks[0].readyToHatch, undefined);
      assert.deepEqual(result.unresolved, []);
    }
    assert.deepEqual((await ready()).tokenIds, []);
    assert.deepEqual(await hatch(grailId), grail);
    assert.deepEqual(await hatch(ordinaryId), ordinary);
    const unpack = await request<{ artworks: EthereumRevealTokensResponse['artworks'] }>(ETHEREUM_REVEAL_PATHS.transaction,
      { chainId, contractAddress, transactionHash: observation.transactionHash });
    for (const result of [grail, ordinary]) {
      const recovered = unpack.artworks.find(artwork => artwork.tokenId === result.artworks[0].tokenId)!;
      assert.equal(recovered.image, result.artworks[0].image);
      assert.equal(recovered.metadataRevision, result.artworks[0].metadataRevision);
    }
    const after = await request<Snapshot>('/snapshot');
    checkConservation(after, 40);
    assert.deepEqual(after.immutable, initial.immutable);
    assert.equal(after.status!.hatched, 2);
    assert.equal(after.fresh.length, 1);
    await request('/failure', { enabled: true });
    assert.ok((await request<Array<{ status: string }>>('/publish')).every(row => row.status === 'retry'));
    assert.equal((await request<Snapshot>('/snapshot')).status!.pendingPublication, 2);
    await request('/failure', { enabled: false });
    assert.ok((await request<Array<{ status: string }>>('/publish')).every(row => row.status === 'published'));
    for (const result of [grail, ordinary]) {
      const metadata = await request<{ image: string; readyToHatch?: boolean }>('/metadata', { tokenId: result.artworks[0].tokenId });
      assert.equal(metadata.image, result.artworks[0].image);
      assert.equal(metadata.readyToHatch, undefined);
    }
    assert.ok((await request<Array<{ status: string }>>('/publish', { saved: true })).every(row => row.status === 'superseded'));
    assert.equal((await request<Snapshot>('/snapshot')).status!.published, 2);
    const final = await request<Snapshot>('/freeze', { firstTokenId: 41, fresh: true });
    checkConservation(final, 60);
    assert.equal(final.fresh.length, 0);
    const fresh = final.canonical.find(row => row.tokenId === '41')!;
    assert.equal(fresh.category, 'egg');
    assert.equal(fresh.assetId, 76700);
    assert.equal(fresh.artwork.image, 'https://cdn.lil.org/nft/111k/eggs/76700.png');
    assert.equal(fresh.artwork.readyToHatch, undefined);
    const inspected = await request<{ canonical: Array<{ tokenId: string; category: string; assetId: number }>; changes: number }>('/read-only');
    assert.equal(inspected.changes, 0);
    assert.deepEqual(inspected.canonical.find(row => row.tokenId === '41'), { tokenId: '41', category: 'egg', assetId: 76700 });
    const finalPublic = await request<EthereumRevealTokensResponse>(ETHEREUM_REVEAL_PATHS.tokens, { chainId, contractAddress, tokenIds: ['1', '2', '41'] });
    assert.equal(new Set(finalPublic.artworks.map(artwork => artwork.image)).size, 3);
    assert.doesNotMatch(JSON.stringify(finalPublic), /grail_asset_id|freshEgg|owner_hatching|sourceSha256/);
  } finally { await runtime.dispose(); }
});
