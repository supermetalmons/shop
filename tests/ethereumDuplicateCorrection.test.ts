import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { duplicateCorrectionMain } from '../scripts/ops/ethereumDuplicateCorrection.ts';
import { duplicateCorrectionDefinition as d, duplicateCorrectionDefinitionSha256 as digest } from '../shared/ethereum/installedDuplicateCorrection.ts';
import { parseDuplicateCorrectionRequest, type DuplicateCorrectionRequest, type DuplicateCorrectionResult } from '../shared/ethereum/duplicateCorrection.ts';
import type { EthereumRevealDeployment } from '../shared/ethereum/revealDeployment.ts';

const active: EthereumRevealDeployment = { ...d, dropId:'111k', catalogVersion:d.originCatalogVersion, state:'active', revision:12, createdAtMs:1,
  updatedAtMs:1, activatedAtMs:1, provisionedAtMs:1, lastError:null, effectiveCatalogVersion:d.catalogVersion, effectiveCatalogSha256:d.manifestSha256,
  catalogRevision:2, catalogUpdateId:null, templateJson:'{}', templateSha256:'1'.repeat(64) };
const base = { deploymentId:d.deploymentId, operationId:d.operationId, definitionSha256:digest, expectedRevision:12, sourceCatalogRevision:2 };
const counts = { groups:1, paintings:2, revealed:0, reserved:0, keptFree:1, toReplace:1, replaced:0, conflicts:0, extraRevealed:0 };

async function fixture(t:TestContext) {
  const dir = await mkdtemp(join(tmpdir(),'duplicate-correction-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const path = join(dir,'journal.json');
  const registry = { ...active };
  const trace: string[] = [];
  let applied=false;
  return { trace, path, registry, args:['--deployment-id',d.deploymentId,'--journal',path], dependencies:{
    registry:async () => registry,
    preflight: async () => { trace.push('preflight'); return { verifiedAt:'date', definitionSha256:digest, mediaSha256:digest, objects:1024 }; },
    transport:async (request:DuplicateCorrectionRequest) => {
      trace.push(request.action); assert.equal(request.expectedRevision,12); assert.equal(request.definitionSha256,digest);
      if (request.action === 'apply') { applied=true; registry.revision=15; registry.catalogRevision=3; }
      return { ...base, phase:applied?'complete':'unstarted', registryRevision:registry.revision, catalogRevision:registry.catalogRevision,
        privateIds:[1], ledger:{ applied, appliedAtMs:applied?1:null, definitionSha256:digest, operationId:d.operationId,
          catalogRevision:registry.catalogRevision!, totals:counts, pools:[], blocks:[], privateAssignments:['do not disclose'] } } as DuplicateCorrectionResult;
    },
  } };
}

test('duplicate correction CLI inspects without journal writes, preflights apply and verifies with the original private journal', async t => {
  const f=await fixture(t);
  const before=await duplicateCorrectionMain(['status',...f.args],f.dependencies);
  assert.equal(before.phase,'unstarted'); await assert.rejects(stat(f.path),{code:'ENOENT'});
  const result=await duplicateCorrectionMain(['apply',...f.args,'--write','--expected-revision','12'],f.dependencies);
  assert.deepEqual(f.trace,['inspect','inspect','preflight','apply']);
  assert.equal(result.phase,'complete');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal((await stat(f.path)).mode & 0o777,0o600);
  const journal=await readFile(f.path,'utf8');
  await duplicateCorrectionMain(['verify',...f.args],f.dependencies);
  assert.equal(await readFile(f.path,'utf8'),journal);
  await duplicateCorrectionMain(['apply',...f.args,'--write'],f.dependencies);
  assert.deepEqual(f.trace.slice(-3),['verify','inspect','verify']);
  await assert.rejects(duplicateCorrectionMain(['apply',...f.args,'--write','--expected-revision','15'],f.dependencies),/original duplicate correction journal/);
});

test('duplicate correction rejects unsupported scope, writes on inspect and stale definition or registry', async t => {
  const f=await fixture(t);
  for (const args of [['apply',...f.args],['inspect',...f.args,'--write'],['apply','--write'],['status','--deployment-id','v17']]) {
    await assert.rejects(duplicateCorrectionMain(args,f.dependencies),/Usage/);
  }
  await assert.rejects(duplicateCorrectionMain(['apply',...f.args,'--write'],f.dependencies),/original --expected-revision/);
  await assert.rejects(duplicateCorrectionMain(['status',...f.args,'--expected-revision','11'],f.dependencies),/registry owner/);
  assert.throws(() => parseDuplicateCorrectionRequest({...base, action:'inspect', definitionSha256:'a'.repeat(64)},d,digest),/identity/);
  assert.throws(() => parseDuplicateCorrectionRequest({...base, action:'inspect', tokenIds:[]},d,digest),/identity/);
  assert.deepEqual(f.trace,[]);
});

test('duplicate correction refuses a first write when the candidate media check fails',async t=>{
  const f=await fixture(t);
  await assert.rejects(duplicateCorrectionMain(['apply',...f.args,'--write','--expected-revision','12'],{
    ...f.dependencies,preflight:async()=>{throw new Error('Media failed');},
  }),/Media failed/);
  assert.deepEqual(f.trace,['inspect']);
  await assert.rejects(stat(f.path),{code:'ENOENT'});
});
