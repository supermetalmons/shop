import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { duplicateCorrectionDefinition as def, duplicateCorrectionDefinitionSha256 as proof } from '../../../../shared/ethereum/installedDuplicateCorrection.ts';
import { parseTwinMetadataRequest,
  type TwinMetadataCohortRow, type TwinMetadataMaintenanceRequest } from '../../../../shared/ethereum/twinMetadataMaintenance.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import type { RevealCanonicalMetadata } from '../src/ethereumRevealCatalogTypes.ts';
import { applyTwinMetadata, hasTwinAnnotations } from '../src/ethereumRevealTwinAnnotations.ts';
import type { RevealSql } from '../src/ethereumRevealStore.ts';
import { EthereumTwinMetadataOperation } from '../src/ethereumTwinMetadata.ts';

const TWIN_METADATA_OPERATION = 'mainnet-revealed-twins-20261119';
const twinMetadataCohortHash = (rows: TwinMetadataCohortRow[]) => digest(JSON.stringify(rows.map(row=>[row.tokenId,row.paintingId,row.role,row.beforeSha256,row.etag])));
const digest = (text:string, algorithm='sha256') => createHash(algorithm).update(text).digest('hex');
type FakeObject = {body:string;etag:string;customMetadata:Record<string,string>};
const headers = {contentType:'application/json; charset=utf-8',cacheControl:'no-store'};
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql: RevealSql = {exec(query,...bindings) {
    const stmt=db.prepare(query);
    const args = bindings.map(b=>b instanceof ArrayBuffer ? new Uint8Array(b) : b) as SQLInputValue[];
    const rows=stmt.columns().length ? stmt.all(...args) : (stmt.run(...args),[]);
    return {toArray:()=>rows as never[]};
  }};
  const deployment = {deploymentId:def.deploymentId,chainId:1,contractAddress:def.contractAddress,metadataBaseUri:def.metadataBaseUri,
    deploymentBlock:def.deploymentBlock,catalogVersion:def.originCatalogVersion,effectiveCatalogVersion:def.catalogVersion,
    effectiveCatalogSha256:def.manifestSha256,revision:15,catalogRevision:3} as EthereumRevealDeployment;
  db.exec(`CREATE TABLE settings(id,ready,catalog_revision,effective_catalog_version,effective_catalog_sha256,candidate_catalog_generation,deployment_json);
    CREATE TABLE reveal_duplicate_corrections(operation_id,definition_sha256,protected_counts);
    CREATE TABLE assignments(category,asset_id,token_id,assignment_revision);
    CREATE TABLE owner_hatching_artwork_claims(category,asset_id,token_id);
    CREATE TABLE owner_hatching_tokens(token_id,status,metadata_revision);
    CREATE TABLE owner_hatching_publication(token_id,status,metadata_revision);
    CREATE TABLE owner_hatching_enrichment(token_id,status);
    CREATE TABLE owner_hatching_slot_overrides(origin_category,origin_asset_id);
    CREATE TABLE reveal_duplicate_replacements(origin_category,origin_asset_id);
    CREATE TABLE publication(token_id,status);
    CREATE TABLE reveal_enrichment(token_id,version,assignment_revision,status)`);
  db.prepare('INSERT INTO settings VALUES(1,1,3,?,?,NULL,?)').run(def.catalogVersion,def.manifestSha256,JSON.stringify(deployment));
  const baseline=def.groups.map((_,i)=>i<3?2:0);
  db.prepare('INSERT INTO reveal_duplicate_corrections VALUES(?,?,?)').run(def.operationId,proof,JSON.stringify(baseline));
  const originals=new Map<string,RevealCanonicalMetadata>(), objects=new Map<string,FakeObject>();
  const rows:TwinMetadataCohortRow[]=[];
  const tokens=[['100','9'],['21','22'],['31','32']];
  for (const [i, ids] of def.groups.slice(0,3).entries()) for (const [j,id] of ids.slice(0,2).entries()) {
    const tokenId=tokens[i][j], owner=i===1 && j===0;
    if (owner) {
      db.prepare("INSERT INTO owner_hatching_artwork_claims VALUES('painting',?,?)").run(id,tokenId);
      db.prepare("INSERT INTO owner_hatching_tokens VALUES(?,'hatched',3)").run(tokenId);
      db.prepare("INSERT INTO owner_hatching_publication VALUES(?,'published',3)").run(tokenId);
      db.prepare("INSERT INTO owner_hatching_enrichment VALUES(?,'complete')").run(tokenId);
    } else {
      db.prepare("INSERT INTO assignments VALUES('painting',?,?,1)").run(id,tokenId);
      db.prepare("INSERT INTO publication VALUES(?,'published')").run(tokenId);
      db.prepare("INSERT INTO reveal_enrichment VALUES(?,'v0',1,'published')").run(tokenId);
    }
    const image=`https://cdn.lil.org/nft/111k/paintings/${id}.png`;
    const json=`{"image":"${image}", "attributes":[{ "trait_type":"x","value":1.230000000000000000001 }]}\n`;
    const etag=digest(json,'md5'),targetSha256=digest(json);
    originals.set(tokenId,{tokenId,category:'painting',assetId:id,metadataJson:json,targetSha256,assignmentRevision:1,
      metadataRevision:3,allowMissing:false,migration:false,expectedJsons:[],artwork:{tokenId,crateTokenId:'111112',name:'Test painting',category:'painting',image,metadataRevision:3,
        aspectRatio:{width:1,height:1},observation:{transactionHash:'0x'+'1'.repeat(64),blockNumber:1,blockHash:'0x'+'2'.repeat(64)}}});
    objects.set(`111k/${tokenId}.json`,{body:json,etag,customMetadata:{preserved:'yes',sha256:targetSha256}});
    const role=Number(tokenId)===Math.min(...tokens[i].map(Number))?'good twin':'evil twin';
    rows.push({tokenId,paintingId:id,role,beforeSha256:targetSha256,etag});
  }
  rows.sort((a,b)=>Number(a.tokenId)-Number(b.tokenId));
  const identity={operationId:TWIN_METADATA_OPERATION,deploymentId:def.deploymentId,expectedRevision:15,cohortSha256:twinMetadataCohortHash(rows)};
  const state={writes:0,failAfterPut:false,casMiss:false};
  const bucket={
    async get(key:string){
      const o=objects.get(key);
      return o && {size:Buffer.byteLength(o.body),etag:o.etag,httpMetadata:headers,customMetadata:o.customMetadata,
        arrayBuffer:async()=>new TextEncoder().encode(o.body).buffer};
    },
    async put(key:string,body:string,options:{onlyIf:{etagMatches:string};customMetadata:Record<string,string>}) {
      if (state.casMiss || options.onlyIf.etagMatches!==objects.get(key)?.etag) return null;
      objects.set(key,{body,etag:digest(body,'md5'),customMetadata:options.customMetadata});state.writes++;
      if (state.failAfterPut) {state.failAfterPut=false;throw new Error('Lost acknowledgement');}
      return {};
    },
  } as unknown as R2Bucket;
  const host={sql,transaction:<T>(fn:()=>T) => {db.exec('BEGIN');try {const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}},
    canonical:(id:string)=>{const result=new Map([[id,originals.get(id)!]]);if(hasTwinAnnotations(sql)) applyTwinMetadata(sql,result);return result.get(id);},
    bucket,current:async()=>deployment};
  return {rows,identity,state,db,objects,deployment,run:(action:TwinMetadataMaintenanceRequest['action'], extra:Partial<TwinMetadataMaintenanceRequest>={})=>
    new EthereumTwinMetadataOperation(host).run(parseTwinMetadataRequest({...identity,action,...extra}))};
}

test('pins every eligible role, includes claimed paintings, restarts between pages and permits later read-only verification',async t=>{
  const f=fixture(t);
  assert.equal((await f.run('inspect')).phase,'unstarted');
  assert.equal((await f.run('prepare',{rows:f.rows})).published,0);
  assert.equal(f.state.writes,0);
  assert.equal((await f.run('prepare',{rows:f.rows})).groups,3);
  assert.throws(()=>f.db.exec("UPDATE reveal_twin_annotations SET role='good twin'"),/immutable/);
  assert.throws(()=>f.db.exec('DELETE FROM reveal_twin_annotations'),/immutable/);
  f.state.failAfterPut=true;
  await assert.rejects(f.run('advance'),/Lost acknowledgement/);
  assert.equal((await f.run('inspect')).published,0);
  assert.equal((await f.run('advance')).published,4);
  assert.equal((await f.run('advance')).phase,'complete');
  assert.equal(f.state.writes,6);
  assert.equal((await f.run('advance')).checked,0);
  f.deployment.revision++;
  const first=await f.run('verify');
  assert.equal(first.registryRevision,16);assert.equal(first.checked,4);assert.equal(first.next,4);
  const last=await f.run('verify',{after:first.next!});assert.equal(last.checked,2);assert.equal(last.next,null);
  for(const row of f.rows){
    const o=f.objects.get(`111k/${row.tokenId}.json`)!;
    assert.deepEqual(JSON.parse(o.body).attributes.at(-1),{trait_type:row.role,value:true});
    assert.ok(o.body.includes('1.230000000000000000001'));
    assert.equal(o.customMetadata.preserved,'yes');
    assert.equal(o.customMetadata.sha256,digest(o.body));
    assert.equal(o.customMetadata.revealMetadataRevision,'4');
  }
});

test('rejects incomplete/wrong role or stale manifest without staging any partial annotations',async t=>{
  const f=fixture(t);
  for (const rows of [f.rows.slice(1),f.rows.map((r,i)=>i? r:{...r,role:'evil twin' as const}),f.rows.map((r,i)=>i? r:{...r,beforeSha256:'f'.repeat(64)})]){
    await assert.rejects(f.run('prepare',{rows,cohortSha256:twinMetadataCohortHash(rows)}),/cohort|predecessor/);
    assert.equal((await f.run('inspect')).phase,'unstarted');
  }
  assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'reveal_twin_%'").get()!.n,0);
});

test('uses original conditional ETag, rejects foreign bytes, and reconciles exact canonical generic-writer bytes',async t=>{
  const f=fixture(t);
  await f.run('prepare',{rows:f.rows});
  f.state.casMiss=true;
  await assert.rejects(f.run('advance'),/conditional write conflicted/);
  f.state.casMiss=false;
  const key=`111k/${f.rows[0].tokenId}.json`, obj=f.objects.get(key)!;
  obj.body='{}';
  await assert.rejects(f.run('advance'),/predecessor/);
  assert.equal(f.state.writes,0);
  const stored=f.db.prepare('SELECT target_json FROM reveal_twin_annotations WHERE token_id=?').get(f.rows[0].tokenId)!;
  obj.body=String(stored.target_json);obj.etag=digest(obj.body,'md5');obj.customMetadata={generic:'preserved'};
  assert.equal((await f.run('advance')).published,4);
  assert.equal(f.objects.get(key)!.customMetadata.generic,'preserved');
  assert.equal(f.objects.get(key)!.customMetadata.sha256,digest(obj.body));
});
