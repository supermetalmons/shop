import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { buildEthereumRevealRegistration } from '../../../../scripts/ops/ethereumRevealControl.ts';
import { localEthereumRevealBindings } from '../../../../scripts/shared/ethereum111kLocalReveal.ts';
import { parseEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { ETHEREUM_111K_CONTROL_SQL, parseEthereum111kControl } from '../../../../shared/ethereum/control.ts';
import type { EthereumRevealObject } from '../src/ethereumRevealObject.ts';

type SeedableReveal = EthereumRevealObject & {
  seedLegacy(deployment: EthereumRevealDeployment): Promise<void>;
  runAlarm(): Promise<void>;
};
type TestEnv = Omit<Env, 'ETHEREUM_REVEAL'> & { ETHEREUM_REVEAL: DurableObjectNamespace<SeedableReveal> };
const oldContract = `0x${'11'.repeat(20)}`, currentContract = `0x${'22'.repeat(20)}`;

test('native retired purge removes frozen storage and alarms without recreation after retry, callbacks or restart', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ethereum-reveal-purge-'));
  const main = join(directory, 'worker.ts');
  await writeFile(main, `
    export { default, AdminIrlRedeemFinalizeWorkflowV1, StripeReceiptClaimWorkflowV1, StripeChargebackMaintenance,
      EthereumRevealMaintenance, EthereumRevealPublisherObject, EthereumRevealVerifierObject }
      from ${JSON.stringify(resolve('cloud/workers/api/src/index.ts'))};
    import { EthereumRevealObject as Base } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealObject.ts'))};
    export class EthereumRevealObject extends Base {
      async seedLegacy(deployment) {
        this.ctx.storage.sql.exec('CREATE TABLE settings(id INTEGER PRIMARY KEY, deployment_json TEXT NOT NULL)');
        this.ctx.storage.sql.exec('INSERT INTO settings VALUES(1,?)', JSON.stringify(deployment));
        this.ctx.storage.sql.exec('CREATE TABLE assignments(token_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL)');
        this.ctx.storage.sql.exec('INSERT INTO assignments VALUES(?,?)', '1', '{"name":"frozen"}');
        this.ctx.storage.sql.exec("CREATE TRIGGER frozen_assignment_delete BEFORE DELETE ON assignments BEGIN SELECT RAISE(ABORT,'Frozen reveal cannot be deleted'); END");
        await this.ctx.storage.put('legacy-reservation', 'private');
        await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
      }
      async runAlarm() { await this.alarm(); }
    }
  `);
  const production = JSON.parse(await readFile(resolve('cloud/workers/api/wrangler.jsonc'), 'utf8'));
  const config = { ...production, ...localEthereumRevealBindings(), main,
    vars: { ...production.vars, ...Object.fromEntries((production.secrets?.required || []).map((name: string) => [name, ''])),
      ETHEREUM_111K_CHAIN_ID: '11155111', ETHEREUM_111K_CONTRACT_ADDRESS: currentContract },
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({ ...database, remote: false,
      migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)) })),
  };
  delete config.$schema; delete config.account_id; delete config.routes; delete config.secrets;
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  const runtime = createTestHarness({ root: directory, workers: [{ config }] });
  try {
    await runtime.listen();
    const worker = runtime.getWorker<TestEnv>('mons-shop-api');
    for (const binding of ['DATA_DB', 'OPS_DB', 'COMMERCE_DB'] as const) await worker.applyD1Migrations(binding);
    let env = await worker.getEnv();
    await env.COMMERCE_DB.prepare(`UPDATE ethereum_111k_control SET paused=0,paused_at_ms=NULL,
      chain_id=11155111,contract_address=?,revision=46 WHERE singleton=1`).bind(currentContract).run();
    const templateJson = '{"name":"artwork","description":"","image":"placeholder","attributes":[]}';
    const register = async (deploymentId: string, contractAddress: string, catalogVersion: string) => {
      await env.OPS_DB.prepare(buildEthereumRevealRegistration({ deploymentId, dropId: '111k_devnet', chainId: 11155111,
        contractAddress, metadataBaseUri: `https://cdn.mons.shop/111k-sepolia/${deploymentId}/`, deploymentBlock: 100,
        catalogVersion, templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex') })).run();
      const row = await env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET state='paused',revision=4,
        provisioned_at_ms=2,activated_at_ms=3 WHERE deployment_id=? RETURNING *`).bind(deploymentId).first<Record<string, unknown>>();
      assert.ok(row);
      return parseEthereumRevealDeployment(row);
    };
    await register('old-native', oldContract, '111k-v4');
    await register('current-native', currentContract, '111k-v5');
    const current = parseEthereumRevealDeployment((await env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments
      SET state='active',revision=5 WHERE deployment_id='current-native' RETURNING *`).first<Record<string, unknown>>())!);
    const old = parseEthereumRevealDeployment((await env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments
      SET retired_at_ms=?,replacement_deployment_id='current-native',revision=5 WHERE deployment_id='old-native' RETURNING *`)
      .bind(Date.now() - 65_001).first<Record<string, unknown>>())!);
    const name = `11155111:${oldContract}`, currentName = `11155111:${currentContract}`;
    let object = env.ETHEREUM_REVEAL.getByName(name);
    await object.seedLegacy(old);
    await env.ETHEREUM_REVEAL.getByName(currentName).seedLegacy(current);
    const storage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name });
    let currentStorage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name: currentName });
    await assert.rejects(storage.exec('DELETE FROM assignments'), /Frozen reveal cannot be deleted/);
    const request = { deploymentId: old.deploymentId, expectedRevision: old.revision };
    const beforeControl = parseEthereum111kControl(await env.COMMERCE_DB.prepare(ETHEREUM_111K_CONTROL_SQL).first());
    const beforeCurrent = await currentStorage.exec('SELECT * FROM assignments');
    const inspection = await object.inspectRetired(request);
    assert.equal(inspection.deploymentId, old.deploymentId);
    assert.equal(inspection.chainId, old.chainId);
    assert.equal(inspection.contractAddress, old.contractAddress);
    assert.equal(inspection.metadataBaseUri, old.metadataBaseUri);
    assert.equal(inspection.revision, old.revision);
    assert.equal(inspection.storageEmpty, false);
    assert.equal(inspection.alarmCleared, false);
    await assert.rejects(object.purgeRetired({ ...request, expectedRevision: 3 }));
    await assert.rejects(env.ETHEREUM_REVEAL.getByName(currentName).purgeRetired(request));
    await assert.rejects(env.ETHEREUM_REVEAL.getByName(currentName).purgeRetired({ deploymentId: current.deploymentId, expectedRevision: current.revision }));
    const [first, duplicate] = await Promise.all([object.purgeRetired(request), object.purgeRetired(request)]);
    assert.equal(first.purged, true);
    assert.equal(first.storageEmpty, true);
    assert.equal(first.alarmCleared, true);
    assert.equal(duplicate.purged, true);
    assert.equal(duplicate.storageEmpty, true);
    assert.equal(duplicate.alarmCleared, true);
    assert.deepEqual(await storage.exec("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '__cf_%'"), []);
    await runtime.update({ root: directory, workers: [{ config: { ...config, vars: { ...config.vars, PURGE_RESTART_TEST: '1' } } }] });
    env = await worker.getEnv();
    currentStorage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name: currentName });
    object = env.ETHEREUM_REVEAL.getByName(name);
    await object.runAlarm();
    const work = { kind: 'receipt' as const, claim: { hash: `0x${'aa'.repeat(32)}`, claimId: 'late',
      startedAtMs: 1, leaseUntilMs: Date.now() + 30_000, active: true } };
    assert.equal(await object.validateReceiptWork(old, work), false);
    assert.equal(await object.recordReceiptPresence(old, work), false);
    assert.equal(await object.validateReceiptWork(current, work), false);
    await assert.rejects(object.initialize(old));
    await assert.rejects(object.initialize(current));
    await assert.rejects(object.revealTokens(old, ['1']));
    const publication = { token_id: '1', metadata_json: '{"name":"frozen"}', placeholder_json: '{"name":"placeholder"}', attempts: 0 };
    await assert.rejects(env.ETHEREUM_REVEAL_PUBLISHER.getByName(name).publishBatch(old, [publication]));
    const repeated = await object.purgeRetired(request);
    assert.equal(repeated.purged, true);
    assert.equal(repeated.storageEmpty, true);
    assert.equal(repeated.alarmCleared, true);
    assert.equal((await object.inspectRetired(request)).storageEmpty, true);
    assert.deepEqual(await currentStorage.exec('SELECT * FROM assignments'), beforeCurrent);
    for (const saved of [old, current]) {
      const row = await env.OPS_DB.prepare('SELECT * FROM ethereum_reveal_deployments WHERE deployment_id=?')
        .bind(saved.deploymentId).first<Record<string, unknown>>();
      assert.ok(row);
      assert.deepEqual(parseEthereumRevealDeployment(row), saved);
    }
    assert.deepEqual(parseEthereum111kControl(await env.COMMERCE_DB.prepare(ETHEREUM_111K_CONTROL_SQL).first()), beforeControl);
    assert.equal((await env.ETHEREUM_REVEAL_METADATA.list()).objects.length, 0);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
