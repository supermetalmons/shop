import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { computeRevealCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.ts';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { revealCatalogUpdateHash, type RevealCatalogUpdateBody } from '../../../../shared/ethereum/revealCatalogUpdate.ts';
import { parseEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import type { EthereumRevealCatalogUpdateRequest, EthereumRevealCatalogUpdateResult } from '../../../../shared/ethereum/revealMaintenance.ts';
import { EthereumRevealCatalogUpdate, parseCatalogUpdateRequest } from '../src/ethereumRevealCatalogUpdate.ts';
import { EthereumRevealStore, type RevealSql, type RevealPublicationJob } from '../src/ethereumRevealStore.ts';
import { d1Database } from './commerceD1Harness.ts';

const source = getRevealCatalog('111k-v5')!;
const templateJson = JSON.stringify({ name: '{{tokenId}}', description: '111k', image: 'https://cdn.lil.org/nft/111k/placeholder.png',
  attributes: [{ trait_type: 'series', value: '111K' }] });
const deployment: EthereumRevealDeployment = { deploymentId: 'catalog-controller-test', dropId: '111k_devnet', chainId: 11155111,
  contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/catalog-controller-test/',
  deploymentBlock: 100, catalogVersion: source.catalogVersion, templateJson,
  templateSha256: createHash('sha256').update(templateJson).digest('hex'), state: 'active', revision: 3,
  createdAtMs: 1, updatedAtMs: 3, provisionedAtMs: 2, activatedAtMs: 3, lastError: null };

function batch() {
  const target = structuredClone(source);
  target.catalogVersion = '111k-v6';
  target.categories.eggs.count -= 3;
  target.categories.videos.count += 3;
  target.categories.videos.aspectRatioIndexById = [...target.categories.videos.aspectRatioIndexById!, 0, 0, 0];
  const body: RevealCatalogUpdateBody = { version: 1, nonce: '10000000-0000-4000-8000-000000000001',
    predecessor: { manifest: source, descriptor: computeRevealCatalogDescriptor(source) },
    target: { manifest: target, descriptor: computeRevealCatalogDescriptor(target) },
    mappings: [1, 2, 3].map(index => ({ eggId: target.categories.eggs.count + index,
      category: 'video', assetId: source.categories.videos.count + index })) };
  const batchSha256 = revealCatalogUpdateHash(body);
  return { ...body, batchSha256, batchId: `catalog-${batchSha256.slice(0, 32)}` };
}

function fixture(t: TestContext, frozen = 0) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec('PRAGMA foreign_keys=ON');
  for (const migration of ['0009_ethereum_reveal_deployments', '0011_ethereum_reveal_retirement', '0012_ethereum_reveal_catalog_updates']) {
    database.exec(readFileSync(`cloud/workers/api/ops-migrations/${migration}.sql`, 'utf8'));
  }
  database.prepare(`INSERT INTO ethereum_reveal_deployments(deployment_id,drop_id,chain_id,contract_address,metadata_base_uri,
    deployment_block,catalog_version,template_json,template_sha256,state,revision,created_at_ms,updated_at_ms,provisioned_at_ms,activated_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,'active',3,1,3,2,3)`).run(deployment.deploymentId, deployment.dropId, deployment.chainId,
      deployment.contractAddress, deployment.metadataBaseUri, deployment.deploymentBlock, deployment.catalogVersion, templateJson, deployment.templateSha256);
  const sql: RevealSql = { exec(query, ...bindings) {
    const statement = database.prepare(query);
    const parameters = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...parameters) : (statement.run(...parameters), []);
    return { toArray: () => rows as never[] };
  } };
  const transactionSync = <T>(action: () => T): T => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = action(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  const store = new EthereumRevealStore(sql, transactionSync, () => 0);
  store.configure(deployment);
  while (!store.initializeChunk()) {}
  const clock = { now: 1_000_000 };
  database.function('unixepoch', { varargs: true }, () => clock.now / 1000);
  t.mock.method(Date, 'now', () => clock.now);
  const kv = new Map<string, unknown>();
  const objects = new Map<string, { body: string; headersValid: boolean }>();
  const counters = { saves: 0, deletes: 0, wakes: 0, reads: 0, writes: 0, publications: 0 };
  const faults = { mirror: false, afterWrite: false, publicBytes: null as string | null,
    afterSavePhase: null as EthereumRevealCatalogUpdateResult['phase'] | null,
    beforeSavePhase: null as EthereumRevealCatalogUpdateResult['phase'] | null,
    traitGate: null as Promise<void> | null, traitFailure: false,
    outcomes: new Map<string, 'retry' | 'conflict'>() };
  const traits: string[] = [];
  const objectKey = (tokenId: string) => `${new URL(deployment.metadataBaseUri).pathname.slice(1)}${tokenId}.json`;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://cdn.mons.shop/')) {
      const object = objects.get(new URL(url).pathname.slice(1));
      return new Response(faults.publicBytes ?? object?.body ?? null, { status: object ? 200 : 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    assert.match(url, /^https:\/\/cdn\.lil\.org\/nft\/111k\/videos\/json\/v0\/(59|60|61)\.json$/);
    traits.push(url);
    if (faults.traitGate) await faults.traitGate;
    if (faults.traitFailure) return new Response(null, { status: 503 });
    return Response.json({ 'collection block': 'new videos', attributes: [{ trait_type: 'color', value: 'blue' }] });
  });
  const freezeEggs = (eggIds: number[], firstToken = 1, crateTokenId = '111112') => {
    database.prepare('INSERT INTO crates(crate_token_id) VALUES(?)').run(crateTokenId);
    for (const [slot, eggId] of eggIds.entries()) {
      const generation = store.catalogUpdate.effectiveCatalog()!.generation;
      const row = generation ? database.prepare(`SELECT category,slot FROM reveal_catalog_free
        WHERE generation=? AND origin_category='egg' AND origin_asset_id=?`).get(generation, eggId)
        : database.prepare("SELECT category,slot FROM free_slots WHERE category='egg' AND asset_id=?").get(eggId);
      assert.ok(row);
      const unit = store.catalogUpdate.takeFree(row.category as 'egg' | 'video', Number(row.slot));
      database.prepare('INSERT INTO assignments(category,asset_id,crate_token_id,slot) VALUES(?,?,?,?)')
        .run(unit.category, unit.assetId, crateTokenId, slot);
    }
    store.freeze(deployment, { transactionHash: `0x${firstToken.toString(16).padStart(64, '0')}`,
      blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 },
      [{ crateTokenId, tokenIds: Array.from({ length: 20 }, (_, index) => String(firstToken + index)) }], clock.now);
    for (let index = 0; index < eggIds.length; index++) {
      const tokenId = String(firstToken + index);
      store.publicationComplete(tokenId);
      objects.set(objectKey(tokenId), { body: store.catalogUpdate.canonicalMetadata([tokenId])[0].metadataJson, headersValid: true });
    }
  };
  if (frozen) freezeEggs(Array.from({ length: frozen }, (_, index) => source.categories.eggs.count - index));
  const storage = { sql, transactionSync,
    async get<T>(key: string): Promise<T | undefined> { return structuredClone(kv.get(key)) as T | undefined; },
    async delete(keys: string | string[]) {
      counters.deletes++;
      const deleted = (Array.isArray(keys) ? keys : [keys]).filter(key => kv.delete(key)).length;
      return Array.isArray(keys) ? deleted : deleted > 0;
    },
    async put(key: string, value: unknown) {
      counters.saves++;
      if (faults.beforeSavePhase && value && typeof value === 'object' && 'phase' in value && value.phase === faults.beforeSavePhase) {
        faults.beforeSavePhase = null;
        throw new Error('injected lost phase-save acknowledgment');
      }
      kv.set(key, structuredClone(value));
      if (faults.afterSavePhase && value && typeof value === 'object' && 'phase' in value && value.phase === faults.afterSavePhase) {
        faults.afterSavePhase = null;
        throw new Error('injected lost phase-save acknowledgment');
      }
    },
  } as unknown as DurableObjectStorage;
  const update = batch();
  const registry = {
    getCatalog(version: string, hash?: string) {
      const entry = [update.predecessor, update.target].find(value => value.descriptor.catalogVersion === version);
      return entry && (hash === undefined || hash === entry.descriptor.manifestSha256) ? entry.manifest : undefined;
    },
    getDescriptor(version: string) { return [update.predecessor, update.target].find(value => value.descriptor.catalogVersion === version)?.descriptor; },
  };
  const env = { OPS_DB: d1Database(database, undefined, undefined, call => {
    if (faults.mirror && call.method === 'first' && call.sql.includes('SET effective_catalog_version=')) {
      faults.mirror = false;
      throw new Error('injected registry mirror failure');
    }
  }), ETHEREUM_REVEAL_METADATA: { async get(key: string) {
    counters.reads++;
    const object = objects.get(key);
    return object ? { size: Buffer.byteLength(object.body), arrayBuffer: async () => new TextEncoder().encode(object.body).buffer,
      httpMetadata: object.headersValid ? { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } : {} } : null;
  } }, ETHEREUM_REVEAL_PUBLISHER: { getByName: () => ({ async publishBatch(_scope: unknown, jobs: RevealPublicationJob[]) {
    const results: Array<{ tokenId: string; status: 'published' | 'retry' | 'conflict' }> = [];
    for (const job of jobs) {
      counters.publications++;
      const expectedJsons = JSON.parse(job.expected_jsons_json!) as string[];
      assert.equal(store.catalogUpdate.validateMetadataWrite({ tokenId: job.token_id, metadataRevision: job.metadata_revision!,
        metadataJson: job.metadata_json, expectedJsons, allowMissing: Boolean(job.allow_missing) }), true);
      const outcome = faults.outcomes.get(job.token_id);
      if (outcome) { results.push({ tokenId: job.token_id, status: outcome }); continue; }
      const key = objectKey(job.token_id);
      const existing = objects.get(key)?.body ?? null;
      if (existing !== job.metadata_json && (existing === null ? !job.allow_missing : !expectedJsons.includes(existing))) {
        results.push({ tokenId: job.token_id, status: 'conflict' }); continue;
      }
      counters.writes++;
      objects.set(key, { body: job.metadata_json, headersValid: true });
      if (faults.afterWrite) { faults.afterWrite = false; throw new Error('injected crash after metadata write'); }
      results.push({ tokenId: job.token_id, status: 'published' });
    }
    return results;
  } }) } } as unknown as Env;
  const host = { env, storage, initializeStore: () => store,
    async wake() { counters.wakes++; store.catalogUpdate.pruneObsolete(256); } };
  let controller = new EthereumRevealCatalogUpdate(host, registry);
  const reopen = () => { controller = new EthereumRevealCatalogUpdate(host, registry); };
  const request = (action: EthereumRevealCatalogUpdateRequest['action']): EthereumRevealCatalogUpdateRequest => ({
    deploymentId: deployment.deploymentId, expectedRevision: deployment.revision, batchId: update.batchId, action,
    ...(action === 'begin' && { batch: update }),
  });
  const current = () => parseEthereumRevealDeployment(database.prepare('SELECT * FROM ethereum_reveal_deployments').get()!);
  const run = (action: EthereumRevealCatalogUpdateRequest['action']) => controller.run(request(action), current());
  const reach = async (phase: EthereumRevealCatalogUpdateResult['phase']) => {
    for (let attempts = 0; attempts < 1_200; attempts++) {
      const value = await run('advance');
      assert.equal(current().state, 'active');
      if (value.phase === phase) return value;
    }
    assert.fail(`Catalog operation did not reach ${phase}`);
  };
  return { database, store, host, update, clock, kv, objects, objectKey, traits, faults, counters, current, request, run, reach, reopen, freezeEggs,
    controller: () => controller };
}

test('catalog maintenance parsing requires exact operation and frozen batch identity', () => {
  const update = batch();
  const value = { deploymentId: deployment.deploymentId, expectedRevision: 3, batchId: update.batchId, action: 'advance' as const };
  assert.deepEqual(parseCatalogUpdateRequest(value), value);
  assert.deepEqual(parseCatalogUpdateRequest({ ...value, action: 'begin', batch: update }).batch, update);
  for (const changed of [{ action: 'begin' }, { batch: update }, { expectedRevision: 0 }, { batchId: 'other' },
    { verificationAfterEggId: 1 }, { action: 'verify', verificationAfterEggId: -1 }, { arbitrary: true }]) {
    assert.throws(() => parseCatalogUpdateRequest({ ...value, ...changed }), /Invalid catalog/);
  }
});

test('inspection and unsupported catalog requests never change registration or allocator state', async t => {
  const f = fixture(t);
  const schema = f.database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  const before = f.current();
  assert.equal((await f.run('inspect')).phase, 'unstarted');
  await assert.rejects(new EthereumRevealCatalogUpdate(f.host).run(f.request('begin'), deployment), /Deploy support/);
  assert.deepEqual(f.current(), before);
  assert.deepEqual(f.database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), schema);
  assert.equal(f.kv.size, 0);
});

test('staging preserves active traffic, stages every artwork, and cancellation leaves ordinary new reveals intact', async t => {
  const f = fixture(t);
  assert.equal((await f.run('begin')).phase, 'staging');
  assert.equal(f.current().state, 'active');
  assert.equal(f.current().catalogRevision, 0);
  await f.run('advance');
  const gate = Promise.withResolvers<void>();
  f.faults.traitGate = gate.promise;
  const staging = f.run('advance');
  for (let attempt = 0; attempt < 100 && !f.traits.length; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(f.traits.length, 'trait staging should start');
  assert.equal((await f.run('inspect')).phase, 'staging');
  await assert.rejects(f.run('cancel'), /already running/);
  f.freezeEggs([source.categories.eggs.count]);
  assert.equal(f.store.frozen(['1'])[0].category, 'egg');
  gate.resolve();
  await staging;
  f.faults.traitGate = null;
  assert.equal(new Set(f.traits).size, 3);
  await f.run('advance');
  await f.run('advance');
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM reveal_catalog_free WHERE generation=?').get(f.update.batchId)!.count, 512);
  const before = f.store.frozen(['1']);
  f.reopen();
  assert.equal((await f.run('cancel')).phase, 'cancelled');
  assert.equal(f.current().state, 'active');
  assert.equal(f.current().catalogUpdateId, null);
  assert.equal(f.current().catalogRevision, 0);
  assert.deepEqual(f.store.frozen(['1']), before);
  assert.equal(f.counters.writes, 0);
  assert.equal(f.kv.has(`catalog-update-mappings:${f.update.batchId}:0`), false);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM reveal_catalog_free WHERE generation=?').get(f.update.batchId)!.count, 256);
  await f.host.wake();
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM reveal_catalog_free WHERE generation=?').get(f.update.batchId)!.count, 0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM reveal_catalog_pools WHERE generation=?').get(f.update.batchId)!.count, 0);
});

test('a rejected operation claim can be cancelled without undoing a concurrent pause', async t => {
  const f = fixture(t);
  const put = f.host.storage.put.bind(f.host.storage);
  const pause = t.mock.method(f.host.storage, 'put', async (key: string, value: unknown) => {
    await put(key, value);
    if (key === 'catalog-update-active') f.database.exec("UPDATE ethereum_reveal_deployments SET revision=revision+1,state='paused'");
  });
  await assert.rejects(f.run('begin'), /changed before the operation was acquired/);
  pause.mock.restore();
  const before = f.current();
  assert.equal(before.revision, 4);
  assert.equal(before.catalogUpdateId, null);
  f.reopen();
  assert.equal((await f.run('cancel')).phase, 'cancelled');
  assert.deepEqual(f.current(), before);
  const next = structuredClone(f.update);
  next.nonce = '20000000-0000-4000-8000-000000000002';
  next.batchSha256 = revealCatalogUpdateHash(next);
  next.batchId = `catalog-${next.batchSha256.slice(0, 32)}`;
  assert.equal((await f.controller().run({ deploymentId: before.deploymentId, expectedRevision: before.revision,
    action: 'begin', batchId: next.batchId, batch: next }, before)).phase, 'staging');
});

test('trait failures do not activate a candidate or stop ordinary reveals', async t => {
  const f = fixture(t);
  await f.run('begin');
  await f.run('advance');
  f.faults.traitFailure = true;
  await assert.rejects(f.run('advance'), /HTTP 503/);
  assert.equal(f.current().state, 'active');
  assert.equal(f.store.catalogUpdate.effectiveCatalog()!.catalogRevision, 0);
  f.freezeEggs([source.categories.eggs.count]);
  assert.equal(f.store.frozen(['1'])[0].category, 'egg');
  f.faults.traitFailure = false;
  await f.run('advance');
  assert.equal(f.store.catalogUpdate.status(f.update.batchId)!.metadataStaged, 3);
  await f.run('cancel');
});

test('activation remains readable across registry mirror failure and publication acknowledgments lost on restart', async t => {
  const f = fixture(t, 1);
  const oldMetadata = f.objects.get(f.objectKey('1'))!.body;
  await f.run('begin');
  await f.run('advance');
  await f.run('advance');
  await f.run('advance');
  f.freezeEggs([1], 21, '111113');
  assert.equal(f.store.frozen(['21'])[0].category, 'egg');
  const originals = f.database.prepare('SELECT * FROM assignments ORDER BY category,asset_id').all();
  await f.reach('activating');
  assert.equal(f.store.frozen(['1'])[0].category, 'egg');
  assert.equal(new Set(f.traits).size, 3);
  f.faults.mirror = true;
  await assert.rejects(f.run('advance'), /registry mirror failure/);
  assert.equal(f.current().state, 'active');
  assert.equal(f.current().catalogRevision, 0);
  const artwork = f.store.tokensResponse(f.current(), ['1']).artworks[0];
  assert.equal(artwork.category, 'video');
  assert.equal(artwork.metadataRevision, 2);
  assert.equal(f.store.frozen(['21'])[0].category, 'egg');
  assert.equal(f.objects.get(f.objectKey('1'))!.body, oldMetadata);
  assert.deepEqual(f.database.prepare('SELECT * FROM assignments ORDER BY category,asset_id').all(), originals);
  await assert.rejects(f.run('cancel'), /resume forward/);
  f.reopen();
  f.faults.afterWrite = true;
  await assert.rejects(f.run('advance'), /crash after metadata write/);
  const target = f.store.catalogUpdate.canonicalMetadata(['1'])[0];
  assert.equal(f.objects.get(f.objectKey('1'))!.body, target.metadataJson);
  assert.equal(f.current().catalogVersion, source.catalogVersion);
  assert.equal(f.current().catalogRevision, 1);
  f.reopen();
  await f.reach('observing');
  assert.match(target.metadataJson, /new videos/);
  assert.equal(f.store.catalogUpdate.status(f.update.batchId)!.published, 1);
  f.clock.now += 300_000;
  const cleanup = await f.run('advance');
  assert.equal(cleanup.phase, 'observing');
  assert.equal(f.current().catalogUpdateId, f.update.batchId);
  assert.equal(f.current().revision, 5);
  assert.ok(Number(f.database.prepare('SELECT COUNT(*) AS count FROM free_slots').get()!.count) > 0);
  assert.equal((await f.reach('complete')).complete, true);
  assert.equal(f.current().state, 'active');
  assert.equal(f.current().catalogUpdateId, null);
  assert.equal(f.current().revision, 6);
  assert.equal(f.kv.has(`catalog-update-mappings:${f.update.batchId}:0`), false);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM free_slots').get()!.count, 0);
  const snapshot = [f.current(), [...f.kv], f.counters.saves, f.counters.writes];
  assert.equal((await f.run('verify')).nextVerificationEggId, null);
  assert.deepEqual([f.current(), [...f.kv], f.counters.saves, f.counters.writes], snapshot);
});

test('a token publication conflict leaves other replacements and new reveals online with a finite activation set', async t => {
  const f = fixture(t, 2);
  await f.run('begin');
  await f.reach('activating');
  await f.run('advance');
  assert.equal(f.store.catalogUpdate.status(f.update.batchId)!.frozen, 2);
  f.freezeEggs([source.categories.eggs.count - 2], 21, '111113');
  assert.equal(f.store.frozen(['21'])[0].category, 'video');
  assert.equal(f.store.catalogUpdate.canonicalMetadata(['21'])[0].migration, false);
  assert.equal(f.store.catalogUpdate.status(f.update.batchId)!.frozen, 2);
  const original = f.objects.get(f.objectKey('1'))!.body;
  f.objects.set(f.objectKey('1'), { body: '{"foreign":true}', headersValid: true });
  const progress = await f.run('advance');
  assert.equal(progress.phase, 'publishing');
  assert.equal(progress.published, 1);
  assert.equal(progress.conflicts, 1);
  assert.equal(f.current().state, 'active');
  assert.equal(f.store.frozen(['1', '2', '21']).every(artwork => artwork.category === 'video'), true);
  const writes = f.counters.writes;
  await f.run('advance');
  assert.equal(f.counters.writes, writes);
  f.objects.set(f.objectKey('1'), { body: original, headersValid: true });
  f.clock.now += 300_000;
  await f.reach('verifying');
  f.faults.publicBytes = '\uFEFF' + f.objects.get(f.objectKey('1'))!.body;
  await assert.rejects(f.run('advance'), /Public metadata differs/);
  assert.equal(f.current().state, 'active');
  f.faults.publicBytes = null;
  await f.reach('observing');
  f.clock.now += 300_000;
  await f.reach('complete');
  assert.equal(f.store.catalogUpdate.status(f.update.batchId)!.frozen, 2);
});

test('lost activation progress saves resume the same mapping without rolling back live reads', async t => {
  const f = fixture(t);
  await f.run('begin');
  await f.reach('activating');
  f.faults.afterSavePhase = 'publishing';
  await assert.rejects(f.run('advance'), /lost phase-save acknowledgment/);
  assert.equal(f.store.catalogUpdate.effectiveCatalog()!.catalogRevision, 1);
  assert.equal(f.current().state, 'active');
  f.store.reserve(['111112']);
  f.reopen();
  await f.reach('observing');
  assert.equal(f.current().catalogRevision, 1);
  assert.equal(f.store.catalogUpdate.status(f.update.batchId)!.frozen, 0);
  f.clock.now += 300_000;
  f.faults.beforeSavePhase = 'complete';
  await assert.rejects(f.reach('complete'), /lost phase-save acknowledgment/);
  assert.equal(f.current().catalogUpdateId, null);
  assert.equal(f.current().revision, 6);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM free_slots').get()!.count, 0);
  assert.equal(f.kv.has(`catalog-update-mappings:${f.update.batchId}:0`), false);
  f.database.exec("UPDATE ethereum_reveal_deployments SET state='paused',revision=revision+1");
  f.reopen();
  assert.equal((await f.run('advance')).phase, 'complete');
  assert.equal(f.current().state, 'paused');
  assert.equal(f.current().revision, 7);
});
