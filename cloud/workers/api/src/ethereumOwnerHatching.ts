import { z } from 'zod';
import { ETHEREUM_OWNER_HATCHING_MESSAGE, ETHEREUM_OWNER_HATCHING_PATHS } from '../../../../shared/ethereum/ownerHatching.js';
import { normalizeEthereumAddress, normalizeEthereumTokenId } from '../../../../shared/ethereum/protocol.js';
import { readEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { raceWithSignal } from './boundedRequest.js';
import { limitEthereumRequest } from './ethereumAuth.js';
import { isAllowedEthereumCheckoutStatusOrigin } from './ethereumCheckoutOrigin.js';
import { EthereumApiError, readEthereumBody } from './ethereumError.js';
import { verifyEthereumPersonalSignature } from './ethereumPersonalSignature.js';
import { ethereumTokenInfos } from './ethereumRead.js';
import { isSupportedRevealDeployment } from './ethereumRevealCatalog.js';
import { ethereumBlockSnapshot, verifyEthereumBlockSnapshot, withEthereumReadProvider,
  type EthereumCollectionReadContext, type EthereumEnvironment, type EthereumRequestContext } from './ethereumRuntime.js';
import type { ProviderBudgetClient } from './ethereumProviderBudget.js';

const scopeSchema = z.object({
  chainId: z.number().int().refine(value => [1, 11155111, 31337].includes(value)),
  contractAddress: z.string().refine(value => Boolean(normalizeEthereumAddress(value)) && !/^0x0{40}$/i.test(value)),
}).strict();
const hatchSchema = scopeSchema.extend({
  tokenId: z.string().max(78),
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(8194),
}).strict();
const rpcCodes = ['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found',
  'failed-precondition', 'aborted', 'resource-exhausted', 'unavailable', 'deadline-exceeded'] as const;
const rpcErrorPrefix = 'EthereumOwnerHatching:';

export function ownerHatchingRpcError(error: unknown): Error {
  const failure = error instanceof EthereumApiError && rpcCodes.some(code => code === error.code)
    ? error : new EthereumApiError('unavailable', 'Egg hatching is temporarily unavailable.');
  const result = new Error(failure.message);
  result.name = `${rpcErrorPrefix}${failure.code}`;
  return result;
}

function requestError(error: unknown): EthereumApiError {
  if (error instanceof EthereumApiError) return error;
  if (error instanceof Error) {
    const code = rpcCodes.find(code => error.name === `${rpcErrorPrefix}${code}`);
    if (code) return new EthereumApiError(code, error.message);
  }
  return new EthereumApiError('unavailable', 'Egg hatching is temporarily unavailable.');
}

export async function authorizeOwnerHatch(env: EthereumEnvironment, deployment: EthereumRevealDeployment,
  tokenId: string, signature: string, dependencies: {
    signal?: AbortSignal; fetch?: typeof fetch; providerBudgetClient?: ProviderBudgetClient;
  } = {}): Promise<void> {
  if (normalizeEthereumTokenId(tokenId) !== tokenId || BigInt(tokenId) > 111_111n) {
    throw new EthereumApiError('invalid-argument', 'Provide an artwork token ID.');
  }
  const context: EthereumCollectionReadContext = {
    env, nowMs: Date.now(), signal: dependencies.signal ?? AbortSignal.timeout(15_000),
    fetch: dependencies.fetch ?? fetch, providerLane: 'reveal', providerBudgetClient: dependencies.providerBudgetClient,
    config: { enabled: true, chainId: deployment.chainId, contractAddress: deployment.contractAddress,
      metadataBaseUri: deployment.metadataBaseUri, deploymentBlock: deployment.deploymentBlock },
  };
  await withEthereumReadProvider(context, async selected => {
    const snapshot = await ethereumBlockSnapshot(selected);
    const [token] = await ethereumTokenInfos(selected, [tokenId], snapshot.blockHash);
    if (!token || token.kind !== 'artwork') {
      throw new EthereumApiError('failed-precondition', 'This artwork token does not currently exist.');
    }
    const valid = await verifyEthereumPersonalSignature(selected, token.owner, ETHEREUM_OWNER_HATCHING_MESSAGE,
      signature, { blockHash: snapshot.blockHash, requireCanonical: true });
    await verifyEthereumBlockSnapshot(selected, snapshot);
    selected.signal.throwIfAborted();
    if (!valid) throw new EthereumApiError('permission-denied', 'The current token owner must authorize hatching.');
  });
}

export async function ethereumOwnerHatching(request: Request, context: EthereumRequestContext, path: string): Promise<unknown> {
  const ready = path === ETHEREUM_OWNER_HATCHING_PATHS.ready;
  if (!ready && path !== ETHEREUM_OWNER_HATCHING_PATHS.hatch) {
    throw new EthereumApiError('not-found', 'Egg hatching method not found.');
  }
  await limitEthereumRequest(request, context, ready ? 'owner-hatching-read' : 'owner-hatching-hatch',
    (ready ? context.env.ETHEREUM_REVEAL_READ_RATE_LIMITER : context.env.ETHEREUM_REVEAL_ADMISSION_RATE_LIMITER)
      ?? context.env.PUBLIC_SHOP_RATE_LIMITER, isAllowedEthereumCheckoutStatusOrigin);
  const url = new URL(request.url);
  let body: z.infer<typeof scopeSchema> | z.infer<typeof hatchSchema>;
  if (ready) {
    if ([...url.searchParams.keys()].some(key => !['chainId', 'contractAddress'].includes(key) ||
      url.searchParams.getAll(key).length !== 1) || !['1', '11155111', '31337'].includes(url.searchParams.get('chainId') ?? '')) {
      throw new EthereumApiError('invalid-argument', 'Provide one chainId and contractAddress for the collection.');
    }
    const parsed = scopeSchema.safeParse({ chainId: Number(url.searchParams.get('chainId')),
      contractAddress: url.searchParams.get('contractAddress') });
    if (!parsed.success) throw new EthereumApiError('invalid-argument', 'Provide one chainId and contractAddress for the collection.');
    body = parsed.data;
  } else {
    if (url.search) throw new EthereumApiError('invalid-argument', 'Provide hatching fields in the JSON body.');
    body = await readEthereumBody(request, context.signal, hatchSchema);
  }
  if (body.chainId === 31337 && context.env.ETHEREUM_111K_CHAIN_ID !== '31337') {
    throw new EthereumApiError('invalid-argument', 'Local Ethereum collections are unavailable in this environment.');
  }
  const scope = { chainId: body.chainId, contractAddress: normalizeEthereumAddress(body.contractAddress)! };
  const deployment = await raceWithSignal(readEthereumRevealDeployment(context.env.OPS_DB, scope), context.signal);
  if (!deployment) throw new EthereumApiError('not-found', 'The Ethereum collection is not registered.');
  if (deployment.retiredAtMs != null || !isSupportedRevealDeployment(deployment)) {
    throw new EthereumApiError('failed-precondition', 'The Ethereum collection is retired or unavailable.');
  }
  if (deployment.provisionedAtMs == null || deployment.state === 'provisioning' || !context.env.ETHEREUM_REVEAL) {
    throw new EthereumApiError('unavailable', 'Egg hatching is temporarily unavailable.');
  }
  const object = context.env.ETHEREUM_REVEAL.getByName(`${deployment.chainId}:${deployment.contractAddress}`);
  try {
    let value: unknown;
    if ('tokenId' in body) {
      const tokenId = normalizeEthereumTokenId(body.tokenId);
      if (!tokenId || BigInt(tokenId) > 111_111n) throw new EthereumApiError('invalid-argument', 'Provide an artwork token ID.');
      value = await raceWithSignal(object.ownerHatch(deployment, { tokenId, signature: body.signature }), context.signal);
    } else {
      value = await raceWithSignal(object.ownerHatchingReady(deployment), context.signal);
    }
    const current = await raceWithSignal(readEthereumRevealDeployment(context.env.OPS_DB, scope), context.signal);
    if (!current || current.deploymentId !== deployment.deploymentId || current.retiredAtMs != null) {
      throw new EthereumApiError('unavailable', 'Egg hatching is temporarily unavailable.');
    }
    return value;
  } catch (error) {
    context.signal.throwIfAborted();
    throw requestError(error);
  }
}
