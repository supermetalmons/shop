import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { appendOwnerHatchingCatalogBatch } from '../scripts/ethereum-metadata/ownerHatchingCatalog.ts';
import { getOwnerHatchingGrail, getOwnerHatchingGrails, ownerHatchingCatalogSha256,
  validateOwnerHatchingCatalog, type OwnerHatchingCatalog } from '../shared/ethereum/ownerHatchingCatalog.ts';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../shared/ethereum/revealCatalogRegistry.ts';
import { revealCatalogMedia } from '../shared/ethereum/revealAssetCatalog.ts';

const supplement: OwnerHatchingCatalog = JSON.parse(await readFile(new URL('../shared/ethereum/ownerHatchingCatalog.json', import.meta.url), 'utf8'));
const predecessor = { catalogVersion: '111k-v9', manifestSha256: 'a7cf99fd2f9850a069ff9e69dfacdfb87249eeb0c4a8d5fcee1967da950974f1' };

test('the public grail supplement preserves all 175 DROWEE assets without changing the ordinary catalog', () => {
  validateOwnerHatchingCatalog(supplement);
  assert.equal(supplement.batches[0].source.sha256, 'd72eef0c264fb1e985f8a761308bacb1c8e69a5f2bc93dcf9d5160df838c8ddd');
  assert.deepEqual(getRevealCatalogDescriptor('111k-v9'), predecessor);
  const ordinary = getRevealCatalog('111k-v9')!;
  assert.equal(ordinary.categories.eggs.count, 38652);
  assert.equal(revealCatalogMedia(ordinary, 'animated', 421).animation_url, 'https://cdn.lil.org/nft/111k/animated/421.mp4');
  assert.throws(() => revealCatalogMedia(ordinary, 'animated', 422), /invalid asset ID/);
  const grails = getOwnerHatchingGrails();
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
  assert.equal(getOwnerHatchingGrail('animated', 597), undefined);
  assert.equal(ownerHatchingCatalogSha256, createHash('sha256').update(JSON.stringify(supplement)).digest('hex'));
});

test('grail source imports preserve original source evidence and support only immutable additive batches', () => {
  const predecessorSource = JSON.stringify({ 'animated/1.png': [512, 512, 'Earlier'] });
  const source = JSON.stringify({ 'animated/1.png': [512, 512, 'Earlier'], 'animated/2.png': [512, 256, 'New'], 'relics/1.png': [512, 512] });
  const first = appendOwnerHatchingCatalogBatch({ source, predecessorSource, predecessor, batchId: 'first', animationExtension: 'gif' });
  assert.equal(first.batches[0].source.sha256, createHash('sha256').update(source).digest('hex'));
  assert.deepEqual(first.batches[0].artworks, [{ assetId: 2, width: 512, height: 256, collectionBlock: 'New', animationExtension: 'gif' }]);
  const nextSource = JSON.stringify({ ...JSON.parse(source), 'animated/3.png': [128, 512, 'Next'] });
  const next = appendOwnerHatchingCatalogBatch({ source: nextSource, predecessorSource, predecessor, batchId: 'second',
    animationExtension: 'mp4', previous: first });
  validateOwnerHatchingCatalog(next, first);
  assert.deepEqual(next.batches[0], first.batches[0]);
  assert.deepEqual(next.batches[1].artworks.map(row => row.assetId), [3]);
  assert.throws(() => appendOwnerHatchingCatalogBatch({ source, predecessorSource, predecessor, batchId: 'second',
    animationExtension: 'gif', previous: first }), /Invalid owner hatching catalog/);
  const changed = structuredClone(next);
  changed.batches[0].artworks[0].animationExtension = 'mp4';
  assert.throws(() => validateOwnerHatchingCatalog(changed, first), /cannot change existing batches/);
  const duplicate = structuredClone(next);
  duplicate.batches[1].artworks[0].assetId = 2;
  assert.throws(() => validateOwnerHatchingCatalog(duplicate), /Invalid owner hatching catalog/);
});

test('grail imports reject changed existing art, unlabeled additions, unexpected additions and private mapping fields', () => {
  const predecessorSource = JSON.stringify({ 'animated/1.png': [512, 512, 'Earlier'] });
  const base = { predecessorSource, predecessor, batchId: 'first', animationExtension: 'gif' as const };
  for (const source of [
    { 'animated/1.png': [512, 256, 'Earlier'], 'animated/2.png': [512, 512, 'New'] },
    { 'animated/1.png': [512, 512, 'Earlier'], 'animated/2.png': [512, 512] },
    { 'animated/1.png': [512, 512, 'Earlier'], 'paintings/2.png': [512, 512, 'New'] },
  ]) assert.throws(() => appendOwnerHatchingCatalogBatch({ ...base, source: JSON.stringify(source) }));
  assert.throws(() => validateOwnerHatchingCatalog({ ...supplement, tokenIds: ['1'] }), /Invalid owner hatching catalog/);
  const invalid = structuredClone(supplement);
  Object.assign(invalid.batches[0].artworks[0], { tokenId: '1' });
  assert.throws(() => validateOwnerHatchingCatalog(invalid), /Invalid owner hatching catalog/);
});
