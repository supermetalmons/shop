import { readEthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { EthereumApiError } from './ethereumError.js';
import type { EthereumContext } from './ethereumRuntime.js';
import { raceWithSignal } from './boundedRequest.js';

export const ETHEREUM_CATALOG_SNAPSHOT_PAGE_SIZE = 16;

export type EthereumRevealCatalogSnapshot = {
  deploymentId: string | null;
  catalogRevision: number;
  artworks: Array<{ tokenId: string; metadataJson: string; metadataRevision: number }>;
};

export async function ethereumCatalogSnapshot(context: EthereumContext, tokenIds: string[] = []): Promise<EthereumRevealCatalogSnapshot> {
  const address = context.config.contractAddress;
  const deployment = address ? await readEthereumRevealDeployment(context.env.OPS_DB,
    { chainId: context.config.chainId, contractAddress: address }) : null;
  if (deployment?.retiredAtMs != null) throw new EthereumApiError('unavailable', 'This artwork collection is retired.');
  if (!deployment) return { deploymentId: null, catalogRevision: 0, artworks: [] };
  if (!context.env.ETHEREUM_REVEAL) {
    if (deployment.catalogRevision || deployment.catalogUpdateId) throw new EthereumApiError('unavailable', 'Artwork metadata is temporarily unavailable.');
    return { deploymentId: deployment.deploymentId, catalogRevision: 0, artworks: [] };
  }
  const object = context.env.ETHEREUM_REVEAL.getByName(`${deployment.chainId}:${deployment.contractAddress}`);
  for (;;) {
    context.signal.throwIfAborted();
    let snapshot: EthereumRevealCatalogSnapshot | undefined;
    let changed = false;
    for (let offset = 0; offset < Math.max(1, tokenIds.length); offset += ETHEREUM_CATALOG_SNAPSHOT_PAGE_SIZE) {
      const page = await raceWithSignal(object.catalogSnapshot(deployment, tokenIds.slice(offset, offset + ETHEREUM_CATALOG_SNAPSHOT_PAGE_SIZE)), context.signal);
      if (page.deploymentId !== deployment.deploymentId) throw new EthereumApiError('unavailable', 'The artwork collection changed.');
      if (snapshot && page.catalogRevision !== snapshot.catalogRevision) { changed = true; break; }
      if (snapshot) snapshot.artworks.push(...page.artworks);
      else snapshot = page;
    }
    if (!changed) return snapshot!;
  }
}

export async function requireEthereumCatalogSnapshot(context: EthereumContext, captured: EthereumRevealCatalogSnapshot): Promise<void> {
  const address = context.config.contractAddress;
  const current = address ? await readEthereumRevealDeployment(context.env.OPS_DB,
    { chainId: context.config.chainId, contractAddress: address }) : null;
  if ((current?.deploymentId ?? null) !== captured.deploymentId || current?.retiredAtMs != null) {
    throw new EthereumApiError('unavailable', 'The artwork collection changed. Try again shortly.');
  }
}
