import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import previousOwnerCatalog from '../../releases/111k-catalog-v10/predecessor-owner-supplement.json';
import { validateOwnerHatchingCatalog, type OwnerHatchingCatalog } from '../../shared/ethereum/ownerHatchingCatalog.ts';
import { computeRevealCatalogDescriptor, REVEAL_ASSET_FAMILIES, validateRevealAssetCatalog, type RevealAssetCatalog, type RevealAssetCatalogDescriptor } from '../../shared/ethereum/revealAssetCatalog.ts';
import { getRevealCatalog } from '../../shared/ethereum/revealCatalogRegistry.ts';
import { validateRevealCollectionBlocks, selectRevealCollectionBlocks, lookupRevealCollectionBlock, type RevealCollectionBlocks } from '../../shared/ethereum/revealCollectionBlocks.ts';
import { MIXED_ALLOCATION_GROUPS, MIXED_ALLOCATION_PREDECESSOR as PREDECESSOR } from '../../shared/ethereum/mixedAllocation20261117.ts';
import { mixedAllocationHash, mixedReleaseBlockHash, validateMixedAllocationRelease, validateMixedAllocationDefinition, type MixedAllocationGroup,
  type MixedAllocationDefinition } from '../../shared/ethereum/revealMixedAllocation.ts';
import { buildRevealAssetCatalog } from './assetImport.ts';
import { sha256 } from './catalog.ts';
import { buildRevealCollectionBlocks } from './collectionBlocks.ts';
import { readArtworkSource, ordinaryRevealCatalogSource, removeCatalogRelics, type ArtworkSource } from './ownerHatchingCatalog.ts';
import { revealCatalogAdditions } from '../../shared/ethereum/revealCatalogUpdate.ts';
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

export type MixedReleasePolicy = Pick<Extract<MixedAllocationDefinition, { version: 2 }>,
  'batchId' | 'deploymentId' | 'chainId' | 'contractAddress' | 'metadataBaseUri' | 'deploymentBlock' | 'originCatalogVersion' | 'predecessor'> & {
  targetVersion: string; quotas: { collections: string[]; ownerCount: number }[]; ordinaryCount?: number;
};

export type PreparedMixedRelease = {
  definition: MixedAllocationDefinition; predecessor: RevealAssetCatalog; targetCatalog: RevealAssetCatalog;
  collectionBlocks: RevealCollectionBlocks; ownerSupplement: OwnerHatchingCatalog; normalizedSource: string; originalSource: string;
};

function requireMixedSourceExtension(catalog: RevealAssetCatalog, source: string, next: ArtworkSource) {
  if (sha256(source) !== catalog.source.sha256) throw new Error('Mixed source does not match the installed catalog checksum.');
  const previous = readArtworkSource(source);
  for (const [path, entry] of Object.entries(previous)) {
    const after = next[path];
    if (!after || entry.some((value, i) => after[i] !== value)) throw new Error('Mixed release changed existing artwork source: ' + path);
  }
  return previous;
}

export function requireMixedHeadExtension(head: RevealAssetCatalog, headSource: string, target: RevealAssetCatalog, entries: ArtworkSource) {
  requireMixedSourceExtension(head, headSource, entries);
  revealCatalogAdditions(head, target, { allowUnchangedInventory: true });
}

function validateOriginalSupplement(source: ArtworkSource, supplement: OwnerHatchingCatalog,
  version: string, retained: readonly RevealAssetCatalogDescriptor[]) {
  const revision = Number(version.slice(6));
  removeCatalogRelics(source, revision >= 9);
  const index = supplement.batches.findLastIndex(batch => {
    const catalog = batch.target ?? batch.predecessor;
    return Number(catalog.catalogVersion.slice(6)) <= revision && retained.some(binding =>
      binding.catalogVersion === catalog.catalogVersion && binding.manifestSha256 === catalog.manifestSha256);
  });
  for (const batch of supplement.batches.slice(0, index + 1)) {
    for (const asset of batch.artworks) {
      const entry = source[`animated/${asset.assetId}.png`];
      if (!entry || entry[0] !== asset.width || entry[1] !== asset.height || entry[2] !== asset.collectionBlock) {
        throw new Error('Mixed source omitted or changed a historical owner artwork.');
      }
    }
  }
}

export function prepareMixedRelease(input: {
  originalSource: string; predecessorSource: string; installedSource?: string; policy: MixedReleasePolicy; predecessor: RevealAssetCatalog;
  ownerSupplement: OwnerHatchingCatalog; collectionBlocks: RevealCollectionBlocks; installedCatalogs: RevealAssetCatalog[];
}): PreparedMixedRelease {
  const { policy, predecessor, originalSource, ownerSupplement } = input;
  validateRevealAssetCatalog(predecessor, policy.predecessor);
  const origin = policy.originCatalogVersion === predecessor.catalogVersion ? predecessor :
    input.installedCatalogs.find(catalog => catalog.catalogVersion === policy.originCatalogVersion);
  if (!origin) throw new Error('Mixed release registered origin catalog is unavailable.');
  if ((policy.ordinaryCount ?? 0) > predecessor.importSettings.availableEggs - Math.max(origin.categories.eggs.count, predecessor.categories.eggs.count)) {
    throw new Error('Insufficient unused fresh egg inventory for the registered origin.');
  }
  validateOwnerHatchingCatalog(ownerSupplement);
  validateRevealCollectionBlocks(input.collectionBlocks);
  const originals = readArtworkSource(originalSource);
  validateOriginalSupplement(originals, ownerSupplement, policy.targetVersion, input.installedCatalogs.map(computeRevealCatalogDescriptor));
  const normalized = ordinaryRevealCatalogSource(originalSource);
  const entries = readArtworkSource(normalized);
  const previous = requireMixedSourceExtension(predecessor, input.predecessorSource, entries);
  const sameCatalog = policy.targetVersion === predecessor.catalogVersion;
  if (sameCatalog && Object.keys(entries).length !== Object.keys(previous).length) throw new Error('Mixed release needs a new catalog version for new media.');
  const normalizedSource = sameCatalog ? input.predecessorSource : normalized;
  const targetCatalog = sameCatalog ? predecessor : buildRevealAssetCatalog(normalizedSource, {
    catalogVersion: policy.targetVersion, availableEggs: predecessor.importSettings.availableEggs,
  });
  const target = computeRevealCatalogDescriptor(targetCatalog);
  const retainedTarget = input.installedCatalogs.find(catalog => catalog.catalogVersion === target.catalogVersion);
  if (retainedTarget && computeRevealCatalogDescriptor(retainedTarget).manifestSha256 !== target.manifestSha256) {
    throw new Error('Mixed target version is already bound to another catalog.');
  }
  const head = input.installedCatalogs.reduce((latest, catalog) =>
    Number(catalog.catalogVersion.slice(6)) > Number(latest.catalogVersion.slice(6)) ? catalog : latest, predecessor);
  if (!retainedTarget) {
    if (Number(target.catalogVersion.slice(6)) <= Number(head.catalogVersion.slice(6))) throw new Error('New mixed catalog version must exceed the installed version.');
    if (head.catalogVersion !== predecessor.catalogVersion) {
      if (input.installedSource === undefined) throw new Error('Current installed catalog source is required.');
      requireMixedHeadExtension(head, input.installedSource, targetCatalog, entries);
    }
  }
  const collectionBlocks = sameCatalog || retainedTarget ? input.collectionBlocks : buildRevealCollectionBlocks({
    source: normalizedSource, frozenSource: normalizedSource, catalog: targetCatalog, ancestors: input.installedCatalogs,
    previous: input.collectionBlocks,
  });
  const lookup = selectRevealCollectionBlocks(collectionBlocks, target);
  if (!lookup) throw new Error('Mixed release collection block lookup missing.');
  if (sameCatalog || retainedTarget) {
    for (const [category, family] of Object.entries(REVEAL_ASSET_FAMILIES)) {
      if (category === 'egg') continue;
      const media = targetCatalog.categories[family];
      const template = media.imagePathTemplate ?? media.pathTemplate;
      for (let ordinal = 1; ordinal <= media.count; ordinal++) {
        const id = media.assetIds?.[ordinal - 1] ?? ordinal;
        const label = entries[template.replace('{id}', String(id))]?.[2];
        if (label !== undefined && label !== lookupRevealCollectionBlock(lookup, category as MixedAllocationGroup['category'], id)) {
          throw new Error('Mixed source changed a recorded collection block.');
        }
      }
    }
  }
  const artifacts = { predecessor, targetCatalog, collectionBlocks, ownerSupplement };
  const definition = mixedDefinitionForPolicy(policy, originalSource, artifacts);
  return { definition, ...artifacts, normalizedSource, originalSource };
}

export function mixedDefinitionForPolicy(policy: MixedReleasePolicy, originalSource: string,
  { predecessor, targetCatalog, collectionBlocks, ownerSupplement }: Pick<PreparedMixedRelease, 'predecessor' | 'targetCatalog' | 'collectionBlocks' | 'ownerSupplement'>) {
  const supportedKeys = ['batchId', 'deploymentId', 'chainId', 'contractAddress', 'metadataBaseUri', 'deploymentBlock',
    'originCatalogVersion', 'predecessor', 'targetVersion', 'quotas', 'ordinaryCount'];
  if (Object.keys(policy).some(key => !supportedKeys.includes(key)) || !Array.isArray(policy.quotas)) throw new Error('Invalid mixed release policy.');
  if (policy.targetVersion !== targetCatalog.catalogVersion) throw new Error('Mixed policy target does not match the frozen catalog.');
  const target = computeRevealCatalogDescriptor(targetCatalog);
  const lookup = selectRevealCollectionBlocks(collectionBlocks, target);
  if (!lookup) throw new Error('Mixed release collection block lookup missing.');
  const sameCatalog = policy.targetVersion === predecessor.catalogVersion;
  const additions = sameCatalog ? [] : revealCatalogAdditions(predecessor, targetCatalog);
  const groups: MixedAllocationGroup[] = [];
  const byCollection = new Map<string, number>();
  const usedQuotas = new Set<number>();
  for (const [index, quota] of policy.quotas.entries()) {
    if (!quota || Object.keys(quota).length !== 2 || !Array.isArray(quota.collections) || !quota.collections.length ||
      !Number.isSafeInteger(quota.ownerCount) || quota.ownerCount < 0) throw new Error('Invalid collection quota.');
    for (const label of quota.collections) {
      if (typeof label !== 'string' || !label.trim() || byCollection.has(label)) throw new Error('Duplicate or invalid quota collection.');
      byCollection.set(label, index);
    }
  }
  const represented = new Set<string>();
  for (const { category, assetId } of additions) {
    const collectionBlock = lookupRevealCollectionBlock(lookup, category, assetId);
    if (!collectionBlock) throw new Error('New mixed artwork is missing its collection block.');
    const last = groups.at(-1);
    if (last && last.category === category && last.collectionBlock === collectionBlock && last.lastId + 1 === assetId) {
      last.lastId = assetId;
      continue;
    }
    represented.add(collectionBlock);
    const quota = byCollection.get(collectionBlock);
    const ownerCount = quota !== undefined && !usedQuotas.has(quota) ? policy.quotas[quota].ownerCount : 0;
    groups.push({ category, collectionBlock, firstId: assetId, lastId: assetId, ownerCount, ...(quota === undefined ? {} : { pool: 'quota-' + quota }) });
    if (quota !== undefined) usedQuotas.add(quota);
  }
  if ([...byCollection.keys()].some(label => !represented.has(label))) throw new Error('A quota collection has no new artworks.');
  const { batchId, deploymentId, chainId, contractAddress, metadataBaseUri, deploymentBlock } = policy;
  const definition: MixedAllocationDefinition = {
    version: 2, batchId, deploymentId, chainId, contractAddress, metadataBaseUri, deploymentBlock, originCatalogVersion: policy.originCatalogVersion,
    sourceSha256: sha256(originalSource), predecessor: policy.predecessor, target, ordinaryCount: policy.ordinaryCount ?? 0,
    collectionBlocksSha256: mixedReleaseBlockHash(collectionBlocks, target),
    ownerSupplementSha256: mixedAllocationHash(ownerSupplement), groups,
  };
  validateMixedAllocationRelease(definition, predecessor, targetCatalog, collectionBlocks, ownerSupplement);
  const { catalogVersion, manifestSha256 } = definition.predecessor;
  return { ...definition, predecessor: { catalogVersion, manifestSha256 } };
}

export async function readPreparedMixedRelease(directory: string): Promise<PreparedMixedRelease> {
  const read = (name: string) => readFile(join(directory, name), 'utf8');
  const [definition, predecessor, targetCatalog, collectionBlocks, ownerSupplement] = await Promise.all(
    ['definition.json', 'predecessor.json', 'manifest.json', 'collection-blocks.json', 'owner-supplement.json'].map(async path => JSON.parse(await read(path))));
  const [normalizedSource, originalSource] = await Promise.all(['source.json', 'original-input.json'].map(read));
  validateMixedAllocationDefinition(definition);
  validateMixedAllocationRelease(definition, predecessor, targetCatalog, collectionBlocks, ownerSupplement);
  validateOriginalSupplement(readArtworkSource(originalSource), ownerSupplement, definition.target.catalogVersion, collectionBlocks.catalogs);
  const generated = buildRevealAssetCatalog(normalizedSource, {
    catalogVersion: definition.target.catalogVersion, availableEggs: targetCatalog.importSettings.availableEggs,
  });
  validateRevealAssetCatalog(generated, definition.target);
  const normalized = ordinaryRevealCatalogSource(originalSource);
  const original = readArtworkSource(normalized);
  const installed = readArtworkSource(normalizedSource);
  if (sha256(originalSource) !== definition.sourceSha256 || sha256(normalizedSource) !== targetCatalog.source.sha256 ||
    definition.target.manifestSha256 !== definition.predecessor.manifestSha256 && normalized !== normalizedSource ||
    Object.keys(installed).length !== Object.keys(original).length || Object.entries(installed).some(([path, values]) =>
      !original[path] || values.some((value, i) => original[path][i] !== value))) throw new Error('Frozen mixed source changed.');
  return { definition, predecessor, targetCatalog, collectionBlocks, ownerSupplement, normalizedSource, originalSource };
}
