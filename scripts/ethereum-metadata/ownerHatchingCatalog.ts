import relicEvidence from '../../releases/111k-relic-images-2026-11-11/preflight.json';
import supplement from '../../shared/ethereum/ownerHatchingCatalog.json';

export type ArtworkSource = Record<string, [number, number, string?]>;
const ownerArtworks = new Map(supplement.batches.flatMap(batch => batch.artworks.map(artwork => [artwork.assetId, artwork] as const)));

export function readArtworkSource(bytes: string): ArtworkSource {
  const source: unknown = JSON.parse(bytes);
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Artwork source must be an object.');
  const paths = [...bytes.matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map(match => JSON.parse(match[1]) as string);
  if (new Set(paths).size !== paths.length) throw new Error('Artwork source contains duplicate paths.');
  for (const [path, entry] of Object.entries(source)) {
    if (!Array.isArray(entry) || ![2, 3].includes(entry.length) || entry.slice(0, 2).some(value => !Number.isSafeInteger(value) || value < 1) ||
      entry.length === 3 && (typeof entry[2] !== 'string' || !entry[2].trim())) throw new Error(`Invalid artwork source entry: ${path}`);
  }
  return source as ArtworkSource;
}

export function removeCatalogRelics(source: ArtworkSource, requireAll = false): number {
  let removed = 0;
  for (const relic of relicEvidence.checks) {
    if (relic.kind !== 'canonical') continue;
    const path = `relics/${relic.id}.png`;
    if (!requireAll && !Object.hasOwn(source, path)) continue;
    const entry = source[path];
    if (!entry || entry.length !== 2 || entry[0] !== relic.width || entry[1] !== relic.height) {
      throw new Error(`Catalog source changed or removed ${path}.`);
    }
    delete source[path];
    removed++;
  }
  return removed;
}

export function ordinaryRevealCatalogSource(bytes: string): string {
  const source = readArtworkSource(bytes);
  let removed = removeCatalogRelics(source) > 0;
  for (const [path, value] of Object.entries(source)) {
    const match = /^animated\/([1-9]\d*)\.(png|gif|mp4)$/.exec(path);
    if (!match) continue;
    const artwork = ownerArtworks.get(Number(match[1]));
    if (!artwork) continue;
    const matchesMedia = match[2] === 'png' ? value[0] === artwork.width && value[1] === artwork.height :
      match[2] === artwork.animationExtension && value[0] * artwork.height === value[1] * artwork.width;
    if (!matchesMedia || value[2] !== undefined && value[2] !== artwork.collectionBlock) {
      throw new Error(`Existing owner hatching artwork changed: ${path}`);
    }
    delete source[path];
    removed = true;
  }
  return removed ? `${JSON.stringify(source, null, 2)}\n` : bytes;
}
