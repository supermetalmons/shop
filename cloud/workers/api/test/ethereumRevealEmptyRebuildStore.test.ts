import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { computeRevealCatalogDescriptor, type RevealAssetCatalog } from '../../../../shared/ethereum/revealAssetCatalog.ts';
import { revealCatalogAdditions, revealCatalogUpdateHash, type RevealCatalogUpdateBody } from '../../../../shared/ethereum/revealCatalogUpdate.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { EthereumRevealStore, type RevealSql } from '../src/ethereumRevealStore.ts';

const predecessor = getRevealCatalog('111k-v8')!;
const target = getRevealCatalog('111k-v9')!;
const operationId = 'empty-mainnet-test-v9';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function makeBatch(before = predecessor, after = target) {
  const body: RevealCatalogUpdateBody = { version: 1, nonce: '00000000-0000-4000-8000-000000000009',
    predecessor: { manifest: before, descriptor: computeRevealCatalogDescriptor(before) },
    target: { manifest: after, descriptor: computeRevealCatalogDescriptor(after) },
    mappings: revealCatalogAdditions(before, after).map((row, index) => ({ eggId: after.categories.eggs.count + index + 1, ...row })) };
  const batchSha256 = revealCatalogUpdateHash(body);
  return { ...body, batchId: `catalog-${batchSha256.slice(0, 32)}`, batchSha256 };
}
const batch = makeBatch();

function fixture(t: TestContext, chainId = 1) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  const templateJson = JSON.stringify({ name: '{{tokenId}}', image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] });
  const deployment: EthereumRevealDeployment = { deploymentId: 'mainnet-empty-test', dropId: '111k', chainId,
    contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 100,
    catalogVersion: predecessor.catalogVersion, templateJson, templateSha256: digest(templateJson), state: 'active', revision: 3,
    createdAtMs: 1, updatedAtMs: 3, provisionedAtMs: 2, activatedAtMs: 3, lastError: null };
  let failSql: string | undefined;
  const sql: RevealSql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: Array<string | number | null | ArrayBuffer>) {
    if (failSql && query.includes(failSql)) throw new Error('injected failure');
    const statement = database.prepare(query);
    const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
    return { toArray: () => rows as T[] };
  } };
  const transaction = <T>(action: () => T): T => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = action(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  const random: number[] = [];
  const open = () => new EthereumRevealStore(sql, transaction, maximum => {
    const value = random.shift() ?? 0;
    assert.ok(value >= 0 && value < maximum);
    return value;
  });
  const store = open();
  store.configure(deployment);
  while (!store.initializeChunk()) {}
  t.after(() => database.close());
  return { database, store, deployment, random, open, fail: (value?: string) => { failSql = value; } };
}

function stage(store: EthereumRevealStore) {
  store.catalogUpdate.beginEmptyRebuild({ operationId, batch, now: 1000 });
  while (store.catalogUpdate.status(operationId)!.generationSeeded < 111111) store.catalogUpdate.stageEmptyRebuild(operationId);
  store.catalogUpdate.sealEmptyRebuild(operationId);
}

test('empty rebuild resumes bounded atomic seeding and retains immutable origin and cancelled evidence', t => {
  const f = fixture(t);
  const origin = f.database.prepare('SELECT deployment_json FROM settings').get()!.deployment_json;
  f.store.catalogUpdate.begin(batch, 500);
  f.store.catalogUpdate.stageMappings(batch.batchId, batch.mappings.slice(0, 256));
  f.store.catalogUpdate.cancel(batch.batchId);
  const started = f.store.catalogUpdate.beginEmptyRebuild({ operationId, batch, now: 1000 });
  assert.equal(started.mode, 'empty-rebuild');
  assert.equal(started.total, 0);
  assert.equal(started.batchSha256, batch.batchSha256);
  assert.deepEqual(started.categoryCounts, { egg: 38652, painting: 68980, video: 58, '3d': 3000, animated: 421 });
  f.fail('UPDATE reveal_catalog_pools SET seeded=seeded+?');
  assert.throws(() => f.store.catalogUpdate.stageEmptyRebuild(operationId), /injected failure/);
  f.fail();
  assert.equal(f.store.catalogUpdate.status(operationId)!.generationSeeded, 0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM reveal_catalog_free WHERE generation=?').get(operationId)!.n, 0);
  assert.equal(f.store.catalogUpdate.stageEmptyRebuild(operationId).generationSeeded, 4096);
  const reopened = f.open();
  assert.equal(reopened.catalogUpdate.beginEmptyRebuild({ operationId, batch }).generationSeeded, 4096);
  stage(reopened);
  assert.throws(() => reopened.catalogUpdate.activate(operationId), /empty pool rebuild activation/);
  const active = reopened.catalogUpdate.activateEmptyRebuild(operationId, 2000);
  assert.equal(active.targetRevision, 1);
  assert.equal(active.frozen, 0);
  assert.equal(active.metadataStaged, 0);
  assert.equal(reopened.catalogUpdate.verifyEmptyRebuild(operationId).generationSeeded, 111111);
  assert.equal(f.database.prepare('SELECT deployment_json FROM settings').get()!.deployment_json, origin);
  assert.equal(f.database.prepare('SELECT allocation_base_generation FROM settings').get()!.allocation_base_generation, operationId);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM reveal_catalog_mappings WHERE batch_id=?').get(operationId)!.n, 0);
  reopened.catalogUpdate.finalize(operationId);
  let remaining = 111111;
  for (;;) {
    const result = reopened.catalogUpdate.pruneEmptyRebuild(operationId);
    assert.ok(result.remaining <= remaining && remaining - result.remaining <= 8192);
    remaining = result.remaining;
    if (!remaining) break;
  }
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM free_slots').get()!.n, 0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM pools').get()!.n, 0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM reveal_catalog_mappings WHERE batch_id=?').get(batch.batchId)!.n, 256);
  assert.equal(reopened.catalogUpdate.status(batch.batchId)!.phase, 'cancelled');
  assert.throws(() => f.database.prepare("UPDATE reveal_catalog_generations SET mode='online' WHERE batch_id=?").run(operationId), /immutable/);
});

test('empty rebuild rejects testnet, existing reservations, changed replay, and incomplete or corrupted target ranges', t => {
  const testnet = fixture(t, 11155111);
  assert.throws(() => testnet.store.catalogUpdate.beginEmptyRebuild({ operationId, batch }), /mainnet/);
  const reserved = fixture(t);
  reserved.store.reserve(['111112']);
  assert.throws(() => reserved.store.catalogUpdate.beginEmptyRebuild({ operationId, batch }), /zero assignments/);
  const f = fixture(t);
  f.store.catalogUpdate.beginEmptyRebuild({ operationId, batch });
  assert.throws(() => f.store.reserve(['111112']), /fenced/);
  assert.throws(() => f.store.catalogUpdate.sealEmptyRebuild(operationId), /incomplete/);
  const changed = makeBatch();
  changed.nonce = '00000000-0000-4000-8000-000000000010';
  changed.batchSha256 = revealCatalogUpdateHash(changed);
  changed.batchId = `catalog-${changed.batchSha256.slice(0, 32)}`;
  assert.throws(() => f.store.catalogUpdate.beginEmptyRebuild({ operationId, batch: changed }), /replay/);
  stage(f.store);
  f.database.prepare("UPDATE reveal_catalog_free SET origin_asset_id=111112,asset_id=111112 WHERE generation=? AND category='painting' AND slot=0").run(operationId);
  assert.throws(() => f.store.catalogUpdate.activateEmptyRebuild(operationId), /asset identities/);
  assert.equal(f.store.catalogUpdate.effectiveCatalog()!.catalogVersion, '111k-v8');
});

test('an existing store refreshes cached allocation counts after another store rebuilds the base', { timeout: 60_000 }, t => {
  const f = fixture(t);
  const store = f.store;
  store.catalogUpdate.begin(batch, 500);
  const originalUnit = store.catalogUpdate.takeFree('3d', 0);
  store.catalogUpdate.releaseFree(originalUnit);
  store.catalogUpdate.cancel(batch.batchId);
  const rebuildingStore = f.open();
  stage(rebuildingStore);
  rebuildingStore.catalogUpdate.activateEmptyRebuild(operationId, 2000);
  rebuildingStore.catalogUpdate.finalize(operationId);
  while (rebuildingStore.catalogUpdate.pruneEmptyRebuild(operationId).remaining) {}
  f.random.push(target.categories['3d'].count + target.categories.animated.count + target.categories.eggs.count, target.categories.paintings.count - 1);
  store.freeze(f.deployment, { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 },
    [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], 3000);
  const before = store.catalogUpdate.canonicalMetadata(['1'])[0];
  assert.equal(before.category, 'painting');
  assert.equal(before.assetId, 68980);
  assert.equal(before.assignmentRevision, 1);
  assert.equal(before.metadataRevision, 2);
  assert.equal(before.migration, false);
  assert.deepEqual(before.artwork.attributes, [{ trait_type: 'type', value: 'painting' }]);
  const next: RevealAssetCatalog = structuredClone(target);
  next.catalogVersion = '111k-v10';
  next.categories.eggs.count--;
  next.categories.videos.count++;
  next.categories.videos.aspectRatioIndexById = [...next.categories.videos.aspectRatioIndexById!, 0];
  const update = makeBatch(target, next);
  store.catalogUpdate.begin(update, 4000);
  store.catalogUpdate.stageMappings(update.batchId, update.mappings);
  store.catalogUpdate.sealMappings(update.batchId);
  const attributesJson = JSON.stringify([{ trait_type: 'collection block', value: 'future' }]);
  store.catalogUpdate.metadataStage(update.batchId, [{ category: 'video', assetId: 59, attributesJson, sha256: digest(attributesJson) }]);
  while (store.catalogUpdate.status(update.batchId)!.generationSeeded < 111111) store.catalogUpdate.generationStage(update.batchId);
  store.catalogUpdate.seal(update.batchId);
  store.catalogUpdate.activate(update.batchId, 5000);
  assert.equal(store.catalogUpdate.verify(update.batchId).targetRevision, 2);
  assert.equal(store.catalogUpdate.canonicalMetadata(['1'])[0].metadataJson, before.metadataJson);
  assert.deepEqual(store.catalogUpdate.resolveUnit({ category: 'egg', assetId: target.categories.eggs.count }),
    { category: 'video', assetId: 59, assignmentRevision: 2 });
  assert.equal(store.catalogUpdate.pools().reduce((sum, pool) => sum + pool.available, 0), 111091);
});
