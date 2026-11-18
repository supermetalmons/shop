import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { getInstalledMixedAllocation } from '../shared/ethereum/installedMixedAllocation.ts';
import { MIXED_MAINNET_BATCH_ID, type MixedAllocationMaintenanceRequest, type MixedAllocationMaintenanceResult } from '../shared/ethereum/mixedAllocationMaintenance.ts';
import type { EthereumRevealDeployment } from '../shared/ethereum/revealDeployment.ts';
import { mixedAllocationControlMain } from '../scripts/ops/ethereumMixedAllocationControl.ts';
import { withEthereumRevealMaintenance } from '../scripts/shared/ethereumRevealMaintenance.ts';

const { definition } = getInstalledMixedAllocation();
const deployment: EthereumRevealDeployment = {
  deploymentId: 'mainnet-v1', dropId: '111k', chainId: 1, contractAddress: '0x08cded8258730bda384ff198001e47a1b50f7f9d',
  metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 26387160, catalogVersion: '111k-v8',
  templateJson: '{}', templateSha256: 'a'.repeat(64), state: 'active', revision: 9, createdAtMs: 1, updatedAtMs: 3,
  activatedAtMs: 3, provisionedAtMs: 2, lastError: null, effectiveCatalogVersion: definition.predecessor.catalogVersion,
  effectiveCatalogSha256: definition.predecessor.manifestSha256, catalogRevision: 1, catalogUpdateId: null,
};
function status(override: Partial<MixedAllocationMaintenanceResult> = {}): MixedAllocationMaintenanceResult {
  return { deploymentId: 'mainnet-v1', batchId: MIXED_MAINNET_BATCH_ID, phase: 'unstarted', readyCount: 424,
    grailCount: 424, candidates: 500, scanned: 500, total: 500, staged: 6586,
    generationSeeded: 111111, futureCount: 6162, activationChecked: 424, activationSelected: 424, published: 424,
    hatched: 2, retrying: 0, conflicts: 0, pendingEnrichment: 0, failedEnrichment: 0,
    verificationPasses: 0, verificationInProgress: false, observationUntilMs: null, retryAfterMs: 1, complete: false,
    registryRevision: 9, catalogRevision: 1, catalogUpdateId: null, targetVersion: definition.target.catalogVersion,
    targetSha256: definition.target.manifestSha256, sourceSha256: definition.sourceSha256, ...override };
}
async function journalPath(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(),'mixed-operator-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  return join(dir,'mainnet.journal.json');
}

test('mixed command preserves the source-bound operation across a lost activation and monotonically finishes both verification passes and cleanup', async t => {
  const path = await journalPath(t);
  let progress = status(), now = 1000, prune = 0, verifies = 0;
  const seen: string[] = [];
  const transport = async (r: MixedAllocationMaintenanceRequest) => {
    seen.push(r.action);
    assert.deepEqual(r,{ action:r.action, deploymentId:'mainnet-v1', batchId:MIXED_MAINNET_BATCH_ID,expectedRevision:9 });
    if (r.action === 'begin') {
      const j = JSON.parse(await readFile(path,'utf8'));
      assert.equal(j.expectedRevision,9); assert.equal(j.definitionSha256.length,64);
      progress = { ...progress, phase:'scanning',catalogUpdateId:r.batchId,registryRevision:10 };
    }
    if (r.action === 'scan') progress.phase='staging';
    if (r.action === 'stage') progress.phase='prepared';
    if (r.action === 'activate') {
      progress={...progress,phase:'publishing',catalogRevision:2,registryRevision:11};
      throw new Error('Network connection lost after activation');
    }
    if (r.action === 'verify') {
      verifies++;
      progress.verificationInProgress = verifies % 2 === 1;
      if (!progress.verificationInProgress) {
        progress.verificationPasses++;
        if (progress.phase === 'publishing') { progress.phase='observing'; progress.observationUntilMs=now+300_000; }
        else assert.ok(now >= progress.observationUntilMs!);
      }
    }
    if (r.action === 'complete') {
      assert.equal(progress.verificationPasses,2);
      if (++prune === 3) progress={...progress,phase:'complete',registryRevision:12,catalogUpdateId:null,complete:true};
    }
    return {...progress,privateAssignments:['private']};
  };
  const result=await mixedAllocationControlMain(['apply','--expected-revision','9','--write','--journal',path], {
    registry:async()=>deployment,transport,now:()=>now,sleep:async ms=>{ now+=ms; },
  });
  assert.equal(result.complete,true);
  assert.equal(seen.filter(k=>k==='begin').length,1);
  assert.equal(seen.filter(k=>k==='activate').length,1);
  assert.equal(verifies,4);
  assert.equal(prune,3);
  assert.equal('privateAssignments' in result,false);
  assert.equal((await stat(path)).mode & 0o777,0o600);
  const journal=await readFile(path,'utf8');
  const resumed=await mixedAllocationControlMain(['apply','--write','--journal',path],{registry:async()=>({...deployment,revision:12,
    catalogRevision:2,effectiveCatalogVersion:definition.target.catalogVersion,effectiveCatalogSha256:definition.target.manifestSha256}),transport});
  assert.deepEqual(resumed,result); assert.equal(await readFile(path,'utf8'),journal);
  await assert.rejects(mixedAllocationControlMain(['apply','--expected-revision','12','--write','--journal',path],{
    registry:async()=>deployment,transport:async()=>{throw new Error('Unexpected remote request');}
  }),/original journal revision/);
});

test('mixed operation rejects wrong registry identity, a changed revision, foreign lease or ambiguous write before transport', async t => {
  const path=await journalPath(t);
  const transport=async()=>{throw new Error('Unexpected transport');};
  for (const args of [['apply'],['status','--write'],['apply','--write','--expected-revision','9.1'],
    ['freeze','--write'],['apply','--write','--write']]) {
    await assert.rejects(mixedAllocationControlMain([...args,'--journal',path],{registry:async()=>deployment,transport}),/Usage/);
  }
  for (const patch of [{state:'paused' as const},{chainId:11155111},{contractAddress:'0x'+'1'.repeat(40)},
    {metadataBaseUri:'https://other/'},{catalogUpdateId:'other-op'},{revision:10},{effectiveCatalogSha256:'f'.repeat(64)}]){
    await assert.rejects(mixedAllocationControlMain(['apply','--expected-revision','9','--write','--journal',path],{
      registry:async()=>({...deployment,...patch}),transport
    }),/readiness changed|original.*revision/);
  }
  await assert.rejects(stat(path),{code:'ENOENT'});
});

test('mixed status and remote binding return only aggregate fields from non-enumerable linked results', async t=>{
  const path=await journalPath(t), expected=status();
  const proxied=new Proxy({...expected,verificationCursor:'755',mappings:[1]},{ownKeys:()=>[]});
  const args=['status','--journal',path];
  const result=await withEthereumRevealMaintenance(transport=>mixedAllocationControlMain(args,{
    registry:async()=>deployment,transport:r=>transport.mixedAllocation!(r)
  }),async()=>({env:{REVEAL_MAINTENANCE:{
    mixedAllocation:async r=>{assert.equal(r.action,'status');return proxied;},
    inspectRetired:async()=>{throw new Error('Unused');},purgeRetired:async()=>{throw new Error('Unused');}
  }},dispose:async()=>{}}));
  assert.deepEqual(result,expected);
  await assert.rejects(stat(path),{code:'ENOENT'});
});

test('mixed apply cannot declare completion with incomplete evidence and never stages after a cancelled status', async t=>{
  const path=await journalPath(t);
  const args=['apply','--write','--expected-revision','9','--journal',path];
  for(const result of [status({phase:'complete',complete:true}),status({phase:'cancelled'}),status({failedEnrichment:1}),status({targetSha256:'0'.repeat(64)})]) {
    await assert.rejects(mixedAllocationControlMain(args,{registry:async()=>deployment,transport:async r=>{
      assert.equal(r.action,'status');return result;
    }}),/Unexpected mixed|cancelled|enrichment conflicts/);
  }
});

test('mixed recovery commands keep the original revision and return aggregate completion only after their last page', async t => {
  const path = await journalPath(t);
  const run = async (command: string, initial: MixedAllocationMaintenanceResult, replies: MixedAllocationMaintenanceResult[]) => {
    const actions: string[] = [];
    const result = await mixedAllocationControlMain([command, '--write', '--expected-revision', '9', '--journal', path], {
      registry: async () => deployment, sleep: async () => {},
      transport: async request => {
        assert.equal(request.expectedRevision, 9);
        actions.push(request.action);
        return request.action === 'status' ? initial : replies.shift()!;
      },
    });
    assert.equal(replies.length, 0);
    return { actions, result };
  };
  const completed = status({ phase: 'complete', complete: true, registryRevision: 12, catalogRevision: 2, verificationPasses: 2 });
  const verified = await run('verify', completed, [
    { ...completed, verificationInProgress: true },
    { ...completed, verificationPasses: 3 },
  ]);
  assert.deepEqual(verified.actions, ['status', 'verify', 'verify']);
  assert.equal(verified.result.verificationPasses, 3);
  const cancel = await run('cancel', status({ phase: 'prepared' }), [
    status({ phase: 'cancelled', remainingCleanup: 12 }), status({ phase: 'cancelled', remainingCleanup: 0 }),
  ]);
  assert.deepEqual(cancel.actions, ['status', 'cancel', 'cancel']);
  const refresh = await run('refresh-activation', status({ phase: 'activating' }), [status({ phase: 'activating', activationChecked: 0 })]);
  assert.deepEqual(refresh.actions, ['status', 'refresh-activation']);
});

test('both underfilled scan phases direct apply to refresh the frozen batch', async t => {
  const path = await journalPath(t);
  const args = ['--expected-revision','9','--write','--journal',path];
  for (const phase of ['scanning','staging'] as const) {
    const short = status({ phase, scanned: 500, total: 500, candidates: 423 });
    const actions: string[] = [];
    const dependencies = { registry: async () => deployment, transport: async (request: MixedAllocationMaintenanceRequest) => {
      actions.push(request.action);
      return request.action === 'refresh-scan' ? status({ phase: 'scanning', scanned: 0, total: 501, candidates: 0 }) : short;
    } };
    await assert.rejects(mixedAllocationControlMain(['apply', ...args], dependencies), /refresh-scan --write with this journal/);
    assert.equal((await mixedAllocationControlMain(['refresh-scan', ...args], dependencies)).scanned, 0);
    assert.deepEqual(actions, ['status','status','refresh-scan']);
  }
});

test('an opaque Cloudflare reference error reconnects from authoritative progress with a bounded retry budget', async t => {
  const path = await journalPath(t);
  const args = ['apply', '--write', '--expected-revision', '9', '--journal', path];
  const opaque = new Error('internal error; reference = 0123456789abcdefghijklmn');
  const completed = status({ phase: 'complete', complete: true, registryRevision: 12, catalogRevision: 2, verificationPasses: 2 });
  const calls: string[] = [];
  const sleeps: number[] = [];
  let complete = false;
  const result = await mixedAllocationControlMain(args, {
    registry: async () => deployment, sleep: async ms => { sleeps.push(ms); },
    transport: async request => {
      assert.equal(request.expectedRevision, 9);
      calls.push(request.action);
      if (request.action === 'status') return complete ? completed : status({ phase: 'observing', verificationPasses: 2 });
      assert.equal(request.action, 'complete');
      assert.equal(JSON.parse(await readFile(path, 'utf8')).expectedRevision, 9);
      complete = true;
      throw opaque;
    },
  });
  assert.deepEqual(result, completed);
  assert.deepEqual(calls, ['status', 'complete', 'status']);
  assert.deepEqual(sleeps, [1000]);

  calls.length = 0;
  await assert.rejects(mixedAllocationControlMain(args, {
    registry: async () => deployment, sleep: async () => {},
    transport: async request => { calls.push(request.action); throw opaque; },
  }), opaque);
  assert.deepEqual(calls, ['status', 'status', 'status', 'status']);
});

test('a lost first claim keeps the default journal and accepts an explicitly bound retry journal', async t => {
  const first = await journalPath(t);
  const retry = await journalPath(t);
  let revision = 9;
  const released = status({ phase: 'complete', complete: true, registryRevision: 13, catalogRevision: 2, verificationPasses: 2 });
  const transport = async (request: MixedAllocationMaintenanceRequest) => {
    if (request.expectedRevision !== revision) throw new Error('Initial mixed claim lost.');
    if (request.action === 'status') return status({ registryRevision: revision });
    assert.equal(request.action, 'begin');
    if (revision === 9) {
      revision++;
      throw new Error('Initial mixed claim lost.');
    }
    assert.equal(JSON.parse(await readFile(retry, 'utf8')).expectedRevision, revision);
    return released;
  };
  const deps = { defaultJournalPath: first, registry: async () => ({ ...deployment, revision }), transport };
  await assert.rejects(mixedAllocationControlMain(['apply','--write','--expected-revision','9'], deps), /claim lost/);
  const initialBytes = await readFile(first, 'utf8');
  assert.equal(JSON.parse(initialBytes).expectedRevision, 9);
  await assert.rejects(mixedAllocationControlMain(['apply','--write'], deps), /claim lost/);
  await assert.rejects(mixedAllocationControlMain(['apply','--write','--expected-revision','10'], deps), /original journal revision/);
  const args = ['--expected-revision','10','--journal',retry];
  assert.equal((await mixedAllocationControlMain(['status',...args], deps)).phase, 'unstarted');
  assert.equal((await mixedAllocationControlMain(['apply','--write',...args], deps)).complete, true);
  assert.equal(await readFile(first, 'utf8'), initialBytes);
});

test('the completed journal can audit a previous release while the registry belongs to a later operation', async t => {
  const path = await journalPath(t);
  let registry = deployment;
  const completed = status({ phase: 'complete', complete: true, registryRevision: 12, catalogRevision: 2, verificationPasses: 2 });
  const deps = { defaultJournalPath: path, registry: async () => registry };
  await mixedAllocationControlMain(['apply','--write','--expected-revision','9'], { ...deps, transport: async () => completed });
  registry = { ...deployment, revision: 15, catalogRevision: 3, effectiveCatalogVersion: '111k-v11',
    effectiveCatalogSha256: '1'.repeat(64), catalogUpdateId: 'later-operation' };
  const actions: string[] = [];
  const transport = async (request: MixedAllocationMaintenanceRequest) => {
    actions.push(request.action);
    assert.equal(request.expectedRevision, 9);
    return { ...completed, catalogRevision: 3, registryRevision: 15, catalogUpdateId: 'later-operation',
      verificationPasses: request.action === 'verify' ? 3 : 2 };
  };
  assert.equal((await mixedAllocationControlMain(['status'], { ...deps, transport })).complete, true);
  assert.equal((await mixedAllocationControlMain(['verify','--write'], { ...deps, transport })).verificationPasses, 3);
  await assert.rejects(mixedAllocationControlMain(['apply','--write'], { ...deps, transport }), /ownership or readiness/);
  assert.deepEqual(actions, ['status','status','verify']);
});

test('apply finishes a fresh audit after a holder hatches between status and completion', async t => {
  const path = await journalPath(t);
  const healthy = status({ phase: 'observing', verificationPasses: 2, registryRevision: 11, catalogRevision: 2,
    catalogUpdateId: MIXED_MAINNET_BATCH_ID });
  const pending = { ...healthy, published: 423, retrying: 1, verificationInProgress: true };
  const audited = { ...healthy, verificationPasses: 3 };
  const completed = { ...audited, phase: 'complete' as const, complete: true, catalogUpdateId: null, registryRevision: 12 };
  const steps = [
    ['status', healthy], ['complete', pending], ['verify', pending], ['verify', audited],
    ['complete', { ...completed, verificationInProgress: true }], ['verify', { ...completed, verificationPasses: 4 }],
  ] as const;
  let i = 0;
  const result = await mixedAllocationControlMain(['apply','--expected-revision','9','--write','--journal',path], {
    registry: async () => deployment, sleep: async () => {},
    transport: async request => {
      const [action, response] = steps[i++];
      assert.equal(request.action, action);
      return response;
    },
  });
  assert.equal(result.complete, true);
  assert.equal(i, steps.length);
});

test('historical verification waits for republished metadata and a subsequent healthy pass', async t => {
  const path = await journalPath(t);
  const done = status({ phase: 'complete', complete: true, verificationPasses: 2, registryRevision: 12, catalogRevision: 2 });
  const pending = { ...done, verificationPasses: 3, published: 423, retrying: 1 };
  const published = { ...done, verificationPasses: 3 };
  const replies = [done, pending, published, { ...published, verificationPasses: 4 }];
  const actions: string[] = [];
  const result = await mixedAllocationControlMain(['verify','--expected-revision','9','--write','--journal',path], {
    registry: async () => deployment, sleep: async () => {},
    transport: async request => { actions.push(request.action); return replies.shift()!; },
  });
  assert.equal(result.verificationPasses, 4);
  assert.deepEqual(actions, ['status','verify','status','verify']);
});
