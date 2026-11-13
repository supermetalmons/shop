import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { OwnerHatchingMaintenanceResult } from '../../../../shared/ethereum/ownerHatchingMaintenance.ts';

test('native owner hatching operations preserve private preparation through restart, publication and scheduler verification', { timeout: 60_000 }, async () => {
  const path = (value: string) => JSON.stringify(resolve(value));
  const source = `
    import { DurableObject } from 'cloudflare:workers';
    import { createHash } from 'node:crypto';
    import { EthereumOwnerHatchingOperations } from ${path('cloud/workers/api/src/ethereumOwnerHatchingOperations.ts')};
    import { EthereumOwnerHatchingStore } from ${path('cloud/workers/api/src/ethereumOwnerHatchingStore.ts')};
    import { fetchRevealAttributePayload } from ${path('cloud/workers/api/src/ethereumRevealAttributes.ts')};
    import { revealTraitFixtureBlock } from ${path('cloud/workers/api/runtime-test/revealTraitFixture.ts')};
    import { getRevealCatalog,getRevealCatalogDescriptor } from ${path('shared/ethereum/revealCatalogRegistry.ts')};
    import { ownerHatchingCatalogSha256 } from ${path('shared/ethereum/ownerHatchingCatalog.ts')};
    import supplement from ${path('shared/ethereum/ownerHatchingCatalog.json')};
    import { encodeAbi,encodeCall,decodeReturn } from ${path('shared/ethereum/abi.ts')};
    import { ETHEREUM_FUNCTIONS } from ${path('shared/ethereum/protocol.ts')};
    const descriptor=getRevealCatalogDescriptor('111k-v9');
    const deployment={deploymentId:'mainnet-native-owner',dropId:'111k',chainId:1,contractAddress:'0x'+'1'.repeat(40),
      metadataBaseUri:'https://cdn.mons.shop/111k/',deploymentBlock:100,catalogVersion:'111k-v8',templateJson:'{}',
      templateSha256:'0'.repeat(64),state:'active',revision:9,createdAtMs:0,updatedAtMs:0,activatedAtMs:0,provisionedAtMs:0,lastError:null};
    const identity={deploymentId:deployment.deploymentId,batchId:'native-drowee',expectedRevision:9};
    const begin={...identity,action:'begin',sourceSha256:supplement.batches[0].source.sha256,catalogSha256:ownerHatchingCatalogSha256,
      readyCount:118,grailIds:Array.from({length:9},(_,i)=>422+i),freshEggIds:Array.from({length:109},(_,i)=>55304+i)};
    let now=1000000,traitsUnavailable=true,head=500,randomCalls=0;
    const canonicalHashes=new Map(),tokenCalls=[];
    const blockHash=block=>'0x'+block.toString(16).padStart(64,'0');
    Date.now=()=>now;
    const hash=value=>createHash('sha256').update(value).digest('hex');
    globalThis.fetch=async(input,init)=>{
      if(String(input).startsWith('https://cdn.lil.org/')){
        if(String(input).includes('/paintings/'))return traitsUnavailable?new Response(null,{status:503}):Response.json({'collection block':revealTraitFixtureBlock(String(input)),attributes:[{trait_type:'Recovered',value:'yes'}]});
        return Response.json({'collection block':'DROWEE',attributes:[]});
      }
      const payload=JSON.parse(init.body);
      const respond=row=>{
        let result;
        if(row.method==='eth_chainId')result='0x1';
        else if(row.method==='eth_getBlockByNumber'){
          const block=row.params[0]==='latest'?head:Number(BigInt(row.params[0]));
          result={number:'0x'+block.toString(16),hash:canonicalHashes.get(block)??blockHash(block)};
        }
        else if(row.method==='eth_call'){
          const data=row.params[0].data;
          if(data.slice(0,10)===encodeCall(ETHEREUM_FUNCTIONS.stats,[],[]))result=encodeAbi(
            ['uint256','uint256','uint256','uint256','uint256','bool','bytes32','uint256','uint256','uint256','uint256','uint256','uint256','uint256','uint256'],
            [12,0,240,1,1,true,'0x'+'0'.repeat(64),1,1,0,0,0,0,0,0]);
          else {const [ids]=decodeReturn(['uint256[]'],'0x'+data.slice(10));
            tokenCalls.push({ids:ids.map(String),block:row.params[1]});
            result=encodeAbi(['(uint8,uint256,address)[]'],[ids.map(id=>[1,id,'0x'+'2'.repeat(40)])]);}
        }else throw new Error('Unexpected RPC method');
        return {jsonrpc:'2.0',id:row.id,result};
      };
      return Response.json(Array.isArray(payload)?payload.map(respond):respond(payload));
    };
    export class Preparation extends DurableObject {
      constructor(ctx,env){
        super(ctx,env);this.depth=0;
        this.transaction=action=>this.depth?action():ctx.storage.transactionSync(()=>{this.depth++;try{return action();}finally{this.depth--;}});
        const sql=ctx.storage.sql;
        sql.exec('CREATE TABLE IF NOT EXISTS assignments(id INTEGER PRIMARY KEY)');
        if(!sql.exec('SELECT 1 FROM assignments LIMIT 1').toArray().length){
          this.transaction(()=>{for(let id=1;id<=240;id++)sql.exec('INSERT INTO assignments VALUES(?)',id);});
        }
        this.original=tokenId=>{
          const artwork={tokenId,crateTokenId:'111112',category:'egg',name:'Egg #'+tokenId,
            image:'https://cdn.lil.org/nft/111k/eggs/'+tokenId+'.png',aspectRatio:{width:1,height:1},
            observation:{transactionHash:'0x'+'3'.repeat(64),blockHash:'0x'+'4'.repeat(64),blockNumber:101}};
          const metadataJson=JSON.stringify({name:artwork.name,image:artwork.image,category:'egg',attributes:[]})+String.fromCharCode(10);
          return {tokenId,category:'egg',assetId:Number(tokenId),assignmentRevision:1,metadataRevision:2,artwork,metadataJson,
            targetSha256:hash(metadataJson),expectedJsons:[metadataJson],allowMissing:false,migration:false};
        };
        this.owner=new EthereumOwnerHatchingStore(sql,this.transaction,{canonical:this.original,originForToken:tokenId=>({category:'egg',assetId:Number(tokenId)}),
          build:(tokenId,asset,original)=>{
            const artwork={...original.artwork,category:asset.category,name:'Painting #'+asset.assetId,image:'https://cdn.lil.org/nft/111k/paintings/'+asset.assetId+'.png'};
            return {artwork,metadataJson:JSON.stringify({name:artwork.name,image:artwork.image,category:asset.category,attributes:[]})+String.fromCharCode(10)};
          },takeOrdinary:()=>({origin:{category:'painting',assetId:1},effective:{category:'painting',assetId:1}}),
          transitionSlot:()=>{},releaseReplacement:()=>{},
          freshEggAvailable:id=>id>=55304&&id<=76700,eligibleEgg:()=>true},()=>0);
        this.owner.initialize();this.open();
      }
      open(){
        this.operations=new EthereumOwnerHatchingOperations({env:{...this.env,ALCHEMY_MI_NOTE_API_KEY:'fixture',ETHEREUM_PROVIDER_CONTROL_ENABLED:'false'},
          sql:this.ctx.storage.sql,transaction:this.transaction,store:{catalogUpdate:{ownerHatching:this.owner,
            effectiveCatalog:()=>({...descriptor,generation:'v9-native',catalogRevision:1}),activeCatalog:()=>getRevealCatalog('111k-v9'),
            freshOwnerEggAvailable:id=>id>=55304&&id<=76700,canonicalMetadata:ids=>ids.map(this.original),
            pools:()=>[{available:111111-240,total:111111}]}},recover:async()=>true,requireCurrent:async()=>{},wake:async()=>{},
          randomInteger:maximum=>randomCalls++%maximum});
      }
      async run(action){
        if(action==='reopen'){this.open();action='status';}
        if(action==='clock'){now+=300000;action='status';}
        if(action==='reorg'){canonicalHashes.set(head,blockHash(head+1000));head++;action='status';}
        if(action==='hatch'){
          const tokenId=this.ctx.storage.sql.exec('SELECT token_id FROM owner_hatching_tokens WHERE grail_asset_id IS NULL LIMIT 1').one().token_id;
          this.owner.hatch(tokenId,now);action='status';
        }
        if(action==='enrich'||action==='recover-traits'){
          if(action==='recover-traits'){traitsUnavailable=false;now+=300000;}
          for(const row of this.owner.enrichmentPage(now)){
            try{
              const attributes=JSON.parse(await fetchRevealAttributePayload(row.category,row.assetId,AbortSignal.timeout(20000),fetch,getRevealCatalog('111k-v9')));
              this.owner.acceptEnrichment(row.tokenId,row.metadataRevision,JSON.stringify({...JSON.parse(row.baseJson),attributes})+String.fromCharCode(10));
            }catch{this.owner.failEnrichment(row.tokenId,row.metadataRevision,now,'source-unavailable');}
          }
          action='status';
        }
        if(action==='remove-metadata'||action==='restore-metadata'){
          const tokenId=this.ctx.storage.sql.exec('SELECT token_id FROM owner_hatching_tokens ORDER BY CAST(token_id AS INTEGER) LIMIT 1 OFFSET 16').one().token_id;
          const key='111k/'+tokenId+'.json';
          if(action==='remove-metadata')await this.env.ETHEREUM_REVEAL_METADATA.delete(key);
          else await this.env.ETHEREUM_REVEAL_METADATA.put(key,this.owner.canonical(tokenId).metadataJson,
            {httpMetadata:{contentType:'application/json; charset=utf-8',cacheControl:'no-store'}});
          action='status';
        }
        if(action==='publish'){
          let jobs;
          while((jobs=this.owner.claimPublications(now,8)).length){
            for(const job of jobs)await this.env.ETHEREUM_REVEAL_METADATA.put('111k/'+job.token_id+'.json',job.metadata_json,
              {httpMetadata:{contentType:'application/json; charset=utf-8',cacheControl:'no-store'}});
            this.owner.completePublications(jobs.map(job=>({job,status:'published'})),now);
          }
          action='status';
        }
        if(action==='activation-evidence')return {
          draws:this.ctx.storage.sql.exec('SELECT position,token_id,live FROM owner_hatching_activation_candidates ORDER BY position').toArray(),
          activation:this.ctx.storage.sql.exec('SELECT * FROM owner_hatching_activation').one(),
          preparation:this.ctx.storage.sql.exec('SELECT * FROM owner_hatching_preparations').one(),
          traits:this.ctx.storage.sql.exec('SELECT * FROM owner_hatching_trait_staging ORDER BY asset_id').toArray(),randomCalls,tokenCalls};
        if(action==='evidence')return {
          candidates:this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM owner_hatching_candidates').one().n,
          traits:this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM owner_hatching_trait_staging').one().n,
          activationCandidates:this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM owner_hatching_activation_candidates').one().n,
          activationChecked:this.ctx.storage.sql.exec('SELECT checked AS n FROM owner_hatching_activation').one().n,
          tokens:this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM owner_hatching_tokens').one().n,
          passes:this.ctx.storage.sql.exec('SELECT verification_passes AS n FROM owner_hatching_preparations').one().n};
        return this.operations.run(deployment,action==='begin'?begin:{...identity,action});
      }
    }
    export default {async fetch(request,env){try{return Response.json(await env.PREPARATION.getByName('fixture').run(new URL(request.url).pathname.slice(1)));}
      catch(error){return Response.json({error:error.message},{status:409});}}};
  `;
  const bundle = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'owner-hatching-operations-native.ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
  const worker = 'owner-hatching-operations-native';
  const runtime = new Miniflare({ workers: [{ config: { name: worker, compatibilityDate: '2026-08-08', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'worker.mjs', modulesRoot: resolve('.'), modules: { 'worker.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    env: { PREPARATION: { type: 'durable-object', worker, exportName: 'Preparation' },
      ETHEREUM_REVEAL_METADATA: { type: 'r2', name: 'owner-hatching-operations-metadata' } },
    exports: { Preparation: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  const request = async <T = OwnerHatchingMaintenanceResult>(action: string, status = 200): Promise<T> => {
    const response = await runtime.dispatchFetch(`https://owner-native.test/${action}`);
    const body = await response.json() as T & { error?: string };
    assert.equal(response.status, status, body.error ?? action);
    return body;
  };
  try {
    assert.equal((await request('begin')).total, 240);
    assert.equal((await request('scan')).scanned, 100);
    assert.equal((await request('reopen')).scanned, 100);
    await request('reorg');
    assert.match((await request<{ error: string }>('scan', 409)).error, /Ethereum changed/);
    const refreshedScan = await request('refresh-scan');
    assert.equal(refreshedScan.phase, 'scanning');
    assert.equal(refreshedScan.scanned, 0);
    assert.equal(refreshedScan.candidates, 0);
    assert.equal(refreshedScan.total, 240);
    assert.deepEqual(await request('reopen'), refreshedScan);
    assert.equal((await request('scan')).scanned, 100);
    assert.equal((await request('scan')).scanned, 200);
    assert.equal((await request('scan')).phase, 'staging');
    assert.match((await request<{ error: string }>('refresh-scan', 409)).error, /unfinished scan/);
    assert.equal((await request('stage')).staged, 8);
    assert.equal((await request('reopen')).staged, 8);
    assert.equal((await request('stage')).phase, 'prepared');
    const activating = await request('activate');
    assert.equal(activating.phase, 'activating');
    assert.equal(activating.activationChecked, 0);
    assert.equal(activating.activationSelected, 0);
    assert.equal((await request('reopen')).phase, 'activating');
    const firstActivationPage = await request('activate');
    assert.equal(firstActivationPage.phase, 'activating');
    assert.equal(firstActivationPage.activationChecked, 100);
    assert.equal(firstActivationPage.activationSelected, 100);
    assert.deepEqual(await request('reopen'), firstActivationPage);
    await request('reorg');
    assert.match((await request<{ error: string }>('activate', 409)).error, /Ethereum changed/);
    type ActivationEvidence = {
      draws: Array<{ position: number; token_id: string; live: number | null }>;
      activation: { batch_id: string; block_number: number; block_hash: string; checked: number; selected: number };
      preparation: Record<string, unknown>; traits: Array<Record<string, unknown>>; randomCalls: number;
      tokenCalls: Array<{ ids: string[]; block: { blockHash: string; requireCanonical: boolean } }>;
    };
    const stuck = await request<ActivationEvidence>('activation-evidence');
    assert.equal(stuck.activation.checked, 100);
    assert.equal(stuck.draws.length, 118);
    assert.ok(stuck.draws.slice(100).every(row => row.live === null));
    await request('reopen');
    assert.match((await request<{ error: string }>('activate', 409)).error, /Ethereum changed/);
    const refreshed = await request('refresh-activation');
    assert.equal(refreshed.activationChecked, 0);
    assert.equal(refreshed.activationSelected, 0);
    const reset = await request<ActivationEvidence>('activation-evidence');
    assert.deepEqual(reset.draws, stuck.draws.map(row => ({ ...row, live: null })));
    assert.deepEqual(reset.preparation, stuck.preparation);
    assert.deepEqual(reset.traits, stuck.traits);
    assert.equal(reset.activation.block_number, 502);
    assert.equal(reset.randomCalls, stuck.randomCalls);
    assert.deepEqual(await request('reopen'), refreshed);
    assert.deepEqual(await request<ActivationEvidence>('activation-evidence'), reset);
    assert.equal((await request('activate')).activationChecked, 100);
    const rechecked = await request<ActivationEvidence>('activation-evidence');
    assert.equal(rechecked.randomCalls, stuck.randomCalls);
    assert.deepEqual(rechecked.tokenCalls.at(-1)!.ids, stuck.draws.slice(0, 100).map(row => row.token_id));
    assert.deepEqual(rechecked.tokenCalls.at(-1)!.block, { blockHash: reset.activation.block_hash, requireCanonical: true });
    assert.equal((await request('activate')).phase, 'publishing');
    const allocated = await request<ActivationEvidence>('activation-evidence');
    assert.equal(allocated.randomCalls, stuck.randomCalls);
    assert.deepEqual(allocated.draws, stuck.draws.map(row => ({ ...row, live: 1 })));
    assert.deepEqual(allocated.tokenCalls.at(-1)!.ids, stuck.draws.slice(100).map(row => row.token_id));
    assert.match((await request<{ error: string }>('refresh-activation', 409)).error, /Only an unallocated activation/);
    assert.match((await request<{ error: string }>('refresh-scan', 409)).error, /unfinished scan/);
    assert.deepEqual(await request<ActivationEvidence>('activation-evidence'), allocated);
    assert.equal((await request('activate')).readyCount, 118);
    assert.equal((await request('publish')).published, 118);
    while ((await request('verify')).verificationCursor !== null) {}
    assert.match((await request<{ error: string }>('complete', 409)).error, /two verification passes/);
    await request('clock');
    while ((await request('verify')).verificationCursor !== null) {}
    const completed = await request('complete');
    assert.equal(completed.complete, true);
    assert.equal(completed.staged, 9);
    assert.equal('grailIds' in completed, false);
    assert.equal('candidateTokenIds' in completed, false);
    assert.deepEqual(await request('evidence'), { candidates: 0, traits: 0, activationCandidates: 0, activationChecked: 118, tokens: 118, passes: 2 });
    assert.deepEqual(await request('reopen'), completed);
    const firstPage = await request('verify');
    assert.equal(firstPage.complete, true);
    assert.equal(firstPage.phase, 'complete');
    assert.notEqual(firstPage.verificationCursor, null);
    await request('remove-metadata');
    assert.match((await request<{ error: string }>('verify', 409)).error, /missing or oversized/);
    assert.deepEqual(await request('reopen'), firstPage);
    await request('restore-metadata');
    while ((await request('verify')).verificationCursor !== null) {}
    assert.deepEqual(await request('status'), completed);
    assert.notEqual((await request('verify')).verificationCursor, null);
    while ((await request('verify')).verificationCursor !== null) {}
    assert.deepEqual(await request('status'), completed);
    assert.deepEqual(await request('evidence'), { candidates: 0, traits: 0, activationCandidates: 0, activationChecked: 118, tokens: 118, passes: 4 });
    const hatched = await request('hatch');
    assert.equal(hatched.phase, 'complete');
    assert.equal(hatched.hatched, 1);
    assert.equal(hatched.pendingEnrichment, 1);
    assert.equal(hatched.failedEnrichment, 0);
    const basePublished = await request('publish');
    assert.equal(basePublished.published, 118);
    assert.equal(basePublished.retrying, 0);
    assert.match((await request<{ error: string }>('verify', 409)).error, /enrichment is incomplete/);
    const failed = await request('enrich');
    assert.equal(failed.pendingEnrichment, 1);
    assert.equal(failed.failedEnrichment, 1);
    assert.match((await request<{ error: string }>('verify', 409)).error, /failed trait enrichments/);
    assert.match((await request<{ error: string }>('complete', 409)).error, /failed trait enrichments/);
    assert.equal((await request('reopen')).phase, 'complete');
    const recovered = await request('recover-traits');
    assert.equal(recovered.pendingEnrichment, 0);
    assert.equal(recovered.failedEnrichment, 0);
    await request('publish');
    assert.notEqual((await request('verify')).verificationCursor, null);
    while ((await request('verify')).verificationCursor !== null) {}
    assert.equal((await request('complete')).complete, true);
    assert.deepEqual(await request('evidence'), { candidates: 0, traits: 0, activationCandidates: 0, activationChecked: 118, tokens: 118, passes: 5 });
  } finally { await runtime.dispose(); }
});
