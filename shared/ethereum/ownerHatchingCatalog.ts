import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import supplement from './ownerHatchingCatalog.json';
import type { EthereumArtworkCategory } from './reveal.ts';

export type OwnerHatchingGrail = {
  category: 'animated';
  assetId: number;
  image: string;
  animation_url: string;
  aspectRatio: { width: number; height: number };
  collectionBlock: string;
};

export type OwnerHatchingCatalog = {
  version: 1;
  baseUrl: string;
  batches: Array<{
    id: string;
    source: { filename: '111k.json'; sha256: string };
    predecessor: { catalogVersion: string; manifestSha256: string };
    artworks: Array<{ assetId: number; width: number; height: number; collectionBlock: string; animationExtension: 'gif' | 'mp4' }>;
  }>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function validateOwnerHatchingCatalog(value: unknown, previous?: OwnerHatchingCatalog): asserts value is OwnerHatchingCatalog {
  const invalid = () => { throw new Error('Invalid owner hatching catalog.'); };
  if (!record(value) || !keys(value, ['version', 'baseUrl', 'batches']) || value.version !== 1 ||
    value.baseUrl !== 'https://cdn.lil.org/nft/111k/' || !Array.isArray(value.batches) || !value.batches.length) invalid();
  const catalog = value as OwnerHatchingCatalog;
  const batches = new Set<string>();
  const assets = new Set<number>();
  for (const batch of catalog.batches) {
    if (!record(batch) || !keys(batch, ['id', 'source', 'predecessor', 'artworks']) ||
      typeof batch.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(batch.id) || batches.has(batch.id) ||
      !record(batch.source) || !keys(batch.source, ['filename', 'sha256']) || batch.source.filename !== '111k.json' ||
      typeof batch.source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(batch.source.sha256) ||
      !record(batch.predecessor) || !keys(batch.predecessor, ['catalogVersion', 'manifestSha256']) ||
      typeof batch.predecessor.catalogVersion !== 'string' || !/^111k-v[1-9]\d{0,8}$/.test(batch.predecessor.catalogVersion) ||
      typeof batch.predecessor.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(batch.predecessor.manifestSha256) ||
      !Array.isArray(batch.artworks) || !batch.artworks.length) invalid();
    batches.add(batch.id);
    let lastId = 0;
    for (const artwork of batch.artworks) {
      if (!record(artwork) || !keys(artwork, ['assetId', 'width', 'height', 'collectionBlock', 'animationExtension']) ||
        !positive(artwork.assetId) || artwork.assetId <= lastId || assets.has(artwork.assetId) ||
        !positive(artwork.width) || !positive(artwork.height) || typeof artwork.collectionBlock !== 'string' ||
        !artwork.collectionBlock.trim() || !['gif', 'mp4'].includes(artwork.animationExtension)) invalid();
      assets.add(artwork.assetId);
      lastId = artwork.assetId;
    }
  }
  if (previous) {
    validateOwnerHatchingCatalog(previous);
    if (catalog.batches.length < previous.batches.length || previous.batches.some((batch, index) =>
      JSON.stringify(batch) !== JSON.stringify(catalog.batches[index]))) {
      throw new Error('Owner hatching catalog additions cannot change existing batches.');
    }
  }
}

function reduceRatio(width: number, height: number): { width: number; height: number } {
  let divisor = width;
  let remainder = height;
  while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
  return { width: width / divisor, height: height / divisor };
}

validateOwnerHatchingCatalog(supplement);

const grails: readonly OwnerHatchingGrail[] = Object.freeze(supplement.batches.flatMap(batch => batch.artworks.map(artwork => Object.freeze({
  category: 'animated' as const,
  assetId: artwork.assetId,
  image: `${supplement.baseUrl}animated/${artwork.assetId}.png`,
  animation_url: `${supplement.baseUrl}animated/${artwork.assetId}.${artwork.animationExtension}`,
  aspectRatio: Object.freeze(reduceRatio(artwork.width, artwork.height)),
  collectionBlock: artwork.collectionBlock,
}))));
const byId = new Map(grails.map(grail => [grail.assetId, grail]));

export const ownerHatchingCatalogSha256 = bytesToHex(sha256(JSON.stringify(supplement)));

export function getOwnerHatchingGrails(): readonly OwnerHatchingGrail[] {
  return grails;
}

export function getOwnerHatchingGrail(category: EthereumArtworkCategory, assetId: number): OwnerHatchingGrail | undefined {
  return category === 'animated' ? byId.get(assetId) : undefined;
}
