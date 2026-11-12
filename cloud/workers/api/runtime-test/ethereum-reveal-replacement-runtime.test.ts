import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { withRevealTraitFixture } from './revealTraitFixture.ts';
import { createTestHarness } from 'wrangler';
import { encodeAbi } from '../../../../shared/ethereum/abi.ts';
import { parseEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import type { EthereumRevealReplacementInspection, EthereumRevealRetirementResult } from '../../../../shared/ethereum/revealMaintenance.ts';
import { buildEthereumRevealRegistration, buildEthereumRevealTransition } from '../../../../scripts/ops/ethereumRevealControl.ts';
import { localEthereumRevealBindings } from '../../../../scripts/shared/ethereum111kLocalReveal.ts';
import type { EthereumRevealObject } from '../src/ethereumRevealObject.ts';

type TestObject = EthereumRevealObject & { seedReady(deployment: EthereumRevealDeployment): Promise<void>;
  addFrozen(deployment: EthereumRevealDeployment): Promise<void>; advanceTime(ms: number): Promise<void>; runAlarm(): Promise<void>;
  setPublicationHealth(status: string, error: string | null): Promise<void> };
type TestEnv = Omit<Env, 'ETHEREUM_REVEAL'> & { ETHEREUM_REVEAL: DurableObjectNamespace<TestObject> };
const oldContract = `0x${'11'.repeat(20)}`, replacementContract = `0x${'22'.repeat(20)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

test('native same-catalog replacement retires durably, drains callbacks, preserves a stable active snapshot and purges after 65 seconds', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ethereum-replacement-'));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const rpc = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const { method, params } = JSON.parse(body);
    let result: unknown = null;
    if (method === 'eth_chainId') result = '0xaa36a7';
    else if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'latest' ? 1000 : Number(BigInt(params[0]));
      result = { number: `0x${number.toString(16)}`, hash: hash(number) };
    } else if (method === 'eth_getCode') result = params[1].blockHash === hash(199) ? '0x' : '0x6000';
    else if (method === 'eth_call') result = encodeAbi(['string'], ['https://cdn.mons.shop/111k-sepolia/replacement-native/']);
    else if (method === 'eth_getLogs') result = [];
    else if (method === 'eth_getTransactionReceipt' && params[0] === hash(999)) { entered.resolve(); await release.promise; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
  await new Promise<void>(done => rpc.listen(0, '127.0.0.1', done));
  const address = rpc.address();
  assert.ok(address && typeof address === 'object');
  const main = join(directory, 'api.ts'), callerMain = join(directory, 'caller.ts');
  await writeFile(main, `
    export { default, AdminIrlRedeemFinalizeWorkflowV1, StripeReceiptClaimWorkflowV1, StripeChargebackMaintenance,
      EthereumRevealMaintenance, EthereumRevealPublisherObject, EthereumRevealVerifierObject,
      EthereumProviderBudgetObject, EthereumPublicReadCacheObject }
      from ${JSON.stringify(resolve('cloud/workers/api/src/index.ts'))};
    import { EthereumRevealObject as Base } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealObject.ts'))};
    import { EthereumRevealStore } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealStore.ts'))};
    const providerFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => providerFetch(String(input).startsWith('https://eth-sepolia.g.alchemy.com/')
      ? ${JSON.stringify(`http://127.0.0.1:${address.port}/`)} : input, init);
    const actualNow = Date.now;
    let offset = 0;
    Date.now = () => actualNow() + offset;
    export class EthereumRevealObject extends Base {
      constructor(ctx, env) { super(ctx, env); offset = Number(env.REPLACEMENT_TEST_CLOCK || 0); }
      async seedReady(deployment) {
        const store = new EthereumRevealStore(this.ctx.storage.sql, action => this.ctx.storage.transactionSync(action), maximum => maximum - 1);
        store.configure(deployment);
        while (!store.ready()) store.initializeChunk();
        store.freeze(deployment, { transactionHash: ${JSON.stringify(hash(1))}, blockNumber: 201, blockHash: ${JSON.stringify(hash(201))} },
          [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, i) => String(i + 1)) }], Date.now() - 100);
        await this.ctx.storage.setAlarm(Date.now() + 86400000);
      }
      async addFrozen(deployment) {
        const store = new EthereumRevealStore(this.ctx.storage.sql, action => this.ctx.storage.transactionSync(action), () => 0);
        store.configure(deployment);
        store.freeze(deployment, { transactionHash: ${JSON.stringify(hash(2))}, blockNumber: 202, blockHash: ${JSON.stringify(hash(202))} },
          [{ crateTokenId: '111113', tokenIds: Array.from({ length: 20 }, (_, i) => String(i + 21)) }], Date.now());
      }
      async advanceTime(ms) { offset = ms; }
      async alarm() { if (!this.testingPublicationHealth) await super.alarm(); }
      async runAlarm() { await super.alarm(); }
      async setPublicationHealth(status, error) {
        this.testingPublicationHealth = true;
        this.ctx.storage.sql.exec("UPDATE publication SET status=?,last_error=? WHERE token_id='9'", status, error);
      }
    }
  `);
  await writeFile(callerMain, `export default { async fetch(request, env) {
    const method = new URL(request.url).pathname.slice(1);
    if (!['retireForReplacement','cancelRetirement','inspectReplacement','purgeRetired','inspectRetired','backfillAttributes'].includes(method)) return new Response(null,{status:404});
    try { return Response.json(await env.MAINTENANCE[method](await request.json())); }
    catch (error) { return Response.json({error:String(error.message || error)}, {status:409}); }
  } };`);
  const production = JSON.parse(await readFile(resolve('cloud/workers/api/wrangler.jsonc'), 'utf8'));
  const config = { ...production, ...localEthereumRevealBindings(), main,
    vars: { ...production.vars, ...Object.fromEntries((production.secrets?.required || []).map((name: string) => [name, ''])),
      ETHEREUM_111K_CHAIN_ID: '11155111', ETHEREUM_111K_CONTRACT_ADDRESS: replacementContract,
      ETHEREUM_111K_METADATA_BASE_URI: 'https://cdn.mons.shop/111k-sepolia/replacement-native/', ETHEREUM_111K_DEPLOYMENT_BLOCK: '200',
      ALCHEMY_MI_NOTE_API_KEY: 'native-test' },
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({ ...database, remote: false,
      migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)) })),
  };
  delete config.$schema; delete config.account_id; delete config.routes; delete config.secrets;
  const callerConfig = { name: 'replacement-caller', main: callerMain, compatibility_date: production.compatibility_date,
    compatibility_flags: production.compatibility_flags,
    services: [{ binding: 'MAINTENANCE', service: 'mons-shop-api', entrypoint: 'EthereumRevealMaintenance', remote: false }] };
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  t.mock.method(globalThis, 'fetch', withRevealTraitFixture(fetch, () => new Response(null, { status: 503 })));
  const runtime = createTestHarness({ root: directory, workers: [{ config }, { config: callerConfig }] });
  try {
    await runtime.listen();
    const worker = runtime.getWorker<TestEnv>('mons-shop-api'), caller = runtime.getWorker('replacement-caller');
    for (const binding of ['DATA_DB', 'OPS_DB', 'COMMERCE_DB'] as const) await worker.applyD1Migrations(binding);
    let env = await worker.getEnv();
    await env.COMMERCE_DB.prepare(`UPDATE ethereum_111k_control SET paused=0,paused_at_ms=NULL,chain_id=11155111,
      contract_address=?,revision=46 WHERE singleton=1`).bind(replacementContract).run();
    const call = async <T>(method: string, body: unknown): Promise<T> => {
      const response = await caller.fetch(`https://operator/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const value = await response.json() as T & { error?: string };
      if (!response.ok) throw new Error(value.error);
      return value;
    };
    const register = async (deploymentId: string, contractAddress: string, deploymentBlock: number) => {
      const templateJson = '{"name":"{{tokenId}}","description":"","image":"https://cdn.lil.org/nft/111k/placeholder.png","attributes":[]}';
      await env.OPS_DB.prepare(buildEthereumRevealRegistration({ deploymentId, dropId: '111k_devnet', chainId: 11155111,
        contractAddress, metadataBaseUri: `https://cdn.mons.shop/111k-sepolia/${deploymentId}/`, deploymentBlock, catalogVersion: '111k-v5',
        templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex') })).run();
      const row = await env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET state='active',revision=3,
        provisioned_at_ms=2,activated_at_ms=3 WHERE deployment_id=? RETURNING *`).bind(deploymentId).first<Record<string, unknown>>();
      assert.ok(row);
      return parseEthereumRevealDeployment(row);
    };
    const old = await register('old-native', oldContract, 100), replacement = await register('replacement-native', replacementContract, 200);
    const oldName = `11155111:${oldContract}`, newName = `11155111:${replacementContract}`;
    let oldObject = env.ETHEREUM_REVEAL.getByName(oldName), newObject = env.ETHEREUM_REVEAL.getByName(newName);
    await oldObject.seedReady(old);
    await newObject.seedReady(replacement);
    await newObject.watchdog(replacement);
    const replacementRequest = { deploymentId: replacement.deploymentId, expectedRevision: replacement.revision };
    const before = await call<EthereumRevealReplacementInspection>('inspectReplacement', replacementRequest);
    assert.equal(before.frozenArtworks, 20);
    assert.equal(before.frozenSamples.length, 8);
    const cancelledScope = await register('cancel-native', `0x${'44'.repeat(20)}`, 150);
    await env.OPS_DB.prepare("UPDATE ethereum_reveal_deployments SET state='paused',revision=4 WHERE deployment_id='cancel-native'").run();
    await env.OPS_DB.prepare("UPDATE ethereum_reveal_deployments SET last_error='metadata-conflict' WHERE deployment_id='replacement-native'").run();
    await newObject.setPublicationHealth('conflict', 'metadata-conflict');
    const ledger = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name: newName });
    await ledger.exec("DELETE FROM reveal_enrichment WHERE version='v0' AND token_id='1'");
    await env.COMMERCE_DB.prepare('UPDATE ethereum_111k_control SET paused=1,paused_at_ms=1,revision=revision+1').run();
    const page = { ...replacementRequest, afterTokenId: null };
    assert.deepEqual(await call('backfillAttributes', { ...page, write: false }), { eligible: 19, missing: 1, invalid: 0, conflict: 0, conflictRechecks: 0, enqueued: 0, requeued: 0, nextCursor: null });
    assert.deepEqual(await call('backfillAttributes', { ...page, write: true }), { eligible: 19, missing: 1, invalid: 0, conflict: 0, conflictRechecks: 0, enqueued: 1, requeued: 0, nextCursor: null });
    await ledger.exec("UPDATE reveal_enrichment SET status='invalid',last_error='invalid',claim_id=NULL WHERE token_id='19' AND version='v0'");
    const blocked = { eligible: 19, missing: 0, invalid: 1, conflict: 0, conflictRechecks: 0, enqueued: 0, requeued: 0, nextCursor: null };
    assert.deepEqual(await call('backfillAttributes', { ...page, write: true }), blocked);
    assert.deepEqual(await call('backfillAttributes', { ...page, retryBlocked: true, write: false }), blocked);
    assert.deepEqual(await call('backfillAttributes', { ...page, retryBlocked: true, write: true }), { ...blocked, requeued: 1 });
    assert.deepEqual(await call('backfillAttributes', { ...page, retryBlocked: true, write: true }), { ...blocked, invalid: 0 });
    await env.COMMERCE_DB.prepare('UPDATE ethereum_111k_control SET paused=0,paused_at_ms=NULL,revision=revision+1').run();
    await newObject.setPublicationHealth('published', null);
    const cancelRequest = { deploymentId: cancelledScope.deploymentId, expectedRevision: 4,
      replacementDeploymentId: replacement.deploymentId, expectedReplacementRevision: 3 };
    assert.deepEqual(await call('cancelRetirement', cancelRequest), {
      deploymentId: 'cancel-native', replacementDeploymentId: 'replacement-native', revision: 5, cancelled: true, retired: false,
    });
    assert.equal((await env.COMMERCE_DB.prepare("SELECT state FROM ethereum_111k_retirements WHERE deployment_id='cancel-native'")
      .first<{ state: string }>())?.state, 'cancelled');
    await env.OPS_DB.prepare("UPDATE ethereum_reveal_deployments SET last_error=NULL WHERE deployment_id='replacement-native'").run();
    await assert.rejects(call('retireForReplacement', cancelRequest));
    await oldObject.revealTransaction(old, hash(999), true, Date.now() + 25);
    await entered.promise;
    await env.OPS_DB.prepare("UPDATE ethereum_reveal_deployments SET state='paused',revision=4 WHERE deployment_id='old-native'").run();
    const retirementRequest = { deploymentId: old.deploymentId, expectedRevision: 4,
      replacementDeploymentId: replacement.deploymentId, expectedReplacementRevision: 3 };
    for (const [status, error] of [['conflict', 'metadata-conflict'], ['pending', 'publication-unavailable']]) {
      await newObject.setPublicationHealth(status, error);
      assert.equal((await env.OPS_DB.prepare("SELECT last_error FROM ethereum_reveal_deployments WHERE deployment_id='replacement-native'")
        .first<{ last_error: string | null }>())?.last_error, null);
      await assert.rejects(call('inspectReplacement', replacementRequest), /publication is unhealthy/);
      await assert.rejects(call('retireForReplacement', retirementRequest), /publication is unhealthy/);
      assert.equal((await env.OPS_DB.prepare("SELECT retired_at_ms FROM ethereum_reveal_deployments WHERE deployment_id='old-native'")
        .first<{ retired_at_ms: number | null }>())?.retired_at_ms, null);
    }
    await newObject.setPublicationHealth('published', null);
    assert.ok(before.frozenSamples.every(sample => sample.tokenId !== '9'));
    const base = (await ledger.exec<{ metadata_json: string }>("SELECT metadata_json FROM assignments WHERE token_id='9'"))[0].metadata_json;
    const target = JSON.parse(base);
    target.attributes.unshift({ trait_type: 'collection block', value: 'Repair fixture' });
    const repairedTarget = JSON.stringify(target) + '\n';
    const repairedSha = createHash('sha256').update(repairedTarget).digest('hex');
    assert.equal((await ledger.exec(`UPDATE reveal_enrichment SET status='published',last_error=NULL,claim_id=NULL,target_json=?,target_sha256=?
      WHERE token_id='9' AND version='v0' RETURNING token_id`, repairedTarget, '0'.repeat(64))).length, 1);
    await ledger.exec("INSERT INTO reveal_enrichment_acknowledgments(token_id,version,target_sha256) VALUES('9','v0',?)", repairedSha);
    const readEvidence = () => ledger.exec(`SELECT e.*,ack.target_sha256 AS acknowledged_sha256 FROM reveal_enrichment e
      JOIN reveal_enrichment_acknowledgments ack ON ack.token_id=e.token_id AND ack.version=e.version
      WHERE e.token_id='9' AND e.version='v0'`);
    const evidence = await readEvidence();
    const targeted = { ...page, recheckTokenId: '9' };
    await assert.rejects(call('backfillAttributes', { ...targeted, write: false }), /acknowledged enrichment checksum/);
    assert.deepEqual(await readEvidence(), evidence);
    const rejected = await call<{ conflict: number; requeued: number }>('backfillAttributes', { ...targeted, write: true });
    assert.deepEqual([rejected.conflict, rejected.requeued], [1, 0]);
    const [blockedEvidence] = await readEvidence();
    assert.equal(blockedEvidence.status, 'conflict');
    assert.equal(blockedEvidence.last_error, 'conflict');
    assert.equal(blockedEvidence.target_json, repairedTarget);
    assert.equal(blockedEvidence.target_sha256, '0'.repeat(64));
    assert.equal(blockedEvidence.acknowledged_sha256, repairedSha);
    assert.equal(await (await env.ETHEREUM_REVEAL_METADATA.get('111k-sepolia/replacement-native/9.json'))!.text(), base);
    await assert.rejects(call('inspectReplacement', replacementRequest), /attribute publication has a metadata conflict/);
    await assert.rejects(call('retireForReplacement', retirementRequest), /attribute publication has a metadata conflict/);
    assert.equal((await env.OPS_DB.prepare("SELECT retired_at_ms FROM ethereum_reveal_deployments WHERE deployment_id='old-native'")
      .first<{ retired_at_ms: number | null }>())?.retired_at_ms, null);
    await ledger.exec("UPDATE reveal_enrichment SET target_sha256=? WHERE token_id='9' AND version='v0'", repairedSha);
    const repairKey = '111k-sepolia/replacement-native/9.json';
    await env.ETHEREUM_REVEAL_METADATA.put(repairKey, repairedTarget, { httpMetadata: { contentType: 'application/octet-stream' } });
    const repair = await call<{ requeued: number }>('backfillAttributes', { ...page, write: true, retryBlocked: true });
    assert.equal(repair.requeued, 1);
    const rechecks = async () => (await call<{ conflictRechecks: number }>('backfillAttributes', { ...page, write: false })).conflictRechecks;
    assert.equal(await rechecks(), 1);
    await assert.rejects(call('inspectReplacement', replacementRequest), /attribute publication has a metadata conflict/);
    await assert.rejects(call('retireForReplacement', retirementRequest), /attribute publication has a metadata conflict/);
    await ledger.exec("UPDATE reveal_enrichment SET next_check_ms=? WHERE token_id!='9' AND status='pending'", Date.now() + 86_400_000);
    await newObject.watchdog(replacement);
    for (let attempt = 0; ; attempt++) {
      if ((await ledger.exec<{ status: string }>("SELECT status FROM reveal_enrichment WHERE token_id='9'"))[0].status === 'published') break;
      assert.ok(attempt < 300, 'Repaired metadata was not acknowledged');
      await new Promise(done => setTimeout(done, 5));
    }
    const repaired = await env.ETHEREUM_REVEAL_METADATA.get(repairKey);
    assert.ok(repaired);
    assert.equal(await repaired.text(), repairedTarget);
    assert.equal(repaired.httpMetadata?.contentType, 'application/json; charset=utf-8');
    assert.equal(repaired.httpMetadata?.cacheControl, 'no-store');
    assert.equal(await rechecks(), 0);
    let finished = false;
    const retiring = call<EthereumRevealRetirementResult>('retireForReplacement', retirementRequest).then(result => { finished = true; return result; });
    void retiring.catch(() => undefined);
    for (let attempt = 0; ; attempt++) {
      const marker = await env.OPS_DB.prepare("SELECT retired_at_ms FROM ethereum_reveal_deployments WHERE deployment_id='old-native'").first<{ retired_at_ms: number | null }>();
      if (marker?.retired_at_ms) break;
      assert.ok(attempt < 500, 'Retirement marker was not committed');
      await new Promise(done => setTimeout(done, 5));
    }
    assert.equal(finished, false);
    release.resolve();
    const retired = await retiring;
    assert.equal(retired.quiesced, true);
    assert.equal(retired.revision, 5);
    assert.deepEqual(await call('retireForReplacement', retirementRequest), retired);
    assert.deepEqual(await call('cancelRetirement', retirementRequest), {
      deploymentId: 'old-native', replacementDeploymentId: 'replacement-native', revision: 5, cancelled: false, retired: true,
    });
    const purgeRequest = { deploymentId: old.deploymentId, expectedRevision: retired.revision };
    await assert.rejects(call('purgeRetired', purgeRequest), /65 seconds/);
    await assert.rejects(oldObject.revealTokens(old, ['1']));
    await assert.rejects(oldObject.watchdog(old));
    await assert.rejects(env.OPS_DB.prepare("UPDATE ethereum_reveal_deployments SET state='active' WHERE deployment_id='old-native'").run());
    const retiredHttp = await worker.fetch('https://api.mons.shop/ethereum/111k/reveal/tokens', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://vvv.so', 'X-Mons-CSRF': '1' },
      body: JSON.stringify({ chainId: 11155111, contractAddress: oldContract, tokenIds: ['1'] }) });
    assert.equal(retiredHttp.status, 409);
    await oldObject.advanceTime(65_001);
    const purged = await call<{ purged: boolean; storageEmpty: boolean; alarmCleared: boolean }>('purgeRetired', purgeRequest);
    assert.deepEqual([purged.purged, purged.storageEmpty, purged.alarmCleared], [true, true, true]);
    const oldMetadata = await env.ETHEREUM_REVEAL_METADATA.list({ prefix: '111k-sepolia/old-native/' });
    await env.ETHEREUM_REVEAL_METADATA.delete(Array.from({ length: oldMetadata.objects.length }, (_, i) => oldMetadata.objects[i].key));
    await newObject.addFrozen(replacement);
    await newObject.watchdog(replacement);
    assert.deepEqual(await call('inspectReplacement', { ...replacementRequest, frozenThroughMs: before.frozenThroughMs }), before);
    await runtime.update({ root: directory, workers: [{ config: { ...config, vars: { ...config.vars, REPLACEMENT_TEST_CLOCK: '65001' } } }, { config: callerConfig }] });
    env = await worker.getEnv();
    oldObject = env.ETHEREUM_REVEAL.getByName(oldName);
    newObject = env.ETHEREUM_REVEAL.getByName(newName);
    await oldObject.runAlarm();
    const late = { kind: 'receipt' as const, claim: { hash: hash(999), claimId: 'late', startedAtMs: 1, leaseUntilMs: Date.now() + 100_000, active: true } };
    assert.equal(await oldObject.validateReceiptWork(old, late), false);
    assert.equal(await oldObject.recordReceiptPresence(old, late), false);
    await assert.rejects(oldObject.initialize(old));
    await newObject.watchdog(replacement);
    assert.deepEqual(await call('inspectReplacement', { ...replacementRequest, frozenThroughMs: before.frozenThroughMs }), before);
    const finalInspection = await call<{ storageEmpty: boolean }>('inspectRetired', purgeRequest);
    const retiredStorage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name: oldName });
    assert.equal(finalInspection.storageEmpty, true, JSON.stringify(await retiredStorage.exec('SELECT name,type FROM sqlite_schema')));
    assert.equal((await env.ETHEREUM_REVEAL_METADATA.list({ prefix: '111k-sepolia/old-native/' })).objects.length, 0);
    for (const sample of before.frozenSamples) {
      const object = await env.ETHEREUM_REVEAL_METADATA.get(`111k-sepolia/replacement-native/${sample.tokenId}.json`);
      assert.ok(object);
      assert.equal(createHash('sha256').update(await object.text()).digest('hex'), sample.metadataSha256);
    }
    const markerSql = "SELECT revision,retired_at_ms,replacement_deployment_id FROM ethereum_reveal_deployments WHERE deployment_id='old-native'";
    const fenceSql = `SELECT operation_id,expected_revision,expected_replacement_revision,replacement_deployment_id,state,created_at_ms
      FROM ethereum_111k_retirements WHERE deployment_id='old-native'`;
    const marker = await env.OPS_DB.prepare(markerSql).first();
    const fence = await env.COMMERCE_DB.prepare(fenceSql).first();
    let resumed = replacement;
    for (const command of ['pause', 'activate'] as const) {
      const row = await env.OPS_DB.prepare(buildEthereumRevealTransition(command, resumed, resumed.revision)).first<Record<string, unknown>>();
      assert.ok(row);
      resumed = parseEthereumRevealDeployment(row);
      if (command === 'pause') await assert.rejects(call('retireForReplacement', retirementRequest), /Replacement reveal deployment/);
    }
    await env.COMMERCE_DB.prepare('UPDATE ethereum_111k_control SET paused=1,paused_at_ms=1,revision=revision+1 WHERE singleton=1').run();
    await env.COMMERCE_DB.prepare('UPDATE ethereum_111k_control SET paused=0,paused_at_ms=NULL,revision=revision+1 WHERE singleton=1').run();
    assert.equal(resumed.revision, 5);
    assert.deepEqual(await call('retireForReplacement', retirementRequest), retired);
    assert.deepEqual(await env.OPS_DB.prepare(markerSql).first(), marker);
    assert.deepEqual(await env.COMMERCE_DB.prepare(fenceSql).first(), fence);
    assert.deepEqual(await call('inspectReplacement', { ...replacementRequest, expectedRevision: resumed.revision,
      frozenThroughMs: before.frozenThroughMs }), { ...before, revision: resumed.revision });
    const storage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name: newName });
    const sample = before.frozenSamples[0];
    const [{ metadata_json }] = await storage.exec<{ metadata_json: string }>('SELECT metadata_json FROM assignments WHERE token_id=?', sample.tokenId);
    const metadata = JSON.parse(metadata_json);
    const enriched = JSON.stringify({ ...metadata, attributes: [{ trait_type: 'collection block', value: 'sample' }, ...metadata.attributes] }, null, 2) + '\n';
    const sha256 = createHash('sha256').update(enriched).digest('hex');
    await storage.exec(`UPDATE reveal_enrichment SET target_json=?,target_sha256=?,claim_id=NULL,next_check_ms=?
      WHERE token_id=? AND version='v0'`, enriched, sha256, Date.now() + 86400000, sample.tokenId);
    const inspect = () => call<EthereumRevealReplacementInspection>('inspectReplacement', {
      ...replacementRequest, expectedRevision: resumed.revision, frozenThroughMs: before.frozenThroughMs });
    for (const published of [false, true]) {
      if (published) await storage.exec("UPDATE reveal_enrichment SET status='published' WHERE token_id=? AND version='v0'", sample.tokenId);
      assert.deepEqual(await inspect(), { ...before, revision: resumed.revision, frozenSamples: [
        { ...sample, enrichment: { version: 'v0', sha256, published } }, ...before.frozenSamples.slice(1)] });
    }
    const publishedProof = await inspect();
    const key = `111k-sepolia/replacement-native/${sample.tokenId}.json`;
    const recheck = (write: boolean) => call<{ eligible: number; requeued: number }>('backfillAttributes',
      { ...page, expectedRevision: resumed.revision, recheckTokenId: sample.tokenId, write });
    await newObject.setPublicationHealth('published', null);
    assert.equal((await recheck(false)).eligible, 1);
    assert.equal(await (await env.ETHEREUM_REVEAL_METADATA.get(key))!.text(), metadata_json);
    assert.equal((await recheck(true)).requeued, 1);
    assert.equal((await recheck(true)).requeued, 0);
    await assert.rejects(inspect(), /metadata conflict/);
    await storage.exec("UPDATE reveal_enrichment SET next_check_ms=? WHERE token_id!=? AND status='pending'", Date.now() + 86_400_000, sample.tokenId);
    await newObject.watchdog(resumed);
    for (let attempt = 0; ; attempt++) {
      const [row] = await storage.exec<{ status: string; last_error: string | null }>(
        "SELECT status,last_error FROM reveal_enrichment WHERE token_id=? AND version='v0'", sample.tokenId);
      if (row.status === 'published' && row.last_error === null) break;
      assert.ok(attempt < 300, 'Published token recheck did not finish');
      await new Promise(done => setTimeout(done, 5));
    }
    assert.equal(await (await env.ETHEREUM_REVEAL_METADATA.get(key))!.text(), enriched);
    assert.deepEqual(await inspect(), publishedProof);
    assert.equal((await env.COMMERCE_DB.prepare('SELECT contract_address FROM ethereum_111k_control WHERE singleton=1').first<{ contract_address: string }>())?.contract_address, replacementContract);
  } finally {
    release.resolve();
    await runtime.close();
    rpc.closeAllConnections();
    await new Promise<void>(done => rpc.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
