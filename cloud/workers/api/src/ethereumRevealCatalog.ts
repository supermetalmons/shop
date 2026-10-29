import catalog from '../../../../scripts/ethereum-metadata/reveal-assets/111k_devnet/manifest.json';
import type { EthereumArtworkCategory, EthereumRevealedArtwork, EthereumRevealObservation } from '../../../../shared/ethereum/reveal.js';

export const REVEAL_CATEGORY_COUNTS = { egg: 22_222, painting: 85_556, video: 3_333 } as const;
export const REVEAL_ARTWORK_COUNT = 111_111;
export const REVEAL_CATEGORIES = ['egg', 'painting', 'video'] as const;

export function revealCrateSize(crateTokenId: string): number {
  const id = Number(crateTokenId);
  if (!Number.isSafeInteger(id) || id < 111_112 || id > 116_666 || String(id) !== crateTokenId) {
    throw new Error('Invalid reveal crate token.');
  }
  return id === 116_666 ? 31 : 20;
}

export function validateRevealCatalog(): void {
  if (catalog.artworkCount !== REVEAL_ARTWORK_COUNT || catalog.baseUrl !== 'https://wip.lil.org/111k/' ||
    catalog.categories.eggs.count !== REVEAL_CATEGORY_COUNTS.egg ||
    catalog.categories.paintings.count !== REVEAL_CATEGORY_COUNTS.painting ||
    catalog.categories.videos.count !== REVEAL_CATEGORY_COUNTS.video ||
    catalog.categories.paintings.aspectRatioIndexById.length !== REVEAL_CATEGORY_COUNTS.painting ||
    catalog.categories.paintings.aspectRatioIndexById.some(index => !Number.isInteger(index) || index < 0 ||
      index >= catalog.categories.paintings.aspectRatioPalette.length) ||
    catalog.categories.paintings.aspectRatioPalette.some(pair => pair.length !== 2 ||
      pair.some(value => !Number.isSafeInteger(value) || value <= 0))) throw new Error('Invalid reveal asset catalog.');
}

function revealAssetMedia(category: EthereumArtworkCategory, assetId: number) {
  if (!Number.isInteger(assetId) || assetId < 1 || assetId > REVEAL_CATEGORY_COUNTS[category]) throw new Error('Invalid reveal asset.');
  const pair = category === 'painting'
    ? catalog.categories.paintings.aspectRatioPalette[catalog.categories.paintings.aspectRatioIndexById[assetId - 1]]
    : category === 'egg' ? catalog.categories.eggs.aspectRatio : catalog.categories.videos.aspectRatio;
  const directory = category === 'egg' ? 'eggs' : category === 'painting' ? 'paintings' : 'videos';
  return {
    image: `${catalog.baseUrl}${directory}/${assetId}.webp`,
    ...(category === 'video' ? { animation_url: `${catalog.baseUrl}videos/${assetId}.mp4` } : {}),
    aspectRatio: { width: pair[0], height: pair[1] },
  };
}

export function buildRevealedArtwork(input: {
  templateJson: string; tokenId: string; crateTokenId: string; category: EthereumArtworkCategory;
  assetId: number; observation: EthereumRevealObservation;
}): { artwork: EthereumRevealedArtwork; metadataJson: string; placeholderJson: string } {
  const template = JSON.parse(input.templateJson.replaceAll('{{tokenId}}', input.tokenId).replaceAll('{{displayId}}', input.tokenId)) as {
    name: string; description?: string; image: string; attributes?: Array<{ trait_type: string; value: string | number }>;
  };
  const media = revealAssetMedia(input.category, input.assetId);
  const attributes = [...(template.attributes || []).filter(attribute => attribute.trait_type !== 'type'),
    { trait_type: 'type', value: input.category }];
  const metadata = { ...template, ...media, attributes, category: input.category, revealStatus: 'revealed' as const };
  return {
    artwork: { tokenId: input.tokenId, crateTokenId: input.crateTokenId, category: input.category,
      name: template.name, ...(template.description !== undefined ? { description: template.description } : {}),
      ...media, attributes, observation: input.observation },
    metadataJson: `${JSON.stringify(metadata, null, 2)}\n`,
    placeholderJson: `${JSON.stringify(template, null, 2)}\n`,
  };
}

export function revealRandomInteger(maximum: number): number {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 0x1_0000_0000) throw new Error('Invalid random range.');
  const ceiling = Math.floor(0x1_0000_0000 / maximum) * maximum;
  const bytes = new Uint32Array(1);
  do { crypto.getRandomValues(bytes); } while (bytes[0] >= ceiling);
  return bytes[0] % maximum;
}
