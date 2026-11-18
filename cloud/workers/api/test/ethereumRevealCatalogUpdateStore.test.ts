import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { computeRevealCatalogDescriptor, type RevealAssetCatalog } from '../../../../shared/ethereum/revealAssetCatalog.ts';
import { revealCatalogUpdateHash, type RevealCatalogUpdateBatch, type RevealCatalogUpdateBody } from '../../../../shared/ethereum/revealCatalogUpdate.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { REVEAL_ENRICHMENT_VERSION } from '../../../../shared/ethereum/reveal.ts';
import type { RevealSql } from '../src/ethereumRevealStore.ts';
import { HistoricalRevealStore as EthereumRevealStore } from './historicalCatalogFixture.ts';
import { applyRevealAttributePayload, MAX_REVEAL_METADATA_BYTES } from '../src/ethereumRevealAttributes.ts';
import { buildNewRevealedArtwork, buildRevealedArtwork } from '../src/ethereumRevealCatalog.ts';
import { EthereumRevealCatalogReader } from '../src/ethereumRevealCatalogReader.ts';
import { registerRevealCollectionBlocksFixture } from './revealCollectionBlocksFixture.ts';

const source = getRevealCatalog('111k-v5')!;
const templateJson = JSON.stringify({ name: '{{tokenId}}', description: '111k', image: 'https://cdn.lil.org/nft/111k/placeholder.png',
  attributes: [{ trait_type: 'series', value: '111K' }] });
const deployment: EthereumRevealDeployment = { deploymentId: 'catalog-update-test', dropId: '111k_devnet', chainId: 11155111,
  contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/catalog-update-test/',
  deploymentBlock: 100, catalogVersion: source.catalogVersion, templateJson,
  templateSha256: createHash('sha256').update(templateJson).digest('hex'), state: 'active', revision: 3,
  createdAtMs: 1, updatedAtMs: 3, provisionedAtMs: 2, activatedAtMs: 3, lastError: null };
const observation = { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 };

function batch(predecessor: RevealAssetCatalog = source, count = 3): RevealCatalogUpdateBatch {
  const target = structuredClone(predecessor);
  target.catalogVersion = `111k-v${Number(predecessor.catalogVersion.slice(6)) + 1}`;
  target.categories.eggs.count -= count;
  target.categories.videos.count += count;
  target.categories.videos.aspectRatioIndexById = [...target.categories.videos.aspectRatioIndexById!, ...Array<number>(count).fill(0)];
  registerRevealCollectionBlocksFixture(target, 'new artworks');
  const body: RevealCatalogUpdateBody = { version: 1, nonce: '00000000-0000-4000-8000-000000000001',
    predecessor: { manifest: predecessor, descriptor: computeRevealCatalogDescriptor(predecessor) },
    target: { manifest: target, descriptor: computeRevealCatalogDescriptor(target) },
    mappings: Array.from({ length: count }, (_, index) => ({ eggId: target.categories.eggs.count + index + 1,
      category: 'video', assetId: predecessor.categories.videos.count + index + 1 })) };
  const batchSha256 = revealCatalogUpdateHash(body);
  return { ...body, batchId: `catalog-${batchSha256.slice(0, 32)}`, batchSha256 };
}

function fixture(t: TestContext, scope = deployment, seedInventory = true) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  let failSql: string | undefined;
  let observed: Array<{ query: string; bindings: number }> | undefined;
  const sql: RevealSql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: Array<string | number | null | ArrayBuffer>) {
    if (failSql && query.includes(failSql)) throw new Error('injected failure');
    observed?.push({ query, bindings: bindings.length });
    const statement = database.prepare(query);
    const parameters = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...parameters) : (statement.run(...parameters), []);
    return { toArray: () => rows as T[] };
  } };
  const transaction = <T>(action: () => T): T => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = action(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  const random: number[] = [];
  const store = new EthereumRevealStore(sql, transaction, maximum => { const value = random.shift() ?? 0; assert.ok(value < maximum); return value; });
  store.configure(scope);
  if (seedInventory) while (!store.initializeChunk()) {}
  t.after(() => database.close());
  return { store, database, sql, transaction, random, fail: (fragment?: string) => { failSql = fragment; },
    observe: <T>(action: () => T) => {
      const queries: Array<{ query: string; bindings: number }> = [];
      observed = queries;
      try { return { value: action(), queries }; } finally { observed = undefined; }
    },
    reopen: () => new EthereumRevealStore(sql, transaction, () => 0) };
}

function reserveEgg(database: DatabaseSync, eggId: number, crateId: string, slot: number) {
  database.prepare('INSERT OR IGNORE INTO crates(crate_token_id) VALUES(?)').run(crateId);
  const selected = Number(database.prepare("SELECT slot FROM free_slots WHERE category='egg' AND asset_id=?").get(eggId)!.slot);
  const available = Number(database.prepare("SELECT available FROM pools WHERE category='egg'").get()!.available);
  const last = Number(database.prepare("SELECT asset_id FROM free_slots WHERE category='egg' AND slot=?").get(available - 1)!.asset_id);
  database.prepare("DELETE FROM free_slots WHERE category='egg' AND slot=?").run(available - 1);
  if (selected !== available - 1) database.prepare("UPDATE free_slots SET asset_id=? WHERE category='egg' AND slot=?").run(last, selected);
  database.prepare("UPDATE pools SET available=available-1 WHERE category='egg'").run();
  database.prepare("INSERT INTO assignments(category,asset_id,crate_token_id,slot) VALUES('egg',?,?,?)").run(eggId, crateId, slot);
}

const attributesJson = '[{"trait_type":"collection block","value":"new artworks"},{"trait_type":"serial","value":9007199254740993}]';
const attributesSha256 = createHash('sha256').update(attributesJson).digest('hex');
function stageMetadata(store: EthereumRevealStore, update: RevealCatalogUpdateBatch) {
  const operation = store.catalogUpdate;
  operation.begin(update, 2000);
  for (let offset = 0; offset < update.mappings.length; offset += 256) operation.stageMappings(update.batchId, update.mappings.slice(offset, offset + 256));
  operation.sealMappings(update.batchId);
  for (;;) {
    const page = operation.reader.metadataPreparationPage(update.batchId, 256);
    if (!page.length) break;
    operation.metadataStage(update.batchId, page.map(row => ({ ...row, attributesJson, sha256: attributesSha256 })));
  }
}

function stageGeneration(store: EthereumRevealStore, update: RevealCatalogUpdateBatch, interleave?: () => void) {
  while (store.catalogUpdate.reader.status(update.batchId)!.generationSeeded < 111111) {
    store.catalogUpdate.generationStage(update.batchId);
    interleave?.();
  }
  store.catalogUpdate.seal(update.batchId);
}

function conservation(store: EthereumRevealStore, database: DatabaseSync) {
  const pools = store.catalogUpdate.reader.pools();
  assert.equal(pools.reduce((sum, row) => sum + row.total, 0), 111111);
  assert.equal(pools.reduce((sum, row) => sum + row.available, 0) + Number(database.prepare('SELECT COUNT(*) AS count FROM assignments').get()!.count), 111111);
  assert.equal(new Set(store.catalogUpdate.reader.canonicalMetadata(['1', '2', '3']).map(row => `${row.category}:${row.assetId}`)).size,
    store.catalogUpdate.reader.canonicalMetadata(['1', '2', '3']).length);
}

test('catalog inspection is query-only on an uninitialized database', t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql: RevealSql = { exec<T>(query: string, ...bindings: Array<string | number | null | ArrayBuffer>) {
    return { toArray: () => database.prepare(query).all(...bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value)) as T[] };
  } };
  const schema = database.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
  const changes = database.prepare('SELECT total_changes() AS changes').get()!.changes;
  database.exec('PRAGMA query_only=ON');
  const reader = new EthereumRevealCatalogReader(sql);
  assert.equal(reader.status(), null);
  assert.equal(reader.effectiveCatalog(), null);
  assert.deepEqual(reader.canonicalMetadata(['1', '1']), []);
  assert.deepEqual(reader.canonicalArtworks(['1']), []);
  assert.equal(database.prepare('SELECT total_changes() AS changes').get()!.changes, changes);
  assert.deepEqual(database.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema);
});

test('canonical metadata batches reads with bounded parameters and preserves order, duplicates, and publication evidence', t => {
  const f = fixture(t);
  for (let eggId = 1; eggId <= 6; eggId++) reserveEgg(f.database, eggId, '111112', eggId - 1);
  const crates = Array.from({ length: 6 }, (_, index) => ({ crateTokenId: String(111112 + index),
    tokenIds: Array.from({ length: 20 }, (_, offset) => String(index * 20 + offset + 1)) }));
  f.store.freeze(deployment, observation, crates, 1000);
  const published = f.store.catalogUpdate.reader.canonicalMetadata(['1'])[0];
  f.database.prepare("UPDATE publication SET status='published',metadata_revision=? WHERE token_id='1'").run(published.metadataRevision);
  const ids = crates.flatMap(crate => crate.tokenIds);
  const expected = new Map(ids.map(tokenId => [tokenId, f.store.catalogUpdate.reader.canonicalMetadata([tokenId])[0]]));
  const schema = f.database.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
  const changes = f.database.prepare('SELECT total_changes() AS changes').get()!.changes;
  f.database.exec('PRAGMA query_only=ON');
  const reader = new EthereumRevealCatalogReader(f.sql);
  const counts: number[] = [];
  for (const [size, budget] of [[1, 12], [16, 12], [99, 12], [100, 19], [120, 18]]) {
    const requested = ids.slice(0, size).reverse();
    const result = f.observe(() => reader.canonicalMetadata(requested));
    counts.push(result.queries.length);
    assert.deepEqual(result.value, requested.map(tokenId => expected.get(tokenId)));
    assert.ok(result.queries.length <= budget, `${size} tokens used ${result.queries.length} queries; budget ${budget}`);
    assert.ok(result.queries.every(entry => entry.bindings <= 100 && /^(SELECT|WITH)\b/.test(entry.query)), 'reads stay bounded and read-only');
    assert.equal(result.queries.filter(entry => entry.query === 'SELECT * FROM settings WHERE id=1').length, 1);
    assert.equal(result.queries.filter(entry => entry.query.includes("name='reveal_enrichment'")).length, 1);
  }
  const requested = ['999', '120', '1', '2', '1', '119', '999', '120'];
  const mixed = f.observe(() => reader.canonicalMetadata(requested));
  assert.deepEqual(mixed.value, requested.flatMap(tokenId => expected.has(tokenId) ? [expected.get(tokenId)] : []));
  assert.equal(mixed.value.find(value => value.tokenId === '1')!.allowMissing, false);
  for (const value of mixed.value) {
    const persisted = f.database.prepare('SELECT metadata_json,placeholder_json FROM assignments WHERE token_id=?').get(value.tokenId)!;
    assert.equal(value.metadataJson, persisted.metadata_json);
    assert.equal(value.targetSha256, createHash('sha256').update(value.metadataJson).digest('hex'));
    assert.deepEqual(value.expectedJsons, [...new Set([persisted.placeholder_json, persisted.metadata_json])]);
    assert.equal(value.assignmentRevision, 0);
    assert.equal(value.metadataRevision, 0);
    assert.equal(value.migration, false);
  }
  assert.ok(f.observe(() => reader.canonicalMetadata(Array(300).fill('1'))).queries.length <= 12);
  assert.deepEqual(f.observe(() => reader.canonicalMetadata([])), { value: [], queries: [] });
  assert.equal(f.database.prepare('SELECT total_changes() AS changes').get()!.changes, changes);
  assert.deepEqual(f.database.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema);
  t.diagnostic(`canonical metadata queries for 1/16/99/100/120 tokens: ${counts.join('/')}`);
});

test('canonical payload reads stay byte bounded across ordinary, enriched, mapped and owner metadata', t => {
  const f = fixture(t, deployment, false);
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const descriptor = JSON.stringify(computeRevealCatalogDescriptor(source));
  for (const revision of [1, 2, 3]) {
    f.database.prepare(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,
      target_manifest_json,source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,activated_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(`generation-${revision}`, 'a'.repeat(64), descriptor, descriptor,
      JSON.stringify(source), revision - 1, revision, 4, 'b'.repeat(64), revision === 3 ? 'staging' : 'complete', revision, revision === 3 ? null : revision);
  }
  f.database.exec("UPDATE settings SET active_catalog_generation='generation-2',catalog_revision=2; INSERT INTO crates(crate_token_id) VALUES('111112')");
  const frozen = new Map<string, ReturnType<typeof buildNewRevealedArtwork>>();
  const enrichedMetadata = new Map<string, string>();
  for (let id = 1; id <= 13; id++) {
    const tokenId = String(id);
    const mapped = id >= 9 && id <= 12;
    const fresh = mapped && id % 2 === 1;
    const category = mapped || id === 13 ? 'egg' : 'painting';
    const build = mapped && !fresh ? buildRevealedArtwork : buildNewRevealedArtwork;
    const built = build({ templateJson: id <= 4
      ? JSON.stringify({ ...JSON.parse(templateJson), description: '☀'.repeat(id === 4 ? 130_000 : 70_000) }) : templateJson,
      tokenId, crateTokenId: '111112', category: fresh ? 'painting' : category, assetId: id, observation, catalog: source });
    if (fresh) {
      built.artwork.name = `saved fresh ${id}`;
      built.metadataJson = JSON.stringify({ ...JSON.parse(built.metadataJson), name: built.artwork.name }) + '\n';
    }
    assert.ok(Buffer.byteLength(built.metadataJson) <= MAX_REVEAL_METADATA_BYTES);
    frozen.set(tokenId, built);
    f.database.prepare(`INSERT INTO assignments(category,asset_id,crate_token_id,slot,token_id,artwork_json,
      metadata_json,placeholder_json,frozen_at_ms,assignment_revision) VALUES(?,?,'111112',?,?,?,?,?,?,?)`)
      .run(category, id, id - 1, tokenId, JSON.stringify(built.artwork), built.metadataJson, built.placeholderJson, 1000, fresh ? 2 : 0);
    f.database.prepare('INSERT INTO publication(token_id,status) VALUES(?,?)').run(tokenId, id % 2 ? 'published' : 'pending');
    if (id >= 5 && id <= 8) {
      const block = built.artwork.attributes!.find(attribute => attribute.trait_type === 'collection block')!;
      const enriched = applyRevealAttributePayload(built.metadataJson, JSON.stringify([block, { trait_type: 'large', value: '☀'.repeat(115_000) }]));
      enrichedMetadata.set(tokenId, enriched.metadataJson);
      f.database.prepare(`INSERT INTO reveal_enrichment(token_id,version,assignment_revision,status,target_json,target_sha256)
        VALUES(?,?,0,'published',?,?)`).run(tokenId, REVEAL_ENRICHMENT_VERSION, enriched.metadataJson, enriched.metadataSha256);
    }
    if (mapped) for (const revision of [1, 2, 3]) {
      const target = buildNewRevealedArtwork({ templateJson, tokenId, crateTokenId: '111112', category: 'painting', assetId: id, observation, catalog: source });
      const block = target.artwork.attributes!.find(attribute => attribute.trait_type === 'collection block')!;
      const attributes = JSON.stringify([block, { trait_type: 'generation', value: revision },
        { trait_type: 'large', value: '☀'.repeat(115_000) }]);
      f.database.prepare(`INSERT INTO reveal_catalog_mappings(batch_id,egg_id,category,asset_id,attributes_json,
        attributes_sha256,origin_category,origin_asset_id) VALUES(?,?,'painting',?,?,?,'egg',?)`)
        .run(`generation-${revision}`, id, id, attributes, digest(attributes), id);
    }
  }
  const initial = f.store.catalogUpdate.reader.canonicalMetadata(['13'])[0];
  const owned = { ...initial, metadataRevision: 4, metadataJson: JSON.stringify({ ...JSON.parse(initial.metadataJson), readyToHatch: true }) + '\n' };
  owned.targetSha256 = digest(owned.metadataJson);
  f.database.prepare(`INSERT INTO owner_hatching_batches(batch_id,source_sha256,input_sha256,ready_count,grail_count,fresh_egg_count,created_at_ms)
    VALUES('owner','a','b',1,0,1,1000)`).run();
  f.database.prepare(`INSERT INTO owner_hatching_tokens(token_id,batch_id,egg_id,original_json,status,canonical_json,metadata_revision)
    VALUES('13','owner',13,?,'ready',?,4)`).run(JSON.stringify(initial), JSON.stringify(owned));
  const reader = f.store.catalogUpdate.reader;
  const expected = new Map([...frozen.keys()].map(id => [id, reader.canonicalMetadata([id])[0]]));
  assert.deepEqual(expected.get('13'), owned);
  for (const id of ['1', '2', '3', '4']) assert.equal(expected.get(id)!.metadataJson, frozen.get(id)!.metadataJson);
  for (const [id, metadataJson] of enrichedMetadata) assert.equal(expected.get(id)!.metadataJson, metadataJson);
  for (const id of ['9', '10', '11', '12']) {
    const value = expected.get(id)!;
    assert.equal(value.category, 'painting');
    assert.equal(value.assetId, Number(id));
    assert.equal(value.assignmentRevision, 2);
    assert.equal(value.metadataRevision, 5);
    assert.equal(value.migration, Number(id) % 2 === 0);
    assert.equal(value.artwork.name, Number(id) % 2 ? `saved fresh ${id}` : id);
    assert.equal(value.artwork.attributes!.find(attribute => attribute.trait_type === 'generation')!.value, 2);
  }
  const payloads: Array<{ rows: number; bytes: number }> = [];
  const sql: RevealSql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: Array<string | number | null | ArrayBuffer>) {
    assert.match(query, /^(SELECT|WITH)\b/);
    assert.ok(bindings.length <= 100);
    const rows = f.sql.exec<T>(query, ...bindings).toArray();
    const bytes = rows.reduce((total, row) => total + Object.entries(row).reduce((sum, [key, value]) =>
      sum + (key.endsWith('_json') && typeof value === 'string' ? Buffer.byteLength(value) : 0), 0), 0);
    if (bytes) payloads.push({ rows: rows.length, bytes });
    return { toArray: () => rows };
  } };
  const schema = f.database.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
  const changes = f.database.prepare('SELECT total_changes() AS changes').get()!.changes;
  f.database.exec('PRAGMA query_only=ON');
  const readonly = new EthereumRevealCatalogReader(sql);
  const ids = ['12', '4', '8', '1', '13', '999', '7', '10', '3', '11', '6', '2', '9', '5', '4', '13'];
  assert.deepEqual(readonly.canonicalMetadata(ids), ids.flatMap(id => expected.has(id) ? [expected.get(id)] : []));
  assert.ok(payloads.every(page => page.bytes <= 1024 * 1024 || page.rows === 1), JSON.stringify(payloads));
  assert.ok(payloads.some(page => page.bytes > 1024 * 1024 && page.rows === 1));
  assert.equal(f.database.prepare('SELECT total_changes() AS changes').get()!.changes, changes);
  assert.deepEqual(f.database.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema);
});

test('catalog staging rejects conflicting collection blocks before activation and corrected traits publish fresh mapped tokens', t => {
  const f = fixture(t);
  const update = batch(source, 1);
  const mapping = update.mappings[0];
  reserveEgg(f.database, mapping.eggId, '111112', 0);
  const operation = f.store.catalogUpdate;
  operation.begin(update, 2000);
  operation.stageMappings(update.batchId, update.mappings);
  operation.sealMappings(update.batchId);
  for (const attributes of [
    [{ trait_type: 'collection block', value: 'wrong source label' }],
    [{ trait_type: 'collection block', value: 'new artworks' }, { trait_type: 'collection block', value: 'wrong duplicate' }],
  ]) {
    const payload = JSON.stringify(attributes);
    assert.throws(() => operation.metadataStage(update.batchId, [{ ...mapping, attributesJson: payload,
      sha256: createHash('sha256').update(payload).digest('hex') }]), /collection-block-mismatch/);
    assert.equal(operation.reader.status(update.batchId)!.metadataStaged, 0);
    assert.equal(f.database.prepare('SELECT attributes_json FROM reveal_catalog_mappings WHERE batch_id=?').get(update.batchId)!.attributes_json, null);
    assert.throws(() => operation.generationStage(update.batchId), /Stage every new artwork/);
    assert.throws(() => operation.activate(update.batchId), /cannot activate/);
    assert.equal(operation.reader.effectiveCatalog()!.catalogRevision, 0);
  }
  operation.metadataStage(update.batchId, [{ ...mapping, attributesJson, sha256: attributesSha256 }]);
  stageGeneration(f.store, update);
  operation.activate(update.batchId, 3000);
  f.store.freeze(deployment, observation, [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], 3001);
  const jobs = f.store.claimPublications(4000, 8);
  assert.equal(jobs.length, 8);
  const first = jobs.find(job => job.token_id === '1')!;
  const metadata = JSON.parse(first.metadata_json);
  assert.deepEqual(metadata.attributes[0], { trait_type: 'collection block', value: 'new artworks' });
  assert.equal(metadata.attributes.filter((attribute: { trait_type: string }) => attribute.trait_type === 'collection block').length, 1);
  assert.equal(metadata.category, 'video');
  assert.match(first.metadata_json, /9007199254740993/);
  assert.equal(f.store.completePublications(jobs.map(job => ({ job, status: 'published' as const })), 4001).length, 8);
  assert.equal(f.database.prepare("SELECT status FROM publication WHERE token_id='1'").get()!.status, 'published');
});

test('legacy metadata validation is query-only before migration and resumes in bounded pages across restarts', t => {
  const f = fixture(t);
  const update = batch();
  stageMetadata(f.store, update);
  const saved = f.database.prepare('SELECT attributes_json,attributes_sha256 FROM reveal_catalog_mappings ORDER BY egg_id').all();
  const reader = new EthereumRevealCatalogReader(f.sql);
  assert.equal(reader.status(update.batchId)!.metadataStaged, 3);
  f.database.exec('DROP INDEX reveal_catalog_metadata_validation; ALTER TABLE reveal_catalog_mappings DROP COLUMN collection_block_validated; PRAGMA query_only=ON;');
  const changes = f.database.prepare('SELECT total_changes() AS count').get()!.count;
  assert.equal(reader.status(update.batchId)!.metadataStaged, 0);
  assert.equal(reader.metadataPreparationPage(update.batchId, 1).length, 1);
  assert.equal(f.database.prepare('SELECT total_changes() AS count').get()!.count, changes);
  f.database.exec('PRAGMA query_only=OFF');
  let store = f.reopen();
  assert.equal(reader.status(update.batchId)!.metadataStaged, 0);
  assert.throws(() => store.catalogUpdate.generationStage(update.batchId), /validate its collection block/);
  for (let validated = 1; validated <= 3; validated++) {
    const [row] = store.catalogUpdate.reader.metadataPreparationPage(update.batchId, 1);
    assert.ok('attributesJson' in row);
    store.catalogUpdate.metadataStage(update.batchId, [row]);
    store = f.reopen();
    assert.equal(reader.status(update.batchId)!.metadataStaged, validated);
  }
  assert.deepEqual(reader.metadataPreparationPage(update.batchId), []);
  assert.deepEqual(f.database.prepare('SELECT attributes_json,attributes_sha256 FROM reveal_catalog_mappings ORDER BY egg_id').all(), saved);
  for (const query of [
    'SELECT COUNT(*),SUM(NOT(collection_block_validated=0)) FROM reveal_catalog_mappings WHERE batch_id=?',
    'SELECT 1 FROM reveal_catalog_mappings WHERE batch_id=? AND collection_block_validated=0 LIMIT 1',
  ]) {
    const plan = f.database.prepare(`EXPLAIN QUERY PLAN ${query}`).all(update.batchId);
    assert.ok(plan.some(row => String(row.detail).includes('COVERING INDEX reveal_catalog_metadata_validation')));
  }
});

test('new and migrated validation markers cannot certify a missing payload', t => {
  for (const legacy of [false, true]) {
    const f = fixture(t);
    const update = batch(source, 1);
    f.store.catalogUpdate.begin(update, 2000);
    f.store.catalogUpdate.stageMappings(update.batchId, update.mappings);
    if (legacy) {
      f.database.exec('DROP INDEX reveal_catalog_metadata_validation; ALTER TABLE reveal_catalog_mappings DROP COLUMN collection_block_validated');
      f.reopen();
    }
    assert.throws(() => f.database.prepare('UPDATE reveal_catalog_mappings SET collection_block_validated=1 WHERE batch_id=?').run(update.batchId), /CHECK constraint failed/);
  }
});

for (const phase of ['staging', 'ready'] as const) test(`legacy ${phase} candidates cannot advance with invalid frozen attributes`, t => {
  for (const failure of ['label', 'duplicate', 'checksum']) {
    const f = fixture(t);
    const update = batch(source, 1);
    const operation = f.store.catalogUpdate;
    operation.begin(update, 2000);
    operation.stageMappings(update.batchId, update.mappings);
    operation.sealMappings(update.batchId);
    const block = { trait_type: 'collection block', value: failure === 'label' ? 'wrong' : 'new artworks' };
    const payload = JSON.stringify([block, ...(failure === 'duplicate' ? [{ ...block, value: 'wrong' }] : [])]);
    const checksum = failure === 'checksum' ? '0'.repeat(64) : createHash('sha256').update(payload).digest('hex');
    f.database.prepare('UPDATE reveal_catalog_mappings SET attributes_json=?,attributes_sha256=? WHERE batch_id=?')
      .run(payload, checksum, update.batchId);
    if (phase === 'ready') f.database.prepare("UPDATE reveal_catalog_generations SET phase='ready',seeded=111111 WHERE batch_id=?").run(update.batchId);
    const resumed = f.reopen().catalogUpdate;
    const [row] = resumed.reader.metadataPreparationPage(update.batchId);
    assert.ok('attributesJson' in row);
    assert.throws(() => resumed.metadataStage(update.batchId, [row]), /collection-block-mismatch|Invalid staged artwork attributes/);
    assert.equal(resumed.reader.status(update.batchId)!.metadataStaged, 0);
    assert.equal(resumed.reader.status(update.batchId)!.activatedAtMs, null);
    assert.throws(() => phase === 'ready' ? resumed.seal(update.batchId) : resumed.generationStage(update.batchId), /validate its collection block/);
    assert.throws(() => resumed.activate(update.batchId), /validate its collection block|cannot activate/);
    assert.deepEqual({ ...f.database.prepare('SELECT attributes_json,attributes_sha256,collection_block_validated FROM reveal_catalog_mappings WHERE batch_id=?').get(update.batchId) },
      { attributes_json: payload, attributes_sha256: checksum, collection_block_validated: 0 });
  }
});

for (const allocation of ['reserved', 'free'] as const) {
  test(`sparse cutoff preserves reveal of ${allocation} original eggs above the nominal catalog count`, t => {
    const f = fixture(t);
    const eggId = source.categories.eggs.count;
    if (allocation === 'reserved') reserveEgg(f.database, eggId, '111112', 0);
    const update = batch(source, 1);
    const body: RevealCatalogUpdateBody = { ...update, version: 2, eggCutoff: 0,
      mappings: update.mappings.map(mapping => ({ ...mapping, eggId: 1 })) };
    const batchSha256 = revealCatalogUpdateHash(body);
    const sparse: RevealCatalogUpdateBatch = { ...body, batchSha256, batchId: `catalog-${batchSha256.slice(0, 32)}` };
    stageMetadata(f.store, sparse);
    stageGeneration(f.store, sparse);
    f.store.catalogUpdate.activate(sparse.batchId, 3000);
    f.store.catalogUpdate.finalize(sparse.batchId);
    assert.equal(f.store.catalogUpdate.reader.activeCatalog().categories.eggs.count, eggId - 1);
    assert.equal(f.store.catalogUpdate.ownerHatching.reader.slotOverride({ category: 'egg', assetId: eggId }), null);
    if (allocation === 'free') {
      const row = f.database.prepare("SELECT slot FROM reveal_catalog_free WHERE generation=? AND category='egg' AND asset_id=?")
        .get(sparse.batchId, eggId)!;
      f.random.push(source.categories['3d'].count + source.categories.animated.count, Number(row.slot));
    }
    f.store.freeze(deployment, observation, [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], 4000);
    const canonical = f.reopen().catalogUpdate.reader.canonicalMetadata(['1'])[0];
    assert.equal(canonical.category, 'egg');
    assert.equal(canonical.assetId, eggId);
    assert.equal(canonical.artwork.name, `Egg #${eggId}`);
    assert.equal(canonical.artwork.image, `https://cdn.lil.org/nft/111k/eggs/${eggId}.png`);
    assert.equal(JSON.parse(canonical.metadataJson).image, canonical.artwork.image);
    assert.deepEqual(f.store.frozen(['1'])[0], canonical.artwork);
    conservation(f.store, f.database);
  });
}

test('sparse cutoff coexists with live owner hatches and publishes fresh eggs through their immutable origins', t => {
  const f = fixture(t);
  reserveEgg(f.database, 1, '111112', 0);
  reserveEgg(f.database, source.categories.eggs.count - 3, '111112', 1);
  f.store.freeze(deployment, observation, [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], 1000);
  const initial = batch();
  stageMetadata(f.store, initial);
  stageGeneration(f.store, initial);
  f.store.catalogUpdate.activate(initial.batchId, 3000);
  f.store.catalogUpdate.finalize(initial.batchId);
  const owner = f.store.catalogUpdate.ownerHatching;
  owner.prepare({ batchId: 'owner-wave', sourceSha256: 'a'.repeat(64), candidateTokenIds: ['1', '2'], readyCount: 2,
    grails: [{ category: 'animated', assetId: 422, attributesJson: attributesJson.replace('new artworks', 'DROWEE') }], freshEggIds: [76700] }, 4000);
  const next = batch(initial.target.manifest, 1);
  assert.throws(() => f.store.catalogUpdate.begin(next, 4001), /protected by owner hatching/);
  assert.equal(f.store.catalogUpdate.reader.status(next.batchId), null);
  assert.deepEqual(owner.reader.readyTokenIds(), ['1', '2']);
  const ordinaryId = String(f.database.prepare('SELECT token_id FROM owner_hatching_tokens WHERE grail_asset_id IS NULL').get()!.token_id);
  const grailId = ordinaryId === '1' ? '2' : '1';
  owner.hatch(ordinaryId, 5000);
  const requested = ['3', grailId, '999', ordinaryId, '3', grailId];
  const ordinary = f.store.catalogUpdate.reader.canonicalMetadata(['3'])[0];
  const reader = f.reopen().catalogUpdate.reader;
  const mixed = f.observe(() => reader.canonicalMetadata(requested));
  assert.deepEqual(mixed.value, [ordinary, owner.reader.canonical(grailId), owner.reader.canonical(ordinaryId), ordinary, owner.reader.canonical(grailId)]);
  assert.ok(mixed.queries.length <= 12, `mixed owner/ordinary read used ${mixed.queries.length} queries`);
  assert.equal(mixed.queries.filter(entry => /FROM owner_hatching_tokens\s+WHERE token_id IN/.test(entry.query)).length, 2);
  conservation(f.store, f.database);
  const row = f.database.prepare("SELECT slot FROM reveal_catalog_free WHERE generation=? AND category='egg' AND asset_id=76700")
    .get(initial.batchId)!;
  const origin = f.store.catalogUpdate.takeFree('egg', Number(row.slot));
  f.database.prepare("INSERT INTO crates(crate_token_id) VALUES('111113')").run();
  f.database.prepare("INSERT INTO assignments(category,asset_id,crate_token_id,slot) VALUES(?,?,'111113',0)").run(origin.category, origin.assetId);
  f.store.freeze(deployment, observation, [{ crateTokenId: '111113', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 21)) }], 5001);
  const original = f.database.prepare("SELECT * FROM assignments WHERE token_id='21'").get();
  assert.equal(f.store.frozen(['21'])[0].category, 'egg');
  assert.equal(f.store.catalogUpdate.reader.canonicalMetadata(['21'])[0].assetId, 76700);
  const body: RevealCatalogUpdateBody = { ...next, version: 2, eggCutoff: 76699,
    mappings: next.mappings.map(mapping => ({ ...mapping, eggId: 76700 })) };
  const batchSha256 = revealCatalogUpdateHash(body);
  const explicit: RevealCatalogUpdateBatch = { ...body, batchSha256, batchId: `catalog-${batchSha256.slice(0, 32)}` };
  stageMetadata(f.store, explicit);
  assert.throws(() => owner.prepare({ batchId: 'owner-conflict', sourceSha256: 'b'.repeat(64), candidateTokenIds: ['21'], readyCount: 1,
    grails: [{ category: 'animated', assetId: 423, attributesJson: attributesJson.replace('new artworks', 'DROWEE') }], freshEggIds: [] }, 5002), /Not enough eligible/);
  f.store.catalogUpdate.generationStage(explicit.batchId);
  owner.hatch(grailId, 5003);
  stageGeneration(f.store, explicit);
  f.store.catalogUpdate.activate(explicit.batchId, 6000);
  const publication = f.store.catalogUpdate.reader.publicationPage(explicit.batchId);
  assert.equal(publication.length, 1);
  assert.equal(publication[0].tokenId, '21');
  assert.equal(publication[0].eggId, 76700);
  assert.equal(publication[0].category, 'video');
  assert.deepEqual(f.database.prepare("SELECT * FROM assignments WHERE token_id='21'").get(), original);
  f.store.catalogUpdate.acknowledgePublication(explicit.batchId, '21', publication[0].metadataRevision, publication[0].targetSha256);
  f.store.catalogUpdate.finalize(explicit.batchId);
  conservation(f.store, f.database);
  assert.equal(f.store.catalogUpdate.reader.pools().find(pool => pool.category === 'animated')!.total, source.categories.animated.count + 1);
  assert.equal(f.reopen().catalogUpdate.reader.verify(explicit.batchId).published, 1);
  assert.equal(owner.reader.isRetiredEgg(Number(JSON.parse(String(f.database.prepare('SELECT original_json FROM owner_hatching_tokens WHERE token_id=?').get(ordinaryId)!.original_json)).assetId)), true);
});

test('replacement inspection can read a pre-owner ledger without initializing or writing schema', t => {
  const f = fixture(t);
  reserveEgg(f.database, 1, '111112', 0);
  f.store.freeze(deployment, observation, [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], 1000);
  f.database.exec('PRAGMA foreign_keys=OFF');
  for (const row of f.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'owner_hatching_%'").all()) {
    f.database.exec(`DROP TABLE ${String(row.name)}`);
  }
  const before = f.database.prepare('SELECT total_changes() AS changes').get()!.changes;
  const store = new EthereumRevealCatalogReader(f.sql);
  assert.equal(store.ownerHatching.available, false);
  const result = f.observe(() => store.canonicalMetadata(['2', '1', '999', '1']));
  assert.deepEqual(result.value.map(value => value.tokenId), ['2', '1', '1']);
  assert.equal(result.value[1].category, 'egg');
  assert.ok(result.queries.length <= 12);
  assert.equal(store.canonicalArtworks(['1'])[0].category, 'egg');
  f.database.exec('DROP TRIGGER enqueue_reveal_enrichment; DROP TABLE reveal_enrichment');
  assert.deepEqual(store.canonicalMetadata(['2', '1', '999', '1']), result.value);
  assert.equal(f.database.prepare('SELECT total_changes() AS changes').get()!.changes, before);
});

test('catalogue verification and eligible inspection read completed pre-owner schemas without migrations', t => {
  const f = fixture(t);
  const update = batch(source, 1);
  reserveEgg(f.database, update.mappings[0].eggId, '111112', 0);
  f.store.freeze(deployment, observation, [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], 1000);
  stageMetadata(f.store, update);
  stageGeneration(f.store, update);
  f.store.catalogUpdate.activate(update.batchId, 3000);
  const job = f.store.catalogUpdate.reader.publicationPage(update.batchId)[0];
  f.store.catalogUpdate.acknowledgePublication(update.batchId, job.tokenId, job.metadataRevision, job.targetSha256);
  f.store.catalogUpdate.finalize(update.batchId);
  f.database.exec('PRAGMA foreign_keys=OFF');
  for (const row of f.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'owner_hatching_%'").all()) {
    f.database.exec(`DROP TABLE ${String(row.name)}`);
  }
  f.database.exec(`DROP TRIGGER enqueue_reveal_enrichment;
    DROP TABLE reveal_catalog_egg_claims;
    DROP TRIGGER reveal_catalog_mapping_origin_identity;
    DROP INDEX reveal_catalog_mapping_origin_unit;
    ALTER TABLE reveal_catalog_mappings DROP COLUMN origin_category;
    ALTER TABLE reveal_catalog_mappings DROP COLUMN origin_asset_id;
    DROP TRIGGER reveal_catalog_explicit_identity;
    ALTER TABLE reveal_catalog_generations DROP COLUMN batch_version;
    ALTER TABLE reveal_catalog_generations DROP COLUMN egg_cutoff;
    DROP TRIGGER reveal_catalog_mode_immutable;
    ALTER TABLE reveal_catalog_generations DROP COLUMN mode;`);
  const before = f.database.prepare('SELECT total_changes() AS changes').get()!.changes;
  const schema = f.database.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
  f.database.exec('PRAGMA query_only=ON');
  const store = new EthereumRevealCatalogReader(f.sql);
  assert.equal(store.verify(update.batchId).published, 1);
  assert.equal(store.publicationPage(update.batchId)[0].tokenId, '1');
  assert.deepEqual(store.pendingPublications(update.batchId), []);
  assert.equal(f.database.prepare('SELECT total_changes() AS changes').get()!.changes, before);
  assert.deepEqual(f.database.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema);
});

test('online activation maps free, private and frozen units atomically without rewriting original evidence', t => {
  const f = fixture(t);
  const update = batch();
  const maximum = source.categories.eggs.count;
  reserveEgg(f.database, maximum, '111112', 0);
  reserveEgg(f.database, 70000, '111112', 1);
  f.store.freeze(deployment, observation, [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], 1000);
  f.store.publicationComplete('1');
  reserveEgg(f.database, maximum - 1, '111113', 0);
  const original = f.database.prepare('SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY token_id').all();
  stageMetadata(f.store, update);
  stageGeneration(f.store, update);
  assert.equal(f.store.frozen(['1'])[0].category, 'egg');
  assert.equal(f.store.catalogUpdate.reader.pools().find(row => row.category === 'egg')!.total, maximum);
  f.store.catalogUpdate.activate(update.batchId, 3000);
  const changed = f.store.catalogUpdate.reader.canonicalMetadata(['1'])[0];
  assert.equal(changed.category, 'video');
  assert.equal(changed.assetId, 61);
  assert.equal(changed.metadataRevision, 3);
  assert.match(changed.metadataJson, /9007199254740993/);
  assert.equal(changed.artwork.crateTokenId, '111112');
  assert.deepEqual(changed.artwork.observation, observation);
  assert.deepEqual(f.database.prepare('SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY token_id').all(), original);
  assert.equal(f.store.frozen(['2'])[0].category, 'egg');
  f.store.freeze(deployment, observation, [{ crateTokenId: '111113', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 21)) }], 3001);
  assert.equal(f.store.frozen(['21'])[0].category, 'video');
  assert.equal(f.store.catalogUpdate.reader.canonicalMetadata(['21'])[0].assetId, 60);
  assert.equal(f.store.catalogUpdate.reader.status(update.batchId)!.frozen, 1);
  assert.equal(f.store.catalogUpdate.reader.publicationPage(update.batchId).length, 1);
  f.random.push(111110, 0);
  f.store.reserve(['111114']);
  f.store.freeze(deployment, observation, [{ crateTokenId: '111114', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 41)) }], 3002);
  assert.equal(f.store.catalogUpdate.reader.canonicalMetadata(['41'])[0].assetId, 59);
  assert.equal(f.store.frozen(['41'])[0].category, 'video');
  assert.equal(f.store.tokensResponse(deployment, ['1']).catalogRevision, 1);
  assert.equal(f.store.transactionResponse(deployment, observation.transactionHash).catalogRevision, 1);
  conservation(f.store, f.database);
  const job = f.store.catalogUpdate.reader.pendingPublications(update.batchId)[0];
  assert.ok(f.store.catalogUpdate.reader.validateMetadataWrite(job));
  assert.equal(f.store.catalogUpdate.reader.validateMetadataWrite({ ...job, metadataRevision: 0 }), false);
  f.store.catalogUpdate.acknowledgePublication(update.batchId, job.tokenId, job.metadataRevision, job.targetSha256);
  f.store.catalogUpdate.finalize(update.batchId);
  while (f.store.catalogUpdate.prune(update.batchId).remaining) {}
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM free_slots').get()!.count, 0);
  assert.equal(f.store.catalogUpdate.reader.verify(update.batchId).published, 1);
  assert.equal(f.reopen().frozen(['1'])[0].category, 'video');
  assert.throws(() => f.database.prepare("UPDATE assignments SET metadata_json='{}' WHERE token_id='1'").run(), /Frozen reveal/);
});

test('candidate free slots mirror live allocations and releases while staging, including after sealing', t => {
  const f = fixture(t);
  const update = batch();
  stageMetadata(f.store, update);
  f.store.catalogUpdate.generationStage(update.batchId);
  f.random.push(source.categories['3d'].count + source.categories.animated.count, 0);
  f.store.reserve(['111112']);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM reveal_catalog_free WHERE origin_category='egg' AND origin_asset_id=1").get()!.count, 0);
  f.database.prepare("DELETE FROM assignments WHERE category='egg' AND asset_id=1 AND token_id IS NULL").run();
  f.store.catalogUpdate.releaseFree({ category: 'egg', assetId: 1 });
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM reveal_catalog_free WHERE origin_category='egg' AND origin_asset_id=1").get()!.count, 1);
  stageGeneration(f.store, update);
  f.store.reserve(['111113']);
  const lastEgg = source.categories.eggs.count;
  const slot = Number(f.database.prepare("SELECT slot FROM free_slots WHERE category='egg' AND asset_id=?").get(lastEgg)!.slot);
  f.random.push(source.categories['3d'].count + source.categories.animated.count, slot);
  f.store.reserve(['111114']);
  f.store.freeze(deployment, observation, [{ crateTokenId: '111114', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], 2999);
  assert.equal(f.store.frozen(['1'])[0].category, 'egg');
  f.store.catalogUpdate.activate(update.batchId, 3000);
  assert.equal(f.store.frozen(['1'])[0].category, 'video');
  assert.equal(f.store.catalogUpdate.reader.status(update.batchId)!.frozen, 1);
  const publication = f.store.catalogUpdate.reader.pendingPublications(update.batchId)[0];
  f.store.catalogUpdate.acknowledgePublication(update.batchId, publication.tokenId, publication.metadataRevision, publication.targetSha256);
  conservation(f.store, f.database);
  f.store.catalogUpdate.finalize(update.batchId);
});

test('cancelling staged work leaves reads and allocations online and permits a new frozen mapping', t => {
  const f = fixture(t);
  const update = batch();
  stageMetadata(f.store, update);
  f.store.catalogUpdate.generationStage(update.batchId);
  f.store.reserve(['111112']);
  const before = f.store.summary();
  f.store.catalogUpdate.cancel(update.batchId);
  assert.deepEqual(f.store.summary(), before);
  assert.equal(f.store.catalogUpdate.reader.effectiveCatalog()!.catalogRevision, 0);
  while (f.store.catalogUpdate.prune(update.batchId).remaining) {}
  f.store.reserve(['111113']);
  conservation(f.store, f.database);
});

test('a conflict on one replacement does not prevent other replacements from publishing', t => {
  const f = fixture(t);
  const update = batch();
  update.mappings.forEach((mapping, slot) => reserveEgg(f.database, mapping.eggId, '111112', slot));
  f.store.freeze(deployment, observation, [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], 1000);
  stageMetadata(f.store, update);
  stageGeneration(f.store, update);
  f.store.catalogUpdate.activate(update.batchId, 3000);
  const first = f.store.catalogUpdate.reader.pendingPublications(update.batchId, 1, 3000)[0];
  f.store.catalogUpdate.failPublication(update.batchId, first.tokenId, first.metadataRevision, 'conflict', 3000);
  const rest = f.store.catalogUpdate.reader.pendingPublications(update.batchId, 8, 3001);
  assert.equal(rest.length, 2);
  assert.ok(rest.every(row => row.tokenId !== first.tokenId));
  for (const row of rest) f.store.catalogUpdate.acknowledgePublication(update.batchId, row.tokenId, row.metadataRevision, row.targetSha256);
  f.store.reserve(['111113']);
  assert.equal(f.store.catalogUpdate.reader.status(update.batchId)!.conflicts, 1);
  assert.throws(() => f.store.catalogUpdate.cancel(update.batchId), /resume forward/);
  assert.equal(f.store.catalogUpdate.reader.pendingPublications(update.batchId, 8, 303001).length, 1);
});

test('500 reveal projections stay compact while canonical inventory metadata keeps full staged traits', { timeout: 60_000 }, t => {
  const f = fixture(t);
  const update = batch(source, 500);
  update.mappings.forEach((mapping, index) => reserveEgg(f.database, mapping.eggId, String(111112 + Math.floor(index / 20)), index % 20));
  for (let index = 0; index < 25; index++) f.store.freeze(deployment, observation, [{ crateTokenId: String(111112 + index),
    tokenIds: Array.from({ length: 20 }, (_, offset) => String(index * 20 + offset + 1)) }], 1000);
  f.store.catalogUpdate.begin(update, 2000);
  for (let offset = 0; offset < update.mappings.length; offset += 256) f.store.catalogUpdate.stageMappings(update.batchId, update.mappings.slice(offset, offset + 256));
  f.store.catalogUpdate.sealMappings(update.batchId);
  const payload = JSON.stringify([{ trait_type: 'collection block', value: 'new artworks' }, { trait_type: 'large', value: 'x'.repeat(64 * 1024) }]);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  for (;;) {
    const page = f.store.catalogUpdate.reader.metadataPreparationPage(update.batchId, 8);
    if (!page.length) break;
    f.store.catalogUpdate.metadataStage(update.batchId, page.map(row => ({ ...row, attributesJson: payload, sha256 })));
  }
  stageGeneration(f.store, update);
  f.store.catalogUpdate.activate(update.batchId, 3000);
  const items = f.store.frozen(Array.from({ length: 500 }, (_, index) => String(index + 1)));
  assert.equal(items.length, 500);
  assert.ok(items.every(row => row.category === 'video' && row.metadataRevision === 2 && row.attributes?.every(attribute => attribute.trait_type !== 'large')));
  assert.ok(Buffer.byteLength(JSON.stringify(items)) < 512 * 1024);
  const full = f.store.catalogUpdate.reader.canonicalMetadata(['1'])[0];
  assert.equal(full.metadataRevision, 3);
  assert.equal(JSON.parse(full.metadataJson).attributes.find((attribute: { trait_type: string }) => attribute.trait_type === 'large').value.length, 64 * 1024);
});

test('oversized merged metadata is rejected before activation while the original pool remains available', t => {
  const f = fixture(t);
  const update = batch();
  f.store.catalogUpdate.begin(update, 2000);
  f.store.catalogUpdate.stageMappings(update.batchId, update.mappings);
  f.store.catalogUpdate.sealMappings(update.batchId);
  const payload = JSON.stringify([{ trait_type: 'collection block', value: 'new artworks' }, { trait_type: 'data', value: 'x'.repeat(MAX_REVEAL_METADATA_BYTES - 200) }]);
  assert.ok(Buffer.byteLength(payload) < MAX_REVEAL_METADATA_BYTES);
  const [row] = f.store.catalogUpdate.reader.metadataPreparationPage(update.batchId);
  assert.throws(() => f.store.catalogUpdate.metadataStage(update.batchId, [{ ...row, attributesJson: payload,
    sha256: createHash('sha256').update(payload).digest('hex') }]), /exceeds 512 KiB/);
  assert.equal(f.store.catalogUpdate.reader.status(update.batchId)!.metadataStaged, 0);
  assert.equal(f.store.catalogUpdate.reader.effectiveCatalog()!.catalogRevision, 0);
  f.store.reserve(['111112']);
});

test('staging preserves the legacy size bound when fresh metadata would deduplicate repeated collection blocks', t => {
  const f = fixture(t);
  const update = batch(source, 1);
  const operation = f.store.catalogUpdate;
  operation.begin(update, 2000);
  operation.stageMappings(update.batchId, update.mappings);
  operation.sealMappings(update.batchId);
  const [row] = operation.reader.metadataPreparationPage(update.batchId);
  const block = { trait_type: 'collection block', value: 'new artworks' };
  const payload = JSON.stringify(Array(Math.floor((MAX_REVEAL_METADATA_BYTES - 200) / (JSON.stringify(block).length + 1))).fill(block));
  const fresh = buildNewRevealedArtwork({ templateJson, tokenId: '111111', crateTokenId: '116666', category: row.category,
    assetId: row.assetId, catalog: update.target.manifest, observation });
  assert.ok(Buffer.byteLength(payload) < MAX_REVEAL_METADATA_BYTES);
  assert.ok(Buffer.byteLength(applyRevealAttributePayload(fresh.metadataJson, payload).metadataJson) < MAX_REVEAL_METADATA_BYTES);
  assert.throws(() => operation.metadataStage(update.batchId, [{ ...row, attributesJson: payload,
    sha256: createHash('sha256').update(payload).digest('hex') }]), /exceeds 512 KiB/);
  assert.equal(operation.reader.status(update.batchId)!.metadataStaged, 0);
  assert.equal(f.database.prepare('SELECT attributes_json FROM reveal_catalog_mappings WHERE batch_id=?').get(update.batchId)!.attributes_json, null);
});

for (const amount of [9358, source.categories.eggs.count]) test(`online generation stages ${amount} replacements and reaches its exact cutoff`, { timeout: 120_000 }, t => {
  const f = fixture(t);
  const update = batch(source, amount);
  const started = performance.now();
  stageMetadata(f.store, update);
  let crate = 111112;
  stageGeneration(f.store, update, () => { if (crate < 111132) f.store.reserve([String(crate++)]); });
  const stagedMs = performance.now() - started;
  const activated = performance.now();
  f.store.catalogUpdate.activate(update.batchId, 3000);
  const activationMs = performance.now() - activated;
  assert.equal(f.store.catalogUpdate.reader.activeCatalog().categories.eggs.count, source.categories.eggs.count - amount);
  assert.equal(f.store.catalogUpdate.reader.pools().find(row => row.category === 'egg')!.total, source.categories.eggs.count - amount);
  conservation(f.store, f.database);
  f.store.freeze(deployment, observation, [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }], 3001);
  if (amount === source.categories.eggs.count) assert.ok(f.store.frozen(Array.from({ length: 20 }, (_, index) => String(index + 1))).every(row => row.category !== 'egg'));
  f.store.catalogUpdate.finalize(update.batchId);
  t.diagnostic(JSON.stringify({ amount, stagedMs: Math.round(stagedMs), activationMs: Math.round(activationMs) }));
});
