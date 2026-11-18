import { ETHEREUM_REVEAL_DEPLOYMENT_ID, type EthereumRevealDeployment } from './revealDeployment.ts';
import { getRevealCatalogDescriptor } from './revealCatalogRegistry.ts';
import type { MixedAllocationDefinition } from './revealMixedAllocation.ts';
import type { OwnerHatchingMaintenanceRequest, OwnerHatchingMaintenanceResult } from './ownerHatchingMaintenance.ts';
import { MIXED_MAINNET_BATCH_ID } from './mixedAllocation20261117.ts';

const legacyDeployment = {
  batchId: MIXED_MAINNET_BATCH_ID, deploymentId: 'mainnet-v1', chainId: 1,
  contractAddress: '0x08cded8258730bda384ff198001e47a1b50f7f9d', metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 26387160,
};

export function mixedAllocationScope(definition: MixedAllocationDefinition) {
  const { deploymentId, batchId, chainId, contractAddress, metadataBaseUri, deploymentBlock } =
    definition.version === 1 ? legacyDeployment : definition;
  return { deploymentId, batchId, chainId, contractAddress, metadataBaseUri, deploymentBlock };
}

export function registeredMixedCatalog(row: EthereumRevealDeployment) {
  return row.effectiveCatalogVersion && row.effectiveCatalogSha256
    ? { catalogVersion: row.effectiveCatalogVersion, manifestSha256: row.effectiveCatalogSha256 }
    : getRevealCatalogDescriptor(row.catalogVersion);
}

export type MixedAllocationMaintenanceRequest = Pick<OwnerHatchingMaintenanceRequest, 'deploymentId' | 'batchId' | 'expectedRevision'> & {
  action: OwnerHatchingMaintenanceRequest['action'] | 'cancel';
  definitionSha256?: string;
};

export type MixedAllocationMaintenanceResult = Omit<OwnerHatchingMaintenanceResult, 'phase' | 'verificationCursor'> & {
  phase: OwnerHatchingMaintenanceResult['phase'] | 'unstarted';
  verificationInProgress: boolean;
  verificationPasses: number;
  generationSeeded: number;
  futureCount: number;
  registryRevision: number;
  catalogRevision: number;
  catalogUpdateId: string | null;
  targetVersion: string;
  targetSha256: string;
  sourceSha256: string;
  remainingCleanup?: number;
};

export function parseMixedAllocationMaintenanceRequest(value: unknown): MixedAllocationMaintenanceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid mixed allocation request.');
  const row = value as Record<string, unknown>;
  const legacy = row.batchId === MIXED_MAINNET_BATCH_ID;
  if (Object.keys(row).some(key => !['action','deploymentId','batchId','expectedRevision','definitionSha256'].includes(key)) ||
    !['begin','scan','refresh-scan','stage','activate','refresh-activation','status','verify','complete','cancel'].includes(String(row.action)) ||
    typeof row.deploymentId !== 'string' || !ETHEREUM_REVEAL_DEPLOYMENT_ID.test(row.deploymentId) ||
    typeof row.batchId !== 'string' || !ETHEREUM_REVEAL_DEPLOYMENT_ID.test(row.batchId) ||
    (!legacy || row.definitionSha256 !== undefined) &&
      (typeof row.definitionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.definitionSha256)) ||
    legacy && row.deploymentId !== legacyDeployment.deploymentId ||
    !Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 1) throw new Error('Invalid mixed allocation identity or action.');
  return row as MixedAllocationMaintenanceRequest;
}
