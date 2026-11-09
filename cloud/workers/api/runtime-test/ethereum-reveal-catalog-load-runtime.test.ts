import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { computeRevealCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.ts';
import { revealCatalogUpdateHash, type RevealCatalogUpdateBody } from '../../../../shared/ethereum/revealCatalogUpdate.ts';

const predecessor = getRevealCatalog('111k-v5')!;
const templateJson = JSON.stringify({ name: '{{tokenId}}', description: 'load', image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] });
const deployment = { deploymentId: 'online-load', dropId: '111k_devnet', chainId: 11155111,
  contractAddress: `0x${'12'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/online-load/',
  deploymentBlock: 100, catalogVersion: '111k-v5', templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex'),
  state: 'active', revision: 3, createdAtMs: 1, updatedAtMs: 3, activatedAtMs: 3, provisionedAtMs: 2, lastError: null };

test('native online pools stage 9358 and all remaining eggs while ordinary requests continue', { timeout: 180_000 }, async t => {
  const source = `
    import { DurableObject } from 'cloudflare:workers';
    import { EthereumRevealStore } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealStore.ts'))};
    const deployment = ${JSON.stringify(deployment)};
    const observation = { transactionHash: '0x'+'1'.repeat(64),blockHash:'0x'+'2'.repeat(64),blockNumber:101 };
    const payload='[{"trait_type":"collection block","value":"load"},{"trait_type":"serial","value":9007199254740993}]';
    export class Pool extends DurableObject {
      constructor(ctx,env) { super(ctx,env); this.store=new EthereumRevealStore(ctx.storage.sql, work=>ctx.storage.transactionSync(work),maximum=>{
        const value=this.random?.shift()??0; if(value>=maximum)throw new Error('random bound'); return value;
      }); this.random=[]; }
      async run(input) {
        const updates=this.store.catalogUpdate, sql=this.ctx.storage.sql;
        if(input.command==='init') {
          this.store.configure(deployment); while(!this.store.initializeChunk()){}
          const first=76642-input.amount+1;
          sql.exec("WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<?) INSERT INTO crates(crate_token_id) SELECT CAST(111112+n AS TEXT) FROM ids",Math.ceil(input.amount/20)-1);
          sql.exec("DELETE FROM free_slots WHERE category='egg' AND asset_id>=?",first);
          sql.exec("UPDATE pools SET available=available-? WHERE category='egg'",input.amount);
          sql.exec(
            "WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<?),rows AS (SELECT n,?+n-1 AS egg,CAST(111112+(n-1)/20 AS TEXT) AS crate,"+
            "json_object('name','Egg #'||(?+n-1),'description','egg','image','https://cdn.lil.org/nft/111k/eggs/'||(?+n-1)||'.png','category','egg','attributes',json('[]'),'aspectRatio',json_object('width',1,'height',1),'revealStatus','revealed') AS metadata FROM ids) "+
            "INSERT INTO assignments(category,asset_id,crate_token_id,slot,token_id,artwork_json,metadata_json,placeholder_json,frozen_at_ms,assignment_revision) "+
            "SELECT 'egg',egg,crate,(n-1)%20,CAST(n AS TEXT),json_set(metadata,'$.tokenId',CAST(n AS TEXT),'$.crateTokenId',crate,'$.observation',json(?)),metadata,?,1,0 FROM rows",
            input.amount,first,first,first,JSON.stringify(observation),deployment.templateJson);
          sql.exec("INSERT INTO publication(token_id,status) SELECT token_id,'published' FROM assignments");
          return { frozen:input.amount };
        }
        if(input.command==='begin')return updates.begin(input.batch,1000);
        if(input.command==='mapping')return updates.stageMappings(input.batchId,input.rows);
        if(input.command==='sealMapping')return updates.sealMappings(input.batchId);
        if(input.command==='metadata') {
          const rows=updates.metadataPreparationPage(input.batchId,256);
          if(rows.length)updates.metadataStage(input.batchId,rows.map(row=>({...row,attributesJson:payload,sha256:input.sha256})));
          return updates.status(input.batchId);
        }
        if(input.command==='generation') { const start=performance.now(); const value=updates.generationStage(input.batchId,256);return {...value,duration:performance.now()-start}; }
        if(input.command==='seal')return updates.seal(input.batchId);
        if(input.command==='activate') { const start=performance.now();const value=updates.activate(input.batchId,2000);return {...value,duration:performance.now()-start}; }
        if(input.command==='ordinary') {
          const crate=String(115000+input.index),first=100000+input.index*20;
          this.random.push(3421,0);
          this.store.reserve([crate]);
          this.store.freeze(deployment,observation,[{crateTokenId:crate,tokenIds:Array.from({length:20},(_,index)=>String(first+index))}],2001);
          return {revision:updates.effectiveCatalog().catalogRevision,artworks:this.store.frozen([String(first)]).map(value=>({category:value.category,tokenId:value.tokenId}))};
        }
        if(input.command==='read') {
          const canonical=updates.canonicalMetadata(['1'])[0];
          return {revision:updates.effectiveCatalog().catalogRevision,category:canonical.category,metadataRevision:canonical.metadataRevision,metadataJson:canonical.metadataJson};
        }
        if(input.command==='verify') {
          const pools=updates.pools();
          return {total:pools.reduce((sum,pool)=>sum+pool.total,0),free:pools.reduce((sum,pool)=>sum+pool.available,0),
            assigned:sql.exec('SELECT COUNT(*) AS count FROM assignments').one().count,
            originalEggs:sql.exec("SELECT COUNT(*) AS count FROM assignments WHERE category='egg' AND assignment_revision=0").one().count,
            eggs:pools.find(pool=>pool.category==='egg').total,status:updates.status(input.batchId)};
        }
        throw new Error('Unknown command');
      }
    }
    export default { async fetch(request,env) { const input=await request.json();return Response.json(await env.POOL.getByName(input.id).run(input)); } };
  `;
  const bundled = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'online-load.ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
  const runtime = new Miniflare({ workers: [{ config: { name: 'online-pool-load', compatibilityDate: '2026-08-08',
    manifest: { mainModule: 'pool.mjs', modulesRoot: resolve('.'), modules: { 'pool.mjs': { type: 'esm', contents: bundled.outputFiles[0].text } } },
    env: { POOL: { type: 'durable-object', worker: 'online-pool-load', exportName: 'Pool' } },
    exports: { Pool: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    const payload = '[{"trait_type":"collection block","value":"load"},{"trait_type":"serial","value":9007199254740993}]';
    const sha256 = createHash('sha256').update(payload).digest('hex');
    for (const amount of [9358, predecessor.categories.eggs.count]) {
      const target = structuredClone(predecessor);
      const category = amount === 9358 ? 'painting' : 'video';
      const family = category === 'painting' ? 'paintings' : 'videos';
      target.catalogVersion = '111k-v6';
      target.categories.eggs.count -= amount;
      target.categories[family].count += amount;
      target.categories[family].aspectRatioIndexById = [...target.categories[family].aspectRatioIndexById!, ...Array<number>(amount).fill(0)];
      if (family === 'paintings' && target.categories.paintings.variants?.alt) {
        target.categories.paintings.variants.alt.assetIds = Array.from({ length: predecessor.categories.paintings.count }, (_, index) => index + 1);
      }
      const body: RevealCatalogUpdateBody = { version: 1, nonce: '00000000-0000-4000-8000-000000000001',
        predecessor: { manifest: predecessor, descriptor: computeRevealCatalogDescriptor(predecessor) },
        target: { manifest: target, descriptor: computeRevealCatalogDescriptor(target) },
        mappings: Array.from({ length: amount }, (_, index) => ({ eggId: target.categories.eggs.count + index + 1,
          category, assetId: predecessor.categories[family].count + index + 1 })) };
      const batchSha256 = revealCatalogUpdateHash(body);
      const batch = { ...body, batchSha256, batchId: `catalog-${batchSha256.slice(0, 32)}` };
      const request = async <T = Record<string, number | string>>(command: string, input: object = {}): Promise<T> => {
        const response = await runtime.dispatchFetch('https://test/', { method: 'POST', body: JSON.stringify({ id: String(amount), command, batchId: batch.batchId, ...input }) });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json() as Promise<T>;
      };
      const started = performance.now();
      await request('init', { amount });
      await request('begin', { batch });
      for (let offset = 0; offset < amount; offset += 256) await request('mapping', { rows: batch.mappings.slice(offset, offset + 256) });
      await request('sealMapping');
      while ((await request('metadata', { sha256 })).metadataStaged !== amount) {}
      let seeded = 0, maximumStageMs = 0, ordinary = 0;
      while (seeded < 111111) {
        const [stage, read] = await Promise.all([request('generation'), request('read')]);
        seeded = Number(stage.generationSeeded);
        maximumStageMs = Math.max(maximumStageMs, Number(stage.duration));
        assert.equal(read.revision, 0);
        assert.equal(read.category, 'egg');
        if (ordinary < 12 && seeded >= ordinary * 8192) {
          assert.equal((await request('ordinary', { index: ordinary++ })).revision, 0);
        }
      }
      await request('seal');
      assert.equal((await request('ordinary', { index: ordinary++ })).revision, 0);
      const activated = await request('activate');
      const read = await request('read');
      assert.equal(read.revision, 1);
      assert.equal(read.category, category);
      assert.equal(read.metadataRevision, 3);
      assert.match(String(read.metadataJson), /9007199254740993/);
      assert.equal((await request('ordinary', { index: ordinary++ })).revision, 1);
      const verified = await request<{ total: number; free: number; assigned: number; originalEggs: number; eggs: number;
        status: { frozen: number; generationSeeded: number } }>('verify');
      assert.equal(verified.total, 111111);
      assert.equal(verified.free + verified.assigned, 111111);
      assert.equal(verified.originalEggs >= amount, true);
      assert.equal(verified.eggs, target.categories.eggs.count);
      assert.equal(verified.status.generationSeeded, 111111);
      assert.equal(verified.status.frozen, amount);
      assert.ok(Number(activated.duration) < 1500, `Activation exceeded the foreground budget: ${activated.duration}`);
      t.diagnostic(JSON.stringify({ runtime: 'native-workerd', amount, elapsedMs: Math.round(performance.now() - started),
        maximumStageMs: Math.round(maximumStageMs), activationMs: Math.round(Number(activated.duration)), ordinaryRequests: ordinary }));
    }
  } finally { await runtime.dispose(); }
});
