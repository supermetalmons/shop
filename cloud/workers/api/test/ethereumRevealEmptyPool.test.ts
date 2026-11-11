import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { computeRevealCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.ts';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { revealCatalogAdditions, revealCatalogUpdateHash, type RevealCatalogUpdateBody } from '../../../../shared/ethereum/revealCatalogUpdate.ts';
import { parseEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import type { EthereumRevealEmptyPoolRequest, EthereumRevealEmptyPoolResult } from '../../../../shared/ethereum/revealMaintenance.ts';
import { EthereumRevealEmptyPool, parseEmptyPoolRequest } from '../src/ethereumRevealEmptyPool.ts';
import { EthereumRevealEmptyPoolFence } from '../src/ethereumRevealEmptyPoolFence.ts';
import { EthereumRevealCatalogUpdateStore } from '../src/ethereumRevealCatalogUpdateStore.ts';
import { EthereumRevealStore, type RevealSql } from '../src/ethereumRevealStore.ts';
import type { verifyEmptyRevealChain } from '../src/ethereumRevealChain.ts';
import { d1Database } from './commerceD1Harness.ts';

const source = getRevealCatalog('111k-v8')!;
const target = getRevealCatalog('111k-v9')!;
const templateJson = JSON.stringify({ name: '{{tokenId}}', description: '',
  image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [{ trait_type: 'type', value: 'painting' }] });
const deployment: EthereumRevealDeployment = { deploymentId: 'mainnet-empty-controller', dropId: '111k', chainId: 1,
  contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 100,
  catalogVersion: source.catalogVersion, templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex'),
  state: 'paused', revision: 5, createdAtMs: 1, updatedAtMs: 5, provisionedAtMs: 2, activatedAtMs: 3, lastError: null };
const operationId = `empty-${'a'.repeat(32)}`;

function batch(nonce = '11111111-1111-4111-8111-111111111111') {
  const body: RevealCatalogUpdateBody = { version: 1, nonce,
    predecessor: { manifest: source, descriptor: computeRevealCatalogDescriptor(source) },
    target: { manifest: target, descriptor: computeRevealCatalogDescriptor(target) },
    mappings: revealCatalogAdditions(source, target).map((row, index) => ({ eggId: target.categories.eggs.count + index + 1, ...row })) };
  const batchSha256 = revealCatalogUpdateHash(body);
  return { ...body, batchSha256, batchId: `catalog-${batchSha256.slice(0, 32)}` };
}
const update = batch();

function fixture(t: TestContext, initial: Partial<EthereumRevealDeployment> = {}) {
  const selected = { ...deployment, ...initial };
  const ledger = new DatabaseSync(':memory:');
  const ops = new DatabaseSync(':memory:');
  t.after(() => { ledger.close(); ops.close(); });
  ledger.exec('PRAGMA foreign_keys=ON');
  for (const migration of ['0009_ethereum_reveal_deployments', '0011_ethereum_reveal_retirement', '0012_ethereum_reveal_catalog_updates']) {
    ops.exec(readFileSync(`cloud/workers/api/ops-migrations/${migration}.sql`, 'utf8'));
  }
  ops.prepare(`INSERT INTO ethereum_reveal_deployments(deployment_id,drop_id,chain_id,contract_address,metadata_base_uri,
    deployment_block,catalog_version,template_json,template_sha256,state,revision,created_at_ms,updated_at_ms,provisioned_at_ms,activated_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,1,5,?,3)`).run(selected.deploymentId, selected.dropId, selected.chainId,
    selected.contractAddress, selected.metadataBaseUri, selected.deploymentBlock, selected.catalogVersion, templateJson, selected.templateSha256,
    selected.state, selected.revision, selected.provisionedAtMs);
  const statements = new Map<string, StatementSync>();
  const sql: RevealSql = { exec(query, ...bindings) {
    let statement = statements.get(query);
    if (!statement) statements.set(query, statement = ledger.prepare(query));
    const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
    return { toArray: () => rows as never[] };
  } };
  let depth = 0;
  const transaction = <T>(action: () => T): T => {
    if (depth) return action();
    ledger.exec('BEGIN IMMEDIATE');
    depth++;
    try { const value = action(); ledger.exec('COMMIT'); return value; }
    catch (error) { ledger.exec('ROLLBACK'); throw error; }
    finally { depth--; }
  };
  let store: EthereumRevealStore | null = new EthereumRevealStore(sql, transaction, () => 0);
  store.configure(selected);
  while (!store.initializeChunk()) {}
  const clock = { now: 1_000_000 };
  t.mock.method(Date, 'now', () => clock.now);
  const faults = { quiescent: true, chain: false, mirrorBefore: false, mirrorAfter: false, completionAfter: false, claimBefore: false,
    beforeSave: null as EthereumRevealEmptyPoolResult['phase'] | null,
    afterSave: null as EthereumRevealEmptyPoolResult['phase'] | null, chainGate: null as Promise<void> | null };
  const counters = { chain: 0, media: 0, wakes: 0, alarmsDeleted: 0 };
  t.mock.method(globalThis, 'fetch', async () => { counters.media++; throw new Error('Unexpected media request'); });
  const kv = new Map<string, unknown>();
  const storage = { sql, transactionSync: transaction,
    async get<T>(key: string): Promise<T | undefined> { return structuredClone(kv.get(key)) as T | undefined; },
    async put(key: string, value: unknown) {
      if (faults.beforeSave && value && typeof value === 'object' && 'phase' in value && value.phase === faults.beforeSave) {
        faults.beforeSave = null;
        throw new Error('lost state acknowledgment');
      }
      kv.set(key, structuredClone(value));
      if (faults.afterSave && value && typeof value === 'object' && 'phase' in value && value.phase === faults.afterSave) {
        faults.afterSave = null;
        throw new Error('lost saved-state acknowledgment');
      }
    },
    async deleteAlarm() { counters.alarmsDeleted++; },
  } as unknown as DurableObjectStorage;
  const env = { OPS_DB: d1Database(ops, call => {
    if (faults.mirrorAfter && call.sql.includes('SET effective_catalog_version=')) {
      faults.mirrorAfter = false;
      throw new Error('lost mirror acknowledgment');
    }
    if (faults.completionAfter && call.sql.includes('SET catalog_update_id=NULL')) {
      faults.completionAfter = false;
      throw new Error('lost completion acknowledgment');
    }
  }, undefined, call => {
    if (faults.claimBefore && call.method === 'first' && call.sql.includes('SET catalog_update_id=?')) {
      faults.claimBefore = false;
      throw new Error('registry claim unavailable');
    }
    if (faults.mirrorBefore && call.method === 'first' && call.sql.includes('SET effective_catalog_version=')) {
      faults.mirrorBefore = false;
      throw new Error('mirror unavailable');
    }
  }) } as unknown as Env;
  const verifyChain: typeof verifyEmptyRevealChain = async (_env, value, signal) => {
    counters.chain++;
    assert.equal(value.chainId, 1);
    assert.equal(value.contractAddress, deployment.contractAddress);
    assert.equal(value.metadataBaseUri, deployment.metadataBaseUri);
    signal.throwIfAborted();
    if (faults.chainGate) await faults.chainGate;
    if (faults.chain) throw new Error('chain is not empty and closed');
    return { number: 200, hash: `0x${'1'.repeat(64)}` };
  };
  let fence = new EthereumRevealEmptyPoolFence(sql, transaction);
  const makeController = () => new EthereumRevealEmptyPool({ env, storage, fence,
    initializeStore: () => (store ??= new EthereumRevealStore(sql, transaction, () => 0)).catalogUpdate,
    readStore: () => new EthereumRevealCatalogUpdateStore(sql, transaction),
    quiescent: () => faults.quiescent,
    async wake() { counters.wakes++; },
  }, verifyChain);
  let controller = makeController();
  const reopen = () => { store = null; fence = new EthereumRevealEmptyPoolFence(sql, transaction); controller = makeController(); };
  const current = () => parseEthereumRevealDeployment(ops.prepare('SELECT * FROM ethereum_reveal_deployments').get()!);
  const request = (action: EthereumRevealEmptyPoolRequest['action'], extra = {}): EthereumRevealEmptyPoolRequest =>
    parseEmptyPoolRequest({ deploymentId: deployment.deploymentId, expectedRevision: deployment.revision, operationId, action,
      ...(action === 'begin' ? { batch: update } : {}), ...extra });
  const run = (action: EthereumRevealEmptyPoolRequest['action'], extra = {}) => controller.run(request(action, extra), current());
  const reach = async (phase: EthereumRevealEmptyPoolResult['phase']) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await run('advance');
      if (value.phase === phase) return value;
    }
    assert.fail(`Empty-pool rebuild did not reach ${phase}`);
  };
  const drain = () => { clock.now += 65_000; };
  return { ledger, ops, sql, transaction, clock, faults, counters, kv, current, request, run, reach, reopen, drain,
    fence: () => fence, controller: () => controller,
    readStore: () => new EthereumRevealCatalogUpdateStore(sql, transaction) };
}

test('empty-pool requests require the exact action and frozen batch shape', () => {
  const request = { deploymentId: deployment.deploymentId, expectedRevision: 5, operationId, action: 'advance' };
  assert.deepEqual(parseEmptyPoolRequest(request), request);
  assert.equal(parseEmptyPoolRequest({ ...request, action: 'begin', batch: update }).batch, update);
  for (const extra of [{ operationId: 'bad' }, { expectedRevision: 0 }, { action: 'other' }, { action: 'begin' },
    { batch: update }, { ignoreFence: true }]) assert.throws(() => parseEmptyPoolRequest({ ...request, ...extra }), /Invalid empty-pool/);
  assert.throws(() => parseEmptyPoolRequest({ ...request, action: 'begin', batch: { ...update, batchSha256: '0'.repeat(64) } }), /Invalid reveal catalog/);
});

test('empty-pool begin requires mainnet, paused ready inventory, and the current predecessor revision', async t => {
  const f = fixture(t);
  const initial = f.current();
  assert.equal((await f.run('inspect')).phase, 'unstarted');
  assert.equal(f.kv.size, 0);
  assert.equal(f.fence().status(), null);
  for (const mutation of ["state='active'", "state='ready'", 'revision=6', 'provisioned_at_ms=NULL',
    "catalog_update_id='another',catalog_update_started_at_ms=1"]) {
    f.ops.exec(`UPDATE ethereum_reveal_deployments SET ${mutation}`);
    await assert.rejects(f.run('begin'), /Pause|identity/);
    f.ops.prepare(`UPDATE ethereum_reveal_deployments SET state='paused',revision=5,provisioned_at_ms=2,
      catalog_update_id=NULL,catalog_update_started_at_ms=NULL`).run();
  }
  assert.deepEqual(f.current(), initial);
  assert.equal(f.kv.size, 0);
  assert.equal(f.fence().status(), null);
});

for (const initial of [{ catalogVersion: '111k-v7' }, { chainId: 11155111, dropId: '111k_devnet',
  metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/mainnet-empty-controller/' }] as const) {
  test(`empty-pool begin rejects an incompatible initial identity ${JSON.stringify(initial)}`, async t => {
    const f = fixture(t, initial);
    await assert.rejects(f.run('begin'), /Pause|identity/);
    assert.equal(f.kv.size, 0);
    assert.equal(f.fence().status(), null);
  });
}

test('empty-pool operation keeps its original revision, batch hash, and immutable deployment identity', async t => {
  const f = fixture(t);
  await f.run('begin');
  await assert.rejects(f.run('inspect', { expectedRevision: 6 }), /original revision/);
  await assert.rejects(f.run('begin', { batch: batch('22222222-2222-4222-8222-222222222222') }), /frozen batch/);
  assert.throws(() => f.ops.exec('UPDATE ethereum_reveal_deployments SET deployment_block=101'), /immutable/);
  f.ops.exec('DROP TRIGGER ethereum_reveal_deployment_immutable');
  f.ops.exec('UPDATE ethereum_reveal_deployments SET deployment_block=101');
  await assert.rejects(f.run('advance'), /identity/);
  assert.equal(f.readStore().effectiveCatalog()!.catalogRevision, 0);
  assert.ok(f.fence().status());
});

test('empty-pool rebuild drains writers, proves emptiness, switches atomically, and observes before cleanup', async t => {
  const f = fixture(t);
  f.ledger.exec("INSERT INTO recovery_jobs(id,token_ids_json,ranges_json) VALUES('pending','[1]','[]')");
  const begun = await f.run('begin');
  assert.equal(begun.phase, 'fencing');
  assert.equal(f.current().revision, 6);
  assert.equal(f.current().state, 'paused');
  assert.equal(f.counters.alarmsDeleted, 1);
  assert.throws(() => f.ledger.exec("DELETE FROM free_slots WHERE category='egg' AND slot=0"), /fenced/);
  f.clock.now += 64_999;
  assert.equal((await f.run('advance')).phase, 'fencing');
  assert.equal(f.counters.chain, 0);
  f.clock.now++;
  f.faults.quiescent = false;
  await assert.rejects(f.run('advance'), /writers have not drained/);
  f.faults.quiescent = true;
  await assert.rejects(f.run('advance'), /not empty/);
  const scope = f.fence().status()!;
  f.fence().withRebuild(scope, () => f.ledger.exec("DELETE FROM recovery_jobs WHERE id='pending'"));
  assert.equal((await f.run('advance')).phase, 'staging');
  assert.equal(f.counters.chain, 1);
  const ready = await f.reach('activating');
  assert.equal(ready.seeded, 111111);
  assert.equal(ready.catalogRevision, 0);
  assert.equal(f.current().state, 'paused');
  f.faults.chain = true;
  await assert.rejects(f.run('advance'), /chain is not empty/);
  assert.ok(f.fence().status());
  assert.equal(f.readStore().effectiveCatalog()!.catalogRevision, 0);
  f.faults.chain = false;
  const observing = await f.run('advance');
  assert.equal(observing.phase, 'observing');
  assert.equal(observing.catalogRevision, 1);
  assert.equal(observing.fenceActive, false);
  assert.equal(f.current().state, 'active');
  assert.equal(f.current().revision, 7);
  assert.equal(f.current().effectiveCatalogSha256, update.target.descriptor.manifestSha256);
  assert.equal(f.current().catalogVersion, source.catalogVersion);
  assert.equal(f.readStore().effectiveCatalog()!.catalogVersion, target.catalogVersion);
  await assert.rejects(f.run('cancel'), /must finish forward/);
  f.clock.now += 299_999;
  assert.equal((await f.run('advance')).phase, 'observing');
  assert.equal(f.ledger.prepare('SELECT COUNT(*) AS count FROM free_slots').get()!.count, 111111);
  f.clock.now++;
  f.faults.chain = true;
  await assert.rejects(f.run('advance'), /chain is not empty/);
  assert.equal(f.current().catalogUpdateId, operationId);
  assert.equal(f.ledger.prepare('SELECT COUNT(*) AS count FROM free_slots').get()!.count, 111111);
  f.faults.chain = false;
  const complete = await f.reach('complete');
  assert.equal(complete.complete, true);
  assert.equal(f.current().revision, 8);
  assert.equal(f.current().catalogUpdateId, null);
  assert.equal(f.ledger.prepare('SELECT COUNT(*) AS count FROM free_slots').get()!.count, 0);
  assert.equal(f.ledger.prepare('SELECT COUNT(*) AS count FROM reveal_catalog_free').get()!.count, 111111);
  assert.equal(f.ledger.prepare('SELECT COUNT(*) AS count FROM reveal_catalog_mappings').get()!.count, 0);
  assert.equal(f.counters.media, 0);
  assert.equal((await f.run('verify')).complete, true);
});

for (const fault of ['mirrorBefore', 'mirrorAfter'] as const) {
  test(`empty-pool activation resumes forward after ${fault} across an object restart`, async t => {
    const f = fixture(t);
    await f.run('begin');
    f.drain();
    await f.reach('activating');
    f.faults[fault] = true;
    await assert.rejects(f.run('advance'), /mirror/);
    assert.equal(f.readStore().effectiveCatalog()!.catalogRevision, 1);
    assert.equal(f.fence().status(), null);
    assert.equal(f.current().revision, fault === 'mirrorBefore' ? 6 : 7);
    f.reopen();
    assert.equal((await f.run('begin')).phase, 'observing');
    assert.equal(f.current().revision, 7);
    assert.equal(f.current().state, 'active');
    assert.equal(f.readStore().effectiveCatalog()!.catalogRevision, 1);
    await assert.rejects(f.run('cancel'), /must finish forward/);
    f.clock.now += 300_000;
    await f.reach('complete');
    assert.equal(f.current().revision, 8);
    assert.equal(f.counters.media, 0);
  });
}

test('lost completion acknowledgment does not rebuild or advance the catalog twice', async t => {
  const f = fixture(t);
  await f.run('begin');
  f.drain();
  await f.reach('observing');
  f.clock.now += 300_000;
  f.faults.completionAfter = true;
  await assert.rejects(f.reach('complete'), /completion acknowledgment/);
  assert.equal(f.current().revision, 8);
  assert.equal(f.current().catalogUpdateId, null);
  f.reopen();
  assert.equal((await f.run('advance')).phase, 'complete');
  assert.equal((await f.run('begin')).phase, 'complete');
  assert.equal(f.current().revision, 8);
  assert.equal(f.readStore().effectiveCatalog()!.catalogRevision, 1);
});

test('preactivation cancellation preserves the pause and complete old pool', async t => {
  const f = fixture(t);
  await f.run('begin');
  f.drain();
  await f.run('advance');
  assert.equal((await f.run('advance')).seeded, 4096);
  const result = await f.run('cancel');
  assert.equal(result.phase, 'cancelled');
  assert.equal(result.fenceActive, false);
  assert.equal(f.current().state, 'paused');
  assert.equal(f.current().catalogUpdateId, null);
  assert.equal(f.readStore().effectiveCatalog()!.catalogRevision, 0);
  assert.equal(f.readStore().effectiveCatalog()!.catalogVersion, source.catalogVersion);
  assert.equal(f.ledger.prepare('SELECT COUNT(*) AS count FROM free_slots').get()!.count, 111111);
  f.reopen();
  assert.equal((await f.run('cancel')).phase, 'cancelled');
  await assert.rejects(f.run('begin'), /cancelled/);
  assert.equal(f.counters.media, 0);
});

test('cancellation recovers a saved operation that never acquired its fence', async t => {
  const f = fixture(t);
  f.faults.afterSave = 'fencing';
  await assert.rejects(f.run('begin'), /saved-state acknowledgment/);
  assert.equal(f.fence().status(), null);
  assert.equal(f.readStore().status(operationId), null);
  const before = f.current();
  f.reopen();
  assert.equal((await f.run('cancel')).phase, 'cancelled');
  assert.deepEqual(f.current(), before);
  assert.equal(f.ledger.prepare('SELECT COUNT(*) AS count FROM free_slots').get()!.count, 111111);
});

test('cancelling an unclaimed fenced operation preserves concurrent state and revision changes', async t => {
  const f = fixture(t);
  f.faults.claimBefore = true;
  await assert.rejects(f.run('begin'), /claim unavailable/);
  assert.ok(f.fence().status());
  assert.equal(f.current().catalogUpdateId, null);
  f.ops.exec("UPDATE ethereum_reveal_deployments SET state='active',revision=9");
  const concurrent = f.current();
  f.drain();
  f.reopen();
  assert.equal((await f.run('cancel')).phase, 'cancelled');
  assert.deepEqual(f.current(), concurrent);
  assert.equal(f.fence().status(), null);
  assert.equal(f.readStore().effectiveCatalog()!.catalogRevision, 0);
});

test('cancellation retries a lost registry acknowledgment without resuming reveals', async t => {
  const f = fixture(t);
  await f.run('begin');
  f.drain();
  f.faults.completionAfter = true;
  await assert.rejects(f.run('cancel'), /completion acknowledgment/);
  assert.equal(f.current().state, 'paused');
  assert.equal(f.current().revision, 7);
  assert.equal(f.current().catalogUpdateId, null);
  assert.equal(f.fence().status(), null);
  f.reopen();
  assert.equal((await f.run('cancel')).phase, 'cancelled');
  assert.equal(f.current().state, 'paused');
  assert.equal(f.current().revision, 7);
});

test('inspection stays read-only while a chain check holds the mutation lane', { timeout: 5000 }, async t => {
  const f = fixture(t);
  await f.run('begin');
  f.drain();
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  f.faults.chainGate = gate.promise;
  const pending = f.run('advance');
  for (let attempts = 0; attempts < 100 && !f.counters.chain; attempts++) await new Promise(resolve => setTimeout(resolve, 0));
  try {
    assert.equal(f.counters.chain, 1);
    await assert.rejects(f.run('advance'), /already running/);
    const before = f.ledger.prepare('SELECT total_changes() AS count').get()!.count;
    assert.equal((await f.run('inspect')).phase, 'fencing');
    assert.equal(f.ledger.prepare('SELECT total_changes() AS count').get()!.count, before);
    assert.equal(f.ledger.prepare('SELECT bypass FROM reveal_empty_pool_fences').get()!.bypass, 0);
  } finally { gate.resolve(); }
  assert.equal((await pending).phase, 'staging');
});
