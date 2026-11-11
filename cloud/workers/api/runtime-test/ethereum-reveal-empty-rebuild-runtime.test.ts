import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { buildRevealCatalogUpdateBatch } from '../../../../scripts/ethereum-metadata/catalogUpdate.ts';
import type { RevealCatalogUpdateStatus } from '../src/ethereumRevealCatalogUpdateStore.ts';

test('native empty mainnet rebuild seeds direct identities under the fence and preserves normal enrichment', { timeout: 90_000 }, async t => {
  const predecessor = getRevealCatalog('111k-v8')!;
  const target = getRevealCatalog('111k-v9')!;
  const batch = buildRevealCatalogUpdateBatch(predecessor, target, () => 0);
  const templateJson = JSON.stringify({ name: '{{tokenId}}', image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] });
  const deployment = { deploymentId: 'mainnet-native-empty', dropId: '111k', chainId: 1,
    contractAddress: `0x${'34'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 100,
    catalogVersion: predecessor.catalogVersion, templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex'),
    state: 'active', revision: 3, createdAtMs: 1, updatedAtMs: 3, provisionedAtMs: 2, activatedAtMs: 3, lastError: null };
  const scope = { operationId: 'empty-native-mainnet-v9', deploymentId: deployment.deploymentId,
    batchSha256: batch.batchSha256, expectedRevision: 3 };
  const source = `
    import { DurableObject } from 'cloudflare:workers';
    import { EthereumRevealStore } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealStore.ts'))};
    import { EthereumRevealEmptyPoolFence, ETHEREUM_REVEAL_EMPTY_POOL_DRAIN_MS } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealEmptyPoolFence.ts'))};
    const deployment=${JSON.stringify(deployment)}, scope=${JSON.stringify(scope)};
    let externalRequests=0;
    globalThis.fetch=()=>{externalRequests++;throw new Error('External requests are forbidden in empty rebuild regression.');};
    export class Pool extends DurableObject {
      constructor(ctx,env) {
        super(ctx,env);
        let depth=0;
        this.transaction=action=>{
          if(depth)return action();
          return ctx.storage.transactionSync(()=>{depth++;try{return action();}finally{depth--;}});
        };
        this.now=1000;this.random=[];
        this.fence=new EthereumRevealEmptyPoolFence(ctx.storage.sql,this.transaction);
        this.store=this.open();
      }
      open() {
        return new EthereumRevealStore(this.ctx.storage.sql,this.transaction,maximum=>{
          const selected=this.random.shift()??0;
          if(selected<0||selected>=maximum)throw new Error('Invalid fixture draw.');
          return selected;
        });
      }
      snapshot() {
        const sql=this.ctx.storage.sql,pools=this.store.catalogUpdate.pools();
        return {effective:this.store.catalogUpdate.effectiveCatalog(),status:this.store.catalogUpdate.status(scope.operationId),
          pools,free:pools.reduce((sum,pool)=>sum+pool.available,0),
          origin:JSON.parse(sql.exec('SELECT deployment_json FROM settings WHERE id=1').one().deployment_json),
          base:sql.exec('SELECT allocation_base_generation FROM settings WHERE id=1').one().allocation_base_generation,
          legacyFree:sql.exec('SELECT COUNT(*) AS n FROM free_slots').one().n,
          legacyPools:sql.exec('SELECT COUNT(*) AS n FROM pools').one().n,
          mappings:sql.exec('SELECT COUNT(*) AS n FROM reveal_catalog_mappings WHERE batch_id=?',scope.operationId).one().n,
          historicalMappings:sql.exec('SELECT COUNT(*) AS n FROM reveal_catalog_mappings WHERE batch_id!=?',scope.operationId).one().n,
          fence:this.fence.status(),bypass:sql.exec('SELECT bypass FROM reveal_empty_pool_fences WHERE operation_id=?',scope.operationId).one().bypass,
          externalRequests};
      }
      run(input) {
        const sql=this.ctx.storage.sql,updates=this.store.catalogUpdate;
        if(input.command==='init') {
          this.store.configure(deployment);while(!this.store.initializeChunk()){}
          updates.begin(input.batch,this.now);
          updates.stageMappings(input.batch.batchId,input.batch.mappings.slice(0,16));
          updates.cancel(input.batch.batchId);
          this.fence.acquire(scope,this.now);
          let blocked=false;
          try{sql.exec('UPDATE settings SET ready=0 WHERE id=1');}catch(error){blocked=String(error).includes('fenced');}
          return {blocked,...this.snapshot()};
        }
        if(input.command==='drain') {this.now+=ETHEREUM_REVEAL_EMPTY_POOL_DRAIN_MS;return this.fence.assertEmpty(scope,this.now);}
        if(input.command==='begin') {
          this.fence.assertEmpty(scope,this.now);
          return this.fence.withRebuild(scope,()=>updates.beginEmptyRebuild({operationId:scope.operationId,batch:input.batch,now:this.now}));
        }
        if(input.command==='reopen') {
          this.fence.withRebuild(scope,()=>{this.store=this.open();});
          return this.snapshot();
        }
        if(input.command==='stage') return this.fence.withRebuild(scope,()=>updates.stageEmptyRebuild(scope.operationId,4096));
        if(input.command==='activate') return this.fence.withRebuild(scope,()=>{
          updates.sealEmptyRebuild(scope.operationId);
          updates.activateEmptyRebuild(scope.operationId,this.now);
          updates.verifyEmptyRebuild(scope.operationId);
          updates.finalize(scope.operationId);
          return this.snapshot();
        });
        if(input.command==='prune') return this.fence.withRebuild(scope,()=>updates.pruneEmptyRebuild(scope.operationId,4096));
        if(input.command==='release') {
          this.fence.withRebuild(scope,()=>this.fence.release(scope,this.now));
          return this.snapshot();
        }
        if(input.command==='artworkFixture') {
          this.random.push(${target.categories['3d'].count + target.categories.animated.count + target.categories.eggs.count},${target.categories.paintings.count - 1});
          this.store.freeze(deployment,{transactionHash:'0x'+'1'.repeat(64),blockHash:'0x'+'2'.repeat(64),blockNumber:101},
            [{crateTokenId:'111112',tokenIds:Array.from({length:20},(_,index)=>String(index+1))}],this.now);
          this.store.publicationComplete('1');
          const canonical=updates.canonicalMetadata(['1'])[0];
          const claim=this.store.enrichment.claim(this.now).find(row=>row.token_id==='1');
          return {canonical,claim,externalRequests,free:updates.pools().reduce((sum,pool)=>sum+pool.available,0)};
        }
        throw new Error('Unknown native rebuild command.');
      }
    }
    export default {async fetch(request,env){
      try{return Response.json(await env.POOL.getByName('mainnet').run(await request.json()));}
      catch(error){return Response.json({error:error.message},{status:409});}
    }};
  `;
  const bundled = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'empty-mainnet-runtime.ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
  const worker = 'empty-mainnet-runtime';
  const runtime = new Miniflare({ workers: [{ config: { name: worker, compatibilityDate: '2026-08-08',
    manifest: { mainModule: 'pool.mjs', modulesRoot: resolve('.'), modules: { 'pool.mjs': { type: 'esm', contents: bundled.outputFiles[0].text } } },
    env: { POOL: { type: 'durable-object', worker, exportName: 'Pool' } },
    exports: { Pool: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  const request = async <T>(command: string, input: object = {}, expectedStatus = 200): Promise<T> => {
    const response = await runtime.dispatchFetch('https://native-empty.test/', { method: 'POST', body: JSON.stringify({ command, ...input }) });
    const value = await response.json() as T & { error?: string };
    assert.equal(response.status, expectedStatus, value.error ?? command);
    return value;
  };
  type Snapshot = { blocked?: boolean; effective: { catalogVersion: string; catalogRevision: number }; status: RevealCatalogUpdateStatus;
    pools: Array<{ category: string; total: number; available: number }>; free: number; origin: typeof deployment; base: string;
    legacyFree: number; legacyPools: number; mappings: number; historicalMappings: number; fence: unknown; bypass: number; externalRequests: number };
  try {
    const initial = await request<Snapshot>('init', { batch });
    assert.equal(initial.blocked, true);
    assert.equal(initial.free, 111111);
    assert.equal(initial.effective.catalogVersion, '111k-v8');
    assert.match((await request<{ error: string }>('begin', { batch }, 409)).error, /drain/);
    assert.equal((await request<{ empty: boolean }>('drain')).empty, true);
    assert.equal((await request<RevealCatalogUpdateStatus>('begin', { batch })).mode, 'empty-rebuild');
    let pages = 0;
    while ((await request<RevealCatalogUpdateStatus>('stage')).generationSeeded < 111111) {
      if (++pages === 1) assert.equal((await request<Snapshot>('reopen')).bypass, 0);
      assert.ok(pages < 30);
    }
    const active = await request<Snapshot>('activate');
    assert.equal(active.effective.catalogVersion, '111k-v9');
    assert.equal(active.effective.catalogRevision, 1);
    assert.equal(active.origin.catalogVersion, '111k-v8');
    assert.equal(active.base, scope.operationId);
    assert.equal(active.free, 111111);
    assert.equal(active.status.metadataStaged, 0);
    assert.equal(active.mappings, 0);
    assert.deepEqual(Object.fromEntries(active.pools.map(pool => [pool.category, pool.total])),
      { '3d': 3000, animated: 421, egg: 38652, painting: 68980, video: 58 });
    while ((await request<{ remaining: number }>('prune')).remaining) {}
    const released = await request<Snapshot>('release');
    assert.equal(released.legacyFree, 0);
    assert.equal(released.legacyPools, 0);
    assert.equal(released.historicalMappings, 16);
    assert.equal(released.fence, null);
    assert.equal(released.bypass, 0);
    const ordinary = await request<{ canonical: { category: string; assetId: number; metadataRevision: number; migration: boolean };
      claim: { asset_id: number; assignment_revision: number }; free: number; externalRequests: number }>('artworkFixture');
    assert.equal(ordinary.canonical.category, 'painting');
    assert.equal(ordinary.canonical.assetId, 68980);
    assert.equal(ordinary.canonical.metadataRevision, 2);
    assert.equal(ordinary.canonical.migration, false);
    assert.equal(ordinary.claim.asset_id, 68980);
    assert.equal(ordinary.claim.assignment_revision, 1);
    assert.equal(ordinary.free, 111091);
    assert.equal(ordinary.externalRequests, 0);
    t.diagnostic(JSON.stringify({ runtime: 'native-workerd', seeded: 111111, pageSize: 4096, pages: pages + 1, enrichmentAsset: 68980 }));
  } finally { await runtime.dispose(); }
});
