import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { duplicateCorrectionDefinition as definition, duplicateCorrectionDefinitionSha256 as digest } from '../../../../shared/ethereum/installedDuplicateCorrection.ts';
import type { DuplicateCorrectionRequest } from '../../../../shared/ethereum/duplicateCorrection.ts';
import type { DuplicateCorrectionLedgerResult } from '../../../../shared/ethereum/duplicateCorrectionLedger.ts';
import { runDuplicateCorrection } from '../src/ethereumDuplicateCorrectionOperation.ts';
import { d1Database } from './commerceD1Harness.ts';

const identity = { deploymentId:definition.deploymentId, operationId:definition.operationId, definitionSha256:digest, expectedRevision:12, sourceCatalogRevision:2 };
const counts = { groups:1, paintings:2, revealed:1, reserved:0, keptFree:0, toReplace:1, replaced:0, conflicts:0, extraRevealed:0 };
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const filename of ['0009_ethereum_reveal_deployments', '0011_ethereum_reveal_retirement', '0012_ethereum_reveal_catalog_updates', '0013_mixed_allocation_revisions']) {
    db.exec(readFileSync(`cloud/workers/api/ops-migrations/${filename}.sql`, 'utf8'));
  }
  db.prepare(`INSERT INTO ethereum_reveal_deployments(deployment_id,drop_id,chain_id,contract_address,metadata_base_uri,
    deployment_block,catalog_version,template_json,template_sha256,state,revision,created_at_ms,updated_at_ms,provisioned_at_ms,
    activated_at_ms)
    VALUES(?,'111k',1,?,?,?,?,?,?,'active',6,1,1,1,1)`).run(definition.deploymentId, definition.contractAddress, definition.metadataBaseUri,
    definition.deploymentBlock, definition.originCatalogVersion, JSON.stringify({name:'A',description:'A',image:'a',attributes:[]}),
    'f'.repeat(64));
  for (const [catalog, digest] of [['111k-v9', 'a'.repeat(64)], [definition.catalogVersion, definition.manifestSha256]]) {
    db.exec("UPDATE ethereum_reveal_deployments SET catalog_update_id='previous',catalog_update_started_at_ms=1,revision=revision+1");
    db.prepare('UPDATE ethereum_reveal_deployments SET effective_catalog_version=?,effective_catalog_sha256=?,catalog_revision=catalog_revision+1,revision=revision+1').run(catalog,digest);
    db.exec('UPDATE ethereum_reveal_deployments SET catalog_update_id=NULL,catalog_update_started_at_ms=NULL,revision=revision+1');
  }
  const records = new Map<string,unknown>();
  const result: DuplicateCorrectionLedgerResult = { operationId:identity.operationId, definitionSha256:digest, applied:false, appliedAtMs:null,
    catalogRevision:2, totals:{ ...counts }, pools:[], blocks:[] };
  const state = { commits:0, crash:'', fenced:false };
  const storage = { get:async (k:string) => records.get(k), put:async (k:string,v:unknown) => { records.set(k,v); } } as unknown as DurableObjectStorage;
  const host = { storage, db:d1Database(db, call => {
    if (state.crash && call.sql.includes(state.crash)) { state.crash=''; throw new Error('Simulated lost D1 acknowledgement.'); }
  }), assertAvailable(){ if (state.fenced) throw new Error('Fenced'); },
  ledger(action: DuplicateCorrectionRequest['action']) {
    if (action==='apply') {
      assert.equal(result.applied,false);
      state.commits++;
      result.applied=true; result.appliedAtMs=100; result.catalogRevision=3; result.totals.replaced=1;
    }
    if (action==='verify') assert.ok(result.applied);
    return result;
  } };
  return { db, state, result, records, run:(action:DuplicateCorrectionRequest['action'], override:Partial<DuplicateCorrectionRequest>={}) =>
    runDuplicateCorrection(host, definition, { ...identity, action, ...override }) };
}

test('duplicate correction is read only during inspection and survives loss of each registry write acknowledgement', async t => {
  for (const fault of ['SET catalog_update_id=?,','SET catalog_revision=catalog_revision+1','SET catalog_update_id=NULL']) {
    const f=fixture(t);
    assert.equal((await f.run('inspect')).phase,'unstarted');
    assert.equal(f.records.size,0);
    await assert.rejects(f.run('verify'),/before verification/);
    f.state.crash=fault;
    await assert.rejects(f.run('apply'),/lost D1 acknowledgement/);
    const recovered=await f.run('apply');
    assert.equal(recovered.phase,'complete');
    assert.equal(recovered.catalogRevision,3);
    assert.equal(recovered.registryRevision,15);
    assert.equal(f.state.commits,1);
    assert.equal((await f.run('verify')).ledger.applied,true);
    assert.equal((await f.run('apply')).ledger.applied,true);
    assert.equal(f.state.commits,1);
    await assert.rejects(f.run('apply',{expectedRevision:11}),/original duplicate correction journal/);
  }
});

test('duplicate correction rejects inventory conflict, fencing and changed scope without acquiring registry', async t => {
  const f=fixture(t);
  f.result.totals.conflicts=1;
  await assert.rejects(f.run('apply'),/protected inventory/);
  f.result.totals.conflicts=0; f.state.fenced=true;
  await assert.rejects(f.run('apply'),/Fenced/);
  f.state.fenced=false;
  f.db.exec("UPDATE ethereum_reveal_deployments SET state='paused',revision=revision+1,updated_at_ms=2");
  await assert.rejects(f.run('apply'),/identity or readiness/);
  assert.equal(f.records.size,0);
  assert.equal(f.state.commits,0);
});

test('original correction journal remains read-only after a subsequent catalog release', async t => {
  const f=fixture(t);
  await f.run('apply');
  f.db.exec("UPDATE ethereum_reveal_deployments SET catalog_update_id='new-mixed',catalog_update_started_at_ms=2,revision=revision+1");
  f.db.prepare('UPDATE ethereum_reveal_deployments SET effective_catalog_version=?,effective_catalog_sha256=?,catalog_revision=catalog_revision+1,revision=revision+1')
    .run('111k-v11','b'.repeat(64));
  f.db.exec('UPDATE ethereum_reveal_deployments SET catalog_update_id=NULL,catalog_update_started_at_ms=NULL,revision=revision+1');
  for (const action of ['inspect','verify','apply'] as const) {
    const r=await f.run(action);
    assert.equal(r.phase,'complete'); assert.equal(r.catalogRevision,4); assert.equal(r.registryRevision,18); assert.equal(r.ledger.catalogRevision,3);
  }
  assert.equal(f.state.commits,1);
});
