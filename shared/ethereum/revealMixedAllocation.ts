import { MIXED_ALLOCATION_GROUPS, MIXED_ALLOCATION_PREDECESSOR, MIXED_OWNER_PREDECESSOR_SHA256 } from './mixedAllocation20261117.ts';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { validateOwnerHatchingCatalog } from './ownerHatchingCatalog.ts';
import { validateRevealAssetCatalog, type RevealAssetCatalog, type RevealAssetCatalogDescriptor } from './revealAssetCatalog.ts';
import { revealCatalogAdditions } from './revealCatalogUpdate.ts';
import { lookupRevealCollectionBlock, selectRevealCollectionBlocks, validateRevealCollectionBlocks } from './revealCollectionBlocks.ts';

export type MixedAllocationArtwork = { category: 'painting' | 'animated'; assetId: number };
export type MixedAllocationGroup = {
  category: MixedAllocationArtwork['category']; collectionBlock: string; firstId: number; lastId: number; ownerCount: number;
};
export type MixedAllocationDefinition = {
  version: 1; sourceSha256: string; predecessor: RevealAssetCatalogDescriptor; target: RevealAssetCatalogDescriptor;
  collectionBlocksSha256: string; ownerSupplementSha256: string; groups: MixedAllocationGroup[];
};

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
  if (!record(value, ['version', 'sourceSha256', 'predecessor', 'target', 'ownerSupplementSha256', 'collectionBlocksSha256', 'groups']) ||
    value.version !== 1 || ![value.sourceSha256, value.ownerSupplementSha256, value.collectionBlocksSha256].every(hash => typeof hash === 'string' && SHA256.test(hash)) ||
    !descriptor(value.predecessor) || !descriptor(value.target) || Number(value.target.catalogVersion.slice(6)) <= Number(value.predecessor.catalogVersion.slice(6)) ||
    !Array.isArray(value.groups) || value.groups.length === 0) throw new Error('Invalid mixed allocation definition.');
  const lastIds = { painting: 0, animated: 0 };
  const labels = new Set<string>();
  let ready = 0;
  let total = 0;
  for (const group of value.groups) {
    if (!record(group, ['category', 'collectionBlock', 'firstId', 'lastId', 'ownerCount']) || group.category !== 'painting' && group.category !== 'animated' ||
      typeof group.collectionBlock !== 'string' || !group.collectionBlock.trim() || labels.has(group.collectionBlock) ||
      !integer(group.firstId, lastIds[group.category] + 1, 111_111) || !integer(group.lastId, group.firstId, 111_111) ||
      !integer(group.ownerCount, 0, group.lastId - group.firstId + 1)) throw new Error('Invalid mixed allocation group.');
    const count = group.lastId - group.firstId + 1;
    if (group.category === 'animated' && count !== group.ownerCount) throw new Error('Owner supplement animations must all be reserved.');
    labels.add(group.collectionBlock);
    lastIds[group.category] = group.lastId;
    ready += group.ownerCount;
    total += count;
  }
  if (ready === 0 || ready === total || total > 111_111) throw new Error('Invalid mixed allocation totals.');
}

export function validateMixedAllocationRelease(definition: MixedAllocationDefinition, predecessor: RevealAssetCatalog, target: RevealAssetCatalog,
  blocks: unknown, supplement: unknown): void {
  validateMixedAllocationDefinition(definition);
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
  for (const group of definition.groups) {
    const ids = Array.from({ length: group.lastId - group.firstId + 1 }, (_, index) => group.firstId + index);
    if (group.ownerCount < ids.length) {
      for (let i = 0; i < group.ownerCount; i++) {
        const offset = choose(ids.length - i);
        if (!integer(offset, 0, ids.length - i - 1)) throw new Error('Invalid mixed allocation draw.');
        const other = i + offset;
        [ids[i], ids[other]] = [ids[other], ids[i]];
      }
    }
    for (let i = 0; i < ids.length; i++) (i < group.ownerCount ? owner : future).push({ category: group.category, assetId: ids[i] });
  }
  return { owner, future };
}
