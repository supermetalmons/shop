import type { DeploymentRegistryDrop } from './deploymentRegistry.js';
import { normalizeDropBase, type SolanaCluster } from './deploymentCore.js';
import { resolveDropInventoryManifest } from './dropInventoryManifest.js';
import { resolveDropMaxFigureId } from './dropFigureIds.js';
import { isPreorderCardId, preorderMetadataUri, type PreorderAsset, type PreorderConfig } from './preorders.js';

type PublicPreorderDrop = Pick<DeploymentRegistryDrop,
  'dropId' | 'dropFamily' | 'solanaCluster' | 'collectionMint' | 'metadataBase' | 'metadataPathFormat' |
  'figureNamePrefix' | 'maxSupply' | 'itemsPerBox' | 'operationsConfig' | 'inventoryManifest'>;

export function preorderCardMetadata(args: {
  config: PreorderConfig;
  publicDrop?: PublicPreorderDrop;
  id: number;
}): { name: string; uri: string } | null {
  const { config, publicDrop: drop, id } = args;
  if (!isPreorderCardId(id) || !drop || drop.dropId !== config.preorderId || drop.dropFamily !== 'mi_note_cards' ||
    drop.solanaCluster !== config.cluster || drop.collectionMint !== config.collection || drop.metadataPathFormat !== 'compact' ||
    !drop.operationsConfig || drop.itemsPerBox !== 2 || !drop.figureNamePrefix || drop.figureNamePrefix !== drop.figureNamePrefix.trim()) return null;
  try {
    const manifest = resolveDropInventoryManifest(drop);
    if (!manifest || manifest.cardIds.includes(id) || id > resolveDropMaxFigureId(drop)) return null;
    return { name: `${drop.figureNamePrefix} ${id}`, uri: `${normalizeDropBase(drop.metadataBase)}/f${id}.json` };
  } catch { return null; }
}

export function resolveClaimedPreorderAsset(args: {
  config: PreorderConfig;
  cluster: SolanaCluster;
  claim: PreorderAsset;
  actual: { address: string; collection: string; name: string; uri: string };
  publicDrop?: PublicPreorderDrop;
}): { kind: 'preorder' | 'dude'; id: number } | null {
  const { config, claim, actual } = args;
  if (args.cluster !== config.cluster || !isPreorderCardId(claim.id) ||
    actual.address !== claim.address || actual.collection !== config.collection) return null;
  if (actual.name === `Preorder #${claim.id}` && actual.uri === preorderMetadataUri(config, claim.id)) {
    return { kind: 'preorder', id: claim.id };
  }
  const target = preorderCardMetadata({ config, publicDrop: args.publicDrop, id: claim.id });
  return target && actual.name === target.name && actual.uri === target.uri ? { kind: 'dude', id: claim.id } : null;
}
