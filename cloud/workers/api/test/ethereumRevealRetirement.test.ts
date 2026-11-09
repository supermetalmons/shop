import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { encodeAbi } from '../../../../shared/ethereum/abi.ts';
import { parseEthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import catalogDescriptor from '../../../../shared/ethereum/revealCatalog.json';
import { buildEthereumRevealRegistration, buildEthereumRevealTransition } from '../../../../scripts/ops/ethereumRevealControl.ts';
import { requireRetiredRevealDeployment, parseRevealReplacementRequest } from '../src/ethereumRevealMaintenanceSupport.ts';
import { acquireRevealCommerceFence } from '../src/ethereumRevealCommerceFence.ts';
import { loadCloudflareWorkersModule } from './cloudflareWorkersTestLoader.ts';
import { createCommerceD1Harness, d1Database } from './commerceD1Harness.ts';
import { runEthereum111kControl } from '../../../../scripts/ops/ethereum111kControl.ts';
import { createDeferredWorkCollector } from './deferredWork.ts';

const { EthereumRevealMaintenance } = await loadCloudflareWorkersModule(() => import('../src/ethereumRevealMaintenance.ts'));
const oldContract = `0x${'11'.repeat(20)}`, newContract = `0x${'22'.repeat(20)}`;
const request = { deploymentId: 'old', expectedRevision: 4, replacementDeploymentId: 'replacement', expectedReplacementRevision: 3 };
const templateJson = '{"name":"artwork","description":"","image":"placeholder","attributes":[]}';
const hash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;

function fixture(t: TestContext, overrides: { oldChain?: number; oldDrop?: string; oldCatalog?: string; oldState?: string;
  newCatalog?: string; newState?: string } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  for (const file of ['0009_ethereum_reveal_deployments.sql', '0011_ethereum_reveal_retirement.sql', '0012_ethereum_reveal_catalog_updates.sql']) {
    database.exec(readFileSync(`cloud/workers/api/ops-migrations/${file}`, 'utf8'));
  }
  const add = (deploymentId: string, contractAddress: string, block: number, chainId: number, dropId: string, catalogVersion: string, state: string, revision: number) => {
    database.exec(buildEthereumRevealRegistration({ deploymentId, contractAddress, deploymentBlock: block, chainId, dropId,
      metadataBaseUri: `https://cdn.mons.shop/${chainId === 1 ? '111k' : '111k-sepolia'}/${deploymentId}/`, catalogVersion,
      templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex') }));
    database.prepare('UPDATE ethereum_reveal_deployments SET state=?,revision=?,provisioned_at_ms=2,activated_at_ms=3 WHERE deployment_id=?')
      .run(state, revision, deploymentId);
  };
  add('old', oldContract, 100, overrides.oldChain ?? 11155111, overrides.oldDrop ?? '111k_devnet', overrides.oldCatalog ?? '111k-v5', overrides.oldState ?? 'paused', 4);
  add('replacement', newContract, 200, 11155111, '111k_devnet', overrides.newCatalog ?? '111k-v5', overrides.newState ?? 'active', 3);
  const read = (id: string) => parseEthereumRevealDeployment(database.prepare('SELECT * FROM ethereum_reveal_deployments WHERE deployment_id=?').get(id)!);
  const commerce = createCommerceD1Harness();
  commerce.database.prepare(`UPDATE ethereum_111k_control SET paused=0,revision=46,paused_at_ms=NULL,
    chain_id=11155111,contract_address=?,reset_guard_id=NULL,last_reset_id=NULL,updated_at_ms=1`).run(newContract);
  const setControl = (values: Record<string, unknown>) => commerce.database.prepare(`UPDATE ethereum_111k_control
    SET ${Object.keys(values).map(key => `${key}=?`).join(',')}`).run(...Object.values(values) as never[]);
  const state = { ready: true, quiesceFailures: 0, quiesces: 0, inspected: 0, inspectedRevisions: [] as number[], rpc: 0,
    metadataUri: read('replacement').metadataBaseUri, afterInspection: () => {} };
  const deferred = createDeferredWorkCollector();
  const env = { OPS_DB: d1Database(database), COMMERCE_DB: commerce.db,
    ETHEREUM_111K_CHAIN_ID: '11155111', ETHEREUM_111K_CONTRACT_ADDRESS: newContract,
    ETHEREUM_111K_METADATA_BASE_URI: read('replacement').metadataBaseUri, ETHEREUM_111K_DEPLOYMENT_BLOCK: '200', ALCHEMY_MI_NOTE_API_KEY: 'fixture',
    ETHEREUM_REVEAL: { getByName(name: string) {
      if (name === `11155111:${newContract}`) return { async inspectReplacement(value: { deploymentId: string; expectedRevision: number }) {
        state.inspected++;
        assert.deepEqual(value, { deploymentId: 'replacement', expectedRevision: read('replacement').revision });
        state.inspectedRevisions.push(value.expectedRevision);
        if (!state.ready) throw new Error('Replacement inventory is not ready');
        state.afterInspection();
        return { ready: true };
      } };
      assert.equal(name, `11155111:${oldContract}`);
      return { async quiesceRetired(value: unknown) {
        state.quiesces++;
        assert.deepEqual(value, { deploymentId: 'old', expectedRevision: read('old').revision });
        assert.ok(read('old').retiredAtMs);
        if (state.quiesceFailures-- > 0) throw new Error('Publisher drain interrupted');
        return { quiesced: true };
      } };
    } },
  } as unknown as Env;
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    state.rpc++;
    const { method, params } = JSON.parse(String(init?.body));
    let result: unknown;
    if (method === 'eth_chainId') result = '0xaa36a7';
    else if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'latest' ? 1000 : Number(BigInt(params[0]));
      result = { number: `0x${number.toString(16)}`, hash: hash(number) };
    } else if (method === 'eth_getCode') result = params[1].blockHash === hash(199) ? '0x' : '0x6000';
    else if (method === 'eth_call') result = encodeAbi(['string'], [state.metadataUri]);
    else throw new Error(`Unexpected RPC ${method}`);
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  t.after(async () => { await deferred.drain(); database.close(); commerce.database.close(); });
  const controlQuery = (sql: string) => commerce.database.prepare(sql).all();
  return { database, env, commerce, setControl, controlQuery, state, read, maintenance: new EthereumRevealMaintenance({ waitUntil: deferred.defer } as ExecutionContext, env) };
}

function interruptCommit(t: TestContext, f: ReturnType<typeof fixture>) {
  let commit: (() => Promise<unknown>) | undefined;
  const prepare = f.env.OPS_DB.prepare.bind(f.env.OPS_DB);
  t.mock.method(f.env.OPS_DB, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes('SET retired_at_ms=')) return statement;
    const bind = statement.bind.bind(statement);
    t.mock.method(statement, 'bind', (...values: unknown[]) => {
      const bound = bind(...values);
      commit = bound.first.bind(bound);
      t.mock.method(bound, 'first', async () => { throw new Error('Commit response interrupted'); });
      return bound;
    });
    return statement;
  });
  return () => { assert.ok(commit); return commit(); };
}

const controlArgs = (command: 'pause' | 'resume', contract: string, revision: number) =>
  [command, '--chain-id', '11155111', '--contract', contract, '--expected-revision', String(revision), '--write'];

function amendCatalog(f: ReturnType<typeof fixture>, deploymentId: string, catalogVersion: string, manifestSha256: string): void {
  const previous = f.read(deploymentId);
  f.database.prepare(`UPDATE ethereum_reveal_deployments SET catalog_update_id=?,catalog_update_started_at_ms=1,
    revision=revision+1 WHERE deployment_id=?`).run(`catalog-${deploymentId}`, deploymentId);
  f.database.prepare(`UPDATE ethereum_reveal_deployments SET effective_catalog_version=?,effective_catalog_sha256=?,
    catalog_revision=catalog_revision+1,catalog_update_id=NULL,catalog_update_started_at_ms=NULL,state=?,revision=revision+1
    WHERE deployment_id=?`).run(catalogVersion, manifestSha256, previous.state, deploymentId);
}

test('an old deployment catalog amendment blocks retirement before creating the Commerce fence', async t => {
  const f = fixture(t);
  f.database.exec(`UPDATE ethereum_reveal_deployments SET catalog_update_id='catalog-in-progress',catalog_update_started_at_ms=1,
    revision=5 WHERE deployment_id='old'`);
  const before = f.read('old');
  const scope = { ...request, expectedRevision: 5 };
  await assert.rejects(f.maintenance.retireForReplacement(scope), /superseded Sepolia/);
  await assert.rejects(f.maintenance.cancelRetirement(scope), /cancellation scope/);
  assert.deepEqual(f.read('old'), before);
  assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS count FROM ethereum_111k_retirements').get()!.count, 0);
  assert.equal(f.state.inspected, 0);
  assert.equal(f.state.quiesces, 0);
  assert.equal(f.state.rpc, 0);
});

test('retirement rejects a newer effective old catalog even when its origin catalog is older', async t => {
  const f = fixture(t, { oldCatalog: '111k-v4' });
  amendCatalog(f, 'old', '111k-v6', 'b'.repeat(64));
  const before = f.read('old');
  await assert.rejects(f.maintenance.retireForReplacement({ ...request, expectedRevision: before.revision }), /superseded Sepolia/);
  assert.equal(before.catalogVersion, '111k-v4');
  assert.equal(before.effectiveCatalogVersion, '111k-v6');
  assert.deepEqual(f.read('old'), before);
  assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS count FROM ethereum_111k_retirements').get()!.count, 0);
  assert.equal(f.state.inspected, 0);
  assert.equal(f.state.rpc, 0);
});

test('retirement compares effective catalogs while preserving both immutable origin versions', async t => {
  const f = fixture(t, { oldCatalog: '111k-v4', newCatalog: '111k-v3' });
  amendCatalog(f, 'old', catalogDescriptor.catalogVersion, catalogDescriptor.manifestSha256);
  amendCatalog(f, 'replacement', catalogDescriptor.catalogVersion, catalogDescriptor.manifestSha256);
  const old = f.read('old'), replacement = f.read('replacement');
  const result = await f.maintenance.retireForReplacement({ ...request, expectedRevision: old.revision,
    expectedReplacementRevision: replacement.revision });
  assert.equal(result.quiesced, true);
  assert.equal(f.read('old').catalogVersion, '111k-v4');
  assert.equal(f.read('replacement').catalogVersion, '111k-v3');
  assert.equal(f.read('old').effectiveCatalogVersion, catalogDescriptor.catalogVersion);
  assert.deepEqual(f.read('replacement'), replacement);
  assert.equal(f.commerce.database.prepare('SELECT state FROM ethereum_111k_retirements').get()!.state, 'retired');
});

test('commerce cannot move during retirement CAS and cannot resume the retired scope after release', async t => {
  const f = fixture(t);
  const prepare = f.env.OPS_DB.prepare.bind(f.env.OPS_DB);
  t.mock.method(f.env.OPS_DB, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes('SET retired_at_ms=')) return statement;
    const bind = statement.bind.bind(statement);
    t.mock.method(statement, 'bind', (...values: unknown[]) => {
      const bound = bind(...values), first = bound.first.bind(bound);
      t.mock.method(bound, 'first', async () => {
        const status = await runEthereum111kControl(['status'], { query: f.controlQuery });
        assert.deepEqual({ ...status.pendingRetirement }, request);
        await assert.rejects(runEthereum111kControl(controlArgs('pause', newContract, 46), { query: f.controlQuery }));
        assert.throws(() => f.setControl({ contract_address: oldContract }), /retirement/);
        return first();
      });
      return bound;
    });
    return statement;
  });
  await f.maintenance.retireForReplacement(request);
  assert.equal(f.read('old').revision, 5);
  assert.equal(f.commerce.database.prepare('SELECT state FROM ethereum_111k_retirements').get()!.state, 'retired');
  await runEthereum111kControl(controlArgs('pause', newContract, 46), { query: f.controlQuery });
  await assert.rejects(runEthereum111kControl(controlArgs('resume', oldContract, 47), { query: f.controlQuery }));
  await runEthereum111kControl(controlArgs('resume', newContract, 47), { query: f.controlQuery });
});

test('a commerce rollback before fence acquisition prevents retirement entirely', async t => {
  const f = fixture(t);
  const prepare = f.env.COMMERCE_DB.prepare.bind(f.env.COMMERCE_DB);
  t.mock.method(f.env.COMMERCE_DB, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith('INSERT INTO ethereum_111k_retirements')) return statement;
    const bind = statement.bind.bind(statement);
    t.mock.method(statement, 'bind', (...values: unknown[]) => {
      const bound = bind(...values), first = bound.first.bind(bound);
      t.mock.method(bound, 'first', async () => {
        await runEthereum111kControl(controlArgs('pause', newContract, 46), { query: f.controlQuery });
        await runEthereum111kControl(controlArgs('resume', oldContract, 47), { query: f.controlQuery });
        return first();
      });
      return bound;
    });
    return statement;
  });
  await assert.rejects(f.maintenance.retireForReplacement(request), /replacement commerce scope changed/);
  assert.equal(f.read('old').retiredAtMs, undefined);
  assert.equal(f.read('old').revision, 4);
  assert.equal(f.commerce.database.prepare('SELECT contract_address FROM ethereum_111k_control').get()!.contract_address, oldContract);
  assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS count FROM ethereum_111k_retirements').get()!.count, 0);
});

test('unknown retirement outcomes keep the commerce fence until revision-fenced cancellation', async t => {
  const f = fixture(t), commit = interruptCommit(t, f);
  await assert.rejects(f.maintenance.retireForReplacement(request), /Commit response interrupted/);
  assert.equal(f.read('old').revision, 4);
  await assert.rejects(runEthereum111kControl(controlArgs('pause', newContract, 46), { query: f.controlQuery }));
  const cancelled = await f.maintenance.cancelRetirement(request);
  assert.deepEqual(cancelled, { deploymentId: 'old', replacementDeploymentId: 'replacement', revision: 5, cancelled: true, retired: false });
  assert.equal(await commit(), null);
  assert.equal(f.read('old').retiredAtMs, undefined);
  assert.deepEqual(await f.maintenance.cancelRetirement(request), cancelled);
  await assert.rejects(acquireRevealCommerceFence(f.env.COMMERCE_DB, request, f.read('old'), f.read('replacement')), /cancelled/);
  await runEthereum111kControl(controlArgs('pause', newContract, 46), { query: f.controlQuery });
  await runEthereum111kControl(controlArgs('resume', oldContract, 47), { query: f.controlQuery });
});

test('cancellation remains available when replacement health and revision change', async t => {
  const f = fixture(t);
  interruptCommit(t, f);
  await assert.rejects(f.maintenance.retireForReplacement(request), /Commit response interrupted/);
  f.database.exec("UPDATE ethereum_reveal_deployments SET state='paused',revision=revision+1,last_error='metadata-conflict' WHERE deployment_id='replacement'");
  const result = await f.maintenance.cancelRetirement(request);
  assert.equal(result.cancelled, true);
  assert.equal(f.read('old').revision, 5);
  await runEthereum111kControl(controlArgs('pause', newContract, 46), { query: f.controlQuery });
});

test('a lost cancellation reply resumes without bumping the old revision twice', async t => {
  const f = fixture(t);
  interruptCommit(t, f);
  await assert.rejects(f.maintenance.retireForReplacement(request), /Commit response interrupted/);
  const prepare = f.env.OPS_DB.prepare.bind(f.env.OPS_DB);
  let lost = false;
  t.mock.method(f.env.OPS_DB, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes('RETURNING revision')) return statement;
    const bind = statement.bind.bind(statement);
    t.mock.method(statement, 'bind', (...values: unknown[]) => {
      const bound = bind(...values), first = bound.first.bind(bound);
      t.mock.method(bound, 'first', async () => {
        const value = await first();
        if (!lost) { lost = true; throw new Error('Lost cancellation reply'); }
        return value;
      });
      return bound;
    });
    return statement;
  });
  await assert.rejects(f.maintenance.cancelRetirement(request), /Lost cancellation reply/);
  assert.equal(f.read('old').revision, 5);
  assert.equal(f.commerce.database.prepare('SELECT state FROM ethereum_111k_retirements').get()!.state, 'pending');
  assert.equal((await f.maintenance.cancelRetirement(request)).cancelled, true);
  assert.equal(f.read('old').revision, 5);
  await runEthereum111kControl(controlArgs('pause', newContract, 46), { query: f.controlQuery });
});

test('a mismatched cancellation cannot bump the old revision or release another operation', async t => {
  const f = fixture(t);
  interruptCommit(t, f);
  await assert.rejects(f.maintenance.retireForReplacement(request), /Commit response interrupted/);
  await assert.rejects(f.maintenance.cancelRetirement({ ...request, expectedReplacementRevision: 2 }), /different Ethereum retirement/);
  assert.equal(f.read('old').revision, 4);
  assert.equal(f.commerce.database.prepare('SELECT state FROM ethereum_111k_retirements').get()!.state, 'pending');
});

test('cancellation resolves an already-committed retirement without reviving the old scope', async t => {
  const f = fixture(t), commit = interruptCommit(t, f);
  await assert.rejects(f.maintenance.retireForReplacement(request), /Commit response interrupted/);
  await commit();
  const result = await f.maintenance.cancelRetirement(request);
  assert.deepEqual(result, { deploymentId: 'old', replacementDeploymentId: 'replacement', revision: 5, cancelled: false, retired: true });
  assert.ok(f.read('old').retiredAtMs);
  assert.equal(f.commerce.database.prepare('SELECT state FROM ethereum_111k_retirements').get()!.state, 'retired');
  await runEthereum111kControl(controlArgs('pause', newContract, 46), { query: f.controlQuery });
  await assert.rejects(runEthereum111kControl(controlArgs('resume', oldContract, 47), { query: f.controlQuery }));
});

test('cancellation before acquisition prevents a delayed preflight from reacquiring its fence', async t => {
  const f = fixture(t), old = f.read('old'), replacement = f.read('replacement');
  const result = await f.maintenance.cancelRetirement(request);
  assert.equal(result.cancelled, true);
  await assert.rejects(acquireRevealCommerceFence(f.env.COMMERCE_DB, request, old, replacement), /cancelled/);
  assert.equal(f.commerce.database.prepare('SELECT state FROM ethereum_111k_retirements').get()!.state, 'cancelled');
  await runEthereum111kControl(controlArgs('pause', newContract, 46), { query: f.controlQuery });
});

test('an active old scope without a retirement intent cannot be revision-bumped by cancellation', async t => {
  const f = fixture(t, { oldState: 'active' });
  f.setControl({ contract_address: oldContract });
  f.env.ETHEREUM_111K_CONTRACT_ADDRESS = oldContract;
  await assert.rejects(f.maintenance.cancelRetirement(request), /paused old deployment/);
  assert.equal(f.read('old').revision, 4);
  assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS count FROM ethereum_111k_retirements').get()!.count, 0);
});

test('replay installs a retired commerce tombstone for an existing OPS marker without a pending acquisition', async t => {
  const f = fixture(t);
  f.database.exec("UPDATE ethereum_reveal_deployments SET retired_at_ms=1000,replacement_deployment_id='replacement',revision=5 WHERE deployment_id='old'");
  const prepare = f.env.COMMERCE_DB.prepare.bind(f.env.COMMERCE_DB);
  t.mock.method(f.env.COMMERCE_DB, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith('INSERT INTO ethereum_111k_retirements')) return statement;
    const bind = statement.bind.bind(statement);
    t.mock.method(statement, 'bind', (...values: unknown[]) => { assert.notEqual(values[8], 'pending'); return bind(...values); });
    return statement;
  });
  assert.equal((await f.maintenance.retireForReplacement(request)).retiredAtMs, 1000);
  assert.equal(f.state.rpc, 0);
  assert.equal(f.commerce.database.prepare('SELECT state FROM ethereum_111k_retirements').get()!.state, 'retired');
  await runEthereum111kControl(controlArgs('pause', newContract, 46), { query: f.controlQuery });
  await assert.rejects(runEthereum111kControl(controlArgs('resume', oldContract, 47), { query: f.controlQuery }));
});

test('cancellation cannot bind a prior OPS marker to a different replacement or original revision', async t => {
  const f = fixture(t);
  f.database.exec("UPDATE ethereum_reveal_deployments SET retired_at_ms=1000,replacement_deployment_id='replacement',revision=5 WHERE deployment_id='old'");
  f.database.exec(buildEthereumRevealRegistration({ deploymentId: 'other', contractAddress: `0x${'33'.repeat(20)}`,
    deploymentBlock: 300, chainId: 11155111, dropId: '111k_devnet', metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/other/',
    catalogVersion: '111k-v5', templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex') }));
  f.database.exec("UPDATE ethereum_reveal_deployments SET state='active',revision=3,provisioned_at_ms=2 WHERE deployment_id='other'");
  await assert.rejects(f.maintenance.cancelRetirement({ ...request, replacementDeploymentId: 'other' }), /cancellation scope/);
  await assert.rejects(f.maintenance.cancelRetirement({ ...request, expectedRevision: 3 }), /cancellation scope/);
  assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS count FROM ethereum_111k_retirements').get()!.count, 0);
  f.database.exec("UPDATE ethereum_reveal_deployments SET revision=revision+1,last_error='metadata-conflict' WHERE deployment_id='replacement'");
  assert.equal((await f.maintenance.cancelRetirement(request)).retired, true);
  assert.equal(f.commerce.database.prepare('SELECT replacement_deployment_id FROM ethereum_111k_retirements').get()!.replacement_deployment_id, 'replacement');
});

test('same-catalog retirement commits one permanent marker then quiesces and replays without another revision or chain check', async t => {
  const f = fixture(t);
  const replacement = f.read('replacement');
  const first = await f.maintenance.retireForReplacement(request);
  assert.equal(first.revision, 5);
  assert.equal(first.quiesced, true);
  assert.equal(first.replacementDeploymentId, 'replacement');
  assert.equal(first.replacementRevision, 3);
  assert.ok(first.retiredAtMs > 0);
  assert.equal(f.state.quiesces, 1);
  assert.ok(f.state.rpc > 0);
  const rpcCalls = f.state.rpc;
  assert.deepEqual(await f.maintenance.retireForReplacement(request), first);
  assert.equal(f.state.quiesces, 2);
  assert.equal(f.state.rpc, rpcCalls);
  assert.deepEqual(f.read('replacement'), replacement);
  await assert.rejects(requireRetiredRevealDeployment(f.env, { deploymentId: 'old', expectedRevision: 5 }, { requireDrain: true }), /65 seconds/);
  t.mock.method(Date, 'now', () => first.retiredAtMs + 65_000);
  assert.equal((await requireRetiredRevealDeployment(f.env, { deploymentId: 'old', expectedRevision: 5 }, { requireDrain: true })).retiredAtMs, first.retiredAtMs);
});

test('a lost commit reply is reconciled from the permanent marker before reporting success', async t => {
  const f = fixture(t);
  const prepare = f.env.OPS_DB.prepare.bind(f.env.OPS_DB);
  t.mock.method(f.env.OPS_DB, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes('SET retired_at_ms=')) return statement;
    const bind = statement.bind.bind(statement);
    t.mock.method(statement, 'bind', (...values: unknown[]) => {
      const bound = bind(...values);
      const first = bound.first.bind(bound);
      t.mock.method(bound, 'first', async () => { await first(); throw new Error('Lost D1 reply'); });
      return bound;
    });
    return statement;
  });
  const result = await f.maintenance.retireForReplacement(request);
  assert.equal(result.quiesced, true);
  assert.equal(f.read('old').revision, 5);
  assert.equal(f.state.quiesces, 1);
});

for (const changed of ['revision', 'publication health']) test(`the retirement CAS rejects a replacement ${changed} change after preflight`, async t => {
  const f = fixture(t);
  const prepare = f.env.OPS_DB.prepare.bind(f.env.OPS_DB);
  t.mock.method(f.env.OPS_DB, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes('SET retired_at_ms=')) return statement;
    const bind = statement.bind.bind(statement);
    t.mock.method(statement, 'bind', (...values: unknown[]) => {
      const bound = bind(...values);
      const first = bound.first.bind(bound);
      t.mock.method(bound, 'first', async () => {
        f.database.exec(changed === 'revision'
          ? "UPDATE ethereum_reveal_deployments SET revision=revision+1 WHERE deployment_id='replacement'"
          : "UPDATE ethereum_reveal_deployments SET last_error='publication-unavailable' WHERE deployment_id='replacement'");
        return first();
      });
      return bound;
    });
    return statement;
  });
  await assert.rejects(f.maintenance.retireForReplacement(request), /Replacement reveal deployment/);
  assert.equal(f.read('old').retiredAtMs, undefined);
  assert.equal(f.read('old').revision, 4);
  assert.equal(f.state.quiesces, 0);
});

test('retirement remains fenced after a failed drain and resumes from the original request', async t => {
  const f = fixture(t);
  f.state.quiesceFailures = 1;
  await assert.rejects(f.maintenance.retireForReplacement(request), /drain interrupted/);
  const marked = f.read('old');
  assert.ok(marked.retiredAtMs);
  assert.equal(marked.revision, 5);
  const result = await f.maintenance.retireForReplacement(request);
  assert.equal(result.retiredAtMs, marked.retiredAtMs);
  assert.equal(result.quiesced, true);
});

function pauseAndResumeReplacement(f: ReturnType<typeof fixture>): void {
  for (const command of ['pause', 'activate'] as const) {
    const deployment = f.read('replacement');
    f.database.exec(buildEthereumRevealTransition(command, deployment, deployment.revision));
  }
}

test('a committed retirement replays after replacement registry and commerce pause/resume with the original receipt identity', async t => {
  const f = fixture(t);
  const first = await f.maintenance.retireForReplacement(request);
  const old = f.read('old');
  const fence = f.commerce.database.prepare('SELECT * FROM ethereum_111k_retirements').get()!;
  pauseAndResumeReplacement(f);
  await runEthereum111kControl(controlArgs('pause', newContract, 46), { query: f.controlQuery });
  await runEthereum111kControl(controlArgs('resume', newContract, 47), { query: f.controlQuery });
  assert.deepEqual(await f.maintenance.retireForReplacement(request), first);
  assert.deepEqual(f.state.inspectedRevisions, [3, 5]);
  assert.deepEqual(f.read('old'), old);
  const replayedFence = f.commerce.database.prepare('SELECT * FROM ethereum_111k_retirements').get()!;
  assert.deepEqual({ ...replayedFence, updated_at_ms: fence.updated_at_ms }, { ...fence });
  assert.equal(replayedFence.operation_id, 'old:4:replacement:3');
  await assert.rejects(f.maintenance.retireForReplacement({ ...request, expectedReplacementRevision: 5 }), /UNIQUE/);
  assert.equal(f.state.quiesces, 2);
});

test('a lost commit reply resolves the original pending fence after the replacement registry revision advances', async t => {
  const f = fixture(t), commit = interruptCommit(t, f);
  await assert.rejects(f.maintenance.retireForReplacement(request), /Commit response interrupted/);
  await commit();
  const old = f.read('old');
  pauseAndResumeReplacement(f);
  const result = await f.maintenance.retireForReplacement(request);
  assert.equal(result.retiredAtMs, old.retiredAtMs);
  assert.equal(result.replacementRevision, 3);
  assert.equal(f.read('replacement').revision, 5);
  assert.deepEqual(f.read('old'), old);
  assert.deepEqual(f.state.inspectedRevisions, [3, 5]);
  const fence = f.commerce.database.prepare('SELECT * FROM ethereum_111k_retirements').get()!;
  assert.equal(fence.operation_id, 'old:4:replacement:3');
  assert.equal(fence.expected_replacement_revision, 3);
  assert.equal(fence.state, 'retired');
  assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS count FROM ethereum_111k_retirements').get()!.count, 1);
});

test('replay rejects replacement revision drift after its current health inspection before resolving a pending fence', async t => {
  const f = fixture(t), commit = interruptCommit(t, f);
  await assert.rejects(f.maintenance.retireForReplacement(request), /Commit response interrupted/);
  await commit();
  pauseAndResumeReplacement(f);
  f.state.afterInspection = () => pauseAndResumeReplacement(f);
  await assert.rejects(f.maintenance.retireForReplacement(request), /revision changed during retirement/);
  assert.equal(f.state.quiesces, 0);
  assert.equal(f.commerce.database.prepare('SELECT state FROM ethereum_111k_retirements').get()!.state, 'pending');
});

test('a permanent marker for another replacement cannot replay the original retirement request', async t => {
  const f = fixture(t);
  f.database.exec(buildEthereumRevealRegistration({ deploymentId: 'other', contractAddress: `0x${'33'.repeat(20)}`,
    deploymentBlock: 300, chainId: 11155111, dropId: '111k_devnet', metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/other/',
    catalogVersion: '111k-v5', templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex') }));
  f.database.exec("UPDATE ethereum_reveal_deployments SET state='active',revision=3,provisioned_at_ms=2 WHERE deployment_id='other'");
  f.database.exec("UPDATE ethereum_reveal_deployments SET retired_at_ms=1000,replacement_deployment_id='other',revision=5 WHERE deployment_id='old'");
  const old = f.read('old');
  await assert.rejects(f.maintenance.retireForReplacement(request), /expected superseded Sepolia deployment and replacement/);
  assert.deepEqual(f.read('old'), old);
  assert.equal(f.state.inspected, 0);
  assert.equal(f.state.quiesces, 0);
  assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS count FROM ethereum_111k_retirements').get()!.count, 0);
});

for (const changed of ['backward-revision', 'unhealthy', 'not-ready', 'paused', 'commerce-paused', 'configured-old', 'wrong-old-revision'] as const) {
  test(`committed retirement replay rejects ${changed}`, async t => {
    const f = fixture(t);
    await f.maintenance.retireForReplacement(request);
    pauseAndResumeReplacement(f);
    if (changed === 'backward-revision') f.database.exec("UPDATE ethereum_reveal_deployments SET revision=2 WHERE deployment_id='replacement'");
    if (changed === 'unhealthy') f.database.exec("UPDATE ethereum_reveal_deployments SET last_error='publication-unavailable' WHERE deployment_id='replacement'");
    if (changed === 'not-ready') f.state.ready = false;
    if (changed === 'paused') f.database.exec("UPDATE ethereum_reveal_deployments SET state='paused' WHERE deployment_id='replacement'");
    if (changed === 'commerce-paused') f.setControl({ paused: 1, paused_at_ms: 1 });
    if (changed === 'configured-old') f.env.ETHEREUM_111K_CONTRACT_ADDRESS = oldContract;
    const before = f.read('old');
    await assert.rejects(f.maintenance.retireForReplacement({ ...request,
      ...(changed === 'wrong-old-revision' ? { expectedRevision: 3 } : {}) }));
    assert.equal(f.state.quiesces, 1);
    assert.deepEqual(f.read('old'), before);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS count FROM ethereum_111k_retirements').get()!.count, 1);
  });
}

test('retired registration cannot be reactivated, relabeled, unretired, deleted or revision-bumped', async t => {
  const f = fixture(t);
  await f.maintenance.retireForReplacement(request);
  const marked = f.read('old');
  assert.throws(() => buildEthereumRevealTransition('activate', marked, marked.revision), /Retired reveal/);
  for (const change of ["state='active'", 'retired_at_ms=NULL,replacement_deployment_id=NULL', 'retired_at_ms=retired_at_ms+1',
    "replacement_deployment_id='old'", 'revision=revision+1']) {
    assert.throws(() => f.database.exec(`UPDATE ethereum_reveal_deployments SET ${change} WHERE deployment_id='old'`), /retirement/);
  }
  assert.throws(() => f.database.exec("DELETE FROM ethereum_reveal_deployments WHERE deployment_id='old'"), /permanent/);
  assert.deepEqual(f.read('old'), marked);
});

for (const kind of ['old-revision', 'new-revision', 'same-id', 'old-active', 'old-mainnet', 'old-drop', 'future-catalog',
  'new-catalog', 'new-paused', 'configured-old', 'commerce-old', 'commerce-paused', 'not-ready', 'base-uri'] as const) {
  test(`retirement rejects ${kind} before committing a marker`, async t => {
    const f = fixture(t, { ...(kind === 'old-active' ? { oldState: 'active' } : {}),
      ...(kind === 'old-mainnet' ? { oldChain: 1 } : {}), ...(kind === 'old-drop' ? { oldDrop: 'other' } : {}),
      ...(kind === 'future-catalog' ? { oldCatalog: '111k-v6' } : {}), ...(kind === 'new-catalog' ? { newCatalog: '111k-v4' } : {}),
      ...(kind === 'new-paused' ? { newState: 'paused' } : {}) });
    if (kind === 'configured-old') f.env.ETHEREUM_111K_CONTRACT_ADDRESS = oldContract;
    if (kind === 'commerce-old') f.setControl({ contract_address: oldContract });
    if (kind === 'commerce-paused') f.setControl({ paused: 1, paused_at_ms: 1 });
    if (kind === 'not-ready') f.state.ready = false;
    if (kind === 'base-uri') f.state.metadataUri = 'https://cdn.mons.shop/111k-sepolia/incorrect/';
    await assert.rejects(f.maintenance.retireForReplacement({ ...request,
      ...(kind === 'old-revision' ? { expectedRevision: 3 } : {}), ...(kind === 'new-revision' ? { expectedReplacementRevision: 2 } : {}),
      ...(kind === 'same-id' ? { deploymentId: 'replacement' } : {}) }));
    assert.equal(f.read('old').retiredAtMs, undefined);
    assert.equal(f.read('old').revision, 4);
    assert.equal(f.state.quiesces, 0);
  });
}

test('frozen snapshot cutoffs reject malformed or future caller timestamps', () => {
  for (const frozenThroughMs of [-1, NaN, 1.5, Date.now() + 1000, '1']) {
    assert.throws(() => parseRevealReplacementRequest({ deploymentId: 'replacement', expectedRevision: 3, frozenThroughMs }));
  }
});

for (const error of ['metadata-conflict', 'publication-unavailable']) {
  test(`replacement ${error} blocks inspection and retirement until publication health recovers`, async t => {
    const f = fixture(t);
    f.database.prepare("UPDATE ethereum_reveal_deployments SET last_error=? WHERE deployment_id='replacement'").run(error);
    await assert.rejects(f.maintenance.inspectReplacement({ deploymentId: 'replacement', expectedRevision: 3 }), /Replacement reveal deployment/);
    await assert.rejects(f.maintenance.retireForReplacement(request), /Replacement reveal deployment/);
    assert.equal(f.state.inspected, 0);
    assert.equal(f.state.quiesces, 0);
    assert.equal(f.state.rpc, 0);
    assert.equal(f.read('old').retiredAtMs, undefined);
    f.database.exec("UPDATE ethereum_reveal_deployments SET last_error=NULL WHERE deployment_id='replacement'");
    assert.equal((await f.maintenance.retireForReplacement(request)).quiesced, true);
  });
}
