import catalog from '../../../../scripts/ethereum-metadata/reveal-assets/111k_devnet/manifest.json';
import descriptor from '../../../../shared/ethereum/revealCatalog.json';
import { revealCatalogMedia, validateRevealAssetCatalog, type RevealAssetCatalog, type RevealAssetCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.js';
import type { EthereumArtworkCategory, EthereumRevealedArtwork, EthereumRevealObservation } from '../../../../shared/ethereum/reveal.js';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { getOwnerHatchingGrail } from '../../../../shared/ethereum/ownerHatchingCatalog.js';

export function revealCategoryCounts(catalog: { categories: Record<'eggs' | 'paintings' | 'videos' | '3d' | 'animated', { count: number }> }) { return {
  egg: catalog.categories.eggs.count,
  painting: catalog.categories.paintings.count,
  video: catalog.categories.videos.count,
  '3d': catalog.categories['3d'].count,
  animated: catalog.categories.animated.count,
} as const; }
export const REVEAL_CATEGORY_COUNTS = revealCategoryCounts(catalog);

export function revealDeploymentCatalog(deployment: Pick<EthereumRevealDeployment, 'catalogVersion' | 'effectiveCatalogVersion' | 'effectiveCatalogSha256'>): RevealAssetCatalog {
  const catalog = getRevealCatalog(deployment.effectiveCatalogVersion ?? deployment.catalogVersion, deployment.effectiveCatalogSha256 ?? undefined);
  if (!catalog) throw new Error('Reveal catalog is not supported.');
  return catalog;
}

export function isSupportedRevealDeployment(deployment: EthereumRevealDeployment): boolean {
  return Boolean(getRevealCatalog(deployment.effectiveCatalogVersion ?? deployment.catalogVersion, deployment.effectiveCatalogSha256 ?? undefined));
}
export const REVEAL_ARTWORK_COUNT = 111_111;
export const REVEAL_CATEGORIES = ['egg', 'painting', 'video', '3d', 'animated'] as const;
let validatedCatalog: RevealAssetCatalog | undefined;

export function revealCrateSize(crateTokenId: string): number {
  const id = Number(crateTokenId);
  if (!Number.isSafeInteger(id) || id < 111_112 || id > 116_666 || String(id) !== crateTokenId) {
    throw new Error('Invalid reveal crate token.');
  }
  return id === 116_666 ? 31 : 20;
}

export function validateRevealCatalog(): void {
  if (validatedCatalog) return;
  const value: unknown = catalog;
  validateRevealAssetCatalog(value, descriptor satisfies RevealAssetCatalogDescriptor);
  validatedCatalog = value;
}

function revealAssetMedia(category: EthereumArtworkCategory, assetId: number, supplied?: RevealAssetCatalog, ownerHatching = false, allocatedEgg = false) {
  const selected = supplied ?? (validateRevealCatalog(), validatedCatalog!);
  const grail = ownerHatching ? getOwnerHatchingGrail(category, assetId) : undefined;
  if (grail) return { image: grail.image, animation_url: grail.animation_url, aspectRatio: grail.aspectRatio };
  if ((ownerHatching || allocatedEgg) && category === 'egg' && Number.isSafeInteger(assetId) && assetId > selected.categories.eggs.count &&
    assetId <= selected.importSettings.availableEggs) {
    return { image: `${selected.categories.eggs.baseUrl ?? selected.baseUrl}eggs/${assetId}.png`,
      aspectRatio: { width: selected.importSettings.eggAspectRatio[0], height: selected.importSettings.eggAspectRatio[1] } };
  }
  if (supplied) return revealCatalogMedia(supplied, category, assetId);
  validateRevealCatalog();
  return revealCatalogMedia(validatedCatalog!, category, assetId);
}

export function buildRevealedArtwork(input: {
  templateJson: string; tokenId: string; crateTokenId: string; category: EthereumArtworkCategory;
  assetId: number; observation: EthereumRevealObservation;
  catalog?: RevealAssetCatalog;
  ownerHatching?: boolean;
  allocatedEgg?: boolean;
}): { artwork: EthereumRevealedArtwork; metadataJson: string; placeholderJson: string } {
  const template = JSON.parse(input.templateJson.replaceAll('{{tokenId}}', input.tokenId).replaceAll('{{displayId}}', input.tokenId)) as {
    name: string; description?: string; image: string; attributes?: Array<{ trait_type: string; value: string | number }>;
  };
  const media = revealAssetMedia(input.category, input.assetId, input.catalog, input.ownerHatching, input.allocatedEgg);
  const name = input.category === 'egg' ? `Egg #${input.assetId}` : template.name;
  const description = input.category === 'egg' ? 'a unrevealed gan egg. what will hatch from it?' : template.description;
  const attributes = [...(template.attributes || []).filter(attribute => attribute.trait_type !== 'type'),
    { trait_type: 'type', value: input.category }];
  const metadata = { ...template, name, description, ...media, attributes, category: input.category, revealStatus: 'revealed' as const };
  return {
    artwork: { tokenId: input.tokenId, crateTokenId: input.crateTokenId, category: input.category,
      name, ...(description !== undefined ? { description } : {}),
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
