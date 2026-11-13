import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import source from '../../../../scripts/ethereum-metadata/reveal-assets/111k_devnet/collection-blocks.json';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { lookupRevealCollectionBlock, selectRevealCollectionBlocks, validateRevealCollectionBlocks } from '../../../../shared/ethereum/revealCollectionBlocks.ts';
import type { EthereumArtworkCategory } from '../../../../shared/ethereum/reveal.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { buildNewRevealedArtwork, buildRevealedArtwork } from '../src/ethereumRevealCatalog.ts';
import { getOwnerHatchingGrails } from '../../../../shared/ethereum/ownerHatchingCatalog.ts';
import { EthereumRevealStore, type RevealSql } from '../src/ethereumRevealStore.ts';
import { applyRevealAttributePayload } from '../src/ethereumRevealAttributes.ts';

const templateJson = JSON.stringify({ name: '{{tokenId}}', image: 'https://cdn.lil.org/nft/111k/placeholder.png',
  attributes: [{ trait_type: 'series', value: '111K' }] });
const observation = { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 };

test('fresh grails resolve their collection block without a supplied or previously initialized catalog', () => {
  const grail = getOwnerHatchingGrails()[0];
  const value = buildNewRevealedArtwork({ templateJson, tokenId: '42', crateTokenId: '111112', observation,
    category: grail.category, assetId: grail.assetId, ownerHatching: true });
  assert.deepEqual(JSON.parse(value.metadataJson).attributes[0], { trait_type: 'collection block', value: grail.collectionBlock });
  assert.equal(value.artwork.image, grail.image);
});

function fixture(t: TestContext, catalogVersion = '111k-v9') {
  const deployment: EthereumRevealDeployment = { deploymentId: 'collection-block-test', dropId: '111k_devnet', chainId: 11155111,
    contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/collection-block-test/',
    deploymentBlock: 100, catalogVersion, templateJson,
    templateSha256: createHash('sha256').update(templateJson).digest('hex'), state: 'active', revision: 3,
    createdAtMs: 1, updatedAtMs: 3, provisionedAtMs: 2, activatedAtMs: 3, lastError: null };
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  const statements = new Map<string, StatementSync>();
  const queries: string[] = [];
  const sql: RevealSql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: Array<string | number | null | ArrayBuffer>) {
    queries.push(query);
    let statement = statements.get(query);
    if (!statement) statements.set(query, statement = database.prepare(query));
    const parameters = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...parameters) : (statement.run(...parameters), []);
    return { toArray: () => rows as T[] };
  } };
  const store = new EthereumRevealStore(sql, action => action(), () => 0);
  store.configure(deployment);
  t.after(() => database.close());
  const seedFrozen = (units: Array<{ category: EthereumArtworkCategory; assetId: number }>) => {
    database.prepare('INSERT OR IGNORE INTO crates(crate_token_id) VALUES(?)').run('111112');
    units.forEach((unit, index) => {
      const tokenId = String(index + 1);
      const value = buildRevealedArtwork({ ...unit, tokenId, crateTokenId: '111112', templateJson, observation, catalog: getRevealCatalog(catalogVersion)! });
      database.prepare(`INSERT INTO assignments(category,asset_id,crate_token_id,slot,token_id,artwork_json,metadata_json,placeholder_json,frozen_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(unit.category, unit.assetId, '111112', index, tokenId,
        JSON.stringify(value.artwork), value.metadataJson, value.placeholderJson, 1000);
    });
    const mappings = units.map((_, index) => ({ tokenId: String(index + 1), crateTokenId: '111112' }));
    database.prepare(`INSERT INTO transactions(hash,status,from_block,tokens_json,revealed_all,created_at_ms,last_requested_at_ms)
      VALUES(?,'revealed',100,?,1,1000,1000)`).run(observation.transactionHash, JSON.stringify(mappings));
    return mappings.map(value => value.tokenId);
  };
  return { database, store, deployment, seedFrozen, queries,
    snapshot: () => database.prepare('SELECT * FROM assignments ORDER BY token_id').all() };
}

test('the bundled lookup resolves every range boundary and bounds each supported catalog', () => {
  const blocks: unknown = source;
  validateRevealCollectionBlocks(blocks);
  const current = selectRevealCollectionBlocks(blocks, getRevealCatalogDescriptor('111k-v9'));
  assert.ok(current);
  for (const category of ['painting', 'video', '3d', 'animated'] as const) {
    let first = 1;
    const ranges: readonly (readonly [number, string])[] = blocks.ranges[category];
    for (const [last, label] of ranges) {
      assert.equal(lookupRevealCollectionBlock(current, category, first), label);
      assert.equal(lookupRevealCollectionBlock(current, category, last), label);
      first = last + 1;
    }
    assert.equal(lookupRevealCollectionBlock(current, category, first), null);
    assert.equal(lookupRevealCollectionBlock(current, category, 0), null);
  }
  assert.equal(lookupRevealCollectionBlock(current, 'egg', 1), null);
  assert.equal(lookupRevealCollectionBlock(current, 'painting', NaN), null);
  assert.equal(selectRevealCollectionBlocks(blocks, { catalogVersion: '111k-v9', manifestSha256: '0'.repeat(64) }), null);
  const ancestor = selectRevealCollectionBlocks(blocks, getRevealCatalogDescriptor('111k-v5'));
  assert.ok(ancestor);
  assert.equal(lookupRevealCollectionBlock(ancestor, 'painting', 30990), 'gpt pixel');
  assert.equal(lookupRevealCollectionBlock(ancestor, 'painting', 30991), null);
  const previousAncestor = selectRevealCollectionBlocks(blocks, getRevealCatalogDescriptor('111k-v7'));
  assert.ok(previousAncestor);
  assert.equal(lookupRevealCollectionBlock(previousAncestor, 'painting', 47128), 'Poets, Gamblers, Fools');
  assert.equal(lookupRevealCollectionBlock(previousAncestor, 'painting', 47129), null);
  const predecessor = selectRevealCollectionBlocks(blocks, getRevealCatalogDescriptor('111k-v8'));
  assert.ok(predecessor);
  assert.equal(lookupRevealCollectionBlock(predecessor, 'painting', 52329), 'Apartment Traveler');
  assert.equal(lookupRevealCollectionBlock(predecessor, 'painting', 52330), null);
});

for (const size of [20, 500]) test(`response decoration adds no SQL or network operations for ${size} frozen tokens`, t => {
  const f = fixture(t);
  const ids = f.seedFrozen(Array.from({ length: size }, (_, index) => ({ category: 'painting', assetId: index + 1 })));
  const original = f.snapshot();
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected collection-block fetch'); });
  f.queries.length = 0;
  const undecorated = f.store.frozen(ids);
  const queries = f.queries.splice(0);
  const decorated = f.store.frozen(ids, { includeCollectionBlock: true });
  assert.deepEqual(f.queries, queries);
  assert.equal(fetch.mock.callCount(), 0);
  assert.ok(undecorated.every(artwork => !Object.hasOwn(artwork, 'collectionBlock')));
  assert.ok(decorated.every(artwork => artwork.collectionBlock === 'plane of existence'));
  assert.deepEqual(decorated.map(({ collectionBlock: _block, ...artwork }) => artwork), undecorated);
  assert.deepEqual(f.snapshot(), original);
});

test('both public endpoints decorate existing frozen artworks without changing metadata or stored assignments', t => {
  const f = fixture(t);
  const ids = f.seedFrozen([{ category: 'painting', assetId: 68980 }, { category: 'video', assetId: 58 },
    { category: '3d', assetId: 1000 }, { category: '3d', assetId: 1001 }, { category: 'animated', assetId: 421 }, { category: 'egg', assetId: 1 }]);
  const original = f.snapshot();
  const expected = ['watercolor mons', 'film clips', 'DrOps3 Knives', 'DrOps3 Guns', 'gifworks', null];
  const transaction = f.store.transactionResponse(f.deployment, observation.transactionHash);
  const tokens = f.store.tokensResponse(f.deployment, ids);
  assert.deepEqual(transaction.artworks.map(artwork => artwork.collectionBlock), expected);
  assert.deepEqual(tokens.artworks, transaction.artworks);
  assert.deepEqual(f.snapshot(), original);
  assert.ok(original.every(row => !String(row.metadata_json).includes('collection block') && !String(row.artwork_json).includes('collectionBlock')));
});

test('newly frozen reveals publish their collection block before any source enrichment', t => {
  const f = fixture(t);
  while (!f.store.initializeChunk()) {}
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected collection-block fetch'); });
  const ids = Array.from({ length: 20 }, (_, index) => String(index + 1));
  f.store.freeze(f.deployment, observation, [{ crateTokenId: '111112', tokenIds: ids }], 1000);
  const original = f.snapshot();
  const artworks = f.store.tokensResponse(f.deployment, ids).artworks;
  const blocks = new Map(artworks.map(artwork => [artwork.tokenId, artwork.collectionBlock]));
  const jobs = f.store.claimPublications(1001, 8);
  assert.ok(jobs.some(job => JSON.parse(job.metadata_json).category !== 'egg'));
  for (const job of jobs) {
    const metadata = JSON.parse(job.metadata_json);
    const attributes = metadata.attributes.filter((value: { trait_type: string }) => value.trait_type === 'collection block');
    assert.deepEqual(attributes, metadata.category === 'egg' ? [] : [{ trait_type: 'collection block', value: blocks.get(job.token_id) }]);
    if (metadata.category !== 'egg') assert.deepEqual(metadata.attributes[0], attributes[0]);
    assert.equal(f.store.validateMetadataWrite({ tokenId: job.token_id, metadataRevision: job.metadata_revision!,
      metadataJson: job.metadata_json, expectedJsons: JSON.parse(job.expected_jsons_json!), allowMissing: Boolean(job.allow_missing) }), true);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.ok(f.store.tokensResponse(f.deployment, ids).artworks.every(artwork =>
    artwork.category === 'egg' ? artwork.collectionBlock === null : typeof artwork.collectionBlock === 'string'));
  assert.deepEqual(f.snapshot(), original);
});

test('fresh metadata covers every artwork category and grails while legacy bytes and eggs remain stable', () => {
  const catalog = getRevealCatalog('111k-v9')!;
  const blocks: unknown = source;
  validateRevealCollectionBlocks(blocks);
  const lookup = selectRevealCollectionBlocks(blocks, getRevealCatalogDescriptor(catalog.catalogVersion));
  const base = { templateJson, tokenId: '42', crateTokenId: '111112', observation, catalog };
  for (const category of ['painting', 'video', '3d', 'animated'] as const) {
    const input = { ...base, category, assetId: 1 };
    const legacy = buildRevealedArtwork(input);
    const fresh = buildNewRevealedArtwork(input);
    const attributes = [{ trait_type: 'collection block', value: lookupRevealCollectionBlock(lookup, category, 1) },
      ...legacy.artwork.attributes!];
    assert.deepEqual(fresh.artwork.attributes, attributes);
    assert.deepEqual(JSON.parse(fresh.metadataJson), { ...JSON.parse(legacy.metadataJson), attributes });
    assert.equal(fresh.placeholderJson, legacy.placeholderJson);
    assert.ok(!legacy.metadataJson.includes('collection block'));
  }
  const egg = { ...base, category: 'egg' as const, assetId: 1 };
  assert.deepEqual(buildNewRevealedArtwork(egg), buildRevealedArtwork(egg));
  const grail = getOwnerHatchingGrails()[0];
  const freshGrail = buildNewRevealedArtwork({ ...base, category: grail.category, assetId: grail.assetId, ownerHatching: true });
  assert.deepEqual(JSON.parse(freshGrail.metadataJson).attributes[0], { trait_type: 'collection block', value: grail.collectionBlock });
});

test('fresh metadata replaces template collection blocks with exactly one authoritative label and fails closed without a catalog', () => {
  const input = { templateJson: JSON.stringify({ ...JSON.parse(templateJson), attributes: [
    { trait_type: 'collection block', value: 'wrong' }, { trait_type: 'series', value: '111K' },
    { trait_type: 'collection block', value: 'another wrong label' },
  ] }), tokenId: '42', crateTokenId: '111112', category: 'painting' as const, assetId: 41171, observation,
  catalog: getRevealCatalog('111k-v9')! };
  assert.deepEqual(JSON.parse(buildNewRevealedArtwork(input).metadataJson).attributes, [
    { trait_type: 'collection block', value: 'little swag' }, { trait_type: 'series', value: '111K' }, { trait_type: 'type', value: 'painting' },
  ]);
  assert.throws(() => buildNewRevealedArtwork({ ...input, catalog: { ...input.catalog, catalogVersion: '111k-v999' } }),
    /collection block is unavailable/);
  assert.throws(() => buildNewRevealedArtwork({ ...input, catalog: { ...input.catalog, baseUrl: 'https://example.test/' } }),
    /collection block is unavailable/);
});

test('historical mapped targets retain exact bytes while fresh mapped assignments keep one authoritative collection block', t => {
  const f = fixture(t, '111k-v5');
  f.seedFrozen([{ category: 'egg', assetId: 76642 }]);
  const catalog = getRevealCatalog('111k-v7')!;
  const descriptor = getRevealCatalogDescriptor('111k-v7')!;
  f.database.prepare(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
    source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,activated_at_ms)
    VALUES('test',?,?,?,?,0,1,2,?,'active',1000,1001)`).run('0'.repeat(64), JSON.stringify(getRevealCatalogDescriptor('111k-v5')),
    JSON.stringify(descriptor), JSON.stringify(catalog), '0'.repeat(64));
  const payload = JSON.stringify([{ trait_type: 'collection block', value: 'Poets, Gamblers, Fools' },
    { trait_type: 'source', value: 'preserved' }, { trait_type: 'collection block', value: 'Poets, Gamblers, Fools' }]);
  const payloadSha256 = createHash('sha256').update(payload).digest('hex');
  for (const [eggId, assetId] of [[76642, 47128], [76641, 47127]]) {
    f.database.prepare(`INSERT INTO reveal_catalog_mappings(batch_id,egg_id,category,asset_id,attributes_json,attributes_sha256)
      VALUES('test',?,'painting',?,?,?)`).run(eggId, assetId, payload, payloadSha256);
  }
  f.database.prepare(`UPDATE settings SET active_catalog_generation='test',effective_catalog_version=?,effective_catalog_sha256=?,catalog_revision=1`)
    .run(descriptor.catalogVersion, descriptor.manifestSha256);
  const fresh = buildNewRevealedArtwork({ templateJson, tokenId: '2', crateTokenId: '111112', category: 'painting', assetId: 47127,
    observation, catalog });
  f.database.prepare(`INSERT INTO assignments(category,asset_id,crate_token_id,slot,token_id,artwork_json,metadata_json,placeholder_json,frozen_at_ms,assignment_revision)
    VALUES('egg',76641,'111112',1,'2',?,?,?,?,1)`).run(JSON.stringify(fresh.artwork), fresh.metadataJson, fresh.placeholderJson, 1002);
  const legacy = buildRevealedArtwork({ templateJson, tokenId: '1', crateTokenId: '111112', category: 'painting', assetId: 47128,
    observation, catalog });
  const [historical, current] = f.store.catalogUpdate.canonicalMetadata(['1', '2']);
  assert.equal(historical.metadataJson, applyRevealAttributePayload(legacy.metadataJson, payload).metadataJson);
  assert.equal(JSON.parse(historical.metadataJson).attributes.filter((row: { trait_type: string }) => row.trait_type === 'collection block').length, 2);
  assert.equal(current.metadataJson, applyRevealAttributePayload(fresh.metadataJson, payload).metadataJson);
  assert.equal(JSON.parse(current.metadataJson).attributes.filter((row: { trait_type: string }) => row.trait_type === 'collection block').length, 1);
});

test('unsupported, mismatched and incomplete effective identities do not reuse origin labels', t => {
  const f = fixture(t);
  const ids = f.seedFrozen([{ category: 'painting', assetId: 1 }]);
  for (const [version, hash] of [['111k-v999', '0'.repeat(64)], ['111k-v9', '0'.repeat(64)], ['111k-v9', null],
    [null, getRevealCatalogDescriptor('111k-v9')!.manifestSha256]]) {
    f.database.prepare('UPDATE settings SET effective_catalog_version=?,effective_catalog_sha256=?').run(version, hash);
    assert.equal(f.store.frozen(ids, { includeCollectionBlock: true })[0].collectionBlock, null);
  }
});

test('hatched frozen eggs use their effective artwork and effective catalog binding', t => {
  const f = fixture(t, '111k-v5');
  const ids = f.seedFrozen([{ category: 'egg', assetId: 76642 }, { category: 'egg', assetId: 1 }]);
  const original = f.snapshot();
  const catalog = getRevealCatalog('111k-v7')!;
  const descriptor = getRevealCatalogDescriptor('111k-v7')!;
  f.database.prepare(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
    source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,activated_at_ms)
    VALUES('test',?,?,?,?,0,1,1,?,'active',1000,1001)`).run('0'.repeat(64), JSON.stringify(getRevealCatalogDescriptor('111k-v5')),
    JSON.stringify(descriptor), JSON.stringify(catalog), '0'.repeat(64));
  f.database.prepare(`INSERT INTO reveal_catalog_mappings(batch_id,egg_id,category,asset_id) VALUES('test',76642,'painting',47128)`).run();
  f.database.prepare(`UPDATE settings SET active_catalog_generation='test',effective_catalog_version=?,effective_catalog_sha256=?,catalog_revision=1`)
    .run(descriptor.catalogVersion, descriptor.manifestSha256);
  const tokens = f.store.tokensResponse(f.deployment, ids);
  assert.deepEqual(tokens.artworks.map(artwork => [artwork.category, artwork.collectionBlock]), [['painting', 'Poets, Gamblers, Fools'], ['egg', null]]);
  assert.deepEqual(f.store.transactionResponse(f.deployment, observation.transactionHash).artworks, tokens.artworks);
  assert.deepEqual(f.snapshot(), original);
});
