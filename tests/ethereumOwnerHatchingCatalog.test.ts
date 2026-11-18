import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ordinaryRevealCatalogSource } from '../scripts/ethereum-metadata/ownerHatchingCatalog.ts';
import { getOwnerHatchingGrail, getOwnerHatchingGrails, ownerHatchingCatalogSha256,
  validateOwnerHatchingCatalog, type OwnerHatchingCatalog } from '../shared/ethereum/ownerHatchingCatalog.ts';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../shared/ethereum/revealCatalogRegistry.ts';
import { revealCatalogMedia } from '../shared/ethereum/revealAssetCatalog.ts';

const supplement: OwnerHatchingCatalog = JSON.parse(await readFile(new URL('../shared/ethereum/ownerHatchingCatalog.json', import.meta.url), 'utf8'));
const predecessor = { catalogVersion: '111k-v9', manifestSha256: 'a7cf99fd2f9850a069ff9e69dfacdfb87249eeb0c4a8d5fcee1967da950974f1' };

test('ordinary imports exclude only matching owner posters and their recorded companion formats', () => {
  const ordinary = { 'paintings/1.png': [100, 100, 'fixture'] };
  for (const extension of ['gif', 'mp4']) {
    const artwork = supplement.batches.flatMap(batch => batch.artworks).find(row => row.animationExtension === extension)!;
    const prefix = `animated/${artwork.assetId}.`;
    const dimensions = [artwork.width, artwork.height];
    const entry = [...dimensions, artwork.collectionBlock];
    const normalize = (source: object) => JSON.parse(ordinaryRevealCatalogSource(JSON.stringify({ ...ordinary, ...source })));
    assert.deepEqual(normalize({}), ordinary);
    assert.deepEqual(normalize({ [prefix + 'png']: dimensions, [prefix + extension]: entry }), ordinary);
    assert.throws(() => normalize({ [prefix + 'png']: [2 * artwork.width, 2 * artwork.height, artwork.collectionBlock] }), /owner hatching artwork changed/);
    assert.throws(() => normalize({ [prefix + (extension === 'gif' ? 'mp4' : 'gif')]: entry }), /owner hatching artwork changed/);
  }
});

test('the public grail supplement preserves all 175 DROWEE assets without changing the ordinary catalog', () => {
  validateOwnerHatchingCatalog(supplement);
  assert.equal(supplement.batches[0].source.sha256, 'd72eef0c264fb1e985f8a761308bacb1c8e69a5f2bc93dcf9d5160df838c8ddd');
  assert.deepEqual(getRevealCatalogDescriptor('111k-v9'), predecessor);
  const ordinary = getRevealCatalog('111k-v9')!;
  assert.equal(ordinary.categories.eggs.count, 38652);
  assert.equal(revealCatalogMedia(ordinary, 'animated', 421).animation_url, 'https://cdn.lil.org/nft/111k/animated/421.mp4');
  assert.throws(() => revealCatalogMedia(ordinary, 'animated', 422), /invalid asset ID/);
  const grails = getOwnerHatchingGrails().filter(grail => grail.collectionBlock === 'DROWEE');
  assert.equal(grails.length, 175);
  assert.deepEqual(grails.map(grail => grail.assetId), Array.from({ length: 175 }, (_, index) => 422 + index));
  for (const grail of grails) {
    assert.equal(grail.image, `https://cdn.lil.org/nft/111k/animated/${grail.assetId}.png`);
    assert.equal(grail.animation_url, `https://cdn.lil.org/nft/111k/animated/${grail.assetId}.gif`);
    assert.equal(grail.collectionBlock, 'DROWEE');
    assert.deepEqual(grail.aspectRatio, { width: 1, height: 1 });
    assert.equal(getOwnerHatchingGrail('animated', grail.assetId), grail);
  }
  assert.equal(getOwnerHatchingGrail('animated', 421), undefined);
  assert.equal(getOwnerHatchingGrail('egg', 422), undefined);
  assert.equal(getOwnerHatchingGrail('animated', 597)?.animation_url, 'https://cdn.lil.org/nft/111k/animated/597.mp4');
  assert.equal(getOwnerHatchingGrails().length, 299);
  assert.equal(ownerHatchingCatalogSha256, createHash('sha256').update(JSON.stringify(supplement)).digest('hex'));
});

test('frozen owner supplements reject changes to recorded batches, duplicate artworks and private assignment fields', () => {
  const changed = structuredClone(supplement);
  changed.batches[0].artworks[0].animationExtension = 'mp4';
  assert.throws(() => validateOwnerHatchingCatalog(changed, supplement), /cannot change existing batches/);
  const duplicate = structuredClone(supplement);
  duplicate.batches.at(-1)!.artworks[0].assetId = duplicate.batches[0].artworks[0].assetId;
  assert.throws(() => validateOwnerHatchingCatalog(duplicate), /Invalid owner hatching catalog/);
  assert.throws(() => validateOwnerHatchingCatalog({ ...supplement, tokenIds: ['1'] }), /Invalid owner hatching catalog/);
  const invalid = structuredClone(supplement);
  Object.assign(invalid.batches[0].artworks[0], { tokenId: '1' });
  assert.throws(() => validateOwnerHatchingCatalog(invalid), /Invalid owner hatching catalog/);
});
