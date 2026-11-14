import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('native canonical scans preserve complete large mapped and enriched records within a 128 MiB heap', { timeout: 180_000 }, async t => {
  const path = (value: string) => JSON.stringify(resolve(value));
  const source = `
    import { DurableObject } from 'cloudflare:workers';
    import { createHash } from 'node:crypto';
    import { EthereumRevealCatalogUpdateStore } from ${path('cloud/workers/api/src/ethereumRevealCatalogUpdateStore.ts')};
    import { buildRevealedArtwork, buildNewRevealedArtwork } from ${path('cloud/workers/api/src/ethereumRevealCatalog.ts')};
    import { applyRevealAttributePayload, MAX_REVEAL_METADATA_BYTES } from ${path('cloud/workers/api/src/ethereumRevealAttributes.ts')};
    import { getRevealCatalog } from ${path('shared/ethereum/revealCatalogRegistry.ts')};
    import { REVEAL_ENRICHMENT_VERSION } from ${path('shared/ethereum/reveal.ts')};
    const catalog=getRevealCatalog('111k-v9');
    const templateJson=JSON.stringify({name:'{{tokenId}}',image:'https://cdn.lil.org/nft/111k/placeholder.png',attributes:[]});
    export class Probe extends DurableObject {
      constructor(ctx,env) {
        super(ctx,env);
        const sql=ctx.storage.sql;
        sql.exec('CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY,deployment_json TEXT,catalog_revision INTEGER,allocation_base_generation TEXT,active_catalog_generation TEXT)');
        sql.exec('INSERT OR IGNORE INTO settings VALUES(1,?,1,NULL,NULL)',JSON.stringify({catalogVersion:'111k-v9',templateJson}));
        sql.exec('CREATE TABLE IF NOT EXISTS assignments(token_id TEXT PRIMARY KEY,category TEXT,asset_id INTEGER,crate_token_id TEXT,artwork_json TEXT,metadata_json TEXT,placeholder_json TEXT,frozen_at_ms INTEGER,assignment_revision INTEGER)');
        sql.exec('CREATE TABLE IF NOT EXISTS publication(token_id TEXT PRIMARY KEY,status TEXT,metadata_revision INTEGER)');
        sql.exec('CREATE TABLE IF NOT EXISTS reveal_catalog_generations(batch_id TEXT PRIMARY KEY,target_revision INTEGER,activated_at_ms INTEGER)');
        sql.exec("INSERT OR IGNORE INTO reveal_catalog_generations VALUES('mapping',1,1)");
        sql.exec('CREATE TABLE IF NOT EXISTS reveal_catalog_mappings(batch_id TEXT,egg_id INTEGER,category TEXT,asset_id INTEGER,attributes_json TEXT,attributes_sha256 TEXT,origin_category TEXT,origin_asset_id INTEGER)');
        sql.exec('CREATE TABLE IF NOT EXISTS reveal_enrichment(token_id TEXT PRIMARY KEY,version INTEGER,target_json TEXT,target_sha256 TEXT,assignment_revision INTEGER)');
        this.store=new EthereumRevealCatalogUpdateStore(sql,work=>ctx.storage.transactionSync(work));
      }
      seed(start,unicode,enriched) {
        const sql=this.ctx.storage.sql;
        const payload=JSON.stringify([{trait_type:'collection block',value:'plane of existence'},
          {trait_type:'text',value:(unicode?'☀':'')+'"'.repeat(unicode?145000:255000)}]);
        let metadataBytes=0;
        for(let i=start;i<start+10;i++) {
          const tokenId=String(i),crateTokenId=String(111112+Math.floor((i-1)/20));
          const observation={transactionHash:'0x'+'1'.repeat(64),blockHash:'0x'+'2'.repeat(64),blockNumber:101};
          const input={templateJson,tokenId,crateTokenId,observation,catalog};
          const original=buildNewRevealedArtwork({...input,category:enriched?'painting':'egg',assetId:i});
          const legacy=applyRevealAttributePayload(buildRevealedArtwork({...input,category:'painting',assetId:i}).metadataJson,payload);
          const fresh=applyRevealAttributePayload(buildNewRevealedArtwork({...input,category:'painting',assetId:i}).metadataJson,payload);
          const target=enriched?fresh:legacy;
          metadataBytes=Math.max(new TextEncoder().encode(fresh.metadataJson).length,new TextEncoder().encode(legacy.metadataJson).length);
          if(metadataBytes>MAX_REVEAL_METADATA_BYTES)throw new Error('Invalid fixture metadata size');
          sql.exec('INSERT INTO assignments VALUES(?,?,?,?,?,?,?,?,?)',tokenId,enriched?'painting':'egg',i,crateTokenId,
            JSON.stringify(original.artwork),original.metadataJson,original.placeholderJson,1,0);
          sql.exec("INSERT INTO publication VALUES(?,'published',?)",tokenId,enriched?1:3);
          if(enriched)sql.exec('INSERT INTO reveal_enrichment VALUES(?,?,?,?,0)',tokenId,REVEAL_ENRICHMENT_VERSION,target.metadataJson,target.metadataSha256);
          else sql.exec("INSERT INTO reveal_catalog_mappings VALUES('mapping',?,'painting',?,?,?,NULL,NULL)",
            i,i,payload,createHash('sha256').update(payload).digest('hex'));
        }
        return {metadataBytes,attributeBytes:new TextEncoder().encode(payload).length};
      }
      read(singleton) {
        if(globalThis.gc)globalThis.gc();
        const ids=Array.from({length:100},(_,i)=>String(100-i));
        ids.splice(50,0,'999','100');
        const rows=singleton?ids.flatMap(id=>this.store.canonicalMetadata([id])):this.store.canonicalMetadata(ids);
        const digest=createHash('sha256');
        for(const row of rows)digest.update(JSON.stringify(row));
        return {count:rows.length,sha256:digest.digest('hex')};
      }
    }
    export default {async fetch(request,env) {
      const input=await request.json(),object=env.PROBE.getByName(input.enriched?'enriched':input.unicode?'unicode':'quotes');
      return Response.json(input.start?await object.seed(input.start,input.unicode,input.enriched):await object.read(input.singleton));
    }};
  `;
  const bundled = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'canonical-memory.ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
  const previousFlags = process.env.MINIFLARE_WORKERD_V8_FLAGS;
  process.env.MINIFLARE_WORKERD_V8_FLAGS = `${previousFlags ?? ''} --max-old-space-size=128 --expose-gc`.trim();
  const runtime = new Miniflare({ workers: [{ config: { name: 'canonical-memory', compatibilityDate: '2026-08-08',
    manifest: { mainModule: 'probe.mjs', modulesRoot: resolve('.'), modules: { 'probe.mjs': { type: 'esm', contents: bundled.outputFiles[0].text } } },
    env: { PROBE: { type: 'durable-object', worker: 'canonical-memory', exportName: 'Probe' } },
    exports: { Probe: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    const request = async (input: { unicode: boolean; enriched: boolean; start?: number; singleton?: boolean }) => {
      const response = await runtime.dispatchFetch('https://test/', { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      return JSON.parse(body);
    };
    for (const variant of [{ unicode: false, enriched: false }, { unicode: true, enriched: false }, { unicode: false, enriched: true }]) {
      let sizes;
      for (let start = 1; start <= 100; start += 10) sizes = await request({ ...variant, start });
      const singleton = await request({ ...variant, singleton: true });
      const batched = await request({ ...variant, singleton: false });
      assert.equal(batched.count, 101);
      assert.deepEqual(batched, singleton);
      t.diagnostic(JSON.stringify({ ...variant, ...sizes, count: batched.count }));
    }
  } finally {
    await runtime.dispose();
    if (previousFlags === undefined) delete process.env.MINIFLARE_WORKERD_V8_FLAGS;
    else process.env.MINIFLARE_WORKERD_V8_FLAGS = previousFlags;
  }
});
