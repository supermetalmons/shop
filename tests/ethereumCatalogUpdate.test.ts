import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildRevealAssetCatalog } from '../scripts/ethereum-metadata/assetImport.ts';
import { ordinaryRevealCatalogSource } from '../scripts/ethereum-metadata/ownerHatchingCatalog.ts';
import { catalogUpdateMain } from '../scripts/ethereum-metadata/catalogUpdateCli.ts';
import { getRevealCatalog, getRevealCatalogDescriptor, getSupportedRevealCatalogVersions } from '../shared/ethereum/revealCatalogRegistry.ts';
import { validateRevealAssetCatalog } from '../shared/ethereum/revealAssetCatalog.ts';
import { revealCatalogUpdateHash, validateRevealCatalogUpdateBatch, type RevealCatalogUpdateBatch } from '../shared/ethereum/revealCatalogUpdate.ts';
import { buildRevealCatalogUpdateBatch } from './helpers/historicalCatalogBatch.ts';

const sample = () => ({ '3d/1.png': [1, 1], 'animated/1.png': [1, 1], 'paintings/1.png': [1, 1],
  'paintings/alt/1.webp': [1, 1], 'videos/1.mp4': [2, 1], 'videos/1.webp': [2, 1] });
const nextSource = () => ({ ...sample(), 'paintings/2.png': [2, 3], 'paintings/3.png': [3, 2],
  'videos/2.mp4': [2, 1], 'videos/2.webp': [2, 1] });
const catalog = (source: object, catalogVersion: string) => buildRevealAssetCatalog(JSON.stringify(source), { catalogVersion, availableEggs: 111111 });
const batch = () => buildRevealCatalogUpdateBatch(catalog(sample(), '111k-v5'), catalog(nextSource(), '111k-v6'), () => 0);
function rehash(value: RevealCatalogUpdateBatch): RevealCatalogUpdateBatch {
  value.batchSha256 = revealCatalogUpdateHash(value);
  value.batchId = `catalog-${value.batchSha256.slice(0, 32)}`;
  return value;
}

test('partial, absent and sparse alternatives preserve full variant output and reject unknown IDs', () => {
  const full = catalog(sample(), '111k-v5');
  assert.equal(full.categories.paintings.variants!.alt.assetIds, undefined);
  const partial = catalog(nextSource(), '111k-v6');
  assert.deepEqual(partial.categories.paintings.variants!.alt.assetIds, [1]);
  const sparse = catalog({ ...nextSource(), 'paintings/alt/3.webp': [4, 3] }, '111k-v6');
  assert.deepEqual(sparse.categories.paintings.variants!.alt.assetIds, [1, 3]);
  const { 'paintings/alt/1.webp': _alt, ...absent } = nextSource();
  assert.equal(catalog(absent, '111k-v6').categories.paintings.variants, undefined);
  assert.throws(() => catalog({ ...sample(), 'paintings/alt/2.webp': [1, 1] }, '111k-v6'), /alternate IDs/);
  const malformed = structuredClone(sparse);
  malformed.categories.paintings.variants!.alt.assetIds = [3, 1];
  assert.throws(() => validateRevealAssetCatalog(malformed), /variant asset IDs/);
});

test('frozen mapping covers highest eggs exactly once and only new artwork identities', () => {
  const value = batch();
  validateRevealCatalogUpdateBatch(value);
  assert.equal(value.mappings.length, 3);
  assert.deepEqual(value.mappings.map(row => row.eggId), [111105, 111106, 111107]);
  assert.deepEqual(new Set(value.mappings.map(row => `${row.category}:${row.assetId}`)), new Set(['painting:2', 'painting:3', 'video:2']));
  assert.notDeepEqual(value.mappings.map(row => `${row.category}:${row.assetId}`), ['painting:2', 'painting:3', 'video:2']);
  const duplicated = structuredClone(value);
  duplicated.mappings[1] = { ...duplicated.mappings[0], eggId: duplicated.mappings[1].eggId };
  assert.throws(() => validateRevealCatalogUpdateBatch(rehash(duplicated)), /bijection/);
  const oldArtwork = structuredClone(value);
  oldArtwork.mappings[0].assetId = 1;
  assert.throws(() => validateRevealCatalogUpdateBatch(rehash(oldArtwork)), /bijection/);
  const wrongEgg = structuredClone(value);
  wrongEgg.mappings[0].eggId--;
  assert.throws(() => validateRevealCatalogUpdateBatch(rehash(wrongEgg)), /bijection/);
  const tampered = structuredClone(value);
  tampered.batchSha256 = 'a'.repeat(64);
  assert.throws(() => validateRevealCatalogUpdateBatch(tampered), /batch shape/);
});

test('explicit cutoff batches accept sparse effective egg IDs and preserve the historical v1 hash', () => {
  const legacy = batch();
  const oldHash = createHash('sha256').update(JSON.stringify({ version: legacy.version, nonce: legacy.nonce,
    predecessor: legacy.predecessor, target: legacy.target, mappings: legacy.mappings })).digest('hex');
  assert.equal(legacy.batchSha256, oldHash);
  const explicit = buildRevealCatalogUpdateBatch(legacy.predecessor.manifest, legacy.target.manifest, () => 0,
    { eggCutoff: 10, eggIds: [111110, 80, 20] });
  assert.equal(explicit.version, 2);
  assert.deepEqual(explicit.mappings.map(row => row.eggId), [20, 80, 111110]);
  validateRevealCatalogUpdateBatch(explicit);
  assert.throws(() => buildRevealCatalogUpdateBatch(legacy.predecessor.manifest, legacy.target.manifest, () => 0,
    { eggCutoff: 20, eggIds: [20, 80, 111110] }), /bijection/);
  assert.throws(() => buildRevealCatalogUpdateBatch(legacy.predecessor.manifest, legacy.target.manifest, () => 0,
    { eggCutoff: 10, eggIds: [20, 20, 80] }), /bijection/);
  assert.throws(() => validateRevealCatalogUpdateBatch({ ...legacy, version: '1' }), /batch shape/);
});

test('ordinary catalogue source removes registered grails without admitting them as regular additions', () => {
  const source = { ...nextSource(), 'animated/422.png': [512, 512, 'DROWEE'] };
  const ordinary = ordinaryRevealCatalogSource(JSON.stringify(source));
  assert.deepEqual(JSON.parse(ordinary), nextSource());
  assert.equal(buildRevealCatalogUpdateBatch(catalog(sample(), '111k-v5'), catalog(JSON.parse(ordinary), '111k-v6')).mappings.length, 3);
  assert.throws(() => ordinaryRevealCatalogSource(JSON.stringify({ ...source, 'animated/422.png': [512, 256, 'DROWEE'] })), /artwork changed/);
  assert.throws(() => ordinaryRevealCatalogSource('{"animated/422.png":[512,512,"DROWEE"],"animated/422.png":[512,512,"DROWEE"]}'), /duplicate paths/);
});

test('updates reject deletions, old media changes and nonincreasing catalog versions', () => {
  const old = catalog(sample(), '111k-v5');
  assert.throws(() => buildRevealCatalogUpdateBatch(old, catalog(sample(), '111k-v6')), /egg cutoff/);
  assert.throws(() => buildRevealCatalogUpdateBatch(old, catalog(nextSource(), '111k-v5')), /identity/);
  assert.throws(() => buildRevealCatalogUpdateBatch(old, catalog({ ...nextSource(), 'paintings/1.png': [2, 1] }, '111k-v6')), /media changed/);
  const { 'paintings/alt/1.webp': _alt, ...removedAlt } = nextSource();
  assert.throws(() => buildRevealCatalogUpdateBatch(old, catalog(removedAlt, '111k-v6')), /alternate changed/);
});

test('current v10 catalog and retained v5 through v9 ancestors are pinned and immutable', () => {
  const supported = getSupportedRevealCatalogVersions();
  for (const [version, eggs, paintings] of [
    ['111k-v5', 76642, 30990], ['111k-v6', 67284, 40348], ['111k-v7', 60504, 47128],
    ['111k-v8', 55303, 52329], ['111k-v9', 38652, 68980], ['111k-v10', 32190, 75442],
  ] as const) {
    assert.ok(supported.includes(version));
    const descriptor = getRevealCatalogDescriptor(version)!;
    const value = getRevealCatalog(version, descriptor.manifestSha256)!;
    assert.equal(value.categories.eggs.count, eggs);
    assert.equal(value.categories.paintings.count, paintings);
    assert.ok(Object.isFrozen(value.categories.eggs));
    assert.equal(getRevealCatalog(version, 'a'.repeat(64)), undefined);
  }
  assert.equal(getRevealCatalog('111k-v999'), undefined);
});

test('catalog history accepts only read-only commands and reports aggregate evidence', async () => {
  for (const command of ['prepare', 'apply', 'promote', 'eligible-eggs', 'cancel']) {
    await assert.rejects(catalogUpdateMain([command, '--bundle', 'unused']), /Usage/);
  }
  const value = await catalogUpdateMain(['verify', '--bundle', 'releases/111k-catalog-v7']);
  assert.deepEqual(Object.keys(value).sort(), ['artworks', 'batchId', 'batchSha256', 'verified']);
});
