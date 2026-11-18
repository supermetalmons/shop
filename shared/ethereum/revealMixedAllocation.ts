import { MIXED_ALLOCATION_GROUPS, MIXED_ALLOCATION_PREDECESSOR, MIXED_OWNER_PREDECESSOR_SHA256 } from './mixedAllocation20261117.ts';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ethereumMetadataBaseUri } from './config.ts';
import { validateOwnerHatchingCatalog } from './ownerHatchingCatalog.ts';
import { validateRevealAssetCatalog, type RevealAssetCatalog, type RevealAssetCatalogDescriptor } from './revealAssetCatalog.ts';
import { revealCatalogAdditions } from './revealCatalogUpdate.ts';
import { lookupRevealCollectionBlock, selectRevealCollectionBlocks, validateRevealCollectionBlocks, type RevealCollectionBlocks } from './revealCollectionBlocks.ts';

export type MixedAllocationArtwork = { category: 'painting' | 'animated' | 'video' | '3d'; assetId: number };
export type MixedAllocationGroup = {
  category: MixedAllocationArtwork['category']; collectionBlock: string; firstId: number; lastId: number; ownerCount: number; pool?: string;
};
type MixedReleaseFields = {
  sourceSha256: string; predecessor: RevealAssetCatalogDescriptor; target: RevealAssetCatalogDescriptor;
  collectionBlocksSha256: string; ownerSupplementSha256: string; groups: MixedAllocationGroup[];
};

export type MixedAllocationDefinition = MixedReleaseFields & ({ version: 1 } | {
  version: 2; batchId: string; deploymentId: string; chainId: number; contractAddress: string;
  metadataBaseUri: string; deploymentBlock: number; originCatalogVersion: string; ordinaryCount: number;
});

export function mixedAllocationCounts(definition: MixedAllocationDefinition) {
  const preassignedCount = definition.groups.reduce((sum, group) => sum + group.ownerCount, 0);
  const totalCount = definition.groups.reduce((sum, group) => sum + group.lastId - group.firstId + 1, 0);
  const ordinaryCount = definition.version === 2 ? definition.ordinaryCount : 0;
  return { preassignedCount, totalCount, ordinaryCount, readyCount: preassignedCount + ordinaryCount, futureCount: totalCount - preassignedCount };
}

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^111k-v[1-9]\d{0,8}$/;

export function mixedAllocationHash(value: unknown): string {
  return bytesToHex(sha256(JSON.stringify(value)));
}

function record(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function descriptor(value: unknown): value is RevealAssetCatalogDescriptor {
  return record(value, ['catalogVersion', 'manifestSha256']) && typeof value.catalogVersion === 'string' && VERSION.test(value.catalogVersion) &&
    typeof value.manifestSha256 === 'string' && SHA256.test(value.manifestSha256);
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function validateMixedAllocationDefinition(value: unknown): asserts value is MixedAllocationDefinition {
  const v2 = typeof value === 'object' && value !== null && 'version' in value && value.version === 2;
  const identity = ['batchId', 'deploymentId', 'chainId', 'contractAddress', 'metadataBaseUri', 'deploymentBlock', 'originCatalogVersion', 'ordinaryCount'];
  if (!record(value, ['version', 'sourceSha256', 'predecessor', 'target', 'ownerSupplementSha256', 'collectionBlocksSha256', 'groups', ...(v2 ? identity : [])]) ||
    !v2 && value.version !== 1 || ![value.sourceSha256, value.ownerSupplementSha256, value.collectionBlocksSha256].every(hash => typeof hash === 'string' && SHA256.test(hash)) ||
    !descriptor(value.predecessor) || !descriptor(value.target) || !Array.isArray(value.groups)) throw new Error('Invalid mixed allocation definition.');
  if (v2 && (typeof value.batchId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.batchId) ||
    typeof value.deploymentId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.deploymentId) ||
    ![1, 11155111].includes(Number(value.chainId)) || typeof value.chainId !== 'number' ||
    typeof value.contractAddress !== 'string' || !/^0x[0-9a-f]{40}$/.test(value.contractAddress) || /^0x0{40}$/.test(value.contractAddress) ||
    typeof value.metadataBaseUri !== 'string' || ethereumMetadataBaseUri(value.metadataBaseUri, value.chainId) !== value.metadataBaseUri || !integer(value.deploymentBlock, 1, Number.MAX_SAFE_INTEGER) ||
    typeof value.originCatalogVersion !== 'string' || !VERSION.test(value.originCatalogVersion) ||
    Number(value.originCatalogVersion.slice(6)) > Number(value.predecessor.catalogVersion.slice(6)) || !integer(value.ordinaryCount, 0, 2000))) throw new Error('Invalid mixed allocation identity or ordinary rewards.');
  const categories = ['painting', 'animated', ...(v2 ? ['video', '3d'] : [])];
  const lastIds: Record<string, number> = {};
  const labels = new Set<string>();
  const pools = new Map<string, { size: number; ownerCount: number }>();
  for (const [index, group] of value.groups.entries()) {
    const pooled = v2 && typeof group === 'object' && group !== null && 'pool' in group;
    if (!record(group, ['category', 'collectionBlock', 'firstId', 'lastId', 'ownerCount', ...(pooled ? ['pool'] : [])]) ||
      typeof group.category !== 'string' || !categories.includes(group.category) ||
      typeof group.collectionBlock !== 'string' || !group.collectionBlock.trim() || !v2 && labels.has(group.collectionBlock) ||
      !integer(group.firstId, (lastIds[group.category] ?? 0) + 1, 111_111) || !integer(group.lastId, group.firstId, 111_111) ||
      !integer(group.ownerCount, 0, pooled ? 111_111 : group.lastId - group.firstId + 1) ||
      pooled && (typeof group.pool !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(group.pool))) throw new Error('Invalid mixed allocation group.');
    const size = group.lastId - group.firstId + 1;
    if (!v2 && group.category === 'animated' && size !== group.ownerCount) throw new Error('Owner supplement animations must all be reserved.');
    const key = pooled ? String(group.pool) : ':' + index;
    const prior = pools.get(key);
    if (prior && group.ownerCount !== 0) throw new Error('A pooled quota must be specified only once.');
    pools.set(key, { size: (prior?.size ?? 0) + size, ownerCount: prior?.ownerCount ?? group.ownerCount });
    lastIds[group.category] = group.lastId;
    labels.add(group.collectionBlock);
  }
  const definition = value as unknown as MixedAllocationDefinition;
  const { readyCount, totalCount, futureCount } = mixedAllocationCounts(definition);
  const sameCatalog = definition.predecessor.catalogVersion === definition.target.catalogVersion &&
    definition.predecessor.manifestSha256 === definition.target.manifestSha256;
  if ([...pools.values()].some(pool => pool.size < pool.ownerCount) || totalCount > 111_111 ||
    (!v2 && (!readyCount || !futureCount)) || v2 && (!readyCount && !totalCount || readyCount > 2000) ||
    (totalCount ? Number(definition.target.catalogVersion.slice(6)) <= Number(definition.predecessor.catalogVersion.slice(6)) : !sameCatalog)) throw new Error('Invalid mixed allocation totals or target.');
}

export function mixedReleaseBlockHash(blocks: RevealCollectionBlocks, target: RevealAssetCatalogDescriptor): string {
  const binding = blocks.catalogs.find(catalog => catalog.catalogVersion === target.catalogVersion && catalog.manifestSha256 === target.manifestSha256);
  if (!binding) throw new Error('Mixed release collection block binding is missing.');
  const ranges = Object.fromEntries((['painting', 'video', '3d', 'animated'] as const).map(category => {
    const selected: Array<[number, string]> = [];
    const count = binding.counts[category];
    if (count) for (const [end, label] of blocks.ranges[category]) {
      selected.push([Math.min(end, count), label]);
      if (end >= count) break;
    }
    return [category, selected];
  }));
  return mixedAllocationHash({ binding, ranges });
}

export function validateMixedAllocationRelease(definition: MixedAllocationDefinition, predecessor: RevealAssetCatalog, target: RevealAssetCatalog,
  blocks: unknown, supplement: unknown): void {
  validateMixedAllocationDefinition(definition);
  if (definition.version === 2) {
    validateRevealAssetCatalog(predecessor, definition.predecessor);
    validateRevealAssetCatalog(target, definition.target);
    if (definition.ordinaryCount > predecessor.importSettings.availableEggs - predecessor.categories.eggs.count) {
      throw new Error('Insufficient fresh egg media in the predecessor catalog.');
    }
    validateRevealCollectionBlocks(blocks);
    validateOwnerHatchingCatalog(supplement);
    const lookup = selectRevealCollectionBlocks(blocks, definition.target);
    const ownerPrefix = supplement.batches.some((_, index) =>
      mixedAllocationHash({ ...supplement, batches: supplement.batches.slice(0, index + 1) }) === definition.ownerSupplementSha256);
    if (!lookup || !ownerPrefix || mixedReleaseBlockHash(blocks, definition.target) !== definition.collectionBlocksSha256) throw new Error('Mixed allocation supplements do not match the release.');
    const additions = definition.groups.length ? revealCatalogAdditions(predecessor, target) : [];
    const remaining = new Set(additions.map(asset => asset.category + '/' + asset.assetId));
    for (const group of definition.groups) {
      for (let id = group.firstId; id <= group.lastId; id++) {
        if (!remaining.delete(group.category + '/' + id) || lookupRevealCollectionBlock(lookup, group.category, id) !== group.collectionBlock) {
          throw new Error('Mixed allocation group does not match new catalog artworks.');
        }
      }
    }
    if (remaining.size) throw new Error('Mixed allocation does not cover every new artwork.');
    return;
  }
  if (definition.predecessor.manifestSha256 === MIXED_ALLOCATION_PREDECESSOR.manifestSha256 &&
    (definition.groups.length !== MIXED_ALLOCATION_GROUPS.length || MIXED_ALLOCATION_GROUPS.some((expected, index) => {
      const actual = definition.groups[index];
      return actual.category !== expected.category || actual.collectionBlock !== expected.collectionBlock ||
        actual.firstId !== expected.firstId || actual.lastId !== expected.lastId || actual.ownerCount !== expected.ownerCount;
    }))) throw new Error('Mixed allocation groups differ from the reviewed split.');
  validateRevealAssetCatalog(predecessor, definition.predecessor);
  validateRevealAssetCatalog(target, definition.target);
  validateRevealCollectionBlocks(blocks);
  validateOwnerHatchingCatalog(supplement);
  if (definition.predecessor.manifestSha256 === MIXED_ALLOCATION_PREDECESSOR.manifestSha256 &&
    mixedAllocationHash({ ...supplement, batches: supplement.batches.slice(0, -1) }) !== MIXED_OWNER_PREDECESSOR_SHA256) {
    throw new Error('Mixed allocation changed a previous owner-hatching batch.');
  }
  const lookup = selectRevealCollectionBlocks(blocks, definition.target);
  const batch = supplement.batches.at(-1)!;
  if (batch.allocation !== 'mixed' || batch.target?.catalogVersion !== definition.target.catalogVersion || batch.target.manifestSha256 !== definition.target.manifestSha256 ||
    mixedAllocationHash(blocks) !== definition.collectionBlocksSha256 || blocks.source.sha256 !== target.source.sha256 || !lookup ||
    mixedAllocationHash(supplement) !== definition.ownerSupplementSha256 || batch.source.sha256 !== definition.sourceSha256 ||
    batch.predecessor.catalogVersion !== definition.predecessor.catalogVersion || batch.predecessor.manifestSha256 !== definition.predecessor.manifestSha256) {
    throw new Error('Mixed allocation supplements do not match the release.');
  }
  const ordinary = revealCatalogAdditions(predecessor, target);
  if (ordinary.some(asset => asset.category !== 'painting')) throw new Error('Mixed ordinary additions must be paintings.');
  const paintings = new Set(ordinary.map(asset => asset.assetId));
  const animations = new Map(batch.artworks.map(asset => [asset.assetId, asset]));
  for (const group of definition.groups) {
    for (let id = group.firstId; id <= group.lastId; id++) {
      if (group.category === 'painting') {
        if (!paintings.delete(id) || lookupRevealCollectionBlock(lookup, 'painting', id) !== group.collectionBlock) {
          throw new Error('Mixed painting group does not match new catalog artworks.');
        }
      } else {
        const asset = animations.get(id);
        if (!asset || asset.animationExtension !== 'mp4' || asset.collectionBlock !== group.collectionBlock || id <= target.categories.animated.count) {
          throw new Error('Mixed animation group does not match new owner artworks.');
        }
        animations.delete(id);
      }
    }
  }
  if (paintings.size || animations.size) throw new Error('Mixed allocation does not cover every new artwork.');
}

export function drawMixedAllocation(definition: MixedAllocationDefinition, choose: (maximum: number) => number): {
  owner: MixedAllocationArtwork[]; future: MixedAllocationArtwork[];
} {
  validateMixedAllocationDefinition(definition);
  const owner: MixedAllocationArtwork[] = [];
  const future: MixedAllocationArtwork[] = [];
  const pools = new Map<string, { artworks: MixedAllocationArtwork[]; ownerCount: number }>();
  for (const [index, group] of definition.groups.entries()) {
    const key = group.pool ?? ':' + index;
    const pool = pools.get(key) ?? { artworks: [], ownerCount: group.ownerCount };
    for (let id = group.firstId; id <= group.lastId; id++) pool.artworks.push({ category: group.category, assetId: id });
    pools.set(key, pool);
  }
  for (const { artworks, ownerCount } of pools.values()) {
    if (ownerCount < artworks.length) {
      for (let i = 0; i < ownerCount; i++) {
        const offset = choose(artworks.length - i);
        if (!integer(offset, 0, artworks.length - i - 1)) throw new Error('Invalid mixed allocation draw.');
        const other = i + offset;
        [artworks[i], artworks[other]] = [artworks[other], artworks[i]];
      }
    }
    for (const [index, asset] of artworks.entries()) (index < ownerCount ? owner : future).push(asset);
  }
  return { owner, future };
}
