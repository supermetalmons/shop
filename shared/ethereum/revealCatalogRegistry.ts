import currentCatalog from '../../scripts/ethereum-metadata/reveal-assets/111k_devnet/manifest.json';
import currentDescriptor from './revealCatalog.json';
import ancestors from './revealCatalogAncestors.json';
import { computeRevealCatalogDescriptor, validateRevealAssetCatalog,
  type RevealAssetCatalog, type RevealAssetCatalogDescriptor } from './revealAssetCatalog.ts';

const catalogs = new Map<string, { catalog: RevealAssetCatalog; descriptor: RevealAssetCatalogDescriptor }>();

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

for (const value of [...ancestors, currentCatalog]) {
  validateRevealAssetCatalog(value);
  const descriptor = computeRevealCatalogDescriptor(value);
  const existing = catalogs.get(value.catalogVersion);
  if (existing && existing.descriptor.manifestSha256 !== descriptor.manifestSha256) {
    throw new Error('Conflicting supported reveal catalog identity.');
  }
  catalogs.set(value.catalogVersion, { catalog: freeze(value), descriptor: freeze(descriptor) });
}
validateRevealAssetCatalog(currentCatalog, currentDescriptor);

export function getRevealCatalog(version: string, expectedHash?: string): RevealAssetCatalog | undefined {
  const entry = catalogs.get(version);
  return entry && (expectedHash === undefined || entry.descriptor.manifestSha256 === expectedHash) ? entry.catalog : undefined;
}

export function getRevealCatalogDescriptor(version: string): RevealAssetCatalogDescriptor | undefined {
  return catalogs.get(version)?.descriptor;
}

export function getSupportedRevealCatalogVersions(): string[] {
  return [...catalogs.keys()].sort((first, second) => Number(first.slice(6)) - Number(second.slice(6)));
}
