import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { buildEthereumRevealRegistration } from '../../../../scripts/ops/ethereumRevealControl.ts';
import { ownerHatchingCatalogSha256 } from '../../../../shared/ethereum/ownerHatchingCatalog.ts';
import supplement from '../../../../shared/ethereum/ownerHatchingCatalog.json';
import type { OwnerHatchingMaintenanceRequest, OwnerHatchingMaintenanceResult } from '../../../../shared/ethereum/ownerHatchingMaintenance.ts';
import { getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.ts';

test('native coordinator resumes the frozen owner hatching revision after an explicit registry pause and resume', { timeout: 60_000 }, async () => {
  const deploymentId = 'native-owner-hatching-revision';
  const contractAddress = `0x${'ac'.repeat(20)}`;
  const metadataBaseUri = `https://cdn.mons.shop/111k/${deploymentId}/`;
  const templateJson = JSON.stringify({ name: '{{tokenId}}', description: '111k', image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] });
  const descriptor = getRevealCatalogDescriptor('111k-v9')!;
  const identity = { deploymentId, batchId: 'native-revision-hatch', expectedRevision: 9 };
  const begin: OwnerHatchingMaintenanceRequest = { ...identity, action: 'begin', sourceSha256: supplement.batches[0].source.sha256,
    catalogSha256: ownerHatchingCatalogSha256, readyCount: 2, grailIds: [422], freshEggIds: [76700] };
  const path = (value: string) => JSON.stringify(resolve(value));
  const source = `
    import { EthereumRevealObject } from ${path('cloud/workers/api/src/ethereumRevealObject.ts')};
    import { EthereumRevealStore } from ${path('cloud/workers/api/src/ethereumRevealStore.ts')};
    import { getRevealCatalog,getRevealCatalogDescriptor } from ${path('shared/ethereum/revealCatalogRegistry.ts')};
    import { parseEthereumRevealDeployment } from ${path('shared/ethereum/revealDeployment.ts')};
    import { encodeAbi,encodeCall,decodeReturn } from ${path('shared/ethereum/abi.ts')};
    import { ETHEREUM_FUNCTIONS } from ${path('shared/ethereum/protocol.ts')};
    const deploymentId=${JSON.stringify(deploymentId)};
    const objectName=${JSON.stringify(`1:${contractAddress}`)};
    const catalog=getRevealCatalog('111k-v9');
    const descriptor=getRevealCatalogDescriptor('111k-v9');
    let now=1000000;
    Date.now=()=>now;
    globalThis.fetch=async(input,init)=>{
      if(String(input).startsWith('https://cdn.lil.org/'))return Response.json({'collection block':'DROWEE',attributes:[]});
      const payload=JSON.parse(init.body);
      const respond=row=>{
        let result;
        if(row.method==='eth_chainId')result='0x1';
        else if(row.method==='eth_getBlockByNumber')result={number:'0x1f4',hash:'0x'+'a'.repeat(64)};
        else if(row.method==='eth_call'){
          const data=row.params[0].data;
          if(data.slice(0,10)===encodeCall(ETHEREUM_FUNCTIONS.stats,[],[]))result=encodeAbi(
            ['uint256','uint256','uint256','uint256','uint256','bool','bytes32','uint256','uint256','uint256','uint256','uint256','uint256','uint256','uint256'],
            [1,0,20,1,1,true,'0x'+'0'.repeat(64),1,1,0,0,0,0,0,0]);
          else {const [ids]=decodeReturn(['uint256[]'],'0x'+data.slice(10));
            result=encodeAbi(['(uint8,uint256,address)[]'],[ids.map(id=>[1,id,'0x'+'2'.repeat(40)])]);}
        }else throw new Error('Unexpected fixture RPC '+row.method);
        return {jsonrpc:'2.0',id:row.id,result};
      };
      return Response.json(Array.isArray(payload)?payload.map(respond):respond(payload));
    };
    async function current(env){
      return parseEthereumRevealDeployment(await env.OPS_DB.prepare('SELECT * FROM ethereum_reveal_deployments WHERE deployment_id=?')
        .bind(deploymentId).first());
    }
    export class Coordinator extends EthereumRevealObject {
      constructor(ctx,env){super(ctx,{...env,ALCHEMY_MI_NOTE_API_KEY:'fixture',ETHEREUM_PROVIDER_CONTROL_ENABLED:'false'});}
      async alarm(){}
      async startBackground(){}
      async openStore(){
        const store=new EthereumRevealStore(this.ctx.storage.sql,action=>this.ctx.storage.transactionSync(action),()=>0);
        store.configure(await current(this.env));
        return store;
      }
      async seed(){
        const store=await this.openStore();
        while(!store.initializeChunk()){}
        const sql=this.ctx.storage.sql;
        this.ctx.storage.transactionSync(()=>{
          sql.exec("INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,activated_at_ms,seeded,frozen_count) VALUES('revision-base',?,?,?,?,0,1,0,?,'complete',1,2,111111,0)",
            'a'.repeat(64),JSON.stringify(descriptor),JSON.stringify(descriptor),JSON.stringify(catalog),'b'.repeat(64));
          sql.exec("INSERT INTO reveal_catalog_pools(generation,category,total,seeded,available) SELECT 'revision-base',category,total,seeded,available FROM pools");
          sql.exec("INSERT INTO reveal_catalog_free(generation,category,slot,origin_category,origin_asset_id,asset_id) SELECT 'revision-base',category,slot,category,asset_id,asset_id FROM free_slots");
          sql.exec("UPDATE settings SET active_catalog_generation='revision-base',allocation_base_generation='revision-base',catalog_revision=1,effective_catalog_version=?,effective_catalog_sha256=? WHERE id=1",descriptor.catalogVersion,descriptor.manifestSha256);
          sql.exec("INSERT INTO crates(crate_token_id) VALUES('111112')");
          for(let slot=0;slot<2;slot++){
            const origin=store.catalogUpdate.takeFree('egg',slot);
            sql.exec("INSERT INTO assignments(category,asset_id,crate_token_id,slot) VALUES(?,?,'111112',?)",origin.category,origin.assetId,slot);
          }
        });
        store.freeze(await current(this.env),{transactionHash:'0x'+'3'.repeat(64),blockHash:'0x'+'4'.repeat(64),blockNumber:101},
          [{crateTokenId:'111112',tokenIds:Array.from({length:20},(_,i)=>String(i+1))}],now);
        return {ready:store.ready()};
      }
      async publish(){
        const store=await this.openStore();
        const owner=store.catalogUpdate.ownerHatching;
        const jobs=owner.claimPublications(now,8);
        for(const job of jobs)await this.env.ETHEREUM_REVEAL_METADATA.put(
          new URL(${JSON.stringify(metadataBaseUri)}+job.token_id+'.json').pathname.slice(1),job.metadata_json,
          {httpMetadata:{contentType:'application/json; charset=utf-8',cacheControl:'no-store'}});
        owner.completePublications(jobs.map(job=>({job,status:'published'})),now);
        return {published:jobs.length};
      }
      async clock(){now+=300000;return {now};}
      async evidence(){
        const sql=this.ctx.storage.sql;
        const row=sql.exec('SELECT request_json,verification_passes FROM owner_hatching_preparations').one();
        return {expectedRevision:JSON.parse(row.request_json).expectedRevision,passes:row.verification_passes,
          preparations:sql.exec('SELECT COUNT(*) AS n FROM owner_hatching_preparations').one().n,
          candidates:sql.exec('SELECT COUNT(*) AS n FROM owner_hatching_candidates').one().n,
          traits:sql.exec('SELECT COUNT(*) AS n FROM owner_hatching_trait_staging').one().n};
      }
    }
    export default {async fetch(request,env){
      const object=env.ETHEREUM_REVEAL.getByName(objectName);
      const action=new URL(request.url).pathname;
      try {
        if(action==='/seed')return Response.json(await object.seed());
        if(action==='/publish')return Response.json(await object.publish());
        if(action==='/clock')return Response.json(await object.clock());
        if(action==='/evidence')return Response.json(await object.evidence());
        return Response.json(await object.ownerHatchingOperation(await current(env),await request.json()));
      }catch(error){return Response.json({error:error.message},{status:409});}
    }};
  `;
  const bundle = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'owner-hatching-revision-native.ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
  const worker = 'owner-hatching-revision-native';
  const runtime = new Miniflare({ workers: [{ config: { name: worker, compatibilityDate: '2026-08-08', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'worker.mjs', modulesRoot: resolve('.'), modules: { 'worker.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    env: { OPS_DB: { type: 'd1', name: 'owner-hatching-revision-ops' },
      ETHEREUM_REVEAL: { type: 'durable-object', worker, exportName: 'Coordinator' },
      ETHEREUM_REVEAL_METADATA: { type: 'r2', name: 'owner-hatching-revision-metadata' } },
    exports: { Coordinator: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  const request = async <T>(path: string, body: unknown = {}, status = 200): Promise<T> => {
    const response = await runtime.dispatchFetch(`https://owner-revision.test${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json() as T & { error?: string };
    assert.equal(response.status, status, value.error ?? path);
    return value;
  };
  const run = (action: OwnerHatchingMaintenanceRequest['action'], expectedRevision = identity.expectedRevision) =>
    request<OwnerHatchingMaintenanceResult>('/operation', action === 'begin' ? { ...begin, expectedRevision } : { ...identity, action, expectedRevision });
  try {
    const db = await runtime.getD1Database('OPS_DB');
    for (const migration of ['0009_ethereum_reveal_deployments', '0011_ethereum_reveal_retirement', '0012_ethereum_reveal_catalog_updates']) {
      const sql = await readFile(resolve(`cloud/workers/api/ops-migrations/${migration}.sql`), 'utf8');
      await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
    }
    await db.prepare(buildEthereumRevealRegistration({ deploymentId, dropId: '111k', chainId: 1, contractAddress,
      metadataBaseUri, deploymentBlock: 100, catalogVersion: descriptor.catalogVersion, templateJson,
      templateSha256: createHash('sha256').update(templateJson).digest('hex') })).run();
    await db.prepare("UPDATE ethereum_reveal_deployments SET state='active',revision=9,provisioned_at_ms=2,activated_at_ms=3,catalog_update_id='revision-base',catalog_update_started_at_ms=1 WHERE deployment_id=?")
      .bind(deploymentId).run();
    await db.prepare('UPDATE ethereum_reveal_deployments SET catalog_revision=1,effective_catalog_version=?,effective_catalog_sha256=?,catalog_update_id=NULL,catalog_update_started_at_ms=NULL WHERE deployment_id=?')
      .bind(descriptor.catalogVersion, descriptor.manifestSha256, deploymentId).run();
    assert.deepEqual(await request('/seed'), { ready: true });
    assert.equal((await run('begin')).total, 20);
    assert.equal((await run('scan')).phase, 'staging');
    assert.equal((await run('stage')).phase, 'prepared');
    await db.prepare("UPDATE ethereum_reveal_deployments SET revision=8 WHERE deployment_id=?").bind(deploymentId).run();
    assert.match((await request<{ error: string }>('/operation', { ...identity, action: 'activate' }, 409)).error, /revision or readiness changed/);
    await db.prepare("UPDATE ethereum_reveal_deployments SET state='paused',revision=10 WHERE deployment_id=?").bind(deploymentId).run();
    for (const action of ['activate', 'verify', 'complete']) {
      assert.match((await request<{ error: string }>('/operation', { ...identity, action }, 409)).error, /revision or readiness changed/);
    }
    assert.equal((await run('status')).phase, 'prepared');
    assert.deepEqual(await db.prepare('SELECT state,revision FROM ethereum_reveal_deployments WHERE deployment_id=?').bind(deploymentId).first(),
      { state: 'paused', revision: 10 });
    await db.prepare("UPDATE ethereum_reveal_deployments SET state='active',revision=11 WHERE deployment_id=?").bind(deploymentId).run();
    assert.match((await request<{ error: string }>('/operation', { ...begin, batchId: 'stale-new-batch' }, 409)).error, /revision or readiness changed/);
    assert.match((await request<{ error: string }>('/operation', { ...identity, action: 'activate', expectedRevision: 11 }, 409)).error,
      /original operation identity/);
    assert.equal((await run('begin')).phase, 'prepared');
    assert.equal((await run('activate')).phase, 'activating');
    assert.equal((await run('activate')).phase, 'publishing');
    assert.deepEqual(await request('/publish'), { published: 2 });
    assert.equal((await run('verify')).phase, 'observing');
    assert.match((await request<{ error: string }>('/operation', { ...identity, action: 'complete' }, 409)).error, /two verification passes/);
    await request('/clock');
    assert.equal((await run('verify')).verificationCursor, null);
    assert.equal((await run('complete')).complete, true);
    assert.deepEqual(await request('/evidence'), { expectedRevision: 9, passes: 2, preparations: 1, candidates: 0, traits: 0 });
    assert.deepEqual(await db.prepare('SELECT state,revision FROM ethereum_reveal_deployments WHERE deployment_id=?').bind(deploymentId).first(),
      { state: 'active', revision: 11 });
  } finally { await runtime.dispose(); }
});
