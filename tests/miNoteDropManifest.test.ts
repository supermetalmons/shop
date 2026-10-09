import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePrepareMiNoteDropArgs } from '../scripts/prepare-mi-note-drop.ts';
import {
  miNoteCatalogIds, miNoteManifestDigest, parseMiNoteDropManifest, prepareMiNoteDropManifest,
  miNotePreorderAssetsFromCollection, readMiNotePreorderSnapshot, validateMiNotePreorderSnapshot, verifyMiNoteDropManifest,
} from '../scripts/shared/miNoteDropManifest.ts';
import { resolveDropInventoryManifest } from '../shared/dropInventoryManifest.ts';
import { miNoteManifestFixture } from './helpers/miNoteManifest.ts';
import { miNoteDropFixture } from './helpers/miNoteDropFixture.ts';

test('the Mi Note snapshot keeps clean IDs, includes specials and excludes legacy succeeded orders', async () => {
  const fixture = miNoteManifestFixture();
  const manifest = await fixture.manifest();
  assert.deepEqual(manifest.excludedCardIds, [1, 4]);
  assert.deepEqual(manifest.eligibleCardIds, [2, 3, 1401, 1430]);
  assert.equal(manifest.packCount, 2);
  assert.equal(manifest.maxFigureId, 1430);
  assert.deepEqual(manifest.sourcePreorder, { preorderId: fixture.config.preorderId, cluster: 'devnet', collection: fixture.config.collection });
  assert.equal(manifest.catalogSha256, miNoteManifestDigest(fixture.catalogText));
  assert.equal(parseMiNoteDropManifest(manifest), manifest);
  for (const forbidden of ['buyer', 'ethereum', 'signature', 'signed_transaction', 'orderId', 'address']) {
    assert.equal(Object.hasOwn(manifest, forbidden), false);
    assert.doesNotMatch(JSON.stringify(manifest), new RegExp(`"${forbidden}"`));
  }
});

test('snapshot SQL is one read scoped by both collection and cluster without customer fields', async () => {
  const fixture = miNoteManifestFixture();
  await readMiNotePreorderSnapshot((sql) => {
    assert.match(sql, /^SELECT json_object/);
    assert.match(sql, /cluster = 'devnet' AND collection = '65JF5n29WqB5Z7YsHQXLAPvgsytHRZDixKzqSq2D1RMv'/);
    assert.doesNotMatch(sql, /buyer|ethereum_address|signed_transaction|\bUPDATE\b|\bINSERT\b|\bDELETE\b/);
    return fixture.dependencies.query(sql);
  }, fixture.config);
});

for (const status of ['prepared', 'submitted']) {
  test(`unresolved ${status} orders block an inventory snapshot`, async () => {
    const fixture = miNoteManifestFixture();
    fixture.snapshot.orders[0].status = status;
    await assert.rejects(fixture.manifest(), /unresolved/);
  });
}

test('snapshot validation rejects cross-cluster claims, missing claims, duplicate cards and stale failed claims', () => {
  for (const mutate of [
    (value: ReturnType<typeof miNoteManifestFixture>) => { value.snapshot.claims[0].cluster = 'mainnet-beta'; },
    (value: ReturnType<typeof miNoteManifestFixture>) => { value.snapshot.claims.pop(); },
    (value: ReturnType<typeof miNoteManifestFixture>) => { value.snapshot.orders.push({ ...value.snapshot.orders[0], orderId: 'duplicate' }); },
    (value: ReturnType<typeof miNoteManifestFixture>) => { value.snapshot.orders[0].status = 'failed'; },
    (value: ReturnType<typeof miNoteManifestFixture>) => { value.snapshot.orders[0].assets[0].id = 1401; },
  ]) {
    const fixture = miNoteManifestFixture();
    mutate(fixture);
    assert.throws(() => validateMiNotePreorderSnapshot(fixture.snapshot, fixture.config, miNoteCatalogIds(fixture.catalogText).preorder));
  }
});

test('finalized collection verification rejects mismatched addresses, IDs, genesis and missing assets', async () => {
  for (const mutate of [
    (value: ReturnType<typeof miNoteManifestFixture>) => { value.chain.assets[0].address = value.chain.assets[1].address; },
    (value: ReturnType<typeof miNoteManifestFixture>) => { value.chain.assets[0].id = 2; },
    (value: ReturnType<typeof miNoteManifestFixture>) => { value.chain.genesisHash = 'wrong'; },
    (value: ReturnType<typeof miNoteManifestFixture>) => { value.chain.assets.pop(); },
  ]) {
    const fixture = miNoteManifestFixture();
    mutate(fixture);
    await assert.rejects(fixture.manifest(), /Finalized preorder/);
  }
});

test('a shared collection retains its 22 preorders while excluding bounded public pack and card assets', () => {
  const { config } = miNoteManifestFixture();
  const drop = miNoteDropFixture();
  const preorders = Array.from({ length: 22 }, (_, index) => ({ address: `asset-${index + 1}`, name: `Preorder #${index + 1}`,
    collection: config.collection, uri: `${config.metadataBase}${index + 1}.json` }));
  const pack = { address: 'public-pack', name: 'Pack #704', collection: config.collection, uri: `${drop.metadataBase}/b704.json` };
  const card = { address: 'public-card', name: 'Card #1430', collection: config.collection, uri: `${drop.metadataBase}/f1430.json` };
  assert.deepEqual(miNotePreorderAssetsFromCollection(config, [...preorders, pack, card], [drop]).map((asset) => asset.id),
    Array.from({ length: 22 }, (_, index) => index + 1));
  for (const uri of [`${drop.metadataBase}/b705.json`, `${drop.metadataBase}/f1431.json`, `${drop.metadataBase}/f01.json`,
    `${drop.metadataBase}/f1.json?unexpected=1`, `${drop.metadataBase}/rb1.json`, `${config.metadataBase}unknown.json`]) {
    assert.throws(() => miNotePreorderAssetsFromCollection(config, [...preorders, { ...card, uri }], [drop]), /unexpected or malformed/);
  }
  for (const changed of [{ solanaCluster: 'mainnet-beta' as const }, { collectionMint: 'another-collection' },
    { metadataBase: `${drop.metadataBase}/other` }]) {
    assert.throws(() => miNotePreorderAssetsFromCollection(config, [...preorders, pack], [{ ...drop, ...changed }]), /unexpected or malformed/);
  }
});

test('regular assets cannot hide a mismatched or migrated claimed preorder asset', async () => {
  const fixture = miNoteManifestFixture();
  const drop = miNoteDropFixture();
  const publicCard = { address: 'public-card', name: 'Card #1430', collection: fixture.config.collection, uri: `${drop.metadataBase}/f1430.json` };
  const chainWithPublic = () => ({ ...fixture.chain,
    assets: miNotePreorderAssetsFromCollection(fixture.config, [...fixture.chain.assets, publicCard], [drop]) });
  await prepareMiNoteDropManifest(fixture.config.preorderId, { ...fixture.dependencies, chain: async () => chainWithPublic() });
  fixture.chain.assets[0].address = fixture.chain.assets[1].address;
  await assert.rejects(prepareMiNoteDropManifest(fixture.config.preorderId,
    { ...fixture.dependencies, chain: async () => chainWithPublic() }), /asset addresses differ/);
  fixture.chain.assets[0].uri = `${drop.metadataBase}/f1.json`;
  await assert.rejects(prepareMiNoteDropManifest(fixture.config.preorderId,
    { ...fixture.dependencies, chain: async () => chainWithPublic() }), /does not match the permanent claims/);
});

test('a source change during chain verification cannot produce a manifest', async () => {
  const fixture = miNoteManifestFixture();
  await assert.rejects(prepareMiNoteDropManifest(fixture.config.preorderId, {
    ...fixture.dependencies,
    chain: async () => { fixture.snapshot.orders[0].revision += 1; return fixture.chain; },
  }), /changed during chain verification/);
});

test('an odd remaining card count fails rather than discarding a card', async () => {
  const fixture = miNoteManifestFixture();
  const catalog = JSON.parse(fixture.catalogText);
  catalog.ethereumCollections[0].tokens.push({ clean_card_id: 5, name: 'odd card' });
  await assert.rejects(prepareMiNoteDropManifest(fixture.config.preorderId, {
    ...fixture.dependencies, catalogText: () => JSON.stringify(catalog),
  }), /exact positive number of two-card packs/);
});

test('manifest revalidation ignores a newer chain slot but rejects altered content or source', async () => {
  const fixture = miNoteManifestFixture();
  const manifest = await fixture.manifest();
  fixture.chain.slot += 10;
  assert.equal((await verifyMiNoteDropManifest(manifest, fixture.dependencies)).chain.slot, fixture.chain.slot);
  assert.throws(() => parseMiNoteDropManifest({ ...manifest, eligibleCardIds: [1, 3, 1401, 1430] }), /modified/);
  fixture.snapshot.orders[0].revision += 1;
  await assert.rejects(verifyMiNoteDropManifest(manifest, fixture.dependencies), /stale/);
});

test('inventory manifests allow sparse high IDs only within the operations bound and remain optional for other drops', () => {
  const inventoryManifest = { sha256: 'a'.repeat(64), cardIds: [2, 3, 1401, 1430] };
  const drop = { maxSupply: 2, itemsPerBox: 2, operationsConfig: { maxSupply: 715 }, inventoryManifest };
  assert.equal(resolveDropInventoryManifest(drop), inventoryManifest);
  assert.equal(resolveDropInventoryManifest({ maxSupply: 2, itemsPerBox: 2 }), undefined);
  assert.throws(() => resolveDropInventoryManifest({ ...drop, operationsConfig: undefined }));
  for (const cardIds of [[2, 3, 1401], [2, 2, 1401, 1430], [3, 2, 1401, 1430], [0, 3, 1401, 1430], [2, 3, 1401, 1431]]) {
    assert.throws(() => resolveDropInventoryManifest({ ...drop, inventoryManifest: { ...inventoryManifest, cardIds } }));
  }
});

test('preparation CLI selects exactly one local output or check operation', () => {
  assert.equal(parsePrepareMiNoteDropArgs(['mi_note_cards']).preorderId, 'mi_note_cards');
  assert.ok(parsePrepareMiNoteDropArgs(['mi_note_cards_devnet', '--output', 'manifest.json']).output?.endsWith('/manifest.json'));
  for (const argv of [[], ['mi_note_cards', '--write'], ['mi_note_cards', '--output'],
    ['mi_note_cards', '--output', 'one.json', '--check', 'two.json']]) {
    assert.throws(() => parsePrepareMiNoteDropArgs(argv), /Usage/);
  }
});
