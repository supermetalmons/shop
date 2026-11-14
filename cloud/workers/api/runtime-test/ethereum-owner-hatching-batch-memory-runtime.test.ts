import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('native 100-token owner scans preserve large quoted and Unicode metadata within a 128 MiB heap', { timeout: 120_000 }, async t => {
  const path = (value: string) => JSON.stringify(resolve(value));
  const source = `
    import { DurableObject } from 'cloudflare:workers';
    import { createHash } from 'node:crypto';
    import { EthereumRevealCatalogUpdateStore } from ${path('cloud/workers/api/src/ethereumRevealCatalogUpdateStore.ts')};
    import { buildNewRevealedArtwork } from ${path('cloud/workers/api/src/ethereumRevealCatalog.ts')};
    import { applyRevealAttributePayload, MAX_REVEAL_METADATA_BYTES } from ${path('cloud/workers/api/src/ethereumRevealAttributes.ts')};
    import { getRevealCatalog } from ${path('shared/ethereum/revealCatalogRegistry.ts')};
    export class Probe extends DurableObject {
      constructor(ctx,env) {
        super(ctx,env);
        ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS owner_hatching_tokens(token_id TEXT PRIMARY KEY,canonical_json TEXT)');
        this.store=new EthereumRevealCatalogUpdateStore(ctx.storage.sql,work=>ctx.storage.transactionSync(work));
      }
      seed(start,unicode) {
        const catalog=getRevealCatalog('111k-v9');
        const payload=JSON.stringify([{trait_type:'collection block',value:'plane of existence'},
          {trait_type:'text',value:(unicode?'☀':'')+'"'.repeat(260000)}]);
        let metadataBytes=0,canonicalBytes=0;
        for(let i=start;i<start+10;i++) {
          const tokenId=String(i);
          const built=buildNewRevealedArtwork({templateJson:JSON.stringify({name:'{{tokenId}}',
            image:'https://cdn.lil.org/nft/111k/placeholder.png',attributes:[]}),tokenId,
            crateTokenId:String(111112+Math.floor((i-1)/20)),category:'painting',assetId:i,
            observation:{transactionHash:'0x'+'1'.repeat(64),blockHash:'0x'+'2'.repeat(64),blockNumber:101},catalog});
          const result=applyRevealAttributePayload(built.metadataJson,payload);
          metadataBytes=new TextEncoder().encode(result.metadataJson).length;
          if(metadataBytes>MAX_REVEAL_METADATA_BYTES)throw new Error('Invalid fixture metadata size');
          const row={tokenId,category:'painting',assetId:i,assignmentRevision:1,metadataRevision:7,
            artwork:built.artwork,metadataJson:result.metadataJson,targetSha256:result.metadataSha256,
            expectedJsons:[built.metadataJson,built.placeholderJson],allowMissing:false,migration:true};
          const json=JSON.stringify(row);
          canonicalBytes=new TextEncoder().encode(json).length;
          this.ctx.storage.sql.exec('INSERT INTO owner_hatching_tokens VALUES(?,?)',tokenId,json);
        }
        return {metadataBytes,canonicalBytes};
      }
      read(legacy) {
        if(globalThis.gc)globalThis.gc();
        const ids=Array.from({length:100},(_,i)=>String(i+1));
        const values=legacy?ids.map(id=>this.store.ownerHatching.canonical(id)):this.store.canonicalMetadata(ids);
        const digest=createHash('sha256');
        for(const row of values)digest.update(row.tokenId).update(row.metadataJson);
        return {count:values.length,sha256:digest.digest('hex')};
      }
    }
    export default {async fetch(request,env) {
      const input=await request.json(),object=env.PROBE.getByName(input.unicode?'unicode':'quotes');
      return Response.json(input.start?await object.seed(input.start,input.unicode):await object.read(input.legacy));
    }};
  `;
  const bundled = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'owner-memory.ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
  const previousFlags = process.env.MINIFLARE_WORKERD_V8_FLAGS;
  process.env.MINIFLARE_WORKERD_V8_FLAGS = `${previousFlags ?? ''} --max-old-space-size=128 --expose-gc`.trim();
  const runtime = new Miniflare({ workers: [{ config: { name: 'owner-memory', compatibilityDate: '2026-08-08',
    manifest: { mainModule: 'probe.mjs', modulesRoot: resolve('.'), modules: { 'probe.mjs': { type: 'esm', contents: bundled.outputFiles[0].text } } },
    env: { PROBE: { type: 'durable-object', worker: 'owner-memory', exportName: 'Probe' } },
    exports: { Probe: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    const request = async (input: { unicode: boolean; start?: number; legacy?: boolean }) => {
      const response = await runtime.dispatchFetch('https://test/', { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      return JSON.parse(body);
    };
    for (const unicode of [false, true]) {
      let sizes;
      for (let start = 1; start <= 100; start += 10) sizes = await request({ unicode, start });
      const legacy = await request({ unicode, legacy: true });
      const batched = await request({ unicode, legacy: false });
      assert.equal(batched.count, 100);
      assert.deepEqual(batched, legacy);
      t.diagnostic(JSON.stringify({ unicode, ...sizes, count: batched.count }));
    }
  } finally {
    await runtime.dispose();
    if (previousFlags === undefined) delete process.env.MINIFLARE_WORKERD_V8_FLAGS;
    else process.env.MINIFLARE_WORKERD_V8_FLAGS = previousFlags;
  }
});
