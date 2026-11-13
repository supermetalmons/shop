import { getOwnerHatchingGrail } from '../../../../shared/ethereum/ownerHatchingCatalog.ts';
import { getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { ETHEREUM_REVEAL_CATALOG_VERSION } from '../../../../shared/ethereum/revealDeployment.ts';
import { lookupRevealCollectionBlock } from '../../../../shared/ethereum/revealCollectionBlocks.ts';
import { revealCollectionBlocks } from '../src/ethereumRevealCollectionBlocks.ts';

export function revealTraitFixtureBlock(input: string | URL): string {
  const url = new URL(input);
  const path = /^\/nft\/111k\/(paintings|videos|3d|animated)\/json\/v0\/([1-9]\d*)\.json$/.exec(url.pathname);
  if (!path) throw new Error(`Unexpected fixture trait URL: ${url}`);
  const categories = { paintings: 'painting', videos: 'video', '3d': '3d', animated: 'animated' } as const;
  const category = categories[path[1] as keyof typeof categories];
  const assetId = Number(path[2]);
  const label = getOwnerHatchingGrail(category, assetId)?.collectionBlock ?? lookupRevealCollectionBlock(
    revealCollectionBlocks(getRevealCatalogDescriptor(ETHEREUM_REVEAL_CATALOG_VERSION)), category, assetId);
  if (!label) throw new Error(`Missing fixture collection block: ${url}`);
  return label;
}

export function withRevealTraitFixture(otherFetch: typeof fetch,
  respond?: (url: URL) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://cdn.lil.org' || !url.pathname.includes('/json/')) return otherFetch(input, init);
    const path = /^\/nft\/111k\/(paintings|videos|3d|animated)\/json\/v0\/([1-9]\d*)\.json$/.exec(url.pathname);
    if (!path) throw new Error(`Unexpected fixture trait URL: ${url}`);
    if (respond) return respond(url);
    return Response.json({ 'collection block': revealTraitFixtureBlock(url), attributes: [{ trait_type: 'asset ID', value: Number(path[2]) }] });
  };
}
