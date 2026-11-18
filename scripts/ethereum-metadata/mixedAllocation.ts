import { readFile } from 'node:fs/promises';
import previousOwnerCatalog from '../../releases/111k-catalog-v10/predecessor-owner-supplement.json';
import { validateOwnerHatchingCatalog, type OwnerHatchingCatalog } from '../../shared/ethereum/ownerHatchingCatalog.ts';
import { computeRevealCatalogDescriptor } from '../../shared/ethereum/revealAssetCatalog.ts';
import { getRevealCatalog } from '../../shared/ethereum/revealCatalogRegistry.ts';
import { validateRevealCollectionBlocks } from '../../shared/ethereum/revealCollectionBlocks.ts';
import { MIXED_ALLOCATION_GROUPS, MIXED_ALLOCATION_PREDECESSOR as PREDECESSOR } from '../../shared/ethereum/mixedAllocation20261117.ts';
import { mixedAllocationHash, validateMixedAllocationRelease,
  type MixedAllocationDefinition } from '../../shared/ethereum/revealMixedAllocation.ts';
import { buildRevealAssetCatalog } from './assetImport.ts';
import { sha256 } from './catalog.ts';
import { buildRevealCollectionBlocks } from './collectionBlocks.ts';
import { readArtworkSource, removeCatalogRelics, type ArtworkSource } from './ownerHatchingCatalog.ts';
import previousBlocks from '../../releases/111k-catalog-v10/predecessor-collection-blocks.json';

const REVIEW_SOURCE_SHA256 = 'e8ae1557e2aa5b4c98b525c1b8211e6aa4122468b421dbcaab078f9f33f9bc60';

function removeExisting(source: ArtworkSource, path: string, expected: readonly (string | number)[]): void {
  if (JSON.stringify(source[path]) !== JSON.stringify(expected)) throw new Error(`Mixed allocation changed or removed ${path}.`);
  delete source[path];
}

export async function buildMixedAllocation(bytes: string, expectedSourceSha256: string) {
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expectedSourceSha256) throw new Error('Mixed allocation source SHA-256 does not match.');
  const predecessor = getRevealCatalog(PREDECESSOR.catalogVersion, PREDECESSOR.manifestSha256);
  if (!predecessor) throw new Error('The frozen mixed allocation predecessor is unavailable.');
  const priorBytes = await readFile(new URL('../../releases/111k-catalog-v9/source.json', import.meta.url), 'utf8');
  if (sha256(priorBytes) !== predecessor.source.sha256) throw new Error('Predecessor artwork source SHA-256 does not match.');
  const previous = JSON.parse(priorBytes) as ArtworkSource;
  const ordinarySource = readArtworkSource(bytes);
  const manifestPaths = Object.keys(ordinarySource).length;
  for (const [path, entry] of Object.entries(previous)) {
    if (JSON.stringify(ordinarySource[path]) !== JSON.stringify(entry)) throw new Error(`Mixed allocation changed or removed ${path}.`);
  }
  const priorOwner: unknown = previousOwnerCatalog;
  validateOwnerHatchingCatalog(priorOwner);
  const oldAnimations = priorOwner.batches.flatMap(batch => batch.artworks);
  for (const asset of oldAnimations) {
    removeExisting(ordinarySource, `animated/${asset.assetId}.png`, [asset.width, asset.height, asset.collectionBlock]);
  }
  const knownRelics = removeCatalogRelics(ordinarySource, true);

  const artworks: OwnerHatchingCatalog['batches'][number]['artworks'] = [];
  for (const group of MIXED_ALLOCATION_GROUPS) {
    if (group.category !== 'animated') continue;
    for (let assetId = group.firstId; assetId <= group.lastId; assetId++) {
      const path = `animated/${assetId}.png`;
      const entry = ordinarySource[path];
      if (!entry || entry[2] !== group.collectionBlock) throw new Error(`Missing or mislabeled mixed animation: ${path}`);
      artworks.push({ assetId, width: entry[0], height: entry[1], collectionBlock: entry[2], animationExtension: 'mp4' });
      delete ordinarySource[path];
    }
  }
  let alternateCount = 0;
  for (const path of Object.keys(ordinarySource)) {
    if (Object.hasOwn(previous, path)) continue;
    const match = /^paintings\/alt\/([1-9]\d*)\.webp$/.exec(path);
    if (!match) continue;
    if (Number(match[1]) < 30_991 || Number(match[1]) > 68_980) throw new Error(`Unexpected mixed painting alternate: ${path}`);
    alternateCount++;
  }
  if (alternateCount !== 37_990) throw new Error('Mixed allocation painting alternate coverage changed.');
  const normalized = JSON.stringify(ordinarySource, null, 2) + '\n';
  const targetCatalog = buildRevealAssetCatalog(normalized, { catalogVersion: '111k-v10', availableEggs: predecessor.importSettings.availableEggs });
  const target = computeRevealCatalogDescriptor(targetCatalog);
  const ownerSupplement: OwnerHatchingCatalog = { ...priorOwner, batches: [...priorOwner.batches, {
    id: 'gan-videos-2026-11-17', allocation: 'mixed', source: { filename: '111k.json', sha256: sourceSha256 }, predecessor: PREDECESSOR, target, artworks,
  }] };
  validateOwnerHatchingCatalog(ownerSupplement, priorOwner);
  const priorBlocks: unknown = previousBlocks;
  validateRevealCollectionBlocks(priorBlocks);
  const collectionBlocks = buildRevealCollectionBlocks({ source: normalized, frozenSource: normalized, catalog: targetCatalog,
    ancestors: [predecessor], previous: priorBlocks });
  const definition: MixedAllocationDefinition = { version: 1, sourceSha256, predecessor: PREDECESSOR, target,
    collectionBlocksSha256: mixedAllocationHash(collectionBlocks), ownerSupplementSha256: mixedAllocationHash(ownerSupplement),
    groups: MIXED_ALLOCATION_GROUPS.map(group => ({ ...group })) };
  validateMixedAllocationRelease(definition, predecessor, targetCatalog, collectionBlocks, ownerSupplement);
  const groups = definition.groups.map(group => {
    const newArtworks = group.lastId - group.firstId + 1;
    return { ...group, newArtworks, futureCount: newArtworks - group.ownerCount };
  });
  const summary = { manifestPaths, unchangedPaths: Object.keys(previous).length, knownOwnerArtworks: oldAnimations.length, knownRelics,
    newAlternates: alternateCount, newArtworks: groups.reduce((sum, row) => sum + row.newArtworks, 0),
    ownerCount: groups.reduce((sum, row) => sum + row.ownerCount, 0), futureCount: groups.reduce((sum, row) => sum + row.futureCount, 0), groups };
  return { definition, predecessor, targetCatalog, collectionBlocks, ownerSupplement, normalizedSource: normalized, summary };
}

export async function inspectMixedAllocation(sourcePath: string) {
  return buildMixedAllocation(await readFile(sourcePath, 'utf8'), REVIEW_SOURCE_SHA256);
}
