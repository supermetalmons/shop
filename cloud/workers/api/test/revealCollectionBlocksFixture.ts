import source from '../../../../scripts/ethereum-metadata/reveal-assets/111k_devnet/collection-blocks.json';
import { computeRevealCatalogDescriptor, REVEAL_ASSET_FAMILIES, type RevealAssetCatalog } from '../../../../shared/ethereum/revealAssetCatalog.ts';
import { validateRevealCollectionBlocks } from '../../../../shared/ethereum/revealCollectionBlocks.ts';

export function registerRevealCollectionBlocksFixture(catalog: RevealAssetCatalog, label: string): void {
  const counts = { painting: catalog.categories.paintings.count, video: catalog.categories.videos.count,
    '3d': catalog.categories['3d'].count, animated: catalog.categories.animated.count };
  for (const category of ['painting', 'video', '3d', 'animated'] as const) {
    const ranges = source.ranges[category];
    const last = ranges.at(-1);
    const count = catalog.categories[REVEAL_ASSET_FAMILIES[category]].count;
    if (count > Number(last?.[0] ?? 0)) {
      if (last?.[1] === label) last[0] = count;
      else ranges.push([count, label]);
    }
  }
  source.catalogs = [...source.catalogs.filter(value => value.catalogVersion !== catalog.catalogVersion),
    { ...computeRevealCatalogDescriptor(catalog), counts }];
  validateRevealCollectionBlocks(source);
}
