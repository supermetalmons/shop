import { createHash } from 'node:crypto';
import { validateOwnerHatchingCatalog, type OwnerHatchingCatalog } from '../../shared/ethereum/ownerHatchingCatalog.ts';
import type { RevealAssetCatalogDescriptor } from '../../shared/ethereum/revealAssetCatalog.ts';

type Source = Record<string, [number, number, string?]>;

function readSource(bytes: string): Source {
  const source: unknown = JSON.parse(bytes);
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Artwork source must be an object.');
  const paths = [...bytes.matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map(match => JSON.parse(match[1]) as string);
  if (new Set(paths).size !== paths.length) throw new Error('Artwork source contains duplicate paths.');
  for (const [path, entry] of Object.entries(source)) {
    if (!Array.isArray(entry) || ![2, 3].includes(entry.length) || entry.slice(0, 2).some(value => !Number.isSafeInteger(value) || value < 1) ||
      entry.length === 3 && (typeof entry[2] !== 'string' || !entry[2].trim())) throw new Error(`Invalid artwork source entry: ${path}`);
  }
  return source as Source;
}

export function appendOwnerHatchingCatalogBatch(input: {
  source: string;
  predecessorSource: string;
  predecessor: RevealAssetCatalogDescriptor;
  batchId: string;
  animationExtension: 'gif' | 'mp4';
  previous?: OwnerHatchingCatalog;
}): OwnerHatchingCatalog {
  const source = readSource(input.source);
  const predecessor = readSource(input.predecessorSource);
  if (input.previous) validateOwnerHatchingCatalog(input.previous);
  const existing = new Set<number>();
  for (const batch of input.previous?.batches ?? []) for (const artwork of batch.artworks) {
    existing.add(artwork.assetId);
    const value = source[`animated/${artwork.assetId}.png`];
    if (!value || value[0] !== artwork.width || value[1] !== artwork.height || value[2] !== artwork.collectionBlock) {
      throw new Error('Owner hatching catalog additions cannot change existing artworks.');
    }
  }
  for (const [path, value] of Object.entries(predecessor)) {
    const next = source[path];
    if (!next || value[0] !== next[0] || value[1] !== next[1] || value[2] !== undefined && value[2] !== next[2]) {
      throw new Error(`Owner hatching source changed an existing artwork: ${path}`);
    }
  }
  const artworks: OwnerHatchingCatalog['batches'][number]['artworks'] = [];
  for (const [path, value] of Object.entries(source)) {
    if (Object.hasOwn(predecessor, path) || /^relics\/([1-9]|1[0-8])\.png$/.test(path)) continue;
    const match = /^animated\/([1-9]\d*)\.png$/.exec(path);
    if (!match) throw new Error(`Unexpected artwork outside the owner hatching additions: ${path}`);
    const assetId = Number(match[1]);
    if (existing.has(assetId)) continue;
    if (!value[2]) throw new Error(`New artwork requires a collection block: ${path}`);
    artworks.push({ assetId, width: value[0], height: value[1], collectionBlock: value[2], animationExtension: input.animationExtension });
  }
  artworks.sort((first, second) => first.assetId - second.assetId);
  const catalog: OwnerHatchingCatalog = { version: 1, baseUrl: 'https://cdn.lil.org/nft/111k/', batches: [
    ...structuredClone(input.previous?.batches ?? []),
    { id: input.batchId, source: { filename: '111k.json', sha256: createHash('sha256').update(input.source).digest('hex') },
      predecessor: { ...input.predecessor }, artworks },
  ] };
  validateOwnerHatchingCatalog(catalog, input.previous);
  return catalog;
}
