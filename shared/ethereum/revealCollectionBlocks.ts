import type { EthereumArtworkCategory } from './reveal.ts';
import { revealCatalogAssetOrdinal, type RevealAssetCatalogDescriptor } from './revealAssetCatalog.ts';

export type RevealCollectionBlockCategory = Exclude<EthereumArtworkCategory, 'egg'>;
export type RevealCollectionBlockRanges = Record<RevealCollectionBlockCategory, readonly (readonly [number, string])[]>;
export type RevealCollectionBlockCounts = Record<RevealCollectionBlockCategory, number>;
export type RevealCollectionBlocks = {
  version: 1;
  source: { filename: '111k.json'; sha256: string };
  catalogs: readonly (RevealAssetCatalogDescriptor & { counts: RevealCollectionBlockCounts; animatedAssetIds?: readonly number[] })[];
  ranges: RevealCollectionBlockRanges;
};
export type RevealCollectionBlockLookup = { ranges: RevealCollectionBlockRanges; counts: RevealCollectionBlockCounts; animatedAssetIds?: readonly number[] };

const CATEGORIES = ['painting', 'video', '3d', 'animated'] as const;
const SHA256 = /^[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function invalid(): never { throw new Error('Invalid reveal collection blocks.'); }

export function validateRevealCollectionBlocks(value: unknown): asserts value is RevealCollectionBlocks {
  if (!record(value) || !keys(value, ['version', 'source', 'catalogs', 'ranges']) || value.version !== 1 ||
    !record(value.source) || !keys(value.source, ['filename', 'sha256']) || value.source.filename !== '111k.json' ||
    typeof value.source.sha256 !== 'string' || !SHA256.test(value.source.sha256) ||
    !Array.isArray(value.catalogs) || !value.catalogs.length || !record(value.ranges) || !keys(value.ranges, CATEGORIES)) invalid();
  for (const category of CATEGORIES) {
    const ranges = value.ranges[category];
    if (!Array.isArray(ranges)) invalid();
    let lastId = 0;
    let previousLabel: string | undefined;
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0]) ||
        range[0] <= lastId || range[0] > 111_111 || typeof range[1] !== 'string' || !range[1].trim() || range[1] === previousLabel) invalid();
      lastId = range[0];
      previousLabel = range[1];
    }
  }
  const versions = new Set<string>();
  for (const catalog of value.catalogs) {
    if (!record(catalog) || !keys(catalog, ['catalogVersion', 'manifestSha256', 'counts', ...(Object.hasOwn(catalog, 'animatedAssetIds') ? ['animatedAssetIds'] : [])]) ||
      typeof catalog.catalogVersion !== 'string' || !/^111k-v[1-9]\d{0,8}$/.test(catalog.catalogVersion) || versions.has(catalog.catalogVersion) ||
      typeof catalog.manifestSha256 !== 'string' || !SHA256.test(catalog.manifestSha256) ||
      !record(catalog.counts) || !keys(catalog.counts, CATEGORIES)) invalid();
    const ids = catalog.animatedAssetIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length !== catalog.counts.animated || ids.some((id, index) =>
      !Number.isSafeInteger(id) || id < 1 || id > 111_111 || index > 0 && id <= ids[index - 1]))) invalid();
    versions.add(catalog.catalogVersion);
    for (const category of CATEGORIES) {
      const count = catalog.counts[category];
      const ranges = value.ranges[category] as Array<[number, string]>;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > (ranges.at(-1)?.[0] ?? 0)) invalid();
    }
  }
}

export function selectRevealCollectionBlocks(value: RevealCollectionBlocks,
  descriptor: RevealAssetCatalogDescriptor | null | undefined): RevealCollectionBlockLookup | null {
  if (!descriptor) return null;
  const catalog = value.catalogs.find(entry => entry.catalogVersion === descriptor.catalogVersion && entry.manifestSha256 === descriptor.manifestSha256);
  return catalog ? { ranges: value.ranges, counts: catalog.counts, ...(catalog.animatedAssetIds ? { animatedAssetIds: catalog.animatedAssetIds } : {}) } : null;
}

export function lookupRevealCollectionBlock(lookup: RevealCollectionBlockLookup | null, category: EthereumArtworkCategory, assetId: number): string | null {
  if (!lookup || category === 'egg') return null;
  const ordinal = revealCatalogAssetOrdinal({ count: lookup.counts[category], assetIds: category === 'animated' ? lookup.animatedAssetIds : undefined }, assetId);
  if (!ordinal) return null;
  const ranges = lookup.ranges[category];
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle][0] < ordinal) low = middle + 1;
    else high = middle;
  }
  return ranges[low]?.[1] ?? null;
}
