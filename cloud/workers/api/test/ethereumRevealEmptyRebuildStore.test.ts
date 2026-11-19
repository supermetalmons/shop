import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { computeRevealCatalogDescriptor, type RevealAssetCatalog } from '../../../../shared/ethereum/revealAssetCatalog.ts';
import { revealCatalogAdditions, revealCatalogUpdateHash, type RevealCatalogUpdateBatch, type RevealCatalogUpdateBody } from '../../../../shared/ethereum/revealCatalogUpdate.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import type { RevealSql } from '../src/ethereumRevealStore.ts';
import { HistoricalRevealStore as EthereumRevealStore } from './historicalCatalogFixture.ts';
import { lookupRevealCollectionBlock, selectRevealCollectionBlocks, validateRevealCollectionBlocks } from '../../../../shared/ethereum/revealCollectionBlocks.ts';
import { revealCollectionBlocks } from '../src/ethereumRevealCollectionBlocks.ts';
import { backfillRevealAttributePage } from '../src/ethereumRevealAttributeBackfill.ts';
import installedCollectionBlocks from '../../../../scripts/ethereum-metadata/reveal-assets/111k_devnet/collection-blocks.json';
import supplement from '../../../../shared/ethereum/ownerHatchingCatalog.json';
import { mixedReleaseBlockHash, type MixedAllocationGroup } from '../../../../shared/ethereum/revealMixedAllocation.ts';
import { appendTwinTrait, type TwinRole } from '../../../../shared/ethereum/twinMetadataTrait.ts';
import { initializeDuplicateReplacementReads } from '../src/ethereumRevealSlotOverrides.ts';
import { registerRevealCollectionBlocksFixture } from './revealCollectionBlocksFixture.ts';

const originalCollectionBlocks = structuredClone(installedCollectionBlocks);
test.afterEach(() => { Object.assign(installedCollectionBlocks, structuredClone(originalCollectionBlocks)); });

const predecessor = getRevealCatalog('111k-v8')!;
const target = getRevealCatalog('111k-v9')!;
const operationId = 'empty-mainnet-test-v9';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function makeBatch(before = predecessor, after = target) {
  registerRevealCollectionBlocksFixture(after, 'future');
  const body: RevealCatalogUpdateBody = { version: 1, nonce: '00000000-0000-4000-8000-000000000009',
    predecessor: { manifest: before, descriptor: computeRevealCatalogDescriptor(before) },
    target: { manifest: after, descriptor: computeRevealCatalogDescriptor(after) },
    mappings: revealCatalogAdditions(before, after).map((row, index) => ({ eggId: after.categories.eggs.count + index + 1, ...row })) };
  const batchSha256 = revealCatalogUpdateHash(body);
  return { ...body, batchId: `catalog-${batchSha256.slice(0, 32)}`, batchSha256 };
}
const batch = makeBatch();

function fixture(t: TestContext, chainId = 1, catalog = predecessor) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  const templateJson = JSON.stringify({ name: '{{tokenId}}', image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] });
  const deployment: EthereumRevealDeployment = { deploymentId: 'mainnet-empty-test', dropId: '111k', chainId,
    contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 100,
    catalogVersion: catalog.catalogVersion, templateJson, templateSha256: digest(templateJson), state: 'active', revision: 3,
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
  return { database, sql, store, deployment, random, open, fail: (value?: string) => { failSql = value; } };
}

function stage(store: EthereumRevealStore) {
  store.catalogUpdate.beginEmptyRebuild({ operationId, batch, now: 1000 });
  while (store.catalogUpdate.reader.status(operationId)!.generationSeeded < 111111) store.catalogUpdate.stageEmptyRebuild(operationId);
  store.catalogUpdate.sealEmptyRebuild(operationId);
}

function sparseBatch(before: RevealAssetCatalog, after: RevealAssetCatalog): RevealCatalogUpdateBatch {
  const body: RevealCatalogUpdateBody = { ...makeBatch(before, after), version: 2, eggCutoff: 0,
    mappings: revealCatalogAdditions(before, after).map((row, index) => ({ eggId: index + 1, ...row })) };
  const batchSha256 = revealCatalogUpdateHash(body);
  return { ...body, batchId: `catalog-${batchSha256.slice(0, 32)}`, batchSha256 };
}

function stageOnline(store: EthereumRevealStore, update: RevealCatalogUpdateBatch) {
  const updates = store.catalogUpdate;
  updates.begin(update, 500);
  for (let offset = 0; offset < update.mappings.length; offset += 256) {
    updates.stageMappings(update.batchId, update.mappings.slice(offset, offset + 256));
  }
  updates.sealMappings(update.batchId);
  const blocks = revealCollectionBlocks(update.target.descriptor);
  for (;;) {
    const page = updates.reader.metadataPreparationPage(update.batchId, 256);
    if (!page.length) break;
    updates.metadataStage(update.batchId, page.map(row => {
      const block = lookupRevealCollectionBlock(blocks, row.category, row.assetId);
      assert.ok(block);
      const attributesJson = JSON.stringify([{ trait_type: 'collection block', value: block }]);
      return { ...row, attributesJson, sha256: digest(attributesJson) };
    }));
  }
  while (updates.reader.status(update.batchId)!.generationSeeded < 111111) updates.generationStage(update.batchId);
  updates.seal(update.batchId);
}

test('empty rebuild replaces an activated sparse allocation base and preserves later online mapping verification', { timeout: 90_000 }, t => {
  const origin = getRevealCatalog('111k-v7')!;
  const f = fixture(t, 1, origin);
  const sparse = sparseBatch(origin, predecessor);
  assert.equal(sparse.mappings.length, 5201);
  assert.deepEqual(sparse.mappings[0], { eggId: 1, category: 'painting', assetId: 47129 });
  assert.deepEqual(sparse.mappings.at(-1), { eggId: 5201, category: 'painting', assetId: 52329 });
  stageOnline(f.store, sparse);
  f.store.catalogUpdate.activate(sparse.batchId, 600);
  f.store.catalogUpdate.finalize(sparse.batchId);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM assignments').get()!.n, 0);
  const priorInventory = () => ({
    settings: f.database.prepare(`SELECT deployment_json,active_catalog_generation,allocation_base_generation,
      effective_catalog_version,effective_catalog_sha256,catalog_revision FROM settings`).get(),
    pools: f.database.prepare('SELECT * FROM reveal_catalog_pools WHERE generation=? ORDER BY category').all(sparse.batchId),
    free: digest(JSON.stringify(f.database.prepare('SELECT * FROM reveal_catalog_free WHERE generation=? ORDER BY category,slot').all(sparse.batchId))),
  });
  const before = priorInventory();
  f.store.catalogUpdate.beginEmptyRebuild({ operationId, batch, now: 1000 });
  while (f.store.catalogUpdate.reader.status(operationId)!.generationSeeded < 111111) f.store.catalogUpdate.stageEmptyRebuild(operationId);
  assert.equal(f.store.catalogUpdate.reader.verifyEmptyRebuild(operationId).targetRevision, 2);
  f.database.prepare("UPDATE reveal_catalog_free SET origin_asset_id=111112,asset_id=111112 WHERE generation=? AND category='painting' AND slot=0").run(operationId);
  assert.throws(() => f.store.catalogUpdate.sealEmptyRebuild(operationId), /asset identities/);
  assert.deepEqual(priorInventory(), before);
  assert.equal(f.store.catalogUpdate.reader.status(operationId)!.phase, 'staging');
  f.database.prepare("UPDATE reveal_catalog_free SET origin_asset_id=1,asset_id=1 WHERE generation=? AND category='painting' AND slot=0").run(operationId);
  f.store.catalogUpdate.sealEmptyRebuild(operationId);
  f.fail('UPDATE settings SET active_catalog_generation');
  assert.throws(() => f.store.catalogUpdate.activateEmptyRebuild(operationId, 2000), /injected failure/);
  f.fail();
  assert.deepEqual(priorInventory(), before);
  assert.equal(f.store.catalogUpdate.reader.status(operationId)!.phase, 'ready');
  assert.equal(f.store.catalogUpdate.reader.status(operationId)!.activatedAtMs, null);
  const reopened = f.open();
  reopened.catalogUpdate.activateEmptyRebuild(operationId, 2000);
  assert.equal(reopened.catalogUpdate.reader.verifyEmptyRebuild(operationId).targetRevision, 2);
  reopened.catalogUpdate.finalize(operationId);
  while (reopened.catalogUpdate.pruneEmptyRebuild(operationId).remaining) {}
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM reveal_catalog_mappings WHERE batch_id=?').get(sparse.batchId)!.n, 5201);
  assert.deepEqual(reopened.catalogUpdate.reader.resolveUnit({ category: 'egg', assetId: 1 }), { category: 'egg', assetId: 1, assignmentRevision: 2 });
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM reveal_catalog_free WHERE generation=? AND category='painting' AND asset_id BETWEEN 47129 AND 52329").get(operationId)!.n, 5201);
  f.random.push(target.categories['3d'].count + target.categories.animated.count, 0);
  reopened.freeze(f.deployment, { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 },
    [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], 3000);
  assert.equal(reopened.catalogUpdate.reader.canonicalMetadata(['1'])[0].category, 'egg');
  const next = structuredClone(target);
  next.catalogVersion = '111k-v10';
  next.categories.eggs.count--;
  next.categories.videos.count++;
  next.categories.videos.aspectRatioIndexById = [...next.categories.videos.aspectRatioIndexById!, 0];
  const update = sparseBatch(target, next);
  stageOnline(reopened, update);
  reopened.catalogUpdate.activate(update.batchId, 4000);
  const publication = reopened.catalogUpdate.reader.publicationPage(update.batchId)[0];
  assert.equal(publication.tokenId, '1');
  assert.equal(publication.assetId, 59);
  reopened.catalogUpdate.acknowledgePublication(update.batchId, publication.tokenId, publication.metadataRevision, publication.targetSha256);
  reopened.catalogUpdate.finalize(update.batchId);
  assert.equal(reopened.catalogUpdate.reader.verify(sparse.batchId).targetRevision, 1);
  assert.equal(f.open().catalogUpdate.reader.verify(update.batchId).targetRevision, 3);
  assert.deepEqual(reopened.catalogUpdate.reader.resolveUnit({ category: 'egg', assetId: 1 }), { category: 'video', assetId: 59, assignmentRevision: 3 });
  assert.equal(reopened.catalogUpdate.reader.pools().reduce((sum, pool) => sum + pool.available, 0), 111091);
});

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
  assert.equal(f.store.catalogUpdate.reader.status(operationId)!.generationSeeded, 0);
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
  assert.equal(reopened.catalogUpdate.reader.verifyEmptyRebuild(operationId).generationSeeded, 111111);
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
  assert.equal(reopened.catalogUpdate.reader.status(batch.batchId)!.phase, 'cancelled');
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
  assert.equal(f.store.catalogUpdate.reader.effectiveCatalog()!.catalogVersion, '111k-v8');
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
  const before = store.catalogUpdate.reader.canonicalMetadata(['1'])[0];
  assert.equal(before.category, 'painting');
  assert.equal(before.assetId, 68980);
  assert.equal(before.assignmentRevision, 1);
  assert.equal(before.metadataRevision, 2);
  assert.equal(before.migration, false);
  assert.deepEqual(before.artwork.attributes, [
    { trait_type: 'collection block', value: 'watercolor mons' },
    { trait_type: 'artist', value: 'evil biscuit' },
    { trait_type: 'type', value: 'painting' },
  ]);
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
  while (store.catalogUpdate.reader.status(update.batchId)!.generationSeeded < 111111) store.catalogUpdate.generationStage(update.batchId);
  store.catalogUpdate.seal(update.batchId);
  store.catalogUpdate.activate(update.batchId, 5000);
  assert.equal(store.catalogUpdate.reader.verify(update.batchId).targetRevision, 2);
  assert.equal(store.catalogUpdate.reader.canonicalMetadata(['1'])[0].metadataJson, before.metadataJson);
  assert.deepEqual(store.catalogUpdate.reader.resolveUnit({ category: 'egg', assetId: target.categories.eggs.count }),
    { category: 'video', assetId: 59, assignmentRevision: 2 });
  assert.equal(store.catalogUpdate.reader.pools().reduce((sum, pool) => sum + pool.available, 0), 111091);
});

function correctedInventory(t: TestContext) {
  const f = fixture(t);
  stage(f.store);
  const catalog = f.store.catalogUpdate;
  catalog.activateEmptyRebuild(operationId, 2000);
  catalog.finalize(operationId);
  while (catalog.pruneEmptyRebuild(operationId).remaining) {}
  f.database.exec(`CREATE TABLE reveal_duplicate_replacements(origin_category TEXT, origin_asset_id INTEGER, egg_id INTEGER UNIQUE,
    PRIMARY KEY(origin_category,origin_asset_id))`);
  assert.equal(catalog.reader.freshEggBounds().maximum, 76_700);
  initializeDuplicateReplacementReads(f.sql);
  return f;
}

test('a corrected free painting stays an egg across draw, freeze, publication, restart and a later owner hatch', t => {
  const f = correctedInventory(t);
  const catalog = f.store.catalogUpdate;
  const origin = { category: 'painting' as const, assetId: 1 };
  const eggId = catalog.reader.freshEggBounds().lastIssued + 1;
  const insert = () => { f.database.prepare('INSERT INTO reveal_duplicate_replacements VALUES(?,?,?)').run(origin.category, origin.assetId, eggId); };
  const before = catalog.reader.pools();
  assert.throws(() => catalog.replaceFreePaintingWithEgg(origin, eggId, () => { insert(); throw new Error('injected'); }), /injected/);
  assert.deepEqual(catalog.reader.pools(), before);
  assert.equal(catalog.reader.freshOwnerEggAvailable(eggId), true);
  catalog.replaceFreePaintingWithEgg(origin, eggId, insert);
  assert.equal(catalog.reader.freshOwnerEggAvailable(eggId), false);
  const inventory = catalog.reader.requireFreshEggInventory(1);
  assert.ok(inventory.used.has(eggId));
  assert.equal(inventory.maximum, 76_700);
  assert.equal(inventory.used.size, 14_191);
  assert.equal(catalog.reader.freshOwnerEggAvailable(62_511), false);
  const remaining = inventory.maximum - inventory.lastIssued - inventory.used.size;
  assert.equal(catalog.reader.requireFreshEggInventory(remaining).maximum, inventory.maximum);
  assert.throws(() => catalog.reader.requireFreshEggInventory(remaining + 1), /Insufficient unused/);
  const expanded = t.mock.method(catalog.reader, 'activeCatalog', () => ({ ...target, importSettings: { ...target.importSettings, availableEggs: 76_701 } }));
  assert.equal(catalog.reader.freshOwnerEggAvailable(76_700), false);
  assert.equal(catalog.reader.freshOwnerEggAvailable(76_701), true);
  assert.equal(catalog.reader.requireFreshEggInventory(remaining + 1).maximum, 76_701);
  expanded.mock.restore();
  assert.equal(catalog.reader.pools().find(pool => pool.category === 'painting')!.total, target.categories.paintings.count - 1);
  const eggSlot = catalog.reader.pools().find(pool => pool.category === 'egg')!.available - 1;
  assert.deepEqual(catalog.takeFree('egg', eggSlot), origin);
  catalog.releaseFree(origin);
  catalog.reader.verifyGeneration(operationId);
  f.random.push(target.categories['3d'].count + target.categories.animated.count, eggSlot);
  f.store.reserve(['111112']);
  const tokens = Array.from({ length: 20 }, (_, i) => String(i + 1));
  f.store.freeze(f.deployment, { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 },
    [{ crateTokenId: '111112', tokenIds: tokens }], 3000);
  assert.equal(f.store.frozen(['1'])[0].image, `https://cdn.lil.org/nft/111k/eggs/${eggId}.png`);
  const frozen = catalog.reader.canonicalMetadata(['1'])[0];
  assert.equal(frozen.category, 'egg');
  assert.equal(frozen.assetId, eggId);
  assert.equal(JSON.parse(frozen.metadataJson).name, `Egg #${eggId}`);
  assert.equal(f.store.publicationComplete('1'), true);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM reveal_enrichment WHERE token_id='1'").get()!.n, 0);
  assert.equal(backfillRevealAttributePage(f.sql, { afterTokenId: null, write: false, retryBlocked: false }).eligible, 0);
  const reopened = f.open().catalogUpdate;
  assert.deepEqual(reopened.reader.canonicalMetadata(['1'])[0].artwork, frozen.artwork);
  reopened.ownerHatching.prepare({ batchId: 'owner-corrected-egg', sourceSha256: 'a'.repeat(64), candidateTokenIds: ['1'],
    readyCount: 1, freshEggIds: [], grails: [{ category: 'animated', assetId: 422 }] });
  const hatch = reopened.ownerHatching.hatch('1');
  assert.equal(hatch.kind, 'hatched');
  assert.equal(reopened.reader.canonicalMetadata(['1'])[0].assetId, 422);
  assert.equal(reopened.reader.resolveUnit(origin).category, 'animated');
  assert.equal(reopened.reader.freshOwnerEggAvailable(eggId), false);
  reopened.reader.verifyGeneration(operationId);
});

test('the next mixed allocation can exchange a corrected egg and preserves its retired painting and fresh egg history', t => {
  const f = correctedInventory(t);
  const updates = f.store.catalogUpdate;
  const origin = { category: 'painting' as const, assetId: target.categories.paintings.count };
  const eggId = updates.reader.freshEggBounds().lastIssued + 1;
  updates.replaceFreePaintingWithEgg(origin, eggId, () => {
    f.database.prepare('INSERT INTO reveal_duplicate_replacements VALUES(?,?,?)').run(origin.category, origin.assetId, eggId);
  });

  const next = getRevealCatalog('111k-v10')!;
  const descriptor = computeRevealCatalogDescriptor(next);
  const sourceBlocks: unknown = installedCollectionBlocks;
  validateRevealCollectionBlocks(sourceBlocks);
  const blocks = selectRevealCollectionBlocks(sourceBlocks, descriptor);
  const groups: MixedAllocationGroup[] = [];
  for (const asset of revealCatalogAdditions(target, next)) {
    const block = lookupRevealCollectionBlock(blocks, asset.category, asset.assetId)!;
    const prior = groups.at(-1);
    if (prior && prior.category === asset.category && prior.collectionBlock === block && prior.lastId + 1 === asset.assetId) prior.lastId++;
    else groups.push({ category: asset.category, collectionBlock: block, firstId: asset.assetId, lastId: asset.assetId, ownerCount: 0 });
  }
  const batchId = 'next-after-correction';
  const scope = f.deployment;
  const definition = { version: 2 as const, batchId, deploymentId: scope.deploymentId, chainId: scope.chainId, contractAddress: scope.contractAddress,
    metadataBaseUri: scope.metadataBaseUri, deploymentBlock: scope.deploymentBlock, originCatalogVersion: scope.catalogVersion,
    sourceSha256: next.source.sha256, predecessor: computeRevealCatalogDescriptor(target), target: descriptor,
    ownerSupplementSha256: digest(JSON.stringify(supplement)), collectionBlocksSha256: mixedReleaseBlockHash(sourceBlocks, descriptor), groups, ordinaryCount: 0 };
  const mixed = updates.mixed;
  mixed.begin({ batchId, definition, targetCatalog: next });
  for (let pending = mixed.pendingTraits(batchId, 256); pending.length; pending = mixed.pendingTraits(batchId, 256)) {
    mixed.stageTraits(batchId, pending.map(asset => {
      const attributesJson = JSON.stringify([{ trait_type: 'collection block', value: lookupRevealCollectionBlock(blocks, asset.category, asset.assetId) }]);
      return { ...asset, attributesJson, sha256: digest(attributesJson) };
    }));
  }
  while (mixed.stageInventory(batchId, 4096).generationSeeded < 111_111) {}
  mixed.seal(batchId);
  mixed.activate(batchId, []);
  const replacement = updates.reader.resolveUnit(origin);
  assert.equal(replacement.category, 'painting');
  assert.ok(replacement.assetId > target.categories.paintings.count);
  mixed.verify(batchId);
  assert.equal(updates.reader.freshOwnerEggAvailable(eggId), false);
  assert.ok(updates.reader.requireFreshEggInventory(1).used.has(76_700));
  const row = f.database.prepare(`SELECT slot,asset_id FROM reveal_catalog_free WHERE generation=? AND origin_category='painting'
    AND origin_asset_id=? AND category='painting'`).get(batchId, origin.assetId);
  assert.equal(row?.asset_id, replacement.assetId);
  const counts = updates.reader.pools();
  f.random.push(counts.filter(p => p.category < 'painting').reduce((sum, p) => sum + p.total, 0), Number(row!.slot));
  f.store.freeze(scope, { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 },
    [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, i) => String(i + 1)) }], 3000);
  const published = updates.reader.canonicalMetadata(['1'])[0];
  assert.equal(published.assetId, replacement.assetId);
  assert.equal(published.artwork.image, `https://cdn.lil.org/nft/111k/paintings/${replacement.assetId}.png`);
  assert.ok(JSON.parse(published.metadataJson).attributes.some((attr: { trait_type: string }) => attr.trait_type === 'collection block'));
  f.store.publicationComplete('1');
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM reveal_enrichment WHERE token_id='1'").get()!.n, 0);
  assert.deepEqual(f.open().catalogUpdate.reader.canonicalMetadata(['1'])[0].artwork, published.artwork);
});

test('terminal twin traits survive ordinary and owner reveal reads, stale publication, and attribute repair', t => {
  const f = correctedInventory(t), catalog = f.store.catalogUpdate, owner = catalog.ownerHatching;
  const ids = Array.from({ length: 20 }, (_, i) => String(i + 1));
  f.random.push(3421, 0, 3421 + target.categories.eggs.count, 0);
  f.store.freeze(f.deployment, { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 },
    [{ crateTokenId: '111112', tokenIds: ids }], 3000);
  for (const id of ids) f.store.publicationComplete(id);
  owner.prepare({ batchId: 'twin-test', sourceSha256: 'a'.repeat(64), candidateTokenIds: ['1'], readyCount: 1,
    freshEggIds: [catalog.reader.freshEggBounds().lastIssued + 1], grails: [] });
  const paintingPool = catalog.reader.pools().filter(pool => pool.category === 'painting');
  const pools = t.mock.method(catalog.reader, 'pools', () => paintingPool);
  assert.equal(owner.hatch('1', 4000).kind, 'hatched');
  pools.mock.restore();
  const hatched = owner.reader.canonical('1')!;
  assert.equal(hatched.category, 'painting');
  assert.ok(owner.acceptEnrichment('1', hatched.metadataRevision, hatched.metadataJson, hatched.targetSha256));
  const ownerJobs = owner.claimPublications(5000);
  owner.completePublications(ownerJobs.map(job => ({ job, status: 'published' })), 5000);
  const base = catalog.reader.canonicalMetadata(['2'])[0];
  assert.equal(base.category, 'painting');
  const enriched = JSON.parse(base.metadataJson);
  enriched.attributes.push({ trait_type: 'colour', value: 'ochre' });
  const metadataJson = JSON.stringify(enriched) + '\n';
  f.database.prepare(`UPDATE reveal_enrichment SET target_json=?,target_sha256=?,status='published' WHERE token_id='2'`).run(metadataJson, digest(metadataJson));
  const before = catalog.reader.canonicalMetadata(['1', '2', '3']);
  f.database.exec(`CREATE TABLE reveal_twin_annotations(token_id TEXT PRIMARY KEY,painting_id INTEGER UNIQUE,role TEXT,predecessor_sha256 TEXT,
    target_sha256 TEXT,metadata_revision INTEGER,published INTEGER)`);
  const roles: TwinRole[] = ['good twin', 'evil twin'];
  for (const [index, value] of before.slice(0, 2).entries()) {
    f.database.prepare('INSERT INTO reveal_twin_annotations VALUES(?,?,?,?,?,?,0)').run(value.tokenId, value.assetId, roles[index],
      value.targetSha256, digest(appendTwinTrait(value.metadataJson, roles[index])), value.metadataRevision + 1);
  }
  assert.throws(() => backfillRevealAttributePage(f.sql, { audit: true, frozenThroughMs: 5000, afterTokenId: null, write: false }), /twin metadata publication/);
  const reader = f.open().catalogUpdate.reader;
  const current = reader.canonicalMetadata(['1','2','3']);
  assert.deepEqual(current[2], before[2]);
  const lightweight = reader.canonicalArtworks(['1','2','3']);
  for (let i = 0; i < 2; i++) {
    const value = current[i], previous = before[i];
    const role = { trait_type: roles[i], value: true };
    assert.equal(value.metadataJson, appendTwinTrait(previous.metadataJson, roles[i]));
    assert.equal(value.metadataRevision, previous.metadataRevision + 1);
    assert.deepEqual(value.expectedJsons, [previous.metadataJson]);
    assert.equal(value.allowMissing, false);
    assert.deepEqual(lightweight[i].attributes?.at(-1), role);
    assert.equal(lightweight[i].metadataRevision, value.metadataRevision);
    assert.deepEqual(value.artwork.attributes?.at(-1), role);
    assert.ok(reader.validateMetadataWrite({ tokenId: value.tokenId, metadataRevision: value.metadataRevision,
      metadataJson: value.metadataJson, expectedJsons: [previous.metadataJson], allowMissing: false }));
    assert.equal(reader.validateMetadataWrite({ tokenId: value.tokenId, metadataRevision: previous.metadataRevision,
      metadataJson: previous.metadataJson, expectedJsons: [], allowMissing: false }), false);
  }
  const retry = owner.hatch('1', 6000);
  assert.equal(retry.kind, 'hatched');
  if (retry.kind === 'hatched') assert.deepEqual(retry.artwork, lightweight[0]);
  assert.deepEqual(reader.canonicalMetadata(['1', '1']), [current[0],current[0]]);
  f.database.exec('UPDATE reveal_twin_annotations SET published=1');
  const audit = backfillRevealAttributePage(f.sql, { audit: true, frozenThroughMs: 5000, afterTokenId: null, write: false });
  assert.equal(audit.tokens!.find(token => token.tokenId === '2')!.metadataSha256, current[1].targetSha256);
  assert.equal(backfillRevealAttributePage(f.sql, { afterTokenId: null, recheckTokenId: '2', write: true }).enqueued, 0);
  f.database.exec("UPDATE reveal_enrichment SET status='pending' WHERE token_id='2'");
  assert.ok(!f.store.enrichment.claim(6000).some(job => job.token_id === '2'));
  f.database.exec("UPDATE reveal_twin_annotations SET predecessor_sha256='unexpected' WHERE token_id='1'");
  assert.throws(() => reader.canonicalMetadata(['1']), /predecessor changed/);
});
