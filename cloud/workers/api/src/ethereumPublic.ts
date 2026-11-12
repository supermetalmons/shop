import { z } from 'zod';
import { ETHEREUM_API_PATHS, type EthereumPublicCollectionConfig, type EthereumPublicCollectionScope } from '../../../../shared/ethereum/api.js';
import { isEthereumCheckoutPartnerOrigin } from '../../../../shared/ethereum/checkout.js';
import { ETHEREUM_MAX_MINT_QUANTITY, ETHEREUM_MAX_UNBOX_QUANTITY, normalizeEthereumAddress } from '../../../../shared/ethereum/protocol.js';
import { readEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { ethereumRequestOrigin } from './ethereumAuth.js';
import { ethereumCatalogSnapshot } from './ethereumCatalogRevision.js';
import { isAllowedEthereumCheckoutStatusOrigin } from './ethereumCheckoutOrigin.js';
import { EthereumApiError, readEthereumBody } from './ethereumError.js';
import { ethereumCollectionRead, ethereumCollectionStats, ethereumPublicRead } from './ethereumRead.js';
import { isSupportedRevealDeployment } from './ethereumRevealCatalog.js';
import { ethereumConfig, ethereumTransactionHash, localEthereumRpcUrl,
  type EthereumCollectionReadContext, type EthereumRequestContext } from './ethereumRuntime.js';
import { confirmEthereumTransaction } from './ethereumTransactionConfirmation.js';
import { raceWithSignal, sleepWithSignal } from './boundedRequest.js';
import { ethereumPublicReadCacheScope } from './ethereumPublicReadCache.js';

type CollectionScope = { chainId: number; contractAddress: string };
const confirmationSchema = z.object({
  chainId: z.number().int().optional(), contractAddress: z.string().optional(),
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
}).strict();
const readParameters: Readonly<Record<string, readonly string[]>> = {
  [ETHEREUM_API_PATHS.config]: [],
  [ETHEREUM_API_PATHS.stats]: ['owner'],
  [ETHEREUM_API_PATHS.inventory]: ['owner', 'cursor', 'expectedTokenIds'],
  [ETHEREUM_API_PATHS.metadata]: ['kind', 'displayId'],
};

function requestScope(input: { chainId?: unknown; contractAddress?: unknown }, required: boolean): CollectionScope | null {
  if (input.chainId === undefined && input.contractAddress === undefined && !required) return null;
  const contractAddress = normalizeEthereumAddress(input.contractAddress);
  if (typeof input.chainId !== 'number' || ![1, 11155111, 31337].includes(input.chainId) ||
    !contractAddress || /^0x0{40}$/.test(contractAddress)) {
    throw new EthereumApiError('invalid-argument', 'Provide one chainId and contractAddress for the collection.');
  }
  return { chainId: input.chainId, contractAddress };
}

async function publicDeployment(context: EthereumRequestContext, scope: CollectionScope): Promise<EthereumRevealDeployment> {
  context.signal.throwIfAborted();
  if (scope.chainId === 31337 && context.env.ETHEREUM_111K_CHAIN_ID !== '31337') {
    throw new EthereumApiError('invalid-argument', 'Local Ethereum collections are unavailable in this environment.');
  }
  const deployment = await raceWithSignal(readEthereumRevealDeployment(context.env.OPS_DB, scope), context.signal);
  context.signal.throwIfAborted();
  if (!deployment) throw new EthereumApiError('not-found', 'The Ethereum collection is not registered.');
  if (deployment.retiredAtMs != null || !isSupportedRevealDeployment(deployment)) {
    throw new EthereumApiError('failed-precondition', 'The Ethereum collection is retired or unavailable.');
  }
  return deployment;
}

function collectionContext(context: EthereumRequestContext, deployment: EthereumRevealDeployment): EthereumCollectionReadContext {
  return { ...context, publicReadCacheScope: ethereumPublicReadCacheScope(deployment), config: { chainId: deployment.chainId, contractAddress: deployment.contractAddress,
    metadataBaseUri: deployment.metadataBaseUri, deploymentBlock: deployment.deploymentBlock, enabled: true } };
}

function collectionScope(deployment: EthereumRevealDeployment, catalogRevision: number): EthereumPublicCollectionScope {
  return { deploymentId: deployment.deploymentId, dropId: deployment.dropId, chainId: deployment.chainId,
    contractAddress: deployment.contractAddress, catalogRevision };
}

async function publicConfig(context: EthereumCollectionReadContext, deployment: EthereumRevealDeployment,
  scope: EthereumPublicCollectionScope): Promise<EthereumPublicCollectionConfig> {
  const stats = await ethereumCollectionStats(context, null);
  const local = deployment.chainId === 31337;
  const mainnet = deployment.chainId === 1;
  const enabled = deployment.provisionedAtMs !== null && deployment.state !== 'provisioning';
  return { ...scope, chainName: local ? 'Local Ethereum' : mainnet ? 'Ethereum' : 'Sepolia',
    metadataBaseUri: deployment.metadataBaseUri, deploymentBlock: deployment.deploymentBlock,
    explorerUrl: local ? '' : mainnet ? 'https://etherscan.io' : 'https://sepolia.etherscan.io',
    walletRpcUrl: local ? localEthereumRpcUrl(context.env.ETHEREUM_111K_RPC_URL || '') :
      mainnet ? 'https://ethereum-rpc.publicnode.com' : 'https://ethereum-sepolia-rpc.publicnode.com',
    testnet: !mainnet, enabled, revealEnabled: enabled && deployment.state === 'active', saleActive: stats.saleActive,
    cratePriceWei: stats.cratePriceWei, warehousePriceWei: stats.warehousePriceWei,
    confirmationBlocks: 3, maxMintQuantity: ETHEREUM_MAX_MINT_QUANTITY, maxUnboxQuantity: ETHEREUM_MAX_UNBOX_QUANTITY };
}

export async function ethereumPublicRequest(request: Request, context: EthereumRequestContext, path: string): Promise<unknown> {
  const url = new URL(request.url);
  const required = isEthereumCheckoutPartnerOrigin(ethereumRequestOrigin(request, isAllowedEthereumCheckoutStatusOrigin));
  let scope: CollectionScope | null;
  let transactionHash: string | undefined;
  if (path === ETHEREUM_API_PATHS.transactionsConfirm) {
    if (url.search) throw new EthereumApiError('invalid-argument', 'Provide transaction confirmation fields in the JSON body.');
    const body = await readEthereumBody(request, context.signal, confirmationSchema);
    scope = requestScope(body, required);
    transactionHash = ethereumTransactionHash(body.transactionHash);
  } else {
    const parameters = readParameters[path];
    if (!parameters) throw new EthereumApiError('not-found', 'Public Ethereum method not found.');
    for (const key of url.searchParams.keys()) {
      if (url.searchParams.getAll(key).length !== 1) throw new EthereumApiError('invalid-argument', 'Duplicate Ethereum request parameter.');
    }
    const chain = url.searchParams.get('chainId');
    if (chain !== null && !['1', '11155111', '31337'].includes(chain)) {
      throw new EthereumApiError('invalid-argument', 'Invalid Ethereum chainId.');
    }
    scope = requestScope({ chainId: chain === null ? undefined : Number(chain),
      contractAddress: url.searchParams.get('contractAddress') ?? undefined }, required);
    if (scope && [...url.searchParams.keys()].some(key => !['chainId', 'contractAddress', ...parameters].includes(key))) {
      throw new EthereumApiError('invalid-argument', 'Unknown Ethereum request parameter.');
    }
  }
  if (!scope) {
    const legacy = { ...context, config: ethereumConfig(context.env) };
    return transactionHash ? confirmEthereumTransaction(legacy, transactionHash) : ethereumPublicRead(request, legacy, path);
  }
  const readsArtworkMetadata = path !== ETHEREUM_API_PATHS.config && path !== ETHEREUM_API_PATHS.stats;
  for (;;) {
    context.signal.throwIfAborted();
    const deployment = await publicDeployment(context, scope);
    const ready = deployment.provisionedAtMs !== null && deployment.state !== 'provisioning';
    if (!ready && path !== ETHEREUM_API_PATHS.config) throw new EthereumApiError('unavailable', 'The Ethereum collection is still provisioning.');
    const selected = collectionContext(context, deployment);
    const before = ready && readsArtworkMetadata
      ? await ethereumCatalogSnapshot(selected) : { catalogRevision: deployment.catalogRevision ?? 0 };
    const identity = collectionScope(deployment, before.catalogRevision);
    const value = path === ETHEREUM_API_PATHS.config ? await publicConfig(selected, deployment, identity)
      : transactionHash ? await confirmEthereumTransaction(selected, transactionHash) : await ethereumCollectionRead(request, selected, path);
    const after = ready && (readsArtworkMetadata || deployment.catalogUpdateId != null)
      ? await ethereumCatalogSnapshot(selected) : before;
    const current = await publicDeployment(context, scope);
    if (current.deploymentId !== deployment.deploymentId || current.revision !== deployment.revision ||
      current.catalogRevision !== deployment.catalogRevision || current.catalogUpdateId !== deployment.catalogUpdateId ||
      readsArtworkMetadata && after.catalogRevision !== before.catalogRevision) continue;
    if (selected.publicReadCacheExpiresAtMs !== undefined && Date.now() >= selected.publicReadCacheExpiresAtMs) {
      await sleepWithSignal(1, context.signal);
      continue;
    }
    return { ...value, ...collectionScope(deployment, after.catalogRevision) };
  }
}
