import { ETHEREUM_111K_CONTROL_SQL, parseEthereum111kControl } from '../../../../shared/ethereum/control.js';
import { isSupportedRevealDeployment } from './ethereumRevealCatalog.js';
import { normalizeEthereumAddress } from '../../../../shared/ethereum/protocol.js';
import { ETHEREUM_REVEAL_DEPLOYMENT_ID,
  ETHEREUM_REVEAL_DEPLOYMENTS_SQL, parseEthereumRevealDeployment,
  type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { isRevealArtworkTokenId, type EthereumRevealAttributeBackfillRequest, type EthereumRevealMaintenanceRequest,
  type EthereumRevealReplacementRequest, type EthereumRevealRetirementRequest } from '../../../../shared/ethereum/revealMaintenance.js';

export function parseRevealMaintenanceRequest(value: unknown): EthereumRevealMaintenanceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reveal maintenance request.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || typeof row.deploymentId !== 'string' ||
    !ETHEREUM_REVEAL_DEPLOYMENT_ID.test(row.deploymentId) || typeof row.expectedRevision !== 'number' ||
    !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1) throw new Error('Invalid reveal maintenance request.');
  return { deploymentId: row.deploymentId, expectedRevision: row.expectedRevision };
}

export function parseRevealReplacementRequest(value: unknown): EthereumRevealReplacementRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reveal replacement request.');
  const row = value as Record<string, unknown>;
  const request = parseRevealMaintenanceRequest({ deploymentId: row.deploymentId, expectedRevision: row.expectedRevision });
  if (Object.keys(row).some(key => !['deploymentId', 'expectedRevision', 'frozenThroughMs'].includes(key)) ||
    row.frozenThroughMs !== undefined && (typeof row.frozenThroughMs !== 'number' || !Number.isSafeInteger(row.frozenThroughMs) ||
      row.frozenThroughMs < 0 || row.frozenThroughMs > Date.now())) throw new Error('Invalid frozen artwork cutoff.');
  return { ...request, ...(row.frozenThroughMs !== undefined ? { frozenThroughMs: row.frozenThroughMs as number } : {}) };
}

export function parseRevealAttributeBackfillRequest(value: unknown): EthereumRevealAttributeBackfillRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reveal attribute backfill request.');
  const row = value as Record<string, unknown>;
  const scope = parseRevealMaintenanceRequest({ deploymentId: row.deploymentId, expectedRevision: row.expectedRevision });
  if (Object.keys(row).some(key => !['deploymentId', 'expectedRevision', 'write', 'afterTokenId', 'retryBlocked', 'recheckTokenId'].includes(key)) ||
    row.retryBlocked !== undefined && typeof row.retryBlocked !== 'boolean' || typeof row.write !== 'boolean' ||
    row.afterTokenId !== null && !isRevealArtworkTokenId(row.afterTokenId) ||
    row.recheckTokenId !== undefined && (!isRevealArtworkTokenId(row.recheckTokenId) || row.retryBlocked || row.afterTokenId !== null)) {
    throw new Error('Invalid reveal attribute backfill request.');
  }
  return { ...scope, afterTokenId: row.afterTokenId, write: row.write, ...(row.retryBlocked === true && { retryBlocked: true }),
    ...(row.recheckTokenId !== undefined && { recheckTokenId: row.recheckTokenId }) };
}

export function parseRevealRetirementRequest(value: unknown): EthereumRevealRetirementRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reveal retirement request.');
  const row = value as Record<string, unknown>;
  const current = parseRevealMaintenanceRequest({ deploymentId: row.deploymentId, expectedRevision: row.expectedRevision });
  const replacement = parseRevealMaintenanceRequest({ deploymentId: row.replacementDeploymentId, expectedRevision: row.expectedReplacementRevision });
  if (Object.keys(row).length !== 4 || current.deploymentId === replacement.deploymentId) throw new Error('Invalid reveal retirement request.');
  return { ...current, replacementDeploymentId: replacement.deploymentId, expectedReplacementRevision: replacement.expectedRevision };
}

async function readRevealMaintenanceDeployment(env: Env, deploymentId: string): Promise<EthereumRevealDeployment> {
  const row = await env.OPS_DB.prepare(`${ETHEREUM_REVEAL_DEPLOYMENTS_SQL} WHERE deployment_id=?`)
    .bind(deploymentId).first<Record<string, unknown>>();
  if (!row) throw new Error('Reveal deployment is not registered.');
  return parseEthereumRevealDeployment(row);
}

export async function requireRetiredRevealDeployment(env: Env, value: unknown,
  options: { requireDrain?: boolean } = {}): Promise<EthereumRevealDeployment> {
  const request = parseRevealMaintenanceRequest(value);
  const deployment = await readRevealMaintenanceDeployment(env, request.deploymentId);
  if (deployment.revision !== request.expectedRevision || deployment.chainId !== 11155111 || deployment.dropId !== '111k_devnet' ||
    deployment.state !== 'paused' || deployment.retiredAtMs == null || deployment.catalogUpdateId != null) {
    throw new Error('Reveal purge requires the expected retired Sepolia deployment.');
  }
  if (options.requireDrain && deployment.retiredAtMs != null && Date.now() - deployment.retiredAtMs < 65_000) {
    throw new Error('Retired reveal deployment must drain for at least 65 seconds before purge.');
  }
  const configuredChain = Number(env.ETHEREUM_111K_CHAIN_ID);
  const configuredContract = normalizeEthereumAddress(env.ETHEREUM_111K_CONTRACT_ADDRESS);
  const control = parseEthereum111kControl(await env.COMMERCE_DB.prepare(ETHEREUM_111K_CONTROL_SQL).first());
  if (!Number.isSafeInteger(configuredChain) || configuredChain < 1 || !configuredContract || /^0x0{40}$/.test(configuredContract) ||
    control.chainId === null || control.resetGuardId !== null ||
    configuredChain === deployment.chainId && configuredContract === deployment.contractAddress ||
    control.chainId === deployment.chainId && control.contractAddress === deployment.contractAddress) {
    throw new Error('Configured or commerce-controlled reveal deployments cannot be purged.');
  }
  return deployment;
}

async function requireActiveRevealScope(env: Env, request: EthereumRevealMaintenanceRequest, operation: 'Replacement' | 'Backfill') {
  const deployment = await readRevealMaintenanceDeployment(env, request.deploymentId);
  const control = parseEthereum111kControl(await env.COMMERCE_DB.prepare(ETHEREUM_111K_CONTROL_SQL).first());
  if (deployment.revision !== request.expectedRevision || deployment.chainId !== 11155111 || deployment.dropId !== '111k_devnet' ||
    deployment.state !== 'active' || deployment.retiredAtMs != null ||
    !isSupportedRevealDeployment(deployment) || operation === 'Replacement' && deployment.catalogUpdateId != null ||
    deployment.provisionedAtMs === null || Number(env.ETHEREUM_111K_CHAIN_ID) !== deployment.chainId ||
    normalizeEthereumAddress(env.ETHEREUM_111K_CONTRACT_ADDRESS) !== deployment.contractAddress ||
    env.ETHEREUM_111K_METADATA_BASE_URI !== deployment.metadataBaseUri || Number(env.ETHEREUM_111K_DEPLOYMENT_BLOCK) !== deployment.deploymentBlock ||
    control.resetGuardId !== null || control.chainId !== deployment.chainId || control.contractAddress !== deployment.contractAddress) {
    throw new Error(`${operation} reveal deployment must be active and match the live API and commerce scope.`);
  }
  if (operation === 'Replacement' && (deployment.lastError !== null || control.paused)) {
    throw new Error('Replacement reveal deployment must be healthy with active commerce.');
  }
  return deployment;
}

export function requireRevealReplacement(env: Env, value: unknown): Promise<EthereumRevealDeployment> {
  return requireActiveRevealScope(env, parseRevealReplacementRequest(value), 'Replacement');
}

export function requireAttributeBackfillDeployment(env: Env, request: EthereumRevealAttributeBackfillRequest): Promise<EthereumRevealDeployment> {
  return requireActiveRevealScope(env, request, 'Backfill');
}

export async function requireRevealRetirementPair(env: Env, value: unknown) {
  const request = parseRevealRetirementRequest(value);
  const [deployment, currentReplacement] = await Promise.all([
    readRevealMaintenanceDeployment(env, request.deploymentId),
    readRevealMaintenanceDeployment(env, request.replacementDeploymentId),
  ]);
  const replay = deployment.retiredAtMs != null && deployment.replacementDeploymentId === currentReplacement.deploymentId &&
    deployment.revision === request.expectedRevision + 1;
  if (currentReplacement.revision < request.expectedReplacementRevision) {
    throw new Error('Replacement reveal deployment revision moved backwards.');
  }
  const replacement = await requireRevealReplacement(env, { deploymentId: request.replacementDeploymentId,
    expectedRevision: replay ? currentReplacement.revision : request.expectedReplacementRevision });
  if (deployment.chainId !== 11155111 || deployment.dropId !== '111k_devnet' || deployment.state !== 'paused' || deployment.catalogUpdateId != null ||
    deployment.contractAddress === replacement.contractAddress || deployment.metadataBaseUri === replacement.metadataBaseUri ||
    deployment.deploymentBlock >= replacement.deploymentBlock ||
    Number((deployment.effectiveCatalogVersion ?? deployment.catalogVersion).slice(6)) >
      Number((replacement.effectiveCatalogVersion ?? replacement.catalogVersion).slice(6)) ||
    (deployment.retiredAtMs != null ? !replay : deployment.revision !== request.expectedRevision)) {
    throw new Error('Retirement requires the expected superseded Sepolia deployment and replacement.');
  }
  return { request, deployment, replacement, replay };
}

export async function requireRevealCancellationPair(env: Env, value: unknown) {
  const request = parseRevealRetirementRequest(value);
  const [deployment, replacement] = await Promise.all([
    readRevealMaintenanceDeployment(env, request.deploymentId),
    readRevealMaintenanceDeployment(env, request.replacementDeploymentId),
  ]);
  if ([deployment, replacement].some(row => row.chainId !== 11155111 || row.dropId !== '111k_devnet' || row.catalogUpdateId != null)
    || deployment.contractAddress === replacement.contractAddress || deployment.deploymentBlock >= replacement.deploymentBlock
    || deployment.revision < request.expectedRevision || replacement.revision < request.expectedReplacementRevision
    || deployment.retiredAtMs != null && (deployment.replacementDeploymentId !== replacement.deploymentId
      || deployment.revision !== request.expectedRevision + 1)) {
    throw new Error('Invalid Ethereum retirement cancellation scope.');
  }
  return { request, deployment, replacement };
}

export function revealMaintenanceIdentity(deployment: EthereumRevealDeployment) {
  return { deploymentId: deployment.deploymentId, chainId: deployment.chainId,
    contractAddress: deployment.contractAddress, metadataBaseUri: deployment.metadataBaseUri, revision: deployment.revision };
}

export function requireRevealObjectIdentity(id: DurableObjectId, namespace: DurableObjectNamespace,
  deployment: Pick<EthereumRevealDeployment, 'chainId' | 'contractAddress'>): void {
  if (!id.equals(namespace.idFromName(`${deployment.chainId}:${deployment.contractAddress}`))) {
    throw new Error('Reveal maintenance object does not match the registered deployment.');
  }
}
