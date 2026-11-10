import source from '../../../../scripts/ethereum-metadata/reveal-assets/111k_devnet/collection-blocks.json';
import { selectRevealCollectionBlocks, validateRevealCollectionBlocks } from '../../../../shared/ethereum/revealCollectionBlocks.js';
import type { RevealAssetCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.js';

const collectionBlocks = (() => {
  const value: unknown = source;
  validateRevealCollectionBlocks(value);
  return value;
})();

export function revealCollectionBlocks(descriptor: RevealAssetCatalogDescriptor | null | undefined) {
  return selectRevealCollectionBlocks(collectionBlocks, descriptor);
}
