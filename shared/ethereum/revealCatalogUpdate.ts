import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { REVEAL_ASSET_FAMILIES, revealCatalogMedia, validateRevealAssetCatalog,
  type RevealAssetCatalog, type RevealAssetCatalogDescriptor, type RevealAssetVariant } from './revealAssetCatalog.ts';
import type { EthereumArtworkCategory } from './reveal.ts';

export type RevealCatalogAddition = { category: Exclude<EthereumArtworkCategory, 'egg'>; assetId: number };
export type RevealCatalogUpdateMapping = RevealCatalogAddition & { eggId: number };
export type RevealCatalogUpdateBatch = {
  version: 1;
  nonce: string;
  batchId: string;
  batchSha256: string;
  predecessor: { manifest: RevealAssetCatalog; descriptor: RevealAssetCatalogDescriptor };
  target: { manifest: RevealAssetCatalog; descriptor: RevealAssetCatalogDescriptor };
  mappings: RevealCatalogUpdateMapping[];
};
export type RevealCatalogUpdateBody = Omit<RevealCatalogUpdateBatch, 'batchId' | 'batchSha256'>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function invalid(reason: string): never { throw new Error(`Invalid reveal catalog update: ${reason}.`); }

function alternate(variant: RevealAssetVariant | undefined, id: number): string | null {
  if (!variant) return null;
  let index = id - 1;
  if (variant.assetIds) {
    let low = 0;
    let high = variant.assetIds.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (variant.assetIds[middle] < id) low = middle + 1;
      else high = middle;
    }
    index = variant.assetIds[low] === id ? low : -1;
  }
  if (index < 0) return null;
  return JSON.stringify([variant.pathTemplate, variant.aspectRatio ?? variant.aspectRatioPalette[variant.aspectRatioIndexById[index]]]);
}

export function revealCatalogAdditions(predecessor: RevealAssetCatalog, target: RevealAssetCatalog): RevealCatalogAddition[] {
  validateRevealAssetCatalog(predecessor);
  validateRevealAssetCatalog(target);
  if (Number(target.catalogVersion.slice(6)) <= Number(predecessor.catalogVersion.slice(6)) ||
    predecessor.dropId !== target.dropId || predecessor.baseUrl !== target.baseUrl ||
    JSON.stringify(predecessor.importSettings) !== JSON.stringify(target.importSettings) ||
    JSON.stringify(predecessor.categories.receipts) !== JSON.stringify(target.categories.receipts)) invalid('catalog identity or settings changed');
  const additions: RevealCatalogAddition[] = [];
  for (const category of ['painting', 'video', '3d', 'animated'] as const) {
    const family = REVEAL_ASSET_FAMILIES[category];
    const before = predecessor.categories[family];
    const after = target.categories[family];
    if (after.count < before.count || before.pathTemplate !== after.pathTemplate ||
      before.imagePathTemplate !== after.imagePathTemplate || before.baseUrl !== after.baseUrl) invalid('existing artwork changed');
    for (let id = 1; id <= before.count; id++) {
      if (JSON.stringify(revealCatalogMedia(predecessor, category, id)) !== JSON.stringify(revealCatalogMedia(target, category, id))) {
        invalid('existing artwork media changed');
      }
      const oldAlternate = alternate(before.variants?.alt, id);
      if (oldAlternate !== null && oldAlternate !== alternate(after.variants?.alt, id)) invalid('existing alternate changed');
    }
    for (let id = before.count + 1; id <= after.count; id++) additions.push({ category, assetId: id });
  }
  const oldEggs = predecessor.categories.eggs;
  const newEggs = target.categories.eggs;
  if (!additions.length || oldEggs.count - newEggs.count !== additions.length ||
    JSON.stringify({ ...oldEggs, count: newEggs.count }) !== JSON.stringify(newEggs)) invalid('egg cutoff does not match new artworks');
  return additions;
}

export function revealCatalogUpdateHash(value: RevealCatalogUpdateBody): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify({ version: value.version,
    nonce: value.nonce, predecessor: value.predecessor, target: value.target, mappings: value.mappings }))));
}

export function validateRevealCatalogUpdateBatch(value: unknown): asserts value is RevealCatalogUpdateBatch {
  if (!record(value) || !keys(value, ['version', 'nonce', 'batchId', 'batchSha256', 'predecessor', 'target', 'mappings']) || value.version !== 1 ||
    typeof value.nonce !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.nonce) ||
    typeof value.batchId !== 'string' || typeof value.batchSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.batchSha256) ||
    value.batchId !== `catalog-${value.batchSha256.slice(0, 32)}` || !Array.isArray(value.mappings)) invalid('invalid batch shape');
  for (const name of ['predecessor', 'target'] as const) {
    const catalog = value[name];
    if (!record(catalog) || !keys(catalog, ['manifest', 'descriptor'])) invalid('invalid catalog snapshot');
    validateRevealAssetCatalog(catalog.manifest, catalog.descriptor);
  }
  const batch = value as unknown as RevealCatalogUpdateBatch;
  const additions = revealCatalogAdditions(batch.predecessor.manifest, batch.target.manifest);
  if (batch.mappings.length !== additions.length) invalid('mapping does not cover every cutoff egg');
  const remaining = new Set(additions.map(row => `${row.category}:${row.assetId}`));
  for (const [index, row] of batch.mappings.entries()) {
    if (!record(row) || !keys(row, ['eggId', 'category', 'assetId']) ||
      row.eggId !== batch.target.manifest.categories.eggs.count + index + 1 ||
      !remaining.delete(`${row.category}:${row.assetId}`)) invalid('mapping must be a complete bijection to new artworks');
  }
  if (remaining.size || revealCatalogUpdateHash(batch) !== batch.batchSha256) invalid('batch checksum mismatch');
}
