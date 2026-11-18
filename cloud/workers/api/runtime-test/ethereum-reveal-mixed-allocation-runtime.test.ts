import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareMixedRelease } from '../../../../scripts/ethereum-metadata/mixedAllocation.ts';
import { rehearseMixedBundle, rehearsePreparedMixedRelease } from '../../../../scripts/ethereum-metadata/rehearseMixedAllocation.ts';

import { readArtworkSource } from '../../../../scripts/ethereum-metadata/ownerHatchingCatalog.ts';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { validateRevealCollectionBlocks } from '../../../../shared/ethereum/revealCollectionBlocks.ts';
import { validateOwnerHatchingCatalog } from '../../../../shared/ethereum/ownerHatchingCatalog.ts';

test('the frozen November mixed release exchanges only free eggs under concurrent reveal and owner activity', { timeout: 240_000 }, async () => {
  const directory = fileURLToPath(new URL('../../../../releases/111k-catalog-v10/', import.meta.url));
  const result = await rehearseMixedBundle(directory);
  assert.equal(result.ready, 424);
  assert.equal(result.future, 6162);
  assert.equal(result.supply, 111111);
  assert.equal(result.published, 424);
  assert.ok(result.verificationPasses >= 2);
});

async function preparedFixture(style: 'mixed' | 'ordinary' | 'future', ordinaryCount: number = 1) {
  const source = (path: string) => readFile(new URL('../../../../' + path, import.meta.url), 'utf8');
  const frozen = 'releases/111k-catalog-v10/';
  const predecessorSource = await source(frozen + 'source.json');
  const predecessor = getRevealCatalog('111k-v10')!;
  const ownerSupplement: unknown = JSON.parse(await source(frozen + 'owner-supplement.json'));
  const collectionBlocks: unknown = JSON.parse(await source(frozen + 'collection-blocks.json'));
  validateOwnerHatchingCatalog(ownerSupplement);
  validateRevealCollectionBlocks(collectionBlocks);
  const originalSource = await source(frozen + 'original-input.json');
  const entries = readArtworkSource(originalSource);
  const families = ['paintings','videos','3d','animated'] as const;
  for (const family of families) {
    const largest = family === 'animated' ? Math.max(predecessor.categories.animated.count, ...ownerSupplement.batches.flatMap(batch => batch.artworks.map(art => art.assetId))) :
      predecessor.categories[family].count;
    for (let i = 1; i <= 2; i++) {
      const key = `${family}/${largest+i}`;
      entries[key + (family === 'videos' ? '.webp' : '.png')] = [320,240,family];
      if (family === 'videos') entries[key + '.mp4'] = [320,240,family];
    }
  }
  const common = { predecessor, predecessorSource, collectionBlocks, ownerSupplement,
    installedCatalogs: collectionBlocks.catalogs.map(catalog => getRevealCatalog(catalog.catalogVersion, catalog.manifestSha256)!) };
  const policy = {batchId: 'rehearsed-split', deploymentId: 'sepolia-rehearsal', chainId: 11155111,
    contractAddress: '0x' + 'ab'.repeat(20), metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/rehearsal/',
    deploymentBlock: 77, originCatalogVersion: style === 'ordinary' ? '111k-v5' : predecessor.catalogVersion, predecessor: getRevealCatalogDescriptor(predecessor.catalogVersion)!,
    targetVersion: '111k-v' + (Number(predecessor.catalogVersion.slice(6)) + 1),
    quotas: families.map(family => ({collections:[family],ownerCount:1})),
    ordinaryCount: 1 };
  const added = JSON.stringify(entries);
  const ordinary = style === 'ordinary', future = style === 'future';
  return prepareMixedRelease({...common, originalSource: ordinary ? originalSource : added,
    policy: {...policy, batchId: 'rehearsed-' + style, quotas: style === 'mixed' ? policy.quotas : [],
      ordinaryCount: future ? 0 : ordinaryCount,
      targetVersion: ordinary ? predecessor.catalogVersion : policy.targetVersion}});
}

for (const style of ['mixed','future','ordinary'] as const) {
  test(`reusable Sepolia ${style} allocation from its registered origin`, {timeout: 180_000}, async () => {
    const result = await rehearsePreparedMixedRelease(await preparedFixture(style));
    assert.equal(result.published, style === 'ordinary' ? 1 : style === 'future' ? 0 : 5);
    assert.equal(result.future, style === 'ordinary' ? 0 : style === 'future' ? 8 : 4);
    assert.equal(result.supply,111_111);
    assert.equal(result.verificationPasses,2);
  });
}

test('ordinary release preparation uses the registered origin to bound fresh media', async () => {
  const origin = getRevealCatalog('111k-v5')!;
  const predecessor = getRevealCatalog('111k-v10')!;
  const ordinary = origin.importSettings.availableEggs - origin.categories.eggs.count + 1;
  assert.ok(ordinary <= predecessor.importSettings.availableEggs - predecessor.categories.eggs.count);
  await assert.rejects(preparedFixture('ordinary', ordinary), /Insufficient unused fresh egg inventory for the registered origin/);
});
