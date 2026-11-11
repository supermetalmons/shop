import type { RelicImagesScope } from '../../../../shared/ethereum/relicImages.js';
import { readEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { revealDeploymentCatalog } from './ethereumRevealCatalog.js';

export async function requireRelicImagesDeployment(env: Pick<Env, 'OPS_DB'>, scope: RelicImagesScope): Promise<EthereumRevealDeployment> {
  const deployment = await readEthereumRevealDeployment(env.OPS_DB, scope);
  if (!deployment || deployment.deploymentId !== scope.deploymentId || deployment.chainId !== scope.chainId ||
    deployment.contractAddress !== scope.contractAddress || deployment.metadataBaseUri !== scope.metadataBaseUri ||
    deployment.revision !== scope.expectedRevision || deployment.retiredAtMs != null || deployment.catalogUpdateId != null ||
    deployment.state === 'provisioning' || deployment.dropId !== (scope.chainId === 1 ? '111k' : '111k_devnet')) {
    throw new Error('Relic image deployment identity, revision, or maintenance state changed.');
  }
  revealDeploymentCatalog(deployment);
  return deployment;
}
